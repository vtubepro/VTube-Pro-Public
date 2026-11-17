// Automatic face setup (src/app.ts autoFace): a model with no eye shapes and / or no mouth shapes gets generated
// eyes / a generated mouth placed for it. Only while the Source is still the default "model's own" one; once the
// performer picks a Source by hand (EyeConfig.picked / MouthConfig.picked) it is theirs, and switching back to the
// model's own eyes or mouth must stick across rebuilds, reloads and sessions.
import type { AvatarProfile } from './types.ts';

/** What the loaded model can do on its own: blink / look (eye shapes, VRM look-at) and talk (mouth shapes, jaw rig). */
export interface FaceAbility { blink: boolean; mouth: boolean }

/** Which parts the automatic face setup should generate for this profile + model. */
export function autoFaceNeeds(p: Pick<AvatarProfile, 'eyes' | 'mouth'>, can: FaceAbility): { eyes: boolean; mouth: boolean } {
  return {
    eyes: p.eyes.mode === 'model' && !p.eyes.picked && !can.blink,
    mouth: p.mouth.mode === 'model' && !p.mouth.picked && !can.mouth,
  };
}

/** Which of the NEEDED parts the face guess (src/avatar/faceGuess.ts) found a spot for; null = none of them, and then
 *  autoFace must not edit at all: an edit that places nothing still saves + rebuilds the whole avatar, which runs
 *  autoFace again with the same guess, forever (e.g. eyes needed, the eye rays miss, only the mouth ray hits). Every
 *  non-null answer turns at least one needed part into a generated one, so the rebuilds end after at most two. */
export function autoFacePlace(need: { eyes: boolean; mouth: boolean }, guess: { eyes: unknown; mouth: unknown } | null): { eyes: boolean; mouth: boolean } | null {
  const eyes = need.eyes && !!guess?.eyes, mouth = need.mouth && !!guess?.mouth;
  return eyes || mouth ? { eyes, mouth } : null;
}

/** The drop import (src/ui/dropImport.ts) keeps the model's own face on purpose: its own eyes (painted on / modelled,
 *  found before anything is drawn on: "we kept them"), or every part when the performer unticks "Set up the face".
 *  Saved as picked, so the studio's automatic face setup doesn't draw generated eyes / a mouth over them right after
 *  "Wear it now" (double eyes). Parts the import gave a generated Source are left as they are. */
export function keepImportFace(p: Pick<AvatarProfile, 'eyes' | 'mouth'>, kept: { ownEyes: boolean; optedOut: boolean }): void {
  if (p.eyes.mode === 'model' && (kept.ownEyes || kept.optedOut)) p.eyes.picked = true;
  if (p.mouth.mode === 'model' && kept.optedOut) p.mouth.picked = true;
}
