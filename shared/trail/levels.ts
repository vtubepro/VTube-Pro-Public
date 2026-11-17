// The Trail — level descriptions (plain data shared by the host physics, the clients' placeholder visuals and the
// Node tests) + the grey-box builders used until trailart's GLBs land (ASSET_SPEC.md §2.6), + the wagon + prop specs.
// Level space: metres, +Y up, the trail runs toward +Z. glTF-contract reader: glbLevel.ts.

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number];
export type Tag = 'ground' | 'road' | 'wall' | 'wood' | 'rock' | 'shelf' | 'bed' | 'roof' | 'fence' | 'grass' | 'bush' | 'log' | 'counter' | 'tent' | 'spire' | 'arch' | 'dock' | 'invisible' | 'cloud' | 'mud';
export interface ColDesc { shape: 'box' | 'cylinder' | 'sphere' | 'trimesh'; p: V3; q?: Q4; he?: V3; r?: number; hh?: number; tag: Tag; color?: string; friction?: number;
  /** trimesh (static only): world-space vertices (x,y,z…) + triangle indices; `name` = the GLB node (COL_MESH_riverbed…). */
  verts?: number[]; idx?: number[]; name?: string }
export interface ZoneDesc { name: string; p: V3; he: V3; yaw?: number; extras?: Record<string, number | string | boolean> }
export interface WaterDesc { name: string; p: V3; he: V3; level: number; depth: number; flow: [number, number]; murk: number; color?: string }
export interface SpawnDesc { p: V3; yaw: number }
export interface ItemSpawn { item: string; p: V3; yaw?: number; price?: number; value?: number }
export interface NpcDesc { id: string; p: V3; yaw: number; role: string; name?: string }
export interface Sky { top: string; bottom: string; fog: string; fogNear: number; fogFar: number; sun: string; sunI: number; amb: string; ambI: number; night?: boolean }
export interface LevelDesc {
  id: string; kind: string; theme: string; size: [number, number];
  cols: ColDesc[]; zones: ZoneDesc[]; water: WaterDesc[];
  spawns: SpawnDesc[]; wagon: SpawnDesc; items: ItemSpawn[]; animals: { p: V3; kinds: string[]; radius: number; air?: boolean }[]; npcs: NpcDesc[];
  seats: (SpawnDesc & { pose: 'sit' | 'stand' })[]; paths: Record<string, V3[]>; cams: Record<string, { p: V3; look: V3; fov: number }>;
  sky: Sky; decor: { kind: string; p: V3; s: number; yaw: number; color?: string }[];
  /** Asset (theme pack) providing the visuals, when present (the host's colliders then come from it too). */
  glb?: string;
  /** Generated stops (stopgen.ts): a heightfield ground (the host's physics + every view rebuild it from `spec`). */
  terrain?: import('./stopgen.ts').TerrainDesc;
  /** Generated stops: the visual recipe the client's stopview.ts renders (materials per collider, kit pieces, …). */
  art?: import('./stopgen.ts').StopArt;
}

const yawQ = (y: number): Q4 => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const pitchQ = (x: number): Q4 => [Math.sin(x / 2), 0, 0, Math.cos(x / 2)];
const box = (p: V3, he: V3, tag: Tag, color?: string, q?: Q4): ColDesc => ({ shape: 'box', p, he, tag, color, ...(q ? { q } : {}) });
const cyl = (p: V3, r: number, hh: number, tag: Tag, color?: string): ColDesc => ({ shape: 'cylinder', p, r, hh, tag, color });

