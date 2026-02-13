import { spawnSync } from "child_process";

function parseArgs(argv) {
  const out = {
    passthrough: [],
    trainer: "py",
    stopOnError: false,
    sleepMs: 2000,
    maxRuns: 0
  };
  const localOnly = new Set(["trainer", "stop-on-error", "sleep-ms", "max-runs"]);
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      out.passthrough.push(item);
      continue;
    }
    const key = item.slice(2);
    const next = argv[i + 1];
    const hasValue = Boolean(next) && !next.startsWith("--");
    if (!localOnly.has(key)) {
      out.passthrough.push(item);
      if (hasValue) {
        out.passthrough.push(next);
        i += 1;
      }
      continue;
    }

    if (key === "trainer") {
      if (hasValue) {
        out.trainer = String(next);
        i += 1;
      } else {
        out.trainer = "py";
      }
      continue;
    }
    if (key === "stop-on-error") {
      out.stopOnError = hasValue ? String(next).toLowerCase() === "true" : true;
      if (hasValue) i += 1;
      continue;
    }
    if (key === "sleep-ms") {
      const raw = hasValue ? Number(next) : 2000;
      if (hasValue) i += 1;
      out.sleepMs = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 2000;
      continue;
    }
    if (key === "max-runs") {
      const raw = hasValue ? Number(next) : 0;
      if (hasValue) i += 1;
      out.maxRuns = Number.isFinite(raw) ? Math.max(0, Math.floor(raw)) : 0;
    }
  }
  return out;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const trainer = String(args.trainer || "py").toLowerCase().trim();
  const stopOnError = Boolean(args.stopOnError);
  const sleepMs = Number.isFinite(args.sleepMs) ? Math.max(0, Math.floor(args.sleepMs)) : 2000;
  const maxRuns = Number.isFinite(args.maxRuns) ? Math.max(0, Math.floor(args.maxRuns)) : 0;
  const passthrough = Array.isArray(args.passthrough) ? args.passthrough : [];

  let stopping = false;
  process.on("SIGINT", () => {
    stopping = true;
    console.log("\nloop: stop requested (Ctrl+C), waiting current run to finish...");
  });
  process.on("SIGTERM", () => {
    stopping = true;
  });

  let round = 0;
  while (!stopping) {
    if (maxRuns > 0 && round >= maxRuns) break;
    round += 1;
    console.log(`loop: run #${round} (trainer=${trainer})`);
    const cmdArgs = ["scripts/self-train.mjs", "--trainer", trainer, ...passthrough];
    const res = spawnSync(process.execPath, cmdArgs, {
      cwd: process.cwd(),
      stdio: "inherit",
      shell: false
    });
    const code = Number(res.status ?? 1);
    if (code !== 0 && stopOnError) {
      process.exit(code);
    }
    if (stopping) break;
    if (sleepMs > 0) {
      await sleep(sleepMs);
    }
  }
  console.log("loop: stopped");
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
