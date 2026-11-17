// Raceway — episodes outside the glass, DETERMINISTIC and closed-form like the space battle director: every episode
// is planned from hash(seed, id) + the room's anchors and then SAMPLED at (now − start): no simulation state, so every
// OBS page / party guest draws the same fight, and a page opened mid-fight shows mid-fight.
//
//   skirmish   bounty hunters jump in (white / blue HUNTERs), the station scrambles its BRAWLERs from the hangar, duels in
//              the battle zone (tracers, missiles, shield hits), turrets on the rock join in, kills + drifting wrecks,
//              survivors jump out, brawlers fly home into the hangar
//   armada     the same with a raider GUNSHIP (it shells the station: impacts + shield flashes by the glass) and pirate
//              BRICKs joining; the gunship is torn apart in three burning pieces; the lounge goes to red alert
//   salute     three brawlers in formation past the glass, a barrel roll and flares (subs / members)
//   lap        a showboat racer slow-rolls past the glass trailing a banner with the supporter's name (tips)
import * as THREE from 'three';
import { hash32, Rng } from '../../raid/rng.ts';
import { SPRITE, type SpaceFx } from '../fx.ts';
import type { RacewayShips, RwShipMeta } from './racewayShips.ts';
import type { RacewayRoom } from './racewayRoom.ts';
import { orient } from './race.ts';
import { govern, pageGovernor, safeAmp } from '../../../../shared/flashGovernor.ts';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3;
const UP = V(0, 1, 0);

export interface BFrame {
  t: number; ships: RacewayShips; fx: SpaceFx;
  alarm: number; flash: number; shake: number;
  pa: { key: string; text: string; tone: 'alert' | 'info' | 'cheer' }[];
  labels: { key: string; text: string; sub: string; pos: V3; alpha: number; kind: 'banner' | 'label'; fwd?: V3 }[];
  moments: { key: string; what: string }[];
  cam: { key: string; name: string } | null;
  detail: number;
}

function bez(p0: V3, p1: V3, p2: V3, p3: V3, u: number, out = V()) {
  const a = 1 - u;
  return out.set(0, 0, 0).addScaledVector(p0, a * a * a).addScaledVector(p1, 3 * a * a * u).addScaledVector(p2, 3 * a * u * u).addScaledVector(p3, u * u * u);
}
class Loop {
  readonly curve: THREE.CatmullRomCurve3; readonly L: number;
  constructor(pts: V3[]) { this.curve = new THREE.CatmullRomCurve3(pts, true, 'centripetal'); this.curve.arcLengthDivisions = 120; this.L = this.curve.getLength(); }
  at(s: number, o = V()) { return this.curve.getPointAt((((s / this.L) % 1) + 1) % 1, o); }
  tan(s: number, o = V()) { return this.curve.getTangentAt((((s / this.L) % 1) + 1) % 1, o); }
}

/** A flight leg: cubic bezier (t0..t1) or a loop in the zone (s = s0 + v·(t − t0)). */
type Leg = { t0: number; t1: number; bez?: [V3, V3, V3, V3]; loop?: Loop; s0?: number; v?: number; roll?: number };
export interface BShip {
  id: number; kind: string; side: 'raider' | 'defender'; c1: THREE.Color; c2: THREE.Color; legs: Leg[];
  tIn: number; tOut: number; warpIn?: number; warpOut?: number; hangarIn?: number; death?: number; big?: boolean; scale?: number;
}
interface Burst { ship: number; target: number; t: number; n: number; gun: number; hit: boolean; col: [number, number, number] }
interface Missile { ship: number; target: number; t: number; dur: number; side: number }
interface StationHit { t: number; p: V3; shield: boolean }
export interface Episode {
  key: string; kind: string; start: number; dur: number; seed: number; user?: string; amount?: string;
  ships: BShip[]; bursts: Burst[]; missiles: Missile[]; hits: StationHit[]; turretShots: { turret: number; target: number; t: number }[];
  alarm: [number, number] | null; cams: [number, number, string][]; pa: [number, string, 'alert' | 'info' | 'cheer'][];
  breakup?: { t: number; pieces: { kind: string; off: V3; vel: V3; spin: V3 }[] };
  /** salute: every ship pops decoy flares between t0 and t1 */
  flares?: { t0: number; t1: number };
}

const PIRATE: [string, string][] = [['#c9a227', '#2a2d31'], ['#b8621e', '#2a2d31'], ['#8a8a3a', '#1a1a1a'], ['#c9a227', '#6a1e1a']];
const LAW: [string, string][] = [['#e6eaee', '#2a5ab8'], ['#e6eaee', '#1a3a7a'], ['#d8dde2', '#b8321e']];

export class Battles {
  private cache = new Map<string, Episode | null>();
  constructor(readonly R: RacewayRoom, readonly meta: Record<string, RwShipMeta>, readonly seed: number) {}

  plan(kind: string, id: string, start: number, extra: { user?: string; amount?: string } = {}): Episode | null {
    const key = `${kind}:${id}:${start}`;
    const c = this.cache.get(key);
    if (c !== undefined) return c;
    let ep: Episode | null = null;
    try {
      const seed = hash32(this.seed, id, kind);
      if (kind === 'skirmish' || kind === 'armada') ep = this.planBattle(kind, key, start, seed, extra);
      else if (kind === 'salute') ep = this.planSalute(key, start, seed, extra);
      else if (kind === 'lap') ep = this.planLap(key, start, seed, extra);
    } catch (e) { console.warn('[raceway] plan failed', kind, e); ep = null; }
    this.cache.set(key, ep);
    if (this.cache.size > 48) this.cache.delete(this.cache.keys().next().value!);
    return ep;
  }

