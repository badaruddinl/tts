import { spawn } from "child_process";
import readline from "readline";

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

  child.stderr.on("data", () => {});

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
    if (msg?.id && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      p.resolve(msg);
    }
  });

  child.on("error", (err) => readyReject(err));
  child.on("exit", (code) => {
    for (const [, p] of pending) p.reject(new Error(`service_exited code=${code}`));
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = String(args.mode || "js").toLowerCase();
  const runs = Math.max(1, Number(args.runs ?? 5));
  const feedbackFile = String(args["feedback-file"] || "data/training/splits/ml/train.ndjson");
  const outDir = String(args.outdir || "models/bench_seq");
  const pyCmd = String(args["py-cmd"] || "python");

  let cmd = "node";
  let cmdArgs = ["scripts/train-ml-policy-service.mjs"];
  let prefix = "js_service";
  if (mode === "py") {
    cmd = pyCmd;
    cmdArgs = ["-u", "scripts_py/train_ml_policy_service.py"];
    prefix = "py_service";
  }

  const svc = startService(cmd, cmdArgs);
  await svc.ready;
  const times = [];
  for (let i = 1; i <= runs; i += 1) {
    const t0 = process.hrtime.bigint();
    const msg = await svc.send({
      action: "train",
      feedbackFile,
      outputModel: `${outDir}/${prefix}_${i}.json`,
      useCache: true
    });
    if (msg?.type === "error") {
      await svc.shutdown();
      throw new Error(msg.error || `${mode}_service_error`);
    }
    const dt = Number(process.hrtime.bigint() - t0) / 1e6;
    times.push(dt);
  }
  await svc.shutdown();

  const avg = times.reduce((s, n) => s + n, 0) / Math.max(1, times.length);
  const min = Math.min(...times);
  const max = Math.max(...times);
  process.stdout.write(
    JSON.stringify({
      avgMs: Number(avg.toFixed(3)),
      minMs: Number(min.toFixed(3)),
      maxMs: Number(max.toFixed(3))
    })
  );
}

main().catch((err) => {
  console.error(err?.message || String(err));
  process.exit(1);
});
