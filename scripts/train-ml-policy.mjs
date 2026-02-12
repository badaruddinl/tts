import fs from "fs";
import path from "path";
import { trainPolicyModel, savePolicyModel, featureVector, ML_POLICY_PATH } from "../lib/ml-policy.mjs";

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

function sanitizeStyle(style) {
  return String(style || "")
    .toLowerCase()
    .replace(/[^a-z0-9-_]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function resolveProsodyPath(row) {
  if (!row?.prosodyFile) return null;
  const p = path.resolve(process.cwd(), "outputs", row.prosodyFile);
  return fs.existsSync(p) ? p : null;
}

function asNum(value, fallback = 0) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function pickNum(row, snakeKey, camelKey = "", fallback = 0) {
  const v = row?.[snakeKey] ?? (camelKey ? row?.[camelKey] : undefined);
  return asNum(v, fallback);
}

function buildSamples(feedbackRows) {
  const samples = [];
  for (const row of feedbackRows) {
    const filePath = resolveProsodyPath(row);
    if (!filePath) continue;
    const prosody = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const segments = Array.isArray(prosody.segments) ? prosody.segments : [];
    if (segments.length === 0) continue;

    const score = asNum(row.score, 3);
    const intensityTarget = Math.max(0, Math.min(1, pickNum(row, "intensity_target", "intensityTarget", 0.6)));
    const voiceFit = Math.max(1, Math.min(5, pickNum(row, "voice_fit", "voiceFit", 4)));
    const confBase = Math.max(0.4, Math.min(1.2, (6 - score) / 3));
    const conf = confBase * (0.7 + intensityTarget * 0.5) * (0.8 + voiceFit / 10);
    const baseRateAdj = asNum(row.adjustRate, 0);
    const basePitchAdj = asNum(row.adjustPitch, 0);
    const baseVolumeAdj = asNum(row.adjustVolume, 0);
    const style = row.style || prosody.style || "natural";

    for (let i = 0; i < segments.length; i += 1) {
      const seg = segments[i];
      const punctQ = /\?$/.test(seg.text || "");
      const punctX = /!$/.test(seg.text || "");
      const punctE = /\.\.\.$/.test(seg.text || "");

      let dr = baseRateAdj;
      let dp = basePitchAdj;
      let dv = baseVolumeAdj;
      if (punctQ) {
        dr += 0.35 * baseRateAdj;
        dp += 0.5 * basePitchAdj;
      }
      if (punctX) {
        dr += 0.4 * baseRateAdj;
        dp += 0.35 * basePitchAdj;
        dv += 0.3 * baseVolumeAdj;
      }
      if (punctE) {
        dr -= 0.3 * baseRateAdj;
        dp -= 0.2 * basePitchAdj;
      }

      samples.push({
        features: featureVector({
          segment: seg,
          idx: i,
          total: segments.length,
          style
        }),
        target: [dr * conf, dp * conf, dv * conf]
      });
    }
  }
  return samples;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const style = sanitizeStyle(args.style || "");
  const feedbackPath = style
    ? path.resolve(process.cwd(), "data", "training", "styles", style, "feedback.ndjson")
    : path.resolve(process.cwd(), "data", "training", "feedback.ndjson");
  const feedbackRows = readNdjson(feedbackPath);
  const withAdjust = feedbackRows.filter((r) => {
    const r0 = asNum(r.adjustRate, 0);
    const p0 = asNum(r.adjustPitch, 0);
    const v0 = asNum(r.adjustVolume, 0);
    return r0 !== 0 || p0 !== 0 || v0 !== 0;
  });

  const samples = buildSamples(withAdjust);
  const result = trainPolicyModel({ samples });
  if (result.status !== "trained") {
    console.log(`ML training skipped: ${result.reason} (${result.sampleCount} samples)`);
    return;
  }

  const meta = {
    createdAt: new Date().toISOString(),
    sampleCount: result.sampleCount,
    sourceFeedbackRows: withAdjust.length,
    version: "prosody-policy-v1",
    styleScope: style || "all"
  };
  const saved = savePolicyModel({ model: result.model, meta });
  console.log(`ML policy trained: ${saved}`);
  console.log(`Model path const: ${ML_POLICY_PATH}`);
  console.log(`Samples: ${result.sampleCount}`);
}

main();
