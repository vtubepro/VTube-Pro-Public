// Ship crew: the DECK as plain data (room space = ship frame: the ship never moves in room space, the
// world scrolls past) + navigation: the deck nav graph with link kinds and all-pairs shortest paths, sideways lanes so
// paths don't overlap, the shore planner (visibility graph around the leg feet) for treasure stops, and the geometry
// fit (snapDeck: feet onto the real floor, bodies out of rails and bulwarks) the scene runs against the room's meshes.
//
// Anchor contract (empties in the room GLB, docs/SCENES.md -> "Ship crew"; the walking-ship SPEC 1.3 + Appendix A).
// A room with >= 4 CREW_NAV_ nodes uses its own anchors; with fewer, the built-in preset layout (the SPEC ship's
// own anchors, room frame k = 20) is used and any crew anchor the room does have overrides the built-in one by name.
//   CREW_NAV_xx            nav node (feet); extras links = 'CREW_NAV_03,CREW_NAV_04' with kinds = 'walk,stairs' (or
//                          'CREW_NAV_04:stairs' inline). Kinds: walk | stairs | ladder | door | narrow; made symmetric; a
//                          'walk' link that climbs > 0.5 m counts as stairs
//   CREW_HELM              the helmsman's feet behind HELM_WHEEL, +Z = facing the wheel. A wheel hub higher than the
//                          puppet reaches (0.60 m at crew height 1.25) gets a crate under the Cap'n (deck.helmCrate)
//   HELM_WHEEL             the wheel node: the crew system spins it about its local Z from the voyage's yaw rate
//   TURRET_n               turret yaw node (SPEC; alias via scene.json voyage.turrets[TURRET_n].alias 'GUN_F' or the
//                          node's extras.alias 'GUN_F_YAW'; default TURRET_1 = F, TURRET_2 = A), or GUN_<F|A>_YAW (older
//                          contract). Children GUN_x_SEAT (the gunner's feet, +Z = facing) and GUN_x_BREECH (the loader's
//                          feet at the loading hatch; a breech authored as a hand point > 0.35 m above the seat puts the
//                          loader's feet on the floor 0.35 m behind it) ride it. TURRET_n_MUZZLE / GUN_x_MUZZLE give the
//                          barrel direction (the voyage feed's gunYaw is the BARREL's room yaw)
//   GUN_<F|A>_RACK         the ready-rack (fixed deck). Further than 1.2 m from the breech feet it is pulled in to 1.0 m
//                          (the loader's 4.2 s cycle; noted in deck.notes)
//   CREW_STOKER / CREW_FUEL / CREW_FIREBOX   the stoker's feet (default: beside the firebox, towards the fuel bin)
//   CREW_LOOKOUT           the lookout's perch (wheelhouse roof / bow), +Z = the usual look direction
//   CREW_JUMP_<P|S>_xx     rail points the shore party jumps from (+Z = outboard)
//   CREW_LADDER_<P|S>      deck foot of the rope ladder (+Z = outboard); aliases LADDER_DROP_<S|P>. GANGWAY_<S|P> (or a
//                          lone GANGWAY, side from its x) = the ship's own rope ladder: the crew climbs that one and draws
//                          none. CREW_CATCH_<P|S> = the catcher / hoist point
//   CARGO_HATCH            where hoisted loot is stowed (hidden)
//   CREW_HOME_00..08       per-crew home duty spot (roster order), SWAB_xx, RING_SEAT_xx (sit, +Z = facing), RAIL_xx
//   DAMAGE_nn (+ DAMAGE_nn_REPAIR)   hull hit sites (voyage) and the deck stand a deckhand repairs each from
//   CREW_FOOT_xx / LEG_*_FOOT   the walker's feet on the ground (obstacles while halted; extras r = radius)
//   CREW_KEEPOUT           box (extras size [x, y, z]) the crew never path through (the show floor)
import * as THREE from 'three';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

/** 'step' (fit only): a hop onto / off a platform or a step, from the edge above to the deck below */
export type LinkKind = 'walk' | 'stairs' | 'ladder' | 'door' | 'narrow' | 'step';
export interface Link { to: number; kind: LinkKind; len: number }
/** A deck point. `rail` (geometry fit): the rail's top height and its horizontal distance ahead (+Z) of the point;
 *  `out`: how far the hull bulges out past the rail below it (rope ladders / hoists hang clear of it). */
export interface DeckSpot { name: string; pos: V3; yaw: number; rail?: { y: number; d: number; out: number } }
export interface DeckGun {
  id: string;
  /** turret pivot (deck space, rest) + its rest yaw; the frame `GUN_<id>` = pivot * rotY(yaw(t)) */
  pivot: V3; restYaw: number;
  /** barrel yaw = frame yaw + aimOff (a TURRET_n node's +Z need not run along its barrel) */
  aimOff: number;
  /** seat / breech in the TURRET frame (local to the pivot at rest yaw) */
  seat: DeckSpot; breech: DeckSpot;
  /** the authored breech HAND point (turret frame) when GUN_x_BREECH was a shove point, not the loader's feet */
  hand?: V3;
  /** a loading step (crate) the loader stands on at the breech (turret frame: its base centre, yaw, height) - the
   *  breech of a human-scale gun sits above a 1.25 m puppet's reach (geometry fit) */
  step?: { pos: V3; yaw: number; h: number } | null;
  /** fixed deck point */
  rack: DeckSpot;
  node: THREE.Object3D | null;
}
export interface CrewDeck {
  source: 'anchors' | 'preset';
  nav: V3[]; navNames: string[]; links: Link[][];
  /** all-pairs: dist[i*n+j] (m, kind-weighted), next[i*n+j] = first hop from i towards j (-1 = unreachable) */
  dist: Float64Array; next: Int16Array;
  spots: Map<string, DeckSpot>;
  guns: DeckGun[];
  jumps: { port: DeckSpot[]; starboard: DeckSpot[] };
  ladders: { port: DeckSpot | null; starboard: DeckSpot | null };
  /** the ship's own rope ladders (GANGWAY_*): its hanging point; the crew climbs it and draws no rope of its own */
  gangways: { port: DeckSpot | null; starboard: DeckSpot | null };
  catches: { port: DeckSpot | null; starboard: DeckSpot | null };
  feet: { pos: V3; r: number }[];
  /** more circles on the sand the shore party keeps clear of (deck x / z, radius): the alongside size spots (SPEC C14) */
  /** the room's default dig site (TREASURE_SITE: deck x / z on the starboard side), when it has one */
  digSite?: V3 | null;
  avoid: { pos: V3; r: number }[];
  keepout: THREE.Box3 | null;
  wheel: { pos: V3; node: THREE.Object3D | null } | null;
  /** a crate under the Cap'n when the wheel hub is above his reach (its top = CREW_HELM's feet) */
  helmCrate: { pos: V3; yaw: number; h: number } | null;
  homes: DeckSpot[];
  /** hull hit sites and the deck stand each is repaired from */
  repairs: { site: string; pos: V3; stand: DeckSpot }[];
  /** per nav node, free horizontal distance in 8 directions (k * 45 deg from +Z towards +X) at waist height; null =
   *  unknown (no geometry fit) */
  navClear: Float32Array | null;
  /** nav nodes the fit cut off (no way a body can walk to them, nothing to do there): never chosen as a route end */
  navDead?: Uint8Array | null;
  /** sand height (room y) under the halted, kneeled ship */
  ground: number;
  /** what the anchor parse / geometry fit changed (info().deck.notes) */
  notes: string[];
}

const KIND_COST: Record<LinkKind, number> = { walk: 1, door: 1.2, narrow: 1.3, stairs: 1.6, ladder: 3.5, step: 2.0 };
const KINDS: readonly LinkKind[] = ['walk', 'stairs', 'ladder', 'door', 'narrow'];
/** a level change bigger than this along a walk is a hop (a step, a platform edge), not a slope */
export const STEP_DY = 0.2;
const yawOfVec = (x: number, z: number) => Math.atan2(x, z);
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
const q2 = (x: number) => Math.round(x * 100) / 100;
const rad = (d: number) => (d * Math.PI) / 180;
/** SPEC.md D2 / 1.3: sand at rest y -12.844, the ship kneels 3.0 m at a stop -> the sand sits at -9.844 under the deck. */
export const PRESET_GROUND = -9.844;

// ================================================================================================ anchors (plain data)
/** One anchor in deck space. `turret` = the turret it rides (seat / breech / muzzle). */
export interface Anchor { name: string; pos: V3; yaw: number; extras: Record<string, unknown>; turret?: string; node?: THREE.Object3D | null }
type AnchorMap = Map<string, Anchor>;

// ---------------------------------------------------------------------------------- the preset deck (SPEC ship)
// The SPEC ship's own anchors (the SPEC ship's build/out scene.glb + rig.json, room frame: glTF metres, +Z aft, bow -Z,
// +X starboard, origin = the show-floor planks): well / main deck y -3.72, poop deck -1.23, forecastle -1.66, the
// flying-bridge helm on the wheelhouse roof (y 3.14), beam 8.8 m (hull to |x| 4.4, rail inner face ~4.1).
type P = [number, number, number];
const NAV: [string, P, string][] = [
  ['BOW', [0.0, -1.276, -18.5], 'FWD_P:walk,FWD_S:walk'],
  ['FWD_P', [-2.6, -1.659, -15.0], 'GUNF:stairs,FWELL_P:stairs'],
  ['FWD_S', [2.6, -1.66, -15.0], 'GUNF:stairs,FWELL_S:stairs'],
  ['GUNF', [1.6, -3.717, -12.2], ''],
  ['FWELL_P', [-3.6, -3.609, -9.0], 'MID_P:narrow'],
  ['FWELL_S', [3.6, -3.718, -9.0], 'MID_S:narrow'],
  ['MID_P', [-3.75, -3.721, -3.0], 'MID2_P:narrow'],
  ['MID_S', [3.75, -3.72, -3.0], 'MID2_S:narrow'],
  ['MID2_P', [-3.75, -3.716, 2.0], 'AFT_P:walk'],
  ['MID2_S', [3.75, -3.716, 2.0], 'AFT_S:walk'],
  ['AFT_P', [-3.0, -3.719, 5.5], 'RING:stairs,LADDER_FOOT:stairs'],
  ['AFT_S', [3.0, -3.72, 5.5], 'RING:stairs'],
  ['RING', [0.0, -2.222, 4.9], 'AFT_C:stairs,LADDER_FOOT:walk'],
  ['AFT_C', [0.0, -1.231, 9.6], 'GUNA:walk'],
  ['GUNA', [-1.5, -1.23, 11.6], ''],
  ['LADDER_FOOT', [-1.375, -2.193, 6.1], ''],
];
const SPOTS: [string, P, number, Record<string, unknown>?][] = [
  ['CREW_HELM', [0.0, 3.137, -5.6], 180], ['HELM_WHEEL', [0.0, 4.317, -6.29], 0], ['CREW_LOOKOUT', [0.6, 3.097, -8.9], 180],
  ['CREW_FUEL', [2.6, -3.721, 6.2], -90], ['CREW_FIREBOX', [1.6, -3.721, 4.4], 180], ['CARGO_HATCH', [-1.8, -3.721, 6.6], 0],
  ['CREW_CATCH_P', [-3.85, -3.62, 3.6], -90], ['CREW_CATCH_S', [3.85, -3.718, 3.6], 90],
  ['CREW_LADDER_P', [-3.9, -3.051, 4.6], -90], ['CREW_LADDER_S', [3.9, -3.09, 4.6], 90],
  ['CREW_JUMP_P_01', [-3.9, -3.71, -6.0], -90], ['CREW_JUMP_P_02', [-3.9, -3.711, 0.0], -90], ['CREW_JUMP_P_03', [-3.9, -2.955, 6.0], -90],
  ['CREW_JUMP_S_01', [3.9, -3.717, -6.0], 90], ['CREW_JUMP_S_02', [3.9, -3.708, 0.0], 90], ['CREW_JUMP_S_03', [3.9, -2.983, 6.0], 90],
  ['CREW_HOME_07', [-3.4, -3.721, -4.0], 0], ['CREW_HOME_08', [3.4, -3.721, -1.0], 0],
  ['RING_SEAT_01', [0.0, -1.231, 10.3], 180], ['RING_SEAT_02', [2.425, -3.722, 6.1], -60], ['RING_SEAT_03', [-2.425, -3.719, 6.1], 60],
  ['SWAB_01', [-3.4, -3.721, -4.0], 0], ['SWAB_02', [3.4, -3.721, -1.0], 0], ['SWAB_03', [-3.4, -3.719, 2.5], 0], ['SWAB_04', [0.5, -1.336, -15.5], 0],
  ['GUN_F_RACK', [1.7, -1.693, -13.0], 180], ['GUN_A_RACK', [-1.6, -1.872, 12.4], 0],
  // hull hit sites (rig.json damage; local +Z = the hull normal)
  ['DAMAGE_01', [-3.809, -5.015, -12.009], -90], ['DAMAGE_02', [4.083, -5.013, -10.003], 90], ['DAMAGE_03', [-3.551, -5.63, 8.006], -90],
  ['DAMAGE_04', [3.083, -5.64, 9.512], 90], ['DAMAGE_05', [-2.497, -2.498, -2.001], -90], ['DAMAGE_06', [4.33, -2.585, 5.022], 90],
  ['DAMAGE_07', [-3.629, -1.003, -15.025], -90], ['DAMAGE_08', [2.965, -1.486, 11.512], 90],
];
// turrets: pivot (rest yaw 0: the node's +Z runs aft), the barrel's muzzle, and the crew points that ride them
const TURRETS: { name: string; pivot: P; muzzle: P; seat: [P, number]; breech: [P, number] }[] = [
  { name: 'TURRET_1', pivot: [0.0, -1.29, -16.6], muzzle: [0.006, 0.53, -19.164], seat: [[-0.906, -1.29, -14.803], 180], breech: [[-0.004, 0.204, -15.72], 180] },
  { name: 'TURRET_2', pivot: [0.0, -1.23, 10.62], muzzle: [0.002, 0.124, 15.752], seat: [[0.899, -1.23, 8.819], 0], breech: [[-0.001, -0.348, 8.58], 0] },
];
// the six feet (rig.json soles) on the sand: they stay planted while the ship kneels, so x / z are the rest stance
const FEET: [number, number][] = [[-6.872, -14.562], [-8.962, -3.15], [-7.06, 7.436], [6.872, -14.562], [8.962, -3.15], [7.06, 7.436]];
// the canopy show set: deck bounds + wings + the hatch stage (SPEC Appendix A areas.deck.bounds)
const KEEPOUT: [P, P] = [[-4.3, -0.4, -4.2], [4.3, 3.95, 7.3]];

