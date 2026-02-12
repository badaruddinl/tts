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

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function runSuite({ dir, outdir, style }) {
  const args = [
    "scripts/eval-expression-suite.mjs",
    "--dir",
    dir,
    "--outdir",
    outdir,
    "--style",
    style
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (res.status !== 0 && res.status !== 2) {
    throw new Error(`suite_failed style=${style}\n${res.stderr || res.stdout}`);
  }
  const summaryPath = path.join(outdir, "summary.json");
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary_not_found style=${style} path=${summaryPath}`);
  }
  return JSON.parse(fs.readFileSync(summaryPath, "utf8"));
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

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(String(args.dir || "tests/expressions"));
  const styleList = String(args.styles || "tegang,natural,sinematik,narator_tegas,melankolis")
    .split(",")
    .map((s) => String(s || "").trim())
    .filter(Boolean);
  const baseOutDir = path.resolve(String(args.outdir || "outputs/eval_select"));
  const cfgPath = path.resolve(String(args.config || "config/expression/defaults.json"));

  ensureDir(baseOutDir);
  ensureDir(path.dirname(cfgPath));

  const results = [];
  for (const style of styleList) {
    const styleOut = path.join(baseOutDir, style);
    ensureDir(styleOut);
    const summary = runSuite({
      dir: testsDir,
      outdir: styleOut,
      style
    });
    const score = scoreSummary(summary);
    results.push({
      style,
      score,
      gate: summary?.gate?.status || "unknown",
      metrics: summary?.metrics || {},
      summaryFile: path.relative(process.cwd(), path.join(styleOut, "summary.json"))
    });
    console.log(`style_eval style=${style} score=${score} gate=${summary?.gate?.status || "unknown"}`);
  }

  results.sort((a, b) => a.score - b.score);
  const best = results[0];
  if (!best) {
    throw new Error("no_results");
  }

  const payload = {
    updatedAt: new Date().toISOString(),
    source: {
      testsDir: path.relative(process.cwd(), testsDir),
      candidateStyles: styleList
    },
    selected: {
      style: best.style,
      score: best.score,
      gate: best.gate
    },
    ranking: results
  };
  fs.writeFileSync(cfgPath, JSON.stringify(payload, null, 2), "utf8");
  console.log(`expression_default_selected style=${best.style} config=${path.relative(process.cwd(), cfgPath)}`);
}

main();
