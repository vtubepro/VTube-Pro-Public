// Epic "Live Link Face" (free iPhone app, Live Link (ARKit) mode) UDP receiver.
//
// Wire format = Unreal's AppleARKit Live Link remote publisher, serialised with FNboSerializeToBuffer
// (network byte order = BIG-endian throughout). Checked against three independent open-source parsers and
// a real captured stream:
//   - JimWest/PyLiveLinkFace  pylivelinkface/pylivelinkface.py (decode(): '!i' string lengths, '!if2i' frame time, 'b' count, '!61f')
//   - nmfisher/blender_livelinkface  pylivelinkface.py (same decode, comment "BLEND_SHAPE_PACKET_VER (uint8), DeviceId, SubjectName, …")
//   - aelzeiny/Animoji livelink.py ('>B' version == 6, '>i'+utf8 strings, '>ifii' frame time, '>B' count == 61, '>f' × count)
//     + experimentation/livelink.udp — 567 real iPhone packets: 560 × 319 bytes (full) and 7 × 74 bytes (header only)
//   - shun126/livelinkface_arkit_receiver __init__.py (same offsets, '>' everywhere)
// (PyLiveLinkFace's encoder writes the version as '<I' + a 37-byte "$uuid" — byte-identical to uint8 6 followed by
//  an int32-BE length 0x24 = 36 and the UUID, which is how the two descriptions reconcile.)
//
//   phone → PC UDP :11111 (app default), ~60 Hz, one datagram per ARKit frame:
//     u8     packet version (6)
//     i32be  device-id length, then that many UTF-8 bytes (a UUID, 36 chars)
//     i32be  subject-name length, then UTF-8 bytes (the phone's name, e.g. "Ahmeds_iPhone")
//     i32be  frame number, f32be subframe, i32be fps numerator, i32be fps denominator   (FQualifiedFrameTime)
//     u8     blendshape count (61)            ← absent in "header only" packets (no face / subject announce)
//     f32be  × count, in UE's EARFaceBlendShape order: the 52 ARKit shapes (0..1) then
//            HeadYaw, HeadPitch, HeadRoll, LeftEyeYaw, LeftEyePitch, LeftEyeRoll, RightEyeYaw, RightEyePitch, RightEyeRoll
//
// Rotation units and signs (no public spec — derived from the capture above and Face_Landmark_Link, a tool that
// fakes LLF packets from MediaPipe: Qaanaaq/Face_Landmark_Link Face_Landmarker_Link_stream.py sends
// yaw = euler_y, pitch = −euler_x, roll = euler_z of the MediaPipe pose matrix, in RADIANS):
//   - RADIANS. In the capture LeftEyeYaw = −0.58 × (eyeLookOutLeft − eyeLookInLeft) with r = −1.000, i.e. a full
//     ARKit eye-look reads ≈ 0.58 rad ≈ 33° (ARKit's iris travel). Head values span ≈ ±0.5.
//   - Eye yaw > 0 = looking to the performer's RIGHT, eye pitch > 0 = looking DOWN (r = ±1.000 vs eyeLook*).
//   - Head yaw > 0 = turn to the performer's LEFT, head pitch > 0 = nod UP: the eyes counter-rotate against the
//     head while the performer watches the screen (HeadPitch ≈ LeftEyePitch, HeadYaw vs eye yaw r = +0.96), and
//     Face_Landmark_Link's MediaPipe mapping gives the same signs.
//   - Head roll > 0 = tilt to the performer's RIGHT (Face_Landmark_Link: roll = +euler_z; lowest confidence →
//     the per-source "invert" toggles exist for exactly this).
//   → ExternalTracking (degrees; head [pitch +down, yaw +left, roll +left]; eyes [pitch +down, yaw +left]):
//       head = [−HeadPitch, +HeadYaw, −HeadRoll]°, eye = [+EyePitch, −EyeYaw]°. No head position is sent.
// Blendshape names are ARKit's (performer's own sides), passed through unchanged like the other receivers.
import dgram from 'node:dgram';
import type { ExternalTracking } from '../../shared/types.ts';
import {
  RateCounter, SenderLock, applyInvert, arkitName, bareIp, clamp01, eyeDeg, headDeg, nowSec, throttled,
  type AxisInvert, type SourceRuntime, type SourceStatus,
} from './common.ts';

export interface LiveLinkFaceConfig {
  enabled: boolean;
  /** Local UDP port the app streams to (Live Link Face default 11111). */
  port: number;
  bind: string;
  /** Optional: only accept packets from this phone ('' = any sender). */
  phoneIp: string;
  invert: AxisInvert;
}