/** Theme palette → level colours (deck.palette), with fallbacks. */
export interface Pal { ground: string; road: string; wood: string; wall: string; roof: string; rock: string; grass: string; accent: string; accent2: string; water: string; sky: string; fog: string; night: string; cloud: string }
export function palette(p: Record<string, string> | undefined, theme: string): Pal {
  const bong = theme === 'bayou', leaf = theme === 'skyisles';
  return {
    ground: p?.ground ?? (bong ? '#3b5b2a' : leaf ? '#bfe3a6' : '#8b7a55'),
    road: bong ? '#5a4632' : leaf ? '#f1e6c8' : '#9c8457',
    wood: bong ? '#6b4a2e' : leaf ? '#f4efe4' : '#7a5533',
    wall: bong ? '#2f5a44' : leaf ? '#f8f4ec' : '#a8875c',
    roof: bong ? '#6b2f5e' : leaf ? '#d83a4a' : '#6e3b2a',
    rock: bong ? '#5d6b55' : leaf ? '#c9d2e6' : '#8a8378',
    grass: bong ? '#4f8a2d' : leaf ? '#9bdc7a' : '#9aa84e',
    accent: p?.accent ?? '#e8a33d', accent2: p?.accent2 ?? '#7fb8d6',
    water: p?.water ?? (bong ? '#3f6b3a' : leaf ? '#e8eeff' : '#4a7fa0'),
    sky: p?.sky ?? (bong ? '#1d3b2c' : leaf ? '#8fc8ff' : '#9cc7e6'),
    fog: p?.fog ?? (bong ? '#1f3a28' : leaf ? '#dfe9ff' : '#d9c9a3'),
    night: bong ? '#07100c' : leaf ? '#101a3a' : '#0d1020', cloud: leaf ? '#ffffff' : '#d8d8d8',
  };
}
function sky(pal: Pal, theme: string, night = false): Sky {
  if (night) return { top: pal.night, bottom: '#1a2433', fog: pal.night, fogNear: 12, fogFar: 55, sun: '#8fa8ff', sunI: 0.35, amb: '#6070a0', ambI: 0.45, night: true };
  if (theme === 'bayou') return { top: '#2a5a44', bottom: '#9fd67a', fog: '#6f9a6a', fogNear: 30, fogFar: 140, sun: '#fff1c0', sunI: 1.8, amb: '#b9ffcf', ambI: 0.9 };
  if (theme === 'skyisles') return { top: '#4f8fe8', bottom: '#eaf4ff', fog: '#dfeaff', fogNear: 40, fogFar: 180, sun: '#fff6e0', sunI: 2.0, amb: '#e8f0ff', ambI: 1.0 };
  return { top: '#6aa6d8', bottom: '#f2e3c0', fog: pal.fog, fogNear: 40, fogFar: 170, sun: '#fff3d6', sunI: 2.0, amb: '#fff0dd', ambI: 0.9 };
}
function arena(d: LevelDesc, w: number, depth: number, pal: Pal, cx = 0, cz = 0) {
  d.cols.push(box([cx, -0.5, cz], [w / 2, 0.5, depth / 2], 'ground', pal.ground));
  const h = 6;
  d.cols.push(box([cx, h / 2, cz - depth / 2 - 0.5], [w / 2, h / 2, 0.5], 'invisible'), box([cx, h / 2, cz + depth / 2 + 0.5], [w / 2, h / 2, 0.5], 'invisible'),
    box([cx - w / 2 - 0.5, h / 2, cz], [0.5, h / 2, depth / 2], 'invisible'), box([cx + w / 2 + 0.5, h / 2, cz], [0.5, h / 2, depth / 2], 'invisible'));
}
function base(id: string, kind: string, theme: string, pal: Pal, size: [number, number], night = false): LevelDesc {
  return { id, kind, theme, size, cols: [], zones: [], water: [], spawns: [], wagon: { p: [0, 0, 0], yaw: 0 }, items: [], animals: [], npcs: [], seats: [], paths: {}, cams: {}, sky: sky(pal, theme, night), decor: [] };
}
function spawnsAround(c: V3, n = 8, r = 3, yaw = 0): SpawnDesc[] {
  return Array.from({ length: n }, (_, i) => { const a = (i / n) * Math.PI * 2; return { p: [c[0] + Math.cos(a) * r, 0.1, c[2] + Math.sin(a) * r] as V3, yaw }; });
}
/** Seeded scatter for decor (deterministic per level + seed). */
function scatter(seed: number, n: number, w: number, d: number, avoid: (x: number, z: number) => boolean, kinds: string[], cz = 0): LevelDesc['decor'] {
  let s = seed >>> 0 || 1;
  const rnd = () => { s ^= s << 13; s ^= s >>> 17; s ^= s << 5; return ((s >>> 0) % 100000) / 100000; };
  const out: LevelDesc['decor'] = [];
  for (let i = 0, g = 0; i < n && g < n * 20; g++) {
    const x = (rnd() - 0.5) * w, z = cz + (rnd() - 0.5) * d;
    if (avoid(x, z)) continue;
    out.push({ kind: kinds[Math.floor(rnd() * kinds.length)], p: [x, 0, z], s: 0.7 + rnd() * 0.8, yaw: rnd() * 6.28 });
    i++;
  }
  return out;
}
const THEME_DECOR: Record<string, string[]> = {
  bayou: ['cypress', 'reeds', 'lilypad', 'mushroom', 'stump', 'firefly'],
  skyisles: ['cloudpuff', 'crystal', 'shrine', 'flowertree', 'featherpost', 'star'],
  frontier: ['pine', 'rock', 'bush', 'cactus', 'stump', 'grasstuft'],
};
const decorKinds = (theme: string) => THEME_DECOR[theme] ?? THEME_DECOR.frontier;

// ---------------------------------------------------------------- the wagon (ASSET_SPEC §2.1), wagon-local space (+Z forward)
/** The wagon's physics + anchors in wagon-local space (+Z forward, origin at ground level). The engine default below; a
 *  theme's `wagon.glb` (trailart) replaces it through glbLevel.ts `wagonFromGlb` so physics matches the visible wagon. */
export interface WagonSpec {
  mass: number; cols: ColDesc[]; wheels: Record<string, V3>; wheelR: { F: number; R: number };
  cargo: { p: V3; he: V3 }; revive: { p: V3; he: V3 };
  seats: { p: V3; yaw: number; pose?: 'sit' | 'stand'; sizes?: string[] }[];
  hitch: V3; animalSlots: V3[]; slotWheel: V3;
  /** Wheel colliders come with `cols` (from a GLB): don't add the default wheel cylinders. */
  ownWheels?: boolean;
}
/** Theme-pack level files per stop kind, in preference order (ASSET_SPEC §3: landmark_1 = the slice's landmark,
 *  destination = the finish). Paths are relative to the theme pack, without `.glb`. */
export const LEVEL_FILES: Record<string, string[]> = {
  store: ['levels/store'], river: ['levels/river', 'levels/river_1'], hunt: ['levels/hunt'], landmark: ['levels/landmark_1', 'levels/landmark'],
  camp: ['levels/camp'], finish: ['levels/destination', 'levels/finish'],
};

