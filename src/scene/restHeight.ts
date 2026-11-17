// The rest-height plausibility test behind SceneActor's normalising scale (src/scene/actor.ts measureRest), as pure
// functions so it can be unit-tested (tools/avsize_unit.ts).
//
// measureRest compares the bounding box with what the skeleton says. It used to estimate the height as
// (head joint - foot) x 1.18, i.e. it assumed human proportions (the head joint at ~85 % of the height). A puppet breaks
// that: a puppet avatar's `head` joint sits at the BASE of a 0.62 m head (y 0.597, feet 0.038), so the estimate was
// 0.66 m, his real 1.42 m looked like "stray geometry" (> 1.8 x 0.66), he was measured 0.66 m tall and normalised 2.27x
// too big, and the face check then failed too (the face was re-guessed at his chest). Two fixes:
//   1. when the head's bone subtree reaches well above the head joint (> 25 % of the span: his upperHead / jaw hinge at
//      0.891 -> estimate 1.01 m) the span runs to its top, capped at 75 % so a stray bone can't inflate it; humans (hair
//      bones a few cm up) keep the old estimate;
//   2. geometry is only called "stray" when the skinned vertices really leave an empty band (> 6 % of the box height):
//      a particle plane or a hidden floor floats apart from the body; a big continuous puppet head does not.

/** The skeleton's height estimate (m): (top of the head subtree - foot) x 1.18. `subtreeTop` = the highest bone at or
 *  under the head (null = the head joint itself). */
export function skeletonHeight(headY: number, footY: number, subtreeTop: number | null): number {
  const span = headY - footY;
  if (!(span > 1e-4)) return 0;
  // only a head subtree reaching well above the head joint (> 25 % of the head-to-foot span: a puppet / mascot head)
  // counts - a human's hair / hat bones a few cm up keep the old estimate, so its stray-geometry test stays as sharp
  const up = subtreeTop === null || !Number.isFinite(subtreeTop) ? 0 : subtreeTop - headY;
  const top = up > span * 0.25 ? headY + Math.min(up, span * 0.75) : headY;
  return (top - footY) * 1.18;
}

/** Longest empty band of a vertical histogram (fraction of [min, max]); `ys` = sampled vertex heights. */
export function verticalGap(ys: ArrayLike<number>, min: number, max: number, bins = 50): number {
  const H = max - min;
  if (!(H > 1e-6) || ys.length < 8) return 0;
  const hit = new Uint8Array(bins);
  for (let i = 0; i < ys.length; i++) {
    const b = Math.floor(((ys[i] - min) / H) * bins);
    hit[Math.min(bins - 1, Math.max(0, b))] = 1;
  }
  let best = 0, run = 0;
  for (let b = 0; b < bins; b++) { if (hit[b]) run = 0; else { run++; if (run > best) best = run; } }
  return best / bins;
}

export const STRAY_GAP = 0.06;

/** Is the box height implausible for the skeleton estimate? (outside 0.55 .. 1.8 x the estimate) */
export const implausible = (height: number, est: number) => est > 1e-4 && (height > est * 1.8 || height < est * 0.55);
