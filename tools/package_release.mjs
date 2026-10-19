// Deterministic ZIP writer (store + deflate) with entry-by-entry verification.
import { deflateRawSync, inflateRawSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERSION = "0.2.1";
const zipPath = resolve(root, "dist", `motion-rally-v${VERSION}.zip`);
const sumsPath = resolve(root, "dist", `SHA256SUMS-v${VERSION}.txt`);

const FILES = [
  ".gitattributes",
  ".gitignore",
  "LICENSE",
  "README.md",
  "docs/browser-qa.json", "docs/audit-controller.png", "docs/audit-court.png", ".github/workflows/verify.yml",
  "docs/preview-controller.png",
  "docs/preview-host.png",
  "package-lock.json",
  "package.json",
  "public/controller.html",
  "public/controller.js",
  "public/host.js",
  "public/index.html",
  "public/style.css",
  "public/three.min.js",
  "reports/load.json",
  "server/commentary.mjs",
  "server/game.mjs",
  "server/protocol.mjs",
  "server/server.mjs",
  "tests/rally.test.mjs",
  "tools/browser_qa.mjs",
  "tools/load_test.mjs",
  "tools/package_release.mjs",
];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

// 2026-10-19 00:00:00 in DOS date/time.
const DOS_TIME = 0;
const DOS_DATE = ((2026 - 1980) << 9) | (10 << 5) | 19;

function buildZip(entries) {
  const chunks = [];
  const central = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data, { level: 9 });
    const checksum = crc32(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(checksum, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    chunks.push(local, name, compressed);

    const record = Buffer.alloc(46);
    record.writeUInt32LE(0x02014b50, 0);
    record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6);
    record.writeUInt16LE(0x0800, 8);
    record.writeUInt16LE(8, 10);
    record.writeUInt16LE(DOS_TIME, 12);
    record.writeUInt16LE(DOS_DATE, 14);
    record.writeUInt32LE(checksum, 16);
    record.writeUInt32LE(compressed.length, 20);
    record.writeUInt32LE(entry.data.length, 24);
    record.writeUInt16LE(name.length, 28);
    record.writeUInt16LE(0, 30);
    record.writeUInt16LE(0, 32);
    record.writeUInt16LE(0, 34);
    record.writeUInt16LE(0, 36);
    record.writeUInt32LE(0, 38);
    record.writeUInt32LE(offset, 42);
    central.push(Buffer.concat([record, name]));
    offset += local.length + name.length + compressed.length;
  }
  const centralBuffer = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuffer.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...chunks, centralBuffer, end]);
}

function readZip(buffer) {
  const entries = new Map();
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const checksum = buffer.readUInt32LE(offset + 14);
    const compressedSize = buffer.readUInt32LE(offset + 18);
    const size = buffer.readUInt32LE(offset + 22);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extraLength = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString("utf8", offset + 30, offset + 30 + nameLength);
    const dataStart = offset + 30 + nameLength + extraLength;
    const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
    const data = method === 8 ? inflateRawSync(compressed) : compressed;
    entries.set(name, { data, checksum, size });
    offset = dataStart + compressedSize;
  }
  return entries;
}

const files = FILES.filter((name) => {
  try { readFileSync(resolve(root, name)); return true; } catch { return false; }
});
const missing = FILES.filter((name) => !files.includes(name));
if (missing.length) {
  console.error("missing release files:", missing.join(", "));
  process.exit(1);
}

const entries = files.sort().map((name) => ({ name, data: readFileSync(resolve(root, name)) }));
const zip = buildZip(entries);
mkdirSync(resolve(root, "dist"), { recursive: true });
writeFileSync(zipPath, zip);

const sums = entries
  .map((entry) => `${createHash("sha256").update(entry.data).digest("hex")}  ${entry.name}`)
  .join("\n") + "\n";
writeFileSync(sumsPath, sums);

const verified = readZip(zip);
const mismatches = [];
for (const entry of entries) {
  const stored = verified.get(entry.name);
  if (!stored) mismatches.push(`missing ${entry.name}`);
  else if (!stored.data.equals(entry.data)) mismatches.push(`content differs: ${entry.name}`);
  else if (stored.checksum !== crc32(entry.data)) mismatches.push(`crc differs: ${entry.name}`);
}
if (verified.size !== entries.length) mismatches.push("entry count differs");

const result = {
  version: VERSION,
  zip: `dist/${zipPath.split(/[\\/]/).pop()}`,
  zipBytes: zip.length,
  zipSha256: createHash("sha256").update(zip).digest("hex"),
  sums: `dist/${sumsPath.split(/[\\/]/).pop()}`,
  sumsSha256: createHash("sha256").update(readFileSync(sumsPath)).digest("hex"),
  files: entries.length,
  verified: mismatches.length === 0,
  mismatches,
};
console.log(JSON.stringify(result, null, 2));
process.exit(result.verified ? 0 : 1);
