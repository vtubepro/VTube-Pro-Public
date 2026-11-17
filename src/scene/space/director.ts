// Space-battle director: DETERMINISTIC and closed-form. Every act (a fighter flyby, a dogfight, a strafing run, a warp
// visit, an orbital barrage, an orbital laser, a threat event, a drop pod's re-entry …) is planned from
// hash(seed, slot / event id) + the room's anchors, and then SAMPLED at wall-clock time — no simulation state — so the
// studio preview, every OBS page and party guests (same seed + epoch, host clock) draw exactly the same sky, and a page
// opened mid-act shows mid-act. Positions are authored space units (the space group compresses them, see spaceRoom.ts).
import * as THREE from 'three';
import { SPACE_PACING, spaceActOn, type SceneSpaceState, type SpaceEventStamp } from '../../../shared/space.ts';
import { hash32, Rng } from '../raid/rng.ts';
import { IMPACT } from './backdrop.ts';
import { SPRITE, type SpaceFx } from './fx.ts';
import type { ShipKind, ShipMeta, ShipSet } from './ships.ts';
import type { SpaceRoom } from './spaceRoom.ts';
import { govern, pageGovernor, safeAmp } from '../../../shared/flashGovernor.ts';

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
const smooth = (v: number) => { const k = clamp01(v); return k * k * (3 - 2 * k); };
const easeOut = (v: number) => 1 - (1 - clamp01(v)) ** 3;
const easeIn = (v: number) => clamp01(v) ** 3;
const UP = V(0, 1, 0);

export interface Impact { dir: V3; age: number; size: number; kind: number; dur: number; seed: number }
export interface Frame {
  now: number; t: number;
  ships: ShipSet; fx: SpaceFx;
  impacts: Impact[];
  /** Bridge: red alert 0..1, white flash 0..1 (+ colour), camera shake 0..1. */
  alert: number; flash: number; flashCol: THREE.Color; shake: number;
  /** One-shot moments this frame (act key + what) — the page fires light cues from them. */
  moments: { key: string; what: string }[];
  labels: { key: string; text: string; sub: string; pos: V3; alpha: number }[];
  detail: number;
}

// ------------------------------------------------------------------------------------------------ geometry helpers
const _m = new THREE.Matrix4(), _x = V(), _y = V(), _z = V();
function orient(fwd: V3, up: V3, out = new THREE.Quaternion()): THREE.Quaternion {
  _z.copy(fwd).normalize();
  _x.crossVectors(up, _z);
  if (_x.lengthSq() < 1e-8) _x.crossVectors(Math.abs(_z.x) < 0.9 ? V(1, 0, 0) : V(0, 0, 1), _z);
  _x.normalize();
  _y.crossVectors(_z, _x);
  _m.makeBasis(_x, _y, _z);
  return out.setFromRotationMatrix(_m);
}
function bez(p0: V3, p1: V3, p2: V3, p3: V3, u: number, out = V()) {
  const a = 1 - u;
  return out.set(0, 0, 0).addScaledVector(p0, a * a * a).addScaledVector(p1, 3 * a * a * u).addScaledVector(p2, 3 * a * u * u).addScaledVector(p3, u * u * u);
}
class Path {
  readonly curve: THREE.CatmullRomCurve3;
  readonly length: number;
  constructor(pts: V3[], closed = false) { this.curve = new THREE.CatmullRomCurve3(pts, closed, 'centripetal'); this.curve.arcLengthDivisions = 160; this.length = this.curve.getLength(); }
  at(s: number, out = V()) { return this.curve.getPointAt(this.closed ? ((s / this.length) % 1 + 1) % 1 : clamp01(s / this.length), out); }
  tan(s: number, out = V()) { return this.curve.getTangentAt(this.closed ? ((s / this.length) % 1 + 1) % 1 : clamp01(s / this.length), out); }
  get closed() { return this.curve.closed; }
}
const _t0 = V(), _t1 = V(), _lat = V(), _up = V(), _q = new THREE.Quaternion();
/** Flight pose on a path at arc length s: nose along the tangent, banking into turns. */
function flyPose(p: Path, s: number, pos: V3, q: THREE.Quaternion, bank = 1, roll = 0) {
  p.at(s, pos);
  p.tan(s - 8, _t0); p.tan(s + 8, _t1);
  const fwd = p.tan(s, V());
  _lat.subVectors(_t1, _t0); _lat.addScaledVector(fwd, -_lat.dot(fwd));
  _up.copy(UP).addScaledVector(_lat, 9 * bank).normalize();
  orient(fwd, _up, q);
  if (roll) q.multiply(_q.setFromAxisAngle(V(0, 0, 1), roll));
  return fwd;
}
const local = (pos: V3, q: THREE.Quaternion, p: number[] | undefined, s = 1, out = V()) => (p ? out.set(p[0] * s, p[1] * s, p[2] * s).applyQuaternion(q).add(pos) : out.copy(pos));

// ------------------------------------------------------------------------------------------------ room geometry
export class SpaceGeo {
  readonly targets: V3[] = [];
  readonly zones: THREE.Vector4[] = [];
  readonly friendly: { kind: ShipKind; pos: V3; q: THREE.Quaternion; fwd: V3; i: number }[] = [];
  readonly glassD: number;     // eye → glass distance along the view normal (authored)
  constructor(readonly R: SpaceRoom, readonly meta: Record<string, ShipMeta>, seed: number) {
    const v = R.view;
    this.glassD = Math.max(1, v.center.clone().sub(R.eye).dot(v.normal));
    // planet targets: rays from the eye through the window grid that hit the planet
    const ray = new THREE.Ray(), sph = new THREE.Sphere(R.planet.center, R.planet.radius), hit = V();
    // (surface that faces the viewer — targets on the grazing limb would be invisible slivers)
    for (const minFace of [0.35, 0.15, -1]) {
      for (let j = 0; j < 12; j++) for (let i = 0; i < 20; i++) {
        const a = (i / 19 - 0.5) * 1.6, b = (j / 11 - 0.5) * 1.7;
        const wp = v.center.clone().addScaledVector(v.right, (a * v.width) / 2 / R.k).addScaledVector(v.up, (b * v.height) / 2 / R.k);
        ray.set(R.eye, wp.sub(R.eye).normalize());
        if (!ray.intersectSphere(sph, hit)) continue;
        const n = hit.clone().sub(R.planet.center).normalize();
        if (-n.dot(ray.direction) >= minFace) this.targets.push(n);
      }
      if (this.targets.length >= 12) break;
      this.targets.length = 0;
    }
    // the room's own combat sites first (SPACE_BATTLE_xx)
    if (R.sites.length >= 3) { this.targets.length = 0; for (const s of R.sites) for (let i = 0; i < 4; i++) this.targets.push(s.clone()); }
    if (this.targets.length < 8) {
      const toV = v.center.clone().sub(R.planet.center).normalize();
      const r = new Rng(77);
      while (this.targets.length < 60) { const d = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize(); if (d.dot(toV) > 0.75) this.targets.push(d); }
    }
    // war zones on the visible side (day / night mix)
    const zr = new Rng(hash32(seed, 'zones'));
    const zsrc = R.sites.length >= 3 ? R.sites : this.targets;
    for (let i = 0; i < 6 && zsrc.length; i++) {
      const d = R.sites.length >= 3 ? zsrc[i % zsrc.length] : zsrc[zr.int(zsrc.length)];
      if (this.zones.some((z) => V(z.x, z.y, z.z).distanceTo(d) < 0.1)) continue;
      this.zones.push(new THREE.Vector4(d.x, d.y, d.z, zr.range(0.05, 0.1)));
    }
    // (a room that doesn't keep the 'fleet' act has no parked capital ships: nothing launches from / defends with them)
    if (spaceActOn(R.acts, 'fleet')) R.ships.forEach((s, i) => {
      const fwd = s.fwd.clone().normalize();
      this.friendly.push({ kind: s.kind === 'frigate' ? 'FRIGATE' : 'SD', pos: s.p.clone(), q: orient(fwd, UP), fwd, i });
    });
  }
  /** A point in the window's view cone (authored), `d` = distance from the eye as a fraction range. */
  inView(r: Rng, dMin: number, dMax: number, spread = 0.85, out = V(), bMin = -spread * 0.8, bMax = spread): V3 {
    const v = this.R.view, k = this.R.k;
    const a = r.range(-spread, spread), b = r.range(bMin, bMax);
    const wp = v.center.clone().addScaledVector(v.right, (a * v.width) / 2 / k).addScaledVector(v.up, (b * v.height) / 2 / k);
    const dir = wp.sub(this.R.eye).normalize();
    const along = dir.dot(v.normal);
    const minD = (this.glassD + 40) / Math.max(0.2, along);
    return out.copy(this.R.eye).addScaledVector(dir, Math.max(minD, r.range(dMin, dMax)));
  }
  /** Keep a point outside the glass (≥ margin authored units beyond the viewport plane) and out of the keep-out boxes. */
  outside(p: V3, margin = 40, keep = true): V3 {
    const d = p.clone().sub(this.R.view.center).dot(this.R.view.normal);
    if (d < margin) p.addScaledVector(this.R.view.normal, margin - d);
    if (keep) for (const b of this.R.keepOut) {
      const e = b.clone().expandByScalar(30);
      if (e.containsPoint(p)) p.y = e.max.y;
    }
    return p;
  }
  /** How well the room's main camera sees a (nominal) point: 1 = centre of frame … 0 = outside. */
  seen(p: V3): number {
    const c = this.R.cam0;
    if (!c) return 1;
    this.cam ??= (() => { const k = new THREE.PerspectiveCamera(c.fov, 16 / 9, 0.1, 1e5); k.position.copy(c.position); k.quaternion.copy(c.quaternion); k.updateMatrixWorld(); k.updateProjectionMatrix(); return k; })();
    const r = p.clone().sub(this.R.view.center).multiplyScalar(this.R.k).add(this.R.view.center).project(this.cam);
    if (r.z > 1) return 0;
    return clamp01(1 - Math.max(Math.abs(r.x), Math.abs(r.y)));
  }
  private cam: THREE.PerspectiveCamera | null = null;
  /** Out of the keep-out boxes (our hull) sideways — along the viewport's right axis — plus a margin. */
  aside(p: V3, margin = 40): V3 {
    const rt = this.R.view.right;
    for (const b of this.R.keepOut) {
      const e = b.clone().expandByScalar(margin);
      if (!e.containsPoint(p)) continue;
      const c = e.getCenter(V());
      const half = Math.abs(rt.x) * (e.max.x - e.min.x) / 2 + Math.abs(rt.z) * (e.max.z - e.min.z) / 2;
      const side = Math.sign(p.clone().sub(c).dot(rt)) || 1;
      p.addScaledVector(rt, side * half - p.clone().sub(c).dot(rt));
    }
    return p;
  }
  /** A muzzle on OUR ship (SPACE_CANNON_xx), when the room has them. */
  cannon(r: Rng) { const c = this.R.cannons; return c.length ? c[r.int(c.length)] : null; }
  surface(dir: V3, out = V(), lift = 0) { return out.copy(dir).multiplyScalar(this.R.planet.radius + lift).add(this.R.planet.center); }
  private good: V3[] | null = null;
  /** A planet target the main camera sees (falls back to any). */
  target(r: Rng) {
    this.good ??= this.targets.filter((d) => this.seen(this.surface(d)) > 0.2);
    const l = this.good.length >= 3 ? this.good : this.targets;
    return l[r.int(l.length)].clone();
  }
  jitterDir(d: V3, r: Rng, amt: number) { return d.clone().add(V(r.range(-amt, amt), r.range(-amt, amt), r.range(-amt, amt))).normalize(); }
  nearestFriendly(p: V3, kind?: ShipKind) {
    let best = this.friendly[0] ?? null, bd = Infinity;
    for (const f of this.friendly) { if (kind && f.kind !== kind) continue; const d = f.pos.distanceTo(p); if (d < bd) { bd = d; best = f; } }
    return best;
  }
}

