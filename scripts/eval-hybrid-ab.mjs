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

function runSuite({ dir, outdir, style, hybridProsody }) {
  const args = [
    "scripts/eval-expression-suite.mjs",
    "--dir",
    dir,
    "--outdir",
    outdir,
    "--style",
    style,
    "--hybrid-prosody",
    hybridProsody ? "true" : "false"
  ];
  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (res.status !== 0 && res.status !== 2) {
    throw new Error(`eval_suite_failed mode=${hybridProsody ? "on" : "off"}\n${res.stderr || res.stdout}`);
  }
  const summaryPath = path.join(outdir, "summary.json");
  if (!fs.existsSync(summaryPath)) throw new Error(`summary_missing ${summaryPath}`);
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
  let score = over * 0.55 + auto * 0.35 + changed * 0.1;
  if (!gate) score += 3.5;
  if (coverage < 0.8) score += 2;
  return Number(score.toFixed(6));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(String(args.dir || "tests/expressions"));
  const style = String(args.style || "tegang");
  const outDir = path.resolve(String(args.outdir || "outputs/eval_hybrid_ab"));
  ensureDir(outDir);

  const offDir = path.join(outDir, "hybrid_off");
  const onDir = path.join(outDir, "hybrid_on");
  ensureDir(offDir);
  ensureDir(onDir);

  const off = runSuite({ dir: testsDir, outdir: offDir, style, hybridProsody: false });
  const on = runSuite({ dir: testsDir, outdir: onDir, style, hybridProsody: true });

  const offScore = scoreSummary(off);
  const onScore = scoreSummary(on);
  const delta = Number((offScore - onScore).toFixed(6));
  const winner = onScore < offScore ? "hybrid_on" : onScore > offScore ? "hybrid_off" : "tie";
  const payload = {
    generatedAt: new Date().toISOString(),
    style,
    testsDir: path.relative(process.cwd(), testsDir).replace(/\\/g, "/"),
    score: {
      hybridOff: offScore,
      hybridOn: onScore,
      deltaOffMinusOn: delta,
      winner
    },
    gate: {
      hybridOff: off?.gate?.status || "unknown",
      hybridOn: on?.gate?.status || "unknown"
    },
    metrics: {
      hybridOff: off?.metrics || {},
      hybridOn: on?.metrics || {}
    },
    reports: {
      off: path.relative(process.cwd(), path.join(offDir, "summary.json")).replace(/\\/g, "/"),
      on: path.relative(process.cwd(), path.join(onDir, "summary.json")).replace(/\\/g, "/")
    }
  };

  const reportJson = path.join(outDir, "summary.json");
  fs.writeFileSync(reportJson, JSON.stringify(payload, null, 2), "utf8");
  const md = [
    "# Hybrid Prosody A/B",
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- style: ${payload.style}`,
    `- testsDir: \`${payload.testsDir}\``,
    "",
    "| mode | score | gate |",
    "|---|---:|---|",
    `| hybrid_off | ${offScore} | ${payload.gate.hybridOff} |`,
    `| hybrid_on | ${onScore} | ${payload.gate.hybridOn} |`,
    "",
    `Winner: **${winner}** (delta off-on: ${delta})`
  ];
  fs.writeFileSync(path.join(outDir, "summary.md"), `${md.join("\n")}\n`, "utf8");
  console.log(`hybrid_ab_done winner=${winner} report=${path.relative(process.cwd(), reportJson).replace(/\\/g, "/")}`);
}

main();
