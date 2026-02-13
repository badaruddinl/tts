import fs from "fs";
import path from "path";
import MLR from "ml-regression-multivariate-linear";

const MODEL_DIR = path.resolve(process.cwd(), "models");
const MODEL_PATH = path.join(MODEL_DIR, "limiter-policy-v1.json");

function ensureModelDir() {
  if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR, { recursive: true });
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function toNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function styleHash(style) {
  let h = 0;
  const s = String(style || "natural");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h / 997;
}

function hasAny(text, words) {
  const t = String(text || "").toLowerCase();
  return words.some((w) => t.includes(w));
}

function resolveProsodyPath(row) {
  if (!row?.prosodyFile) return null;
  const p = path.resolve(process.cwd(), "outputs", row.prosodyFile);
  return fs.existsSync(p) ? p : null;
}

function transitionScore(segments) {
  if (!Array.isArray(segments) || segments.length <= 1) return 0;
  let acc = 0;
  for (let i = 1; i < segments.length; i += 1) {
    const a = segments[i - 1] || {};
    const b = segments[i] || {};
    const av = a.final || a;
    const bv = b.final || b;
    acc +=
      Math.abs(toNum(bv.rate) - toNum(av.rate)) +
      Math.abs(toNum(bv.pitch) - toNum(av.pitch)) +
      Math.abs(toNum(bv.volume) - toNum(av.volume));
  }
  return acc / (segments.length - 1);
}

function prosodyEnergy(segments) {
  if (!Array.isArray(segments) || segments.length === 0) return 0;
  let acc = 0;
  for (const s of segments) {
    const v = s?.final || s || {};
    acc += Math.abs(toNum(v.rate)) + Math.abs(toNum(v.pitch)) + Math.abs(toNum(v.volume));
  }
  return acc / segments.length;
}

function readProsodyStats(row) {
  const fp = resolveProsodyPath(row);
  if (!fp) return null;
  try {
    const payload = JSON.parse(fs.readFileSync(fp, "utf8"));
    const segments = Array.isArray(payload?.segments) ? payload.segments : [];
    if (!segments.length) return null;
    return {
      transition: transitionScore(segments),
      energy: prosodyEnergy(segments),
      segCount: segments.length
    };
  } catch {
    return null;
  }
}

function inferTargetStrength(row, stats) {
  const notes = String(row?.notes || "").toLowerCase();
  const transitionNote = String(row?.transition_note ?? row?.transitionNote ?? "").toLowerCase();
  const score = clamp(toNum(row?.score, 3), 1, 5);
  let target = 0.64;

  // Too flat/robotic => lower limiter (more dynamics).
  if (hasAny(notes, ["robot", "datar", "kurang emosi", "flat"])) target -= 0.1;
  // Too abrupt/jerky => higher limiter.
  if (hasAny(notes, ["patah", "kasar", "terlalu cepat", "berlebihan"]) || transitionNote.includes("abrupt")) {
    target += 0.08;
  }
  if (hasAny(notes, ["terlalu lambat", "kurang tegas"])) target -= 0.04;
  if (transitionNote.includes("flat") || transitionNote.includes("datar")) target -= 0.05;

  const tr = toNum(stats?.transition, 0);
  const en = toNum(stats?.energy, 0);
  if (tr > 8.5) target += 0.06;
  if (tr < 4.5) target -= 0.04;
  if (en > 20) target += 0.04;
  if (en < 8) target -= 0.05;

  // Very low score pushes stronger correction but keep bounded.
  target += (3 - score) * 0.015;
  return clamp(target, 0.45, 0.9);
}

export function limiterFeatureVector({ row, stats, style }) {
  const notes = String(row?.notes || "").toLowerCase();
  const transitionNote = String(row?.transition_note ?? row?.transitionNote ?? "").toLowerCase();
  const score = clamp(toNum(row?.score, 3), 1, 5);
  const voiceFit = clamp(toNum(row?.voice_fit ?? row?.voiceFit, 4), 1, 5);
  const intensityTarget = clamp(toNum(row?.intensity_target ?? row?.intensityTarget, 0.6), 0, 1);
  const st = String(style || row?.style || "natural");

  return [
    toNum(stats?.transition, 0),
    toNum(stats?.energy, 0),
    toNum(stats?.segCount, 0),
    score / 5,
    voiceFit / 5,
    intensityTarget,
    styleHash(st),
    hasAny(notes, ["robot", "datar", "flat", "kurang emosi"]) ? 1 : 0,
    hasAny(notes, ["terlalu cepat", "patah", "kasar", "berlebihan"]) ? 1 : 0,
    hasAny(notes, ["terlalu lambat", "kurang tegas"]) ? 1 : 0,
    transitionNote.includes("abrupt") ? 1 : 0,
    transitionNote.includes("flat") || transitionNote.includes("datar") ? 1 : 0
  ];
}

