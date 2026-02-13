import os
import shutil
import zipfile
from datetime import datetime
from pathlib import Path

from common_pipeline import parse_args, to_bool


def _ts():
    return datetime.now().strftime("%Y%m%d-%H%M%S")


def _copy_tree(src, dst):
    src = Path(src)
    dst = Path(dst)
    if not src.exists():
        return
    if src.is_file():
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
        return
    dst.mkdir(parents=True, exist_ok=True)
    for fp in src.rglob("*"):
        if not fp.is_file():
            continue
        rel = fp.relative_to(src)
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(fp, target)


if __name__ == "__main__":
    args = parse_args(os.sys.argv[1:])
    file_arg = str(args.get("file") or "").strip()
    if not file_arg:
        raise SystemExit("Usage: npm run pack:import -- --file backups/training-pack-xxxx.zip")
    root = Path(os.getcwd()).resolve()
    zip_path = Path(file_arg).resolve()
    if not zip_path.exists():
        raise SystemExit(f"Zip not found: {zip_path}")
    sqlite_only = to_bool(args.get("sqlite-only"), False)
    tmp_root = root / ".tmp" / f"import-{_ts()}"
    backup_root = root / "backups" / f"pre-import-{_ts()}"
    tmp_root.mkdir(parents=True, exist_ok=True)
    backup_root.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(zip_path, "r") as zf:
        zf.extractall(tmp_root)
    candidates = ["config/profiles", "data/training/training.db", "models", ".env"] if sqlite_only else ["config/profiles", "data/training", "models", ".env"]
    restored = []
    backups = []
    for rel in candidates:
        src = (tmp_root / rel).resolve()
        if not src.exists():
            continue
        dst = (root / rel).resolve()
        if dst.exists():
            bdst = (backup_root / rel).resolve()
            _copy_tree(dst, bdst)
            backups.append(str(bdst.relative_to(root)).replace("\\", "/"))
        _copy_tree(src, dst)
        restored.append(rel.replace("\\", "/"))
    print(f"Imported from: {zip_path}")
    print(f"Restored: {', '.join(restored) if restored else '-'}")
    print(f"Backup dir: {str(backup_root.relative_to(root)).replace('\\\\', '/')}")
    print(f"Backed up: {', '.join(backups) if backups else '-'}")
    print(f"SQLite only: {str(sqlite_only).lower()}")
