import json
import os
import tempfile
from datetime import datetime, timezone
from pathlib import Path

from common_pipeline import parse_args, run_cmd


def average(items):
    return (sum(items) / len(items)) if items else 0.0


def read_test_text(dir_path):
    files = sorted([p for p in Path(dir_path).iterdir() if p.is_file() and p.suffix.lower() == ".txt"])
    if not files:
        raise RuntimeError(f"No .txt voice test files found in {dir_path}")
    fp = files[0]
    raw = fp.read_text(encoding="utf-8")
    lines = [ln.strip() for ln in raw.splitlines() if ln.strip() and not ln.strip().startswith("[SCENE")]
    text = "\n".join(lines).strip() or raw
    return {"file": fp.name, "text": text}


def run_case(text, output_base, voice, style, speech_style, voice_tone):
    with tempfile.NamedTemporaryFile(prefix="voice_case_", suffix=".txt", delete=False) as tmp:
        tmp.write((text + "\n").encode("utf-8"))
        tmp_path = tmp.name
    try:
        cmd = [
            "node",
            "scripts/generate-tts.mjs",
            "--input",
            tmp_path,
            "--output",
            output_base,
            "--voice",
            voice,
            "--humanize",
            "true",
            "--humanize-intensity",
            "0.55",
            "--style",
            style,
            "--speech-style",
            speech_style,
            "--voice-character",
            "true",
            "--voice-tone",
            voice_tone,
            "--ml-policy",
            "false",
        ]
        run_cmd(cmd, allowed_exit_codes=(0,))
        prosody_path = Path(f"{output_base}.prosody.json").resolve()
        audio_path = Path(f"{output_base}.mp3").resolve()
        with open(prosody_path, "r", encoding="utf-8") as f:
            prosody = json.load(f)
        seg = prosody.get("segments") if isinstance(prosody, dict) else []
        seg = seg if isinstance(seg, list) else []
        rates = [float((s.get("final") or {}).get("rate", s.get("rate", 0))) for s in seg]
        pitches = [float((s.get("final") or {}).get("pitch", s.get("pitch", 0))) for s in seg]
        return {
            "voice": voice,
            "style": prosody.get("style"),
            "speechStyle": speech_style,
            "voiceTone": voice_tone,
            "outputAudio": str(audio_path.relative_to(Path.cwd())).replace("\\", "/"),
            "outputProsody": str(prosody_path.relative_to(Path.cwd())).replace("\\", "/"),
            "segments": len(seg),
            "avgRate": round(average(rates), 3),
            "avgPitch": round(average(pitches), 3),
            "postApplied": bool(((prosody.get("voiceCharacter") or {}).get("postApplied"))),
        }
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass


def bool_all(items):
    return all(bool(x) for x in items)


