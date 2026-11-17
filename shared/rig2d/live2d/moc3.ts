// Clean-room .moc3 reader (TypeScript port of the project's own blender/live2d/moc3.py), used ONLY to convert a user's
// Live2D model into VTube Pro's own .vtp2 rig on import (shared/rig2d/live2d/convert.ts). VTube Pro never renders
// .moc3 files and never uses any Live2D Cubism Core / SDK / Framework code.
//
// Provenance of the layout (docs/RIG2D_IMPORT_PROVENANCE.md): the OpenL2D "moc3ingbird" ImHex pattern (FDPL-1.0-US),
// MahouTechnologies/moc3-rs (MIT / Apache-2.0) for the deformer maths, and analysis of model files themselves.
//
// UNTRUSTED INPUT: .moc3 files from the internet have been used to attack other apps (CVE-2023-27566). Every offset,
// count and index here is bounds-checked, sizes are capped, and a broken file ends in Moc3Error — never a crash, a
// hang or an out-of-range read (tools/rig2d_moc3_unit.ts fuzzes it).

export class Moc3Error extends Error {}

export const MOC3_LIMITS = { bytes: 128 << 20, count: 4_000_000, objects: 65536 };

type T = 'f4' | 'i4' | 'u4' | 'u1' | 'i2' | 'id' | 'rt';
const SIZE: Record<T, number> = { f4: 4, i4: 4, u4: 4, u1: 1, i2: 2, id: 64, rt: 0 };

export const COUNT_NAMES = ['parts', 'deformers', 'warps', 'rots', 'arts', 'params', 'partKF', 'warpKF', 'rotKF', 'artKF',
  'kfPos', 'pbIdx', 'kfBind', 'pBind', 'keys', 'uvs', 'posIdx', 'masks', 'dog', 'dogObj', 'glue', 'glueInfo', 'glueKF',
  // v4 (Cubism 4.2)
  'mulCol', 'scrCol', 'bsPBind', 'bsKBind', 'bsWarp', 'bsArt', 'bsConIdx', 'bsCon', 'bsConVal',
  // v5
  'bsPart', 'bsRot', 'bsGlue'] as const;
export type CountName = typeof COUNT_NAMES[number];

