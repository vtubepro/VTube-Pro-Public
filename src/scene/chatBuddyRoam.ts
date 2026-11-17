// Chat buddy ROAM mode (SceneState.chat.buddyMode 'roam', the default): he lives in the room. He ambles between floor
// spots in view of the current shot (now and then hopping up onto a desk / counter / crate), pauses, looks at the
// performers and does little bits (waves at the lens, peers at the host, stretches, sits down for a bit, pretends to
// read his own tablet, trips over nothing and dusts himself off). When a chat message / event arrives he goes to the
// nearest spot where his tablet is READABLE (chatBuddyPlace.ts rules), turns to the lens, holds it up for the display
// time, lowers it and wanders on. While walking the tablet is carried at his side (or like a tray, big tablets).
//
//  1. planRoam — per shot, time-sliced (the caller runs it ≤ 2 ms a frame): the roam SET = up to 14 spots where HE
//     reads well in this shot (whole body in frame, not over anyone's face / the react screen / the chat props, not
//     hidden behind a performer or furniture, not a giant right in front of the lens), which of them also give a
//     readable raised tablet (the full tablet test: chatBuddyPlace cheap + raysOk), and the straight walks between
//     them (room rays at knee + chest height, COLLIDE_* boxes, floor all the way, clear of performers, never in front
//     of a face). Only the largest connected group is kept: every spot reaches every other.
//  2. simulate — DETERMINISTIC timeline = f(set, seed, epoch, message times, wall clock), like the kitchen planner:
//     time is cut into 7.5 s slots from the host's epoch (SceneState.chat.buddyAt); each slot's action comes from
//     rng(seed, slot) — wander, hop onto a perch or stay — then a bit. Windows of 8 slots start at a seeded spot, so
//     a page only simulates from the current window's start: every OBS page (host + guests) and a page opened late
//     show the same walk. Chat events (their ts + 0.6 s, the same on every page) interrupt: hurry to the nearest
//     readable spot, show, lower, go on. No per-frame rays: sampling the timeline is pure arithmetic.
import * as THREE from 'three';
import { rectOverlap } from './chatPlace.ts';
import { _place, type BuddyGeo, type BuddyPlanInput, type TabletPlan } from './chatBuddyPlace.ts';

type V3 = THREE.Vector3;
const UP = new THREE.Vector3(0, 1, 0);
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };

/** Slot length (s) and slots per window. */
export const SLOT = 7.5, WIN = 8;
/** Tablet raise / lower (s), reaction delay after the event's ts (s), display time after the last message (s). */
export const RAISE = 0.35, LOWER = 0.4, REACT = 0.6, HOLD = 7, MIN_SHOW = 4, MAX_SHOW = 30;
const ACC = 0.45, DEC = 0.55;
/** A readable spot's tablet must be this much over the readable minimum (the chat text ≥ 14 px at 1080p, measured on
 *  the real tablet — a spot exactly at the limit reads too small once he really holds it). */
const READ_MARGIN = 1.1;

export type Bit = 'idle' | 'wave' | 'peer' | 'stretch' | 'sit' | 'read' | 'look' | 'hop' | 'dance' | 'trip';
export const BIT_DUR: Record<Bit, number> = { idle: 0, wave: 2.6, peer: 3.2, stretch: 3.2, sit: 6.5, read: 4.4, look: 3.2, hop: 1.7, dance: 3.4, trip: 3.8 };

export interface RoamPoint {
  id: number;
  /** Where he stands (floor, or a furniture top for a perch). */
  pos: V3;
  perch: boolean;
  /** Perch: the floor point beside the furniture he hops up from / down to (his graph node). */
  launch: V3 | null;
  /** Perch whose edge faces the lens (he may sit on it, legs dangling). */
  edge: boolean;
  /** The raised tablet here is readable → a spot where he shows chat. */
  tab: TabletPlan | null;
  /** Hand holding the tablet (away from the host). */
  side: 1 | -1;
  score: number;
  /** Only for showing chat (nearer the lens than he'd idle): he hurries there for a message, then wanders back. */
  showOnly: boolean;
}

export interface RoamSet {
  key: string;
  /** His height (m) while roaming this shot (normal, else 80 % / 64 % when space is tight). */
  height: number;
  pts: RoamPoint[];
  /** Shortest walk (m) between spots and the next spot on that route (Floyd). */
  cost: number[][];
  next: number[][];
  /** No spot gives a readable tablet: messages use this plan (a smaller spot / the foreground peek / overlay). */
  msgPlan: TabletPlan | null;
  /** Straight floor walk a → b is fine (room rays, COLLIDE_*, floor, performers, not in front of a face). */
  clear: (a: V3, b: V3) => boolean;
  /** His body at p is completely outside this shot's frame. */
  offscreen: (p: V3) => boolean;
  /** Screen rules only (a spot he already stands on after a camera cut). */
  screenOk: (p: V3) => boolean;
  camPos: V3;
  /** Camera right on the floor + the frame u of a floor point (edge walk-ins). */
  rgt: V3;
  u: (p: V3) => number;
  stats: { cands: number; checked: number; valid: number; tabs: number; edges: number; k: number };
}

// ---------------------------------------------------------------------------------------------------- rng
export function hash32(...xs: (number | string)[]): number {
  let h = 2166136261 >>> 0;
  for (const x of xs) {
    const s = String(x);
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    h ^= 0x9e3779b9; h = Math.imul(h ^ (h >>> 15), 2246822519) >>> 0;
  }
  return h >>> 0;
}
export function rng(seed: number) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ---------------------------------------------------------------------------------------------------- planner
interface Cand { pos: V3; perch: boolean; source: string; launch: V3 | null; edge: boolean }

const why = (inp: BuddyPlanInput, k: string): null => { if (inp.trace) inp.trace[k] = (inp.trace[k] ?? 0) + 1; return null; };

function segPoint2D(a: V3, b: V3, p: V3) {
  const dx = b.x - a.x, dz = b.z - a.z, L2 = dx * dx + dz * dz;
  const t = L2 > 1e-9 ? clamp01(((p.x - a.x) * dx + (p.z - a.z) * dz) / L2) : 0;
  return Math.hypot(a.x + dx * t - p.x, a.z + dz * t - p.z);
}