function presetAnchors(): AnchorMap {
  const m: AnchorMap = new Map();
  const put = (name: string, p: P, yawDeg: number, extras: Record<string, unknown> = {}, turret?: string) => m.set(name, { name, pos: V(...p), yaw: rad(yawDeg), extras, ...(turret ? { turret } : {}) });
  for (const [n, p, links] of NAV) put(`CREW_NAV_${n}`, p, 0, links ? { links: links.split(',').map((l) => `CREW_NAV_${l}`).join(',') } : {});
  for (const [n, p, y, x] of SPOTS) put(n, p, y, x ?? {});
  TURRETS.forEach((t, k) => {
    const id = k === 0 ? 'F' : 'A';
    put(t.name, t.pivot, 0, { alias: `GUN_${id}_YAW` });
    put(`${t.name}_MUZZLE`, t.muzzle, 0, {}, t.name);
    put(`GUN_${id}_SEAT`, t.seat[0], t.seat[1], {}, t.name);
    put(`GUN_${id}_BREECH`, t.breech[0], t.breech[1], {}, t.name);
  });
  FEET.forEach(([x, z], k) => put(`CREW_FOOT_${String(k + 1).padStart(2, '0')}`, [x, 0, z], 0, { r: 2.0 }));
  const c = KEEPOUT[0].map((v, i) => (v + KEEPOUT[1][i]) / 2) as P, s = KEEPOUT[1].map((v, i) => v - KEEPOUT[0][i]);
  put('CREW_KEEPOUT', c, 0, { size: s });
  return m;
}

const ANCHOR_RE = /^(CREW_|GUN_[A-Z]_|TURRET_\d+(_MUZZLE)?$|HELM_WHEEL$|CARGO_HATCH$|SWAB_|RING_SEAT_|RAIL_|LEG_.*_FOOT$|DAMAGE_\d+(_REPAIR)?$|GANGWAY(_[PS])?$|LADDER_DROP_[PS]$|TREASURE_SITE$)/;

/** Read every crew anchor of a room (positions / yaws in `space`, i.e. deck space). */
export function roomAnchors(root: THREE.Object3D, space: THREE.Object3D): AnchorMap {
  root.updateMatrixWorld(true);
  const inv = new THREE.Matrix4().copy(space.matrixWorld).invert();
  const sq = space.getWorldQuaternion(new THREE.Quaternion()).invert();
  const q = new THREE.Quaternion();
  const out: AnchorMap = new Map();
  root.traverse((o) => {
    if (!ANCHOR_RE.test(o.name) || out.has(o.name)) return;
    if (o.name.startsWith('vtp:')) return;
    const f = V(0, 0, 1).applyQuaternion(sq.clone().multiply(o.getWorldQuaternion(q)));
    let turret: string | undefined;
    for (let p = o.parent; p; p = p.parent) if (/^(TURRET_\d+|GUN_[A-Z]_YAW)$/.test(p.name)) { turret = p.name; break; }
    out.set(o.name, { name: o.name, pos: o.getWorldPosition(V()).applyMatrix4(inv), yaw: yawOfVec(f.x, f.z), extras: (o.userData ?? {}) as Record<string, unknown>, ...(turret ? { turret } : {}), node: o });
  });
  return out;
}

// ================================================================================================ build
function finish(deck: Omit<CrewDeck, 'dist' | 'next'>): CrewDeck {
  const n = deck.nav.length;
  const dist = new Float64Array(n * n).fill(Infinity);
  const next = new Int16Array(n * n).fill(-1);
  for (let i = 0; i < n; i++) {
    dist[i * n + i] = 0; next[i * n + i] = i;
    for (const l of deck.links[i]) { const c = l.len * KIND_COST[l.kind]; if (c < dist[i * n + l.to]) { dist[i * n + l.to] = c; next[i * n + l.to] = l.to; } }
  }
  for (let k = 0; k < n; k++) for (let i = 0; i < n; i++) {
    const dik = dist[i * n + k];
    if (dik === Infinity) continue;
    for (let j = 0; j < n; j++) {
      const d = dik + dist[k * n + j];
      if (d < dist[i * n + j] - 1e-9) { dist[i * n + j] = d; next[i * n + j] = next[i * n + k]; }
    }
  }
  return { ...deck, dist, next };
}

function link(links: Link[][], nav: V3[], i: number, j: number, kind: LinkKind) {
  if (i === j || links[i].some((l) => l.to === j)) return;
  const len = nav[i].distanceTo(nav[j]);
  // (a 'walk' that climbs half a metre or more is a stair: slower, never a straight skate up a wall)
  const k: LinkKind = kind === 'walk' && Math.abs(nav[i].y - nav[j].y) > 0.5 ? 'stairs' : kind;
  links[i].push({ to: j, kind: k, len }); links[j].push({ to: i, kind: k, len });
}

/** The built-in preset deck (the SPEC ship's own anchors). */
export function presetDeck(ground = PRESET_GROUND): CrewDeck & { ground: number } {
  const d = buildDeck(presetAnchors(), 'preset', ground, {});
  return d as CrewDeck & { ground: number };
}

/** A turret-frame spot -> deck space at turret (frame) yaw `yaw`. */
export function gunSpotDeck(g: DeckGun, s: DeckSpot, yaw: number): DeckSpot {
  const c = Math.cos(yaw), si = Math.sin(yaw);
  const x = s.pos.x * c + s.pos.z * si, z = -s.pos.x * si + s.pos.z * c;
  return { name: s.name, pos: V(g.pivot.x + x, g.pivot.y + s.pos.y, g.pivot.z + z), yaw: s.yaw + yaw };
}
/** Deck space -> a turret-frame point at frame yaw `yaw`. */
function deckToGun(g: { pivot: V3 }, p: V3, yaw: number): V3 {
  const dx = p.x - g.pivot.x, dz = p.z - g.pivot.z, c = Math.cos(-yaw), s = Math.sin(-yaw);
  return V(dx * c + dz * s, p.y - g.pivot.y, -dx * s + dz * c);
}

export interface DeckOpts {
  /** scene.json voyage.turrets: { TURRET_1: { alias: 'GUN_F' } } */
  turrets?: Record<string, { alias?: string }>;
  /** crew height (m, default 1.25): the helm crate is sized to the puppet's reach */
  height?: number;
}

/** Room anchors -> the deck. layout 'preset' = the built-in deck only; 'anchors' = the room's (null without >= 2 nav
 *  nodes); 'auto' = the room's when it has >= 4 CREW_NAV_ nodes, else the built-in one with the room's other crew
 *  anchors laid over it by name. */
export function deckFromRoom(root: THREE.Object3D, space: THREE.Object3D, layout: 'auto' | 'anchors' | 'preset' = 'auto', ground = PRESET_GROUND, opts: DeckOpts = {}): CrewDeck | null {
  if (layout === 'preset') return buildDeck(presetAnchors(), 'preset', ground, opts);
  const room = roomAnchors(root, space);
  const nNav = [...room.keys()].filter((n) => n.startsWith('CREW_NAV_')).length;
  if (layout === 'anchors' && nNav < 2) return null;
  if (nNav >= 4 || layout === 'anchors') return buildDeck(room, 'anchors', ground, opts);
  // too few nav nodes: the built-in deck (its nav graph), the room's other anchors (turrets, spots, ladders ...) over
  // it by name
  const merged = presetAnchors();
  const roomHasTurret = [...room.keys()].some((n) => /^(TURRET_\d+|GUN_[A-Z]_YAW)$/.test(n));
  if (roomHasTurret) for (const k of [...merged.keys()]) if (/^(TURRET_\d+|GUN_[A-Z]_(SEAT|BREECH|MUZZLE))/.test(k)) merged.delete(k);
  for (const [k, a] of room) if (!k.startsWith('CREW_NAV_')) merged.set(k, a);
  return buildDeck(merged, 'preset', ground, opts);
}

