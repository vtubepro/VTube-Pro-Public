// Sky traffic — the flight plans. Closed-form in time (no simulation state): every pad runs its own periodic cycle
//   idle → approach (curved descent from far out, decelerating) → hover (turn to the pad heading, gear down) →
//   touchdown → parked → spool-up → lift-off (gear up) → departure (accelerating climb, boost) → idle
// and every cruise lane releases a ship every `every` s. The ship kind / directions / park time of each cycle come from
// hash(seed, pad, cycle), so every page that shares the clock shows the same traffic.
import * as THREE from 'three';
import { DEFAULT_CLASSES, Polyline, hash01, type LaneCfg, type PadCfg, type ShipMeta, type TrafficCfg } from './config.ts';

export type Phase = 'approach' | 'hover' | 'descend' | 'parked' | 'spool' | 'lift' | 'depart' | 'cruise';
export interface ShipPose {
  key: string;             // stable id of this flight (pool slot reuse)
  ship: string;            // ship id
  pos: THREE.Vector3;
  quat: THREE.Quaternion;
  gear: number;            // 0 retracted … 1 down
  thrust: number;          // engine glow 0.2 idle … 1 cruise … 2 boost
  phase: Phase;
  landing: number;         // 0…1 landing-light strength
  /** This flight (pad + cycle, lane + release, parked slot + 10-minute rotation): the same on every page. */
  flight?: string;
  /** When this flight started (s, traffic clock). */
  start?: number;
}
/** A pad cycle's timeline (s, traffic clock): approach from t0, touchdown at t0 + Ta + Tt + Td, lift-off at `lift`. */
export interface PadTiming {
  i: number; k: number; ship: string; L: number;
  Ta: number; Tt: number; Td: number; Tp: number; Ts: number; Tl: number; Tdep: number; fixed: number;
  /** Offset of the flight inside its cycle, and its absolute start (the approach begins). */
  start: number; t0: number;
  touchdown: number; lift: number; end: number;
  h: (n: number) => number;
}
/** A moment of the pad cycles (for camera directors: src/scene/afk): a touchdown or a lift-off. */
export interface TrafficEvent { kind: 'land' | 'launch'; at: number; pad: number; padName: string; ship: string; key: string; flight: string; start: number; timing: PadTiming }

const UP = new THREE.Vector3(0, 1, 0);
const tv = new THREE.Vector3(), tv2 = new THREE.Vector3(), tv3 = new THREE.Vector3();
const tm = new THREE.Matrix4(), tq = new THREE.Quaternion(), te = new THREE.Euler();
const ease = (x: number) => x * x * (3 - 2 * x);
/** Parked ships count as a new "flight" (a new chatter name on them) every 5 minutes. */
const PARK_ROTATE = 300;
const clamp01 = (x: number) => Math.min(1, Math.max(0, x));

function bez(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
  const u = 1 - t;
  return out.set(0, 0, 0).addScaledVector(p0, u * u * u).addScaledVector(p1, 3 * u * u * t).addScaledVector(p2, 3 * u * t * t).addScaledVector(p3, t * t * t);
}
function bezTan(p0: THREE.Vector3, p1: THREE.Vector3, p2: THREE.Vector3, p3: THREE.Vector3, t: number, out: THREE.Vector3) {
  const u = 1 - t;
  return out.set(0, 0, 0).addScaledVector(p1.clone().sub(p0), 3 * u * u).addScaledVector(p2.clone().sub(p1), 6 * u * t).addScaledVector(p3.clone().sub(p2), 3 * t * t);
}
/** orientation: nose (-Z) along `fwd`, banked by `bank` rad, pitched from the vertical part of fwd */
function orient(fwd: THREE.Vector3, bank: number, out: THREE.Quaternion) {
  const f = tv3.copy(fwd);
  if (f.lengthSq() < 1e-8) f.set(0, 0, -1);
  f.normalize();
  const yaw = Math.atan2(-f.x, -f.z);
  const pitch = Math.asin(Math.max(-0.6, Math.min(0.6, f.y)));
  te.set(pitch, yaw, bank, 'YXZ');
  return out.setFromEuler(te);
}