/** The roam set for this shot (time-sliced). `range`: 'near' keeps him within ~3 m of the host, 'room' = anywhere in view. */
export function* planRoam(inp: BuddyPlanInput, range: 'near' | 'room', key: string): Generator<void, RoamSet, void> {
  const P = _place;
  const { ctx } = inp;
  const pre = P.prep(inp);
  const cam = pre.cam;
  const fwd = cam.getWorldDirection(V()).setY(0);
  if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, -1);
  fwd.normalize();
  const right = V().crossVectors(fwd, UP).normalize();
  const ht = Math.tan(THREE.MathUtils.degToRad(ctx.pose.fov) / 2) * ctx.aspect;
  const base = cam.position.clone().setY(0);
  const rays = ctx.rays;
  const host = pre.hostIn && ctx.anchor ? ctx.anchor.floor.clone() : null;
  // grid depth: the host's, else (host not in this shot) how far the camera sees along its axis (as planTablet)
  let dA = host ? Math.max(1.2, host.clone().sub(base).dot(fwd)) : 3;
  if (!host) {
    const look = cam.getWorldDirection(V());
    const hit = rays.hit(cam.position, cam.position.clone().addScaledVector(look, 30), 0.05);
    dA = THREE.MathUtils.clamp((hit === Infinity ? 8 : hit) * Math.max(0.2, Math.hypot(look.x, look.z)) * 0.8, 1.5, 9);
  }
  const H0 = inp.height;
  const cands: Cand[] = [];
  for (const a of inp.anchors) cands.push({ pos: a.pos.clone(), perch: a.pos.y > 0.15, source: a.source, launch: null, edge: false });
  for (const dk of [0.34, 0.42, 0.5, 0.6, 0.7, 0.8, 0.9, 1.02, 1.15, 1.3, 1.5]) {
    const d = Math.max(0.9, dA * dk);
    for (let i = 0; i <= 14; i++) {
      const u = 0.05 + (i / 14) * 0.9;
      cands.push({ pos: base.clone().addScaledVector(fwd, d).addScaledVector(right, (2 * u - 1) * d * ht * 0.92), perch: false, source: 'grid', launch: null, edge: false });
    }
  }
  yield;
  // perches: flat furniture tops under eye level across the frame (as planTablet), moved to the edge that faces the
  // lens (he may sit there), with the floor point beside it he hops up from
  const top = Math.min(cam.position.y + 0.25, 2.4);
  let n = 0;
  for (const dk of [0.4, 0.55, 0.7, 0.85, 1.0, 1.2]) {
    const d = Math.max(0.8, dA * dk);
    for (let i = 0; i <= 9; i++) {
      const u = 0.06 + (i / 9) * 0.88;
      const p = base.clone().addScaledVector(fwd, d).addScaledVector(right, (2 * u - 1) * d * ht * 0.9);
      if (++n % 2 === 0) yield;
      const y = P.perchAt(ctx, p.x, p.z, top);
      if (y === null || y > H0 * 1.3) continue;
      const c = perchEdge(inp, p.setY(y), base, H0);
      if (c) cands.push(c);
    }
  }
  yield;
  // his size: normal, else (space is tight) 80 % / 64 %
  const sepMin = 0.5;
  let best: { k: number; geo: BuddyGeo; pts: { c: Cand; score: number; side: 1 | -1 }[] } | null = null;
  let checked = 0;
  // (last pass: an overview / far shot — he may be small in the distance rather than not in the room at all)
  for (const [k, minBh] of [[1, 0.08], [0.8, 0.08], [0.64, 0.08], [1, 0.045]]) {
    if (minBh < 0.08 && best && best.pts.length) break;
    const geo = inp.geoAt(H0 * k);
    const scored: { c: Cand; score: number }[] = [];
    n = 0;
    for (const c of cands) {
      const s = roamCheap(inp, pre, c, geo, range, host, false, minBh);
      if (s !== null) scored.push({ c, score: s });
      if (++n % 12 === 0) yield;
    }
    scored.sort((a, b) => a.score - b.score);
    // spread out: a spot every half metre at least
    const pick: typeof scored = [];
    for (const s of scored) { if (pick.length >= 36) break; if (pick.every((q) => q.c.pos.distanceTo(s.c.pos) >= sepMin)) pick.push(s); }
    const ok: { c: Cand; score: number; side: 1 | -1 }[] = [];
    n = 0;
    for (const s of pick) {
      checked++;
      if (roamRays(inp, pre, s.c, geo, range, host)) ok.push({ ...s, side: P.holdSide(ctx, s.c.pos, cam) });
      if (++n % 2 === 0) yield;
      if (ok.length >= 14) break;
    }
    if (!best || ok.length > best.pts.length) best = { k, geo, pts: ok };
    if (ok.length >= 4) break;
  }
  const geo = best!.geo;
  // which spots give a readable raised tablet (the full test)
  const pts: RoamPoint[] = [];
  n = 0;
  for (const q of best!.pts) {
    let tab: TabletPlan | null = null;
    const cand = { pos: q.c.pos, perch: q.c.perch, source: q.c.source };
    for (const L of geo.lifts) {
      for (const sd of [q.side, -q.side as 1 | -1]) {
        const g = { ...geo, tabUp: L.up };
        const s = P.cheap({ ...inp, cur: null, bad: [] }, pre, cand, g, sd);
        if (!s.ok || s.hf < geo.hfMin * READ_MARGIN) continue;
        if (!P.raysOk(inp, pre, cand, g, sd)) continue;
        tab = { mode: 'world', pos: q.c.pos.clone(), yaw: s.yaw, side: sd, corner: 1, score: s.score + L.cost, hf: s.hf, perch: q.c.perch, source: 'roam', lift: L.up, height: geo.height, cheer: s.cheer, hop: s.hop };
        break;
      }
      if (tab) break;
    }
    pts.push({ id: pts.length, pos: q.c.pos.clone(), perch: q.c.perch, launch: q.c.launch, edge: q.c.edge, tab, side: tab ? tab.side : q.side, score: q.score, showOnly: false });
    yield;
  }
  // too few readable spots among them (the tablet reads too small where he idles): the planner's tablet spots, nearer
  // the lens — he only goes there to show chat (a short hurry), then wanders back
  if (pts.length && pts.filter((p) => p.tab).length < 3) {
    const scored: { c: Cand; g: BuddyGeo; sd: 1 | -1; s: number; hf: number; yaw: number; cheer: number; hop: number }[] = [];
    n = 0;
    // + a few steps from each spot toward the lens (he walks up to the camera to show it)
    const near: Cand[] = [];
    for (const p of pts.slice(0, 8)) {
      if (p.perch) continue;
      const to = cam.position.clone().setY(p.pos.y).sub(p.pos);
      const L = to.length();
      if (L < 0.5) continue;
      to.divideScalar(L);
      for (const st of [0.25, 0.5, 0.75, 1, 1.3, 1.6, 2]) if (st < L - 0.6) near.push({ pos: p.pos.clone().addScaledVector(to, st), perch: false, source: 'grid', launch: null, edge: false });
    }
    for (const c of [...near, ...cands]) {
      if (pts.some((p) => p.pos.distanceTo(c.pos) < 0.4)) continue;
      const cand = { pos: c.pos, perch: c.perch, source: c.source };
      const side0 = P.holdSide(ctx, c.pos, cam);
      let bestS: (typeof scored)[number] | null = null;
      for (const L of geo.lifts) for (const sd of [side0, -side0 as 1 | -1]) {
        const g = { ...geo, tabUp: L.up };
        const s = P.cheap({ ...inp, cur: null, bad: [] }, pre, cand, g, sd);
        if (s.ok && s.hf >= geo.hfMin * READ_MARGIN && (!bestS || s.score + L.cost < bestS.s)) bestS = { c, g, sd, s: s.score + L.cost + (sd === side0 ? 0 : 0.4), hf: s.hf, yaw: s.yaw, cheer: s.cheer, hop: s.hop };
      }
      if (bestS) scored.push(bestS);
      if (++n % 10 === 0) yield;
    }
    scored.sort((a, b) => a.s - b.s);
    let added = 0, tried = 0;
    for (const x of scored) {
      if (added + pts.filter((p) => p.tab).length >= 4 || tried >= 24) break;
      if (pts.some((p) => p.pos.distanceTo(x.c.pos) < 0.4)) continue;
      tried++;
      const cand = { pos: x.c.pos, perch: x.c.perch, source: x.c.source };
      if (P.raysOk(inp, pre, cand, x.g, x.sd)) {
        const tab: TabletPlan = { mode: 'world', pos: x.c.pos.clone(), yaw: x.yaw, side: x.sd, corner: 1, score: x.s, hf: x.hf, perch: x.c.perch, source: 'roam-show', lift: x.g.tabUp, height: geo.height, cheer: x.cheer, hop: x.hop };
        pts.push({ id: pts.length, pos: x.c.pos.clone(), perch: x.c.perch, launch: x.c.launch, edge: x.c.edge, tab, side: x.sd, score: x.s, showOnly: true });
        added++;
      }
      if (tried % 2 === 0) yield;
    }
  }
  // walks between spots (graph nodes: the floor point, or the launch point of a perch)
  const h = geo.height;
  const clear = (a: V3, b: V3): boolean => {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    if (d < 0.03) return true;
    for (const q of ctx.performers) if (segPoint2D(a, b, q.floor) < 0.5 + 0.12 * h) return false;
    for (const y of [0.3, 0.75]) if (!rays.clear(a.clone().setY(a.y + y * h), b.clone().setY(b.y + y * h))) return false;
    const m = Math.max(2, Math.ceil(d / 0.3));
    for (let i = 1; i < m; i++) {
      const p = a.clone().lerp(b, i / m);
      if (rays.insideCollider(p.clone().setY(p.y + 0.2 * h), 0.1) || rays.insideCollider(p.clone().setY(p.y + 0.6 * h), 0.1)) return false;
      {
        // not in front of anyone's face while he walks past
        const { body } = P.bodyRects(p, geo, pre);
        if (body.front) {
          const dC = p.clone().setY(p.y + 0.5 * h).sub(cam.position).dot(pre.fwd);
          const bc = P.clip01(body), ba = Math.max(1e-6, (body.x1 - body.x0) * (body.y1 - body.y0));
          for (const q of pre.prs) {
            if (q.depth > dC + 0.1 && rectOverlap(bc, q.face) > 0) return false;
            if (q.depth < dC - 0.1 && (rectOverlap(bc, q.body) / ba > 0.5 || rectOverlap(bc, q.face) > 0)) return false;   // vanishing behind someone
          }
          for (const k of pre.keep) if (rectOverlap(P.clip01(body), k) > 0.004) return false;
        }
      }
    }
    for (const f of [0.25, 0.5, 0.75]) {
      const p = a.clone().lerp(b, f);
      const y = rays.floorBelow(p.clone().setY(p.y + 0.5), 1.2);
      if (y === null || Math.abs(y - p.y) > 0.1) return false;
    }
    return true;
  };
  const N = pts.length;
  const node = (i: number) => pts[i].launch ?? pts[i].pos;
  const cost: number[][] = [...Array(N)].map(() => Array(N).fill(Infinity));
  let edges = 0;
  for (let i = 0; i < N; i++) {
    cost[i][i] = 0;
    for (let j = i + 1; j < N; j++) {
      const a = node(i), b = node(j);
      const d = a.distanceTo(b);
      if (d < 7 && clear(a, b)) { cost[i][j] = cost[j][i] = d; edges++; }
      if ((i * N + j) % 3 === 0) yield;
    }
  }
  // the largest connected group (ties: the one with more readable spots)
  const comp = Array(N).fill(-1);
  const groups: number[][] = [];
  for (let i = 0; i < N; i++) {
    if (comp[i] >= 0) continue;
    const g: number[] = [], st = [i];
    comp[i] = groups.length;
    while (st.length) { const x = st.pop()!; g.push(x); for (let j = 0; j < N; j++) if (comp[j] < 0 && cost[x][j] < Infinity) { comp[j] = groups.length; st.push(j); } }
    groups.push(g);
  }
  const walkers = (g: number[]) => g.filter((i) => !pts[i].showOnly).length, readers = (g: number[]) => g.filter((i) => pts[i].tab).length;
  groups.sort((a, b) => walkers(b) - walkers(a) || readers(b) - readers(a));
  const keep = (groups[0] ?? []).sort((a, b) => a - b);
  const kp = keep.map((i, id) => ({ ...pts[i], id }));
  const M = kp.length;
  const C = keep.map((i) => keep.map((j) => cost[i][j]));
  const nx = keep.map((_, i) => keep.map((__, j) => (C[i][j] < Infinity ? j : -1)));
  for (let k = 0; k < M; k++) for (let i = 0; i < M; i++) for (let j = 0; j < M; j++) if (C[i][k] + C[k][j] < C[i][j] - 1e-9) { C[i][j] = C[i][k] + C[k][j]; nx[i][j] = nx[i][k]; }
  const g2 = geo;
  const set: RoamSet = {
    key, height: geo.height, pts: kp, cost: C, next: nx, msgPlan: null, clear,
    offscreen: (p) => { const { body } = P.bodyRects(p, g2, pre); return !body.front || body.x1 < 0 || body.x0 > 1 || body.y1 < 0 || body.y0 > 1; },
    screenOk: (p) => roamCheap({ ...inp, bad: [] }, pre, { pos: p, perch: p.y > 0.15, source: 'current', launch: null, edge: false }, g2, 'room', null, true) !== null,
    camPos: cam.position.clone(), rgt: right.clone(),
    u: (p) => { const v = p.clone().project(cam); return (v.x + 1) / 2; },
    stats: { cands: cands.length, checked, valid: N, tabs: kp.filter((p) => p.tab).length, edges, k: best!.k },
  };
  return set;
}

