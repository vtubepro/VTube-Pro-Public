// Emote rain: where is the avatar's head, in the picture? (docs/b16/EMOTE_RAIN.md)
// The OBS page keeps a read-only debugging handle, `window.vtpOut` (src/output.ts): the performer's runtime (faceInfo = the
// face's centre and size in the room) and, behind the compositor / the room runtime, the stage camera. This projects the
// face and the shoulders through that camera. Every step is guarded: when anything is missing the answer is null and the
// rain falls on a sensible default spot (or the side the user picked), never an error. Measured about 8 times a second
// into one reused object, so nothing is allocated while it rains.
import * as THREE from 'three';
import type { RainAnchor } from '../../../shared/emoteRain.ts';

interface Cam extends THREE.Camera { projectionMatrix: THREE.Matrix4; matrixWorld: THREE.Matrix4 }
const out: RainAnchor = { x: 0, y: 0, rx: 0, ry: 0, shY: 0, shHalf: 0, neck: 0, drop: 0 };
const P = new THREE.Vector3(), Q = new THREE.Vector3(), R = new THREE.Vector3();
let lastAt = -1e9, lastOk = false;
const EVERY_MS = 120;

type Handle = { runtime?: { faceInfo?: () => { center: THREE.Vector3; size: number } | undefined };
  scene?: { stage?: { camera?: Cam } } | null; stage?: { stage?: { camera?: Cam } } | null; test?: { stage?: { camera?: Cam } } };

function cameraOf(o: Handle): Cam | null {
  const c = o.scene?.stage?.camera ?? o.stage?.stage?.camera ?? o.test?.stage?.camera;
  return c && c.projectionMatrix && c.matrixWorld && (c as THREE.PerspectiveCamera).matrixWorldInverse ? c : null;
}

/** The head and shoulders in frame units (x 0..aspect, y 0..1 top down), or null when the page can't tell. */
export function measureAnchor(aspect: number, now: number = performance.now()): RainAnchor | null {
  if (now - lastAt < EVERY_MS) return lastOk ? out : null;
  lastAt = now; lastOk = false;
  try {
    const o = (globalThis as unknown as { vtpOut?: Handle }).vtpOut;
    const rt = o?.runtime;
    const cam = o ? cameraOf(o) : null;
    const fi = rt?.faceInfo?.();
    if (!o || !cam || !fi || !(fi.size > 0)) return null;
    const S = fi.size, e = cam.matrixWorld.elements;
    R.set(e[0], e[1], e[2]).normalize();   // the camera's right
    const toFrameX = (nx: number) => (nx * 0.5 + 0.5) * aspect, toFrameY = (ny: number) => 1 - (ny * 0.5 + 0.5);
    // head: a little below the face's centre
    P.copy(fi.center); P.y -= S * 0.04;
    Q.copy(P).project(cam);
    if (Q.z > 1 || Q.z < -1) return null;
    const hx = toFrameX(Q.x), hy = toFrameY(Q.y);
    Q.copy(P).addScaledVector(R, S * 0.5).project(cam);
    const rx = Math.abs(toFrameX(Q.x) - hx);
    Q.copy(P); Q.y += S * 0.6; Q.project(cam);
    const ry = Math.abs(toFrameY(Q.y) - hy);
    // shoulders: below the chin; a little wider than real ones so a pile has room (and the arms are in that space too)
    Q.copy(P); Q.y -= S * 1.45; Q.project(cam);
    const shY = toFrameY(Q.y);
    Q.copy(P).addScaledVector(R, S * 1.35); Q.y -= S * 1.45; Q.project(cam);
    const shHalf = Math.abs(toFrameX(Q.x) - hx);
    out.x = hx; out.y = hy; out.rx = rx; out.ry = ry; out.shY = shY; out.shHalf = shHalf; out.neck = shHalf * 0.28; out.drop = ry * 0.25;
    lastOk = true;
    return out;
  } catch { return null; }
}