/** Every level file a theme pack may have: [key, level kind, candidate files]. Keys: the stop kind (generic level) or
 *  `node:<route node id>` (a level just for that stop, e.g. levels/landmark_2.glb, levels/river_3.glb). */
export function levelJobs(route: { id: string; kind: string }[]): [string, string, string[]][] {
  const jobs: [string, string, string[]][] = Object.entries(LEVEL_FILES).map(([k, f]) => [k, k, f]);
  const taken = new Set(Object.values(LEVEL_FILES).flat());
  const kindOf: Record<string, string> = { river: 'river', landmark: 'landmark', fort: 'store', pass: 'landmark' };
  for (const n of route) {
    const kind = kindOf[n.kind];
    const f = `levels/${n.id}`;
    if (!kind || taken.has(f) || !/^[a-z0-9_]{1,40}$/.test(n.id)) continue;
    taken.add(f);
    jobs.push([`node:${n.id}`, kind, [f]]);
  }
  return jobs;
}

export const WAGON: WagonSpec = {
  mass: 450,
  /** Colliders: bed floor, side walls, front board, bonnet roof (walkable). */
  cols: [
    box([0, 0.85, 0], [1.0, 0.08, 1.9], 'bed'), box([-1.0, 1.25, 0], [0.07, 0.35, 1.9], 'wood'), box([1.0, 1.25, 0], [0.07, 0.35, 1.9], 'wood'),
    box([0, 1.25, 1.85], [1.0, 0.35, 0.07], 'wood'), box([0, 2.45, -0.1], [1.05, 0.08, 1.7], 'roof'),
  ] as ColDesc[],
  wheels: { FL: [-1.08, 0.55, 1.35], FR: [1.08, 0.55, 1.35], RL: [-1.08, 0.65, -1.35], RR: [1.08, 0.65, -1.35] } as Record<string, V3>,
  wheelR: { F: 0.55, R: 0.65 },
  /** The cargo zone (inside the bed, up to the bonnet). */
  cargo: { p: [0, 1.5, 0] as V3, he: [0.95, 0.65, 1.85] as V3 },
  revive: { p: [0, 1, 0] as V3, he: [1.8, 1.4, 2.6] as V3 },
  seats: [
    { p: [-0.72, 0.95, 0.9], yaw: Math.PI / 2 }, { p: [0.72, 0.95, 0.9], yaw: -Math.PI / 2 }, { p: [-0.72, 0.95, -0.2], yaw: Math.PI / 2 },
    { p: [0.72, 0.95, -0.2], yaw: -Math.PI / 2 }, { p: [-0.72, 0.95, -1.3], yaw: Math.PI / 2 }, { p: [0.72, 0.95, -1.3], yaw: -Math.PI / 2 },
    { p: [0, 1.35, 2.25], yaw: 0 }, { p: [0, 2.55, -0.3], yaw: 0 },
    // (index 6 = the driver bench, 7 = the roof: large / macro only)
  ].map((s, i) => (i === 7 ? { ...s, pose: 'stand' as const, sizes: ['large', 'macro'] } : s)) as WagonSpec['seats'],
  hitch: [0, 0.6, 3.2],
  animalSlots: [[-0.7, 0, 4.4], [0.7, 0, 4.4], [-0.7, 0, 6.3], [0.7, 0, 6.3]],
  slotWheel: [-1.25, 0.55, 1.35],
};
/** Cargo slot `i` in a wagon's cargo box: [x, y, z] (wagon space) + yaw of the prop (crates lie along the bed). */
export function cargoSlot(w: WagonSpec, i: number): { p: V3; yaw: number } {
  const c = w.cargo;
  const along = c.he[2] >= c.he[0];
  const cw = along ? 0.5 : 0.75, cl = along ? 0.75 : 0.5;
  const nx = Math.max(1, Math.floor((c.he[0] * 2) / cw)), nz = Math.max(1, Math.floor((c.he[2] * 2) / cl));
  const per = nx * nz, layer = Math.floor(i / per), k = i % per;
  const x = -c.he[0] + cw * (0.5 + (k % nx)) + (c.he[0] * 2 - nx * cw) / 2;
  const z = -c.he[2] + cl * (0.5 + Math.floor(k / nx)) + (c.he[2] * 2 - nz * cl) / 2;
  return { p: [c.p[0] + x, c.p[1] - c.he[1] + 0.3 + layer * 0.46, c.p[2] + z], yaw: along ? Math.PI / 2 : 0 };
}
export const cargoSlotCount = (w: WagonSpec) => { const c = w.cargo; const along = c.he[2] >= c.he[0]; return Math.max(1, Math.floor((c.he[0] * 2) / (along ? 0.5 : 0.75))) * Math.max(1, Math.floor((c.he[2] * 2) / (along ? 0.75 : 0.5))) * Math.max(1, Math.floor((c.he[1] * 2 + 0.3) / 0.46)); };

