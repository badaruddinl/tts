import readline from "readline";
import { runMlPolicyTraining } from "../lib/ml-policy-train-runner.mjs";

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
  terminal: false
});

function respond(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

respond({ type: "ready", service: "train-ml-policy-js" });

rl.on("line", (line) => {
  const trimmed = String(line || "").trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    respond({ type: "error", error: "invalid_json" });
    return;
  }

  if (msg?.action === "shutdown") {
    respond({ type: "bye" });
    process.exit(0);
    return;
  }

  if (msg?.action !== "train") {
    respond({ id: msg?.id ?? null, type: "error", error: "unknown_action" });
    return;
  }

  const t0 = Date.now();
  try {
    const res = runMlPolicyTraining({
      style: String(msg?.style || ""),
      feedbackFile: String(msg?.feedbackFile || ""),
      outputModel: String(msg?.outputModel || ""),
      summaryFile: String(msg?.summaryFile || ""),
      useCache: msg?.useCache !== false
    });
    respond({
      id: msg?.id ?? null,
      type: "result",
      elapsedMs: Date.now() - t0,
      ...res
    });
  } catch (err) {
    respond({
      id: msg?.id ?? null,
      type: "error",
      elapsedMs: Date.now() - t0,
      error: err?.message || String(err)
    });
  }
});
