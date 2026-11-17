// Network smoothing for REMOTE performers (party members), used by every page that renders them (OBS output,
// studio previews) and by the studio for per-guest link stats. Pure TypeScript (no DOM / three.js) so the Node
// simulation (tools/test_party_net.ts) runs the exact same code.
//
//  * Clock offset: every packet carries the sender's clock (ms). d = arrival − sent mixes one-way delay with the
//    clock difference; its sliding MINIMUM (the least-delayed packet in the last ~8 s) is the base, and d − base is
//    that packet's jitter.
//  * Adaptive jitter buffer: frames play out at sender time  now − base − delay, where delay follows
//    p95(jitter) + half a frame interval, clamped to 40–120 ms (rises fast after a late burst, falls slowly).
//  * Between buffered frames: interpolation (numbers lerp, bone quaternions nlerp). Past the newest frame
//    (late / lost packets): damped constant-velocity extrapolation of head, position, gaze and bones (an α-β /
//    steady-state Kalman velocity estimate, capped — it can't run away), face held.
//  * Graceful degradation: nothing new for 500 ms → ease to neutral over 600 ms and report `live = false`
//    after 3 s (the renderer's idle animation takes over).
//  * Mouth: voice samples (~50 Hz, redundant, tiny) have their OWN shorter buffer and override visemes / jaw /
//    closure / speaking, so the mouth stays crisp even when head frames are late. A voice gap > 150 ms closes
//    the mouth quickly (a stuck-open mouth reads worst). `lipDelay` shifts it to line up with Discord audio.
import type { PartyNetStamp, TrackingFrame, VoiceSample } from '../../shared/types.ts';
import { visemeMap } from '../../shared/partyWire.ts';

export interface SmootherOptions {
  minDelay: number; maxDelay: number;
  extrapolate: number; holdMs: number; neutralMs: number;
  voiceMin: number; voiceMax: number;
  /** Extra mouth delay (ms, may be negative down to −voiceMin) to line up with the member's Discord audio. */
  lipDelay: number;
}
const DEFAULTS: SmootherOptions = { minDelay: 40, maxDelay: 120, extrapolate: 70, holdMs: 500, neutralMs: 600, voiceMin: 25, voiceMax: 90, lipDelay: 0 };

export interface LinkStats {
  /** Current playout delay (ms) of frames / voice. */
  delay: number; voiceDelay: number;
  /** p95 jitter (ms) over the last ~5 s. */
  jitter: number;
  /** Packet loss (%) from sequence gaps over the last ~5 s (frames). */
  loss: number;
  /** Frames arriving after their play-out time recently (%): the buffer ran dry and extrapolated. */
  late: number;
  /** ms since the last packet. */
  age: number;
  speaking: boolean;
}

/** u32 sender-ms unwrapping (performance.now mod 2^32). */
class Unwrap {
  private last = -1; private epoch = 0;
  map(raw: number): number {
    if (this.last >= 0) {
      if (raw < this.last - 2 ** 31) this.epoch += 2 ** 32;
      else if (raw > this.last + 2 ** 31) return raw + this.epoch - 2 ** 32; // straggler from before a wrap
    }
    this.last = raw;
    return raw + this.epoch;
  }
}

/** Sliding-minimum clock offset + jitter percentile. */
export class OffsetTracker {
  private hist: { a: number; d: number }[] = [];
  base = NaN;
  constructor(private windowMs = 8000) {}
  push(sent: number, arrival: number) {
    const d = arrival - sent;
    this.hist.push({ a: arrival, d });
    while (this.hist.length && this.hist[0].a < arrival - this.windowMs) this.hist.shift();
    if (this.hist.length > 800) this.hist.shift();
    let m = Infinity;
    for (const h of this.hist) if (h.d < m) m = h.d;
    this.base = m;
    return d - m;
  }
  /** Reused sort buffer (history is capped at 800): no per-call array, and the typed-array sort needs no comparator. */
  private scratch = new Float64Array(800);
  /** Jitter percentile (ms) over the last `ms`. */
  p(q: number, now: number, ms = 5000): number {
    const xs = this.scratch;
    let n = 0;
    for (const h of this.hist) if (h.a >= now - ms) xs[n++] = h.d - this.base;
    if (!n) return 0;
    xs.subarray(0, n).sort(); // numeric ascending, same order as the old (a, b) => a - b
    return xs[Math.min(n - 1, Math.floor(q * n))];
  }
}

