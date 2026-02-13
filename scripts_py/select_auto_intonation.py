import json
import os
from datetime import datetime, timezone
from pathlib import Path

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
    energy_penalty = (7 - energy) * 0.8 if energy < 7 else (energy - 18) * 0.5 if energy > 18 else 0
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
    profile_file,
    hybrid_prosody,
    humanize_intensity,
    auto_expressive,
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
        "--humanize-intensity",
        str(humanize_intensity),
        "--auto-expressive",
        "true" if auto_expressive else "false",
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
    cwd = Path(os.getcwd())
    tests_dir = Path(str(args.get("dir") or "tests/expressions")).resolve()
    out_dir = Path(str(args.get("outdir") or "outputs/eval_intonation_select")).resolve()
    cfg_path = Path(str(args.get("config") or "config/expression/defaults.json")).resolve()
    style = str(args.get("style") or "tegang")
    profile_file = str(args.get("profile-file") or "").strip()
    hybrid_prosody = str(args.get("hybrid-prosody", "true")).lower() == "true"
    prosody_limiter = str(args.get("prosody-limiter", "true")).lower() == "true"
    prosody_limiter_strength = float(args.get("prosody-limiter-strength") or 0.64)
    intensities = []
    for raw in str(args.get("intensities") or "0.45,0.55,0.64,0.72,0.8").split(","):
        raw = raw.strip()
        if not raw:
            continue
        try:
            intensities.append(max(0.0, min(1.0, float(raw))))
        except Exception:
            continue
    expressive_modes = []
    for raw in str(args.get("auto-expressive-candidates") or "true,false").split(","):
        v = raw.strip().lower()
        if v in ("true", "false"):
            expressive_modes.append(v == "true")
    off_margin = max(0.0, min(0.5, float(args.get("auto-expressive-off-margin") or 0.1)))

    ensure_dir(str(out_dir))
    ensure_dir(str(cfg_path.parent))
    ranking = []
    for intensity in intensities:
        for auto_expressive in expressive_modes:
            key = f"int_{intensity:.2f}_ae_{'on' if auto_expressive else 'off'}"
            case_out = out_dir / key
            ensure_dir(str(case_out))
            summary = run_suite(
                tests_dir=tests_dir,
                out_dir=case_out,
                style=style,
                profile_file=profile_file,
                hybrid_prosody=hybrid_prosody,
                humanize_intensity=intensity,
                auto_expressive=auto_expressive,
                prosody_limiter=prosody_limiter,
                prosody_limiter_strength=prosody_limiter_strength,
            )
            ranking.append(
                {
                    "key": key,
                    "humanizeIntensity": round(float(intensity), 3),
                    "autoExpressive": bool(auto_expressive),
                    "score": score_summary(summary),
                    "gate": summary.get("gate", {}).get("status", "unknown"),
                    "metrics": summary.get("metrics", {}),
                    "summaryFile": str((case_out / "summary.json").relative_to(cwd)).replace("\\", "/"),
                }
            )
    ranking.sort(key=lambda x: x["score"])
    best = ranking[0]
    best_on = next((r for r in ranking if r.get("autoExpressive") is True), None)
    best_off = next((r for r in ranking if r.get("autoExpressive") is False), None)
    if best_on and best_off and float(best_off["score"]) < float(best_on["score"]):
        rel_gain = (float(best_on["score"]) - float(best_off["score"])) / max(float(best_on["score"]), 1e-9)
        if rel_gain < off_margin:
            best = best_on

    defaults = {}
    if cfg_path.exists():
        try:
            with open(cfg_path, "r", encoding="utf-8") as f:
                defaults = json.load(f)
        except Exception:
            defaults = {}
    now = datetime.now(timezone.utc).isoformat()
    defaults["updatedAt"] = now
    rt = defaults.get("selectedRuntime", {})
    rt["source"] = "auto_intonation_select"
    rt["style"] = rt.get("style") or style
    rt["humanizeIntensity"] = float(best["humanizeIntensity"])
    rt["autoExpressive"] = bool(best["autoExpressive"])
    defaults["selectedRuntime"] = rt
    defaults["intonationSelection"] = {
        "updatedAt": now,
        "style": style,
        "hybridProsody": hybrid_prosody,
        "prosodyLimiter": prosody_limiter,
        "prosodyLimiterStrength": prosody_limiter_strength,
        "intensities": intensities,
        "expressiveModes": expressive_modes,
        "autoExpressiveOffMargin": off_margin,
        "selected": best,
        "ranking": ranking,
    }
    with open(cfg_path, "w", encoding="utf-8") as f:
        json.dump(defaults, f, indent=2, ensure_ascii=False)
    with open(out_dir / "summary.json", "w", encoding="utf-8") as f:
        json.dump({"updatedAt": now, "style": style, "selected": best, "ranking": ranking}, f, indent=2, ensure_ascii=False)
    print(
        f"intonation_selected intensity={best['humanizeIntensity']} "
        f"auto_expressive={str(best['autoExpressive']).lower()} score={best['score']}"
    )


if __name__ == "__main__":
    main()
