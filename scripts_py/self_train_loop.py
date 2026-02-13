import signal
import subprocess
import sys
import time

from common_pipeline import parse_args, to_bool


def main():
    args = parse_args(sys.argv[1:])
    trainer = str(args.get("trainer") or "py").strip().lower()
    stop_on_error = to_bool(args.get("stop-on-error"), False)
    sleep_ms = int(float(args.get("sleep-ms") or 2000))
    max_runs = int(float(args.get("max-runs") or 0))

    passthrough = []
    local = {"trainer", "stop-on-error", "sleep-ms", "max-runs"}
    raw = sys.argv[1:]
    i = 0
    while i < len(raw):
      token = raw[i]
      if token.startswith("--"):
        key = token[2:]
        nxt = raw[i + 1] if i + 1 < len(raw) else None
        has_value = bool(nxt) and not nxt.startswith("--")
        if key in local:
          i += 2 if has_value else 1
          continue
        passthrough.append(token)
        if has_value:
          passthrough.append(nxt)
          i += 2
        else:
          i += 1
      else:
        passthrough.append(token)
        i += 1

    stopping = {"v": False}

    def _stop_handler(_sig, _frame):
        stopping["v"] = True
        print("\nloop: stop requested (Ctrl+C), waiting current run to finish...")

    signal.signal(signal.SIGINT, _stop_handler)
    signal.signal(signal.SIGTERM, _stop_handler)

    round_no = 0
    while not stopping["v"]:
        if max_runs > 0 and round_no >= max_runs:
            break
        round_no += 1
        print(f"loop: run #{round_no} (trainer={trainer})")
        cmd = ["python", "scripts_py/self_train.py", "--trainer", trainer] + passthrough
        res = subprocess.run(cmd, shell=False)
        code = int(res.returncode or 0)
        if code != 0 and stop_on_error:
            raise SystemExit(code)
        if stopping["v"]:
            break
        if sleep_ms > 0:
            time.sleep(sleep_ms / 1000.0)
    print("loop: stopped")


if __name__ == "__main__":
    main()
