import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import express from "express";
import dotenv from "dotenv";
import {
  cleanLine,
  parseText,
  synthesizeToMp3,
  synthesizeHumanizedToMp3
} from "../lib/tts-core.mjs";
import {
  loadActiveProfile,
  getStyleNames,
  ensureTrainingDirs,
  appendNdjson,
  getStyleTrainingFile,
  listProfileFiles,
  readProfileFile
} from "../lib/profile-store.mjs";
import { trainProfileFromFeedback } from "../lib/profile-trainer.mjs";
import { getExpressionDefaultStyle } from "../lib/expression-defaults.mjs";

dotenv.config({ quiet: true });

const app = express();
const PORT = Number(process.env.WEB_PORT || 3030);
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const CACHE_DIR = path.resolve(process.cwd(), ".tts-cache");
const LOG_FILE = path.join(CACHE_DIR, "jobs.log");
const TRAINING_DIR = ensureTrainingDirs();
const TRAINING_FEEDBACK_FILE = path.join(TRAINING_DIR, "feedback.ndjson");
const TRAINING_JOBS_FILE = path.join(TRAINING_DIR, "jobs.ndjson");
const TRAINING_BENCHMARK_FILE = path.resolve(process.cwd(), "config", "training", "benchmark.txt");
const AUTO_TRAIN = String(process.env.TTS_AUTO_TRAIN || "true").toLowerCase() === "true";
const AUTO_TRAIN_MIN_FEEDBACK = Number(process.env.TTS_AUTO_TRAIN_MIN_FEEDBACK || "2");
const USE_ML_POLICY = String(process.env.TTS_ML_POLICY || "true").toLowerCase() === "true";

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULTS = {
  voice: process.env.TTS_VOICE || "id-ID-GadisNeural",
  rate: process.env.TTS_RATE || "-8%",
  pitch: process.env.TTS_PITCH || "-2Hz",
  volume: process.env.TTS_VOLUME || "0%",
  humanize: String(process.env.TTS_HUMANIZE || "false").toLowerCase() === "true",
  humanizeIntensity: Number(process.env.TTS_HUMANIZE_INTENSITY || "0.45"),
  style: process.env.TTS_STYLE || getExpressionDefaultStyle("natural"),
  speechStyle: process.env.TTS_SPEECH_STYLE || "auto",
  voiceCharacter: String(process.env.TTS_VOICE_CHARACTER || "true").toLowerCase() === "true",
  voiceTone: process.env.TTS_VOICE_TONE || "auto"
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

function parseBool(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  const s = String(value).toLowerCase().trim();
  if (["1", "true", "yes", "on"].includes(s)) return true;
  if (["0", "false", "no", "off"].includes(s)) return false;
  return fallback;
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
  const active = loadActiveProfile();
  res.json({
    defaults: {
      ...DEFAULTS,
      style: DEFAULTS.style || active.profile.defaultStyle
    },
    activeProfile: active.file
  });
});

app.get("/api/styles", (req, res) => {
  const profileFile = String(req.query?.profile || "").trim();
  const active = loadActiveProfile();
  let profilePack = active;
  if (profileFile) {
    try {
      profilePack = { file: profileFile, profile: readProfileFile(profileFile) };
    } catch {
      return res.status(404).json({ error: "Profile not found." });
    }
  }
  return res.json({
    activeProfile: active.file,
    selectedProfile: profilePack.file,
    defaultStyle: profilePack.profile.defaultStyle,
    styles: getStyleNames(profilePack.profile)
  });
});

