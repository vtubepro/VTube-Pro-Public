// Party (multiplayer) wire formats shared by the studio, the OBS page and the Node tests.
//
//  * Binary tracking frames ('F', ~0.6–0.9 kB instead of ~2–3 kB of JSON) so one frame fits one network packet on
//    the unreliable realtime channel: a lost packet costs one frame, never a head-of-line stall.
//  * Binary voice packets ('V', ≤ 61 bytes, ~50 Hz): voice-derived mouth samples (VAD, level, jaw open, lip
//    closure, top-3 visemes). Each packet repeats the previous samples (redundancy), so a lost packet costs nothing.
//  * Host → guest relays prefix the packet with the owner's party id ('R').
//  * GLB checks + the guest-profile sanitiser (receivers run them before anything is sealed or parsed).
// Numbers are quantised, clamped and bounded on decode; strings are never used as paths or code.
import type { AvatarProfile, TrackingFrame, VoiceSample } from './types.ts';
import { normalizeProfile } from './defaults.ts';
import { sanitizeSize } from './avatarSize.ts';
import { sanitizeNeck } from './neck.ts';
import { sanitizeMech } from './mech.ts';
import { isStoredBody } from './bodyKind.ts';

export const ARKIT = [
  'eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
  'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
  'jawForward', 'jawLeft', 'jawRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
  'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight',
  'mouthStretchLeft', 'mouthStretchRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
  'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
  'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
  'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut',
] as const;
/** Same order as src/tracking/visemes.ts VISEMES. */
export const VISEME_IDS = ['sil', 'PP', 'FF', 'TH', 'DD', 'kk', 'CH', 'SS', 'nn', 'RR', 'L', 'W', 'aa', 'E', 'I', 'O', 'U'] as const;
export const BONES = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal', 'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
  'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal', 'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
  'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
  'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal', 'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
  'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal', 'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
  'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal',
] as const;
const MOUTH = ['open', 'wide', 'smile', 'frown', 'pucker', 'funnel', 'tongue', 'fv', 'sib', 'speak', 'closure'] as const;

const FACE_IX = new Map<string, number>(ARKIT.map((k, i) => [k, i]));
const BONE_IX = new Map<string, number>(BONES.map((k, i) => [k, i]));
const VIS_IX = new Map<string, number>(VISEME_IDS.map((k, i) => [k, i]));
const KEY = /^[A-Za-z0-9_]{1,48}$/;

export const PKT_FRAME = 0x46; // 'F'
export const PKT_VOICE = 0x56; // 'V'
export const PKT_RELAY = 0x52; // 'R'

// ---------------------------------------------------------------- tiny byte writer / reader
class Writer {
  private buf = new ArrayBuffer(1024);
  private dv = new DataView(this.buf);
  off = 0;
  private need(n: number) {
    if (this.off + n <= this.buf.byteLength) return;
    const nb = new ArrayBuffer(Math.max(this.buf.byteLength * 2, this.off + n));
    new Uint8Array(nb).set(new Uint8Array(this.buf, 0, this.off));
    this.buf = nb; this.dv = new DataView(nb);
  }
  u8(v: number) { this.need(1); this.dv.setUint8(this.off, v & 255); this.off += 1; }
  u16(v: number) { this.need(2); this.dv.setUint16(this.off, v & 0xffff, true); this.off += 2; }
  u32(v: number) { this.need(4); this.dv.setUint32(this.off, v >>> 0, true); this.off += 4; }
  i16(v: number) { this.need(2); this.dv.setInt16(this.off, Math.max(-32767, Math.min(32767, Math.round(Number.isFinite(v) ? v : 0))), true); this.off += 2; }
  bytes(b: Uint8Array) { this.need(b.length); new Uint8Array(this.buf, this.off, b.length).set(b); this.off += b.length; }
  done(): Uint8Array { return new Uint8Array(this.buf.slice(0, this.off)); }
}
class Reader {
  private dv: DataView;
  off = 0;
  constructor(private b: Uint8Array) { this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength); }
  private has(n: number) { if (this.off + n > this.b.byteLength) throw new Error('short packet'); }
  u8() { this.has(1); return this.dv.getUint8(this.off++); }
  u16() { this.has(2); const v = this.dv.getUint16(this.off, true); this.off += 2; return v; }
  u32() { this.has(4); const v = this.dv.getUint32(this.off, true); this.off += 4; return v; }
  i16() { this.has(2); const v = this.dv.getInt16(this.off, true); this.off += 2; return v; }
  bytes(n: number) { this.has(n); const v = this.b.subarray(this.off, this.off + n); this.off += n; return v; }
  get left() { return this.b.byteLength - this.off; }
}
const enc = new TextEncoder(), dec = new TextDecoder();
const clamp = (v: number, lo: number, hi: number) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
function key(w: Writer, ix: Map<string, number>, k: string) {
  const i = ix.get(k);
  if (i !== undefined) { w.u8(i); return; }
  const b = enc.encode(k.slice(0, 48)); w.u8(255); w.u8(b.length); w.bytes(b);
}
function readKey(r: Reader, names: readonly string[]): string | null {
  const i = r.u8();
  if (i !== 255) return names[i] ?? null;
  const k = dec.decode(r.bytes(r.u8()));
  return KEY.test(k) ? k : null;
}

