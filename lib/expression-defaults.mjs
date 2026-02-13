import fs from "fs";
import path from "path";

const DEFAULT_PATH = path.resolve(process.cwd(), "config", "expression", "defaults.json");

export function loadExpressionDefaults() {
  if (!fs.existsSync(DEFAULT_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DEFAULT_PATH, "utf8"));
  } catch {
    return null;
  }
}

export function getExpressionDefaultStyle(fallback = "natural") {
  const cfg = loadExpressionDefaults();
  const style = String(cfg?.selectedRuntime?.style || cfg?.selected?.style || "").trim();
  return style || fallback;
}

export function getExpressionRuntimeDefaults() {
  const cfg = loadExpressionDefaults();
  const rt = cfg?.selectedRuntime || {};
  const intensityRaw = Number(rt.humanizeIntensity);
  const humanizeIntensity = Number.isFinite(intensityRaw) ? Math.max(0, Math.min(1, intensityRaw)) : null;
  return {
    style: String(rt.style || "").trim() || null,
    humanizeIntensity,
    hybridProsody: typeof rt.hybridProsody === "boolean" ? rt.hybridProsody : null,
    prosodyLimiter: {
      enabled:
        typeof rt?.prosodyLimiter?.enabled === "boolean" ? rt.prosodyLimiter.enabled : null,
      strength: Number.isFinite(Number(rt?.prosodyLimiter?.strength))
        ? Math.max(0.3, Math.min(1, Number(rt.prosodyLimiter.strength)))
        : null
    }
  };
}

export const EXPRESSION_DEFAULTS_PATH = DEFAULT_PATH;
