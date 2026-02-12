import fs from "fs";
import path from "path";
import { trainPolicyModel, savePolicyModel, savePolicyModelToPath, ML_POLICY_PATH } from "../lib/ml-policy.mjs";
import { buildSamples, readNdjson, rowsWithAdjust, sanitizeStyle } from "../lib/ml-policy-dataset.mjs";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const style = sanitizeStyle(args.style || "");
  const feedbackPathArg = String(args["feedback-file"] || "").trim();
  const feedbackPathDefault = style
    ? path.resolve(process.cwd(), "data", "training", "styles", style, "feedback.ndjson")
    : path.resolve(process.cwd(), "data", "training", "feedback.ndjson");
  const feedbackPath = path.resolve(feedbackPathArg || feedbackPathDefault);
  const outputModelPath = String(args["output-model"] || "").trim();
  const summaryPath = String(args["summary-file"] || "").trim();
  const feedbackRows = readNdjson(feedbackPath);
  const withAdjust = rowsWithAdjust(feedbackRows);

  const samples = buildSamples(withAdjust);
  const result = trainPolicyModel({ samples });
  if (result.status !== "trained") {
    console.log(`ML training skipped: ${result.reason} (${result.sampleCount} samples)`);
    return;
  }

  const meta = {
    createdAt: new Date().toISOString(),
    sampleCount: result.sampleCount,
    sourceFeedbackRows: withAdjust.length,
    version: "prosody-policy-v1",
    styleScope: style || "all",
    feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/")
  };
  const saved = outputModelPath
    ? savePolicyModelToPath({ model: result.model, meta, modelPath: outputModelPath })
    : savePolicyModel({ model: result.model, meta });
  if (summaryPath) {
    const target = path.resolve(summaryPath);
    const parent = path.dirname(target);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          status: "trained",
          modelPath: path.relative(process.cwd(), saved).replace(/\\/g, "/"),
          feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/"),
          sampleCount: result.sampleCount,
          sourceFeedbackRows: withAdjust.length,
          styleScope: style || "all"
        },
        null,
        2
      ),
      "utf8"
    );
  }
  console.log(`ML policy trained: ${saved}`);
  console.log(`Model path const: ${ML_POLICY_PATH}`);
  console.log(`Samples: ${result.sampleCount}`);
}

main();
