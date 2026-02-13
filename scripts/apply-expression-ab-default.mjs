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

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const summaryPath = path.resolve(String(args.summary || "outputs/eval_expression_ab_self/summary.json"));
  const configPath = path.resolve(String(args.config || "config/expression/defaults.json"));
  if (!fs.existsSync(summaryPath)) {
    throw new Error(`summary_not_found: ${summaryPath}`);
  }
  const summary = JSON.parse(fs.readFileSync(summaryPath, "utf8"));
  const winner = String(summary?.score?.winner || "tie");
  const selectedKey = winner === "A" ? "A" : winner === "B" ? "B" : "B";
  const cfg = summary?.configs?.[selectedKey];
  if (!cfg) {
    throw new Error(`winner_config_not_found: ${selectedKey}`);
  }
  const transitionDelta = toNum(summary?.metrics?.[selectedKey]?.avgOverrideTransitionDelta, 6);
  const changedIntent = toNum(summary?.metrics?.[selectedKey]?.avgChangedIntentSegments, 0.5);
  const limiterStrength = clamp(0.52 + transitionDelta / 28 + changedIntent / 12, 0.5, 0.82);

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
    source: "expression_ab",
    winner: selectedKey,
    style: String(cfg.style || "").trim() || "natural",
    profileFile: String(cfg.profileFile || "active"),
    humanizeIntensity: clamp(toNum(cfg.humanizeIntensity, 0.6), 0, 1),
    hybridProsody: Boolean(cfg.hybridProsody),
    prosodyLimiter: {
      enabled: true,
      strength: Number(limiterStrength.toFixed(3))
    }
  };

  const parent = path.dirname(configPath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(defaults, null, 2), "utf8");
  console.log(
    `expression_ab_applied winner=${selectedKey} style=${defaults.selectedRuntime.style} intensity=${defaults.selectedRuntime.humanizeIntensity} hybrid=${defaults.selectedRuntime.hybridProsody} limiter=${defaults.selectedRuntime.prosodyLimiter.strength}`
  );
}

main();
