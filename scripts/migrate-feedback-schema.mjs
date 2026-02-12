import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const TRAIN_DIR = path.resolve(ROOT, "data", "training");

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

function writeNdjson(filePath, rows) {
  const payload = rows.map((r) => JSON.stringify(r)).join("\n");
  fs.writeFileSync(filePath, payload ? `${payload}\n` : "", "utf8");
}

function asNum(v, fallback = null) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function migrateRow(row, dropLegacy) {
  const out = { ...row };
  const intentTarget = String(out.intent_target ?? out.intentTarget ?? "").trim().toLowerCase();
  const intensityTarget = asNum(out.intensity_target ?? out.intensityTarget, null);
  const transitionNote = String(out.transition_note ?? out.transitionNote ?? "").trim();
  const voiceFit = asNum(out.voice_fit ?? out.voiceFit, null);

  out.intent_target = intentTarget || null;
  out.intensity_target =
    intensityTarget !== null && intensityTarget >= 0 && intensityTarget <= 1 ? intensityTarget : null;
  out.transition_note = transitionNote || "";
  out.voice_fit = voiceFit !== null && voiceFit >= 1 && voiceFit <= 5 ? Math.round(voiceFit) : null;

  if (dropLegacy) {
    delete out.intentTarget;
    delete out.intensityTarget;
    delete out.transitionNote;
    delete out.voiceFit;
  }
  return out;
}

function collectFeedbackFiles() {
  const targets = [path.join(TRAIN_DIR, "feedback.ndjson")];
  const stylesRoot = path.join(TRAIN_DIR, "styles");
  if (fs.existsSync(stylesRoot)) {
    const dirs = fs.readdirSync(stylesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      targets.push(path.join(stylesRoot, d.name, "feedback.ndjson"));
    }
  }
  return targets.filter((f) => fs.existsSync(f));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dropLegacy = String(args["drop-legacy"] ?? "true").toLowerCase() === "true";
  const files = collectFeedbackFiles();
  if (!files.length) {
    console.log("schema_migrate_skipped=no_feedback_files");
    return;
  }

  let touched = 0;
  for (const filePath of files) {
    const rows = readNdjson(filePath);
    if (!rows.length) continue;
    const migrated = rows.map((r) => migrateRow(r, dropLegacy));
    writeNdjson(filePath, migrated);
    touched += 1;
    console.log(`${path.relative(ROOT, filePath)} rows=${rows.length} migrated=true drop_legacy=${dropLegacy}`);
  }
  console.log(`schema_migrate_done files=${touched}`);
}

main();