// ---------------------------------------------------------------- frames
const S_UNIT = 16000;   // face / mouth / gaze / lips (±2)
const S_HEAD = 8000;    // head rotation radians (±4)
const S_POS = 6000;     // head position (±5)
const S_Q = 32767;      // quaternion components
const F_TRACKED = 1, F_LIPS = 2, F_VIS = 4, F_BONES = 8, F_SNACK = 16;

/** Pack a (sanitised) tracking frame. `sent` = sender clock ms (performance.now()). */
export function encodeFrame(f: TrackingFrame, seq: number, sent: number): Uint8Array {
  const w = new Writer();
  w.u8(PKT_FRAME); w.u8(1); w.u16(seq); w.u32(Math.round(sent));
  const bones = f.bones ? Object.entries(f.bones).slice(0, 80) : [];
  const vis = f.visemes ? Object.entries(f.visemes).filter(([k, v]) => VIS_IX.has(k) && v > 0.004).slice(0, 17) : [];
  const snack = f.snack ? enc.encode(JSON.stringify(f.snack)).slice(0, 2048) : null;
  w.u8((f.tracked ? F_TRACKED : 0) | (f.lips ? F_LIPS : 0) | (vis.length ? F_VIS : 0) | (bones.length ? F_BONES : 0) | (snack ? F_SNACK : 0));
  for (let i = 0; i < 3; i++) w.i16(clamp(f.head?.[i] ?? 0, -4, 4) * S_HEAD);
  for (let i = 0; i < 3; i++) w.i16(clamp(f.headPos?.[i] ?? 0, -5, 5) * S_POS);
  for (let i = 0; i < 2; i++) w.i16(clamp(f.gaze?.[i] ?? 0, -2, 2) * S_UNIT);
  const m = (f.mouth ?? {}) as unknown as Record<string, number | undefined>;
  let mask = 0;
  MOUTH.forEach((k, i) => { if (typeof m[k] === 'number') mask |= 1 << i; });
  w.u16(mask);
  MOUTH.forEach((k, i) => { if (mask & (1 << i)) w.i16(clamp(m[k]!, -2, 2) * S_UNIT); });
  const face = Object.entries(f.face ?? {}).filter(([k, v]) => KEY.test(k) && Math.abs(v) >= 1 / S_UNIT).slice(0, 160);
  w.u8(face.length);
  for (const [k, v] of face) { key(w, FACE_IX, k); w.i16(clamp(v, -2, 2) * S_UNIT); }
  if (vis.length) { w.u8(vis.length); for (const [k, v] of vis) { w.u8(VIS_IX.get(k)!); w.u8(Math.round(clamp(v, 0, 1) * 255)); } }
  if (f.lips) for (const arr of [f.lips.u, f.lips.l]) for (let i = 0; i < 7; i++) w.i16(clamp(arr[i] ?? 0, -2, 2) * S_UNIT);
  if (bones.length) {
    w.u8(bones.length);
    for (const [k, q] of bones) { key(w, BONE_IX, k); for (let i = 0; i < 4; i++) w.i16(clamp(q[i] ?? 0, -1, 1) * S_Q); }
  }
  if (snack) { w.u16(snack.length); w.bytes(snack); }
  return w.done();
}

