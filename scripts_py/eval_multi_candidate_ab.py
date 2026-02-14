import json
import os
import time
from pathlib import Path

from common_pipeline import parse_args, run_cmd, to_bool


def to_num(v, fallback=0.0):
    try:
        n = float(v)
        if n == n and n not in (float("inf"), float("-inf")):
            return n
    except Exception:
        pass
    return fallback


def load_segments(prosody_path):
    payload = json.loads(Path(prosody_path).read_text(encoding="utf-8"))
    return payload.get("segments") if isinstance(payload, dict) else []


def final_vals(seg):
    item = seg.get("final") if isinstance(seg.get("final"), dict) else seg
    return {
        "rate": to_num((item or {}).get("rate"), 0.0),
        "pitch": to_num((item or {}).get("pitch"), 0.0),
        "volume": to_num((item or {}).get("volume"), 0.0),
    }


def calc_metrics(segments):
    rows = [s for s in (segments or []) if isinstance(s, dict)]
    if not rows:
        return {
            "segments": 0,
            "avgTransitionJump": 0.0,
            "nearRepeatRatio": 0.0,
            "endingMatchRatio": 0.0,
            "avgAbsRate": 0.0,
            "avgAbsPitch": 0.0,
            "avgAbsVolume": 0.0,
        }

    rep = 0
    trans = []
    ending_ok = 0
    abs_rate = []
    abs_pitch = []
    abs_volume = []
    prev = None
    for row in rows:
        cur = final_vals(row)
        txt = str(row.get("text") or "").strip()
        abs_rate.append(abs(cur["rate"]))
        abs_pitch.append(abs(cur["pitch"]))
        abs_volume.append(abs(cur["volume"]))

        if txt.endswith("?"):
            if cur["pitch"] >= 0.0:
                ending_ok += 1
        elif txt.endswith("!"):
            if cur["volume"] >= 0.0:
                ending_ok += 1
        elif txt.endswith("..."):
            if cur["rate"] <= 0.6:
                ending_ok += 1
        else:
            ending_ok += 1

        if prev is not None:
            dr = abs(cur["rate"] - prev["rate"])
            dp = abs(cur["pitch"] - prev["pitch"])
            dv = abs(cur["volume"] - prev["volume"])
            jump = dr * 0.42 + dp * 0.42 + dv * 0.16
            trans.append(jump)
            if dr < 0.20 and dp < 0.16 and dv < 0.14:
                rep += 1
        prev = cur

    avg_jump = (sum(trans) / len(trans)) if trans else 0.0
    near_repeat_ratio = (rep / len(trans)) if trans else 0.0
    ending_match_ratio = ending_ok / max(1, len(rows))
    return {
        "segments": len(rows),
        "avgTransitionJump": round(avg_jump, 4),
        "nearRepeatRatio": round(near_repeat_ratio, 4),
        "endingMatchRatio": round(ending_match_ratio, 4),
        "avgAbsRate": round(sum(abs_rate) / len(abs_rate), 4),
        "avgAbsPitch": round(sum(abs_pitch) / len(abs_pitch), 4),
        "avgAbsVolume": round(sum(abs_volume) / len(abs_volume), 4),
    }


def pick_input(path_arg=""):
    if path_arg:
        p = Path(str(path_arg)).resolve()
        if p.exists():
            return p
    p = Path("sample/sample_text_input.txt").resolve()
    if p.exists():
        return p
    p = Path("text.txt").resolve()
    if p.exists():
        return p
    raise RuntimeError("input_text_not_found")


def write_md(path_obj, payload):
    b = payload["baseline"]
    m = payload["multiCandidate"]
    lines = [
        "# Multi Candidate A/B",
        "",
        f"- input: `{payload['inputFile']}`",
        f"- baseline candidates: `{payload['baselineCandidates']}`",
        f"- multi candidates: `{payload['multiCandidates']}`",
        f"- winner: `{payload['winner']}`",
        "",
        "## Baseline",
        f"- segments: {b['segments']}",
        f"- avgTransitionJump: {b['avgTransitionJump']}",
        f"- nearRepeatRatio: {b['nearRepeatRatio']}",
        f"- endingMatchRatio: {b['endingMatchRatio']}",
        "",
        "## Multi Candidate",
        f"- segments: {m['segments']}",
        f"- avgTransitionJump: {m['avgTransitionJump']}",
        f"- nearRepeatRatio: {m['nearRepeatRatio']}",
        f"- endingMatchRatio: {m['endingMatchRatio']}",
        "",
    ]
    path_obj.write_text("\n".join(lines), encoding="utf-8")


