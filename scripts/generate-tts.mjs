import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  parseInputFile,
  synthesizeToMp3,
  synthesizeHumanizedToMp3
} from "../lib/tts-core.mjs";
import { getExpressionDefaultStyle, getExpressionRuntimeDefaults } from "../lib/expression-defaults.mjs";

dotenv.config({ quiet: true });

const DEFAULTS = {
  input: process.env.TTS_INPUT || "text.txt",
  output: process.env.TTS_OUTPUT || "output.mp3",
  voice: process.env.TTS_VOICE || "id-ID-GadisNeural",
  rate: process.env.TTS_RATE || "-8%",
  pitch: process.env.TTS_PITCH || "-2Hz",
  volume: process.env.TTS_VOLUME || "0%",
  segmentConcurrency: Number(process.env.TTS_SEGMENT_CONCURRENCY || "1")
};

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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const runtimeDefaults = getExpressionRuntimeDefaults();

  if (args.help) {
    console.log(
      "Usage: npm run tts -- --input text.txt --output season1.mp3 [--humanize true --style misteri --speech-style auto --voice-tone auto --voice-character true --segment-concurrency 2 --prosody-limiter true --prosody-limiter-strength 0.64]"
    );
    process.exit(0);
  }

  const input = path.resolve(String(args.input || DEFAULTS.input));
  if (!fs.existsSync(input)) {
    console.error(`Input file not found: ${input}`);
    process.exit(1);
  }

  const parsed = parseInputFile(input);
  if (!parsed.text) {
    console.error("Input text is empty after cleanup.");
    process.exit(1);
  }

  const output = String(args.output || parsed.meta.OUTPUT || DEFAULTS.output);
  const voice = String(args.voice || parsed.meta.VOICE || DEFAULTS.voice);
  const backend = String(args.backend ?? process.env.TTS_BACKEND ?? "edge");
  const rate = String(args.rate || parsed.meta.RATE || DEFAULTS.rate);
  const pitch = String(args.pitch || parsed.meta.PITCH || DEFAULTS.pitch);
  const volume = String(args.volume || parsed.meta.VOLUME || DEFAULTS.volume);
  const humanize = String(args.humanize || "").toLowerCase() === "true" || args.humanize === true;
  const humanizeIntensity = Number(
    args["humanize-intensity"] ??
      process.env.TTS_HUMANIZE_INTENSITY ??
      runtimeDefaults.humanizeIntensity ??
      0.45
  );
  const style = args.style ? String(args.style) : getExpressionDefaultStyle(process.env.TTS_STYLE || "natural");
  const useMlPolicy =
    String(args["ml-policy"] ?? process.env.TTS_ML_POLICY ?? "true").toLowerCase() === "true";
  const autoExpressive =
    String(
      args["auto-expressive"] ??
        process.env.TTS_AUTO_EXPRESSIVE ??
        (runtimeDefaults.autoExpressive === null ? "true" : String(runtimeDefaults.autoExpressive))
    ).toLowerCase() === "true";
  const speechStyle = String(args["speech-style"] ?? process.env.TTS_SPEECH_STYLE ?? "auto");
  const hybridProsody =
    String(
      args["hybrid-prosody"] ??
        process.env.TTS_HYBRID_PROSODY ??
        (runtimeDefaults.hybridProsody === null ? "true" : String(runtimeDefaults.hybridProsody))
    ).toLowerCase() === "true";
  const prosodyLimiter =
    String(
      args["prosody-limiter"] ??
        process.env.TTS_PROSODY_LIMITER ??
        (runtimeDefaults?.prosodyLimiter?.enabled === null
          ? "true"
          : String(runtimeDefaults.prosodyLimiter.enabled))
    ).toLowerCase() === "true";
  const prosodyLimiterStrength = Number(
    args["prosody-limiter-strength"] ??
      process.env.TTS_PROSODY_LIMITER_STRENGTH ??
      runtimeDefaults?.prosodyLimiter?.strength ??
      0.64
  );
  const voiceCharacter =
    String(args["voice-character"] ?? process.env.TTS_VOICE_CHARACTER ?? "true").toLowerCase() ===
    "true";
  const legacyArdiHeavy =
    String(args["ardi-heavy"] ?? process.env.TTS_ARDI_HEAVY ?? "").toLowerCase().trim();
  let voiceTone = String(args["voice-tone"] ?? process.env.TTS_VOICE_TONE ?? "auto");
  if (legacyArdiHeavy === "true" && (!args["voice-tone"] || String(args["voice-tone"]).trim() === "")) {
    voiceTone = "deep";
  }
  if (legacyArdiHeavy === "false" && (!args["voice-tone"] || String(args["voice-tone"]).trim() === "")) {
    voiceTone = "off";
  }

  if (humanize) {
    const segmentConcurrencyRaw = Number(args["segment-concurrency"] ?? DEFAULTS.segmentConcurrency ?? 1);
    const segmentConcurrency = Number.isFinite(segmentConcurrencyRaw)
      ? Math.max(1, Math.min(8, Math.floor(segmentConcurrencyRaw)))
      : 1;
    const res = await synthesizeHumanizedToMp3({
      text: parsed.text,
      output,
      voice,
      rate,
      pitch,
      volume,
      cacheDir: path.resolve(process.cwd(), ".tts-cache"),
      humanizeIntensity,
      style,
      speechStyle,
      useMlPolicy,
      autoExpressive,
      voiceCharacter,
      voiceTone,
      hybridProsody,
      backend,
      segmentConcurrency,
      prosodyLimiter,
      prosodyLimiterStrength
    });
    console.log(
      `Humanize done: audio=${path.basename(res.audioPath)}, prosody=${path.basename(res.prosodyPath)}, segments=${res.segments}, style=${res.style}, profile=${res.profileFile}`
    );
  } else {
    await synthesizeToMp3({
      text: parsed.text,
      output,
      voice,
      rate,
      pitch,
      volume,
      cacheDir: path.resolve(process.cwd(), ".tts-cache"),
      backend
    });
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
