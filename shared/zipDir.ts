// Reading a zip's directory without unpacking it: the end record (ZIP64 too), the central directory, entry names in
// whatever code page the zip tool used (UTF-8 flag, Info-ZIP unicode path, else UTF-8 / Shift-JIS / GBK / Big5 /
// EUC-KR, NFC), and the local header's data offset. Pure (no Node, no DOM): the helper's upload reader
// (shared/flatUnzip.ts) reads a whole upload with it, the studio's repack (src/ui/flatPrune.ts) reads slices of a File.
// Untrusted input: every offset is bounds-checked; a broken directory is a ZipDirError.

export class ZipDirError extends Error { constructor(readonly kind: 'damaged' | 'too-many') { super(kind); } }

export interface ZipDirEntry {
  name: string; method: number; flags: number; crc: number; size: number; csize: number; local: number;
  /** raw name bytes when they were decoded with a guessed legacy code page */
  legacy?: Uint8Array;
}

const utf8 = new TextDecoder('utf-8', { fatal: true });
const isUtf8 = (b: Uint8Array) => { try { utf8.decode(b); return true; } catch { return false; } };
export const cleanZipName = (n: string) => n.replace(/\\/g, '/').replace(/^(\.\/)+/, '');
export const LEGACY_DECODERS = ['shift_jis', 'gbk', 'big5', 'euc-kr'].map((e) => { try { return new TextDecoder(e, { fatal: true }); } catch { return null; } }).filter((d): d is TextDecoder => !!d);

/** A zip entry name without the UTF-8 flag: UTF-8 when it decodes, else the first legacy East-Asian code page that does
 *  (Shift-JIS first: Live2D's home turf), else Latin-1. Always NFC (macOS writes NFD). */
export function decodeZipName(raw: Uint8Array, utf8Flag: boolean): string {
  let s: string | null = null;
  if (utf8Flag || raw.every((c) => c < 0x80)) { try { s = utf8.decode(raw); } catch { s = null; } }
  if (s === null) { try { s = utf8.decode(raw); } catch { /* not UTF-8 */ } }
  if (s === null) for (const d of LEGACY_DECODERS) { try { s = d.decode(raw); break; } catch { /* next */ } }
  if (s === null) { let t = ''; for (const c of raw) t += String.fromCharCode(c); s = t; }
  return s.normalize('NFC');
}

/** The end record, searched in the archive's last bytes (`tail` starts at file offset `tailStart`). `zip64At` = the
 *  file offset of a ZIP64 end record to read (56 bytes) and pass to zip64End. */
