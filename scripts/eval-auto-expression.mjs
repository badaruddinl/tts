import fs from "fs";
import path from "path";
import { parseInputFile, previewAutoExpressionFromText } from "../lib/tts-core.mjs";

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

function avg(items) {
  if (!items.length) return 0;
  return items.reduce((s, n) => s + n, 0) / items.length;
}

function transitionScore(segments) {
  const delta = [];
  for (let i = 1; i < segments.length; i += 1) {
    const a = segments[i - 1];
    const b = segments[i];
    delta.push(
      Math.abs((b.rate ?? 0) - (a.rate ?? 0)) +
        Math.abs((b.pitch ?? 0) - (a.pitch ?? 0)) +
        Math.abs((b.volume ?? 0) - (a.volume ?? 0))
    );
  }
  return Number(avg(delta).toFixed(3));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const input = path.resolve(String(args.input || "text_intent_test.txt"));
  const output = path.resolve(String(args.output || "outputs/auto_expression_eval.json"));
  const style = args.style ? String(args.style) : null;
  const humanizeIntensity = Number(args["humanize-intensity"] ?? 0.7);

  if (!fs.existsSync(input)) {
    throw new Error(`Input file not found: ${input}`);
  }

  const parsed = parseInputFile(input);
  if (!parsed.text) {
    throw new Error("Input text is empty after cleanup.");
  }

  const autoRun = previewAutoExpressionFromText({
    text: parsed.text,
    style,
    humanizeIntensity,
    autoExpressive: true,
    allowIntentOverride: false
  });
  const overrideRun = previewAutoExpressionFromText({
    text: parsed.text,
    style,
    humanizeIntensity,
    autoExpressive: true,
    allowIntentOverride: true
  });

  const autoSeg = autoRun.segments || [];
  const overSeg = overrideRun.segments || [];
  const count = Math.min(autoSeg.length, overSeg.length);
  let changedIntent = 0;
  let overrideIntentCount = 0;
  for (let i = 0; i < count; i += 1) {
    if ((autoSeg[i]?.reason?.intent || "netral") !== (overSeg[i]?.reason?.intent || "netral")) {
      changedIntent += 1;
    }
    if (overSeg[i]?.reason?.intentSource === "tag_override") {
      overrideIntentCount += 1;
    }
  }

  const report = {
    at: new Date().toISOString(),
    input: path.relative(process.cwd(), input),
    styleAuto: autoRun.styleName,
    styleOverride: overrideRun.styleName,
    segments: count,
    metrics: {
      autoTransitionDelta: transitionScore(autoSeg),
      overrideTransitionDelta: transitionScore(overSeg),
      changedIntentSegments: changedIntent,
      overrideIntentSegments: overrideIntentCount
    },
    auto: autoSeg.map((s) => ({
      index: s.index,
      text: s.text,
      intent: s.reason?.intent,
      intensity: s.reason?.intentIntensity,
      transition: s.reason?.transition
    })),
    override: overSeg.map((s) => ({
      index: s.index,
      text: s.text,
      intent: s.reason?.intent,
      intensity: s.reason?.intentIntensity,
      source: s.reason?.intentSource,
      transition: s.reason?.transition
    }))
  };

  const parent = path.dirname(output);
  if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
  fs.writeFileSync(output, JSON.stringify(report, null, 2), "utf8");

  console.log(
    `eval_done file=${path.relative(process.cwd(), output)} segments=${count} changed=${changedIntent} tag_override=${overrideIntentCount}`
  );
}

main();