/** Section fields in file order (each field = one entry of the section offset table). */
export function layout(ver: number): [CountName, [string, T][]][] {
  const L: [CountName, [string, T][]][] = [
    ['parts', [['rt', 'rt'], ['ids', 'id'], ['kbSrc', 'i4'], ['kfBegin', 'i4'], ['kfCount', 'i4'], ['visible', 'u4'], ['enabled', 'u4'], ['parentPart', 'i4']]],
    ['deformers', [['rt', 'rt'], ['ids', 'id'], ['kbSrc', 'i4'], ['visible', 'u4'], ['enabled', 'u4'], ['parentPart', 'i4'], ['parentDeformer', 'i4'], ['types', 'u4'], ['specific', 'i4']]],
    ['warps', [['kbSrc', 'i4'], ['kfBegin', 'i4'], ['kfCount', 'i4'], ['vertexCounts', 'i4'], ['rows', 'u4'], ['cols', 'u4']]],
    ['rots', [['kbSrc', 'i4'], ['kfBegin', 'i4'], ['kfCount', 'i4'], ['baseAngles', 'f4']]],
    ['arts', [['rt', 'rt'], ['rt1', 'rt'], ['rt2', 'rt'], ['rt3', 'rt'], ['ids', 'id'], ['kbSrc', 'i4'], ['kfBegin', 'i4'], ['kfCount', 'i4'], ['visible', 'u4'],
      ['enabled', 'u4'], ['parentPart', 'i4'], ['parentDeformer', 'i4'], ['textureNo', 'u4'], ['flags', 'u1'], ['vertexCounts', 'i4'], ['uvBegin', 'i4'],
      ['posIdxBegin', 'i4'], ['posIdxCount', 'i4'], ['maskBegin', 'i4'], ['maskCount', 'i4']]],
    ['params', [['rt', 'rt'], ['ids', 'id'], ['max', 'f4'], ['min', 'f4'], ['default', 'f4'], ['repeat', 'u4'], ['decimals', 'u4'], ['pbBegin', 'i4'], ['pbCount', 'i4']]],
    ['partKF', [['drawOrders', 'f4']]],
    ['warpKF', [['opacities', 'f4'], ['posBegin', 'i4']]],
    ['rotKF', [['opacities', 'f4'], ['angles', 'f4'], ['ox', 'f4'], ['oy', 'f4'], ['scales', 'f4'], ['reflectX', 'u4'], ['reflectY', 'u4']]],
    ['artKF', [['opacities', 'f4'], ['drawOrders', 'f4'], ['posBegin', 'i4']]],
    ['kfPos', [['xys', 'f4']]],
    ['pbIdx', [['src', 'i4']]],
    ['kfBind', [['pbiBegin', 'i4'], ['pbiCount', 'i4']]],
    ['pBind', [['keysBegin', 'i4'], ['keysCount', 'i4']]],
    ['keys', [['values', 'f4']]],
    ['uvs', [['xys', 'f4']]],
    ['posIdx', [['indices', 'i2']]],
    ['masks', [['art', 'i4']]],
    ['dog', [['objBegin', 'i4'], ['objCount', 'i4'], ['objTotal', 'i4'], ['maxOrder', 'u4'], ['minOrder', 'u4']]],
    ['dogObj', [['types', 'u4'], ['indices', 'i4'], ['self', 'i4']]],
    ['glue', [['rt', 'rt'], ['ids', 'id'], ['kbSrc', 'i4'], ['kfBegin', 'i4'], ['kfCount', 'i4'], ['artA', 'i4'], ['artB', 'i4'], ['infoBegin', 'i4'], ['infoCount', 'i4']]],
    ['glueInfo', [['weights', 'f4'], ['posIdx', 'i2']]],
    ['glueKF', [['intensities', 'f4']]],
  ];
  if (ver >= 2) L.push(['warps', [['isQuad', 'u4']]]);
  if (ver >= 4) L.push(
    ['params', [['rtx', 'rt'], ['extKeysBegin', 'i4'], ['extKeysCount', 'i4']]],
    ['warps', [['colBegin', 'i4']]], ['rots', [['colBegin', 'i4']]], ['arts', [['colBegin', 'i4']]],
    ['mulCol', [['r', 'f4'], ['g', 'f4'], ['b', 'f4']]], ['scrCol', [['r', 'f4'], ['g', 'f4'], ['b', 'f4']]],
    ['params', [['ptype', 'u4'], ['bsPbBegin', 'i4'], ['bsPbCount', 'i4']]],
    ['bsPBind', [['keysBegin', 'i4'], ['keysCount', 'i4'], ['baseKey', 'i4']]],
    ['bsKBind', [['pbSrc', 'i4'], ['kfBegin', 'i4'], ['kfCount', 'i4'], ['conBegin', 'i4'], ['conCount', 'i4']]],
    ['bsWarp', [['target', 'i4'], ['kbBegin', 'i4'], ['kbCount', 'i4']]],
    ['bsArt', [['target', 'i4'], ['kbBegin', 'i4'], ['kbCount', 'i4']]],
    ['bsConIdx', [['src', 'i4']]],
    ['bsCon', [['param', 'i4'], ['valBegin', 'i4'], ['valCount', 'i4']]],
    ['bsConVal', [['keys', 'f4'], ['weights', 'f4']]],
  );
  if (ver >= 5) L.push(
    ['warpKF', [['mulBegin', 'i4'], ['scrBegin', 'i4']]], ['rotKF', [['mulBegin', 'i4'], ['scrBegin', 'i4']]], ['artKF', [['mulBegin', 'i4'], ['scrBegin', 'i4']]],
    ['bsPart', [['target', 'i4'], ['kbBegin', 'i4'], ['kbCount', 'i4']]],
    ['bsRot', [['target', 'i4'], ['kbBegin', 'i4'], ['kbCount', 'i4']]],
    ['bsGlue', [['target', 'i4'], ['kbBegin', 'i4'], ['kbCount', 'i4']]],
  );
  return L;
}

type Arr = Float32Array | Int32Array | Uint32Array | Uint8Array | Int16Array;
export type Section = Record<string, Arr | string[]>;

export interface Moc3 {
  version: number;
  canvas: { ppu: number; ox: number; oy: number; w: number; h: number; flags: number };
  counts: Record<CountName, number>;
  s: Record<CountName, Section>;
}

/** Section field accessors with a typed default (empty) when a version lacks the field. */
export const num = (m: Moc3, sec: CountName, f: string): Arr => (m.s[sec][f] as Arr) ?? new Int32Array(m.counts[sec]);
export const ids = (m: Moc3, sec: CountName): string[] => (m.s[sec].ids as string[]) ?? [];

