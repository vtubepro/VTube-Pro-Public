// Minimal KTX2 reader / writer (Khronos KTX 2.0 spec, registry.khronos.org/KTX/specs/2.0/ktxspec.v2.html) for the
// texture tiers: the Basis encoder (shared/rig2d/gpu/basis.ts) writes one KTX2 per picture; we put our own mip levels
// (and, for pages over the encoder's pixel guard, horizontal strips of a level) together into ONE file per page. UASTC
// blocks are independent and zstd frames may follow one another, so a level made of strips is simply the strips'
// compressed bytes back to back (decoded as one: ZSTD_decompress reads every frame).
export const KTX2_ID = new Uint8Array([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);
/** KHR_DF_FLAG_ALPHA_PREMULTIPLIED (data format descriptor flags). */
export const DF_PREMULTIPLIED = 1;

export interface Ktx2Level { data: Uint8Array; uncompressed: number }
export interface Ktx2 {
  vkFormat: number; typeSize: number; width: number; height: number; supercompression: number;
  dfd: Uint8Array; kvd: Uint8Array; sgd: Uint8Array;
  levels: Ktx2Level[];
}

const u64 = (dv: DataView, o: number) => dv.getUint32(o, true) + dv.getUint32(o + 4, true) * 2 ** 32;

export function isKtx2(b: Uint8Array) { return b.length >= 80 && KTX2_ID.every((x, i) => b[i] === x); }

export function readKtx2(b: Uint8Array): Ktx2 {
  if (!isKtx2(b)) throw new Error('not a KTX2 file');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const levelCount = Math.max(1, dv.getUint32(40, true));
  const dfdO = dv.getUint32(48, true), dfdL = dv.getUint32(52, true), kvdO = dv.getUint32(56, true), kvdL = dv.getUint32(60, true);
  const sgdO = u64(dv, 64), sgdL = u64(dv, 72);
  const levels: Ktx2Level[] = [];
  for (let i = 0; i < levelCount; i++) {
    const o = 80 + i * 24, off = u64(dv, o), len = u64(dv, o + 8), un = u64(dv, o + 16);
    if (off + len > b.length) throw new Error('the KTX2 file is cut off');
    levels.push({ data: b.subarray(off, off + len), uncompressed: un });
  }
  return {
    vkFormat: dv.getUint32(12, true), typeSize: dv.getUint32(16, true), width: dv.getUint32(20, true), height: dv.getUint32(24, true),
    supercompression: dv.getUint32(44, true), dfd: b.subarray(dfdO, dfdO + dfdL), kvd: b.subarray(kvdO, kvdO + kvdL), sgd: b.subarray(sgdO, sgdO + sgdL), levels,
  };
}

/** The DFD's flags byte (basic descriptor block): bit 0 = premultiplied alpha. */
export function dfdFlags(dfd: Uint8Array) { return dfd.length > 15 ? dfd[15] : 0; }

/** Write a KTX2 file. `levels[0]` = full size. Level data is laid out smallest first (as the spec recommends), each
 *  level 8-byte aligned (harmless for supercompressed data, required for some uncompressed formats). */
export function writeKtx2(k: Ktx2, opts: { premultiplied?: boolean } = {}): Uint8Array {
  const dfd = k.dfd.slice();
  if (opts.premultiplied !== undefined && dfd.length > 15) dfd[15] = opts.premultiplied ? dfd[15] | DF_PREMULTIPLIED : dfd[15] & ~DF_PREMULTIPLIED;
  const n = k.levels.length;
  const align = (x: number, a: number) => Math.ceil(x / a) * a;
  let o = 80 + n * 24;
  const dfdO = o; o += dfd.length;
  const kvdO = k.kvd.length ? o : 0; o += k.kvd.length;
  const sgdO = k.sgd.length ? align(o, 8) : 0; if (k.sgd.length) o = sgdO + k.sgd.length;
  const offs = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) { o = align(o, 8); offs[i] = o; o += k.levels[i].data.length; }
  const b = new Uint8Array(o), dv = new DataView(b.buffer);
  b.set(KTX2_ID, 0);
  dv.setUint32(12, k.vkFormat, true); dv.setUint32(16, k.typeSize, true); dv.setUint32(20, k.width, true); dv.setUint32(24, k.height, true);
  dv.setUint32(28, 0, true); dv.setUint32(32, 0, true); dv.setUint32(36, 1, true); dv.setUint32(40, n, true); dv.setUint32(44, k.supercompression, true);
  dv.setUint32(48, dfdO, true); dv.setUint32(52, dfd.length, true); dv.setUint32(56, kvdO, true); dv.setUint32(60, k.kvd.length, true);
  const set64 = (at: number, v: number) => { dv.setUint32(at, v >>> 0, true); dv.setUint32(at + 4, Math.floor(v / 2 ** 32), true); };
  set64(64, sgdO); set64(72, k.sgd.length);
  for (let i = 0; i < n; i++) { set64(80 + i * 24, offs[i]); set64(80 + i * 24 + 8, k.levels[i].data.length); set64(80 + i * 24 + 16, k.levels[i].uncompressed); }
  b.set(dfd, dfdO); if (k.kvd.length) b.set(k.kvd, kvdO); if (k.sgd.length) b.set(k.sgd, sgdO);
  for (let i = 0; i < n; i++) b.set(k.levels[i].data, offs[i]);
  return b;
}

/** Join pieces of the same level (top strip first) into one level. */
export function joinLevel(parts: Ktx2Level[]): Ktx2Level {
  const data = new Uint8Array(parts.reduce((s, p) => s + p.data.length, 0));
  let o = 0;
  for (const p of parts) { data.set(p.data, o); o += p.data.length; }
  return { data, uncompressed: parts.reduce((s, p) => s + p.uncompressed, 0) };
}
