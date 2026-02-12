import fs from "fs";
import path from "path";
import { spawn } from "child_process";
import { createRequire } from "module";
import ffmpegPath from "ffmpeg-static";
import { loadActiveProfile, readProfileFile } from "./profile-store.mjs";
import { loadPolicyModel, predictAdjustment } from "./ml-policy.mjs";

const require = createRequire(import.meta.url);
const VOICE_PRESET_PATH = path.resolve(process.cwd(), "config", "voice-character", "presets.json");

const META_KEYS = new Set(["TITLE", "VOICE", "RATE", "PITCH", "VOLUME", "OUTPUT"]);

export function cleanLine(line) {
  let out = line.trim();
  if (!out) return "";
  if (/^[-*_]{3,}$/.test(out)) return "";
  if (/^\(.*\)$/.test(out)) return "";

  out = out.replace(/^#{1,6}\s+/, "");
  out = out.replace(/\*\*(.*?)\*\*/g, "$1");
  out = out.replace(/\*(.*?)\*/g, "$1");
  out = out.replace(/\[PAUSE_SHORT\]/gi, " ... ");
  out = out.replace(/\[PAUSE_MEDIUM\]/gi, " .... ");
  out = out.replace(/\[PAUSE_LONG\]/gi, " ..... ");
  out = out.replace(/\[SCENE:[^\]]+\]/gi, "");
  out = out.replace(/\s+/g, " ").trim();
  return out;
}

export function parseText(rawText) {
  const lines = rawText.replace(/^\uFEFF/, "").split(/\r?\n/);
  const meta = {};
  const bodyLines = [];
  let bodyStarted = false;

  for (const line of lines) {
    const trimmed = line.trim();
    const match = trimmed.match(/^([A-Z_]+)\s*:\s*(.+)$/);
    if (!bodyStarted && match && META_KEYS.has(match[1])) {
      meta[match[1]] = match[2].trim();
      continue;
    }
    if (!bodyStarted && trimmed === "---") {
      bodyStarted = true;
      continue;
    }
    if (trimmed) bodyStarted = true;
    bodyLines.push(line);
  }

  const cleaned = bodyLines.map(cleanLine).filter(Boolean).join("\n");
  return { meta, text: cleaned };
}

export function parseInputFile(filePath) {
  const raw = fs.readFileSync(filePath, "utf8");
  return parseText(raw);
}

function getEdgeCliPath() {
  const pkgPath = require.resolve("@andresaya/edge-tts/package.json");
  return path.resolve(path.dirname(pkgPath), "dist", "cli", "edge-tts.js");
}

function resolveBackendName(backend) {
  const key = String(backend || process.env.TTS_BACKEND || "edge").trim().toLowerCase();
  if (key === "local" || key === "local-lite" || key === "piper") return "local-lite";
  return "edge";
}

function normalizeOutput(outputName) {
  return String(outputName || "output.mp3").replace(/\.mp3$/i, "");
}

