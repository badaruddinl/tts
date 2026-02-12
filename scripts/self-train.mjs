import { spawnSync } from "child_process";

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

function runStep(name, args, opts = {}) {
  const allowedExitCodes = Array.isArray(opts.allowedExitCodes) ? opts.allowedExitCodes : [0];
  const cmd = process.execPath;
  const res = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    shell: false
  });
  if (!allowedExitCodes.includes(Number(res.status))) {
    throw new Error(`step_failed=${name} exit=${res.status ?? "unknown"}`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const intensityRaw = Number(args.intensity ?? 1);
  const intensity = Number.isFinite(intensityRaw) ? Math.max(0, Math.min(1, intensityRaw)) : 1;
  const voices = String(args.voices || "id-ID-ArdiNeural,id-ID-GadisNeural")
    .split(",")
    .map((v) => String(v || "").trim())
    .filter(Boolean);
  const minFeedback = Number(args["min-feedback"] ?? 1);
  const styles = String(args.styles || "").trim();
  const runBenchmark = String(args.benchmark ?? "true").toLowerCase() === "true";
  const runSchemaMigrate = String(args["schema-migrate"] ?? "true").toLowerCase() === "true";
  const runExpressionEval = String(args["expression-eval"] ?? "true").toLowerCase() === "true";
  const expressionStrict = String(args["expression-strict"] ?? "false").toLowerCase() === "true";
  const expressionDir = String(args["expression-dir"] || "tests/expressions");
  const expressionSelectStyles = String(
    args["expression-select-styles"] || "tegang,natural,sinematik,narator_tegas,melankolis"
  );

  const runVoiceEval = String(args["voice-eval"] ?? "true").toLowerCase() === "true";
  const voiceStrict = String(args["voice-strict"] ?? "false").toLowerCase() === "true";
  const voiceEvalDir = String(args["voice-eval-dir"] || "tests/voice");

  console.log("self_train:start");
  if (runSchemaMigrate) {
    runStep("schema_migrate", ["scripts/migrate-feedback-schema.mjs", "--drop-legacy", "true"]);
  }
  runStep("dedupe", ["scripts/dedupe-training-data.mjs"]);
  runStep("style_detail", ["scripts/enrich-style-feedback.mjs"]);
  runStep("profile", ["scripts/train-profile.mjs", "--apply", "true", "--min-feedback", String(minFeedback)]);
  runStep("ml_all", ["scripts/train-ml-policy.mjs"]);

  if (styles) {
    const picked = styles
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
    for (const style of picked) {
      runStep(`ml_${style}`, ["scripts/train-ml-policy.mjs", "--style", style]);
    }
  }

  if (runBenchmark) {
    for (const voice of voices) {
      const benchArgs = [
        "scripts/generate-style-benchmarks.mjs",
        "--voice",
        voice,
        "--intensity",
        String(intensity)
      ];
      if (styles) {
        benchArgs.push("--styles", styles);
      }
      runStep(`benchmark_${voice}`, benchArgs);
    }
  }

  if (runExpressionEval) {
    const evalExitCodes = expressionStrict ? [0] : [0, 2];
    runStep(
      "expression_suite",
      ["scripts/eval-expression-suite.mjs", "--dir", expressionDir, "--style", "tegang"],
      { allowedExitCodes: evalExitCodes }
    );
    runStep("expression_select", [
      "scripts/select-expression-default.mjs",
      "--dir",
      expressionDir,
      "--styles",
      expressionSelectStyles
    ]);
  }

  if (runVoiceEval) {
    const voiceExitCodes = voiceStrict ? [0] : [0, 2];
    runStep(
      "voice_suite",
      ["scripts/eval-voice-character-suite.mjs", "--dir", voiceEvalDir],
      { allowedExitCodes: voiceExitCodes }
    );
  }

  console.log("self_train:done");
}

main();
