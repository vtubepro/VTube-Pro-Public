// Be Right Back (live-tabs, owner 2026-10-01): "the BRB option mutes the audio from guests and puts up a simple text of
// Be Right Back in a looped animation in light and dark VTube Pro themes … it should always take the camera away from
// the scene with a fade to black. When you undo BRB, it should fade in from black and back to the scene."
//
// BRB is ON exactly while the lighting state is 'brb' (Live → Show → Lighting → BRB, Privacy → Be right back, Shift+4,
// Ctrl+K "brb", Stream Deck `lighting {state: brb}`, the OBS dock — and OBS scene switching keys off it as before).
// While on, every OBS page / preview / the Live program monitor fades to black (FADE_S) and then shows the BRB card
// (src/scene/brb/*), and the host's studio mutes every guest on stream and in the other guests' mixes (a separate
// layer in src/net/moderation.ts: the host's own per-guest decisions are never touched, so turning BRB off restores
// them exactly). The card's look is host-owned in SceneState.brb (missing = the defaults below).

export type BrbTheme = 'dark' | 'light';
export interface SceneBrbState {
  /** Animation style id (BRB_STYLES). */
  style: string;
  theme: BrbTheme;
  /** The card's line ('' = "Be Right Back"). ≤ 40 chars, one line. */
  text: string;
  /** Your own BRB screen: a picture / short looping video behind the words (server/routes/brb.ts, kept on this
   *  computer). `rev` changes on every new upload so pages load the new one. Absent = the theme's own background. */
  bg?: { kind: 'image' | 'video'; rev: number };
}
export const BRB_STYLES: { id: string; name: string; blurb: string }[] = [
  { id: 'breathe', name: 'Breathe', blurb: 'The words glow in and out, slowly, with the VTube Pro mark' },
  { id: 'sweep', name: 'Light sweep', blurb: 'A soft brand-colour light sweeps across the words' },
  { id: 'dots', name: 'Bouncing dots', blurb: 'Three dots bounce under the words, like someone is typing' },
];
export const BRB_DEFAULT_TEXT = 'Be Right Back';
export const DEFAULT_BRB: SceneBrbState = { style: 'breathe', theme: 'dark', text: '' };
/** Fade to / from black, seconds (the card fades in on the black after it). */
export const BRB_FADE_S = 0.8;
export const BRB_CARD_S = 0.45;

export const isBrbStyle = (v: unknown): v is string => typeof v === 'string' && BRB_STYLES.some((s) => s.id === v);
export const cleanBrbText = (v: unknown): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '');
export function sanitizeBrbState(o: unknown): SceneBrbState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const bg = x.bg && typeof x.bg === 'object' ? x.bg as Record<string, unknown> : null;
  const okBg = bg && (bg.kind === 'image' || bg.kind === 'video') && typeof bg.rev === 'number' && Number.isFinite(bg.rev) && bg.rev > 0;
  return { style: isBrbStyle(x.style) ? x.style : DEFAULT_BRB.style, theme: x.theme === 'light' ? 'light' : 'dark', text: cleanBrbText(x.text),
    ...(okBg ? { bg: { kind: bg!.kind as 'image' | 'video', rev: Math.round(bg!.rev as number) } } : {}) };
}

// ---- your own BRB screen (a picture or a short looping video, kept on this computer)
/** Biggest file the helper takes (bytes). */
export const BRB_BG_MAX = 40 * 1024 * 1024;
/** What a file is, from its first bytes (null = not a picture / video we can show). */
export function sniffBrbMedia(b: Uint8Array): { kind: 'image' | 'video'; ext: 'png' | 'jpg' | 'webp' | 'gif' | 'mp4' | 'webm' } | null {
  const at = (i: number, ...v: number[]) => v.every((x, k) => b[i + k] === x);
  const ascii = (i: number, t: string) => [...t].every((c, k) => b[i + k] === c.charCodeAt(0));
  if (at(0, 0x89, 0x50, 0x4e, 0x47)) return { kind: 'image', ext: 'png' };
  if (at(0, 0xff, 0xd8, 0xff)) return { kind: 'image', ext: 'jpg' };
  if (ascii(0, 'GIF8')) return { kind: 'image', ext: 'gif' };
  if (ascii(0, 'RIFF') && ascii(8, 'WEBP')) return { kind: 'image', ext: 'webp' };
  if (ascii(4, 'ftyp')) return { kind: 'video', ext: 'mp4' };
  if (at(0, 0x1a, 0x45, 0xdf, 0xa3)) return { kind: 'video', ext: 'webm' };
  return null;
}
/** Where pages load it from (same origin: the web helper shim routes it). */
export const brbBgUrl = (bg: { rev: number }) => `/api/brb/background?v=${bg.rev}`;
/** BRB is on (from the saved / effective scene state). */
export const brbOn = (s: { lights?: { state?: unknown } } | null | undefined) => s?.lights?.state === 'brb';
export const brbText = (b: SceneBrbState) => b.text || BRB_DEFAULT_TEXT;

/** Where a BRB fade is at `t` seconds after it switched (on = going to BRB). black = 0..1 opacity of the black layer,
 *  card = 0..1 opacity of the card. Pure (the overlay and the tests use it). */
export function brbFade(on: boolean, t: number): { black: number; card: number } {
  const c = (v: number) => Math.min(1, Math.max(0, v));
  if (on) return { black: c(t / BRB_FADE_S), card: c((t - BRB_FADE_S) / BRB_CARD_S) };
  // off: the card goes first (quickly), then the black fades away to the scene
  const cardOut = BRB_CARD_S * 0.6;
  return { black: 1 - c((t - cardOut) / BRB_FADE_S), card: 1 - c(t / cardOut) };
}
