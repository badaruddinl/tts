const textEl = document.getElementById("text");
const voiceEl = document.getElementById("voice");
const rateEl = document.getElementById("rate");
const pitchEl = document.getElementById("pitch");
const volumeEl = document.getElementById("volume");
const rateValueEl = document.getElementById("rateValue");
const pitchValueEl = document.getElementById("pitchValue");
const volumeValueEl = document.getElementById("volumeValue");
const outputNameEl = document.getElementById("outputName");
const generateBtn = document.getElementById("generateBtn");
const statusEl = document.getElementById("status");
const jobEl = document.getElementById("job");
const downloadEl = document.getElementById("download");
const logsEl = document.getElementById("logs");

let pollingTimer = null;

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

async function loadDefaults() {
  const [cfgRes, voiceRes] = await Promise.all([
    fetch("/api/config"),
    fetch("/api/voices")
  ]);
  const cfgData = await cfgRes.json();
  const voiceData = await voiceRes.json();

  const voices = Array.isArray(voiceData.voices) ? voiceData.voices : [];
  if (voices.length === 0) {
    const fallback = cfgData.defaults.voice || "id-ID-GadisNeural";
    voiceEl.innerHTML = `<option value="${fallback}">${fallback}</option>`;
  } else {
    voiceEl.innerHTML = voices.map((v) => `<option value="${v}">${v}</option>`).join("");
  }
  voiceEl.value = cfgData.defaults.voice;
  if (!voiceEl.value && voiceEl.options.length > 0) {
    voiceEl.value = voiceEl.options[0].value;
  }

  rateEl.value = String(parsePercentToNumber(cfgData.defaults.rate));
  pitchEl.value = String(parseHzToNumber(cfgData.defaults.pitch));
  volumeEl.value = String(parsePercentToNumber(cfgData.defaults.volume));
  rateValueEl.textContent = pct(rateEl.value);
  pitchValueEl.textContent = hz(pitchEl.value);
  volumeValueEl.textContent = pct(volumeEl.value);
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
    generateBtn.disabled = false;
  } else if (data.status === "failed") {
    stopPolling();
    generateBtn.disabled = false;
    downloadEl.hidden = true;
    setStatus(`failed (${data.error || "unknown error"})`);
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
      outputName: outputNameEl.value.trim()
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

generateBtn.addEventListener("click", () => {
  submitJob().catch((err) => {
    setStatus(`error (${err.message || String(err)})`);
    generateBtn.disabled = false;
  });
});

rateEl.addEventListener("input", () => {
  rateValueEl.textContent = pct(rateEl.value);
});

pitchEl.addEventListener("input", () => {
  pitchValueEl.textContent = hz(pitchEl.value);
});

volumeEl.addEventListener("input", () => {
  volumeValueEl.textContent = pct(volumeEl.value);
});

loadDefaults().catch(() => {
  setStatus("failed to load defaults");
});
