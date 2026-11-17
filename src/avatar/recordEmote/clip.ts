// "Record my own emote" (beta.16, lane recemote): the clip format and the editing maths. PURE: no DOM, no three.js, no
// Node-only calls, so the studio, the OBS page, the helper's route (server/routes/userEmotes.ts) and the unit test all
// use the very same code.
//
// A take is what the recorder sees: one rotation per humanoid bone per frame, at a fixed rate, in the T-pose-based space
// that VRMA clips and src/avatar/emotes.ts EmoteLayer play (so the clip works on any humanoid avatar, not only the one it
// was recorded on). A saved clip is that take with every bone packed as 16-bit numbers in base64 (a 10 s take of a wave is
// about 60 KB). The clip never contains the camera picture, the face or the voice: only bone angles.
//
//   { vtpemote: 1, name, fps, frames, loop, bones: { rightUpperArm: "<base64 int16 x,y,z,w per frame>", ... }, createdAt }
//
// Quaternions are [x, y, z, w] (three.js order).

export const CLIP_VERSION = 1;
export const CLIP_MAX_SECS = 30;
export const CLIP_MAX_FPS = 30;
export const CLIP_MIN_FPS = 5;
export const CLIP_MIN_FRAMES = 3;
export const CLIP_MAX_FRAMES = CLIP_MAX_SECS * CLIP_MAX_FPS + 1;
export const CLIP_NAME_MAX = 40;
/** Largest clip file the helper keeps: 900 frames x 55 bones x 8 bytes = 400 KB packed, 540 KB as base64. */
export const CLIP_MAX_BYTES = 1_200_000;

/** Every bone name a clip may hold (VRM 1.0 humanoid names; the same ones EmoteLayer plays). */
export const HUMAN_BONES: readonly string[] = [
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'head', 'leftEye', 'rightEye', 'jaw',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes',
  'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightShoulder', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal', 'leftIndexProximal', 'leftIndexIntermediate', 'leftIndexDistal',
  'leftMiddleProximal', 'leftMiddleIntermediate', 'leftMiddleDistal', 'leftRingProximal', 'leftRingIntermediate', 'leftRingDistal',
  'leftLittleProximal', 'leftLittleIntermediate', 'leftLittleDistal',
  'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal', 'rightIndexProximal', 'rightIndexIntermediate', 'rightIndexDistal',
  'rightMiddleProximal', 'rightMiddleIntermediate', 'rightMiddleDistal', 'rightRingProximal', 'rightRingIntermediate', 'rightRingDistal',
  'rightLittleProximal', 'rightLittleIntermediate', 'rightLittleDistal',
];
const BONE_SET = new Set(HUMAN_BONES);
/** Hips and legs: a webcam does not see them, and a room's seat pose owns them. Left out unless the user asks. */
export const LEG_BONES: ReadonlySet<string> = new Set(['hips', 'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'leftToes', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot', 'rightToes']);
/** Eyes and jaw stay live (gaze, blinks, lip sync): never recorded. */
export const FACE_BONES: ReadonlySet<string> = new Set(['leftEye', 'rightEye', 'jaw']);

export interface Take {
  fps: number;
  frames: number;
  /** bone -> frames x 4 floats [x, y, z, w] */
  bones: Record<string, Float32Array>;
}
export interface EmoteClip {
  vtpemote: typeof CLIP_VERSION;
  name: string;
  fps: number;
  frames: number;
  loop: boolean;
  bones: Record<string, string>;
  createdAt: number;
}

export const takeSeconds = (t: Pick<Take, 'fps' | 'frames'>) => Math.max(0, (t.frames - 1) / t.fps);

// ------------------------------------------------------------------------------------------------ names

