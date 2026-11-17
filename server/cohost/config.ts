// AI co-host (beta.16, docs/b16/COHOST.md): the settings. PURE: no file system, no network, no DOM, so the helper (engine,
// routes), the studio panel and tools/cohost_unit.ts all read the same shape. Saved by server/cohost/mount.ts in
// config/cohost.json. It holds NO key: the AI connection (a model on this PC) is the one made on the
// "Connect an AI" page; here the user only picks which one to use.
//
// Ships enabled but switched off (never gate a feature): `on` is false until the user turns it on. Nothing is read, sent to a
// model, spoken or shown while it is off.

export const COHOST_FILE_VERSION = 1;

/** The moods a reply may carry. The chat buddy hops and smiles for the happy ones; the caption wears the colour. */
export const COHOST_MOODS = ['neutral', 'happy', 'excited', 'curious', 'sad', 'sarcastic'] as const;
export type CohostMood = (typeof COHOST_MOODS)[number];
/** Moods that make the chat buddy cheer (hop + big smile) when "react with the buddy" is on. */
export const CHEER_MOODS: readonly CohostMood[] = ['happy', 'excited'];

/** Small things the co-host may do on its own besides talking. A fixed list (an allow-list): the model can only ASK for one
 *  of these by name, and only the ones the user ticked ever run. */
export const COHOST_REACTIONS = ['cheer', 'applause'] as const;
export type CohostReaction = (typeof COHOST_REACTIONS)[number];
export const REACTION_LABEL: Record<CohostReaction, string> = { cheer: 'The chat buddy hops and smiles', applause: 'The audience claps' };

export interface CohostPersona {
  /** What the co-host is called (also what viewers can @mention). */
  name: string;
  /** A few plain sentences: who it is and how it talks. */
  personality: string;
  /** Words it must never say. The reply is dropped if it contains one (case and spacing ignored). */
  banned: string[];
}

export interface CohostRate {
  /** At most this many replies in any one minute. */
  perMinute: number;
  /** Always at least this many seconds between two replies. */
  gapSecs: number;
  /** Safety net for the model bill: at most this many replies an hour. */
  perHour: number;
}

export interface CohostConfig {
  v: typeof COHOST_FILE_VERSION;
  /** The big switch. Off until the user turns it on. */
  on: boolean;
  persona: CohostPersona;
  /** Which AI connection answers: 'auto' = a model running on this PC (never spends money); else a provider id from the
   *  Connect an AI page (ollama, lmstudio, llamacpp, local). `model` empty = that connection's own choice. */
  model: { provider: string; model: string };
  rate: CohostRate;
  /** What it answers. */
  answers: { questions: boolean; mentions: boolean; redeem: boolean; redeemTitle: string };
  /** Say the reply out loud with the Read-aloud voice (Chat Hub). The sound plays in the studio window like every other
   *  show sound, never on an OBS page. */
  speak: boolean;
  /** Show the reply as a caption on the stream. */
  caption: boolean;
  /** Wait until the streamer (and the co-host itself) is quiet before talking. */
  waitForSilence: boolean;
  /** Reactions it may ask for with a reply (allow-list). */
  reactions: CohostReaction[];
}

export const COHOST_LIMITS = {
  nameMax: 24, personalityMax: 600, bannedMax: 30, bannedWordMax: 30, replyMaxChars: 220, titleMax: 60,
  perMinute: [1, 6] as const, gapSecs: [4, 300] as const, perHour: [1, 200] as const,
  /** A line waits at most this long for a quiet moment, then it is dropped (old news is not worth saying). */
  maxWaitMs: 45_000,
  /** How long the streamer must have been quiet before the co-host starts. */
  quietMs: 1200,
  /** At most this many lines wait their turn. */
  queueMax: 3,
  /** The same viewer is answered at most this often. */
  perUserGapMs: 30_000,
} as const;

export const DEFAULT_PERSONA: CohostPersona = {
  name: 'Buddy',
  personality: 'Friendly, quick and a little cheeky. Talks like a good friend on the couch: short, warm, never mean. Loves the stream and the people in chat.',
  banned: [],
};