  // ---------------------------------------------------------------------------------------------- battles
  private zonePoint(r: Rng, shrink = 0.8) {
    const z = this.R.zone, c = z.getCenter(V()), s = z.getSize(V()).multiplyScalar(shrink / 2);
    return V(c.x + r.range(-s.x, s.x), c.y + r.range(-s.y, s.y), c.z + r.range(-s.z, s.z));
  }
  private duelLoop(r: Rng) {
    const c = this.zonePoint(r, 0.55);
    const pts: V3[] = [];
    const n = 6, rad = r.range(90, 190);
    const tilt = V(r.range(-0.4, 0.4), 1, r.range(-0.4, 0.4)).normalize();
    const u = V().crossVectors(tilt, V(0, 0, 1)).normalize(), w = V().crossVectors(tilt, u).normalize();
    const a0 = r.next() * 6.283;
    for (let i = 0; i < n; i++) { const a = a0 + (i / n) * 6.283; const rr = rad * r.range(0.7, 1.3); pts.push(c.clone().addScaledVector(u, Math.cos(a) * rr * 1.5).addScaledVector(w, Math.sin(a) * rr).addScaledVector(tilt, r.range(-40, 40))); }
    return new Loop(pts);
  }

  private planBattle(kind: string, key: string, start: number, seed: number, extra: { user?: string; amount?: string }): Episode {
    const R = this.R, r = new Rng(seed);
    const armada = kind === 'armada';
    const ep: Episode = { key, kind, start, dur: 0, seed, ...extra, ships: [], bursts: [], missiles: [], hits: [], turretShots: [], alarm: null, cams: [], pa: [] };
    const entry = R.entries.length ? R.entries[r.int(R.entries.length)] : { pos: V(600, 200, -2400), fwd: V(-0.3, -0.1, 0.9).normalize() };
    const nR = armada ? 10 + r.int(3) : 3 + r.int(3);
    const nD = armada ? 8 + r.int(2) : 3 + r.int(2);
    const fightEnd = armada ? 78 : 46;
    let id = 0;
    const mkShip = (k: string, side: 'raider' | 'defender', pal: [string, string]): BShip => ({ id: id++, kind: k, side, c1: new THREE.Color(pal[0]), c2: new THREE.Color(pal[1]), legs: [], tIn: 0, tOut: 0 });
    // ---- raiders jump in (staggered), approach, then duel
    const raiders: BShip[] = [];
    for (let i = 0; i < nR; i++) {
      const s = mkShip('HUNTER', 'raider', LAW[r.int(LAW.length)]);
      const wi = 1.0 + i * r.range(0.25, 0.7);
      const p0 = entry.pos.clone().add(V(r.range(-160, 160), r.range(-80, 80), r.range(-160, 160)));
      const tgt = this.zonePoint(r, 0.7);
      const t1 = wi + r.range(9, 13);
      s.warpIn = wi; s.tIn = wi;
      s.legs.push({ t0: wi, t1, bez: [p0, p0.clone().addScaledVector(entry.fwd, 500), tgt.clone().addScaledVector(entry.fwd, -300), tgt] });
      raiders.push(s); ep.ships.push(s);
    }
    // the gunship (armada)
    let gun: BShip | null = null;
    if (armada && this.meta.GUNSHIP) {
      gun = mkShip('GUNSHIP', 'raider', LAW[0]); gun.big = true;
      const p0 = entry.pos.clone().add(V(0, 60, 0));
      const hold = R.zone.getCenter(V()).lerp(R.eye, 0.25).add(V(r.range(-120, 120), r.range(40, 110), 0));
      gun.warpIn = 2.5; gun.tIn = 2.5;
      gun.legs.push({ t0: 2.5, t1: 26, bez: [p0, p0.clone().addScaledVector(entry.fwd, 700), hold.clone().add(V(0, 0, -250)), hold] });
      gun.legs.push({ t0: 26, t1: fightEnd + 20, bez: [hold, hold.clone().add(V(30, 6, 20)), hold.clone().add(V(60, 10, 30)), hold.clone().add(V(80, 12, 40))] });
      gun.death = fightEnd - 6;
      ep.ships.push(gun);
      ep.breakup = { t: gun.death, pieces: ['GUNSHIP_p1', 'GUNSHIP_p2', 'GUNSHIP_p3'].map((k, i) => ({ kind: k, off: V(), vel: V(r.range(-6, 6), r.range(-3, 5), (1 - i) * 7 + r.range(-2, 2)), spin: V(r.range(-0.25, 0.25), r.range(-0.2, 0.2), r.range(-0.35, 0.35)) })) };
      // it shells the station: impacts on the rock around the glass (+ shield flashes)
      for (let t = 27; t < gun.death - 1; t += r.range(1.6, 3.2)) {
        // on the rock around the bay (never on the glass itself): x ±14..70 m, y -25..40 m, a few metres out
        const sx = r.chance(0.5) ? 1 : -1;
        const p = R.eye.clone().add(V(sx * r.range(14, 70), r.range(-25, 40), 0));
        p.z = R.eye.z - r.range(4, 9);
        ep.hits.push({ t, p, shield: r.chance(0.7) });
      }
    }
    // ---- defenders launch from the hangar
    const defs: BShip[] = [];
    const launches = R.launch.length ? R.launch : [{ pos: V(-128, 28, -176), fwd: V(0.8, 0, -0.2).normalize() }];
    const nBrick = armada ? 3 : 0;
    for (let i = 0; i < nD + nBrick; i++) {
      const isBrick = i >= nD;
      const s = mkShip(isBrick ? 'BRICK' : 'BRAWLER', 'defender', PIRATE[r.int(PIRATE.length)]);
      const L = launches[i % launches.length];
      const t0 = 3.5 + i * r.range(0.9, 1.6);
      const out = L.pos.clone().addScaledVector(L.fwd, 70);
      const tgt = this.zonePoint(r, 0.7);
      const t1 = t0 + r.range(8, 11);
      s.tIn = t0;
      s.legs.push({ t0, t1, bez: [L.pos.clone(), out, tgt.clone().lerp(out, 0.4).add(V(0, 60, 0)), tgt] });
      defs.push(s); ep.ships.push(s);
    }
    // ---- duels: pair defenders with raiders on loops in the zone; kills
    const aliveR = [...raiders], aliveD = [...defs];
    const tDuel0 = 14;
    const duels: { a: BShip; b: BShip; loop: Loop; t0: number; t1: number; chaser: BShip; lead: BShip; kill: BShip | null }[] = [];
    let t = tDuel0;
    const rounds = armada ? 4 : 2;
    for (let round = 0; round < rounds; round++) {
      const pairs = Math.min(aliveR.length, aliveD.length);
      const rt0 = tDuel0 + round * (fightEnd - tDuel0) / rounds, rt1 = rt0 + (fightEnd - tDuel0) / rounds;
      for (let k = 0; k < pairs; k++) {
        const a = aliveD[k], b = aliveR[k];
        const loop = this.duelLoop(r);
        const chaserIsD = r.chance(0.62);
        const chaser = chaserIsD ? a : b, lead = chaserIsD ? b : a;
        const kill = r.chance(round === rounds - 1 ? 0.75 : 0.5) ? (r.chance(armada ? 0.78 : 0.7) ? b : a) : null;
        duels.push({ a, b, loop, t0: rt0 + r.range(0, 1.5), t1: rt1, chaser, lead, kill });
      }
      for (const d of duels.filter((x) => x.t0 >= rt0 && x.t0 < rt1)) {
        if (d.kill) {
          const tk = d.t0 + (d.t1 - d.t0) * r.range(0.55, 0.9);
          d.kill.death = tk;
          const i1 = aliveR.indexOf(d.kill); if (i1 >= 0) aliveR.splice(i1, 1);
          const i2 = aliveD.indexOf(d.kill); if (i2 >= 0) aliveD.splice(i2, 1);
        }
      }
      void t;
    }
    // legs + bursts for the duels (each ship: a loop leg per duel it is in)
    for (const d of duels) {
      const v = r.range(95, 125), gap = r.range(45, 80), s0 = r.next() * d.loop.L;
      for (const s of [d.a, d.b]) {
        const end = s.death !== undefined ? Math.min(d.t1, s.death) : d.t1;
        if (end <= d.t0) continue;
        s.legs.push({ t0: d.t0, t1: end, loop: d.loop, s0: s === d.lead ? s0 + gap : s0, v, roll: r.range(-0.6, 0.6) });
      }
      const end = Math.min(d.t1, d.lead.death ?? d.t1, d.chaser.death ?? d.t1);
      for (let tb = d.t0 + r.range(0.8, 2.0); tb < end - 0.4; tb += r.range(1.1, 2.3)) {
        ep.bursts.push({ ship: d.chaser.id, target: d.lead.id, t: tb, n: 4 + r.int(4), gun: r.int(3), hit: r.chance(0.55), col: d.chaser.side === 'defender' ? [1.4, 0.85, 0.3] : [0.5, 0.85, 1.5] });
        if (d.chaser.kind === 'BRAWLER' && r.chance(0.18)) ep.missiles.push({ ship: d.chaser.id, target: d.lead.id, t: tb + 0.3, dur: r.range(1.4, 2.2), side: r.chance(0.5) ? 1 : -1 });
      }
      if (d.lead.death !== undefined && d.lead.death <= d.t1) ep.bursts.push({ ship: d.chaser.id, target: d.lead.id, t: d.lead.death - 0.5, n: 6, gun: 0, hit: true, col: d.chaser.side === 'defender' ? [1.4, 0.85, 0.3] : [0.5, 0.85, 1.5] });
    }
    // gunship strafing runs by the brawlers + its own point defence
    if (gun) {
      for (const d of defs) {
        for (let tb = 30 + r.range(0, 6); tb < (gun.death ?? 60) - 1; tb += r.range(3.5, 7)) ep.bursts.push({ ship: d.id, target: gun.id, t: tb, n: 5 + r.int(4), gun: 0, hit: true, col: [1.4, 0.85, 0.3] });
      }
      for (let tb = 30; tb < (gun.death ?? 60); tb += r.range(0.7, 1.4)) {
        const tgt = defs[r.int(defs.length)];
        ep.bursts.push({ ship: gun.id, target: tgt.id, t: tb, n: 3, gun: r.int(4), hit: r.chance(0.3), col: [0.6, 0.85, 1.6] });
      }
    }
    // turrets on the station rock
    const targets = [...raiders, ...(gun ? [gun] : [])];
    for (let ti = 0; ti < R.turrets.length; ti++) for (let tt = 15 + ti * 0.7; tt < fightEnd; tt += r.range(1.2, 2.6)) ep.turretShots.push({ turret: ti, target: targets[r.int(targets.length)].id, t: tt });
    // ---- after the fight: raiders jump out, defenders go home
    const endT = fightEnd;
    for (const s of raiders) {
      if (s.death !== undefined) continue;
      const last = s.legs[s.legs.length - 1];
      const p = this.legPos(last, last.t1);
      const away = entry.pos.clone().sub(p).normalize();
      const t0 = Math.max(last.t1, endT - r.range(0, 4));
      s.legs.push({ t0, t1: t0 + 7, bez: [p, p.clone().addScaledVector(away, 200), p.clone().addScaledVector(away, 600), p.clone().addScaledVector(away, 900)] });
      s.warpOut = t0 + 6.4; s.tOut = t0 + 6.6;
    }
    for (const s of defs) {
      if (s.death !== undefined) continue;
      const last = s.legs[s.legs.length - 1];
      const p = this.legPos(last, last.t1);
      const L = launches[s.id % launches.length];
      const t0 = Math.max(last.t1, endT + r.range(0, 5));
      const t1 = t0 + r.range(12, 16);
      s.legs.push({ t0, t1, bez: [p, p.clone().add(V(0, 40, 0)), L.pos.clone().addScaledVector(L.fwd, 120), L.pos.clone().addScaledVector(L.fwd, -20)] });
      s.hangarIn = t1 - 1.2; s.tOut = t1;
    }
    // fill the gaps between legs (a ship between duels keeps flying: a bezier from where it was to where it will be)
    for (const s of ep.ships) {
      s.legs.sort((a, b) => a.t0 - b.t0);
      const filled: Leg[] = [];
      for (const lg of s.legs) {
        const prev = filled[filled.length - 1];
        if (prev && lg.t0 > prev.t1 + 0.01) {
          const a = this.legPos(prev, prev.t1), b = this.legPos(lg, lg.t0);
          const ta = this.legTan(prev, prev.t1), tb = this.legTan(lg, lg.t0);
          const d = a.distanceTo(b) * 0.4 + 60;
          filled.push({ t0: prev.t1, t1: lg.t0, bez: [a, a.clone().addScaledVector(ta, d), b.clone().addScaledVector(tb, -d), b] });
        }
        filled.push(lg);
      }
      s.legs = filled;
      if (!s.tOut) s.tOut = s.death !== undefined ? s.death : filled[filled.length - 1].t1;
    }
    ep.dur = Math.max(...ep.ships.map((s) => (s.death !== undefined ? s.death + 30 : s.tOut + 2)), fightEnd + 20);
    ep.alarm = [0.8, fightEnd + 6];
    const who = extra.user ? ` - BOUNTY POSTED BY ${extra.user.toUpperCase()}` : '';
    if (armada) {
      ep.pa.push([0.6, `RED ALERT - ARMADA INBOUND${who} - ALL BRAWLERS SCRAMBLE`, 'alert'], [26, 'GUNSHIP ON THE GLASS - STAY AWAY FROM THE WINDOWS (OR DON\'T)', 'alert'],
        [(gun?.death ?? 60) + 0.5, 'GUNSHIP DOWN! DRINKS ARE ON THE HOUSE (THEY ARE NOT)', 'cheer'], [fightEnd + 8, 'ALL CLEAR - RACING RESUMES', 'info']);
      ep.cams.push([14, 22, 'CAM_BATTLE'], [(gun?.death ?? 60) - 1.2, (gun?.death ?? 60) + 6, 'CAM_BATTLE']);
    } else {
      ep.pa.push([0.6, `HOSTILE CONTACTS INBOUND${who} - BRAWLERS SCRAMBLE`, 'alert'], [fightEnd + 6, 'ALL CLEAR - KEEP YOUR BETS ON THE TABLE', 'info']);
    }
    return ep;
  }

