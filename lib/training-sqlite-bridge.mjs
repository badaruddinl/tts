import fs from "fs";
import path from "path";
import { spawn } from "child_process";

const DEFAULT_DB = path.resolve(process.cwd(), "data", "training", "training.db");

function toBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const v = String(value).trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(v)) return true;
  if (["0", "false", "no", "n", "off"].includes(v)) return false;
  return fallback;
}

function runPython(args) {
  return new Promise((resolve, reject) => {
    const child = spawn("python", args, { stdio: ["ignore", "pipe", "pipe"], shell: false });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve(stdout.trim());
        return;
      }
      reject(new Error(stderr.trim() || stdout.trim() || `python exited with code ${code}`));
    });
  });
}

export function sqliteTrainingEnabled() {
  return toBool(process.env.TTS_SQLITE_TRAINING, true);
}

export async function appendTrainingSqlite({
  kind,
  payload,
  scope = "global",
  styleKey = "",
  sourceFile = "",
  dbFile = DEFAULT_DB
}) {
  if (!sqliteTrainingEnabled()) return { skipped: true, reason: "disabled" };
  const tmpDir = path.resolve(process.cwd(), ".tmp", "sqlite-append");
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, `payload_${Date.now()}_${Math.floor(Math.random() * 100000)}.json`);

  fs.writeFileSync(tmpFile, JSON.stringify(payload), "utf8");
  try {
    const out = await runPython([
      "scripts_py/training_db_append.py",
      "--kind",
      String(kind),
      "--payload-file",
      tmpFile,
      "--db-file",
      path.resolve(String(dbFile)),
      "--scope",
      String(scope),
      "--style-key",
      String(styleKey || ""),
      "--source-file",
      String(sourceFile || "")
    ]);
    return { ok: true, out };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // ignore cleanup errors
    }
  }
}

export async function safeAppendTrainingSqlite(opts) {
  try {
    return await appendTrainingSqlite(opts);
  } catch (err) {
    return { ok: false, error: err.message || String(err) };
  }
}

