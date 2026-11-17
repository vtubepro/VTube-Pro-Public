// The Trail — read a level GLB's node contract (ASSET_SPEC.md §1, §2.6) into a LevelDesc for the host's physics, with
// no three.js (works on the host's main thread, in the Worker and in Node): the JSON chunk gives nodes / transforms /
// extras / accessor bounds; the BIN chunk only for COL_MESH_ / COL_HULL_ vertices. Anything the GLB doesn't provide is
// taken from the placeholder level of the same kind (`fallback`), so a partially authored level still plays.
import type { ColDesc, LevelDesc, NpcDesc, Q4, SpawnDesc, V3, WagonSpec, WaterDesc, ZoneDesc } from './levels.ts';

type M4 = Float64Array; // column-major
interface GNode { name?: string; children?: number[]; mesh?: number; translation?: number[]; rotation?: number[]; scale?: number[]; matrix?: number[]; extras?: Record<string, unknown>; camera?: number }
interface Gltf { nodes?: GNode[]; scenes?: { nodes: number[] }[]; scene?: number; meshes?: { primitives: { attributes: Record<string, number>; indices?: number }[] }[]; accessors?: { bufferView?: number; byteOffset?: number; count: number; componentType: number; type: string; min?: number[]; max?: number[] }[]; bufferViews?: { byteOffset?: number; byteLength: number; byteStride?: number }[] }

function parseGlb(buf: ArrayBuffer): { json: Gltf; bin: DataView | null } {
  const dv = new DataView(buf);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12, json: Gltf | null = null, bin: DataView | null = null;
  while (off < buf.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(new Uint8Array(buf, off + 8, len))) as Gltf;
    else if (type === 0x004e4942) bin = new DataView(buf, off + 8, len);
    off += 8 + len;
  }
  if (!json) throw new Error('GLB without JSON');
  return { json, bin };
}
const ident = (): M4 => { const m = new Float64Array(16); m[0] = m[5] = m[10] = m[15] = 1; return m; };
function compose(t: number[] = [0, 0, 0], q: number[] = [0, 0, 0, 1], s: number[] = [1, 1, 1]): M4 {
  const [x, y, z, w] = q, m = new Float64Array(16);
  const x2 = x + x, y2 = y + y, z2 = z + z, xx = x * x2, xy = x * y2, xz = x * z2, yy = y * y2, yz = y * z2, zz = z * z2, wx = w * x2, wy = w * y2, wz = w * z2;
  m[0] = (1 - (yy + zz)) * s[0]; m[1] = (xy + wz) * s[0]; m[2] = (xz - wy) * s[0];
  m[4] = (xy - wz) * s[1]; m[5] = (1 - (xx + zz)) * s[1]; m[6] = (yz + wx) * s[1];
  m[8] = (xz + wy) * s[2]; m[9] = (yz - wx) * s[2]; m[10] = (1 - (xx + yy)) * s[2];
  m[12] = t[0]; m[13] = t[1]; m[14] = t[2]; m[15] = 1;
  return m;
}
function mul(a: M4, b: M4): M4 { const o = new Float64Array(16); for (let c = 0; c < 4; c++) for (let r = 0; r < 4; r++) { let s = 0; for (let k = 0; k < 4; k++) s += a[k * 4 + r] * b[c * 4 + k]; o[c * 4 + r] = s; } return o; }
const apply = (m: M4, p: number[]): V3 => [m[0] * p[0] + m[4] * p[1] + m[8] * p[2] + m[12], m[1] * p[0] + m[5] * p[1] + m[9] * p[2] + m[13], m[2] * p[0] + m[6] * p[1] + m[10] * p[2] + m[14]];
const colLen = (m: M4, c: number) => Math.hypot(m[c * 4], m[c * 4 + 1], m[c * 4 + 2]);
/** Rotation (quaternion) of a world matrix (scale removed). */
function rotOf(m: M4): Q4 {
  const sx = colLen(m, 0) || 1, sy = colLen(m, 1) || 1, sz = colLen(m, 2) || 1;
  const a = m[0] / sx, b = m[4] / sy, c = m[8] / sz, d = m[1] / sx, e = m[5] / sy, f = m[9] / sz, g = m[2] / sx, h = m[6] / sy, i = m[10] / sz;
  const tr = a + e + i;
  let x, y, z, w;
  if (tr > 0) { const s = 0.5 / Math.sqrt(tr + 1); w = 0.25 / s; x = (h - f) * s; y = (c - g) * s; z = (d - b) * s; }
  else if (a > e && a > i) { const s = 2 * Math.sqrt(1 + a - e - i); w = (h - f) / s; x = 0.25 * s; y = (b + d) / s; z = (c + g) / s; }
  else if (e > i) { const s = 2 * Math.sqrt(1 + e - a - i); w = (c - g) / s; x = (b + d) / s; y = 0.25 * s; z = (f + h) / s; }
  else { const s = 2 * Math.sqrt(1 + i - a - e); w = (d - b) / s; x = (c + g) / s; y = (f + h) / s; z = 0.25 * s; }
  return [x, y, z, w];
}
/** Yaw that turns +Z onto the node's +Z (flattened). */
function yawOf(m: M4): number { return Math.atan2(m[8], m[10]); }

