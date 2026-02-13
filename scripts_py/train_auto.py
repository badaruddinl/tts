import os
import subprocess
import sys


if __name__ == "__main__":
    cmd = ["python", "scripts_py/train.py", "--mode", "all", "--db-file", "data/training/training.db"] + sys.argv[1:]
    res = subprocess.run(cmd, cwd=os.getcwd(), shell=False)
    raise SystemExit(int(res.returncode or 0))
