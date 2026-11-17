// Where 2D avatars read their files (FlatFiles, src/avatar/flat/types.ts):
//  * libraryFiles: this PC's own avatar folder over HTTP (/library/<id>/<file>);
//  * bundleFiles: a party guest's avatar, unpacked from the sealed bytes in RAM — never written anywhere, blob: URLs
//    revoked on dispose (model custody, docs/MULTIPLAYER_DISCORD.md).
// The party bundle (packFlatBundle / unpackFlatBundle) is a valid glTF 2.0 binary with no meshes: the files ride in
// its BIN chunk, listed in extras.vtpFlat. That keeps the party wire's GLB checks (shared/partyWire.ts glbProblem)
// and the 0-triangle count meaningful, and an older app that can't show 2D avatars just loads an empty scene.
import type { AvatarProfile } from '../../../shared/types.ts';
import type { FlatFiles } from './types.ts';

const enc = new TextEncoder(), dec = new TextDecoder();
const libUrl = (id: string, rel: string) => `/library/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

export function libraryFiles(p: AvatarProfile): FlatFiles & { dispose(): void } {
  return {
    sealed: false,
    list: () => null,
    url: async (rel) => libUrl(p.id, rel),
    bytes: async (rel) => {
      const r = await fetch(libUrl(p.id, rel));
      if (!r.ok) throw new Error(`${rel}: ${r.status}`);
      return r.arrayBuffer();
    },
    dispose() { /* nothing held */ },
  };
}

export function bundleFiles(files: Map<string, Uint8Array>): FlatFiles & { dispose(): void } {
  const urls: string[] = [];
  return {
    sealed: true,
    list: () => [...files.keys()],
    bytes: async (rel) => { const b = files.get(rel); if (!b) throw new Error(`${rel}: not in the avatar`); return b.slice().buffer; },
    url: async (rel) => { const b = files.get(rel); if (!b) throw new Error(`${rel}: not in the avatar`); const u = URL.createObjectURL(new Blob([b.slice()])); urls.push(u); return u; },
    dispose() { for (const u of urls) URL.revokeObjectURL(u); urls.length = 0; for (const b of files.values()) b.fill(0); files.clear(); },
  };
}

const MAGIC = 0x46546c67, JSON_T = 0x4e4f534a, BIN_T = 0x004e4942;
const pad4 = (n: number) => (n + 3) & ~3;

/** Pack files (path → bytes) into a 2D-avatar party bundle (a mesh-less GLB). */
export function packFlatBundle(files: [string, Uint8Array][]): Uint8Array {
  let off = 0;
  const views: { buffer: 0; byteOffset: number; byteLength: number }[] = [];
  const list: { path: string; view: number }[] = [];
  for (const [path, b] of files) { views.push({ buffer: 0, byteOffset: off, byteLength: b.byteLength }); list.push({ path, view: views.length - 1 }); off = pad4(off + b.byteLength); }
  const binLen = Math.max(4, off);
  const gltf = { asset: { version: '2.0', generator: 'VTube Pro 2D avatar bundle' }, scene: 0, scenes: [{ nodes: [0] }], nodes: [{ name: 'vtp_flat_avatar' }],
    buffers: [{ byteLength: binLen }], bufferViews: views, extras: { vtpFlat: { v: 1, files: list } } };
  let json = enc.encode(JSON.stringify(gltf));
  const jl = pad4(json.byteLength);
  if (jl !== json.byteLength) { const j2 = new Uint8Array(jl).fill(0x20); j2.set(json); json = j2; }
  const total = 12 + 8 + jl + 8 + binLen;
  const out = new Uint8Array(total);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, MAGIC, true); dv.setUint32(4, 2, true); dv.setUint32(8, total, true);
  dv.setUint32(12, jl, true); dv.setUint32(16, JSON_T, true); out.set(json, 20);
  const bo = 20 + jl;
  dv.setUint32(bo, binLen, true); dv.setUint32(bo + 4, BIN_T, true);
  for (let i = 0; i < files.length; i++) out.set(files[i][1], bo + 8 + views[i].byteOffset);
  return out;
}

/** Is this GLB a 2D-avatar bundle? (cheap: reads the JSON chunk only) */
export function isFlatBundle(b: Uint8Array): boolean { return unpackHeader(b) !== null; }

function unpackHeader(b: Uint8Array): { json: { bufferViews?: { byteOffset?: number; byteLength: number }[]; extras?: { vtpFlat?: { v?: number; files?: { path?: unknown; view?: unknown }[] } } }; bin: number; binLen: number } | null {
  if (b.byteLength < 28) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== MAGIC || dv.getUint32(16, true) !== JSON_T) return null;
  const jl = dv.getUint32(12, true);
  if (20 + jl + 8 > b.byteLength) return null;
  let json;
  try { json = JSON.parse(dec.decode(b.subarray(20, 20 + jl))); } catch { return null; }
  if (!json?.extras?.vtpFlat || !Array.isArray(json.extras.vtpFlat.files)) return null;
  const bo = 20 + jl;
  if (dv.getUint32(bo + 4, true) !== BIN_T) return null;
  const binLen = dv.getUint32(bo, true);
  if (bo + 8 + binLen > b.byteLength) return null;
  return { json, bin: bo + 8, binLen };
}

/** Unpack a bundle into path → bytes (copies; the caller wipes the source buffer). Unsafe paths are dropped. */
export function unpackFlatBundle(b: Uint8Array): Map<string, Uint8Array> {
  const h = unpackHeader(b);
  if (!h) throw new Error('not a 2D avatar bundle');
  const out = new Map<string, Uint8Array>();
  for (const f of h.json.extras!.vtpFlat!.files!.slice(0, 2000)) {
    const v = typeof f.view === 'number' ? h.json.bufferViews?.[f.view] : undefined;
    if (typeof f.path !== 'string' || !v || f.path.length > 300 || /(^|\/)\.\.?(\/|$)|^\/|\\|^[A-Za-z]:/.test(f.path)) continue;
    const o = v.byteOffset ?? 0;
    if (o < 0 || v.byteLength < 0 || o + v.byteLength > h.binLen) continue;
    out.set(f.path, b.slice(h.bin + o, h.bin + o + v.byteLength));
  }
  return out;
}
