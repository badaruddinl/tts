import fs from "fs";
import path from "path";
import crypto from "crypto";
import { buildSamples, rowsWithAdjust } from "./ml-policy-dataset.mjs";

function resolveProsodyPath(row) {
  if (!row?.prosodyFile) return null;
  const p = path.resolve(process.cwd(), "outputs", row.prosodyFile);
  return fs.existsSync(p) ? p : null;
}

function safeStat(filePath) {
  try {
    const s = fs.statSync(filePath);
    return { mtimeMs: Number(s.mtimeMs || 0), size: Number(s.size || 0) };
  } catch {
    return { mtimeMs: 0, size: 0 };
  }
}

function computeSignature({ feedbackFile, rows }) {
  const target = path.resolve(feedbackFile);
  const feedbackStat = safeStat(target);
  const prosodyRows = rowsWithAdjust(rows);
  const prosodyStats = [];
  for (const row of prosodyRows) {
    const p = resolveProsodyPath(row);
    if (!p) continue;
    const st = safeStat(p);
    prosodyStats.push(`${path.relative(process.cwd(), p)}:${st.mtimeMs}:${st.size}`);
  }
  prosodyStats.sort();
  const raw = JSON.stringify({
    feedbackFile: path.relative(process.cwd(), target).replace(/\\/g, "/"),
    feedbackMtimeMs: feedbackStat.mtimeMs,
    feedbackSize: feedbackStat.size,
    feedbackRows: rows.length,
    prosodyCount: prosodyStats.length,
    prosodyStats
  });
  return crypto.createHash("sha1").update(raw).digest("hex");
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true });
}

export function loadSamplesWithCache({
  feedbackFile,
  rows,
  cacheDir = path.resolve(process.cwd(), ".tts-cache", "ml-samples"),
  useCache = true
}) {
  const signature = computeSignature({ feedbackFile, rows });
  const cachePath = path.resolve(cacheDir, `${signature}.json`);
  if (useCache && fs.existsSync(cachePath)) {
    const payload = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const samples = Array.isArray(payload?.samples) ? payload.samples : [];
    return {
      signature,
      cachePath,
      cacheHit: true,
      rowsWithAdjust: Number(payload?.rowsWithAdjust ?? 0),
      samples
    };
  }

  const adjusted = rowsWithAdjust(rows);
  const samples = buildSamples(adjusted);
  if (useCache) {
    ensureDir(cacheDir);
    fs.writeFileSync(
      cachePath,
      JSON.stringify(
        {
          createdAt: new Date().toISOString(),
          feedbackFile: path.relative(process.cwd(), feedbackFile).replace(/\\/g, "/"),
          signature,
          rows: rows.length,
          rowsWithAdjust: adjusted.length,
          samples
        },
        null,
        2
      ),
      "utf8"
    );
  }

  return {
    signature,
    cachePath,
    cacheHit: false,
    rowsWithAdjust: adjusted.length,
    samples
  };
}
