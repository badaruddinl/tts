import fs from "fs";
import path from "path";

const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const TRAIN_DIR = path.resolve(process.cwd(), "data", "training");
const FEEDBACK_FILE = path.join(TRAIN_DIR, "feedback.ndjson");

function ensureDirs() {
  if (!fs.existsSync(TRAIN_DIR)) fs.mkdirSync(TRAIN_DIR, { recursive: true });
}

function readProsodyFiles() {
  if (!fs.existsSync(OUTPUT_DIR)) return [];
  return fs
    .readdirSync(OUTPUT_DIR)
    .filter((f) => f.endsWith(".prosody.json"))
    .map((f) => path.join(OUTPUT_DIR, f));
}

function readExistingJobIds() {
  if (!fs.existsSync(FEEDBACK_FILE)) return new Set();
  const lines = fs.readFileSync(FEEDBACK_FILE, "utf8").split(/\r?\n/).filter(Boolean);
  const ids = new Set();
  for (const line of lines) {
    try {
      const row = JSON.parse(line);
      if (row?.jobId) ids.add(String(row.jobId));
    } catch {}
  }
  return ids;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function styleBaseAdjust(style) {
  switch (style) {
    case "misteri":
    case "horor_intim":
      return { r: -1, p: -1, v: 1 };
    case "dramatis":
    case "thriller":
    case "sinematik":
      return { r: 2, p: 2, v: 2 };
    case "pasrah":
    case "melankolis":
      return { r: -2, p: -1, v: -1 };
    case "narator_tegas":
      return { r: 1, p: 1, v: 2 };
    case "datar":
      return { r: 2, p: 2, v: 1 };
    default:
      return { r: 1, p: 1, v: 1 };
  }
}

function inferAdjustFromProsody(prosody) {
  const segs = Array.isArray(prosody?.segments) ? prosody.segments : [];
  const style = prosody?.style || "natural";
  const base = styleBaseAdjust(style);
  if (segs.length === 0) {
    return { adjustRate: base.r, adjustPitch: base.p, adjustVolume: base.v, score: 3 };
  }

  const avgAmp =
    segs.reduce((acc, s) => {
      const r = Math.abs(Number(s.rate || 0));
      const p = Math.abs(Number(s.pitch || 0));
      const v = Math.abs(Number(s.volume || 0));
      return acc + (r / 20 + p / 10 + v / 10) / 3;
    }, 0) / segs.length;

  let score = 4;
  let boost = 0;
  if (avgAmp < 0.35) {
    score = 2;
    boost = 2;
  } else if (avgAmp < 0.55) {
    score = 3;
    boost = 1;
  }

  return {
    adjustRate: clamp(base.r + boost, -5, 5),
    adjustPitch: clamp(base.p + Math.ceil(boost / 2), -5, 5),
    adjustVolume: clamp(base.v + Math.ceil(boost / 2), -5, 5),
    score
  };
}

function main() {
  ensureDirs();
  const files = readProsodyFiles();
  const existingIds = readExistingJobIds();
  let created = 0;

  for (const filePath of files) {
    const fileName = path.basename(filePath);
    const jobId = `bootstrap_${fileName}`;
    if (existingIds.has(jobId)) continue;
    let prosody;
    try {
      prosody = JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch {
      continue;
    }
    const style = prosody.style || "natural";
    const adj = inferAdjustFromProsody(prosody);
    const payload = {
      at: new Date().toISOString(),
      jobId,
      score: adj.score,
      notes: "bootstrap synthetic label from existing prosody",
      adjustRate: adj.adjustRate,
      adjustPitch: adj.adjustPitch,
      adjustVolume: adj.adjustVolume,
      mode: "humanize",
      style,
      humanizeIntensity: Number(prosody.humanizeIntensity || 0.45),
      outputFile: fileName.replace(".prosody.json", ".mp3"),
      prosodyFile: fileName
    };
    fs.appendFileSync(FEEDBACK_FILE, `${JSON.stringify(payload)}\n`, "utf8");
    created += 1;
  }

  console.log(`bootstrap_created=${created}`);
  console.log(`prosody_seen=${files.length}`);
}

main();
