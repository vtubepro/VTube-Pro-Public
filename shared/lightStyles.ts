// Music lighting STYLES — room-agnostic, beat / bar / phrase / arrangement-aware light choreography (docs/SCENES.md
// "Music styles"). A style drives every show fixture of ANY room (each room's LIGHT_* fixtures / EMIT_* groups) as one
// spatial canvas: fixtures are placed by where they are (left → right, back → front, low → high, angle around the
// room centre), so sweeps, ping-pongs, spirals, shockwaves, call-and-response, rainbow rolls and "police" alternates
// read the same in a club, a kitchen or a forest. Each style has a layer per music section (groove / build / drop /
// breakdown), an accent layer for signs + neon, its own palette and the effects-rig moves it wants (beams, lasers).
// Pure data + pure maths: shared by the OBS page's light engine (src/scene/lightShow.ts) and the Scene tab's live
// mini previews (src/ui/lightsPanel.ts), so a preview is exactly what the room will do.

export type StylePattern = 'wash' | 'sweep' | 'pingpong' | 'spiral' | 'centerout' | 'wave' | 'kickstrobe' | 'snarestrobe' | 'blackout'
  | 'callresponse' | 'alternate' | 'stack' | 'bounce' | 'sparkle' | 'build' | 'breathe' | 'twin' | 'scanner' | 'heartbeat' | 'rain';
export type StyleColor = 'pair' | 'split' | 'alt' | 'rainbow' | 'police' | 'mono' | 'b' | 'phrase';
export interface StyleLayer {
  pat: StylePattern;
  /** pattern speed: cycles per bar (sweeps, spirals, waves) — 1 = one per bar */
  rate?: number;
  /** band width 0..1 (sweeps / scanners / rings) */
  width?: number;
  /** minimum level between hits (0 = full blackout, 1 = never dips) */
  floor?: number;
  color?: StyleColor;
  /** extra white flash on kicks (0..1, gated) */
  kick?: number;
}
export type StyleCat = 'sweeps' | 'hits' | 'colour' | 'moods' | 'signature';
export type BeamMotionName = 'sweep' | 'fan' | 'figure8' | 'ballyhoo' | 'circle' | 'wander' | 'cross' | 'still';
export type LaserName = 'fan' | 'cross' | 'tunnel' | 'sheet' | 'scan' | 'off';
export interface LightStyle {
  id: string; name: string; cat: StyleCat; vibe: string;
  /** 0 chill … 1 banger (the Auto picker) */
  energy: number;
  palette: [string, string][];
  groove: StyleLayer; build?: StyleLayer; drop?: StyleLayer; breakdown?: StyleLayer;
  /** signs + neon (default: a wash that pulses on kicks) */
  accent?: StyleLayer;
  beams?: Partial<Record<StyleSection, BeamMotionName>>;
  lasers?: Partial<Record<StyleSection, LaserName>>;
}
export type StyleSection = 'groove' | 'build' | 'drop' | 'breakdown';

const L = (pat: StylePattern, o: Partial<StyleLayer> = {}): StyleLayer => ({ pat, ...o });
const BW: [string, string][] = [['#8dff3a', '#ff3fd2'], ['#35e3ff', '#8dff3a'], ['#ff3fd2', '#b026ff'], ['#ffd23a', '#8dff3a']];

