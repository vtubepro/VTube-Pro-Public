// A small, strict ZIP reader for archives we download (the ML pack's code, tools/gpu/rigml_setup.ts). No external tool (a `tar` on
// PATH may be GNU tar, which cannot read zips and mistakes "C:" for a host), no extra package. Supports stored + deflate entries
// (what GitHub code archives use), refuses everything else. Before anything is written it checks every entry:
//   * a path that is absolute, has a drive letter, a backslash, a NUL, or a ".." step, or would land outside the folder
//   * a symbolic link (the Unix mode in the central directory)
//   * too many files, too many bytes in total, a single file over the limit, a size that disagrees with the real data
//   * a wrong CRC-32
//   * ZIP64 (not needed for code archives)
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

export interface UnzipLimits { maxFiles: number; maxTotalBytes: number; maxFileBytes: number }
export const DEFAULT_LIMITS: UnzipLimits = { maxFiles: 5000, maxTotalBytes: 400e6, maxFileBytes: 150e6 };

export class UnzipError extends Error {}

interface Entry { name: string; method: number; csize: number; usize: number; crc: number; offset: number; mode: number; isDir: boolean }

const EOCD = 0x06054b50, CEN = 0x02014b50, LOC = 0x04034b50;

/** CON, PRN, AUX, NUL, COM1-9, LPT1-9, with any extension ("nul.txt" is still the NUL device on Windows). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Why an entry name may not be unpacked (null = fine). */
export function badEntryName(name: string): string | null {
  if (!name) return 'empty name';
  if (name.includes('\0')) return 'NUL in a name';
  if (name.includes('\\')) return 'backslash in a name';
  if (name.includes(':')) return 'a colon in a name';
  if (name.startsWith('/') || /^[a-z]:/i.test(name)) return 'absolute path';
  if (name.split('/').some((s) => s === '..')) return 'a ".." step';
  for (const seg of name.split('/')) {
    if (!seg) continue;
    // Windows drops a trailing dot or space (so "a.txt." and "a.txt" would be one file) and treats device names as devices
    if (/[. ]$/.test(seg)) return 'a name ending in a dot or a space';
    if (WINDOWS_DEVICE.test(seg)) return 'a Windows device name';
  }
  return null;
}

export function listZip(buf: Buffer): Entry[] {
  const min = Math.max(0, buf.length - 22 - 65535);
  let e = -1;
  for (let i = buf.length - 22; i >= min; i--) if (buf.readUInt32LE(i) === EOCD) { e = i; break; }
  if (e < 0) throw new UnzipError('not a zip file');
  const count = buf.readUInt16LE(e + 10), cdSize = buf.readUInt32LE(e + 12), cdOff = buf.readUInt32LE(e + 16);
  if (count === 0xffff || cdSize === 0xffffffff || cdOff === 0xffffffff) throw new UnzipError('zip64 archives are not supported');
  if (cdOff + cdSize > buf.length) throw new UnzipError('damaged zip (directory outside the file)');
  const out: Entry[] = [];
  let p = cdOff;
  for (let i = 0; i < count; i++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== CEN) throw new UnzipError('damaged zip (bad directory entry)');
    const madeBy = buf.readUInt16LE(p + 4), flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16), csize = buf.readUInt32LE(p + 20), usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28), xlen = buf.readUInt16LE(p + 30), clen = buf.readUInt16LE(p + 32);
    const ext = buf.readUInt32LE(p + 38), offset = buf.readUInt32LE(p + 42);
    if (csize === 0xffffffff || usize === 0xffffffff || offset === 0xffffffff) throw new UnzipError('zip64 archives are not supported');
    if (flags & 1) throw new UnzipError('encrypted zip entries are not supported');
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const mode = (madeBy >> 8) === 3 ? (ext >>> 16) & 0xffff : 0;
    out.push({ name, method, csize, usize, crc, offset, mode, isDir: name.endsWith('/') });
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

/** Check the whole archive's entries (no writing). Throws UnzipError naming the first problem. */
export function checkEntries(entries: Entry[], limits: UnzipLimits = DEFAULT_LIMITS): void {
  if (entries.length > limits.maxFiles) throw new UnzipError(`too many files (${entries.length})`);
  let total = 0;
  const seen = new Set<string>();
  for (const e of entries) {
    const bad = badEntryName(e.name);
    if (bad) throw new UnzipError(`unsafe path in the archive (${bad}): ${e.name.slice(0, 80)}`);
    if ((e.mode & 0o170000) === 0o120000) throw new UnzipError(`the archive has a symbolic link (${e.name.slice(0, 80)})`);
    if (e.method !== 0 && e.method !== 8) throw new UnzipError(`unsupported compression in ${e.name.slice(0, 80)}`);
    if (e.usize > limits.maxFileBytes) throw new UnzipError(`a file is too big (${e.name.slice(0, 80)})`);
    total += e.usize;
    if (total > limits.maxTotalBytes) throw new UnzipError('the archive unpacks to more than the limit');
    const key = e.name.toLowerCase().split('/').map((s) => s.replace(/[. ]+$/, '')).join('/');
    if (seen.has(key)) throw new UnzipError(`the same path twice (${e.name.slice(0, 80)})`);
    seen.add(key);
  }
}

/** Unpack `zipPath` into `dest` (created). Returns the list of files written (relative, "/" separated). */
export function unzipSafe(zipPath: string, dest: string, limits: UnzipLimits = DEFAULT_LIMITS): string[] {
  const buf = fs.readFileSync(zipPath);
  const entries = listZip(buf);
  checkEntries(entries, limits);
  const root = path.resolve(dest);
  fs.mkdirSync(root, { recursive: true });
  const written: string[] = [];
  for (const e of entries) {
    const target = path.resolve(root, e.name);
    if (target !== root && !target.startsWith(root + path.sep)) throw new UnzipError(`unsafe path in the archive: ${e.name.slice(0, 80)}`);
    if (e.isDir) { fs.mkdirSync(target, { recursive: true }); continue; }
    if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== LOC) throw new UnzipError(`damaged zip (${e.name.slice(0, 80)})`);
    const nlen = buf.readUInt16LE(e.offset + 26), xlen = buf.readUInt16LE(e.offset + 28);
    const start = e.offset + 30 + nlen + xlen;
    if (start + e.csize > buf.length) throw new UnzipError(`damaged zip (${e.name.slice(0, 80)} runs past the end)`);
    const raw = buf.subarray(start, start + e.csize);
    let data: Buffer;
    try { data = e.method === 0 ? Buffer.from(raw) : zlib.inflateRawSync(raw, { maxOutputLength: Math.max(1, e.usize + 1) }); }
    catch { throw new UnzipError(`damaged zip (${e.name.slice(0, 80)} would not unpack)`); }
    if (data.length !== e.usize) throw new UnzipError(`the size of ${e.name.slice(0, 80)} does not match the archive's directory`);
    if ((zlib.crc32(data) >>> 0) !== e.crc) throw new UnzipError(`damaged zip (checksum of ${e.name.slice(0, 80)} is wrong)`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, data);
    written.push(e.name);
  }
  return written;
}
