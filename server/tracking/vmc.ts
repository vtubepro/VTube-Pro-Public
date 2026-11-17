// VMC protocol (Virtual Motion Capture, https://protocol.vmc.info/english) — OSC over UDP.
//
// RECEIVER ("Marionette", default UDP 39539): lets VSeeFace, XR Animator, Webcam Motion Capture,
// Warudo, VMagicMirror, VNyan … drive VTube Pro.
//   /VMC/Ext/Blend/Val  (s name)(f value)       BlendShapeProxy value; VRM presets or Perfect-Sync ARKit names
//   /VMC/Ext/Blend/Apply                          end of one blendshape frame
//   /VMC/Ext/Bone/Pos   (s name)(f px py pz)(f qx qy qz qw)   HumanBodyBones name, LOCAL pose, Unity space
//   /VMC/Ext/Root/Pos   (s name)(f px py pz)(f qx qy qz qw)[(f sx sy sz)(f ox oy oz)]
//   /VMC/Ext/OK         (i loaded)[(i calibState)(i calibMode)[(i trackingStatus)]]
//   /VMC/Ext/T          (f time)
//
// SENDER (VmcSender below): streams OUR face as /VMC/Ext/Blend/Val (Perfect-Sync ARKit names + VRM presets)
// and /VMC/Ext/Bone/Pos Head, so a VMC receiver (VSeeFace "VMC receiver", Warudo, VNyan, VMagicMirror …)
// can be driven by VTube Pro's webcam tracking.
//
// Unity is left-handed with the avatar facing +Z: its own right is +X. Unity euler angles are applied
// Z, then X, then Y (R = Ry·Rx·Rz — the same algebra as three.js 'YXZ'), degrees:
//   euler.x > 0 → pitch down, euler.y > 0 → turn to the avatar's right, euler.z > 0 → tilt to the avatar's left.
// The VMC performer's avatar moves like the performer (its left = the performer's left), so
//   ExternalTracking head = [pitch = x, yaw(+left) = −y, roll(+left) = z].
import dgram from 'node:dgram';
import type { ExternalTracking, TrackingFrame, Vec3 } from '../../shared/types.ts';
import {
  MAX_PACKET, RateCounter, SenderLock, applyInvert, arkitName, clamp, clamp01, eyeDeg, headDeg, num, nowSec, throttled,
  type AxisInvert, type SourceRuntime, type SourceStatus,
} from './common.ts';
import { F, I, S, encodeBundle, encodeMessage, parseOsc } from './osc.ts';

type Quat = [number, number, number, number];

export interface VmcConfig {
  enabled: boolean;
  port: number;
  /** Second listen port: face-only VMC assistants (Waidayo, AndroidMoCap …) often send to the "performer" port
   *  39540 instead of 39539 (protocol.vmc.info). Best effort: skipped if busy (e.g. VSeeFace is running) or if our own
   *  VMC sender targets it on this PC. 0 = off. */
  port2: number;
  bind: string;
  /** Only accept this phone / sender ('' = the first one that sends is kept). */
  phoneIp: string;
  /** Flip head axes if an app disagrees (the phone card's "Head turns the wrong way? Flip it"). */
  invert: AxisInvert;
  /** Optional sender: our tracking → another VMC app. */
  out: { enabled: boolean; host: string; port: number };
}

export const VMC_DEFAULTS: VmcConfig = {
  enabled: false, port: 39539, port2: 39540, bind: '0.0.0.0', phoneIp: '', invert: { yaw: false, pitch: false, roll: false },
  out: { enabled: false, host: '127.0.0.1', port: 39540 },
};

// ---------------------------------------------------------------- math

const RAD = 180 / Math.PI;

function normQ(q: Quat): Quat {
  const n = Math.hypot(q[0], q[1], q[2], q[3]);
  return n > 1e-6 ? [q[0] / n, q[1] / n, q[2] / n, q[3] / n] : [0, 0, 0, 1];
}

