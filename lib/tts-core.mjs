import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";

const require = createRequire(import.meta.url);

const META_KEYS = new Set(["TITLE", "VOICE", "RATE", "PITCH", "VOLUME", "OUTPUT"]);

export function cleanLine(line) {
  let out = line.trim();
  if (!out) return "";
  if (/^[-*_]{3,}$/.test(out)) return "";
  if (/^\(.*\)$/.test(out)) return "";

  out = out.replace(/^#{1,6}\s+/, "");
  out = out.replace(/\*\*(.*?)\*\*/g, "$1");
  out = out.replace(/\*(.*?)\*/g, "$1");
  out = out.replace(/\[PAUSE_SHORT\]/gi, " ... ");
  out = out.replace(/\[PAUSE_MEDIUM\]/gi, " .... ");
  out = out.replace(/\[PAUSE_LONG\]/gi, " ..... ");
  out = out.replace(/\[SCENE:[^\]]+\]/gi, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function parseText(rawText) {
  const lines = rawText.replace(/^\uFEFF/, "").split(/\r?\n/);
  const meta = {};
  const bodyLines = [];
  let bodyStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (!bodyStarted && match && META_KEYS.has(match[1])) {
      meta[match[1]] = match[2].trim();
      continue;
    }
    if (!bodyStarted && trimmed === "---") {
      bodyStarted = true;
      continue;
    }
    if (trimmed) bodyStarted = true;
    bodyLines.push(line);
  }

  const cleaned = bodyLines.map(cleanLine).filter(Boolean).join("\n");
  return { meta, text: cleaned };
}

export function parseInputFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseText(raw);
}

function getEdgeCliPath() {
  const pkgPath = require.resolve("@andresaya/edge-tts/package.json");
  return path.resolve(path.dirname(pkgPath), "dist", "cli", "edge-tts.js");
}

function normalizeOutput(outputName) {
  return String(outputName || "output.mp3").replace(/\.mp3$/i, "");
}

export async function synthesizeToMp3({
  text,
  output,
  voice,
  rate,
  pitch,
  volume,
  cacheDir
}) {
  if (!text || !text.trim()) {
    throw new Error("Input text is empty after cleanup.");
  }

  const workCacheDir = path.resolve(cacheDir || path.join(process.cwd(), ".tts-cache"));
  if (!fs.existsSync(workCacheDir)) fs.mkdirSync(workCacheDir, { recursive: true });

  const taskId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const tempInputPath = path.join(workCacheDir, `input.${taskId}.txt`);
  fs.writeFileSync(tempInputPath, text, "utf8");

  const cliPath = getEdgeCliPath();
  const normalizedOutput = normalizeOutput(output);
  const cmdArgs = [
    cliPath,
    "synthesize",
    "--file",
    tempInputPath,
    "--voice",
    String(voice),
    `--rate=${String(rate)}`,
    `--pitch=${String(pitch)}`,
    `--volume=${String(volume)}`,
    "--output",
    normalizedOutput
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cmdArgs, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `edge-tts exited with code ${code}`));
    });
  });

  return path.resolve(`${normalizedOutput}.mp3`);
}
