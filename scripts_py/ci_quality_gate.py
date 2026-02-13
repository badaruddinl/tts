import subprocess
import sys


STEPS = [
    ("prod_eval_strict", ["cmd", "/c", "npm", "run", "prod:eval:strict"]),
]


def main():
    for name, cmd in STEPS:
        print(f"[quality-gate] start {name}: {' '.join(cmd)}")
        res = subprocess.run(cmd, shell=False)
        code = int(res.returncode or 0)
        if code != 0:
            print(f"[quality-gate] fail {name} exit={code}")
            return code
        print(f"[quality-gate] pass {name}")
    print("[quality-gate] all_pass")
    return 0


if __name__ == "__main__":
    sys.exit(main())