app.get("/api/profiles", (req, res) => {
  const active = loadActiveProfile();
  return res.json({
    activeProfile: active.file,
    profiles: listProfileFiles()
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

function enqueueJob({
  rawText,
  voice,
  rate,
  pitch,
  volume,
  humanize,
  style,
  speechStyle,
  voiceCharacter,
  voiceTone,
  humanizeIntensity,
  outputName,
  profileFileOverride = null,
  source = "manual"
}) {
  if (!rawText.trim()) {
    return { error: "Text is required." };
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
    return { error: "Text is empty after cleanup." };
  }

  const jobId = getNowId();
  const vVoice = String(voice || parsed.meta.VOICE || DEFAULTS.voice);
  const vRate = String(rate || parsed.meta.RATE || DEFAULTS.rate);
  const vPitch = String(pitch || parsed.meta.PITCH || DEFAULTS.pitch);
  const vVolume = String(volume || parsed.meta.VOLUME || DEFAULTS.volume);
  const vHumanize = parseBool(humanize, DEFAULTS.humanize);
  const styleCandidate = String(style || "").trim();
  const vStyle = styleCandidate || DEFAULTS.style || getExpressionDefaultStyle("natural");
  const vSpeechStyle = String(speechStyle || DEFAULTS.speechStyle || "auto").trim() || "auto";
  const vVoiceCharacter = parseBool(voiceCharacter, DEFAULTS.voiceCharacter);
  const vVoiceTone = String(voiceTone || DEFAULTS.voiceTone || "auto").trim() || "auto";
  const humanizeIntensityRaw = Number(humanizeIntensity ?? DEFAULTS.humanizeIntensity);
  const humanizeStrength = Number.isFinite(humanizeIntensityRaw)
    ? Math.max(0, Math.min(1, humanizeIntensityRaw))
    : DEFAULTS.humanizeIntensity;

  const requestedName = outputName || parsed.meta.OUTPUT || jobId;
  const baseName = sanitizeBaseName(requestedName);
  const outputWithoutExt = path.join(OUTPUT_DIR, `${baseName}_${jobId}`);

  jobs.set(jobId, {
    id: jobId,
    status: "queued",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    voice: vVoice,
    rate: vRate,
    pitch: vPitch,
    volume: vVolume,
    outputFile: `${outputWithoutExt}.mp3`,
    prosodyFile: `${outputWithoutExt}.prosody.json`,
    style: vStyle,
    humanize: vHumanize,
    humanizeIntensity: humanizeStrength,
    speechStyle: vSpeechStyle,
    voiceCharacter: vVoiceCharacter,
    voiceTone: vVoiceTone,
    profileFileOverride,
    source,
    error: null,
    events: []
  });
  addEvent(
    jobs.get(jobId),
    "info",
    vHumanize
      ? `queued with voice=${vVoice}, humanize=true, style=${vStyle}, speech_style=${vSpeechStyle}, voice_tone=${vVoiceTone}, source=${source}, ignored_by_humanize(rate=${vRate}, pitch=${vPitch}, volume=${vVolume})`
      : `queued with voice=${vVoice}, humanize=false, rate=${vRate}, pitch=${vPitch}, volume=${vVolume}, style=${vStyle}, source=${source}`
  );
  cleanupJobsIfNeeded();

  (async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    addEvent(job, "info", "synthesis started");

    try {
      if (vHumanize) {
        const res = await synthesizeHumanizedToMp3({
          text: cleaned,
          output: outputWithoutExt,
          voice: vVoice,
          rate: vRate, // kept for traceability, ignored by style rules during humanize
          pitch: vPitch,
          volume: vVolume,
          cacheDir: CACHE_DIR,
          humanizeIntensity: humanizeStrength,
          style: vStyle,
          speechStyle: vSpeechStyle,
          useMlPolicy: USE_ML_POLICY,
          profileFile: profileFileOverride,
          voiceCharacter: vVoiceCharacter,
          voiceTone: vVoiceTone
        });
        addEvent(job, "info", `humanize segments=${res.segments}, style=${res.style}, profile=${res.profileFile}`);
        appendNdjson(TRAINING_JOBS_FILE, {
          at: new Date().toISOString(),
          jobId,
          voice: vVoice,
          mode: "humanize",
          style: res.style,
          profileFile: res.profileFile,
          intensity: humanizeStrength,
          outputFile: job.outputFile,
          prosodyFile: job.prosodyFile
        });
        const styleJobs = getStyleTrainingFile(res.style || vStyle, "jobs");
        appendNdjson(styleJobs.filePath, {
          at: new Date().toISOString(),
          jobId,
          voice: vVoice,
          mode: "humanize",
          style: res.style || vStyle,
          styleKey: styleJobs.styleKey,
          profileFile: res.profileFile,
          intensity: humanizeStrength,
          outputFile: job.outputFile,
          prosodyFile: job.prosodyFile
        });
      } else {
        await synthesizeToMp3({
          text: cleaned,
          output: outputWithoutExt,
          voice: vVoice,
          rate: vRate,
          pitch: vPitch,
          volume: vVolume,
          cacheDir: CACHE_DIR
        });
        appendNdjson(TRAINING_JOBS_FILE, {
          at: new Date().toISOString(),
          jobId,
          voice: vVoice,
          mode: "normal",
          style: null,
          profileFile: null,
          intensity: null,
          outputFile: job.outputFile,
          prosodyFile: null
        });
        const styleJobs = getStyleTrainingFile(vStyle || "general", "jobs");
        appendNdjson(styleJobs.filePath, {
          at: new Date().toISOString(),
          jobId,
          voice: vVoice,
          mode: "normal",
          style: vStyle || "general",
          styleKey: styleJobs.styleKey,
          profileFile: null,
          intensity: null,
          outputFile: job.outputFile,
          prosodyFile: null
        });
      }
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

  return { jobId, status: "queued" };
}

app.post("/api/jobs", async (req, res) => {
  const enq = enqueueJob({
    rawText: String(req.body?.text || ""),
    voice: req.body?.voice,
    rate: req.body?.rate,
    pitch: req.body?.pitch,
    volume: req.body?.volume,
    humanize: req.body?.humanize,
    style: req.body?.style,
    speechStyle: req.body?.speechStyle ?? req.body?.speech_style,
    voiceCharacter: req.body?.voiceCharacter ?? req.body?.voice_character,
    voiceTone: req.body?.voiceTone ?? req.body?.voice_tone,
    humanizeIntensity: req.body?.humanizeIntensity,
    outputName: req.body?.outputName,
    source: "manual"
  });
  if (enq.error) {
    return res.status(400).json({ error: enq.error });
  }
  return res.status(202).json(enq);
});

app.post("/api/training/jobs", async (req, res) => {
  if (!fs.existsSync(TRAINING_BENCHMARK_FILE)) {
    return res.status(404).json({ error: "Training benchmark text not found." });
  }
  const benchmark = fs.readFileSync(TRAINING_BENCHMARK_FILE, "utf8");
  const profileFile = String(req.body?.profileFile || "").trim() || null;
  if (profileFile) {
    try {
      readProfileFile(profileFile);
    } catch {
      return res.status(404).json({ error: "Profile not found." });
    }
  }
  const enq = enqueueJob({
    rawText: benchmark,
    voice: req.body?.voice,
    humanize: true,
    style: req.body?.style || DEFAULTS.style,
    speechStyle: req.body?.speechStyle ?? req.body?.speech_style ?? DEFAULTS.speechStyle,
    voiceCharacter: req.body?.voiceCharacter ?? req.body?.voice_character ?? DEFAULTS.voiceCharacter,
    voiceTone: req.body?.voiceTone ?? req.body?.voice_tone ?? DEFAULTS.voiceTone,
    humanizeIntensity: req.body?.humanizeIntensity ?? DEFAULTS.humanizeIntensity,
    outputName: req.body?.outputName || `training_${req.body?.style || DEFAULTS.style}`,
    profileFileOverride: profileFile,
    source: "training_benchmark"
  });
  if (enq.error) {
    return res.status(400).json({ error: enq.error });
  }
  return res.status(202).json(enq);
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
    prosodyUrl:
      job.status === "completed" && fs.existsSync(job.prosodyFile)
        ? `/api/jobs/${job.id}/prosody`
        : null,
    events: job.events
  });
});

app.post("/api/jobs/:jobId/feedback", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  const scoreNum = Number(req.body?.score);
  if (!Number.isFinite(scoreNum) || scoreNum < 1 || scoreNum > 5) {
    return res.status(400).json({ error: "Score must be 1..5." });
  }
  const notes = String(req.body?.notes || "").trim();
  const adjustRate = Number(req.body?.adjustRate ?? 0);
  const adjustPitch = Number(req.body?.adjustPitch ?? 0);
  const adjustVolume = Number(req.body?.adjustVolume ?? 0);
  const intentTargetRaw = String(req.body?.intent_target ?? req.body?.intentTarget ?? "").trim().toLowerCase();
  const intensityTargetRaw = Number(req.body?.intensity_target ?? req.body?.intensityTarget);
  const transitionNote = String(req.body?.transition_note ?? req.body?.transitionNote || "").trim();
  const voiceFitRaw = Number(req.body?.voice_fit ?? req.body?.voiceFit);
  const intentTarget = intentTargetRaw || null;
  const intensityTarget =
    Number.isFinite(intensityTargetRaw) && intensityTargetRaw >= 0 && intensityTargetRaw <= 1
      ? intensityTargetRaw
      : null;
  const voiceFit = Number.isFinite(voiceFitRaw) && voiceFitRaw >= 1 && voiceFitRaw <= 5 ? voiceFitRaw : null;
  const payload = {
    at: new Date().toISOString(),
    jobId: job.id,
    score: scoreNum,
    notes,
    adjustRate: Number.isFinite(adjustRate) ? adjustRate : 0,
    adjustPitch: Number.isFinite(adjustPitch) ? adjustPitch : 0,
    adjustVolume: Number.isFinite(adjustVolume) ? adjustVolume : 0,
    intent_target: intentTarget,
    intensity_target: intensityTarget,
    transition_note: transitionNote,
    voice_fit: voiceFit,
    mode: job.humanize ? "humanize" : "normal",
    style: job.style || null,
    humanizeIntensity: job.humanizeIntensity ?? null,
    outputFile: path.basename(job.outputFile),
    prosodyFile: fs.existsSync(job.prosodyFile) ? path.basename(job.prosodyFile) : null
  };
  appendNdjson(TRAINING_FEEDBACK_FILE, payload);
  const styleFeedback = getStyleTrainingFile(job.style || "general", "feedback");
  appendNdjson(styleFeedback.filePath, {
    ...payload,
    styleKey: styleFeedback.styleKey
  });
  addEvent(job, "info", `feedback saved (score=${scoreNum})`);
  let trainRes = null;
  if (AUTO_TRAIN) {
    trainRes = trainProfileFromFeedback({
      apply: true,
      minFeedback: AUTO_TRAIN_MIN_FEEDBACK
    });
    if (trainRes.status === "trained") {
      addEvent(job, "info", `auto-train applied: ${trainRes.file}`);
    } else {
      addEvent(job, "info", `auto-train skipped: ${trainRes.reason}`);
    }
  }
  const active = loadActiveProfile();
  return res.json({
    ok: true,
    autoTrain: AUTO_TRAIN,
    trainResult: trainRes,
    activeProfile: active.file
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

app.get("/api/jobs/:jobId/audio-stream", (req, res) => {
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

  res.setHeader("Content-Type", "audio/mpeg");
  res.setHeader("Accept-Ranges", "bytes");
  return fs.createReadStream(job.outputFile).pipe(res);
});

app.get("/api/jobs/:jobId/prosody", (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) {
    return res.status(404).json({ error: "Job not found." });
  }
  if (!fs.existsSync(job.prosodyFile)) {
    return res.status(404).json({ error: "Prosody map not found for this job." });
  }
  return res.download(job.prosodyFile, path.basename(job.prosodyFile));
});

app.listen(PORT, () => {
  console.log(`TTS web running at http://localhost:${PORT}`);
});
