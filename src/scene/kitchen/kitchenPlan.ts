// Kitchen: the DETERMINISTIC planner. An episode (food fight, riot, inspection) is planned once from
// (seed, id, room) into per-actor tracks of segments + throws, splats, bubbles, door / prop keyframes, and every page
// samples it at wall-clock time — so the studio preview, every OBS page and party guests all show the same kitchen,
// and a page opened mid-riot shows mid-riot. Nothing here looks at the camera or the frame rate.
import * as THREE from 'three';
import { type KitchenRoom, navPath, nearestNav } from './kitchenRoom';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export const TAG = { RAGE: 1, STARS: 2, STEAM: 4, SWEAT: 8, ANGER: 16 } as const;

export interface Seg {
  t0: number; t1: number;
  clip: string; loop: boolean; off?: number;
  a: V3; b: V3;
  /** Walks: a polyline (cumulative lengths in plen); the actor faces along it. */
  path?: V3[]; plen?: number[];
  /** Flights: a ballistic arc from a to b with peak height h, `spin` somersaults. */
  arc?: { h: number; spin: number };
  yaw0: number; yaw1: number; turn?: number;
  held?: string; hidden?: boolean; tags?: number;
}
export interface Overlay { t: number; clip: string; dur: number }
export interface Track { segs: Seg[]; overlays: Overlay[] }
export interface Throw { tr: number; ta: number; from: V3; to: V3; food: number; h: number; hit: boolean }
export interface SplatEv { pos: V3; normal: V3; t: number; c0: number; c1: number; kind: number; size: number; ceil: boolean }
export interface Bubble { actor: number; t0: number; t1: number; text: string; loud?: boolean }
export interface Puff { t: number; pos: V3; kind: 'frost' | 'dust' | 'sauce'; size: number }
export type Keys = [number, number][];

export interface Episode {
  id: string; kind: 'foodfight' | 'riot' | 'manager';
  start: number; dur: number;
  tracks: Track[];
  throws: Throw[]; splats: SplatEv[]; bubbles: Bubble[]; puffs: Puff[];
  office: Keys; freezer: Keys; trash: Keys;
  softserve: [number, number] | null;
  alarm: [number, number] | null;
  /** When the crew is pacified (riot) / the manager arrives (fights). */
  climax: number;
  /** Camera shots for the riot director: [t0, t1, CAM_x]. */
  shots: [number, number, string][];
  user?: string; amount?: string;
}

