const textEl = document.getElementById("text");
const tabNormalEl = document.getElementById("tabNormal");
const tabTrainingEl = document.getElementById("tabTraining");
const panelNormalEl = document.getElementById("panelNormal");
const panelTrainingEl = document.getElementById("panelTraining");
const voiceEl = document.getElementById("voice");
const styleEl = document.getElementById("style");
const speechStyleEl = document.getElementById("speechStyle");
const voiceToneEl = document.getElementById("voiceTone");
const voiceCharacterEl = document.getElementById("voiceCharacter");
const rateEl = document.getElementById("rate");
const pitchEl = document.getElementById("pitch");
const volumeEl = document.getElementById("volume");
const rateValueEl = document.getElementById("rateValue");
const pitchValueEl = document.getElementById("pitchValue");
const volumeValueEl = document.getElementById("volumeValue");
const outputNameEl = document.getElementById("outputName");
const humanizeEl = document.getElementById("humanize");
const humanizeIntensityEl = document.getElementById("humanizeIntensity");
const humanizeIntensityValueEl = document.getElementById("humanizeIntensityValue");
const generateBtn = document.getElementById("generateBtn");
const statusEl = document.getElementById("status");
const jobEl = document.getElementById("job");
const profileInfoEl = document.getElementById("profileInfo");
const audioPreviewEl = document.getElementById("audioPreview");
const downloadEl = document.getElementById("download");
const downloadProsodyEl = document.getElementById("downloadProsody");
const logsEl = document.getElementById("logs");
const feedbackScoreEl = document.getElementById("feedbackScore");
const feedbackNotesEl = document.getElementById("feedbackNotes");
const feedbackBtnEl = document.getElementById("feedbackBtn");
const feedbackBoxEl = document.getElementById("feedbackBox");
const adjustRateEl = document.getElementById("adjustRate");
const adjustPitchEl = document.getElementById("adjustPitch");
const adjustVolumeEl = document.getElementById("adjustVolume");
const adjustRateValueEl = document.getElementById("adjustRateValue");
const adjustPitchValueEl = document.getElementById("adjustPitchValue");
const adjustVolumeValueEl = document.getElementById("adjustVolumeValue");
const intentTargetEl = document.getElementById("intentTarget");
const intensityTargetEl = document.getElementById("intensityTarget");
const intensityTargetValueEl = document.getElementById("intensityTargetValue");
const transitionNoteEl = document.getElementById("transitionNote");
const voiceFitEl = document.getElementById("voiceFit");
const voiceFitValueEl = document.getElementById("voiceFitValue");
const trainingProfileEl = document.getElementById("trainingProfile");
const trainingStyleEl = document.getElementById("trainingStyle");
const trainingVoiceEl = document.getElementById("trainingVoice");
const trainingSpeechStyleEl = document.getElementById("trainingSpeechStyle");
const trainingVoiceToneEl = document.getElementById("trainingVoiceTone");
const trainingVoiceCharacterEl = document.getElementById("trainingVoiceCharacter");
const trainingIntensityEl = document.getElementById("trainingIntensity");
const trainingIntensityValueEl = document.getElementById("trainingIntensityValue");
const trainingOutputNameEl = document.getElementById("trainingOutputName");
const runTrainingBtnEl = document.getElementById("runTrainingBtn");
const runFullPipelineBtnEl = document.getElementById("runFullPipelineBtn");
const runFullPipelineLoopBtnEl = document.getElementById("runFullPipelineLoopBtn");
const stopFullPipelineBtnEl = document.getElementById("stopFullPipelineBtn");

let pollingTimer = null;
let currentJobId = null;
let currentPipelineRunId = null;
let activeTab = "normal";

async function refreshProfileState(preferredProfile = "") {
  const [profileRes, styleRes] = await Promise.all([
    fetch("/api/profiles"),
    fetch(`/api/styles?profile=${encodeURIComponent(preferredProfile || "")}`)
  ]);
  const profileData = await profileRes.json();
  const styleData = await styleRes.json();
  if (!profileRes.ok || !styleRes.ok) return;

  const profiles = Array.isArray(profileData.profiles) ? profileData.profiles : [];
  const prevProfile = trainingProfileEl.value;
  trainingProfileEl.innerHTML = profiles.map((p) => `<option value="${p}">${p}</option>`).join("");
  trainingProfileEl.value = preferredProfile || profileData.activeProfile || prevProfile || profiles[0] || "";

  const styles = Array.isArray(styleData.styles) ? styleData.styles : ["natural"];
  const prevStyle = trainingStyleEl.value;
  trainingStyleEl.innerHTML = styles.map((s) => `<option value="${s}">${s}</option>`).join("");
  trainingStyleEl.value = styleData.defaultStyle || prevStyle || styles[0] || "natural";

  profileInfoEl.textContent = `Active profile: ${profileData.activeProfile || "-"}`;
}