export function mulQ(a: Quat, b: Quat): Quat {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}

/** Quaternion → Unity euler degrees [x, y, z] (R = Ry·Rx·Rz; the three.js 'YXZ' decomposition). */
export function unityEuler(q: Quat): Vec3 {
  const [x, y, z, w] = normQ(q);
  const m11 = 1 - 2 * (y * y + z * z), m13 = 2 * (x * z + y * w);
  const m21 = 2 * (x * y + z * w), m22 = 1 - 2 * (x * x + z * z), m23 = 2 * (y * z - x * w);
  const m31 = 2 * (x * z - y * w), m33 = 1 - 2 * (x * x + y * y);
  const ex = Math.asin(-clamp(m23, -1, 1));
  let ey: number, ez: number;
  if (Math.abs(m23) < 0.9999999) { ey = Math.atan2(m13, m33); ez = Math.atan2(m21, m22); }
  else { ey = Math.atan2(-m31, m11); ez = 0; }
  return [ex * RAD, ey * RAD, ez * RAD];
}

/** Unity euler degrees → quaternion (R = Ry·Rx·Rz; three.js setFromEuler 'YXZ'). */
export function unityQuat(xDeg: number, yDeg: number, zDeg: number): Quat {
  const h = Math.PI / 360;
  const c1 = Math.cos(xDeg * h), c2 = Math.cos(yDeg * h), c3 = Math.cos(zDeg * h);
  const s1 = Math.sin(xDeg * h), s2 = Math.sin(yDeg * h), s3 = Math.sin(zDeg * h);
  return [
    s1 * c2 * c3 + c1 * s2 * s3,
    c1 * s2 * c3 - s1 * c2 * s3,
    c1 * c2 * s3 - s1 * s2 * c3,
    c1 * c2 * c3 + s1 * s2 * s3,
  ];
}

// ---------------------------------------------------------------- blendshape mapping

/** VRM 0.x / 1.0 expression presets → ARKit approximations (values are multiplied by the preset weight). */
const VRM_PRESETS: Record<string, Record<string, number>> = {
  a: { jawOpen: 1 }, aa: { jawOpen: 1 },
  i: { jawOpen: 0.25, mouthStretchLeft: 0.8, mouthStretchRight: 0.8 }, ih: { jawOpen: 0.25, mouthStretchLeft: 0.8, mouthStretchRight: 0.8 },
  u: { jawOpen: 0.15, mouthPucker: 1 }, ou: { jawOpen: 0.15, mouthPucker: 1 },
  e: { jawOpen: 0.4, mouthStretchLeft: 0.5, mouthStretchRight: 0.5 }, ee: { jawOpen: 0.4, mouthStretchLeft: 0.5, mouthStretchRight: 0.5 },
  o: { jawOpen: 0.5, mouthFunnel: 1 }, oh: { jawOpen: 0.5, mouthFunnel: 1 },
  blink: { eyeBlinkLeft: 1, eyeBlinkRight: 1 },
  blink_l: { eyeBlinkLeft: 1 }, blinkleft: { eyeBlinkLeft: 1 },
  blink_r: { eyeBlinkRight: 1 }, blinkright: { eyeBlinkRight: 1 },
  joy: { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.6, cheekSquintRight: 0.6 },
  happy: { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.6, cheekSquintRight: 0.6 },
  angry: { browDownLeft: 1, browDownRight: 1, mouthFrownLeft: 0.6, mouthFrownRight: 0.6, noseSneerLeft: 0.4, noseSneerRight: 0.4 },
  sorrow: { browInnerUp: 1, mouthFrownLeft: 0.8, mouthFrownRight: 0.8 }, sad: { browInnerUp: 1, mouthFrownLeft: 0.8, mouthFrownRight: 0.8 },
  fun: { mouthSmileLeft: 0.7, mouthSmileRight: 0.7 }, relaxed: { mouthSmileLeft: 0.5, mouthSmileRight: 0.5, eyeSquintLeft: 0.3, eyeSquintRight: 0.3 },
  surprised: { eyeWideLeft: 1, eyeWideRight: 1, browInnerUp: 1, browOuterUpLeft: 1, browOuterUpRight: 1, jawOpen: 0.3 },
};

