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

function addPathIfExists(zip, rootDir, relPath, fileList) {
  const full = path.resolve(rootDir, relPath);
  if (!fs.existsSync(full)) return;
  const stat = fs.statSync(full);
  if (stat.isFile()) {
    zip.addLocalFile(full, path.dirname(relPath).replace(/\\/g, "/"));
    fileList.push(relPath.replace(/\\/g, "/"));
    return;
  }
  if (stat.isDirectory()) {
    zip.addLocalFolder(full, relPath.replace(/\\/g, "/"));
    fileList.push(`${relPath.replace(/\\/g, "/")}/`);
  }
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const includeEnv = String(args["include-env"] || "false").toLowerCase() === "true";
  const outDir = path.resolve(process.cwd(), "backups");
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  const outFile =
    args.output
      ? path.resolve(String(args.output))
      : path.join(outDir, `training-pack-${timestamp()}.zip`);

  const zip = new AdmZip();
  const root = process.cwd();
  const fileList = [];
  const targets = [
    "config/profiles",
    "data/training",
    "models"
  ];
  if (includeEnv) targets.push(".env");

  for (const t of targets) {
    addPathIfExists(zip, root, t, fileList);
  }

  const manifest = {
    createdAt: new Date().toISOString(),
    sourceHost: process.env.COMPUTERNAME || process.env.HOSTNAME || "unknown",
    includeEnv,
    files: fileList
  };
  zip.addFile("training-pack.manifest.json", Buffer.from(JSON.stringify(manifest, null, 2), "utf8"));
  zip.writeZip(outFile);

  console.log(`Exported: ${outFile}`);
  console.log(`Entries: ${fileList.length}`);
}

main();
