import fs from "fs";
import path from "path";
import readline from "readline";
import { spawn, spawnSync } from "child_process";

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

function detectPythonCmd() {
  const picks = ["python", "py"];
  for (const cmd of picks) {
    const res = spawnSync(cmd, ["--version"], { cwd: process.cwd(), stdio: "pipe", shell: false });
    if (Number(res.status) === 0) return cmd;
  }
  return null;
}

function summarizeMs(items) {
  if (!items.length) return { avgMs: 0, minMs: 0, maxMs: 0 };
  const sum = items.reduce((s, n) => s + n, 0);
  return {
    avgMs: Number((sum / items.length).toFixed(3)),
    minMs: Number(Math.min(...items).toFixed(3)),
    maxMs: Number(Math.max(...items).toFixed(3))
  };
}

function runSpawn(cmd, args) {
  const t0 = process.hrtime.bigint();
  const res = spawnSync(cmd, args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8",
    shell: false
  });
  const elapsedMs = Number(process.hrtime.bigint() - t0) / 1e6;
  if (Number(res.status) !== 0) {
    throw new Error((res.stderr || res.stdout || "").trim() || `spawn_failed cmd=${cmd}`);
  }
  return { elapsedMs, stdout: String(res.stdout || "") };
}

function startService(cmd, args) {
  const child = spawn(cmd, args, {
    cwd: process.cwd(),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map();
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });

  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "").trim();
    if (text) {
      // ignore noisy stderr; keep for debug if needed
    }
  });

  rl.on("line", (line) => {
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (msg?.type === "ready") {
      readyResolve(msg);
      return;
    }
    const id = msg?.id;
    if (id && pending.has(id)) {
      const p = pending.get(id);
      pending.delete(id);
      p.resolve(msg);
    }
  });

  child.on("error", (err) => {
    readyReject(err);
  });
  child.on("exit", (code) => {
    for (const [, p] of pending) {
      p.reject(new Error(`service_exited code=${code}`));
    }
    pending.clear();
  });

  let seq = 0;
  function send(msg) {
    const id = `r${++seq}`;
    const payload = { id, ...msg };
    const out = new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
    });
    child.stdin.write(`${JSON.stringify(payload)}\n`);
    return out;
  }

  async function shutdown() {
    child.stdin.write(`${JSON.stringify({ action: "shutdown" })}\n`);
    child.stdin.end();
  }

  return { ready, send, shutdown };
}

function makeModelPath(outDir, mode, i) {
  return path.resolve(outDir, `${mode}_run_${i}.json`);
}

function writeReport(reportFile, payload) {
  ensureDir(path.dirname(reportFile));
  fs.writeFileSync(reportFile, JSON.stringify(payload, null, 2), "utf8");
  const md = [
    "# Trainer Benchmark",
    "",
    `- generatedAt: ${payload.generatedAt}`,
    `- runs: ${payload.runs}`,
    `- feedbackFile: \`${payload.feedbackFile}\``,
    "",
    "| mode | avgMs | minMs | maxMs |",
    "|---|---:|---:|---:|"
  ];
  for (const row of payload.results) {
    md.push(`| ${row.mode} | ${row.avgMs} | ${row.minMs} | ${row.maxMs} |`);
  }
  fs.writeFileSync(reportFile.replace(/\.json$/i, ".md"), `${md.join("\n")}\n`, "utf8");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runs = Math.max(2, Number(args.runs ?? 5));
  const feedbackFile = path.resolve(String(args["feedback-file"] || "data/training/splits/ml/train.ndjson"));
  const outDir = path.resolve(String(args.outdir || "outputs/bench_trainers"));
  const reportFile = path.resolve(String(args.report || path.join(outDir, "report.json")));
  ensureDir(outDir);

  const pyCmd = detectPythonCmd();
  if (!pyCmd) throw new Error("python_not_found");

  const modeTimes = {
    js_spawn: [],
    py_spawn: [],
    js_service: [],
    py_service: []
  };

  for (let i = 1; i <= runs; i += 1) {
    const r = runSpawn("node", [
      "scripts/train-ml-policy.mjs",
      "--feedback-file",
      feedbackFile,
      "--output-model",
      makeModelPath(outDir, "js_spawn", i)
    ]);
    modeTimes.js_spawn.push(r.elapsedMs);
  }

  for (let i = 1; i <= runs; i += 1) {
    const r = runSpawn(pyCmd, [
      "scripts_py/train_ml_policy.py",
      "--feedback-file",
      feedbackFile,
      "--output-model",
      makeModelPath(outDir, "py_spawn", i)
    ]);
    modeTimes.py_spawn.push(r.elapsedMs);
  }

  const jsService = startService("node", ["scripts/train-ml-policy-service.mjs"]);
  await jsService.ready;
  for (let i = 1; i <= runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const msg = await jsService.send({
      action: "train",
      feedbackFile,
      outputModel: makeModelPath(outDir, "js_service", i),
      useCache: true
    });
    if (msg?.type === "error") throw new Error(msg.error || "js_service_error");
    modeTimes.js_service.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  await jsService.shutdown();

  const pyService = startService(pyCmd, ["scripts_py/train_ml_policy_service.py"]);
  await pyService.ready;
  for (let i = 1; i <= runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const msg = await pyService.send({
      action: "train",
      feedbackFile,
      outputModel: makeModelPath(outDir, "py_service", i),
      useCache: true
    });
    if (msg?.type === "error") throw new Error(msg.error || "py_service_error");
    modeTimes.py_service.push(Number(process.hrtime.bigint() - t0) / 1e6);
  }
  await pyService.shutdown();

  const resultRows = Object.entries(modeTimes).map(([mode, items]) => ({
    mode,
    ...summarizeMs(items)
  }));
  const payload = {
    generatedAt: new Date().toISOString(),
    runs,
    feedbackFile: path.relative(process.cwd(), feedbackFile).replace(/\\/g, "/"),
    results: resultRows
  };
  writeReport(reportFile, payload);
  console.log(`benchmark_done report=${path.relative(process.cwd(), reportFile).replace(/\\/g, "/")}`);
  for (const row of resultRows) {
    console.log(
      `mode=${row.mode} avgMs=${row.avgMs.toFixed(3)} minMs=${row.minMs.toFixed(3)} maxMs=${row.maxMs.toFixed(3)}`
    );
  }
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