/** A perch moved to its edge facing the lens (else any open side), with the floor point beside it. */
function perchEdge(inp: BuddyPlanInput, p: V3, base: V3, H: number): Cand | null {
  const rays = inp.ctx.rays;
  const toCam = base.clone().sub(p).setY(0);
  if (toCam.lengthSq() < 1e-6) return null;
  toCam.normalize();
  const side = V(toCam.z, 0, -toCam.x);
  const dirs = [toCam, side, side.clone().negate(), toCam.clone().negate()];
  for (let di = 0; di < dirs.length; di++) {
    const dir = dirs[di];
    let edgeAt = -1;
    for (let s = 0.08; s <= 0.9; s += 0.08) {
      const y = rays.floorBelow(p.clone().addScaledVector(dir, s).setY(p.y + 0.3), 0.6);
      if (y === null || Math.abs(y - p.y) > 0.05) { edgeAt = s; break; }
    }
    if (edgeAt < 0) continue;
    const pos = p.clone().addScaledVector(dir, Math.max(0, edgeAt - 0.12 * (H / 1.08)));
    const launch = p.clone().addScaledVector(dir, edgeAt + 0.32).setY(0);
    const fy = rays.floorBelow(launch.clone().setY(0.4), 1);
    if (fy === null || Math.abs(fy) > 0.08) continue;
    launch.y = fy;
    if (rays.insideCollider(launch.clone().setY(fy + 0.25), 0.12)) continue;
    // the hop is clear (nothing between the floor point and the top) and he fits standing up there
    if (!rays.clear(launch.clone().setY(fy + H * 0.5), pos.clone().setY(pos.y + H * 0.5))) continue;
    if (!rays.clear(pos.clone().setY(pos.y + 0.05), pos.clone().setY(pos.y + H * 1.02))) continue;
    return { pos, perch: true, source: 'perch', launch, edge: di === 0 };
  }
  return null;
}

