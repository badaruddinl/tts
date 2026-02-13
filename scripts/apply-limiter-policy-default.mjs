import fs from "fs";
import path from "path";
import { readNdjson } from "../lib/ml-policy-dataset.mjs";
import {
  loadLimiterPolicyModel,
  predictLimiterStrength,
  summarizeRowsForStyle,
  summarizeToFeatureVector
} from "../lib/limiter-policy.mjs";
import { getExpressionDefaultStyle } from "../lib/expression-defaults.mjs";

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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function readDefaults(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cfgPath = path.resolve(String(args.config || "config/expression/defaults.json"));
  const modelPath = String(args.model || "").trim();
  const styleArg = String(args.style || "").trim();
  const alpha = clamp(toNum(args.alpha, 0.65), 0, 1);
  const feedbackFileArg = String(args["feedback-file"] || "").trim();

  const defaults = readDefaults(cfgPath);
  const style =
    styleArg ||
    String(defaults?.selectedRuntime?.style || "").trim() ||
    getExpressionDefaultStyle("natural");
  const styleKey = String(style || "natural").trim().toLowerCase();
  const fallbackStrength = clamp(
    toNum(defaults?.selectedRuntime?.prosodyLimiter?.strength, 0.64),
    0.45,
    0.9
  );
  const feedbackPath = feedbackFileArg
    ? path.resolve(feedbackFileArg)
    : path.resolve(process.cwd(), "data", "training", "feedback.ndjson");
  const rows = readNdjson(feedbackPath);
  const summary = summarizeRowsForStyle(rows, styleKey);
  const feat = summarizeToFeatureVector(summary);
  const policy = loadLimiterPolicyModel(modelPath || undefined);
  const predicted = predictLimiterStrength(policy, feat, fallbackStrength);
  const blended = clamp((1 - alpha) * fallbackStrength + alpha * predicted, 0.45, 0.9);

  defaults.updatedAt = new Date().toISOString();
  defaults.selectedRuntime = {
    ...(defaults.selectedRuntime || {}),
    style,
    prosodyLimiter: {
      enabled: true,
      strength: Number(blended.toFixed(3))
    }
  };
  defaults.limiterPolicy = {
    updatedAt: defaults.updatedAt,
    style,
    alpha,
    fallbackStrength: Number(fallbackStrength.toFixed(3)),
    predictedStrength: Number(predicted.toFixed(3)),
    blendedStrength: Number(blended.toFixed(3)),
    modelMeta: policy?.meta || null,
    feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/")
  };
  fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf8");
  console.log(
    `limiter_policy_applied style=${style} blended=${blended.toFixed(3)} predicted=${predicted.toFixed(3)} alpha=${alpha}`
  );
}

main();
