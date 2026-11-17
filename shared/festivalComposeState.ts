// The host's composed-endshow choice (SceneFestivalState.compose): just the numbers every page composes the same show
// from (shared/festivalCompose.ts composeEndshow). Kept apart from the composer so the state sanitiser stays light.

/** the templates: a full endshow (~22 min: a cinematic intro, full-force tracks, a breather, the anthem, rising
 *  premieres, a near-dark final break, the finale), a short closing show (~12 min: an overture, the closing theme, the
 *  finale), a show in three acts (~30 min: an opener, a look back, the convergence + encore) and the inverted arc (open
 *  at full force, cut almost to dark, rebuild) */
export const COMPOSE_TEMPLATES = ['main', 'closing', 'acts3', 'inverted'] as const;
export type ComposeTemplate = (typeof COMPOSE_TEMPLATES)[number];
export const COMPOSE_LABEL: Record<ComposeTemplate, string> = { main: 'Full endshow', closing: 'Short closing show', acts3: 'Three acts', inverted: 'Inverted arc' };
/** default minutes per template and the range a host may ask for */
export const COMPOSE_MINUTES: Record<ComposeTemplate, [number, number, number]> = { main: [22, 12, 30], closing: [12, 8, 16], acts3: [30, 20, 40], inverted: [20, 12, 30] };

export interface ComposeState {
  /** template */
  t: ComposeTemplate;
  /** length (minutes) */
  min: number;
  /** the tempo the show is laid out at (BPM; the bars follow the music's beat when it plays) */
  bpm: number;
  /** variety: the same seed = the same show on every page */
  seed: number;
  /** where the anthem (the sing-along peak) sits, 0..1 of the show (the host's choice: real shows put it anywhere) */
  anthem: number;
  /** the host's own track lengths in bars (optional; else the template's arrangement) */
  tracks?: number[];
}
export const DEFAULT_COMPOSE: ComposeState = { t: 'main', min: 22, bpm: 150, seed: 1, anthem: 0.55 };

/** The festival route's compose fields (POST /api/scene/festival - server/routes/scenes.ts) into its command `args`:
 *  - compose: null | false | "room" → null: the stage's own endshow again
 *  - compose: "<template>" (+ min, anthem, bpm, seed) → that composed show; the seed is the body's, else from the clock
 *  - with endshow (1 = now, or an epoch ms) it plays; without one it only sets the choice up and STOPS what is playing
 *    (endshow 0): a playing show is never swapped mid-play
 *  A bare {endshow} start plays the stage's own endshow (shared/festival.ts festivalPatch drops the composed choice). */
export function composeArgs(b: Record<string, unknown>, now: number, args: Record<string, unknown>): void {
  if (b.compose === null || b.compose === false || b.compose === 'room') args.compose = null;
  else if (typeof b.compose === 'string' && b.compose in COMPOSE_MINUTES) {
    const c = sanitizeCompose({ t: b.compose, min: b.min, anthem: b.anthem, bpm: b.bpm, seed: typeof b.seed === 'number' && Number.isFinite(b.seed) ? b.seed : now % 1_000_000 });
    if (c) args.compose = c;
  }
  if ('compose' in args && args.endshow === undefined) args.endshow = 0;
}

/** The tempo a composed show is laid out for: the music's tempo now (the studio's beat input, once it has locked) -
 *  rounded and kept to what a composed show takes (60-240 BPM) - else 150. The show then lasts the minutes picked, and
 *  a hard tempo (166+ BPM) plays the hardcore house show. */
export function composeBpm(m: { on?: boolean; locked?: boolean; bpm?: number } | null | undefined): number {
  const b = m && m.on !== false && m.locked && typeof m.bpm === 'number' && Number.isFinite(m.bpm) && m.bpm > 0 ? m.bpm : 150;
  return Math.round(Math.min(240, Math.max(60, b)));
}
/** How long a composed show can still be playing (ms): its minutes at the tempo it was laid out for (+10 %: its blocks
 *  round the length), with headroom for music that slows down (to 100 BPM, and at least a quarter slower) - the Stop
 *  button stays while it may still play. */
export const composedLenMs = (min: number, bpm: number) => (min * 1.1 * Math.max(1.25, bpm / 100) + 1) * 60_000;
export function sanitizeCompose(raw: unknown): ComposeState | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  const t = typeof o.t === 'string' && (COMPOSE_TEMPLATES as readonly string[]).includes(o.t) ? o.t as ComposeTemplate : null;
  if (!t) return null;
  const n = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
  const [dm, lo, hi] = COMPOSE_MINUTES[t];
  const tracks = Array.isArray(o.tracks) ? o.tracks.filter((b): b is number => typeof b === 'number' && Number.isFinite(b)).slice(0, 16).map((b) => Math.round(Math.min(512, Math.max(16, b)))) : [];
  return { t, min: Math.round(n(o.min, lo, hi, dm) * 2) / 2, bpm: Math.round(n(o.bpm, 60, 240, 150)), seed: Math.round(n(o.seed, 0, 1e6, 1)), anthem: Math.round(n(o.anthem, 0.1, 0.9, DEFAULT_COMPOSE.anthem) * 100) / 100, ...(tracks.length >= 2 ? { tracks } : {}) };
}
