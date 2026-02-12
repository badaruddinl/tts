import fs from "fs";
import path from "path";
import { parseText, synthesizeHumanizedToMp3 } from "../lib/tts-core.mjs";

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

function average(items) {
  if (!items.length) return 0;
  return items.reduce((s, n) => s + n, 0) / items.length;
}

function readTestText(dirPath) {
  const files = fs
    .readdirSync(dirPath, { withFileTypes: true })
    .filter((d) => d.isFile() && d.name.toLowerCase().endsWith(".txt"))
    .map((d) => d.name)
    .sort();
  if (!files.length) {
    throw new Error(`No .txt voice test files found in ${dirPath}`);
  }
  const first = files[0];
  const raw = fs.readFileSync(path.join(dirPath, first), "utf8");
  const parsed = parseText(raw);
  return {
    file: first,
    text: parsed.text || raw
  };
}

async function runCase({
  text,
  outputBase,
  voice,
  style,
  speechStyle,
  voiceTone
}) {
  const res = await synthesizeHumanizedToMp3({
    text,
    output: outputBase,
    voice,
    rate: "-8%",
    pitch: "-2Hz",
    volume: "0%",
    humanizeIntensity: 0.55,
    style,
    speechStyle,
    useMlPolicy: false,
    autoExpressive: true,
    voiceCharacter: true,
    voiceTone
  });
  const prosody = JSON.parse(fs.readFileSync(res.prosodyPath, "utf8"));
  const seg = Array.isArray(prosody.segments) ? prosody.segments : [];
  return {
    voice,
    style: prosody.style,
    speechStyle,
    voiceTone,
    outputAudio: path.relative(process.cwd(), res.audioPath),
    outputProsody: path.relative(process.cwd(), res.prosodyPath),
    segments: seg.length,
    avgRate: Number(average(seg.map((s) => Number(s?.final?.rate ?? s?.rate ?? 0))).toFixed(3)),
    avgPitch: Number(average(seg.map((s) => Number(s?.final?.pitch ?? s?.pitch ?? 0))).toFixed(3)),
    postApplied: Boolean(prosody?.voiceCharacter?.postApplied)
  };
}

function boolAll(items) {
  return items.every(Boolean);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const testsDir = path.resolve(String(args.dir || "tests/voice"));
  const outDir = path.resolve(String(args.outdir || "outputs/voice_eval_suite"));
  const style = String(args.style || "tegang");
  const minRateDelta = Number(args["min-rate-delta"] ?? 1.0);
  const voices = String(args.voices || "id-ID-ArdiNeural,id-ID-GadisNeural")
    .split(",")
    .map((v) => String(v || "").trim())
    .filter(Boolean);

  if (!fs.existsSync(testsDir)) {
    throw new Error(`Voice tests directory not found: ${testsDir}`);
  }
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const sample = readTestText(testsDir);
  const configs = [
    { speechStyle: "relaxed", voiceTone: "auto" },
    { speechStyle: "assertive", voiceTone: "auto" },
    { speechStyle: "dramatic", voiceTone: "deep" },
    { speechStyle: "dramatic", voiceTone: "bright" },
    { speechStyle: "dramatic", voiceTone: "off" }
  ];

  const rows = [];
  for (const voice of voices) {
    for (const cfg of configs) {
      const base = path.join(
        outDir,
        `${voice.replace(/[^a-z0-9]/gi, "_")}_${cfg.speechStyle}_${cfg.voiceTone}`
      );
      const result = await runCase({
        text: sample.text,
        outputBase: base,
        voice,
        style,
        speechStyle: cfg.speechStyle,
        voiceTone: cfg.voiceTone
      });
      rows.push(result);
      console.log(
        `voice_case voice=${voice} speech_style=${cfg.speechStyle} voice_tone=${cfg.voiceTone} post=${result.postApplied} avg_rate=${result.avgRate}`
      );
    }
  }

  const checks = [];
  for (const voice of voices) {
    const relaxed = rows.find((r) => r.voice === voice && r.speechStyle === "relaxed" && r.voiceTone === "auto");
    const assertive = rows.find(
      (r) => r.voice === voice && r.speechStyle === "assertive" && r.voiceTone === "auto"
    );
    const deep = rows.find((r) => r.voice === voice && r.voiceTone === "deep");
    const bright = rows.find((r) => r.voice === voice && r.voiceTone === "bright");
    const off = rows.find((r) => r.voice === voice && r.voiceTone === "off");

    const rateDelta = Number(((assertive?.avgRate ?? 0) - (relaxed?.avgRate ?? 0)).toFixed(3));
    const perVoice = {
      voice,
      relaxedVsAssertiveRateDelta: rateDelta,
      relaxedVsAssertiveOk: rateDelta >= minRateDelta,
      deepPostOk: Boolean(deep?.postApplied),
      brightPostOk: Boolean(bright?.postApplied),
      offPostDisabledOk: !Boolean(off?.postApplied)
    };
    checks.push(perVoice);
  }

  const summary = {
    at: new Date().toISOString(),
    testsDir: path.relative(process.cwd(), testsDir),
    sampleFile: sample.file,
    style,
    minRateDelta,
    caseCount: rows.length,
    voices,
    checks,
    gate: {
      status: boolAll(
        checks.map(
          (c) => c.relaxedVsAssertiveOk && c.deepPostOk && c.brightPostOk && c.offPostDisabledOk
        )
      )
        ? "pass"
        : "fail"
    },
    cases: rows
  };

  const jsonPath = path.join(outDir, "summary.json");
  fs.writeFileSync(jsonPath, JSON.stringify(summary, null, 2), "utf8");

  const md = [
    "# Voice Character Eval Suite",
    "",
    `- Generated at: ${summary.at}`,
    `- Test dir: \`${summary.testsDir}\``,
    `- Sample file: \`${summary.sampleFile}\``,
    `- Style: \`${summary.style}\``,
    `- Gate: **${summary.gate.status.toUpperCase()}**`,
    "",
    "## Voice Checks",
    "",
    "| voice | rateDelta(assertive-relaxed) | rateOk | deepPost | brightPost | offDisabled |",
    "|---|---:|---|---|---|---|"
  ];
  for (const c of checks) {
    md.push(
      `| ${c.voice} | ${c.relaxedVsAssertiveRateDelta} | ${c.relaxedVsAssertiveOk} | ${c.deepPostOk} | ${c.brightPostOk} | ${c.offPostDisabledOk} |`
    );
  }
  const mdPath = path.join(outDir, "summary.md");
  fs.writeFileSync(mdPath, `${md.join("\n")}\n`, "utf8");

  console.log(
    `voice_eval_done gate=${summary.gate.status} cases=${rows.length} summary_json=${path.relative(process.cwd(), jsonPath)} summary_md=${path.relative(process.cwd(), mdPath)}`
  );
  if (summary.gate.status !== "pass") process.exitCode = 2;
}

main().catch((err) => {
  console.error(err.message || String(err));
  process.exit(1);
});
