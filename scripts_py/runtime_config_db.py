import argparse
import json
import os
import sqlite3
from pathlib import Path

from training_db import connect_db, default_db_path, upsert_recommendation


def _norm(p):
    return str(p or "").replace("\\", "/")


def _read_json_artifact(conn, rel_path):
    row = conn.execute(
        "SELECT content_text FROM json_artifacts WHERE path = ? LIMIT 1",
        (_norm(rel_path),),
    ).fetchone()
    if not row:
        return None
    try:
        return json.loads(row[0])
    except Exception:
        return None


def action_get_json(conn, rel_path):
    payload = _read_json_artifact(conn, rel_path)
    return {"ok": bool(payload is not None), "path": _norm(rel_path), "json": payload}


def action_get_active_profile(conn):
    row = conn.execute(
        "SELECT rec_value FROM recommendations WHERE rec_key='active_profile' LIMIT 1"
    ).fetchone()
    if row and str(row[0] or "").strip():
        return {"ok": True, "activeProfile": str(row[0]).strip(), "source": "recommendations"}

    active_cfg = _read_json_artifact(conn, "config/profiles/active.json")
    name = ""
    if isinstance(active_cfg, dict):
        name = str(active_cfg.get("activeProfile") or "").strip()
    if name:
        return {"ok": True, "activeProfile": name, "source": "json_artifacts"}
    return {"ok": False, "activeProfile": None}


def action_set_active_profile(conn, name):
    value = str(name or "").strip()
    if not value:
        return {"ok": False, "error": "empty_profile_name"}
    upsert_recommendation(conn, rec_key="active_profile", rec_value=value, reason="runtime_config_set")
    return {"ok": True, "activeProfile": value}


def action_list_profiles(conn):
    rows = conn.execute(
        """
        SELECT path FROM json_artifacts
        WHERE path LIKE 'config/profiles/%.json'
          AND path <> 'config/profiles/active.json'
        ORDER BY path ASC
        """
    ).fetchall()
    items = []
    for r in rows:
        p = str(r[0] or "")
        base = Path(p).name
        if base and base.endswith(".json") and base != "active.json":
            items.append(base)
    # unique + stable
    uniq = []
    seen = set()
    for x in items:
        if x in seen:
            continue
        seen.add(x)
        uniq.append(x)
    return {"ok": True, "profiles": uniq}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--action", required=True, choices=["get-json", "get-active-profile", "set-active-profile", "list-profiles"])
    parser.add_argument("--path", default="")
    parser.add_argument("--value", default="")
    parser.add_argument("--db-file", default="")
    args = parser.parse_args()

    cwd = os.getcwd()
    db_path = str(args.db_file).strip() or str(default_db_path(cwd))
    target = Path(db_path).resolve()
    if not target.exists():
        print(json.dumps({"ok": False, "error": "db_not_found", "db": str(target)}))
        return

    conn = connect_db(str(target), ensure_schema=True)
    try:
        if args.action == "get-json":
            out = action_get_json(conn, args.path)
        elif args.action == "get-active-profile":
            out = action_get_active_profile(conn)
        elif args.action == "set-active-profile":
            out = action_set_active_profile(conn, args.value)
        elif args.action == "list-profiles":
            out = action_list_profiles(conn)
        else:
            out = {"ok": False, "error": "invalid_action"}
    finally:
        conn.close()

    print(json.dumps(out, ensure_ascii=False))


if __name__ == "__main__":
    main()
