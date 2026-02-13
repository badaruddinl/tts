import json
import os
from pathlib import Path
from datetime import datetime, timezone

from common_pipeline import ensure_dir, parse_args, run_cmd


def to_num(v, fallback=0.0):
    try:
        n = float(v)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    except Exception:
        pass
    return fallback


def score_summary(summary):
    m = summary.get("metrics", {})
    gate = summary.get("gate", {}).get("status") == "pass"
    auto = to_num(m.get("avgAutoTransitionDelta"), 99)
    over = to_num(m.get("avgOverrideTransitionDelta"), 99)
    changed = to_num(m.get("avgChangedIntentSegments"), 99)
    coverage = to_num(m.get("avgOverrideIntentSegments"), 0)
    score = over * 0.55 + auto * 0.35 + changed * 0.1
    if not gate:
        score += 3.5
    if coverage < 0.8:
        score += 2
    return round(score, 6)


def run_suite(tests_dir, out_dir, style):
    cmd = [
        "python",
        "scripts_py/eval_expression_suite.py",
        "--dir",
        str(tests_dir),
        "--outdir",
        str(out_dir),
        "--style",
        str(style),
    ]
    run_cmd(cmd, allowed_exit_codes=(0, 2))
    summary_path = Path(out_dir) / "summary.json"
    if not summary_path.exists():
        raise RuntimeError(f"summary_not_found style={style} path={summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    args = parse_args(os.sys.argv[1:])
    tests_dir = Path(str(args.get("dir") or "tests/expressions")).resolve()
    styles = [s.strip() for s in str(args.get("styles") or "tegang,natural,sinematik,narator_tegas,melankolis").split(",") if s.strip()]
    base_out = Path(str(args.get("outdir") or "outputs/eval_select")).resolve()
    config = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    ensure_dir(str(base_out))
    ensure_dir(str(config.parent))

    results = []
    for style in styles:
        style_out = base_out / style
        ensure_dir(str(style_out))
        summary = run_suite(tests_dir, style_out, style)
        score = score_summary(summary)
        gate = summary.get("gate", {}).get("status", "unknown")
        print(f"style_eval style={style} score={score} gate={gate}")
        results.append(
            {
                "style": style,
                "score": score,
                "gate": gate,
                "metrics": summary.get("metrics", {}),
                "summaryFile": str((style_out / "summary.json").relative_to(Path.cwd())).replace("\\", "/"),
            }
        )
    results.sort(key=lambda x: x.get("score", 9999))
    best = results[0]
    payload = {
        "updatedAt": datetime.now(timezone.utc).isoformat(),
        "source": {
            "testsDir": str(tests_dir.relative_to(Path.cwd())).replace("\\", "/"),
            "candidateStyles": styles,
        },
        "selected": {"style": best["style"], "score": best["score"], "gate": best["gate"]},
        "ranking": results,
    }
    with open(config, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(f"expression_default_selected style={best['style']} config={str(config.relative_to(Path.cwd())).replace('\\', '/')}")


if __name__ == "__main__":
    main()