// ---------------------------------------------------------------- props (ASSET_SPEC §2.3) — physics + placeholder look
export interface PropSpec { shape: 'box' | 'cylinder' | 'sphere' | 'capsule'; size: V3; mass: number; buoy: number; color: string; label: string; item?: string }
export const PROPS: Record<string, PropSpec> = {
  crate_food: { shape: 'box', size: [0.35, 0.22, 0.22], mass: 25, buoy: 1.4, color: '#b5874f', label: 'FOOD', item: 'food' },
  clothes_bundle: { shape: 'box', size: [0.25, 0.17, 0.2], mass: 8, buoy: 1.2, color: '#7a6bd6', label: 'CLOTHES', item: 'clothes' },
  ammo_box: { shape: 'box', size: [0.22, 0.15, 0.15], mass: 12, buoy: 0.7, color: '#56644a', label: 'AMMO', item: 'ammo' },
  medicine: { shape: 'cylinder', size: [0.1, 0.15, 0.1], mass: 2, buoy: 1.1, color: '#6cff9a', label: 'MED', item: 'medicine' },
  spare_wheel: { shape: 'cylinder', size: [0.62, 0.07, 0.62], mass: 35, buoy: 1.1, color: '#7a5533', label: 'WHEEL', item: 'wheel' },
  spare_axle: { shape: 'box', size: [1.0, 0.075, 0.075], mass: 50, buoy: 0.8, color: '#6b4a2e', label: 'AXLE', item: 'axle' },
  spare_tongue: { shape: 'box', size: [1.3, 0.06, 0.06], mass: 30, buoy: 1.0, color: '#6b4a2e', label: 'TONGUE', item: 'tongue' },
  barrel: { shape: 'cylinder', size: [0.3, 0.42, 0.3], mass: 40, buoy: 1.6, color: '#8a5a2b', label: 'WATER' },
  bucket: { shape: 'cylinder', size: [0.17, 0.17, 0.17], mass: 3, buoy: 1.3, color: '#a0a0a0', label: 'BUCKET' },
  meme_frog: { shape: 'sphere', size: [0.16, 0.16, 0.16], mass: 3, buoy: 1.5, color: '#8dff3a', label: 'MEME', item: 'meme' },
  draft: { shape: 'box', size: [0.6, 0.5, 0.9], mass: 90, buoy: 1.2, color: '#6fae3a', label: 'DRAFT', item: 'draft' },
  plank: { shape: 'box', size: [1.0, 0.03, 0.15], mass: 8, buoy: 1.5, color: '#a07a4a', label: '' },
  // v2 camp + memes
  log: { shape: 'capsule', size: [0.11, 0.42, 0.11], mass: 9, buoy: 1.6, color: '#7a5230', label: '' },
  log_big: { shape: 'capsule', size: [0.24, 0.8, 0.24], mass: 95, buoy: 1.6, color: '#6b4526', label: 'BIG LOG' },
  tent_bundle: { shape: 'box', size: [0.45, 0.2, 0.2], mass: 18, buoy: 1.3, color: '#c9b27a', label: 'TENT' },
  feed_sack: { shape: 'box', size: [0.3, 0.18, 0.22], mass: 14, buoy: 1.2, color: '#d6c38a', label: 'FEED' },
  rubber_duck: { shape: 'sphere', size: [1.1, 1.1, 1.1], mass: 60, buoy: 3, color: '#ffd23f', label: '' },
};

// ---------------------------------------------------------------- builders
export interface BuildOpts { theme: string; palette?: Record<string, string>; seed?: number; depth?: number; swift?: boolean; animals?: Record<string, { count: number }>; slot?: number }