/** Screen rules for a roam spot (no rays): whole body in frame, readable size, not over a face / screen / prop,
 *  not hidden behind a performer, not right in front of the lens. Returns a score (lower = better) or null. */
function roamCheap(inp: BuddyPlanInput, pre: ReturnType<typeof _place.prep>, c: Cand, geo: BuddyGeo, range: 'near' | 'room', host: V3 | null, screenOnly = false, minBh = 0.08): number | null {
  const P = _place;
  const { ctx } = inp;
  const p = c.pos, h = geo.height, cam = pre.cam;
  if (!screenOnly) {
    for (const s of ctx.spots) if (Math.hypot(s.x - p.x, s.z - p.z) < (c.perch ? 0.5 : 0.6)) return why(inp, 'c306');
    if (!c.perch) {
      for (const q of ctx.performers) if (Math.hypot(q.floor.x - p.x, q.floor.z - p.z) < 0.75) return why(inp, 'c308');
      for (const y of [0.15, 0.5, 0.85]) if (ctx.rays.insideCollider(new THREE.Vector3(p.x, p.y + y * h, p.z), 0.2 * Math.min(1, h / 1.08))) return why(inp, 'c309');
    }
    if (range === 'near' && host && Math.hypot(host.x - p.x, host.z - p.z) > 3.2) return why(inp, 'c311');
  }
  const { head, body } = P.bodyRects(p, geo, pre);
  if (!head.front || !body.front) return why(inp, 'c314');
  if (head.x0 < 0.02 || head.x1 > 0.98 || head.y0 < 0.03 || head.y1 > 0.97) return why(inp, 'c315');
  const bc = P.clip01(body);
  const area = Math.max(1e-6, (body.x1 - body.x0) * (body.y1 - body.y0));
  if (((bc.x1 - bc.x0) * (bc.y1 - bc.y0)) / area < 0.8) return why(inp, 'c318');
  const bh = body.y1 - body.y0;
  if (bh < minBh || bh > 0.62) return why(inp, 'c320');
  const dC = p.clone().setY(p.y + 0.5 * h).sub(cam.position).dot(pre.fwd);
  if (dC < 0.9 || (pre.dA !== null && dC < pre.dA * 0.4)) return why(inp, 'c322');
  for (const q of pre.prs) {
    if (rectOverlap(bc, q.face) > 0 || rectOverlap(head, q.face) > 0) return why(inp, 'c324');
    if (q.depth < dC - 0.1 && rectOverlap(bc, q.body) / area > 0.35) return why(inp, 'c325');       // behind a performer
  }
  for (const k of pre.keep) if (rectOverlap(bc, k) > 0.002 || rectOverlap(head, k) > 0) return why(inp, 'c327');
  const uc = (body.x0 + body.x1) / 2;
  let score = 0;
  if (pre.hostU !== null) score += Math.abs(uc - pre.hostU) * (range === 'near' ? 1.6 : 0.35);
  if (pre.dA !== null) score += (Math.abs(dC - pre.dA) / pre.dA) * 0.8;
  score += Math.abs((head.y0 + body.y1) / 2 - 0.6) * 0.8;
  if (bh > 0.45) score += (bh - 0.45) * 3;
  if (c.perch) score += 0.15;
  else if (c.source !== 'grid' && c.source !== 'current') score -= 0.3;
  return score;
}

