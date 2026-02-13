import subprocess
import sys
from pathlib import Path


def run_node(script_relpath, argv=None):
    argv = list(argv or sys.argv[1:])
    script_path = Path(script_relpath).as_posix()
    cmd = ["node", script_path] + argv
    res = subprocess.run(cmd)
    return res.returncode


def run_powershell(args):
    cmd = ["powershell", "-ExecutionPolicy", "Bypass", "-File"] + args
    res = subprocess.run(cmd)
    return res.returncode
