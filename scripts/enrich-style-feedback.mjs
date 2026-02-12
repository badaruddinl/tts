import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const TRAIN_DIR = path.resolve(ROOT, "data", "training");
const STYLE_DIR = path.join(TRAIN_DIR, "styles");
const GLOBAL_FEEDBACK = path.join(TRAIN_DIR, "feedback.ndjson");
const GLOBAL_JOBS = path.join(TRAIN_DIR, "jobs.ndjson");
const ACTIVE_PROFILE_PTR = path.resolve(ROOT, "config", "profiles", "active.json");

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

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function appendNdjson(filePath, rows) {
  if (!rows.length) return;
  const parent = path.dirname(filePath);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const payload = rows.map((r) => JSON.stringify(r)).join("\n") + "\n";
  fs.appendFileSync(filePath, payload, "utf8");
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function average(items) {
  if (!items.length) return 0;
  return items.reduce((s, n) => s + n, 0) / items.length;
}

function stddev(items, mean) {
  if (!items.length) return 0;
  const m = Number.isFinite(mean) ? mean : average(items);
  const v = average(items.map((n) => (n - m) ** 2));
  return Math.sqrt(v);
}

function styleTarget(style) {
  switch (style) {
    case "horor_intim":
      return { rate: -18, pitch: -6, volume: -1, varMin: 2.8 };
    case "misteri":
      return { rate: -14, pitch: -4, volume: -1, varMin: 2.1 };
    case "sinematik":
      return { rate: -9, pitch: -2, volume: 1, varMin: 2.6 };
    default:
      return { rate: -10, pitch: -3, volume: 0, varMin: 2.0 };
  }
}

function analyzeSegments(segments) {
  const rate = segments.map((s) => Number(s?.final?.rate ?? s?.rate ?? 0));
  const pitch = segments.map((s) => Number(s?.final?.pitch ?? s?.pitch ?? 0));
  const volume = segments.map((s) => Number(s?.final?.volume ?? s?.volume ?? 0));
  const text = segments.map((s) => String(s?.text || ""));
  const punctQ = text.filter((t) => /\?$/.test(t)).length;
  const punctX = text.filter((t) => /!$/.test(t)).length;
  const punctE = text.filter((t) => /\.\.\.$/.test(t)).length;
  const meanRate = average(rate);
  const meanPitch = average(pitch);
  const meanVolume = average(volume);
  return {
    count: segments.length,
    meanRate,
    meanPitch,
    meanVolume,
    varRate: stddev(rate, meanRate),
    varPitch: stddev(pitch, meanPitch),
    varVolume: stddev(volume, meanVolume),
    punctQ,
    punctX,
    punctE,
    intents: segments.map((s) => String(s?.reason?.intent || "netral")),
    intensities: segments.map((s) => Number(s?.reason?.intentIntensity ?? 0)),
    transitions: segments.map((s) => String(s?.reason?.transition || "steady"))
  };
}

function dominantIntent(intents) {
  const freq = new Map();
  for (const item of intents || []) {
    const key = String(item || "netral");
    freq.set(key, (freq.get(key) || 0) + 1);
  }
  let best = "netral";
  let bestN = -1;
  for (const [k, n] of freq.entries()) {
    if (n > bestN) {
      best = k;
      bestN = n;
    }
  }
  return best;
}

function buildAdjust(style, metrics) {
  const target = styleTarget(style);
  const dRate = target.rate - metrics.meanRate;
  const dPitch = target.pitch - metrics.meanPitch;
  const dVolume = target.volume - metrics.meanVolume;
  const varMean = average([metrics.varRate, metrics.varPitch, metrics.varVolume]);
  const underVar = target.varMin - varMean;

  let adjustRate = Math.round(clamp(dRate / 2.2, -6, 6));
  let adjustPitch = Math.round(clamp(dPitch / 1.6, -6, 6));
  let adjustVolume = Math.round(clamp(dVolume / 1.6, -6, 6));

  if (underVar > 0.7) {
    adjustRate += 1;
    adjustPitch += 1;
  } else if (underVar < -1.1) {
    adjustRate -= 1;
  }

  if (metrics.punctE > 0) adjustRate -= 1;
  if (metrics.punctQ > 0) adjustPitch += 1;
  if (metrics.punctX > 0) adjustVolume += 1;

  adjustRate = Math.round(clamp(adjustRate, -6, 6));
  adjustPitch = Math.round(clamp(adjustPitch, -6, 6));
  adjustVolume = Math.round(clamp(adjustVolume, -6, 6));

  const dist =
    Math.abs(target.rate - metrics.meanRate) / 8 +
    Math.abs(target.pitch - metrics.meanPitch) / 6 +
    Math.abs(target.volume - metrics.meanVolume) / 6 +
    Math.abs(target.varMin - varMean) / 2.4;
  const score = clamp(Math.round(5 - dist), 2, 5);

  const notes =
    `detail style-map: hook=${metrics.count >= 6 ? "ok" : "short"}, ` +
    `tempo=${metrics.meanRate.toFixed(1)}, tone=${metrics.meanPitch.toFixed(1)}, ` +
    `energy=${metrics.meanVolume.toFixed(1)}, var=${varMean.toFixed(2)}, ` +
    `q=${metrics.punctQ}, x=${metrics.punctX}, e=${metrics.punctE}`;

  const intentTarget = dominantIntent(metrics.intents);
  const intensityTarget = clamp(average(metrics.intensities), 0, 1);
  const smoothedCount = metrics.transitions.filter((t) => t === "smoothed").length;
  const heldCount = metrics.transitions.filter((t) => t === "held").length;
  const transitionNote = `transitions: smoothed=${smoothedCount}, held=${heldCount}, steady=${metrics.count - smoothedCount - heldCount}`;
  const voiceFit = clamp(Math.round(score), 1, 5);

  return {
    adjustRate,
    adjustPitch,
    adjustVolume,
    score,
    notes,
    intentTarget,
    intensityTarget,
    transitionNote,
    voiceFit
  };
}

function getProsodyPath(job) {
  const raw = String(job?.prosodyFile || "").trim();
  if (!raw) return null;
  if (path.isAbsolute(raw)) return fs.existsSync(raw) ? raw : null;
  const candidate = path.resolve(ROOT, raw);
  if (fs.existsSync(candidate)) return candidate;
  const inOutputs = path.resolve(ROOT, "outputs", raw);
  return fs.existsSync(inOutputs) ? inOutputs : null;
}

function normalizeProsodyName(filePath) {
  return path.basename(filePath);
}

function enrichStyle(styleName) {
  const dir = path.join(STYLE_DIR, styleName);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const jobsPath = path.join(dir, "jobs.ndjson");
  const styleFeedbackPath = path.join(dir, "feedback.ndjson");
  const styleJobs = readNdjson(jobsPath);
  const globalJobs = readNdjson(GLOBAL_JOBS).filter((j) => String(j.style || "") === styleName);
  const jobs = [...styleJobs, ...globalJobs];
  const uniqJobs = new Map();
  for (const j of jobs) {
    const id = String(j?.jobId || "").trim();
    if (!id) continue;
    if (!uniqJobs.has(id)) uniqJobs.set(id, j);
  }
  const styleFeedback = readNdjson(styleFeedbackPath);
  const globalFeedback = readNdjson(GLOBAL_FEEDBACK);
  const knownStyleIds = new Set(styleFeedback.map((r) => String(r.jobId || "")));
  const knownGlobalIds = new Set(globalFeedback.map((r) => String(r.jobId || "")));

  const styleRows = [];
  const globalRows = [];
  let skippedNoProsody = 0;
  let skippedDup = 0;

  for (const job of uniqJobs.values()) {
    const baseId = String(job?.jobId || "").trim();
    if (!baseId) continue;
    const detailId = `detail_${baseId}`;
    if (knownStyleIds.has(detailId) || knownGlobalIds.has(detailId)) {
      skippedDup += 1;
      continue;
    }

    const prosodyPath = getProsodyPath(job);
    if (!prosodyPath) {
      skippedNoProsody += 1;
      continue;
    }
    let prosody;
    try {
      prosody = JSON.parse(fs.readFileSync(prosodyPath, "utf8"));
    } catch {
      skippedNoProsody += 1;
      continue;
    }
    const segments = Array.isArray(prosody?.segments) ? prosody.segments : [];
    if (!segments.length) {
      skippedNoProsody += 1;
      continue;
    }

    const metrics = analyzeSegments(segments);
    const adj = buildAdjust(styleName, metrics);
    const row = {
      at: new Date().toISOString(),
      jobId: detailId,
      score: adj.score,
      notes: adj.notes,
      adjustRate: adj.adjustRate,
      adjustPitch: adj.adjustPitch,
      adjustVolume: adj.adjustVolume,
      intent_target: adj.intentTarget,
      intensity_target: Number(adj.intensityTarget.toFixed(3)),
      transition_note: adj.transitionNote,
      voice_fit: adj.voiceFit,
      mode: String(job.mode || "humanize"),
      style: styleName,
      styleKey: styleName,
      humanizeIntensity: Number(job.intensity ?? prosody.humanizeIntensity ?? 0.45),
      outputFile: path.basename(String(job.outputFile || "").trim() || `${baseId}.mp3`),
      prosodyFile: normalizeProsodyName(prosodyPath)
    };
    styleRows.push(row);
    globalRows.push(row);
    knownStyleIds.add(detailId);
    knownGlobalIds.add(detailId);
  }

  appendNdjson(styleFeedbackPath, styleRows);
  appendNdjson(GLOBAL_FEEDBACK, globalRows);

  return {
    styleName,
    jobsSeen: uniqJobs.size,
    created: styleRows.length,
    skippedNoProsody,
    skippedDup
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const only = String(args.style || "").trim();
  let profileStyles = [];
  if (fs.existsSync(ACTIVE_PROFILE_PTR)) {
    try {
      const active = JSON.parse(fs.readFileSync(ACTIVE_PROFILE_PTR, "utf8"));
      const profileFile = String(active?.activeProfile || "").trim();
      const profilePath = path.resolve(ROOT, "config", "profiles", profileFile);
      if (profileFile && fs.existsSync(profilePath)) {
        const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
        profileStyles = Object.keys(profile?.styles || {});
      }
    } catch {}
  }

  const dirStyles = fs.existsSync(STYLE_DIR)
    ? fs
        .readdirSync(STYLE_DIR, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

  const styles = only ? [only] : [...new Set([...profileStyles, ...dirStyles])];

  if (!styles.length) {
    console.log("style_detail_skipped=no_style_dirs");
    return;
  }

  let totalCreated = 0;
  for (const styleName of styles) {
    const res = enrichStyle(styleName);
    totalCreated += res.created;
    console.log(
      `style=${res.styleName} jobs=${res.jobsSeen} created=${res.created} dup=${res.skippedDup} no_prosody=${res.skippedNoProsody}`
    );
  }
  console.log(`style_detail_created_total=${totalCreated}`);
}

main();
