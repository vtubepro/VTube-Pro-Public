// Metric head position from a single webcam (no depth sensor).
//
//  • SCALE — the RMS spread of 24 rigid landmarks (eye corners, nose, forehead, temples) is ~2× steadier
//    than one eye-corner span and nearly rotation-invariant (turning the head changes it by ~0.5 % vs ~3 %).
//  • METRIC — the human iris is 11.7 ± 0.5 mm across for almost every adult. The ratio of the rigid
//    spread to the iris diameter (measured only on frontal, open-eyed frames, then frozen) gives THIS
//    person's face size in millimetres, independent of the camera. Depth is then f · S / spread.
//  • FOV — the one thing a single image can't tell us. It comes from the camera's name (manufacturer
//    specs for common webcams), else a typical 78° diagonal, or the user's own value. Only depth
//    amplitude depends on it: sideways / vertical motion in metres is FOV-independent.
//  • PIVOT — the avatar's body should follow the NECK, not the face: turning your head swings your
//    face ~5 cm sideways, which used to slide the whole avatar. The position reported is a point
//    ~9 cm behind / 6.5 cm below the face centre, so rotating in place = rotation only.
//  • LINE OF SIGHT (optional, off) — composes the rotation with the camera→face ray, for a face model
//    that reports rotation relative to its crop. The recorded clip says MediaPipe's doesn't need it.

import * as THREE from 'three';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';

export const IRIS_MM = 11.7;
/** Rigid landmarks: eye corners, nose bridge/tip/wings, face edge at eye level, temples, forehead, brow tails. */
export const RIGID = [33, 133, 362, 263, 168, 6, 197, 195, 5, 4, 1, 98, 327, 234, 454, 127, 356, 10, 151, 9, 107, 336, 70, 300];
/** Pivot offset from the rigid centroid, head frame (x right, y up, z out of the face), metres. Fitted on a
 *  recorded head-turn/nod sequence (tools/eval_face.ts) and kept close to the anatomical C1–C2 / condyle axis. */
export const PIVOT: [number, number, number] = [0, -0.065, -0.09];

/** Diagonal field of view (degrees) of common webcams at their full-sensor modes (manufacturer specs). */
const FOV_TABLE: [RegExp, number][] = [
  [/facecam\s*4k/i, 90], [/facecam\s*pro/i, 90], [/facecam\s*mk\.?\s*2|facecam\s*neo/i, 84], [/facecam/i, 82],
  [/brio\s*(4k|ultra)|logi(tech)?\s*brio(?!\s*[0-9])/i, 90], [/brio\s*5\d\d/i, 90], [/brio\s*3\d\d/i, 70], [/brio/i, 90],
  [/c930/i, 90], [/c92[02]|c925|streamcam|c615/i, 78], [/c27\d|c31\d/i, 55], [/c5[02]\d/i, 60],
  [/kiyo\s*pro\s*ultra/i, 82], [/kiyo\s*x/i, 82], [/kiyo/i, 81.6], [/lifecam\s*studio/i, 75], [/lifecam/i, 68.5],
  [/insta360\s*link/i, 79.5], [/obsbot\s*tiny/i, 85.5], [/obsbot/i, 86], [/emeet/i, 90], [/anker|powerconf/i, 95],
  [/avermedia|pw31\d/i, 94], [/nexigo/i, 90], [/depstech/i, 90],
];
export const DEFAULT_FOV = 78;
const KEY = 'vtp.faceMetric';

export interface HeadMeasure {
  /** Rigid centroid, normalized image coords (u: 0..1 of width, v: 0..1 of height). */
  u: number; v: number;
  /** Rigid RMS spread in frame-WIDTH units (scale-free face size). */
  s: number;
  /** Horizontal iris diameter (mean of both eyes), frame-width units, 0 when not measurable. */
  iris: number;
}

export function fovForLabel(label: string): number | null {
  for (const [re, f] of FOV_TABLE) if (re.test(label)) return f;
  return null;
}

/** Scale-free measurement of the face in the image (landmarks: x in width units, y in height units, z ~ x). */
export function measureHead(lm: NormalizedLandmark[], aspect: number): HeadMeasure {
  let cx = 0, cy = 0, cz = 0;
  for (const i of RIGID) { const p = lm[i]; cx += p.x; cy += p.y / aspect; cz += p.z; }
  const n = RIGID.length;
  cx /= n; cy /= n; cz /= n;
  let r = 0;
  for (const i of RIGID) { const p = lm[i]; r += (p.x - cx) ** 2 + (p.y / aspect - cy) ** 2 + (p.z - cz) ** 2; }
  let iris = 0;
  if (lm.length >= 478) {
    const d = (a: number, b: number) => Math.hypot(lm[a].x - lm[b].x, (lm[a].y - lm[b].y) / aspect);
    iris = (d(469, 471) + d(474, 476)) / 2;
  }
  return { u: cx, v: cy * aspect, s: Math.sqrt(r / n), iris };
}

const _v = new THREE.Vector3();
const _fwd = new THREE.Vector3(0, 0, -1);
const _los = new THREE.Quaternion();

