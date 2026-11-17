// Model statistics straight from the glTF JSON (no geometry parsing): triangles, vertices, meshes, materials,
// textures. Used by the avatar library (server, on list / import), the party sender (before a model is shared) and
// the party receiver (before a model is sealed) — docs/MULTIPLAYER_DISCORD.md → "Polycount limit".
//
// Triangles are counted per mesh USE (a mesh instanced by three nodes renders three times). Primitive modes:
// TRIANGLES = count / 3, STRIP / FAN = count − 2, points / lines = 0. Numbers are bounded: a hostile JSON can't
// make the counter loop forever or report nonsense.

export interface ModelStats { tris: number; verts: number; meshes: number; materials: number; textures: number }

/** Party defaults (the user's decision, 2026-09-26: 200,000 triangles per avatar incl. the worn costume — raised from
 *  37,000 so most models go through untouched; the host can change it for their party: Multiplayer → "Max triangles
 *  per avatar"). Only over it does the studio share an automatic party version (server/partyLod.ts). A softer "heavy"
 *  warning starts at 170,000. */
export const TRIS_WARN = 170_000;
export const TRIS_MAX = 200_000;
/** The range a host may set. */
export const TRIS_MIN_LIMIT = 10_000, TRIS_MAX_LIMIT = 2_000_000;

export const clampTrisLimit = (v: unknown) => {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.round(Math.min(TRIS_MAX_LIMIT, Math.max(TRIS_MIN_LIMIT, n))) : TRIS_MAX;
};

/** 52310 → "52,310" (exact: people compare it with the limit). */
export function fmtTris(n: number): string {
  if (!Number.isFinite(n)) return '?';
  return Math.round(n).toLocaleString('en-US');
}

/** The party wire's reason code for an over-limit avatar ('tris:52310' = 52,310 triangles). */
export const trisWhy = (tris: number) => `tris:${Math.max(1, Math.round(tris))}`;
/** 'tris:52310' → 52310 (older builds sent thousands: 'tris:412' → 412,000). */
export const trisOfWhy = (why: string) => { const n = Number(why.slice(5)); return !Number.isFinite(n) ? 0 : n < 5000 ? n * 1000 : n; };

const dec = new TextDecoder();

/** The JSON chunk of a GLB (null = not a GLB / broken). */
export function glbJson(b: Uint8Array): Record<string, unknown> | null {
  if (b.byteLength < 20) return null;
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(16, true) !== 0x4e4f534a) return null;
  const len = dv.getUint32(12, true);
  if (len > 64 << 20 || 20 + len > b.byteLength) return null;
  try { const j = JSON.parse(dec.decode(b.subarray(20, 20 + len))); return j && typeof j === 'object' ? j as Record<string, unknown> : null; } catch { return null; }
}

/** Stats from a parsed glTF JSON. */
export function gltfStats(json: Record<string, unknown>): ModelStats {
  const arr = (k: string) => (Array.isArray(json[k]) ? (json[k] as unknown[]) : []);
  const accessors = arr('accessors'), meshes = arr('meshes'), nodes = arr('nodes');
  const count = (i: unknown) => {
    const a = typeof i === 'number' ? accessors[i] as { count?: unknown } | undefined : undefined;
    const c = a && typeof a.count === 'number' && Number.isFinite(a.count) ? a.count : 0;
    return Math.max(0, Math.min(c, 1e9));
  };
  const perMesh = meshes.slice(0, 100_000).map((m) => {
    let tris = 0, verts = 0;
    const prims = m && typeof m === 'object' && Array.isArray((m as { primitives?: unknown }).primitives) ? (m as { primitives: unknown[] }).primitives.slice(0, 10_000) : [];
    for (const p of prims) {
      if (!p || typeof p !== 'object') continue;
      const q = p as { mode?: unknown; indices?: unknown; attributes?: { POSITION?: unknown } };
      const mode = typeof q.mode === 'number' ? q.mode : 4;
      const vc = count(q.attributes?.POSITION);
      const n = q.indices !== undefined ? count(q.indices) : vc;
      verts += vc;
      if (mode === 4) tris += Math.floor(n / 3);
      else if (mode === 5 || mode === 6) tris += Math.max(0, n - 2);
    }
    return { tris, verts };
  });
  // count each mesh per node that uses it (instancing); a file whose nodes use no mesh: each mesh once
  const uses = new Array<number>(perMesh.length).fill(0);
  for (const n of nodes.slice(0, 200_000)) {
    const mi = n && typeof n === 'object' ? (n as { mesh?: unknown }).mesh : undefined;
    if (typeof mi === 'number' && mi >= 0 && mi < uses.length) uses[mi]++;
  }
  const anyUse = uses.some((u) => u > 0);
  let tris = 0, verts = 0;
  perMesh.forEach((m, i) => { const k = anyUse ? uses[i] : 1; tris += m.tris * k; verts += m.verts * k; });
  return { tris, verts, meshes: perMesh.length, materials: arr('materials').length, textures: arr('images').length };
}

/** Stats of a GLB / VRM file in memory (null = not a GLB). */
export function glbStats(b: Uint8Array): ModelStats | null {
  const j = glbJson(b);
  return j ? gltfStats(j) : null;
}

/** Automatic party version of an avatar (server/partyLod.ts; GET / POST /api/avatars/:id/party-lod). Files are paths
 *  inside the avatar's own folder (served under /library/<id>/…); the original model is never touched. */
export interface PartyLodStatus {
  /** The model (+ worn costume) is over `max`, so parties use a party version. */
  needed: boolean;
  /** A party version for exactly this model / costume / limit exists. */
  ready: boolean;
  max: number;
  /** Triangles of the original (model + costume) and of the party version. */
  srcTris: number;
  tris: number;
  model: string | null;
  costume: string | null;
  costumeId: string | null;
  warnings: string[];
  error?: string;
}
