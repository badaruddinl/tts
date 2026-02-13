import json
import os
import re
import shutil
import subprocess
import tempfile
import time
from pathlib import Path

from common_pipeline import parse_args, run_cmd


def to_num(v, fallback=0.0):
    try:
        n = float(v)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    except Exception:
        pass
    return fallback


def avg(items):
    return (sum(items) / len(items)) if items else 0.0


def pick_sample_json(path_arg=""):
    if path_arg:
        p = Path(str(path_arg)).resolve()
        if p.exists():
            return p
    p1 = Path("sample_text.json").resolve()
    p2 = Path("sample/sample_text.json").resolve()
    if p1.exists():
        return p1
    if p2.exists():
        return p2
    raise RuntimeError("sample_text_json_not_found")


def pick_reference_audio(path_arg=""):
    if path_arg:
        p = Path(str(path_arg)).resolve()
        if p.exists():
            return p
    p = Path("sample/training_audio.m4a").resolve()
    if p.exists():
        return p
    raise RuntimeError("reference_audio_not_found")


def ffprobe_duration(file_path):
    ffprobe = shutil.which("ffprobe")
    if ffprobe:
        cmd = [
            ffprobe,
            "-v",
            "error",
            "-show_entries",
            "format=duration",
            "-of",
            "default=noprint_wrappers=1:nokey=1",
            str(file_path),
        ]
        res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", shell=False)
        if int(res.returncode or 0) == 0:
            return to_num((res.stdout or "").strip(), 0.0)

    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        return 0.0
    cmd = [ffmpeg, "-i", str(file_path)]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", shell=False)
    text = (res.stderr or "") + "\n" + (res.stdout or "")
    m = re.search(r"Duration:\s*(\d+):(\d+):([\d.]+)", text)
    if not m:
        return 0.0
    hh = to_num(m.group(1), 0.0)
    mm = to_num(m.group(2), 0.0)
    ss = to_num(m.group(3), 0.0)
    return float(hh * 3600 + mm * 60 + ss)


def ffmpeg_volumes(file_path):
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        return {"meanDb": 0.0, "maxDb": 0.0}
    cmd = [ffmpeg, "-i", str(file_path), "-af", "volumedetect", "-f", "null", "NUL"]
    res = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", shell=False)
    text = (res.stderr or "") + "\n" + (res.stdout or "")
    m_mean = re.search(r"mean_volume:\s*([-\d.]+)\s*dB", text)
    m_max = re.search(r"max_volume:\s*([-\d.]+)\s*dB", text)
    return {
        "meanDb": to_num(m_mean.group(1) if m_mean else None, 0.0),
        "maxDb": to_num(m_max.group(1) if m_max else None, 0.0),
    }


def resolve_ffmpeg():
    local = Path("node_modules/ffmpeg-static/ffmpeg.exe").resolve()
    if local.exists():
        return str(local)
    return shutil.which("ffmpeg")


def summarize_prosody_segments(rows):
    segs = rows if isinstance(rows, list) else []
    rates = []
    pitches = []
    volumes = []
    for seg in segs:
        item = seg.get("final") if isinstance(seg, dict) and isinstance(seg.get("final"), dict) else seg
        rates.append(to_num((item or {}).get("rate"), 0.0))
        pitches.append(to_num((item or {}).get("pitch"), 0.0))
        volumes.append(to_num((item or {}).get("volume"), 0.0))
    return {
        "count": len(segs),
        "avgRate": round(avg(rates), 3),
        "avgPitch": round(avg(pitches), 3),
        "avgVolume": round(avg(volumes), 3),
    }


def run_generate_with_retry(cmd, retries=4, backoff_sec=2.0):
    last_err = None
    for attempt in range(1, max(1, int(retries)) + 1):
        try:
            run_cmd(cmd, allowed_exit_codes=(0,), capture=True)
            return
        except Exception as exc:
            last_err = exc
            msg = str(exc).lower()
            transient = (
                "503" in msg
                or "invalid response status" in msg
                or "websocket inactivity timeout" in msg
                or "temporarily unavailable" in msg
            )
            if (not transient) or attempt >= int(retries):
                break
            wait_sec = float(backoff_sec) * attempt
            print(f"reference_match synth retry={attempt}/{retries} wait={wait_sec:.1f}s reason=transient_edge_tts")
            time.sleep(wait_sec)
    raise last_err if last_err else RuntimeError("reference_match_synthesis_failed")