export const LLF_DEFAULTS: LiveLinkFaceConfig = {
  enabled: false, port: 11111, bind: '0.0.0.0', phoneIp: '',
  invert: { yaw: false, pitch: false, roll: false },
};

/** UE EARFaceBlendShape order (indices 0..60). */
export const LLF_CHANNELS = [
  'EyeBlinkLeft', 'EyeLookDownLeft', 'EyeLookInLeft', 'EyeLookOutLeft', 'EyeLookUpLeft', 'EyeSquintLeft', 'EyeWideLeft',
  'EyeBlinkRight', 'EyeLookDownRight', 'EyeLookInRight', 'EyeLookOutRight', 'EyeLookUpRight', 'EyeSquintRight', 'EyeWideRight',
  'JawForward', 'JawLeft', 'JawRight', 'JawOpen',
  'MouthClose', 'MouthFunnel', 'MouthPucker', 'MouthLeft', 'MouthRight', 'MouthSmileLeft', 'MouthSmileRight',
  'MouthFrownLeft', 'MouthFrownRight', 'MouthDimpleLeft', 'MouthDimpleRight', 'MouthStretchLeft', 'MouthStretchRight',
  'MouthRollLower', 'MouthRollUpper', 'MouthShrugLower', 'MouthShrugUpper', 'MouthPressLeft', 'MouthPressRight',
  'MouthLowerDownLeft', 'MouthLowerDownRight', 'MouthUpperUpLeft', 'MouthUpperUpRight',
  'BrowDownLeft', 'BrowDownRight', 'BrowInnerUp', 'BrowOuterUpLeft', 'BrowOuterUpRight',
  'CheekPuff', 'CheekSquintLeft', 'CheekSquintRight', 'NoseSneerLeft', 'NoseSneerRight', 'TongueOut',
  'HeadYaw', 'HeadPitch', 'HeadRoll', 'LeftEyeYaw', 'LeftEyePitch', 'LeftEyeRoll', 'RightEyeYaw', 'RightEyePitch', 'RightEyeRoll',
] as const;
const ARKIT_OF = LLF_CHANNELS.slice(0, 52).map((n) => arkitName(n));
const HEAD = 52;

/** Real packets are ~320 bytes; strings are a UUID and a phone name. */
export const LLF_MAX_PACKET = 2048;
const MAX_STR = 256;
const R2D = 180 / Math.PI;
/** |angle| above this (radians) is not a head/eye pose → packet rejected. */
const MAX_RAD = 2 * Math.PI;

export interface LiveLinkFacePacket {
  data: ExternalTracking;
  version: number;
  deviceId: string;
  subject: string;
  frame: number;
  fps: number;
}

/** Printable, bounded label for the status endpoint (never trusted for anything else). */
const label = (b: Buffer) => b.toString('utf8').replace(/[^\x20-\x7e -￿]/g, '').slice(0, 64);

/**
 * Parse one Live Link Face datagram. Returns null for anything malformed (wrong lengths, trailing bytes,
 * > 61 values, non-finite floats). A header-only packet (no blendshape block) is a valid "no face" packet.
 */
export function parseLiveLinkFace(buf: Buffer): LiveLinkFacePacket | null {
  if (!Buffer.isBuffer(buf) || buf.length < 25 || buf.length > LLF_MAX_PACKET) return null;
  let o = 0;
  const version = buf.readUInt8(o); o += 1;
  if (version === 0) return null;
  const str = () => {
    if (o + 4 > buf.length) return null;
    const n = buf.readInt32BE(o); o += 4;
    if (n < 0 || n > MAX_STR || o + n > buf.length) return null;
    const s = buf.subarray(o, o + n); o += n;
    return s;
  };
  const dev = str(); if (!dev) return null;
  const sub = str(); if (!sub) return null;
  if (o + 16 > buf.length) return null;
  const frame = buf.readInt32BE(o), fpsNum = buf.readInt32BE(o + 8), fpsDen = buf.readInt32BE(o + 12);
  o += 16;
  const fps = fpsDen > 0 && fpsNum > 0 ? fpsNum / fpsDen : 0;
  const d: ExternalTracking = { source: 'livelinkface', t: nowSec(), found: false };
  const pkt: LiveLinkFacePacket = { data: d, version, deviceId: label(dev), subject: label(sub), frame, fps };
  if (o === buf.length) return pkt;                 // header only: no face this frame
  const count = buf.readUInt8(o); o += 1;
  if (count === 0 || count > LLF_CHANNELS.length || buf.length - o !== count * 4) return null;
  const v = new Array<number>(count);
  let nonZero = false;
  for (let i = 0; i < count; i++, o += 4) {
    const x = buf.readFloatBE(o);
    if (!Number.isFinite(x)) return null;
    if (i >= HEAD && Math.abs(x) > MAX_RAD) return null;
    if (x !== 0) nonZero = true;
    v[i] = x;
  }
  const bs: Record<string, number> = {};
  for (let i = 0; i < Math.min(count, HEAD); i++) { const k = ARKIT_OF[i]; if (k) bs[k] = clamp01(v[i]); }
  d.blendshapes = bs;
  if (count >= HEAD + 3) d.head = headDeg(-v[HEAD + 1] * R2D, v[HEAD] * R2D, -v[HEAD + 2] * R2D);
  if (count >= HEAD + 5) d.eyeLeft = eyeDeg(v[HEAD + 4] * R2D, -v[HEAD + 3] * R2D);
  if (count >= HEAD + 8) d.eyeRight = eyeDeg(v[HEAD + 7] * R2D, -v[HEAD + 6] * R2D);
  // ARKit never reports an exact all-zero face; the app sends zeros while it has no face anchor
  d.found = nonZero;
  return pkt;
}

