import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { getActiveProfileFile, setActiveProfileFile } from "../lib/profile-store.mjs";

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

function runNodeStep(name, args, opts = {}) {
  const allowedExitCodes = Array.isArray(opts.allowedExitCodes) ? opts.allowedExitCodes : [0];
  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (!allowedExitCodes.includes(Number(res.status))) {
    const logs = [res.stdout || "", res.stderr || ""].filter(Boolean).join("\n");
    throw new Error(`step_failed=${name} exit=${res.status ?? "unknown"}\n${logs}`);
  }
  return {
    status: Number(res.status ?? 0),
    stdout: String(res.stdout || "").trim(),
    stderr: String(res.stderr || "").trim()
  };
}

function readJson(filePath, fallback = null) {
  const target = path.resolve(filePath);
  if (!fs.existsSync(target)) return fallback;
  return JSON.parse(fs.readFileSync(target, "utf8"));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function scoreSummary(summary) {
  const m = summary?.metrics || {};
  const gate = summary?.gate?.status === "pass";
  const auto = toNum(m.avgAutoTransitionDelta, 99);
  const over = toNum(m.avgOverrideTransitionDelta, 99);
  const changed = toNum(m.avgChangedIntentSegments, 99);
  const coverage = toNum(m.avgOverrideIntentSegments, 0);
  let score = over * 0.55 + auto * 0.35 + changed * 0.1;
  if (!gate) score += 3.5;
  if (coverage < 0.8) score += 2;
  return Number(score.toFixed(6));
}

function evaluateExpressionSet({ styles, testsDir, outBaseDir, profileFile }) {
  const rows = [];
  for (const style of styles) {
    const outdir = path.join(outBaseDir, style);
    ensureDir(outdir);
    runNodeStep(
      `eval_expression_${style}_${profileFile || "active"}`,
      [
        "scripts/eval-expression-suite.mjs",
        "--dir",
        testsDir,
        "--outdir",
        outdir,
        "--style",
        style,
        ...(profileFile ? ["--profile-file", profileFile] : [])
      ],
      { allowedExitCodes: [0, 2] }
    );
    const summary = readJson(path.join(outdir, "summary.json"), {});
    rows.push({
      style,
      score: scoreSummary(summary),
      gate: summary?.gate?.status || "unknown",
      metrics: summary?.metrics || {}
    });
  }
  const avgScore = rows.length
    ? Number((rows.reduce((s, r) => s + r.score, 0) / rows.length).toFixed(6))
    : 999;
  const passCount = rows.filter((r) => r.gate === "pass").length;
  return { rows, avgScore, passCount };
}

function relativeSafe(filePath) {
  return path.relative(process.cwd(), filePath).replace(/\\/g, "/");
}

function appendNdjson(filePath, payload) {
  const target = path.resolve(filePath);
  ensureDir(path.dirname(target));
  fs.appendFileSync(target, `${JSON.stringify(payload)}\n`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const splitDir = path.resolve(String(args["split-dir"] || "data/training/splits/ml"));
  const mlValidFile = path.join(splitDir, "valid.ndjson");
  const mlTrainFile = path.join(splitDir, "train.ndjson");
  const mlTestFile = path.join(splitDir, "test.ndjson");
  const styles = String(args.styles || "tegang,natural,sinematik,narator_tegas,melankolis")
    .split(",")
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const testsDir = path.resolve(String(args["expression-dir"] || "tests/expressions"));
  const reportDir = path.resolve(String(args.outdir || `outputs/auto_train/${runId}`));
  const registryFile = path.resolve(String(args.registry || "data/training/auto-train-runs.ndjson"));
  const feedbackSource = path.resolve(String(args["feedback-source"] || "data/training/feedback.ndjson"));
  const splitRatios = String(args["split-ratios"] || "0.8,0.1,0.1");
  const splitSeed = String(args["split-seed"] || "42");
  const minMlRelImprove = toNum(args["min-ml-rel-improve"], 0.01);
  const minProfileAbsImprove = toNum(args["min-profile-abs-improve"], 0.05);
  const requireProfileGate = String(args["require-profile-gate"] ?? "true").toLowerCase() === "true";
  const requireMlImprove = String(args["require-ml-improve"] ?? "true").toLowerCase() === "true";
  const dryRun = String(args["dry-run"] ?? "false").toLowerCase() === "true";
  const keepCandidates = String(args["keep-candidates"] ?? "false").toLowerCase() === "true";

  ensureDir(reportDir);
  ensureDir(splitDir);

  const baselineProfileFile = getActiveProfileFile();
  const baselineModelPath = path.resolve("models/prosody-policy-v1.json");
  const candidateProfileFile = `v_auto_candidate_${runId}.json`;
  const candidateModelPath = path.resolve(`models/candidates/prosody-policy-v1-${runId}.json`);

  runNodeStep("split", [
    "scripts/train-split.mjs",
    "--source",
    feedbackSource,
    "--outdir",
    splitDir,
    "--seed",
    splitSeed,
    "--ratios",
    splitRatios
  ]);

  runNodeStep("train_ml_candidate", [
    "scripts/train-ml-policy.mjs",
    "--feedback-file",
    mlTrainFile,
    "--output-model",
    candidateModelPath
  ]);

  const mlBaseEvalFile = path.join(reportDir, "ml_baseline_valid.json");
  const mlCandEvalFile = path.join(reportDir, "ml_candidate_valid.json");
  const mlCandEvalTestFile = path.join(reportDir, "ml_candidate_test.json");

  runNodeStep(
    "eval_ml_baseline_valid",
    [
      "scripts/eval-ml-policy.mjs",
      "--feedback-file",
      mlValidFile,
      "--model",
      baselineModelPath,
      "--output",
      mlBaseEvalFile
    ],
    { allowedExitCodes: [0, 2] }
  );
  runNodeStep(
    "eval_ml_candidate_valid",
    [
      "scripts/eval-ml-policy.mjs",
      "--feedback-file",
      mlValidFile,
      "--model",
      candidateModelPath,
      "--output",
      mlCandEvalFile
    ],
    { allowedExitCodes: [0, 2] }
  );
  runNodeStep(
    "eval_ml_candidate_test",
    [
      "scripts/eval-ml-policy.mjs",
      "--feedback-file",
      mlTestFile,
      "--model",
      candidateModelPath,
      "--output",
      mlCandEvalTestFile
    ],
    { allowedExitCodes: [0, 2] }
  );

  runNodeStep("train_profile_candidate", [
    "scripts/train-profile.mjs",
    "--feedback-file",
    mlTrainFile,
    "--output-file",
    candidateProfileFile,
    "--apply",
    "false",
    "--min-feedback",
    "1"
  ]);

  const baselineExpr = evaluateExpressionSet({
    styles,
    testsDir,
    outBaseDir: path.join(reportDir, "expression_baseline"),
    profileFile: baselineProfileFile
  });
  const candidateExpr = evaluateExpressionSet({
    styles,
    testsDir,
    outBaseDir: path.join(reportDir, "expression_candidate"),
    profileFile: candidateProfileFile
  });

  const mlBase = readJson(mlBaseEvalFile, {});
  const mlCand = readJson(mlCandEvalFile, {});
  const mlBaseMse = toNum(mlBase?.mse?.total, Number.POSITIVE_INFINITY);
  const mlCandMse = toNum(mlCand?.mse?.total, Number.POSITIVE_INFINITY);
  const mlRelImprove = Number.isFinite(mlBaseMse) && mlBaseMse > 0
    ? Number(((mlBaseMse - mlCandMse) / mlBaseMse).toFixed(6))
    : Number.POSITIVE_INFINITY;
  const profileAbsImprove = Number((baselineExpr.avgScore - candidateExpr.avgScore).toFixed(6));

  const mlGate = requireMlImprove ? mlRelImprove >= minMlRelImprove : mlCandMse < Number.POSITIVE_INFINITY;
  const profileGateByScore = profileAbsImprove >= minProfileAbsImprove;
  const profileGateByPass = !requireProfileGate || candidateExpr.passCount >= baselineExpr.passCount;
  const profileGate = profileGateByScore && profileGateByPass;
  const promote = mlGate && profileGate;

  if (promote && !dryRun) {
    ensureDir(path.dirname(baselineModelPath));
    fs.copyFileSync(candidateModelPath, baselineModelPath);
    setActiveProfileFile(candidateProfileFile);
  }

  const summary = {
    at: new Date().toISOString(),
    runId,
    promote,
    dryRun,
    baseline: {
      profile: baselineProfileFile,
      model: relativeSafe(baselineModelPath)
    },
    candidate: {
      profile: candidateProfileFile,
      model: relativeSafe(candidateModelPath)
    },
    gates: {
      mlGate,
      profileGate,
      profileGateByScore,
      profileGateByPass
    },
    metrics: {
      ml: {
        baselineValidMse: Number.isFinite(mlBaseMse) ? mlBaseMse : null,
        candidateValidMse: Number.isFinite(mlCandMse) ? mlCandMse : null,
        relImprove: Number.isFinite(mlRelImprove) ? mlRelImprove : null,
        minRelImprove: minMlRelImprove
      },
      profile: {
        baselineAvgScore: baselineExpr.avgScore,
        candidateAvgScore: candidateExpr.avgScore,
        absImprove: profileAbsImprove,
        minAbsImprove: minProfileAbsImprove,
        baselinePassCount: baselineExpr.passCount,
        candidatePassCount: candidateExpr.passCount
      }
    },
    styles,
    expression: {
      baseline: baselineExpr.rows,
      candidate: candidateExpr.rows
    },
    split: {
      dir: relativeSafe(splitDir),
      source: relativeSafe(feedbackSource)
    },
    reports: {
      dir: relativeSafe(reportDir),
      mlBaselineValid: relativeSafe(mlBaseEvalFile),
      mlCandidateValid: relativeSafe(mlCandEvalFile),
      mlCandidateTest: relativeSafe(mlCandEvalTestFile)
    }
  };

  const summaryFile = path.join(reportDir, "summary.json");
  fs.writeFileSync(summaryFile, JSON.stringify(summary, null, 2), "utf8");
  appendNdjson(registryFile, summary);

  if (dryRun && !keepCandidates) {
    const candidateProfilePath = path.resolve("config", "profiles", candidateProfileFile);
    if (fs.existsSync(candidateProfilePath)) fs.unlinkSync(candidateProfilePath);
    if (fs.existsSync(candidateModelPath)) fs.unlinkSync(candidateModelPath);
  }

  console.log(
    `train_auto_done promote=${promote} ml_rel=${summary.metrics.ml.relImprove} profile_abs=${summary.metrics.profile.absImprove} report=${relativeSafe(summaryFile)}`
  );
  if (!promote) process.exitCode = 2;
}

main();