// ------------------------------------------------------------------------------------------------ acts
export interface Act { key: string; kind: string; start: number; dur: number; seed: number; ev?: SpaceEventStamp; data: unknown }
type Planner = (g: SpaceGeo, r: Rng, a: Act) => { dur: number; data: unknown };
type Sampler = (g: SpaceGeo, a: Act, tau: number, F: Frame) => void;
const ACTS: Record<string, { plan: Planner; sample: Sampler }> = {};

// ---- shared drawing helpers
/** Where support labels hang: just outside the glass, upper middle of the viewport. */
const labelPos = (g: SpaceGeo) => g.R.view.center.clone().addScaledVector(g.R.view.up, (g.R.view.height * 0.3) / g.R.k).addScaledVector(g.R.view.normal, 120);
function engines(F: Frame, meta: ShipMeta | undefined, pos: V3, q: THREE.Quaternion, s: number, power: number, col: [number, number, number] = [0.55, 0.8, 1], seed = 0) {
  if (!meta) return;
  for (let i = 0; i < meta.engines.length; i++) {
    const e = local(pos, q, meta.engines[i], s);
    const fl = 0.85 + safeAmp(0.15) * Math.sin(F.t * 31 + i * 1.7 + seed);   // (engine flicker: < 10 % with the flash limit on)
    F.fx.sprite(e, meta.engineR * s * (1.6 + power * 0.9), col[0] * 1.3, col[1] * 1.3, col[2] * 1.3, 0.75 * fl * Math.min(1, power + 0.25), SPRITE.glow, seed + i * 0.1);
    F.fx.sprite(e, meta.engineR * s * 0.9, 1, 1, 1, 0.6 * power * fl, SPRITE.core, seed);
  }
}
function navLights(F: Frame, meta: ShipMeta | undefined, pos: V3, q: THREE.Quaternion, s: number, seed: number) {
  if (!meta) return;
  for (const l of meta.lights) {
    const on = l.blink > 0 ? (((F.t + seed) % l.blink) < 0.12 ? 1 : 0) : 0.8;
    if (!on) continue;
    const c = l.c === 'red' ? [1, 0.15, 0.1] : l.c === 'green' ? [0.2, 1, 0.35] : [1, 1, 1];
    F.fx.sprite(local(pos, q, l.p, s), 2.2 * s + 1.5, c[0], c[1], c[2], on, SPRITE.flare, seed);
  }
}
function trail(F: Frame, pts: V3[], w: number, col: [number, number, number], alpha: number) {
  for (let i = 0; i < pts.length - 1; i++) {
    const a = alpha * (1 - i / (pts.length - 1));
    F.fx.line(pts[i + 1], pts[i], w * (1 - i / pts.length * 0.6), 1.2, col[0], col[1], col[2], a, false);
  }
}
/** Explosion at `tau` seconds after it went off (fireball, flash, sparks, smoke). */
function boom(F: Frame, p: V3, tau: number, size: number, seed: number, smoke = true) {
  if (tau < 0) return;
  const r = new Rng(seed);
  if (tau < 0.25) F.fx.sprite(p, size * (1.5 + tau * 6), 1.4, 1.2, 1, 1 - tau / 0.25, SPRITE.flare, r.next());
  if (tau < 1.6) F.fx.sprite(p, size * (0.5 + easeOut(tau / 1.2) * 1.1), 1.3, 1.0, 0.8, (1 - smooth(tau / 1.6)) * 1.2, SPRITE.fire, r.next());
  if (tau < 0.9) F.fx.sprite(p, size * 0.6, 1.4, 1.3, 1.1, 1 - tau / 0.9, SPRITE.core, 0);
  const n = F.detail > 0 ? 9 : 4;
  for (let i = 0; i < n; i++) {
    const d = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
    const sp = size * r.range(1.2, 3.2);
    if (tau < 1.4) {
      const a = p.clone().addScaledVector(d, sp * easeOut(tau / 1.4) * 1.6);
      const b = p.clone().addScaledVector(d, sp * easeOut(Math.max(0, tau - 0.12) / 1.4) * 1.6);
      F.fx.line(b, a, size * 0.05, 1.3, 1, 0.7, 0.35, 1 - tau / 1.4, false);
    }
  }
  if (smoke && tau < 7) for (let i = 0; i < (F.detail > 0 ? 3 : 1); i++) {
    const d = V(r.range(-1, 1), r.range(-0.5, 1), r.range(-1, 1)).normalize();
    const age = tau - 0.3;
    if (age > 0) F.fx.puff(p.clone().addScaledVector(d, size * (0.3 + age * 0.25)), size * (0.7 + age * 0.22), 0.12, 0.11, 0.1, 0.55 * (1 - smooth(age / 6.5)), r.next());
  }
}
/** Warp flash + tunnel lines (dir = travel direction). k: 0..1 progress of the flash; col = tint. */
function warpFlash(F: Frame, p: V3, dir: V3, size: number, age: number, seed: number, col: [number, number, number], inbound: boolean) {
  if (age < 0 || age > 2.2) return;
  const r = new Rng(seed);
  const flash = age < 0.55 ? smooth(age / 0.45) : Math.exp(-(age - 0.55) * 3.2);
  F.fx.sprite(p, size * (0.6 + flash * 1.6), col[0] * 1.4, col[1] * 1.4, col[2] * 1.4, flash, SPRITE.flare, r.next());
  F.fx.sprite(p, size * 0.5 * flash, 1.4, 1.4, 1.4, flash, SPRITE.core, 0);
  if (age > 0.4 && age < 2.0) F.fx.sprite(p, size * (0.8 + (age - 0.4) * 2.4), col[0], col[1], col[2], 0.8 * (1 - (age - 0.4) / 1.6), SPRITE.ring, r.next());
  // tunnel lines streaming in along the travel direction
  if (age < 1.1) {
    const u = V(), w = V();
    u.crossVectors(dir, UP); if (u.lengthSq() < 1e-6) u.set(1, 0, 0); u.normalize(); w.crossVectors(dir, u);
    const n = F.detail > 0 ? 26 : 12;
    for (let i = 0; i < n; i++) {
      const ang = r.next() * Math.PI * 2, rad = size * r.range(0.4, 2.4);
      const off = u.clone().multiplyScalar(Math.cos(ang) * rad).addScaledVector(w, Math.sin(ang) * rad);
      const L = size * r.range(6, 14), ph = clamp01(age / 1.1 + r.range(-0.15, 0.15));
      const head = inbound ? p.clone().add(off.clone().multiplyScalar(1 - ph)).addScaledVector(dir, -L * (1 - ph) * 2) : p.clone().add(off.clone().multiplyScalar(ph)).addScaledVector(dir, L * ph * 2);
      const tail = head.clone().addScaledVector(dir, inbound ? -L : -L * 0.6);
      F.fx.line(tail, head, size * 0.04, 1.1, col[0], col[1], col[2], 0.85 * (1 - ph), false);
    }
  }
}

// ---- patrols (ambient, continuous)
interface PatrolData { path: Path; v: number; n: number; phase: number; kind: ShipKind; offs: [number, number, number][] }
function planPatrol(g: SpaceGeo, r: Rng): PatrolData {
  const c = g.inView(r, 500, 1100, 0.6);
  const pts: V3[] = [];
  const n = 6, R = r.range(180, 380);
  const a0 = r.next() * Math.PI * 2;
  const tilt = V(r.range(-0.3, 0.3), 1, r.range(-0.3, 0.3)).normalize();
  const u = V().crossVectors(tilt, g.R.view.normal).normalize(), w = V().crossVectors(tilt, u).normalize();
  for (let i = 0; i < n; i++) {
    const a = a0 + (i / n) * Math.PI * 2;
    const rr = R * r.range(0.75, 1.25);
    pts.push(g.outside(c.clone().addScaledVector(u, Math.cos(a) * rr * 1.4).addScaledVector(w, Math.sin(a) * rr).addScaledVector(tilt, r.range(-60, 60)), 80));
  }
  const cnt = 2 + r.int(3);
  const offs: [number, number, number][] = [];
  for (let j = 0; j < cnt; j++) offs.push([((j % 2) * 2 - 1) * Math.ceil(j / 2) * 16, -j * 2, -j * 14]);
  return { path: new Path(pts, true), v: r.range(55, 80), n: cnt, phase: r.next(), kind: 'EAGLE', offs };
}
function samplePatrol(g: SpaceGeo, d: PatrolData, secs: number, F: Frame) {
  const L = d.path.length;
  const s0 = (secs * d.v + d.phase * L) % L;
  const pos = V(), q = new THREE.Quaternion(), meta = g.meta.EAGLE;
  for (let j = 0; j < d.n; j++) {
    const s = s0 + d.offs[j][2];
    const fwd = flyPose(d.path, s, pos, q, 1);
    const right = V(1, 0, 0).applyQuaternion(q), up = V(0, 1, 0).applyQuaternion(q);
    pos.addScaledVector(right, d.offs[j][0]).addScaledVector(up, d.offs[j][1]);
    F.ships.push({ kind: d.kind, pos, quat: q });
    engines(F, meta, pos, q, 1, 0.8, undefined, j);
    navLights(F, meta, pos, q, 1, j);
    if (F.detail > 0) {
      const tr = [local(pos, q, meta?.engines[0])];
      for (let i = 1; i <= 4; i++) tr.push(tr[0].clone().addScaledVector(fwd, -i * 9));
      trail(F, tr, 0.5, [0.5, 0.75, 1], 0.35);
    }
  }
}