  private planSalute(key: string, start: number, seed: number, extra: { user?: string; amount?: string }): Episode {
    const R = this.R, r = new Rng(seed);
    const ep: Episode = { key, kind: 'salute', start, dur: 16, seed, ...extra, ships: [], bursts: [], missiles: [], hits: [], turretShots: [], alarm: null, cams: [], pa: [] };
    const eye = R.eye;
    const side = r.chance(0.5) ? 1 : -1;
    const near = eye.clone().add(V(0, r.range(5, 10), -r.range(30, 38)));
    const p0 = near.clone().add(V(-side * 420, r.range(-20, 30), -r.range(110, 150)));
    const p3 = near.clone().add(V(side * 440, r.range(30, 80), -r.range(120, 170)));
    for (let i = 0; i < 3; i++) {
      const s: BShip = { id: i, kind: 'BRAWLER', side: 'defender', c1: new THREE.Color(PIRATE[i % PIRATE.length][0]), c2: new THREE.Color(PIRATE[i % PIRATE.length][1]), legs: [], tIn: 0.5 + i * 0.35, tOut: 13 + i * 0.35 };
      const o = V((i - 1) * 20 * side, -Math.abs(i - 1) * 5, -Math.abs(i - 1) * 18);
      s.legs.push({ t0: s.tIn, t1: s.tOut, bez: [p0.clone().add(o), near.clone().add(V(-side * 150, 0, 10)).add(o), near.clone().add(V(side * 150, 5, 10)).add(o), p3.clone().add(o)], roll: i === 1 ? 6.283 : 0 });
      ep.ships.push(s);
    }
    ep.flares = { t0: 6.2, t1: 8.6 };
    ep.pa.push([0.4, `THE BRAWLERS SALUTE ${(extra.user ?? 'A FRIEND').toUpperCase()}!`, 'cheer']);
    return ep;
  }