/** Map raw VMC blend values to ARKit (max-combined; Perfect-Sync ARKit names pass straight through). */
export function vmcBlendToArkit(raw: Map<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  const put = (k: string, v: number) => { if (v > (out[k] ?? 0)) out[k] = clamp01(v); };
  // A Perfect-Sync sender (Waidayo, VSeeFace with a Perfect-Sync model, OUR sender) sends the 52 ARKit shapes AND the VRM
  // presets for models without them. The presets are approximations built FROM the shapes: max-combining them back in
  // inflated jawOpen / smile / blink (a recorded round trip through our own sender was off by 0.15), so a stream that
  // carries ARKit shapes is read from those alone.
  let arkit = 0;
  for (const name of raw.keys()) if (arkitName(name)) arkit++;
  const perfectSync = arkit >= 20;
  for (const [name, v] of raw) {
    if (!(v > 0)) continue;
    const preset = VRM_PRESETS[name.toLowerCase()];
    if (preset) { if (!perfectSync) for (const k in preset) put(k, preset[k] * v); continue; }
    const k = arkitName(name);
    if (k) put(k, v);
  }
  return out;
}

// ---------------------------------------------------------------- receiver

export class VmcReceiver implements SourceRuntime {
  private sock: dgram.Socket | null = null;
  private sock2: dgram.Socket | null = null;
  private port2Note: string | null = null;
  private rate = new RateCounter();
  private lastError: string | null = null;
  private blend = new Map<string, number>();
  private bones = new Map<string, { p: Vec3; q: Quat }>();
  private found = true;
  private lastFrom = '';
  /** The first sender's address, held across silence (common.ts SenderLock; "That's not
   *  my phone" in the studio = forget(), "Use it" = switchPhone()). */
  private lock = new SenderLock();
  private publish: ReturnType<typeof throttled>;

  constructor(private cfg: VmcConfig, publish: (d: ExternalTracking) => void) {
    this.publish = throttled(publish, 60);
  }

