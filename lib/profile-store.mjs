import fs from "fs";
import path from "path";
import {
  getActiveProfileFromSqlite,
  listProfilesFromSqlite,
  loadJsonFromSqlite,
  setActiveProfileInSqlite,
  sqliteConfigEnabled
} from "./runtime-config-bridge.mjs";

const PROFILE_DIR = path.resolve(process.cwd(), "config", "profiles");
const ACTIVE_FILE = path.join(PROFILE_DIR, "active.json");

function ensureProfileDir() {
  if (!fs.existsSync(PROFILE_DIR)) fs.mkdirSync(PROFILE_DIR, { recursive: true });
}

export function listProfileFiles() {
  if (sqliteConfigEnabled()) {
    const fromDb = listProfilesFromSqlite();
    if (Array.isArray(fromDb) && fromDb.length) return fromDb.sort();
  }
  ensureProfileDir();
  return fs
    .readdirSync(PROFILE_DIR)
    .filter((name) => name.endsWith(".json") && name !== "active.json")
    .sort();
}

export function readProfileFile(fileName) {
  if (sqliteConfigEnabled()) {
    const fromDb = loadJsonFromSqlite(`config/profiles/${String(fileName)}`);
    if (fromDb && typeof fromDb === "object") return fromDb;
  }
  const target = path.join(PROFILE_DIR, fileName);
  const raw = fs.readFileSync(target, "utf8");
  return JSON.parse(raw);
}

export function getActiveProfileFile() {
  if (sqliteConfigEnabled()) {
    const activeFromDb = getActiveProfileFromSqlite();
    const fromDbList = listProfilesFromSqlite();
    if (Array.isArray(fromDbList) && fromDbList.length) {
      if (activeFromDb && fromDbList.includes(activeFromDb)) return activeFromDb;
      const sorted = [...fromDbList].sort();
      return sorted[sorted.length - 1];
    }
  }
  ensureProfileDir();
  if (!fs.existsSync(ACTIVE_FILE)) {
    fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ activeProfile: "v1.json" }, null, 2), "utf8");
  }
  const raw = fs.readFileSync(ACTIVE_FILE, "utf8");
  const data = JSON.parse(raw);
  return data.activeProfile || "v1.json";
}

export function setActiveProfileFile(fileName) {
  ensureProfileDir();
  fs.writeFileSync(ACTIVE_FILE, JSON.stringify({ activeProfile: fileName }, null, 2), "utf8");
  if (sqliteConfigEnabled()) {
    void setActiveProfileInSqlite(fileName);
  }
}

export function loadActiveProfile() {
  const file = getActiveProfileFile();
  return {
    file,
    profile: readProfileFile(file)
  };
}

export function getStyleNames(profile) {
  return Object.keys(profile?.styles || {});
}

export function ensureTrainingDirs() {
  const dir = path.resolve(process.cwd(), "data", "training");
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function appendNdjson(filePath, payload) {
  fs.appendFileSync(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

export function sanitizeStyleKey(style) {
  const s = String(style || "general")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
  return s || "general";
}

export function ensureStyleTrainingDir(style) {
  const root = ensureTrainingDirs();
  const key = sanitizeStyleKey(style);
  const dir = path.resolve(root, "styles", key);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return { dir, key };
}

export function getStyleTrainingFile(style, kind) {
  const { dir, key } = ensureStyleTrainingDir(style);
  const fileName = kind === "jobs" ? "jobs.ndjson" : "feedback.ndjson";
  return {
    styleKey: key,
    filePath: path.resolve(dir, fileName)
  };
}
