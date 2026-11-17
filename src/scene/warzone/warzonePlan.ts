// The warzone's timeline: a pure function of (room anchors, seed, wall clock, the host's timed events). Every page asks
// "what is happening at t?" and gets the same answer, so the OBS page, the studio preview and party guests all see the
// same shell land in the same place at the same moment; a page opened late simply shows the smoke already rising.
//
// Pacing (never a constant blur): the clock is cut into cycles of ~3–4 min, each a LULL (distant thumps, a tracer
// burst on the skyline, a drone), a BUILD (mortars creep closer, RPGs, a technical, the sniper starts), a PEAK (a walking
// barrage, air strikes on the skyline, a gunship pass) and an AFTERMATH (burning, drifting smoke). Every cycle has its own
// seeded lengths + peak height. Night adds illumination flares and AA fire; "calm" holds everything but the quietest.
import * as THREE from 'three';
import { hash32, Rng } from '../raid/rng.ts';
import { safeAt, type Box, type V, type WzAnchors } from './warzoneRoom.ts';

export type Kind = 'mortar' | 'rpg' | 'burst' | 'skystrike' | 'heli' | 'jet' | 'technical' | 'flare' | 'aaa' | 'sniper' | 'drone' | 'barrage'
  | 'armor' | 'airstrike' | 'assault' | 'cannon' | 'rocket';
export interface Ev {
  id: string; kind: Kind; t0: number; dur: number; seed: number; mag: number;
  p: V; q?: V; path?: V[]; big?: boolean; user?: string; amount?: string; label?: string;
  /** Faction firing (bursts): 'frog' = orange-red tracers, 'militia' = green. */
  side?: 'frog' | 'militia';
  /** The technical: where it gets hit (0..1 along its route), -1 = it escapes. */
  kill?: number;
}
const DUR: Record<Kind, number> = {
  mortar: 45, rpg: 28, burst: 2.2, skystrike: 170, heli: 34, jet: 9, technical: 95, flare: 48, aaa: 4, sniper: 2, drone: 70, barrage: 16,
  armor: 70, airstrike: 180, assault: 90, cannon: 40, rocket: 30,
};
export interface Phase { name: 'lull' | 'build' | 'peak' | 'after'; k: number; start: number; end: number; peak: number }
const BUCKET = 1;
const LOUD = new Set<Kind>(['mortar', 'rpg', 'barrage', 'technical', 'heli', 'jet', 'skystrike', 'sniper', 'drone']);
const LOOKBACK = 185;

export class WarzonePlan {
  /** Ambient level (scene.json warzone.level, 0.25 … 2). */
  level = 1;
  private cache = new Map<number, Ev[]>();
  constructor(readonly A: WzAnchors, readonly seed: number) {}

  /** The cycle + phase at t (s). */
  phase(t: number): Phase {
    const CYC = 210;
    const k = Math.floor(t / CYC);
    const r = new Rng(hash32(this.seed, k, 'cyc'));
    const lull = r.range(70, 115), build = r.range(30, 50), peak = r.range(16, 32);
    const peakH = r.range(0.75, 1);
    const s = k * CYC, u = t - s;
    if (u < lull) return { name: 'lull', k, start: s, end: s + lull, peak: peakH };
    if (u < lull + build) return { name: 'build', k, start: s + lull, end: s + lull + build, peak: peakH };
    if (u < lull + build + peak) return { name: 'peak', k, start: s + lull + build, end: s + lull + build + peak, peak: peakH };
    return { name: 'after', k, start: s + lull + build + peak, end: s + CYC, peak: peakH };
  }
  /** 0 … 1 battle intensity at t (smooth across phases). */
  intensity(t: number): number {
    const ph = this.phase(t);
    const u = (t - ph.start) / Math.max(1, ph.end - ph.start);
    const sm = (x: number) => x * x * (3 - 2 * x);
    switch (ph.name) {
      case 'lull': return 0.1 + 0.06 * Math.sin(u * 6.28);
      case 'build': return 0.12 + (ph.peak * 0.75 - 0.12) * sm(u);
      case 'peak': return ph.peak;
      default: return 0.18 + (ph.peak - 0.18) * (1 - sm(Math.min(1, u * 1.6)));
    }
  }