export class HeadMetric {
  /** Diagonal FOV in degrees and where it came from. */
  fovDiag = DEFAULT_FOV;
  fovSource: 'default' | 'camera' | 'user' = 'default';
  /** This person's rigid-landmark spread in metres (learned from the iris). */
  S = 0.05;
  /** Frontal open-eye samples collected so far (learning freezes at LEARN_N). */
  learned = 0;
  /** Last absolute camera distance (m) — diagnostics. */
  Z = 0;
  /** Iris-only distance of the last frame (m), 0 when not measurable — diagnostics. */
  irisZ = 0;
  /** Line-of-sight correction (true rotation = crop-relative rotation ∘ line of sight). OFF: on the recorded
   *  clip the rigid-pivot model fits MediaPipe's rotation better WITHOUT it (turn leakage −0.3 vs 0.9 cm/30°),
   *  i.e. the face model's rotation already behaves like the camera-frame rotation. Kept for experiments. */
  lineOfSight = false;
  private ratios: number[] = [];
  private static readonly LEARN_N = 240;

  constructor() {
    try {
      const s = JSON.parse(localStorage.getItem(KEY) ?? 'null') as { S?: number; n?: number; fov?: number } | null;
      if (s?.S && s.S > 0.03 && s.S < 0.08) { this.S = s.S; this.learned = s.n ?? HeadMetric.LEARN_N; }
      if (s?.fov && s.fov > 30 && s.fov < 150) { this.fovDiag = s.fov; this.fovSource = 'user'; }
    } catch { /* no storage */ }
  }

  /** Pick the FOV from the camera's name unless the user set one. */
  setCamera(label: string) {
    if (this.fovSource === 'user') return;
    const f = fovForLabel(label);
    this.fovDiag = f ?? DEFAULT_FOV;
    this.fovSource = f ? 'camera' : 'default';
  }

  /** User override (null = back to automatic). */
  setUserFov(fov: number | null, label = '') {
    if (fov && fov > 30 && fov < 150) { this.fovDiag = fov; this.fovSource = 'user'; }
    else { this.fovSource = 'default'; this.setCamera(label); }
    this.save();
  }

  /** Relearn the person's face size (e.g. a different performer). */
  resetScale() { this.ratios = []; this.learned = 0; this.S = 0.05; this.save(); }

  private save() {
    try { localStorage.setItem(KEY, JSON.stringify({ S: this.S, n: this.learned, fov: this.fovSource === 'user' ? this.fovDiag : undefined })); } catch { /* ignore */ }
  }

  /** Focal length in frame-width units for the current FOV. */
  focal(aspect: number) {
    const tanH = Math.tan((this.fovDiag * Math.PI) / 360) * aspect / Math.hypot(aspect, 1);
    return 0.5 / tanH;
  }

  /**
   * Feed a frame for face-size learning. Only frontal (|yaw|, |pitch| small), open-eyed, gaze-centred
   * frames count: the horizontal iris diameter foreshortens when the eye turns.
   */
  learn(m: HeadMeasure, frontal: boolean) {
    if (this.learned >= HeadMetric.LEARN_N || !frontal || m.iris <= 0) return;
    const r = m.s / m.iris;
    if (r < 2.5 || r > 7) return; // implausible (bad iris fit)
    this.ratios.push(r);
    this.learned++;
    if (this.ratios.length >= 15 && (this.ratios.length % 15 === 0 || this.learned >= HeadMetric.LEARN_N)) {
      const srt = [...this.ratios].sort((a, b) => a - b);
      this.S = srt[srt.length >> 1] * IRIS_MM / 1000; // median ratio × 11.7 mm
      if (this.learned >= HeadMetric.LEARN_N) { this.ratios = []; this.save(); }
    }
  }

  /**
   * Camera-space centroid in metres, GL convention (x right, y up, z toward the viewer; the face is at z < 0).
   */
  centroid(m: HeadMeasure, aspect: number, out = new THREE.Vector3()) {
    const f = this.focal(aspect);
    const Z = (f * this.S) / Math.max(1e-4, m.s);
    return out.set(((m.u - 0.5) / f) * Z, -((m.v - 0.5) / (aspect * f)) * Z, -Z);
  }

  /** True head rotation in the camera frame: the crop-relative rotation composed with the line of sight. */
  trueRotation(qApparent: THREE.Quaternion, m: HeadMeasure, aspect: number, out = new THREE.Quaternion()) {
    if (!this.lineOfSight) return out.copy(qApparent);
    this.centroid(m, aspect, _v).normalize();
    _los.setFromUnitVectors(_fwd, _v);
    return out.copy(_los.multiply(qApparent)); // (out may alias qApparent)
  }

  /**
   * Neck-pivot position (metres, GL camera frame) for a measurement + TRUE head rotation. Records Z / irisZ.
   */
  pivot(m: HeadMeasure, aspect: number, qTrue: THREE.Quaternion | null, out = new THREE.Vector3()) {
    this.centroid(m, aspect, out);
    this.Z = -out.z;
    this.irisZ = m.iris > 0 ? (this.focal(aspect) * IRIS_MM) / 1000 / m.iris : 0;
    if (qTrue) out.add(_v.set(PIVOT[0], PIVOT[1], PIVOT[2]).applyQuaternion(qTrue));
    return out;
  }
}