def main():
    args = parse_args(os.sys.argv[1:])
    tests_dir = Path(str(args.get("dir") or "tests/voice")).resolve()
    out_dir = Path(str(args.get("outdir") or "outputs/voice_eval_suite")).resolve()
    style = str(args.get("style") or "tegang")
    min_rate_delta = float(args.get("min-rate-delta") or 1.0)
    voices = [v.strip() for v in str(args.get("voices") or "id-ID-ArdiNeural,id-ID-GadisNeural").split(",") if v.strip()]
    if not tests_dir.exists():
        raise RuntimeError(f"Voice tests directory not found: {tests_dir}")
    out_dir.mkdir(parents=True, exist_ok=True)

    sample = read_test_text(tests_dir)
    configs = [
        {"speechStyle": "relaxed", "voiceTone": "auto"},
        {"speechStyle": "assertive", "voiceTone": "auto"},
        {"speechStyle": "dramatic", "voiceTone": "deep"},
        {"speechStyle": "dramatic", "voiceTone": "bright"},
        {"speechStyle": "dramatic", "voiceTone": "off"},
    ]

    rows = []
    for voice in voices:
        for cfg in configs:
            base = out_dir / f"{''.join(c if c.isalnum() else '_' for c in voice)}_{cfg['speechStyle']}_{cfg['voiceTone']}"
            result = run_case(
                text=sample["text"],
                output_base=str(base),
                voice=voice,
                style=style,
                speech_style=cfg["speechStyle"],
                voice_tone=cfg["voiceTone"],
            )
            rows.append(result)
            print(
                f"voice_case voice={voice} speech_style={cfg['speechStyle']} voice_tone={cfg['voiceTone']} "
                f"post={str(result['postApplied']).lower()} avg_rate={result['avgRate']}"
            )

    checks = []
    for voice in voices:
        relaxed = next((r for r in rows if r["voice"] == voice and r["speechStyle"] == "relaxed" and r["voiceTone"] == "auto"), None)
        assertive = next((r for r in rows if r["voice"] == voice and r["speechStyle"] == "assertive" and r["voiceTone"] == "auto"), None)
        deep = next((r for r in rows if r["voice"] == voice and r["voiceTone"] == "deep"), None)
        bright = next((r for r in rows if r["voice"] == voice and r["voiceTone"] == "bright"), None)
        off = next((r for r in rows if r["voice"] == voice and r["voiceTone"] == "off"), None)
        rate_delta = round(
            float((assertive or {}).get("avgRate", 0)) - float((relaxed or {}).get("avgRate", 0)),
            3,
        )
        checks.append(
            {
                "voice": voice,
                "relaxedVsAssertiveRateDelta": rate_delta,
                "relaxedVsAssertiveOk": rate_delta >= min_rate_delta,
                "deepPostOk": bool((deep or {}).get("postApplied")),
                "brightPostOk": bool((bright or {}).get("postApplied")),
                "offPostDisabledOk": not bool((off or {}).get("postApplied")),
            }
        )

    summary = {
        "at": datetime.now(timezone.utc).isoformat(),
        "testsDir": str(tests_dir.relative_to(Path.cwd())).replace("\\", "/"),
        "sampleFile": sample["file"],
        "style": style,
        "minRateDelta": min_rate_delta,
        "caseCount": len(rows),
        "voices": voices,
        "checks": checks,
        "gate": {
            "status": "pass"
            if bool_all(
                [
                    c["relaxedVsAssertiveOk"] and c["deepPostOk"] and c["brightPostOk"] and c["offPostDisabledOk"]
                    for c in checks
                ]
            )
            else "fail"
        },
        "cases": rows,
    }
    json_path = out_dir / "summary.json"
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(summary, f, indent=2, ensure_ascii=False)
    md = [
        "# Voice Character Eval Suite",
        "",
        f"- Generated at: {summary['at']}",
        f"- Test dir: `{summary['testsDir']}`",
        f"- Sample file: `{summary['sampleFile']}`",
        f"- Style: `{summary['style']}`",
        f"- Gate: **{summary['gate']['status'].upper()}**",
        "",
        "## Voice Checks",
        "",
        "| voice | rateDelta(assertive-relaxed) | rateOk | deepPost | brightPost | offDisabled |",
        "|---|---:|---|---|---|---|",
    ]
    for c in checks:
        md.append(
            f"| {c['voice']} | {c['relaxedVsAssertiveRateDelta']} | {c['relaxedVsAssertiveOk']} | "
            f"{c['deepPostOk']} | {c['brightPostOk']} | {c['offPostDisabledOk']} |"
        )
    md_path = out_dir / "summary.md"
    with open(md_path, "w", encoding="utf-8") as f:
        f.write("\n".join(md) + "\n")
    print(
        f"voice_eval_done gate={summary['gate']['status']} cases={len(rows)} "
        f"summary_json={str(json_path.relative_to(Path.cwd())).replace('\\', '/')} "
        f"summary_md={str(md_path.relative_to(Path.cwd())).replace('\\', '/')}"
    )
    if summary["gate"]["status"] != "pass":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
