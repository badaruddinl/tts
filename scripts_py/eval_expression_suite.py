import json
import os
from pathlib import Path
from datetime import datetime, timezone

from common_pipeline import parse_args
from eval_auto_expression import evaluate_auto_expression


def safe_avg(items):
    return (sum(items) / len(items)) if items else 0.0


def main():
    args = parse_args(os.sys.argv[1:])
    tests_dir = Path(str(args.get("dir") or "tests/expressions")).resolve()
    report_dir = Path(str(args.get("outdir") or "outputs/eval_suite")).resolve()
    style = str(args.get("style") or "tegang").strip()
    profile_file = str(args.get("profile-file") or "").strip() or None
    hybrid_prosody = str(args.get("hybrid-prosody", "true")).lower() == "true"
    humanize_intensity = float(args.get("humanize-intensity") or 0.7)
    prosody_limiter = str(args.get("prosody-limiter", "true")).lower() == "true"
    prosody_limiter_strength = float(args.get("prosody-limiter-strength") or 0.64)
    auto_expressive = str(args.get("auto-expressive", "true")).lower() == "true"
    max_auto_delta = float(args.get("max-auto-delta") or 9.8)
    max_override_delta = float(args.get("max-override-delta") or 10.2)
    min_avg_override_segments = float(args.get("min-avg-override-segments") or 0.8)
    max_avg_changed_segments = float(args.get("max-avg-changed-segments") or 1.6)

    if not tests_dir.exists():
        raise RuntimeError(f"Tests directory not found: {tests_dir}")
    report_dir.mkdir(parents=True, exist_ok=True)
    files = sorted([p for p in tests_dir.iterdir() if p.is_file() and p.suffix.lower() == ".txt"])
    if not files:
        raise RuntimeError(f"No .txt test files found in {tests_dir}")

    rows = []
    for fp in files:
        out_path = report_dir / f"{fp.stem}.json"
        report = evaluate_auto_expression(
            input_path=str(fp),
            style=style,
            profile_file=profile_file,
            humanize_intensity=humanize_intensity,
            hybrid_prosody=hybrid_prosody,
            prosody_limiter=prosody_limiter,
            prosody_limiter_strength=prosody_limiter_strength,
            auto_expressive=auto_expressive,
        )
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(report, f, indent=2, ensure_ascii=False)
        m = report.get("metrics", {})
        rows.append(
            {
                "file": fp.name,
                "segments": int(report.get("segments", 0)),
                "changedIntentSegments": float(m.get("changedIntentSegments", 0)),
                "overrideIntentSegments": float(m.get("overrideIntentSegments", 0)),
                "autoTransitionDelta": float(m.get("autoTransitionDelta", 0)),
                "overrideTransitionDelta": float(m.get("overrideTransitionDelta", 0)),
                "autoProsodyEnergy": float(m.get("autoProsodyEnergy", 0)),
                "overrideProsodyEnergy": float(m.get("overrideProsodyEnergy", 0)),
            }
        )

    summary = {
        "at": datetime.now(timezone.utc).isoformat(),
        "dir": str(tests_dir.relative_to(Path.cwd())).replace("\\", "/"),
        "style": style,
        "profileFile": profile_file or "active",
        "hybridProsody": hybrid_prosody,
        "caseCount": len(rows),
        "metrics": {
            "avgSegments": round(safe_avg([r["segments"] for r in rows]), 3),
            "avgChangedIntentSegments": round(safe_avg([r["changedIntentSegments"] for r in rows]), 3),
            "avgOverrideIntentSegments": round(safe_avg([r["overrideIntentSegments"] for r in rows]), 3),
            "avgAutoTransitionDelta": round(safe_avg([r["autoTransitionDelta"] for r in rows]), 3),
            "avgOverrideTransitionDelta": round(safe_avg([r["overrideTransitionDelta"] for r in rows]), 3),
            "avgAutoProsodyEnergy": round(safe_avg([r["autoProsodyEnergy"] for r in rows]), 3),
            "avgOverrideProsodyEnergy": round(safe_avg([r["overrideProsodyEnergy"] for r in rows]), 3),
        },
    }
    checks = {
        "autoTransitionOk": summary["metrics"]["avgAutoTransitionDelta"] <= max_auto_delta,
        "overrideTransitionOk": summary["metrics"]["avgOverrideTransitionDelta"] <= max_override_delta,
        "overrideCoverageOk": summary["metrics"]["avgOverrideIntentSegments"] >= min_avg_override_segments,
        "changedIntentOk": summary["metrics"]["avgChangedIntentSegments"] <= max_avg_changed_segments,
    }
    passed = all(bool(v) for v in checks.values())
    summary["gate"] = {
        "status": "pass" if passed else "fail",
        "thresholds": {
            "maxAutoDelta": max_auto_delta,
            "maxOverrideDelta": max_override_delta,
            "minAvgOverrideSegments": min_avg_override_segments,
            "maxAvgChangedSegments": max_avg_changed_segments,
        },
        "checks": checks,
    }
    summary["cases"] = []
    for row in rows:
        summary["cases"].append(
            {
                **row,
                "gate": {
                    "autoDeltaOk": row["autoTransitionDelta"] <= max_auto_delta,
                    "overrideDeltaOk": row["overrideTransitionDelta"] <= max_override_delta,
                    "overrideCoverageOk": row["overrideIntentSegments"] >= 1,
                },
            }
        )

    summary_json = report_dir / "summary.json"
    with open(summary_json, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)

    md_lines = [
        "# Expression Eval Suite Summary",
        "",
        f"- Generated at: {summary['at']}",
        f"- Test dir: `{summary['dir']}`",
        f"- Style: `{summary['style']}`",
        f"- Cases: {summary['caseCount']}",
        "",
        "## Aggregate Metrics",
        "",
        f"- avgSegments: {summary['metrics']['avgSegments']}",
        f"- avgChangedIntentSegments: {summary['metrics']['avgChangedIntentSegments']}",
        f"- avgOverrideIntentSegments: {summary['metrics']['avgOverrideIntentSegments']}",
        f"- avgAutoTransitionDelta: {summary['metrics']['avgAutoTransitionDelta']}",
        f"- avgOverrideTransitionDelta: {summary['metrics']['avgOverrideTransitionDelta']}",
        f"- avgAutoProsodyEnergy: {summary['metrics']['avgAutoProsodyEnergy']}",
        f"- avgOverrideProsodyEnergy: {summary['metrics']['avgOverrideProsodyEnergy']}",
        "",
        "## Quality Gate",
        "",
        f"- status: **{summary['gate']['status'].upper()}**",
        f"- autoTransitionOk: {summary['gate']['checks']['autoTransitionOk']}",
        f"- overrideTransitionOk: {summary['gate']['checks']['overrideTransitionOk']}",
        f"- overrideCoverageOk: {summary['gate']['checks']['overrideCoverageOk']}",
        f"- changedIntentOk: {summary['gate']['checks']['changedIntentOk']}",
        "",
        "## Cases",
        "",
        "| file | segments | changedIntent | overrideIntent | autoDelta | overrideDelta | gate |",
        "|---|---:|---:|---:|---:|---:|---|",
    ]
    for row in summary["cases"]:
        row_pass = row["gate"]["autoDeltaOk"] and row["gate"]["overrideDeltaOk"] and row["gate"]["overrideCoverageOk"]
        md_lines.append(
            f"| {row['file']} | {row['segments']} | {row['changedIntentSegments']} | {row['overrideIntentSegments']} | "
            f"{row['autoTransitionDelta']} | {row['overrideTransitionDelta']} | {'pass' if row_pass else 'fail'} |"
        )
    summary_md = report_dir / "summary.md"
    with open(summary_md, "w", encoding="utf-8") as f:
        f.write("\n".join(md_lines) + "\n")

    print(
        f"eval_suite_done cases={len(rows)} gate={summary['gate']['status']} "
        f"summary_json={str(summary_json.relative_to(Path.cwd())).replace('\\', '/')} "
        f"summary_md={str(summary_md.relative_to(Path.cwd())).replace('\\', '/')}"
    )
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
