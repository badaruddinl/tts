import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args


def clamp(n, lo, hi):
    return max(lo, min(hi, n))


def to_num(v, fallback=0.0):
    try:
        n = float(v)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    except Exception:
        pass
    return fallback


def main():
    args = parse_args(os.sys.argv[1:])
    summary_path = Path(str(args.get("summary") or "outputs/eval_expression_ab_self/summary.json")).resolve()
    config_path = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    if not summary_path.exists():
        raise RuntimeError(f"summary_not_found: {summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        summary = json.load(f)
    winner = str(((summary.get("score") or {}).get("winner") or "tie"))
    selected_key = "A" if winner == "A" else "B"
    cfg = ((summary.get("configs") or {}).get(selected_key) or {})
    if not cfg:
        raise RuntimeError(f"winner_config_not_found: {selected_key}")
    metrics = (summary.get("metrics") or {}).get(selected_key) or {}
    transition_delta = to_num(metrics.get("avgOverrideTransitionDelta"), 6.0)
    changed_intent = to_num(metrics.get("avgChangedIntentSegments"), 0.5)
    limiter_strength = clamp(0.52 + transition_delta / 28.0 + changed_intent / 12.0, 0.5, 0.82)

    defaults = {}
    if config_path.exists():
        try:
            with open(config_path, "r", encoding="utf-8") as f:
                defaults = json.load(f)
        except Exception:
            defaults = {}
    now = datetime.now(timezone.utc).isoformat()
    defaults["updatedAt"] = now
    defaults["selectedRuntime"] = {
        "source": "expression_ab",
        "winner": selected_key,
        "style": str(cfg.get("style") or "").strip() or "natural",
        "profileFile": str(cfg.get("profileFile") or "active"),
        "humanizeIntensity": clamp(to_num(cfg.get("humanizeIntensity"), 0.6), 0.0, 1.0),
        "hybridProsody": bool(cfg.get("hybridProsody")),
        "prosodyLimiter": {"enabled": True, "strength": round(float(limiter_strength), 3)},
    }
    config_path.parent.mkdir(parents=True, exist_ok=True)
    with open(config_path, "w", encoding="utf-8") as f:
        json.dump(defaults, f, indent=2, ensure_ascii=False)
    print(
        f"expression_ab_applied winner={selected_key} style={defaults['selectedRuntime']['style']} "
        f"intensity={defaults['selectedRuntime']['humanizeIntensity']} "
        f"hybrid={str(defaults['selectedRuntime']['hybridProsody']).lower()} "
        f"limiter={defaults['selectedRuntime']['prosodyLimiter']['strength']}"
    )


if __name__ == "__main__":
    main()