function buildDeck(A: AnchorMap, source: 'anchors' | 'preset', ground: number, opts: DeckOpts): CrewDeck {
  const notes: string[] = [];
  const get = (n: string) => A.get(n) ?? null;
  const spotOf = (a: Anchor, name = a.name): DeckSpot => ({ name, pos: a.pos.clone(), yaw: a.yaw });
  // ---- nav
  const navE = [...A.values()].filter((a) => a.name.startsWith('CREW_NAV_')).sort((a, b) => a.name.localeCompare(b.name));
  const navNames = navE.map((a) => a.name);
  const nav = navE.map((a) => a.pos.clone());
  const links: Link[][] = nav.map(() => []);
  navE.forEach((a, i) => {
    const l = a.extras.links;
    if (typeof l !== 'string') return;
    const kinds = typeof a.extras.kinds === 'string' ? a.extras.kinds.split(',').map((s) => s.trim()) : [];
    l.split(',').map((s) => s.trim()).filter(Boolean).forEach((part, k) => {
      const [nm, inl] = part.split(':');
      const j = navNames.indexOf(nm.trim());
      const kind = KINDS.find((x) => x === (inl ?? kinds[k] ?? '').trim()) ?? 'walk';
      if (j >= 0) link(links, nav, i, j, kind);
    });
  });
  if (!nav.length) { nav.push(V(0, 0, 0)); navNames.push('CREW_NAV_ORIGIN'); links.push([]); notes.push('no nav nodes'); }
  // ---- plain spots
  const spots = new Map<string, DeckSpot>();
  for (const a of A.values()) if (!/^CREW_NAV_|^GUN_|^TURRET_|^DAMAGE_|^CREW_FOOT_|^LEG_|^CREW_KEEPOUT$|^LADDER_DROP_|^TREASURE_SITE$/.test(a.name)) spots.set(a.name, spotOf(a));
  // ---- turrets -> guns
  const guns: DeckGun[] = [];
  const turretNodes = [...A.values()].filter((a) => /^(TURRET_\d+|GUN_[A-Z]_YAW)$/.test(a.name));
  const idOf = (a: Anchor): string | null => {
    const m = /^GUN_([A-Z])_YAW$/.exec(a.name);
    if (m) return m[1];
    const al = opts.turrets?.[a.name]?.alias ?? a.extras.alias;
    const ma = typeof al === 'string' ? /^GUN_([A-Z])(_YAW)?$/.exec(al) : null;
    if (ma) return ma[1];
    const n = +(/^TURRET_(\d+)$/.exec(a.name)?.[1] ?? 0);
    return n === 1 ? 'F' : n === 2 ? 'A' : n > 2 ? String.fromCharCode(64 + n) : null;
  };
  const seen = new Set<string>();
  for (const t of turretNodes.sort((a, b) => (a.name.startsWith('GUN_') ? -1 : 1) - (b.name.startsWith('GUN_') ? -1 : 1) || a.name.localeCompare(b.name))) {
    const id = idOf(t);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const pivot = t.pos.clone(), restYaw = t.yaw;
    const g0 = { pivot };
    const local = (a: Anchor | null, fb: DeckSpot): DeckSpot => a ? { name: a.name, pos: deckToGun(g0, a.pos, restYaw), yaw: wrap(a.yaw - restYaw) } : fb;
    // the barrel: a muzzle child, else the node's own +Z when it is a GUN_x_YAW (old contract), else away from midships
    const mz = get(`${t.name}_MUZZLE`) ?? get(`GUN_${id}_MUZZLE`);
    let aimOff = 0;
    if (mz && Math.hypot(mz.pos.x - pivot.x, mz.pos.z - pivot.z) > 0.3) aimOff = wrap(yawOfVec(mz.pos.x - pivot.x, mz.pos.z - pivot.z) - restYaw);
    else if (!t.name.startsWith('GUN_')) aimOff = wrap((pivot.z < 0 ? Math.PI : 0) - restYaw);
    const seat = local(get(`GUN_${id}_SEAT`), { name: `GUN_${id}_SEAT`, pos: V(0.95, 0, -0.1), yaw: 0 });
    let breech = local(get(`GUN_${id}_BREECH`), { name: `GUN_${id}_BREECH`, pos: V(0, 0, -1.25), yaw: 0 });
    let hand: V3 | undefined;
    if (breech.pos.y - seat.pos.y > 0.35) {
      // a hand point (the shove point at the breech): the loader's feet go on the floor 0.35 m behind it (the geometry
      // fit then finds the real stand within reach of the hand point)
      hand = breech.pos.clone();
      const f = V(Math.sin(breech.yaw), 0, Math.cos(breech.yaw));
      breech = { name: breech.name, pos: V(breech.pos.x - f.x * 0.35, seat.pos.y, breech.pos.z - f.z * 0.35), yaw: breech.yaw };
      notes.push(`GUN_${id}_BREECH is a hand point: loader feet on the floor below it`);
    }
    const g: DeckGun = { id, pivot, restYaw, aimOff, seat, breech, ...(hand ? { hand } : {}), rack: { name: `GUN_${id}_RACK`, pos: pivot.clone().add(V(1.0, 0, 1.0)), yaw: 0 }, node: t.node ?? null };
    // ready rack: authored, within the loader's reach of the breech (4.2 s cycle)
    const bd = gunSpotDeck(g, breech, restYaw).pos;
    const ra = get(`GUN_${id}_RACK`);
    if (ra) {
      const d = Math.hypot(ra.pos.x - bd.x, ra.pos.z - bd.z);
      if (d > 1.2) {
        const k = 1.0 / d;
        const p = V(bd.x + (ra.pos.x - bd.x) * k, bd.y, bd.z + (ra.pos.z - bd.z) * k);
        g.rack = { name: g.rack.name, pos: p, yaw: yawOfVec(ra.pos.x - p.x, ra.pos.z - p.z) };
        notes.push(`GUN_${id}_RACK ${d.toFixed(1)} m from the breech: shells taken 1.0 m from it`);
      } else g.rack = spotOf(ra);
    } else g.rack = { name: g.rack.name, pos: V(bd.x + Math.sign(seat.pos.x || 1) * 0.9, bd.y, bd.z), yaw: 0 };
    guns.push(g);
  }
  for (const g of guns) { spots.set(g.rack.name, g.rack); spots.set(`GUN_${g.id}_SEAT`, gunSpotDeck(g, g.seat, g.restYaw)); }
  // chore spots inside a turret's sweep (a seat on its slew ring): the turret turns through them, nobody sits there
  for (const [k, sp] of [...spots]) {
    if (!/^(RING_SEAT_|SWAB_|RAIL_)/.test(k)) continue;
    const g = guns.find((x) => Math.hypot(sp.pos.x - x.pivot.x, sp.pos.z - x.pivot.z) < 1.0 && Math.abs(sp.pos.y - x.pivot.y) < 1.0);
    if (g) { spots.delete(k); notes.push(`${k} is inside GUN_${g.id}'s turret sweep: not used`); }
  }
  // ---- stoker: beside the firebox, towards the fuel bin, facing the firebox
  if (!spots.has('CREW_STOKER')) {
    const fb = spots.get('CREW_FIREBOX'), fu = spots.get('CREW_FUEL');
    if (fb) {
      const d = fu ? V(fu.pos.x - fb.pos.x, 0, fu.pos.z - fb.pos.z) : V(Math.sin(fb.yaw), 0, Math.cos(fb.yaw));
      if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
      d.normalize();
      const p = fb.pos.clone().addScaledVector(d, 0.6);
      spots.set('CREW_STOKER', { name: 'CREW_STOKER', pos: p, yaw: yawOfVec(fb.pos.x - p.x, fb.pos.z - p.z) });
    }
  }
  // ---- over the side
  const sideSpots = (pre: string) => [...A.values()].filter((a) => a.name.startsWith(pre)).sort((a, b) => a.name.localeCompare(b.name)).map((a) => spotOf(a));
  const jumps = { port: sideSpots('CREW_JUMP_P'), starboard: sideSpots('CREW_JUMP_S') };
  const ladderAt = (s: 'P' | 'S') => { const a = get(`CREW_LADDER_${s}`) ?? get(`LADDER_DROP_${s}`); return a ? spotOf(a, `CREW_LADDER_${s}`) : null; };
  const ladders = { port: ladderAt('P'), starboard: ladderAt('S') };
  const gang = { port: null as DeckSpot | null, starboard: null as DeckSpot | null };
  for (const a of A.values()) {
    const m = /^GANGWAY(?:_([PS]))?$/.exec(a.name);
    if (!m) continue;
    const side = m[1] ? (m[1] === 'P' ? 'port' : 'starboard') : (a.pos.x < 0 ? 'port' : 'starboard');
    gang[side] ??= spotOf(a);
  }
  // a gangway without a deck foot: the foot is 0.55 m inboard of it
  for (const side of ['port', 'starboard'] as const) {
    const gw = gang[side];
    if (gw && !ladders[side]) {
      const f = V(Math.sin(gw.yaw), 0, Math.cos(gw.yaw));
      ladders[side] = { name: side === 'port' ? 'CREW_LADDER_P' : 'CREW_LADDER_S', pos: gw.pos.clone().addScaledVector(f, -0.55), yaw: gw.yaw };
    }
  }
  const catches = { port: get('CREW_CATCH_P') ? spotOf(get('CREW_CATCH_P')!) : null, starboard: get('CREW_CATCH_S') ? spotOf(get('CREW_CATCH_S')!) : null };
  // rails (cruise loops lean on them): authored RAIL_xx, else jump points
  const rails = ['RAIL_01', 'RAIL_02', 'RAIL_03', 'RAIL_04'];
  const railFb = [jumps.port[0], jumps.starboard[1] ?? jumps.starboard[0], jumps.starboard[0], jumps.port[jumps.port.length - 1]];
  rails.forEach((r, k) => { if (!spots.has(r) && railFb[k]) spots.set(r, { ...railFb[k], name: r, pos: railFb[k].pos.clone() }); });
  // ---- feet, keep-out, wheel
  const feetA = [...A.values()].filter((a) => /^CREW_FOOT_/.test(a.name));
  const legs = [...A.values()].filter((a) => /^LEG_.*_FOOT$/.test(a.name));
  const feet = (feetA.length ? feetA : legs.length ? legs : [...presetAnchors().values()].filter((a) => /^CREW_FOOT_/.test(a.name)))
    .map((a) => ({ pos: V(q2(a.pos.x), ground, q2(a.pos.z)), r: typeof a.extras.r === 'number' ? (a.extras.r as number) : 2.0 }));
  const ko = get('CREW_KEEPOUT');
  let keepout: THREE.Box3 | null = null;
  if (ko) {
    const s = Array.isArray(ko.extras.size) ? (ko.extras.size as number[]) : [5, 3, 8];
    keepout = new THREE.Box3(ko.pos.clone().sub(V(s[0] / 2, s[1] / 2, s[2] / 2)), ko.pos.clone().add(V(s[0] / 2, s[1] / 2, s[2] / 2)));
  }
  const wa = get('HELM_WHEEL');
  const wheel = wa ? { pos: wa.pos.clone(), node: wa.node ?? null } : null;
  // ---- the helm: the Cap'n stands 0.26 m behind the hub, 0.60 m under it (puppet reach at 1.25 m); a crate makes up
  // the difference to the authored floor
  let helmCrate: CrewDeck['helmCrate'] = null;
  const helm = spots.get('CREW_HELM');
  if (helm && wheel) {
    const k = (opts.height ?? 1.25) / 1.25;
    const f = V(Math.sin(helm.yaw), 0, Math.cos(helm.yaw));
    const hubDy = wheel.pos.y - helm.pos.y;
    const want = 0.6 * k;
    if (hubDy > want + 0.08 && hubDy < 3) {
      const h = q2(hubDy - want);
      const p = V(wheel.pos.x - f.x * 0.26 * k, helm.pos.y, wheel.pos.z - f.z * 0.26 * k);
      helmCrate = { pos: V(q2(p.x), helm.pos.y, q2(p.z)), yaw: helm.yaw, h };
      spots.set('CREW_HELM', { name: 'CREW_HELM', pos: V(q2(p.x), helm.pos.y + h, q2(p.z)), yaw: helm.yaw });
      notes.push(`wheel hub ${hubDy.toFixed(2)} m above CREW_HELM: the Cap'n stands on a ${h.toFixed(2)} m crate`);
    }
  }
  // ---- homes (roster order)
  const HOMES = ['CREW_HELM', 'GUN_F_SEAT', 'GUN_F_RACK', 'GUN_A_SEAT', 'GUN_A_RACK', 'CREW_STOKER', 'CREW_LOOKOUT', 'CREW_HOME_07', 'CREW_HOME_08'];
  const fb0: DeckSpot = { name: 'HOME', pos: nav[0].clone(), yaw: 0 };
  const homes = HOMES.map((h, i) => {
    const own = get(`CREW_HOME_${String(i).padStart(2, '0')}`);
    if (own && (i >= 7 || !spots.has(h))) return spotOf(own);
    return spots.get(h) ?? (own ? spotOf(own) : null) ?? spots.get(`SWAB_0${(i % 4) + 1}`) ?? fb0;
  });
  // ---- hull hit sites + their repair stands (authored, else fitted: snapDeck refines them against the geometry)
  const repairs: CrewDeck['repairs'] = [];
  const ts = get('TREASURE_SITE');
  const tmp = finish({ source, nav, navNames, links, spots, guns, jumps, ladders, gangways: gang, catches, feet, avoid: [], digSite: ts ? ts.pos.clone() : null, keepout, wheel, helmCrate, homes, repairs: [], navClear: null, ground, notes });
  for (const a of A.values()) {
    const m = /^DAMAGE_(\d+)$/.exec(a.name);
    if (!m) continue;
    const st = get(`${a.name}_REPAIR`);
    repairs.push({ site: a.name, pos: a.pos.clone(), stand: st ? spotOf(st) : standFor(tmp, a.pos) });
  }
  repairs.sort((a, b) => a.site.localeCompare(b.site));
  tmp.repairs = repairs;
  return tmp;
}