  // ---------------------------------------------------------------- ambient events per 1 s bucket (memoised)
  private bucket(b: number, night: boolean): Ev[] {
    const key = b * 2 + (night ? 1 : 0);
    const c = this.cache.get(key);
    if (c) return c;
    const out: Ev[] = [];
    const t = b * BUCKET;
    const I = Math.min(1.5, this.intensity(t) * this.level);
    const ph = this.phase(t);
    const A = this.A;
    const rate = (kind: string, r: number) => {
      const rng = new Rng(hash32(this.seed, b, kind));
      if (rng.next() >= r * BUCKET) return null;
      return rng;
    };
    const add = (kind: Kind, rng: Rng, e: Partial<Ev> & { p: V }) => out.push({ id: `${kind}:${b}`, kind, t0: t + rng.next() * BUCKET, dur: DUR[kind], seed: hash32(this.seed, b, kind, 's'), mag: 1, ...e });
    let r: Rng | null;
    // mortars / artillery landing in the street and the blocks beyond
    if ((r = rate('mortar', 0.003 + 0.07 * I * I))) { const p = this.inBoxes(A.impacts, r); if (p) add('mortar', r, { p, mag: r.range(0.7, 1.25) }); }
    if ((r = rate('rpg', 0.002 + 0.035 * I)) && A.rpg.length) { const s = A.rpg[r.int(A.rpg.length)]; add('rpg', r, { p: s.p.clone(), q: this.rpgTarget(s, r) }); }
    if ((r = rate('burst', 0.08 + 0.55 * I))) {
      const a = A.far[r.int(A.far.length)], bb = A.far[(r.int(A.far.length - 1) + 1 + A.far.indexOf(a)) % A.far.length];
      add('burst', r, { p: this.inBox(a, r), q: this.inBox(bb, r), side: r.chance(0.55) ? 'frog' : 'militia', mag: r.range(0.6, 1.2) });
    }
    if ((r = rate('sky', 0.0015 + 0.02 * I * I * I))) add('skystrike', r, { p: A.sky[r.int(A.sky.length)].clone(), mag: r.range(0.8, 1.6) });
    if (A.sniper && (r = rate('sniper', ph.name === 'lull' ? 0.012 : 0.05 * I))) add('sniper', r, { p: A.sniper.p.clone(), q: this.sniperTarget(r) });
    if (night) {
      if ((r = rate('flare', 0.01 + 0.025 * I))) add('flare', r, { p: this.flarePoint(r), mag: r.range(0.85, 1.2) });
      if ((r = rate('aaa', 0.02 + 0.08 * I))) add('aaa', r, { p: A.sky[r.int(A.sky.length)].clone().lerp(A.battle, 0.45), mag: r.range(0.7, 1.2) });
    }
    // once-per-cycle beats, placed by the cycle's own seed
    if (Math.floor(t) === Math.floor(ph.start) && ph.name === 'peak') {
      const rr = new Rng(hash32(this.seed, ph.k, 'peak'));
      out.push({ id: `barrage:${ph.k}`, kind: 'barrage', t0: ph.start + 1, dur: DUR.barrage, seed: hash32(this.seed, ph.k, 'bar'), mag: 1, p: this.inBoxes(A.impacts, rr) ?? A.battle.clone(), q: this.inBoxes(A.impacts, rr) ?? A.battle.clone() });
      out.push({ id: `sky:${ph.k}`, kind: 'skystrike', t0: ph.start + rr.range(4, 12), dur: DUR.skystrike, seed: hash32(this.seed, ph.k, 'sky'), mag: 1.8, p: A.sky[rr.int(A.sky.length)].clone() });
      if (rr.chance(0.55)) out.push({ id: `heli:${ph.k}`, kind: 'heli', t0: ph.start + rr.range(2, 10), dur: DUR.heli, seed: hash32(this.seed, ph.k, 'heli'), mag: 1, p: A.battle.clone(), path: A.fly[rr.int(A.fly.length)] });
      else out.push({ id: `jet:${ph.k}`, kind: 'jet', t0: ph.start + rr.range(2, 10), dur: DUR.jet, seed: hash32(this.seed, ph.k, 'jet'), mag: 1, p: A.battle.clone(), path: A.fly[rr.int(A.fly.length)] });
    }
    if (Math.floor(t) === Math.floor(ph.start) && ph.name === 'build') {
      const rr = new Rng(hash32(this.seed, ph.k, 'build'));
      if (rr.chance(0.6)) out.push({ id: `tech:${ph.k}`, kind: 'technical', t0: ph.start + rr.range(3, 20), dur: DUR.technical, seed: hash32(this.seed, ph.k, 'tech'), mag: 1, p: A.road[0].clone(), path: A.road, kill: rr.chance(0.7) ? rr.range(0.45, 0.7) : -1 });
    }
    if (Math.floor(t) === Math.floor(ph.start) && ph.name === 'lull') {
      const rr = new Rng(hash32(this.seed, ph.k, 'lull'));
      if (rr.chance(0.5)) out.push({ id: `drone:${ph.k}`, kind: 'drone', t0: ph.start + rr.range(5, 30), dur: DUR.drone, seed: hash32(this.seed, ph.k, 'drone'), mag: 1, p: A.battle.clone().addScaledVector(A.out, 10).setY(A.floorY + 32) });
    }
    this.cache.set(key, out);
    if (this.cache.size > 900) { const cut = [...this.cache.keys()].sort((a, b2) => a - b2).slice(0, 300); for (const k of cut) this.cache.delete(k); }
    return out;
  }

