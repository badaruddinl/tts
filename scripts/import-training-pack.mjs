import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";

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

function timestamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function copyRecursive(src, dest) {
  if (!fs.existsSync(src)) return;
  const st = fs.statSync(src);
  if (st.isFile()) {
    const parent = path.dirname(dest);
    if (!fs.existsSync(parent)) fs.mkdirSync(parent, { recursive: true });
    fs.copyFileSync(src, dest);
    return;
  }
  if (!fs.existsSync(dest)) fs.mkdirSync(dest, { recursive: true });
  const names = fs.readdirSync(src);
  for (const name of names) {
    copyRecursive(path.join(src, name), path.join(dest, name));
  }
}

function backupPath(target, backupRoot) {
  if (!fs.existsSync(target)) return null;
  const rel = path.relative(process.cwd(), target);
  const safeRel = rel.replace(/[:]/g, "_");
  const dst = path.join(backupRoot, safeRel);
  copyRecursive(target, dst);
  return dst;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const file = String(args.file || "").trim();
  if (!file) {
    console.error("Usage: npm run pack:import -- --file backups/training-pack-xxxx.zip");
    process.exit(1);
  }

  const zipPath = path.resolve(file);
  if (!fs.existsSync(zipPath)) {
    console.error(`Zip not found: ${zipPath}`);
    process.exit(1);
  }

  const backupRoot = path.resolve(process.cwd(), "backups", `pre-import-${timestamp()}`);
  fs.mkdirSync(backupRoot, { recursive: true });

  const tmpRoot = path.resolve(process.cwd(), ".tmp", `import-${timestamp()}`);
  fs.mkdirSync(tmpRoot, { recursive: true });

  const zip = new AdmZip(zipPath);
  zip.extractAllTo(tmpRoot, true);

  const candidates = [
    "config/profiles",
    "data/training",
    "models",
    ".env"
  ];

  const restored = [];
  const backups = [];
  for (const rel of candidates) {
    const src = path.resolve(tmpRoot, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.resolve(process.cwd(), rel);
    const b = backupPath(dst, backupRoot);
    if (b) backups.push(path.relative(process.cwd(), b));
    copyRecursive(src, dst);
    restored.push(rel);
  }

  console.log(`Imported from: ${zipPath}`);
  console.log(`Restored: ${restored.join(", ") || "-"}`);
  console.log(`Backup dir: ${path.relative(process.cwd(), backupRoot)}`);
  console.log(`Backed up: ${backups.join(", ") || "-"}`);
}

main();