// ================================================================================================ queries
export function nearestNav(deck: CrewDeck, p: V3, maxDy = 1.2): number {
  let best = 0, bd = Infinity;
  const dead = deck.navDead;
  deck.nav.forEach((q, i) => {
    if (dead?.[i]) return;
    const dy = Math.abs(q.y - p.y);
    const d = Math.hypot(q.x - p.x, q.z - p.z) + (dy > maxDy ? 50 + dy * 10 : dy * 2);
    if (d < bd) { bd = d; best = i; }
  });
  return best;
}

export function navDist(deck: CrewDeck, a: V3, b: V3): number {
  const n = deck.nav.length;
  const i = nearestNav(deck, a), j = nearestNav(deck, b);
  const d = deck.dist[i * n + j];
  return (Number.isFinite(d) ? d : 999) + a.distanceTo(deck.nav[i]) + b.distanceTo(deck.nav[j]);
}

/** Free distance from nav node i towards horizontal direction (dx, dz) (Infinity = unknown / open): the smaller of
 *  the two measured directions either side of it (conservative). */
export function navFree(deck: CrewDeck, i: number, dx: number, dz: number): number {
  if (!deck.navClear) return Infinity;
  const a = Math.atan2(dx, dz) / (Math.PI / 4);
  const k0 = ((Math.floor(a) % 8) + 8) % 8, k1 = (k0 + 1) % 8;
  return Math.min(deck.navClear[i * 8 + k0], deck.navClear[i * 8 + k1]);
}

/** The walkable point of the nav graph nearest `p`: the closest point on a walk / door / narrow EDGE (or a lone node)
 *  whose deck is between `yLo` and `yHi` (a hull hit is worked from the deck above it, not from a deck below), weighted
 *  so a deck level near the hit wins. `node` = the nearer end node (its clearances). */
export function edgePoint(deck: CrewDeck, p: V3, yLo = -Infinity, yHi = Infinity): { pos: V3; node: number } {
  let best = deck.nav[0].clone(), bn = 0, bd = Infinity;
  const score = (c: V3) => Math.hypot(c.x - p.x, c.z - p.z) + Math.max(0, Math.abs(c.y - p.y) - 1.2) * 1.5;
  const ok = (y: number) => y >= yLo - 1e-6 && y <= yHi + 1e-6;
  deck.nav.forEach((a, i) => {
    if (deck.navDead?.[i]) return;
    if (ok(a.y)) { const d = score(a); if (d < bd) { bd = d; best = a.clone(); bn = i; } }
    for (const l of deck.links[i]) {
      if (l.to < i || l.kind === 'stairs' || l.kind === 'ladder') continue;
      const b = deck.nav[l.to];
      if (!ok(a.y) || !ok(b.y)) continue;
      const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
      const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / L2)) : 0;
      const c = a.clone().lerp(b, t);
      const d = score(c);
      if (d < bd - 1e-9) { bd = d; best = c; bn = t < 0.5 ? i : l.to; }
    }
  });
  return { pos: best, node: bn };
}

/** Where to stand to fix a hull hit: the walkway point nearest it (on the nav graph's edges, on the deck above it),
 *  stepped towards it while the walkway allows, facing it (a hit on the hull below is worked leaning over the rail). */
export function standFor(deck: CrewDeck, hit: V3): DeckSpot {
  let e = edgePoint(deck, hit, hit.y - 1.5, hit.y + 3.5);
  if (!Number.isFinite(e.pos.x)) e = edgePoint(deck, hit);
  const best = e.pos;
  const to = V(hit.x - best.x, 0, hit.z - best.z);
  const L = to.length();
  // (stay on the walkway: up to 0.4 m towards the hit, never closer than 0.3 m to the rail / bulwark; without a
  // geometry fit only 0.15 m: nav nodes run down the walkway's middle)
  const free = L > 1e-3 ? navFree(deck, e.node, to.x, to.z) : Infinity;
  const lim = Number.isFinite(free) ? Math.max(0, free - 0.3) : deck.navClear ? 0.4 : 0.15;
  const step = Math.min(Math.max(0, L - 0.55), 0.4, lim);
  const pos = L > 1e-3 ? best.clone().addScaledVector(to.normalize(), step) : best.clone();
  return { name: 'WORK', pos: V(q2(pos.x), q2(best.y), q2(pos.z)), yaw: L > 1e-3 ? Math.atan2(hit.x - pos.x, hit.z - pos.z) : 0 };
}

export interface RoutePt { p: V3; kind: LinkKind }

/** p -> nearest node -> ... -> nearest node -> q, with each hop's link kind (the kind of the hop that ENDS at that point).
 *  `lane` (m, + = right of travel) offsets walk hops sideways so crew paths don't overlap. */
export function route(deck: CrewDeck, p: V3, q: V3, lane = 0): RoutePt[] {
  const n = deck.nav.length;
  const a = nearestNav(deck, p), b = nearestNav(deck, q);
  const ids: number[] = [a];
  let cur = a, guard = 0;
  while (cur !== b && guard++ < 128) { const nx = deck.next[cur * n + b]; if (nx < 0) break; ids.push(nx); cur = nx; }
  const kindTo = (i: number, j: number): LinkKind => deck.links[i].find((l) => l.to === j)?.kind ?? 'walk';
  const pts: RoutePt[] = ids.map((id, k) => ({ p: deck.nav[id].clone(), kind: k === 0 ? 'walk' : kindTo(ids[k - 1], id) }));
  // skip a first / last node that doubles back
  if (pts.length > 1 && p.distanceTo(pts[1].p) < pts[0].p.distanceTo(pts[1].p) && pts[1].kind === 'walk') pts.shift();
  if (pts.length > 1 && q.distanceTo(pts[pts.length - 2].p) < pts[pts.length - 1].p.distanceTo(pts[pts.length - 2].p) && pts[pts.length - 1].kind === 'walk') pts.pop();
  pts.push({ p: q.clone(), kind: 'walk' as LinkKind });
  if (lane) {
    for (let i = 1; i < pts.length - 1; i++) {
      if (pts[i].kind !== 'walk' || (pts[i + 1] && pts[i + 1].kind !== 'walk')) continue;
      const prev = i > 0 ? pts[i - 1].p : p, nxt = pts[i + 1].p;
      const d = V(nxt.x - prev.x, 0, nxt.z - prev.z);
      if (d.lengthSq() < 1e-6) continue;
      d.normalize();
      // (a fitted deck: never offset a node into the rail)
      let off = lane;
      if (deck.navClear) {
        const ni = deck.nav.findIndex((v) => Math.abs(v.x - pts[i].p.x) < 1e-6 && Math.abs(v.z - pts[i].p.z) < 1e-6);
        if (ni >= 0) { const fr = navFree(deck, ni, -d.z * Math.sign(lane), d.x * Math.sign(lane)); if (Number.isFinite(fr)) off = Math.sign(lane) * Math.min(Math.abs(lane), Math.max(0, fr - 0.3)); }
      }
      pts[i].p.x += -d.z * off; pts[i].p.z += d.x * off;
    }
  }
  const first: RoutePt = { p: p.clone(), kind: 'walk' };
  return [first, ...pts].filter((r, i, arr) => i === 0 || r.p.distanceTo(arr[i - 1].p) > 0.04);
}

// ================================================================================================ shore (treasure stops)
/** A walk on the sand from `a` to `b` around circular obstacles (the leg feet): a visibility graph over points around
 *  each circle + Dijkstra. Flat (y = a.y); returns [a, ..., b]. */
export function shorePath(a: V3, b: V3, obstacles: { pos: V3; r: number }[], margin = 0.6): V3[] {
  const circ = obstacles.map((o) => ({ x: o.pos.x, z: o.pos.z, r: o.r + margin * 0.5 }));
  const clear = (p: { x: number; z: number }, q: { x: number; z: number }) => {
    for (const c of circ) {
      const dx = q.x - p.x, dz = q.z - p.z, L2 = dx * dx + dz * dz;
      const t = L2 > 1e-9 ? Math.max(0, Math.min(1, ((c.x - p.x) * dx + (c.z - p.z) * dz) / L2)) : 0;
      const ex2 = p.x + dx * t - c.x, ez = p.z + dz * t - c.z;
      if (ex2 * ex2 + ez * ez < c.r * c.r - 1e-6) return false;
    }
    return true;
  };
  if (clear(a, b)) return [a.clone(), b.clone()];
  const pts: { x: number; z: number }[] = [{ x: a.x, z: a.z }, { x: b.x, z: b.z }];
  for (const o of obstacles) for (let k = 0; k < 10; k++) {
    const ang = (k / 10) * Math.PI * 2, R = (o.r + margin) / Math.cos(Math.PI / 10);
    pts.push({ x: o.pos.x + Math.sin(ang) * R, z: o.pos.z + Math.cos(ang) * R });
  }
  const n = pts.length;
  const d = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  d[0] = 0;
  for (let it = 0; it < n; it++) {
    let u = -1, bd = Infinity;
    for (let i = 0; i < n; i++) if (!done[i] && d[i] < bd) { bd = d[i]; u = i; }
    if (u < 0 || u === 1) break;
    done[u] = 1;
    for (let v = 0; v < n; v++) {
      if (done[v]) continue;
      const w = Math.hypot(pts[v].x - pts[u].x, pts[v].z - pts[u].z);
      if (d[u] + w < d[v] && clear(pts[u], pts[v])) { d[v] = d[u] + w; prev[v] = u; }
    }
  }
  if (!Number.isFinite(d[1])) return [a.clone(), b.clone()];
  const out: V3[] = [];
  for (let v = 1; v >= 0; v = prev[v]) { out.push(V(pts[v].x, a.y, pts[v].z)); if (v === 0) break; }
  out.reverse();
  out[0] = a.clone(); out[out.length - 1] = b.clone();
  return out;
}

// ================================================================================================ geometry fit
/** What the deck fit asks of the room's meshes (the scene implements it with BVH rays; tests with boxes). */
export interface DeckProbe {
  /** Heights (room y, highest first) of walkable (near-horizontal) surfaces under (x, z) between yTop and yBot. */
  floors(x: number, z: number, yTop: number, yBot: number): number[];
  /** Horizontal free distance from p along unit (dx, 0, dz), up to `far` (Infinity = nothing that close). */
  free(p: V3, dx: number, dz: number, far: number): number;
}
/** scene.json `bounds` [minx, miny, minz, maxx, maxy, maxz] -> the show-set keep-out box (null when malformed). */
export function boundsBox(b: unknown): THREE.Box3 | null {
  if (!Array.isArray(b) || b.length !== 6 || !b.every((v) => typeof v === 'number' && Number.isFinite(v))) return null;
  const box = new THREE.Box3(V(b[0], b[1], b[2]), V(b[3], b[4], b[5]));
  return box.isEmpty() ? null : box;
}

/** The floor a foot planned at (x, y, z) stands on: the walkable surface nearest y within +-tol (else y). */
export function floorUnder(probe: DeckProbe, x: number, z: number, y: number, tol = 0.22): number {
  let best = y, bd = Infinity;
  for (const q of probe.floors(x, z, y + tol, y - tol)) { const d = Math.abs(q - y); if (d < bd) { bd = d; best = q; } }
  return best;
}
export interface SnapReport { points: number; moved: number; lifted: number; dropped: number; noFloor: string[]; maxDy: number; maxPush: number; searched: number; reach: string[] }

