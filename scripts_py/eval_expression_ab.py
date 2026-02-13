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


def run_suite(
    tests_dir,
    out_dir,
    style,
    profile_file,
    hybrid_prosody,
    humanize_intensity,
    prosody_limiter=True,
    prosody_limiter_strength=0.64,
):
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
        "--humanize-intensity",
        str(humanize_intensity),
        "--prosody-limiter",
        "true" if prosody_limiter else "false",
        "--prosody-limiter-strength",
        str(prosody_limiter_strength),
    ]
    if profile_file:
        cmd += ["--profile-file", str(profile_file)]
    run_cmd(cmd, allowed_exit_codes=(0, 2))
    summary_path = Path(out_dir) / "summary.json"
    if not summary_path.exists():
        raise RuntimeError(f"summary_missing {summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        return json.load(f)


def main():
    args = parse_args(os.sys.argv[1:])
    tests_dir = Path(str(args.get("dir") or "tests/expressions")).resolve()
    out_dir = Path(str(args.get("outdir") or "outputs/eval_expression_ab")).resolve()
    style_a = str(args.get("style-a") or "tegang")
    style_b = str(args.get("style-b") or style_a)
    profile_a = str(args.get("profile-a") or "").strip()
    profile_b = str(args.get("profile-b") or "").strip()
    hybrid_a = str(args.get("hybrid-a", "true")).lower() == "true"
    hybrid_b = str(args.get("hybrid-b", "true")).lower() == "true"
    intensity_a = float(args.get("intensity-a") or 0.4)
    intensity_b = float(args.get("intensity-b") or 0.7)
    limiter = str(args.get("prosody-limiter", "true")).lower() == "true"
    limiter_strength = float(args.get("prosody-limiter-strength") or 0.64)

    ensure_dir(str(out_dir))
    a_dir = out_dir / "a"
    b_dir = out_dir / "b"
    ensure_dir(str(a_dir))
    ensure_dir(str(b_dir))
    a = run_suite(tests_dir, a_dir, style_a, profile_a, hybrid_a, intensity_a, limiter, limiter_strength)
    b = run_suite(tests_dir, b_dir, style_b, profile_b, hybrid_b, intensity_b, limiter, limiter_strength)

    a_score = score_summary(a)
    b_score = score_summary(b)
    delta = round(a_score - b_score, 6)
    winner = "B" if b_score < a_score else "A" if b_score > a_score else "tie"
    payload = {
        "generatedAt": datetime.now(timezone.utc).isoformat(),
        "testsDir": str(tests_dir.relative_to(Path.cwd())).replace("\\", "/"),
        "configs": {
            "A": {
                "style": style_a,
                "profileFile": profile_a or "active",
                "hybridProsody": hybrid_a,
                "humanizeIntensity": intensity_a,
            },
            "B": {
                "style": style_b,
                "profileFile": profile_b or "active",
                "hybridProsody": hybrid_b,
                "humanizeIntensity": intensity_b,
            },
        },
        "score": {"A": a_score, "B": b_score, "deltaAminusB": delta, "winner": winner},
        "gate": {"A": a.get("gate", {}).get("status", "unknown"), "B": b.get("gate", {}).get("status", "unknown")},
        "metrics": {"A": a.get("metrics", {}), "B": b.get("metrics", {})},
        "reports": {
            "A": str((a_dir / "summary.json").relative_to(Path.cwd())).replace("\\", "/"),
            "B": str((b_dir / "summary.json").relative_to(Path.cwd())).replace("\\", "/"),
        },
    }
    report_json = out_dir / "summary.json"
    with open(report_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    md = [
        "# Expression A/B",
        "",
        f"- generatedAt: {payload['generatedAt']}",
        f"- testsDir: `{payload['testsDir']}`",
        "",
        "| mode | score | gate | style | profile | hybrid | intensity |",
        "|---|---:|---|---|---|---|---:|",
        f"| A | {a_score} | {payload['gate']['A']} | {style_a} | {profile_a or 'active'} | {hybrid_a} | {intensity_a} |",
        f"| B | {b_score} | {payload['gate']['B']} | {style_b} | {profile_b or 'active'} | {hybrid_b} | {intensity_b} |",
        "",
        f"Winner: **{winner}** (delta A-B: {delta})",
    ]
    with open(out_dir / "summary.md", "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    print(f"expression_ab_done winner={winner} report={str(report_json.relative_to(Path.cwd())).replace('\\', '/')}")


if __name__ == "__main__":
    main()
