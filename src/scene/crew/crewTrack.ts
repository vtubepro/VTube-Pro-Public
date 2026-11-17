// Ship crew: tracks (per crew member: contiguous segments + upper-body overlays), the builder the planner
// writes them with, and the per-frame sampler. Generalises the kitchen's TB / Seg / sampleTrack
// (src/scene/kitchen/kitchenPlan.ts) for a moving deck: a segment can live in a turret's frame (the gunner rides the
// gun) or end in one (the loader walks up to a turning breech), locomotion advances its clip by the distance walked
// (cumulative across segments, so feet never pop), ladders are vertical walks, and a segment's clip can be resolved per
// frame from the voyage feed (the helm wheel's angle, the barrel's pitch).
import * as THREE from 'three';
import { CREW_SPEED, clipMeta } from './crewClips';
import { STEP_DY, type RoutePt } from './crewDeck';
export { STEP_DY };

type V3 = THREE.Vector3;
const V = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);

export interface Seg {
  t0: number; t1: number;
  clip: string; loop: boolean;
  /** clip time offset (s) / playback rate (non-locomotion) */
  off?: number; rate?: number;
  /** distance-locked locomotion: clip time = (dist0 + walked) / cycle * dur */
  dist0?: number; cyc?: number;
  a: V3; b: V3;
  path?: V3[]; plen?: number[];
  /** ballistic arc a -> b with peak h above the straight line */
  arc?: { h: number };
  /** the whole segment is in a frame ('GUN_F' ...): a, b, yaw are local to it */
  frame?: string;
  /** only the end point (b, and the path's last point) is in that frame (walking up to a moving turret) */
  endFrame?: string;
  yaw0: number; yaw1: number; turn?: number;
  /** keep yaw (ladders) instead of facing along the path */
  fixYaw?: boolean;
  held?: string; hidden?: boolean;
  /** clip resolved per frame from the feed: 'helm' (hold / turn by the wheel), 'gunlay' (up / mid / down by pitch) */
  dyn?: 'helm' | 'gunlay';
  /** gun id for 'gunlay' / which ship part a 'helm' turns */
  dynArg?: string;
}
export interface Overlay { t: number; clip: string; dur: number }
export interface Track { segs: Seg[]; overlays: Overlay[] }

const yawTo = (a: V3, b: V3) => Math.atan2(b.x - a.x, b.z - a.z);