function readVec3s(json: Gltf, bin: DataView | null, acc: number): number[][] {
  const a = json.accessors?.[acc];
  if (!a || !bin || a.bufferView === undefined) return [];
  const bv = json.bufferViews![a.bufferView];
  const stride = bv.byteStride || 12;
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const out: number[][] = [];
  for (let i = 0; i < a.count; i++) { const o = base + i * stride; out.push([bin.getFloat32(o, true), bin.getFloat32(o + 4, true), bin.getFloat32(o + 8, true)]); }
  return out;
}
function readIndices(json: Gltf, bin: DataView | null, acc: number | undefined, count: number): number[] {
  if (acc === undefined) return Array.from({ length: count }, (_, i) => i);
  const a = json.accessors?.[acc];
  if (!a || !bin || a.bufferView === undefined) return [];
  const bv = json.bufferViews![a.bufferView];
  const base = (bv.byteOffset ?? 0) + (a.byteOffset ?? 0);
  const size = a.componentType === 5125 ? 4 : a.componentType === 5123 ? 2 : 1;
  const out: number[] = [];
  for (let i = 0; i < a.count; i++) out.push(size === 4 ? bin.getUint32(base + i * 4, true) : size === 2 ? bin.getUint16(base + i * 2, true) : bin.getUint8(base + i));
  return out;
}
/** Local bounds of a node's mesh (accessor min/max over its primitives). */
function meshBounds(json: Gltf, mesh: number | undefined): { min: V3; max: V3 } | null {
  if (mesh === undefined) return null;
  const min: V3 = [Infinity, Infinity, Infinity], max: V3 = [-Infinity, -Infinity, -Infinity];
  for (const p of json.meshes?.[mesh]?.primitives ?? []) {
    const a = json.accessors?.[p.attributes.POSITION];
    if (!a?.min || !a.max) continue;
    for (let k = 0; k < 3; k++) { min[k] = Math.min(min[k], a.min[k]); max[k] = Math.max(max[k], a.max[k]); }
  }
  return Number.isFinite(min[0]) ? { min, max } : null;
}

export interface GlbLevelInfo { desc: LevelDesc; warnings: string[]; trimeshTris: number }

