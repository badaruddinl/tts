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

function runSuite({ dir, outdir, style, profileFile, hybridProsody, humanizeIntensity }) {
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
    String(humanizeIntensity)
  ];
  if (profileFile) {
    args.push("--profile-file", profileFile);
  }
  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (res.status !== 0 && res.status !== 2) {
    throw new Error(`eval_suite_failed mode=${style}\n${res.stderr || res.stdout}`);
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
  const outDir = path.resolve(String(args.outdir || "outputs/eval_expression_ab"));
  const styleA = String(args["style-a"] || "tegang");
  const styleB = String(args["style-b"] || styleA);
  const profileA = String(args["profile-a"] || "").trim();
  const profileB = String(args["profile-b"] || "").trim();
  const hybridA = String(args["hybrid-a"] ?? "true").toLowerCase() === "true";
  const hybridB = String(args["hybrid-b"] ?? "true").toLowerCase() === "true";
  const intensityA = Number(args["intensity-a"] ?? 0.4);
  const intensityB = Number(args["intensity-b"] ?? 0.7);

  ensureDir(outDir);
  const aDir = path.join(outDir, "a");
  const bDir = path.join(outDir, "b");
  ensureDir(aDir);
  ensureDir(bDir);

  const a = runSuite({
    dir: testsDir,
    outdir: aDir,
    style: styleA,
    profileFile: profileA,
    hybridProsody: hybridA,
    humanizeIntensity: intensityA
  });
  const b = runSuite({
    dir: testsDir,
    outdir: bDir,
    style: styleB,
    profileFile: profileB,
    hybridProsody: hybridB,
    humanizeIntensity: intensityB
  });

  const aScore = scoreSummary(a);
  const bScore = scoreSummary(b);
  const delta = Number((aScore - bScore).toFixed(6));
  const winner = bScore < aScore ? "B" : bScore > aScore ? "A" : "tie";
  const payload = {
    generatedAt: new Date().toISOString(),
    testsDir: path.relative(process.cwd(), testsDir).replace(/\\/g, "/"),
    configs: {
      A: {
        style: styleA,
        profileFile: profileA || "active",
        hybridProsody: hybridA,
        humanizeIntensity: intensityA
      },
      B: {
        style: styleB,
        profileFile: profileB || "active",
        hybridProsody: hybridB,
        humanizeIntensity: intensityB
      }
    },
    score: {
      A: aScore,
      B: bScore,
      deltaAminusB: delta,
      winner
    },
    gate: {
      A: a?.gate?.status || "unknown",
      B: b?.gate?.status || "unknown"
    },
    metrics: {
      A: a?.metrics || {},
      B: b?.metrics || {}
    },
    reports: {
      A: path.relative(process.cwd(), path.join(aDir, "summary.json")).replace(/\\/g, "/"),
      B: path.relative(process.cwd(), path.join(bDir, "summary.json")).replace(/\\/g, "/")
    }
  };

  const reportJson = path.join(outDir, "summary.json");
  fs.writeFileSync(reportJson, JSON.stringify(payload, null, 2), "utf8");
  const md = [
    "# Expression A/B",
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- testsDir: \`${payload.testsDir}\``,
    "",
    "| mode | score | gate | style | profile | hybrid | intensity |",
    "|---|---:|---|---|---|---|---:|",
    `| A | ${aScore} | ${payload.gate.A} | ${payload.configs.A.style} | ${payload.configs.A.profileFile} | ${payload.configs.A.hybridProsody} | ${payload.configs.A.humanizeIntensity} |`,
    `| B | ${bScore} | ${payload.gate.B} | ${payload.configs.B.style} | ${payload.configs.B.profileFile} | ${payload.configs.B.hybridProsody} | ${payload.configs.B.humanizeIntensity} |`,
    "",
    `Winner: **${winner}** (delta A-B: ${delta})`
  ];
  fs.writeFileSync(path.join(outDir, "summary.md"), `${md.join("\n")}\n`, "utf8");
  console.log(`expression_ab_done winner=${winner} report=${path.relative(process.cwd(), reportJson).replace(/\\/g, "/")}`);
}

main();
