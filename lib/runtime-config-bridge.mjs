import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const DEFAULT_DB = path.resolve(process.cwd(), "data", "training", "training.db");

function resolveDbPath() {
  const v = String(process.env.TTS_TRAINING_DB || "").trim();
  return path.resolve(v || DEFAULT_DB);
}

function resolveConfigSource() {
  const mode = String(process.env.TTS_CONFIG_SOURCE || "auto").trim().toLowerCase();
  if (["sqlite", "file", "auto"].includes(mode)) return mode;
  return "auto";
}

function shouldUseSqliteConfig() {
  const mode = resolveConfigSource();
  const db = resolveDbPath();
  if (mode === "file") return false;
  if (mode === "sqlite") return fs.existsSync(db);
  return fs.existsSync(db);
}

function runConfigQuery(args) {
  const dbPath = resolveDbPath();
  const cmdArgs = ["scripts_py/runtime_config_db.py", ...args, "--db-file", dbPath];
  const res = spawnSync("python", cmdArgs, {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
    shell: false
  });
  if (Number(res.status) !== 0) return null;
  try {
    const parsed = JSON.parse(String(res.stdout || "{}"));
    return parsed;
  } catch {
    return null;
  }
}

export function loadJsonFromSqlite(relPath) {
  if (!shouldUseSqliteConfig()) return null;
  const out = runConfigQuery(["--action", "get-json", "--path", String(relPath || "")]);
  if (!out || !out.ok) return null;
  return out.json ?? null;
}

export function getActiveProfileFromSqlite() {
  if (!shouldUseSqliteConfig()) return null;
  const out = runConfigQuery(["--action", "get-active-profile"]);
  if (!out || !out.ok) return null;
  const v = String(out.activeProfile || "").trim();
  return v || null;
}

export function setActiveProfileInSqlite(fileName) {
  if (!shouldUseSqliteConfig()) return false;
  const out = runConfigQuery(["--action", "set-active-profile", "--value", String(fileName || "")]);
  return Boolean(out?.ok);
}

export function listProfilesFromSqlite() {
  if (!shouldUseSqliteConfig()) return null;
  const out = runConfigQuery(["--action", "list-profiles"]);
  if (!out || !out.ok || !Array.isArray(out.profiles)) return null;
  return out.profiles;
}

export function sqliteConfigEnabled() {
  return shouldUseSqliteConfig();
}
