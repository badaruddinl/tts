import { runMlPolicyTraining } from "../lib/ml-policy-train-runner.mjs";

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
  const res = runMlPolicyTraining({
    style: String(args.style || ""),
    feedbackFile: String(args["feedback-file"] || "").trim(),
    outputModel: String(args["output-model"] || "").trim(),
    summaryFile: String(args["summary-file"] || "").trim(),
    useCache: !(String(args["no-cache"] || "").toLowerCase() === "true")
  });
  if (res.status !== "trained") {
    console.log(`ML training skipped: ${res.reason} (${res.sampleCount} samples)`);
    return;
  }
  console.log(`ML policy trained: ${res.modelPath}`);
  console.log(`Model path const: ${res.modelPathConst}`);
  console.log(`Samples: ${res.sampleCount}`);
  console.log(`Cache hit: ${res.cacheHit}`);
}

main();