// ---- pelicans (ambient shuttle runs down to the surface and back)
interface PelData { from: V3; c1: V3; c2: V3; to: V3; dir: V3; down: boolean }
function planPelican(g: SpaceGeo, r: Rng): PelData | null {
  const f = g.friendly.length ? g.friendly[r.int(g.friendly.length)] : null;
  const from = f ? f.pos.clone().add(V(r.range(-60, 60), r.range(-30, 0), r.range(-60, 60))) : g.inView(r, 400, 800);
  const dir = g.target(r);
  const to = g.surface(dir, V(), 25);
  const c1 = from.clone().add(V(r.range(-200, 200), -120, r.range(-200, 200)));
  const c2 = g.surface(dir, V(), 500).add(V(r.range(-150, 150), 0, r.range(-150, 150)));
  return { from, c1, c2, to, dir, down: r.chance(0.6) };
}
function samplePelican(g: SpaceGeo, d: PelData, tau: number, dur: number, F: Frame, seed: number) {
  const u0 = clamp01(tau / dur), u = d.down ? easeIn(u0) * 0.7 + u0 * 0.3 : 1 - (easeIn(1 - u0) * 0.7 + (1 - u0) * 0.3);
  const pos = bez(d.from, d.c1, d.c2, d.to, u), ahead = bez(d.from, d.c1, d.c2, d.to, clamp01(u + (d.down ? 0.01 : -0.01)));
  const fwd = ahead.sub(pos).normalize();
  const q = orient(fwd, UP);
  const alt = pos.distanceTo(g.R.planet.center) - g.R.planet.radius;
  const fade = smooth(alt / 120) * smooth(tau / 1.5) * smooth((dur - tau) / 1.5);
  F.ships.push({ kind: 'PELICAN', pos, quat: q, fade });
  engines(F, g.meta.PELICAN, pos, q, 1, 0.7, undefined, seed);
  navLights(F, g.meta.PELICAN, pos, q, 1, seed);
  if (alt < 260) F.fx.sprite(local(pos, q, [0, 0, 16]), 14, 1.2, 0.5, 0.15, (1 - alt / 260) * fade * 0.8, SPRITE.fire, seed);   // atmospheric entry glow
}

// ---- flyby: a formation passes close to the viewport
ACTS.flyby = {
  plan: (g, r) => {
    const v = g.R.view;
    const side = r.chance(0.5) ? 1 : -1;
    // the close pass: through the upper-middle of the window as seen from the main camera (above our own bow)
    const near = g.outside(g.inView(r, g.glassD + 120, g.glassD + 240, 0.35, V(), 0.1, 0.55), 90);
    const p0 = near.clone().addScaledVector(v.right, -side * r.range(900, 1300)).addScaledVector(v.normal, r.range(300, 700)).addScaledVector(v.up, r.range(-80, 160));
    const p3 = near.clone().addScaledVector(v.right, side * r.range(900, 1300)).addScaledVector(v.normal, r.range(200, 800)).addScaledVector(v.up, r.range(0, 260));
    const p1 = near.clone().lerp(p0, 0.45).addScaledVector(v.normal, 60), p2 = near.clone().lerp(p3, 0.45).addScaledVector(v.normal, 40);
    const path = new Path([p0, p1, near, p2, p3].map((p) => g.outside(p, 70)));
    const n = 3 + r.int(3), vv = r.range(150, 210);
    return { dur: path.length / vv + 1, data: { path, v: vv, n, roll: r.chance(0.35), kind: r.chance(0.85) || !spaceActOn(g.R.acts, 'pelican') ? 'EAGLE' : 'PELICAN' } };
  },
  sample: (g, a, tau, F) => {
    const d = a.data as { path: Path; v: number; n: number; roll: boolean; kind: ShipKind };
    const pos = V(), q = new THREE.Quaternion(), meta = g.meta[d.kind];
    for (let j = 0; j < d.n; j++) {
      const s = tau * d.v - j * 16;
      if (s < 0 || s > d.path.length) continue;
      const u = s / d.path.length;
      const roll = d.roll && j === 0 ? Math.PI * 2 * smooth((u - 0.42) / 0.2) : 0;
      const fwd = flyPose(d.path, s, pos, q, 1.2, roll);
      const right = V(1, 0, 0).applyQuaternion(q);
      pos.addScaledVector(right, ((j % 2) * 2 - 1) * Math.ceil(j / 2) * 18).addScaledVector(UP, -Math.ceil(j / 2) * 4);
      const fade = smooth(u / 0.06) * smooth((1 - u) / 0.06);
      F.ships.push({ kind: d.kind, pos, quat: q, fade });
      engines(F, meta, pos, q, 1, 1, undefined, j);
      navLights(F, meta, pos, q, 1, j + a.seed % 7);
      const tr = [local(pos, q, meta?.engines[0])];
      for (let i = 1; i <= (F.detail > 0 ? 6 : 3); i++) tr.push(tr[0].clone().addScaledVector(fwd, -i * 14));
      trail(F, tr, 0.9, [0.55, 0.8, 1], 0.55 * fade);
    }
  },
};

// ---- dogfight: fighters chase each other with tracers; the chased one usually blows up
interface Duel { path: Path; v: number; gap: number; lead: ShipKind; chase: ShipKind; kill: number; bursts: number[]; back: number[]; seed: number }
ACTS.dogfight = {
  plan: (g, r, a) => {
    const pairs = 1 + (r.chance(0.45) ? 1 : 0) + (r.chance(0.2) ? 1 : 0);
    const duels: Duel[] = [];
    let dur = 0;
    for (let i = 0; i < pairs; i++) {
      const pts: V3[] = [];
      const c = g.inView(r, g.glassD + 200, g.glassD + 520, 0.6, V(), -0.1, 0.7);
      for (let k = 0; k < 7; k++) pts.push(g.outside(c.clone().add(V(r.range(-380, 380), r.range(-160, 160), r.range(-300, 300))).addScaledVector(g.R.view.right, (k - 3) * 110), 80));
      const path = new Path(pts);
      const v = r.range(95, 130);
      const len = Math.min(path.length / v, 22);
      const eagleChases = r.chance(0.75);
      const bursts: number[] = [], back: number[] = [];
      for (let t = r.range(0.8, 2); t < len - 2; t += r.range(1.2, 2.4)) bursts.push(t);
      for (let t = r.range(2, 4); t < len - 3; t += r.range(3, 5)) back.push(t);
      duels.push({ path, v, gap: r.range(40, 70), lead: eagleChases ? 'BOT_FIGHTER' : 'EAGLE', chase: eagleChases ? 'EAGLE' : 'BOT_FIGHTER', kill: r.chance(0.8) ? len - r.range(1.5, 4) : Infinity, bursts, back, seed: hash32(a.seed, i) });
      dur = Math.max(dur, len + 8);
    }
    return { dur, data: duels };
  },
  sample: (g, a, tau, F) => {
    for (const d of a.data as Duel[]) {
      const len = Math.min(d.path.length / d.v, 22);
      if (tau > len + 8) continue;
      const pl = V(), ql = new THREE.Quaternion(), pc = V(), qc = new THREE.Quaternion();
      const sl = Math.min(tau, len) * d.v, sc = sl - d.gap;
      const fwdL = flyPose(d.path, sl, pl, ql, 1.6, Math.sin(tau * 1.3 + d.seed) * 0.5);
      const fwdC = flyPose(d.path, sc, pc, qc, 1.6);
      pc.addScaledVector(V(1, 0, 0).applyQuaternion(qc), Math.sin(tau * 0.9) * 8).addScaledVector(UP, Math.cos(tau * 1.1) * 5);
      const fin = smooth((len + 8 - tau) / 1.5) * smooth(tau / 0.8);
      const leaderAlive = tau < d.kill;
      if (tau < len) {
        if (leaderAlive) {
          F.ships.push({ kind: d.lead, pos: pl, quat: ql, fade: fin });
          engines(F, g.meta[d.lead], pl, ql, 1, 1, d.lead === 'BOT_FIGHTER' ? [1, 0.35, 0.12] : undefined, d.seed);
          trail(F, [local(pl, ql, g.meta[d.lead]?.engines[0]), pl.clone().addScaledVector(fwdL, -30), pl.clone().addScaledVector(fwdL, -60)], 0.7, d.lead === 'BOT_FIGHTER' ? [1, 0.4, 0.15] : [0.55, 0.8, 1], 0.4 * fin);
        }
        F.ships.push({ kind: d.chase, pos: pc, quat: qc, fade: fin });
        engines(F, g.meta[d.chase], pc, qc, 1, 1, d.chase === 'BOT_FIGHTER' ? [1, 0.35, 0.12] : undefined, d.seed + 1);
        trail(F, [local(pc, qc, g.meta[d.chase]?.engines[0]), pc.clone().addScaledVector(fwdC, -30), pc.clone().addScaledVector(fwdC, -60)], 0.7, d.chase === 'BOT_FIGHTER' ? [1, 0.4, 0.15] : [0.55, 0.8, 1], 0.4 * fin);
      } else if (tau < len + 8) {
        // chaser peels off
        const s = sc + (tau - len) * d.v * 1.2;
        const pos = V(), q = new THREE.Quaternion();
        const f2 = flyPose(d.path, Math.min(s, d.path.length), pos, q, 1);
        pos.addScaledVector(f2, Math.max(0, s - d.path.length));
        F.ships.push({ kind: d.chase, pos, quat: q, fade: fin });
        engines(F, g.meta[d.chase], pos, q, 1, 1, d.chase === 'BOT_FIGHTER' ? [1, 0.35, 0.12] : undefined, d.seed + 1);
      }
      // tracers: chaser bursts at the leader, the leader sometimes fires back over its shoulder
      const shots = (list: number[], from: 'c' | 'l') => {
        for (const b of list) {
          for (let k = 0; k < 7; k++) {
            const tf = b + k * 0.07, age = tau - tf;
            if (age < 0 || age > 0.45) continue;
            if (from === 'c' && tf > Math.min(d.kill, len)) continue;
            const r = new Rng(hash32(d.seed, b, k, from));
            const sp = from === 'c' ? pc : pl, tg = from === 'c' ? pl : pc;
            const q2 = from === 'c' ? qc : ql;
            const mz = local(sp, q2, g.meta[from === 'c' ? d.chase : d.lead]?.guns[k % 2]);
            const dir = tg.clone().sub(mz).normalize().add(V(r.range(-0.04, 0.04), r.range(-0.04, 0.04), r.range(-0.04, 0.04))).normalize();
            const head = mz.clone().addScaledVector(dir, 40 + age * 900), tail = head.clone().addScaledVector(dir, -32);
            const bot = (from === 'c' ? d.chase : d.lead) === 'BOT_FIGHTER';
            F.fx.line(tail, head, 0.45, 1.4, bot ? 1 : 1, bot ? 0.25 : 0.8, bot ? 0.1 : 0.3, 0.95, false);
            if (k === 0 && age < 0.05) F.fx.sprite(mz, 3, 1.2, bot ? 0.4 : 0.9, 0.3, 1, SPRITE.flare, r.next());
            if (from === 'c' && r.chance(0.35) && age > 0.08 && age < 0.25 && leaderAlive) F.fx.sprite(pl.clone().add(V(r.range(-3, 3), r.range(-2, 2), r.range(-3, 3))), 3.5, 1.3, 1, 0.6, 1 - age * 4, SPRITE.flare, r.next());
          }
        }
      };
      shots(d.bursts, 'c');
      if (leaderAlive) shots(d.back, 'l');
      // the kill
      if (tau >= d.kill) {
        const kt = tau - d.kill;
        const kp = V(), kq = new THREE.Quaternion();
        const kf = flyPose(d.path, d.kill * d.v, kp, kq, 1.6);
        kp.addScaledVector(kf, kt * d.v * 0.35);
        boom(F, kp, kt, 16, d.seed + 5);
        if (kt < 6) {
          const r = new Rng(d.seed + 9);
          for (let i = 0; i < 6; i++) {
            const dd = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
            const p = kp.clone().addScaledVector(dd, kt * r.range(8, 25)).addScaledVector(kf, kt * 10);
            F.ships.push({ kind: 'DEBRIS_B', pos: p, quat: new THREE.Quaternion().setFromAxisAngle(dd, kt * r.range(1, 4)), scale: r.range(1.2, 2.6), heat: Math.max(0, 1 - kt / 2.5), fade: 1 - smooth((kt - 4) / 2) });
          }
        }
      }
    }
  },
};

