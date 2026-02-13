import argparse
import json
import os
from pathlib import Path

from training_db import (
    connect_db,
    default_db_path,
    insert_auto_train_runs,
    insert_feedback,
    insert_jobs,
    insert_ml_split_rows,
    insert_style_feedback,
    read_ndjson,
    upsert_ml_split_meta,
    upsert_json_artifact,
    upsert_model_file,
)


def _collect_training_files(cwd):
    train_dir = Path(cwd) / "data" / "training"
    files = []

    files.append(
        {
            "kind": "jobs",
            "scope": "global",
            "style_key": "",
            "path": train_dir / "jobs.ndjson",
        }
    )
    files.append(
        {
            "kind": "feedback",
            "scope": "global",
            "style_key": "",
            "path": train_dir / "feedback.ndjson",
        }
    )

    styles_dir = train_dir / "styles"
    if styles_dir.exists():
        for style_dir in sorted([d for d in styles_dir.iterdir() if d.is_dir()]):
            style_key = style_dir.name.strip().lower()
            files.append(
                {
                    "kind": "jobs",
                    "scope": "style",
                    "style_key": style_key,
                    "path": style_dir / "jobs.ndjson",
                }
            )
            files.append(
                {
                    "kind": "feedback",
                    "scope": "style",
                    "style_key": style_key,
                    "path": style_dir / "feedback.ndjson",
                }
            )
    return files