  async start() {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('error', (e) => { this.lastError = e.message; });
    sock.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(this.cfg.port, this.cfg.bind, () => { sock.off('error', reject); resolve(); });
    }).catch((e: Error) => { this.lastError = `Can't listen on UDP ${this.cfg.bind}:${this.cfg.port} — ${e.message}`; try { sock.close(); } catch { /* */ } throw e; });
    this.sock = sock;
    this.lastError = null;
    const p2 = this.cfg.port2;
    if (p2 && p2 !== this.cfg.port) {
      const s2 = dgram.createSocket({ type: 'udp4', reuseAddr: false });
      s2.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
      await new Promise<void>((resolve) => {
        s2.once('error', (e) => { this.port2Note = `port ${p2} not used (${e.message})`; try { s2.close(); } catch { /* */ } resolve(); });
        s2.bind(p2, this.cfg.bind, () => { s2.removeAllListeners('error'); s2.on('error', () => {}); this.sock2 = s2; resolve(); });
      });
    }
  }

  /** Exposed for tests: feed one datagram. */
  onPacket(msg: Buffer, rinfo?: { address: string; port: number }) {
    if (msg.length > MAX_PACKET) return;
    if (rinfo) {
      const ip = rinfo.address.replace(/^::ffff:/, '');
      if (!this.lock.allows(ip, this.cfg.phoneIp)) return;
    }
    let msgs;
    try { msgs = parseOsc(msg); } catch (e) { this.lastError = `Malformed OSC: ${(e as Error).message}`; return; }
    let dirty = false;
    for (const m of msgs) {
      const a = m.args;
      switch (m.address) {
        case '/VMC/Ext/Blend/Val':
          if (typeof a[0] === 'string' && a[0].length <= 64 && (this.blend.size < 256 || this.blend.has(a[0]))) this.blend.set(a[0], clamp01(num(a[1])));
          break;
        case '/VMC/Ext/Blend/Apply':
          dirty = true;
          break;
        case '/VMC/Ext/Bone/Pos':
        case '/VMC/Ext/Root/Pos': {
          if (typeof a[0] !== 'string' || a[0].length > 64 || a.length < 8) break;
          const name = m.address === '/VMC/Ext/Root/Pos' ? 'Root' : a[0];
          if (this.bones.size >= 96 && !this.bones.has(name)) break;
          const p: Vec3 = [clamp(num(a[1]), -100, 100), clamp(num(a[2]), -100, 100), clamp(num(a[3]), -100, 100)];
          const q = normQ([num(a[4]), num(a[5]), num(a[6]), num(a[7], 1)]);
          this.bones.set(name, { p, q });
          dirty = true;
          break;
        }
        case '/VMC/Ext/OK':
          // tracking status (v2.7+): 1 = tracking; loaded = 0 → no avatar at the sender
          if (a.length >= 4) this.found = num(a[3]) === 1;
          else if (a.length >= 1) this.found = num(a[0]) === 1;
          break;
      }
    }
    if (!dirty) return;
    this.rate.hit();
    if (rinfo) { this.lastFrom = `${rinfo.address}:${rinfo.port}`; this.lock.accept(rinfo.address.replace(/^::ffff:/, ''), this.cfg.phoneIp); }
    this.publish(applyInvert(this.snapshot(), this.cfg.invert));
  }

  private snapshot(): ExternalTracking {
    const d: ExternalTracking = { source: 'vmc', t: nowSec(), found: this.found };
    if (this.blend.size) d.blendshapes = vmcBlendToArkit(this.blend);
    const head = this.bones.get('Head'), neck = this.bones.get('Neck');
    if (head) {
      const q = neck ? mulQ(neck.q, head.q) : head.q;
      const [x, y, z] = unityEuler(q);
      d.head = headDeg(x, -y, z);
    }
    for (const [bone, key] of [['LeftEye', 'eyeLeft'], ['RightEye', 'eyeRight']] as const) {
      const b = this.bones.get(bone);
      if (b) { const [x, y] = unityEuler(b.q); d[key] = eyeDeg(x, -y); }
    }
    if (this.bones.size) {
      const bones: NonNullable<ExternalTracking['bones']> = {};
      for (const [k, v] of this.bones) bones[k] = { p: v.p, q: v.q };
      d.bones = bones;
    }
    return d;
  }

  forget() { this.lock.forget(); this.lastFrom = ''; this.blend.clear(); this.bones.clear(); this.rate.reset(); }
  /** "Use it": the device that was knocking takes over (SenderLock.take). */
  switchPhone(): boolean { const c = this.lock.take(); if (c) { this.lastFrom = ''; this.blend.clear(); this.bones.clear(); this.rate.reset(); } return !!c; }

  async stop() {
    this.publish.cancel();
    const s = this.sock;
    this.sock = null;
    this.blend.clear();
    this.bones.clear();
    if (s) await new Promise<void>((r) => { try { s.close(() => r()); } catch { r(); } });
    const s2 = this.sock2;
    this.sock2 = null;
    if (s2) await new Promise<void>((r) => { try { s2.close(() => r()); } catch { r(); } });
  }

  status(): SourceStatus {
    const fresh = this.rate.lastSeen !== null && Date.now() - this.rate.lastSeen < 1000;
    return {
      kind: 'vmc', enabled: this.cfg.enabled, running: !!this.sock, bind: this.cfg.bind, port: this.cfg.port,
      packetsPerSec: this.rate.perSec(), packetsTotal: this.rate.total, lastSeen: this.rate.lastSeen,
      faceFound: fresh && this.found, lastError: this.lastError,
      info: { sender: this.lastFrom, phone: this.cfg.phoneIp || this.lock.current(), candidate: this.lock.candidate(), blendshapes: this.blend.size, bones: this.bones.size, port2: this.sock2 ? this.cfg.port2 : null, port2Note: this.port2Note },
    };
  }
}

