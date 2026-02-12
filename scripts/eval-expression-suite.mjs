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

function runEval({ inputPath, outputPath, style }) {
  const args = [
    "scripts/eval-auto-expression.mjs",
    "--input",
    inputPath,
    "--output",
    outputPath
  ];
  if (style) args.push("--style", style);

  const res = spawnSync(process.execPath, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8"
  });
  if (res.status !== 0) {
    throw new Error(`eval_failed file=${inputPath}\n${res.stderr || res.stdout}`);
  }
}

function safeAvg(items) {
  if (!items.length) return 0;
  return items.reduce((s, n) => s + n, 0) / items.length;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(String(args.dir || "tests/expressions"));
  const reportDir = path.resolve(String(args.outdir || "outputs/eval_suite"));
  const style = String(args.style || "tegang").trim();
  const maxAutoDelta = Number(args["max-auto-delta"] ?? 9.8);
  const maxOverrideDelta = Number(args["max-override-delta"] ?? 10.2);
  const minAvgOverrideSegments = Number(args["min-avg-override-segments"] ?? 0.8);
  const maxAvgChangedSegments = Number(args["max-avg-changed-segments"] ?? 1.6);

  if (!fs.existsSync(testsDir)) {
    throw new Error(`Tests directory not found: ${testsDir}`);
  }
  if (!fs.existsSync(reportDir)) fs.mkdirSync(reportDir, { recursive: true });

  const files = fs
    .readdirSync(testsDir, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".txt"))
    .map((d) => d.name)
    .sort();

  if (!files.length) {
    throw new Error(`No .txt test files found in ${testsDir}`);
  }

  const rows = [];
  for (const file of files) {
    const inputPath = path.join(testsDir, file);
    const outPath = path.join(reportDir, `${file.replace(/\.txt$/i, "")}.json`);
    runEval({ inputPath, outputPath: outPath, style });
    const report = JSON.parse(fs.readFileSync(outPath, "utf8"));
    rows.push({
      file,
      segments: Number(report?.segments || 0),
      changedIntentSegments: Number(report?.metrics?.changedIntentSegments || 0),
      overrideIntentSegments: Number(report?.metrics?.overrideIntentSegments || 0),
      autoTransitionDelta: Number(report?.metrics?.autoTransitionDelta || 0),
      overrideTransitionDelta: Number(report?.metrics?.overrideTransitionDelta || 0)
    });
  }

  const summary = {
    at: new Date().toISOString(),
    dir: path.relative(process.cwd(), testsDir),
    style,
    caseCount: rows.length,
    metrics: {
      avgSegments: Number(safeAvg(rows.map((r) => r.segments)).toFixed(3)),
      avgChangedIntentSegments: Number(safeAvg(rows.map((r) => r.changedIntentSegments)).toFixed(3)),
      avgOverrideIntentSegments: Number(safeAvg(rows.map((r) => r.overrideIntentSegments)).toFixed(3)),
      avgAutoTransitionDelta: Number(safeAvg(rows.map((r) => r.autoTransitionDelta)).toFixed(3)),
      avgOverrideTransitionDelta: Number(safeAvg(rows.map((r) => r.overrideTransitionDelta)).toFixed(3))
    }
  };

  const gateChecks = {
    autoTransitionOk: summary.metrics.avgAutoTransitionDelta <= maxAutoDelta,
    overrideTransitionOk: summary.metrics.avgOverrideTransitionDelta <= maxOverrideDelta,
    overrideCoverageOk: summary.metrics.avgOverrideIntentSegments >= minAvgOverrideSegments,
    changedIntentOk: summary.metrics.avgChangedIntentSegments <= maxAvgChangedSegments
  };
  const passed = Object.values(gateChecks).every(Boolean);
  summary.gate = {
    status: passed ? "pass" : "fail",
    thresholds: {
      maxAutoDelta,
      maxOverrideDelta,
      minAvgOverrideSegments,
      maxAvgChangedSegments
    },
    checks: gateChecks
  };
  summary.cases = rows.map((row) => ({
    ...row,
    gate: {
      autoDeltaOk: row.autoTransitionDelta <= maxAutoDelta,
      overrideDeltaOk: row.overrideTransitionDelta <= maxOverrideDelta,
      overrideCoverageOk: row.overrideIntentSegments >= 1
    }
  }));

  const summaryJsonPath = path.join(reportDir, "summary.json");
  fs.writeFileSync(summaryJsonPath, JSON.stringify(summary, null, 2), "utf8");

  const mdLines = [
    "# Expression Eval Suite Summary",
    "",
    `- Generated at: ${summary.at}`,
    `- Test dir: \`${summary.dir}\``,
    `- Style: \`${summary.style}\``,
    `- Cases: ${summary.caseCount}`,
    "",
    "## Aggregate Metrics",
    "",
    `- avgSegments: ${summary.metrics.avgSegments}`,
    `- avgChangedIntentSegments: ${summary.metrics.avgChangedIntentSegments}`,
    `- avgOverrideIntentSegments: ${summary.metrics.avgOverrideIntentSegments}`,
    `- avgAutoTransitionDelta: ${summary.metrics.avgAutoTransitionDelta}`,
    `- avgOverrideTransitionDelta: ${summary.metrics.avgOverrideTransitionDelta}`,
    "",
    "## Quality Gate",
    "",
    `- status: **${summary.gate.status.toUpperCase()}**`,
    `- autoTransitionOk: ${summary.gate.checks.autoTransitionOk}`,
    `- overrideTransitionOk: ${summary.gate.checks.overrideTransitionOk}`,
    `- overrideCoverageOk: ${summary.gate.checks.overrideCoverageOk}`,
    `- changedIntentOk: ${summary.gate.checks.changedIntentOk}`,
    "",
    "## Cases",
    "",
    "| file | segments | changedIntent | overrideIntent | autoDelta | overrideDelta | gate |",
    "|---|---:|---:|---:|---:|---:|---|"
  ];
  for (const row of summary.cases) {
    const rowPass = row.gate.autoDeltaOk && row.gate.overrideDeltaOk && row.gate.overrideCoverageOk;
    mdLines.push(
      `| ${row.file} | ${row.segments} | ${row.changedIntentSegments} | ${row.overrideIntentSegments} | ${row.autoTransitionDelta} | ${row.overrideTransitionDelta} | ${rowPass ? "pass" : "fail"} |`
    );
  }
  const summaryMdPath = path.join(reportDir, "summary.md");
  fs.writeFileSync(summaryMdPath, `${mdLines.join("\n")}\n`, "utf8");

  console.log(
    `eval_suite_done cases=${rows.length} gate=${summary.gate.status} summary_json=${path.relative(process.cwd(), summaryJsonPath)} summary_md=${path.relative(process.cwd(), summaryMdPath)}`
  );

  if (!passed) {
    process.exitCode = 2;
  }
}

main();
