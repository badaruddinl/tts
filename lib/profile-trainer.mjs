import fs from "fs";
import path from "path";
import {
  ensureTrainingDirs,
  loadActiveProfile,
  listProfileFiles,
  readProfileFile,
  setActiveProfileFile
} from "./profile-store.mjs";
import { filterValidRows, validateFeedbackRow } from "./ndjson-schema.mjs";

function readNdjson(filePath) {
  if (!fs.existsSync(filePath)) return [];
  const rows = fs
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
  return filterValidRows(rows, validateFeedbackRow);
}

function cloneProfile(profile) {
  return JSON.parse(JSON.stringify(profile));
}

function ensureStyle(profile, styleName) {
  if (!profile.styles[styleName]) {
    profile.styles[styleName] = cloneProfile(profile.styles[profile.defaultStyle]);
  }
  return profile.styles[styleName];
}

function adjustByScore(style, avgScore) {
  const delta = 3.6 - avgScore;
  if (delta <= 0) return;
  style.amplitude.rate = Math.min(12, Number(style.amplitude.rate) + delta * 0.8);
  style.amplitude.pitch = Math.min(6, Number(style.amplitude.pitch) + delta * 0.4);
  style.amplitude.volume = Math.min(5, Number(style.amplitude.volume) + delta * 0.5);
}

function applyKeywordHeuristic(style, notes) {
  const text = String(notes || "").toLowerCase();
  if (!text) return;
  if (text.includes("terlalu cepat")) style.base.rate -= 2;
  if (text.includes("terlalu lambat")) style.base.rate += 2;
  if (text.includes("terlalu tinggi") || text.includes("cempreng")) style.base.pitch -= 1;
  if (text.includes("terlalu rendah")) style.base.pitch += 1;
  if (text.includes("kurang emosi") || text.includes("datar") || text.includes("robot")) {
    style.amplitude.rate += 1.2;
    style.amplitude.pitch += 0.8;
    style.amplitude.volume += 0.8;
  }
  if (text.includes("terlalu keras")) style.base.volume -= 1;
  if (text.includes("terlalu pelan")) style.base.volume += 1;
}

function readRowText(row, snakeKey, camelKey = "") {
  const raw = row?.[snakeKey] ?? (camelKey ? row?.[camelKey] : undefined);
  return String(raw ?? "").trim();
}

function readRowNumber(row, snakeKey, camelKey = "", fallback = 0) {
  const raw = row?.[snakeKey] ?? (camelKey ? row?.[camelKey] : undefined);
  const n = Number(raw);
  return Number.isFinite(n) ? n : fallback;
}

function applyStructuredFeedback(style, row) {
  const intent = readRowText(row, "intent_target", "intentTarget").toLowerCase();
  const intensity = Math.max(0, Math.min(1, readRowNumber(row, "intensity_target", "intensityTarget", 0.5)));
  const transition = readRowText(row, "transition_note", "transitionNote").toLowerCase();
  const voiceFit = Math.max(1, Math.min(5, readRowNumber(row, "voice_fit", "voiceFit", 4)));

  const intensityScale = 0.6 + intensity * 0.8;
  if (intent === "tegang" || intent === "kaget") {
    style.base.rate -= 0.5 * intensityScale;
    style.base.pitch -= 0.4 * intensityScale;
    style.amplitude.rate += 0.7 * intensityScale;
    style.amplitude.volume += 0.5 * intensityScale;
  } else if (intent === "tenang" || intent === "sedih") {
    style.base.rate -= 0.5 * intensityScale;
    style.amplitude.rate += 0.25 * intensityScale;
    style.amplitude.pitch += 0.2 * intensityScale;
  } else if (intent === "tegas") {
    style.base.volume += 0.35 * intensityScale;
    style.base.pitch -= 0.25 * intensityScale;
  } else if (intent === "ceria") {
    style.base.rate += 0.35 * intensityScale;
    style.base.pitch += 0.35 * intensityScale;
    style.amplitude.pitch += 0.45 * intensityScale;
  }

  if (transition.includes("abrupt") || transition.includes("patah")) {
    style.amplitude.rate -= 0.25;
    style.amplitude.pitch -= 0.2;
  } else if (transition.includes("flat") || transition.includes("datar")) {
    style.amplitude.rate += 0.2;
    style.amplitude.pitch += 0.2;
  }

  if (voiceFit <= 2) {
    style.base.pitch -= 0.2;
    style.base.volume += 0.15;
  } else if (voiceFit >= 5) {
    style.amplitude.volume += 0.1;
  }
}