export const DEFAULT_COHOST: CohostConfig = {
  v: COHOST_FILE_VERSION,
  on: false,
  persona: DEFAULT_PERSONA,
  model: { provider: 'auto', model: '' },
  rate: { perMinute: 2, gapSecs: 12, perHour: 40 },
  answers: { questions: true, mentions: true, redeem: true, redeemTitle: 'Ask the co-host' },
  speak: true,
  caption: true,
  waitForSilence: true,
  reactions: ['cheer'],
};

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
/** Plain text only: no control characters, no angle brackets (nothing here ever becomes markup), one line of spaces. */
export const plain = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max) : '');
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v))) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const PROVIDER = /^[a-z][a-z0-9_-]{0,31}$/;
const MODEL = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;

/** Anything (a saved file, a PUT body) -> a valid config. Unknown fields are dropped; a patch keeps the rest of `base`. */
export function sanitizeCohost(o: unknown, base: CohostConfig = DEFAULT_COHOST): CohostConfig {
  const x = rec(o), p = rec(x.persona), m = rec(x.model), r = rec(x.rate), a = rec(x.answers);
  const L = COHOST_LIMITS;
  const bannedIn = Array.isArray(p.banned) ? p.banned : typeof p.banned === 'string' ? p.banned.split(/[,\n]/) : null;
  const banned = bannedIn ? [...new Set(bannedIn.map((w) => plain(w, L.bannedWordMax).toLowerCase()).filter(Boolean))].slice(0, L.bannedMax) : base.persona.banned;
  const prov = typeof m.provider === 'string' && PROVIDER.test(m.provider.trim()) ? m.provider.trim() : base.model.provider;
  const mdl = typeof m.model === 'string' ? (m.model.trim() === '' ? '' : MODEL.test(m.model.trim()) ? m.model.trim() : base.model.model) : base.model.model;
  const reactions = Array.isArray(x.reactions) ? COHOST_REACTIONS.filter((k) => (x.reactions as unknown[]).includes(k)) : base.reactions;
  return {
    v: COHOST_FILE_VERSION,
    on: bool(x.on, base.on),
    persona: {
      name: plain(p.name, L.nameMax) || base.persona.name,
      personality: 'personality' in p ? plain(p.personality, L.personalityMax) || DEFAULT_PERSONA.personality : base.persona.personality,
      banned,
    },
    model: { provider: prov, model: mdl },
    rate: { perMinute: num(r.perMinute, ...L.perMinute, base.rate.perMinute), gapSecs: num(r.gapSecs, ...L.gapSecs, base.rate.gapSecs), perHour: num(r.perHour, ...L.perHour, base.rate.perHour) },
    answers: {
      questions: bool(a.questions, base.answers.questions), mentions: bool(a.mentions, base.answers.mentions), redeem: bool(a.redeem, base.answers.redeem),
      redeemTitle: 'redeemTitle' in a ? plain(a.redeemTitle, L.titleMax) || DEFAULT_COHOST.answers.redeemTitle : base.answers.redeemTitle,
    },
    speak: bool(x.speak, base.speak),
    caption: bool(x.caption, base.caption),
    waitForSilence: bool(x.waitForSilence, base.waitForSilence),
    reactions: [...reactions],
  };
}

/** One spoken line, as it travels on the bus to the OBS pages (command `cohost-line`). */
export interface CohostLine {
  /** Unique per line. */
  id: string;
  name: string;
  text: string;
  mood: CohostMood;
  /** How long the line is on screen / the mouth moves (ms). Includes the voice when it speaks. */
  ms: number;
  /** The voice is speaking it (the studio plays the sound; OBS pages only move the mouth). */
  spoken: boolean;
  /** Show the caption. */
  caption: boolean;
  /** Hop and smile. */
  cheer: boolean;
  /** Who it answers (display name), for the caption's small print. */
  to?: string;
}

/** Read a `cohost-line` bus message: known fields only, bounded. null = junk. */
export function sanitizeLine(o: unknown): CohostLine | null {
  const x = rec(o);
  const text = plain(x.text, COHOST_LIMITS.replyMaxChars + 40);
  const id = plain(x.id, 60);
  if (!text || !id) return null;
  const mood = (COHOST_MOODS as readonly unknown[]).includes(x.mood) ? x.mood as CohostMood : 'neutral';
  return { id, name: plain(x.name, COHOST_LIMITS.nameMax) || DEFAULT_PERSONA.name, text, mood, ms: num(x.ms, 600, 60_000, 4000), spoken: x.spoken === true, caption: x.caption !== false, cheer: x.cheer === true,
    ...(plain(x.to, 48) ? { to: plain(x.to, 48) } : {}) };
}
