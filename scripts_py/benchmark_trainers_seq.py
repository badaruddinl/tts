import sys
from _node_wrap import run_powershell


if __name__ == "__main__":
    args = ["scripts/benchmark-trainers.ps1"] + sys.argv[1:]
    sys.exit(run_powershell(args))