const DIRS8 = Array.from({ length: 8 }, (_, k) => [Math.sin((k * Math.PI) / 4), Math.cos((k * Math.PI) / 4)] as const);
const DIRS12 = Array.from({ length: 12 }, (_, k) => [Math.sin((k * Math.PI) / 6), Math.cos((k * Math.PI) / 6)] as const);
const DIRS16 = Array.from({ length: 16 }, (_, k) => [Math.sin((k * Math.PI) / 8), Math.cos((k * Math.PI) / 8)] as const);
/** Fit the deck to the room's geometry (pure given the probe; every page gets the same numbers, 1 cm grid):
 *   - every foot point (nav nodes, spots, homes, gun seats, jumps, ladders, catches, repair stands) stands on the
 *     walkable surface NEAREST its authored height within [y - 0.9, y + 0.6], on a patch wide enough for a body (not a
 *     rail cap, a gun barrel or a stair nosing) and clear of walls by the body radius `r` (8 rays at shin and waist
 *     height); a point with no such floor (authored past the hull edge, on a rail, over a stairwell, in a gangway gap)
 *     moves to the nearest place that has one (towards its nav node, then rings around it, <= 1.5 m);
 *   - rail points (jumps, ladders, catches, RAIL_xx) stand on the walkway inside the rail and learn the rail's top
 *     height and distance and how far the hull bulges out below it;
 *   - a loader's breech HAND point gets the floor stand within reach of it (a loading step when it is above a 1.25 m
 *     puppet's reach: deck.guns[].step);
 *   - hull hit sites without an authored DAMAGE_nn_REPAIR get a stand at the rail on the deck above them;
 *   - nav nodes learn their free distance in 8 directions (work stands / lanes never step into the rail). */
export function snapDeck(deck: CrewDeck, probe: DeckProbe, r = 0.22): { deck: CrewDeck; report: SnapReport } {
  const g = snapDeckSteps(deck, probe, r);
  for (;;) { const v = g.next(); if (v.done) return v.value; }
}
/** snapDeck in small steps (a yield every few rays' worth of work): crewScene runs it a few ms per frame, so fitting a
 *  big ship never stalls the show. Same result as snapDeck. */