interface PadPlan { pad: PadCfg; P: THREE.Vector3; H: THREE.Vector3; cycle: number; offset: number; kinds: string[] }

export class FlightPlanner {
  readonly pads: PadPlan[] = [];
  readonly cruise: { lane: LaneCfg; line: Polyline; ships: string[]; every: number; speed: number }[] = [];
  private meta = new Map<string, ShipMeta>();
  readonly parked: { ship: string; pos: THREE.Vector3; quat: THREE.Quaternion }[] = [];
  private seed: number;
  private busy: number;
  constructor(readonly cfg: TrafficCfg, ships: ShipMeta[], toWorld: (p: THREE.Vector3) => THREE.Vector3) {
    for (const s of ships) this.meta.set(s.id, s);
    this.seed = (cfg.seed ?? 18) | 0;
    this.busy = Math.min(2, Math.max(0.5, cfg.busy ?? 1));
    const classes = { ...DEFAULT_CLASSES, ...(cfg.classes ?? {}) };
    const [c0, c1] = cfg.cycle ?? [170, 260];
    (cfg.pads ?? []).forEach((pad, i) => {
      const kinds = (classes[pad.cls] ?? classes.M).filter((k) => this.meta.has(k));
      if (!kinds.length) return;
      const P = toWorld(new THREE.Vector3(...pad.position));
      const H = new THREE.Vector3(...pad.heading); H.y = 0; if (H.lengthSq() < 1e-6) H.set(0, 0, -1); H.normalize();
      const cycle = (c0 + (c1 - c0) * hash01(this.seed, i, 7)) / this.busy;
      this.pads.push({ pad, P, H, cycle, offset: cycle * hash01(this.seed, i, 11), kinds });
    });
    for (const pk of cfg.parked ?? []) {
      if (!this.meta.has(pk.ship)) continue;
      const H = new THREE.Vector3(...pk.heading); H.y = 0; if (H.lengthSq() < 1e-6) H.set(0, 0, -1);
      const q = new THREE.Quaternion(); orient(H.normalize(), 0, q);
      this.parked.push({ ship: pk.ship, pos: toWorld(new THREE.Vector3(...pk.position)), quat: q });
    }
    for (const lane of cfg.lanes ?? []) {
      if (lane.kind !== 'cruise' || !lane.ships) continue;
      const ids = lane.ships.split(',').map((s) => s.trim()).filter((s) => this.meta.has(s));
      if (!ids.length || lane.points.length < 2) continue;
      const pts = lane.points.map((p) => { const v = toWorld(new THREE.Vector3(...p)); return [v.x, v.y, v.z] as [number, number, number]; });
      this.cruise.push({ lane, line: new Polyline(pts, !!lane.closed), ships: ids, every: Math.max(30, (lane.every ?? 120) / this.busy), speed: lane.speed ?? 40 });
    }
  }

  length(id: string) { return this.meta.get(id)?.length ?? 20; }
  shipMeta(id: string) { return this.meta.get(id) ?? null; }

  /** Pad i's cycle k: the ship, its phase lengths and absolute times (pure: the same on every page). */
  padTiming(i: number, k: number): PadTiming {
    const pp = this.pads[i];
    const h = (n: number) => hash01(this.seed + 101, i * 7919 + k, n);
    const ship = pp.kinds[Math.floor(h(1) * pp.kinds.length) % pp.kinds.length];
    const L = this.length(ship);
    const Ta = 24 + L * 0.09, Tt = 4, Td = 6 + L * 0.03, Ts = 3, Tl = 5 + L * 0.02, Tdep = 20 + L * 0.05;
    const fixed = Ta + Tt + Td + Ts + Tl + Tdep;
    const Tp = Math.max(12, (pp.cycle - fixed) * (0.45 + 0.35 * h(2)));
    const gap = Math.max(6, pp.cycle - fixed - Tp);
    const start = gap * h(3);
    const t0 = k * pp.cycle - pp.offset + start;
    return { i, k, ship, L, Ta, Tt, Td, Tp, Ts, Tl, Tdep, fixed, start, t0, touchdown: t0 + Ta + Tt + Td, lift: t0 + Ta + Tt + Td + Tp + Ts, end: t0 + fixed + Tp, h };
  }

