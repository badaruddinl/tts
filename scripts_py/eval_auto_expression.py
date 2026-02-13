import json
import os
import tempfile
import subprocess
from pathlib import Path

from common_pipeline import parse_args


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
    with tempfile.NamedTemporaryFile(prefix="eval_auto_", suffix=".json", delete=False) as tmp_out:
        out_path = tmp_out.name
    try:
        node_src = r"""
import fs from "fs";
import path from "path";
import { parseInputFile, previewAutoExpressionFromText } from "./lib/tts-core.mjs";

const params = JSON.parse(process.env.EVAL_PAYLOAD || "{}");
const parsed = parseInputFile(path.resolve(params.inputPath));
const autoRun = previewAutoExpressionFromText({
  text: parsed.text,
  style: params.style || null,
  profileFile: params.profileFile || null,
  humanizeIntensity: Number(params.humanizeIntensity ?? 0.7),
  hybridProsody: Boolean(params.hybridProsody),
  prosodyLimiter: Boolean(params.prosodyLimiter),
  prosodyLimiterStrength: Number(params.prosodyLimiterStrength ?? 0.64),
  autoExpressive: Boolean(params.autoExpressive),
  allowIntentOverride: false
});
const overRun = previewAutoExpressionFromText({
  text: parsed.text,
  style: params.style || null,
  profileFile: params.profileFile || null,
  humanizeIntensity: Number(params.humanizeIntensity ?? 0.7),
  hybridProsody: Boolean(params.hybridProsody),
  prosodyLimiter: Boolean(params.prosodyLimiter),
  prosodyLimiterStrength: Number(params.prosodyLimiterStrength ?? 0.64),
  autoExpressive: Boolean(params.autoExpressive),
  allowIntentOverride: true
});
function avg(items){ return items.length ? items.reduce((s,n)=>s+n,0)/items.length : 0; }
function transitionScore(segments){
  const delta=[];
  for(let i=1;i<segments.length;i+=1){
    const a=segments[i-1], b=segments[i];
    delta.push(Math.abs((b.rate??0)-(a.rate??0))+Math.abs((b.pitch??0)-(a.pitch??0))+Math.abs((b.volume??0)-(a.volume??0)));
  }
  return Number(avg(delta).toFixed(3));
}
function energy(segments){
  if(!Array.isArray(segments)||!segments.length) return 0;
  const acc=segments.reduce((s,x)=>s+Math.abs(Number(x?.rate||0))+Math.abs(Number(x?.pitch||0))+Math.abs(Number(x?.volume||0)),0);
  return Number((acc/segments.length).toFixed(3));
}
const autoSeg = autoRun.segments || [];
const overSeg = overRun.segments || [];
const count = Math.min(autoSeg.length, overSeg.length);
let changedIntent=0, overrideIntent=0;
for(let i=0;i<count;i+=1){
  if((autoSeg[i]?.reason?.intent||"netral")!==(overSeg[i]?.reason?.intent||"netral")) changedIntent+=1;
  if(overSeg[i]?.reason?.intentSource==="tag_override") overrideIntent+=1;
}
const report = {
  at: new Date().toISOString(),
  input: path.relative(process.cwd(), path.resolve(params.inputPath)),
  profileFile: params.profileFile || "active",
  hybridProsody: Boolean(params.hybridProsody),
  styleAuto: autoRun.styleName,
  styleOverride: overRun.styleName,
  segments: count,
  metrics: {
    autoTransitionDelta: transitionScore(autoSeg),
    overrideTransitionDelta: transitionScore(overSeg),
    changedIntentSegments: changedIntent,
    overrideIntentSegments: overrideIntent,
    autoProsodyEnergy: energy(autoSeg),
    overrideProsodyEnergy: energy(overSeg)
  }
};
fs.writeFileSync(path.resolve(params.outputPath), JSON.stringify(report, null, 2), "utf8");
"""
        payload = {
            "inputPath": str(Path(input_path).resolve()),
            "outputPath": str(Path(out_path).resolve()),
            "style": style,
            "profileFile": profile_file,
            "humanizeIntensity": float(humanize_intensity),
            "hybridProsody": bool(hybrid_prosody),
            "prosodyLimiter": bool(prosody_limiter),
            "prosodyLimiterStrength": float(prosody_limiter_strength),
            "autoExpressive": bool(auto_expressive),
        }
        env = dict(os.environ)
        env["EVAL_PAYLOAD"] = json.dumps(payload, ensure_ascii=False)
        res = subprocess.run(
            ["node", "--input-type=module", "-e", node_src],
            cwd=os.getcwd(),
            text=True,
            encoding="utf-8",
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            shell=False,
            env=env,
        )
        if int(res.returncode or 0) != 0:
            raise RuntimeError((res.stderr or res.stdout or "").strip() or "eval_auto_expression_failed")
        with open(out_path, "r", encoding="utf-8") as f:
            return json.load(f)
    finally:
        try:
            os.remove(out_path)
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