export interface DecodedFrame { seq: number; sent: number; frame: TrackingFrame; snackJson?: unknown }
/** Unpack a frame packet (throws on malformed input). The result still goes through the party sanitiser. */
export function decodeFrame(b: Uint8Array): DecodedFrame {
  const r = new Reader(b);
  if (r.u8() !== PKT_FRAME || r.u8() !== 1) throw new Error('not a frame');
  const seq = r.u16(), sent = r.u32(), flags = r.u8();
  const head = [r.i16() / S_HEAD, r.i16() / S_HEAD, r.i16() / S_HEAD] as TrackingFrame['head'];
  const headPos = [r.i16() / S_POS, r.i16() / S_POS, r.i16() / S_POS] as TrackingFrame['headPos'];
  const gaze = [r.i16() / S_UNIT, r.i16() / S_UNIT] as TrackingFrame['gaze'];
  const mask = r.u16();
  const mouth: Record<string, number> = { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 };
  MOUTH.forEach((k, i) => { if (mask & (1 << i)) mouth[k] = r.i16() / S_UNIT; });
  const face: Record<string, number> = {};
  for (let n = r.u8(); n > 0; n--) { const k = readKey(r, ARKIT); const v = r.i16() / S_UNIT; if (k) face[k] = v; }
  let visemes: Record<string, number> | undefined;
  if (flags & F_VIS) { visemes = {}; for (let n = r.u8(); n > 0; n--) { const k = VISEME_IDS[r.u8()]; const v = r.u8() / 255; if (k) visemes[k] = v; } }
  let lips: TrackingFrame['lips'];
  if (flags & F_LIPS) { const u: number[] = [], l: number[] = []; for (let i = 0; i < 7; i++) u.push(r.i16() / S_UNIT); for (let i = 0; i < 7; i++) l.push(r.i16() / S_UNIT); lips = { u, l }; }
  let bones: Record<string, [number, number, number, number]> | undefined;
  if (flags & F_BONES) {
    bones = {};
    for (let n = r.u8(); n > 0; n--) { const k = readKey(r, BONES); const q: [number, number, number, number] = [r.i16() / S_Q, r.i16() / S_Q, r.i16() / S_Q, r.i16() / S_Q]; if (k) bones[k] = q; }
  }
  let snackJson: unknown;
  if (flags & F_SNACK) { try { snackJson = JSON.parse(dec.decode(r.bytes(r.u16()))); } catch { snackJson = undefined; } }
  const frame: TrackingFrame = { t: sent / 1000, face, head, headPos, gaze, mouth: mouth as unknown as TrackingFrame['mouth'], tracked: !!(flags & F_TRACKED), visemes, lips, bones };
  return { seq, sent, frame, snackJson };
}

// ---------------------------------------------------------------- voice samples
/** Top-3 visemes of a weight map as [index, weight] pairs (weights renormalised). */
export function topVisemes(v: Record<string, number> | undefined | null): [number, number][] {
  if (!v) return [];
  const all = Object.entries(v).filter(([k, x]) => VIS_IX.has(k) && x > 0.01).sort((a, b) => b[1] - a[1]).slice(0, 3);
  const sum = all.reduce((s, [, x]) => s + x, 0) || 1;
  return all.map(([k, x]) => [VIS_IX.get(k)!, Math.min(1, x / sum)]);
}
export function visemeMap(vis: [number, number][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [i, w] of vis) { const k = VISEME_IDS[i]; if (k) out[k] = (out[k] ?? 0) + w; }
  return out;
}

