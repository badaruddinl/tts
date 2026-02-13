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
    energy = to_num(m.get("avgOverrideProsodyEnergy"), 0)
    energy_penalty = (6.5 - energy) * 0.9 if energy < 6.5 else (energy - 17.5) * 0.6 if energy > 17.5 else 0
    score = over * 0.5 + auto * 0.3 + changed * 0.1 + energy_penalty
    if not gate:
        score += 3.5
    if coverage < 0.8:
        score += 2
    return round(score, 6)


def run_suite(
    tests_dir,
    out_dir,
    style,
    hybrid_prosody,
    prosody_limiter,
    prosody_limiter_strength,
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
        "--prosody-limiter",
        "true" if prosody_limiter else "false",
        "--prosody-limiter-strength",
        str(prosody_limiter_strength),
    ]
    run_cmd(cmd, allowed_exit_codes=(0, 2))
    summary_path = Path(out_dir) / "summary.json"
    if not summary_path.exists():
        raise RuntimeError(f"summary_not_found: {summary_path}")
    with open(summary_path, "r", encoding="utf-8") as f:
        return json.load(f)


def load_defaults(path_obj):
    if not path_obj.exists():
        return {}
    try:
        with open(path_obj, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def main():
    args = parse_args(os.sys.argv[1:])
    tests_dir = Path(str(args.get("dir") or "tests/expressions")).resolve()
    out_dir = Path(str(args.get("outdir") or "outputs/eval_limiter_select")).resolve()
    cfg = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    style = str(args.get("style") or "tegang")
    hybrid = str(args.get("hybrid-prosody", "true")).lower() == "true"
    strengths = []
    for s in str(args.get("strengths") or "0.5,0.58,0.64,0.7,0.78").split(","):
        s = s.strip()
        if not s:
            continue
        try:
            strengths.append(max(0.3, min(1.0, float(s))))
        except Exception:
            continue
    ensure_dir(str(out_dir))
    ensure_dir(str(cfg.parent))

    candidates = [{"key": "off", "prosodyLimiter": False, "strength": 0.64}]
    candidates.extend(
        [{"key": f"on_{val:.2f}", "prosodyLimiter": True, "strength": val} for val in strengths]
    )
    ranking = []
    for c in candidates:
        case_out = out_dir / c["key"]
        ensure_dir(str(case_out))
        summary = run_suite(
            tests_dir=tests_dir,
            out_dir=case_out,
            style=style,
            hybrid_prosody=hybrid,
            prosody_limiter=bool(c["prosodyLimiter"]),
            prosody_limiter_strength=float(c["strength"]),
        )
        ranking.append(
            {
                "key": c["key"],
                "prosodyLimiter": bool(c["prosodyLimiter"]),
                "strength": round(float(c["strength"]), 3),
                "score": score_summary(summary),
                "gate": summary.get("gate", {}).get("status", "unknown"),
                "metrics": summary.get("metrics", {}),
                "summaryFile": str((case_out / "summary.json").relative_to(Path.cwd())).replace("\\", "/"),
            }
        )
    ranking.sort(key=lambda x: x["score"])
    best = ranking[0]

    defaults = load_defaults(cfg)
    now = datetime.now(timezone.utc).isoformat()
    defaults["updatedAt"] = now
    rt = defaults.get("selectedRuntime", {})
    rt["source"] = "limiter_select"
    rt["prosodyLimiter"] = {"enabled": bool(best["prosodyLimiter"]), "strength": float(best["strength"])}
    defaults["selectedRuntime"] = rt
    defaults["limiterSelection"] = {
        "updatedAt": now,
        "style": style,
        "hybridProsody": hybrid,
        "strengths": strengths,
        "selected": best,
        "ranking": ranking,
    }
    with open(cfg, "w", encoding="utf-8") as f:
        json.dump(defaults, f, indent=2, ensure_ascii=False)
    summary_payload = {"updatedAt": now, "style": style, "hybridProsody": hybrid, "selected": best, "ranking": ranking}
    with open(out_dir / "summary.json", "w", encoding="utf-8") as f:
        json.dump(summary_payload, f, indent=2, ensure_ascii=False)
    print(
        f"limiter_selected enabled={str(best['prosodyLimiter']).lower()} strength={best['strength']} score={best['score']}"
    )


if __name__ == "__main__":
    main()
