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

function runSuite({
  dir,
  outdir,
  style,
  hybridProsody,
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
    "--prosody-limiter",
    prosodyLimiter ? "true" : "false",
    "--prosody-limiter-strength",
    String(prosodyLimiterStrength)
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (res.status !== 0 && res.status !== 2) {
    throw new Error(`suite_failed\n${res.stderr || res.stdout}`);
  }
  const summaryPath = path.join(outdir, "summary.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`summary_not_found: ${summaryPath}`);
  return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
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
  const energy = toNum(m.avgOverrideProsodyEnergy, 0);
  // Penalize over-smoothing and over-expressive modes.
  const energyPenalty = energy < 6.5 ? (6.5 - energy) * 0.9 : energy > 17.5 ? (energy - 17.5) * 0.6 : 0;
  let score = over * 0.5 + auto * 0.3 + changed * 0.1 + energyPenalty;
  if (!gate) score += 3.5;
  if (coverage < 0.8) score += 2;
  return Number(score.toFixed(6));
}

function loadDefaults(configPath) {
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(String(args.dir || "tests/expressions"));
  const outDir = path.resolve(String(args.outdir || "outputs/eval_limiter_select"));
  const cfgPath = path.resolve(String(args.config || "config/expression/defaults.json"));
  const style = String(args.style || "tegang");
  const hybridProsody = String(args["hybrid-prosody"] ?? "true").toLowerCase() === "true";
  const strengths = String(args.strengths || "0.5,0.58,0.64,0.7,0.78")
    .split(",")
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n))
    .map((n) => Math.max(0.3, Math.min(1, n)));
  ensureDir(outDir);
  ensureDir(path.dirname(cfgPath));

  const candidates = [
    { key: "off", prosodyLimiter: false, strength: 0.64 },
    ...strengths.map((s) => ({ key: `on_${s.toFixed(2)}`, prosodyLimiter: true, strength: s }))
  ];

  const ranking = [];
  for (const c of candidates) {
    const caseOut = path.join(outDir, c.key);
    ensureDir(caseOut);
    const summary = runSuite({
      dir: testsDir,
      outdir: caseOut,
      style,
      hybridProsody,
      prosodyLimiter: c.prosodyLimiter,
      prosodyLimiterStrength: c.strength
    });
    ranking.push({
      key: c.key,
      prosodyLimiter: c.prosodyLimiter,
      strength: Number(c.strength.toFixed(3)),
      score: scoreSummary(summary),
      gate: summary?.gate?.status || "unknown",
      metrics: summary?.metrics || {},
      summaryFile: path.relative(process.cwd(), path.join(caseOut, "summary.json")).replace(/\\/g, "/")
    });
  }
  ranking.sort((a, b) => a.score - b.score);
  const best = ranking[0];

  const defaults = loadDefaults(cfgPath);
  defaults.updatedAt = new Date().toISOString();
  defaults.selectedRuntime = {
    ...(defaults.selectedRuntime || {}),
    source: "limiter_select",
    prosodyLimiter: {
      enabled: Boolean(best?.prosodyLimiter),
      strength: Number(best?.strength ?? 0.64)
    }
  };
  defaults.limiterSelection = {
    updatedAt: defaults.updatedAt,
    style,
    hybridProsody,
    strengths,
    selected: best,
    ranking
  };
  fs.writeFileSync(cfgPath, JSON.stringify(defaults, null, 2), "utf8");

  const summaryPayload = {
    updatedAt: defaults.updatedAt,
    style,
    hybridProsody,
    selected: best,
    ranking
  };
  fs.writeFileSync(path.join(outDir, "summary.json"), JSON.stringify(summaryPayload, null, 2), "utf8");
  console.log(
    `limiter_selected enabled=${best?.prosodyLimiter} strength=${best?.strength} score=${best?.score}`
  );
}

main();
