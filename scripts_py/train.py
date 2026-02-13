import argparse
import json
import os
import subprocess
from datetime import datetime, timezone
from pathlib import Path

from train_ml_policy import run_training as run_ml_training
from training_db import (
    connect_db,
    default_db_path,
    insert_metric,
    record_training_run,
    register_model_version,
    upsert_recommendation,
)


def now_iso():
    return datetime.now(timezone.utc).isoformat()


def rel(cwd, target):
    return str(Path(target).resolve().relative_to(Path(cwd).resolve())).replace("\\", "/")


def run_cmd(cmd):
    res = subprocess.run(cmd, cwd=os.getcwd(), shell=False)
    code = int(res.returncode or 0)
    if code != 0:
        raise RuntimeError(f"step_failed exit={code} cmd={' '.join(cmd)}")


def run_profile(db_file, min_feedback=1):
    cwd = os.getcwd()
    run_key = f"profile_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    started_at = now_iso()
    out_name = f"train_db_profile_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}.json"
    cmd = [
        "python",
        "scripts_py/train_profile.py",
        "--feedback-source",
        "sqlite",
        "--db-file",
        str(db_file),
        "--apply",
        "true",
        "--min-feedback",
        str(int(min_feedback)),
        "--output-file",
        out_name,
    ]
    run_cmd(cmd)
    profile_path = Path(cwd) / "config" / "profiles" / out_name

    conn = connect_db(db_file, ensure_schema=True)
    mv = register_model_version(
        conn,
        model_name="profile",
        path=rel(cwd, profile_path),
        source="python",
        meta={"trainer": "train.py"},
        trained_at=now_iso(),
    )
    record_training_run(
        conn,
        run_key=run_key,
        trainer="python",
        model_name="profile",
        model_path=rel(cwd, profile_path),
        data_source=f"sqlite:{rel(cwd, db_file)}",
        status="trained",
        sample_count=None,
        started_at=started_at,
        ended_at=now_iso(),
        raw_payload={"modelVersion": mv["version"]},
    )
    upsert_recommendation(
        conn,
        rec_key="active_profile",
        rec_value=out_name,
        reason="latest_profile_training",
    )
    conn.close()
    return {"status": "trained", "model": rel(cwd, profile_path), "version": mv["version"]}


def run_ml(db_file, output_model, summary_file=""):
    cwd = os.getcwd()
    run_key = f"ml_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    started_at = now_iso()
    res = run_ml_training(
        feedback_file="data/training/feedback.ndjson",
        feedback_source="sqlite",
        db_file=str(db_file),
        output_model=str(output_model),
        summary_file=str(summary_file or ""),
        style_scope="",
        use_cache=True,
    )

    conn = connect_db(db_file, ensure_schema=True)
    if res.get("status") == "trained":
        mv = register_model_version(
            conn,
            model_name="prosody_policy",
            path=rel(cwd, output_model),
            source="python",
            meta={"trainer": "train.py", "feedback": res.get("feedbackFile")},
            trained_at=now_iso(),
        )
        record_training_run(
            conn,
            run_key=run_key,
            trainer="python",
            model_name="prosody_policy",
            model_path=rel(cwd, output_model),
            data_source=str(res.get("feedbackFile") or f"sqlite:{rel(cwd, db_file)}"),
            status="trained",
            sample_count=int(res.get("sampleCount") or 0),
            summary_path=rel(cwd, summary_file) if summary_file else "",
            started_at=started_at,
            ended_at=now_iso(),
            raw_payload=res,
        )
        insert_metric(conn, run_key=run_key, metric_key="sample_count", metric_value=float(res.get("sampleCount") or 0), model_version_id=mv["id"])
        upsert_recommendation(
            conn,
            rec_key="active_prosody_policy",
            rec_value=rel(cwd, output_model),
            reason="latest_ml_training",
            score=float(res.get("sampleCount") or 0),
        )
    else:
        record_training_run(
            conn,
            run_key=run_key,
            trainer="python",
            model_name="prosody_policy",
            model_path=rel(cwd, output_model),
            data_source=str(res.get("feedbackFile") or f"sqlite:{rel(cwd, db_file)}"),
            status="skipped",
            sample_count=int(res.get("sampleCount") or 0),
            summary_path=rel(cwd, summary_file) if summary_file else "",
            started_at=started_at,
            ended_at=now_iso(),
            raw_payload=res,
        )
    conn.close()
    return res


def run_limiter(db_file, output_model, summary_file=""):
    cwd = os.getcwd()
    run_key = f"limiter_{datetime.now(timezone.utc).strftime('%Y%m%d%H%M%S')}"
    started_at = now_iso()
    cmd = [
        "python",
        "scripts_py/train_limiter_policy.py",
        "--feedback-source",
        "sqlite",
        "--db-file",
        str(db_file),
        "--output-model",
        str(output_model),
    ]
    if summary_file:
        cmd += ["--summary-file", str(summary_file)]
    run_cmd(cmd)

    conn = connect_db(db_file, ensure_schema=True)
    mv = register_model_version(
        conn,
        model_name="limiter_policy",
        path=rel(cwd, output_model),
        source="python",
        meta={"trainer": "train.py"},
        trained_at=now_iso(),
    )
    record_training_run(
        conn,
        run_key=run_key,
        trainer="python",
        model_name="limiter_policy",
        model_path=rel(cwd, output_model),
        data_source=f"sqlite:{rel(cwd, db_file)}",
        status="trained",
        sample_count=None,
        summary_path=rel(cwd, summary_file) if summary_file else "",
        started_at=started_at,
        ended_at=now_iso(),
        raw_payload={"model": rel(cwd, output_model)},
    )
    upsert_recommendation(
        conn,
        rec_key="active_limiter_policy",
        rec_value=rel(cwd, output_model),
        reason="latest_limiter_training",
    )
    conn.close()
    return {"status": "trained", "modelPath": rel(cwd, output_model), "version": mv["version"]}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-file", default="data/training/training.db")
    parser.add_argument("--mode", default="all", choices=["all", "profile", "ml", "limiter"])
    parser.add_argument("--ml-output", default="models/prosody-policy-v1.json")
    parser.add_argument("--ml-summary", default="")
    parser.add_argument("--limiter-output", default="models/limiter-policy-v1-py.json")
    parser.add_argument("--limiter-summary", default="")
    parser.add_argument("--min-feedback", type=int, default=1)
    args = parser.parse_args()

    cwd = os.getcwd()
    db_file = Path(str(args.db_file).strip() or str(default_db_path(cwd))).resolve()
    if not db_file.exists():
        raise RuntimeError(f"sqlite_db_not_found={db_file}")

    out = {"db": rel(cwd, db_file), "mode": args.mode, "steps": []}
    if args.mode in ("all", "profile"):
        out["steps"].append({"profile": run_profile(db_file, min_feedback=args.min_feedback)})
    if args.mode in ("all", "ml"):
        out["steps"].append({"ml": run_ml(db_file, Path(args.ml_output).resolve(), summary_file=args.ml_summary)})
    if args.mode in ("all", "limiter"):
        out["steps"].append({"limiter": run_limiter(db_file, Path(args.limiter_output).resolve(), summary_file=args.limiter_summary)})

    print(json.dumps(out, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
