import fs from "fs";
import path from "path";
import { readNdjson } from "../lib/ml-policy-dataset.mjs";

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

function mulberry32(seed) {
  let t = seed >>> 0;
  return function rand() {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), t | 1);
    r ^= r + Math.imul(r ^ (r >>> 7), r | 61);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function stableShuffle(items, seed) {
  const out = [...items];
  const rand = mulberry32(seed);
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i];
    out[i] = out[j];
    out[j] = tmp;
  }
  return out;
}

function parseRatios(input) {
  const chunks = String(input || "0.8,0.1,0.1")
    .split(",")
    .map((n) => Number(n));
  if (chunks.length !== 3 || chunks.some((n) => !Number.isFinite(n) || n <= 0)) {
    throw new Error(`Invalid ratios: ${input}`);
  }
  const sum = chunks.reduce((s, n) => s + n, 0);
  return chunks.map((n) => n / sum);
}

function writeNdjson(filePath, rows) {
  const target = path.resolve(filePath);
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const lines = rows.map((r) => JSON.stringify(r));
  fs.writeFileSync(target, `${lines.join("\n")}${lines.length ? "\n" : ""}`, "utf8");
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceFile = path.resolve(String(args.source || "data/training/feedback.ndjson"));
  const outDir = path.resolve(String(args.outdir || "data/training/splits/ml"));
  const seed = Number(args.seed ?? 42);
  const ratios = parseRatios(args.ratios || "0.8,0.1,0.1");

  const rows = readNdjson(sourceFile);
  if (!rows.length) {
    throw new Error(`No rows found: ${sourceFile}`);
  }

  const shuffled = stableShuffle(rows, Number.isFinite(seed) ? seed : 42);
  const total = shuffled.length;
  if (total < 3) {
    const train = shuffled;
    const valid = [];
    const test = [];
    writeNdjson(path.join(outDir, "train.ndjson"), train);
    writeNdjson(path.join(outDir, "valid.ndjson"), valid);
    writeNdjson(path.join(outDir, "test.ndjson"), test);
    const manifest = {
      createdAt: new Date().toISOString(),
      sourceFile: path.relative(process.cwd(), sourceFile).replace(/\\/g, "/"),
      seed: Number.isFinite(seed) ? seed : 42,
      ratios: {
        train: Number(ratios[0].toFixed(6)),
        valid: Number(ratios[1].toFixed(6)),
        test: Number(ratios[2].toFixed(6))
      },
      counts: {
        total,
        train: train.length,
        valid: 0,
        test: 0
      }
    };
    fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
    console.log(
      `train_split_done total=${manifest.counts.total} train=${manifest.counts.train} valid=0 test=0 dir=${path.relative(process.cwd(), outDir)}`
    );
    return;
  }
  const trainCount = Math.max(1, Math.floor(total * ratios[0]));
  const validCount = Math.max(1, Math.floor(total * ratios[1]));
  const cappedTrain = Math.min(trainCount, Math.max(1, total - 2));
  const cappedValid = Math.min(validCount, Math.max(1, total - cappedTrain - 1));
  const testCount = Math.max(1, total - cappedTrain - cappedValid);

  const train = shuffled.slice(0, cappedTrain);
  const valid = shuffled.slice(cappedTrain, cappedTrain + cappedValid);
  const test = shuffled.slice(cappedTrain + cappedValid, cappedTrain + cappedValid + testCount);

  writeNdjson(path.join(outDir, "train.ndjson"), train);
  writeNdjson(path.join(outDir, "valid.ndjson"), valid);
  writeNdjson(path.join(outDir, "test.ndjson"), test);
  const manifest = {
    createdAt: new Date().toISOString(),
    sourceFile: path.relative(process.cwd(), sourceFile).replace(/\\/g, "/"),
    seed: Number.isFinite(seed) ? seed : 42,
    ratios: {
      train: Number(ratios[0].toFixed(6)),
      valid: Number(ratios[1].toFixed(6)),
      test: Number(ratios[2].toFixed(6))
    },
    counts: {
      total,
      train: train.length,
      valid: valid.length,
      test: test.length
    }
  };
  fs.writeFileSync(path.join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2), "utf8");
  console.log(
    `train_split_done total=${manifest.counts.total} train=${manifest.counts.train} valid=${manifest.counts.valid} test=${manifest.counts.test} dir=${path.relative(process.cwd(), outDir)}`
  );
}

main();