// ---- strafing run: a flight of Eagles dives at the planet and carpets a target
ACTS.strafe = {
  plan: (g, r) => {
    const f = g.friendly.length ? g.friendly[r.int(g.friendly.length)] : null;
    const p0 = f ? f.pos.clone().add(V(r.range(-80, 80), r.range(-40, 20), r.range(-80, 80))) : g.inView(r, 400, 700);
    const dir = g.target(r);
    const p3 = g.surface(dir, V(), 30);
    const p1 = p0.clone().add(V(r.range(-150, 150), -60, r.range(-150, 150)));
    const p2 = g.surface(dir, V(), 350);
    const n = 3;
    const dur = r.range(9, 12);
    const tside = V().crossVectors(dir, UP).normalize();
    return { dur: dur + 18, data: { p0, p1, p2, p3, dir, n, tdur: dur, tside } };
  },
  sample: (g, a, tau, F) => {
    const d = a.data as { p0: V3; p1: V3; p2: V3; p3: V3; dir: V3; n: number; tdur: number; tside: V3 };
    const meta = g.meta.EAGLE;
    if (tau < d.tdur) for (let j = 0; j < d.n; j++) {
      const u = clamp01((tau - j * 0.35) / d.tdur);
      if (u <= 0) continue;
      const k = u * u * 0.6 + u * 0.4;
      const pos = bez(d.p0, d.p1, d.p2, d.p3, k).addScaledVector(d.tside, (j - 1) * 22);
      const ahead = bez(d.p0, d.p1, d.p2, d.p3, clamp01(k + 0.01)).addScaledVector(d.tside, (j - 1) * 22);
      const fwd = ahead.sub(pos).normalize();
      const q = orient(fwd, UP);
      const fade = smooth((1 - u) / 0.12);
      F.ships.push({ kind: 'EAGLE', pos, quat: q, fade });
      engines(F, meta, pos, q, 1, 1, undefined, j);
      if (u > 0.75) F.fx.sprite(pos, 7, 1.3, 0.55, 0.2, (u - 0.75) * 3 * fade, SPRITE.fire, j);
    }
    // bombs walk across the target
    for (let i = 0; i < 7; i++) {
      const ti = d.tdur - 0.8 + i * 0.16;
      const age = tau - ti;
      if (age < 0) continue;
      const dir = d.dir.clone().addScaledVector(d.tside, (i - 3) * 0.006).normalize();
      F.impacts.push({ dir, age, size: 0.02, kind: IMPACT.strafe, dur: 14, seed: a.seed + i });
    }
  },
};

// ---- warp visit: a friendly ship jumps in, cruises, jumps out
interface WarpData { kind: ShipKind; p: V3; fwd: V3; v: number; out: number }
function warpShip(F: Frame, g: SpaceGeo, kind: ShipKind, p: V3, fwd: V3, tau: number, outAt: number, v: number, seed: number, col: [number, number, number] = [0.55, 0.8, 1.2]) {
  const meta = g.meta[kind] ?? g.meta.SD;
  const L = meta?.length ?? 100;
  const q = orient(fwd, UP);
  let pos = p.clone(), stretch = 0, warp = 0, shown = true;
  if (tau < 0.35) shown = false;
  else if (tau < 1.0) { const e = easeOut((tau - 0.35) / 0.65); pos = p.clone().addScaledVector(fwd, -L * 14 * (1 - e)); stretch = 22 * (1 - e); warp = 1 - e * 0.7; }
  else if (tau < 2.2) warp = 0.3 * (1 - (tau - 1) / 1.2);
  const cruise = Math.max(0, Math.min(tau, outAt) - 1.0) * v;
  pos.addScaledVector(fwd, cruise);
  // jump out: charge (2.4 s of blue sparkles) → stretch forward + flash
  if (tau > outAt) {
    const k = tau - outAt;
    if (k < 2.4) {
      const r = new Rng(seed + Math.floor(tau * 20));
      for (let i = 0; i < 6; i++) F.fx.sprite(pos.clone().add(V(r.range(-1, 1), r.range(-0.4, 0.6), r.range(-1, 1)).multiplyScalar(L * 0.5)), L * 0.03, col[0], col[1], col[2], k / 2.4, SPRITE.flare, r.next());
      warp = 0.4 * (k / 2.4);
    } else {
      const j = k - 2.4;
      if (j < 0.35) { const e = easeIn(j / 0.35); pos.addScaledVector(fwd, L * 16 * e); stretch = 30 * e; warp = 0.4 + 0.6 * e; }
      else shown = false;
      warpFlash(F, p.clone().addScaledVector(fwd, cruise + L * 0.6), fwd, L * 0.7, j, seed + 3, col, false);
    }
  }
  warpFlash(F, p.clone().addScaledVector(fwd, L * 0.3), fwd.clone().negate(), L * 0.7, tau, seed + 1, col, true);
  if (shown) {
    F.ships.push({ kind, pos, quat: q, stretch, warp });
    engines(F, meta, pos, q, 1, tau > outAt ? 1 : 0.6, undefined, seed);
    navLights(F, meta, pos, q, 1, seed);
  }
  return { pos, q, shown };
}
ACTS.warp = {
  plan: (g, r) => {
    const vis = g.R.warps.filter((x) => g.seen(x.p) > 0.3 && !/warp out|departing/i.test(String(x.extras.note ?? '')));
    const wl = vis.length ? vis : g.R.warps;
    const w = wl.length ? wl[r.int(wl.length)] : null;
    const p = w ? w.p.clone() : g.inView(r, 600, 1200);
    const fwd = w ? w.fwd.clone() : g.R.view.right.clone().multiplyScalar(r.chance(0.5) ? 1 : -1).add(V(0, 0, r.range(-0.3, 0.3))).normalize();
    const kind: ShipKind = r.chance(0.55) ? 'FRIGATE' : 'SD';
    const out = r.range(18, 34);
    return { dur: out + 5, data: { kind, p, fwd, v: kind === 'SD' ? r.range(6, 12) : r.range(12, 22), out } as WarpData };
  },
  sample: (g, a, tau, F) => { const d = a.data as WarpData; warpShip(F, g, d.kind, d.p, d.fwd, tau, d.out, d.v, a.seed); },
};

