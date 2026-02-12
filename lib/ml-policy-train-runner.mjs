import fs from "fs";
import path from "path";
import {
  trainPolicyModel,
  savePolicyModel,
  savePolicyModelToPath,
  ML_POLICY_PATH
} from "./ml-policy.mjs";
import { readNdjson, sanitizeStyle } from "./ml-policy-dataset.mjs";
import { loadSamplesWithCache } from "./ml-policy-sample-cache.mjs";

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function runMlPolicyTraining({
  style = "",
  feedbackFile = "",
  outputModel = "",
  summaryFile = "",
  useCache = true
}) {
  const normalizedStyle = sanitizeStyle(style || "");
  const defaultFeedbackPath = normalizedStyle
    ? path.resolve(process.cwd(), "data", "training", "styles", normalizedStyle, "feedback.ndjson")
    : path.resolve(process.cwd(), "data", "training", "feedback.ndjson");
  const feedbackPath = path.resolve(feedbackFile || defaultFeedbackPath);
  const feedbackRows = readNdjson(feedbackPath);
  const samplePack = loadSamplesWithCache({
    feedbackFile: feedbackPath,
    rows: feedbackRows,
    useCache
  });
  const samples = samplePack.samples;

  const result = trainPolicyModel({ samples });
  if (result.status !== "trained") {
    return {
      status: "skipped",
      reason: result.reason,
      sampleCount: result.sampleCount || 0,
      feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/")
    };
  }

  const meta = {
    createdAt: new Date().toISOString(),
    sampleCount: result.sampleCount,
    sourceFeedbackRows: samplePack.rowsWithAdjust,
    version: "prosody-policy-v1",
    styleScope: normalizedStyle || "all",
    feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/"),
    sampleCache: {
      signature: samplePack.signature,
      file: path.relative(process.cwd(), samplePack.cachePath).replace(/\\/g, "/"),
      hit: samplePack.cacheHit
    }
  };
  const saved = outputModel
    ? savePolicyModelToPath({ model: result.model, meta, modelPath: outputModel })
    : savePolicyModel({ model: result.model, meta });

  if (summaryFile) {
    const target = path.resolve(summaryFile);
    ensureDir(path.dirname(target));
    fs.writeFileSync(
      target,
      JSON.stringify(
        {
          status: "trained",
          modelPath: path.relative(process.cwd(), saved).replace(/\\/g, "/"),
          feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/"),
          sampleCount: result.sampleCount,
          sourceFeedbackRows: samplePack.rowsWithAdjust,
          styleScope: normalizedStyle || "all",
          cacheHit: samplePack.cacheHit
        },
        null,
        2
      ),
      "utf8"
    );
  }

  return {
    status: "trained",
    modelPath: saved,
    modelPathConst: ML_POLICY_PATH,
    sampleCount: result.sampleCount,
    feedbackFile: path.relative(process.cwd(), feedbackPath).replace(/\\/g, "/"),
    sourceFeedbackRows: samplePack.rowsWithAdjust,
    styleScope: normalizedStyle || "all",
    cacheHit: samplePack.cacheHit
  };
}