export function* snapDeckSteps(deck: CrewDeck, probe: DeckProbe, r = 0.22): Generator<string | void, { deck: CrewDeck; report: SnapReport }, void> {
  const rep: SnapReport = { points: 0, moved: 0, lifted: 0, dropped: 0, noFloor: [], maxDy: 0, maxPush: 0, searched: 0, reach: [] };
  const k = r / 0.22;                          // crew scale (1 = the 1.25 m puppet unit)
  const navOf = (p: V3) => deck.nav[nearestNav(deck, p)];
  /** the floor nearest y0 within [y0 - below, y0 + above] (ties: the lower one) */
  const floorNear = (x: number, z: number, y0: number, below = 0.9, above = 0.6): number | null => {
    const f = probe.floors(x, z, y0 + above, y0 - below);
    let best: number | null = null;
    for (const y of f) if (best === null || Math.abs(y - y0) < Math.abs(best - y0) - 1e-6) best = y;
    return best;
  };
  /** a patch wide enough to stand on: the same floor (+-0.1) 0.6 r out in 4 directions */
  const flat = (x: number, z: number, y: number) => {
    const d = r * 0.6;
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (!probe.floors(x + dx * d, z + dz * d, y + 0.1, y - 0.1).length) return false;
    return true;
  };
  const minFree = (p: V3) => {
    let m = Infinity;
    for (const h of [0.25, 0.7]) for (const [dx, dz] of DIRS8) m = Math.min(m, probe.free(V(p.x, p.y + h * k, p.z), dx, dz, r + 0.02));
    return m;
  };
  const clear = (p: V3) => {
    // (early out: most rejected places hit a wall on the first rays)
    for (const h of [0.25, 0.7]) for (const [dx, dz] of DIRS8) if (probe.free(V(p.x, p.y + h * k, p.z), dx, dz, r + 0.02) < r - 0.01) return false;
    return true;
  };
  /** head room: no walkable top (a platform, a table, a hatch cover) within the body's height above the feet - the
   *  deck under a gun platform is not somewhere to stand */
  const roomy = (x: number, z: number, y: number) => !probe.floors(x, z, y + 1.05 * k, y + 0.08).length;
  /** push a standing point out of walls on its own level; null = squeezed (no room for a body here) */
  const push = (p0: V3): V3 | null => {
    const p = p0.clone();
    for (let it = 0; it < 6; it++) {
      let mx = 0, mz = 0, blocked = 0;
      for (const h of [0.25, 0.7]) for (const [dx, dz] of DIRS8) {
        const f = probe.free(V(p.x, p.y + h * k, p.z), dx, dz, r + 0.05);
        if (f < r - 0.005) { mx -= dx * (r - f); mz -= dz * (r - f); blocked++; }
      }
      if (!blocked) return p;
      const ml = Math.hypot(mx, mz);
      if (ml < 0.01) return null;                       // walls on both sides
      const cap = Math.min(ml, r) / ml;
      p.x += mx * cap; p.z += mz * cap;
      const y = floorNear(p.x, p.z, p.y, 0.15, 0.15);  // (same level: never climbs onto what it was pushed from)
      if (y === null || !flat(p.x, p.z, y)) return null;
      p.y = y;
    }
    return clear(p) ? p : null;
  };
  /** standing point at (x, z) near height y0, or null */
  const standAt = (x: number, z: number, y0: number, below = 0.9, above = 0.6): V3 | null => {
    const y = floorNear(x, z, y0, below, above);
    if (y === null || !flat(x, z, y) || !roomy(x, z, y)) return null;
    const p = V(x, y, z);
    return clear(p) ? p : push(p);
  };
  /** nearest standing point to p0 (towards `toward`, then rings out to 1.5 m) */
  const search = (p0: V3, y0: number, toward: V3 | null): V3 | null => {
    rep.searched++;
    const cand: { x: number; z: number; d: number }[] = [];
    if (toward) {
      const dx = toward.x - p0.x, dz = toward.z - p0.z, L = Math.hypot(dx, dz);
      if (L > 0.05) for (let s = 0.05; s <= Math.min(L, 2.5) + 1e-6; s += 0.05) cand.push({ x: p0.x + (dx / L) * s, z: p0.z + (dz / L) * s, d: s - 1e-3 });
    }
    for (let rr = 0.1; rr <= 1.5 + 1e-6; rr += 0.1) for (const [dx, dz] of DIRS12) cand.push({ x: p0.x + dx * rr, z: p0.z + dz * rr, d: rr });
    // (one floor ray each, then the full test in order of distance + height change: a step onto a gun platform or a
    // hatch cover loses to the deck a little further away)
    const sc: { x: number; z: number; s: number }[] = [];
    cand.forEach((c) => { const y = floorNear(c.x, c.z, y0); if (y !== null) sc.push({ x: c.x, z: c.z, s: c.d + 1.5 * Math.abs(y - y0) }); });
    sc.sort((a, b) => a.s - b.s);
    for (const c of sc) { const p = standAt(c.x, c.z, y0); if (p) return p; }
    return null;
  };
  const done = (name: string, p0: V3, p: V3 | null): V3 => {
    rep.points++;
    if (!p) { rep.noFloor.push(name); return V(q2(p0.x), q2(p0.y), q2(p0.z)); }
    const o = V(q2(p.x), q2(p.y), q2(p.z));
    const dy = o.y - p0.y, dh = Math.hypot(o.x - p0.x, o.z - p0.z);
    if (Math.abs(dy) > 0.02 || dh > 0.02) rep.moved++;
    if (dy > 0.02) rep.lifted++;
    if (dy < -0.02) rep.dropped++;
    rep.maxDy = Math.max(rep.maxDy, Math.abs(dy)); rep.maxPush = Math.max(rep.maxPush, dh);
    return o;
  };
  /** a foot point: its own spot when it stands, else the nearest that does (y0 = the height to stay near) */
  const fit = (name: string, p0: V3, y0 = p0.y, toward: V3 | null = null): V3 => done(name, p0, standAt(p0.x, p0.z, y0) ?? search(p0, y0, toward));
  const railOf = (s: DeckSpot): DeckSpot['rail'] => {
    const fx = Math.sin(s.yaw), fz = Math.cos(s.yaw);
    let d = probe.free(V(s.pos.x, s.pos.y + 0.5 * k, s.pos.z), fx, fz, 1.5);
    if (!Number.isFinite(d)) d = probe.free(V(s.pos.x, s.pos.y + 0.25 * k, s.pos.z), fx, fz, 1.5);
    if (!Number.isFinite(d)) return undefined;
    const top = probe.floors(s.pos.x + fx * (d + 0.06), s.pos.z + fz * (d + 0.06), s.pos.y + 1.5, s.pos.y + 0.3);
    const capT = top.filter((t) => t <= s.pos.y + 1.3 * k);
    const ry = capT.length ? capT[0] : top.length ? top[top.length - 1] : s.pos.y + 0.95;
    // the hull below the rail: how far out does it reach (rope ladders / hoists hang clear of it; only the hull side
    // near the deck: the legs further down are not the hull)
    let out = 0.15;
    for (let h = -0.5; h >= -3.0; h -= 0.5) {
      const o = V(s.pos.x + fx * 4, s.pos.y + h, s.pos.z + fz * 4);
      const back = probe.free(o, -fx, -fz, 4);
      if (Number.isFinite(back)) out = Math.max(out, 4 - back - d);
    }
    return { y: q2(ry), d: q2(d), out: q2(Math.min(3, out + 0.2)) };
  };
  const nearNav = (p: V3) => { const q = navOf(p); return Math.hypot(q.x - p.x, q.z - p.z) > 0.05 ? q : null; };
  /** a plain spot (its own height, towards its nav node) */
  const spot = (s: DeckSpot): DeckSpot => ({ name: s.name, pos: fit(s.name, s.pos, s.pos.y, nearNav(s.pos)), yaw: s.yaw });
  /** a rail point: on the walkway inside the rail (its authored height, else its nav node's deck), facing out */
  const railSpot = (s: DeckSpot): DeckSpot => {
    const nv = navOf(s.pos);
    let p = standAt(s.pos.x, s.pos.z, s.pos.y);
    let o: DeckSpot | null = p ? { name: s.name, pos: p, yaw: s.yaw } : null;
    let rl = o ? railOf(o) : undefined;
    if (!o || !rl || p!.y > nv.y + 0.3) {
      // on a rail cap / bulwark top / in a gap: the deck below it, inside the rail
      p = search(s.pos, Math.abs(s.pos.y - nv.y) > 0.3 ? nv.y : s.pos.y, nearNav(s.pos));
      o = p ? { name: s.name, pos: p, yaw: s.yaw } : null;
      rl = o ? railOf(o) : undefined;
    }
    const pos = done(s.name, s.pos, o ? o.pos : null);
    const out: DeckSpot = { name: s.name, pos, yaw: s.yaw };
    const r2 = rl ?? railOf(out);
    if (r2) out.rail = r2;
    return out;
  };

  yield 'nodes';
  const nav: V3[] = [];
  for (let i = 0; i < deck.nav.length; i++) { nav.push(fit(deck.navNames[i], deck.nav[i])); yield; }
  const navNames = deck.navNames.slice();
  let links = deck.links.map((ls, i) => ls.map((l) => ({ ...l, len: nav[i].distanceTo(nav[l.to]) })));
  // ---- edges: a walkway edge (level, or a gentle sheer <= 0.6 m) that runs through something (a bollard, a post, a gun
  // platform, the hull) gets detour nodes beside the obstruction; one with no way round is noted
  const blockedAt = (a: V3, b: V3): V3 | null => {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    if (L < 0.5 || Math.abs(a.y - b.y) > 0.6) return null;
    const bad: number[] = [];
    for (let t = 0.25; t <= L - 0.25 + 1e-6; t += 0.1) {
      const u = t / L, x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y0 = a.y + (b.y - a.y) * u;
      const y = floorNear(x, z, y0, 0.2, 0.2);
      if (y === null || minFree(V(x, y, z)) < r - 0.03) bad.push(t);
    }
    if (!bad.length) return null;
    const t = (bad[0] + bad[bad.length - 1]) / 2, u = t / L;
    return V(a.x + (b.x - a.x) * u, a.y + (b.y - a.y) * u, a.z + (b.z - a.z) * u);
  };
  /** detour points a -> [..] -> b round the obstruction at m (one point, else two) */
  function* detour(a: V3, b: V3, m: V3, depth = 0): Generator<string | void, V3[] | null, void> {
    const dx = b.x - a.x, dz = b.z - a.z, L = Math.hypot(dx, dz);
    const px = -dz / L, pz = dx / L;
    let half: { p: V3; bad: 'a' | 'b' } | null = null;
    for (let o = 0.1; o <= 1.5 + 1e-6; o += 0.05) for (const sg of [1, -1]) {
      yield;
      const p = standAt(m.x + px * o * sg, m.z + pz * o * sg, m.y, 0.2, 0.2);
      if (!p) continue;
      const q = V(q2(p.x), q2(p.y), q2(p.z));
      const ba = blockedAt(a, q), bb = blockedAt(q, b);
      if (!ba && !bb) return [q];
      if (!half && depth === 0 && (!ba || !bb)) half = { p: q, bad: ba ? 'a' : 'b' };
    }
    if (half) {
      const h = half.p;
      const sub = half.bad === 'a' ? yield* detour(a, h, blockedAt(a, h)!, 1) : yield* detour(h, b, blockedAt(h, b)!, 1);
      if (sub) return half.bad === 'a' ? [...sub, h] : [h, ...sub];
    }
    return null;
  }
  const addNode = (p: V3, name: string) => { nav.push(p.clone()); navNames.push(name); links.push([]); return nav.length - 1; };
  const addLink = (a: number, b: number, kind: LinkKind) => {
    if (a === b || links[a].some((l) => l.to === b)) return;
    const len = nav[a].distanceTo(nav[b]);
    links[a].push({ to: b, kind, len }); links[b].push({ to: a, kind, len });
  };
  // ---- a walk the geometry allows from a to b when no straight / one-detour way exists: A* over a 0.15 m grid of
  // standing places (clear of walls, head room) in a corridor round a -> b, moving on a level (slopes <= 0.12 m per
  // cell) or hopping a step (<= 0.95 m: a puppet scrambles up a bottom step a human would climb), then pulled tight into waypoints (step pairs kept). Lazy: only the cells
  // the search reaches are probed.
  const G = 0.2;
  /** body clear of walls by the body radius at shin, waist and shoulder height - except a step's face (a floor <= 0.95 m
   *  up just behind what the ray hit: the next tread, the top of a scramble), which stairs always have that close */
  const stairClear = (x: number, z: number, y: number) => {
    for (const h of [0.25, 0.7, 1.0]) for (const [dx, dz] of DIRS8) {
      const f = probe.free(V(x, y + h * k, z), dx, dz, r + 0.02);
      if (f >= r - 0.01) continue;
      if (!probe.floors(x + dx * (f + 0.04), z + dz * (f + 0.04), y + 0.95, y + 0.04).length) return false;
    }
    return true;
  };
  // (per cell: every floor in the column once, each floor's standing test once - whatever window a search asks for)
  const cellFloors = new Map<string, number[]>();
  const cellOk = new Map<string, boolean>();
  const gridFloors = (ix: number, iz: number, yLo: number, yHi: number): number[] => {
    const key = `${ix},${iz}`;
    const x = ix * G, z = iz * G;
    let col = cellFloors.get(key);
    if (!col) { col = probe.floors(x, z, 60, -60); cellFloors.set(key, col); }
    const out: number[] = [];
    for (const y of col) {
      if (y < yLo || y > yHi) continue;
      const k2 = `${key},${y.toFixed(3)}`;
      let ok = cellOk.get(k2);
      if (ok === undefined) { ok = roomy(x, z, y) && stairClear(x, z, y); cellOk.set(k2, ok); }
      if (ok) out.push(y);
    }
    return out;
  };
  function* gridPath(a: V3, b: V3): Generator<string | void, { p: V3; kind: LinkKind }[] | null, void> {
    const yLo = Math.min(a.y, b.y) - 1.0, yHi = Math.max(a.y, b.y) + 1.0;
    const pad = 4.0;
    const bx0 = Math.floor((Math.min(a.x, b.x) - pad) / G), bx1 = Math.ceil((Math.max(a.x, b.x) + pad) / G);
    const bz0 = Math.floor((Math.min(a.z, b.z) - pad) / G), bz1 = Math.ceil((Math.max(a.z, b.z) + pad) / G);
    const near = (ix: number, iz: number, y0: number) => {
      let best: number | null = null;
      for (const y of gridFloors(ix, iz, yLo, yHi)) if (Math.abs(y - y0) <= 0.15 && (best === null || Math.abs(y - y0) < Math.abs(best - y0))) best = y;
      return best;
    };
    const sx = Math.round(a.x / G), sz = Math.round(a.z / G), gx = Math.round(b.x / G), gz = Math.round(b.z / G);
    const sy = near(sx, sz, a.y), gy = near(gx, gz, b.y);
    if (sy === null || gy === null) return null;
    type N = { ix: number; iz: number; y: number; g: number; f: number; prev: string | null; step: boolean };
    const kOf = (ix: number, iz: number, y: number) => `${ix},${iz},${Math.round(y * 20)}`;
    const open = new Map<string, N>(), closed = new Map<string, N>();
    const h = (ix: number, iz: number, y: number) => Math.hypot((ix - gx) * G, (iz - gz) * G) + Math.abs(y - gy);
    const s0: N = { ix: sx, iz: sz, y: sy, g: 0, f: h(sx, sz, sy), prev: null, step: false };
    open.set(kOf(sx, sz, sy), s0);
    let goal: N | null = null;
    for (let it = 0; it < 8000 && open.size; it++) {
      if (it % 4 === 3) yield;
      let cur: N | null = null, ck = '';
      for (const [kk, n] of open) if (!cur || n.f < cur.f - 1e-9 || (Math.abs(n.f - cur.f) <= 1e-9 && kk < ck)) { cur = n; ck = kk; }
      open.delete(ck); closed.set(ck, cur!);
      const c = cur!;
      if (Math.abs(c.ix - gx) <= 1 && Math.abs(c.iz - gz) <= 1 && Math.abs(c.y - gy) <= 0.15) { goal = c; break; }
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
        if (!dx && !dz) continue;
        const far = Math.abs(dx) === 2 || Math.abs(dz) === 2;
        const nx = c.ix + dx, nz = c.iz + dz;
        if (nx < bx0 || nx > bx1 || nz < bz0 || nz > bz1) continue;
        const dl = Math.hypot(dx, dz) * G;
        for (const y of gridFloors(nx, nz, yLo, yHi)) {
          const dy = Math.abs(y - c.y);
          const step = dy > 0.12;
          if (dy > 0.95 || (far && !step)) continue;            // (two cells: only a hop over a rim)
          const nk = kOf(nx, nz, y);
          if (closed.has(nk)) continue;
          const g = c.g + dl + (step ? 1.0 + dy : dy);
          const o = open.get(nk);
          if (!o || g < o.g - 1e-9) open.set(nk, { ix: nx, iz: nz, y, g, f: g + h(nx, nz, y), prev: ck, step });
        }
      }
    }
    if ((globalThis as { __gridLog?: unknown[] }).__gridLog) (globalThis as unknown as { __gridLog: unknown[] }).__gridLog.push([a.toArray().map(q2), b.toArray().map(q2), !!goal, closed.size, cellFloors.size]);
    if (!goal) return null;
    const cells: { p: V3; step: boolean }[] = [];
    for (let n: N | undefined = goal; n; n = n.prev ? closed.get(n.prev) : undefined) cells.push({ p: V(q2(n.ix * G), q2(n.y), q2(n.iz * G)), step: n.step });
    cells.reverse();
    cells[0].p = a.clone(); cells.push({ p: b.clone(), step: Math.abs(b.y - cells[cells.length - 1].p.y) > 0.12 });
    // pull tight: keep steps (the cell before + the cell after) and the fewest level waypoints with clear straight hops
    const out: { p: V3; kind: LinkKind }[] = [{ p: cells[0].p, kind: 'walk' }];
    let i = 0, nb = 0;
    while (i < cells.length - 1) {
      if (cells[i + 1].step) { out.push({ p: cells[i + 1].p, kind: 'step' }); i++; continue; }
      let j = i + 1;
      // (a yield every few clearance tests: a long walk's pull-tight was one ~60 ms step in the browser)
      while (j + 1 < cells.length && !cells[j + 1].step) { if (++nb % 3 === 0) yield; if (blockedAt(cells[i].p, cells[j + 1].p)) break; j++; }
      out.push({ p: cells[j].p, kind: 'walk' });
      i = j;
    }
    return out;
  }
  /** splice a grid walk into the nav graph from node ia (or a new node at point `from`) to node ib; false = none */
  function* gridLink(ia: number | V3, ib: number, name: string, base: LinkKind): Generator<string | void, boolean, void> {
    const path = yield* gridPath(typeof ia === 'number' ? nav[ia] : ia, nav[ib]);
    if (!path) return false;
    let prev = typeof ia === 'number' ? ia : addNode(ia, `${name}`);
    path.slice(1, -1).forEach((q, j) => { const id = addNode(q.p, `${name}#${j + 1}`); addLink(prev, id, q.kind === 'step' ? 'step' : base); prev = id; });
    addLink(prev, ib, path[path.length - 1].kind === 'step' ? 'step' : base);
    return true;
  }
  /** a straight stairs climb a -> b that leaves the floor (> 0.35 m off it) or runs through something */
  function* stairsBad(a: V3, b: V3): Generator<string | void, boolean, void> {
    const L = Math.hypot(b.x - a.x, b.z - a.z);
    for (let t = 0.2, n = 0; t <= L - 0.2 + 1e-6; t += 0.2) {
      if (++n % 6 === 0) yield;
      const u = t / L, x = a.x + (b.x - a.x) * u, z = a.z + (b.z - a.z) * u, y0 = a.y + (b.y - a.y) * u;
      const y = floorNear(x, z, y0, 0.35, 0.35);
      if (y === null || minFree(V(x, y, z)) < r - 0.05) return true;
    }
    return false;
  }
  yield 'edges';
  const blockedNote: string[] = [];
  /** links the geometry has no way for (stairs drawn where there are none, a walk through a wall): dropped when the
   *  graph stays connected without them, kept (and noted) where they are the only way */
  const fict: [number, number, LinkKind][] = [];
  const nNav0 = nav.length;
  for (let i = 0; i < nNav0; i++) for (const l of [...links[i]]) {
    yield;
    if (l.to < i || l.kind === 'ladder') continue;
    const a = nav[i], b = nav[l.to];
    // (a 'stairs' link the fit left on one level is a walk: the ship's own anchors can say stairs where there are none)
    if (l.kind === 'stairs') {
      if (Math.abs(a.y - b.y) > STEP_DY) {
        // real stairs: the straight climb must stay within a tread of the floor all the way; else walk the grid
        if (!(yield* stairsBad(a, b))) continue;
        links[i] = links[i].filter((x) => x.to !== l.to); links[l.to] = links[l.to].filter((x) => x.to !== i);
        if (!(yield* gridLink(i, l.to, `${navNames[i]}~${navNames[l.to].replace(/^CREW_NAV_/, '')}`, 'stairs'))) fict.push([i, l.to, 'stairs']);
        continue;
      }
      links[i].find((x) => x.to === l.to)!.kind = 'walk'; links[l.to].find((x) => x.to === i)!.kind = 'walk';
    }
    const kind = l.kind === 'stairs' ? 'walk' : l.kind;
    const m = blockedAt(a, b);
    if (!m) continue;
    const d = yield* detour(a, b, m);
    links[i] = links[i].filter((x) => x.to !== l.to); links[l.to] = links[l.to].filter((x) => x.to !== i);
    if (!d) {
      // no simple way round: walk the grid (round a gun platform, up / down a step the anchors drew as a slope)
      if (!(yield* gridLink(i, l.to, `${navNames[i]}~${navNames[l.to].replace(/^CREW_NAV_/, '')}`, kind))) fict.push([i, l.to, kind]);
      continue;
    }
    let prev = i;
    d.forEach((q, j) => { const id = addNode(q, `${navNames[i]}~${navNames[l.to].replace(/^CREW_NAV_/, '')}${j ? j + 1 : ''}`); addLink(prev, id, kind); prev = id; });
    addLink(prev, l.to, kind);
  }
  yield 'islands';
  // connectivity: islands the dropped links left are joined to the main deck by a grid walk where one exists
  const comps = () => {
    const c = new Int32Array(nav.length).fill(-1);
    let nc = 0;
    for (let s0 = 0; s0 < nav.length; s0++) {
      if (c[s0] >= 0) continue;
      const st = [s0]; c[s0] = nc;
      while (st.length) { const u = st.pop()!; for (const l of links[u]) if (c[l.to] < 0) { c[l.to] = nc; st.push(l.to); } }
      nc++;
    }
    return { c, nc };
  };
  for (let pass = 0; pass < 4; pass++) {
    const { c, nc } = comps();
    if (nc <= 1) break;
    const size = new Array(nc).fill(0);
    for (let i = 0; i < nav.length; i++) size[c[i]]++;
    const main = size.indexOf(Math.max(...size));
    let joined = false;
    for (let ci = 0; ci < nc && !joined; ci++) {
      if (ci === main) continue;
      const pairs: [number, number, number][] = [];
      for (let u = 0; u < nav.length; u++) if (c[u] === ci) for (let v = 0; v < nav.length; v++) if (c[v] === main && Math.abs(nav[u].y - nav[v].y) <= 3.0 && nav[u].distanceTo(nav[v]) <= 9) pairs.push([u, v, nav[u].distanceTo(nav[v])]);
      pairs.sort((a, b) => a[2] - b[2] || a[0] - b[0] || a[1] - b[1]);
      for (const [u, v] of pairs.slice(0, 4)) if (yield* gridLink(u, v, `${navNames[u]}~${navNames[v].replace(/^CREW_NAV_/, '')}`, 'walk')) { joined = true; break; }
    }
    if (!joined) break;
  }
  yield 'welds';
  // ---- weld: nodes near each other on one level with a clear straight way between them (two grid walks ending side by
  // side at the foot of the same stairs) are linked
  const hops2 = (a: number, b: number) => links[a].some((l) => l.to === b || links[l.to].some((m) => m.to === b));
  let welds = 0;
  for (let a = 0; a < nav.length; a++) for (let b = a + 1; b < nav.length; b++) {
    if (b === a + 1) yield;
    const A = nav[a], B = nav[b];
    if (Math.abs(A.y - B.y) > 0.12 || Math.hypot(A.x - B.x, A.z - B.z) > 2.0 || hops2(a, b)) continue;
    if (blockedAt(A, B) || (Math.hypot(A.x - B.x, A.z - B.z) < 0.5 && minFree(V((A.x + B.x) / 2, (A.y + B.y) / 2, (A.z + B.z) / 2)) < r - 0.03)) continue;
    addLink(a, b, 'walk'); welds++;
  }
  yield 'shortcuts';
  // ---- shortcuts: two places on one level the graph only joins the long way round (port to starboard over the bow)
  // get a grid walk between them when the geometry has a much shorter one (the well deck across, round a hatch)
  const graphDist = (from: number) => {
    const d = new Float64Array(nav.length).fill(Infinity), done = new Uint8Array(nav.length);
    d[from] = 0;
    for (let it = 0; it < nav.length; it++) {
      let u = -1, bd = Infinity;
      for (let i = 0; i < nav.length; i++) if (!done[i] && d[i] < bd) { bd = d[i]; u = i; }
      if (u < 0) break;
      done[u] = 1;
      for (const l of links[u]) if (d[u] + l.len < d[l.to]) d[l.to] = d[u] + l.len;
    }
    return d;
  };
  let shortcuts = 0;
  for (let round = 0; round < 3; round++) {
    let best: [number, number, number] | null = null;
    for (let a = 0; a < nNav0; a++) {
      const gd = graphDist(a);
      for (let b = a + 1; b < nNav0; b++) {
        const A = nav[a], B = nav[b], st = Math.hypot(A.x - B.x, A.z - B.z);
        if (Math.abs(A.y - B.y) > 0.3 || st > 9 || st < 1) continue;
        const gain = gd[b] - st * 1.4;
        if (gd[b] > st * 2.5 && (!best || gain > best[2])) best = [a, b, gain];
      }
    }
    if (!best) break;
    const [a, b] = best;
    yield;
    const path = yield* gridPath(nav[a], nav[b]);
    const pl = path ? path.reduce((acc, q, i) => acc + (i ? q.p.distanceTo(path[i - 1].p) : 0), 0) : Infinity;
    if (!path || pl > graphDist(a)[b] * 0.6) break;
    yield* gridLink(a, b, `${navNames[a]}~${navNames[b].replace(/^CREW_NAV_/, '')}`, 'walk');
    shortcuts++;
  }
  if (welds || shortcuts) deck.notes.push(`nav: ${welds} weld(s), ${shortcuts} shortcut(s)`);
  const nBase = nav.length;
  if (nBase > nNav0) deck.notes.push(`nav: ${nBase - nNav0} detour node(s) round obstructions`);
  const navDeck = { ...deck, nav, navNames, links };
  yield 'spots';
  const spots = new Map<string, DeckSpot>();
  for (const [key, s] of deck.spots) {
    yield;
    if (key === 'HELM_WHEEL' || key === 'CARGO_HATCH' || /^GANGWAY|^CREW_FUEL$|^CREW_FIREBOX$|^GUN_[A-Z]_(SEAT|RACK)$/.test(key)) { spots.set(key, s); continue; }
    if (key === 'CREW_HELM' && deck.helmCrate) { spots.set(key, s); continue; }
    spots.set(key, /^(RAIL_|CREW_JUMP_|CREW_LADDER_|CREW_CATCH_)/.test(key) ? railSpot(s) : spot(s));
  }
  // ---- turrets: the gunner's seat, the loader's stand at the breech (within reach of its hand point), the rack
  yield 'guns';
  const guns: DeckGun[] = [];
  for (const g of deck.guns) {
    yield;
    const seatD = gunSpotDeck(g, g.seat, g.restYaw);
    const s2 = fit(`GUN_${g.id}_SEAT`, seatD.pos, seatD.pos.y, nearNav(seatD.pos));
    let b2: V3, step: DeckGun['step'] = null;
    const handD = g.hand ? gunSpotDeck(g, { name: '', pos: g.hand, yaw: 0 }, g.restYaw).pos : null;
    if (handD) {
      // stands around the hand point; the best is ~0.6 m (puppet scale) under it and <= 0.35 m away, behind the breech
      const back = V(-Math.sin(g.restYaw + g.aimOff), 0, -Math.cos(g.restYaw + g.aimOff));
      let best: { p: V3; s: number; d: number } | null = null;
      for (let rr = 0.2; rr <= 1.4 + 1e-6; rr += 0.1) for (const [dx, dz] of DIRS16) {
        if (dx === DIRS16[0][0] && dz === DIRS16[0][1]) yield;
        const x = handD.x + dx * rr, z = handD.z + dz * rr;
        for (const y of probe.floors(x, z, handD.y - 0.3 * k, handD.y - 2.6 * k)) {
          if (!flat(x, z, y)) continue;
          const p = V(x, y, z);
          if (!clear(p)) continue;
          const up = handD.y - y;
          if (up - 0.6 * k > 0.9) continue;                       // (would need a step taller than 0.9 m)
          if (!roomy(x, z, up > 0.78 * k ? handD.y - 0.6 * k : y)) continue;
          // (and never on the gunner's toes: the two work the gun side by side)
          const s = (up > 0.78 * k ? 0.3 + (up - 0.78 * k) * 0.5 : up < 0.45 * k ? (0.45 * k - up) * 3 : 0) + Math.max(0, rr - 0.35 * k) * 3 + (dx * back.x + dz * back.z < -0.3 ? 0.3 : 0)
            + Math.max(0, 0.7 * k - Math.hypot(x - s2.x, z - s2.z)) * 4;
          if (!best || s < best.s - 1e-9) best = { p, s, d: rr };
        }
      }
      if (best) {
        const up = handD.y - best.p.y;
        b2 = best.p;
        if (up > 0.78 * k) {
          // a loading step: the loader's feet 0.6 m (puppet scale) under the hand point
          const h = q2(up - 0.6 * k);
          step = { pos: deckToGun(g, V(q2(b2.x), q2(b2.y), q2(b2.z)), g.restYaw), yaw: g.breech.yaw, h };
          b2 = b2.clone().setY(b2.y + h);
          deck.notes.push(`GUN_${g.id}: the loader stands on a ${h.toFixed(2)} m step (breech ${up.toFixed(2)} m above the floor)`);
        }
        if (best.d > 0.55 * k) rep.reach.push(`GUN_${g.id}_BREECH ${best.d.toFixed(2)} m from the nearest stand`);
        b2 = done(`GUN_${g.id}_BREECH`, gunSpotDeck(g, g.breech, g.restYaw).pos, b2);
      } else { const bd = gunSpotDeck(g, g.breech, g.restYaw).pos; b2 = fit(`GUN_${g.id}_BREECH`, bd, bd.y, nearNav(bd)); }
    } else { const bd = gunSpotDeck(g, g.breech, g.restYaw).pos; b2 = fit(`GUN_${g.id}_BREECH`, bd, bd.y, nearNav(bd)); }
    const brYaw = handD ? Math.atan2(handD.x - b2.x, handD.z - b2.z) - g.restYaw : g.breech.yaw;
    const out: DeckGun = { ...g, seat: { ...g.seat, pos: deckToGun(g, s2, g.restYaw) }, breech: { ...g.breech, pos: deckToGun(g, b2, g.restYaw), yaw: wrap(brYaw) }, step };
    // the rack: fixed deck, within reach of the breech stand (pulled in to 1.0 m when further)
    const ra = deck.spots.get(g.rack.name) ?? g.rack;
    const bd = gunSpotDeck(out, out.breech, g.restYaw).pos;
    let rp = fit(g.rack.name, ra.pos, ra.pos.y, nearNav(ra.pos));
    const bf = step ? bd.y - step.h : bd.y;          // the floor under the breech stand
    const dr = Math.hypot(rp.x - bd.x, rp.z - bd.z);
    if (dr > 1.25 || Math.abs(rp.y - bf) > 0.3) {
      // shells within reach on the loader's own level (a 4.2 s cycle never climbs on and off a gun platform): the
      // stand 0.6-1.2 m from the breech nearest the authored rack
      let bestR: V3 | null = null, bs = Infinity;
      for (let rr = 0.6; rr <= 1.2 + 1e-6; rr += 0.1) for (const [dx, dz] of DIRS12) {
        const p = standAt(bd.x + dx * rr, bd.z + dz * rr, bf, 0.15, 0.15);
        if (!p) continue;
        const sc = Math.hypot(p.x - rp.x, p.z - rp.z) + Math.max(0, 0.7 * k - Math.hypot(p.x - s2.x, p.z - s2.z)) * 4;
        if (sc < bs - 1e-9) { bs = sc; bestR = p; }
      }
      if (bestR) { rp = V(q2(bestR.x), q2(bestR.y), q2(bestR.z)); deck.notes.push(`GUN_${g.id}_RACK: shells taken on the loader's level, ${Math.hypot(rp.x - bd.x, rp.z - bd.z).toFixed(1)} m from the breech`); }
    }
    out.rack = { name: g.rack.name, pos: rp, yaw: Math.atan2(rp.x - bd.x, rp.z - bd.z) + Math.PI };
    guns.push(out);
  }
  for (const g of guns) { spots.set(g.rack.name, g.rack); spots.set(`GUN_${g.id}_SEAT`, gunSpotDeck(g, g.seat, g.restYaw)); }
  yield 'rails';
  const jumps = { port: deck.jumps.port.map(railSpot), starboard: deck.jumps.starboard.map(railSpot) };
  const ladders = { port: deck.ladders.port ? railSpot(deck.ladders.port) : null, starboard: deck.ladders.starboard ? railSpot(deck.ladders.starboard) : null };
  const catches = { port: deck.catches.port ? railSpot(deck.catches.port) : null, starboard: deck.catches.starboard ? railSpot(deck.catches.starboard) : null };
  // the helm crate stands on the real floor: its height makes up the difference
  let helmCrate = deck.helmCrate;
  if (helmCrate) {
    const y = floorNear(helmCrate.pos.x, helmCrate.pos.z, helmCrate.pos.y);
    const top = (deck.spots.get('CREW_HELM')?.pos.y ?? helmCrate.pos.y + helmCrate.h);
    if (y !== null && top - y > 0.05) helmCrate = { pos: V(helmCrate.pos.x, q2(y), helmCrate.pos.z), yaw: helmCrate.yaw, h: q2(top - y) };
    else if (y === null) rep.noFloor.push('HELM_CRATE');
  }
  // ---- repair stands: authored ones fitted as they are; else the walkway point at the rail on the deck above the site
  yield 'repairs';
  const repairs: CrewDeck['repairs'] = [];
  for (const rp of deck.repairs) {
    yield;
    // (an authored stand off every walkway level - in the hold, under the hull - is no use to a deckhand: noted, and the
    // walkway point above the site is used instead)
    if (/_REPAIR$/.test(rp.stand.name) && !nav.slice(0, nBase).some((q) => Math.abs(q.y - rp.stand.pos.y) < 1.3)) deck.notes.push(`${rp.stand.name} is off the walkways (y ${rp.stand.pos.y.toFixed(2)}): repaired from the deck above`);
    else if (/_REPAIR$/.test(rp.stand.name)) { const st = spot(rp.stand); repairs.push({ site: rp.site, pos: rp.pos, stand: { ...st, yaw: Math.atan2(rp.pos.x - st.pos.x, rp.pos.z - st.pos.z) } }); continue; }
    const e = edgePoint(navDeck as unknown as CrewDeck, rp.pos, rp.pos.y - 1.5, rp.pos.y + 3.5);
    const to = V(rp.pos.x - e.pos.x, 0, rp.pos.z - e.pos.z), L = to.length();
    let best = standAt(e.pos.x, e.pos.z, e.pos.y, 0.3, 0.3) ?? e.pos.clone();
    if (L > 1e-3) {
      to.multiplyScalar(1 / L);
      // walk out towards the site while there is deck and room for a body (up to 1.5 m, never past 0.35 m from it)
      for (let st = 0.05; st <= Math.min(1.5, L - 0.35) + 1e-6; st += 0.05) {
        const y = floorNear(e.pos.x + to.x * st, e.pos.z + to.z * st, e.pos.y, 0.15, 0.15);
        if (y === null || !flat(e.pos.x + to.x * st, e.pos.z + to.z * st, y)) break;
        const p = V(e.pos.x + to.x * st, y, e.pos.z + to.z * st);
        if (!clear(p)) break;
        best = p;
      }
    }
    const pos = done(`${rp.site}_REPAIR`, e.pos, best);
    const far = Math.hypot(rp.pos.x - pos.x, rp.pos.z - pos.z);
    if (far > 2.0) rep.reach.push(`${rp.site} ${far.toFixed(1)} m from the nearest walkway`);
    repairs.push({ site: rp.site, pos: rp.pos, stand: { name: 'WORK', pos, yaw: Math.atan2(rp.pos.x - pos.x, rp.pos.z - pos.z) } });
  }
  const homes = deck.homes.map((h) => spots.get(h.name) ?? (h.name.startsWith('CREW_HOME') || h.name === 'HOME' ? spot(h) : h));
  // ---- access: every spot / post joins the nav graph by a way a body can walk - a node AT the spot, linked to its
  // nearest nav node round anything in the way, with a hop where it sits on a platform / step of its own
  yield 'access';
  const accessed = new Set<string>();
  let nAccess = 0;
  const noAccess: string[] = [];
  function* access(name: string, S: V3): Generator<string | void, void, void> {
    const key = `${S.x.toFixed(2)},${S.y.toFixed(2)},${S.z.toFixed(2)}`;
    if (accessed.has(key)) return;
    accessed.add(key);
    // the base node route() would pick for it (level-aware; detours included, other access nodes not)
    const near: { i: number; d: number }[] = [];
    for (let i = 0; i < nBase; i++) {
      const q = nav[i], dy = Math.abs(q.y - S.y);
      near.push({ i, d: Math.hypot(q.x - S.x, q.z - S.z) + (dy > 1.2 ? 50 + dy * 10 : dy * 2) });
    }
    near.sort((a, b) => a.d - b.d || a.i - b.i);
    const N0 = nav[near[0].i];
    if (Math.abs(N0.y - S.y) > 1.3 || (Math.hypot(N0.x - S.x, N0.z - S.z) < 0.05 && Math.abs(N0.y - S.y) < 0.05)) return;
    for (const { i: ni } of near.slice(0, 3)) {
      const N = nav[ni];
      if (Math.abs(N.y - S.y) > 1.3) break;
      if (Math.abs(S.y - N.y) <= STEP_DY) {
        const m = blockedAt(S, N);
        if (!m) {
          if (ni === near[0].i) return;
          const sId = addNode(S, `${name}@`); addLink(sId, ni, 'walk'); nAccess++;
          return;
        }
        const d = yield* detour(S, N, m);
        if (!d) continue;
        let prev = addNode(S, `${name}@`);
        d.forEach((q, j) => { const id = addNode(q, `${name}@via${j || ''}`); addLink(prev, id, 'walk'); prev = id; });
        addLink(prev, ni, 'walk'); nAccess++;
        return;
      }
      // a level change: the edge of S's level along the way to N (top) and the first footing on N's level (bot)
      const dx = N.x - S.x, dz = N.z - S.z, L = Math.hypot(dx, dz);
      if (L < 0.05) continue;
      let top: V3 | null = null, bot: V3 | null = null;
      for (let t = 0.05, n = 0; t <= L + 1e-6 && !bot; t += 0.05) {
        if (++n % 8 === 0) yield;
        const x = S.x + (dx / L) * t, z = S.z + (dz / L) * t;
        const a = standAt(x, z, S.y, 0.12, 0.12);
        if (a && (!top || Math.hypot(a.x - top.x, a.z - top.z) < 0.08)) { top = a; continue; }
        const b = standAt(x, z, N.y, 0.3, 0.3);
        if (b && Math.abs(b.y - S.y) > STEP_DY) bot = b;
      }
      const tb = top ?? S;
      if (!bot || Math.hypot(bot.x - tb.x, bot.z - tb.z) > 0.8 || Math.abs(bot.y - tb.y) > 1.3) continue;
      const bm = blockedAt(bot, N);
      const bd = bm ? yield* detour(bot, N, bm) : [];
      if (!bd) continue;
      const sId = addNode(S, `${name}@`);
      const tId = tb.distanceTo(S) > 0.05 ? addNode(V(q2(tb.x), q2(tb.y), q2(tb.z)), `${name}@top`) : sId;
      addLink(sId, tId, 'walk');
      let prev = addNode(V(q2(bot.x), q2(bot.y), q2(bot.z)), `${name}@bot`);
      addLink(tId, prev, 'step');
      bd.forEach((q, j) => { const id = addNode(q, `${name}@via${j || ''}`); addLink(prev, id, 'walk'); prev = id; });
      addLink(prev, ni, 'walk'); nAccess++;
      return;
    }
    // no straight / one-detour / one-hop way: walk the grid to the nearest node it reaches
    for (const { i: ni } of near.slice(0, 3)) {
      if (Math.abs(nav[ni].y - S.y) > 1.3) break;
      if (yield* gridLink(S.clone(), ni, `${name}@`, 'walk')) { nAccess++; return; }
    }
    noAccess.push(name);
  }
  const skipAccess = /^(HELM_WHEEL|CARGO_HATCH|CREW_FUEL|CREW_FIREBOX|GANGWAY.*)$/;
  for (const [key, sp] of spots) if (!skipAccess.test(key) && !(key === 'CREW_HELM' && helmCrate)) { yield* access(key, sp.pos); yield; }
  for (const sp of [...jumps.port, ...jumps.starboard, ladders.port, ladders.starboard, catches.port, catches.starboard]) if (sp) { yield* access(sp.name, sp.pos); yield; }
  for (const h of homes) if (!(h.name === 'CREW_HELM' && helmCrate)) { yield* access(h.name, h.pos); yield; }
  for (const rp of repairs) { yield* access(`${rp.site}_REPAIR`, rp.stand.pos); yield; }
  // ---- links the geometry has no way for: dropped where the graph is whole without them; an island cut off by one keeps
  // it (walked as drawn: the ship's own nav says so) when a spot needs it, else the island's nodes are left out
  let navDead: Uint8Array | null = null;
  for (const [a, b, kind] of fict) {
    const { c } = comps();
    if (c[a] === c[b]) { blockedNote.push(`${navNames[a]}-${navNames[b]} (dropped)`); continue; }
    const size = new Map<number, number>();
    for (let i = 0; i < nav.length; i++) size.set(c[i], (size.get(c[i]) ?? 0) + 1);
    const small = (size.get(c[a]) ?? 0) <= (size.get(c[b]) ?? 0) ? c[a] : c[b];
    const hasSpot = navNames.some((nm, i) => c[i] === small && nm.includes('@'));
    if (hasSpot) { addLink(a, b, kind); blockedNote.push(`${navNames[a]}-${navNames[b]} (${kind}, kept: the only way to ${navNames.filter((nm, i) => c[i] === small && /@$/.test(nm)).slice(0, 3).join(' ')})`); continue; }
    navDead ??= new Uint8Array(nav.length);
    for (let i = 0; i < nav.length; i++) if (c[i] === small) navDead[i] = 1;
    blockedNote.push(`${navNames[a]}-${navNames[b]} (dropped: ${navNames.filter((_, i) => c[i] === small).slice(0, 3).join(' ')} left out)`);
  }
  if (blockedNote.length) deck.notes.push(`nav: no clear way along ${blockedNote.join(', ')}`);
  links = links.map((ls) => ls.slice().sort((x, y) => x.to - y.to));
  if (nAccess) deck.notes.push(`nav: ${nAccess} spot(s) joined by a detour / hop`);
  if (noAccess.length) deck.notes.push(`nav: no clear way to ${noAccess.join(', ')}`);
  // nav clearances (8 directions): the wall at waist height or the edge of the node's floor (a platform rim, a stair
  // edge), whichever is nearer - lanes and work stands never step past either
  yield 'clearance';
  const navClear = new Float32Array(nav.length * 8);
  for (let i = 0; i < nav.length; i++) {
    if (i % 8 === 7) yield;
    const p = nav[i];
    DIRS8.forEach(([dx, dz], j) => {
    const f = probe.free(V(p.x, p.y + 0.5 * k, p.z), dx, dz, 3);
    let c = Number.isFinite(f) ? f : 3;
    for (let t = 0.1; t <= Math.min(c, 0.8) + 1e-6; t += 0.1) if (!probe.floors(p.x + dx * t, p.z + dz * t, p.y + 0.12, p.y - 0.12).length) { c = t - 0.1 + r; break; }
    navClear[i * 8 + j] = q2(c);
    });
  }
  const out0 = finish({ ...navDeck, links, spots, guns, jumps, ladders, catches, helmCrate, homes, repairs, navClear, navDead });
  out0.notes = [...deck.notes, `geometry fit: ${rep.moved}/${rep.points} points moved (max dy ${rep.maxDy.toFixed(2)} m, max push ${rep.maxPush.toFixed(2)} m)${rep.noFloor.length ? `, no floor: ${rep.noFloor.slice(0, 6).join(' ')}` : ''}${rep.reach.length ? `; ${rep.reach.join('; ')}` : ''}`];
  return { deck: out0, report: rep };
}

/** On the sand the real ground's offset fades in over this many metres above the flat stop plane (a jump lands on the
 *  dune, a ladder foot meets it, the deck is never touched). */
export const SAND_BAND = 2.5;
/** Within this many metres of the flat stop plane a point moves with the real ground in full (feet, a bottom rung). */
export const SAND_FLAT = 0.5;
/** y on the sand: the planned y (on the flat stop plane `ground`) moved by the real ground's offset there (gy - ground):
 *  in full up to SAND_FLAT m above the plane, faded out from there to SAND_BAND m. A bad or far-off ground (NaN, > 8 m
 *  away) is ignored. (crewScene, with the voyage's feed.groundAt: presentation only.) */
export function sandLift(y: number, ground: number, gy: number): number {
  if (!Number.isFinite(gy) || !Number.isFinite(y)) return y;
  const dy = gy - ground;
  if (Math.abs(dy) > 8) return y;
  const w = Math.min(1, Math.max(0, 1 - (y - ground - SAND_FLAT) / (SAND_BAND - SAND_FLAT)));
  return y + dy * w;
}