/** Pack up to 4 voice samples (newest last). `sent` = the newest sample's t. */
export function encodeVoice(samples: VoiceSample[], seq: number): Uint8Array {
  const s = samples.slice(-4);
  const w = new Writer();
  const sent = s.length ? s[s.length - 1].t : 0;
  w.u8(PKT_VOICE); w.u8(1); w.u16(seq); w.u32(Math.round(sent)); w.u8(s.length);
  for (const x of s) {
    w.i16(Math.max(-32000, Math.min(0, Math.round(x.t - sent))));
    w.u8(Math.round(clamp(x.vad, 0, 1) * 255)); w.u8(Math.round(clamp(x.level, 0, 1) * 255));
    w.u8(Math.round(clamp(x.open, 0, 1) * 255)); w.u8(Math.round(clamp(x.closure, 0, 1) * 255));
    const vis = x.vis.slice(0, 3);
    w.u8(vis.length);
    for (const [i, v] of vis) { w.u8(i); w.u8(Math.round(clamp(v, 0, 1) * 255)); }
  }
  return w.done();
}
export interface DecodedVoice { seq: number; sent: number; samples: VoiceSample[] }
export function decodeVoice(b: Uint8Array): DecodedVoice {
  const r = new Reader(b);
  if (r.u8() !== PKT_VOICE || r.u8() !== 1) throw new Error('not a voice packet');
  const seq = r.u16(), sent = r.u32(), n = Math.min(4, r.u8());
  const samples: VoiceSample[] = [];
  for (let k = 0; k < n; k++) {
    const t = sent + r.i16();
    const vad = r.u8() / 255, level = r.u8() / 255, open = r.u8() / 255, closure = r.u8() / 255;
    const vis: [number, number][] = [];
    for (let m = Math.min(3, r.u8()); m > 0; m--) { const i = r.u8(), v = r.u8() / 255; if (i < VISEME_IDS.length) vis.push([i, v]); }
    samples.push({ t, vad, level, open, closure, vis });
  }
  return { seq, sent, samples };
}

/** Clean voice samples from an untrusted source (bus / JSON). */
export function sanitizeVoice(v: unknown): VoiceSample[] {
  if (!Array.isArray(v)) return [];
  return v.slice(0, 8).map((x) => {
    const o = (x ?? {}) as Record<string, unknown>;
    const n = (k: string) => clamp(Number(o[k]), 0, 1);
    const vis = (Array.isArray(o.vis) ? o.vis : []).slice(0, 3)
      .map((p) => (Array.isArray(p) ? [Math.round(clamp(Number(p[0]), 0, VISEME_IDS.length - 1)), clamp(Number(p[1]), 0, 1)] : [0, 0]) as [number, number]);
    return { t: clamp(Number(o.t), 0, 2 ** 32), vad: n('vad'), level: n('level'), open: n('open'), closure: n('closure'), vis };
  });
}

// ---------------------------------------------------------------- host relay prefix
export function wrapRelay(owner: string, inner: Uint8Array): Uint8Array {
  const id = enc.encode(owner.slice(0, 32));
  const out = new Uint8Array(2 + id.length + inner.length);
  out[0] = PKT_RELAY; out[1] = id.length; out.set(id, 2); out.set(inner, 2 + id.length);
  return out;
}
export function unwrapRelay(b: Uint8Array): { owner: string | null; inner: Uint8Array } {
  if (b[0] !== PKT_RELAY) return { owner: null, inner: b };
  const n = b[1] ?? 0;
  if (b.length < 2 + n + 1) throw new Error('short relay packet');
  return { owner: dec.decode(b.subarray(2, 2 + n)), inner: b.subarray(2 + n) };
}

// ---------------------------------------------------------------- GLB custody checks
/** Why a received model must be refused (null = fine): glTF 2.0 binary only, length exact, and NO external
 *  references (a hostile GLB could otherwise make every viewer fetch a URL: IP leak / tracking). */
export function glbProblem(b: Uint8Array): string | null {
  if (b.byteLength < 28) return 'empty model';
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67 || dv.getUint32(4, true) !== 2 || dv.getUint32(8, true) !== b.byteLength) return 'only GLB / VRM (glTF 2.0 binary) models are accepted';
  const jsonLen = dv.getUint32(12, true);
  if (dv.getUint32(16, true) !== 0x4e4f534a || 20 + jsonLen > b.byteLength || jsonLen > 16 << 20) return 'bad GLB JSON chunk';
  let json: Record<string, unknown>;
  try { json = JSON.parse(dec.decode(b.subarray(20, 20 + jsonLen))) as Record<string, unknown>; } catch { return 'bad GLB JSON'; }
  for (const k of ['buffers', 'images']) {
    const arr = json[k];
    if (!Array.isArray(arr)) continue;
    for (const x of arr) if (x && typeof x === 'object' && typeof (x as { uri?: unknown }).uri === 'string' && !String((x as { uri: string }).uri).startsWith('data:')) return 'the model references external files';
  }
  return null;
}

