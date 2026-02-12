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
  const style = String(cfg?.selected?.style || "").trim();
  return style || fallback;
}

export const EXPRESSION_DEFAULTS_PATH = DEFAULT_PATH;