/** A name as shown in lists: trimmed, one line, no control characters, at most CLIP_NAME_MAX letters. */
export function cleanEmoteName(s: unknown, fallback = 'My emote'): string {
  const t = (typeof s === 'string' ? s : '').replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, CLIP_NAME_MAX).trim();
  return t || fallback;
}
/** The file / animation id for a name: a-z, 0-9 and dashes, unique among `taken`. */
export function emoteIdFor(name: string, taken: Iterable<string> = []): string {
  const base = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/g, '') || 'emote';
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let i = 2; i < 10_000; i++) { const id = `${base}-${i}`; if (!used.has(id)) return id; }
  return `${base}-${Date.now().toString(36)}`;
}
export const EMOTE_ID = /^[a-z0-9][a-z0-9-]{0,47}$/;
/** The name a recorded emote has in a frame's `emote.name` (src/avatar/emotes.ts looks clips up by it). */
export const RECORDED_PREFIX = 'rec:';
/** Names starting `rec:_` are studio-only previews: OBS pages never fetch them. */
export const PREVIEW_ID = '_preview';
export const recordedName = (id: string) => `${RECORDED_PREFIX}${id}`;
export const recordedId = (animName: string): string | null => animName.startsWith(RECORDED_PREFIX) ? animName.slice(RECORDED_PREFIX.length) : null;

// ------------------------------------------------------------------------------------------------ packing