export function buildLimiterSamples(rows, { style = "" } = {}) {
  const normalizedStyle = String(style || "").trim().toLowerCase();
  const samples = [];
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const rowStyle = String(row.style || "").trim().toLowerCase();
    if (normalizedStyle && rowStyle && rowStyle !== normalizedStyle) continue;
    const stats = readProsodyStats(row);
    if (!stats) continue;
    const feature = limiterFeatureVector({ row, stats, style: rowStyle || normalizedStyle || "natural" });
    const target = inferTargetStrength(row, stats);
    samples.push({ features: feature, target: [target], style: rowStyle || "natural" });
  }
  return samples;
}

export function trainLimiterPolicyModel({ samples }) {
  const x = [];
  const y = [];
  for (const s of samples || []) {
    if (!Array.isArray(s.features) || s.features.length === 0) continue;
    if (!Array.isArray(s.target) || s.target.length !== 1) continue;
    x.push(s.features);
    y.push(s.target);
  }
  if (x.length < 10) {
    return { status: "skipped", reason: "not_enough_samples", sampleCount: x.length };
  }
  const model = new MLR(x, y);
  return { status: "trained", model, sampleCount: x.length };
}

export function saveLimiterPolicyModel({ model, meta, modelPath = MODEL_PATH }) {
  ensureModelDir();
  const target = path.resolve(String(modelPath || MODEL_PATH));
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(
    target,
    JSON.stringify(
      {
        modelType: "mlr_js_v1",
        meta,
        model: model.toJSON()
      },
      null,
      2
    ),
    "utf8"
  );
  return target;
}

export function loadLimiterPolicyModel(modelPath = MODEL_PATH) {
  const target = path.resolve(String(modelPath || MODEL_PATH));
  if (!fs.existsSync(target)) return null;
  const payload = JSON.parse(fs.readFileSync(target, "utf8"));
  return {
    meta: payload?.meta || null,
    model: payload?.model ? MLR.load(payload.model) : null
  };
}

export function predictLimiterStrength(policy, featureVec, fallback = 0.64) {
  if (!policy?.model || !Array.isArray(featureVec) || !featureVec.length) {
    return clamp(toNum(fallback, 0.64), 0.45, 0.9);
  }
  const pred = policy.model.predict(featureVec);
  const raw = Array.isArray(pred) ? toNum(pred[0], fallback) : fallback;
  return clamp(raw, 0.45, 0.9);
}

export function summarizeRowsForStyle(rows, style = "") {
  const normalizedStyle = String(style || "").trim().toLowerCase();
  const picked = (rows || []).filter((r) => {
    const rs = String(r?.style || "").trim().toLowerCase();
    return !normalizedStyle || !rs || rs === normalizedStyle;
  });
  if (!picked.length) return null;

  const stats = [];
  for (const row of picked) {
    const st = readProsodyStats(row);
    if (st) stats.push(st);
  }
  if (!stats.length) return null;

  const avg = (arr, key) => arr.reduce((s, it) => s + toNum(it[key], 0), 0) / arr.length;
  return {
    transition: avg(stats, "transition"),
    energy: avg(stats, "energy"),
    segCount: avg(stats, "segCount"),
    score: avg(picked, "score"),
    voiceFit: avg(picked.map((r) => ({ v: toNum(r?.voice_fit ?? r?.voiceFit, 4) })), "v"),
    intensityTarget: avg(picked.map((r) => ({ v: toNum(r?.intensity_target ?? r?.intensityTarget, 0.6) })), "v"),
    notes: picked.map((r) => String(r?.notes || "")).join(" | "),
    transitionNote: picked.map((r) => String(r?.transition_note ?? r?.transitionNote ?? "")).join(" | "),
    style: normalizedStyle || String(picked[0]?.style || "natural")
  };
}

export function summarizeToFeatureVector(summary) {
  if (!summary) return null;
  return limiterFeatureVector({
    row: {
      notes: summary.notes,
      transition_note: summary.transitionNote,
      score: summary.score,
      voice_fit: summary.voiceFit,
      intensity_target: summary.intensityTarget,
      style: summary.style
    },
    stats: {
      transition: summary.transition,
      energy: summary.energy,
      segCount: summary.segCount
    },
    style: summary.style
  });
}

export const LIMITER_POLICY_PATH = MODEL_PATH;
