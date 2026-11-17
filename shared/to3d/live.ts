// Pro2D → 3D live gating (lane to3d; AGENTS.md rules 1 + 5, BLENDER_PLAYBOOK §1 / §3.4). Pure.
// While OBS streams / records, or the studio is tracking (live_ok not IDLE: a fresh diag state.json), the only work
// allowed is the CPU pipeline at IDLE priority inside the Blender lock. No visible Blender window, no renders in the
// studio's process; review renders run in a separate muted headless process, one view at a time.
export interface LiveFacts {
  /** obs.outputActive(): true streaming / recording, false not, null = can't tell (OBS never connected) */
  obsOutput: boolean | null;
  /** age (s) of the newest cache/diag/history/*state.json (the live studio writes it every 3 s while tracking); null = none */
  diagAgeS: number | null;
  /** the studio's tracking is struggling (inferMs ≥ 25 or trackFps ≤ 24 in that state.json) */
  struggling: boolean;
}

export interface LiveRule {
  live: boolean;
  why: string | null;
  /** a visible Blender window may be opened (never while live) */
  visibleBlender: boolean;
  /** headless review renders: all views in one go, or one view per pass with gaps (live) */
  renderOneAtATime: boolean;
  /** heavy steps wait (the studio's tracking is struggling) */
  pause: boolean;
}

export const TRACKING_FRESH_S = 30;

export function liveRule(f: LiveFacts): LiveRule {
  const tracking = f.diagAgeS !== null && f.diagAgeS <= TRACKING_FRESH_S;
  const live = f.obsOutput === true || tracking;
  const why = f.obsOutput === true ? 'OBS is streaming or recording' : tracking ? 'the studio is tracking your camera' : null;
  return { live, why, visibleBlender: !live, renderOneAtATime: live, pause: tracking && f.struggling };
}