/** Room rays for a roam spot: his head + body are seen, something under his feet, nothing cuts through him. */
function roamRays(inp: BuddyPlanInput, pre: ReturnType<typeof _place.prep>, c: Cand, geo: BuddyGeo, range: 'near' | 'room', host: V3 | null): boolean {
  const { ctx } = inp;
  const rays = ctx.rays, cam = pre.cam, p = c.pos, h = geo.height;
  const hc = p.clone().setY(p.y + geo.headUp);
  const heads = [hc, hc.clone().addScaledVector(pre.rgt, geo.headW * 0.6), hc.clone().addScaledVector(pre.rgt, -geo.headW * 0.6), hc.clone().setY(hc.y - geo.headW * 0.5), hc.clone().setY(hc.y - geo.headW * 0.25).addScaledVector(pre.rgt, geo.headW * 0.3), hc.clone().setY(hc.y - geo.headW * 0.25).addScaledVector(pre.rgt, -geo.headW * 0.3), p.clone().setY(p.y + h * 0.5)];
  // (his whole face seen — not peeking through a bar stool or over a desk edge)
  if (heads.filter((q) => rays.clear(cam.position, q)).length < heads.length) return !!why(inp, 'r345');
  const chest = p.clone().setY(p.y + h * 0.45);
  if (!rays.clear(cam.position, chest) && !rays.clear(cam.position, p.clone().setY(p.y + h * 0.2))) return !!why(inp, 'r347');
  if (rays.hit(p.clone().setY(p.y + 0.6), p.clone().setY(p.y - 0.4), 0.01) === Infinity) return !!why(inp, 'r348');
  if (!rays.clear(p.clone().setY(p.y + h * 0.06), p.clone().setY(p.y + Math.max(geo.headUp + geo.headW * 0.6, h * 0.9)))) return !!why(inp, 'r349');
  if (!rays.clear(chest.clone().addScaledVector(pre.rgt, -h * 0.22), chest.clone().addScaledVector(pre.rgt, h * 0.22))) return !!why(inp, 'r350');
  // nothing sticks through him (a bar stool, a table edge, a lamp): a ring of short rays out of his body at belly + head height
  for (const y of [0.45, 0.8]) {
    const c = p.clone().setY(p.y + y * h), r = (y > 0.6 ? geo.headW : h * 0.2) * 0.9;
    for (let i = 0; i < 6; i++) { const a = (i / 6) * Math.PI * 2; if (!rays.clear(c, c.clone().add(new THREE.Vector3(Math.cos(a) * r, 0, Math.sin(a) * r)))) return !!why(inp, 'ring'); }
  }
  if (inp.exact && !inp.exact([hc], cam.position)) return !!why(inp, 'r351');
  if (!c.perch && range === 'near' && host && !rays.clear(host.clone().setY(1.3), p.clone().setY(1.3))) return !!why(inp, 'r352');
  return true;
}

// ---------------------------------------------------------------------------------------------------- timeline
export interface RSeg {
  k: 'hold' | 'walk' | 'hop' | 'show';
  t0: number; t1: number;
  a: V3; b: V3;
  /** Walk: polyline, cumulative lengths, top speed, duration of the whole speed profile (a walk cut short by a
   *  message ends before it). */
  pts?: V3[]; cum?: number[]; v?: number; wd?: number;
  /** Hop: arc height (m). */
  arc?: number;
  bit?: Bit;
  /** Spot he is at / heading to (-1 = none). */
  pt: number;
  /** Show: the raised-tablet plan; `fall` = no readable spot in this shot, the message fallback plan is used. */
  tab?: TabletPlan | null; fall?: boolean;
  /** Distance walked before this segment (stride phase). */
  dist0: number;
  side: 1 | -1;
}

export interface SimIn {
  set: RoamSet;
  seed: number;
  /** Epoch seconds the slots count from (the host's buddyAt). */
  epoch: number;
  /** Chat event reaction times (s): ts + REACT. */
  msgs: number[];
  now: number;
  /** Amble / hurry speeds (m/s). */
  v: number; hurry: number;
  /** Buddy height (m) — hop arcs. */
  h: number;
  /** Longest hurry (m) to a readable spot for a message; farther → the fallback plan (a message must not wait). */
  maxHurry?: number;
}

function walkDur(L: number, v: number) { let vv = v; if (L < (vv * (ACC + DEC)) / 2) vv = (2 * L) / (ACC + DEC); return { dur: vv > 0 ? L / vv + (ACC + DEC) / 2 : 0, v: vv }; }
function walkS(L: number, v: number, dur: number, t: number): { s: number; vi: number } {
  if (t <= 0) return { s: 0, vi: 0 };
  if (t >= dur) return { s: L, vi: 0 };
  if (t < ACC) return { s: (v * t * t) / (2 * ACC), vi: (v * t) / ACC };
  if (t > dur - DEC) { const r = dur - t; return { s: L - (v * r * r) / (2 * DEC), vi: (v * r) / DEC }; }
  return { s: (v * ACC) / 2 + v * (t - ACC), vi: v };
}
function along(pts: V3[], cum: number[], s: number, out: V3): { dir: V3 } {
  let i = 0;
  while (i < pts.length - 2 && s > cum[i + 1]) i++;
  const L = cum[i + 1] - cum[i];
  const k = L > 1e-9 ? clamp01((s - cum[i]) / L) : 1;
  out.lerpVectors(pts[i], pts[i + 1], k);
  return { dir: pts[i + 1].clone().sub(pts[i]).setY(0) };
}

/** Merge message times into display windows [start, until]. */
function windows(msgs: number[], from: number): [number, number][] {
  const out: [number, number][] = [];
  for (const m of [...msgs].sort((a, b) => a - b)) {
    if (m + HOLD < from) continue;
    const last = out[out.length - 1];
    if (last && m <= last[1] + 0.3) last[1] = Math.max(last[1], m + HOLD);
    else out.push([m, m + HOLD]);
  }
  return out;
}

const BITS: [Bit, number][] = [['idle', 26], ['wave', 9], ['peer', 10], ['stretch', 7], ['sit', 8], ['read', 11], ['look', 10], ['hop', 6], ['dance', 5]];