  private planLap(key: string, start: number, seed: number, extra: { user?: string; amount?: string }): Episode {
    const R = this.R, r = new Rng(seed);
    const ep: Episode = { key, kind: 'lap', start, dur: 20, seed, ...extra, ships: [], bursts: [], missiles: [], hits: [], turretShots: [], alarm: null, cams: [], pa: [] };
    const eye = R.eye;
    const near = eye.clone().add(V(0, r.range(3, 7), -r.range(28, 34)));
    const p0 = near.clone().add(V(380, r.range(20, 50), -140));
    const p3 = near.clone().add(V(-420, r.range(30, 70), -160));
    const pal = [['#e8402a', '#f2f2f2'], ['#f2c230', '#1a1a1a'], ['#2a7ae8', '#f2c230']][r.int(3)];
    const s: BShip = { id: 0, kind: ['RACER_A', 'RACER_B', 'RACER_C'][r.int(3)], side: 'defender', c1: new THREE.Color(pal[0]), c2: new THREE.Color(pal[1]), legs: [], tIn: 0.3, tOut: 17 };
    s.legs.push({ t0: 0.3, t1: 17, bez: [p0, near.clone().add(V(130, 0, 12)), near.clone().add(V(-130, 5, 12)), p3], roll: 6.283 });
    ep.ships.push(s);
    ep.pa.push([0.4, `VICTORY LAP FOR ${(extra.user ?? 'OUR SPONSOR').toUpperCase()}${extra.amount ? ' (' + extra.amount + ')' : ''} - THE HOUSE PAYS OUT!`, 'cheer']);
    return ep;
  }

