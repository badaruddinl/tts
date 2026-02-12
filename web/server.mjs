import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import express from "express";
import dotenv from "dotenv";
import { cleanLine, parseText, synthesizeToMp3 } from "../lib/tts-core.mjs";

dotenv.config({ quiet: true });

const app = express();
const PORT = Number(process.env.WEB_PORT || 3030);
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const CACHE_DIR = path.resolve(process.cwd(), ".tts-cache");
const LOG_FILE = path.join(CACHE_DIR, "jobs.log");

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULTS = {
  voice: process.env.TTS_VOICE || "id-ID-GadisNeural",
  rate: process.env.TTS_RATE || "-8%",
  pitch: process.env.TTS_PITCH || "-2Hz",
  volume: process.env.TTS_VOLUME || "0%"
};

const jobs = new Map();
const MAX_JOBS = 100;
let voiceCache = null;
let voiceCacheAt = 0;
const VOICE_CACHE_MS = 5 * 60 * 1000;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve(process.cwd(), "web/public")));

function cleanupJobsIfNeeded() {
  if (jobs.size <= MAX_JOBS) return;
  const keys = [...jobs.keys()];
  const extra = keys.length - MAX_JOBS;
  for (let i = 0; i < extra; i += 1) {
    jobs.delete(keys[i]);
  }
}

function appendLog(jobId, level, message) {
  const line = `[${new Date().toISOString()}] [${level}] [job:${jobId}] ${message}`;
  console.log(line);
  fs.appendFileSync(LOG_FILE, `${line}\n`, "utf8");
}

function addEvent(job, level, message) {
  const evt = {
    at: new Date().toISOString(),
    level,
    message
  };
  job.events.push(evt);
  appendLog(job.id, level, message);
}

function sanitizeBaseName(name) {
  const safe = String(name || "tts_output")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 80);
  return safe || "tts_output";
}

function getNowId() {
  return `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
}

function getEdgeCliPath() {
  return path.resolve(
    process.cwd(),
    "node_modules",
    "@andresaya",
    "edge-tts",
    "dist",
    "cli",
    "edge-tts.js"
  );
}

function parseVoiceListOutput(text) {
  return String(text)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("- "))
    .map((line) => line.slice(2).trim())
    .filter(Boolean);
}

async function loadVoices() {
  const now = Date.now();
  if (voiceCache && now - voiceCacheAt < VOICE_CACHE_MS) {
    return voiceCache;
  }

  const cliPath = getEdgeCliPath();
  const args = [cliPath, "voice-list"];
  const output = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, { stdio: ["ignore", "pipe", "pipe"] });
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
      if (code !== 0) {
        reject(new Error(stderr || `voice-list exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });

  voiceCache = parseVoiceListOutput(output);
  voiceCacheAt = now;
  return voiceCache;
}

app.get("/api/config", (req, res) => {
  res.json({
    defaults: DEFAULTS
  });
});

app.get("/api/voices", async (req, res) => {
  try {
    const voices = await loadVoices();
    return res.json({ voices });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
});

app.post("/api/jobs", async (req, res) => {
  const rawText = String(req.body?.text || "");
  if (!rawText.trim()) {
    return res.status(400).json({ error: "Text is required." });
  }

  const parsed = parseText(rawText);
  let cleaned = parsed.text;
  if (!cleaned) {
    cleaned = rawText
      .split(/\r?\n/)
      .map(cleanLine)
      .filter(Boolean)
      .join("\n");
  }
  if (!cleaned) {
    return res.status(400).json({ error: "Text is empty after cleanup." });
  }

  const jobId = getNowId();
  const voice = String(req.body?.voice || parsed.meta.VOICE || DEFAULTS.voice);
  const rate = String(req.body?.rate || parsed.meta.RATE || DEFAULTS.rate);
  const pitch = String(req.body?.pitch || parsed.meta.PITCH || DEFAULTS.pitch);
  const volume = String(req.body?.volume || parsed.meta.VOLUME || DEFAULTS.volume);

  const requestedName = req.body?.outputName || parsed.meta.OUTPUT || jobId;
  const baseName = sanitizeBaseName(requestedName);
  const outputWithoutExt = path.join(OUTPUT_DIR, `${baseName}_${jobId}`);

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    voice,
    rate,
    pitch,
    volume,
    outputFile: `${outputWithoutExt}.mp3`,
    error: null,
    events: []
  });
  addEvent(
    jobs.get(jobId),
    "info",
    `queued with voice=${voice}, rate=${rate}, pitch=${pitch}, volume=${volume}`
  );
  cleanupJobsIfNeeded();

  (async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    addEvent(job, "info", "synthesis started");

    try {
      await synthesizeToMp3({
        text: cleaned,
        output: outputWithoutExt,
        voice,
        rate,
        pitch,
        volume,
        cacheDir: CACHE_DIR
      });
      job.status = "completed";
      job.updatedAt = new Date().toISOString();
      addEvent(job, "info", `completed, file=${path.basename(job.outputFile)}`);
    } catch (err) {
      job.status = "failed";
      job.updatedAt = new Date().toISOString();
      job.error = err.message || String(err);
      addEvent(job, "error", job.error);
    }
  })();

  return res.status(202).json({ jobId, status: "queued" });
});

app.get("/api/jobs/:jobId", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  return res.json({
    id: job.id,
    status: job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    error: job.error,
    downloadUrl: job.status === "completed" ? `/api/jobs/${job.id}/audio` : null,
    events: job.events
  });
});

app.get("/api/jobs/:jobId/audio", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (job.status !== "completed") {
    return res.status(409).json({ error: "Job not completed yet." });
  }
  if (!fs.existsSync(job.outputFile)) {
    return res.status(404).json({ error: "Output file not found." });
  }

  return res.download(job.outputFile, path.basename(job.outputFile));
});

app.listen(PORT, () => {
  console.log(`TTS web running at http://localhost:${PORT}`);
});