function updateHumanizeMode() {
  const active = humanizeEl.checked;
  rateEl.disabled = active;
  pitchEl.disabled = active;
  volumeEl.disabled = active;
}

function switchTab(nextTab) {
  activeTab = nextTab;
  const normal = nextTab === "normal";
  panelNormalEl.hidden = !normal;
  panelTrainingEl.hidden = normal;
  feedbackBoxEl.hidden = normal;
  tabNormalEl.classList.toggle("active", normal);
  tabTrainingEl.classList.toggle("active", !normal);
}

function parsePercentToNumber(value) {
  const n = Number(String(value || "0").replace("%", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function parseHzToNumber(value) {
  const n = Number(String(value || "0").replace("Hz", "").trim());
  return Number.isFinite(n) ? n : 0;
}

function pct(value) {
  return `${Number(value)}%`;
}

function hz(value) {
  return `${Number(value)}Hz`;
}

function setStatus(message) {
  statusEl.textContent = `Status: ${message}`;
}

function renderEvents(events) {
  if (!events || events.length === 0) {
    logsEl.textContent = "";
    return;
  }
  logsEl.textContent = events
    .map((e) => `[${e.at}] [${e.level}] ${e.message}`)
    .join("\n");
}

function stopPolling() {
  if (pollingTimer) {
    clearInterval(pollingTimer);
    pollingTimer = null;
  }
}

async function pollPipeline(runId) {
  const res = await fetch(`/api/pipeline/${runId}`);
  const data = await res.json();
  if (!res.ok) {
    setStatus(`pipeline error (${data.error || "unknown"})`);
    stopPolling();
    runFullPipelineBtnEl.disabled = false;
    runFullPipelineLoopBtnEl.disabled = false;
    stopFullPipelineBtnEl.disabled = true;
    return;
  }
  setStatus(`pipeline ${data.status} (${data.mode || "single"})`);
  jobEl.textContent = `Pipeline: ${runId}`;
  renderEvents(data.logs);
  if (data.status !== "running") {
    stopPolling();
    runFullPipelineBtnEl.disabled = false;
    runFullPipelineLoopBtnEl.disabled = false;
    stopFullPipelineBtnEl.disabled = true;
  }
}

async function loadDefaults() {
  const [cfgRes, voiceRes, styleRes, profileRes] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/voices"),
    fetch("/api/styles"),
    fetch("/api/profiles")
  ]);
  const cfgData = await cfgRes.json();
  const voiceData = await voiceRes.json();
  const styleData = await styleRes.json();
  const profileData = await profileRes.json();

  const voices = Array.isArray(voiceData.voices) ? voiceData.voices : [];
  if (voices.length === 0) {
    const fallback = cfgData.defaults.voice || "id-ID-GadisNeural";
    voiceEl.innerHTML = `<option value="${fallback}">${fallback}</option>`;
  } else {
    voiceEl.innerHTML = voices.map((v) => `<option value="${v}">${v}</option>`).join("");
    trainingVoiceEl.innerHTML = voices.map((v) => `<option value="${v}">${v}</option>`).join("");
  }
  voiceEl.value = cfgData.defaults.voice;
  if (!voiceEl.value && voiceEl.options.length > 0) {
    voiceEl.value = voiceEl.options[0].value;
  }
  trainingVoiceEl.value = voiceEl.value;

  rateEl.value = String(parsePercentToNumber(cfgData.defaults.rate));
  pitchEl.value = String(parseHzToNumber(cfgData.defaults.pitch));
  volumeEl.value = String(parsePercentToNumber(cfgData.defaults.volume));
  humanizeEl.checked = Boolean(cfgData.defaults.humanize);
  humanizeIntensityEl.value = String(cfgData.defaults.humanizeIntensity ?? 0.45);
  const styles = Array.isArray(styleData.styles) ? styleData.styles : ["natural"];
  styleEl.innerHTML = styles.map((s) => `<option value="${s}">${s}</option>`).join("");
  styleEl.value = cfgData.defaults.style || styleData.defaultStyle || styles[0] || "natural";
  speechStyleEl.value = cfgData.defaults.speechStyle || "auto";
  voiceToneEl.value = cfgData.defaults.voiceTone || "auto";
  voiceCharacterEl.checked = Boolean(cfgData.defaults.voiceCharacter ?? true);
  trainingStyleEl.innerHTML = styles.map((s) => `<option value="${s}">${s}</option>`).join("");
  trainingStyleEl.value = styleEl.value;
  trainingSpeechStyleEl.value = speechStyleEl.value || "auto";
  trainingVoiceToneEl.value = voiceToneEl.value || "auto";
  trainingVoiceCharacterEl.checked = voiceCharacterEl.checked;
  const profiles = Array.isArray(profileData.profiles) ? profileData.profiles : [];
  trainingProfileEl.innerHTML = profiles.map((p) => `<option value="${p}">${p}</option>`).join("");
  trainingProfileEl.value = profileData.activeProfile || "";
  trainingIntensityEl.value = String(cfgData.defaults.humanizeIntensity ?? 0.45);
  trainingIntensityValueEl.textContent = String(trainingIntensityEl.value);
  profileInfoEl.textContent = `Active profile: ${styleData.activeProfile || cfgData.activeProfile || "-"}`;
  rateValueEl.textContent = pct(rateEl.value);
  pitchValueEl.textContent = hz(pitchEl.value);
  volumeValueEl.textContent = pct(volumeEl.value);
  humanizeIntensityValueEl.textContent = String(humanizeIntensityEl.value);
  updateHumanizeMode();
}

async function reloadTrainingStyles(profileFile) {
  const qp = encodeURIComponent(profileFile || "");
  const res = await fetch(`/api/styles?profile=${qp}`);
  const data = await res.json();
  if (!res.ok) return;
  const styles = Array.isArray(data.styles) ? data.styles : ["natural"];
  trainingStyleEl.innerHTML = styles.map((s) => `<option value="${s}">${s}</option>`).join("");
  trainingStyleEl.value = data.defaultStyle || styles[0] || "natural";
}

async function pollJob(jobId) {
  const res = await fetch(`/api/jobs/${jobId}`);
  const data = await res.json();
  jobEl.textContent = `Job: ${jobId}`;
  setStatus(data.status);

  if (data.status === "completed") {
    stopPolling();
    downloadEl.hidden = false;
    downloadEl.href = data.downloadUrl;
    downloadEl.textContent = "Download MP3";
    audioPreviewEl.hidden = false;
    audioPreviewEl.src = `/api/jobs/${jobId}/audio-stream`;
    audioPreviewEl.load();
    if (data.prosodyUrl) {
      downloadProsodyEl.hidden = false;
      downloadProsodyEl.href = data.prosodyUrl;
      downloadProsodyEl.textContent = "Download Prosody JSON";
    } else {
      downloadProsodyEl.hidden = true;
    }
    generateBtn.disabled = false;
    feedbackBtnEl.disabled = false;
    currentJobId = jobId;
  } else if (data.status === "failed") {
    stopPolling();
    generateBtn.disabled = false;
    downloadEl.hidden = true;
    downloadProsodyEl.hidden = true;
    audioPreviewEl.hidden = true;
    audioPreviewEl.removeAttribute("src");
    setStatus(`failed (${data.error || "unknown error"})`);
    feedbackBtnEl.disabled = true;
  }
  renderEvents(data.events);
}

async function submitJob() {
  const text = textEl.value.trim();
  if (!text) {
    setStatus("text is required");
    return;
  }

  generateBtn.disabled = true;
  downloadEl.hidden = true;
  downloadProsodyEl.hidden = true;
  audioPreviewEl.hidden = true;
  audioPreviewEl.removeAttribute("src");
  feedbackBtnEl.disabled = true;
  setStatus("submitting");

  const res = await fetch("/api/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      voice: voiceEl.value.trim(),
      rate: pct(rateEl.value),
      pitch: hz(pitchEl.value),
      volume: pct(volumeEl.value),
      outputName: outputNameEl.value.trim(),
      humanize: humanizeEl.checked,
      humanizeIntensity: Number(humanizeIntensityEl.value),
      style: styleEl.value,
      speech_style: speechStyleEl.value,
      voice_character: voiceCharacterEl.checked,
      voice_tone: voiceToneEl.value
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown error" }));
    setStatus(`error (${err.error || "unknown"})`);
    generateBtn.disabled = false;
    return;
  }

  const data = await res.json();
  setStatus("queued");
  jobEl.textContent = `Job: ${data.jobId}`;
  currentJobId = data.jobId;
  logsEl.textContent = "";
  stopPolling();
  pollingTimer = setInterval(() => {
    pollJob(data.jobId).catch(() => {
      setStatus("connection issue, retrying");
    });
  }, 1500);
  pollJob(data.jobId).catch(() => {
    setStatus("connection issue, retrying");
  });
}

async function submitTrainingJob() {
  runTrainingBtnEl.disabled = true;
  setStatus("submitting training benchmark");
  const outputName = trainingOutputNameEl.value.trim() || `benchmark_${trainingStyleEl.value}_${trainingProfileEl.value.replace(".json", "")}`;

  const res = await fetch("/api/training/jobs", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      profileFile: trainingProfileEl.value,
      style: trainingStyleEl.value,
      voice: trainingVoiceEl.value,
      speech_style: trainingSpeechStyleEl.value,
      voice_character: trainingVoiceCharacterEl.checked,
      voice_tone: trainingVoiceToneEl.value,
      humanizeIntensity: Number(trainingIntensityEl.value),
      outputName
    })
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: "unknown error" }));
    setStatus(`training error (${err.error || "unknown"})`);
    runTrainingBtnEl.disabled = false;
    return;
  }

  const data = await res.json();
  currentJobId = data.jobId;
  feedbackBtnEl.disabled = true;
  downloadEl.hidden = true;
  downloadProsodyEl.hidden = true;
  audioPreviewEl.hidden = true;
  audioPreviewEl.removeAttribute("src");
  logsEl.textContent = "";
  setStatus("training queued");
  jobEl.textContent = `Job: ${data.jobId}`;
  stopPolling();
  pollingTimer = setInterval(() => {
    pollJob(data.jobId).catch(() => {
      setStatus("connection issue, retrying");
    });
  }, 1500);
  pollJob(data.jobId).catch(() => {
    setStatus("connection issue, retrying");
  });
  runTrainingBtnEl.disabled = false;
}