export const LIGHT_STYLES: LightStyle[] = [
  // ---------------------------------------------------------------- sweeps + chases
  { id: 'laser_sweep', name: 'Laser Sweep', cat: 'sweeps', vibe: 'A bright bar sweeps the room left → right every bar; the drop fires shockwaves', energy: 0.6,
    palette: [['#00e5ff', '#ff2bd6'], ['#7c3cff', '#00ff9c'], ['#ff5a00', '#ffd000']],
    groove: L('sweep', { rate: 1, width: 0.28, floor: 0.12, color: 'pair' }), build: L('build', { color: 'pair' }), drop: L('centerout', { width: 0.25, floor: 0.2, color: 'alt', kick: 0.7 }),
    breakdown: L('breathe', { rate: 0.25, floor: 0.15, color: 'mono' }), beams: { groove: 'sweep', build: 'fan', drop: 'ballyhoo', breakdown: 'still' }, lasers: { groove: 'fan', build: 'scan', drop: 'tunnel', breakdown: 'off' } },
  { id: 'pingpong', name: 'Ping-Pong', cat: 'sweeps', vibe: 'Light bounces wall to wall on the beat, colours swap on each hit', energy: 0.55,
    palette: [['#ff2bd6', '#00e5ff'], ['#ffd000', '#7c3cff']],
    groove: L('pingpong', { rate: 1, width: 0.22, floor: 0.1, color: 'split' }), build: L('pingpong', { rate: 2, width: 0.18, floor: 0.08, color: 'split' }),
    drop: L('alternate', { floor: 0.1, color: 'alt', kick: 0.6 }), breakdown: L('wave', { rate: 0.25, floor: 0.2, color: 'pair' }), beams: { groove: 'cross', drop: 'ballyhoo' }, lasers: { groove: 'scan', drop: 'cross' } },
  { id: 'twin_chase', name: 'Twin Chase', cat: 'sweeps', vibe: 'Two chases race in from both walls and crash in the middle', energy: 0.55,
    palette: [['#00ffd5', '#ff4fd8'], ['#ff7a2b', '#35e3ff']],
    groove: L('twin', { rate: 1, width: 0.2, floor: 0.1, color: 'split' }), build: L('twin', { rate: 2, width: 0.15, floor: 0.06, color: 'split' }),
    drop: L('centerout', { width: 0.3, floor: 0.2, color: 'alt', kick: 0.6 }), breakdown: L('breathe', { rate: 0.5, floor: 0.2, color: 'pair' }), beams: { groove: 'fan', drop: 'circle' }, lasers: { groove: 'fan', drop: 'sheet' } },
  { id: 'scanner', name: 'Scanner', cat: 'sweeps', vibe: 'A thin red eye scans back and forth (retro sci-fi); drops go white', energy: 0.45,
    palette: [['#ff2020', '#ff9a3a'], ['#ff2bd6', '#ffffff']],
    groove: L('scanner', { rate: 0.5, width: 0.12, floor: 0.04, color: 'mono' }), build: L('scanner', { rate: 1.5, width: 0.1, floor: 0.04, color: 'mono' }),
    drop: L('kickstrobe', { floor: 0.08, color: 'pair', kick: 1 }), breakdown: L('scanner', { rate: 0.25, width: 0.2, floor: 0.06, color: 'mono' }), beams: { groove: 'still', drop: 'sweep' }, lasers: { groove: 'scan', drop: 'fan' } },
  { id: 'spiral_galaxy', name: 'Spiral Galaxy', cat: 'sweeps', vibe: 'Colour spins around the room like a galaxy arm, faster in builds', energy: 0.65,
    palette: [['#7a2bff', '#2b6bff'], ['#b04bff', '#00e5ff'], ['#5a00ff', '#ff00d4']],
    groove: L('spiral', { rate: 0.5, width: 0.3, floor: 0.12, color: 'pair' }), build: L('spiral', { rate: 2, width: 0.25, floor: 0.1, color: 'pair' }),
    drop: L('spiral', { rate: 1, width: 0.4, floor: 0.25, color: 'rainbow', kick: 0.6 }), breakdown: L('breathe', { rate: 0.25, floor: 0.2, color: 'b' }), beams: { groove: 'circle', drop: 'figure8' }, lasers: { groove: 'tunnel', drop: 'tunnel' } },
  { id: 'rain', name: 'Neon Rain', cat: 'sweeps', vibe: 'Light drips from the ceiling to the floor on every beat', energy: 0.45,
    palette: [['#35e3ff', '#b026ff'], ['#8dff3a', '#35e3ff']],
    groove: L('rain', { rate: 1, width: 0.3, floor: 0.12, color: 'pair' }), build: L('rain', { rate: 2, width: 0.25, floor: 0.1, color: 'pair' }),
    drop: L('wash', { floor: 0.5, color: 'phrase', kick: 0.8 }), breakdown: L('rain', { rate: 0.25, width: 0.4, floor: 0.15, color: 'mono' }), beams: { groove: 'wander' }, lasers: { groove: 'sheet' } },
  // ---------------------------------------------------------------- strobes + hits
  { id: 'kick_hits', name: 'Kick Hits', cat: 'hits', vibe: 'Dark room, every kick punches the whole rig — tight and heavy', energy: 0.8,
    palette: [['#ffffff', '#ff2bd6'], ['#ffffff', '#00e5ff']],
    groove: L('kickstrobe', { floor: 0.06, color: 'phrase' }), build: L('build', { color: 'pair' }), drop: L('blackout', { color: 'alt', kick: 1 }),
    breakdown: L('breathe', { rate: 0.5, floor: 0.1, color: 'b' }), beams: { groove: 'still', drop: 'ballyhoo' }, lasers: { groove: 'off', drop: 'fan' } },
  { id: 'blackout_hit', name: 'Blackout → Hit', cat: 'hits', vibe: 'Pitch black between hits, then everything slams on — pure drama', energy: 0.9,
    palette: [['#ff2b2b', '#ffffff'], ['#ff00d4', '#ffffff']],
    groove: L('blackout', { color: 'pair' }), build: L('build', { color: 'mono' }), drop: L('blackout', { color: 'b', kick: 1 }), breakdown: L('wash', { floor: 0.05, color: 'mono' }),
    beams: { groove: 'still', drop: 'ballyhoo' }, lasers: { groove: 'off', drop: 'cross' } },
  { id: 'strobe_storm', name: 'Strobe Storm', cat: 'hits', vibe: 'Kicks and snares trade strobe hits across the room (safe-gated)', energy: 0.95,
    palette: [['#ffffff', '#7c3cff'], ['#ffffff', '#00ff9c']],
    groove: L('snarestrobe', { floor: 0.1, color: 'split', kick: 0.5 }), build: L('build', { color: 'b' }), drop: L('kickstrobe', { floor: 0.05, color: 'alt', kick: 1 }),
    breakdown: L('sparkle', { floor: 0.05, color: 'b' }), beams: { groove: 'ballyhoo', drop: 'ballyhoo' }, lasers: { groove: 'cross', drop: 'tunnel' } },
  { id: 'shockwave', name: 'Shockwave', cat: 'hits', vibe: 'Rings of light blast out from the centre on every kick', energy: 0.8,
    palette: [['#00e5ff', '#ffffff'], ['#ff2bd6', '#ffd000']],
    groove: L('centerout', { width: 0.22, floor: 0.08, color: 'pair' }), build: L('build', { color: 'pair' }), drop: L('centerout', { width: 0.35, floor: 0.2, color: 'rainbow', kick: 0.8 }),
    breakdown: L('breathe', { rate: 0.5, floor: 0.12, color: 'mono' }), beams: { groove: 'fan', drop: 'circle' }, lasers: { groove: 'tunnel', drop: 'tunnel' } },
  { id: 'heartbeat', name: 'Heartbeat', cat: 'hits', vibe: 'Lub-dub double pulses in deep red and pink', energy: 0.5,
    palette: [['#ff1a3c', '#ff4fd8'], ['#c8003c', '#ff8aa8']],
    groove: L('heartbeat', { floor: 0.12, color: 'pair' }), build: L('heartbeat', { floor: 0.2, color: 'b' }), drop: L('kickstrobe', { floor: 0.2, color: 'pair', kick: 0.6 }),
    breakdown: L('heartbeat', { floor: 0.08, color: 'mono' }), beams: { groove: 'still', drop: 'fan' }, lasers: { groove: 'off', drop: 'fan' } },
  { id: 'police', name: 'Police Lights', cat: 'hits', vibe: 'Red / blue halves trade on every beat — for chaos and raids', energy: 0.75,
    palette: [['#ff1010', '#1040ff']],
    groove: L('alternate', { floor: 0.06, color: 'police' }), build: L('alternate', { floor: 0.04, color: 'police', rate: 2 }), drop: L('kickstrobe', { floor: 0.05, color: 'police', kick: 0.8 }),
    breakdown: L('breathe', { rate: 0.5, floor: 0.1, color: 'police' }), beams: { groove: 'cross', drop: 'ballyhoo' }, lasers: { groove: 'cross', drop: 'cross' } },
  // ---------------------------------------------------------------- colour
  { id: 'rainbow_roll', name: 'Rainbow Roll', cat: 'colour', vibe: 'A rainbow rolls across the room, one lap per bar', energy: 0.55,
    palette: [['#ff0000', '#00ffff']],
    groove: L('wave', { rate: 0.5, floor: 0.35, color: 'rainbow' }), build: L('wave', { rate: 2, floor: 0.25, color: 'rainbow' }), drop: L('centerout', { width: 0.4, floor: 0.35, color: 'rainbow', kick: 0.6 }),
    breakdown: L('wave', { rate: 0.125, floor: 0.3, color: 'rainbow' }), beams: { groove: 'figure8', drop: 'circle' }, lasers: { groove: 'fan', drop: 'tunnel' } },
  { id: 'phrase_wash', name: 'Phrase Wash', cat: 'colour', vibe: 'Big washes that change colour every phrase and on drops, breathing with the kick', energy: 0.4,
    palette: [['#ff2bd6', '#00e5ff'], ['#7c3cff', '#00ff9c'], ['#ff5a00', '#ffd000'], ['#00a2ff', '#ff006a']],
    groove: L('wash', { floor: 0.55, color: 'phrase', kick: 0.25 }), build: L('build', { color: 'phrase' }), drop: L('wash', { floor: 0.7, color: 'phrase', kick: 0.7 }),
    breakdown: L('breathe', { rate: 0.25, floor: 0.3, color: 'phrase' }), beams: { groove: 'wander', drop: 'fan' }, lasers: { groove: 'off', drop: 'fan' } },
  { id: 'call_response', name: 'Call & Response', cat: 'colour', vibe: 'Left side calls on 1 & 3, the right side answers on 2 & 4', energy: 0.6,
    palette: [['#ff2bd6', '#00e5ff'], ['#ffd000', '#00ff9c']],
    groove: L('callresponse', { floor: 0.1, color: 'split' }), build: L('callresponse', { floor: 0.08, color: 'split', rate: 2 }), drop: L('alternate', { floor: 0.15, color: 'split', kick: 0.7 }),
    breakdown: L('wave', { rate: 0.25, floor: 0.2, color: 'split' }), beams: { groove: 'cross', drop: 'cross' }, lasers: { groove: 'cross', drop: 'cross' } },
  { id: 'stack_build', name: 'Stack & Drop', cat: 'colour', vibe: 'Fixtures stack up across each bar, the downbeat resets — builds explode', energy: 0.7,
    palette: [['#00ff9c', '#ff2bd6'], ['#ffd000', '#00a2ff']],
    groove: L('stack', { floor: 0.08, color: 'pair' }), build: L('build', { color: 'pair' }), drop: L('wash', { floor: 0.6, color: 'alt', kick: 0.9 }),
    breakdown: L('breathe', { rate: 0.5, floor: 0.12, color: 'mono' }), beams: { groove: 'fan', drop: 'ballyhoo' }, lasers: { groove: 'scan', drop: 'fan' } },
  { id: 'bounce', name: 'Floor to Ceiling', cat: 'colour', vibe: 'Light bounces from the floor up to the rig on every beat', energy: 0.55,
    palette: [['#35e3ff', '#ff3fd2'], ['#8dff3a', '#ffd23a']],
    groove: L('bounce', { width: 0.3, floor: 0.12, color: 'pair' }), build: L('bounce', { width: 0.25, floor: 0.08, color: 'pair', rate: 2 }), drop: L('centerout', { width: 0.3, floor: 0.2, color: 'alt', kick: 0.7 }),
    breakdown: L('breathe', { rate: 0.5, floor: 0.15, color: 'b' }), beams: { groove: 'fan', drop: 'figure8' }, lasers: { groove: 'sheet', drop: 'tunnel' } },
  // ---------------------------------------------------------------- moods
  { id: 'halftime', name: 'Half-time Mood', cat: 'moods', vibe: 'Slow, heavy swells every two bars in cold blues', energy: 0.2,
    palette: [['#2b6bff', '#7a2bff'], ['#00d0ff', '#4b2bff']],
    groove: L('breathe', { rate: 0.5, floor: 0.12, color: 'pair' }), build: L('wave', { rate: 0.5, floor: 0.2, color: 'pair' }), drop: L('wash', { floor: 0.6, color: 'pair', kick: 0.4 }),
    breakdown: L('breathe', { rate: 0.25, floor: 0.08, color: 'mono' }), beams: { groove: 'still', drop: 'wander' }, lasers: { groove: 'off' } },
  { id: 'sunset_drift', name: 'Sunset Drift', cat: 'moods', vibe: 'Warm oranges drifting across the room, lazy and golden', energy: 0.15,
    palette: [['#ff7a2b', '#ffb347'], ['#ff3d6e', '#ffa53b']],
    groove: L('wave', { rate: 0.125, floor: 0.35, color: 'pair' }), drop: L('wave', { rate: 0.5, floor: 0.45, color: 'pair', kick: 0.3 }), breakdown: L('breathe', { rate: 0.125, floor: 0.3, color: 'pair' }),
    beams: { groove: 'wander' }, lasers: { groove: 'off' } },
  { id: 'sparkle', name: 'Glitter', cat: 'moods', vibe: 'Random fixtures twinkle on the hi-hats over a soft wash', energy: 0.35,
    palette: [['#e8f6ff', '#9fb8ff'], ['#ffd8f8', '#b0fff4']],
    groove: L('sparkle', { floor: 0.2, color: 'pair' }), build: L('sparkle', { floor: 0.1, color: 'b', rate: 2 }), drop: L('sparkle', { floor: 0.4, color: 'rainbow', kick: 0.5 }),
    breakdown: L('sparkle', { floor: 0.1, color: 'mono', rate: 0.5 }), beams: { groove: 'still' }, lasers: { groove: 'off' } },
  { id: 'afterglow', name: 'Afterglow', cat: 'moods', vibe: 'Long warm tails sweeping slowly — the outro of the night', energy: 0.2,
    palette: [['#ff9a4a', '#ff4fd8'], ['#ffcf7a', '#c83dff']],
    groove: L('sweep', { rate: 0.25, width: 0.6, floor: 0.25, color: 'pair' }), drop: L('sweep', { rate: 0.5, width: 0.6, floor: 0.35, color: 'pair', kick: 0.3 }),
    breakdown: L('breathe', { rate: 0.125, floor: 0.25, color: 'pair' }), beams: { groove: 'wander' }, lasers: { groove: 'off' } },
  // ---------------------------------------------------------------- signature
  { id: 'neon_rave', name: 'Neon Rave', cat: 'signature', vibe: 'Acid green ↔ neon pink: sweeps in the groove, shockwaves on the drop', energy: 0.85,
    palette: BW,
    groove: L('sweep', { rate: 1, width: 0.3, floor: 0.15, color: 'split' }), build: L('build', { color: 'pair' }), drop: L('centerout', { width: 0.3, floor: 0.25, color: 'alt', kick: 0.8 }),
    breakdown: L('breathe', { rate: 0.5, floor: 0.15, color: 'mono' }), accent: L('wash', { floor: 0.6, color: 'pair', kick: 0.6 }),
    beams: { groove: 'fan', build: 'sweep', drop: 'ballyhoo', breakdown: 'still' }, lasers: { groove: 'fan', build: 'scan', drop: 'tunnel', breakdown: 'off' } },
  { id: 'neon_tide', name: 'Neon Tide', cat: 'signature', vibe: 'Slow green / purple waves with fireflies of light on the hats', energy: 0.4,
    palette: [['#5dff7a', '#b026ff'], ['#8dff3a', '#35e3ff']],
    groove: L('wave', { rate: 0.25, floor: 0.3, color: 'pair' }), build: L('sparkle', { floor: 0.2, color: 'pair', rate: 2 }), drop: L('wave', { rate: 1, floor: 0.4, color: 'alt', kick: 0.6 }),
    breakdown: L('sparkle', { floor: 0.15, color: 'mono' }), accent: L('breathe', { rate: 0.5, floor: 0.5, color: 'pair' }), beams: { groove: 'wander', drop: 'figure8' }, lasers: { groove: 'sheet', drop: 'fan' } },
  { id: 'hopscotch', name: 'Hopscotch', cat: 'signature', vibe: 'Hops of light fixture to fixture (left, right, jump!) with a pink splash on the drop', energy: 0.6,
    palette: [['#4dff9a', '#ff3fd2'], ['#8dff3a', '#ffd23a']],
    groove: L('pingpong', { rate: 2, width: 0.18, floor: 0.12, color: 'pair' }), build: L('build', { color: 'pair' }), drop: L('centerout', { width: 0.3, floor: 0.3, color: 'b', kick: 0.9 }),
    breakdown: L('wave', { rate: 0.25, floor: 0.25, color: 'mono' }), beams: { groove: 'fan', drop: 'circle' }, lasers: { groove: 'fan', drop: 'tunnel' } },
];
export const STYLE_CATS: { id: StyleCat; label: string }[] = [
  { id: 'signature', label: 'Signature' }, { id: 'sweeps', label: 'Sweeps & chases' }, { id: 'hits', label: 'Strobes & hits' }, { id: 'colour', label: 'Colour' }, { id: 'moods', label: 'Moods' },
];
/**
 * Retired style ids → their current id. Saved scenes, saved "my styles", deck buttons and Stream Deck / HTTP scripts
 * ({"style":"frog_rave"}) made before a rename keep working. Never remove an entry (old saves live forever).
 */