/** Deterministic roam timeline from the current window's start to ~25 s ahead (see the header). */
export function simulate(inp: SimIn): RSeg[] {
  const { set, seed, epoch, now } = inp;
  const pts = set.pts, N = pts.length;
  const segs: RSeg[] = [];
  if (!N) return segs;
  const nodeP = (i: number) => pts[i].launch ?? pts[i].pos;
  const hasTab = pts.some((p) => p.tab);
  const pickW = (r: () => number, w: number[]) => { const tot = w.reduce((a, b) => a + b, 0); if (tot <= 0) return -1; let x = r() * tot; for (let i = 0; i < w.length; i++) { x -= w[i]; if (x <= 0 && w[i] > 0) return i; } return w.findIndex((v) => v > 0); };
  const startOf = (w: number) => { const r = rng(hash32(seed, w, 'start')); const i = pickW(r, pts.map((p) => (p.showOnly ? 0 : (p.tab ? 3 : 1) * (p.perch ? 0.3 : 1)))); return i < 0 ? 0 : i; };
  const kNow = Math.floor((now - epoch) / SLOT);
  const W = Math.floor(kNow / WIN);
  let t = epoch + W * WIN * SLOT;
  let at = startOf(W);
  const pos = pts[at].pos.clone();
  let dist = 0;
  let side: 1 | -1 = pts[at].side;
  const horizon = now + 25;
  const wins = windows(inp.msgs, t);
  let wi = 0;
  while (wi < wins.length && wins[wi][1] < t) wi++;
  const emit = (s: Omit<RSeg, 'dist0' | 'side'> & { side?: 1 | -1 }) => { segs.push({ ...s, dist0: dist, side: s.side ?? side }); t = s.t1; };
  /** Route (spot ids) from spot i to spot j. */
  const route = (i: number, j: number): number[] | null => {
    if (set.cost[i]?.[j] === undefined || set.cost[i][j] === Infinity) return null;
    const r = [i];
    let x = i, guard = 0;
    while (x !== j && guard++ < N + 2) { x = set.next[x][j]; if (x < 0) return null; r.push(x); }
    return r;
  };
  /** Walk / hop pieces along a route (from `from` — his exact position — through the spots). Stops at a message
   *  window if `interrupt`; returns false if interrupted (he is then between spots: at = -1, prev / next known). */
  let between: [number, number] | null = null;
  const go = (from: V3, r: number[], v: number, interrupt: boolean, trip: boolean): boolean => {
    const first = pts[r[0]], last = pts[r[r.length - 1]];
    side = last.side;
    // off a perch first
    if (first.perch && first.launch && from.distanceTo(first.pos) < 0.05 && r.length > 1) {
      const d = hopDur(first.pos, first.launch);
      emit({ k: 'hop', t0: t, t1: t + d, a: first.pos.clone(), b: first.launch.clone(), arc: inp.h * 0.22, pt: r[r.length - 1] });
      pos.copy(first.launch);
    }
    // (between two spots after a message stopped him: walk to the route's first spot too)
    const line: V3[] = [pos.clone()];
    for (let i = pos.distanceTo(nodeP(r[0])) > 0.05 && pos.distanceTo(first.pos) > 0.05 ? 0 : 1; i < r.length; i++) line.push(nodeP(r[i]).clone());
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + line[i].distanceTo(line[i - 1]));
    const L = cum[cum.length - 1];
    if (L > 0.03) {
      const pieces: [number, number][] = trip && L > 1.6 ? [[0, L * 0.5], [L * 0.5, L]] : [[0, L]];
      for (let pi = 0; pi < pieces.length; pi++) {
        const [s0, s1] = pieces[pi];
        const sub = subLine(line, cum, s0, s1);
        const { dur, v: vv } = walkDur(s1 - s0, v);
        const w = interrupt && wi < wins.length ? wins[wi][0] : Infinity;
        if (w < t + dur) {
          // a message: he stops where he is (between two spots) and goes to the nearest readable one
          const tt = Math.max(0, w - t);
          const { s } = walkS(s1 - s0, vv, dur, tt);
          if (tt > 0.01) {
            const cut = subLine(sub.pts, sub.cum, 0, s);
            const end = cut.pts[cut.pts.length - 1].clone();
            emit({ k: 'walk', t0: t, t1: t + tt, a: pos.clone(), b: end, pts: cut.pts, cum: cut.cum, v: vv, wd: dur, pt: -1 });
            dist += s;
            pos.copy(end);
          }
          let seg = 0;
          while (seg < line.length - 2 && s0 + s > cum[seg + 1]) seg++;
          const off = line.length === r.length ? 0 : -1;       // line[0] is his position when it isn't a spot
          const ia = Math.max(0, Math.min(r.length - 1, seg + off)), ib = Math.max(0, Math.min(r.length - 1, seg + 1 + off));
          between = [r[ia], r[ib]];
          at = -1;
          return false;
        }
        emit({ k: 'walk', t0: t, t1: t + dur, a: sub.pts[0].clone(), b: sub.pts[sub.pts.length - 1].clone(), pts: sub.pts, cum: sub.cum, v: vv, wd: dur, pt: r[r.length - 1] });
        dist += s1 - s0;
        pos.copy(sub.pts[sub.pts.length - 1]);
        if (pi === 0 && pieces.length > 1) emit({ k: 'hold', t0: t, t1: t + BIT_DUR.trip, a: pos.clone(), b: pos.clone(), bit: 'trip', pt: -1 });
      }
    }
    if (last.perch && last.launch) {
      const d = hopDur(last.launch, last.pos);
      emit({ k: 'hop', t0: t, t1: t + d, a: pos.clone(), b: last.pos.clone(), arc: inp.h * 0.22 + Math.max(0, last.pos.y - pos.y) * 0.35, pt: r[r.length - 1] });
      pos.copy(last.pos);
    }
    at = r[r.length - 1];
    between = null;
    return true;
  };
  const hopDur = (a: V3, b: V3) => 0.55 + Math.abs(b.y - a.y) * 0.25;
  /** From where he is, the readable spot with the shortest walk. */
  const nearestTab = (): { r: number[]; from: V3 } | null => {
    let bestC = Infinity, bestR: number[] | null = null;
    const starts: [number, number][] = at >= 0 ? [[at, 0]] : between ? [[between[0], pos.distanceTo(nodeP(between[0]))], [between[1], pos.distanceTo(nodeP(between[1]))]] : [];
    for (const [s0, c0] of starts) for (let j = 0; j < N; j++) {
      if (!pts[j].tab) continue;
      const c = c0 + set.cost[s0][j];
      if (c > (inp.maxHurry ?? Infinity)) continue;
      if (c < bestC - 1e-9) { bestC = c; bestR = route(s0, j); }
    }
    return bestR ? { r: bestR, from: pos.clone() } : null;
  };
  const show = () => {
    const [, until0] = wins[wi++];
    let until = until0;
    // later windows that start while he's still on his way merge in
    const tgt = hasTab ? nearestTab() : null;
    if (!tgt) {
      emit({ k: 'show', t0: t, t1: Math.max(until, t + MIN_SHOW) + LOWER, a: pos.clone(), b: pos.clone(), tab: null, fall: true, pt: at });
      while (wi < wins.length && wins[wi][0] < t) { until = Math.max(until, wins[wi][1]); wi++; }
      return;
    }
    if (tgt.r.length > 1 || at < 0) go(pos.clone(), tgt.r, inp.hurry, false, false);
    else side = pts[at].side;
    while (wi < wins.length && wins[wi][0] <= t + 0.3) { until = Math.max(until, wins[wi][1]); wi++; }
    let tEnd = Math.max(until, t + MIN_SHOW);
    let guard = 0;
    for (;;) {
      const len = Math.min(tEnd - t, MAX_SHOW);
      emit({ k: 'show', t0: t, t1: t + len + LOWER, a: pos.clone(), b: pos.clone(), tab: pts[at].tab, pt: at, side: pts[at].tab!.side });
      // more messages while he shows: keep showing
      while (wi < wins.length && wins[wi][0] <= t - LOWER) { until = Math.max(until, wins[wi][1]); wi++; }
      tEnd = Math.max(tEnd, until);
      if (t >= tEnd || guard++ > 6) {
        // a show-only spot (near the lens): back among the others
        if (pts[at].showOnly) {
          const back = pts.filter((p) => !p.showOnly && set.cost[at][p.id] < Infinity).map((p) => p.id).sort((a, b) => set.cost[at][a] - set.cost[at][b]);
          const r = back.length ? route(at, back[0]) : null;
          if (r) go(pos.clone(), r, inp.v, false, false);
        }
        break;
      }
      // shown for a long time (busy chat): stretch his legs to another readable spot, then go on showing
      const others = pts.filter((p) => p.tab && p.id !== at).map((p) => p.id).sort((a, b) => set.cost[at][a] - set.cost[at][b]);
      const r = others.length ? route(at, others[0]) : null;
      if (r) go(pos.clone(), r, inp.v, false, false);
    }
  };
  /** Stand (doing `bit`) until `until`, showing chat for any message window that starts meanwhile. */
  const hold = (until: number, bit: Bit) => {
    let b = bit;
    while (t < until - 1e-6) {
      const w = wi < wins.length ? wins[wi][0] : Infinity;
      if (w <= t) { show(); b = 'idle'; continue; }
      const end = Math.min(until, w);
      emit({ k: 'hold', t0: t, t1: end, a: pos.clone(), b: pos.clone(), bit: b, pt: at });
      if (end < until) b = 'idle';
    }
  };
  let guard = 0;
  for (let k = W * WIN; t < horizon && guard++ < 400; k++) {
    const tSlot = epoch + k * SLOT, tNext = tSlot + SLOT;
    if (t < tSlot) hold(tSlot, 'idle');
    if (t >= tNext) continue;                                           // a long show ran over this slot
    if (wi < wins.length && wins[wi][0] <= t) { show(); if (t >= tNext) continue; }
    const r = rng(hash32(seed, k, 'slot'));
    const lastOfWin = (k + 1) % WIN === 0;
    let target = -1;
    if (lastOfWin) target = startOf(Math.floor((k + 1) / WIN));
    else {
      const roll = r();
      const wantPerch = roll >= 0.52 && roll < 0.63;
      if (roll < 0.63 && at >= 0) {
        const w = pts.map((p, j) => {
          if (j === at || set.cost[at][j] === Infinity || p.showOnly) return 0;
          const c = set.cost[at][j];
          const near = Math.exp(-(((c - 2.2) / 1.8) ** 2));
          return near * (p.tab ? 3 : 1) * (p.perch ? (wantPerch ? 6 : 0.2) : wantPerch ? 0.15 : 1);
        });
        target = pickW(r, w);
      }
    }
    const trip = !lastOfWin && r() < 0.13;
    if (target >= 0 && target !== at && at >= 0) {
      const rt = route(at, target);
      if (rt && !go(pos.clone(), rt, inp.v, true, trip)) { show(); continue; }
    }
    if (t >= tNext) continue;
    // a bit
    const room = tNext - t - 0.3;
    const onPerch = at >= 0 && pts[at].perch;
    const w = BITS.map(([b, wt]) => (BIT_DUR[b] <= room && !(b === 'sit' && onPerch && !pts[at].edge) && !(b === 'hop' && onPerch) ? wt : 0));
    const bi = pickW(r, w);
    const bit = bi >= 0 ? BITS[bi][0] : 'idle';
    if (bit !== 'idle') hold(Math.min(t + BIT_DUR[bit], tNext), bit);
  }
  return segs;
}

