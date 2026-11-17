// Pure TypeScript BC7 (BPTC UNORM), written from the Khronos Data Format specification §BPTC
// and Microsoft's BC7 mode reference. No GPU, native codec or npm dependency.
import { PARTITION2, PARTITION3, ANCHOR2_1, ANCHOR3_1, ANCHOR3_2 } from './bc7Tables.ts';

// subsets, partition bits, rotation bits, selector bits, RGB bits, alpha bits,
// endpoint P bits, shared P bits, primary index bits, secondary index bits.
const MODES = [
  [3, 4, 0, 0, 4, 0, 1, 0, 3, 0], [2, 6, 0, 0, 6, 0, 0, 1, 3, 0],
  [3, 6, 0, 0, 5, 0, 0, 0, 2, 0], [2, 6, 0, 0, 7, 0, 1, 0, 2, 0],
  [1, 0, 2, 1, 5, 6, 0, 0, 2, 3], [1, 0, 2, 0, 7, 8, 0, 0, 2, 2],
  [1, 0, 0, 0, 7, 7, 1, 0, 4, 0], [2, 6, 0, 0, 5, 5, 1, 0, 2, 0],
] as const;
const WEIGHTS: Record<number, readonly number[]> = {
  2: [0, 21, 43, 64], 3: [0, 9, 18, 27, 37, 46, 55, 64],
  4: [0, 4, 9, 13, 17, 21, 26, 30, 34, 38, 43, 47, 51, 55, 60, 64],
};

/** Decode one 16-byte block to 16 straight RGBA8 pixels, in row-major order. */
export function decodeBc7Block(bytes: Uint8Array, offset = 0, out = new Uint8Array(64)): Uint8Array {
  if (!Number.isInteger(offset) || offset < 0 || offset + 16 > bytes.length || out.length < 64) throw new Error('A BC7 texture block is cut short.');
  let bit = 0;
  const read = (n: number) => {
    let v = 0;
    for (let i = 0; i < n; i++, bit++) v |= ((bytes[offset + (bit >>> 3)] >>> (bit & 7)) & 1) << i;
    return v;
  };
  let mode = 0;
  while (mode < 8 && !read(1)) mode++;
  // Reserved all-zero mode prefix: the specified transparent black fallback.
  if (mode === 8) { out.fill(0, 0, 64); return out; }
  const [ns, pb, rb, sb, cb, ab, ep, sp, ib, ib2] = MODES[mode];
  const partition = read(pb), rotation = read(rb), selector = read(sb), ne = ns * 2;
  const endpoints = new Uint16Array(ne * 4);
  for (let c = 0; c < 4; c++) for (let e = 0; e < ne; e++) endpoints[e * 4 + c] = read(c === 3 ? ab : cb);
  const pbits = new Uint8Array(ne);
  if (ep) for (let e = 0; e < ne; e++) pbits[e] = read(1);
  if (sp) for (let s = 0; s < ns; s++) pbits[s * 2] = pbits[s * 2 + 1] = read(1);
  for (let e = 0; e < ne; e++) for (let c = 0; c < 4; c++) {
    const at = e * 4 + c;
    if (c === 3 && !ab) { endpoints[at] = 255; continue; }
    const n = (c === 3 ? ab : cb) + ep + sp;
    let v = endpoints[at];
    if (ep || sp) v = (v << 1) | pbits[e];
    v <<= 8 - n;
    endpoints[at] = v | (v >>> n);
  }
  const pattern = ns === 2 ? PARTITION2[partition] : ns === 3 ? PARTITION3[partition] : 0;
  const a1 = ns === 2 ? ANCHOR2_1[partition] : ns === 3 ? ANCHOR3_1[partition] : -1;
  const a2 = ns === 3 ? ANCHOR3_2[partition] : -1;
  const primary = new Uint8Array(16), secondary = new Uint8Array(16);
  for (let i = 0; i < 16; i++) primary[i] = read(ib - (i === 0 || i === a1 || i === a2 ? 1 : 0));
  if (ib2) for (let i = 0; i < 16; i++) secondary[i] = read(ib2 - (i === 0 ? 1 : 0));
  for (let i = 0; i < 16; i++) {
    const e = ((pattern >>> (i * 2)) & 3) * 8;
    for (let c = 0; c < 4; c++) {
      const useSecond = ib2 && (c === 3 ? !selector : selector);
      const w = WEIGHTS[useSecond ? ib2 : ib][useSecond ? secondary[i] : primary[i]];
      out[i * 4 + c] = ((64 - w) * endpoints[e + c] + w * endpoints[e + 4 + c] + 32) >>> 6;
    }
    if (rotation) { const a = i * 4 + rotation - 1, b = i * 4 + 3; [out[a], out[b]] = [out[b], out[a]]; }
  }
  return out;
}

const MAX_SIDE = 8192;
function blockBytes(width: number, height: number) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > MAX_SIDE || height > MAX_SIDE) {
    throw new Error('The BC7 texture size is invalid or exceeds 8192 pixels. Export a smaller PNG texture.');
  }
  return Math.ceil(width / 4) * Math.ceil(height / 4) * 16;
}

/** Raw BC7 blocks; dimensions must come from a documented container, never guessed from the byte count. */
export function decodeBc7(bytes: Uint8Array, width: number, height: number): Uint8Array {
  if (bytes.length !== blockBytes(width, height)) throw new Error('The BC7 texture data does not match its size. Export it again with PNG textures.');
  const out = new Uint8Array(width * height * 4), block = new Uint8Array(64);
  let at = 0;
  for (let y = 0; y < height; y += 4) for (let x = 0; x < width; x += 4, at += 16) {
    decodeBc7Block(bytes, at, block);
    for (let row = 0; row < Math.min(4, height - y); row++) out.set(block.subarray(row * 16, row * 16 + Math.min(4, width - x) * 4), ((y + row) * width + x) * 4);
  }
  return out;
}

/** INP tag 2 specifies BC7 but upstream specifies no size header. Accept a standard DDS DX10 2D
 *  payload (BC7_UNORM / BC7_UNORM_SRGB), not an invented INP-specific header. See provenance §5. */
export function decodeBc7Texture(bytes: Uint8Array): { width: number; height: number; rgba: Uint8Array } {
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const u32 = (o: number) => dv.getUint32(o, true);
  if (bytes.length < 148 || u32(0) !== 0x20534444 || u32(4) !== 124 || u32(76) !== 32 || u32(84) !== 0x30315844) {
    throw new Error('This BC7 texture has no supported image-size header. Export the puppet from Inochi Creator with PNG textures.');
  }
  const format = u32(128), width = u32(16), height = u32(12);
  if ((format !== 98 && format !== 99) || u32(132) !== 3 || (u32(136) & 4) || u32(140) !== 1 || (u32(112) & 0x200200) || u32(24) > 1) {
    throw new Error('This compressed texture is not a single BC7 2D image. Export it again with PNG textures.');
  }
  const n = blockBytes(width, height);
  if (bytes.length < 148 + n) throw new Error('A BC7 texture is cut short. Export it again with PNG textures.');
  const rgba = decodeBc7(bytes.subarray(148, 148 + n), width, height);
  // DDS alpha mode 2 is premultiplied; .vtp2 stores straight alpha.
  if ((u32(144) & 7) === 2) for (let i = 0; i < rgba.length; i += 4) for (let c = 0; c < 3; c++) rgba[i + c] = rgba[i + 3] ? Math.min(255, Math.round(rgba[i + c] * 255 / rgba[i + 3])) : 0;
  return { width, height, rgba };
}
