import { spawnSync } from "child_process";

function parseArgs(argv) {
  const out = { passthrough: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const item = argv[i];
    if (!item.startsWith("--")) {
      out.passthrough.push(item);
      continue;
    }
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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const trainer = String(args.trainer || "py").toLowerCase().trim();
  const stopOnError = String(args["stop-on-error"] ?? "false").toLowerCase() === "true";
  const sleepMsRaw = Number(args["sleep-ms"] ?? 2000);
  const sleepMs = Number.isFinite(sleepMsRaw) ? Math.max(0, Math.floor(sleepMsRaw)) : 2000;
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