// ---------------------------------------------------------------- guest profile (what an OBS page may use)
const str = (v: unknown, max: number) => String(v ?? '').slice(0, max);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const COLOR = /^#[0-9a-fA-F]{3,8}$/;
const SURFACE_IDS = new Set(['none', 'felt', 'sock', 'fleece', 'plush', 'knit', 'crochet', 'clay', 'plastic', 'vinyl', 'rubber', 'porcelain',
  'paper', 'cardboard', 'metal_brushed', 'metal_painted', 'glass', 'crystal', 'slime', 'stone', 'scales_lizard', 'scales_dragon',
  'scales_snake', 'scales_fish', 'scutes', 'keratin', 'wet_skin', 'fur_short', 'fur_long']);
/** A costume's surface style: a known id, or {style, tweaks} where a tweak is a number, a colour or a short word. */
function sanitizeSurface(v: unknown): string | Record<string, unknown> | undefined {
  if (typeof v === 'string') return SURFACE_IDS.has(v) ? v : undefined;
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  if (typeof o.style !== 'string' || !SURFACE_IDS.has(o.style)) return undefined;
  const out: Record<string, unknown> = { style: o.style };
  for (const [k, x] of Object.entries(o).slice(0, 48)) {
    if (k === 'style' || !/^[a-zA-Z0-9]{1,24}$/.test(k)) continue;
    if (typeof x === 'number' && Number.isFinite(x)) out[k] = Math.min(100, Math.max(-100, x));
    else if (x === null) out[k] = null;
    else if (typeof x === 'string' && (COLOR.test(x) || /^[a-z0-9_]{1,16}$/.test(x))) out[k] = x;
  }
  return out;
}
/** A costume's anti-clip settings (CostumeDef.fit): clamped numbers and a few spheres only. */
function sanitizeFit(v: unknown) {
  if (!v || typeof v !== 'object') return undefined;
  const o = v as Record<string, unknown>;
  const out: { margin?: number; hideBody?: boolean; hideInside?: { center: [number, number, number]; radius: number; bone?: string }[] } = {};
  if (typeof o.margin === 'number' && Number.isFinite(o.margin)) out.margin = Math.min(0.05, Math.max(0, o.margin));
  if (typeof o.hideBody === 'boolean') out.hideBody = o.hideBody;
  const hs = (Array.isArray(o.hideInside) ? o.hideInside : []).slice(0, 8).flatMap((h) => {
    const x = (h ?? {}) as Record<string, unknown>;
    const c = Array.isArray(x.center) && x.center.length === 3 && x.center.every((n) => typeof n === 'number' && Number.isFinite(n)) ? (x.center as number[]).map((n) => Math.min(10, Math.max(-10, n))) as [number, number, number] : null;
    if (!c || typeof x.radius !== 'number' || !Number.isFinite(x.radius)) return [];
    const bone = typeof x.bone === 'string' && /^[A-Za-z0-9_.:-]{1,64}$/.test(x.bone) ? x.bone : undefined;
    return [{ center: c, radius: Math.min(2, Math.max(0.001, x.radius)), ...(bone ? { bone } : {}) }];
  });
  if (hs.length) out.hideInside = hs;
  return Object.keys(out).length ? out : undefined;
}
/** A costume a guest is wearing (outfit or accessory): only safe, known fields — the owner's fit, grip and surface
 *  included, so it looks on every OBS page as it does at home; its bytes come from the vault, never a path. */