export function buildStore(o: BuildOpts): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('store', 'store', o.theme, pal, [50, 50]);
  arena(d, 50, 50, pal);
  // the shop: floor, walls (door 1.2 × 2.2 front-centre, window 2.6 wide front-left, cat flap 0.5 × 0.45 back-right), roof
  const cz = -8, W = 6, D = 4.5, H = 3.2, t = 0.15;
  d.cols.push(box([0, 0.05, cz], [W, 0.05, D], 'wood', pal.wood));
  const front = cz + D, back = cz - D;
  /** A wall segment x0..x1 × y0..y1 at depth z. */
  const seg = (x0: number, x1: number, y0: number, y1: number, z: number, tag: Tag = 'wall', col = pal.wall) => d.cols.push(box([(x0 + x1) / 2, (y0 + y1) / 2, z], [(x1 - x0) / 2, (y1 - y0) / 2, t], tag, col));
  // front: [wall][window: counter below, wall above][wall][door 1.2 × 2.2][wall]
  seg(-W, -3.7, 0, H, front); seg(-3.7, -1.1, 0, 1.1, front, 'counter', pal.wood); seg(-3.7, -1.1, 2.2, H, front);
  seg(-1.1, -0.6, 0, H, front); seg(-0.6, 0.6, 2.2, H, front); seg(0.6, W, 0, H, front);
  // back: [wall][cat flap 0.5 × 0.45][wall]
  seg(-W, 3.25, 0, H, back); seg(3.25, 3.75, 0.45, H, back); seg(3.75, W, 0, H, back);
  d.cols.push(box([-W, H / 2, cz], [t, H / 2, D], 'wall', pal.wall), box([W, H / 2, cz], [t, H / 2, D], 'wall', pal.wall));
  d.cols.push(box([0, H + 0.1, cz], [W + 0.4, 0.1, D + 0.4], 'roof', pal.roof));
  // shelves along the side walls + a centre island, a counter at the back
  const shelves: V3[] = [[-W + 0.45, 0, cz - 1.5], [-W + 0.45, 0, cz + 1.8], [W - 0.45, 0, cz - 1.5], [W - 0.45, 0, cz + 1.8], [0, 0, cz + 0.4]];
  shelves.forEach((s, i) => {
    const alongX = i === 4;
    const he: V3 = alongX ? [2.2, 0.05, 0.4] : [0.4, 0.05, 1.3];
    for (const y of [0.45, 1.15]) d.cols.push(box([s[0], y, s[2]], he, 'shelf', pal.wood));
  });
  d.cols.push(box([-2.8, 0.55, cz - 3.2], [1.8, 0.55, 0.45], 'counter', pal.wood));
  d.npcs.push({ id: 'shopkeeper', p: [-2.8, 0, cz - 3.9], yaw: 0, role: 'shopkeeper' });
  // stock on the shelves (prices are filled in by the sim from the deck)
  const stock: [string, V3][] = [];
  const lane = (x: number, z0: number, items: string[]) => items.forEach((it, k) => stock.push([it, [x, 0, z0 + k * 0.62]]));
  lane(-W + 0.45, cz - 2.5, ['crate_food', 'crate_food', 'crate_food', 'crate_food']);
  lane(-W + 0.45, cz + 0.9, ['crate_food', 'crate_food', 'crate_food', 'crate_food']);
  lane(W - 0.45, cz - 2.5, ['clothes_bundle', 'clothes_bundle', 'clothes_bundle', 'clothes_bundle']);
  lane(W - 0.45, cz + 0.9, ['ammo_box', 'ammo_box', 'ammo_box', 'medicine']);
  stock.push(['medicine', [-1.4, 0, cz + 0.4]], ['medicine', [-0.7, 0, cz + 0.4]], ['meme_frog', [0, 0, cz + 0.4]], ['spare_wheel', [1, 0, cz + 0.4]], ['spare_wheel', [1.9, 0, cz + 0.4]]);
  for (const [item, p] of stock) {
    const shelfY = Math.abs(p[0]) > 4 ? 1.22 : 1.22;
    d.items.push({ item, p: [p[0], shelfY + (PROPS[item]?.size[1] ?? 0.2) + 0.02, p[2]] });
  }
  d.items.push({ item: 'spare_axle', p: [0, 0.2, cz - 2] }, { item: 'spare_tongue', p: [0, 0.5, cz - 2] }, { item: 'barrel', p: [4.8, 0.45, cz - 3.6] });
  // the pen with the draft animals
  const px = 13, pz = -6;
  for (const [x, z, hx, hz] of [[px, pz - 4, 4, 0.1], [px + 4, pz, 0.1, 4], [px - 4, pz - 2.4, 0.1, 1.6]] as const) d.cols.push(box([x, 0.5, z], [hx, 0.5, hz], 'fence', pal.wood));
  for (let i = 0; i < 6; i++) d.items.push({ item: 'draft', p: [px - 1.8 + (i % 3) * 1.8, 0.7, pz - 2 + Math.floor(i / 3) * 2.4] });
  d.zones.push({ name: 'checkout', p: [-2.8, 1, cz - 2.4], he: [1.8, 1, 0.6] }, { name: 'window', p: [-1.1, 1.5, front + 0.8], he: [1.3, 1.2, 0.8] },
    { name: 'catflap', p: [3.5, 0.3, back], he: [0.3, 0.3, 0.4] }, { name: 'porch', p: [-4, 0.5, 1.5], he: [2, 0.5, 1.5] }, { name: 'pen', p: [px, 1, pz], he: [4, 1, 4] });
  d.wagon = { p: [0, 0, 8], yaw: 0 };
  // walk graph for bots / NPCs: through the door, the aisles
  d.paths.nav = [[0, 0, front + 1.4], [0, 0, front - 1.2], [-3.4, 0, cz], [3.4, 0, cz], [0, 0, back + 1.4], [-3.4, 0, back + 1.3], [3.4, 0, back + 1.3]];
  d.spawns = spawnsAround([0, 0, 3], 8, 2.5, Math.PI);
  d.cams = { CAM_SPECT_WIDE: { p: [14, 9, 20], look: [0, 1, -2], fov: 50 }, CAM_SPECT_HERO: { p: [-5, 2.2, 1], look: [0, 1.2, cz], fov: 55 } };
  d.decor = scatter(o.seed ?? 1, 26, 46, 46, (x, z) => (Math.abs(x) < 8 && z > -14 && z < 13) || (x > 8 && x < 18 && z > -11 && z < -1), decorKinds(o.theme));
  d.decor.push({ kind: 'sign', p: [3.2, 3.6, front + 0.2], s: 1, yaw: 0, color: pal.accent });
  return d;
}

