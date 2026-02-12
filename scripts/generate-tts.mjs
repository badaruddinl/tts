import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import {
  parseInputFile,
  synthesizeToMp3,
  synthesizeHumanizedToMp3
} from "../lib/tts-core.mjs";

dotenv.config({ quiet: true });

const DEFAULTS = {
  input: process.env.TTS_INPUT || "text.txt",
  output: process.env.TTS_OUTPUT || "output.mp3",
  voice: process.env.TTS_VOICE || "id-ID-GadisNeural",
  rate: process.env.TTS_RATE || "-8%",
  pitch: process.env.TTS_PITCH || "-2Hz",
  volume: process.env.TTS_VOLUME || "0%"
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

  if (args.help) {
    console.log("Usage: npm run tts -- --input text.txt --output season1.mp3 [--humanize true --style misteri]");
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
  const rate = String(args.rate || parsed.meta.RATE || DEFAULTS.rate);
  const pitch = String(args.pitch || parsed.meta.PITCH || DEFAULTS.pitch);
  const volume = String(args.volume || parsed.meta.VOLUME || DEFAULTS.volume);
  const humanize = String(args.humanize || "").toLowerCase() === "true" || args.humanize === true;
  const humanizeIntensity = Number(args["humanize-intensity"] ?? process.env.TTS_HUMANIZE_INTENSITY ?? 0.45);
  const style = args.style ? String(args.style) : null;
  const useMlPolicy =
    String(args["ml-policy"] ?? process.env.TTS_ML_POLICY ?? "true").toLowerCase() === "true";

  if (humanize) {
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
      useMlPolicy
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
      cacheDir: path.resolve(process.cwd(), ".tts-cache")
    });
  }
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