function clampStyle(style) {
  style.base.rate = Math.max(-25, Math.min(10, Number(style.base.rate)));
  style.base.pitch = Math.max(-12, Math.min(10, Number(style.base.pitch)));
  style.base.volume = Math.max(-10, Math.min(10, Number(style.base.volume)));
  style.amplitude.rate = Math.max(1, Math.min(15, Number(style.amplitude.rate)));
  style.amplitude.pitch = Math.max(0.5, Math.min(8, Number(style.amplitude.pitch)));
  style.amplitude.volume = Math.max(0.5, Math.min(6, Number(style.amplitude.volume)));
}

function getNextProfileFile() {
  const files = listProfileFiles();
  const nums = files
    .map((name) => {
      const m = name.match(/^v(\d+)\.json$/i);
      return m ? Number(m[1]) : 0;
    })
    .filter((n) => n > 0);
  const next = nums.length > 0 ? Math.max(...nums) + 1 : 1;
  return `v${next}.json`;
}

function train(profile, feedbackRows) {
  const out = cloneProfile(profile);
  const grouped = new Map();
  for (const row of feedbackRows) {
    const style = row.style || out.defaultStyle;
    if (!grouped.has(style)) grouped.set(style, []);
    grouped.get(style).push(row);
  }

  for (const [styleName, rows] of grouped.entries()) {
    const style = ensureStyle(out, styleName);
    const weighted = rows.map((r) => {
      const score = readRowNumber(r, "score", "", 3);
      const voiceFit = Math.max(1, Math.min(5, readRowNumber(r, "voice_fit", "voiceFit", 4)));
      return score * (0.75 + voiceFit / 10);
    });
    const avgScore = weighted.reduce((s, n) => s + n, 0) / Math.max(1, weighted.length);
    adjustByScore(style, avgScore);
    for (const row of rows) {
      applyKeywordHeuristic(style, row.notes);
      applyStructuredFeedback(style, row);
    }
    clampStyle(style);
  }
  return out;
}

export function trainProfileFromFeedback({
  apply = false,
  minFeedback = 1,
  feedbackFile = "",
  baseProfileFile = "",
  outputFile = ""
} = {}) {
  const trainingDir = ensureTrainingDirs();
  const feedbackFileDefault = path.join(trainingDir, "feedback.ndjson");
  const resolvedFeedbackFile = path.resolve(String(feedbackFile || feedbackFileDefault));
  const feedbackRows = readNdjson(resolvedFeedbackFile);
  const baseFile = String(baseProfileFile || "").trim();
  const active = baseFile
    ? {
        file: baseFile,
        profile: readProfileFile(baseFile)
      }
    : loadActiveProfile();
  const activeBefore = active.file;
  const outputCandidateFile = String(outputFile || "").trim();

  if (feedbackRows.length < minFeedback) {
    return {
      status: "skipped",
      reason: "not_enough_feedback",
      feedbackRows: feedbackRows.length,
      activeProfile: active.file
    };
  }

  const trained = train(active.profile, feedbackRows);
  const before = JSON.stringify(active.profile);
  const after = JSON.stringify(trained);
  if (before === after) {
    return {
      status: "skipped",
      reason: "no_profile_change",
      feedbackRows: feedbackRows.length,
      activeProfile: active.file
    };
  }

  const nextFile = outputCandidateFile || getNextProfileFile();
  trained.meta = trained.meta || {};
  trained.meta.id = path.basename(nextFile).replace(".json", "");
  trained.meta.trainedFrom = active.file;
  trained.meta.trainedAt = new Date().toISOString();
  trained.meta.feedbackCount = feedbackRows.length;
  trained.meta.feedbackFile = path.relative(process.cwd(), resolvedFeedbackFile).replace(/\\/g, "/");

  const target = path.resolve(process.cwd(), "config", "profiles", nextFile);
  fs.writeFileSync(target, JSON.stringify(trained, null, 2), "utf8");

  if (apply) {
    setActiveProfileFile(path.basename(nextFile));
  }

  return {
    status: "trained",
    file: path.basename(nextFile),
    from: active.file,
    feedbackRows: feedbackRows.length,
    applied: apply,
    feedbackFile: path.relative(process.cwd(), resolvedFeedbackFile).replace(/\\/g, "/"),
    activeBefore
  };
}