export function buildRiver(o: BuildOpts): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const depthM = Math.max(0.3, (o.depth ?? 3) * 0.3048);
  const d = base('river', 'river', o.theme, pal, [60, 56]);
  const W = 60, halfR = 9, bank = 19;
  d.cols.push(box([0, -0.5, -halfR - bank / 2], [W / 2, 0.5, bank / 2], 'ground', pal.ground), box([0, -0.5, halfR + bank / 2], [W / 2, 0.5, bank / 2], 'ground', pal.ground));
  d.cols.push(box([0, -depthM - 0.5, 0], [W / 2, 0.5, halfR], 'mud', '#4a3b2a'));
  // banks slope down into the bed (ramps 4 m long on both sides)
  const ramp = (sign: number) => {
    const len = 4, ang = Math.atan2(depthM, len);
    const zc = sign * (halfR - len / 2);
    d.cols.push(box([0, -depthM / 2 - 0.35, zc], [W / 2, 0.35, Math.hypot(len, depthM) / 2], 'mud', '#5a4a33', pitchQ(sign * -ang)));
  };
  ramp(-1); ramp(1);
  d.cols.push(box([0, 2.5, -halfR - bank - 0.5], [W / 2, 3, 0.5], 'invisible'), box([0, 2.5, halfR + bank + 0.5], [W / 2, 3, 0.5], 'invisible'),
    box([-W / 2 - 0.5, 2.5, 0], [0.5, 3, halfR + bank], 'invisible'));
  // stepping stones (micro / small shortcut across) upstream
  for (let i = 0; i < 7; i++) d.cols.push(cyl([-10 + (i % 2) * 0.8, -depthM + (depthM + 0.25) / 2, -7.5 + i * 2.5], 0.55, (depthM + 0.25) / 2, 'rock', pal.rock));
  const flow = (o.swift ? 2.8 : 1.6) * (o.theme === 'skyisles' ? 1.1 : 1);
  d.water.push({ name: 'river', p: [0, -depthM / 2, 0], he: [W / 2, depthM / 2 + 0.02, halfR], level: -0.08, depth: depthM, flow: [flow, 0], murk: o.theme === 'skyisles' ? 0.2 : 0.7, color: pal.water });
  d.zones.push({ name: 'farbank', p: [0, 1, halfR + 5], he: [W / 2, 2, 5] }, { name: 'nearbank', p: [0, 1, -halfR - 5], he: [W / 2, 2, 5] },
    { name: 'rapids', p: [W / 2 - 2, 0, 0], he: [2, 3, halfR], extras: { lost: true } }, { name: 'catch', p: [W / 2 - 6, 0.5, -halfR - 2.5], he: [3, 1, 1.5] });
  d.wagon = { p: [0, 0, -halfR - 6], yaw: 0 };
  d.paths.ford = [[0, 0, -halfR - 6], [0, 0, -halfR], [0, -depthM, -halfR + 4], [0, -depthM, halfR - 4], [0, 0, halfR], [0, 0, halfR + 6]];
  d.paths.ferry = [[-14, -0.1, -halfR + 2.2], [-14, -0.1, halfR - 2.2]];
  d.paths.caulk = [[4, 0, -halfR - 2], [4, 0, halfR + 3]];
  d.npcs.push({ id: 'ferryman', p: [-17, 0, -halfR - 2], yaw: 0.6, role: 'ferryman' }, { id: 'talker_1', p: [8, 0, -halfR - 7], yaw: Math.PI, role: 'talker' });
  d.spawns = spawnsAround([3, 0, -halfR - 9], 8, 2.5, 0);
  d.cams = { CAM_SPECT_WIDE: { p: [-22, 12, -24], look: [2, 0, 0], fov: 52 }, CAM_SPECT_HERO: { p: [12, 2.5, -2], look: [0, 0, 0], fov: 55 } };
  d.decor = scatter(o.seed ?? 2, 40, 58, 54, (x, z) => Math.abs(z) < halfR + 1 || (Math.abs(x) < 6 && Math.abs(z) < 17) || (x < -10 && x > -20 && Math.abs(z) < 13), decorKinds(o.theme));
  return d;
}

export function buildHunt(o: BuildOpts): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('hunt', 'hunt', o.theme, pal, [80, 80]);
  arena(d, 80, 80, pal);
  const s = o.seed ?? 3;
  let r = s || 7;
  const rnd = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return ((r >>> 0) % 100000) / 100000; };
  for (let i = 0; i < 9; i++) { // grass patches (micro hide)
    const x = (rnd() - 0.5) * 60, z = (rnd() - 0.5) * 50 + 5;
    const he: V3 = [2.5 + rnd() * 3, 0.6, 2.5 + rnd() * 3];
    d.zones.push({ name: `grass_${i}`, p: [x, 0.6, z], he });
    d.decor.push({ kind: 'tallgrass', p: [x, 0, z], s: he[0], yaw: he[2], color: pal.grass });
  }
  for (let i = 0; i < 12; i++) d.cols.push(box([(rnd() - 0.5) * 66, 0.5, (rnd() - 0.5) * 60 + 6], [0.6 + rnd(), 0.5 + rnd() * 0.4, 0.6 + rnd()], rnd() < 0.5 ? 'bush' : 'rock', rnd() < 0.5 ? pal.grass : pal.rock));
  for (let i = 0; i < 4; i++) d.cols.push(box([(rnd() - 0.5) * 50, 0.25, (rnd() - 0.5) * 40 + 6], [0.3, 0.25, 2 + rnd() * 2], 'log', pal.wood, [0, Math.sin(rnd() * 3), 0, Math.cos(rnd() * 3)]));
  d.water.push({ name: 'pond', p: [14, -0.3, 18], he: [5, 0.3, 4], level: -0.05, depth: 0.6, flow: [0, 0], murk: 0.6, color: pal.water });
  d.cols.push(box([14, -0.65, 18], [5, 0.05, 4], 'mud', '#4a3b2a'));
  const kinds = Object.keys(o.animals ?? { deer: { count: 3 } });
  for (let i = 0; i < 12; i++) d.animals.push({ p: [(rnd() - 0.5) * 60, 0.5, (rnd() - 0.2) * 50], kinds, radius: 8 });
  d.wagon = { p: [0, 0, -32], yaw: 0 };
  d.spawns = spawnsAround([0, 0, -27], 8, 2.5, 0);
  d.cams = { CAM_SPECT_WIDE: { p: [0, 22, -44], look: [0, 0, 0], fov: 55 }, CAM_SPECT_HERO: { p: [-6, 2, -24], look: [0, 1, 0], fov: 50 } };
  d.decor.push(...scatter(s + 1, 50, 78, 78, (x, z) => Math.abs(x) < 6 && z < -22, decorKinds(o.theme)));
  return d;
}