export interface PlanCtx {
  room: KitchenRoom;
  frogs: number;
  frogScale: number;
  /** Clip length in seconds (loaded assets); 0 = unknown. */
  dur: (who: 'frog' | 'mgr' | 'brute', clip: string) => number;
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
const pick = <T>(r: () => number, xs: readonly T[]) => xs[Math.floor(r() * xs.length) % xs.length];
const yawTo = (a: V3, b: V3) => Math.atan2(b.x - a.x, b.z - a.z);
const flat = (p: V3) => V(p.x, 0, p.z);

// ---------------------------------------------------------------------------------------------------- lines
export const LINES = {
  snap: ['HEY!!!', 'THAT WAS MY PATTY!', '>:(', 'OH COME ON!', 'OH IT\'S ON', 'NOT THE BUNS!'],
  fight: ['EAT FRIES!', 'FOOD FIGHT!', 'NUGGET STORM!', 'HOLD STILL!', 'WAAAH'],
  uhoh: ['uh oh', 'KEVIN!!', '...oops', 'HE\'S HERE'],
  mgr: ['WHAT IS GOING ON BACK HERE?!', 'THIS IS A KITCHEN, NOT A POND!', 'WHO THREW THE NUGGET?!', 'I HAVE A MEETING IN FIVE MINUTES!', 'ARE YOU KIDDING ME?!', 'THE HEALTH INSPECTOR IS OUT FRONT!'],
  kick: ['OUT!', 'FRY DUTY!', 'NO BREAKS!', 'UNACCEPTABLE!', 'WRITE-UP!'],
  back: ['BACK TO WORK!!!', 'CLEAN THIS UP. NOW.', 'EVERYONE IS ON FRY DUTY!'],
  inspect: ['SURPRISE INSPECTION!', 'IS THAT A FLY IN THE FRYER?!', 'SMILE MORE!'],
  riot: ['WE WANT THE ICE CREAM MACHINE FIXED!!', 'UNIONIZE!!!', 'KITCHEN RIOT!!!', 'NO MORE FRY DUTY!', 'BURN IT DOWN (NOT THE FRYER)'],
  brute: ['RUCKUS TIME.', 'WHO\'S NEXT?!', 'STAY DOWN, FROG!', 'I WAS ON MY BREAK!'],
  done: ['...and STAY pacified.', 'Nobody tells Kevin.', 'Back in the freezer I go.'],
  hit: ['HEY?!', 'OOF!', 'AAAA', 'MY CAP!'],
};

// ---------------------------------------------------------------------------------------------------- track builder
const WORK: Record<string, [string, string | undefined]> = {
  grill: ['flip', 'spatula'], assemble: ['assemble', undefined], fries: ['fries', 'basket'], bag: ['bag', 'bag'], drinks: ['drinks', 'cup'],
};
export const workOf = (kind: string) => WORK[kind] ?? WORK.assemble;

class TB {
  segs: Seg[] = [];
  overlays: Overlay[] = [];
  held?: string;
  tags = 0;
  constructor(public t: number, public p: V3, public yaw: number) {}
  push(s: Partial<Seg> & { clip: string; dur: number }) {
    const t1 = this.t + Math.max(0.01, s.dur);
    const seg: Seg = { t0: this.t, t1, clip: s.clip, loop: s.loop ?? true, a: (s.a ?? this.p).clone(), b: (s.b ?? s.a ?? this.p).clone(), yaw0: s.yaw0 ?? this.yaw, yaw1: s.yaw1 ?? s.yaw0 ?? this.yaw,
      held: s.held === undefined ? this.held : s.held, tags: s.tags ?? this.tags, ...(s.off ? { off: s.off } : {}), ...(s.turn ? { turn: s.turn } : {}),
      ...(s.path ? { path: s.path, plen: s.plen } : {}), ...(s.arc ? { arc: s.arc } : {}), ...(s.hidden ? { hidden: true } : {}) };
    this.segs.push(seg);
    this.t = t1; this.p = seg.b.clone(); this.yaw = seg.yaw1;
    return seg;
  }
  hold(dur: number, clip: string, o: Partial<Seg> = {}) { return this.push({ ...o, clip, dur }); }
  until(t: number, clip: string, o: Partial<Seg> = {}) { if (t > this.t + 0.01) this.hold(t - this.t, clip, o); }
  face(yaw: number, clip: string, dur = 0.3, o: Partial<Seg> = {}) { return this.push({ ...o, clip, dur, yaw0: this.yaw, yaw1: yaw, turn: dur }); }
  go(pts: V3[], speed: number, clip: string, o: Partial<Seg> = {}) {
    const path = [this.p.clone(), ...pts.map((q) => q.clone())].filter((q, i, a) => i === 0 || q.distanceTo(a[i - 1]) > 0.05);
    if (path.length < 2) return null;
    const plen = [0];
    for (let i = 1; i < path.length; i++) plen.push(plen[i - 1] + path[i].distanceTo(path[i - 1]));
    const L = plen[plen.length - 1];
    const last = path[path.length - 1], prev = path[path.length - 2];
    return this.push({ ...o, clip, dur: Math.max(0.25, L / speed), a: path[0], b: last, path, plen, yaw0: this.yaw, yaw1: yawTo(prev, last) });
  }
  fly(to: V3, dur: number, h: number, spin: number, clip = 'tumble', o: Partial<Seg> = {}) {
    return this.push({ ...o, clip, dur, a: this.p, b: to, arc: { h, spin }, yaw0: this.yaw, yaw1: this.yaw + spin * 0.5 });
  }
  hide(until: number, at?: V3) { if (until > this.t) this.push({ clip: 'Idle_Loop', dur: until - this.t, hidden: true, a: at ?? this.p }); }
  hit(t: number, clip = 'hit', dur = 0.45) { this.overlays.push({ t, clip, dur }); }
}

/** A nav route from p to q (both floor points): p → nearest node → … → nearest node → q. */
function route(room: KitchenRoom, p: V3, q: V3): V3[] {
  const a = nearestNav(room, p), b = nearestNav(room, q);
  const ids = navPath(room, a, b);
  const pts = ids.map((i) => room.nav[i].clone());
  // skip a first node that doubles back
  if (pts.length > 1 && p.distanceTo(pts[1]) < pts[0].distanceTo(pts[1])) pts.shift();
  if (pts.length > 1 && q.distanceTo(pts[pts.length - 2]) < pts[pts.length - 1].distanceTo(pts[pts.length - 2])) pts.pop();
  pts.push(q.clone());
  return pts;
}

// ---------------------------------------------------------------------------------------------------- the planner
export class KitchenPlanner {
  constructor(private ctx: PlanCtx) {}

  private get room() { return this.ctx.room; }
  private d(who: 'frog' | 'mgr' | 'brute', clip: string, fallback: number) { return this.ctx.dur(who, clip) || fallback; }

  private stationPos(i: number) { return this.room.stations[i % this.room.stations.length].pos.clone(); }
  private stationYaw(i: number) { return this.room.stations[i % this.room.stations.length].yaw; }
  private stationKind(i: number) { return this.room.stations[i % this.room.stations.length].kind; }
  /** The floor point a frog steps down to from its station (the stool) */
  private stepOff(i: number) { const p = this.stationPos(i); const f = V(-Math.sin(this.stationYaw(i)), 0, -Math.cos(this.stationYaw(i))); return flat(p).addScaledVector(f, 0.45); }
  private chest(p: V3) { return p.clone().add(V(0, 0.62 * this.ctx.frogScale * 1.37, 0)); }
  private hand(p: V3, yaw: number) { return p.clone().add(V(Math.sin(yaw) * 0.18, 0.8 * this.ctx.frogScale * 1.37, Math.cos(yaw) * 0.18)); }

  private frogTB(i: number) {
    const tb = new TB(0, this.stationPos(i), this.stationYaw(i));
    tb.held = workOf(this.stationKind(i))[1];
    return tb;
  }
  private work(tb: TB, i: number, until: number) { tb.until(until, workOf(this.stationKind(i))[0], { held: workOf(this.stationKind(i))[1] }); }
  /** Walk back to the station and climb on (a small hop onto the stool). */
  private home(tb: TB, i: number, speed = 2.6, clip = 'run') {
    const st = this.stationPos(i), off = this.stepOff(i);
    if (tb.p.distanceTo(st) < 0.1) return;
    tb.go(route(this.room, flat(tb.p), off), speed, clip, { held: undefined });
    tb.fly(st, 0.35, 0.25, 0, 'walk', { held: undefined });
    tb.face(this.stationYaw(i), 'idle', 0.25, { held: undefined });
    tb.held = workOf(this.stationKind(i))[1];
  }
  /** Step off the stool onto the floor. */
  private down(tb: TB, i: number) {
    if (tb.p.y < 0.05) return;
    tb.fly(this.stepOff(i), 0.3, 0.12, 0, 'walk', { held: undefined });
  }
  private frontZ() {   // the mid aisle (in front of the islands): nav nodes clearly in front of the stations
    const sz = Math.max(...this.room.stations.filter((s) => s.kind !== 'drinks').map((s) => s.pos.z));
    const front = this.room.nav.filter((n) => n.z > sz + 1.2);
    return front.length ? front.reduce((a, n) => a + n.z, 0) / front.length : sz + 2;
  }
  private inZone(p: V3) {
    const z = this.room.zone;
    p.x = THREE.MathUtils.clamp(p.x, z.min.x + 0.4, z.max.x - 0.4);
    p.z = THREE.MathUtils.clamp(p.z, z.min.z + 0.4, z.max.z - 0.4);
    p.y = 0;
    return p;
  }