def run_tts_with_retry(cmd, retries=4, backoff_sec=2.0):
    last_err = None
    total = max(1, int(retries))
    for attempt in range(1, total + 1):
        try:
            run_cmd(cmd, capture=True)
            return
        except Exception as exc:
            last_err = exc
            msg = str(exc).lower()
            transient = (
                "no audio was received" in msg
                or "503" in msg
                or "invalid response status" in msg
                or "websocket inactivity timeout" in msg
                or "temporarily unavailable" in msg
            )
            if (not transient) or attempt >= total:
                break
            wait_s = max(0.5, float(backoff_sec)) * attempt
            print(f"multi_candidate_ab retry={attempt}/{total} wait={wait_s:.1f}s reason=transient_edge_tts")
            time.sleep(wait_s)
    raise last_err if last_err else RuntimeError("multi_candidate_ab_synthesis_failed")


def main():
    args = parse_args(__import__("sys").argv[1:])
    input_file = pick_input(args.get("input"))
    outdir = Path(str(args.get("outdir") or "outputs/eval_multi_candidate_ab")).resolve()
    outdir.mkdir(parents=True, exist_ok=True)
    baseline_n = max(1, int(float(args.get("baseline-candidates") or 1)))
    multi_n = max(2, int(float(args.get("multi-candidates") or 3)))
    hard_gate = to_bool(args.get("hard-gate"), to_bool(os.environ.get("TTS_MULTI_AB_HARD_GATE"), False))
    retries = max(1, int(float(args.get("synth-retries") or os.environ.get("TTS_SYNTH_RETRIES") or 4)))
    backoff = max(0.5, float(args.get("synth-retry-backoff") or os.environ.get("TTS_SYNTH_RETRY_BACKOFF") or 2.0))

    baseline_out = outdir / "baseline.mp3"
    multi_out = outdir / "multi.mp3"

    run_tts_with_retry(
        [
            str(os.environ.get("TTS_PYTHON_BIN") or os.environ.get("PYTHON") or "python"),
            "scripts_py/generate_tts.py",
            "--input",
            str(input_file),
            "--output",
            str(baseline_out),
            "--humanize",
            "true",
            "--eval-mode",
            "true",
            "--multi-prosody-candidates",
            str(baseline_n),
        ],
        retries=retries,
        backoff_sec=backoff,
    )
    run_tts_with_retry(
        [
            str(os.environ.get("TTS_PYTHON_BIN") or os.environ.get("PYTHON") or "python"),
            "scripts_py/generate_tts.py",
            "--input",
            str(input_file),
            "--output",
            str(multi_out),
            "--humanize",
            "true",
            "--eval-mode",
            "true",
            "--multi-prosody-candidates",
            str(multi_n),
        ],
        retries=retries,
        backoff_sec=backoff,
    )

    baseline_prosody = Path(str(baseline_out).replace(".mp3", ".prosody.json"))
    multi_prosody = Path(str(multi_out).replace(".mp3", ".prosody.json"))
    b_metrics = calc_metrics(load_segments(baseline_prosody))
    m_metrics = calc_metrics(load_segments(multi_prosody))

    # Lower is better for jump/repeat, higher is better for ending match.
    b_score = b_metrics["avgTransitionJump"] * 0.55 + b_metrics["nearRepeatRatio"] * 4.2 - b_metrics["endingMatchRatio"] * 0.9
    m_score = m_metrics["avgTransitionJump"] * 0.55 + m_metrics["nearRepeatRatio"] * 4.2 - m_metrics["endingMatchRatio"] * 0.9
    winner = "multi" if m_score < b_score else "baseline"

    payload = {
        "inputFile": str(input_file.relative_to(Path.cwd())).replace("\\", "/"),
        "baselineCandidates": baseline_n,
        "multiCandidates": multi_n,
        "baseline": b_metrics,
        "multiCandidate": m_metrics,
        "score": {"baseline": round(b_score, 4), "multi": round(m_score, 4)},
        "winner": winner,
    }
    out_json = outdir / "summary.json"
    out_md = outdir / "summary.md"
    out_json.write_text(json.dumps(payload, indent=2, ensure_ascii=False), encoding="utf-8")
    write_md(out_md, payload)
    print(
        f"multi_candidate_ab_done winner={winner} baseline_score={payload['score']['baseline']} "
        f"multi_score={payload['score']['multi']} summary={str(out_json.relative_to(Path.cwd())).replace(chr(92),'/')}"
    )
    if hard_gate and winner != "multi":
        raise SystemExit(2)


if __name__ == "__main__":
    main()