export const STYLE_ID_ALIASES: Readonly<Record<string, string>> = { frog_rave: 'neon_rave', neon_swamp: 'neon_tide', lily_pad: 'hopscotch' };
/** A style id, old or new → the current id (unknown ids, 'auto', 'u:N' come back unchanged). */
export const canonStyleId = <T extends string | undefined>(id: T): T =>
  (typeof id === 'string' && Object.prototype.hasOwnProperty.call(STYLE_ID_ALIASES, id) ? STYLE_ID_ALIASES[id] : id) as T;
const BY_ID = new Map(LIGHT_STYLES.map((s) => [s.id, s]));
export const styleById = (id: string | undefined): LightStyle | undefined => (id ? BY_ID.get(canonStyleId(id)) : undefined);

// ---------------------------------------------------------------- the host's saved styles + options
export interface UserLightStyle { name: string; base: string; palette?: [string, string][]; speed?: number }
export interface LightStyleOpts { speed: number; strobes: boolean; states: ('preshow' | 'show' | 'outro' | 'react' | 'brb')[] }
export const DEFAULT_STYLE_OPTS: LightStyleOpts = { speed: 1, strobes: true, states: ['preshow', 'show', 'outro'] };
const HEX = /^#[0-9a-fA-F]{6}$/;
export function sanitizeLightStyleId(v: unknown): string {
  if (typeof v !== 'string') return '';
  const id = canonStyleId(v);
  if (id === 'auto' || BY_ID.has(id) || /^u:\d{1,2}$/.test(id)) return id;
  return '';
}
export function sanitizeUserStyles(o: unknown): UserLightStyle[] | undefined {
  if (!Array.isArray(o)) return undefined;
  const out: UserLightStyle[] = [];
  for (const x of o.slice(0, 12)) {
    if (!x || typeof x !== 'object') continue;
    const r = x as Record<string, unknown>;
    const base = typeof r.base === 'string' ? canonStyleId(r.base) : '';
    if (!BY_ID.has(base)) continue;
    const pal = Array.isArray(r.palette) ? r.palette.filter((p) => Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === 'string' && HEX.test(c))).slice(0, 6) as [string, string][] : undefined;
    out.push({ name: String(r.name ?? 'My style').slice(0, 32) || 'My style', base, ...(pal && pal.length ? { palette: pal } : {}),
      ...(typeof r.speed === 'number' && Number.isFinite(r.speed) ? { speed: Math.min(2, Math.max(0.5, r.speed)) } : {}) });
  }
  return out.length ? out : undefined;
}
export function sanitizeStyleOpts(o: unknown): LightStyleOpts {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const ok = new Set(['preshow', 'show', 'outro', 'react', 'brb']);
  const states = Array.isArray(x.states) ? x.states.filter((s): s is LightStyleOpts['states'][number] => typeof s === 'string' && ok.has(s)) : DEFAULT_STYLE_OPTS.states;
  return { speed: typeof x.speed === 'number' && Number.isFinite(x.speed) ? Math.min(2, Math.max(0.5, x.speed)) : 1, strobes: x.strobes !== false, states };
}
/** A style id (+ the host's saved styles) → the style to run and its palette / speed. */
export function resolveStyle(id: string | undefined, user?: UserLightStyle[]): { style: LightStyle; palette: [string, string][]; speed: number } | null {
  if (!id || id === 'none' || id === 'auto') return null;
  const m = /^u:(\d+)$/.exec(id);
  if (m) {
    const u = user?.[+m[1]]; const s = u && BY_ID.get(canonStyleId(u.base));
    return s ? { style: s, palette: u.palette ?? s.palette, speed: u.speed ?? 1 } : null;
  }
  const s = BY_ID.get(canonStyleId(id));
  return s ? { style: s, palette: s.palette, speed: 1 } : null;
}

