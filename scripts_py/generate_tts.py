import asyncio
import os
import sys
from pathlib import Path

from _node_wrap import run_node
from common_pipeline import parse_args, to_bool
from tts_core_py import (
    choose_runtime_bools,
    choose_style,
    load_runtime_defaults,
    parse_input_file,
    synthesize_humanized_to_mp3,
    synthesize_to_mp3,
)


def refresh_sample_text_input(default_input_path):
    sample_json_candidates = [Path("sample_text.json").resolve(), Path("sample/sample_text.json").resolve()]
    sample_json = next((p for p in sample_json_candidates if p.exists()), None)
    if sample_json is None:
        return
    target = Path(default_input_path).resolve()
    if target.name != "sample_text_input.txt":
        return
    try:
        import json

        with open(sample_json, "r", encoding="utf-8") as f:
            payload = json.load(f)
        segs = payload.get("segments") if isinstance(payload, dict) else []
        lines = []
        if isinstance(segs, list):
            for seg in segs:
                text = str((seg or {}).get("text") or "").strip()
                if text:
                    lines.append(text)
        if lines:
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text("\n".join(lines) + "\n", encoding="utf-8")
    except Exception:
        pass


def help_text():
    return (
        "Usage: npm run py:tts -- --input text.txt --output result.mp3 "
        "[--humanize true --style tegang --humanize-intensity 0.55 "
        "--auto-punctuate true --auto-punctuate-mode balanced --text-rewrite true]"
    )