  /** Touchdowns and lift-offs between t0 and t1 (s), in time order. */
  padEvents(t0: number, t1: number): TrafficEvent[] {
    const out: TrafficEvent[] = [];
    this.pads.forEach((pp, i) => {
      const k0 = Math.floor((t0 + pp.offset) / pp.cycle) - 1, k1 = Math.floor((t1 + pp.offset) / pp.cycle) + 1;
      for (let k = k0; k <= k1; k++) {
        const tm = this.padTiming(i, k);
        const base = { pad: i, padName: pp.pad.name, ship: tm.ship, key: `pad${i}`, flight: `pad${i}:${k}`, start: tm.t0, timing: tm };
        if (tm.touchdown >= t0 && tm.touchdown <= t1) out.push({ kind: 'land', at: tm.touchdown, ...base });
        if (tm.lift >= t0 && tm.lift <= t1) out.push({ kind: 'launch', at: tm.lift, ...base });
      }
    });
    return out.sort((a, b) => a.at - b.at);
  }

  /** One flight's pose at time t (s): `pad3`, `cruise1_812`, `park0` (the keys sample() uses); null = not flying then. */
  poseOf(key: string, t: number, out?: ShipPose): ShipPose | null {
    const mk = (k: string, ship: string): ShipPose => {
      const p = out ?? { key: k, ship, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), gear: 0, thrust: 1, phase: 'cruise', landing: 0 };
      p.key = k; p.ship = ship;
      return p;
    };
    let m = /^pad(\d+)$/.exec(key);
    if (m) return this.pads[+m[1]] ? this.samplePad(+m[1], t, mk) : null;
    m = /^cruise(\d+)_(-?\d+)$/.exec(key);
    if (m) return this.cruise[+m[1]] ? this.sampleCruise(+m[1], +m[2], t, mk) : null;
    m = /^park(\d+)$/.exec(key);
    if (m) return this.parked[+m[1]] ? this.sampleParked(+m[1], t, mk) : null;
    return null;
  }

  /** Every flight in the air / on a pad at time T (s): id + start — what a ship's chatter name is chosen against
   *  (shared/afk.ts crewNameFor). */
  activeAt(T: number): { id: string; start: number }[] {
    const out: { id: string; start: number }[] = [];
    this.pads.forEach((pp, i) => {
      const k = Math.floor((T + pp.offset) / pp.cycle);
      const tm = this.padTiming(i, k);
      if (T >= tm.t0 && T <= tm.end) out.push({ id: `pad${i}:${k}`, start: tm.t0 });
    });
    this.cruise.forEach((c, j) => {
      const span = c.line.length / c.speed, n = Math.ceil(span / c.every) + 1, k0 = Math.floor(T / c.every);
      for (let k = k0 - n; k <= k0; k++) {
        const x = T - k * c.every;
        if (x < 0 || x > span || hash01(this.seed + 303, j, k) < 0.18) continue;
        out.push({ id: `cruise${j}_${k}`, start: k * c.every });
      }
    });
    this.parked.forEach((_, i) => { const r = Math.floor(T / PARK_ROTATE); out.push({ id: `park${i}:${r}`, start: r * PARK_ROTATE }); });
    return out;
  }

  /** Every ship in the sky / on a pad at time t (s). Poses are written into `pool` objects (reused by key). */
  sample(t: number, out: ShipPose[], pool: Map<string, ShipPose>): ShipPose[] {
    out.length = 0;
    const get = (key: string, ship: string) => {
      let p = pool.get(key);
      if (!p) { p = { key, ship, pos: new THREE.Vector3(), quat: new THREE.Quaternion(), gear: 0, thrust: 1, phase: 'cruise', landing: 0 }; pool.set(key, p); }
      p.ship = ship;
      return p;
    };
    this.pads.forEach((_, i) => { const s = this.samplePad(i, t, get); if (s) out.push(s); });
    this.cruise.forEach((c, j) => {
      const span = c.line.length / c.speed;                       // s to cross the lane
      const n = Math.ceil(span / c.every) + 1;
      const k0 = Math.floor(t / c.every);
      for (let k = k0 - n; k <= k0; k++) { const s = this.sampleCruise(j, k, t, get); if (s) out.push(s); }
    });
    this.parked.forEach((_, i) => { const s = this.sampleParked(i, t, get); if (s) out.push(s); });
    // drop pool entries not seen for a while
    if (pool.size > 64) for (const [k, v] of pool) if (!out.includes(v)) pool.delete(k);
    return out;
  }

  private samplePad(i: number, t: number, get: (key: string, ship: string) => ShipPose): ShipPose | null {
    {
      const pp = this.pads[i];
      const k = Math.floor((t + pp.offset) / pp.cycle), u = (t + pp.offset) - k * pp.cycle;
      const tm = this.padTiming(i, k);
      const { h, ship, L, Ta, Tt, Td, Tp, Ts, Tl, Tdep, fixed, start } = tm;
      let x = u - start;
      if (x < 0 || x > fixed + Tp) return null;
      const s = get(`pad${i}`, ship);
      s.flight = `pad${i}:${k}`; s.start = tm.t0;
      const hoverH = 30 + L * 0.35;
      const P = pp.P, H = pp.H;
      // approach from behind the pad (away from the lounge), swinging round from one side
      const side = h(4) < 0.5 ? -1 : 1;
      const aAng = (0.35 + 0.6 * h(5)) * side;
      const dirA = tv.copy(H).applyAxisAngle(UP, aAng).clone();
      const Hv = P.clone().addScaledVector(UP, hoverH);
      if ((x -= 0) < Ta) {
        const A0 = P.clone().addScaledVector(dirA, 1500 + L * 4).addScaledVector(UP, 380 + L);
        const A1 = P.clone().addScaledVector(dirA, 650).addScaledVector(UP, 190 + L * 0.5);
        const A2 = Hv.clone().addScaledVector(dirA, 90 + L * 0.8).addScaledVector(UP, 10);
        const f = x / Ta, e = 1 - (1 - f) * (1 - f);           // decelerating
        bez(A0, A1, A2, Hv, e, s.pos);
        const tan = bezTan(A0, A1, A2, Hv, e, tv2).multiplyScalar(-1).negate();
        const bank = -side * 0.35 * Math.sin(Math.PI * Math.min(1, f * 1.3));
        orient(tan, bank, s.quat);
        s.gear = clamp01((f - 0.82) / 0.15); s.thrust = 1.2 - 0.5 * f; s.phase = 'approach'; s.landing = clamp01((f - 0.7) * 3);
        return s;
      }
      x -= Ta;
      const approachYaw = new THREE.Quaternion(); orient(tv2.copy(dirA).negate(), 0, approachYaw);
      const padYaw = new THREE.Quaternion(); orient(H, 0, padYaw);
      if (x < Tt) {
        s.pos.copy(Hv).addScaledVector(UP, -3 * ease(x / Tt));
        s.quat.copy(approachYaw).slerp(padYaw, ease(x / Tt));
        s.gear = 1; s.thrust = 0.7; s.phase = 'hover'; s.landing = 1;
        return s;
      }
      x -= Tt;
      if (x < Td) {
        const f = ease(x / Td);
        s.pos.copy(P).addScaledVector(UP, (hoverH - 3) * (1 - f));
        s.quat.copy(padYaw);
        s.gear = 1; s.thrust = 0.65 - 0.25 * f; s.phase = 'descend'; s.landing = 1;
        return s;
      }
      x -= Td;
      if (x < Tp) {
        s.pos.copy(P); s.quat.copy(padYaw); s.gear = 1; s.thrust = x < 3 ? 0.4 - x * 0.08 : 0.15; s.phase = 'parked'; s.landing = 0;
        return s;
      }
      x -= Tp;
      if (x < Ts) {
        s.pos.copy(P).addScaledVector(UP, 0.15 * Math.sin(x * 20) * (x / Ts) * 0.3);
        s.quat.copy(padYaw); s.gear = 1; s.thrust = 0.15 + 0.6 * (x / Ts); s.phase = 'spool'; s.landing = 0.6;
        return s;
      }
      x -= Ts;
      if (x < Tl) {
        const f = ease(x / Tl);
        s.pos.copy(P).addScaledVector(UP, (hoverH * 0.8) * f);
        s.quat.copy(padYaw); s.gear = 1 - clamp01((x / Tl - 0.5) * 2.5); s.thrust = 0.8; s.phase = 'lift'; s.landing = 0.6 * (1 - f);
        return s;
      }
      x -= Tl;
      {
        const dside = h(6) < 0.5 ? -1 : 1;
        const dirD = tv.copy(H).applyAxisAngle(UP, (0.15 + 0.5 * h(7)) * dside).clone();
        const D0 = P.clone().addScaledVector(UP, hoverH * 0.8);
        const D1 = D0.clone().addScaledVector(H, 60 + L).addScaledVector(UP, 25);
        const D2 = P.clone().addScaledVector(dirD, 700).addScaledVector(UP, 260 + L);
        const D3 = P.clone().addScaledVector(dirD, 2600 + L * 5).addScaledVector(UP, 900 + L * 2);
        const f = x / Tdep, e = f * f * (0.4 + 0.6 * f) + 0.0;   // accelerating
        bez(D0, D1, D2, D3, Math.min(1, e), s.pos);
        const tan = bezTan(D0, D1, D2, D3, Math.max(0.02, Math.min(1, e)), tv2);
        orient(tan, dside * 0.25 * Math.sin(Math.PI * f), s.quat);
        s.gear = 0; s.thrust = 1 + 1.2 * clamp01(f * 1.6); s.phase = 'depart'; s.landing = 0;
        if (f > 0.97) return null;           // gone into the haze
        return s;
      }
    }
  }

  private sampleCruise(j: number, k: number, t: number, get: (key: string, ship: string) => ShipPose): ShipPose | null {
    const c = this.cruise[j];
    const span = c.line.length / c.speed;                         // s to cross the lane
    const x = t - k * c.every;
    if (x < 0 || x > span) return null;
    if (hash01(this.seed + 303, j, k) < 0.18) return null;       // a gap now and then
    const ship = c.ships[Math.floor(hash01(this.seed + 404, j, k) * c.ships.length) % c.ships.length];
    const s = get(`cruise${j}_${k}`, ship);
    s.flight = `cruise${j}_${k}`; s.start = k * c.every;
    const lift = (hash01(this.seed + 505, j, k) - 0.5) * 60;
    c.line.at(x * c.speed, s.pos, tv2);
    s.pos.y += lift + Math.sin(t * 0.4 + k) * 1.5;
    orient(tv2, Math.sin(t * 0.2 + k) * 0.04, s.quat);
    s.gear = 0; s.thrust = 1; s.phase = 'cruise'; s.landing = 0;
    return s;
  }

  private sampleParked(i: number, t: number, get: (key: string, ship: string) => ShipPose): ShipPose {
    const pk = this.parked[i];
    const s = get(`park${i}`, pk.ship);
    const r = Math.floor(t / PARK_ROTATE);
    s.flight = `park${i}:${r}`; s.start = r * PARK_ROTATE;
    s.pos.copy(pk.pos); s.quat.copy(pk.quat); s.gear = 1; s.thrust = 0.12; s.phase = 'parked'; s.landing = 0;
    return s;
  }
}
export { tm, tq };