interface Buffered { s: number; a: number; f: TrackingFrame }
type Q = [number, number, number, number];

const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
function nlerp(a: Q, b: Q, t: number): Q {
  const dot = a[0] * b[0] + a[1] * b[1] + a[2] * b[2] + a[3] * b[3];
  const s = dot < 0 ? -1 : 1;
  const q0 = lerp(a[0], s * b[0], t), q1 = lerp(a[1], s * b[1], t), q2 = lerp(a[2], s * b[2], t), q3 = lerp(a[3], s * b[3], t);
  const n = Math.hypot(q0, q1, q2, q3) || 1;
  return [q0 / n, q1 / n, q2 / n, q3 / n];
}
function qmul(a: Q, b: Q): Q {
  return [
    a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
    a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
    a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
    a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
  ];
}
const qinv = (q: Q): Q => [-q[0], -q[1], -q[2], q[3]];
/** Rotate `last` further by the (prev → last) rotation scaled by k (constant angular velocity). */
function qextrap(prev: Q, last: Q, k: number): Q {
  let d = qmul(last, qinv(prev));
  if (d[3] < 0) d = [-d[0], -d[1], -d[2], -d[3]];
  const ang = 2 * Math.acos(Math.min(1, d[3]));
  if (ang < 1e-6) return last;
  const sn = Math.sin(ang / 2), ax = [d[0] / sn, d[1] / sn, d[2] / sn];
  const a2 = Math.min(0.6, ang * k) / 2; // never more than ~35° of extrapolated turn
  const s2 = Math.sin(a2);
  const out = qmul([ax[0] * s2, ax[1] * s2, ax[2] * s2, Math.cos(a2)], last);
  const n = Math.hypot(...out) || 1;
  return [out[0] / n, out[1] / n, out[2] / n, out[3] / n];
}

function cloneBones(b: Record<string, Q>): Record<string, Q> {
  const o: Record<string, Q> = {};
  for (const k in b) o[k] = [...b[k]] as Q;
  return o;
}
function cloneFrame(f: TrackingFrame): TrackingFrame {
  return {
    ...f, face: { ...f.face }, head: [...f.head] as TrackingFrame['head'], headPos: [...f.headPos] as TrackingFrame['headPos'],
    gaze: [...f.gaze] as TrackingFrame['gaze'], mouth: { ...f.mouth }, visemes: f.visemes ? { ...f.visemes } : undefined,
    lips: f.lips ? { u: [...f.lips.u], l: [...f.lips.l] } : undefined,
    bones: f.bones ? cloneBones(f.bones) : undefined,
  };
}
function mixMaps(a: Record<string, number> | undefined, b: Record<string, number> | undefined, t: number): Record<string, number> | undefined {
  if (!a && !b) return undefined;
  const out: Record<string, number> = {};
  for (const k in a ?? {}) out[k] = lerp(a![k], b?.[k] ?? 0, t);
  for (const k in b ?? {}) if (!(k in out)) out[k] = lerp(0, b![k], t);
  return out;
}
function interp(a: TrackingFrame, b: TrackingFrame, t: number): TrackingFrame {
  // Build the result directly. The nearer frame supplies every field that is not mixed here (t, tracked, life, ...);
  // face / head / headPos / gaze / mouth / visemes are always fresh, and lips / bones are only copied from that
  // frame when they cannot be mixed (one side missing), so nothing is cloned just to be overwritten.
  const n = t < 0.5 ? a : b;
  const lips = a.lips && b.lips
    ? { u: a.lips.u.map((v, i) => lerp(v, b.lips!.u[i] ?? v, t)), l: a.lips.l.map((v, i) => lerp(v, b.lips!.l[i] ?? v, t)) }
    : n.lips ? { u: [...n.lips.u], l: [...n.lips.l] } : undefined;
  let bones: Record<string, Q> | undefined;
  if (a.bones && b.bones) {
    bones = {};
    for (const k in b.bones) bones[k] = a.bones[k] ? nlerp(a.bones[k], b.bones[k], t) : ([...b.bones[k]] as Q);
  } else bones = n.bones ? cloneBones(n.bones) : undefined;
  return {
    ...n,
    face: mixMaps(a.face, b.face, t)!,
    head: [lerp(a.head[0], b.head[0], t), lerp(a.head[1], b.head[1], t), lerp(a.head[2], b.head[2], t)],
    headPos: [lerp(a.headPos[0], b.headPos[0], t), lerp(a.headPos[1], b.headPos[1], t), lerp(a.headPos[2], b.headPos[2], t)],
    gaze: [lerp(a.gaze[0], b.gaze[0], t), lerp(a.gaze[1], b.gaze[1], t)],
    mouth: mixMaps(a.mouth as unknown as Record<string, number>, b.mouth as unknown as Record<string, number>, t) as unknown as TrackingFrame['mouth'],
    visemes: a.visemes || b.visemes ? mixMaps(a.visemes, b.visemes, t) : undefined,
    lips,
    bones,
    snack: a.snack, // discrete: from the earlier frame
  };
}