export class TB {
  segs: Seg[] = [];
  overlays: Overlay[] = [];
  held?: string;
  walked = 0;
  frame?: string;
  constructor(public t: number, public p: V3, public yaw: number, frame?: string) { this.frame = frame; }
  push(s: Partial<Seg> & { clip: string; dur: number }) {
    const t1 = this.t + Math.max(0.01, s.dur);
    const m = clipMeta(s.clip);
    const frame = s.frame !== undefined ? s.frame : (s.endFrame ? undefined : this.frame);
    const seg: Seg = {
      t0: this.t, t1, clip: s.clip, loop: s.loop ?? m?.loop ?? true, a: (s.a ?? this.p).clone(), b: (s.b ?? s.a ?? this.p).clone(),
      yaw0: s.yaw0 ?? this.yaw, yaw1: s.yaw1 ?? s.yaw0 ?? this.yaw, held: s.held === undefined ? this.held : s.held,
      ...(s.off ? { off: s.off } : {}), ...(s.rate && s.rate !== 1 ? { rate: s.rate } : {}), ...(s.turn ? { turn: s.turn } : {}),
      ...(s.path ? { path: s.path, plen: s.plen } : {}), ...(s.arc ? { arc: s.arc } : {}), ...(s.hidden ? { hidden: true } : {}),
      ...(s.dist0 !== undefined ? { dist0: s.dist0, cyc: s.cyc } : {}), ...(s.fixYaw ? { fixYaw: true } : {}),
      ...(frame ? { frame } : {}), ...(s.endFrame ? { endFrame: s.endFrame } : {}),
      ...(s.dyn ? { dyn: s.dyn, dynArg: s.dynArg } : {}),
    };
    if (seg.held === undefined) delete seg.held;
    this.segs.push(seg);
    this.t = t1; this.p = seg.b.clone(); this.yaw = seg.yaw1;
    this.frame = seg.endFrame ?? seg.frame;
    return seg;
  }
  /** Leave a frame: continue from this deck-space pose (the planner converts with the frame's pose at this.t). */
  unframe(p: V3, yaw: number) { this.frame = undefined; this.p = p.clone(); this.yaw = yaw; }
  hold(dur: number, clip: string, o: Partial<Seg> = {}) { return this.push({ ...o, clip, dur }); }
  until(t: number, clip: string, o: Partial<Seg> = {}) { if (t > this.t + 0.01) return this.hold(t - this.t, clip, o); return null; }
  face(yaw: number, clip: string, dur = 0.35, o: Partial<Seg> = {}) { return this.push({ ...o, clip, dur, yaw0: this.yaw, yaw1: yaw, turn: dur }); }
  /** Walk / run a polyline at `speed`; the clip is distance-locked (no foot sliding). */
  go(pts: V3[], speed: number, clip: string, o: Partial<Seg> = {}) {
    const path = [this.p.clone(), ...pts.map((q) => q.clone())].filter((q, i, a) => i === 0 || q.distanceTo(a[i - 1]) > 0.03);
    if (path.length < 2) return null;
    const plen = [0];
    for (let i = 1; i < path.length; i++) plen.push(plen[i - 1] + path[i].distanceTo(path[i - 1]));
    const L = plen[plen.length - 1];
    const last = path[path.length - 1], prev = path[path.length - 2];
    const cyc = clipMeta(clip)?.cycle;
    const flatEnd = Math.hypot(last.x - prev.x, last.z - prev.z) > 0.02;
    const seg = this.push({ ...o, clip, dur: Math.max(0.2, L / speed), a: path[0], b: last, path, plen, yaw0: this.yaw, yaw1: flatEnd ? yawTo(prev, last) : this.yaw, ...(cyc ? { dist0: this.walked, cyc } : {}) });
    this.walked += L;
    return seg;
  }
  /** A deck route (crewDeck.route): walk hops at `speed` with `clip`, stairs slower, ladders climbed (up) / slid (down),
   *  and a walk hop that changes level (onto a gun platform, a loading step, off a hatch cover) a hop, never a slope
   *  through the step's riser. */
  route(pts: RoutePt[], speed: number, clip: string, o: Partial<Seg> = {}) {
    let run: V3[] = [];
    const flush = () => { if (run.length) { this.go(run, speed, clip, o); run = []; } };
    for (let i = 1; i < pts.length; i++) {
      const k = pts[i].kind;
      const prev = run.length ? run[run.length - 1] : pts[i - 1].p;
      if (k === 'ladder') { flush(); this.ladder(pts[i].p, o.held); }
      else if (k === 'step') { flush(); this.stepTo(pts[i].p, speed, clip, o); }
      else if (k === 'stairs') { flush(); this.go([pts[i].p], Math.min(speed, 0.9), clip === 'run' ? 'walk' : clip, o); }
      else if (Math.abs(pts[i].p.y - prev.y) > STEP_DY) { flush(); this.stepTo(pts[i].p, speed, clip, o); }
      else run.push(pts[i].p);
    }
    flush();
  }
  /** Walk to `to` across one level change: up = walk to 0.3 m short on this level, hop up; down = hop down 0.3 m out,
   *  walk on. (`endFrame`: the end point rides a turret frame.) */
  stepTo(to: V3, speed: number, clip: string, o: Partial<Seg> = {}) {
    const dy = to.y - this.p.y;
    if (Math.abs(dy) <= STEP_DY) { this.go([to], speed, clip, o); return; }
    const dx = to.x - this.p.x, dz = to.z - this.p.z, L = Math.hypot(dx, dz);
    const yaw = L > 0.02 ? yawTo(this.p, to) : this.yaw;
    const hop = { ...o, yaw0: yaw, yaw1: yaw };
    if (dy > 0) {
      if (L > 0.35) this.go([V(to.x - (dx / L) * 0.3, this.p.y, to.z - (dz / L) * 0.3)], speed, clip, { ...o, endFrame: undefined });
      this.push({ ...hop, clip: 'jump_off', dur: 0.24 + Math.min(0.3, dy * 0.3), a: this.p, b: to, arc: { h: 0.12 + dy * 0.15 }, off: 0.12, loop: false });
    } else {
      const post = L > 0.35 ? V(this.p.x + (dx / L) * 0.3, to.y, this.p.z + (dz / L) * 0.3) : to.clone();
      this.push({ ...hop, ...(L > 0.35 ? { endFrame: undefined } : {}), clip: 'fall', dur: 0.24 + Math.min(0.3, -dy * 0.25), a: this.p, b: post, arc: { h: 0.12 } });
      if (L > 0.35) this.go([to], speed, clip, o);
    }
  }
  /** Climb straight up / slide down to `to` (facing the current yaw). */
  ladder(to: V3, held?: string) {
    const up = to.y > this.p.y;
    const top = up ? to : this.p, bot = up ? this.p : to;
    const L = top.distanceTo(bot);
    if (up) {
      const s = this.push({ clip: 'ladder_climb', dur: L / CREW_SPEED.climb, b: to, fixYaw: true, held, dist0: 0, cyc: clipMeta('ladder_climb')?.cycle ?? 0.5 });
      s.path = [s.a.clone(), s.b.clone()]; s.plen = [0, L];
    } else {
      const s = this.push({ clip: 'ladder_slide', dur: Math.max(0.6, L / CREW_SPEED.slide), b: to, fixYaw: true, held });
      s.path = [s.a.clone(), s.b.clone()]; s.plen = [0, L];
    }
  }
  fly(to: V3, dur: number, h: number, clip = 'fall', o: Partial<Seg> = {}) {
    return this.push({ ...o, clip, dur, a: this.p, b: to, arc: { h }, yaw0: this.yaw, yaw1: o.yaw1 ?? this.yaw });
  }
  over(t: number, clip: string, dur?: number) { this.overlays.push({ t, clip, dur: dur ?? clipMeta(clip)?.dur ?? 0.6 }); }
  /** A one-shot clip (non-looping) played once. */
  once(clip: string, o: Partial<Seg> = {}) { return this.push({ ...o, clip, dur: clipMeta(clip)?.dur ?? 1, loop: false }); }
}