export function buildLandmark(o: BuildOpts): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('landmark', 'landmark', o.theme, pal, [60, 60]);
  arena(d, 60, 60, pal);
  // the spire + a spiral ledge path to a summit platform (climb race)
  const c: V3 = [0, 0, 12];
  const H = 16, R = 3.2;
  d.cols.push(cyl([c[0], H / 2, c[2]], R, H / 2, 'spire', pal.rock));
  const steps = 26;
  for (let i = 0; i < steps; i++) {
    const a = (i / steps) * Math.PI * 3.2 - Math.PI / 2, y = 0.45 + (i / steps) * (H - 0.6);
    const rr = R + 0.9;
    d.cols.push(box([c[0] + Math.cos(a) * rr, y, c[2] + Math.sin(a) * rr], [0.95, 0.12, 0.75], 'rock', pal.rock, [0, Math.sin(-a / 2), 0, Math.cos(-a / 2)]));
  }
  d.cols.push(cyl([c[0], H + 0.15, c[2]], R + 0.6, 0.15, 'rock', pal.rock));
  d.zones.push({ name: 'summit', p: [c[0], H + 1.2, c[2]], he: [R + 0.6, 1.2, R + 0.6] }, { name: 'photo', p: [0, 1, -4], he: [4, 1.5, 3] });
  d.decor.push({ kind: 'signwall', p: [c[0], H + 0.3, c[2]], s: 1, yaw: 0, color: pal.accent });
  d.npcs.push({ id: 'talker_1', p: [-9, 0, -8], yaw: 0.9, role: 'talker' }, { id: 'talker_2', p: [9, 0, -7], yaw: -0.9, role: 'talker' }, { id: 'talker_3', p: [-3, 0, -14], yaw: 0.2, role: 'talker' });
  for (const [x, z] of [[-12, -2], [12, -1], [-14, 8]] as const) d.cols.push(box([x, 1.3, z], [2, 1.3, 2], 'wall', pal.wall), box([x, 2.8, z], [2.3, 0.2, 2.3], 'roof', pal.roof));
  d.wagon = { p: [0, 0, -20], yaw: 0 };
  d.spawns = spawnsAround([0, 0, -15], 8, 2.5, 0);
  d.cams = { CAM_SPECT_WIDE: { p: [18, 14, -22], look: [0, 6, 6], fov: 55 }, CAM_SPECT_HERO: { p: [0, 2.4, -9], look: [0, 1.3, -3], fov: 45 }, CAM_SPECT_photo: { p: [0, 2.2, -10.5], look: [0, 1.2, -4], fov: 42 } };
  d.decor.push(...scatter(o.seed ?? 4, 36, 58, 58, (x, z) => Math.hypot(x - c[0], z - c[2]) < 7 || (Math.abs(x) < 5 && z < -2 && z > -24) || Math.abs(x) > 9 && Math.abs(x) < 16 && z > -6 && z < 12, decorKinds(o.theme)));
  return d;
}

export function buildCamp(o: BuildOpts): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('camp', 'camp', o.theme, pal, [44, 44], true);
  arena(d, 44, 44, pal);
  d.zones.push({ name: 'fire', p: [0, 0.5, 0], he: [0.9, 0.6, 0.9], extras: { damage: 8 } });
  d.decor.push({ kind: 'campfire', p: [0, 0, 0], s: 1, yaw: 0, color: '#ff9a3a' });
  for (let i = 0; i < 8; i++) {
    const a = (i / 8) * Math.PI * 2 + 0.2, r = 3.3;
    const p: V3 = [Math.cos(a) * r, 0, Math.sin(a) * r];
    const yaw = Math.atan2(-p[0], -p[2]);
    d.cols.push(box([p[0], 0.2, p[2]], [0.7, 0.2, 0.25], 'log', pal.wood, [0, Math.sin((yaw + Math.PI / 2) / 2), 0, Math.cos((yaw + Math.PI / 2) / 2)]));
    d.seats.push({ p: [p[0], 0.4, p[2]], yaw, pose: 'sit' });
  }
  for (const [x, z] of [[-9, 5], [9, 6], [-7, -9]] as const) d.cols.push(box([x, 0.8, z], [1.3, 0.8, 1.6], 'tent', pal.accent2));
  d.zones.push({ name: 'stash', p: [2.5, 0.5, -9], he: [2.5, 0.8, 1.5] });
  d.wagon = { p: [0, 0, -10], yaw: 0 };
  d.spawns = spawnsAround([0, 0, -5], 8, 1.8, 0);
  d.cams = { CAM_SPECT_WIDE: { p: [9, 7, 12], look: [0, 0.5, 0], fov: 50 }, CAM_SPECT_HERO: { p: [0, 1.6, 6.5], look: [0, 1, 0], fov: 55 } };
  d.decor.push(...scatter(o.seed ?? 5, 30, 42, 42, (x, z) => Math.hypot(x, z) < 8 || (Math.abs(x) < 4 && z < -5), decorKinds(o.theme)));
  return d;
}