// ---------------------------------------------------------------- Auto: pick a style from the music's energy
const AUTO: Record<'chill' | 'mid' | 'banger', string[]> = {
  chill: ['halftime', 'sunset_drift', 'neon_tide', 'sparkle', 'phrase_wash'],
  mid: ['laser_sweep', 'pingpong', 'call_response', 'rainbow_roll', 'twin_chase', 'scanner', 'heartbeat', 'bounce', 'hopscotch', 'rain'],
  banger: ['neon_rave', 'shockwave', 'strobe_storm', 'spiral_galaxy', 'kick_hits', 'blackout_hit', 'stack_build', 'police'],
};
/** Auto mode: one style per 16-bar block (and a fresh one on every drop), from the energy class of the block. */
export function autoStyle(block: number, dropSeq: number, energy: number, section: string): LightStyle {
  const cls = section === 'breakdown' || energy < 0.35 ? 'chill' : energy > 0.7 || section === 'drop' ? 'banger' : 'mid';
  const list = AUTO[cls];
  let h = 2166136261; for (const c of `${block}:${dropSeq}:${cls}`) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
  return BY_ID.get(list[(h >>> 0) % list.length])!;
}

// ---------------------------------------------------------------- the pattern maths
/** Where a fixture is (normalised over the room's fixtures). */
export interface FixGeo { x: number; y: number; z: number; ang: number; r: number; i: number; n: number; seed: number }
/** The musical moment. Ages in ms (Infinity = never). */
export interface StyleIn {
  beat: number; barPos: number; bar: number; phrase: number; kickAge: number; snareAge: number; hatAge: number; hatSeq: number; kickSeq: number; snareSeq: number;
  dropAge: number; energy: number; buildK: number; speed: number; strobes: boolean;
  /** photosensitivity gate: depth 0.1..1 for a flash `key` that started `at` (epoch ms) — see lightShow.ts FlashGate */
  gate: (key: string, at: number) => number;
  now: number;
}
export interface StyleOut { lv: number; mix: number; hue: number; white: number }
// The photosensitivity gate's depth for a frame's kick / snare is the same for every fixture, so it is asked once per
// frame (gate, hit, start time, now) instead of once per fixture. Every new frame (another `now`), hit, start time or
// gate (the Light styles preview has its own) asks the gate again, so it sees every frame exactly as before.
type GateMemo = { gate: StyleIn['gate'] | null; seq: number; at: number; now: number; v: number };
const KICK_GATE: GateMemo = { gate: null, seq: NaN, at: NaN, now: NaN, v: 1 }, SNARE_GATE: GateMemo = { gate: null, seq: NaN, at: NaN, now: NaN, v: 1 };
function gateOnce(m: GateMemo, s: StyleIn, p: string, seq: number, at: number): number {
  if (m.gate !== s.gate || m.seq !== seq || m.at !== at || m.now !== s.now) { m.gate = s.gate; m.seq = seq; m.at = at; m.now = s.now; m.v = s.gate(p + seq, at); }
  return m.v;
}
const frac = (x: number) => x - Math.floor(x);
const band = (d: number, w: number) => Math.max(0, 1 - Math.abs(d) / Math.max(0.02, w));
const cyc = (d: number) => { const f = frac(d); return Math.min(f, 1 - f); };       // distance on a unit circle