// ---- orbital barrage: a destroyer's guns walk shells onto the planet
interface Shell { t: number; T: number; from: V3; dir: V3; size: number; kind: number }
ACTS.barrage = {
  plan: (g, r, a) => {
    const own = g.R.cannons.length && (a.ev || r.chance(0.5) || g.R.cannonsOnly) ? g.R.cannons : null;
    const src = own ? null : g.friendly.find((f) => f.kind === 'SD') ?? g.friendly[0] ?? null;
    const pattern = a.ev ? r.pick(['380', 'walking', '380']) : r.pick(['380', '120', 'walking', 'rail', '380']);
    const site = g.target(r);
    const shells: Shell[] = [];
    const meta = g.meta.SD;
    const from = (i: number) => own ? own[i % own.length].p.clone() : src ? local(src.pos, src.q, pattern === '120' ? meta?.guns[1 + (i % 3)] : meta?.main ?? meta?.guns[0]) : g.inView(r, 600, 900);
    const side = V().crossVectors(site, UP).normalize();
    if (pattern === 'rail') shells.push({ t: 1.2, T: 1.6, from: from(0), dir: site, size: 0.07, kind: IMPACT.rail });
    else {
      const n = pattern === '120' ? 22 : pattern === 'walking' ? 12 : 14;
      const span = pattern === '120' ? 5 : 9;
      for (let i = 0; i < n; i++) {
        const t = 0.6 + (i / n) * span + r.range(0, 0.3);
        const dir = pattern === 'walking' ? site.clone().addScaledVector(side, (i / n - 0.5) * 0.14).add(V(r.range(-0.004, 0.004), r.range(-0.004, 0.004), 0)).normalize() : g.jitterDir(site, r, pattern === '120' ? 0.03 : 0.045);
        shells.push({ t, T: r.range(2.4, 3.2), from: from(i), dir, size: pattern === '120' ? 0.02 : 0.034, kind: IMPACT.shell });
      }
    }
    const last = Math.max(...shells.map((s) => s.t + s.T));
    return { dur: last + 18, data: { shells, pattern, src: own ? own[0].p.clone() : src ? src.pos.clone() : null } };
  },
  sample: (g, a, tau, F) => {
    const d = a.data as { shells: Shell[]; pattern: string; src: V3 | null };
    const hit = V();
    for (let i = 0; i < d.shells.length; i++) {
      const s = d.shells[i];
      const k = (tau - s.t) / s.T;
      const rail = s.kind === IMPACT.rail;
      if (k >= 0 && k < 1) {
        g.surface(s.dir, hit);
        // up out of the guns, then down onto the target from high above (never through the planet)
        const span = s.from.distanceTo(hit);
        const c1 = s.from.clone().add(V(0, Math.min(380, span * 0.35), 0)).addScaledVector(g.R.view.normal, Math.min(150, span * 0.2)), c2 = g.surface(s.dir, V(), Math.min(700, span * 0.6));
        const head = bez(s.from, c1, c2, hit, k), tail = bez(s.from, c1, c2, hit, Math.max(0, k - (rail ? 0.2 : 0.07)));
        F.fx.line(tail, head, rail ? 8 : 4, rail ? 4 : 2.6, rail ? 0.55 : 1, rail ? 0.85 : 0.65, rail ? 1.3 : 0.25, 1, false);
        F.fx.sprite(head, rail ? 26 : 13, rail ? 0.7 : 1.2, rail ? 0.9 : 0.8, rail ? 1.4 : 0.4, 0.9, SPRITE.glow, i * 0.13);
      }
      const fa = tau - s.t;
      if (fa >= 0 && fa < 0.3) { F.fx.sprite(s.from, rail ? 45 : 14, 1.3, rail ? 1.2 : 0.9, rail ? 1.4 : 0.5, 1 - fa / 0.3, SPRITE.flare, i * 0.37); if (i === 0 || rail) F.moments.push({ key: a.key, what: rail ? 'rail' : 'fire' }); }
      if (fa >= 0 && fa < 4 && F.detail > 0) F.fx.puff(s.from.clone().add(V(0, fa * 4, 0)), 6 + fa * 5, 0.5, 0.48, 0.45, 0.35 * (1 - fa / 4), i * 0.7);
      const age = tau - (s.t + s.T);
      if (age >= 0) F.impacts.push({ dir: s.dir, age, size: s.size, kind: s.kind, dur: rail ? 20 : 16, seed: a.seed + i });
    }
    // the stratagem beacon: a red beam straight up from the target while the barrage lands
    const last = Math.max(...d.shells.map((s) => s.t + s.T));
    const bk = smooth(tau / 0.5) * (1 - smooth((tau - last - 0.5) / 1));
    if (bk > 0) { const s0 = g.surface(d.shells[0].dir, V()), s1 = g.surface(d.shells[0].dir, V(), 260); F.fx.line(s0, s1, 3, 2.2, 1.4, 0.15, 0.1, bk * (0.75 + 0.25 * Math.sin(F.t * 9)), true); F.fx.sprite(s0, 10, 1.4, 0.2, 0.1, bk, SPRITE.flare, 0.2); }
    if (a.ev?.user && d.src) {
      const al = smooth(tau / 0.6) * smooth((12 - tau) / 1.5);
      if (al > 0) F.labels.push({ key: a.key, pos: labelPos(g), text: `ORBITAL ${d.pattern === 'rail' ? 'RAILCANNON STRIKE' : d.pattern === 'walking' ? 'WALKING BARRAGE' : '380MM HE BARRAGE'}`, sub: `${a.ev.user}${a.ev.amount ? ` · ${a.ev.amount}` : ''}`, alpha: al });
    }
  },
};

// ---- orbital laser: a sustained beam sweeping a short line on the surface, leaving a burning scar
ACTS.laser = {
  plan: (g, r) => {
    const src = g.friendly.length ? g.friendly[r.int(g.friendly.length)] : null;
    const a0 = g.target(r);
    const b0 = g.jitterDir(a0, r, 0.05);
    // the orbital laser: from our own bow cannon when the room has one, else straight down from a platform high above
    const own = g.cannon(r);
    const from = own && (r.chance(0.6) || g.R.cannonsOnly) ? own.p.clone() : g.surface(a0, V(), 1300).addScaledVector(g.R.sun.dir, 200);
    void src;
    return { dur: 10 + 18, data: { from, a0, b0 } };
  },
  sample: (g, a, tau, F) => {
    const d = a.data as { from: V3; a0: V3; b0: V3 };
    const on = tau >= 1 && tau < 9;
    if (tau < 1.2) F.fx.sprite(d.from, 6 + tau * 20, 1.3, 0.5, 0.25, smooth(tau), SPRITE.flare, 0.2);
    const spot = (t: number) => d.a0.clone().lerp(d.b0, smooth((t - 1) / 8)).normalize();
    if (on) {
      const fl = 0.8 + safeAmp(0.2) * Math.sin(F.t * 53) * Math.sin(F.t * 17);   // (the big beam's buzz: < 10 % with the limit on)
      const s = g.surface(spot(tau));
      const fadeIn = smooth((tau - 1) / 0.25) * smooth((9 - tau) / 0.3);
      F.fx.line(d.from, s, 22, 11, 1.4, 0.22, 0.06, 0.9 * fl * fadeIn, true);
      F.fx.line(d.from, s, 7, 3.5, 1.4, 1.0, 0.75, fl * fadeIn, true);
      F.fx.sprite(d.from, 22, 1.3, 0.6, 0.3, fadeIn, SPRITE.flare, 0.5);
      F.fx.sprite(s, 110, 1.4, 0.6, 0.2, fadeIn * fl, SPRITE.flare, 0.1);
      F.fx.sprite(s, 50, 1.5, 1.3, 1.0, fadeIn, SPRITE.core, 0);
      if (tau - 1 < 0.1) F.moments.push({ key: a.key, what: 'laser' });
    }
    for (let t = 1; t < Math.min(tau, 9); t += 0.3) F.impacts.push({ dir: spot(t), age: tau - t, size: 0.02, kind: IMPACT.laser, dur: 18, seed: a.seed + Math.round(t * 10) });
  },
};

// ---- hellbomb (planet combat): a huge blast in a war zone
ACTS.hellbomb = {
  plan: (g, r) => { const z = g.zones.length ? g.zones[r.int(g.zones.length)] : null; const dir = z ? g.jitterDir(V(z.x, z.y, z.z), r, 0.03) : g.target(r); return { dur: 28, data: { dir } }; },
  sample: (g, a, tau, F) => { const d = a.data as { dir: V3 }; F.impacts.push({ dir: d.dir, age: tau, size: 0.07, kind: IMPACT.hellbomb, dur: 26, seed: a.seed }); },
};

