function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isString(value) {
  return typeof value === "string";
}

function isNumber(value) {
  return typeof value === "number" && Number.isFinite(value);
}

function hasKey(obj, key) {
  return Object.prototype.hasOwnProperty.call(obj, key);
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

export function validateFeedbackRow(row) {
  if (!isPlainObject(row)) return { ok: false, reason: "not_object" };
  if (!isString(row.at) || !row.at) return { ok: false, reason: "missing_at" };
  if (!isString(row.jobId) || !row.jobId) return { ok: false, reason: "missing_jobId" };
  if (!isNumber(row.score) || row.score < 1 || row.score > 5) return { ok: false, reason: "bad_score" };
  if (!isString(row.mode) || (row.mode !== "humanize" && row.mode !== "normal")) {
    return { ok: false, reason: "bad_mode" };
  }
  if (!isString(row.outputFile) || !row.outputFile) return { ok: false, reason: "missing_outputFile" };
  if (hasKey(row, "prosodyFile") && row.prosodyFile !== null && !isString(row.prosodyFile)) {
    return { ok: false, reason: "bad_prosodyFile" };
  }
  if (hasKey(row, "style") && row.style !== null && !isString(row.style)) {
    return { ok: false, reason: "bad_style" };
  }
  if (hasKey(row, "humanizeIntensity") && row.humanizeIntensity !== null) {
    if (!isNumber(row.humanizeIntensity)) return { ok: false, reason: "bad_humanizeIntensity" };
    row.humanizeIntensity = clamp(row.humanizeIntensity, 0, 1);
  }
  if (hasKey(row, "adjustRate") && row.adjustRate !== null && !isNumber(row.adjustRate)) {
    return { ok: false, reason: "bad_adjustRate" };
  }
  if (hasKey(row, "adjustPitch") && row.adjustPitch !== null && !isNumber(row.adjustPitch)) {
    return { ok: false, reason: "bad_adjustPitch" };
  }
  if (hasKey(row, "adjustVolume") && row.adjustVolume !== null && !isNumber(row.adjustVolume)) {
    return { ok: false, reason: "bad_adjustVolume" };
  }
  if (hasKey(row, "intent_target") && row.intent_target !== null && !isString(row.intent_target)) {
    return { ok: false, reason: "bad_intent_target" };
  }
  if (hasKey(row, "intensity_target") && row.intensity_target !== null) {
    if (!isNumber(row.intensity_target)) return { ok: false, reason: "bad_intensity_target" };
    row.intensity_target = clamp(row.intensity_target, 0, 1);
  }
  if (hasKey(row, "transition_note") && row.transition_note !== null && !isString(row.transition_note)) {
    return { ok: false, reason: "bad_transition_note" };
  }
  if (hasKey(row, "voice_fit") && row.voice_fit !== null) {
    if (!isNumber(row.voice_fit)) return { ok: false, reason: "bad_voice_fit" };
    row.voice_fit = clamp(row.voice_fit, 1, 5);
  }
  if (hasKey(row, "notes") && row.notes !== null && !isString(row.notes)) {
    return { ok: false, reason: "bad_notes" };
  }
  return { ok: true };
}

export function validateTrainingJobRow(row) {
  if (!isPlainObject(row)) return { ok: false, reason: "not_object" };
  if (!isString(row.at) || !row.at) return { ok: false, reason: "missing_at" };
  if (!isString(row.jobId) || !row.jobId) return { ok: false, reason: "missing_jobId" };
  if (!isString(row.voice) || !row.voice) return { ok: false, reason: "missing_voice" };
  if (!isString(row.mode) || (row.mode !== "humanize" && row.mode !== "normal")) {
    return { ok: false, reason: "bad_mode" };
  }
  if (hasKey(row, "style") && row.style !== null && !isString(row.style)) {
    return { ok: false, reason: "bad_style" };
  }
  if (hasKey(row, "profileFile") && row.profileFile !== null && !isString(row.profileFile)) {
    return { ok: false, reason: "bad_profileFile" };
  }
  if (hasKey(row, "intensity") && row.intensity !== null) {
    if (!isNumber(row.intensity)) return { ok: false, reason: "bad_intensity" };
    row.intensity = clamp(row.intensity, 0, 1);
  }
  if (!isString(row.outputFile) || !row.outputFile) return { ok: false, reason: "missing_outputFile" };
  if (hasKey(row, "prosodyFile") && row.prosodyFile !== null && !isString(row.prosodyFile)) {
    return { ok: false, reason: "bad_prosodyFile" };
  }
  return { ok: true };
}

export function filterValidRows(rows, validator) {
  const out = [];
  for (const row of rows) {
    const res = validator(row);
    if (res.ok) out.push(row);
  }
  return out;
}