def main():
    args = parse_args(__import__("sys").argv[1:])
    sample_json = pick_sample_json(args.get("sample"))
    ref_audio = pick_reference_audio(args.get("reference-audio"))
    out_dir = Path(str(args.get("outdir") or "outputs/reference_match")).resolve()
    out_dir.mkdir(parents=True, exist_ok=True)

    with open(sample_json, "r", encoding="utf-8") as f:
        sample = json.load(f)
    sample_segments = sample.get("segments") if isinstance(sample, dict) else []
    sample_segments = sample_segments if isinstance(sample_segments, list) else []
    sample_text = "\n".join([str((s or {}).get("text") or "").strip() for s in sample_segments if str((s or {}).get("text") or "").strip()])
    if not sample_text.strip():
        raise RuntimeError("sample_text_empty")

    with tempfile.NamedTemporaryFile(prefix="sample_ref_", suffix=".txt", delete=False, mode="w", encoding="utf-8") as tmp:
        tmp.write(sample_text + "\n")
        tmp_path = Path(tmp.name).resolve()
    generated = out_dir / "reference_match.mp3"
    synth_retries = int(float(args.get("synth-retries") or os.environ.get("TTS_SYNTH_RETRIES") or 4))
    synth_backoff = float(args.get("synth-retry-backoff") or os.environ.get("TTS_SYNTH_RETRY_BACKOFF") or 2.0)
    try:
        run_generate_with_retry(
            [
                str(os.environ.get("TTS_PYTHON_BIN") or os.environ.get("PYTHON") or "python"),
                "scripts_py/generate_tts.py",
                "--input",
                str(tmp_path),
                "--output",
                str(generated),
            ],
            retries=max(1, synth_retries),
            backoff_sec=max(0.5, synth_backoff),
        )
    finally:
        try:
            os.remove(tmp_path)
        except Exception:
            pass

    prosody_path = Path(str(generated).replace(".mp3", ".prosody.json")).resolve()
    if not prosody_path.exists():
        raise RuntimeError("generated_prosody_missing")
    with open(prosody_path, "r", encoding="utf-8") as f:
        generated_prosody = json.load(f)

    ref_summary = summarize_prosody_segments(sample_segments)
    gen_summary = summarize_prosody_segments(generated_prosody.get("segments"))
    prosody_delta = {
        "count": abs(ref_summary["count"] - gen_summary["count"]),
        "avgRate": round(abs(ref_summary["avgRate"] - gen_summary["avgRate"]), 3),
        "avgPitch": round(abs(ref_summary["avgPitch"] - gen_summary["avgPitch"]), 3),
        "avgVolume": round(abs(ref_summary["avgVolume"] - gen_summary["avgVolume"]), 3),
    }

    ref_dur = ffprobe_duration(ref_audio)
    gen_dur = ffprobe_duration(generated)
    duration_delta = abs(ref_dur - gen_dur)
    ref_vol = ffmpeg_volumes(ref_audio)
    gen_vol = ffmpeg_volumes(generated)
    audio_delta = {
        "durationSec": round(duration_delta, 3),
        "meanDb": round(abs(ref_vol["meanDb"] - gen_vol["meanDb"]), 3),
        "maxDb": round(abs(ref_vol["maxDb"] - gen_vol["maxDb"]), 3),
    }

    thresholds = {
        "countTol": int(float(args.get("count-tol") or 140)),
        "rateTol": float(args.get("rate-tol") or 12.0),
        "pitchTol": float(args.get("pitch-tol") or 3.0),
        "volumeTol": float(args.get("volume-tol") or 8.0),
        "durationTol": float(args.get("duration-tol") or 180.0),
        "meanDbTol": float(args.get("mean-db-tol") or 12.0),
        "maxDbTol": float(args.get("max-db-tol") or 12.0),
    }
    gate = (
        prosody_delta["count"] <= thresholds["countTol"]
        and prosody_delta["avgRate"] <= thresholds["rateTol"]
        and prosody_delta["avgPitch"] <= thresholds["pitchTol"]
        and prosody_delta["avgVolume"] <= thresholds["volumeTol"]
        and audio_delta["durationSec"] <= thresholds["durationTol"]
        and audio_delta["meanDb"] <= thresholds["meanDbTol"]
        and audio_delta["maxDb"] <= thresholds["maxDbTol"]
    )

    payload = {
        "sampleFile": str(sample_json.relative_to(Path.cwd())).replace("\\", "/"),
        "referenceAudio": str(ref_audio.relative_to(Path.cwd())).replace("\\", "/"),
        "generatedAudio": str(generated.relative_to(Path.cwd())).replace("\\", "/"),
        "generatedProsody": str(prosody_path.relative_to(Path.cwd())).replace("\\", "/"),
        "referenceProsodySummary": ref_summary,
        "generatedProsodySummary": gen_summary,
        "prosodyDelta": prosody_delta,
        "referenceAudioSummary": {"durationSec": round(ref_dur, 3), **ref_vol},
        "generatedAudioSummary": {"durationSec": round(gen_dur, 3), **gen_vol},
        "audioDelta": audio_delta,
        "thresholds": thresholds,
        "gate": {"status": "pass" if gate else "fail"},
    }
    out_json = out_dir / "summary.json"
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(
        f"reference_match gate={payload['gate']['status']} "
        f"prosody_rate_delta={prosody_delta['avgRate']} prosody_pitch_delta={prosody_delta['avgPitch']} "
        f"audio_duration_delta={audio_delta['durationSec']} summary={str(out_json.relative_to(Path.cwd())).replace('\\', '/')}"
    )
    if not gate:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