  private newEp(kind: Episode['kind'], id: string): Episode {
    return { id, kind, start: 0, dur: 0, tracks: [], throws: [], splats: [], bubbles: [], puffs: [], office: [], freezer: [], trash: [], softserve: null, alarm: null, climax: 0, shots: [] };
  }

  /** a throw from frog tb (at its current place) at `to` (hit: a frog chest) */
  private throwAt(ep: Episode, tb: TB, r: () => number, to: V3, hit: boolean, turn = 0.2) {
    const yaw = yawTo(tb.p, to);
    const s = tb.push({ clip: 'throw', dur: 0.9, loop: false, yaw0: tb.yaw, yaw1: yaw, turn, held: undefined });
    const tr = s.t0 + 0.4;
    const from = this.hand(tb.p, yaw);
    const dist = from.distanceTo(to);
    const ta = tr + 0.25 + dist * 0.075;
    ep.throws.push({ tr, ta, from, to: to.clone(), food: Math.floor(r() * 7), h: 0.3 + dist * 0.09, hit });
    return ta;
  }

  private splatFor(ep: Episode, r: () => number, near: V3, t: number, used: Set<number>, maxD = 4.5) {
    const sp = this.room.splats;
    const cands = sp.map((s, i) => ({ s, i, d: s.pos.distanceTo(near) })).filter((c) => !used.has(c.i) && c.d < maxD);
    if (!cands.length) return null;
    const c = cands[Math.floor(r() * cands.length)];
    used.add(c.i);
    const ceil = c.s.surface === 'ceiling';
    const jitter = V((r() - 0.5) * 0.25, (r() - 0.5) * 0.25, (r() - 0.5) * 0.25);
    jitter.addScaledVector(c.s.normal, -jitter.dot(c.s.normal));
    const pos = c.s.pos.clone().add(jitter).addScaledVector(c.s.normal, 0.004 + ep.splats.length * 0.0004);
    ep.splats.push({ pos, normal: c.s.normal.clone(), t, c0: Infinity, c1: Infinity, kind: Math.floor(r() * 4), size: 0.28 + r() * 0.22, ceil });
    return pos;
  }

  /** Mop every splat in `list` (indices into ep.splats), starting now; floor approach points. */
  private mopRound(ep: Episode, tb: TB, list: number[]) {
    tb.held = 'mop';
    for (const k of list) {
      const s = ep.splats[k];
      let a: V3;
      if (s.normal.y > 0.7) { const dir = flat(tb.p).sub(flat(s.pos)); if (dir.lengthSq() < 1e-4) dir.set(0, 0, 1); a = flat(s.pos).addScaledVector(dir.normalize(), 0.55); }
      else a = flat(s.pos).addScaledVector(flat(s.normal).normalize(), 0.6);
      this.inZone(a);
      tb.go(route(this.room, flat(tb.p), a), 1.7, 'walk', { held: 'mop' });
      tb.face(yawTo(tb.p, s.pos), 'mop', 0.3, { held: 'mop' });
      const m = tb.hold(2.6, 'mop', { held: 'mop' });
      s.c0 = m.t0 + 0.2; s.c1 = m.t1 - 0.1;
    }
    tb.held = undefined;
  }