async function runFullPipeline(loop = false) {
  runFullPipelineBtnEl.disabled = true;
  runFullPipelineLoopBtnEl.disabled = true;
  stopFullPipelineBtnEl.disabled = false;
  setStatus(loop ? "starting loop pipeline" : "starting full pipeline");
  const res = await fetch("/api/pipeline/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ loop: Boolean(loop) })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(`pipeline error (${data.error || "unknown"})`);
    runFullPipelineBtnEl.disabled = false;
    runFullPipelineLoopBtnEl.disabled = false;
    stopFullPipelineBtnEl.disabled = true;
    return;
  }
  currentPipelineRunId = data.runId;
  stopPolling();
  pollingTimer = setInterval(() => {
    pollPipeline(currentPipelineRunId).catch(() => {
      setStatus("pipeline connection issue, retrying");
    });
  }, 2000);
  await pollPipeline(currentPipelineRunId);
}

async function stopFullPipeline() {
  if (!currentPipelineRunId) {
    stopFullPipelineBtnEl.disabled = true;
    return;
  }
  const res = await fetch(`/api/pipeline/${currentPipelineRunId}/stop`, {
    method: "POST"
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    setStatus(`stop failed (${data.error || "unknown"})`);
    return;
  }
  setStatus(`pipeline ${data.status || "stopped"}`);
  runFullPipelineBtnEl.disabled = false;
  runFullPipelineLoopBtnEl.disabled = false;
  stopFullPipelineBtnEl.disabled = true;
}

generateBtn.addEventListener("click", () => {
  submitJob().catch((err) => {
    setStatus(`error (${err.message || String(err)})`);
    generateBtn.disabled = false;
  });
});

runTrainingBtnEl.addEventListener("click", () => {
  submitTrainingJob().catch((err) => {
    setStatus(`training error (${err.message || String(err)})`);
    runTrainingBtnEl.disabled = false;
  });
});

runFullPipelineBtnEl.addEventListener("click", () => {
  runFullPipeline(false).catch((err) => {
    setStatus(`pipeline error (${err.message || String(err)})`);
    runFullPipelineBtnEl.disabled = false;
    runFullPipelineLoopBtnEl.disabled = false;
    stopFullPipelineBtnEl.disabled = true;
  });
});

runFullPipelineLoopBtnEl.addEventListener("click", () => {
  runFullPipeline(true).catch((err) => {
    setStatus(`pipeline error (${err.message || String(err)})`);
    runFullPipelineBtnEl.disabled = false;
    runFullPipelineLoopBtnEl.disabled = false;
    stopFullPipelineBtnEl.disabled = true;
  });
});

stopFullPipelineBtnEl.addEventListener("click", () => {
  stopFullPipeline().catch((err) => {
    setStatus(`stop failed (${err.message || String(err)})`);
  });
});

tabNormalEl.addEventListener("click", () => switchTab("normal"));
tabTrainingEl.addEventListener("click", () => switchTab("training"));

rateEl.addEventListener("input", () => {
  rateValueEl.textContent = pct(rateEl.value);
});

pitchEl.addEventListener("input", () => {
  pitchValueEl.textContent = hz(pitchEl.value);
});

volumeEl.addEventListener("input", () => {
  volumeValueEl.textContent = pct(volumeEl.value);
});

humanizeIntensityEl.addEventListener("input", () => {
  humanizeIntensityValueEl.textContent = String(humanizeIntensityEl.value);
});

humanizeEl.addEventListener("change", () => {
  updateHumanizeMode();
});

trainingProfileEl.addEventListener("change", () => {
  reloadTrainingStyles(trainingProfileEl.value).catch(() => {
      setStatus("failed to load training styles");
  });
});

trainingIntensityEl.addEventListener("input", () => {
  trainingIntensityValueEl.textContent = String(trainingIntensityEl.value);
});

feedbackBtnEl.addEventListener("click", async () => {
  if (!currentJobId) return;
  feedbackBtnEl.disabled = true;
  try {
    const res = await fetch(`/api/jobs/${currentJobId}/feedback`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        score: Number(feedbackScoreEl.value),
        notes: feedbackNotesEl.value.trim(),
        adjustRate: Number(adjustRateEl.value),
        adjustPitch: Number(adjustPitchEl.value),
        adjustVolume: Number(adjustVolumeEl.value),
        intent_target: intentTargetEl.value || null,
        intensity_target: Number(intensityTargetEl.value),
        transition_note: transitionNoteEl.value.trim(),
        voice_fit: Number(voiceFitEl.value)
      })
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: "unknown error" }));
      setStatus(`feedback failed (${err.error || "unknown"})`);
      feedbackBtnEl.disabled = false;
      return;
    }
    const data = await res.json().catch(() => ({}));
    await refreshProfileState(data.activeProfile || "");
    if (data?.trainResult?.status === "trained") {
      setStatus(`feedback saved, profile upgraded to ${data.trainResult.file}`);
    } else if (data?.autoTrain) {
      setStatus(`feedback saved, auto-train: ${data?.trainResult?.reason || "ok"}`);
    } else {
      setStatus("feedback saved");
    }
  } catch (err) {
    setStatus(`feedback failed (${err.message || String(err)})`);
    feedbackBtnEl.disabled = false;
  }
});

adjustRateEl.addEventListener("input", () => {
  adjustRateValueEl.textContent = adjustRateEl.value;
});
adjustPitchEl.addEventListener("input", () => {
  adjustPitchValueEl.textContent = adjustPitchEl.value;
});
adjustVolumeEl.addEventListener("input", () => {
  adjustVolumeValueEl.textContent = adjustVolumeEl.value;
});
intensityTargetEl.addEventListener("input", () => {
  intensityTargetValueEl.textContent = Number(intensityTargetEl.value).toFixed(2);
});
voiceFitEl.addEventListener("input", () => {
  voiceFitValueEl.textContent = String(voiceFitEl.value);
});

switchTab("normal");
stopFullPipelineBtnEl.disabled = true;

loadDefaults().catch(() => {
  setStatus("failed to load defaults");
});
