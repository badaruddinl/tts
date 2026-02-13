import os
import subprocess
import sys

from common_pipeline import parse_args, to_bool


def run_step(name, cmd, allowed_exit_codes=(0,)):
    res = subprocess.run(cmd, cwd=os.getcwd(), shell=False)
    code = int(res.returncode or 0)
    if code not in tuple(allowed_exit_codes):
        raise RuntimeError(f"step_failed={name} exit={code}")


def main():
    args = parse_args(sys.argv[1:])
    trainer = str(args.get("trainer") or "py").strip().lower()
    if trainer not in ("js", "py"):
        raise RuntimeError(f"invalid_trainer={trainer} expected=js|py")

    intensity = float(args.get("intensity") or 1.0)
    intensity = max(0.0, min(1.0, intensity))
    voices = [v.strip() for v in str(args.get("voices") or "id-ID-ArdiNeural,id-ID-GadisNeural").split(",") if v.strip()]
    min_feedback = int(float(args.get("min-feedback") or 1))
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
    if run_schema_migrate:
        run_step("schema_migrate", ["node", "scripts/migrate-feedback-schema.mjs", "--drop-legacy", "true"])
    run_step("dedupe", ["node", "scripts/dedupe-training-data.mjs"])
    run_step("style_detail", ["node", "scripts/enrich-style-feedback.mjs"])

    if trainer == "py":
        run_step("profile_py", ["python", "scripts_py/train_profile.py", "--apply", "true", "--min-feedback", str(min_feedback)])
        run_step("ml_all_py", ["python", "scripts_py/train_ml_policy.py"])
    else:
        run_step("profile", ["node", "scripts/train-profile.mjs", "--apply", "true", "--min-feedback", str(min_feedback)])
        run_step("ml_all", ["node", "scripts/train-ml-policy.mjs"])

    if styles:
        picked = [s.strip() for s in styles.split(",") if s.strip()]
        for style in picked:
            if trainer == "py":
                run_step(
                    f"ml_{style}_py",
                    [
                        "python",
                        "scripts_py/train_ml_policy.py",
                        "--style",
                        style,
                        "--feedback-file",
                        f"data/training/styles/{style}/feedback.ndjson",
                    ],
                )
            else:
                run_step(f"ml_{style}", ["node", "scripts/train-ml-policy.mjs", "--style", style])

    if run_benchmark:
        for voice in voices:
            bench_cmd = ["node", "scripts/generate-style-benchmarks.mjs", "--voice", voice, "--intensity", str(intensity)]
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
        run_step(
            "expression_select",
            ["python", "scripts_py/select_expression_default.py", "--dir", expression_dir, "--styles", expression_select_styles],
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
        if apply_expression_ab:
            run_step(
                "expression_ab_apply",
                ["python", "scripts_py/apply_expression_ab_default.py", "--summary", f"{expression_ab_outdir}/summary.json"],
            )

    if run_voice_eval:
        voice_exit = (0,) if voice_strict else (0, 2)
        run_step(
            "voice_suite",
            ["python", "scripts_py/eval_voice_character_suite.py", "--dir", voice_eval_dir],
            allowed_exit_codes=voice_exit,
        )

    if run_hybrid_eval:
        hybrid_exit = (0,) if hybrid_strict else (0, 2)
        run_step(
            "hybrid_ab",
            ["python", "scripts_py/eval_hybrid_ab.py", "--dir", hybrid_eval_dir, "--style", hybrid_style, "--outdir", hybrid_outdir],
            allowed_exit_codes=hybrid_exit,
        )
        if apply_hybrid_ab:
            run_step(
                "hybrid_ab_apply",
                ["python", "scripts_py/apply_hybrid_ab_default.py", "--summary", f"{hybrid_outdir}/summary.json"],
            )

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

    if run_limiter_train:
        run_step("limiter_train", ["python", "scripts_py/train_limiter_policy.py"])
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
