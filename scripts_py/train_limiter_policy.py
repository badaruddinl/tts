import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args
from limiter_policy import build_samples, read_ndjson, save_model, train_linear
from training_db import (
    connect_db,
    default_db_path,
    fetch_feedback_rows,
    load_json_artifact_lookup,
    record_training_run,
    register_model_version,
    resolve_source_mode,
    source_label_for_sqlite,
    upsert_recommendation,
)


def main():
    args = parse_args(os.sys.argv[1:])
    cwd = os.getcwd()
    style = str(args.get("style") or "").strip().lower()
    db_file = str(args.get("db-file") or default_db_path(cwd)).strip()
    feedback_source = str(args.get("feedback-source") or "auto").strip().lower()
    run_key = f"limiter_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S%f')}"
    started_at = datetime.now(timezone.utc).isoformat()
    default_feedback = (
        Path(cwd) / "data" / "training" / "styles" / style / "feedback.ndjson"
        if style
        else Path(cwd) / "data" / "training" / "feedback.ndjson"
    )
    feedback_path = Path(str(args.get("feedback-file") or default_feedback)).resolve()
    output_model = Path(str(args.get("output-model") or "models/limiter-policy-v1-py.json")).resolve()
    summary_file = str(args.get("summary-file") or "").strip()
    source_mode = resolve_source_mode(feedback_source, db_file, fallback="ndjson")
    if source_mode == "sqlite":
        conn = connect_db(db_file, ensure_schema=True)
        rows = fetch_feedback_rows(conn, style=style, source_scope="style" if style else "global")
        prosody_lookup = load_json_artifact_lookup(conn, kind="prosody_json")
        conn.close()
        source_label = source_label_for_sqlite(
            cwd,
            db_file,
            style_scope=style,
            source_scope="style" if style else "global",
        )
    else:
        rows = read_ndjson(str(feedback_path))
        prosody_lookup = None
        source_label = str(feedback_path.relative_to(Path(cwd))).replace("\\", "/")
    samples = build_samples(cwd, rows, style=style, prosody_lookup=prosody_lookup)
    res = train_linear(samples, ridge=1e-6)
    if res.get("status") != "trained":
        conn = connect_db(db_file, ensure_schema=True)
        record_training_run(
            conn,
            run_key=run_key,
            trainer="python",
            model_name="limiter_policy",
            model_path=str(output_model.relative_to(Path(cwd))).replace("\\", "/"),
            summary_path=str(Path(summary_file).resolve().relative_to(Path(cwd))).replace("\\", "/") if summary_file else "",
            data_source=source_label,
            style_scope=style or "all",
            status="skipped",
            sample_count=int(res.get("sampleCount", 0)),
            started_at=started_at,
            ended_at=datetime.now(timezone.utc).isoformat(),
            raw_payload=res,
        )
        conn.close()
        print(f"limiter_training_skipped reason={res.get('reason')} samples={res.get('sampleCount', 0)}")
        return

    payload = {
        "modelType": "linear_py_v1",
        "intercept": float(res["intercept"]),
        "weights": [float(v) for v in res["weights"]],
        "meta": {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sampleCount": int(res["sampleCount"]),
            "styleScope": style or "all",
            "feedbackFile": source_label,
            "feedbackSource": source_mode,
            "version": "limiter-policy-v1-py",
            "trainer": "python",
        },
    }
    saved = save_model(str(output_model), payload)
    conn = connect_db(db_file, ensure_schema=True)
    mv = register_model_version(
        conn,
        model_name="limiter_policy",
        path=str(saved.relative_to(Path(cwd))).replace("\\", "/"),
        source="python",
        trained_at=payload["meta"]["createdAt"],
        meta=payload.get("meta", {}),
    )
    record_training_run(
        conn,
        run_key=run_key,
        trainer="python",
        model_name="limiter_policy",
        model_path=str(saved.relative_to(Path(cwd))).replace("\\", "/"),
        summary_path=str(Path(summary_file).resolve().relative_to(Path(cwd))).replace("\\", "/") if summary_file else "",
        data_source=source_label,
        style_scope=style or "all",
        status="trained",
        sample_count=int(res["sampleCount"]),
        started_at=started_at,
        ended_at=datetime.now(timezone.utc).isoformat(),
        raw_payload={"version": mv["version"], "sampleCount": int(res["sampleCount"])},
    )
    upsert_recommendation(
        conn,
        rec_key="active_limiter_policy",
        rec_value=str(saved.relative_to(Path(cwd))).replace("\\", "/"),
        reason="latest_limiter_training",
        score=float(res["sampleCount"]),
    )
    conn.close()
    print(
        f"limiter_policy_trained model={str(saved.relative_to(Path(cwd))).replace('\\', '/')} samples={res['sampleCount']}"
    )
    if summary_file:
        sp = Path(summary_file).resolve()
        sp.parent.mkdir(parents=True, exist_ok=True)
        with open(sp, "w", encoding="utf-8") as f:
            json.dump(
                {
                    "status": "trained",
                    "modelPath": str(saved.relative_to(Path(cwd))).replace("\\", "/"),
                    "sampleCount": int(res["sampleCount"]),
                    "styleScope": style or "all",
                },
                f,
                indent=2,
                ensure_ascii=False,
            )


if __name__ == "__main__":
    main()
