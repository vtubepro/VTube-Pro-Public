// What a light group IS in the room, from its name — so the music only moves the lights that should move.
// Before (beta.12): every group whose name wasn't sign / neon / spot / … pulsed on every kick: candles, chandeliers,
// windows, monitors, nav lights and ceiling lamps all flashed with the music. Real lighting designers never do that:
// practicals (lamps, candles, fire) and windows / screens stay put, signals keep their own blink, and the show lives
// on the accent + show fixtures.
//
// Roles:
//   practical  lamps, candles, chandeliers, fire, ceiling / flood / street / office lights — steady (flames flicker)
//   window     windows, viewports, city / sky glow — steady (it's "outside")
//   screen     monitors, terminals, holo displays, tickers, ad boxes — steady (content, not lights)
//   signal     nav / beacon / alarm / status LEDs / landing lights — their own slow blink, never the music
//   mood       TTRPG mood_* groups (the game engine owns them) — untouched
//   deco       string lights, fairy lights, fireflies, bottles, sparkles — twinkle gently, breathe with the music
//   sign       signs, neon signs, ON AIR — steady / slow breathing accents
//   show       spots, movers, beams, lasers, strobes, washes, PARs, stage / reveal lights — the beat-synced show
//   accent     everything else (coves, LED strips, neon, RGB, floor, bar glow …) — the room's colour canvas
// A room can override any group in scene.json: `lights.roles: { "<group>": "<role>" }`.
export type LightRole = 'practical' | 'window' | 'screen' | 'signal' | 'mood' | 'deco' | 'sign' | 'show' | 'accent';
export const LIGHT_ROLES: LightRole[] = ['practical', 'window', 'screen', 'signal', 'mood', 'deco', 'sign', 'show', 'accent'];
/** Roles the music never drives (they keep their authored look / their own ambient program). */
export const STILL_ROLES = new Set<LightRole>(['practical', 'window', 'screen', 'signal', 'mood']);

const RULES: [RegExp, LightRole][] = [
  [/^mood(_|$)/, 'mood'],
  [/on_?air|^rec$/, 'sign'],
  [/nav|beacon|alarm|warn|emergenc|alert|status|radio_?led|led_(red|green|amber)|^lz|lz_|padlight|waypoint|faulty|hazard|strobe_?warn/, 'signal'],
  [/engine|thruster|window|^win(_|\d|$)|win$|hullwin|viewport|citywin|skyline|^sky|planet|^city|windowband|daylight|^station$/, 'window'],
  [/screen|monitor|terminal|console|ticker|lightbox|^ads?$|^ads_|holo|^tv|display|projector|jukebox|arcade|slots|vending|propaganda|^board$/, 'screen'],
  [/spot|mover|moving|beam|laser|strobe|^wash|par_|^par$|stage|reveal|^lift|blinder|truss/, 'show'],
  [/string|fairy|firefl|sparkle|spark|star|bottle|gems?$|shard|ember|glitter|confetti/, 'deco'],
  [/candle|lantern|chandelier|brazier|fire|hearth|stove|torch|lamp|sconce|pendant|downlight|overhead|ceiling|tube|sodium|office|street|flood|bulb|practical|lighthouse|^key$|^fill$|^table$|fridge|^gm$|medtent|lab_hall|forge/, 'practical'],
  [/sign|logo|neon_sign|marquee/, 'sign'],
];
/** Role of a group name (lower-cased match; a room's scene.json `lights.roles` wins). */
export function lightRole(group: string, overrides?: Record<string, string> | null): LightRole {
  const o = overrides?.[group];
  if (o && (LIGHT_ROLES as string[]).includes(o)) return o as LightRole;
  const n = group.toLowerCase();
  for (const [re, role] of RULES) if (re.test(n)) return role;
  return 'accent';
}
/** Flame-like practicals flicker softly instead of sitting dead still. */
export const isFlame = (group: string) => /candle|fire|brazier|hearth|torch|ember|lantern|stove|forge/.test(group.toLowerCase());
