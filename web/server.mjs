import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import express from "express";
import dotenv from "dotenv";
import { cleanLine, parseText } from "../lib/tts-core.mjs";
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
import { getExpressionDefaultStyle, getExpressionRuntimeDefaults } from "../lib/expression-defaults.mjs";
import { validateFeedbackRow, validateTrainingJobRow } from "../lib/ndjson-schema.mjs";
import { safeAppendTrainingSqlite } from "../lib/training-sqlite-bridge.mjs";

dotenv.config({ quiet: true });

const app = express();
const PORT = Number(process.env.WEB_PORT || 3030);
const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const CACHE_DIR = path.resolve(process.cwd(), ".tts-cache");
const LOG_FILE = path.join(CACHE_DIR, "jobs.log");
const JOBS_STORE = path.join(CACHE_DIR, "jobs.json");
const TRAINING_DIR = ensureTrainingDirs();
const TRAINING_FEEDBACK_FILE = path.join(TRAINING_DIR, "feedback.ndjson");
const TRAINING_JOBS_FILE = path.join(TRAINING_DIR, "jobs.ndjson");
const TRAINING_SQLITE_FILE = path.join(TRAINING_DIR, "training.db");
const WRITE_NDJSON = String(process.env.TTS_NDJSON_TRAINING || "false").toLowerCase() === "true";
function resolveTrainingBenchmarkFile() {
  const fromEnv = String(process.env.TTS_WEB_TRAINING_TEXT || "").trim();
  if (fromEnv) {
    return path.resolve(process.cwd(), fromEnv);
  }
  const sampleInput = path.resolve(process.cwd(), "sample", "sample_text_input.txt");
  if (fs.existsSync(sampleInput)) {
    return sampleInput;
  }
  return path.resolve(process.cwd(), "config", "training", "benchmark.txt");
}

const TRAINING_BENCHMARK_FILE = resolveTrainingBenchmarkFile();
const AUTO_TRAIN = String(process.env.TTS_AUTO_TRAIN || "true").toLowerCase() === "true";
const AUTO_TRAIN_MIN_FEEDBACK = Number(process.env.TTS_AUTO_TRAIN_MIN_FEEDBACK || "2");
const USE_ML_POLICY = String(process.env.TTS_ML_POLICY || "true").toLowerCase() === "true";
const DEFAULT_SEGMENT_CONCURRENCY = Math.max(1, Number(process.env.TTS_SEGMENT_CONCURRENCY || "1"));
const RUNTIME_DEFAULTS = getExpressionRuntimeDefaults();

if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

const DEFAULTS = {
  voice: process.env.TTS_VOICE || "id-ID-GadisNeural",
  rate: process.env.TTS_RATE || "-8%",
  pitch: process.env.TTS_PITCH || "-2Hz",
  volume: process.env.TTS_VOLUME || "0%",
  humanize: String(process.env.TTS_HUMANIZE || "false").toLowerCase() === "true",
  humanizeIntensity: Number(process.env.TTS_HUMANIZE_INTENSITY || RUNTIME_DEFAULTS.humanizeIntensity || "0.45"),
  style: process.env.TTS_STYLE || getExpressionDefaultStyle("natural"),
  autoExpressive:
    String(
      process.env.TTS_AUTO_EXPRESSIVE ??
        (RUNTIME_DEFAULTS.autoExpressive === null ? "true" : String(RUNTIME_DEFAULTS.autoExpressive))
    ).toLowerCase() === "true",
  hybridProsody:
    String(
      process.env.TTS_HYBRID_PROSODY ??
        (RUNTIME_DEFAULTS.hybridProsody === null ? "true" : String(RUNTIME_DEFAULTS.hybridProsody))
    ).toLowerCase() === "true",
  speechStyle: process.env.TTS_SPEECH_STYLE || "auto",
  voiceCharacter: String(process.env.TTS_VOICE_CHARACTER || "true").toLowerCase() === "true",
  voiceTone: process.env.TTS_VOICE_TONE || "auto",
  segmentConcurrency: DEFAULT_SEGMENT_CONCURRENCY,
  prosodyLimiter:
    String(
      process.env.TTS_PROSODY_LIMITER ??
        (RUNTIME_DEFAULTS?.prosodyLimiter?.enabled === null
          ? "true"
          : String(RUNTIME_DEFAULTS.prosodyLimiter.enabled))
    ).toLowerCase() === "true",
  prosodyLimiterStrength: Number(
    process.env.TTS_PROSODY_LIMITER_STRENGTH ?? RUNTIME_DEFAULTS?.prosodyLimiter?.strength ?? "0.64"
  ),
  multiProsodyCandidates: Math.max(1, Math.min(6, Number(process.env.TTS_MULTI_PROSODY_CANDIDATES || "3")))
};