export class LiveLinkFaceSource implements SourceRuntime {
  private sock: dgram.Socket | null = null;
  private rate = new RateCounter();
  private lastError: string | null = null;
  private faceFound = false;
  private rejected = 0;
  private last: { subject: string; deviceId: string; version: number; fps: number; from: string } | null = null;
  /** With no phone IP set: the first phone that sends, held across silence (common.ts
   *  SenderLock; "That's not my phone" = forget(), "Use it" = switchPhone()). */
  private lock = new SenderLock();
  private publish: ReturnType<typeof throttled>;

  constructor(private cfg: LiveLinkFaceConfig, publish: (d: ExternalTracking) => void) {
    this.publish = throttled(publish, 60);
  }

  async start() {
    if (this.sock) return;
    const sock = dgram.createSocket({ type: 'udp4', reuseAddr: false });
    sock.on('error', (e) => { this.lastError = e.message; });
    sock.on('message', (msg, rinfo) => { try { this.onPacket(msg, rinfo); } catch { this.rejected++; } });
    await new Promise<void>((resolve, reject) => {
      sock.once('error', reject);
      sock.bind(this.cfg.port, this.cfg.bind, () => { sock.off('error', reject); resolve(); });
    }).catch((e: Error) => { this.lastError = `Can't listen on UDP ${this.cfg.bind}:${this.cfg.port} — ${e.message}`; try { sock.close(); } catch { /* */ } throw e; });
    this.sock = sock;
    this.lastError = null;
  }

  private onPacket(msg: Buffer, rinfo: dgram.RemoteInfo) {
    const from = bareIp(rinfo.address);
    if (!this.lock.allows(from, this.cfg.phoneIp)) return;
    const p = parseLiveLinkFace(msg);
    if (!p) {
      this.rejected++;
      this.lastError = `Malformed Live Link Face packet (${msg.length} bytes) from ${bareIp(rinfo.address)}`;
      return;
    }
    this.lastError = null;
    this.lock.accept(from, this.cfg.phoneIp);
    this.rate.hit();
    this.faceFound = p.data.found;
    this.last = { subject: p.subject, deviceId: p.deviceId, version: p.version, fps: p.fps, from: bareIp(rinfo.address) };
    this.publish(applyInvert(p.data, this.cfg.invert));
  }

  forget() { this.lock.forget(); this.last = null; this.faceFound = false; this.rate.reset(); }
  /** "Use it": the device that was knocking takes over (SenderLock.take). */
  switchPhone(): boolean { const c = this.lock.take(); if (c) { this.last = null; this.faceFound = false; this.rate.reset(); } return !!c; }

  async stop() {
    this.publish.cancel();
    const s = this.sock;
    this.sock = null;
    if (s) await new Promise<void>((r) => { try { s.close(() => r()); } catch { r(); } });
  }

  status(): SourceStatus {
    const fresh = this.rate.lastSeen !== null && Date.now() - this.rate.lastSeen < 1000;
    return {
      kind: 'livelinkface', enabled: this.cfg.enabled, running: !!this.sock, bind: this.cfg.bind, port: this.cfg.port,
      phoneIp: this.cfg.phoneIp, packetsPerSec: this.rate.perSec(), packetsTotal: this.rate.total, lastSeen: this.rate.lastSeen,
      faceFound: fresh && this.faceFound, lastError: this.lastError,
      info: { rejected: this.rejected, ...(this.last ?? {}), phone: this.cfg.phoneIp || this.lock.current(), candidate: this.lock.candidate(), name: this.last?.subject ?? null },
    };
  }
}