export function styleEval(layer: StyleLayer, f: FixGeo, s: StyleIn, out: StyleOut): StyleOut {
  const rate = (layer.rate ?? 1) * s.speed;
  const w = layer.width ?? 0.25;
  const floor = layer.floor ?? 0.1;
  const barU = s.bar + s.barPos / 4;                                   // continuous bars
  const beatFrac = frac(s.beat);
  let kick = 0, snare = 0;
  if (s.kickAge < 900) kick = Math.exp(-s.kickAge / 150) * gateOnce(KICK_GATE, s, 'k', s.kickSeq, s.now - s.kickAge);
  if (s.snareAge < 900) snare = Math.exp(-s.snareAge / 110) * gateOnce(SNARE_GATE, s, 's', s.snareSeq, s.now - s.snareAge);
  let lv = floor, mix = 0, hue = 0, white = 0;
  const side = f.x < 0.5 ? 0 : 1;
  switch (layer.pat) {
    case 'wash': lv = floor + (1 - floor) * 0.25 + (1 - floor) * 0.75 * kick; break;
    case 'sweep': { const head = frac(barU * rate); lv = floor + (1 - floor) * Math.max(band(f.x - head, w), band(f.x - head + 1, w) * 0.6); mix = f.x; break; }
    case 'pingpong': { const p = frac(barU * rate); const head = p < 0.5 ? p * 2 : 2 - p * 2; lv = floor + (1 - floor) * band(f.x - head, w); mix = p < 0.5 ? 0 : 1; break; }
    case 'twin': { const p = frac(barU * rate) * 0.5; lv = floor + (1 - floor) * Math.max(band(f.x - p, w), band(f.x - (1 - p), w)); mix = side; break; }
    case 'scanner': { const p = frac(barU * rate); const head = 0.5 - 0.5 * Math.cos(p * Math.PI * 2); lv = floor + (1 - floor) * Math.pow(band(f.x - head, w), 1.5); break; }
    case 'spiral': { const head = frac(barU * rate); const d = cyc(f.ang - head - f.r * 0.35); lv = floor + (1 - floor) * band(d, w * 0.5); mix = f.r; break; }
    case 'centerout': { const age = Math.min(s.kickAge, 900) / 1000; const ring = age * 1.6; lv = floor + (1 - floor) * band(f.r - ring, w) * (s.kickAge < 900 ? 1 : 0); mix = frac(s.beat / 2) < 0.5 ? 0 : 1; break; }
    case 'wave': { const ph = f.x - barU * rate; lv = floor + (1 - floor) * (0.5 + 0.5 * Math.sin(ph * Math.PI * 2)); mix = 0.5 + 0.5 * Math.sin(ph * Math.PI * 2 + 1.5); hue = frac(ph); break; }
    case 'kickstrobe': lv = floor + (1 - floor) * kick * (s.strobes ? 1 : 0.6); white = s.strobes ? kick * 0.5 : 0; break;
    case 'snarestrobe': lv = floor + (1 - floor) * Math.max(side ? snare : kick * 0.8, 0) * (s.strobes ? 1 : 0.6); white = s.strobes ? snare * 0.6 : 0; break;
    case 'blackout': lv = 0.02 + 0.98 * Math.pow(kick, 1.4); white = s.strobes ? kick * 0.35 : 0; break;
    case 'callresponse': { const bIdx = Math.floor(s.beat * (layer.rate ?? 1)); const mine = (bIdx % 2) === side; const age = frac(s.beat * (layer.rate ?? 1)); lv = floor + (1 - floor) * (mine ? Math.exp(-age * 3) : 0); mix = side; break; }
    case 'alternate': { const bIdx = Math.floor(s.beat * (layer.rate ?? 1)); const mine = ((f.i + bIdx) % 2) === 0; const age = frac(s.beat * (layer.rate ?? 1)); lv = floor + (1 - floor) * (mine ? Math.exp(-age * 2.2) : 0); mix = side; break; }
    case 'stack': { const k = s.barPos / 4; lv = f.x <= k + 0.02 ? floor + (1 - floor) * (0.55 + 0.45 * Math.exp(-(k - f.x) * 6)) : floor; mix = k; break; }
    case 'bounce': { const p = frac(s.beat * (layer.rate ?? 1)); const head = p < 0.5 ? p * 2 : 2 - p * 2; lv = floor + (1 - floor) * band(f.y - head, w); mix = f.y; break; }
    case 'rain': { const head = 1 - frac(s.beat * rate / 4 * 4 / 4); lv = floor + (1 - floor) * band(f.y - head, w) * (0.7 + 0.3 * Math.sin(f.x * 17 + f.z * 9)); mix = f.x; break; }
    case 'sparkle': { const tw = Math.floor(s.hatSeq * (layer.rate ?? 1)); const hit = frac(Math.sin((f.seed * 97 + tw) * 12.9898) * 43758.5453) < 0.28; const age = Math.min(s.hatAge, 600); lv = floor + (1 - floor) * (hit ? Math.exp(-age / 160) : 0); mix = frac(f.seed * 7); break; }
    case 'build': {
      // rising level + accelerating pulses (1/4 → 1/8 → 1/16) as the build progresses; with safe flashes the
      // subdivisions stop at the gate's rate and a quickening sweep carries the rest
      const k = Math.max(0, Math.min(1, s.buildK));
      const sub = k < 0.4 ? 1 : k < 0.75 ? 2 : 4;
      const ph = frac(s.beat * sub);
      const pulse = Math.exp(-ph * 4) * s.gate(`b${Math.floor(s.beat * sub)}`, s.now - ph * 60000 / 128 / sub);
      const sweep = band(f.x - frac(barU * (1 + k * 3)), 0.25);
      lv = 0.1 + 0.35 * k + (0.55 * pulse + 0.25 * sweep) * (0.5 + 0.5 * k); white = s.strobes ? k * k * pulse * 0.35 : 0; mix = k; break;
    }
    case 'breathe': { const u = barU * rate; lv = floor + (1 - floor) * (0.5 - 0.5 * Math.cos(2 * Math.PI * u)) * (0.8 + 0.2 * Math.sin(f.x * 6 + u)); mix = 0.5 - 0.5 * Math.cos(Math.PI * u); break; }
    case 'heartbeat': { const p = beatFrac; const lub = Math.exp(-p * 9), dub = p > 0.28 ? Math.exp(-(p - 0.28) * 9) * 0.7 : 0; lv = floor + (1 - floor) * Math.max(lub, dub); mix = p > 0.28 ? 1 : 0; break; }
  }
  // colour mode → mix / hue
  switch (layer.color ?? 'pair') {
    case 'split': mix = side; break;
    case 'alt': mix = (f.i + Math.floor(s.beat)) % 2; break;
    case 'rainbow': hue = frac(hue + f.x * 0.8 + barU * 0.25); mix = 0; break;
    case 'police': mix = (Math.floor(s.beat * (layer.rate ?? 1)) + side) % 2; break;
    case 'mono': mix = 0; break;
    case 'b': mix = 1; break;
    case 'phrase': mix = s.phrase % 2; break;
  }
  if (layer.kick) { const k2 = kick * layer.kick; lv = Math.max(lv, floor + (1 - floor) * k2); white = Math.max(white, s.strobes ? k2 * 0.4 : 0); }
  // drop hit: one big gated white flash as the drop lands
  if (s.dropAge >= 0 && s.dropAge < 500) { const d = Math.exp(-s.dropAge / 140); lv = Math.max(lv, d * 1.3); white = Math.max(white, d * 0.8); }
  out.lv = Math.max(0, Math.min(1.6, lv)); out.mix = Math.max(0, Math.min(1, mix)); out.hue = layer.color === 'rainbow' ? hue : 0; out.white = Math.max(0, Math.min(1, white));
  return out;
}

