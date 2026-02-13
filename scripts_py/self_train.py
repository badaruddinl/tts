import os
import subprocess
import sys
import json
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args, to_bool
from training_db import connect_db, insert_metric, record_training_run, upsert_recommendation


def run_step(name, cmd, allowed_exit_codes=(0,)):
    res = subprocess.run(cmd, cwd=os.getcwd(), shell=False)
    code = int(res.returncode or 0)
    if code not in tuple(allowed_exit_codes):
        raise RuntimeError(f"step_failed={name} exit={code}")


def _now():
    return datetime.now(timezone.utc).isoformat()


def _safe_load_json(path_str):
    p = Path(path_str).resolve()
    if not p.exists():
        return None
    try:
        with open(p, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _db_log_eval(db_file, eval_name, summary_path, status, extra=None):
    payload = _safe_load_json(summary_path) or {}
    run_key = f"{eval_name}_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    conn = connect_db(db_file, ensure_schema=True)
    try:
        sample_count = None
        if isinstance(payload, dict):
            sample_count = payload.get("caseCount")
            if sample_count is None and isinstance(payload.get("ranking"), list):
                sample_count = len(payload["ranking"])
        record_training_run(
            conn,
            run_key=run_key,
            trainer="python",
            model_name=f"eval:{eval_name}",
            model_path="",
            summary_path=str(Path(summary_path).resolve().relative_to(Path(os.getcwd()).resolve())).replace("\\", "/"),
            data_source=f"sqlite:{str(Path(db_file).resolve().relative_to(Path(os.getcwd()).resolve())).replace('\\', '/')}",
            style_scope=str((payload or {}).get("style") or (extra or {}).get("style") or "all"),
            status=str(status),
            sample_count=int(sample_count) if sample_count is not None else None,
            started_at=_now(),
            ended_at=_now(),
            raw_payload={"summary": payload, "extra": extra or {}},
        )
        metrics = payload.get("metrics") if isinstance(payload, dict) else {}
        if isinstance(metrics, dict):
            for k, v in metrics.items():
                try:
                    insert_metric(conn, run_key=run_key, metric_key=f"{eval_name}.{k}", metric_value=float(v))
                except Exception:
                    # Ignore non-numeric metric fields.
                    pass
    finally:
        conn.close()
    return payload


def _db_upsert_runtime_recs(db_file):
    defaults = _safe_load_json("config/expression/defaults.json") or {}
    rt = defaults.get("selectedRuntime", {}) if isinstance(defaults, dict) else {}
    conn = connect_db(db_file, ensure_schema=True)
    try:
        if isinstance(rt, dict):
            if rt.get("style"):
                upsert_recommendation(
                    conn,
                    rec_key="runtime_style",
                    rec_value=str(rt.get("style")),
                    reason="runtime_defaults",
                )
            if rt.get("humanizeIntensity") is not None:
                upsert_recommendation(
                    conn,
                    rec_key="runtime_humanize_intensity",
                    rec_value=str(rt.get("humanizeIntensity")),
                    reason="runtime_defaults",
                    score=float(rt.get("humanizeIntensity")),
                )
            if rt.get("autoExpressive") is not None:
                upsert_recommendation(
                    conn,
                    rec_key="runtime_auto_expressive",
                    rec_value=str(bool(rt.get("autoExpressive"))).lower(),
                    reason="runtime_defaults",
                )
            limiter = rt.get("prosodyLimiter") if isinstance(rt.get("prosodyLimiter"), dict) else {}
            if limiter:
                if limiter.get("enabled") is not None:
                    upsert_recommendation(
                        conn,
                        rec_key="runtime_prosody_limiter_enabled",
                        rec_value=str(bool(limiter.get("enabled"))).lower(),
                        reason="runtime_defaults",
                    )
                if limiter.get("strength") is not None:
                    upsert_recommendation(
                        conn,
                        rec_key="runtime_prosody_limiter_strength",
                        rec_value=str(limiter.get("strength")),
                        reason="runtime_defaults",
                        score=float(limiter.get("strength")),
                    )
    finally:
        conn.close()


def main():
    args = parse_args(sys.argv[1:])
    trainer = str(args.get("trainer") or "py").strip().lower()
    if trainer != "py":
        raise RuntimeError(f"invalid_trainer={trainer} expected=py")

    intensity = float(args.get("intensity") or 1.0)
    intensity = max(0.0, min(1.0, intensity))
    voices = [v.strip() for v in str(args.get("voices") or "id-ID-ArdiNeural,id-ID-GadisNeural").split(",") if v.strip()]
    min_feedback = int(float(args.get("min-feedback") or 1))
    training_store = str(args.get("training-store") or "auto").strip().lower()
    if training_store not in ("auto", "ndjson", "sqlite"):
        raise RuntimeError(f"invalid_training_store={training_store} expected=auto|ndjson|sqlite")
    db_file = str(args.get("db-file") or "data/training/training.db").strip()
    db_exists = (Path(os.getcwd()) / db_file).resolve().exists()
    trainer_feedback_source = "sqlite" if training_store == "sqlite" else ("sqlite" if training_store == "auto" and db_exists else "ndjson")
    eval_db_enabled = trainer_feedback_source == "sqlite"
    styles = str(args.get("styles") or "").strip()
    run_benchmark = to_bool(args.get("benchmark"), True)
    run_schema_migrate = to_bool(args.get("schema-migrate"), True)
    run_expression_eval = to_bool(args.get("expression-eval"), True)
    expression_strict = to_bool(args.get("expression-strict"), False)
    expression_dir = str(args.get("expression-dir") or "tests/expressions")
    run_intonation_eval = to_bool(args.get("intonation-eval"), True)
    intonation_outdir = str(args.get("intonation-outdir") or "outputs/eval_intonation_select_self")
    intonation_intensities = str(args.get("intonation-intensities") or "0.45,0.55,0.64,0.72,0.8")
    intonation_auto_expressive = str(args.get("intonation-auto-expressive") or "true,false")
    intonation_auto_expressive_off_margin = str(args.get("intonation-auto-expressive-off-margin") or "0.1")
    run_expression_ab = to_bool(args.get("expression-ab"), True)
    apply_expression_ab = to_bool(args.get("expression-ab-apply"), True)
    expression_ab_dir = str(args.get("expression-ab-dir") or expression_dir)
    expression_ab_outdir = str(args.get("expression-ab-outdir") or "outputs/eval_expression_ab_self")
    expression_ab_style_a = str(args.get("expression-ab-style-a") or "tegang")
    expression_ab_style_b = str(args.get("expression-ab-style-b") or expression_ab_style_a)
    expression_ab_intensity_a = str(args.get("expression-ab-intensity-a") or "0.4")
    expression_ab_intensity_b = str(args.get("expression-ab-intensity-b") or "0.7")
    run_hybrid_eval = to_bool(args.get("hybrid-eval"), True)
    apply_hybrid_ab = to_bool(args.get("hybrid-ab-apply"), True)
    hybrid_strict = to_bool(args.get("hybrid-strict"), False)
    hybrid_eval_dir = str(args.get("hybrid-eval-dir") or "tests/expressions")
    hybrid_style = str(args.get("hybrid-style") or "tegang")
    hybrid_outdir = str(args.get("hybrid-outdir") or "outputs/eval_hybrid_ab_self")
    expression_select_styles = str(
        args.get("expression-select-styles") or "tegang,natural,sinematik,narator_tegas,melankolis"
    )
    run_limiter_eval = to_bool(args.get("limiter-eval"), True)
    limiter_outdir = str(args.get("limiter-outdir") or "outputs/eval_limiter_select_self")
    limiter_strengths = str(args.get("limiter-strengths") or "0.5,0.58,0.64,0.7,0.78")
    run_limiter_train = to_bool(args.get("limiter-train"), True)
    apply_limiter_policy = to_bool(args.get("limiter-policy-apply"), True)
    run_voice_eval = to_bool(args.get("voice-eval"), True)
    voice_strict = to_bool(args.get("voice-strict"), False)
    voice_eval_dir = str(args.get("voice-eval-dir") or "tests/voice")
    run_final_tts = to_bool(args.get("final-tts"), True)
    final_tts_input = str(args.get("final-tts-input") or "template.tts.txt")
    final_tts_output = str(args.get("final-tts-output") or "outputs/final.mp3")
    final_tts_humanize = to_bool(args.get("final-tts-humanize"), True)

    print("self_train:start")
    use_ndjson_preprocess = training_store != "sqlite"
    if run_schema_migrate and use_ndjson_preprocess:
        run_step("schema_migrate", ["python", "scripts_py/migrate_feedback_schema.py"])
    if use_ndjson_preprocess:
        run_step("dedupe", ["python", "scripts_py/dedupe_training_data.py"])
        run_step("style_detail", ["python", "scripts_py/enrich_style_feedback.py"])
    if training_store in ("auto", "sqlite"):
        run_step("sqlite_migrate", ["python", "scripts_py/migrate_training_to_sqlite.py", "--db-file", db_file])
        trainer_feedback_source = "sqlite"
        eval_db_enabled = True

    run_step(
        "profile_py",
        [
            "python",
            "scripts_py/train_profile.py",
            "--apply",
            "true",
            "--min-feedback",
            str(min_feedback),
            "--feedback-source",
            trainer_feedback_source,
            "--db-file",
            db_file,
        ],
    )
    run_step(
        "ml_all_py",
        [
            "python",
            "scripts_py/train_ml_policy.py",
            "--feedback-source",
            trainer_feedback_source,
            "--db-file",
            db_file,
        ],
    )

    if styles:
        picked = [s.strip() for s in styles.split(",") if s.strip()]
        for style in picked:
            style_cmd = [
                "python",
                "scripts_py/train_ml_policy.py",
                "--style",
                style,
                "--feedback-source",
                trainer_feedback_source,
                "--db-file",
                db_file,
            ]
            if trainer_feedback_source == "ndjson":
                style_cmd += ["--feedback-file", f"data/training/styles/{style}/feedback.ndjson"]
            run_step(
                f"ml_{style}_py",
                style_cmd,
            )

    if run_benchmark:
        for voice in voices:
            bench_cmd = ["python", "scripts_py/generate_style_benchmarks.py", "--voice", voice, "--intensity", str(intensity)]
            if styles:
                bench_cmd += ["--styles", styles]
            run_step(f"benchmark_{voice}", bench_cmd)

    if run_expression_eval:
        eval_exit = (0,) if expression_strict else (0, 2)
        run_step(
            "expression_suite",
            ["python", "scripts_py/eval_expression_suite.py", "--dir", expression_dir, "--style", "tegang"],
            allowed_exit_codes=eval_exit,
        )
        if eval_db_enabled:
            suite_summary = _safe_load_json("outputs/eval_suite/summary.json") or {}
            suite_gate = (suite_summary.get("gate") or {}).get("status") or "completed"
            suite_payload = _db_log_eval(
                db_file=db_file,
                eval_name="expression_suite",
                summary_path="outputs/eval_suite/summary.json",
                status=str(suite_gate),
                extra={"dir": expression_dir, "style": "tegang"},
            )
            gate = ((suite_payload or {}).get("gate") or {}).get("status")
            if gate:
                conn = connect_db(db_file, ensure_schema=True)
                try:
                    upsert_recommendation(
                        conn,
                        rec_key="expression_suite_gate",
                        rec_value=str(gate),
                        reason="expression_suite_summary",
                    )
                finally:
                    conn.close()
        run_step(
            "expression_select",
            ["python", "scripts_py/select_expression_default.py", "--dir", expression_dir, "--styles", expression_select_styles],
        )
        if eval_db_enabled:
            _db_upsert_runtime_recs(db_file)
            _db_log_eval(
                db_file=db_file,
                eval_name="expression_select",
                summary_path="config/expression/defaults.json",
                status="applied",
                extra={"styles": expression_select_styles},
            )

    if run_intonation_eval:
        run_step(
            "intonation_select",
            [
                "python",
                "scripts_py/select_auto_intonation.py",
                "--dir",
                expression_dir,
                "--outdir",
                intonation_outdir,
                "--style",
                hybrid_style,
                "--hybrid-prosody",
                "true",
                "--intensities",
                intonation_intensities,
                "--auto-expressive-candidates",
                intonation_auto_expressive,
                "--auto-expressive-off-margin",
                intonation_auto_expressive_off_margin,
            ],
        )
        if eval_db_enabled:
            _db_upsert_runtime_recs(db_file)
            _db_log_eval(
                db_file=db_file,
                eval_name="intonation_select",
                summary_path=f"{intonation_outdir}/summary.json",
                status="applied",
                extra={"dir": expression_dir, "style": hybrid_style},
            )

    if run_expression_ab:
        run_step(
            "expression_ab",
            [
                "python",
                "scripts_py/eval_expression_ab.py",
                "--dir",
                expression_ab_dir,
                "--outdir",
                expression_ab_outdir,
                "--style-a",
                expression_ab_style_a,
                "--style-b",
                expression_ab_style_b,
                "--intensity-a",
                expression_ab_intensity_a,
                "--intensity-b",
                expression_ab_intensity_b,
            ],
        )
        if eval_db_enabled:
            payload = _db_log_eval(
                db_file=db_file,
                eval_name="expression_ab",
                summary_path=f"{expression_ab_outdir}/summary.json",
                status="completed",
                extra={"dir": expression_ab_dir},
            )
            winner = ((payload or {}).get("score") or {}).get("winner")
            if winner:
                conn = connect_db(db_file, ensure_schema=True)
                try:
                    upsert_recommendation(
                        conn,
                        rec_key="expression_ab_winner",
                        rec_value=str(winner),
                        reason="expression_ab_summary",
                    )
                finally:
                    conn.close()
        if apply_expression_ab:
            run_step(
                "expression_ab_apply",
                ["python", "scripts_py/apply_expression_ab_default.py", "--summary", f"{expression_ab_outdir}/summary.json"],
            )
            if eval_db_enabled:
                _db_upsert_runtime_recs(db_file)

    if run_voice_eval:
        voice_exit = (0,) if voice_strict else (0, 2)
        run_step(
            "voice_suite",
            ["python", "scripts_py/eval_voice_character_suite.py", "--dir", voice_eval_dir],
            allowed_exit_codes=voice_exit,
        )
        if eval_db_enabled:
            payload = _db_log_eval(
                db_file=db_file,
                eval_name="voice_suite",
                summary_path="outputs/voice_eval_suite/summary.json",
                status="completed",
                extra={"dir": voice_eval_dir},
            )
            gate = ((payload or {}).get("gate") or {}).get("status")
            if gate:
                conn = connect_db(db_file, ensure_schema=True)
                try:
                    upsert_recommendation(
                        conn,
                        rec_key="voice_suite_gate",
                        rec_value=str(gate),
                        reason="voice_suite_summary",
                    )
                finally:
                    conn.close()

    if run_hybrid_eval:
        hybrid_exit = (0,) if hybrid_strict else (0, 2)
        run_step(
            "hybrid_ab",
            ["python", "scripts_py/eval_hybrid_ab.py", "--dir", hybrid_eval_dir, "--style", hybrid_style, "--outdir", hybrid_outdir],
            allowed_exit_codes=hybrid_exit,
        )
        if eval_db_enabled:
            payload = _db_log_eval(
                db_file=db_file,
                eval_name="hybrid_ab",
                summary_path=f"{hybrid_outdir}/summary.json",
                status="completed",
                extra={"dir": hybrid_eval_dir, "style": hybrid_style},
            )
            winner = ((payload or {}).get("score") or {}).get("winner")
            if winner:
                conn = connect_db(db_file, ensure_schema=True)
                try:
                    upsert_recommendation(
                        conn,
                        rec_key="hybrid_ab_winner",
                        rec_value=str(winner),
                        reason="hybrid_ab_summary",
                    )
                finally:
                    conn.close()
        if apply_hybrid_ab:
            run_step(
                "hybrid_ab_apply",
                ["python", "scripts_py/apply_hybrid_ab_default.py", "--summary", f"{hybrid_outdir}/summary.json"],
            )
            if eval_db_enabled:
                _db_upsert_runtime_recs(db_file)

    if run_limiter_eval:
        run_step(
            "limiter_select",
            [
                "python",
                "scripts_py/select_prosody_limiter.py",
                "--dir",
                expression_dir,
                "--style",
                hybrid_style,
                "--hybrid-prosody",
                "true",
                "--outdir",
                limiter_outdir,
                "--strengths",
                limiter_strengths,
            ],
        )
        if eval_db_enabled:
            _db_upsert_runtime_recs(db_file)
            _db_log_eval(
                db_file=db_file,
                eval_name="limiter_select",
                summary_path=f"{limiter_outdir}/summary.json",
                status="applied",
                extra={"dir": expression_dir, "style": hybrid_style},
            )

    if run_limiter_train:
        run_step(
            "limiter_train",
            [
                "python",
                "scripts_py/train_limiter_policy.py",
                "--feedback-source",
                trainer_feedback_source,
                "--db-file",
                db_file,
            ],
        )
        if apply_limiter_policy:
            run_step(
                "limiter_policy_apply",
                ["python", "scripts_py/apply_limiter_policy_default.py", "--style", hybrid_style],
            )

    if run_final_tts:
        run_step(
            "final_tts",
            [
                "node",
                "scripts/generate-tts.mjs",
                "--input",
                final_tts_input,
                "--output",
                final_tts_output,
                "--humanize",
                "true" if final_tts_humanize else "false",
            ],
        )

    print("self_train:done")


if __name__ == "__main__":
    main()