// ================================================================================================ sampling
export interface Sample {
  pos: V3; yaw: number; hidden: boolean;
  clip: string; time: number;
  prev: string | null; prevTime: number; w: number;
  over: string | null; overTime: number; overW: number;
  held?: string;
  /** the segment's frame (positions / yaw already transformed to deck space) */
  frame?: string;
  dyn?: 'helm' | 'gunlay'; dynArg?: string;
  /** index of the segment (for event edge detection) and the segment's local time */
  seg: number; segT: number;
  /** airborne (arc) / on a ladder */
  air: boolean; ladder: boolean;
}

/** frame id + time -> the frame's room-space matrix (turrets); null = identity */
export type FrameFn = (id: string, t: number) => THREE.Matrix4 | null;

const tmpA = V(), tmpB = V(), tmpE = new THREE.Euler(), tmpQ = new THREE.Quaternion();

function segPosLocal(s: Seg, u: number, out: V3, endP: V3 | null): V3 {
  if (s.path && s.plen) {
    const L = s.plen[s.plen.length - 1] * u;
    let k = 1;
    while (k < s.plen.length - 1 && s.plen[k] < L) k++;
    const f = (L - s.plen[k - 1]) / Math.max(1e-6, s.plen[k] - s.plen[k - 1]);
    const pb = k === s.plen.length - 1 && endP ? endP : s.path[k];
    return out.copy(s.path[k - 1]).lerp(pb, THREE.MathUtils.clamp(f, 0, 1));
  }
  out.copy(s.a).lerp(endP ?? s.b, u);
  if (s.arc) out.y += 4 * s.arc.h * u * (1 - u);
  return out;
}

function frameYaw(m: THREE.Matrix4) {
  tmpQ.setFromRotationMatrix(m);
  tmpE.setFromQuaternion(tmpQ, 'YXZ');
  return tmpE.y;
}