function parsePercentNumber(value, fallback = 0) {
  const n = Number(String(value || "").replace("%", "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function parseHzNumber(value, fallback = 0) {
  const n = Number(String(value || "").replace("Hz", "").trim());
  return Number.isFinite(n) ? n : fallback;
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function readVoicePresetFile() {
  if (!fs.existsSync(VOICE_PRESET_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(VOICE_PRESET_PATH, "utf8"));
  } catch {
    return null;
  }
}

function resolveVoiceCharacterKey(voiceName) {
  const v = String(voiceName || "").toLowerCase();
  if (v.includes("ardineural")) return "ardi";
  if (v.includes("gadisneural")) return "gadis";
  return "default";
}

function resolveVoiceCharacterPreset(styleName, voiceName) {
  const cfg = readVoicePresetFile();
  if (!cfg?.styles) {
    return {
      key: "default",
      base: { rate: 0, pitch: 0, volume: 0 },
      amplitudeMul: { rate: 1, pitch: 1, volume: 1 },
      post: { enabled: false, lowDb: 0, highDb: 0, compRatio: 1.8 }
    };
  }
  const key = resolveVoiceCharacterKey(voiceName);
  const styleCfg = cfg.styles?.[styleName] || cfg.styles?.natural || {};
  const voiceCfg = styleCfg?.[key] || styleCfg?.default || {};
  return {
    key,
    base: {
      rate: Number(voiceCfg?.base?.rate ?? 0),
      pitch: Number(voiceCfg?.base?.pitch ?? 0),
      volume: Number(voiceCfg?.base?.volume ?? 0)
    },
    amplitudeMul: {
      rate: Number(voiceCfg?.amplitudeMul?.rate ?? 1),
      pitch: Number(voiceCfg?.amplitudeMul?.pitch ?? 1),
      volume: Number(voiceCfg?.amplitudeMul?.volume ?? 1)
    },
    post: {
      enabled: Boolean(voiceCfg?.post?.enabled ?? voiceCfg?.ardiHeavy?.enabled),
      lowDb: Number(voiceCfg?.post?.lowDb ?? voiceCfg?.ardiHeavy?.lowBoostDb ?? 0),
      highDb: Number(voiceCfg?.post?.highDb ?? voiceCfg?.ardiHeavy?.highCutDb ?? 0),
      compRatio: Number(voiceCfg?.post?.compRatio ?? voiceCfg?.ardiHeavy?.compRatio ?? 1.8)
    }
  };
}

const SPEECH_STYLE_ALIASES = {
  auto: "auto",
  default: "auto",
  naratif: "narrative",
  narrative: "narrative",
  santai: "relaxed",
  relaxed: "relaxed",
  tegas: "assertive",
  assertive: "assertive",
  dramatis: "dramatic",
  dramatic: "dramatic",
  emosional: "emotional",
  emotional: "emotional"
};

const SPEECH_STYLE_PRESETS = {
  auto: { base: { rate: 0, pitch: 0, volume: 0 }, amplitudeMul: { rate: 1, pitch: 1, volume: 1 } },
  narrative: {
    base: { rate: 0, pitch: 0, volume: 0 },
    amplitudeMul: { rate: 1.02, pitch: 1.01, volume: 1.01 }
  },
  relaxed: {
    base: { rate: -1.2, pitch: -0.3, volume: -0.2 },
    amplitudeMul: { rate: 0.9, pitch: 0.9, volume: 0.95 }
  },
  assertive: {
    base: { rate: 0.7, pitch: -0.4, volume: 0.8 },
    amplitudeMul: { rate: 1.05, pitch: 0.95, volume: 1.08 }
  },
  dramatic: {
    base: { rate: 0.2, pitch: 0.6, volume: 0.5 },
    amplitudeMul: { rate: 1.14, pitch: 1.15, volume: 1.1 }
  },
  emotional: {
    base: { rate: -0.2, pitch: 0.8, volume: 0.4 },
    amplitudeMul: { rate: 1.1, pitch: 1.18, volume: 1.08 }
  }
};

function resolveSpeechStylePreset(speechStyle) {
  const key = SPEECH_STYLE_ALIASES[String(speechStyle || "auto").toLowerCase().trim()] || "auto";
  const preset = SPEECH_STYLE_PRESETS[key] || SPEECH_STYLE_PRESETS.auto;
  return { key, ...preset };
}

function resolveStyleConfig(styleName, profileFileOverride = null) {
  let profilePack;
  if (profileFileOverride) {
    profilePack = {
      file: profileFileOverride,
      profile: readProfileFile(profileFileOverride)
    };
  } else {
    profilePack = loadActiveProfile();
  }
  const { profile, file } = profilePack;
  const styles = profile?.styles || {};
  const defaultStyle = profile?.defaultStyle || "natural";
  const normalizedStyle = resolveGlobalStyle(styleName);
  const selected = normalizedStyle && styles[normalizedStyle] ? normalizedStyle : defaultStyle;
  const style = styles[selected] || styles[defaultStyle];
  return {
    profileFile: file,
    styleName: selected,
    style
  };
}

const GLOBAL_STYLE_ALIASES = {
  natural: "natural",
  santai: "natural",
  calm: "natural",
  netral: "natural",
  neutral: "natural",
  ceria: "dramatis",
  cheerful: "dramatis",
  happy: "dramatis",
  energetic: "dramatis",
  tegang: "thriller",
  tense: "thriller",
  thriller: "thriller",
  dramatic_tense: "thriller",
  sedih: "melankolis",
  sad: "melankolis",
  melancholic: "melankolis",
  misteri: "misteri",
  mystery: "misteri",
  horror_intimate: "horor_intim",
  intimate_horror: "horor_intim",
  tegas: "narator_tegas",
  assertive: "narator_tegas",
  cinematic: "sinematik",
  flat: "datar"
};

const INTENT_ALIASES = {
  netral: "netral",
  neutral: "netral",
  calm_neutral: "netral",
  ceria: "ceria",
  cheerful: "ceria",
  happy: "ceria",
  excited: "ceria",
  tegang: "tegang",
  tense: "tegang",
  suspense: "tegang",
  anxious: "tegang",
  sedih: "sedih",
  sad: "sedih",
  sorrow: "sedih",
  kaget: "kaget",
  surprised: "kaget",
  shock: "kaget",
  tegas: "tegas",
  assertive: "tegas",
  firm: "tegas",
  marah: "marah",
  angry: "marah",
  anger: "marah",
  tenang: "tenang",
  calm: "tenang",
  soothe: "tenang"
};

const STYLE_INTENT_PRIOR = {
  natural: "netral",
  datar: "netral",
  dramatis: "ceria",
  misteri: "tegang",
  thriller: "tegang",
  horor_intim: "tegang",
  melankolis: "sedih",
  pasrah: "sedih",
  narator_tegas: "tegas",
  sinematik: "tegang"
};

const INTENT_PROSODY = {
  netral: { rate: 0, pitch: 0, volume: 0 },
  ceria: { rate: 1.5, pitch: 2.1, volume: 0.8 },
  tegang: { rate: -0.9, pitch: -0.8, volume: 0.5 },
  sedih: { rate: -1.7, pitch: -1.5, volume: -0.9 },
  kaget: { rate: 2.1, pitch: 2.4, volume: 1.4 },
  tegas: { rate: 0.8, pitch: -0.5, volume: 1.2 },
  marah: { rate: 1.4, pitch: -1, volume: 1.6 },
  tenang: { rate: -0.8, pitch: -0.2, volume: -0.3 }
};

const INTENT_PATTERNS = {
  ceria: /\b(asyik|senang|bahagia|akhirnya|mantap|hebat|seru|keren|yes|yey|hore|wow|great|awesome|finally)\b/i,
  tegang: /\b(gelap|langkah|pintu|bayangan|bisik|takut|mencekam|sunyi|merinding|dark|shadow|whisper|afraid|cold|opened by itself)\b/i,
  sedih: /\b(sedih|kecewa|hampa|lelah|menangis|sendiri|pilu|terluka|heartbroken|lonely|exhausted|grief)\b/i,
  kaget: /\b(kaget|astaga|waduh|tidak mungkin|what|hah|oh no|no way|suddenly)\b/i,
  tegas: /\b(dengar|perhatikan|ingat|harus|wajib|sekarang|fokus|listen|pay attention|must|stay still)\b/i,
  marah: /\b(marah|geram|kesal|muak|benci|angry|furious|annoyed|hate)\b/i,
  tenang: /\b(pelan|tenang|tarik napas|damai|aman|breathe|steady|calm down|relax)\b/i
};

const HYBRID_IMPORTANT = {
  interjection: new Set(["oh", "hah", "astaga", "waduh", "wow", "yah", "uh", "eh"]),
  emotion: new Set(["takut", "senang", "marah", "sedih", "cemas", "bahagia", "geram"]),
  focus: new Set(["tapi", "namun", "harus", "justru", "tetap", "malah", "wajib"])
};

const HYBRID_DEFAULTS = {
  enabled: true,
  minWords: 2,
  maxWords: 6,
  targetWords: 4,
  maxOverridesPerSegment: 1,
  minOverrideGap: 1,
  phraseContourRate: 0.9,
  phraseContourPitch: 0.6,
  phraseContourVolume: 0.25,
  maxStepRate: 3.2,
  maxStepPitch: 2.4,
  maxStepVolume: 1.9
};

function resolveGlobalStyle(styleName) {
  const key = String(styleName || "").trim().toLowerCase();
  return GLOBAL_STYLE_ALIASES[key] || key || "natural";
}

function normalizeIntent(intentName, fallback = "netral") {
  const key = String(intentName || "").trim().toLowerCase();
  return INTENT_ALIASES[key] || key || fallback;
}

function parseIntentTag(rawText) {
  const text = String(rawText || "");
  const tagRegex = /\[(?:intent|emo|emotion)\s*(?:=|:)\s*([a-z_]+)(?:\s*[,|:]\s*([0-9.]+))?\s*\]/gi;
  let match;
  let intentTag = null;
  let clean = text;
  while ((match = tagRegex.exec(text)) !== null) {
    intentTag = {
      intent: normalizeIntent(match[1], "netral"),
      intensity: clamp(Number(match[2] ?? 1), 0, 1),
      raw: match[0]
    };
  }
  if (intentTag) {
    clean = clean.replace(tagRegex, "").replace(/\s+/g, " ").trim();
  }
  return { cleanText: clean, intentTag };
}

function toWordTokens(text) {
  return String(text || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function splitSegmentIntoPhrases(text, cfg) {
  const words = toWordTokens(text);
  if (words.length <= cfg.maxWords) return [String(text || "").trim()].filter(Boolean);
  const out = [];
  let i = 0;
  while (i < words.length) {
    const remain = words.length - i;
    let size = Math.min(cfg.maxWords, Math.max(cfg.minWords, cfg.targetWords));
    if (remain <= cfg.maxWords) {
      size = remain;
    } else if (remain - size < cfg.minWords) {
      size = Math.max(cfg.minWords, remain - cfg.minWords);
    }
    out.push(words.slice(i, i + size).join(" "));
    i += size;
  }
  return out.filter(Boolean);
}

function classifyPhraseImportance(phraseText) {
  const tokens = toWordTokens(String(phraseText || "").toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, ""));
  const found = {
    interjection: false,
    emotion: false,
    focus: false
  };
  for (const t of tokens) {
    if (HYBRID_IMPORTANT.interjection.has(t)) found.interjection = true;
    if (HYBRID_IMPORTANT.emotion.has(t)) found.emotion = true;
    if (HYBRID_IMPORTANT.focus.has(t)) found.focus = true;
  }
  return found;
}

function smoothProsodySteps(units, cfg) {
  const out = [];
  let prev = null;
  for (const unit of units) {
    const next = { ...unit };
    if (prev) {
      const dr = clamp(next.rate - prev.rate, -cfg.maxStepRate, cfg.maxStepRate);
      const dp = clamp(next.pitch - prev.pitch, -cfg.maxStepPitch, cfg.maxStepPitch);
      const dv = clamp(next.volume - prev.volume, -cfg.maxStepVolume, cfg.maxStepVolume);
      next.rate = prev.rate + dr;
      next.pitch = prev.pitch + dp;
      next.volume = prev.volume + dv;
    }
    next.rate = clamp(next.rate, -35, 35);
    next.pitch = clamp(next.pitch, -20, 20);
    next.volume = clamp(next.volume, -20, 20);
    out.push(next);
    prev = next;
  }
  return out;
}

function applyImportanceBoost({ rate, pitch, volume, importance, strength = 1 }) {
  let r = rate;
  let p = pitch;
  let v = volume;
  if (importance.interjection) {
    r -= 1.2 * strength;
    p += 1.1 * strength;
    v += 0.5 * strength;
  }
  if (importance.emotion) {
    r -= 0.7 * strength;
    p += 0.9 * strength;
    v += 0.8 * strength;
  }
  if (importance.focus) {
    r -= 0.4 * strength;
    p += 0.4 * strength;
    v += 0.9 * strength;
  }
  return { rate: r, pitch: p, volume: v };
}

function expandHybridProsodyUnits(baseSegments, opts) {
  const cfg = {
    ...HYBRID_DEFAULTS,
    enabled: opts?.hybridProsody !== false
  };
  if (!cfg.enabled) return baseSegments;

  const expanded = [];
  let globalIndex = 1;
  for (const seg of baseSegments) {
    const phrases = splitSegmentIntoPhrases(seg.text, cfg);
    let usedOverrides = 0;
    let lastOverrideIdx = -999;
    const singlePhrase = phrases.length <= 1;
    const safePhrases = singlePhrase ? [seg.text] : phrases;
    for (let i = 0; i < safePhrases.length; i += 1) {
      const p = safePhrases[i];
      const arc = Math.sin(((i + 1) / (safePhrases.length + 1)) * Math.PI);
      let rate = seg.rate + arc * cfg.phraseContourRate;
      let pitch = seg.pitch + arc * cfg.phraseContourPitch;
      let volume = seg.volume + arc * cfg.phraseContourVolume;

      const importance = classifyPhraseImportance(p);
      const wantsOverride = importance.interjection || importance.emotion || importance.focus;
      const canOverride =
        wantsOverride &&
        usedOverrides < cfg.maxOverridesPerSegment &&
        i - lastOverrideIdx > cfg.minOverrideGap;

      if (canOverride) {
        const boosted = applyImportanceBoost({
          rate,
          pitch,
          volume,
          importance,
          strength: singlePhrase ? 0.65 : 1
        });
        rate = boosted.rate;
        pitch = boosted.pitch;
        volume = boosted.volume;
        usedOverrides += 1;
        lastOverrideIdx = i;
      }

      expanded.push({
        ...seg,
        index: globalIndex++,
        text: p,
        rate,
        pitch,
        volume,
        reason: {
          ...seg.reason,
          hybrid: {
            phraseIndex: i + 1,
            phraseTotal: safePhrases.length,
            override: canOverride,
            singlePhrase,
            important: importance
          }
        }
      });
    }
  }

  return smoothProsodySteps(expanded, cfg);
}

function splitIntoSegments(text) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const segments = [];
  for (const line of lines) {
    const parts = line
      .split(/(?<=[.!?;:])\s+|(?<=,)\s+/)
      .map((item) => item.trim())
      .filter(Boolean)
      .filter((item) => !/^\.+$/.test(item));
    for (const part of parts) {
      const tagged = parseIntentTag(part);
      if (!tagged.cleanText) continue;
      segments.push({
        text: tagged.cleanText,
        override: tagged.intentTag
      });
    }
  }
  return segments;
}

function detectIntentState(segment, idx, total, styleName, allowIntentOverride = true) {
  const text = String(segment?.text || "").trim();
  const t = text.toLowerCase();
  const isOpening = idx === 0;
  const isGreeting = /^(hai|halo|hello|helo|hi|apa kabar|selamat (pagi|siang|sore|malam))\b/i.test(text);
  const exclaims = (text.match(/!/g) || []).length;
  const questions = (text.match(/\?/g) || []).length;

  const rawOverrideIntent = segment?.override?.intent;
  const overrideIntent = normalizeIntent(rawOverrideIntent, "");
  if (allowIntentOverride && rawOverrideIntent && overrideIntent && INTENT_PROSODY[overrideIntent]) {
    return {
      intent: overrideIntent,
      intensity: clamp(segment?.override?.intensity ?? 1, 0, 1),
      source: "tag_override"
    };
  }

  let bestIntent = STYLE_INTENT_PRIOR[styleName] || "netral";
  let bestScore = 1.2;
  for (const [intent, regex] of Object.entries(INTENT_PATTERNS)) {
    if (regex.test(t)) {
      const score = 2.2 + (t.match(regex) || []).length * 0.5;
      if (score > bestScore) {
        bestScore = score;
        bestIntent = intent;
      }
    }
  }

  if (isGreeting && isOpening && text.length <= 20 && bestIntent === "netral") {
    bestIntent = "ceria";
    bestScore += 0.8;
  }
  if (exclaims >= 2) {
    bestIntent = "kaget";
    bestScore += 1;
  } else if (questions >= 2 && bestIntent === "netral") {
    bestIntent = "tegang";
    bestScore += 0.4;
  }
  if ((styleName === "horor_intim" || styleName === "misteri") && bestIntent === "netral") {
    bestIntent = "tegang";
    bestScore += 0.4;
  }

  const intensity = clamp(0.35 + bestScore / 6, 0.3, 1);
  return {
    intent: normalizeIntent(bestIntent, "netral"),
    intensity,
    confidence: clamp(bestScore / 4, 0.35, 1),
    source: "auto"
  };
}

function smoothIntentStates(states) {
  const out = [];
  let prev = null;
  for (let i = 0; i < states.length; i += 1) {
    const curr = { ...states[i] };
    if (!prev) {
      out.push(curr);
      prev = curr;
      continue;
    }
    const isTagOverride = curr.source === "tag_override";
    const isAbrupt = curr.intent !== prev.intent;
    const isCriticalIntent = curr.intent === "kaget" || prev.intent === "kaget";
    const lowConfidence = Number(curr.confidence ?? 1) < 0.52;
    let nextIntent = curr.intent;
    let transition = "steady";

    const prevWasHeld = prev.transition === "held";
    if (isAbrupt && !isTagOverride && !isCriticalIntent && lowConfidence && !prevWasHeld) {
      nextIntent = prev.intent;
      transition = "held";
    } else if (isAbrupt) {
      transition = "smoothed";
    }

    const hysteresis = transition !== "steady" && !isTagOverride ? 0.22 : 0;
    const blendedIntensity = clamp(curr.intensity * (1 - hysteresis) + prev.intensity * hysteresis, 0.25, 1);
    out.push({
      ...curr,
      intent: nextIntent,
      intensity: blendedIntensity,
      transition
    });
    prev = out[out.length - 1];
  }
  return out;
}

function buildProsodyMap(segments, opts) {
  const styleCfg = resolveStyleConfig(opts.style, opts.profileFile);
  const globalStyle = resolveGlobalStyle(styleCfg.styleName);
  const voicePreset = resolveVoiceCharacterPreset(styleCfg.styleName, opts.voice);
  const speechPreset = resolveSpeechStylePreset(opts.speechStyle);
  const baseRate =
    Number(styleCfg.style?.base?.rate ?? parsePercentNumber(opts.rate, 0)) +
    Number(voicePreset.base.rate ?? 0) +
    Number(speechPreset.base.rate ?? 0);
  const basePitch =
    Number(styleCfg.style?.base?.pitch ?? parseHzNumber(opts.pitch, 0)) +
    Number(voicePreset.base.pitch ?? 0) +
    Number(speechPreset.base.pitch ?? 0);
  const baseVolume =
    Number(styleCfg.style?.base?.volume ?? parsePercentNumber(opts.volume, 0)) +
    Number(voicePreset.base.volume ?? 0) +
    Number(speechPreset.base.volume ?? 0);
  const intensity = clamp(Number(opts.humanizeIntensity ?? 0.45), 0, 1);
  const rateAmp =
    Number(styleCfg.style?.amplitude?.rate ?? 10) *
    Number(voicePreset.amplitudeMul.rate ?? 1) *
    Number(speechPreset.amplitudeMul.rate ?? 1) *
    intensity;
  const pitchAmp =
    Number(styleCfg.style?.amplitude?.pitch ?? 4) *
    Number(voicePreset.amplitudeMul.pitch ?? 1) *
    Number(speechPreset.amplitudeMul.pitch ?? 1) *
    intensity;
  const volumeAmp =
    Number(styleCfg.style?.amplitude?.volume ?? 3) *
    Number(voicePreset.amplitudeMul.volume ?? 1) *
    Number(speechPreset.amplitudeMul.volume ?? 1) *
    intensity;
  const waveFreq = 0.9;
  const wavePhase = Number(styleCfg.style?.wave?.phase ?? 0.65);
  const openingDecay = Number(styleCfg.style?.opening?.decay ?? 2.2);
  const openingRate = Number(styleCfg.style?.opening?.rate ?? rateAmp * 0.32);
  const openingPitch = Number(styleCfg.style?.opening?.pitch ?? pitchAmp * 0.28);
  const openingVolume = Number(styleCfg.style?.opening?.volume ?? volumeAmp * 0.24);
  const longThreshold = Number(styleCfg.style?.lengthRule?.longThreshold ?? 130);
  const shortRateBoost = Number(styleCfg.style?.lengthRule?.shortRateBoost ?? 1.0);
  const longRateDrop = Number(styleCfg.style?.lengthRule?.longRateDrop ?? 2.0);
  const endings = styleCfg.style?.ending || {};
  const autoExpressive = opts.autoExpressive !== false;
  const allowIntentOverride = opts.allowIntentOverride !== false;

  const intentsWithOverridePolicy = smoothIntentStates(
    segments.map((segment, idx) =>
      autoExpressive
        ? detectIntentState(segment, idx, segments.length, globalStyle, allowIntentOverride)
        : { intent: "netral", intensity: 0, source: "disabled" }
    )
  );

  const segmentsOut = segments.map((segment, i) => {
    const text = segment.text;
    const wave = Math.sin(i * waveFreq + wavePhase);
    const openingEnv = Math.exp(-i / Math.max(0.6, openingDecay));
    let rate = baseRate + wave * rateAmp;
    let pitch = basePitch + wave * pitchAmp;
    let volume = baseVolume + wave * volumeAmp;
    // Make the style audible from the very first segment.
    rate += openingRate * openingEnv;
    pitch += openingPitch * openingEnv;
    volume += openingVolume * openingEnv;

    let endKey = "period";
    if (/[!?]$/.test(text)) {
      endKey = /\?$/.test(text) ? "question" : "exclaim";
    }
    if (/\.\.\.$/.test(text)) {
      endKey = "ellipsis";
    }
    const endCfg = endings[endKey] || {};
    rate += Number(endCfg.rate ?? 0) * intensity;
    pitch += Number(endCfg.pitch ?? 0) * intensity;
    volume += Number(endCfg.volume ?? 0) * intensity;

    if (text.length > longThreshold) {
      rate -= longRateDrop * intensity;
    } else if (text.length < 60) {
      rate += shortRateBoost * intensity;
    }

    const intentState = intentsWithOverridePolicy[i] || { intent: "netral", intensity: 0 };
    const ib = INTENT_PROSODY[intentState.intent] || INTENT_PROSODY.netral;
    rate += ib.rate * intensity * intentState.intensity;
    pitch += ib.pitch * intensity * intentState.intensity;
    volume += ib.volume * intensity * intentState.intensity;

    rate = clamp(rate, -35, 35);
    pitch = clamp(pitch, -20, 20);
    volume = clamp(volume, -20, 20);

    return {
      index: i + 1,
      text,
      rate,
      pitch,
      volume,
      reason: {
        style: styleCfg.styleName,
        profileFile: styleCfg.profileFile,
        ending: endKey,
        intent: intentState.intent || "netral",
        intentIntensity: intentState.intensity ?? 0,
        intentSource: intentState.source || "auto",
        transition: intentState.transition || "steady",
        voiceCharacter: voicePreset.key,
        speechStyle: speechPreset.key
      }
    };
  });
  const hybridSegments = expandHybridProsodyUnits(segmentsOut, opts);
  return {
    styleName: styleCfg.styleName,
    profileFile: styleCfg.profileFile,
    voiceCharacter: voicePreset.key,
    speechStyle: speechPreset.key,
    voicePreset,
    segments: hybridSegments
  };
}

async function applyVoiceCharacterPostProcess({
  inputPath,
  outputPath,
  voice,
  style,
  voiceCharacter = true,
  voiceTone = "auto"
}) {
  if (!ffmpegPath || !voiceCharacter) return false;
  const preset = resolveVoiceCharacterPreset(style, voice);
  const tone = String(voiceTone || "auto").toLowerCase().trim();
  if (!preset?.post?.enabled || tone === "off" || tone === "none" || tone === "raw") return false;

  let lowDb = clamp(Number(preset.post.lowDb ?? 0), -6, 8);
  let highDb = clamp(Number(preset.post.highDb ?? 0), -6, 6);
  let compRatio = clamp(Number(preset.post.compRatio ?? 1.8), 1.2, 8);

  // Tone override applies on top of style+voice preset.
  if (tone === "deep" || tone === "berat") {
    lowDb = clamp(lowDb + 1.2, -6, 8);
    highDb = clamp(highDb - 1.0, -6, 6);
    compRatio = clamp(compRatio + 0.3, 1.2, 8);
  } else if (tone === "bright" || tone === "cerah") {
    lowDb = clamp(lowDb - 0.7, -6, 8);
    highDb = clamp(highDb + 1.1, -6, 6);
  } else if (tone === "clear" || tone === "jernih") {
    lowDb = clamp(lowDb - 0.4, -6, 8);
    highDb = clamp(highDb + 0.8, -6, 6);
    compRatio = clamp(compRatio - 0.2, 1.2, 8);
  } else if (tone === "soft" || tone === "halus") {
    highDb = clamp(highDb - 0.5, -6, 6);
    compRatio = clamp(compRatio + 0.2, 1.2, 8);
  }

  const filter = [
    `equalizer=f=120:width_type=h:width=160:g=${lowDb.toFixed(2)}`,
    `equalizer=f=3200:width_type=h:width=1800:g=${highDb.toFixed(2)}`,
    `acompressor=threshold=-18dB:ratio=${compRatio.toFixed(2)}:attack=20:release=220`
  ].join(",");

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputPath,
      "-vn",
      "-af",
      filter,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outputPath
    ];
    const child = spawn(ffmpegPath, args, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg post-process exited with code ${code}`));
    });
  });
  return true;
}

export function previewAutoExpressionFromText({
  text,
  rate = "-8%",
  pitch = "-2Hz",
  volume = "0%",
  humanizeIntensity = 0.45,
  style = null,
  speechStyle = "auto",
  profileFile = null,
  hybridProsody = true,
  autoExpressive = true,
  allowIntentOverride = true
}) {
  const segments = splitIntoSegments(text);
  if (segments.length === 0) {
    throw new Error("No text segments available for auto-expression preview.");
  }
  return buildProsodyMap(segments, {
    rate,
    pitch,
    volume,
    humanizeIntensity,
    style,
    speechStyle,
    profileFile,
    hybridProsody,
    autoExpressive,
    allowIntentOverride
  });
}

async function concatMp3Files(segmentPaths, outputPath, cacheDir) {
  if (!ffmpegPath) {
    throw new Error("ffmpeg-static is not available.");
  }
  const listPath = path.join(cacheDir, `concat_${Date.now()}.txt`);
  const content = segmentPaths
    .map((item) => {
      const normalized = path.resolve(item).replace(/\\/g, "/");
      return `file '${normalized.replace(/'/g, "'\\''")}'`;
    })
    .join("\n");
  fs.writeFileSync(listPath, content, "utf8");

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listPath,
      "-vn",
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outputPath
    ];
    const child = spawn(ffmpegPath, args, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (fs.existsSync(listPath)) fs.unlinkSync(listPath);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg exited with code ${code}`));
    });
  });
}

function parseRateFactor(rateValue) {
  const n = parsePercentNumber(rateValue, 0);
  return clamp(1 + n / 100, 0.5, 2);
}

function parseVolumeFactor(volumeValue) {
  const n = parsePercentNumber(volumeValue, 0);
  return clamp(1 + n / 100, 0.1, 4);
}

async function convertWavToMp3WithAdjust({
  inputWav,
  outputMp3,
  rate = "0%",
  volume = "0%",
  cacheDir
}) {
  if (!ffmpegPath) throw new Error("ffmpeg-static is not available.");
  const rateFactor = parseRateFactor(rate);
  const volumeFactor = parseVolumeFactor(volume);
  const filter = [`atempo=${rateFactor.toFixed(3)}`, `volume=${volumeFactor.toFixed(3)}`].join(",");

  await new Promise((resolve, reject) => {
    const args = [
      "-y",
      "-i",
      inputWav,
      "-vn",
      "-af",
      filter,
      "-ar",
      "24000",
      "-ac",
      "1",
      "-c:a",
      "libmp3lame",
      "-b:a",
      "128k",
      outputMp3
    ];
    const child = spawn(ffmpegPath, args, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `ffmpeg convert exited with code ${code}`));
    });
  });

  if (cacheDir && fs.existsSync(inputWav)) {
    try {
      fs.unlinkSync(inputWav);
    } catch {
      // ignore cleanup failure
    }
  }
}

async function synthesizeLocalLiteToMp3({
  text,
  output,
  rate,
  pitch,
  volume,
  cacheDir
}) {
  const model = String(process.env.TTS_LOCAL_LITE_MODEL || "").trim();
  const cmd = String(process.env.TTS_LOCAL_LITE_CMD || "piper").trim();
  if (!model) {
    throw new Error("Local-lite backend requires TTS_LOCAL_LITE_MODEL (e.g. path/to/model.onnx).");
  }
  const normalizedOutput = normalizeOutput(output);
  const outMp3 = path.resolve(`${normalizedOutput}.mp3`);
  const workCacheDir = path.resolve(cacheDir || path.join(process.cwd(), ".tts-cache"));
  if (!fs.existsSync(workCacheDir)) fs.mkdirSync(workCacheDir, { recursive: true });
  const wavPath = path.resolve(workCacheDir, `local_lite_${Date.now()}_${Math.floor(Math.random() * 100000)}.wav`);

  // Piper expects text from stdin and outputs WAV.
  await new Promise((resolve, reject) => {
    const args = ["--model", model, "--output_file", wavPath];
    const child = spawn(cmd, args, { stdio: ["pipe", "pipe", "pipe"], shell: false });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", (err) => {
      reject(new Error(`Local-lite command failed to start (${cmd}): ${err.message || String(err)}`));
    });
    child.stdin.write(`${text}\n`);
    child.stdin.end();
    child.on("close", (code) => {
      if (code === 0 && fs.existsSync(wavPath)) {
        resolve();
        return;
      }
      reject(
        new Error(
          stderr ||
            `Local-lite synth failed (cmd=${cmd}, code=${code}). Check TTS_LOCAL_LITE_CMD and TTS_LOCAL_LITE_MODEL.`
        )
      );
    });
  });

  // Note: pitch is ignored for local-lite baseline adapter unless dedicated backend controls are available.
  await convertWavToMp3WithAdjust({
    inputWav: wavPath,
    outputMp3: outMp3,
    rate,
    volume,
    cacheDir: workCacheDir
  });
  void pitch;
  return outMp3;
}

export async function synthesizeToMp3({
  text,
  output,
  voice,
  rate,
  pitch,
  volume,
  cacheDir,
  backend = null
}) {
  if (!text || !text.trim()) {
    throw new Error("Input text is empty after cleanup.");
  }

  const chosen = resolveBackendName(backend);
  if (chosen === "local-lite") {
    return synthesizeLocalLiteToMp3({
      text,
      output,
      rate,
      pitch,
      volume,
      cacheDir
    });
  }

  const workCacheDir = path.resolve(cacheDir || path.join(process.cwd(), ".tts-cache"));
  if (!fs.existsSync(workCacheDir)) fs.mkdirSync(workCacheDir, { recursive: true });

  const taskId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const tempInputPath = path.join(workCacheDir, `input.${taskId}.txt`);
  fs.writeFileSync(tempInputPath, text, "utf8");

  const cliPath = getEdgeCliPath();
  const normalizedOutput = normalizeOutput(output);
  const cmdArgs = [
    cliPath,
    "synthesize",
    "--file",
    tempInputPath,
    "--voice",
    String(voice),
    `--rate=${String(rate)}`,
    `--pitch=${String(pitch)}`,
    `--volume=${String(volume)}`,
    "--output",
    normalizedOutput
  ];

  await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, cmdArgs, { stdio: "pipe" });
    let stderr = "";
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(stderr || `edge-tts exited with code ${code}`));
    });
  });

  return path.resolve(`${normalizedOutput}.mp3`);
}

export async function synthesizeHumanizedToMp3({
  text,
  output,
  voice,
  rate,
  pitch,
  volume,
  cacheDir,
  humanizeIntensity = 0.45,
  style = null,
  speechStyle = "auto",
  useMlPolicy = false,
  profileFile = null,
  autoExpressive = true,
  voiceCharacter = true,
  voiceTone = "auto",
  hybridProsody = true,
  backend = null
}) {
  const workCacheDir = path.resolve(cacheDir || path.join(process.cwd(), ".tts-cache"));
  if (!fs.existsSync(workCacheDir)) fs.mkdirSync(workCacheDir, { recursive: true });

  const segments = splitIntoSegments(text);
  if (segments.length === 0) {
    throw new Error("No text segments available for humanize mode.");
  }

  const built = buildProsodyMap(segments, {
    rate,
    pitch,
    volume,
    humanizeIntensity,
    style,
    speechStyle,
    profileFile,
    autoExpressive,
    voice,
    hybridProsody
  });
  const prosodyMap = built.segments;

  const runId = `${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const segDir = path.join(workCacheDir, `humanize_${runId}`);
  fs.mkdirSync(segDir, { recursive: true });

  const policy = useMlPolicy ? loadPolicyModel() : null;
  const segmentPaths = [];
  for (let i = 0; i < prosodyMap.length; i += 1) {
    const seg = prosodyMap[i];
    const mlAdj = policy
      ? predictAdjustment(policy, {
          segment: seg,
          idx: i,
          total: prosodyMap.length,
          style: built.styleName
        })
      : { dr: 0, dp: 0, dv: 0 };
    const nextRate = clamp(seg.rate + mlAdj.dr, -35, 35);
    const nextPitch = clamp(seg.pitch + mlAdj.dp, -20, 20);
    const nextVolume = clamp(seg.volume + mlAdj.dv, -20, 20);

    const segBase = path.join(segDir, `seg_${String(seg.index).padStart(4, "0")}`);
    const segOut = await synthesizeToMp3({
      text: seg.text,
      output: segBase,
      voice,
      rate: `${nextRate.toFixed(0)}%`,
      pitch: `${nextPitch.toFixed(0)}Hz`,
      volume: `${nextVolume.toFixed(0)}%`,
      cacheDir: workCacheDir,
      backend
    });
    seg.ml = mlAdj;
    seg.final = { rate: nextRate, pitch: nextPitch, volume: nextVolume };
    segmentPaths.push(segOut);
  }

  const normalizedOutput = normalizeOutput(output);
  const finalPath = path.resolve(`${normalizedOutput}.mp3`);
  await concatMp3Files(segmentPaths, finalPath, workCacheDir);
  const postPath = path.resolve(`${normalizedOutput}.post.mp3`);
  const postApplied = await applyVoiceCharacterPostProcess({
    inputPath: finalPath,
    outputPath: postPath,
    voice,
    style: built.styleName,
    voiceCharacter,
    voiceTone
  }).catch(() => false);
  if (postApplied && fs.existsSync(postPath)) {
    fs.renameSync(postPath, finalPath);
  } else if (fs.existsSync(postPath)) {
    fs.unlinkSync(postPath);
  }

  const mapPath = path.resolve(`${normalizedOutput}.prosody.json`);
  fs.writeFileSync(
    mapPath,
    JSON.stringify(
      {
        createdAt: new Date().toISOString(),
        voice,
        base: { rate, pitch, volume },
        style: built.styleName,
        profileFile: built.profileFile,
        humanizeIntensity,
        hybridProsody: Boolean(hybridProsody),
        backend: resolveBackendName(backend),
        voiceCharacter: {
          key: built.voiceCharacter || "default",
          speechStyle: built.speechStyle || "auto",
          voiceTone,
          postApplied: Boolean(postApplied)
        },
        mlPolicy: {
          enabled: Boolean(policy),
          modelMeta: policy?.meta || null
        },
        segments: prosodyMap
      },
      null,
      2
    ),
    "utf8"
  );

  return {
    audioPath: finalPath,
    prosodyPath: mapPath,
    segments: prosodyMap.length,
    style: built.styleName,
    profileFile: built.profileFile
  };
}
