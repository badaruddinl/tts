import { trainProfileFromFeedback } from "../lib/profile-trainer.mjs";

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

function main() {
  const args = parseArgs(process.argv.slice(2));
  const apply = args.apply === true || String(args.apply || "").toLowerCase() === "true";
  const minFeedback = Number(args["min-feedback"] ?? 1);
  const res = trainProfileFromFeedback({ apply, minFeedback });

  if (res.status === "trained") {
    console.log(`Training complete: ${res.file}`);
    console.log(`From profile: ${res.from}`);
    console.log(`Feedback rows: ${res.feedbackRows}`);
    console.log(`Applied: ${res.applied}`);
    return;
  }

  console.log(`Training skipped: ${res.reason}`);
  console.log(`Feedback rows: ${res.feedbackRows}`);
  console.log(`Active profile: ${res.activeProfile}`);
}

main();