// ---------------------------------------------------------------- sender

const pascal = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * VMC sender: VTube Pro tracking → any VMC receiver.
 *
 *   const out = new VmcSender({ host: '127.0.0.1', port: 39540 });
 *   out.send(frame);          // call at tracking rate with the studio's TrackingFrame (≤ 60 Hz is plenty)
 *   out.setTarget(host, port);
 *   out.close();
 *
 * TrackingFrame is avatar-space (mirror already applied): head [yaw(+avatar-left), pitch(+down), roll] radians,
 * with roll > 0 tilting toward the avatar's right (see faceSolver.ts). Converted to Unity euler for the Head bone:
 *   unity.x = pitch, unity.y = −yaw, unity.z = −roll.
 * Blendshapes go out as Perfect-Sync PascalCase ARKit names ("EyeBlinkLeft") plus VRM presets
 * (Blink_L/Blink_R/A/I/U/E/O/Joy) so non-Perfect-Sync models still react.
 */
export class VmcSender {
  private sock: dgram.Socket;
  private t0 = Date.now();
  sent = 0;
  lastError: string | null = null;

  constructor(private target: { host: string; port: number }) {
    this.sock = dgram.createSocket('udp4');
    this.sock.on('error', (e) => { this.lastError = e.message; });
  }

  setTarget(host: string, port: number) { this.target = { host, port }; }

  /** Build the OSC bundle for a frame (exposed for tests). */
  encode(frame: TrackingFrame): Buffer {
    const els: Buffer[] = [];
    const f = frame.face ?? {};
    for (const k in f) {
      if (k.startsWith('_')) continue;
      const v = clamp01(num(f[k]));
      els.push(encodeMessage('/VMC/Ext/Blend/Val', [S(pascal(k)), F(v)]));
    }
    const g = (k: string) => clamp01(num(f[k]));
    const m = frame.mouth;
    const presets: [string, number][] = [
      ['Blink_L', g('eyeBlinkLeft')], ['Blink_R', g('eyeBlinkRight')],
      ['A', clamp01(num(m?.open))], ['I', (g('mouthStretchLeft') + g('mouthStretchRight')) / 2], ['U', clamp01(num(m?.pucker))],
      ['E', 0], ['O', clamp01(num(m?.funnel))], ['Joy', clamp01(num(m?.smile))],
    ];
    for (const [k, v] of presets) els.push(encodeMessage('/VMC/Ext/Blend/Val', [S(k), F(v)]));
    els.push(encodeMessage('/VMC/Ext/Blend/Apply'));
    const [yaw, pitch, roll] = frame.head ?? [0, 0, 0];
    const q = unityQuat(num(pitch) * RAD, -num(yaw) * RAD, -num(roll) * RAD);
    els.push(encodeMessage('/VMC/Ext/Bone/Pos', [S('Head'), F(0), F(0), F(0), F(q[0]), F(q[1]), F(q[2]), F(q[3])]));
    els.push(encodeMessage('/VMC/Ext/OK', [I(1), I(3), I(0), I(frame.tracked ? 1 : 0)]));
    els.push(encodeMessage('/VMC/Ext/T', [F((Date.now() - this.t0) / 1000)]));
    return encodeBundle(els);
  }

  send(frame: TrackingFrame) {
    let buf: Buffer;
    try { buf = this.encode(frame); } catch (e) { this.lastError = (e as Error).message; return; }
    this.sock.send(buf, this.target.port, this.target.host, (e) => { if (e) this.lastError = e.message; else this.sent++; });
  }

  close() { try { this.sock.close(); } catch { /* already closed */ } }
}
