// Chat polls (server/poll.ts, docs/STREAM_DECK.md "Polls"): the PURE tally both the server and the pages use.
// Viewers on every connected platform vote in chat with a number ("2"), "!vote 2" or an option's keyword ("pizza");
// one vote per viewer per platform, the latest one counts; subs / members can count ×2; tips that name an option
// ("pizza!" with a $5 tip) add "donation votes". Anti-spam: a per-viewer cooldown + a cap on how often one viewer can
// change, and a per-second flood cap for the whole poll. No DOM, no file system, no network: tools/poll_unit.ts tests it.

export const POLL_MIN_OPTIONS = 2;
export const POLL_MAX_OPTIONS = 8;

export interface PollOption { label: string; keyword?: string }
export interface PollDef {
  question: string;
  options: PollOption[];
  /** Seconds; 0 = runs until ended by hand. */
  durationSec: number;
  /** Subs / members / founders count twice. */
  subDouble: boolean;
  /** Tips / Super Chats / bits naming an option add votes (1 per `usdPerVote`). */
  donationVotes: boolean;
  usdPerVote: number;
  /** Read the question and the winner aloud on the OBS page (Windows voice). */
  announce: boolean;
}
export interface PollTemplate extends PollDef { name: string }

export interface PollOptionView { label: string; keyword: string; votes: number; voters: number; bonus: number }
export interface PollView {
  id: string;
  question: string;
  options: PollOptionView[];
  /** Weighted total (what the bars divide by). */
  total: number;
  voters: number;
  startedAt: number;
  /** 0 = manual end. */
  endsAt: number;
  endedAt: number;
  state: 'live' | 'ended';
  /** Winning option indexes (several = a tie; empty = nobody voted). */
  winner: number[];
  /** Card on stream (Stream Deck "show / hide results"). */
  shown: boolean;
  byPlatform: Record<string, number>;
  subDouble: boolean;
  donationVotes: boolean;
  /** Votes that arrived since the last push (the "+N votes" pulse). */
  pulse: number;
}
export interface PollResult { id: string; question: string; options: { label: string; votes: number }[]; total: number; voters: number; winner: string; startedAt: number; endedAt: number }

export type VoteOutcome = 'counted' | 'changed' | 'same' | 'spam' | 'closed' | 'none';

export const SPAM = { cooldownMs: 1500, maxChanges: 6, floodPerSec: 400 };

const clean = (s: unknown, n: number) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
/** Lower-case, no accents / punctuation / emoji: "Pizza!!" → "pizza". */
export const normKey = (s: string) => s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

export const DEFAULT_POLL: PollDef = { question: '', options: [], durationSec: 60, subDouble: false, donationVotes: false, usdPerVote: 1, announce: false };

/** Built-in quick polls. */
export const POLL_PRESETS: PollTemplate[] = [
  { ...DEFAULT_POLL, name: 'Yes / No', question: 'Yes or no?', options: [{ label: 'Yes', keyword: 'yes' }, { label: 'No', keyword: 'no' }], durationSec: 45 },
  { ...DEFAULT_POLL, name: '1–4', question: 'Pick one', options: [{ label: 'Option 1' }, { label: 'Option 2' }, { label: 'Option 3' }, { label: 'Option 4' }], durationSec: 60 },
];

/** A usable poll from anything (UI, HTTP, templates) — or an error message. */
export function sanitizePoll(raw: unknown, base: PollDef = DEFAULT_POLL): PollDef | string {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  const question = clean(r.question ?? base.question, 140);
  if (!question) return 'The poll needs a question';
  const src = Array.isArray(r.options) ? r.options : base.options;
  const options: PollOption[] = [];
  const seen = new Set<string>();
  for (const o of src.slice(0, POLL_MAX_OPTIONS + 4)) {
    const lab = clean(typeof o === 'string' ? o : (o as PollOption)?.label, 48);
    if (!lab) continue;
    let kw = normKey(clean(typeof o === 'string' ? '' : (o as PollOption)?.keyword, 24));
    if (!kw || /^\d+$/.test(kw) || seen.has(kw)) kw = '';
    const lk = normKey(lab);
    if (seen.has(lk) && !kw) continue;       // duplicate option
    seen.add(lk); if (kw) seen.add(kw);
    options.push(kw ? { label: lab, keyword: kw } : { label: lab });
    if (options.length >= POLL_MAX_OPTIONS) break;
  }
  if (options.length < POLL_MIN_OPTIONS) return `A poll needs ${POLL_MIN_OPTIONS}–${POLL_MAX_OPTIONS} different options`;
  const d = Number(r.durationSec ?? r.duration ?? base.durationSec);
  const durationSec = Number.isFinite(d) && d > 0 ? Math.round(Math.max(10, Math.min(3600, d))) : 0;
  const u = Number(r.usdPerVote ?? base.usdPerVote);
  const b = (k: keyof PollDef) => (typeof r[k] === 'boolean' ? (r[k] as boolean) : (base[k] as boolean));
  return { question, options, durationSec, subDouble: b('subDouble'), donationVotes: b('donationVotes'), usdPerVote: Number.isFinite(u) && u > 0 ? Math.min(1000, u) : 1, announce: b('announce') };
}