export function zipEnd(tail: Uint8Array, tailStart: number): { count: number; cdOff: number; cdSize: number; zip64At: number | null } {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  let eocd = -1;
  for (let i = tail.length - 22; i >= Math.max(0, tail.length - 22 - 65535); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
  if (eocd < 0) throw new ZipDirError('damaged');
  const count = dv.getUint16(eocd + 10, true), cdSize = dv.getUint32(eocd + 12, true), cdOff = dv.getUint32(eocd + 16, true);
  let zip64At: number | null = null;
  if ((count === 0xffff || cdOff === 0xffffffff || cdSize === 0xffffffff) && eocd >= 20 && dv.getUint32(eocd - 20, true) === 0x07064b50) zip64At = Number(dv.getBigUint64(eocd - 12, true));
  void tailStart;
  return { count, cdOff, cdSize, zip64At };
}
/** A ZIP64 end record (56 bytes) → its counts / offsets. */
export function zip64End(rec: Uint8Array): { count: number; cdOff: number; cdSize: number } {
  const dv = new DataView(rec.buffer, rec.byteOffset, rec.byteLength);
  if (rec.length < 56 || dv.getUint32(0, true) !== 0x06064b50) throw new ZipDirError('damaged');
  return { count: Number(dv.getBigUint64(32, true)), cdSize: Number(dv.getBigUint64(40, true)), cdOff: Number(dv.getBigUint64(48, true)) };
}

/** The central directory's entries (`cd` = exactly the directory's bytes). */
export function parseCentralDir(cd: Uint8Array, count: number, maxEntries = 65535): ZipDirEntry[] {
  if (count > maxEntries) throw new ZipDirError('too-many');
  const dv = new DataView(cd.buffer, cd.byteOffset, cd.byteLength);
  const out: ZipDirEntry[] = [];
  let p = 0;
  for (let i = 0; i < count; i++) {
    if (p + 46 > cd.length || dv.getUint32(p, true) !== 0x02014b50) throw new ZipDirError('damaged');
    const flags = dv.getUint16(p + 8, true), method = dv.getUint16(p + 10, true), crc = dv.getUint32(p + 16, true);
    let csize = dv.getUint32(p + 20, true), size = dv.getUint32(p + 24, true), local = dv.getUint32(p + 42, true);
    const nl = dv.getUint16(p + 28, true), xl = dv.getUint16(p + 30, true), cl = dv.getUint16(p + 32, true);
    if (p + 46 + nl + xl > cd.length) throw new ZipDirError('damaged');
    const rawName = cd.subarray(p + 46, p + 46 + nl);
    let name = decodeZipName(rawName, !!(flags & 0x800));
    let legacy: Uint8Array | undefined = !(flags & 0x800) && !rawName.every((c) => c < 0x80) && !isUtf8(rawName) ? rawName.slice() : undefined;
    // extra fields: ZIP64 sizes (0x0001) and the Info-ZIP Unicode path (0x7075, what 7-Zip / WinRAR write)
    for (let x = p + 46 + nl, end = x + xl; x + 4 <= end;) {
      const id = dv.getUint16(x, true), len = dv.getUint16(x + 2, true), d = x + 4;
      if (d + len > end) break;
      if (id === 0x0001) {
        let q = d;
        if (size === 0xffffffff && q + 8 <= d + len) { size = Number(dv.getBigUint64(q, true)); q += 8; }
        if (csize === 0xffffffff && q + 8 <= d + len) { csize = Number(dv.getBigUint64(q, true)); q += 8; }
        if (local === 0xffffffff && q + 8 <= d + len) { local = Number(dv.getBigUint64(q, true)); }
      } else if (id === 0x7075 && len > 5 && cd[d] === 1) {
        try { name = utf8.decode(cd.subarray(d + 5, d + len)).normalize('NFC'); legacy = undefined; } catch { /* keep the decoded name */ }
      }
      x = d + len;
    }
    p += 46 + nl + xl + cl;
    out.push({ name: cleanZipName(name), method, flags, crc, size, csize, local, ...(legacy ? { legacy } : {}) });
  }
  return out;
}

/** A local header's first 30 bytes → the length of the whole local header (where the entry's data starts). */
export function localHeaderLength(h: Uint8Array): number {
  const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
  if (h.length < 30 || dv.getUint32(0, true) !== 0x04034b50) throw new ZipDirError('damaged');
  return 30 + dv.getUint16(26, true) + dv.getUint16(28, true);
}

/** Entries whose names were decoded in a guessed code page: re-decode them with the code page under which the model's
 *  own JSON (model3.json / vtube.json texts) finds the most of their names. Renames keys of `files` in place. */
export function chooseLegacyNames(entries: ZipDirEntry[], files: Map<string, Uint8Array>) {
  const legacy = entries.filter((e) => e.legacy);
  if (!legacy.length) return;
  const text = [...files].filter(([k, v]) => /\.(model3|vtube)\.json$/i.test(k) && v.length < 8 << 20).map(([, v]) => new TextDecoder().decode(v)).join('\n');
  if (!text) return;
  const score = (dec: TextDecoder) => { let n = 0; for (const e of legacy) { let s: string; try { s = dec.decode(e.legacy!).normalize('NFC'); } catch { return -1; } for (const seg of s.replace(/\\/g, '/').split('/')) if (/[^\x00-\x7f]/.test(seg) && text.includes(seg)) n++; } return n; };
  let best: TextDecoder | null = null, bestN = score(LEGACY_DECODERS[0]);
  for (const d of LEGACY_DECODERS.slice(1)) { const n = score(d); if (n > bestN) { best = d; bestN = n; } }
  if (best) for (const e of legacy) { const v = files.get(e.name); if (!v) continue; files.delete(e.name); e.name = cleanZipName(best.decode(e.legacy!).normalize('NFC')); files.set(e.name, v); }
}

/** Never part of a 2D avatar: skipped without inflating (art sources, editor projects, video / audio, programs). */
export const FLAT_SKIP_EXT = new Set(['psd', 'psb', 'cmo3', 'cmo', 'can3', 'cmox', 'aseprite', 'ase', 'clip', 'sai', 'sai2', 'kra', 'xcf', 'ai', 'eps', 'pdn',
  'tif', 'tiff', 'tga', 'bmp', 'exr', 'hdr', 'mp4', 'mov', 'avi', 'mkv', 'webm', 'wmv', 'flv', 'm4v', 'wav', 'mp3', 'ogg', 'flac', 'm4a', 'aac', 'opus', 'aep', 'prproj', 'blend', 'blend1',
  'fbx', 'obj', 'vrm', 'glb', 'exe', 'dll', 'msi', 'bat', 'cmd', 'ps1', 'sh', 'app', 'dmg', 'pdf', 'doc', 'docx', 'rtf', 'xlsx', 'pptx', 'url', 'lnk', 'torrent', 'iso', 'ttf', 'otf']);
export const isZipJunk = (p: string) => /(^|\/)(__MACOSX|\.DS_Store|Thumbs\.db|desktop\.ini|\.Spotlight-V100|\.Trashes|\.fseventsd)(\/|$)/i.test(p) || /(^|\/)\.(?!\.?(\/|$))/.test(p);
export const zipExt = (p: string) => { const n = p.split('/').pop() ?? ''; const m = /\.([^.]+)$/.exec(n.toLowerCase()); return m ? m[1] : ''; };
/** Kept for a 2D avatar upload? (not a folder, not OS junk, not an art source / video / program) */
export const keepForFlat = (name: string) => !name.endsWith('/') && !isZipJunk(name) && !FLAT_SKIP_EXT.has(zipExt(name));

const CRC_TABLE = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
/** CRC-32 (zip / PNG). */
export function crc32(b: Uint8Array): number { let c = -1; for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; }
