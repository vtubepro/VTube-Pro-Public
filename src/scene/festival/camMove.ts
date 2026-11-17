// The festival's camera director maths (src/scene/festival/festivalScene.ts autoShot / showShot), pure and allocation
// free so a unit can check it (tools/festival_cams_unit.ts):
//   showCut   which cut of the show director's grid this is and how far through it: on the BAR-PHASE position (bar +
//             barPos / 4 - Ableton Link joins with its bar phase offset from the raw beat counter, so the raw beat would
//             land every cut two beats off the bar), aligned to the phrase start when the source knows its phrase, free
//             running on the show clock when there is no beat at all
//   movePose  a room camera eased toward its <NAME>_END pose (into the caller's scratch pose)
import * as THREE from 'three';
import type { CamPose } from '../cameraRig.ts';

export interface CutClock { beat: number; bar: number; barPos: number; phraseBeat?: number | null }

/** The cut index (k) and the progress through it (u 0..1) on a grid of `bars` bars. `showSec`: the free-running clock
 *  used when the beat is not a number (120 BPM: a bar every 2 s). */
export function showCut(m: CutClock | null, bars: number, showSec: number, out = { k: 0, u: 0 }) {
  const len = Math.max(1, bars);
  let P: number, P0 = 0;
  if (m && Number.isFinite(m.beat) && Number.isFinite(m.bar) && Number.isFinite(m.barPos)) {
    P = m.bar + Math.min(3.999, Math.max(0, m.barPos)) / 4;
    // (a known phrase: the grid starts where the phrase started)
    if (m.phraseBeat !== undefined && m.phraseBeat !== null && Number.isFinite(m.phraseBeat)) P0 = ((P - m.phraseBeat / 4) % len + len) % len;
  } else P = (Number.isFinite(showSec) ? showSec : 0) / 2;
  const x = (P - P0) / len;
  out.k = Math.floor(x); out.u = x - out.k;
  return out;
}

const easeIO = (u: number) => u * u * (3 - 2 * u);
const QB = new THREE.Quaternion();

/** `out` = pose `a` moved toward pose `b` by u (eased); a non-finite u stays at `a`. */
export function movePose(out: CamPose, a: CamPose, b: CamPose | null, u: number): CamPose {
  out.position.copy(a.position); out.quaternion.copy(a.quaternion); out.fov = a.fov;
  if (!b || !Number.isFinite(u)) return out;
  const k = easeIO(Math.min(1, Math.max(0, u)));
  out.position.lerp(b.position, k);
  QB.copy(b.quaternion);
  out.quaternion.slerp(QB, k);
  out.fov += (b.fov - out.fov) * k;
  return out;
}
