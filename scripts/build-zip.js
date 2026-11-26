/**
 * Build script: packages the production extension files into claimit-extension.zip.
 * Excludes development-only files: tests, scripts, docs, .git, node_modules,
 * eslint config, package metadata, and markdown documentation.
 *
 * Pure Node.js — no external dependencies, no shell calls.
 * Run: node scripts/build-zip.js
 */

import { readFileSync, writeFileSync, statSync, readdirSync, existsSync, unlinkSync } from 'node:fs';
import { join, relative, extname } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = join(fileURLToPath(import.meta.url), '..', '..');
const OUT = join(ROOT, 'claimit-extension.zip');

const INCLUDE_DIRS = ['src', 'assets', 'config'];
const INCLUDE_FILES = ['manifest.json'];
const ALLOWED_EXTS = new Set(['.js', '.css', '.html', '.json', '.svg', '.png']);
const EXCLUDE_RE = [/\.test\.js$/, /eslint\.config/, /^assets\/logo\.svg$/];

function shouldInclude(rel) {
  if (EXCLUDE_RE.some((p) => p.test(rel))) return false;
  return ALLOWED_EXTS.has(extname(rel));
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(full));
    else {
      const rel = relative(ROOT, full).replace(/\\/g, '/');
      if (shouldInclude(rel)) out.push({ full, rel });
    }
  }
  return out;
}

// CRC-32 lookup table
const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c;
}
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = (c >>> 8) ^ CRC_TABLE[(c ^ buf[i]) & 0xff];
  return (c ^ 0xffffffff) >>> 0;
}

function u16(n) { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; }
function u32(n) { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; }

// Collect files
const files = [];
for (const name of INCLUDE_FILES) {
  const full = join(ROOT, name);
  if (existsSync(full)) files.push({ full, rel: name });
}
for (const dir of INCLUDE_DIRS) {
  const d = join(ROOT, dir);
  if (existsSync(d)) files.push(...walk(d));
}

// Build ZIP in memory
const parts = [];
const central = [];
let offset = 0;

for (const { full, rel } of files) {
  const raw = readFileSync(full);
  const crc = crc32(raw);
  const compressed = deflateRawSync(raw);
  const useDeflate = compressed.length < raw.length;
  const data = useDeflate ? compressed : raw;
  const method = useDeflate ? 8 : 0;
  const nameBytes = Buffer.from(rel, 'utf8');

  const local = Buffer.concat([
    Buffer.from('PK\x03\x04'),
    u16(20), u16(0), u16(method),
    u16(0), u16(0),
    u32(crc), u32(data.length), u32(raw.length),
    u16(nameBytes.length), u16(0),
    nameBytes
  ]);

  parts.push(local, data);

  central.push(Buffer.concat([
    Buffer.from('PK\x01\x02'),
    u16(20), u16(20), u16(0), u16(method),
    u16(0), u16(0),
    u32(crc), u32(data.length), u32(raw.length),
    u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0),
    u32(0), u32(offset),
    nameBytes
  ]));

  offset += local.length + data.length;
  const pct = ((raw.length - data.length) / raw.length * 100).toFixed(0);
  console.log(`  ${(raw.length / 1024).toFixed(1).padStart(6)} KB  ${rel}  (${pct}% saved)`);
}

const cdStart = offset;
for (const c of central) { parts.push(c); offset += c.length; }
const cdSize = offset - cdStart;

parts.push(Buffer.concat([
  Buffer.from('PK\x05\x06'),
  u16(0), u16(0),
  u16(central.length), u16(central.length),
  u32(cdSize), u32(cdStart),
  u16(0)
]));

if (existsSync(OUT)) unlinkSync(OUT);
writeFileSync(OUT, Buffer.concat(parts));

const zipSize = statSync(OUT).size;
console.log(`\nFiles: ${files.length}`);
console.log(`Source: ${(files.reduce((s, f) => s + statSync(f.full).size, 0) / 1024).toFixed(1)} KB`);
console.log(`ZIP:   ${(zipSize / 1024).toFixed(1)} KB`);
console.log(`Output: ${OUT}`);
