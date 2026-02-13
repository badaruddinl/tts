import argparse
import json
import os
from pathlib import Path

from training_db import connect_db, default_db_path, insert_feedback, insert_jobs, insert_style_feedback


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--kind", required=True)
    parser.add_argument("--payload-file", required=True)
    parser.add_argument("--db-file", default="")
    parser.add_argument("--scope", default="global")
    parser.add_argument("--style-key", default="")
    parser.add_argument("--source-file", default="")
    args = parser.parse_args()

    kind = str(args.kind).strip().lower()
    payload_file = Path(str(args.payload_file)).resolve()
    if not payload_file.exists():
        raise RuntimeError(f"payload_file_not_found={payload_file}")

    with open(payload_file, "r", encoding="utf-8") as f:
        payload = json.load(f)

    if not isinstance(payload, dict):
        raise RuntimeError("invalid_payload_expected_object")

    db_path = str(args.db_file).strip() or str(default_db_path(os.getcwd()))
    conn = connect_db(db_path, ensure_schema=True)

    if kind == "jobs":
        inserted = insert_jobs(
            conn,
            [payload],
            scope=str(args.scope or "global"),
            style_key=str(args.style_key or ""),
            source_file=str(args.source_file or ""),
        )
    elif kind == "feedback":
        inserted = insert_feedback(
            conn,
            [payload],
            scope=str(args.scope or "global"),
            style_key=str(args.style_key or ""),
            source_file=str(args.source_file or ""),
        )
    elif kind in ("style-feedback", "style_feedback"):
        inserted = insert_style_feedback(
            conn,
            [payload],
            source_file=str(args.source_file or ""),
        )
    else:
        conn.close()
        raise RuntimeError(f"invalid_kind={kind}")

    conn.close()
    print(f"sqlite_append_ok kind={kind} inserted={inserted}")


if __name__ == "__main__":
    main()
