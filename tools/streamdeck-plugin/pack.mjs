// Rebuilds the prebuilt Stream Deck plugin package from the current sources WITHOUT the Elgato CLI:
//   node tools/streamdeck-plugin/pack.mjs
// 1. bundles src/plugin.ts (+ face.ts, @elgato/streamdeck, ws) into com.vtubepro.deck.sdPlugin/bin/plugin.js with esbuild
//    (the repo's own esbuild; same ESM / Node 20 output the rollup config makes), stamped with a hash of the sources;
// 2. zips the .sdPlugin folder into release/com.vtubepro.deck.streamDeckPlugin, byte for byte the same every run
//    (sorted entries, fixed timestamps, level-9 deflate), which is what `streamdeck pack` produces: a zip with the
//    com.vtubepro.deck.sdPlugin/ folder at its root.
// `npm run pack` (the Elgato CLI route in package.json) still works for anyone who has the CLI installed.
// @elgato/streamdeck and ws must be resolvable: `cd tools/streamdeck-plugin && npm install` (or point NODE_PATH at a
// node_modules that has them). tools/streamdeck_pkg_unit.ts checks the result; the release must run this first.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SD_NAME = 'com.vtubepro.deck.sdPlugin';
export const SD_DIR = path.join(HERE, SD_NAME);
export const PACKAGE_PATH = path.join(HERE, 'release', 'com.vtubepro.deck.streamDeckPlugin');
export const SOURCE_FILES = ['src/plugin.ts', 'src/face.ts'];
export const STAMP_RE = /^\/\/ vtp-sources sha256:([0-9a-f]{64})/m;

/** sha256 over the plugin sources with line endings normalised (a CRLF checkout must hash the same). */
export function sourceHash() {
  const h = crypto.createHash('sha256');
  for (const f of SOURCE_FILES) {
    h.update(f + '\n');
    h.update(fs.readFileSync(path.join(HERE, f), 'utf8').replace(/\r\n/g, '\n'));
  }
  return h.digest('hex');
}

// ---------------------------------------------------------------- minimal zip (store / deflate), no dependencies
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; }
  return t;
})();
export function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
const DOS_TIME = 0, DOS_DATE = (1 << 5) | 1;   // 1980-01-01 00:00:00, the zip epoch: the same bytes on every build

/** entries: [name, Buffer][] in the order to write. Returns the zip as a Buffer. */
export function zipEntries(entries) {
  const parts = [], central = [];
  let offset = 0;
  for (const [name, data] of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const body = useDeflate ? deflated : data, method = useDeflate ? 8 : 0, crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(0x0800, 6); local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10); local.writeUInt16LE(DOS_DATE, 12); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(data.length, 22); local.writeUInt16LE(nameBuf.length, 26); local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0); cen.writeUInt16LE(20, 4); cen.writeUInt16LE(20, 6); cen.writeUInt16LE(0x0800, 8); cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(DOS_TIME, 12); cen.writeUInt16LE(DOS_DATE, 14); cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20); cen.writeUInt32LE(data.length, 24); cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cenBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenBuf.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cenBuf, end]);
}

/** Reads every file of a zip into a Map name -> Buffer (checks each CRC). */
export function readZip(buf) {
  let e = buf.length - 22;
  while (e >= 0 && buf.readUInt32LE(e) !== 0x06054b50) e--;
  if (e < 0) throw new Error('not a zip: no end-of-central-directory record');
  const count = buf.readUInt16LE(e + 10);
  let p = buf.readUInt32LE(e + 16);
  const out = new Map();
  for (let i = 0; i < count; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nlen);
    const dataStart = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28);
    const raw = buf.subarray(dataStart, dataStart + csize);
    const data = method === 0 ? raw : method === 8 ? zlib.inflateRawSync(raw) : (() => { throw new Error(`unsupported zip method ${method}`); })();
    if (data.length !== usize || crc32(data) !== crc) throw new Error(`corrupt zip entry ${name}`);
    if (!name.endsWith('/')) out.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

// ---------------------------------------------------------------- build
function listFiles(dir, rel = '') {
  const out = [];
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    const r = rel ? `${rel}/${d.name}` : d.name;
    if (d.isDirectory()) { if (d.name !== 'logs') out.push(...listFiles(path.join(dir, d.name), r)); }
    else if (!d.name.endsWith('.map')) out.push(r);
  }
  return out;
}

export async function bundle() {
  const { build } = await import('esbuild');
  const banner = `// vtp-sources sha256:${sourceHash()}\nimport { createRequire as __vtpCreateRequire } from 'node:module';\nconst require = __vtpCreateRequire(import.meta.url);`;
  const res = await build({
    write: false,
    entryPoints: [path.join(HERE, 'src/plugin.ts')],
    outfile: path.join(SD_DIR, 'bin/plugin.js'),
    absWorkingDir: HERE, bundle: true, platform: 'node', format: 'esm', target: 'node20', sourcemap: false, legalComments: 'none',
    nodePaths: (process.env.NODE_PATH || '').split(path.delimiter).filter(Boolean),
    external: ['bufferutil', 'utf-8-validate'], tsconfig: path.join(HERE, 'tsconfig.json'), banner: { js: banner }, logLevel: 'warning',
  });
  // esbuild writes the path of every bundled file relative to this machine's folders ("../../../AppData/.../node_modules/ws/...");
  // cut that down to "node_modules/..." so the package is the same on every machine and leaks no user folder names.
  const code = res.outputFiles[0].text.replace(/(?:\.\.\/)+[^"'\r\n]*?node_modules\//g, 'node_modules/');
  fs.mkdirSync(path.join(SD_DIR, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(SD_DIR, 'bin/plugin.js'), code);
  fs.writeFileSync(path.join(SD_DIR, 'bin/package.json'), '{ "type": "module" }');
}

export function pack() {
  const files = listFiles(SD_DIR).sort();
  const entries = files.map((f) => [`${SD_NAME}/${f}`, fs.readFileSync(path.join(SD_DIR, f))]);
  fs.mkdirSync(path.dirname(PACKAGE_PATH), { recursive: true });
  fs.writeFileSync(PACKAGE_PATH, zipEntries(entries));
  return files;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await bundle();
  const files = pack();
  console.log(`packed ${files.length} files -> ${path.relative(process.cwd(), PACKAGE_PATH)} (${fs.statSync(PACKAGE_PATH).size} bytes, sources ${sourceHash().slice(0, 12)})`);
}