/** Build a LevelDesc from a level GLB. `fallback` = the placeholder level of the same kind (anchors the GLB lacks). */
export function levelFromGlb(buf: ArrayBuffer, fallback: LevelDesc, glbRel: string): GlbLevelInfo {
  const { json, bin } = parseGlb(buf);
  const warnings: string[] = [];
  const nodes = json.nodes ?? [];
  const world = new Map<number, M4>();
  const walk = (i: number, parent: M4) => {
    const n = nodes[i];
    const local = n.matrix ? Float64Array.from(n.matrix) : compose(n.translation, n.rotation, n.scale);
    const w = mul(parent, local);
    world.set(i, w);
    for (const c of n.children ?? []) walk(c, w);
  };
  const scene = json.scenes?.[json.scene ?? 0];
  for (const r of scene?.nodes ?? nodes.map((_, i) => i)) walk(r, ident());
  const d: LevelDesc = { ...structuredClone(fallback), cols: [], zones: [], water: [], spawns: [], npcs: [], items: [], animals: [], cams: {}, decor: [], glb: glbRel };
  const paths: Record<string, [number, V3][]> = {};
  let trimeshTris = 0;
  let wagon: SpawnDesc | null = null;
  const ex = (n: GNode) => (n.extras ?? {}) as Record<string, unknown>;
  const collider = (n: GNode) => (ex(n).collider ?? {}) as { shape?: string; size?: number[]; radius?: number; height?: number; zone?: string };
  /** OBB of a node (mesh bounds × world, or an empty: scale = half extents / extras.collider.size = full extents). */
  const obb = (i: number): { p: V3; he: V3; q: Q4 } => {
    const n = nodes[i], w = world.get(i)!;
    const b = meshBounds(json, n.mesh);
    const sx = colLen(w, 0), sy = colLen(w, 1), sz = colLen(w, 2);
    if (b) {
      const c: V3 = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
      return { p: apply(w, c), he: [(b.max[0] - b.min[0]) / 2 * sx, (b.max[1] - b.min[1]) / 2 * sy, (b.max[2] - b.min[2]) / 2 * sz], q: rotOf(w) };
    }
    const size = collider(n).size;
    return { p: apply(w, [0, 0, 0]), he: size ? [size[0] / 2, size[1] / 2, size[2] / 2] : [sx, sy, sz], q: rotOf(w) };
  };
  nodes.forEach((n, i) => {
    const name = n.name ?? '';
    const w = world.get(i);
    if (!w) return;
    const pos = apply(w, [0, 0, 0]);
    let m: RegExpExecArray | null;
    if (/^COL_BOX_/.test(name)) { const o = obb(i); d.cols.push({ shape: 'box', p: o.p, he: o.he, q: o.q, tag: 'invisible' }); }
    else if (/^COL_(SPH|CAP|CYL)_/.test(name)) {
      const o = obb(i);
      const r = Math.max(o.he[0], o.he[2]);
      if (name.startsWith('COL_SPH_')) d.cols.push({ shape: 'sphere', p: o.p, r: Math.max(...o.he), tag: 'invisible' });
      else d.cols.push({ shape: 'cylinder', p: o.p, q: o.q, r, hh: o.he[1], tag: 'invisible' });
    } else if (/^COL_(MESH|HULL)_/.test(name) && n.mesh !== undefined) {
      const verts: number[] = [], idx: number[] = [];
      for (const prim of json.meshes?.[n.mesh]?.primitives ?? []) {
        const vs = readVec3s(json, bin, prim.attributes.POSITION);
        const base = verts.length / 3;
        for (const v of vs) verts.push(...apply(w, v));
        for (const k of readIndices(json, bin, prim.indices, vs.length)) idx.push(base + k);
      }
      if (idx.length >= 3) { d.cols.push({ shape: 'trimesh', p: [0, 0, 0], verts, idx, tag: 'invisible', name } as ColDesc); trimeshTris += idx.length / 3; }
      else warnings.push(`${name}: no geometry (BIN missing?)`);
    } else if ((m = /^ZONE_(.+)$/.exec(name))) { const o = obb(i); const z: ZoneDesc = { name: collider(n).zone ?? m[1], p: o.p, he: o.he, yaw: yawOf(w), extras: ex(n) as ZoneDesc['extras'] }; d.zones.push(z); }
    else if (/^KILL_/.test(name)) { const o = obb(i); d.zones.push({ name: 'kill', p: o.p, he: o.he, yaw: yawOf(w) }); }
    else if (/^SPAWN_\d+/.test(name)) d.spawns.push({ p: pos, yaw: yawOf(w) });
    else if (name === 'WAGON_PARK') wagon = { p: pos, yaw: yawOf(w) };
    else if ((m = /^PATH_(WAGON|FERRY|\w+?)_(\d+)$/.exec(name))) { const k = m[1] === 'WAGON' ? 'ford' : m[1].toLowerCase(); (paths[k] ??= []).push([Number(m[2]), pos]); }
    else if ((m = /^NAV_(\d+)$/.exec(name))) (paths.nav ??= []).push([Number(m[1]), pos]);
    else if ((m = /^CAM_SPECT_(.+)$/.exec(name))) {
      const e = ex(n) as { fov?: number; target?: number[] };
      const fwd = apply(w, [0, 0, -1]); // glTF cameras look down -Z
      const look: V3 = e.target && e.target.length === 3 ? [e.target[0], e.target[1], e.target[2]] : [fwd[0], fwd[1], fwd[2]];
      d.cams[`CAM_SPECT_${m[1]}`] = { p: pos, look, fov: typeof e.fov === 'number' ? e.fov : 50 };
    } else if (/^WATER_/.test(name)) {
      const o = obb(i);
      const e = ex(n) as { depth?: number; flow?: number[]; murk?: number; color?: string; cloud?: boolean };
      const depth = typeof e.depth === 'number' ? e.depth : 1;
      const wd: WaterDesc = { name: name.slice(6), p: [o.p[0], o.p[1] - depth / 2, o.p[2]], he: [Math.max(o.he[0], 0.5), depth / 2 + 0.02, Math.max(o.he[2], 0.5)], level: o.p[1], depth, flow: [e.flow?.[0] ?? 0, e.flow?.[1] ?? 0], murk: e.cloud ? Math.max(0.85, e.murk ?? 0.85) : e.murk ?? 0.6,
        // colour: authored, a cloud river is cloud-white, else the theme's water colour (from the grey-box level)
        color: typeof e.color === 'string' && /^#[0-9a-f]{6}$/i.test(e.color) ? e.color : e.cloud ? '#eef2ff' : fallback.water[0]?.color };
      d.water.push(wd);
    } else if ((m = /^NPC_(.+)$/.exec(name))) { const e = ex(n) as { role?: string }; const npc: NpcDesc = { id: m[1], p: pos, yaw: yawOf(w), role: e.role ?? m[1] }; d.npcs.push(npc); }
    else if ((m = /^ITEM_(.+)_(\d+)$/.exec(name))) { const e = ex(n) as { price?: number }; d.items.push({ item: m[1], p: pos, yaw: yawOf(w), ...(typeof e.price === 'number' ? { price: e.price } : {}) }); }
    else if (/^ANIMAL_SPAWN_/.test(name)) { const e = ex(n) as { kinds?: string[]; radius?: number; air?: boolean }; d.animals.push({ p: pos, kinds: Array.isArray(e.kinds) ? e.kinds.map(String) : [], radius: typeof e.radius === 'number' ? e.radius : 8, ...(e.air ? { air: true } : {}) }); }
    else if ((m = /^SEAT_(\d+)$/.exec(name))) { const e = ex(n) as { pose?: string }; d.seats.push({ p: pos, yaw: yawOf(w), pose: e.pose === 'stand' ? 'stand' : 'sit' }); }
  });
  for (const [k, list] of Object.entries(paths)) d.paths[k] = list.sort((a, b) => a[0] - b[0]).map((x) => x[1]);
  if (wagon) d.wagon = wagon; else warnings.push('WAGON_PARK missing (placeholder position used)');
  // anything missing → the placeholder's
  if (!d.cols.length) { d.cols = fallback.cols; warnings.push('no COL_ colliders (placeholder colliders used)'); }
  if (!d.spawns.length) { d.spawns = fallback.spawns; warnings.push('no SPAWN_ nodes'); }
  // a missing porch: beside the wagon (catalogue orders must land somewhere reachable in THIS level)
  if (!d.zones.some((z) => z.name === 'porch') && fallback.zones.some((z) => z.name === 'porch')) {
    const w = d.wagon, s = Math.sin(w.yaw), c = Math.cos(w.yaw);
    d.zones.push({ name: 'porch', p: [w.p[0] + c * 3.2, w.p[1] + 0.8, w.p[2] - s * 3.2], he: [1.2, 0.6, 1.6], yaw: w.yaw });
    warnings.push('ZONE_porch missing (placed beside WAGON_PARK)');
  }
  const family = (n: string) => n.replace(/_?\d+$/, '');
  for (const z of fallback.zones) if (!d.zones.some((x) => x.name === z.name || family(x.name) === family(z.name))) { d.zones.push(z); warnings.push(`ZONE_${z.name} missing (placeholder zone used)`); }
  for (const [k, v] of Object.entries(fallback.paths)) if (!d.paths[k]) { d.paths[k] = v; warnings.push(`PATH ${k} missing (placeholder path used)`); }
  if (!d.water.length && fallback.water.length) { d.water = fallback.water; warnings.push('no WATER_ node (placeholder water used)'); }
  if (!Object.keys(d.cams).length) d.cams = fallback.cams;
  if (!d.npcs.length) d.npcs = fallback.npcs;
  if (!d.items.length) d.items = fallback.items;
  if (!d.animals.length && fallback.animals.length) {
    // no ANIMAL_SPAWN_ nodes: animals start in the level's tall grass (else around the spawns, 15–25 m out)
    const grass = d.zones.filter((z) => family(z.name) === 'grass');
    const kinds = fallback.animals[0]?.kinds ?? [];
    d.animals = grass.length ? grass.map((z) => ({ p: [z.p[0], z.p[1], z.p[2]] as V3, kinds, radius: Math.max(z.he[0], z.he[2]) })) : fallback.animals;
    warnings.push(grass.length ? 'no ANIMAL_SPAWN_ nodes (animals start in the ZONE_grass_ patches)' : 'no ANIMAL_SPAWN_ nodes (placeholder spawns used)');
  }
  if (!d.seats.length) d.seats = fallback.seats;
  return { desc: d, warnings, trimeshTris };
}

/** The level desc a view needs (no trimesh vertex data: the view renders the GLB itself). */
export function viewDesc(d: LevelDesc): LevelDesc {
  // (the mesh colliders stay on the host; a view that can't load the level GLB — a guest without this theme pack — still
  //  gets a flat stand-in for each ground mesh: its footprint at its average height, so nobody stands in the void)
  const cols = d.cols.filter((c) => c.shape !== 'trimesh');
  for (const c of d.cols) {
    if (c.shape !== 'trimesh' || !c.verts || c.verts.length < 9) continue;
    const v = c.verts;
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity, ys = 0;
    for (let i = 0; i < v.length; i += 3) { x0 = Math.min(x0, v[i]); x1 = Math.max(x1, v[i]); z0 = Math.min(z0, v[i + 2]); z1 = Math.max(z1, v[i + 2]); ys += v[i + 1]; }
    const y = ys / (v.length / 3);
    cols.push({ shape: 'box', p: [(x0 + x1) / 2, y - 0.1, (z0 + z1) / 2], he: [Math.max(0.5, (x1 - x0) / 2), 0.1, Math.max(0.5, (z1 - z0) / 2)], tag: 'ground', standIn: true } as ColDesc);
  }
  return { ...d, cols };
}

/** The wagon's physics + anchors from a theme's wagon.glb (ASSET_SPEC §2.1): COL_* (boxes / cylinders — the wagon is a
 *  dynamic body on rafts, so no trimesh), SEAT_nn, ZONE_cargo, ZONE_revive, HITCH, ANIMAL_SLOT_n, SLOT_WHEEL, WHEEL_xx,
 *  extras.mass on the root. Missing anchors come from `fallback`. */
export function wagonFromGlb(buf: ArrayBuffer, fallback: WagonSpec): { spec: WagonSpec; warnings: string[] } {
  const probe: LevelDesc = { id: 'wagon', kind: 'wagon', theme: '', size: [10, 10], cols: [], zones: [], water: [], spawns: [], wagon: { p: [0, 0, 0], yaw: 0 }, items: [], animals: [], npcs: [], seats: [], paths: {}, cams: {}, sky: {} as LevelDesc['sky'], decor: [] };
  const info = levelFromGlb(buf, probe, '');
  const { json } = parseGlb(buf);
  const warnings: string[] = [];
  const nodes = json.nodes ?? [];
  // anchors by name (world = wagon space: the root sits at the origin)
  const world = new Map<number, M4>();
  const walk = (i: number, parent: M4) => { const n = nodes[i]; const w = mul(parent, n.matrix ? Float64Array.from(n.matrix) : compose(n.translation, n.rotation, n.scale)); world.set(i, w); for (const c of n.children ?? []) walk(c, w); };
  for (const r of json.scenes?.[json.scene ?? 0]?.nodes ?? []) walk(r, ident());
  const at = (name: string): V3 | null => { const i = nodes.findIndex((n) => n.name === name); const w = i >= 0 ? world.get(i) : undefined; return w ? apply(w, [0, 0, 0]) : null; };
  const seatsRaw: { n: number; p: V3; yaw: number; pose?: 'sit' | 'stand'; sizes?: string[] }[] = [];
  nodes.forEach((n, i) => {
    const m = /^SEAT_(\d+)$/.exec(n.name ?? '');
    const w = world.get(i);
    if (!m || !w) return;
    const e = (n.extras ?? {}) as { pose?: string; sizes?: string[] };
    seatsRaw.push({ n: Number(m[1]), p: apply(w, [0, 0, 0]), yaw: yawOf(w), pose: e.pose === 'stand' ? 'stand' : 'sit', ...(Array.isArray(e.sizes) ? { sizes: e.sizes.map(String) } : {}) });
  });
  const zone = (name: string) => info.desc.zones.find((z) => z.name === name);
  const cargo = zone('cargo'), revive = zone('revive');
  const cols = info.desc.cols.filter((c) => c.shape !== 'trimesh');
  const wheels: Record<string, V3> = {};
  for (const k of ['FL', 'FR', 'RL', 'RR']) { const p = at(`WHEEL_${k}`); if (p) wheels[k] = p; }
  const root = nodes.find((n) => n.name === 'WAGON');
  const mass = Number((root?.extras as { mass?: number } | undefined)?.mass) || fallback.mass;
  const animalSlots = [1, 2, 3, 4].map((k) => at(`ANIMAL_SLOT_${k}`)).filter((p): p is V3 => !!p);
  const spec: WagonSpec = {
    mass, cols: cols.length ? cols : fallback.cols, wheels: Object.keys(wheels).length === 4 ? wheels : fallback.wheels, wheelR: fallback.wheelR,
    cargo: cargo ? { p: cargo.p, he: cargo.he } : fallback.cargo, revive: revive ? { p: revive.p, he: revive.he } : fallback.revive,
    seats: seatsRaw.length ? seatsRaw.sort((a, b) => a.n - b.n).map(({ n: _n, ...s }) => s) : fallback.seats,
    hitch: at('HITCH') ?? fallback.hitch, animalSlots: animalSlots.length === 4 ? animalSlots : fallback.animalSlots, slotWheel: at('SLOT_WHEEL') ?? fallback.slotWheel,
    ownWheels: cols.some((c) => c.shape === 'cylinder'),
  };
  if (!cargo) warnings.push('ZONE_cargo missing');
  if (!at('HITCH')) warnings.push('HITCH missing (default used)');
  if (animalSlots.length !== 4) warnings.push('ANIMAL_SLOT_1..4 missing (defaults used)');
  if (!seatsRaw.length) warnings.push('no SEAT_ nodes');
  return { spec, warnings };
}
