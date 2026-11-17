// The body kinds a profile may store (AvatarProfile.body; absent = a person) and what the runtime builds for each.
//   quadruped  planted on four legs: the leg / tail layer (src/avatar/quadruped.ts) plus the planted-body retarget
//   object     a thing (lamp, plant, robot arm): planted, NO gait and NO hip sway: only the bend chain (face tracker + idle
//              sway) and the spring bones move (src/avatar/rigMap.ts)
//   serpent    a snake / worm / fish: planted, no gait; a slither runs down the body (src/avatar/rigMap.ts)
//   mech       a pilot in a walking machine (src/avatar/mech.ts)
export type StoredBody = 'quadruped' | 'mech' | 'object' | 'serpent';
export const STORED_BODIES: readonly StoredBody[] = ['quadruped', 'mech', 'object', 'serpent'];

/** True for the kinds that are saved; anything else is dropped (a person). */
export const isStoredBody = (v: unknown): v is StoredBody => typeof v === 'string' && (STORED_BODIES as readonly string[]).includes(v);

export interface BodyLayers {
  /** The retargeter runs in its planted mode: no arm / hand / leg retargeting, a gentle lean, no whole-body sliding. */
  planted: boolean;
  /** QuadrupedLife (legs planted, walk gait, weight shift at the hips, tail swish) is built. */
  quadrupedLife: boolean;
}

export function bodyLayers(body: unknown): BodyLayers {
  switch (body) {
    case 'quadruped': return { planted: true, quadrupedLife: true };
    case 'object': case 'serpent': return { planted: true, quadrupedLife: false };
    default: return { planted: false, quadrupedLife: false };
  }
}