export function sanitizeGuestCostume(c: unknown) {
  if (!c || typeof c !== 'object') return null;
  const o = c as Record<string, unknown>;
  const id = str(o.id, 40);
  if (!/^[A-Za-z0-9_-]{1,40}$/.test(id)) return null;
  const labels = (Array.isArray(o.labels) ? o.labels : []).slice(0, 12).map((l) => {
    const x = (l ?? {}) as Record<string, unknown>;
    return {
      material: str(x.material, 64), text: str(x.text, 200),
      color: COLOR.test(str(x.color, 9)) ? str(x.color, 9) : '#111111',
      background: COLOR.test(str(x.background, 9)) ? str(x.background, 9) : '#ffffff',
      font: str(x.font, 120).replace(/[<>{}]/g, ''), aspect: num(x.aspect, 0.05, 40, 4),
    };
  });
  const hides = (Array.isArray(o.hides) ? o.hides : []).slice(0, 64).map((h) => str(h, 64));
  const eyes = o.eyes && typeof o.eyes === 'object' ? Object.fromEntries(Object.entries(o.eyes as Record<string, unknown>)
    .filter(([k, v]) => /^[a-zA-Z]{1,24}$/.test(k) && (typeof v === 'number' || (typeof v === 'string' && COLOR.test(v))))) : undefined;
  const fit = sanitizeFit(o.fit), surface = sanitizeSurface(o.surface);
  const grip = o.grip === 'left' || o.grip === 'right' || o.grip === 'both' ? o.grip : undefined;
  return { id, name: str(o.name, 40) || id, file: 'sealed', hides, labels, eyes, ...(o.kind === 'accessory' ? { kind: 'accessory' as const } : {}),
    ...(fit ? { fit } : {}), ...(grip ? { grip } : {}), ...(surface ? { surface } : {}), source: 'import' as const };
}

/** Normalise a guest's shared profile: only known fields survive, the model is never a path of theirs. `withCostume`:
 *  their outfit (`costumeDef`) arrived; `withAccessories`: their accessories (`accessoryDefs`) arrived in a costume set.
 *  The sanitised defs are written back, so running it again (the OBS page does) gives the same profile. */
export function sanitizeGuestProfile(body: unknown, peer: string, withCostume: boolean, withAccessories = false): AvatarProfile {
  const b = (body && typeof body === 'object' ? body : {}) as Record<string, unknown>;
  const p = normalizeProfile({ ...b, costumes: [], costume: null, accessories: [], id: `party-${peer}`, modelFile: 'sealed', source: 'import' } as never);
  const c = withCostume ? sanitizeGuestCostume(b.costumeDef) : null;
  const seen = new Set(c ? [c.id] : []);
  const acc = (withAccessories && Array.isArray(b.accessoryDefs) ? b.accessoryDefs : []).slice(0, 15).flatMap((a) => {
    const d = sanitizeGuestCostume(a);
    if (!d || seen.has(d.id)) return [];
    seen.add(d.id);
    const { kind: _kind, ...rest } = d;                                    // (kind always last: a second pass is identical)
    return [{ ...rest, kind: 'accessory' as const }];
  });
  p.costumes = [...(c ? [c] : []), ...acc] as never;
  p.costume = c ? c.id : null;
  p.accessories = acc.map((a) => a.id);
  Object.assign(p, { costumeDef: c, accessoryDefs: acc });
  p.name = str(b.name ?? p.name ?? 'Guest', 40);
  delete (p as { prompt?: string }).prompt;
  delete (p as { thumbnail?: string }).thumbnail;
  delete (p as { modelStats?: unknown }).modelStats;
  // real size (size class → spot + height in the room): only a clean number survives
  const size = sanitizeSize(b.size);
  if (size) p.size = size; else delete (p as { size?: unknown }).size;
  // neck length / head motion (long necks): only clamped numbers survive
  const neck = sanitizeNeck(b.neck);
  if (neck) p.neck = neck; else delete (p as { neck?: unknown }).neck;
  if (isStoredBody(b.body)) p.body = b.body; else delete (p as { body?: unknown }).body;
  // walking machine settings (shared/mech.ts): config only, never model data
  const mech = sanitizeMech(b.mech);
  if (mech) p.mech = mech; else delete (p as { mech?: unknown }).mech;
  return p;
}
