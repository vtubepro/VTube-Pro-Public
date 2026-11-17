// What moves the avatar in the editor's preview. Both choices feed the RUNTIME's own animator (shared/rig2d/animate.ts:
// tracking → bindings → blinks → lip sync → expressions → physics), so the preview is exactly what goes live:
//   demo   demoFrame(t): a deterministic synthetic tracking frame, "talking and looking around" (also what the private
//          tests use: no camera, no microphone, no sound);
//   camera the studio's own tracking frames (the mount function's getFrame).
import type { TrackingFrame } from '../../shared/types.ts';

const cl = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const RAD = Math.PI / 180;

/** The synthetic tracking frame at time t (seconds). Head angles in radians (+yaw = toward the viewer's right,
 *  +pitch = down, +roll = counter-clockwise), ARKit blendshapes, the procedural mouth. */
export function demoFrame(t: number, out?: TrackingFrame): TrackingFrame {
  const yaw = (22 * Math.sin(t * 0.7) + 4 * Math.sin(t * 1.9)) * RAD;
  const pitch = -10 * Math.sin(t * 0.53 + 1) * RAD;
  const roll = 9 * Math.sin(t * 0.41 + 2) * RAD;
  const bp = t % 3.7;
  const blink = bp < 0.09 ? bp / 0.09 : bp < 0.18 ? 1 - (bp - 0.09) / 0.09 : 0;
  const smile = cl(0.5 + 0.6 * Math.sin(t * 0.33), 0, 1);
  const phrase = t % 4.6 < 3.1 ? 1 : 0;
  const open = cl(phrase * Math.max(0, Math.sin(t * 9.1) * 0.55 + Math.sin(t * 5.3 + 1) * 0.35 + 0.15), 0, 1);
  const brow = 0.35 * Math.sin(t * 0.6);
  const f: TrackingFrame = out ?? { t: 0, face: {}, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0], mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 }, tracked: true };
  f.t = t * 1000;
  f.tracked = true;
  f.head[0] = yaw; f.head[1] = pitch; f.head[2] = roll;
  f.headPos[0] = 0.02 * Math.sin(t * 0.45); f.headPos[1] = 0; f.headPos[2] = 0;
  f.gaze[0] = 0.55 * Math.sin(t * 0.9 + 0.4); f.gaze[1] = -0.3 * Math.sin(t * 0.61);
  const face = f.face;
  face.eyeBlinkLeft = face.eyeBlinkRight = blink;
  face.mouthSmileLeft = face.mouthSmileRight = smile * 0.45;
  face.cheekSquintLeft = face.cheekSquintRight = smile > 0.85 ? (smile - 0.85) * 4 : 0;
  face.browOuterUpLeft = face.browOuterUpRight = Math.max(0, brow);
  face.browDownLeft = face.browDownRight = Math.max(0, -brow);
  face.browInnerUp = Math.max(0, 0.3 * Math.sin(t * 0.37));
  face.jawOpen = open;
  const m = f.mouth;
  m.open = open; m.smile = smile * 0.45; m.frown = 0; m.wide = 0; m.pucker = 0; m.funnel = 0; m.tongue = 0; m.speak = phrase;
  return f;
}

/** A frame for "nobody in front of the camera" (the runtime then idles and blinks by itself). */
export const idleFrame = (): TrackingFrame => ({ t: 0, face: {}, head: [0, 0, 0], headPos: [0, 0, 0], gaze: [0, 0], mouth: { open: 0, wide: 0, smile: 0, frown: 0, pucker: 0, funnel: 0, tongue: 0 }, tracked: false });