/** Velocity (per ms) estimate of the vector channels, α-β smoothed across arrivals. */
interface Vel { head: number[]; pos: number[]; gaze: number[] }

export class RemoteSmoother {
  readonly opt: SmootherOptions;
  private clock = new OffsetTracker();
  private unwrap = new Unwrap();
  private vunwrap = new Unwrap();
  private buf: Buffered[] = [];
  private voice: VoiceSample[] = [];
  private delay: number;
  private vdelay: number;
  private vel: Vel = { head: [0, 0, 0], pos: [0, 0, 0], gaze: [0, 0] };
  private interval = 50;
  /** Received sequence numbers (unwrapped) over the last ~5 s: loss = gaps in the window (reordering is not loss). */
  private seqs: { a: number; q: number }[] = [];
  private seqTop = -1;
  private lateLog: { a: number; late: boolean }[] = [];
  private lastPlay = -Infinity;
  /** Local time (ms) of the newest frame / voice packet. */
  lastArrival = -Infinity;
  lastVoiceArrival = -Infinity;
  private shown: TrackingFrame | null = null;

  constructor(opt: Partial<SmootherOptions> = {}) {
    this.opt = { ...DEFAULTS, ...opt };
    this.delay = this.opt.minDelay + 20;
    this.vdelay = this.opt.voiceMin + 10;
  }

  /** A frame arrived. `net` missing (legacy JSON peers) → timed by arrival. */
  pushFrame(f: TrackingFrame, net: PartyNetStamp | undefined, now: number) {
    const s = net ? this.unwrap.map(net.s) : now;
    const jit = this.clock.push(s, now);
    this.lastArrival = now;
    if (net) {
      const raw = net.q & 0xffff;
      // unwrap the 16-bit counter around the highest sequence seen
      let q = raw;
      if (this.seqTop >= 0) {
        const base = this.seqTop - (this.seqTop & 0xffff);
        q = base + raw;
        if (q < this.seqTop - 0x8000) q += 0x10000; else if (q > this.seqTop + 0x8000) q -= 0x10000;
      }
      this.seqTop = Math.max(this.seqTop, q);
      this.seqs.push({ a: now, q });
      while (this.seqs.length && this.seqs[0].a < now - 5000) this.seqs.shift();
    }
    // late = would already have been past its play-out time
    const playS = now - this.clock.base - this.delay;
    this.lateLog.push({ a: now, late: s < playS });
    while (this.lateLog.length && this.lateLog[0].a < now - 5000) this.lateLog.shift(); // same 5 s window stats() reads; pages that never call stats() would grow it forever
    // insert sorted by sender time (reordering on the unreliable channel); drop duplicates / hopeless stragglers
    if (s < this.lastPlay - 200 || this.buf.some((b) => b.s === s)) return;
    let i = this.buf.length;
    while (i > 0 && this.buf[i - 1].s > s) i--;
    this.buf.splice(i, 0, { s, a: now, f });
    const last = this.buf[this.buf.length - 1];
    if (i === this.buf.length - 1 && this.buf.length >= 2) {
      const prev = this.buf[this.buf.length - 2];
      const dt = last.s - prev.s;
      if (dt > 5 && dt < 400) {
        this.interval = this.interval * 0.9 + dt * 0.1;
        const a = 0.5; // α-β velocity gain
        for (let k = 0; k < 3; k++) {
          this.vel.head[k] = lerp(this.vel.head[k], (last.f.head[k] - prev.f.head[k]) / dt, a);
          this.vel.pos[k] = lerp(this.vel.pos[k], (last.f.headPos[k] - prev.f.headPos[k]) / dt, a);
        }
        for (let k = 0; k < 2; k++) this.vel.gaze[k] = lerp(this.vel.gaze[k], (last.f.gaze[k] - prev.f.gaze[k]) / dt, a);
      }
    }
    while (this.buf.length > 64 || (this.buf.length > 3 && this.buf[1].s < this.lastPlay - 1000)) this.buf.shift();
    // adapt the play-out delay: p95 jitter + half a frame interval, up fast, down slowly
    const target = Math.min(this.opt.maxDelay, Math.max(this.opt.minDelay, this.clock.p(0.95, now) + this.interval * 0.5));
    this.delay += (target - this.delay) * (target > this.delay ? 0.25 : 0.02);
    void jit;
  }

