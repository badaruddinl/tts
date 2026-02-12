import fs from "fs";
import path from "path";

const ROOT = process.cwd();
const TRAIN_DIR = path.resolve(ROOT, "data", "training");

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
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

function dedupeFile(filePath) {
  const rows = readNdjson(filePath);
  if (!rows.length) return { filePath, before: 0, after: 0 };
  const uniq = new Map();
  for (const row of rows) {
    const id = String(row?.jobId || "").trim();
    if (!id) continue;
    if (!uniq.has(id)) uniq.set(id, row);
  }
  const out = [...uniq.values()];
  writeNdjson(filePath, out);
  return { filePath, before: rows.length, after: out.length };
}

function main() {
  if (!fs.existsSync(TRAIN_DIR)) {
    console.log("dedupe_skipped=no_training_dir");
    return;
  }
  const targets = [
    path.join(TRAIN_DIR, "jobs.ndjson"),
    path.join(TRAIN_DIR, "feedback.ndjson")
  ];

  const stylesRoot = path.join(TRAIN_DIR, "styles");
  if (fs.existsSync(stylesRoot)) {
    const dirs = fs.readdirSync(stylesRoot, { withFileTypes: true }).filter((d) => d.isDirectory());
    for (const d of dirs) {
      targets.push(path.join(stylesRoot, d.name, "jobs.ndjson"));
      targets.push(path.join(stylesRoot, d.name, "feedback.ndjson"));
    }
  }

  let changed = 0;
  for (const filePath of targets) {
    if (!fs.existsSync(filePath)) continue;
    const res = dedupeFile(filePath);
    if (res.before !== res.after) changed += 1;
    console.log(`${path.relative(ROOT, filePath)} before=${res.before} after=${res.after}`);
  }
  console.log(`dedupe_changed_files=${changed}`);
}

main();