// ---- threat: an Automaton dreadnought warps in close, charges its main gun at US — and is torn apart
interface ThreatData { sc: number; pos0: V3; pos1: V3; fwd: V3; def: { pos: V3; q: THREE.Quaternion; fwd: V3; kind: ShipKind } | null; wing: { p0: V3; p1: V3; p2: V3; p3: V3 }[]; tb: number; pieces: { i: number; v: V3; w: V3; ang: number }[]; debris: { d: V3; sp: number; w: V3; kind: ShipKind; sc: number }[]; saucer: boolean }
const PIECES: ShipKind[] = ['BOT_CRUISER_p1', 'BOT_CRUISER_p2', 'BOT_CRUISER_p3', 'BOT_CRUISER_p4', 'BOT_CRUISER_p5'];
ACTS.threat = {
  plan: (g, r) => {
    // approaches the main camera sees well (kill point in the middle of the frame) first
    const good = g.R.approaches.filter((x) => g.seen(Array.isArray(x.extras.killPoint) ? V(...(x.extras.killPoint as [number, number, number])) : x.p) > 0.3);
    const pool = good.length ? good : g.R.approaches;
    const ap = pool.length ? pool[r.int(pool.length)] : null;
    const kill = ap && Array.isArray(ap.extras.killPoint) ? V(...(ap.extras.killPoint as [number, number, number])) : null;
    let pos1: V3, pos0: V3, fwd: V3;
    if (ap && kill) {
      // authored: out of warp at the anchor, diving along its direction at the bridge, killed at killPoint
      pos0 = ap.p.clone(); pos1 = g.outside(kill.clone(), 160);
      fwd = pos1.clone().sub(pos0).normalize();
    } else {
      pos1 = ap ? ap.p.clone() : g.inView(r, 480, 620, 0.35);
      g.outside(pos1, 200);
      const toEye = g.R.eye.clone().sub(pos1).normalize();
      // three-quarter view: aimed past the bridge (still menacing, but the silhouette reads)
      const side = V().crossVectors(UP, toEye).normalize().multiplyScalar(r.chance(0.5) ? 1 : -1);
      fwd = toEye.clone().lerp(ap ? ap.fwd : toEye, 0.3).normalize().addScaledVector(side, 0.75).normalize();
      pos0 = pos1.clone().addScaledVector(fwd, -260);
    }
    const f = g.nearestFriendly(pos1, 'SD') ?? g.nearestFriendly(pos1);
    const def = f ? { pos: f.pos.clone(), q: f.q.clone(), fwd: f.fwd.clone(), kind: f.kind } : null;
    const wing = [] as ThreatData['wing'];
    const start = def ? def.pos : g.inView(r, 300, 500);
    for (let i = 0; i < 4; i++) {
      const side = V().crossVectors(fwd, UP).normalize().multiplyScalar(i % 2 ? 1 : -1);
      const p0 = start.clone().add(V(r.range(-40, 40), r.range(-20, 20), r.range(-40, 40)));
      const p3 = pos1.clone().addScaledVector(fwd, -r.range(250, 400)).addScaledVector(side, r.range(100, 220)).add(V(0, r.range(40, 120), 0));
      const p1 = p0.clone().lerp(pos1, 0.4).addScaledVector(side, 250).add(V(0, 80, 0));
      const p2 = pos1.clone().addScaledVector(fwd, 180).addScaledVector(side, r.range(20, 60)).add(V(0, r.range(30, 60), 0));
      wing.push({ p0, p1, p2: g.outside(p2, 90), p3 });
    }
    const pieces = PIECES.map((_, i) => ({ i, v: V(r.range(-3, 3), r.range(-2, 3), 0).add(V(0, 0, (i - 2) * r.range(3, 5))), w: V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize(), ang: r.range(0.04, 0.16) }));
    const debris: ThreatData['debris'] = [];
    for (let i = 0; i < 110; i++) debris.push({ d: V(r.range(-1, 1), r.range(-0.8, 1), r.range(-1, 1)).normalize(), sp: r.range(8, 60), w: V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize(), kind: r.chance(0.6) ? 'DEBRIS' : 'DEBRIS_B', sc: r.range(0.8, 3.8) });
    // close approaches: shrink the dreadnought so it fills at most about half of the view
    const sc = THREE.MathUtils.clamp((pos1.distanceTo(g.R.eye) * 0.55) / 234, 0.25, 1);
    return { dur: 46, data: { sc, pos0, pos1, fwd, def, wing, tb: 18.5, pieces, debris, saucer: false } as ThreatData };
  },
  sample: (g, a, tau, F) => {
    const d = a.data as ThreatData;
    const meta = g.meta.BOT_CRUISER;
    const S = d.sc ?? 1;
    const q = orient(d.fwd, UP);
    const adv = smooth(tau / 18);
    const pos = d.pos0.clone().lerp(d.pos1, adv);
    const col: [number, number, number] = [1.3, 0.35, 0.2];
    // warp-in (red): stretched slam
    let stretch = 0, warp = 0, shown = tau >= 0.35;
    if (tau < 1.0) { const e = easeOut((tau - 0.35) / 0.65); pos.addScaledVector(d.fwd, -(meta?.length ?? 200) * S * 12 * (1 - e)); stretch = 20 * (1 - e); warp = 1 - e * 0.8; }
    warpFlash(F, d.pos0.clone().addScaledVector(d.fwd, 60 * S), d.fwd.clone().negate(), 170 * S, tau, a.seed + 1, col, true);
    if (tau >= 0.4 && tau < 0.5) F.moments.push({ key: a.key, what: 'warpin' });
    // bridge red alert
    F.alert = Math.max(F.alert, smooth((tau - 1.2) / 0.5) * (1 - smooth((tau - 23) / 3)));
    if (tau >= 1.5 && tau < 1.6) F.moments.push({ key: a.key, what: 'alert' });
    const alive = tau < d.tb;
    const heatAt = (i: number) => clamp01((tau - 14 - (4 - i) * 0.6) / 2);
    if (shown && alive) {
      const center = new THREE.Vector3();
      for (let i = 0; i < 5; i++) {
        const pc = meta?.pieces?.[i]?.center ?? [0, 0, 0];
        const pp = local(pos, q, pc, S, center);
        F.ships.push({ kind: PIECES[i], pos: pp, quat: q, scale: S, stretch, warp, heat: heatAt(i) * 0.7 });
      }
      engines(F, meta, pos, q, S, 0.9, [1, 0.4, 0.12], a.seed);
      const em = local(pos, q, meta?.emitter, S);
      // charging the main gun AT US
      const ch = clamp01((tau - 4) / 13);
      if (ch > 0) {
        // the charge going unstable: a 6.4 Hz red strobe with the flash limit off; with it on, a slow 1.2 Hz swell (a red
        // flash rule: never a full on / off) — and the flare is one output on the page governor either way
        const unstable0 = tau > 16.5 ? (pageGovernor().safe ? 0.8 + 0.2 * Math.sin(tau * Math.PI * 2 * 1.2) : 0.5 + 0.5 * Math.sin(tau * 40)) : 1;
        const lv0 = 0.5 + ch * 0.7;
        const unstable = govern(`dreadnought charge ${a.seed}`, lv0 * unstable0, true) / lv0;
        F.fx.sprite(em, (8 + ch * 48) * S, 1.4, 0.2, 0.1, (0.5 + ch * 0.7) * unstable, SPRITE.flare, tau * 0.1);
        F.fx.sprite(em, (4 + ch * 22) * S, 1.5, 0.9, 0.8, (0.4 + ch * 0.6) * unstable, SPRITE.core, 0);
        const r = new Rng(a.seed + 77);
        const n = F.detail > 0 ? 14 : 6;
        for (let i = 0; i < n; i++) {
          const dir = V(r.range(-1, 1), r.range(-1, 1), r.range(-1, 1)).normalize();
          const ph = ((tau * (0.6 + ch) + r.next()) % 1);
          const far = (30 + 90 * (1 - ph)) * S;
          F.fx.line(em.clone().addScaledVector(dir, far), em.clone().addScaledVector(dir, far - 25 * S), 0.8 * S, 1.2, 1.3, 0.25, 0.15, ph * ch, false);
        }
      }
      // red bolts at the defending destroyer (its shield flares blue)
      if (d.def) for (let b = 0; b < 10; b++) {
        const tf = 2.4 + b * 0.75, age = tau - tf;
        if (age < 0 || age > 1.4) continue;
        const r = new Rng(a.seed + b * 13);
        const mz = local(pos, q, meta?.guns[b % (meta?.guns.length || 1)], S);
        const aim = d.def.pos.clone().add(V(r.range(-40, 40), r.range(-15, 25), r.range(-40, 40)));
        const hitAt = aim.clone().addScaledVector(aim.clone().sub(mz).normalize(), -60);
        const k = age / 1.0;
        if (k < 1) { const head = mz.clone().lerp(hitAt, k); F.fx.line(head.clone().lerp(mz, 0.08), head, 1.6, 2, 1.4, 0.2, 0.1, 1, false); if (age < 0.12) F.fx.sprite(mz, 10, 1.4, 0.3, 0.1, 1, SPRITE.flare, r.next()); }
        else { const s = age - 1; F.fx.sprite(hitAt, 30 + s * 60, 0.4, 0.75, 1.4, 1 - s / 0.4, SPRITE.flare, r.next()); F.fx.sprite(hitAt, 40 + s * 90, 0.4, 0.7, 1.3, (1 - s / 0.4) * 0.6, SPRITE.ring, r.next()); }
      }
    }
    // Eagle wing scrambles: attack run past the hull with tracers + missiles
    const wm = g.meta.EAGLE;
    for (let i = 0; i < d.wing.length; i++) {
      const w = d.wing[i];
      const u = (tau - 5 - i * 0.4) / 9;
      if (u < 0 || u > 1) continue;
      const k = smooth(u) * 0.3 + u * 0.7;
      const p = bez(w.p0, w.p1, w.p2, w.p3, k), ahead = bez(w.p0, w.p1, w.p2, w.p3, clamp01(k + 0.01));
      const fw = ahead.sub(p).normalize();
      const qq = orient(fw, UP);
      F.ships.push({ kind: 'EAGLE', pos: p, quat: qq, fade: smooth(u / 0.05) * smooth((1 - u) / 0.08) });
      engines(F, wm, p, qq, 1, 1, undefined, i);
      trail(F, [local(p, qq, wm?.engines[0]), p.clone().addScaledVector(fw, -25), p.clone().addScaledVector(fw, -50), p.clone().addScaledVector(fw, -75)], 0.8, [0.55, 0.8, 1], 0.5);
      const tr = new Rng(a.seed + i * 31 + Math.floor(tau * 12));
      if (alive && u > 0.35 && u < 0.75) {
        const tgt = pos.clone().add(V(tr.range(-60, 60), tr.range(-10, 25), tr.range(-60, 60)).multiplyScalar(S));
        const mz = local(p, qq, wm?.guns[i % 2]);
        const dir = tgt.clone().sub(mz).normalize();
        const off = (tau * 12) % 1;
        F.fx.line(mz.clone().addScaledVector(dir, 20 + off * 60), mz.clone().addScaledVector(dir, 55 + off * 60), 0.5, 1.4, 1, 0.8, 0.3, 0.95, false);
        if (tr.chance(0.5)) F.fx.sprite(tgt, 6, 1.3, 1, 0.6, 1, SPRITE.flare, tr.next());
      }
      // missiles (smoky trails) at u ≈ 0.45
      const mt = 5 + i * 0.4 + 0.45 * 9, ma = tau - mt;
      if (alive && ma > 0 && ma < 1.3) {
        const mz = local(p, qq, [0, -0.6, 2]);
        const aim = local(pos, q, meta?.booms?.[(i * 2) % (meta?.booms.length || 1)], S);
        const hm = mz.clone().lerp(aim, easeIn(ma / 1.3));
        F.fx.sprite(hm, 3, 1.4, 1, 0.6, 1, SPRITE.flare, i);
        if (F.detail > 0) for (let s = 1; s < 5; s++) F.fx.puff(mz.clone().lerp(aim, easeIn(Math.max(0, ma - s * 0.12) / 1.3)), 2 + s * 1.2, 0.6, 0.6, 0.6, 0.35 * (1 - s / 5), i + s * 0.1);
      }
      if (alive && ma >= 1.3) boom(F, local(pos, q, meta?.booms?.[(i * 2) % (meta?.booms.length || 1)], S), ma - 1.3, 22 * S, a.seed + i * 3, true);
    }
    // the defender's broadside (blue rail shells) at 11.5–13.5 s
    if (d.def) {
      const dm = g.meta[d.def.kind];
      for (let b = 0; b < 8; b++) {
        const tf = 11.4 + b * 0.22, age = tau - tf;
        if (age < 0) continue;
        const r = new Rng(a.seed + 500 + b);
        const guns = dm?.broadside?.length ? dm.broadside : dm?.guns ?? [[0, 0, 0]];
        const mz = local(d.def.pos, d.def.q, guns[b % guns.length]);
        const aimL = meta?.booms?.[(b * 3) % (meta?.booms.length || 1)];
        const aim = local(d.pos1, q, aimL, S);
        const k = age / 1.1;
        if (k < 1) { const head = mz.clone().lerp(aim, k); F.fx.line(head.clone().lerp(mz, 0.1), head, 2.2, 2.4, 0.5, 0.8, 1.4, 1, false); F.fx.sprite(head, 8, 0.6, 0.85, 1.4, 1, SPRITE.glow, r.next()); if (age < 0.2) F.fx.sprite(mz, 18, 0.8, 0.9, 1.3, 1 - age / 0.2, SPRITE.flare, r.next()); }
        else if (alive || age - 1.1 < 2) boom(F, aim, age - 1.1, 26 * S, a.seed + 900 + b, true);
      }
    }
    // secondary explosions walking bow → stern (14 – 18.5 s)
    const booms = meta?.booms ?? [];
    for (let i = 0; i < booms.length; i++) {
      const tb = 14 + i * 0.48;
      if (tau < tb) continue;
      const base = alive ? pos : d.pos1;
      boom(F, local(base, q, booms[i], S), tau - tb, (34 + (i % 3) * 8) * S, a.seed + 1000 + i, true);
      if (tau - tb < 0.08 && i % 3 === 0) F.shake = Math.max(F.shake, 0.25);
    }
    // THE BREAK: flash, shockwave, hull pieces tumbling apart on fire, debris field
    if (!alive) {
      const k = tau - d.tb;
      const c = d.pos1;
      if (k < 0.1) F.moments.push({ key: a.key, what: 'destroyed' });
      F.flash = Math.max(F.flash, Math.exp(-k * 2.2)); F.flashCol.setRGB(1, 0.85, 0.65);
      if (k < 0.9) F.shake = Math.max(F.shake, 1 - k / 0.9);
      if (k < 2.2) F.fx.sprite(c, 260 * S * (0.4 + easeOut(k / 0.6)), 1.4, 1.2, 1.0, Math.exp(-k * 2.4) * 1.3, SPRITE.core, 0);
      if (k < 3) F.fx.sprite(c, 400 * S * (0.3 + easeOut(k / 1.2)), 1.3, 0.8, 0.5, Math.exp(-k * 1.5), SPRITE.flare, 0.3);
      if (k < 4) F.fx.sprite(c, (120 + easeOut(k / 4) * 1100) * S, 1.2, 0.8, 0.55, (1 - k / 4) * 0.9, SPRITE.ring, 0.1);
      if (k < 6) F.fx.sprite(c, (80 + easeOut(k / 6) * 700) * S, 0.6, 0.7, 1.1, (1 - k / 6) * 0.5, SPRITE.ring, 0.6);
      if (k < 5) F.fx.sprite(c, (140 + k * 40) * S, 1.3, 1.0, 0.8, 1 - smooth(k / 5), SPRITE.fire, 0.4);
      const fadeAll = 1 - smooth((k - 14) / 8);
      for (const p of d.pieces) {
        const pc = meta?.pieces?.[p.i]?.center ?? [0, 0, 0];
        const out = local(V(), q, pc).normalize();
        const drift = out.multiplyScalar(5 + k * 0.25).add(p.v.clone().applyQuaternion(q)).multiplyScalar(k * S);
        drift.addScaledVector(g.R.view.normal, Math.max(0, -drift.dot(g.R.view.normal)));   // never drift towards the glass
        const pp = local(c, q, pc, S).add(drift);
        const qq = q.clone().premultiply(new THREE.Quaternion().setFromAxisAngle(p.w, p.ang * k * (1 + Math.exp(-k) * 2)));
        const heat = 0.9 * Math.exp(-k / 5);
        F.ships.push({ kind: PIECES[p.i], pos: pp, quat: qq, scale: S, heat, fade: fadeAll });
        // burning break edges + smoke trails
        const span = meta?.pieces?.[p.i]?.span ?? [0, 0];
        for (const e of span) {
          const ep = local(pp, qq, [0, 0, e - pc[2]], S);
          F.fx.sprite(ep, (18 + 6 * Math.sin(F.t * 9 + p.i)) * S, 1.3, 0.7, 0.35, heat * fadeAll, SPRITE.fire, p.i + e * 0.01);
          if (F.detail > 0) for (let s = 1; s < 4; s++) F.fx.puff(ep.clone().addScaledVector(drift.clone().normalize(), -s * 22 * S), (14 + s * 6) * S, 0.1, 0.09, 0.09, 0.4 * (1 - s / 4) * fadeAll, p.i + s * 0.3);
        }
      }
      const nd = F.detail > 0 ? d.debris.length : 40;
      for (let i = 0; i < nd; i++) {
        const b = d.debris[i];
        const p = c.clone().addScaledVector(b.d, b.sp * S * k * (1 + Math.exp(-k * 1.5) * 1.5));
        F.ships.push({ kind: b.kind, pos: p, quat: new THREE.Quaternion().setFromAxisAngle(b.w, k * (0.5 + (i % 5) * 0.4)), scale: b.sc * S, heat: Math.max(0, 1 - k / 3.5), fade: fadeAll * (1 - smooth((k - 14 - (i % 7)) / 6)) });
      }
    }
    if (a.ev?.user) {
      const al = smooth((tau - 1) / 0.6) * smooth((26 - tau) / 1.5);
      if (al > 0) F.labels.push({ key: a.key, text: 'THREAT INBOUND — AUTOMATON DREADNOUGHT', sub: `summoned by ${a.ev.user}${a.ev.amount ? ` · ${a.ev.amount}` : ''}`, pos: labelPos(g), alpha: al });
    }
  },
};

