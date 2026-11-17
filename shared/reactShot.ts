// Live panel: "your React screen is out of shot — press Auto or Screen". The owner's React screen vanished because the
// camera was on the 'Me' close-up, which never shows the side screen (and OBS automation then parked the window off the
// picture). The OBS page no longer opens a hole or places a capture for a screen the camera can't see
// (src/scene/SceneRuntime.ts, server/obs.ts); this tells the streamer plainly what to press. Pure: the studio and the
// popped-out Live window share it (tools/react_obs_unit.ts).

/** The studio preview's measurement of the React screen in the live camera's shot (src/output.ts report()).
 *  layout 'stage' = React Full / Medium: a stage layout draws the window in the frame, whatever the room camera does. */
export interface ReactShotReport {
  layout: 'big' | 'solo' | 'stage';
  inShot: boolean;
  /** shared/quad.ts ShotWhy: 'ok' | 'behind' | 'outside' | 'small' | 'bad'. */
  why: string;
  /** SceneState.camera the measurement is for. */
  cam: string;
  /** Date.now() of the measurement (dropped once the studio has checked it is fresh). */
  at?: number;
}

/** A measurement this old (ms) or for another camera is not trusted (the preview may be closed). */
export const SHOT_FRESH_MS = 3000;

const layoutOf = (v: unknown): ReactShotReport['layout'] => (v === 'solo' ? 'solo' : v === 'stage' ? 'stage' : 'big');

/** The preview's measurement if it is fresh, else null — what the studio puts in its live status (without `at`). */
export function freshShot(r: ReactShotReport | null | undefined, now = Date.now()): ReactShotReport | null {
  if (!r || typeof r.at !== 'number' || now - r.at > SHOT_FRESH_MS || now < r.at - 1000) return null;
  return { layout: layoutOf(r.layout), inShot: !!r.inShot, why: String(r.why ?? '').slice(0, 12), cam: String(r.cam ?? '').slice(0, 48) };
}

/** Tolerant reader (bus / pop-out). */
export function sanitizeShot(v: unknown): ReactShotReport | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
  if (!o || typeof o.inShot !== 'boolean' || typeof o.cam !== 'string') return null;
  return { layout: layoutOf(o.layout), inShot: o.inShot, why: typeof o.why === 'string' ? o.why.slice(0, 12) : '', cam: o.cam.slice(0, 48) };
}

const camName = (c: string) => c === 'group' ? 'Group' : c === 'wide' ? 'Wide' : c === 'screen' ? 'Screen' : c === 'react' ? 'React shot'
  : /^CAM_/.test(c) ? c.replace(/^CAM_/, '').replace(/_/g, ' ').toLowerCase().replace(/^./, (x) => x.toUpperCase()) : c;

/** Without a measurement: is the React window surely on the solo side screen beside the performer (the screen a
 *  close-up never shows)? Side, or Auto with one performer in the room (shared/stage.ts resolveReact). Big / Full /
 *  Medium, or Auto with a group (Big or Medium, depending on the room), are left to the preview's measurement. */
export function surelySideScreen(preset: string | undefined, inRoom: number): boolean {
  const p = preset ?? 'auto';
  return p === 'side' || (p === 'auto' && inRoom <= 1);
}

/** One plain sentence when the React screen can't be seen with the camera in use (null = nothing to say).
 *  `shot` = the studio preview's fresh measurement; without one, only a close-up ('talk') of a performer beside the solo
 *  side screen is known to miss it (`live.react` = the React size preset, `inRoom` = performers in the room). */
export function reactShotNote(live: { mode: string; camera?: string; react?: string }, shot?: ReactShotReport | null, inRoom = 1): string | null {
  if (live.mode !== 'react') return null;
  const cam = live.camera ?? 'react';
  const m = shot && shot.cam === cam ? shot : null;
  if (m ? m.inShot : !(cam === 'talk' && surelySideScreen(live.react, inRoom))) return null;
  const what = cam === 'talk' ? 'the camera is on a close-up' : `the ${camName(cam)} camera doesn’t show it`;
  const press = cam === 'screen' ? 'Auto' : cam === 'react' ? 'Screen' : 'Auto or Screen';
  return `Your React screen is out of shot: ${what}, so viewers don’t see your window. Press ${press} under Camera.`;
}