  /** Every event (ambient + stamped set pieces + their children) active at t. */
  active(t: number, night: boolean, calmSince: number | null, stamps: Ev[], ambient = true): Ev[] {
    const out: Ev[] = [];
    const b1 = Math.floor(t / BUCKET), b0 = b1 - Math.ceil(LOOKBACK / BUCKET);
    for (let b = ambient ? b0 : b1 + 1; b <= b1; b++) {
      for (const e of this.bucket(b, night)) {
        // calm: nothing loud STARTS (what already happened keeps burning / drifting); far tracers, flares, fires stay
        if (calmSince !== null && e.t0 >= calmSince - 1 && LOUD.has(e.kind)) continue;
        this.push(out, e, t);
      }
    }
    for (const e of stamps) this.push(out, e, t);
    return out;
  }
  private push(out: Ev[], e: Ev, t: number) {
    if (t >= e.t0 - 4 && t < e.t0 + e.dur) out.push(e);
    for (const c of this.children(e)) if (t >= c.t0 && t < c.t0 + c.dur) out.push(c);
  }

  /** Sub-events of composite set pieces (the barrage's shells, the air strike's bombs, the gunship's rockets …). */
  private kids = new Map<string, Ev[]>();
  children(e: Ev): Ev[] {
    const got = this.kids.get(e.id);
    if (got) return got;
    const r = new Rng(e.seed ^ 0x5bd1e995);
    const A = this.A;
    const out: Ev[] = [];
    const shell = (i: number, at: number, p: V, mag: number, kind: Kind = 'mortar') => out.push({ id: `${e.id}/${i}`, kind, t0: at, dur: DUR[kind], seed: hash32(e.seed, i), mag, p });
    const militia = A.sideB.length ? A.sideB : [A.battle];
    const pickB = () => { for (let k = 0; k < 8; k++) { const p = militia[r.int(militia.length)].clone().add(new THREE.Vector3(r.range(-3, 3), 0, r.range(-3, 3))); if (safeAt(A, p, 14)) return p; } return null; };
    switch (e.kind) {
      case 'barrage': {
        // a walking barrage: shells land along a line, 0.6–1.4 s apart
        const a = e.p, b = e.q ?? e.p;
        for (let i = 0; i < 9; i++) { const p = a.clone().lerp(b, i / 8).add(new THREE.Vector3(r.range(-4, 4), 0, r.range(-4, 4))); if (safeAt(A, p)) shell(i, e.t0 + i * r.range(0.6, 1.4), p, r.range(0.8, 1.3)); }
        break;
      }
      case 'airstrike': {
        // the jets come in (t0), four heavy bombs walk across the militia side 2 s later, then two on the skyline
        // a stick of four walking away down the street from the fight (in view of the breaches), well clear of the room
        const side = new THREE.Vector3(-A.out.z, 0, A.out.x);
        for (let i = 0; i < 4; i++) {
          const p = A.battle.clone().addScaledVector(A.out, 8 + i * 9).addScaledVector(side, r.range(-5, 5)).setY(A.floorY);
          if (safeAt(A, p, 28)) shell(i, e.t0 + 2.2 + i * 0.35, p, 1.5, 'skystrike');
        }
        for (let i = 0; i < 2; i++) shell(10 + i, e.t0 + 5 + i * 0.6, A.sky[r.int(A.sky.length)].clone(), 2.2, 'skystrike');
        break;
      }
      case 'heli': {
        // the gunship: two rocket pairs into the militia side + a gun run (bursts)
        for (let i = 0; i < 4; i++) { const p = pickB(); if (p && e.path) { const t0 = e.t0 + 12 + (i >> 1) * 3 + (i & 1) * 0.25; out.push({ id: `${e.id}/r${i}`, kind: 'rocket', t0, dur: DUR.rocket, seed: hash32(e.seed, 'r', i), mag: 1, p, q: this.along(e.path, Math.min(1, (t0 - e.t0) / e.dur)).add(new THREE.Vector3(0, -0.8, 0)) }); } }
        break;
      }
      case 'armor': {
        for (let i = 0; i < 6; i++) { const p = pickB(); if (p) { const t0 = e.t0 + 14 + i * r.range(4, 7), path = e.path ?? A.armor; out.push({ id: `${e.id}/c${i}`, kind: 'cannon', t0, dur: DUR.cannon, seed: hash32(e.seed, 'c', i), mag: 1.1, p: p.setY(p.y + r.range(0, 5)), q: this.along(path, Math.min(1, ((t0 - e.t0) * 5.5) / Math.max(1, this.pathLen(path)))).add(new THREE.Vector3(0, 2.7, 0)) }); } }
        break;
      }
      case 'assault': {
        // the militia's opening: mortars short of the frog side, RPGs; then the frogs' answer on the militia side
        const frogs = A.sideA.length ? A.sideA : [A.battle];
        for (let i = 0; i < 5; i++) { const p = frogs[r.int(frogs.length)].clone().addScaledVector(A.out, r.range(4, 12)); if (safeAt(A, p, 16)) shell(i, e.t0 + 2 + i * r.range(1.5, 3), p, 0.9); }
        for (let i = 0; i < 4; i++) if (A.rpg.length) { const s = A.rpg[r.int(A.rpg.length)]; out.push({ id: `${e.id}/g${i}`, kind: 'rpg', t0: e.t0 + 6 + i * r.range(3, 7), dur: DUR.rpg, seed: hash32(e.seed, 'g', i), mag: 1, p: s.p.clone(), q: this.rpgTarget(s, r) }); }
        for (let i = 0; i < 7; i++) { const p = pickB(); if (p) shell(20 + i, e.t0 + 40 + i * r.range(1, 2.2), p, 1.1); }
        break;
      }
      case 'technical': {
        if ((e.kill ?? -1) > 0) {
          // an RPG from the frog side hits it, then it burns
          out.push({ id: `${e.id}/hit`, kind: 'mortar', t0: e.t0 + this.routeTime(e) * (e.kill ?? 0.5), dur: DUR.mortar, seed: hash32(e.seed, 'hit'), mag: 0.9, p: this.along(e.path ?? A.road, e.kill ?? 0.5) });
        }
        break;
      }
      case 'flare': break;
      default: break;
    }
    this.kids.set(e.id, out);
    if (this.kids.size > 400) this.kids.delete(this.kids.keys().next().value!);
    return out;
  }