  /** Voice samples arrived (redundant: duplicates are ignored). */
  pushVoice(samples: VoiceSample[], now: number) {
    if (!samples.length) return;
    const newest = samples[samples.length - 1];
    const ts = samples.map((x) => ({ ...x, t: this.vunwrap.map(Math.round(x.t) >>> 0) }));
    this.clock.push(ts[ts.length - 1].t, now);
    this.lastVoiceArrival = now;
    for (const x of ts) {
      if (this.voice.some((v) => Math.abs(v.t - x.t) < 1)) continue;
      let i = this.voice.length;
      while (i > 0 && this.voice[i - 1].t > x.t) i--;
      this.voice.splice(i, 0, x);
    }
    while (this.voice.length > 120) this.voice.shift();
    const target = Math.min(this.opt.voiceMax, Math.max(this.opt.voiceMin, this.clock.p(0.9, now, 3000) + 8));
    this.vdelay += (target - this.vdelay) * (target > this.vdelay ? 0.3 : 0.03);
    void newest;
  }

  /** The newest voice sample's speaking level (vad) and the newest frame's mouth, as they arrived — no play-out delay,
   *  nothing advanced (the host studio's interview director, src/ui/stage/interviewHost.ts). null = nothing for 600 ms. */
  latestVoice(now: number): { speak: number | null; open: number | null } | null {
    const v = now - this.lastVoiceArrival < 600 ? this.voice[this.voice.length - 1] ?? null : null;
    const f = now - this.lastArrival < 600 ? this.buf[this.buf.length - 1]?.f ?? null : null;
    if (!v && !f) return null;
    const fs = f && typeof f.mouth?.speak === 'number' ? f.mouth.speak : null;
    return { speak: v ? v.vad : fs, open: f && f.tracked !== false && Number.isFinite(f.mouth?.open) ? f.mouth.open : null };
  }

  /** The frame to render at local time `now` (ms). */
  sample(now: number): TrackingFrame {
    const o = this.opt;
    if (!this.buf.length) return this.shown ?? neutralFrame();
    const base = Number.isFinite(this.clock.base) ? this.clock.base : 0;
    const ps = now - base - this.delay;
    this.lastPlay = ps;
    const b = this.buf;
    let out: TrackingFrame;
    if (ps <= b[0].s) out = cloneFrame(b[0].f);
    else if (ps >= b[b.length - 1].s) {
      const last = b[b.length - 1], prev = b.length > 1 ? b[b.length - 2] : null;
      out = cloneFrame(last.f);
      const gap = ps - last.s;
      // damped constant velocity: at most τ(1 − e^(−gap/τ)) ms of motion, τ = extrapolate
      const eff = o.extrapolate * (1 - Math.exp(-gap / o.extrapolate));
      for (let k = 0; k < 3; k++) { out.head[k] += this.vel.head[k] * eff; out.headPos[k] += this.vel.pos[k] * eff; }
      for (let k = 0; k < 2; k++) out.gaze[k] += this.vel.gaze[k] * eff;
      if (prev && prev.f.bones && last.f.bones) {
        const dt = last.s - prev.s;
        if (dt > 5 && dt < 400) for (const k in last.f.bones) if (prev.f.bones[k]) out.bones![k] = qextrap(prev.f.bones[k], last.f.bones[k], eff / dt);
      }
    } else {
      let i = b.length - 2;
      while (i > 0 && b[i].s > ps) i--;
      const A = b[i], B = b[i + 1];
      out = interp(A.f, B.f, (ps - A.s) / Math.max(1e-3, B.s - A.s));
    }
    // nothing new for a while → ease to neutral (and stay there)
    const since = now - this.lastArrival;
    if (since > o.holdMs) {
      const w = Math.min(1, (since - o.holdMs) / o.neutralMs);
      out = towardNeutral(out, w * w * (3 - 2 * w));
      if (since > 3000) { out.tracked = false; out.bones = undefined; }
    }
    this.applyVoice(out, now, base);
    this.shown = out;
    return out;
  }