const jobs = new Map();
const MAX_JOBS = 100;
const pipelineRuns = new Map();
const MAX_PIPELINE_RUNS = 20;
let activePipelineRunId = null;
let voiceCache = null;
let voiceCacheAt = 0;
const VOICE_CACHE_MS = 5 * 60 * 1000;
let saveTimer = null;

app.use(express.json({ limit: "2mb" }));
app.use(express.static(path.resolve(process.cwd(), "web/public")));

loadJobsFromDisk();

function scheduleSaveJobs() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    try {
      const payload = [...jobs.values()];
      fs.writeFileSync(JOBS_STORE, JSON.stringify(payload, null, 2), "utf8");
    } catch (err) {
      console.error(`failed to persist jobs: ${err.message || String(err)}`);
    }
  }, 300);
}

function loadJobsFromDisk() {
  if (!fs.existsSync(JOBS_STORE)) return;
  try {
    const raw = JSON.parse(fs.readFileSync(JOBS_STORE, "utf8"));
    if (!Array.isArray(raw)) return;
    for (const job of raw) {
      if (!job || typeof job !== "object") continue;
      const status = String(job.status || "unknown");
      if (status === "queued" || status === "running") {
        job.status = "failed";
        job.error = "server_restarted";
        job.updatedAt = new Date().toISOString();
        job.events = Array.isArray(job.events) ? job.events : [];
        job.events.push({
          at: job.updatedAt,
          level: "warn",
          message: "job marked failed after server restart"
        });
      }
      jobs.set(job.id, job);
    }
  } catch (err) {
    console.error(`failed to load jobs: ${err.message || String(err)}`);
  }
}

function cleanupJobsIfNeeded() {
  if (jobs.size <= MAX_JOBS) return;
  const keys = [...jobs.keys()];
  const extra = keys.length - MAX_JOBS;
  for (let i = 0; i < extra; i += 1) {
    jobs.delete(keys[i]);
  }
  scheduleSaveJobs();
}

function cleanupPipelineRunsIfNeeded() {
  if (pipelineRuns.size <= MAX_PIPELINE_RUNS) return;
  const keys = [...pipelineRuns.keys()];
  const extra = keys.length - MAX_PIPELINE_RUNS;
  for (let i = 0; i < extra; i += 1) {
    pipelineRuns.delete(keys[i]);
  }
}

function resolveNpmBin() {
  return "npm";
}

function addPipelineLog(run, level, message) {
  if (!run) return;
  run.logs = Array.isArray(run.logs) ? run.logs : [];
  run.logs.push({
    at: new Date().toISOString(),
    level,
    message: String(message || "").slice(0, 800)
  });
  if (run.logs.length > 400) {
    run.logs = run.logs.slice(-400);
  }
  run.updatedAt = new Date().toISOString();
}