  /** Seconds the vehicle takes along its route (9 m/s). */
  routeTime(e: Ev) { return this.pathLen(e.path ?? this.A.road) / (e.kind === 'armor' ? 5.5 : 9); }
  pathLen(p: V[]) { let L = 0; for (let i = 1; i < p.length; i++) L += p[i].distanceTo(p[i - 1]); return L; }
  along(p: V[], u: number, out = new THREE.Vector3(), dir?: V): V {
    const L = this.pathLen(p);
    let d = Math.max(0, Math.min(1, u)) * L;
    for (let i = 1; i < p.length; i++) {
      const s = p[i].distanceTo(p[i - 1]);
      if (d <= s || i === p.length - 1) { out.copy(p[i - 1]).lerp(p[i], s > 0 ? Math.min(1, d / s) : 0); if (dir) dir.copy(p[i]).sub(p[i - 1]).normalize(); return out; }
      d -= s;
    }
    return out.copy(p[p.length - 1]);
  }

  // ---------------------------------------------------------------- helpers (all seeded)
  inBox(b: Box, r: Rng): V { return new THREE.Vector3(b.c.x + r.range(-1, 1) * b.h.x, b.c.y + r.range(-1, 1) * b.h.y, b.c.z + r.range(-1, 1) * b.h.z); }
  inBoxes(bs: Box[], r: Rng): V | null {
    for (let k = 0; k < 6; k++) { const b = bs[r.int(bs.length)]; const p = new THREE.Vector3(b.c.x + r.range(-1, 1) * b.h.x, b.c.y, b.c.z + r.range(-1, 1) * b.h.z); if (safeAt(this.A, p)) return p; }
    return null;
  }
  private rpgTarget(s: { p: V; dir: V; target: V | null }, r: Rng): V {
    if (s.target) return s.target.clone().add(new THREE.Vector3(r.range(-2, 2), r.range(-1, 2), r.range(-2, 2)));
    const A = this.A;
    const frogs = A.sideA.length ? A.sideA : [A.battle];
    for (let k = 0; k < 6; k++) { const p = frogs[r.int(frogs.length)].clone().add(new THREE.Vector3(r.range(-3, 3), r.range(0.5, 4), r.range(-3, 3))); if (safeAt(A, p, 14)) return p; }
    return s.p.clone().addScaledVector(s.dir, r.range(25, 50));
  }
  private sniperTarget(r: Rng): V {
    const A = this.A, m = A.sideB.length ? A.sideB : [A.battle];
    return m[r.int(m.length)].clone().add(new THREE.Vector3(r.range(-2, 2), r.range(0.3, 2), r.range(-2, 2)));
  }
  private flarePoint(r: Rng): V {
    const A = this.A;
    return A.battle.clone().addScaledVector(A.out, r.range(15, 55)).add(new THREE.Vector3(r.range(-25, 25), 0, r.range(-25, 25))).setY(A.floorY + r.range(55, 85));
  }
  /** A set piece stamped by the host (Stream Deck, a donation, a channel-point reward) as an event. */
  setPiece(kind: string, at: number, id: string, extra: { user?: string; amount?: string; big?: boolean } = {}): Ev | null {
    const A = this.A;
    const seed = hash32(this.seed, id, kind);
    const r = new Rng(seed);
    const base = { id: `sp:${id}`, t0: at, seed, mag: 1, user: extra.user, amount: extra.amount, big: extra.big };
    switch (kind) {
      case 'wz_airstrike': return { ...base, kind: 'airstrike', dur: DUR.airstrike, p: A.battle.clone(), path: A.fly[r.int(A.fly.length)], label: 'AIR STRIKE' };
      case 'wz_mortar': return { ...base, kind: 'barrage', dur: DUR.barrage, p: this.inBoxes(A.impacts, r) ?? A.battle.clone(), q: this.inBoxes(A.impacts, r) ?? A.battle.clone(), label: 'FIRE MISSION' };
      case 'wz_heli': return { ...base, kind: 'heli', dur: DUR.heli, p: A.battle.clone(), path: A.fly[r.int(A.fly.length)], label: 'GUNSHIP' };
      case 'wz_armor': return { ...base, kind: 'armor', dur: DUR.armor, p: A.armor[0].clone(), path: A.armor, label: 'ARMOURED PUSH' };
      case 'wz_technical': return { ...base, kind: 'technical', dur: DUR.technical, p: A.road[0].clone(), path: [...A.road].reverse(), kill: r.range(0.45, 0.65), label: 'TECHNICAL' };
      case 'wz_flare': return { ...base, kind: 'flare', dur: DUR.flare, p: this.flarePoint(r), mag: 1.3, label: 'ILLUMINATION' };
      case 'wz_sniper': return A.sniper ? { ...base, kind: 'sniper', dur: 14, p: A.sniper.p.clone(), q: this.sniperTarget(r), mag: 5, label: 'SNIPER' } : null;
      case 'wz_assault': return { ...base, kind: 'assault', dur: DUR.assault, p: A.battle.clone(), label: 'ASSAULT REPELLED' };
      default: return null;
    }
  }
}

export const SET_PIECES = ['wz_airstrike', 'wz_armor', 'wz_assault', 'wz_technical', 'wz_mortar', 'wz_heli', 'wz_flare', 'wz_sniper'] as const;
export const SET_PIECE_LABELS: Record<(typeof SET_PIECES)[number], string> = {
  wz_airstrike: 'Air strike', wz_armor: 'Armoured push', wz_assault: 'Militia assault (repelled)', wz_technical: 'Technical', wz_mortar: 'Mortar barrage',
  wz_heli: 'Gunship pass', wz_flare: 'Illumination flares', wz_sniper: 'Frog sniper',
};
/** Default donation tiers (USD): the biggest set piece whose minimum the support meets. */
export const DEFAULT_SUPPORT: Record<string, number> = { wz_mortar: 0, wz_technical: 3, wz_heli: 5, wz_armor: 20, wz_assault: 50, wz_airstrike: 100 };