  // ------------------------------------------------------------------------------------------ FOOD FIGHT (+ inspection)
  planFight(id: string, seed: number, fight = true): Episode {
    const r = rng(hash32(seed, id, 'fight'));
    const room = this.room, F = Math.min(this.ctx.frogs, room.stations.length);
    const ep = this.newEp(fight ? 'foodfight' : 'manager', id);
    const tbs = Array.from({ length: F }, (_, i) => this.frogTB(i));
    const used = new Set<number>();
    const tMgr = fight ? 12 + r() * 4 : 1.8;
    ep.climax = tMgr;
    const anchor = tbs.map((tb) => tb.p.clone());
    const I = Math.floor(r() * F);
    const fz = this.frontZ();
    if (fight) {
      // runners: up to two frogs take the fight into the aisle (in full view)
      const runners = new Set<number>();
      const cand = [...Array(F).keys()].filter((i) => this.stationKind(i) !== 'drinks');
      for (let k = 0; k < 2 && cand.length; k++) { const j = cand.splice(Math.floor(r() * cand.length), 1)[0]; if (r() < 0.8) runners.add(j); }
      const aisle = room.nav.map((n, i) => ({ n, i })).filter((x) => x.n.z > fz - 0.6);
      const joins = tbs.map((_, i) => (i === I ? 1.6 : 1.9 + r() * 2.2));
      tbs[I].hold(1.6, 'seethe', { tags: TAG.ANGER });
      ep.bubbles.push({ actor: I, t0: 0.2, t1: 1.8, text: pick(r, LINES.snap) });
      runners.forEach((i) => {
        const spot = aisle.length ? aisle[Math.floor(r() * aisle.length)].n.clone() : this.stepOff(i);
        spot.x += (r() - 0.5) * 0.8; this.inZone(spot);
        anchor[i] = spot;
      });
      for (let i = 0; i < F; i++) {
        const tb = tbs[i];
        this.work(tb, i, joins[i]);
        if (i !== I && r() < 0.5) tb.hold(0.6, 'shock');
        if (runners.has(i)) { this.down(tb, i); tb.go(route(room, flat(tb.p), anchor[i]), 3.2, 'run'); }
        let n = 0;
        while (tb.t < tMgr - 1.0 && n++ < 30) {
          const a = r();
          if (a < 0.62) {
            const others = [...Array(F).keys()].filter((j) => j !== i);
            const g = pick(r, others);
            const hit = r() < 0.5;
            if (hit) {
              const ta = this.throwAt(ep, tb, r, this.chest(anchor[g]), true);
              tbs[g].hit(ta);
              ep.puffs.push({ t: ta, pos: this.chest(anchor[g]), kind: 'sauce', size: 0.35 });
            } else {
              const sp = ep.splats.length < 12 ? this.splatFor(ep, r, anchor[g], 0, used) : null;
              if (sp) { const ta = this.throwAt(ep, tb, r, sp, false); ep.splats[ep.splats.length - 1].t = ta; }
              else this.throwAt(ep, tb, r, this.chest(anchor[g]).add(V(0, 0.8, 0)), false);
            }
            if (r() < 0.12) ep.bubbles.push({ actor: i, t0: tb.t - 0.6, t1: tb.t + 0.6, text: pick(r, LINES.fight) });
          } else if (a < 0.85) tb.hold(0.9 + r() * 0.7, 'duck');
          else tb.hold(0.6 + r() * 0.6, 'riot', { tags: TAG.ANGER });
        }
      }
    }
    // ---- the manager: kicks the office door open, storms to his spot, yells
    const mgr = new TB(0, room.mgrEnter?.clone() ?? V(), 0);
    const doorNav = room.nav[room.mgrNav]?.clone() ?? V();
    const inside = (room.mgrEnter ?? doorNav).clone().lerp(doorNav, 0.42);
    mgr.hide(tMgr - 1.4);
    mgr.p = room.mgrEnter?.clone() ?? inside.clone();
    mgr.yaw = yawTo(mgr.p, doorNav);
    mgr.go([inside], 1.3, 'StompIn');
    mgr.until(tMgr - 0.42, 'Idle_Loop');
    mgr.hold(this.d('mgr', 'Kick', 1.1) * 0.62, 'Kick', { loop: false });
    ep.office.push([tMgr - 0.01, 0], [tMgr + 0.16, 1.08], [tMgr + 0.4, 0.96]);
    ep.puffs.push({ t: tMgr, pos: doorNav.clone().lerp(inside, 0.5).add(V(0, 1, 0)), kind: 'dust', size: 0.9 });
    const yell = room.mgrYell ?? { pos: doorNav.clone(), yaw: 0 };
    mgr.go(route(room, flat(mgr.p), yell.pos), 4.8, 'Sprint_Loop');   // speeds match the clips' stride (mk_humans.py finish_clips)
    mgr.face(yell.yaw, 'Yell', 0.2);
    const y0 = mgr.t;
    mgr.hold(3.0, 'Yell');
    ep.bubbles.push({ actor: F, t0: y0 - 0.1, t1: y0 + 3.0, text: pick(r, fight ? LINES.mgr : LINES.inspect), loud: true });
    ep.shots.push([tMgr - 0.3, y0 + 3.2, 'CAM_MANAGER']);
    // frogs freeze
    for (let i = 0; i < F; i++) {
      const tb = tbs[i];
      tb.until(tMgr + 0.3, fight ? 'duck' : workOf(this.stationKind(i))[0]);
      tb.hold(1.0, 'shock', { loop: false, held: undefined, tags: TAG.SWEAT });
    }
    ep.bubbles.push({ actor: (I + 1) % F, t0: tMgr + 0.4, t1: tMgr + 1.6, text: pick(r, LINES.uhoh) });
    // ---- kicks
    const kicked: number[] = [];
    const nk = fight ? 2 + (r() < 0.5 ? 1 : 0) : (r() < 0.6 ? 1 : 0);
    const pool = [...Array(F).keys()].sort((a, b) => (anchor[b].z - anchor[a].z) + (r() - 0.5));
    const aisleFirst = pool.filter((i) => anchor[i].distanceTo(this.stationPos(i)) > 0.5).concat(pool.filter((i) => anchor[i].distanceTo(this.stationPos(i)) <= 0.5));
    for (const g of aisleFirst) { if (kicked.length >= nk) break; if (!kicked.includes(g)) kicked.push(g); }
    kicked.sort((a, b) => mgr.p.distanceTo(anchor[a]) - mgr.p.distanceTo(anchor[b]));
    const KICK = this.d('mgr', 'Kick', 1.1);
    for (const g of kicked) {
      const at = anchor[g];
      const onStation = at.distanceTo(this.stationPos(g)) < 0.3 && this.stationKind(g) !== 'drinks';
      let land: V3;
      if (onStation) land = V(at.x + (r() - 0.5) * 1.4, 0, fz + (r() - 0.5) * 0.4);
      else { const side = r() < 0.5 ? -1 : 1; land = V(at.x + side * (2.2 + r() * 1.2), 0, at.z + (r() - 0.5) * 0.6); }
      this.inZone(land);
      const dir = flat(land).sub(flat(at)).normalize();
      const k = flat(at).addScaledVector(dir, -0.72);
      mgr.go(route(room, flat(mgr.p), k), 2.2, 'StompIn');
      mgr.face(yawTo(k, flat(at)), 'Idle_Loop', 0.2);
      const kk = mgr.hold(KICK, 'Kick', { loop: false });
      const imp = kk.t0 + KICK * 0.4;
      ep.bubbles.push({ actor: F, t0: kk.t0, t1: kk.t1 + 0.3, text: pick(r, LINES.kick), loud: true });
      const tb = tbs[g];
      tb.until(imp, 'cower', { tags: TAG.SWEAT });
      tb.fly(land, 1.05, 1.1 + r() * 0.5, 1 + Math.floor(r() * 2), 'tumble', { held: undefined, tags: 0 });
      ep.bubbles.push({ actor: g, t0: imp, t1: imp + 1.0, text: pick(r, LINES.hit) });
      ep.puffs.push({ t: imp + 1.05, pos: land.clone().add(V(0, 0.2, 0)), kind: 'dust', size: 0.7 });
      tb.hold(2.2 + r() * 0.8, 'dazed', { tags: TAG.STARS });
      tb.hold(0.9, 'getup', { loop: false });
    }
    // ---- back to work, the manager leaves
    mgr.go(route(room, flat(mgr.p), yell.pos), 2.0, 'StompIn');
    mgr.face(yell.yaw, 'Point', 0.2);
    const tBack = mgr.t;
    mgr.hold(1.8, 'Point');
    ep.bubbles.push({ actor: F, t0: tBack, t1: tBack + 1.9, text: pick(r, LINES.back), loud: true });
    mgr.go(route(room, flat(mgr.p), inside), 2.0, 'StompIn');
    mgr.go([room.mgrEnter ?? inside], 1.4, 'Walk_Formal_Loop');
    const tIn = mgr.t;
    ep.office.push([tIn - 0.3, 1], [tIn + 0.05, 0]);
    mgr.hide(tIn + 999);
    // non-kicked frogs scramble home (and two of them grab mops afterwards)
    const cleaners = [...Array(F).keys()].filter((i) => !kicked.includes(i)).sort(() => r() - 0.5).slice(0, 2);
    for (let i = 0; i < F; i++) {
      const tb = tbs[i];
      if (!kicked.includes(i)) tb.until(tBack + 0.3 + r() * 0.5, 'cower', { tags: TAG.SWEAT });
    }
    // splats: the cleaners take them (nearest first); ceiling ones drip away by themselves
    const floorSplats = ep.splats.map((s, k) => ({ s, k })).filter((x) => !x.s.ceil);
    ep.splats.forEach((s) => { if (s.ceil) { s.c0 = tBack + 3 + r() * 6; s.c1 = s.c0 + 3; } });
    const lists: number[][] = cleaners.map(() => []);
    floorSplats.sort((a, b) => a.s.pos.x - b.s.pos.x).forEach((x, n) => { if (lists.length) lists[n < floorSplats.length / 2 ? 0 : lists.length - 1].push(x.k); });
    cleaners.forEach((i, c) => {
      const tb = tbs[i];
      tb.until(tBack + 1.2, 'cower');
      if (lists[c].length) { this.down(tb, i); this.mopRound(ep, tb, lists[c]); }
    });
    // everyone home
    for (let i = 0; i < F; i++) { const tb = tbs[i]; this.home(tb, i, cleaners.includes(i) ? 2.0 : 3.0, cleaners.includes(i) ? 'walk' : 'run'); this.work(tb, i, tb.t + 0.5); }
    const end = Math.max(...tbs.map((t) => t.t), tIn) + 0.3;
    for (let i = 0; i < F; i++) this.work(tbs[i], i, end);
    ep.tracks = [...tbs, mgr, new TB(0, room.bruteEnter?.clone() ?? V(), 0)].map((tb) => ({ segs: tb.segs, overlays: tb.overlays }));
    ep.tracks[F + 1].segs = [{ t0: 0, t1: end, clip: 'Idle_Loop', loop: true, a: room.bruteEnter?.clone() ?? V(), b: room.bruteEnter?.clone() ?? V(), yaw0: 0, yaw1: 0, hidden: true }];
    ep.dur = end;
    return ep;
  }