function subLine(pts: V3[], cum: number[], s0: number, s1: number): { pts: V3[]; cum: number[] } {
  const out: V3[] = [];
  const p = V();
  along(pts, cum, s0, p); out.push(p.clone());
  for (let i = 1; i < pts.length - 1; i++) if (cum[i] > s0 + 1e-6 && cum[i] < s1 - 1e-6) out.push(pts[i].clone());
  along(pts, cum, s1, p); out.push(p.clone());
  const c = [0];
  for (let i = 1; i < out.length; i++) c.push(c[i - 1] + out[i].distanceTo(out[i - 1]));
  return { pts: out, cum: c };
}

export interface RSample {
  pos: V3;
  /** Walking / hopping direction (yaw), null = standing (he faces the lens / the host). */
  heading: number | null;
  gait: number; dist: number;
  seg: RSeg | null;
  bit: Bit; bitT: number;
  /** Tablet raised 0..1. */
  raise: number;
  /** 0..1 through a hop (else -1). */
  hop: number;
  side: 1 | -1;
}

/** The timeline at time t (pure: no rays). */
export function sampleRoam(segs: RSeg[], t: number, o?: RSample): RSample {
  const s: RSample = o ?? { pos: V(), heading: null, gait: 0, dist: 0, seg: null, bit: 'idle', bitT: 0, raise: 0, hop: -1, side: 1 };
  s.heading = null; s.gait = 0; s.bit = 'idle'; s.bitT = 0; s.raise = 0; s.hop = -1; s.seg = null;
  if (!segs.length) return s;
  let lo = 0, hi = segs.length - 1;
  if (t >= segs[hi].t0) lo = hi;
  else while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m - 1; }
  const g = segs[lo];
  s.seg = g; s.side = g.side; s.dist = g.dist0;
  const lt = Math.max(0, Math.min(t, g.t1) - g.t0), D = g.t1 - g.t0;
  switch (g.k) {
    case 'walk': {
      const L = g.cum![g.cum!.length - 1];
      const dur = g.wd ?? D;
      const w = walkS(L, g.v!, dur, lt);
      const { dir } = along(g.pts!, g.cum!, w.s, s.pos);
      if (dir.lengthSq() > 1e-8) s.heading = Math.atan2(dir.x, dir.z);
      s.gait = g.v! > 0 ? Math.min(1, w.vi / g.v!) : 0;
      s.dist = g.dist0 + w.s;
      break;
    }
    case 'hop': {
      const k = D > 0 ? clamp01(lt / D) : 1;
      s.pos.lerpVectors(g.a, g.b, smooth(k));
      s.pos.y = g.a.y + (g.b.y - g.a.y) * smooth(k) + (g.arc ?? 0.2) * Math.sin(Math.PI * k);
      const d = g.b.clone().sub(g.a);
      if (d.x * d.x + d.z * d.z > 1e-6) s.heading = Math.atan2(d.x, d.z);
      s.hop = k;
      break;
    }
    case 'hold':
      s.pos.copy(g.a); s.bit = g.bit ?? 'idle'; s.bitT = lt;
      break;
    case 'show':
      s.pos.copy(g.a);
      // (the fallback — no readable spot here — never raises the tablet in the room: the tablet plans show it)
      s.raise = g.fall ? 0 : lt < RAISE ? smooth(lt / RAISE) : lt > D - LOWER ? smooth((D - lt) / LOWER) : 1;
      break;
  }
  return s;
}