def main():
    args = parse_args(sys.argv[1:])
    if args.get("help"):
        print(help_text())
        return 0

    py_runtime = str(args.get("runtime") or os.environ.get("TTS_PY_RUNTIME") or "auto").strip().lower()
    if py_runtime not in ("auto", "py", "js"):
        raise RuntimeError(f"invalid_runtime={py_runtime} expected=auto|py|js")
    if py_runtime == "js":
        return int(run_node("scripts/generate-tts.mjs", sys.argv[1:]) or 0)

    defaults = load_runtime_defaults()
    default_input = os.environ.get("TTS_INPUT") or "text.txt"
    default_output = os.environ.get("TTS_OUTPUT") or "output.mp3"
    default_voice = os.environ.get("TTS_VOICE") or "id-ID-GadisNeural"
    default_rate = os.environ.get("TTS_RATE") or "-8%"
    default_pitch = os.environ.get("TTS_PITCH") or "-2Hz"
    default_volume = os.environ.get("TTS_VOLUME") or "0%"
    refresh_sample_text_input(default_input)

    input_path = Path(str(args.get("input") or default_input)).resolve()
    if not input_path.exists():
        raise RuntimeError(f"input_file_not_found={input_path}")
    parsed = parse_input_file(str(input_path))
    if not str(parsed.get("text") or "").strip():
        raise RuntimeError("input_text_empty_after_cleanup")

    output = str(args.get("output") or parsed.get("meta", {}).get("OUTPUT") or default_output).strip()
    voice = str(args.get("voice") or parsed.get("meta", {}).get("VOICE") or default_voice).strip()
    rate = str(
        args.get("rate")
        or parsed.get("meta", {}).get("RATE")
        or os.environ.get("TTS_RATE")
        or defaults.get("baseRate")
        or default_rate
    ).strip()
    pitch = str(
        args.get("pitch")
        or parsed.get("meta", {}).get("PITCH")
        or os.environ.get("TTS_PITCH")
        or defaults.get("basePitch")
        or default_pitch
    ).strip()
    volume = str(
        args.get("volume")
        or parsed.get("meta", {}).get("VOLUME")
        or os.environ.get("TTS_VOLUME")
        or defaults.get("baseVolume")
        or default_volume
    ).strip()

    sample_lock = bool(defaults.get("sampleLock"))
    eval_mode = to_bool(args.get("eval-mode"), False)
    unlock_sample = (
        to_bool(args.get("unlock-sample"), False)
        and to_bool(
        os.environ.get("TTS_ALLOW_SAMPLE_UNLOCK"), False
    )) or eval_mode
    humanize_default = True if (sample_lock and not unlock_sample) else False
    humanize = to_bool(args.get("humanize"), humanize_default)
    style = choose_style(args.get("style"), os.environ.get("TTS_STYLE"))
    humanize_intensity = float(args.get("humanize-intensity") or os.environ.get("TTS_HUMANIZE_INTENSITY") or defaults.get("humanizeIntensity") or 0.45)
    auto_expressive = choose_runtime_bools(args.get("auto-expressive"), "TTS_AUTO_EXPRESSIVE", defaults.get("autoExpressive"), True)
    use_ml_policy = to_bool(args.get("ml-policy"), to_bool(os.environ.get("TTS_ML_POLICY"), True))
    speech_style = str(
        args.get("speech-style") or os.environ.get("TTS_SPEECH_STYLE") or defaults.get("speechStyle") or "auto"
    ).strip() or "auto"
    voice_character = to_bool(args.get("voice-character"), to_bool(os.environ.get("TTS_VOICE_CHARACTER"), True))
    voice_tone = str(
        args.get("voice-tone") or os.environ.get("TTS_VOICE_TONE") or defaults.get("voiceTone") or "auto"
    ).strip() or "auto"
    prosody_limiter = choose_runtime_bools(
        args.get("prosody-limiter"),
        "TTS_PROSODY_LIMITER",
        defaults.get("prosodyLimiterEnabled"),
        True,
    )
    prosody_limiter_strength = float(
        args.get("prosody-limiter-strength")
        or os.environ.get("TTS_PROSODY_LIMITER_STRENGTH")
        or defaults.get("prosodyLimiterStrength")
        or 0.64
    )
    segment_concurrency = int(float(args.get("segment-concurrency") or os.environ.get("TTS_SEGMENT_CONCURRENCY") or 1))
    save_prosody = to_bool(args.get("save-prosody"), True)
    auto_punctuate = to_bool(args.get("auto-punctuate"), to_bool(os.environ.get("TTS_AUTO_PUNCTUATE"), True))
    auto_punctuate_mode = str(args.get("auto-punctuate-mode") or os.environ.get("TTS_AUTO_PUNCTUATE_MODE") or "balanced")
    text_rewrite = to_bool(args.get("text-rewrite"), to_bool(os.environ.get("TTS_TEXT_REWRITE"), True))
    text_lexicon_path = str(args.get("text-lexicon") or os.environ.get("TTS_TEXT_LEXICON") or "config/text/lexicon.json")
    profile_file = str(args.get("profile-file") or "").strip() or None
    if sample_lock and not unlock_sample:
        if defaults.get("style"):
            style = str(defaults.get("style"))
        if defaults.get("humanizeIntensity") is not None:
            humanize_intensity = float(defaults.get("humanizeIntensity"))
        if defaults.get("speechStyle"):
            speech_style = str(defaults.get("speechStyle"))
        if defaults.get("voiceTone"):
            voice_tone = str(defaults.get("voiceTone"))
        if defaults.get("baseRate"):
            rate = str(defaults.get("baseRate"))
        if defaults.get("basePitch"):
            pitch = str(defaults.get("basePitch"))
        if defaults.get("baseVolume"):
            volume = str(defaults.get("baseVolume"))
        if defaults.get("prosodyLimiterEnabled") is not None:
            prosody_limiter = bool(defaults.get("prosodyLimiterEnabled"))
        if defaults.get("prosodyLimiterStrength") is not None:
            prosody_limiter_strength = float(defaults.get("prosodyLimiterStrength"))
        profile_file = str(defaults.get("profileFile") or profile_file or "").strip() or None
        humanize = True

    try:
        if humanize:
            res = asyncio.run(
                synthesize_humanized_to_mp3(
                    text=parsed["text"],
                    output=output,
                    voice=voice,
                    rate=rate,
                    pitch=pitch,
                    volume=volume,
                    humanize_intensity=humanize_intensity,
                    style=style,
                    use_ml_policy=use_ml_policy,
                    speech_style=speech_style,
                    profile_file=profile_file,
                    auto_expressive=auto_expressive,
                    voice_character=voice_character,
                    voice_tone=voice_tone,
                    segment_concurrency=max(1, min(8, segment_concurrency)),
                    prosody_limiter=prosody_limiter,
                    prosody_limiter_strength=prosody_limiter_strength,
                    save_prosody=save_prosody,
                    auto_punctuate=auto_punctuate,
                    auto_punctuate_mode=auto_punctuate_mode,
                    text_rewrite=text_rewrite,
                    text_lexicon_path=text_lexicon_path,
                )
            )
            prosody_label = Path(str(res.get("prosodyPath"))).name if res.get("prosodyPath") else "disabled"
            print(
                f"Humanize done: audio={Path(str(res['audioPath'])).name}, prosody={prosody_label}, "
                f"segments={res.get('segments')}, style={res.get('style')}, profile={res.get('profileFile')}"
            )
            return 0

        audio_path = asyncio.run(
            synthesize_to_mp3(
                text=parsed["text"],
                output=output,
                voice=voice,
                rate=rate,
                pitch=pitch,
                volume=volume,
                auto_punctuate=auto_punctuate,
                auto_punctuate_mode=auto_punctuate_mode,
                text_rewrite=text_rewrite,
                text_lexicon_path=text_lexicon_path,
            )
        )
        print(f"Synthesize done: audio={Path(str(audio_path)).name}")
        return 0
    except RuntimeError as err:
        if "python_edge_tts_not_installed" in str(err) and py_runtime == "auto":
            return int(run_node("scripts/generate-tts.mjs", sys.argv[1:]) or 0)
        raise


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(str(exc))
        sys.exit(1)
