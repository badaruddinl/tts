import fs from "fs";
import path from "path";
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function runSuite({
  dir,
  outdir,
  style,
  profileFile,
  hybridProsody,
  humanizeIntensity,
  autoExpressive,
  prosodyLimiter,
  prosodyLimiterStrength
}) {
  const args = [
    "scripts/eval-expression-suite.mjs",
    "--dir",
    dir,
    "--outdir",
    outdir,
    "--style",
    style,
    "--hybrid-prosody",
    hybridProsody ? "true" : "false",
    "--humanize-intensity",
    String(humanizeIntensity),
    "--auto-expressive",
    autoExpressive ? "true" : "false",
    "--prosody-limiter",
    prosodyLimiter ? "true" : "false",
    "--prosody-limiter-strength",
    String(prosodyLimiterStrength)
  ];
  if (profileFile) args.push("--profile-file", profileFile);
  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (res.status !== 0 && res.status !== 2) {
    throw new Error(`eval_suite_failed\n${res.stderr || res.stdout}`);
  }
  const summaryPath = path.join(outdir, "summary.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`summary_missing ${summaryPath}`);
  return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
}

function scoreSummary(summary) {
  const m = summary?.metrics || {};
  const gate = summary?.gate?.status === "pass";
  const auto = toNum(m.avgAutoTransitionDelta, 99);
  const over = toNum(m.avgOverrideTransitionDelta, 99);
  const changed = toNum(m.avgChangedIntentSegments, 99);
  const coverage = toNum(m.avgOverrideIntentSegments, 0);
  const energy = toNum(m.avgOverrideProsodyEnergy, 0);
  const energyPenalty = energy < 7 ? (7 - energy) * 0.8 : energy > 18 ? (energy - 18) * 0.5 : 0;
  let score = over * 0.5 + auto * 0.3 + changed * 0.1 + energyPenalty;
  if (!gate) score += 3.5;
  if (coverage < 0.8) score += 2;
  return Number(score.toFixed(6));
}

function readDefaults(cfgPath) {
  if (!fs.existsSync(cfgPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(cfgPath, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(String(args.dir || "tests/expressions"));
  const outDir = path.resolve(String(args.outdir || "outputs/eval_intonation_select"));
  const cfgPath = path.resolve(String(args.config || "config/expression/defaults.json"));
  const style = String(args.style || "tegang");
  const profileFile = String(args["profile-file"] || "").trim();
  const hybridProsody = String(args["hybrid-prosody"] ?? "true").toLowerCase() === "true";
  const prosodyLimiter = String(args["prosody-limiter"] ?? "true").toLowerCase() === "true";
  const prosodyLimiterStrength = Number(args["prosody-limiter-strength"] ?? 0.64);
  const intensities = String(args.intensities || "0.45,0.55,0.64,0.72,0.8")
    .split(",")
    .map((v) => Number(v))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0, Math.min(1, n)));
  const expressiveModes = String(args["auto-expressive-candidates"] || "true,false")
    .split(",")
    .map((v) => String(v).trim().toLowerCase())
    .filter((v) => v === "true" || v === "false")
    .map((v) => v === "true");
  const offMargin = Math.max(0, Math.min(0.5, Number(args["auto-expressive-off-margin"] ?? 0.1)));

  ensureDir(outDir);
  ensureDir(path.dirname(cfgPath));
  const ranking = [];

  for (const intensity of intensities) {
    for (const autoExpressive of expressiveModes) {
      const key = `int_${intensity.toFixed(2)}_ae_${autoExpressive ? "on" : "off"}`;
      const caseOut = path.join(outDir, key);
      ensureDir(caseOut);
      const summary = runSuite({
        dir: testsDir,
        outdir: caseOut,
        style,
        profileFile,
        hybridProsody,
        humanizeIntensity: intensity,
        autoExpressive,
        prosodyLimiter,
        prosodyLimiterStrength
      });
      ranking.push({
        key,
        humanizeIntensity: Number(intensity.toFixed(3)),
        autoExpressive,
        score: scoreSummary(summary),
        gate: summary?.gate?.status || "unknown",
        metrics: summary?.metrics || {},
        summaryFile: path.relative(process.cwd(), path.join(caseOut, "summary.json")).replace(/\\/g, "/")
      });
    }
  }

  ranking.sort((a, b) => a.score - b.score);
  let best = ranking[0];
  const bestOn = ranking.find((r) => r.autoExpressive === true) || null;
  const bestOff = ranking.find((r) => r.autoExpressive === false) || null;
  if (bestOn && bestOff && bestOff.score < bestOn.score) {
    const relGain = (bestOn.score - bestOff.score) / Math.max(bestOn.score, 1e-9);
    if (relGain < offMargin) {
      best = bestOn;
    }
  }
  const defaults = readDefaults(cfgPath);
  const now = new Date().toISOString();
  defaults.updatedAt = now;
  defaults.selectedRuntime = {
    ...(defaults.selectedRuntime || {}),
    source: "auto_intonation_select",
    style: (defaults.selectedRuntime?.style || style),
    humanizeIntensity: Number(best.humanizeIntensity),
    autoExpressive: Boolean(best.autoExpressive)
  };
  defaults.intonationSelection = {
    updatedAt: now,
    style,
    hybridProsody,
    prosodyLimiter,
    prosodyLimiterStrength,
    intensities,
    expressiveModes,
    autoExpressiveOffMargin: offMargin,
    selected: best,
    ranking
  };
  fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf8");
  fs.writeFileSync(
    path.join(outDir, "summary.json"),
    JSON.stringify(
      {
        updatedAt: now,
        style,
        selected: best,
        ranking
      },
      null,
      2
    ),
    "utf8"
  );
  console.log(
    `intonation_selected intensity=${best.humanizeIntensity} auto_expressive=${best.autoExpressive} score=${best.score}`
  );
}

main();
