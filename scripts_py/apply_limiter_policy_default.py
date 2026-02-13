import json
import os
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args
from limiter_policy import (
    clamp,
    predict_strength,
    read_ndjson,
    load_model,
    summarize_rows_for_style,
    summary_to_feature,
)


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
    cwd = Path(os.getcwd())
    cfg_path = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    model_path = Path(str(args.get("model") or "models/limiter-policy-v1-py.json")).resolve()
    style_arg = str(args.get("style") or "").strip()
    alpha = clamp(to_num(args.get("alpha"), 0.65), 0.0, 1.0)
    feedback_path = Path(str(args.get("feedback-file") or "data/training/feedback.ndjson")).resolve()

    defaults = {}
    if cfg_path.exists():
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                defaults = json.load(f)
        except Exception:
            defaults = {}
    style = (
        style_arg
        or str(((defaults.get("selectedRuntime") or {}).get("style") or "")).strip()
        or str(((defaults.get("selected") or {}).get("style") or "")).strip()
        or "natural"
    )
    fallback = clamp(to_num(((defaults.get("selectedRuntime") or {}).get("prosodyLimiter") or {}).get("strength"), 0.64), 0.45, 0.9)
    rows = read_ndjson(str(feedback_path))
    summary = summarize_rows_for_style(str(cwd), rows, style=str(style).lower())
    feat = summary_to_feature(summary)
    model = load_model(str(model_path))
    predicted = predict_strength(model, feat, fallback=fallback)
    blended = clamp((1 - alpha) * fallback + alpha * predicted, 0.45, 0.9)

    now = datetime.now(timezone.utc).isoformat()
    defaults["updatedAt"] = now
    rt = defaults.get("selectedRuntime", {})
    rt["style"] = style
    rt["prosodyLimiter"] = {"enabled": True, "strength": round(float(blended), 3)}
    defaults["selectedRuntime"] = rt
    defaults["limiterPolicy"] = {
        "updatedAt": now,
        "style": style,
        "alpha": alpha,
        "fallbackStrength": round(float(fallback), 3),
        "predictedStrength": round(float(predicted), 3),
        "blendedStrength": round(float(blended), 3),
        "modelMeta": (model or {}).get("meta") if isinstance(model, dict) else None,
        "feedbackFile": str(feedback_path.relative_to(cwd)).replace("\\", "/"),
    }
    cfg_path.parent.mkdir(parents=True, exist_ok=True)
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(defaults, f, indent=2, ensure_ascii=False)
    print(
        f"limiter_policy_applied style={style} blended={blended:.3f} predicted={predicted:.3f} alpha={alpha}"
    )


if __name__ == "__main__":
    main()
