import fs from "fs";
import path from "path";
import { loadActiveProfile, ensureTrainingDirs, appendNdjson, getStyleTrainingFile } from "../lib/profile-store.mjs";
import { synthesizeHumanizedToMp3 } from "../lib/tts-core.mjs";

const OUTPUT_DIR = path.resolve(process.cwd(), "outputs");
const CACHE_DIR = path.resolve(process.cwd(), ".tts-cache");
const TRAINING_DIR = ensureTrainingDirs();
const TRAINING_JOBS_FILE = path.join(TRAINING_DIR, "jobs.ndjson");
const BENCHMARK_FILE = path.resolve(process.cwd(), "config", "training", "benchmark.txt");

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

function sanitizeName(name) {
  return String(name || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

async function main() {
  if (!fs.existsSync(BENCHMARK_FILE)) {
    throw new Error(`Benchmark file not found: ${BENCHMARK_FILE}`);
  }
  if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });

  const args = parseArgs(process.argv.slice(2));
  const voice = String(args.voice || "id-ID-ArdiNeural");
  const intensityRaw = Number(args.intensity ?? 1);
  const intensity = Number.isFinite(intensityRaw) ? Math.max(0, Math.min(1, intensityRaw)) : 1;
  const selectedStyles = String(args.styles || "")
    .split(",")
    .map((s) => sanitizeName(s))
    .filter(Boolean);

  const benchmarkText = fs.readFileSync(BENCHMARK_FILE, "utf8");
  const active = loadActiveProfile();
  const allStyles = Object.keys(active.profile?.styles || {});
  const styles = selectedStyles.length
    ? allStyles.filter((s) => selectedStyles.includes(sanitizeName(s)))
    : allStyles;

  if (!styles.length) {
    console.log("benchmark_skipped=no_styles");
    return;
  }

  for (let i = 0; i < styles.length; i += 1) {
    const style = styles[i];
    const jobId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const base = path.join(OUTPUT_DIR, `benchmark_${sanitizeName(style)}_${sanitizeName(active.file.replace(".json", ""))}_${jobId}`);

    const res = await synthesizeHumanizedToMp3({
      text: benchmarkText,
      output: base,
      voice,
      rate: "-8%",
      pitch: "-2Hz",
      volume: "0%",
      cacheDir: CACHE_DIR,
      humanizeIntensity: intensity,
      style,
      useMlPolicy: true,
      profileFile: active.file
    });

    const jobPayload = {
      at: new Date().toISOString(),
      jobId,
      voice,
      mode: "humanize",
      style: res.style,
      profileFile: res.profileFile,
      intensity,
      outputFile: res.audioPath,
      prosodyFile: res.prosodyPath
    };
    appendNdjson(TRAINING_JOBS_FILE, jobPayload);
    const styleJobs = getStyleTrainingFile(res.style, "jobs");
    appendNdjson(styleJobs.filePath, {
      ...jobPayload,
      styleKey: styleJobs.styleKey
    });

    console.log(`benchmark style=${style} jobId=${jobId} segments=${res.segments} profile=${res.profileFile}`);
  }

  console.log(`benchmark_generated=${styles.length}`);
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