/** The travel / road-event strip: a long road along +Z (floating origin: the sim rebases by −ROAD_REBASE). */
export const ROAD_LEN = 420, ROAD_REBASE = 240, ROAD_SPEED = 3.6;
export function buildRoad(o: BuildOpts & { event?: string }): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('road', 'road', o.theme, pal, [40, ROAD_LEN]);
  d.cols.push(box([0, -0.5, 0], [22, 0.5, ROAD_LEN / 2], 'ground', pal.ground), box([0, 0.005, 0], [2.2, 0.01, ROAD_LEN / 2], 'road', pal.road));
  d.cols.push(box([-23, 3, 0], [0.5, 3, ROAD_LEN / 2], 'invisible'), box([23, 3, 0], [0.5, 3, ROAD_LEN / 2], 'invisible'));
  d.wagon = { p: [0, 0, -ROAD_LEN / 2 + 60], yaw: 0 };
  d.spawns = spawnsAround([0, 0, -ROAD_LEN / 2 + 54], 8, 2, 0);
  d.zones.push({ name: 'finishline', p: [0, 1, -ROAD_LEN / 2 + 150], he: [12, 2, 2] }, { name: 'bush', p: [-12, 1, -ROAD_LEN / 2 + 150], he: [2, 2, 2] });
  d.cams = { CAM_SPECT_WIDE: { p: [9, 6, -ROAD_LEN / 2 + 48], look: [0, 1, -ROAD_LEN / 2 + 62], fov: 55 } };
  if (o.event === 'mud') d.zones.push({ name: 'mud', p: [0, 0.3, -ROAD_LEN / 2 + 60], he: [2.6, 0.5, 3.2] });
  return d;
}

export function buildFinish(o: BuildOpts): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('finish', 'finish', o.theme, pal, [50, 50]);
  arena(d, 50, 50, pal);
  d.cols.push(box([-4.5, 3, 6], [0.5, 3, 0.5], 'arch', pal.accent), box([4.5, 3, 6], [0.5, 3, 0.5], 'arch', pal.accent), box([0, 6.3, 6], [5, 0.4, 0.5], 'arch', pal.accent2));
  d.zones.push({ name: 'finish', p: [0, 1.5, 7], he: [4, 1.5, 1] });
  d.water.push({ name: 'bay', p: [0, -0.3, 20], he: [25, 0.3, 5], level: -0.05, depth: 0.6, flow: [0, 0], murk: 0.4, color: pal.water });
  d.wagon = { p: [0, 0, -12], yaw: 0 };
  d.spawns = spawnsAround([0, 0, -6], 8, 2.5, 0);
  d.cams = { CAM_SPECT_WIDE: { p: [0, 6, 22], look: [0, 1.5, 0], fov: 55 }, CAM_SPECT_HERO: { p: [0, 2, 12], look: [0, 1.5, 4], fov: 50 } };
  d.decor = scatter(o.seed ?? 6, 30, 48, 34, (x, z) => Math.abs(x) < 7, decorKinds(o.theme), -5);
  return d;
}

export function buildLevel(kind: string, o: BuildOpts & { event?: string }): LevelDesc {
  switch (kind) {
    case 'store': return buildStore(o);
    case 'river': return buildRiver(o);
    case 'hunt': return buildHunt(o);
    case 'landmark': return buildLandmark(o);
    case 'camp': return buildCamp(o);
    case 'finish': return buildFinish(o);
    default: return buildRoad(o);
  }
}
/** v2: the procedural journey. No level geometry: the terrain streams in as heightfield chunks (procgen.ts); the desc
 *  only carries the wagon, spawns around it and the sky (the client's day / night overrides it). */
export function buildJourney(o: BuildOpts, wagon: SpawnDesc, ground: (x: number, z: number) => number): LevelDesc {
  const pal = palette(o.palette, o.theme);
  const d = base('journey', 'journey', o.theme, pal, [128, 128]);
  d.wagon = wagon;
  const s = Math.sin(wagon.yaw), c = Math.cos(wagon.yaw);
  for (let i = 0; i < 8; i++) {
    const lx = (i % 2 ? 1 : -1) * (2.4 + (i >> 2) * 0.9), lz = 1.6 - (i >> 1 & 1) * 3.2 - (i >> 2) * 0.8;
    const x = wagon.p[0] + c * lx + s * lz, z = wagon.p[2] - s * lx + c * lz;
    d.spawns.push({ p: [x, ground(x, z) + 0.1, z], yaw: wagon.yaw + Math.PI });
  }
  return d;
}

/** Point in a zone (axis-aligned in the zone's frame; yaw optional). */
export function inZone(z: { p: V3; he: V3; yaw?: number }, x: number, y: number, zz: number): boolean {
  let dx = x - z.p[0], dz = zz - z.p[2];
  if (z.yaw) { const c = Math.cos(-z.yaw), s = Math.sin(-z.yaw); [dx, dz] = [dx * c - dz * s, dx * s + dz * c]; }
  return Math.abs(dx) <= z.he[0] && Math.abs(y - z.p[1]) <= z.he[1] && Math.abs(dz) <= z.he[2];
}