function b64encode(bytes: Uint8Array): string {
  const B = (globalThis as { Buffer?: { from(b: Uint8Array): { toString(enc: string): string } } }).Buffer;
  if (B) return B.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function b64decode(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.length % 4 !== 0) return null;
  const B = (globalThis as { Buffer?: { from(s: string, enc: string): Uint8Array } }).Buffer;
  if (B) { const b = B.from(s, 'base64'); return new Uint8Array(b.buffer, b.byteOffset, b.byteLength); }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Quaternions (unit, so every part is within -1..1) to 16-bit numbers, little-endian, as base64. Error is under 4e-5 per part. */
export function packQuats(q: Float32Array): string {
  const out = new Uint8Array(q.length * 2);
  const dv = new DataView(out.buffer);
  for (let i = 0; i < q.length; i++) dv.setInt16(i * 2, Math.round(Math.max(-1, Math.min(1, q[i])) * 32767), true);
  return b64encode(out);
}
export function unpackQuats(s: string, frames: number): Float32Array | null {
  const bytes = b64decode(s);
  if (!bytes || bytes.length !== frames * 8) return null;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Float32Array(frames * 4);
  for (let f = 0; f < frames; f++) {
    let l = 0;
    for (let k = 0; k < 4; k++) { const v = dv.getInt16((f * 4 + k) * 2, true) / 32767; out[f * 4 + k] = v; l += v * v; }
    if (!(l > 0.5 && l < 1.5)) return null;   // not a rotation
    const n = 1 / Math.sqrt(l);
    for (let k = 0; k < 4; k++) out[f * 4 + k] *= n;
  }
  return out;
}

export function encodeClip(take: Take, name: string, loop: boolean, createdAt = Date.now()): EmoteClip {
  const bones: Record<string, string> = {};
  for (const b of Object.keys(take.bones).sort()) if (BONE_SET.has(b)) bones[b] = packQuats(take.bones[b]);
  return { vtpemote: CLIP_VERSION, name: cleanEmoteName(name), fps: take.fps, frames: take.frames, loop, bones, createdAt };
}

/** Check a clip from disk / the network: the right shape, sane sizes, real rotations. Null = refuse it (never partly accept). */
export function sanitizeClip(o: unknown): EmoteClip | null {
  if (!o || typeof o !== 'object') return null;
  const c = o as Record<string, unknown>;
  if (c.vtpemote !== CLIP_VERSION) return null;
  const fps = Number(c.fps), frames = Number(c.frames);
  if (!Number.isFinite(fps) || fps < CLIP_MIN_FPS || fps > CLIP_MAX_FPS) return null;
  if (!Number.isInteger(frames) || frames < CLIP_MIN_FRAMES || frames > CLIP_MAX_FRAMES) return null;
  if (!c.bones || typeof c.bones !== 'object' || Array.isArray(c.bones)) return null;
  const bones: Record<string, string> = {};
  let n = 0;
  for (const [b, v] of Object.entries(c.bones as Record<string, unknown>)) {
    if (!BONE_SET.has(b) || typeof v !== 'string' || !unpackQuats(v, frames)) return null;
    bones[b] = v; n++;
  }
  if (n < 1) return null;
  return {
    vtpemote: CLIP_VERSION, name: cleanEmoteName(c.name), fps: Math.round(fps * 1000) / 1000, frames, loop: c.loop === true, bones,
    createdAt: Number.isFinite(Number(c.createdAt)) ? Math.max(0, Math.floor(Number(c.createdAt))) : 0,
  };
}
export function decodeClip(c: EmoteClip): Take | null {
  const bones: Record<string, Float32Array> = {};
  for (const [b, v] of Object.entries(c.bones)) { const q = unpackQuats(v, c.frames); if (!q) return null; bones[b] = q; }
  return { fps: c.fps, frames: c.frames, bones };
}

// ------------------------------------------------------------------------------------------------ quaternion helpers (flat arrays)

function qdot(a: Float32Array, i: number, b: Float32Array, j: number) { return a[i] * b[j] + a[i + 1] * b[j + 1] + a[i + 2] * b[j + 2] + a[i + 3] * b[j + 3]; }
/** Angle in degrees between two stored rotations (atan2 form: exact for tiny angles, where acos loses all its digits). */
export function qAngleDeg(a: Float32Array, i: number, b: Float32Array, j: number): number {
  const w = a[i] * b[j] + a[i + 1] * b[j + 1] + a[i + 2] * b[j + 2] + a[i + 3] * b[j + 3];
  const x = a[i + 3] * b[j] - a[i] * b[j + 3] - a[i + 1] * b[j + 2] + a[i + 2] * b[j + 1];
  const y = a[i + 3] * b[j + 1] + a[i] * b[j + 2] - a[i + 1] * b[j + 3] - a[i + 2] * b[j];
  const z = a[i + 3] * b[j + 2] - a[i] * b[j + 1] + a[i + 1] * b[j] - a[i + 2] * b[j + 3];
  return (2 * Math.atan2(Math.hypot(x, y, z), Math.abs(w)) * 180) / Math.PI;
}
function qslerpInto(out: Float32Array, o: number, a: Float32Array, i: number, b: Float32Array, j: number, t: number) {
  let d = qdot(a, i, b, j);
  const s = d < 0 ? -1 : 1;
  d *= s;
  let ka: number, kb: number;
  if (d > 0.9995) { ka = 1 - t; kb = t * s; }
  else { const th = Math.acos(Math.min(1, d)), sn = Math.sin(th); ka = Math.sin((1 - t) * th) / sn; kb = (Math.sin(t * th) / sn) * s; }
  const x = a[i] * ka + b[j] * kb, y = a[i + 1] * ka + b[j + 1] * kb, z = a[i + 2] * ka + b[j + 2] * kb, w = a[i + 3] * ka + b[j + 3] * kb;
  const l = 1 / (Math.hypot(x, y, z, w) || 1);
  out[o] = x * l; out[o + 1] = y * l; out[o + 2] = z * l; out[o + 3] = w * l;
}

// ------------------------------------------------------------------------------------------------ edits

export interface EditOptions {
  /** first / last frame kept (inclusive) */
  start: number;
  end: number;
  /** 0 = as recorded, 1 = very soft (about +-0.3 s) */
  smooth: number;
  /** drop bones that hardly moved: they keep following live tracking while the emote plays */
  keepMoved: boolean;
  /** make the end flow into the start so the clip repeats without a jump */
  loop: boolean;
  /** keep hips and legs */
  legs: boolean;
}
export const DEFAULT_EDIT: EditOptions = { start: 0, end: Number.MAX_SAFE_INTEGER, smooth: 0.25, keepMoved: true, loop: false, legs: false };
/** A bone counts as "moved" when it swings further than this (degrees) from its own average direction. */
export const MOVED_DEG = 6;

export function cloneTake(t: Take): Take {
  const bones: Record<string, Float32Array> = {};
  for (const [b, q] of Object.entries(t.bones)) bones[b] = q.slice();
  return { fps: t.fps, frames: t.frames, bones };
}

export function trimTake(t: Take, start: number, end: number): Take {
  const a = Math.max(0, Math.min(t.frames - 1, Math.floor(start)));
  const z = Math.max(a, Math.min(t.frames - 1, Math.floor(end)));
  const n = z - a + 1;
  const bones: Record<string, Float32Array> = {};
  for (const [b, q] of Object.entries(t.bones)) bones[b] = q.slice(a * 4, (z + 1) * 4);
  return { fps: t.fps, frames: n, bones };
}

/** Soften jitter: each frame becomes a weighted blend of its neighbours (a bell curve, wider as `amount` grows). */
export function smoothTake(t: Take, amount: number): Take {
  const a = Math.max(0, Math.min(1, amount));
  const radius = Math.round(a * 0.3 * t.fps);   // 0.3 s at full
  if (radius < 1 || t.frames < 3) return cloneTake(t);
  const sigma = Math.max(0.6, radius / 2);
  const w: number[] = [];
  for (let k = -radius; k <= radius; k++) w.push(Math.exp(-(k * k) / (2 * sigma * sigma)));
  const bones: Record<string, Float32Array> = {};
  for (const [b, q] of Object.entries(t.bones)) {
    const out = new Float32Array(q.length);
    for (let f = 0; f < t.frames; f++) {
      let x = 0, y = 0, z = 0, ww = 0;
      for (let k = -radius; k <= radius; k++) {
        const g = Math.max(0, Math.min(t.frames - 1, f + k)), i = g * 4, kk = w[k + radius];
        const s = qdot(q, f * 4, q, i) < 0 ? -1 : 1;           // same side of the sphere as the centre frame
        x += q[i] * s * kk; y += q[i + 1] * s * kk; z += q[i + 2] * s * kk; ww += q[i + 3] * s * kk;
      }
      const l = 1 / (Math.hypot(x, y, z, ww) || 1);
      out[f * 4] = x * l; out[f * 4 + 1] = y * l; out[f * 4 + 2] = z * l; out[f * 4 + 3] = ww * l;
    }
    bones[b] = out;
  }
  return { fps: t.fps, frames: t.frames, bones };
}

/** The bones EmoteLayer always drives while an emote plays, even when the clip has no track for them (it then pulls them to
 *  the rest pose). A still one of these is held steady at its recorded pose instead of being left out. */
export const DRIVEN_BONES: ReadonlySet<string> = new Set([
  'hips', 'spine', 'chest', 'upperChest', 'neck', 'leftShoulder', 'leftUpperArm', 'leftLowerArm', 'rightShoulder', 'rightUpperArm', 'rightLowerArm',
  'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg',
]);

/** The average direction of a bone over the take (a unit quaternion). */
export function meanQuat(q: Float32Array): [number, number, number, number] {
  const n = q.length / 4;
  let x = 0, y = 0, z = 0, w = 0;
  for (let f = 0; f < n; f++) {
    const s = qdot(q, f * 4, q, 0) < 0 ? -1 : 1;
    x += q[f * 4] * s; y += q[f * 4 + 1] * s; z += q[f * 4 + 2] * s; w += q[f * 4 + 3] * s;
  }
  const l = 1 / (Math.hypot(x, y, z, w) || 1);
  return [x * l, y * l, z * l, w * l];
}

/** The largest swing (degrees) of a bone away from its own average direction over the take. */
export function boneTravelDeg(q: Float32Array): number {
  const n = q.length / 4;
  if (n < 2) return 0;
  const m = Float32Array.from(meanQuat(q));
  let max = 0;
  for (let f = 0; f < n; f++) max = Math.max(max, qAngleDeg(q, f * 4, m, 0));
  return max;
}

/** "Keep only what moved": a bone that swings less than `minDeg` is left out (it keeps following live tracking while the
 *  emote plays), except the DRIVEN_BONES (arms, torso, neck), which are held still at their average pose. If nothing moved
 *  at all the take is returned whole (never an empty clip). */
export function keepMovedBones(t: Take, minDeg = MOVED_DEG): Take {
  const bones: Record<string, Float32Array> = {};
  let moved = 0;
  for (const [b, q] of Object.entries(t.bones)) {
    if (boneTravelDeg(q) >= minDeg) { bones[b] = q; moved++; }
    else if (DRIVEN_BONES.has(b)) {
      const m = meanQuat(q), flat = new Float32Array(q.length);
      for (let f = 0; f < t.frames; f++) flat.set(m, f * 4);
      bones[b] = flat;
    }
  }
  return moved ? { fps: t.fps, frames: t.frames, bones } : t;
}

/** Fade the last `secs` into the first frame so playing it round and round has no jump. */
export function closeLoop(t: Take, secs = 0.5): Take {
  const n = Math.max(1, Math.min(Math.floor(t.frames / 2), Math.round(secs * t.fps)));
  const bones: Record<string, Float32Array> = {};
  for (const [b, q] of Object.entries(t.bones)) {
    const out = q.slice();
    for (let k = 0; k < n; k++) {
      const f = t.frames - n + k, x = (k + 1) / n, e = x * x * (3 - 2 * x);   // smoothstep, ends exactly on frame 0
      qslerpInto(out, f * 4, q, f * 4, q, 0, e);
    }
    bones[b] = out;
  }
  return { fps: t.fps, frames: t.frames, bones };
}

/** How much the pose changes at each frame (degrees summed over bones): the line on the trim strip. */
export function motionProfile(t: Take): Float32Array {
  const out = new Float32Array(t.frames);
  for (const q of Object.values(t.bones)) for (let f = 1; f < t.frames; f++) out[f] += qAngleDeg(q, f * 4, q, (f - 1) * 4);
  if (t.frames > 1) out[0] = out[1];
  return out;
}

/** Where the movement starts and ends, with a little lead-in and tail (zero-effort default for the trim handles). */
export function suggestTrim(t: Take, leadSecs = 0.25, tailSecs = 0.35): { start: number; end: number } {
  const e = motionProfile(t);
  // smooth over ~0.2 s so one noisy frame does not count as movement
  const r = Math.max(1, Math.round(t.fps * 0.1));
  const s = new Float32Array(t.frames);
  for (let f = 0; f < t.frames; f++) { let a = 0, c = 0; for (let k = -r; k <= r; k++) { const g = f + k; if (g >= 0 && g < t.frames) { a += e[g]; c++; } } s[f] = a / c; }
  let peak = 0;
  for (let f = 0; f < t.frames; f++) peak = Math.max(peak, s[f]);
  if (peak <= 0) return { start: 0, end: t.frames - 1 };
  const thr = Math.max(peak * 0.12, 0.4);
  let a = 0, z = t.frames - 1;
  while (a < t.frames - 1 && s[a] < thr) a++;
  while (z > a && s[z] < thr) z--;
  a = Math.max(0, a - Math.round(leadSecs * t.fps));
  z = Math.min(t.frames - 1, z + Math.round(tailSecs * t.fps));
  return z - a + 1 >= CLIP_MIN_FRAMES ? { start: a, end: z } : { start: 0, end: t.frames - 1 };
}

/** The whole edit, in the order that gives the best result: legs out, smooth, cut, keep what moved, close the loop. */
export function processTake(raw: Take, opt: Partial<EditOptions> = {}): Take {
  const o = { ...DEFAULT_EDIT, ...opt };
  let t: Take = { fps: raw.fps, frames: raw.frames, bones: {} };
  for (const [b, q] of Object.entries(raw.bones)) if (!FACE_BONES.has(b) && (o.legs || !LEG_BONES.has(b))) t.bones[b] = q;
  t = smoothTake(t, o.smooth);
  t = trimTake(t, o.start, o.end);
  if (o.keepMoved) t = keepMovedBones(t);
  if (o.loop && t.frames >= 6) t = closeLoop(t);
  return t;
}