export function sampleTrack(tr: Track, t: number, frames: FrameFn | null, out?: Sample): Sample | null {
  const segs = tr.segs;
  if (!segs.length) return null;
  let lo = 0, hi = segs.length - 1;
  while (lo < hi) { const m = (lo + hi + 1) >> 1; if (segs[m].t0 <= t) lo = m; else hi = m - 1; }
  const i = lo, s = segs[i];
  const o = out ?? ({ pos: V(), yaw: 0, hidden: false, clip: '', time: 0, prev: null, prevTime: 0, w: 1, over: null, overTime: 0, overW: 0, seg: 0, segT: 0, air: false, ladder: false } as Sample);
  const tt = THREE.MathUtils.clamp(t, s.t0, s.t1);
  const u = (tt - s.t0) / Math.max(1e-6, s.t1 - s.t0);
  // frames
  const M = s.frame && frames ? frames(s.frame, t) : null;
  const ME = !M && s.endFrame && frames ? frames(s.endFrame, t) : null;
  const endP = ME ? tmpA.copy(s.b).applyMatrix4(ME) : null;
  segPosLocal(s, u, o.pos, endP ? endP.clone() : null);
  // yaw
  let yaw: number;
  if (s.path && s.plen && !s.fixYaw) {
    const u2 = Math.min(1, (Math.min(s.t1, tt + 0.12) - s.t0) / Math.max(1e-6, s.t1 - s.t0));
    const e = segPosLocal(s, u2, tmpB, endP ? endP.clone() : null);
    const dx = e.x - o.pos.x, dz = e.z - o.pos.z;
    yaw = dx * dx + dz * dz > 1e-6 ? Math.atan2(dx, dz) : s.yaw1;
  } else {
    const dur = s.turn ?? (s.t1 - s.t0);
    const k = THREE.MathUtils.clamp((tt - s.t0) / Math.max(1e-6, dur), 0, 1);
    let d = s.yaw1 - s.yaw0; d = Math.atan2(Math.sin(d), Math.cos(d));
    yaw = s.yaw0 + d * k * k * (3 - 2 * k);
  }
  if (M) { o.pos.applyMatrix4(M); yaw += frameYaw(M); }
  else if (ME && u >= 0.999) yaw = s.yaw1 + frameYaw(ME);
  o.yaw = yaw;
  o.hidden = !!s.hidden;
  o.clip = s.clip; o.seg = i; o.segT = tt - s.t0;
  o.time = clipTime(s, tt);
  o.held = s.held; o.frame = s.frame ?? s.endFrame; o.dyn = s.dyn; o.dynArg = s.dynArg;
  o.air = !!s.arc; o.ladder = s.clip === 'ladder_climb' || s.clip === 'ladder_slide';
  o.prev = null; o.w = 1;
  const FADE = s.clip === 'fall' || s.clip === 'land' || s.clip === 'jump_off' ? 0.08 : 0.22;
  if (i > 0 && tt - s.t0 < FADE) {
    const p = segs[i - 1];
    if (p.clip !== s.clip || p.dyn !== s.dyn) { o.prev = p.clip; o.prevTime = clipTime(p, p.t1) + (tt - s.t0); o.w = (tt - s.t0) / FADE; }
  }
  o.over = null; o.overW = 0;
  for (const ov of tr.overlays) {
    if (t >= ov.t && t <= ov.t + ov.dur) {
      o.over = ov.clip; o.overTime = t - ov.t;
      o.overW = Math.max(0, Math.min(1, (t - ov.t) / 0.06, (ov.t + ov.dur - t) / 0.15));
    }
  }
  return o;
}

/** The clip time of segment `s` at absolute (episode) time t. */
export function clipTime(s: Seg, t: number): number {
  const lt = Math.max(0, t - s.t0);
  if (s.cyc && s.plen) {
    const L = s.plen[s.plen.length - 1] * Math.min(1, lt / Math.max(1e-6, s.t1 - s.t0));
    const dur = clipMeta(s.clip)?.dur ?? 1;
    return (((s.dist0 ?? 0) + L) / s.cyc) * dur + (s.off ?? 0);
  }
  return lt * (s.rate ?? 1) + (s.off ?? 0);
}

/** Track end time (s). */
export const trackEnd = (tr: Track) => (tr.segs.length ? tr.segs[tr.segs.length - 1].t1 : 0);