function startPipelineRun({ loop = false } = {}) {
  if (activePipelineRunId) {
    const active = pipelineRuns.get(activePipelineRunId);
    if (active && active.status === "running") {
      return { error: "pipeline already running", runId: activePipelineRunId };
    }
  }
  const runId = getNowId();
  const run = {
    id: runId,
    mode: loop ? "loop" : "single",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    command: loop ? "npm run prod:pipeline:loop" : "npm run prod:pipeline",
    exitCode: null,
    pid: null,
    logs: []
  };
  pipelineRuns.set(runId, run);
  cleanupPipelineRunsIfNeeded();
  activePipelineRunId = runId;

  const npmBin = resolveNpmBin();
  const pipelineScript = loop ? "prod:pipeline:loop" : "prod:pipeline";
  const command = `${npmBin} run ${pipelineScript}`;
  let child;
  try {
    child = spawn(command, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: true
    });
  } catch (err) {
    run.status = "failed";
    run.exitCode = -1;
    addPipelineLog(run, "error", err.message || String(err));
    if (activePipelineRunId === runId) activePipelineRunId = null;
    return { error: "failed to start pipeline process", detail: err.message || String(err), runId };
  }
  run.pid = child.pid || null;
  addPipelineLog(run, "info", `started: ${run.command}`);

  child.stdout.on("data", (chunk) => {
    const text = String(chunk || "");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) addPipelineLog(run, "info", line.trim());
    }
  });
  child.stderr.on("data", (chunk) => {
    const text = String(chunk || "");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) addPipelineLog(run, "error", line.trim());
    }
  });
  child.on("error", (err) => {
    run.status = "failed";
    run.exitCode = -1;
    addPipelineLog(run, "error", err.message || String(err));
    if (activePipelineRunId === runId) activePipelineRunId = null;
  });
  child.on("close", (code) => {
    run.exitCode = Number(code ?? 0);
    run.status = run.exitCode === 0 ? "completed" : "failed";
    addPipelineLog(run, run.status === "completed" ? "info" : "error", `finished exit=${run.exitCode}`);
    if (activePipelineRunId === runId) activePipelineRunId = null;
  });
  run.child = child;
  return { runId };
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
  scheduleSaveJobs();
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

function parseSegmentConcurrency(value, fallback = 1) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(1, Math.min(8, Math.floor(n)));
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

function getPythonPath() {
  return String(process.env.TTS_PYTHON_BIN || process.env.PYTHON || "python").trim() || "python";
}