  // ---------------------------------------------------------------------------------------------- sampling
  private legPos(lg: Leg, t: number, out = V()) {
    if (lg.bez) { const u = clamp01((t - lg.t0) / Math.max(0.01, lg.t1 - lg.t0)); return bez(lg.bez[0], lg.bez[1], lg.bez[2], lg.bez[3], smoothU(u), out); }
    return lg.loop!.at((lg.s0 ?? 0) + (lg.v ?? 100) * (t - lg.t0), out);
  }
  private legTan(lg: Leg, t: number) {
    const a = this.legPos(lg, t - 0.05), b = this.legPos(lg, t + 0.05);
    const d = b.sub(a); return d.lengthSq() > 1e-8 ? d.normalize() : V(0, 0, 1);
  }
  /** pose of ship s at tau: position, orientation (banking into turns), velocity dir. null = not there. */
  pose(s: BShip, tau: number, pos: V3, q: THREE.Quaternion): V3 | null {
    if (tau < s.tIn - 0.01) return null;
    let lg = s.legs[0];
    for (const l of s.legs) { if (tau >= l.t0) lg = l; else break; }
    const tt = Math.min(tau, lg.t1);
    this.legPos(lg, tt, pos);
    const a = this.legPos(lg, tt - 0.12), b = this.legPos(lg, tt + 0.12);
    const fwd = b.clone().sub(a);
    if (fwd.lengthSq() < 1e-6) fwd.set(0, 0, 1); fwd.normalize();
    const a2 = this.legPos(lg, tt - 0.5);
    const turn = fwd.clone().sub(pos.clone().sub(a2).normalize());
    const up = UP.clone().addScaledVector(turn, 6).normalize();
    orient(fwd, up, q);
    if (lg.roll) { const u = clamp01((tt - lg.t0) / (lg.t1 - lg.t0)); q.multiply(new THREE.Quaternion().setFromAxisAngle(V(0, 0, 1), lg.roll * smooth((u - 0.38) / 0.28))); }
    return fwd;
  }