/** Which layer a section plays. */
export function styleLayer(st: LightStyle, sec: StyleSection): StyleLayer {
  return (sec === 'build' ? st.build : sec === 'drop' ? st.drop : sec === 'breakdown' ? st.breakdown : undefined) ?? st.groove;
}

// ---------------------------------------------------------------- support celebrations (room-wide overlays)
export type LightCue = 'donation' | 'tip' | 'sub' | 'bits' | 'raid' | 'big';
/** overlay for a cue `age` ms after it started: returns the extra level (0 = none) + its colour mode */
/** `safe` (the flash limit is on): sparkles and rolls run slow enough to stay under 3 flashes a second by design (the
 *  output governor, shared/flashGovernor.ts, enforces it either way). */
export function cueEval(cue: LightCue, f: FixGeo, age: number, strobes: boolean, out: { lv: number; color: string; white: number }, safe = false) {
  out.lv = 0; out.white = 0; out.color = '#ffffff';
  const t = age / 1000;
  switch (cue) {
    case 'donation': case 'tip': {            // two gold sweeps left → right
      if (t > 2.2) return out;
      const head = frac(t / 1.1) * 1.3 - 0.15; out.lv = band(f.x - head, 0.22) * 1.2; out.color = '#ffd84a'; break;
    }
    case 'sub': {                              // a rainbow roll burst
      if (t > 2.6) return out;
      const k = Math.min(1, t / 0.2) * (1 - Math.max(0, (t - 2.0) / 0.6));
      out.lv = k * (0.6 + 0.6 * (0.5 + 0.5 * Math.sin((f.x - t * (safe ? 0.5 : 1.5)) * Math.PI * 4)));
      const hh = frac(f.x * 0.9 + t * 0.8); out.color = '#' + hslHex(hh, 1, 0.55); break;
    }
    case 'bits': {                             // a sparkle burst
      if (t > 1.8) return out;
      const hit = frac(Math.sin((f.seed * 131 + Math.floor(t * (safe ? 1.5 : 12))) * 12.9898) * 43758.5453) < 0.35;
      out.lv = hit ? 1.1 * (1 - t / 1.8) : 0; out.color = '#9ff4ff'; out.white = hit && strobes ? 0.4 : 0; break;
    }
    case 'raid': {                             // blackout, then rings of red / pink blasting out
      if (t > 5) return out;
      if (t < 0.4) { out.lv = -1; return out; }
      const ring = frac((t - 0.4) / 0.9) * 1.4;
      out.lv = band(f.r - ring, 0.3) * 1.3; out.color = Math.floor((t - 0.4) / 0.9) % 2 ? '#ff2bd6' : '#ff2020'; out.white = strobes && t < 0.6 ? 0.8 : 0; break;
    }
    case 'big': {                              // three gold shockwaves + a white hit
      if (t > 4) return out;
      const ring = frac(t / 1.2) * 1.4;
      out.lv = band(f.r - ring, 0.35) * 1.4 + (t < 0.3 ? 1 - t / 0.3 : 0); out.color = '#ffd84a'; out.white = strobes && t < 0.3 ? 0.7 : 0; break;
    }
  }
  return out;
}
function hslHex(h: number, s: number, l: number) {
  const f = (n: number) => { const k = (n + h * 12) % 12; const a = s * Math.min(l, 1 - l); const c = l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1)); return Math.round(c * 255).toString(16).padStart(2, '0'); };
  return f(0) + f(8) + f(4);
}
