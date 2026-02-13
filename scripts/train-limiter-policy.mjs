import fs from "fs";
import path from "path";
import { readNdjson, sanitizeStyle } from "../lib/ml-policy-dataset.mjs";
import {
  buildLimiterSamples,
  trainLimiterPolicyModel,
  saveLimiterPolicyModel,
  LIMITER_POLICY_PATH
} from "../lib/limiter-policy.mjs";

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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const style = sanitizeStyle(String(args.style || ""));
  const defaultFeedbackPath = style
    ? path.resolve(process.cwd(), "data", "training", "styles", style, "feedback.ndjson")
    : path.resolve(process.cwd(), "data", "training", "feedback.ndjson");
  const feedbackPath = path.resolve(String(args["feedback-file"] || defaultFeedbackPath));
  const outputModel = path.resolve(String(args["output-model"] || LIMITER_POLICY_PATH));
  const summaryFile = String(args["summary-file"] || "").trim();
  const rows = readNdjson(feedbackPath);
  const samples = buildLimiterSamples(rows, { style });
  const res = trainLimiterPolicyModel({ samples });
  if (res.status !== "trained") {
    console.log(`limiter_training_skipped reason=${res.reason} samples=${res.sampleCount}`);
    return;
  }

  const meta = {
    createdAt: new Date().toISOString(),
    sampleCount: res.sampleCount,
    styleScope: style || "all",
    feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/"),
    version: "limiter-policy-v1"
  };
  const saved = saveLimiterPolicyModel({ model: res.model, meta, modelPath: outputModel });
  console.log(
    `limiter_policy_trained model=${path.relative(process.cwd(), saved).replace(/\\/g, "/")} samples=${res.sampleCount}`
  );

  if (summaryFile) {
    const target = path.resolve(summaryFile);
    ensureDir(path.dirname(target));
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          status: "trained",
          modelPath: path.relative(process.cwd(), saved).replace(/\\/g, "/"),
          sampleCount: res.sampleCount,
          styleScope: style || "all"
        },
        null,
        2
      ),
      "utf8"
    );
  }
}

main();
