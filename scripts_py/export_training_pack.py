import os
import json
import zipfile
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args, to_bool


def _ts():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _add_path(zf, root, rel, files):
    p = (root / rel).resolve()
    if not p.exists():
        return
    if p.is_file():
        zf.write(p, arcname=str(Path(rel).as_posix()))
        files.append(str(Path(rel).as_posix()))
        return
    for fp in p.rglob("*"):
        if not fp.is_file():
            continue
        arc = str(fp.resolve().relative_to(root).as_posix())
        zf.write(fp, arcname=arc)
    files.append(f"{Path(rel).as_posix()}/")


if __name__ == "__main__":
    args = parse_args(os.sys.argv[1:])
    root = Path(os.getcwd()).resolve()
    out_dir = root / "backups"
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = Path(str(args.get("output") or (out_dir / f"training-pack-{_ts()}.zip"))).resolve()
    include_env = to_bool(args.get("include-env"), False)
    sqlite_only = to_bool(args.get("sqlite-only"), False)
    targets = ["config/profiles", "data/training/training.db", "models"] if sqlite_only else ["config/profiles", "data/training", "models"]
    if include_env:
        targets.append(".env")
    files = []
    with zipfile.ZipFile(out_file, "w", compression=zipfile.ZIP_DEFLATED) as zf:
        for rel in targets:
            _add_path(zf, root, rel, files)
        manifest = {
            "createdAt": datetime.now(timezone.utc).isoformat(),
            "sourceHost": os.environ.get("COMPUTERNAME") or os.environ.get("HOSTNAME") or "unknown",
            "includeEnv": include_env,
            "sqliteOnly": sqlite_only,
            "files": files,
        }
        zf.writestr("training-pack.manifest.json", json.dumps(manifest, indent=2, ensure_ascii=False))
    print(f"Exported: {out_file}")
    print(f"Entries: {len(files)}")
    print(f"SQLite only: {str(sqlite_only).lower()}")