  // ------------------------------------------------------------------------------------------ RIOT
  planRiot(id: string, seed: number): Episode {
    const r = rng(hash32(seed, id, 'riot'));
    const room = this.room, F = Math.min(this.ctx.frogs, room.stations.length);
    const ep = this.newEp('riot', id);
    const tbs = Array.from({ length: F }, (_, i) => this.frogTB(i));
    const used = new Set<number>();
    const tB = 15 + r() * 3;
    // 0: the snap
    for (let i = 0; i < F; i++) tbs[i].hold(1.0, 'shock', { loop: false, held: undefined });
    ep.bubbles.push({ actor: Math.floor(r() * F), t0: 0.4, t1: 3.2, text: pick(r, LINES.riot), loud: true });
    for (const tb of tbs) tb.tags = TAG.RAGE | TAG.ANGER;
    ep.softserve = [3 + r() * 2, 12 + r() * 3];
    const fz = this.frontZ();
    const climber = Math.floor(r() * F);
    let trashFrog = -1;
    if (room.trash && room.trashBase) trashFrog = (climber + 1 + Math.floor(r() * (F - 1))) % F;
    for (let i = 0; i < F; i++) {
      const tb = tbs[i];
      if (i === climber && this.stationKind(i) !== 'drinks') {
        const st = this.stationPos(i), yaw = this.stationYaw(i);
        const top = V(st.x + Math.sin(yaw) * 0.55, 0.92, st.z + Math.cos(yaw) * 0.55);
        tb.fly(top, 0.6, 0.55, 0, 'riot');
        ep.bubbles.push({ actor: i, t0: tb.t, t1: tb.t + 2, text: 'ON THE GRILL!!' });
        tb.until(tB, 'riot');
        continue;
      }
      this.down(tb, i);
      if (i === trashFrog && room.trashBase) {
        const tp = room.trashBase.pos.clone();
        const a = this.inZone(tp.clone().add(V(-0.6, 0, 0.3)));
        tb.go(route(room, flat(tb.p), a), 3.4, 'run');
        tb.face(yawTo(a, tp), 'pound', 0.2);
        const s = tb.hold(1.1, 'pound');
        ep.trash.push([s.t0 + 0.5, 0], [s.t0 + 0.9, 1]);
        ep.puffs.push({ t: s.t0 + 0.9, pos: tp.clone().add(V(0.3, 0.3, 0.3)), kind: 'dust', size: 0.8 });
      }
      let n = 0;
      while (tb.t < tB - 0.4 && n++ < 40) {
        const a = r(), room_ = room;
        if (a < 0.3) {
          const q = room_.nav[Math.floor(r() * room_.nav.length)].clone();
          q.x += (r() - 0.5) * 0.6; q.z += (r() - 0.5) * 0.6; this.inZone(q);
          const pts = route(room_, flat(tb.p), q);
          let L = 0; for (let k = 1; k < pts.length; k++) L += pts[k].distanceTo(pts[k - 1]);
          L += pts[0].distanceTo(tb.p);
          if (tb.t + L / 3.4 > tB - 0.2) { tb.until(tB, 'riot'); break; }
          tb.go(pts, 3.4, 'run');
        } else if (a < 0.62) {
          if (tb.t + 0.9 > tB) break;
          const sp = ep.splats.length < 22 ? this.splatFor(ep, r, tb.p, 0, used, 6) : null;
          if (sp) { const ta = this.throwAt(ep, tb, r, sp, false); ep.splats[ep.splats.length - 1].t = ta; }
          else this.throwAt(ep, tb, r, tb.p.clone().add(V(r() * 4 - 2, 3.5, r() * 2 - 1)), false);
        } else if (a < 0.82) tb.hold(Math.min(tB - tb.t, 1.2 + r() * 1.2), 'riot');
        else tb.hold(Math.min(tB - tb.t, 1.0 + r()), 'pound');
      }
      tb.until(tB, 'riot');
    }
    ep.alarm = [0.3, 0];
    ep.shots.push([0.4, 6, 'CAM_RIOT'], [6, tB - 0.5, 'CAM_KITCHEN']);
    // ---- the freezer door blows open
    const brute = new TB(0, room.bruteEnter?.clone() ?? V(), 0);
    const fNav = room.nav[room.bruteNav]?.clone() ?? V();
    brute.hide(tB - 0.25);
    brute.p = room.bruteEnter?.clone() ?? fNav.clone(); brute.yaw = yawTo(brute.p, fNav);
    ep.freezer.push([tB - 0.01, 0], [tB + 0.12, 1.1], [tB + 0.45, 0.98]);
    ep.puffs.push({ t: tB + 0.05, pos: fNav.clone().lerp(brute.p, 0.6).add(V(0, 1.1, 0)), kind: 'frost', size: 1.8 });
    ep.climax = tB;
    const roar = room.bruteRoar ?? { pos: fNav.clone(), yaw: 0 };
    brute.go(route(room, flat(brute.p), roar.pos), 5.0, 'Sprint_Loop');
    brute.face(roar.yaw, 'Flex', 0.2);
    const tf = brute.t;
    brute.hold(1.7, 'Flex');
    ep.bubbles.push({ actor: F + 1, t0: tf, t1: tf + 1.8, text: LINES.brute[0], loud: true });
    ep.shots.push([tB - 0.3, tf + 1.7, 'CAM_FREEZER']);
    // the crew: frozen in place, raging (or cowering) until he reaches them
    for (const tb of tbs) tb.hold(0.8, 'shock', { loop: false, held: undefined, tags: TAG.RAGE | TAG.SWEAT });
    const where = tbs.map((tb) => tb.p.clone());
    const order: number[] = [];
    const left = new Set([...Array(F).keys()]);
    let cur = brute.p.clone();
    while (left.size) { let b = -1, d = Infinity; left.forEach((i) => { const dd = flat(where[i]).distanceTo(flat(cur)); if (dd < d) { d = dd; b = i; } }); order.push(b); left.delete(b); cur = where[b]; }
    const ATT = [
      { clip: 'Kick', imp: 0.4, d: this.d('brute', 'Kick', 1.1) },
      { clip: 'Punch_Cross', imp: 0.42, d: this.d('brute', 'Punch_Cross', 1.0) },
      { clip: 'Melee_Hook', imp: 0.45, d: this.d('brute', 'Melee_Hook', 1.1) },
      { clip: 'Roundhouse', imp: 0.33, d: this.d('brute', 'Roundhouse', 1.2) },
      { clip: 'Shield_Dash', imp: 0.35, d: this.d('brute', 'Shield_Dash', 1.2) },
      { clip: 'Slide', imp: 0.5, d: 1.3 },
    ];
    for (let n = 0; n < order.length; n++) {
      const g = order[n], at = where[g];
      const high = at.y > 0.6;
      const onStation = at.distanceTo(this.stationPos(g)) < 0.3 && this.stationKind(g) !== 'drinks';
      let dir: V3;
      if (high) dir = V(0, 0, -1);
      else if (onStation) dir = V(0, 0, 1);
      else { dir = flat(at).sub(flat(brute.p)); if (dir.lengthSq() < 1e-3) dir.set(1, 0, 0); dir.normalize(); }
      const att = high ? ATT[1] : ATT[n === order.length - 1 ? 3 : Math.floor(r() * ATT.length)];
      const k = high ? V(at.x, 0, at.z + 0.85) : flat(at).addScaledVector(dir, att.clip === 'Slide' ? -2.0 : att.clip === 'Shield_Dash' ? -1.4 : -0.85);
      if (high) dir.set(0, 0, -1);
      this.inZone(k);
      const pts = route(room, flat(brute.p), k);
      const far = brute.p.distanceTo(k) > 1.6;
      brute.go(pts, far ? 5.0 : 3.8, far ? 'Sprint_Loop' : 'Jog_Fwd_Loop');   // = the clips' stride speed (no foot sliding)
      const yaw = yawTo(k, flat(at));
      brute.face(yaw, 'Idle_Loop', 0.15);
      let imp: number;
      if (att.clip === 'Slide') {
        const endP = this.inZone(flat(at).addScaledVector(dir, 1.0));
        const s0 = brute.t;
        brute.push({ clip: 'Slide_Start', dur: this.d('brute', 'Slide_Start', 0.5), loop: false, a: k, b: k.clone().lerp(endP, 0.35), yaw0: yaw, yaw1: yaw });
        brute.push({ clip: 'Slide_Loop', dur: 0.5, a: brute.p, b: endP, yaw0: yaw, yaw1: yaw });
        brute.push({ clip: 'Slide_Exit', dur: this.d('brute', 'Slide_Exit', 0.6), loop: false, yaw0: yaw, yaw1: yaw });
        imp = s0 + this.d('brute', 'Slide_Start', 0.5) + 0.2;
      } else if (att.clip === 'Shield_Dash') {
        const endP = this.inZone(flat(at).addScaledVector(dir, -0.2));
        const s = brute.push({ clip: 'Shield_Dash', dur: att.d, loop: false, a: k, b: endP, yaw0: yaw, yaw1: yaw });
        imp = s.t0 + att.d * att.imp;
      } else {
        const s = brute.hold(att.d, att.clip, { loop: false });
        imp = s.t0 + att.d * att.imp;
      }
      if (n % 2 === 1) ep.bubbles.push({ actor: F + 1, t0: imp - 0.5, t1: imp + 1.0, text: pick(r, LINES.brute.slice(1)), loud: true });
      // the frog: rages / cowers until the hit, then flies
      const tb = tbs[g];
      tb.until(imp, r() < 0.5 ? 'riot' : 'cower', { tags: TAG.RAGE | TAG.ANGER });
      const cands = room.nav.map((q) => q.clone()).concat(Array.from({ length: 6 }, () => V(room.zone.min.x + r() * (room.zone.max.x - room.zone.min.x), 0, room.zone.min.z + r() * (room.zone.max.z - room.zone.min.z))))
        .filter((q) => { const d = flat(q).sub(flat(at)); const L = d.length(); return L > 2 && L < 4.8 && d.normalize().dot(dir) > 0.35; });
      const land = this.inZone(cands.length ? cands[Math.floor(r() * cands.length)] : flat(at).addScaledVector(dir, 3));
      tb.fly(land, 1.2, 1.4 + r() * 0.6, 1 + Math.floor(r() * 3), 'tumble', { tags: 0 });
      ep.bubbles.push({ actor: g, t0: imp, t1: imp + 1.1, text: pick(r, LINES.hit) });
      ep.puffs.push({ t: imp, pos: at.clone().add(V(0, 0.6, 0)), kind: 'dust', size: 0.6 }, { t: imp + 1.2, pos: land.clone().add(V(0, 0.2, 0)), kind: 'dust', size: 0.8 });
      tb.hold(0.1, 'dazed', { tags: TAG.STARS });
    }
    // victory + back into the freezer
    brute.go(route(room, flat(brute.p), roar.pos), 3.8, 'Jog_Fwd_Loop');
    brute.face(roar.yaw, 'Dance_Loop', 0.2);
    const tv = brute.t;
    brute.hold(2.8, 'Dance_Loop');
    ep.bubbles.push({ actor: F + 1, t0: tv, t1: tv + 2.8, text: pick(r, LINES.done), loud: true });
    const doorIn = fNav.clone().lerp(room.bruteEnter ?? fNav, 0.45);
    brute.go(route(room, flat(brute.p), fNav), 1.35, 'Walk_Loop');
    brute.go([doorIn, room.bruteEnter ?? doorIn], 1.3, 'Walk_Loop');
    const tIn = brute.t;
    ep.freezer.push([tIn - 0.4, 1], [tIn + 0.1, 0]);
    brute.hide(tIn + 999);
    ep.alarm = [0.3, tv + 1];
    ep.shots.push([tf + 1.7, tv + 2.8, 'CAM_RIOT']);
    ep.climax = tv;
    // ---- wake up + the big cleanup (every splat, the trash can)
    const tWake = tv + 1.2;
    for (let i = 0; i < F; i++) { const tb = tbs[i]; tb.until(tWake + r() * 2.0, 'dazed', { tags: TAG.STARS }); tb.hold(0.9, 'getup', { loop: false, tags: 0 }); }
    ep.splats.forEach((s) => { if (s.ceil) { s.c0 = tWake + 2 + r() * 8; s.c1 = s.c0 + 3; } });
    const floor = ep.splats.map((s, k) => ({ s, k })).filter((x) => !x.s.ceil);
    const lists: number[][] = tbs.map(() => []);
    floor.forEach((x) => { let b = 0, d = Infinity; tbs.forEach((tb, i) => { const dd = tb.p.distanceTo(x.s.pos) + lists[i].length * 2.5; if (dd < d) { d = dd; b = i; } }); lists[b].push(x.k); });
    if (trashFrog >= 0 && room.trashBase) {
      const tb = tbs[trashFrog], tp = room.trashBase.pos;
      const a = this.inZone(tp.clone().add(V(-0.6, 0, 0.3)));
      tb.go(route(room, flat(tb.p), a), 1.8, 'walk');
      tb.face(yawTo(a, tp), 'pickup', 0.2);
      const s = tb.hold(1.4, 'pickup', { loop: false });
      ep.trash.push([s.t0 + 0.5, 1], [s.t0 + 1.0, 0]);
    }
    for (let i = 0; i < F; i++) if (lists[i].length) this.mopRound(ep, tbs[i], lists[i]);
    for (let i = 0; i < F; i++) this.home(tbs[i], i, 2.0, 'walk');
    const end = Math.max(...tbs.map((t) => t.t), tIn) + 0.5;
    for (let i = 0; i < F; i++) this.work(tbs[i], i, end);
    ep.tracks = [...tbs, new TB(0, room.mgrEnter?.clone() ?? V(), 0), brute].map((tb) => ({ segs: tb.segs, overlays: tb.overlays }));
    ep.tracks[F].segs = [{ t0: 0, t1: end, clip: 'Idle_Loop', loop: true, a: room.mgrEnter?.clone() ?? V(), b: room.mgrEnter?.clone() ?? V(), yaw0: 0, yaw1: 0, hidden: true }];
    ep.dur = end;
    return ep;
  }
}

// ---------------------------------------------------------------------------------------------------- sampling
export interface Sample {
  pos: V3; yaw: number; hidden: boolean;
  clip: string; time: number;
  prev: string | null; prevTime: number; w: number;         // cross-fade from the previous segment
  over: string | null; overTime: number; overW: number;     // hit flinch overlay
  held?: string; tags: number;
  spin: number; spinAxis: V3 | null;
}

const tmpA = V(), tmpB = V();
function segPos(s: Seg, t: number, out: V3) {
  const u = THREE.MathUtils.clamp((t - s.t0) / Math.max(1e-6, s.t1 - s.t0), 0, 1);
  if (s.path && s.plen) {
    const L = s.plen[s.plen.length - 1] * u;
    let k = 1;
    while (k < s.plen.length - 1 && s.plen[k] < L) k++;
    const f = (L - s.plen[k - 1]) / Math.max(1e-6, s.plen[k] - s.plen[k - 1]);
    return out.copy(s.path[k - 1]).lerp(s.path[k], THREE.MathUtils.clamp(f, 0, 1));
  }
  out.copy(s.a).lerp(s.b, u);
  if (s.arc) out.y += 4 * s.arc.h * u * (1 - u);
  return out;
}
function segYaw(s: Seg, t: number, pos: V3): number {
  if (s.path && s.plen) {
    const e = segPos(s, Math.min(s.t1, t + 0.12), tmpB), dx = e.x - pos.x, dz = e.z - pos.z;
    if (dx * dx + dz * dz > 1e-5) return Math.atan2(dx, dz);
    return s.yaw1;
  }
  const dur = s.turn ?? (s.t1 - s.t0);
  const u = THREE.MathUtils.clamp((t - s.t0) / Math.max(1e-6, dur), 0, 1);
  let d = s.yaw1 - s.yaw0;
  d = Math.atan2(Math.sin(d), Math.cos(d));
  const e = u * u * (3 - 2 * u);
  return s.yaw0 + d * e;
}

export function sampleTrack(tr: Track, t: number, out?: Sample): Sample | null {
  const segs = tr.segs;
  if (!segs.length) return null;
  let i = 0;
  // segments are contiguous and sorted: binary search
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m - 1; }
  i = lo;
  const s = segs[i];
  const o = out ?? ({ pos: V(), yaw: 0, hidden: false, clip: '', time: 0, prev: null, prevTime: 0, w: 1, over: null, overTime: 0, overW: 0, tags: 0, spin: 0, spinAxis: null } as Sample);
  const tt = THREE.MathUtils.clamp(t, s.t0, s.t1);
  segPos(s, tt, o.pos);
  o.yaw = segYaw(s, tt, o.pos);
  o.hidden = !!s.hidden;
  o.clip = s.clip; o.time = (tt - s.t0) + (s.off ?? 0);
  o.held = s.held; o.tags = s.tags ?? 0;
  o.prev = null; o.w = 1;
  const FADE = s.clip === 'tumble' || s.clip === 'hit' ? 0.08 : 0.22;
  if (i > 0 && tt - s.t0 < FADE) {
    const p = segs[i - 1];
    if (p.clip !== s.clip) { o.prev = p.clip; o.prevTime = (p.t1 - p.t0) + (p.off ?? 0) + (tt - s.t0); o.w = (tt - s.t0) / FADE; }
  }
  o.spin = 0; o.spinAxis = null;
  if (s.arc && s.arc.spin) {
    const u = (tt - s.t0) / Math.max(1e-6, s.t1 - s.t0);
    o.spin = u * s.arc.spin * Math.PI * 2;
    const d = tmpA.copy(s.b).sub(s.a); d.y = 0;
    if (d.lengthSq() < 1e-6) d.set(0, 0, 1);
    d.normalize();
    o.spinAxis = V(d.z, 0, -d.x);
  }
  o.over = null; o.overW = 0;
  for (const ov of tr.overlays) {
    if (t >= ov.t && t <= ov.t + ov.dur) {
      o.over = ov.clip; o.overTime = t - ov.t;
      const e = Math.min(1, (t - ov.t) / 0.06, (ov.t + ov.dur - t) / 0.15);
      o.overW = Math.max(0, e);
    }
  }
  return o;
}

/** Keyframed scalar (door open 0..1, trash tip 0..1): piecewise linear, holds the last value. */
export function keyAt(keys: Keys, t: number, dflt = 0): number {
  if (!keys.length || t < keys[0][0]) return dflt;
  for (let i = keys.length - 1; i >= 0; i--) {
    if (t >= keys[i][0]) {
      const n = keys[i + 1];
      if (!n) return keys[i][1];
      const u = (t - keys[i][0]) / Math.max(1e-6, n[0] - keys[i][0]);
      return keys[i][1] + (n[1] - keys[i][1]) * u;
    }
  }
  return dflt;
}
