// Plain-words camera help for the studio: what the camera of the current show mode does on its own, and how to keep one
// shot (Show & layout -> Show mode, src/ui/stagePanel.ts; the Show quick bar's "Auto cam", src/ui/live/liveStudio.ts).
// Pure (no DOM): tools/camera_hold_unit.ts checks it.
//   Talk       one steady shot (SceneRuntime.resolveCamera). It moves on its own only for a walk-in (the follow camera)
//              and, with Ambient cameras on, in Preshow / BRB / Outro (src/scene/ambientCam.ts), and while the AFK tour is
//              on (src/scene/afk: the camera tours the room until it is switched off).
//   Interview  the auto director (src/scene/talkshow/director.ts) cuts on who is speaking, with slow push-ins on long
//              answers and a wide shot after a quiet beat. Director: Manual holds the chosen shot.
import { keyActive, type DeckKey, type DeckLiveState } from './deck.ts';

export interface CameraNoteOpts {
  /** Interview: the director setting (SceneState.modes.interview.director). */
  director?: string;
  /** Ambient cameras switched on (SceneState.ambcam.on): Talk's Preshow / BRB / Outro camera moves. */
  ambient?: boolean;
  /** The AFK cinematic tour is on (SceneState.afk.on): Talk's camera tours the room by itself. */
  afk?: boolean;
}

/** One sentence or two under the mode bar: what this mode's camera does by itself and how to keep one shot. */
export function cameraNote(mode: string, o: CameraNoteOpts = {}): string | null {
  if (mode === 'interview') {
    return o.director === 'manual'
      ? 'Camera: Manual. The shot you pick below stays on screen until you pick another. Ctrl+Shift+0 turns the auto director back on.'
      : 'Camera: the auto director is on. It cuts between you, your guests and a wide shot of the room, and slowly zooms in on long answers. To keep one shot, set Director to Manual below and pick a shot.';
  }
  if (mode === 'talk') {
    return 'Camera: Talk keeps one steady shot of you. Pick another in Live > Camera (Me, Group, Wide or a room camera): it stays until you change it. It only moves by itself when someone walks in.'
      + (o.ambient ? ' Ambient cameras is on: in Preshow, BRB and Outro the camera moves around the room. Turn it off further down this page to keep one shot there too.' : '')
      + (o.afk ? ' The AFK tour is on: the camera tours the room by itself until you turn it off (Scene > AFK / Starting soon).' : '');
  }
  if (mode === 'react' || mode === 'gaming') return 'Camera: pick a shot in Live > Camera. It stays until you change it.';
  return null;
}

/** Is a Show quick-bar button lit? Like keyActive, except the Interview director buttons ("Auto cam") stay dark outside
 *  Interview mode: there they change nothing, and a lit "Auto cam" in Talk read as "the camera is on automatic". */
export function quickActive(action: string, params: DeckKey['params'], live: DeckLiveState): boolean | null {
  if (action === 'interview' && live.mode !== 'interview') return false;
  return keyActive({ action, params }, live);
}

/** Hover text of the quick bar's "Auto cam" (the Interview auto director). */
export function autoCamTitle(mode: string, director?: string): string {
  if (mode !== 'interview') return 'Interview mode only: there an auto director cuts between you, your guests and a wide shot. Talk keeps one steady shot (Live > Camera).';
  return director === 'manual'
    ? 'Turns the auto director back on: it cuts between you, your guests and a wide shot. Now: Manual, your shot stays put.'
    : 'The auto director is on: it cuts between you, your guests and a wide shot. To keep one shot, switch it to Manual (Live > Camera) and pick a shot.';
}

/** Who is choosing the camera, in plain words (Live > Camera, so an automatic camera can never be invisible): a hand pick
 *  holds until Auto; with none, a Tabletop game or the ambient cameras may be cutting in a room that has them. */
export function cameraDriverNote(live: Pick<DeckLiveState, 'mode' | 'camHand' | 'ttrpgOn' | 'ambcam'>): string | null {
  if (live.mode === 'interview') return null;
  if (live.camHand) return 'You picked this camera by hand: it stays, whatever the room does. Auto gives the camera back to the room.';
  const who = [live.ttrpgOn ? 'the Tabletop game' : '', live.ambcam ? 'the ambient cameras' : ''].filter(Boolean);
  return who.length ? `${who.join(' and ')} may be choosing the camera. Pick one below to take over.` : null;
}