// ---- drop pod re-entry (from the drop-pod leave cinematic): a fiery streak down to the surface
ACTS.pod = {
  plan: (g, r, a) => {
    const ev = a.data as { start: V3; dir0: V3; target?: V3 | null };
    const dir = ev.target ?? g.target(r);
    const end = g.surface(dir);
    // (the tube mouth is under the ship: the pod shows up just outside the glass, below the viewport)
    const start = g.aside(g.outside(ev.start.clone(), 70, false), 30);
    // swing clear of our own hull (keep-out boxes) sideways, so the bridge sees the burn
    const c1 = g.aside(start.clone().addScaledVector(ev.dir0, 200), 60);
    const c2 = g.surface(dir, V(), 350).lerp(c1, 0.25);
    return { dur: 7.5 + 16, data: { start, c1, c2, end, dir, T: 7.5 } };
  },
  sample: (g, a, tau, F) => {
    const d = a.data as { start: V3; c1: V3; c2: V3; end: V3; dir: V3; T: number };
    const S = g.R.podSize ?? 1;     // scene.json space.podSize (a far own planet: the streak reads bigger)
    if (tau < d.T) {
      const u = easeIn(tau / d.T) * 0.55 + (tau / d.T) * 0.45;
      const p = bez(d.start, d.c1, d.c2, d.end, u);
      const alt = p.distanceTo(g.R.planet.center) - g.R.planet.radius;
      // coasting out (a small blue-white thruster), then the burn: re-entry fire grows over the last half of the fall
      const fire = Math.max(clamp01(1 - (alt - 60) / 420) * smooth((u - 0.25) / 0.2), smooth((u - 0.4) / 0.35));
      F.fx.sprite(p, (6 + fire * 24) * S, 1.3, 1.0 - fire * 0.4, 0.8 - fire * 0.6, 1, fire > 0.1 ? SPRITE.fire : SPRITE.flare, tau);
      F.fx.sprite(p, (4 + fire * 9) * S, 1.5, 1.4, 1.2, 1, SPRITE.core, 0);
      const pts = [p];
      const n = F.detail > 0 ? 8 : 4;
      for (let i = 1; i <= n; i++) { const uu = Math.max(0, u - i * 0.026 * (0.35 + fire)); pts.push(bez(d.start, d.c1, d.c2, d.end, uu)); }
      trail(F, pts, (2 + fire * 7) * S, fire > 0.2 ? [1.3, 0.55, 0.2] : [0.6, 0.8, 1.2], 0.9);
      if (fire > 0.2 && F.detail > 0) for (let i = 2; i < n; i += 2) F.fx.puff(pts[i], (5 + fire * 8 + i) * S, 0.25, 0.22, 0.2, 0.3 * fire, i * 0.1);
    }
    const age = tau - d.T;
    if (age >= 0) {
      F.impacts.push({ dir: d.dir, age, size: 0.02 * Math.min(S, 2.5), kind: IMPACT.pod, dur: 14, seed: a.seed });
      if (age < 0.1) F.moments.push({ key: a.key, what: 'podland' });
    }
  },
};

// ------------------------------------------------------------------------------------------------ the director
const ENABLED: Record<string, (s: SceneSpaceState) => boolean> = {
  flyby: (s) => s.show.fighters, dogfight: (s) => s.show.fighters, strafe: (s) => s.show.fighters, warp: (s) => s.show.warps,
  barrage: (s) => s.show.barrages, laser: (s) => s.show.lasers, hellbomb: (s) => s.show.planet,
};
const WEIGHTS: [string, number][] = [['flyby', 2], ['dogfight', 3], ['strafe', 2], ['warp', 1.6], ['barrage', 2.2], ['laser', 1.1]];

export interface PodLaunch { id: string; at: number; start: V3; dir0: V3; target?: V3 | null }

export class SpaceDirector {
  private acts = new Map<string, Act | null>();
  private patrols: PatrolData[] = [];
  private patrolKey = '';
  private lastTau = new Map<string, number>();
  private fired = new Set<string>();
  active: string[] = [];

  constructor(readonly g: SpaceGeo) {}

  private act(key: string, kind: string, start: number, seed: number, ev?: SpaceEventStamp, data?: unknown): Act | null {
    let a = this.acts.get(key);
    if (a !== undefined) return a;
    const A = ACTS[kind];
    if (!A) { this.acts.set(key, null); return null; }
    a = { key, kind, start, dur: 0, seed, ev, data };
    try {
      const p = A.plan(this.g, new Rng(seed), a);
      a.dur = p.dur; a.data = p.data;
    } catch (e) { console.warn('space act plan failed', kind, e); a = null; }
    this.acts.set(key, a);
    if (this.acts.size > 160) for (const k of [...this.acts.keys()].slice(0, 40)) this.acts.delete(k);
    return a;
  }

