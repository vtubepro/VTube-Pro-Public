// Capture cover ("privacy cover", src/scene/capcover/*): while the host sets up a game / picks a window, an animated
// card covers ONLY the screen-capture area — the React screen (OBS passthrough hole or in-scene capture), the React
// Full / Medium capture rect, the Gaming capture rect — never the performers, cams or chat. It stays up until the host
// turns it off (Scene tab button, the Hide my screen key — Ctrl+B unless changed in Live → Privacy —, bus / MCP `scene {cover:{on}}`, POST /api/scene/cover): nothing auto-dismisses.
//
// HOST-owned, part of SceneState (`state.capcover`, missing = off), so every OBS page (the host's and every party
// guest's) and the Scene-tab preview cover the same way.

export interface SceneCaptureCover {
  /** Covered. */
  on: boolean;
  /** Style id (src/scene/capcover/styles.ts registry). Unknown ids fall back to the default on the page. */
  style: string;
  /** Optional line on the card ("Setting up the game…"); '' = the style's own line. */
  text: string;
}

export const DEFAULT_CAPCOVER: SceneCaptureCover = { on: false, style: 'cc-cartridge', text: '' };

const STYLE = /^[a-z][a-z0-9-]{0,31}$/;
export const isCoverStyle = (v: unknown): v is string => typeof v === 'string' && STYLE.test(v);
/** Card text: one line, no control characters, ≤ 60 chars. */
export const cleanCoverText = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim().slice(0, 60) : '');

export function sanitizeCaptureCover(o: unknown): SceneCaptureCover {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return { on: x.on === true, style: isCoverStyle(x.style) ? x.style : DEFAULT_CAPCOVER.style, text: cleanCoverText(x.text) };
}