export function sanitizeTemplate(raw: unknown): PollTemplate | string {
  const p = sanitizePoll(raw);
  if (typeof p === 'string') return p;
  const name = clean((raw as { name?: unknown })?.name, 40) || p.question.slice(0, 40);
  return { ...p, name };
}

/** Which option a chat line votes for (index) — null when it isn't a vote. */
export function parseVote(text: string, options: PollOption[]): number | null {
  const t = clean(text, 80);
  if (!t) return null;
  const m = /^!(?:vote|v)\s+(.+)$/i.exec(t);
  const body = m ? m[1] : t;
  const num = /^#?(\d{1,2})[.!)]*$/.exec(body.trim());
  if (num) { const i = Number(num[1]) - 1; return i >= 0 && i < options.length ? i : null; }
  const k = normKey(body);
  if (!k) return null;
  for (let i = 0; i < options.length; i++) if (options[i].keyword && options[i].keyword === k) return i;
  for (let i = 0; i < options.length; i++) if (normKey(options[i].label) === k) return i;
  return null;
}

/** Which option a support message names (keyword / label as a whole word anywhere, or "!vote 2"). */
export function parseDonationVote(text: string, options: PollOption[]): number | null {
  const direct = parseVote(text, options);
  if (direct !== null) return direct;
  const k = ` ${normKey(text)} `;
  const hits = new Set<number>();
  options.forEach((o, i) => {
    for (const w of [o.keyword, normKey(o.label)]) if (w && k.includes(` ${w} `)) hits.add(i);
  });
  return hits.size === 1 ? [...hits][0] : null;     // naming two options = ambiguous
}

const SUB_BADGE = /^(subscriber|member|founder|sub)$/i;
export const isSubVoter = (badges: string[] | undefined) => !!badges?.some((b) => SUB_BADGE.test(b));

interface Voter { opt: number; w: number; at: number; changes: number; platform: string }

export class PollTally {
  readonly id: string;
  readonly def: PollDef;
  readonly startedAt: number;
  endedAt = 0;
  shown = true;
  private voters = new Map<string, Voter>();
  private bonus: number[];
  private secT = 0;
  private secN = 0;
  private pulseN = 0;

  constructor(def: PollDef, now = Date.now(), id = `poll-${now.toString(36)}`) {
    this.def = def; this.startedAt = now; this.id = id;
    this.bonus = def.options.map(() => 0);
  }

  get live() { return !this.endedAt; }
  get endsAt() { return this.def.durationSec ? this.startedAt + this.def.durationSec * 1000 : 0; }

  /** Ends the poll when its time is up. Returns true when it just ended. */
  tick(now = Date.now()): boolean {
    if (this.live && this.endsAt && now >= this.endsAt) { this.endedAt = this.endsAt; return true; }
    return false;
  }
  end(now = Date.now()) { if (this.live) this.endedAt = now; }

  /** A chat line. Anything that parses as a vote returns a non-'none' outcome (the hub keeps it off the chat display). */
  vote(platform: string, user: string, text: string, opts: { badges?: string[]; ts?: number } = {}): VoteOutcome {
    const opt = parseVote(text, this.def.options);
    if (opt === null) return 'none';
    const now = opts.ts ?? Date.now();
    if (this.tick(now) || !this.live) return 'closed';
    const u = clean(user, 60).toLowerCase();
    if (!u || u === 'anonymous') return 'spam';
    // flood cap for the whole poll (a bot net / replayed history can't lock the page up)
    const sec = Math.floor(now / 1000);
    if (sec !== this.secT) { this.secT = sec; this.secN = 0; }
    if (++this.secN > SPAM.floodPerSec) return 'spam';
    const key = `${platform}:${u}`;
    const w = this.def.subDouble && isSubVoter(opts.badges) ? 2 : 1;
    const v = this.voters.get(key);
    if (!v) { this.voters.set(key, { opt, w, at: now, changes: 0, platform }); this.pulseN++; return 'counted'; }
    if (v.opt === opt) { v.w = Math.max(v.w, w); return 'same'; }
    if (now - v.at < SPAM.cooldownMs || v.changes >= SPAM.maxChanges) return 'spam';
    v.opt = opt; v.w = Math.max(v.w, w); v.at = now; v.changes++;
    this.pulseN++;
    return 'changed';
  }

  /** A support event naming an option: votes = floor(usd / usdPerVote), at least 1, at most 100 per tip. */
  donate(text: string, usd: number, now = Date.now()): number | null {
    if (!this.def.donationVotes || this.tick(now) || !this.live) return null;
    const opt = parseDonationVote(text, this.def.options);
    if (opt === null) return null;
    const n = Math.max(1, Math.min(100, Math.floor((Number(usd) || 0) / this.def.usdPerVote)));
    this.bonus[opt] += n;
    this.pulseN += n;
    return opt;
  }