def migrate(cwd, db_file):
    db_path = Path(db_file).resolve()
    conn = connect_db(db_path, ensure_schema=True)

    stats = {
        "jobsRead": 0,
        "jobsInserted": 0,
        "feedbackRead": 0,
        "feedbackInserted": 0,
        "styleFeedbackInserted": 0,
        "autoTrainRunsInserted": 0,
        "mlSplitRowsInserted": 0,
        "modelFilesUpserted": 0,
        "jsonArtifactsUpserted": 0,
        "prosodyArtifactsUpserted": 0,
        "filesScanned": 0,
    }

    for item in _collect_training_files(cwd):
        src = item["path"]
        if not src.exists():
            continue

        rows = read_ndjson(src)
        rel = str(src.resolve().relative_to(Path(cwd).resolve())).replace("\\", "/")
        stats["filesScanned"] += 1
        if item["kind"] == "jobs":
            stats["jobsRead"] += len(rows)
            stats["jobsInserted"] += insert_jobs(
                conn,
                rows,
                scope=item["scope"],
                style_key=item["style_key"],
                source_file=rel,
            )
        else:
            stats["feedbackRead"] += len(rows)
            stats["feedbackInserted"] += insert_feedback(
                conn,
                rows,
                scope=item["scope"],
                style_key=item["style_key"],
                source_file=rel,
            )
            if item["scope"] == "style" and item["style_key"]:
                stats["styleFeedbackInserted"] += insert_style_feedback(
                    conn,
                    rows,
                    source_file=rel,
                )

    train_dir = Path(cwd) / "data" / "training"
    auto_runs = train_dir / "auto-train-runs.ndjson"
    if auto_runs.exists():
        rows = read_ndjson(auto_runs)
        stats["filesScanned"] += 1
        stats["autoTrainRunsInserted"] += insert_auto_train_runs(
            conn,
            rows,
            source_file=str(auto_runs.resolve().relative_to(Path(cwd).resolve())).replace("\\", "/"),
        )

    split_dir = train_dir / "splits" / "ml"
    for split_name in ("train", "valid", "test"):
        fp = split_dir / f"{split_name}.ndjson"
        if not fp.exists():
            continue
        rows = read_ndjson(fp)
        stats["filesScanned"] += 1
        stats["mlSplitRowsInserted"] += insert_ml_split_rows(
            conn,
            rows,
            split_name=split_name,
            source_file=str(fp.resolve().relative_to(Path(cwd).resolve())).replace("\\", "/"),
        )
    manifest_fp = split_dir / "manifest.json"
    if manifest_fp.exists():
        stats["filesScanned"] += 1
        try:
            with open(manifest_fp, "r", encoding="utf-8") as f:
                manifest = json.load(f)
            upsert_ml_split_meta(
                conn,
                source_file=str(manifest_fp.resolve().relative_to(Path(cwd).resolve())).replace("\\", "/"),
                meta_payload=manifest,
            )
        except Exception:
            pass

    models_dir = Path(cwd) / "models"
    if models_dir.exists():
        for fp in models_dir.rglob("*.json"):
            if not fp.is_file():
                continue
            if upsert_model_file(conn, fp, cwd=cwd):
                stats["modelFilesUpserted"] += 1
            if upsert_json_artifact(conn, fp, kind="model_json", cwd=cwd):
                stats["jsonArtifactsUpserted"] += 1

    profiles_dir = Path(cwd) / "config" / "profiles"
    if profiles_dir.exists():
        for fp in profiles_dir.glob("*.json"):
            if not fp.is_file():
                continue
            if upsert_json_artifact(conn, fp, kind="profile_json", cwd=cwd):
                stats["jsonArtifactsUpserted"] += 1

    expr_defaults = Path(cwd) / "config" / "expression" / "defaults.json"
    if expr_defaults.exists() and expr_defaults.is_file():
        if upsert_json_artifact(conn, expr_defaults, kind="expression_defaults_json", cwd=cwd):
            stats["jsonArtifactsUpserted"] += 1

    voice_presets = Path(cwd) / "config" / "voice-character" / "presets.json"
    if voice_presets.exists() and voice_presets.is_file():
        if upsert_json_artifact(conn, voice_presets, kind="voice_presets_json", cwd=cwd):
            stats["jsonArtifactsUpserted"] += 1

    outputs_dir = Path(cwd) / "outputs"
    if outputs_dir.exists():
        for fp in outputs_dir.rglob("*.prosody.json"):
            if not fp.is_file():
                continue
            if upsert_json_artifact(conn, fp, kind="prosody_json", cwd=cwd):
                stats["prosodyArtifactsUpserted"] += 1
                stats["jsonArtifactsUpserted"] += 1

    jobs_total = conn.execute("SELECT COUNT(*) AS c FROM jobs").fetchone()["c"]
    feedback_total = conn.execute("SELECT COUNT(*) AS c FROM feedback").fetchone()["c"]
    auto_runs_total = conn.execute("SELECT COUNT(*) AS c FROM auto_train_runs").fetchone()["c"]
    ml_split_total = conn.execute("SELECT COUNT(*) AS c FROM ml_split_rows").fetchone()["c"]
    model_files_total = conn.execute("SELECT COUNT(*) AS c FROM model_files").fetchone()["c"]
    json_artifacts_total = conn.execute("SELECT COUNT(*) AS c FROM json_artifacts").fetchone()["c"]
    prosody_artifacts_total = conn.execute(
        "SELECT COUNT(*) AS c FROM json_artifacts WHERE kind = 'prosody_json'"
    ).fetchone()["c"]
    conn.close()

    return {
        "dbPath": str(db_path),
        "filesScanned": stats["filesScanned"],
        "jobsRead": stats["jobsRead"],
        "jobsInserted": stats["jobsInserted"],
        "feedbackRead": stats["feedbackRead"],
        "feedbackInserted": stats["feedbackInserted"],
        "styleFeedbackInserted": stats["styleFeedbackInserted"],
        "autoTrainRunsInserted": stats["autoTrainRunsInserted"],
        "mlSplitRowsInserted": stats["mlSplitRowsInserted"],
        "modelFilesUpserted": stats["modelFilesUpserted"],
        "jsonArtifactsUpserted": stats["jsonArtifactsUpserted"],
        "prosodyArtifactsUpserted": stats["prosodyArtifactsUpserted"],
        "jobsTotal": int(jobs_total),
        "feedbackTotal": int(feedback_total),
        "autoTrainRunsTotal": int(auto_runs_total),
        "mlSplitRowsTotal": int(ml_split_total),
        "modelFilesTotal": int(model_files_total),
        "jsonArtifactsTotal": int(json_artifacts_total),
        "prosodyArtifactsTotal": int(prosody_artifacts_total),
    }


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--db-file", default="")
    args = parser.parse_args()

    cwd = os.getcwd()
    db_file = str(args.db_file).strip()
    db_file = db_file if db_file else str(default_db_path(cwd))
    res = migrate(cwd, db_file)

    rel_db = str(Path(res["dbPath"]).resolve().relative_to(Path(cwd).resolve())).replace("\\", "/")
    print(f"sqlite_migrate_done db={rel_db}")
    print(f"files_scanned={res['filesScanned']}")
    print(f"jobs_read={res['jobsRead']} jobs_inserted={res['jobsInserted']} jobs_total={res['jobsTotal']}")
    print(
        f"feedback_read={res['feedbackRead']} feedback_inserted={res['feedbackInserted']} feedback_total={res['feedbackTotal']}"
    )
    print(f"style_feedback_inserted={res['styleFeedbackInserted']}")
    print(
        f"auto_train_runs_inserted={res['autoTrainRunsInserted']} auto_train_runs_total={res['autoTrainRunsTotal']}"
    )
    print(f"ml_split_rows_inserted={res['mlSplitRowsInserted']} ml_split_rows_total={res['mlSplitRowsTotal']}")
    print(f"model_files_upserted={res['modelFilesUpserted']} model_files_total={res['modelFilesTotal']}")
    print(
        f"json_artifacts_upserted={res['jsonArtifactsUpserted']} json_artifacts_total={res['jsonArtifactsTotal']}"
    )
    print(
        f"prosody_artifacts_upserted={res['prosodyArtifactsUpserted']} prosody_artifacts_total={res['prosodyArtifactsTotal']}"
    )


if __name__ == "__main__":
    main()
