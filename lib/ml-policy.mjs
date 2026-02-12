import fs from "fs";
import path from "path";
import MLR from "ml-regression-multivariate-linear";

const MODEL_DIR = path.resolve(process.cwd(), "models");
const MODEL_PATH = path.join(MODEL_DIR, "prosody-policy-v1.json");

function ensureModelDir() {
  if (!fs.existsSync(MODEL_DIR)) fs.mkdirSync(MODEL_DIR, { recursive: true });
}

function countLetters(text) {
  return (text.match(/[a-zA-Z]/g) || []).length;
}

function countUpper(text) {
  return (text.match(/[A-Z]/g) || []).length;
}

function hasDigit(text) {
  return /\d/.test(text) ? 1 : 0;
}

function punctFlags(text) {
  return {
    q: /\?$/.test(text) ? 1 : 0,
    x: /!$/.test(text) ? 1 : 0,
    e: /\.\.\.$/.test(text) ? 1 : 0,
    d: /\.$/.test(text) ? 1 : 0
  };
}

function styleHash(style) {
  let h = 0;
  const s = String(style || "natural");
  for (let i = 0; i < s.length; i += 1) h = (h * 31 + s.charCodeAt(i)) % 997;
  return h / 997;
}

export function featureVector({ segment, idx, total, style }) {
  const text = segment.text || "";
  const punct = punctFlags(text);
  const letters = countLetters(text);
  const upper = countUpper(text);
  const upperRatio = letters > 0 ? upper / letters : 0;
  const words = text.trim() ? text.trim().split(/\s+/).length : 0;
  const pos = total > 1 ? idx / (total - 1) : 0;

  return [
    text.length,
    words,
    punct.d,
    punct.q,
    punct.x,
    punct.e,
    upperRatio,
    hasDigit(text),
    pos,
    Math.sin(pos * Math.PI),
    Math.cos(pos * Math.PI),
    segment.rate,
    segment.pitch,
    segment.volume,
    styleHash(style)
  ];
}

export function loadPolicyModel() {
  return loadPolicyModelFromPath(MODEL_PATH);
}

export function loadPolicyModelFromPath(modelPath) {
  const target = path.resolve(String(modelPath || MODEL_PATH));
  if (!fs.existsSync(target)) return null;
  const payload = JSON.parse(fs.readFileSync(target, "utf8"));
  return {
    meta: payload.meta,
    model: MLR.load(payload.model)
  };
}

export function savePolicyModel({ model, meta }) {
  return savePolicyModelToPath({ model, meta, modelPath: MODEL_PATH });
}

export function savePolicyModelToPath({ model, meta, modelPath }) {
  ensureModelDir();
  const target = path.resolve(String(modelPath || MODEL_PATH));
  const parent = path.dirname(target);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  const payload = {
    meta,
    model: model.toJSON()
  };
  fs.writeFileSync(target, JSON.stringify(payload, null, 2), "utf8");
  return target;
}

export function predictAdjustment(policy, context) {
  if (!policy?.model) return { dr: 0, dp: 0, dv: 0 };
  const feat = featureVector(context);
  const pred = policy.model.predict(feat);
  const [dr, dp, dv] = Array.isArray(pred) ? pred : [0, 0, 0];
  return {
    dr: Number.isFinite(dr) ? dr : 0,
    dp: Number.isFinite(dp) ? dp : 0,
    dv: Number.isFinite(dv) ? dv : 0
  };
}

export function trainPolicyModel({ samples }) {
  const x = [];
  const y = [];
  for (const item of samples) {
    if (!Array.isArray(item.features) || item.features.length === 0) continue;
    if (!Array.isArray(item.target) || item.target.length !== 3) continue;
    x.push(item.features);
    y.push(item.target);
  }
  if (x.length < 8) {
    return { status: "skipped", reason: "not_enough_samples", sampleCount: x.length };
  }
  const model = new MLR(x, y);
  return { status: "trained", model, sampleCount: x.length };
}

export const ML_POLICY_PATH = MODEL_PATH;
