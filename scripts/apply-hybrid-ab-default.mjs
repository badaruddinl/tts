import fs from "fs";
import path from "path";

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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = path.resolve(String(args.summary || "outputs/eval_hybrid_ab_self/summary.json"));
  const configPath = path.resolve(String(args.config || "config/expression/defaults.json"));
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary_not_found: ${summaryPath}`);
  }

  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const winner = String(summary?.score?.winner || "tie");
  const selectedHybrid = winner === "hybrid_on" || winner === "tie";
  const scoreDelta = toNum(summary?.score?.deltaOffMinusOn, 0);
  const metrics = selectedHybrid ? summary?.metrics?.hybridOn : summary?.metrics?.hybridOff;
  const transitionDelta = toNum(metrics?.avgOverrideTransitionDelta, 6);
  const changedIntent = toNum(metrics?.avgChangedIntentSegments, 0.5);
  const limiterStrength = clamp(0.5 + transitionDelta / 28 + changedIntent / 12 + scoreDelta / 45, 0.5, 0.82);

  let defaults = {};
  if (fs.existsSync(configPath)) {
    try {
      defaults = JSON.parse(fs.readFileSync(configPath, "utf8"));
    } catch {
      defaults = {};
    }
  }

  defaults.updatedAt = new Date().toISOString();
  defaults.selectedRuntime = {
    ...(defaults.selectedRuntime || {}),
    source: "hybrid_ab",
    hybridProsody: selectedHybrid,
    prosodyLimiter: {
      enabled: true,
      strength: Number(limiterStrength.toFixed(3))
    }
  };

  const parent = path.dirname(configPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf8");
  console.log(
    `hybrid_ab_applied winner=${winner} hybrid=${selectedHybrid} limiter=${defaults.selectedRuntime.prosodyLimiter.strength}`
  );
}

main();