export function readMoc3(input: ArrayBuffer | Uint8Array): Moc3 {
  const b = input instanceof Uint8Array ? input : new Uint8Array(input);
  const size = b.length;
  if (size > MOC3_LIMITS.bytes) throw new Moc3Error('The .moc3 file is too big.');
  if (size < 0x40 + 0x280 || b[0] !== 0x4d || b[1] !== 0x4f || b[2] !== 0x43 || b[3] !== 0x33) throw new Moc3Error('Not a .moc3 file.');
  const version = b[4];
  if (version < 1 || version > 6) throw new Moc3Error(`Unsupported .moc3 version ${version}.`);
  if (b[5]) throw new Moc3Error('Big-endian .moc3 files are not supported.');
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  const ver = Math.min(version, 5);
  const ptr = (i: number) => dv.getUint32(0x40 + i * 4, true);
  const cntOff = ptr(0), canvasOff = ptr(1);
  const nCount = 23 + (ver >= 4 ? 9 : 0) + (ver >= 5 ? 3 : 0);
  if (cntOff + nCount * 4 > size || canvasOff + 21 > size) throw new Moc3Error('The .moc3 header points outside the file.');
  const counts = {} as Record<CountName, number>;
  COUNT_NAMES.forEach((k, i) => {
    const c = i < nCount ? dv.getUint32(cntOff + i * 4, true) : 0;
    if (c > MOC3_LIMITS.count) throw new Moc3Error(`The .moc3 declares too many ${k} (${c}).`);
    counts[k] = c;
  });
  for (const k of ['parts', 'deformers', 'warps', 'rots', 'arts', 'params', 'glue'] as const) if (counts[k] > MOC3_LIMITS.objects) throw new Moc3Error(`Too many ${k}.`);
  const f = (o: number) => dv.getFloat32(o, true);
  const canvas = { ppu: f(canvasOff), ox: f(canvasOff + 4), oy: f(canvasOff + 8), w: f(canvasOff + 12), h: f(canvasOff + 16), flags: b[canvasOff + 20] };
  if (![canvas.ppu, canvas.ox, canvas.oy, canvas.w, canvas.h].every(Number.isFinite) || canvas.ppu <= 0 || canvas.w <= 0 || canvas.h <= 0) throw new Moc3Error('The .moc3 canvas is invalid.');
  const s = {} as Record<CountName, Section>;
  for (const k of COUNT_NAMES) s[k] = {};
  let pi = 2;
  const dec = new TextDecoder('utf-8');
  for (const [sec, fields] of layout(ver)) {
    const n = counts[sec];
    for (const [name, t] of fields) {
      if (pi >= 160) throw new Moc3Error('The .moc3 section table is too short.');
      const off = ptr(pi++);
      if (t === 'rt') continue;
      const bytes = n * SIZE[t];
      if (n && (off + bytes > size || off < 0x40 + 0x280)) throw new Moc3Error(`The .moc3 section ${sec}.${name} points outside the file.`);
      if (t === 'id') {
        const out: string[] = [];
        for (let i = 0; i < n; i++) { const o = off + i * 64; let e = o; while (e < o + 64 && b[e]) e++; out.push(dec.decode(b.subarray(o, e))); }
        s[sec][name] = out;
        continue;
      }
      if (t === 'f4') { const a = new Float32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getFloat32(off + i * 4, true); s[sec][name] = a; }
      else if (t === 'i4') { const a = new Int32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getInt32(off + i * 4, true); s[sec][name] = a; }
      else if (t === 'u4') { const a = new Uint32Array(n); for (let i = 0; i < n; i++) a[i] = dv.getUint32(off + i * 4, true); s[sec][name] = a; }
      else if (t === 'u1') s[sec][name] = b.slice(off, off + n);
      else { const a = new Int16Array(n); for (let i = 0; i < n; i++) a[i] = dv.getInt16(off + i * 2, true); s[sec][name] = a; }
    }
  }
  return { version, canvas, counts, s };
}

// ---------------------------------------------------------------- checked access helpers for the converter
/** Is [begin, begin + count) inside [0, total)? */
export const span = (begin: number, count: number, total: number) => Number.isInteger(begin) && Number.isInteger(count) && count >= 0 && (count === 0 || (begin >= 0 && begin + count <= total));
export function need(c: boolean, what: string): asserts c { if (!c) throw new Moc3Error(`The .moc3 is damaged: ${what}.`); }