async function runPythonTts(args) {
  const py = getPythonPath();
  return await new Promise((resolve, reject) => {
    const child = spawn(py, args, { stdio: ["ignore", "pipe", "pipe"] });
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
        reject(new Error((stderr || stdout || `python_tts_exit_${code}`).trim()));
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function synthesizeViaPython({
  jobId,
  text,
  outputWithoutExt,
  voice,
  rate,
  pitch,
  volume,
  humanize,
  style,
  autoExpressive,
  speechStyle,
  useMlPolicy,
  profileFile,
  voiceCharacter,
  voiceTone,
  segmentConcurrency,
  hybridProsody,
  prosodyLimiter,
  prosodyLimiterStrength,
  humanizeIntensity,
  multiProsodyCandidates
}) {
  const scriptPath = path.resolve(process.cwd(), "scripts_py", "generate_tts.py");
  const inputPath = path.join(CACHE_DIR, `job_input_${jobId}.txt`);
  fs.writeFileSync(inputPath, `${String(text || "").trim()}\n`, "utf8");
  const args = [
    scriptPath,
    "--runtime",
    "py",
    "--input",
    inputPath,
    "--output",
    outputWithoutExt,
    "--voice",
    String(voice),
    "--rate",
    String(rate),
    "--pitch",
    String(pitch),
    "--volume",
    String(volume),
    "--humanize",
    humanize ? "true" : "false",
    "--style",
    String(style || "natural"),
    "--auto-expressive",
    autoExpressive ? "true" : "false",
    "--speech-style",
    String(speechStyle || "auto"),
    "--ml-policy",
    useMlPolicy ? "true" : "false",
    "--voice-character",
    voiceCharacter ? "true" : "false",
    "--voice-tone",
    String(voiceTone || "auto"),
    "--segment-concurrency",
    String(segmentConcurrency),
    "--hybrid-prosody",
    hybridProsody ? "true" : "false",
    "--prosody-limiter",
    prosodyLimiter ? "true" : "false",
    "--prosody-limiter-strength",
    String(prosodyLimiterStrength),
    "--humanize-intensity",
    String(humanizeIntensity),
    "--multi-prosody-candidates",
    String(Math.max(1, Math.min(6, Number(multiProsodyCandidates || 1))))
  ];
  if (profileFile) {
    args.push("--profile-file", String(profileFile));
  }
  try {
    const result = await runPythonTts(args);
    let styleName = style || "natural";
    let resolvedProfile = profileFile || null;
    let segmentCount = 0;
    const prosodyPath = `${outputWithoutExt}.prosody.json`;
    if (humanize && fs.existsSync(prosodyPath)) {
      try {
        const prosodyJson = JSON.parse(fs.readFileSync(prosodyPath, "utf8"));
        styleName = String(prosodyJson?.style || styleName);
        resolvedProfile = String(prosodyJson?.profileFile || resolvedProfile || "").trim() || null;
        segmentCount = Array.isArray(prosodyJson?.segments) ? prosodyJson.segments.length : 0;
      } catch {
        // Keep synthesis result even if prosody metadata parsing fails.
      }
    }
    return {
      ...result,
      audioPath: `${outputWithoutExt}.mp3`,
      prosodyPath: humanize ? `${outputWithoutExt}.prosody.json` : null,
      style: styleName,
      profileFile: resolvedProfile,
      segments: segmentCount
    };
  } finally {
    try {
      fs.unlinkSync(inputPath);
    } catch {
      // Ignore temp cleanup failures.
    }
  }
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

app.post("/api/pipeline/run", (req, res) => {
  const loop = parseBool(req.body?.loop, false);
  const started = startPipelineRun({ loop });
  if (started.error) {
    return res.status(409).json(started);
  }
  return res.status(202).json({ runId: started.runId, status: "running", mode: loop ? "loop" : "single" });
});

app.get("/api/pipeline/active", (req, res) => {
  if (!activePipelineRunId) return res.json({ active: null });
  const run = pipelineRuns.get(activePipelineRunId);
  if (!run) return res.json({ active: null });
  return res.json({
    active: {
      id: run.id,
      mode: run.mode,
      status: run.status,
      createdAt: run.createdAt,
      updatedAt: run.updatedAt,
      exitCode: run.exitCode,
      command: run.command
    }
  });
});

app.get("/api/pipeline/:runId", (req, res) => {
  const run = pipelineRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: "pipeline run not found" });
  return res.json({
    id: run.id,
    mode: run.mode,
    status: run.status,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
    exitCode: run.exitCode,
    command: run.command,
    logs: Array.isArray(run.logs) ? run.logs : []
  });
});

app.post("/api/pipeline/:runId/stop", (req, res) => {
  const run = pipelineRuns.get(req.params.runId);
  if (!run) return res.status(404).json({ error: "pipeline run not found" });
  if (run.status !== "running") return res.json({ ok: true, status: run.status });
  try {
    if (run.child?.pid) {
      run.child.kill("SIGTERM");
    }
    run.status = "stopped";
    run.exitCode = -2;
    addPipelineLog(run, "warn", "stopped by user");
    if (activePipelineRunId === run.id) activePipelineRunId = null;
    return res.json({ ok: true, status: "stopped" });
  } catch (err) {
    return res.status(500).json({ error: err.message || String(err) });
  }
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
  autoExpressive,
  speechStyle,
  voiceCharacter,
  voiceTone,
  humanizeIntensity,
  hybridProsody,
  prosodyLimiter,
  prosodyLimiterStrength,
  multiProsodyCandidates,
  segmentConcurrency: segmentConcurrencyRaw,
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
  const vAutoExpressive = parseBool(autoExpressive, DEFAULTS.autoExpressive);
  const vSpeechStyle = String(speechStyle || DEFAULTS.speechStyle || "auto").trim() || "auto";
  const vVoiceCharacter = parseBool(voiceCharacter, DEFAULTS.voiceCharacter);
  const vVoiceTone = String(voiceTone || DEFAULTS.voiceTone || "auto").trim() || "auto";
  const humanizeIntensityRaw = Number(humanizeIntensity ?? DEFAULTS.humanizeIntensity);
  const humanizeStrength = Number.isFinite(humanizeIntensityRaw)
    ? Math.max(0, Math.min(1, humanizeIntensityRaw))
    : DEFAULTS.humanizeIntensity;
  const vHybridProsody = parseBool(hybridProsody, DEFAULTS.hybridProsody);
  const vProsodyLimiter = parseBool(prosodyLimiter, DEFAULTS.prosodyLimiter);
  const vProsodyLimiterStrengthRaw = Number(prosodyLimiterStrength ?? DEFAULTS.prosodyLimiterStrength);
  const vProsodyLimiterStrength = Number.isFinite(vProsodyLimiterStrengthRaw)
    ? Math.max(0.3, Math.min(1, vProsodyLimiterStrengthRaw))
    : DEFAULTS.prosodyLimiterStrength;
  const segmentConcurrency = parseSegmentConcurrency(segmentConcurrencyRaw ?? DEFAULTS.segmentConcurrency, DEFAULTS.segmentConcurrency);
  const vMultiProsodyCandidates = Math.max(
    1,
    Math.min(6, Number((multiProsodyCandidates ?? DEFAULTS.multiProsodyCandidates) || 1))
  );

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
    autoExpressive: vAutoExpressive,
    voiceCharacter: vVoiceCharacter,
    voiceTone: vVoiceTone,
    hybridProsody: vHybridProsody,
    prosodyLimiter: vProsodyLimiter,
    prosodyLimiterStrength: vProsodyLimiterStrength,
    multiProsodyCandidates: vMultiProsodyCandidates,
    segmentConcurrency,
    profileFileOverride,
    source,
    error: null,
    events: []
  });
  addEvent(
    jobs.get(jobId),
    "info",
    vHumanize
      ? `queued with voice=${vVoice}, humanize=true, style=${vStyle}, speech_style=${vSpeechStyle}, voice_tone=${vVoiceTone}, segment_concurrency=${segmentConcurrency}, source=${source}, ignored_by_humanize(rate=${vRate}, pitch=${vPitch}, volume=${vVolume})`
      : `queued with voice=${vVoice}, humanize=false, rate=${vRate}, pitch=${vPitch}, volume=${vVolume}, style=${vStyle}, source=${source}`
  );
  cleanupJobsIfNeeded();
  scheduleSaveJobs();

  (async () => {
    const job = jobs.get(jobId);
    if (!job) return;
    job.status = "running";
    job.updatedAt = new Date().toISOString();
    addEvent(job, "info", "synthesis started");

    try {
      if (vHumanize) {
        const res = await synthesizeViaPython({
          jobId,
          text: cleaned,
          outputWithoutExt,
          voice: vVoice,
          rate: vRate,
          pitch: vPitch,
          volume: vVolume,
          humanize: true,
          humanizeIntensity: humanizeStrength,
          style: vStyle,
          autoExpressive: vAutoExpressive,
          speechStyle: vSpeechStyle,
          useMlPolicy: USE_ML_POLICY,
          profileFile: profileFileOverride || null,
          voiceCharacter: vVoiceCharacter,
          voiceTone: vVoiceTone,
          segmentConcurrency,
          hybridProsody: vHybridProsody,
          prosodyLimiter: vProsodyLimiter,
          prosodyLimiterStrength: vProsodyLimiterStrength,
          multiProsodyCandidates: vMultiProsodyCandidates
        });
        addEvent(job, "info", `humanize segments=${res.segments}, style=${res.style}, profile=${res.profileFile}`);
        const jobRow = {
          at: new Date().toISOString(),
          jobId,
          voice: vVoice,
          mode: "humanize",
          style: res.style,
          profileFile: res.profileFile,
          intensity: humanizeStrength,
          outputFile: job.outputFile,
          prosodyFile: job.prosodyFile
        };
        const jobValidation = validateTrainingJobRow(jobRow);
        if (jobValidation.ok) {
          if (WRITE_NDJSON) appendNdjson(TRAINING_JOBS_FILE, jobRow);
          const sqliteGlobal = await safeAppendTrainingSqlite({
            kind: "jobs",
            payload: jobRow,
            scope: "global",
            sourceFile: "data/training/jobs.ndjson",
            dbFile: TRAINING_SQLITE_FILE
          });
          if (!sqliteGlobal?.ok && !sqliteGlobal?.skipped) {
            addEvent(job, "warn", `sqlite job mirror failed (global): ${sqliteGlobal.error}`);
          }
          let styleJobs = null;
          if (WRITE_NDJSON) {
            styleJobs = getStyleTrainingFile(res.style || vStyle, "jobs");
            appendNdjson(styleJobs.filePath, {
              ...jobRow,
              style: res.style || vStyle,
              styleKey: styleJobs.styleKey
            });
          }
          const styleKey =
            styleJobs?.styleKey ||
            String(res.style || vStyle || "general")
              .toLowerCase()
              .replace(/[^a-z0-9-_]/g, "_")
              .replace(/_+/g, "_")
              .replace(/^_+|_+$/g, "") ||
            "general";
          const sqliteStyle = await safeAppendTrainingSqlite({
            kind: "jobs",
            payload: {
              ...jobRow,
              style: res.style || vStyle,
              styleKey
            },
            scope: "style",
            styleKey,
            sourceFile: `data/training/styles/${styleKey}/jobs.ndjson`,
            dbFile: TRAINING_SQLITE_FILE
          });
          if (!sqliteStyle?.ok && !sqliteStyle?.skipped) {
            addEvent(job, "warn", `sqlite job mirror failed (style): ${sqliteStyle.error}`);
          }
        } else {
          addEvent(job, "warn", `training job row skipped (${jobValidation.reason})`);
        }
      } else {
        await synthesizeViaPython({
          jobId,
          text: cleaned,
          outputWithoutExt,
          voice: vVoice,
          rate: vRate,
          pitch: vPitch,
          volume: vVolume,
          humanize: false,
          humanizeIntensity: humanizeStrength,
          style: vStyle,
          autoExpressive: vAutoExpressive,
          speechStyle: vSpeechStyle,
          useMlPolicy: USE_ML_POLICY,
          profileFile: profileFileOverride || null,
          voiceCharacter: vVoiceCharacter,
          voiceTone: vVoiceTone,
          segmentConcurrency,
          hybridProsody: vHybridProsody,
          prosodyLimiter: vProsodyLimiter,
          prosodyLimiterStrength: vProsodyLimiterStrength,
          multiProsodyCandidates: vMultiProsodyCandidates
        });
        const jobRow = {
          at: new Date().toISOString(),
          jobId,
          voice: vVoice,
          mode: "normal",
          style: null,
          profileFile: null,
          intensity: null,
          outputFile: job.outputFile,
          prosodyFile: null
        };
        const jobValidation = validateTrainingJobRow(jobRow);
        if (jobValidation.ok) {
          if (WRITE_NDJSON) appendNdjson(TRAINING_JOBS_FILE, jobRow);
          const sqliteGlobal = await safeAppendTrainingSqlite({
            kind: "jobs",
            payload: jobRow,
            scope: "global",
            sourceFile: "data/training/jobs.ndjson",
            dbFile: TRAINING_SQLITE_FILE
          });
          if (!sqliteGlobal?.ok && !sqliteGlobal?.skipped) {
            addEvent(job, "warn", `sqlite job mirror failed (global): ${sqliteGlobal.error}`);
          }
          let styleJobs = null;
          if (WRITE_NDJSON) {
            styleJobs = getStyleTrainingFile(vStyle || "general", "jobs");
            appendNdjson(styleJobs.filePath, {
              ...jobRow,
              style: vStyle || "general",
              styleKey: styleJobs.styleKey
            });
          }
          const styleKey =
            styleJobs?.styleKey ||
            String(vStyle || "general")
              .toLowerCase()
              .replace(/[^a-z0-9-_]/g, "_")
              .replace(/_+/g, "_")
              .replace(/^_+|_+$/g, "") ||
            "general";
          const sqliteStyle = await safeAppendTrainingSqlite({
            kind: "jobs",
            payload: {
              ...jobRow,
              style: vStyle || "general",
              styleKey
            },
            scope: "style",
            styleKey,
            sourceFile: `data/training/styles/${styleKey}/jobs.ndjson`,
            dbFile: TRAINING_SQLITE_FILE
          });
          if (!sqliteStyle?.ok && !sqliteStyle?.skipped) {
            addEvent(job, "warn", `sqlite job mirror failed (style): ${sqliteStyle.error}`);
          }
        } else {
          addEvent(job, "warn", `training job row skipped (${jobValidation.reason})`);
        }
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
    autoExpressive: req.body?.autoExpressive ?? req.body?.auto_expressive,
    speechStyle: req.body?.speechStyle ?? req.body?.speech_style,
    voiceCharacter: req.body?.voiceCharacter ?? req.body?.voice_character,
    voiceTone: req.body?.voiceTone ?? req.body?.voice_tone,
    humanizeIntensity: req.body?.humanizeIntensity,
    hybridProsody: req.body?.hybridProsody ?? req.body?.hybrid_prosody,
    prosodyLimiter: req.body?.prosodyLimiter ?? req.body?.prosody_limiter,
    prosodyLimiterStrength: req.body?.prosodyLimiterStrength ?? req.body?.prosody_limiter_strength,
    segmentConcurrency: req.body?.segmentConcurrency ?? req.body?.segment_concurrency,
    multiProsodyCandidates: req.body?.multiProsodyCandidates ?? req.body?.multi_prosody_candidates,
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
    autoExpressive: req.body?.autoExpressive ?? req.body?.auto_expressive ?? DEFAULTS.autoExpressive,
    speechStyle: req.body?.speechStyle ?? req.body?.speech_style ?? DEFAULTS.speechStyle,
    voiceCharacter: req.body?.voiceCharacter ?? req.body?.voice_character ?? DEFAULTS.voiceCharacter,
    voiceTone: req.body?.voiceTone ?? req.body?.voice_tone ?? DEFAULTS.voiceTone,
    humanizeIntensity: req.body?.humanizeIntensity ?? DEFAULTS.humanizeIntensity,
    hybridProsody: req.body?.hybridProsody ?? req.body?.hybrid_prosody ?? DEFAULTS.hybridProsody,
    prosodyLimiter: req.body?.prosodyLimiter ?? req.body?.prosody_limiter ?? DEFAULTS.prosodyLimiter,
    prosodyLimiterStrength:
      req.body?.prosodyLimiterStrength ?? req.body?.prosody_limiter_strength ?? DEFAULTS.prosodyLimiterStrength,
    segmentConcurrency: req.body?.segmentConcurrency ?? req.body?.segment_concurrency ?? DEFAULTS.segmentConcurrency,
    multiProsodyCandidates:
      req.body?.multiProsodyCandidates ?? req.body?.multi_prosody_candidates ?? DEFAULTS.multiProsodyCandidates,
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

app.post("/api/jobs/:jobId/feedback", async (req, res) => {
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
  const transitionNote = String((req.body?.transition_note ?? req.body?.transitionNote) || "").trim();
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
  const feedbackValidation = validateFeedbackRow(payload);
  if (!feedbackValidation.ok) {
    return res.status(400).json({ error: `Invalid feedback payload (${feedbackValidation.reason}).` });
  }
  if (WRITE_NDJSON) appendNdjson(TRAINING_FEEDBACK_FILE, payload);
  const sqliteGlobal = await safeAppendTrainingSqlite({
    kind: "feedback",
    payload,
    scope: "global",
    sourceFile: "data/training/feedback.ndjson",
    dbFile: TRAINING_SQLITE_FILE
  });
  if (!sqliteGlobal?.ok && !sqliteGlobal?.skipped) {
    addEvent(job, "warn", `sqlite feedback mirror failed (global): ${sqliteGlobal.error}`);
  }
  let styleFeedback = null;
  if (WRITE_NDJSON) {
    styleFeedback = getStyleTrainingFile(job.style || "general", "feedback");
    appendNdjson(styleFeedback.filePath, {
      ...payload,
      styleKey: styleFeedback.styleKey
    });
  }
  const styleKey =
    styleFeedback?.styleKey ||
    String(job.style || "general")
      .toLowerCase()
      .replace(/[^a-z0-9-_]/g, "_")
      .replace(/_+/g, "_")
      .replace(/^_+|_+$/g, "") ||
    "general";
  const stylePayload = {
    ...payload,
    styleKey,
    voice: job.voice
  };
  const sqliteStyle = await safeAppendTrainingSqlite({
    kind: "feedback",
    payload: stylePayload,
    scope: "style",
    styleKey,
    sourceFile: `data/training/styles/${styleKey}/feedback.ndjson`,
    dbFile: TRAINING_SQLITE_FILE
  });
  if (!sqliteStyle?.ok && !sqliteStyle?.skipped) {
    addEvent(job, "warn", `sqlite feedback mirror failed (style): ${sqliteStyle.error}`);
  }
  const sqliteStyleFeature = await safeAppendTrainingSqlite({
    kind: "style-feedback",
    payload: stylePayload,
    sourceFile: `data/training/styles/${styleFeedback.styleKey}/feedback.ndjson`,
    dbFile: TRAINING_SQLITE_FILE
  });
  if (!sqliteStyleFeature?.ok && !sqliteStyleFeature?.skipped) {
    addEvent(job, "warn", `sqlite style_feedback mirror failed: ${sqliteStyleFeature.error}`);
  }
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
  console.log(`Training text source: ${TRAINING_BENCHMARK_FILE}`);
});