  /** Every act that should be drawn at `now` (epoch ms). */
  wanted(st: SceneSpaceState, now: number, pods: PodLaunch[]): Act[] {
    const out: Act[] = [];
    const P = SPACE_PACING[st.intensity];
    const epoch = st.epoch || 0;
    // the room's own list of acts (scene.json space.acts): nothing else is ever planned here, whatever the toggles say
    const keep = (k: string) => spaceActOn(this.g.R.acts, k);
    // timed events (tests / support) — threats queue one after another
    let threatEnd = 0;
    const evThreats: [number, number][] = [];
    for (const ev of [...st.events].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id))) {
      const kind = ev.k === 'support' ? 'barrage' : ev.k;
      if (!ACTS[kind] || kind === 'pod' || !keep(kind)) continue;
      let start = ev.at;
      if (kind === 'threat') start = Math.max(start, threatEnd);
      const a = this.act(`ev:${kind}:${ev.id}:${ev.at}:${st.seed}`, kind, start, hash32(st.seed, ev.id, kind), ev);
      if (!a) continue;
      a.start = start;
      if (kind === 'threat') { threatEnd = start + a.dur * 1000 - 12000; evThreats.push([start, start + a.dur * 1000]); }
      if (now >= a.start && now < a.start + a.dur * 1000) out.push(a);
    }
    if (keep('pod')) for (const p of pods) {
      const a = this.act(`pod:${p.id}:${p.at}`, 'pod', p.at, hash32(p.id, 'pod'), undefined, { start: p.start, dir0: p.dir0, target: p.target ?? null });
      if (a && now >= a.start && now < a.start + a.dur * 1000) out.push(a);
    }
    if (!st.on) return out;
    // ambient acts: one per slot
    const slot = (P.slot / st.freq) * 1000;
    const kinds = WEIGHTS.filter(([k]) => ENABLED[k](st) && keep(k));
    const total = kinds.reduce((s, [, w]) => s + w, 0);
    if (total > 0) {
      const k0 = Math.floor((now - epoch) / slot);
      const back = Math.ceil(50000 / slot) + 1;
      for (let k = k0 - back; k <= k0; k++) {
        const r = new Rng(hash32(st.seed, k, 'slot'));
        let pick = r.next() * total, kind = kinds[0][0];
        for (const [kk, w] of kinds) { pick -= w; if (pick <= 0) { kind = kk; break; } }
        const start = epoch + k * slot + r.next() * slot * 0.6;
        if (now < start) continue;
        const a = this.act(`slot:${st.seed}:${epoch}:${st.intensity}:${st.freq}:${kinds.map((x) => x[0]).join('')}:${k}`, kind, start, hash32(st.seed, k, kind));
        if (a && now < a.start + a.dur * 1000) out.push(a);
      }
    }
    // hellbombs on the planet (≈ every 45 s)
    if (st.show.planet && keep('hellbomb')) {
      const hs = 45000 / st.freq;
      const k0 = Math.floor((now - epoch) / hs);
      for (let k = k0 - 1; k <= k0; k++) {
        const r = new Rng(hash32(st.seed, k, 'hb'));
        if (!r.chance(0.7)) continue;
        const start = epoch + k * hs + r.next() * hs * 0.5;
        if (now < start) continue;
        const a = this.act(`hb:${st.seed}:${epoch}:${st.freq}:${k}`, 'hellbomb', start, hash32(st.seed, k, 'hbx'));
        if (a && now < a.start + a.dur * 1000) out.push(a);
      }
    }
    // regular threat events (rare), not overlapping a summoned one
    if (st.show.threats && keep('threat')) {
      const ts = (P.threat / st.freq) * 1000;
      const k0 = Math.floor((now - epoch) / ts);
      for (let k = k0 - 1; k <= k0; k++) {
        if (k < 0) continue;
        const r = new Rng(hash32(st.seed, k, 'threat'));
        if (!r.chance(0.8)) continue;
        const start = epoch + k * ts + (0.25 + r.next() * 0.5) * ts;
        if (now < start || evThreats.some(([a, b]) => start < b && start + 50000 > a)) continue;
        const a = this.act(`th:${st.seed}:${epoch}:${st.intensity}:${st.freq}:${k}`, 'threat', start, hash32(st.seed, k, 'thx'));
        if (a && now < a.start + a.dur * 1000) out.push(a);
      }
    }
    return out;
  }

  /** Seconds until the next regular threat (UI), or null. */
  nextThreat(st: SceneSpaceState, now: number): number | null {
    if (!st.on || !st.show.threats || !spaceActOn(this.g.R.acts, 'threat')) return null;
    const ts = (SPACE_PACING[st.intensity].threat / st.freq) * 1000, epoch = st.epoch || 0;
    const k0 = Math.floor((now - epoch) / ts);
    for (let k = k0; k < k0 + 4; k++) {
      const r = new Rng(hash32(st.seed, k, 'threat'));
      if (!r.chance(0.8)) continue;
      const start = epoch + k * ts + (0.25 + r.next() * 0.5) * ts;
      if (start > now) return Math.round((start - now) / 1000);
    }
    return null;
  }

  /** Draw everything for `now` into the frame. */
  frame(st: SceneSpaceState, now: number, F: Frame, pods: PodLaunch[]) {
    const g = this.g;
    const tS = now / 1000;
    // parked capital ships: slow bob, engines idling, running lights
    for (const f of g.R.own.fleet ? [] : g.friendly) {
      const bob = Math.sin(tS * 0.12 + f.i * 1.7) * 3;
      const pos = f.pos.clone().addScaledVector(UP, bob);
      const q = f.q.clone().multiply(_q.setFromAxisAngle(V(0, 0, 1), Math.sin(tS * 0.07 + f.i) * 0.02));
      F.ships.push({ kind: f.kind, pos, quat: q });
      engines(F, g.meta[f.kind], pos, q, 1, 0.55, undefined, f.i);
      navLights(F, g.meta[f.kind], pos, q, 1, f.i * 0.37);
    }
    const on = st.on;
    // ambient patrols + pelicans (each only in rooms that keep it: scene.json space.acts)
    if (on && st.show.fighters) {
      const P = SPACE_PACING[st.intensity];
      const key = `${st.seed}:${st.intensity}`;
      if (key !== this.patrolKey) { this.patrolKey = key; this.patrols = Array.from({ length: P.patrols }, (_, i) => planPatrol(g, new Rng(hash32(st.seed, i, 'patrol')))); }
      const secs = (now - (st.epoch || 0)) / 1000;
      if (spaceActOn(g.R.acts, 'patrol')) for (const p of this.patrols) samplePatrol(g, p, secs, F);
      const per = 34000 / P.pelicans / st.freq;
      const k0 = Math.floor((now - (st.epoch || 0)) / per);
      if (spaceActOn(g.R.acts, 'pelican')) for (let k = k0 - 2; k <= k0; k++) {
        const r = new Rng(hash32(st.seed, k, 'pel'));
        const start = (st.epoch || 0) + k * per + r.next() * per * 0.4, dur = 42;
        const tau = (now - start) / 1000;
        if (tau < 0 || tau > dur) continue;
        const key2 = `pel:${st.seed}:${k}`;
        let a = this.acts.get(key2);
        if (a === undefined) { const d = planPelican(g, r); a = d ? { key: key2, kind: 'pel', start, dur, seed: hash32(k, 'pel'), data: d } : null; this.acts.set(key2, a); }
        if (a) samplePelican(g, a.data as PelData, tau, dur, F, a.seed % 97);
      }
    }
    const acts = this.wanted(st, now, pods);
    this.active = acts.map((a) => a.kind);
    const nImp0 = F.impacts.length;
    const seen = new Set<string>();
    for (const a of acts) {
      const tau = (now - a.start) / 1000;
      seen.add(a.key);
      const before = F.moments.length;
      try { ACTS[a.kind].sample(g, a, tau, F); } catch (e) { console.warn('space act failed', a.kind, e); }
      // moments only when the act was already being drawn last frame (a page opened mid-act doesn't replay cues)
      const last = this.lastTau.get(a.key);
      if (last === undefined || tau - last > 0.5) { for (let i = before; i < F.moments.length; i++) this.fired.add(`${F.moments[i].key}:${F.moments[i].what}`); F.moments.length = before; }
      else {
        // each moment once per act
        const keep = F.moments.slice(before).filter((m) => { const id = `${m.key}:${m.what}`; if (this.fired.has(id)) return false; this.fired.add(id); return true; });
        F.moments.length = before; F.moments.push(...keep);
      }
      this.lastTau.set(a.key, tau);
    }
    // every fresh impact also flashes as a billboard at the surface (reads even on the grazing horizon)
    for (let i = nImp0; i < F.impacts.length; i++) {
      const m = F.impacts[i];
      if (m.age > 1.6) continue;
      const p = g.surface(m.dir, V(), 4);
      const big = m.kind === IMPACT.hellbomb ? 2.4 : m.kind === IMPACT.rail ? 1.6 : 1;
      const s = m.size * g.R.planet.radius;
      const rail = m.kind === IMPACT.rail;
      F.fx.sprite(p, s * 1.6 * big * (0.6 + m.age), rail ? 0.7 : 1.4, rail ? 0.9 : 1.0, rail ? 1.4 : 0.6, Math.exp(-m.age * 3.2), SPRITE.flare, (m.seed % 13) / 13);
      if (m.kind === IMPACT.hellbomb || m.kind === IMPACT.shell || m.kind === IMPACT.pod) F.fx.sprite(g.surface(m.dir, V(), s * (0.3 + m.age * 0.5)), s * big * (0.5 + m.age * 0.4), 1.2, 0.9, 0.6, (1 - m.age / 1.6) * 0.9, SPRITE.fire, (m.seed % 7) / 7);
    }
    for (const k of [...this.lastTau.keys()]) if (!seen.has(k)) { this.lastTau.delete(k); for (const f of [...this.fired]) if (f.startsWith(`${k}:`)) this.fired.delete(f); }
  }
}