  /** Current standings. `takePulse` resets the "+N" counter (the server's push does that). */
  view(takePulse = false): PollView {
    const votes = this.def.options.map(() => 0), people = this.def.options.map(() => 0);
    const byPlatform: Record<string, number> = {};
    for (const v of this.voters.values()) { votes[v.opt] += v.w; people[v.opt]++; byPlatform[v.platform] = (byPlatform[v.platform] ?? 0) + 1; }
    const options = this.def.options.map((o, i) => ({ label: o.label, keyword: o.keyword ?? '', votes: votes[i] + this.bonus[i], voters: people[i], bonus: this.bonus[i] }));
    const total = options.reduce((s, o) => s + o.votes, 0);
    const top = Math.max(0, ...options.map((o) => o.votes));
    const winner = top > 0 ? options.map((o, i) => (o.votes === top ? i : -1)).filter((i) => i >= 0) : [];
    const pulse = this.pulseN;
    if (takePulse) this.pulseN = 0;
    return { id: this.id, question: this.def.question, options, total, voters: this.voters.size, startedAt: this.startedAt, endsAt: this.endsAt, endedAt: this.endedAt,
      state: this.live ? 'live' : 'ended', winner, shown: this.shown, byPlatform, subDouble: this.def.subDouble, donationVotes: this.def.donationVotes, pulse };
  }

  result(): PollResult {
    const v = this.view();
    return { id: this.id, question: v.question, options: v.options.map((o) => ({ label: o.label, votes: o.votes })), total: v.total, voters: v.voters,
      winner: winnerText(v), startedAt: this.startedAt, endedAt: this.endedAt || Date.now() };
  }
}

export function winnerText(v: Pick<PollView, 'options' | 'winner'>): string {
  if (!v.winner.length) return 'No votes';
  return v.winner.map((i) => v.options[i]?.label ?? '?').join(' / ') + (v.winner.length > 1 ? ' (tie)' : '');
}

/** Sanitise a pushed view on the pages. */
export function sanitizePollView(raw: unknown): PollView | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as PollView;
  if (typeof r.id !== 'string' || !Array.isArray(r.options) || r.options.length < 2 || r.options.length > POLL_MAX_OPTIONS) return null;
  const n = (x: unknown) => (Number.isFinite(Number(x)) ? Math.max(0, Number(x)) : 0);
  return {
    id: r.id.slice(0, 40), question: clean(r.question, 140),
    options: r.options.map((o) => ({ label: clean(o?.label, 48), keyword: clean(o?.keyword, 24), votes: n(o?.votes), voters: n(o?.voters), bonus: n(o?.bonus) })),
    total: n(r.total), voters: n(r.voters), startedAt: n(r.startedAt), endsAt: n(r.endsAt), endedAt: n(r.endedAt), state: r.state === 'ended' ? 'ended' : 'live',
    winner: Array.isArray(r.winner) ? r.winner.filter((i) => Number.isInteger(i) && i >= 0 && i < r.options.length) : [], shown: r.shown !== false,
    byPlatform: r.byPlatform && typeof r.byPlatform === 'object' ? Object.fromEntries(Object.entries(r.byPlatform).slice(0, 8).map(([k, v]) => [clean(k, 12), n(v)])) : {},
    subDouble: !!r.subDouble, donationVotes: !!r.donationVotes, pulse: n(r.pulse),
  };
}

// ---------------------------------------------------------------- docked placement (OBS page)
export interface PRect { x: number; y: number; w: number; h: number }
const hit = (a: PRect, b: PRect, pad = 0.012) => a.x < b.x + b.w + pad && b.x < a.x + a.w + pad && a.y < b.y + b.h + pad && b.y < a.y + a.h + pad;
/** Where the docked poll card goes (normalised 0–1 screen rects): the first corner that touches nothing to avoid
 *  (faces, interview screens, cams, the capture, docked chat), at full size then smaller. null = nowhere is free. */
export function pickPollDock(avoid: PRect[], w: number, h: number, prev: PRect | null = null): PRect | null {
  const m = 0.02;
  for (const s of [1, 0.8, 0.64]) {
    const W = w * s, H = h * s;
    const c: PRect[] = [
      { x: 1 - m - W, y: m, w: W, h: H }, { x: m, y: m, w: W, h: H }, { x: 1 - m - W, y: 1 - m - H, w: W, h: H }, { x: m, y: 1 - m - H, w: W, h: H },
      { x: (1 - W) / 2, y: m, w: W, h: H }, { x: 1 - m - W, y: (1 - H) / 2, w: W, h: H }, { x: m, y: (1 - H) / 2, w: W, h: H },
    ];
    // stay put while the old spot is still free (no hopping around)
    if (prev && s === 1 && Math.abs(prev.w - W) < 1e-6 && !avoid.some((a) => hit(prev, a))) return prev;
    const ok = c.find((r) => !avoid.some((a) => hit(r, a)));
    if (ok) return ok;
  }
  return null;
}
