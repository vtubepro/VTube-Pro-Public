// The OBS output page's side of the passthrough handshake with OBS automation (server/obs.ts): what the helper's answers
// to GET / POST /api/obs/hole mean for the page (src/output.ts). Owner rule: the React window always looks like a real
// screen in the room — never a misfit box and never an empty see-through hole. Pure (tools/react_obs_unit.ts).

/** `pin` in an answer. true / false = known: OBS warps the capture onto an angled screen's exact corners (Perspective
 *  corner-pin + obs-shaderfilter), or it can't. null = NOT known yet — right after a helper restart or a changed OBS
 *  address / password the helper is still asking OBS: the page keeps what it had (no hole ↔ in-room flip) and asks again
 *  soon (PIN_REASK_MS). Older versions always answer a boolean; a junk / missing answer counts as unknown. */
export function pinFromAnswer(j: unknown): boolean | null {
  const p = j && typeof j === 'object' ? (j as { pin?: unknown }).pin : undefined;
  return p === true ? true : p === false ? false : null;
}

/** `refused` in an answer: OBS automation will NOT show a capture for the page's open React hole (the helper's own check:
 *  a box that can't match the screen's corners, no part of it on the OBS picture …). The page then draws that screen in
 *  the room (the fast feed / a shared window / NO SIGNAL) instead of keeping an empty see-through hole, until the shot
 *  changes. null = nothing refused (or an older version that never says). */
export function refusalFromAnswer(j: unknown): string | null {
  const r = j && typeof j === 'object' ? (j as { refused?: unknown }).refused : undefined;
  return typeof r === 'string' && r.trim() ? r.trim().slice(0, 200) : null;
}

/** While `pin` is unknown the page asks again this soon (instead of the 5 s React cadence). */
export const PIN_REASK_MS = 1500;
