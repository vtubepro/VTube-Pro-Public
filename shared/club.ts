// The club engine's host-owned options (SceneState.club; src/scene/club, docs/SCENES.md "Club"). Pure data + sanitiser.
// Everything the club shows is a pure function of (room, seed, wall clock, these options, chat support events), so
// every OBS page (host + party guests) shows the same bits and celebrations.

/** Background bits (random, on a seeded schedule) — also what the Scene tab's test buttons stamp. */
export const CLUB_BITS = ['crowdsurf', 'danceoff', 'conga', 'proposal', 'stagefall', 'juggle', 'bouncer', 'mirrorball', 'drop', 'bartrick'] as const;
export type ClubBitKind = (typeof CLUB_BITS)[number];
/** Support celebrations (chat finance kinds mapped by clubKindOf) — the test buttons stamp these too. */
export const CLUB_CELEBRATIONS = ['tip', 'sub', 'bits', 'raid', 'big'] as const;
export type ClubCelebration = (typeof CLUB_CELEBRATIONS)[number];

export const CLUB_BIT_SECONDS: Record<ClubBitKind, number> = {
  crowdsurf: 16, danceoff: 24, conga: 30, proposal: 16, stagefall: 14, juggle: 16, bouncer: 22, mirrorball: 20, drop: 10, bartrick: 9,
};
export const CLUB_BIT_LABELS: Record<ClubBitKind, string> = {
  crowdsurf: 'Crowd-surf', danceoff: 'Dance-off', conga: 'Conga line', proposal: 'Proposal', stagefall: 'Stage fall', juggle: 'Bottle juggling',
  bouncer: 'Bouncer toss', mirrorball: 'Mirror-ball moment', drop: 'The drop', bartrick: 'Round of drinks',
};
export const CLUB_CELEBRATION_LABELS: Record<ClubCelebration, string> = {
  tip: 'Tip: confetti cannons + the crowd cheers the name', sub: 'Sub: CO2 jets + laser burst', bits: 'Bits / Kicks: air horn + a round of drinks',
  raid: 'Raid: the bass drop (everyone jumps, fireworks, the stage lifts)', big: 'Big donation: champagne tower + confetti storm + a sign',
};

export interface ClubEvent { k: ClubBitKind | ClubCelebration; at: number; seed: number; user?: string; usd?: number }
export interface SceneClubState {
  /** background bits on */
  bits: boolean;
  /** how often (bits per ~minute: 0.25 .. 3; 1 ≈ one every 50 s) */
  freq: number;
  /** schedule seed (bumped to reshuffle) + origin (epoch ms; host clock) */
  seed: number;
  /** the DJ pose layer at the DJ booth (hands on the decks, headphone moments) — replaces arm tracking there */
  djHands: boolean;
  /** play the air horn / crowd sounds on OBS pages */
  sound: boolean;
  /** a donation at or above this (USD) is a "big" one */
  bigMin: number;
  /** cinematic camera on the host's DJ booth → balcony walk (and the reveal once there) */
  entranceCam: boolean;
  /** host-stamped events (tests, remote triggers): epoch ms, host clock; ≤ 8, newest last */
  events: ClubEvent[];
}
export const DEFAULT_CLUB_STATE: SceneClubState = { bits: true, freq: 1, seed: 7, djHands: true, sound: true, bigMin: 50, entranceCam: true, events: [] };

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const KINDS = new Set<string>([...CLUB_BITS, ...CLUB_CELEBRATIONS]);

export function sanitizeClubState(o: unknown): SceneClubState {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const d = DEFAULT_CLUB_STATE;
  const events: ClubEvent[] = [];
  if (Array.isArray(x.events)) for (const e of x.events.slice(-8)) {
    if (!e || typeof e !== 'object') continue;
    const r = e as Record<string, unknown>;
    if (typeof r.k !== 'string' || !KINDS.has(r.k) || typeof r.at !== 'number' || !Number.isFinite(r.at) || r.at < 0 || r.at > 1e14) continue;
    events.push({ k: r.k as ClubEvent['k'], at: r.at, seed: Math.round(num(r.seed, 0, 2 ** 31, 1)),
      ...(typeof r.user === 'string' ? { user: r.user.slice(0, 32) } : {}), ...(typeof r.usd === 'number' ? { usd: num(r.usd, 0, 1e6, 0) } : {}) });
  }
  return {
    bits: typeof x.bits === 'boolean' ? x.bits : d.bits,
    freq: num(x.freq, 0.25, 3, d.freq),
    seed: Math.round(num(x.seed, 0, 2 ** 31, d.seed)),
    djHands: typeof x.djHands === 'boolean' ? x.djHands : d.djHands,
    sound: typeof x.sound === 'boolean' ? x.sound : d.sound,
    bigMin: num(x.bigMin, 1, 100000, d.bigMin),
    entranceCam: typeof x.entranceCam === 'boolean' ? x.entranceCam : d.entranceCam,
    events,
  };
}

/** Chat finance kind + USD → the club's celebration ('' = none). */
export function clubKindOf(fkind: string | undefined, usd: number, bigMin: number): ClubCelebration | '' {
  if (!fkind) return '';
  if (fkind === 'raid') return 'raid';
  if (fkind === 'kicks' || fkind === 'jewels') return usd >= bigMin ? 'big' : 'bits';
  if (['sub', 'resub', 'giftSub', 'membership', 'milestone', 'giftMembership'].includes(fkind)) return 'sub';
  if (['tip', 'donation', 'rant', 'wallet', 'superchat', 'supersticker'].includes(fkind)) return usd >= bigMin ? 'big' : 'tip';
  return '';
}

/** The bit schedule: one slot every 50 / freq s since the epoch origin; each slot may hold one bit (seeded kind + offset). */
export function clubSchedule(seed: number, freq: number, fromSec: number, toSec: number, rng: (s: number) => () => number, hash: (...p: (string | number)[]) => number): { k: ClubBitKind; at: number; seed: number; dur: number }[] {
  const slot = 50 / Math.max(0.25, freq);
  const out: { k: ClubBitKind; at: number; seed: number; dur: number }[] = [];
  const W: [ClubBitKind, number][] = [['crowdsurf', 12], ['danceoff', 10], ['conga', 10], ['proposal', 6], ['stagefall', 9], ['juggle', 9], ['bouncer', 9], ['mirrorball', 8], ['drop', 7], ['bartrick', 10]];
  const tot = W.reduce((s, [, w]) => s + w, 0);
  for (let k = Math.floor(fromSec / slot) - 1; k <= Math.floor(toSec / slot); k++) {
    const r = rng(hash(seed, 'clubslot', k));
    if (r() > 0.85) continue;                 // some slots stay quiet
    let x = r() * tot, kind: ClubBitKind = W[0][0];
    for (const [c, w] of W) { if ((x -= w) <= 0) { kind = c; break; } }
    const dur = CLUB_BIT_SECONDS[kind];
    const at = k * slot + r() * Math.max(1, slot - dur - 2);
    out.push({ k: kind, at, seed: hash(seed, 'bit', k), dur });
  }
  return out;
}
