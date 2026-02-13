import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args


def to_num(v, fallback=0.0):
    try:
        n = float(v)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    except Exception:
        pass
    return fallback


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def main():
    args = parse_args(os.sys.argv[1:])
    summary_path = Path(str(args.get("summary") or "outputs/eval_hybrid_ab_self/summary.json")).resolve()
    config_path = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    if not summary_path.exists():
        raise RuntimeError(f"summary_not_found: {summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        summary = json.load(f)
    winner = str(((summary.get("score") or {}).get("winner") or "tie"))
    selected_hybrid = winner in ("hybrid_on", "tie")
    score_delta = to_num(((summary.get("score") or {}).get("deltaOffMinusOn")), 0.0)
    metrics = ((summary.get("metrics") or {}).get("hybridOn" if selected_hybrid else "hybridOff") or {})
    transition_delta = to_num(metrics.get("avgOverrideTransitionDelta"), 6.0)
    changed_intent = to_num(metrics.get("avgChangedIntentSegments"), 0.5)
    limiter_strength = clamp(0.5 + transition_delta / 28 + changed_intent / 12 + score_delta / 45, 0.5, 0.82)

    defaults = {}
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                defaults = json.load(f)
        except Exception:
            defaults = {}
    now = datetime.now(timezone.utc).isoformat()
    defaults["updatedAt"] = now
    rt = defaults.get("selectedRuntime", {})
    rt["source"] = "hybrid_ab"
    rt["hybridProsody"] = selected_hybrid
    rt["prosodyLimiter"] = {"enabled": True, "strength": round(float(limiter_strength), 3)}
    defaults["selectedRuntime"] = rt
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(defaults, f, indent=2, ensure_ascii=False)
    print(
        f"hybrid_ab_applied winner={winner} hybrid={str(selected_hybrid).lower()} limiter={rt['prosodyLimiter']['strength']}"
    )


if __name__ == "__main__":
    main()