  sample(ep: Episode, tau: number, F: BFrame) {
    const meta = this.meta;
    const pos = V(), q = new THREE.Quaternion();
    const shipPos = new Map<number, V3>();
    const shipVel = new Map<number, V3>();
    // alarm / PA / cameras
    if (ep.alarm && tau >= ep.alarm[0] && tau < ep.alarm[1]) F.alarm = Math.max(F.alarm, (ep.kind === 'armada' ? 1 : 0.6) * smooth((tau - ep.alarm[0]) / 1.2) * smooth((ep.alarm[1] - tau) / 3));
    for (const [t, text, tone] of ep.pa) if (tau >= t && tau < t + 9) F.pa.push({ key: `${ep.key}:${t}`, text, tone });
    for (const [a, b, name] of ep.cams) if (tau >= a && tau < b) F.cam = { key: `${ep.key}:${a}`, name };
    for (const s of ep.ships) {
      if (s.kind === 'GUNSHIP' && ep.breakup && tau >= ep.breakup.t) continue;
      const fwd = this.pose(s, tau, pos, q);
      if (!fwd) continue;
      const dead = s.death !== undefined && tau >= s.death;
      if (tau > s.tOut + 0.5 && !dead) continue;
      shipPos.set(s.id, pos.clone()); shipVel.set(s.id, fwd.clone());
      const warpK = s.warpIn !== undefined ? clamp01((tau - s.warpIn) / 0.5) : 1;
      const outK = s.warpOut !== undefined ? 1 - clamp01((tau - s.warpOut) / 0.25) : 1;
      const homeK = s.hangarIn !== undefined ? 1 - clamp01((tau - s.hangarIn) / 1.2) : 1;
      // hull hit flash: a 9.5 Hz shimmer with the flash limit off; with it on, one steady glow for the burst — either way
      // through the page governor (one output per ship)
      const hitOn = ep.bursts.some((b) => b.target === s.id && b.hit && tau > b.t + 0.2 && tau < b.t + 0.2 + b.n * 0.09 + 0.12);
      const flash = govern(`raceway hit ${s.id}`, 1 + (hitOn ? (pageGovernor().safe ? 0.75 : 0.55 + 0.45 * Math.sin(tau * 60)) : 0)) - 1;
      if (s.kind === 'GUNSHIP') {
        for (const pc of ['GUNSHIP_p1', 'GUNSHIP_p2', 'GUNSHIP_p3']) {
          const m = meta.GUNSHIP?.pieces?.find((p) => p.name === pc);
          const off = m ? V(m.center[0], m.center[1], m.center[2]).applyQuaternion(q) : V();
          F.ships.push({ kind: pc, pos: pos.clone().add(off), quat: q, c1: s.c1, c2: s.c2, fade: warpK, flash: flash * 0.5, stretch: warpK < 1 ? (1 - warpK) * 6 : 0, heat: s.death !== undefined ? clamp01((tau - (s.death - 10)) / 10) * 0.5 : 0 });
        }
        engines(F, meta.GUNSHIP, pos, q, 1, 0.8, [0.5, 0.75, 1.3], s.id);
        navLights(F, meta.GUNSHIP, pos, q, s.id);
        if (s.death !== undefined && tau > s.death - 8) for (let k = 0; k < 6; k++) { const bp = meta.GUNSHIP?.booms?.[k]; if (!bp) continue; const tb = s.death - 7 + k * 1.1; boom(F, V(bp[0], bp[1], bp[2]).applyQuaternion(q).add(pos), tau - tb, 9, hash32(ep.seed, k)); }
      } else if (!dead) {
        const k = warpK * outK * homeK;
        F.ships.push({ kind: s.kind, pos: pos.clone(), quat: q.clone(), c1: s.c1, c2: s.c2, fade: k, flash, stretch: (1 - warpK) * 8 + (1 - outK) * 8 });
        engines(F, meta[s.kind], pos, q, 1, 1, s.side === 'raider' ? [0.5, 0.75, 1.4] : [1.3, 0.75, 0.35], s.id);
        navLights(F, meta[s.kind], pos, q, s.id);
        trail(F, pos, fwd, s.side === 'raider' ? [0.45, 0.7, 1.2] : [1.1, 0.6, 0.3], 0.5 * k, F.detail);
      } else {
        // wreck: keeps drifting along its last heading, tumbling, burning, fading
        const age = tau - s.death!;
        const lastPos = V(), lq = new THREE.Quaternion();
        const lf = this.pose(s, s.death!, lastPos, lq) ?? V(0, 0, 1);
        const wp = lastPos.clone().addScaledVector(lf, 60 * (1 - Math.exp(-age * 0.6)) + age * 6).add(V(0, -age * 1.2, 0));
        const spin = new THREE.Quaternion().setFromEuler(new THREE.Euler(age * 0.9 * ((s.id % 2) * 2 - 1), age * 0.4, age * 1.3));
        const fade = 1 - smooth((age - 14) / 10);
        if (fade > 0) F.ships.push({ kind: s.kind, pos: wp, quat: lq.multiply(spin), c1: s.c1, c2: s.c2, heat: 0.9 * Math.exp(-age * 0.05), fade });
        boom(F, lastPos, age, s.kind === 'BRICK' ? 16 : 10, hash32(ep.seed, s.id, 'boom'));
        if (age < 12 && F.detail > 0) for (let k = 0; k < 3; k++) { const a = age - k * 0.4; if (a > 0) F.fx.puff(wp.clone().addScaledVector(lf, -3 - k * 4), 3 + a * 0.6, 0.14, 0.12, 0.11, 0.45 * (1 - a / 12), (s.id * 7 + k) / 13); }
        debris(F, lastPos, lf, age, 26, hash32(ep.seed, s.id, 'deb'));
        if (age < 0.05) F.moments.push({ key: `${ep.key}:${s.id}`, what: 'kill' });
      }
    }
    // salute flares: bright magnesium decoys arcing out behind each ship
    if (ep.flares && tau > ep.flares.t0 && tau < ep.flares.t1 + 3) {
      for (const s of ep.ships) {
        for (let k = 0; k < 10; k++) {
          const tf = ep.flares.t0 + k * 0.24 + (s.id * 0.07);
          const age = tau - tf;
          if (age < 0 || age > 2.6 || tf > ep.flares.t1) continue;
          const p0 = V(); const f0 = this.pose(s, tf, p0, new THREE.Quaternion()) ?? V(0, 0, 1);
          const side = k % 2 ? 1 : -1;
          const vel = f0.clone().multiplyScalar(40).add(V(side * 14, 9, 0));
          const p = p0.clone().addScaledVector(vel, age).add(V(0, -6 * age * age, 0));
          const a = 1 - age / 2.6;
          F.fx.sprite(p, 1.8 + age * 0.6, 1.6, 1.25, 0.8, a, SPRITE.flare, (k * 0.31) % 1);
          F.fx.sprite(p, 3.2, 1.2, 0.6, 0.2, a * 0.5, SPRITE.glow, 0);
          if (F.detail > 0) F.fx.puff(p.clone().addScaledVector(vel, -0.08), 1.2 + age * 1.5, 0.8, 0.8, 0.82, 0.3 * a, (k * 0.17) % 1);
        }
      }
    }
    // the gunship breaks up
    if (ep.breakup && tau >= ep.breakup.t) {
      const gun = ep.ships.find((s) => s.kind === 'GUNSHIP')!;
      const age = tau - ep.breakup.t;
      const gp = V(), gq = new THREE.Quaternion();
      this.pose(gun, ep.breakup.t, gp, gq);
      for (const pc of ep.breakup.pieces) {
        const m = meta.GUNSHIP?.pieces?.find((p) => p.name === pc.kind);
        const off = m ? V(m.center[0], m.center[1], m.center[2]).applyQuaternion(gq) : V();
        const p = gp.clone().add(off).addScaledVector(pc.vel, age);
        const qq = gq.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(pc.spin.x * age, pc.spin.y * age, pc.spin.z * age)));
        const fade = 1 - smooth((age - 24) / 10);
        F.ships.push({ kind: pc.kind, pos: p, quat: qq, c1: gun.c1, c2: gun.c2, heat: 0.95 * Math.exp(-age * 0.03), fade });
        if (age < 30 && F.detail > 0) F.fx.puff(p.clone().add(V(0, 2, 0)), 8 + age * 0.8, 0.14, 0.12, 0.11, 0.5 * (1 - age / 30), (pc.kind.length + Math.floor(age * 3)) / 17);
        if (age < 18) F.fx.sprite(p, 6 + Math.sin(age * 9) * 1.5, 1.3, 0.55, 0.15, 0.6 * (1 - age / 18), SPRITE.fire, age * 0.1);
      }
      boom(F, gp, age, 48, hash32(ep.seed, 'gunboom'));
      if (age < 2.4) F.fx.sprite(gp, 60 + age * 260, 1.1, 0.9, 0.7, 0.9 * (1 - age / 2.4), SPRITE.ring, 0.3);
      debris(F, gp, V(0, 0, 1), age, 120, hash32(ep.seed, 'gundeb'), 1.8);
      if (age < 0.6) { F.flash = Math.max(F.flash, 1 - age / 0.6); F.shake = Math.max(F.shake, 0.9); }
      if (age < 0.05) F.moments.push({ key: `${ep.key}:gun`, what: 'destroyed' });
    }
    // warp flashes (in / out)
    for (const s of ep.ships) {
      for (const tw of [s.warpIn, s.warpOut]) {
        if (tw === undefined) continue;
        const age = tau - tw + (tw === s.warpIn ? 0.35 : 0);
        if (age < 0 || age > 1.6) continue;
        const p = V(); const f = this.pose(s, Math.max(s.tIn, Math.min(tau, s.tOut)), p, new THREE.Quaternion()) ?? V(0, 0, 1);
        const sz = s.big ? 70 : 16;
        const k = age < 0.3 ? age / 0.3 : Math.exp(-(age - 0.3) * 3);
        F.fx.sprite(p, sz * (0.6 + k * 1.4), 0.7, 0.9, 1.5, k, SPRITE.flare, (s.id % 7) / 7);
        F.fx.sprite(p, sz * 0.4 * k, 1.4, 1.4, 1.4, k, SPRITE.core, 0);
        if (age < 0.9) for (let i = 0; i < 6; i++) { const a = p.clone().addScaledVector(f, -sz * (2 + i * 1.5) * (1 - age)); F.fx.line(a, p, sz * 0.03, 1.1, 0.6, 0.85, 1.5, 0.7 * (1 - age / 0.9), false); }
      }
      if (s.hangarIn !== undefined && tau > s.hangarIn - 0.2 && tau < s.hangarIn + 1.5) { /* flying into the lit hangar: fade handles it */ }
    }
    // gunfire: tracer bursts (muzzle → where the target will be), hit sparks + shield flicker on the target
    for (const b of ep.bursts) {
      if (tau < b.t || tau > b.t + b.n * 0.09 + 0.7) continue;
      const src = ep.ships[b.ship], tgt = ep.ships[b.target];
      const sp = shipPos.get(src.id), tp = shipPos.get(tgt.id);
      if (!sp || !tp) continue;
      const sq = new THREE.Quaternion(); this.pose(src, tau, V(), sq);
      const m = meta[src.kind === 'GUNSHIP' ? 'GUNSHIP' : src.kind];
      const g = m?.guns?.[b.gun % Math.max(1, m.guns.length)] ?? [0, 0, 6];
      const muzzle = V(g[0], g[1], g[2]).applyQuaternion(sq).add(sp);
      for (let i = 0; i < b.n; i++) {
        const tf = b.t + i * 0.09;
        const age = tau - tf;
        if (age < 0 || age > 0.6) continue;
        const dir = tp.clone().sub(muzzle).normalize();
        if (!b.hit) dir.add(V(Math.sin(i * 7 + b.t) * 0.04, Math.cos(i * 5 + b.t) * 0.04, 0)).normalize();
        const dist = tp.distanceTo(muzzle);
        const travel = Math.min(dist, 1100 * age);
        const head = muzzle.clone().addScaledVector(dir, travel);
        const tail = head.clone().addScaledVector(dir, -Math.min(travel, 22));
        if (travel < dist - 1 || !b.hit) F.fx.line(tail, head, 0.35, 1.3, b.col[0], b.col[1], b.col[2], 0.95, false);
        else if (age * 1100 - dist < 40) { F.fx.sprite(tp.clone().addScaledVector(dir, -4), 4.5, 0.8, 0.95, 1.5, 0.9, SPRITE.flare, i / 7); F.fx.sprite(tp, 2.5, 1.4, 0.9, 0.4, 0.8, SPRITE.spark, i / 5); }
        if (age < 0.06) F.fx.sprite(muzzle, 2.2, b.col[0], b.col[1], b.col[2], 1, SPRITE.flare, i / 9);
      }
    }
    // missiles: a smoky curving trail, an impact boom
    for (const mi of ep.missiles) {
      const age = tau - mi.t;
      if (age < 0 || age > mi.dur + 3) continue;
      const sp = shipPos.get(mi.ship), tp = shipPos.get(mi.target);
      if (!sp || !tp) continue;
      const u = clamp01(age / mi.dur);
      const side = V(mi.side * 30, 20, 0);
      const p = bez(sp, sp.clone().add(side), tp.clone().add(side.clone().multiplyScalar(0.5)), tp, easeOut(u));
      if (u < 1) {
        F.fx.sprite(p, 2.2, 1.5, 1.1, 0.6, 1, SPRITE.flare, u);
        for (let k = 1; k <= (F.detail > 0 ? 8 : 4); k++) { const uu = Math.max(0, u - k * 0.04); const pp = bez(sp, sp.clone().add(side), tp.clone().add(side.clone().multiplyScalar(0.5)), tp, easeOut(uu)); F.fx.puff(pp, 1.6 + k * 0.35, 0.5, 0.48, 0.46, 0.4 * (1 - k / 9), (mi.t * 13 + k) % 1); }
      } else boom(F, tp, age - mi.dur, 7, hash32(mi.t, 'mis'));
    }
    // station turrets
    for (const ts of ep.turretShots) {
      const age = tau - ts.t;
      if (age < 0 || age > 1.2) continue;
      const T = this.R.turrets[ts.turret]; const tp = shipPos.get(ts.target);
      if (!T || !tp) continue;
      const dir = tp.clone().sub(T.pos).normalize();
      for (let i = 0; i < 4; i++) {
        const a = age - i * 0.08; if (a < 0 || a > 0.9) continue;
        const head = T.pos.clone().addScaledVector(dir, a * 1300);
        F.fx.line(head.clone().addScaledVector(dir, -28), head, 0.5, 1.4, 1.5, 0.55, 0.25, 0.95, false);
        if (a < 0.05) F.fx.sprite(T.pos, 3.2, 1.5, 0.7, 0.3, 1, SPRITE.flare, i / 4);
      }
    }
    // the gunship's shells hitting the station around the glass: impact sparks, or a shield flash on the rock
    for (const h of ep.hits) {
      const age = tau - h.t;
      if (age < -1.2 || age > 2.5) continue;
      const gun = ep.ships.find((s) => s.kind === 'GUNSHIP');
      const gp = gun ? shipPos.get(gun.id) : null;
      if (age < 0 && gp) { const u = 1 + age / 1.2; const p = gp.clone().lerp(h.p, u); F.fx.line(p.clone().lerp(gp, 0.04), p, 1.2, 2, 0.5, 0.8, 1.6, 0.95, false); continue; }
      if (age < 0) continue;
      if (h.shield) {
        const k = Math.exp(-age * 3.2);
        F.fx.sprite(h.p, 14 + age * 30, 0.35, 0.75, 1.5, k * 0.9, SPRITE.ring, h.t % 1);
        F.fx.sprite(h.p, 8, 0.5, 0.85, 1.6, k, SPRITE.glow, 0);
        if (age < 0.25) F.flash = Math.max(F.flash, 0.35 * (1 - age / 0.25));
      } else { boom(F, h.p, age, 5, hash32(h.t, 'hit')); if (age < 0.2) F.shake = Math.max(F.shake, 0.35); }
    }
  }
}

