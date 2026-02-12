import fs from "fs";
import path from "path";
import { loadPolicyModelFromPath } from "../lib/ml-policy.mjs";
import { buildSamples, readNdjson, rowsWithAdjust } from "../lib/ml-policy-dataset.mjs";

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) continue;
    const key = item.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      out[key] = true;
      continue;
    }
    out[key] = next;
    i += 1;
  }
  return out;
}

function mseFromPairs(pairs) {
  if (!pairs.length) return null;
  let sum = 0;
  for (const item of pairs) sum += item;
  return sum / pairs.length;
}

function evaluateModel(policy, samples) {
  if (!policy?.model) {
    return {
      status: "skipped",
      reason: "model_not_found"
    };
  }
  if (!samples.length) {
    return {
      status: "skipped",
      reason: "empty_samples"
    };
  }

  const axisRate = [];
  const axisPitch = [];
  const axisVolume = [];
  const axisAll = [];

  const predictFromFeatures = (features) => {
    if (policy?.modelType === "linear_py_v1") {
      const weights = Array.isArray(policy?.model?.weights) ? policy.model.weights : [];
      const bias = Array.isArray(policy?.model?.intercept) ? policy.model.intercept : [0, 0, 0];
      const out = [Number(bias[0] || 0), Number(bias[1] || 0), Number(bias[2] || 0)];
      const dim = Math.min(features.length, weights.length);
      for (let i = 0; i < dim; i += 1) {
        const row = Array.isArray(weights[i]) ? weights[i] : [0, 0, 0];
        const x = Number(features[i] || 0);
        out[0] += x * Number(row[0] || 0);
        out[1] += x * Number(row[1] || 0);
        out[2] += x * Number(row[2] || 0);
      }
      return out;
    }
    return policy.model.predict(features);
  };

  for (const sample of samples) {
    const [tDr, tDp, tDv] = sample.target;
    const pred = predictFromFeatures(sample.features);
    const [pDr, pDp, pDv] = Array.isArray(pred) ? pred : [0, 0, 0];
    const er = (Number(pDr) || 0) - (Number(tDr) || 0);
    const ep = (Number(pDp) || 0) - (Number(tDp) || 0);
    const ev = (Number(pDv) || 0) - (Number(tDv) || 0);

    axisRate.push(er * er);
    axisPitch.push(ep * ep);
    axisVolume.push(ev * ev);
    axisAll.push((er * er + ep * ep + ev * ev) / 3);
  }

  return {
    status: "evaluated",
    sampleCount: samples.length,
    mse: {
      total: Number((mseFromPairs(axisAll) ?? 0).toFixed(6)),
      rate: Number((mseFromPairs(axisRate) ?? 0).toFixed(6)),
      pitch: Number((mseFromPairs(axisPitch) ?? 0).toFixed(6)),
      volume: Number((mseFromPairs(axisVolume) ?? 0).toFixed(6))
    }
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const feedbackFile = path.resolve(
    String(args["feedback-file"] || "data/training/splits/ml/valid.ndjson")
  );
  const modelPath = path.resolve(String(args.model || "models/prosody-policy-v1.json"));
  const outFile = path.resolve(String(args.output || "outputs/eval_ml_policy.json"));

  const rows = rowsWithAdjust(readNdjson(feedbackFile));
  const samples = buildSamples(rows);
  const policy = loadPolicyModelFromPath(modelPath);
  const result = evaluateModel(policy, samples);

  const payload = {
    at: new Date().toISOString(),
    feedbackFile: path.relative(process.cwd(), feedbackFile).replace(/\\/g, "/"),
    model: path.relative(process.cwd(), modelPath).replace(/\\/g, "/"),
    rows: rows.length,
    ...result
  };

  const parent = path.dirname(outFile);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
  console.log(
    `ml_eval_done status=${payload.status} samples=${payload.sampleCount || 0} mse=${payload?.mse?.total ?? "na"} file=${path.relative(process.cwd(), outFile)}`
  );

  if (payload.status !== "evaluated") {
    process.exitCode = 2;
  }
}

main();
