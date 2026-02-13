import json
import os
import subprocess
import sys
from pathlib import Path


def parse_args(argv):
    out = {}
    i = 0
    while i < len(argv):
        item = argv[i]
        if not item.startswith("--"):
            i += 1
            continue
        key = item[2:]
        nxt = argv[i + 1] if i + 1 < len(argv) else None
        if nxt is None or str(nxt).startswith("--"):
            out[key] = True
            i += 1
            continue
        out[key] = nxt
        i += 2
    return out


def to_bool(value, default=False):
    if isinstance(value, bool):
        return value
    if value is None:
        return default
    v = str(value).strip().lower()
    if v in ("1", "true", "yes", "y", "on"):
        return True
    if v in ("0", "false", "no", "n", "off"):
        return False
    return default


def ensure_dir(path_str):
    Path(path_str).mkdir(parents=True, exist_ok=True)


def run_cmd(cmd, allowed_exit_codes=(0,), cwd=None, capture=False):
    if capture:
        res = subprocess.run(
            cmd,
            cwd=cwd or os.getcwd(),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
        )
    else:
        res = subprocess.run(cmd, cwd=cwd or os.getcwd(), shell=False)
    code = int(res.returncode or 0)
    if code not in tuple(allowed_exit_codes):
        if capture:
            detail = (res.stderr or res.stdout or "").strip()
            raise RuntimeError(f"step_failed exit={code}\n{detail}")
        raise RuntimeError(f"step_failed exit={code}")
    return res


def run_node_script(script_relpath, args=None, allowed_exit_codes=(0,), capture=False):
    cmd = ["node", Path(script_relpath).as_posix()] + list(args or [])
    return run_cmd(cmd, allowed_exit_codes=allowed_exit_codes, capture=capture)


def read_json(path_str):
    with open(path_str, "r", encoding="utf-8") as f:
        return json.load(f)


def write_json(path_str, payload):
    ensure_dir(str(Path(path_str).parent))
    with open(path_str, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