/** Where the timeline settles next (the end of the current walk / hop, else where he stands) + that spot. */
export function settleOf(s: RSample): { pos: V3; pt: number } {
  const g = s.seg;
  if (!g) return { pos: s.pos.clone(), pt: -1 };
  return { pos: (g.k === 'walk' || g.k === 'hop' ? g.b : g.a).clone(), pt: g.pt };
}

/** Local walk (catch-ups, walk-ins): from `from` (any floor point) to spot `to` — straight, else via the nearest spot
 *  he can walk to straight; hops up at the end if `to` is a perch. Null = no walkable way. */
export function localRoute(set: RoamSet, from: V3, fromPt: number, to: number, t0: number, v: number, h: number, dist0: number): RSeg[] | null {
  const pts = set.pts;
  const nodeP = (i: number) => pts[i].launch ?? pts[i].pos;
  const out: RSeg[] = [];
  let t = t0, dist = dist0;
  let cur = from.clone();
  const tgt = pts[to];
  const side = tgt.side;
  // standing on a perch spot: hop down first
  if (fromPt >= 0 && pts[fromPt]?.perch && pts[fromPt].launch && fromPt !== to && cur.distanceTo(pts[fromPt].pos) < 0.1) {
    const d = 0.55 + Math.abs(pts[fromPt].pos.y - pts[fromPt].launch!.y) * 0.25;
    out.push({ k: 'hop', t0: t, t1: t + d, a: cur.clone(), b: pts[fromPt].launch!.clone(), arc: h * 0.22, pt: to, dist0: dist, side });
    t += d; cur = pts[fromPt].launch!.clone();
  }
  if (fromPt === to && cur.distanceTo(tgt.pos) < 0.05) return out;
  const goal = nodeP(to);
  let line: V3[] | null = null;
  if (cur.distanceTo(goal) < 0.03) line = [];
  else if (set.clear(cur, goal)) line = [cur.clone(), goal.clone()];
  else {
    // via the closest spot he can reach straight, then the graph
    const order = pts.map((p) => p.id).filter((i) => set.cost[i][to] < Infinity).sort((a, b) => cur.distanceTo(nodeP(a)) + set.cost[a][to] - (cur.distanceTo(nodeP(b)) + set.cost[b][to]));
    for (const i of order.slice(0, 5)) {
      if (!set.clear(cur, nodeP(i))) continue;
      line = [cur.clone(), nodeP(i).clone()];
      let x = i, guard = 0;
      while (x !== to && guard++ < pts.length + 2) { x = set.next[x][to]; if (x < 0) break; line.push(nodeP(x).clone()); }
      if (x !== to) { line = null; continue; }
      break;
    }
  }
  if (!line) return null;
  if (line.length >= 2) {
    const cum = [0];
    for (let i = 1; i < line.length; i++) cum.push(cum[i - 1] + line[i].distanceTo(line[i - 1]));
    const L = cum[cum.length - 1];
    const { dur, v: vv } = walkDur(L, v);
    out.push({ k: 'walk', t0: t, t1: t + dur, a: line[0].clone(), b: line[line.length - 1].clone(), pts: line, cum, v: vv, wd: dur, pt: to, dist0: dist, side });
    t += dur; dist += L; cur = line[line.length - 1].clone();
  }
  if (tgt.perch && tgt.launch) {
    const d = 0.55 + Math.abs(tgt.pos.y - cur.y) * 0.25;
    out.push({ k: 'hop', t0: t, t1: t + d, a: cur.clone(), b: tgt.pos.clone(), arc: h * 0.22 + Math.max(0, tgt.pos.y - cur.y) * 0.35, pt: to, dist0: dist, side });
  }
  return out;
}

/** A straight walk a → b (catch-ups onto a point between two spots). */
export function lineSeg(a: V3, b: V3, t0: number, v: number, dist0: number, pt: number, side: 1 | -1): RSeg {
  const L = a.distanceTo(b);
  const { dur, v: vv } = walkDur(L, v);
  return { k: 'walk', t0, t1: t0 + dur, a: a.clone(), b: b.clone(), pts: [a.clone(), b.clone()], cum: [0, L], v: vv, wd: dur, pt, dist0, side };
}

/** An off-screen floor point beside the frame edge nearest to spot `to` from which he can walk in (null = none). */
export function edgeEntry(set: RoamSet, to: number): V3 | null {
  const pts = set.pts;
  const goal = pts[to].launch ?? pts[to].pos;
  const u = set.u(goal);
  const toward = set.camPos.clone().setY(goal.y).sub(goal).normalize();
  const near = u < 0.5 ? set.rgt.clone().negate() : set.rgt.clone(), far = near.clone().negate();
  const dirs = [near, near.clone().add(toward).normalize(), near.clone().sub(toward).normalize(), far, far.clone().add(toward).normalize(), far.clone().sub(toward).normalize(), toward.clone().negate(), toward.clone()];
  for (const d of dirs) {
    for (let s = 0.4; s <= 9; s += 0.3) {
      const p = goal.clone().addScaledVector(d, s);
      if (!set.offscreen(p)) continue;
      const e = p.addScaledVector(d, 0.3);
      if (set.clear(e, goal)) return e;
      break;
    }
  }
  return null;
}
