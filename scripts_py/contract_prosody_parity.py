import json
import os
import subprocess
import tempfile
from pathlib import Path

from common_pipeline import parse_args
from tts_core_py import parse_input_file, preview_auto_expression_from_text


def avg(values):
    return (sum(values) / len(values)) if values else 0.0


def summarize_segments(segments):
    rates = [float(s.get("rate", 0.0)) for s in segments]
    pitches = [float(s.get("pitch", 0.0)) for s in segments]
    volumes = [float(s.get("volume", 0.0)) for s in segments]
    return {
        "count": len(segments),
        "avgRate": round(avg(rates), 3),
        "avgPitch": round(avg(pitches), 3),
        "avgVolume": round(avg(volumes), 3),
    }


def run_js_preview(input_path, style, intensity):
    with tempfile.NamedTemporaryFile(prefix="parity_js_", suffix=".json", delete=False) as tmp:
        out_path = Path(tmp.name)
    try:
        node_src = r"""
import fs from "fs";
import path from "path";
import { parseInputFile, previewAutoExpressionFromText } from "./lib/tts-core.mjs";
const p = JSON.parse(process.env.PARITY_PAYLOAD || "{}");
const parsed = parseInputFile(path.resolve(p.inputPath));
const out = previewAutoExpressionFromText({
  text: parsed.text,
  style: p.style || null,
  humanizeIntensity: Number(p.intensity ?? 0.55),
  autoPunctuate: true,
  autoPunctuateMode: "balanced",
  textRewrite: true
});
fs.writeFileSync(path.resolve(p.outputPath), JSON.stringify(out, null, 2), "utf8");
"""
        env = dict(os.environ)
        env["PARITY_PAYLOAD"] = json.dumps(
            {
                "inputPath": str(Path(input_path).resolve()),
                "outputPath": str(out_path.resolve()),
                "style": style,
                "intensity": intensity,
            }
        )
        res = subprocess.run(
            ["node", "--input-type=module", "-e", node_src],
            cwd=os.getcwd(),
            text=True,
            encoding="utf-8",
            capture_output=True,
            shell=False,
            env=env,
        )
        if int(res.returncode or 0) != 0:
            raise RuntimeError((res.stderr or res.stdout or "").strip() or "js_preview_failed")
        with open(out_path, "r", encoding="utf-8") as f:
            payload = json.load(f)
        return payload.get("segments") if isinstance(payload, dict) else []
    finally:
        try:
            os.remove(out_path)
        except Exception:
            pass


def run_py_preview(input_path, style, intensity):
    parsed = parse_input_file(str(Path(input_path).resolve()))
    out = preview_auto_expression_from_text(
        text=parsed.get("text") or "",
        style=style,
        humanize_intensity=float(intensity),
        auto_punctuate=True,
        auto_punctuate_mode="balanced",
        text_rewrite=True,
    )
    return out.get("segments") if isinstance(out, dict) else []


def evaluate_case(input_path, style, intensity):
    js_segments = run_js_preview(input_path, style=style, intensity=intensity)
    py_segments = run_py_preview(input_path, style=style, intensity=intensity)
    js_sum = summarize_segments(js_segments)
    py_sum = summarize_segments(py_segments)
    return {
        "input": str(Path(input_path).resolve()).replace("\\", "/"),
        "js": js_sum,
        "py": py_sum,
        "delta": {
            "count": abs(js_sum["count"] - py_sum["count"]),
            "avgRate": round(abs(js_sum["avgRate"] - py_sum["avgRate"]), 3),
            "avgPitch": round(abs(js_sum["avgPitch"] - py_sum["avgPitch"]), 3),
            "avgVolume": round(abs(js_sum["avgVolume"] - py_sum["avgVolume"]), 3),
        },
    }


def collect_inputs(input_path, input_dir):
    if input_path:
        return [Path(str(input_path)).resolve()]
    root = Path(str(input_dir or "tests/expressions")).resolve()
    items = sorted([p.resolve() for p in root.glob("*.txt") if p.is_file()])
    if not items:
        raise RuntimeError(f"no_txt_files_found_in={root}")
    return items


def main():
    args = parse_args(__import__("sys").argv[1:])
    input_path = str(args.get("input") or "").strip()
    input_dir = str(args.get("dir") or "tests/expressions").strip()
    out_json = Path(str(args.get("output") or "outputs/prosody_parity/summary.json")).resolve()
    style = str(args.get("style") or "tegang")
    intensity = float(args.get("humanize-intensity") or 0.55)
    tolerance = float(args.get("tolerance") or 10.0)
    count_tolerance = int(float(args.get("count-tolerance") or tolerance))

    cases = []
    for fp in collect_inputs(input_path, input_dir):
        cases.append(evaluate_case(fp, style=style, intensity=intensity))

    rate_deltas = [float((c.get("delta") or {}).get("avgRate", 0.0)) for c in cases]
    pitch_deltas = [float((c.get("delta") or {}).get("avgPitch", 0.0)) for c in cases]
    volume_deltas = [float((c.get("delta") or {}).get("avgVolume", 0.0)) for c in cases]
    count_deltas = [int((c.get("delta") or {}).get("count", 0)) for c in cases]
    summary = {
        "countDeltaMax": max(count_deltas) if count_deltas else 0,
        "avgRateDeltaMax": round(max(rate_deltas), 3) if rate_deltas else 0.0,
        "avgPitchDeltaMax": round(max(pitch_deltas), 3) if pitch_deltas else 0.0,
        "avgVolumeDeltaMax": round(max(volume_deltas), 3) if volume_deltas else 0.0,
        "avgRateDeltaMean": round(avg(rate_deltas), 3),
        "avgPitchDeltaMean": round(avg(pitch_deltas), 3),
        "avgVolumeDeltaMean": round(avg(volume_deltas), 3),
    }
    passed = (
        summary["countDeltaMax"] <= count_tolerance
        and summary["avgRateDeltaMax"] <= tolerance
        and summary["avgPitchDeltaMax"] <= tolerance
        and summary["avgVolumeDeltaMax"] <= tolerance
    )
    payload = {
        "style": style,
        "humanizeIntensity": intensity,
        "tolerance": tolerance,
        "countTolerance": count_tolerance,
        "cases": cases,
        "summary": summary,
        "gate": {"status": "pass" if passed else "fail"},
    }
    out_json.parent.mkdir(parents=True, exist_ok=True)
    with open(out_json, "w", encoding="utf-8") as f:
        json.dump(payload, f, indent=2, ensure_ascii=False)
    print(
        f"prosody_parity gate={payload['gate']['status']} cases={len(cases)} "
        f"count_delta_max={summary['countDeltaMax']} rate_delta_max={summary['avgRateDeltaMax']} "
        f"pitch_delta_max={summary['avgPitchDeltaMax']} volume_delta_max={summary['avgVolumeDeltaMax']} "
        f"summary={str(out_json.relative_to(Path.cwd())).replace('\\', '/')}"
    )
    if not passed:
        raise SystemExit(2)


if __name__ == "__main__":
    main()
