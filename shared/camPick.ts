// The host's hand-picked camera (SceneState.camPick): the Live panel is the thing that dictates camera direction.
//
// A pick made by hand (Live panel camera buttons, Stream Deck, MCP, the Scene tab's Camera menu) stamps `camPick`. While it
// stands, SceneRuntime.updateCamera takes `state.camera` over every AUTOMATIC source - the room directors on
// `cameraOverride` (raid, kitchen, festival, AFK, audience, TTRPG table, club), the ambient Preshow / BRB / Outro cameras
// and the screen-video "Camera: show the screen" cue - and alert reactions leave the camera alone. Entrances stay:
// the walk-in follow camera (mover.followCamera) and the club's host-entrance shots (SceneRuntime.entranceCamera) still
// play, and when they end the picked camera is simply what is left.
//
// Cleared (the directors may cut again) by: Auto, a mode or room change (the camera is then the mode's / room's own), and
// the host turning a camera director on (ambient cameras, AFK). Pure; tools/camera_pick_unit.ts covers it.
import type { SceneState } from './types.ts';

/** Has the host picked the camera by hand (and not handed it back)? */
export function handPicked(s: Pick<SceneState, 'camPick'> | null | undefined): boolean {
  return typeof s?.camPick === 'number' && s.camPick > 0;
}

/** Stamp (hand = a pick) or clear (Auto / a director took over) the pick on a draft state. */
export function setPick(s: SceneState, hand: boolean, now = Date.now()): void {
  // (strictly newer than the pick it replaces: a diff PUT that changes the camera must also change the stamp - server/routes/scenes.ts)
  if (hand) s.camPick = Math.max(1, Math.floor(now), (s.camPick ?? 0) + 1); else delete s.camPick;
}