  private applyVoice(out: TrackingFrame, now: number, base: number) {
    if (!this.voice.length || now - this.lastVoiceArrival > 1500) return; // no voice stream: frame mouth as sent
    const pv = now - base - Math.max(0, this.vdelay + this.opt.lipDelay);
    const v = this.voice;
    let s: VoiceSample;
    if (pv <= v[0].t) s = v[0];
    else if (pv >= v[v.length - 1].t) s = v[v.length - 1];
    else {
      let i = v.length - 2;
      while (i > 0 && v[i].t > pv) i--;
      const A = v[i], B = v[i + 1], t = (pv - A.t) / Math.max(1e-3, B.t - A.t);
      const vis = mixMaps(visemeMap(A.vis), visemeMap(B.vis), t)!;
      s = { t: pv, vad: lerp(A.vad, B.vad, t), level: lerp(A.level, B.level, t), open: lerp(A.open, B.open, t), closure: lerp(A.closure, B.closure, t), vis: [] };
      (s as VoiceSample & { map?: Record<string, number> }).map = vis;
    }
    let vis = (s as VoiceSample & { map?: Record<string, number> }).map ?? visemeMap(s.vis);
    // voice gap: close the mouth over ~100 ms
    const gap = pv - v[v.length - 1].t;
    let k = 1;
    if (gap > 150) k = Math.max(0, 1 - (gap - 150) / 100);
    if (k < 1) { vis = Object.fromEntries(Object.entries(vis).map(([n, w]) => [n, w * k])); vis.sil = (vis.sil ?? 0) + (1 - k); }
    out.visemes = vis;
    out.mouth = { ...out.mouth, open: s.open * k, speak: s.vad * k, closure: s.closure * k };
    this.speaking = s.vad * k > 0.5;
  }
  speaking = false;

  stats(now: number): LinkStats {
    const recent = this.seqs.filter((x) => x.a >= now - 5000);
    const uniq = new Set(recent.map((x) => x.q));
    let lo = Infinity, hi = -Infinity;
    for (const q of uniq) { if (q < lo) lo = q; if (q > hi) hi = q; }
    const expected = uniq.size ? hi - lo + 1 : 0;
    this.lateLog = this.lateLog.filter((x) => x.a >= now - 5000);
    const late = this.lateLog.filter((x) => x.late).length;
    return {
      delay: Math.round(this.delay), voiceDelay: Math.round(this.vdelay), jitter: Math.round(this.clock.p(0.95, now)),
      loss: expected > 1 ? Math.round((1000 * (expected - uniq.size)) / expected) / 10 : 0,
      late: this.lateLog.length ? Math.round((1000 * late) / this.lateLog.length) / 10 : 0,
      age: Math.round(now - Math.max(this.lastArrival, this.lastVoiceArrival)), speaking: this.speaking,
    };
  }
}

export function neutralFrame(): TrackingFrame {
  return { t: 0, face: {}, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0], mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 }, tracked: false };
}
function towardNeutral(f: TrackingFrame, w: number): TrackingFrame {
  const o = cloneFrame(f);
  for (const k in o.face) o.face[k] *= 1 - w;
  for (let i = 0; i < 3; i++) { o.head[i] *= 1 - w; o.headPos[i] *= 1 - w; }
  o.gaze = [o.gaze[0] * (1 - w), o.gaze[1] * (1 - w)];
  const m = o.mouth as unknown as Record<string, number>;
  for (const k in m) m[k] *= 1 - w;
  if (o.visemes) { for (const k in o.visemes) o.visemes[k] *= 1 - w; o.visemes.sil = (o.visemes.sil ?? 0) + w; }
  // bones are held (identity is a T-pose, not a rest pose); after 3 s `tracked = false` hands over to the idle pose
  return o;
}