function smoothU(u: number) { return u; }

function engines(F: BFrame, meta: RwShipMeta | undefined, pos: V3, q: THREE.Quaternion, s: number, power: number, col: [number, number, number], seed: number) {
  if (!meta) return;
  for (let i = 0; i < meta.engines.length; i++) {
    const e = V(meta.engines[i][0] * s, meta.engines[i][1] * s, meta.engines[i][2] * s).applyQuaternion(q).add(pos);
    const fl = 0.85 + safeAmp(0.15) * Math.sin(F.t * 31 + i * 1.7 + seed);   // (engine flicker: < 10 % with the flash limit on)
    F.fx.sprite(e, meta.engineR * s * (1.8 + power), col[0], col[1], col[2], 0.8 * fl, SPRITE.glow, seed * 0.13 + i * 0.1);
    F.fx.sprite(e, meta.engineR * s * 0.8, 1, 1, 1, 0.6 * power * fl, SPRITE.core, 0);
  }
}
function navLights(F: BFrame, meta: RwShipMeta | undefined, pos: V3, q: THREE.Quaternion, seed: number) {
  if (!meta) return;
  for (const l of meta.lights) {
    const on = l.blink > 0 ? (((F.t + seed * 0.37) % l.blink) < 0.12 ? 1 : 0) : 0.8;
    if (!on) continue;
    const c = l.c === 'red' ? [1, 0.15, 0.1] : l.c === 'green' ? [0.2, 1, 0.35] : [1, 1, 1];
    F.fx.sprite(V(l.p[0], l.p[1], l.p[2]).applyQuaternion(q).add(pos), 1.6, c[0], c[1], c[2], on, SPRITE.flare, seed);
  }
}
function trail(F: BFrame, pos: V3, fwd: V3, col: [number, number, number], alpha: number, detail: number) {
  const n = detail > 0 ? 5 : 2;
  for (let i = 0; i < n; i++) F.fx.line(pos.clone().addScaledVector(fwd, -6 - (i + 1) * 12), pos.clone().addScaledVector(fwd, -6 - i * 12), 0.45 * (1 - i / (n + 1)), 1.0, col[0], col[1], col[2], alpha * (1 - i / n), false);
}
/** explosion `tau` s after it went off: flash, fireball, sparks, smoke */
export function boom(F: BFrame, p: V3, tau: number, size: number, seed: number) {
  if (tau < 0 || tau > 8) return;
  const r = new Rng(seed);
  if (tau < 0.25) F.fx.sprite(p, size * (1.5 + tau * 6), 1.4, 1.2, 1, 1 - tau / 0.25, SPRITE.flare, r.next());
  if (tau < 1.6) F.fx.sprite(p, size * (0.5 + easeOut(tau / 1.2) * 1.1), 1.3, 1.0, 0.8, (1 - smooth(tau / 1.6)) * 1.2, SPRITE.fire, r.next());
  if (tau < 0.9) F.fx.sprite(p, size * 0.6, 1.4, 1.3, 1.1, 1 - tau / 0.9, SPRITE.core, 0);
  if (tau < 0.8) F.fx.sprite(p, size * (0.8 + tau * 5), 1.0, 0.8, 0.6, 0.5 * (1 - tau / 0.8), SPRITE.ring, r.next());
  const n = F.detail > 0 ? 10 : 5;
  for (let i = 0; i < n; i++) {
    const d = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
    const sp = size * r.range(1.2, 3.2);
    if (tau < 1.4) {
      const a = p.clone().addScaledVector(d, sp * easeOut(tau / 1.4) * 1.6);
      const b = p.clone().addScaledVector(d, sp * easeOut(Math.max(0, tau - 0.12) / 1.4) * 1.6);
      F.fx.line(b, a, size * 0.05, 1.3, 1, 0.7, 0.35, 1 - tau / 1.4, false);
    }
  }
  if (tau < 7) for (let i = 0; i < (F.detail > 0 ? 3 : 1); i++) {
    const d = V(r.range(-1, 1), r.range(-0.5, 1), r.range(-1, 1)).normalize();
    const age = tau - 0.3;
    if (age > 0) F.fx.puff(p.clone().addScaledVector(d, size * (0.3 + age * 0.25)), size * (0.7 + age * 0.22), 0.12, 0.11, 0.1, 0.55 * (1 - smooth(age / 6.5)), r.next());
  }
}
/** tumbling hull chunks flung out of an explosion */
export function debris(F: BFrame, p: V3, fwd: V3, age: number, n: number, seed: number, big = 1) {
  if (age < 0 || age > 16) return;
  const r = new Rng(seed);
  const cnt = F.detail > 0 ? n : Math.ceil(n / 2);
  for (let i = 0; i < cnt; i++) {
    const d = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize().addScaledVector(fwd, 0.4).normalize();
    const v = r.range(8, 45) * big;
    const pos = p.clone().addScaledVector(d, v * (1 - Math.exp(-age * 0.35)) / 0.35);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(age * r.range(-3, 3), age * r.range(-3, 3), age * r.range(-3, 3)));
    const fade = 1 - smooth((age - 10) / 6);
    F.ships.push({ kind: r.chance(0.6) ? 'DEBRIS' : 'DEBRIS_B', pos, quat: q, scale: r.range(0.4, 1.6) * big, heat: Math.max(0, 0.8 - age * 0.2), fade });
  }
}
