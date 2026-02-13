import json
from pathlib import Path
from datetime import datetime, timezone

from common_pipeline import parse_args
from tts_core_py import parse_input_file, preview_auto_expression_from_text


def average(items):
    return (sum(items) / len(items)) if items else 0.0


def transition_score(segments):
    delta = []
    for i in range(1, len(segments)):
        a = segments[i - 1]
        b = segments[i]
        delta.append(
            abs(float(b.get("rate", 0.0)) - float(a.get("rate", 0.0)))
            + abs(float(b.get("pitch", 0.0)) - float(a.get("pitch", 0.0)))
            + abs(float(b.get("volume", 0.0)) - float(a.get("volume", 0.0)))
        )
    return round(average(delta), 3)


def energy(segments):
    if not segments:
        return 0.0
    acc = 0.0
    for seg in segments:
        acc += abs(float(seg.get("rate", 0.0))) + abs(float(seg.get("pitch", 0.0))) + abs(float(seg.get("volume", 0.0)))
    return round(acc / len(segments), 3)


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
    parsed = parse_input_file(str(Path(input_path).resolve()))
    auto_run = preview_auto_expression_from_text(
        text=parsed.get("text") or "",
        style=style,
        profile_file=profile_file,
        humanize_intensity=humanize_intensity,
        prosody_limiter=prosody_limiter,
        prosody_limiter_strength=prosody_limiter_strength,
        auto_expressive=auto_expressive,
        allow_intent_override=False,
    )
    over_run = preview_auto_expression_from_text(
        text=parsed.get("text") or "",
        style=style,
        profile_file=profile_file,
        humanize_intensity=humanize_intensity,
        prosody_limiter=prosody_limiter,
        prosody_limiter_strength=prosody_limiter_strength,
        auto_expressive=auto_expressive,
        allow_intent_override=True,
    )
    auto_seg = auto_run.get("segments") if isinstance(auto_run, dict) else []
    over_seg = over_run.get("segments") if isinstance(over_run, dict) else []
    auto_seg = auto_seg if isinstance(auto_seg, list) else []
    over_seg = over_seg if isinstance(over_seg, list) else []

    count = min(len(auto_seg), len(over_seg))
    changed_intent = 0
    override_intent = 0
    for i in range(count):
        ai = str((((auto_seg[i] or {}).get("reason") or {}).get("intent") or "netral"))
        oi = str((((over_seg[i] or {}).get("reason") or {}).get("intent") or "netral"))
        if ai != oi:
            changed_intent += 1
        src = str((((over_seg[i] or {}).get("reason") or {}).get("intentSource") or ""))
        if src == "tag_override":
            override_intent += 1

    return {
        "at": datetime.now(timezone.utc).isoformat(),
        "input": str(Path(input_path).resolve()).replace("\\", "/"),
        "profileFile": profile_file or "active",
        "hybridProsody": bool(hybrid_prosody),
        "styleAuto": auto_run.get("styleName"),
        "styleOverride": over_run.get("styleName"),
        "segments": count,
        "metrics": {
            "autoTransitionDelta": transition_score(auto_seg),
            "overrideTransitionDelta": transition_score(over_seg),
            "changedIntentSegments": changed_intent,
            "overrideIntentSegments": override_intent,
            "autoProsodyEnergy": energy(auto_seg),
            "overrideProsodyEnergy": energy(over_seg),
        },
    }


def main():
    args = parse_args(__import__("sys").argv[1:])
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
