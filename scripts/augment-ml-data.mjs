import fs from "fs";
import path from "path";

const TRAIN_DIR = path.resolve(process.cwd(), "data", "training");
const FEEDBACK_FILE = path.join(TRAIN_DIR, "feedback.ndjson");

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

function readRows() {
  if (!fs.existsSync(FEEDBACK_FILE)) return [];
  return fs
    .readFileSync(FEEDBACK_FILE, "utf8")
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

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

function jitter(seed, i) {
  const n = Math.sin(seed * 999 + i * 31.7) * 10000;
  return n - Math.floor(n);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const factor = Math.max(1, Math.min(5, Number(args.factor || 2)));
  const rows = readRows();
  const base = rows.filter((r) => String(r.jobId || "").startsWith("bootstrap_"));
  if (base.length === 0) {
    console.log("augment_skipped=no_bootstrap_rows");
    return;
  }

  let created = 0;
  for (const row of base) {
    const key = `${row.jobId}|${row.style}|${row.prosodyFile}`;
    let seed = 0;
    for (let i = 0; i < key.length; i += 1) seed += key.charCodeAt(i);

    for (let k = 1; k <= factor; k += 1) {
      const jr = jitter(seed, k) - 0.5;
      const jp = jitter(seed + 7, k) - 0.5;
      const jv = jitter(seed + 13, k) - 0.5;
      const newRow = {
        ...row,
        at: new Date().toISOString(),
        jobId: `${row.jobId}_aug${k}`,
        notes: "bootstrap augmented label",
        adjustRate: clamp(Number(row.adjustRate || 0) + Math.round(jr * 2), -6, 6),
        adjustPitch: clamp(Number(row.adjustPitch || 0) + Math.round(jp * 2), -6, 6),
        adjustVolume: clamp(Number(row.adjustVolume || 0) + Math.round(jv * 2), -6, 6),
        score: clamp(Number(row.score || 3) + Math.round((jr + jp + jv) * 0.8), 1, 5)
      };
      fs.appendFileSync(FEEDBACK_FILE, `${JSON.stringify(newRow)}\n`, "utf8");
      created += 1;
    }
  }

  console.log(`augment_created=${created}`);
  console.log(`source_bootstrap_rows=${base.length}`);
  console.log(`factor=${factor}`);
}

main();
