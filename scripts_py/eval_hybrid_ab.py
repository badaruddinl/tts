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


def run_suite(tests_dir, out_dir, style, hybrid_prosody):
    cmd = [
        "python",
        "scripts_py/eval_expression_suite.py",
        "--dir",
        str(tests_dir),
        "--outdir",
        str(out_dir),
        "--style",
        str(style),
        "--hybrid-prosody",
        "true" if hybrid_prosody else "false",
    ]
    run_cmd(cmd, allowed_exit_codes=(0, 2))
    summary_path = Path(out_dir) / "summary.json"
    if not summary_path.exists():
        raise RuntimeError(f"summary_missing {summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    args = parse_args(os.sys.argv[1:])
    tests_dir = Path(str(args.get("dir") or "tests/expressions")).resolve()
    style = str(args.get("style") or "tegang")
    out_dir = Path(str(args.get("outdir") or "outputs/eval_hybrid_ab")).resolve()
    ensure_dir(str(out_dir))
    off_dir = out_dir / "hybrid_off"
    on_dir = out_dir / "hybrid_on"
    ensure_dir(str(off_dir))
    ensure_dir(str(on_dir))

    off = run_suite(tests_dir, off_dir, style, False)
    on = run_suite(tests_dir, on_dir, style, True)
    off_score = score_summary(off)
    on_score = score_summary(on)
    delta = round(off_score - on_score, 6)
    winner = "hybrid_on" if on_score < off_score else "hybrid_off" if on_score > off_score else "tie"
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "style": style,
        "testsDir": str(tests_dir.relative_to(Path.cwd())).replace("\\", "/"),
        "score": {"hybridOff": off_score, "hybridOn": on_score, "deltaOffMinusOn": delta, "winner": winner},
        "gate": {"hybridOff": off.get("gate", {}).get("status", "unknown"), "hybridOn": on.get("gate", {}).get("status", "unknown")},
        "metrics": {"hybridOff": off.get("metrics", {}), "hybridOn": on.get("metrics", {})},
        "reports": {
            "off": str((off_dir / "summary.json").relative_to(Path.cwd())).replace("\\", "/"),
            "on": str((on_dir / "summary.json").relative_to(Path.cwd())).replace("\\", "/"),
        },
    }
    report_json = out_dir / "summary.json"
    with open(report_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    md = [
        "# Hybrid Prosody A/B",
        "",
        f"- generatedAt: {payload['generatedAt']}",
        f"- style: {style}",
        f"- testsDir: `{payload['testsDir']}`",
        "",
        "| mode | score | gate |",
        "|---|---:|---|",
        f"| hybrid_off | {off_score} | {payload['gate']['hybridOff']} |",
        f"| hybrid_on | {on_score} | {payload['gate']['hybridOn']} |",
        "",
        f"Winner: **{winner}** (delta off-on: {delta})",
    ]
    with open(out_dir / "summary.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    print(f"hybrid_ab_done winner={winner} report={str(report_json.relative_to(Path.cwd())).replace('\\', '/')}")


if __name__ == "__main__":
    main()
