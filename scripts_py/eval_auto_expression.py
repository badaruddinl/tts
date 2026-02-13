import json
import os
import tempfile
from pathlib import Path

from common_pipeline import parse_args, run_node_script


def evaluate_auto_expression(
    input_path,
    style=None,
    profile_file=None,
    humanize_intensity=0.7,
    hybrid_prosody=True,
    prosody_limiter=True,
    prosody_limiter_strength=0.64,
    auto_expressive=True,
):
    with tempfile.NamedTemporaryFile(prefix="eval_auto_", suffix=".json", delete=False) as tmp:
        tmp_path = tmp.name
    try:
        args = [
            "--input",
            str(Path(input_path).resolve()),
            "--output",
            tmp_path,
            "--humanize-intensity",
            str(humanize_intensity),
            "--hybrid-prosody",
            "true" if hybrid_prosody else "false",
            "--prosody-limiter",
            "true" if prosody_limiter else "false",
            "--prosody-limiter-strength",
            str(prosody_limiter_strength),
            "--auto-expressive",
            "true" if auto_expressive else "false",
        ]
        if style:
            args += ["--style", str(style)]
        if profile_file:
            args += ["--profile-file", str(profile_file)]
        run_node_script("scripts/eval-auto-expression.mjs", args=args, allowed_exit_codes=(0,))
        with open(tmp_path, "r", encoding="utf-8") as f:
            return json.load(f)
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


def main():
    args = parse_args(os.sys.argv[1:])
    input_path = str(args.get("input") or "text_intent_test.txt")
    output = str(args.get("output") or "outputs/auto_expression_eval.json")
    style = str(args.get("style") or "").strip() or None
    profile_file = str(args.get("profile-file") or "").strip() or None
    humanize_intensity = float(args.get("humanize-intensity") or 0.7)
    hybrid_prosody = str(args.get("hybrid-prosody", "true")).lower() == "true"
    prosody_limiter = str(args.get("prosody-limiter", "true")).lower() == "true"
    prosody_limiter_strength = float(args.get("prosody-limiter-strength") or 0.64)
    auto_expressive = str(args.get("auto-expressive", "true")).lower() == "true"

    report = evaluate_auto_expression(
        input_path=input_path,
        style=style,
        profile_file=profile_file,
        humanize_intensity=humanize_intensity,
        hybrid_prosody=hybrid_prosody,
        prosody_limiter=prosody_limiter,
        prosody_limiter_strength=prosody_limiter_strength,
        auto_expressive=auto_expressive,
    )

    out_path = Path(output).resolve()
    out_path.parent.mkdir(parents=True, exist_ok=True)
    with open(out_path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2, ensure_ascii=False)
    metrics = report.get("metrics", {})
    print(
        f"eval_done file={Path(output).as_posix()} "
        f"segments={report.get('segments', 0)} "
        f"changed={metrics.get('changedIntentSegments', 0)} "
        f"tag_override={metrics.get('overrideIntentSegments', 0)}"
    )


if __name__ == "__main__":
    main()
