// Host Chat Hub (chathub.html + server/chat/hostHub.ts): one easy-to-read window for the host with the unified chat
// feed and an EVENTS queue (support + stream events) the host acknowledges, plus optional text-to-speech of support
// messages played on the OBS page. The queue lives on this PC's server so the pop-out window, the studio and a Stream
// Deck all see the same state. Nothing here ever posts to a platform.
import type { ChatEvent, LivePlatform } from './chat.ts';

export type TtsWhere = 'obs' | 'studio';
/** system = this computer's voices (free, the default) ·
 *  kokoro = Kokoro-82M on this PC (free, local, installed on demand: server/kokoro.ts). */
export type TtsEngine = 'system' | 'kokoro';

/** Kokoro read-aloud settings (the voice is one of tools/voice/voice_setup.ts KOKORO_VOICES). */
export interface KokoroTts { voice: string; speed: number }
export const DEFAULT_KOKORO: KokoroTts = { voice: 'af_heart', speed: 1 };
export interface TtsSettings {
  /** Master switch (default OFF). */
  on: boolean;
  /** Minimum USD value to read (Kicks / bits / coins at their payout value). */
  minUsd: number;
  /** Per-platform switches (+ local test events). */
  platforms: Record<LivePlatform | 'test', boolean>;
  /** Also read subs / memberships / gifted subs that carry a message. */
  subs: boolean;
  /** Only read events whose viewer typed a message (else "X sent 500 bits" is read too). */
  onlyWithText: boolean;
  /** Say who sent it and what ("NightOwl42 sent $5: …"). */
  readName: boolean;
  /** Bleep common swear words / slurs (a word list, not a moderator). */
  profanity: boolean;
  /** Replace links with "link". */
  urls: boolean;
  /** Characters of the viewer's message that are read (the rest is cut). */
  maxChars: number;
  /** Windows voice name ('' = the first installed). */
  voice: string;
  rate: number;
  /** 0 … 1 */
  volume: number;
  /** obs = the OBS page plays it (on stream) · studio = only the Chat Hub window plays it (host hears it, viewers don't). */
  where: TtsWhere;
  /** Pause between two messages (ms). */
  gapMs: number;
  /** Which voice reads (default: this computer's voices). */
  engine: TtsEngine;
  kokoro?: KokoroTts;
}

export const DEFAULT_TTS: TtsSettings = {
  on: false, minUsd: 1, platforms: { twitch: true, youtube: true, kick: true, rumble: true, tiktok: true, test: true },
  subs: true, onlyWithText: true, readName: true, profanity: true, urls: true, maxChars: 200, voice: '', rate: 1, volume: 0.9,
  where: 'obs', gapMs: 700, engine: 'system', kokoro: { ...DEFAULT_KOKORO },
};

export type TtsState = '' | 'queued' | 'playing' | 'done' | 'skipped' | 'filtered';

/** One entry of the events queue. */
export interface HubItem {
  e: ChatEvent;
  ack: boolean;
  /** Thanked on stream (the celebration was replayed). */
  thanked?: boolean;
  tts: TtsState;
}

/** A plain status line about the voice (Kokoro not ready -> this computer's voice read the line). */
export interface VoiceStatus {
  /** One plain status line ('' = nothing to say), and when it was said (ms). */
  note: string;
  noteAt: number;
}
export interface HubTtsStatus { ok: boolean; error: string; now: string | null; queue: string[]; voices: string[]; voice?: VoiceStatus }

export interface HubSnapshot { items: HubItem[]; tts: TtsSettings; ttsStatus: HubTtsStatus; deckKey: string }

/** Bus messages ({type:'chathub', ...}) — this PC only. */
export type ChatHubBus =
  | { k: 'items'; items: HubItem[] }
  | { k: 'tts'; id: string; url: string; vol: number; where: TtsWhere; text: string }
  | { k: 'hush' }
  | { k: 'ttsStatus'; s: HubTtsStatus; tts?: TtsSettings };

/** Stream Deck / hotkey actions (GET /api/chathub/do/<action>?key=…). */
export const HUB_ACTIONS = ['ack-next', 'ack-all', 'thank-next', 'skip', 'replay', 'tts-on', 'tts-off', 'tts-toggle'] as const;
export type HubAction = (typeof HUB_ACTIONS)[number];
export const HUB_ACTION_LABELS: Record<HubAction, string> = {
  'ack-next': 'Acknowledge the oldest unread event', 'ack-all': 'Acknowledge everything', 'thank-next': 'Thank the oldest unread supporter on stream (+ acknowledge)',
  skip: 'Skip the message being read', replay: 'Replay the last read message', 'tts-on': 'Text-to-speech on', 'tts-off': 'Text-to-speech off', 'tts-toggle': 'Text-to-speech on/off',
};

const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);

export function sanitizeTts(o: unknown, b: TtsSettings = DEFAULT_TTS): TtsSettings {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  const p = (x.platforms && typeof x.platforms === 'object' ? x.platforms : {}) as Record<string, unknown>;
  const plats = { ...b.platforms };
  for (const k of Object.keys(plats) as (keyof TtsSettings['platforms'])[]) plats[k] = bool(p[k], plats[k]);
  return {
    on: bool(x.on, b.on), minUsd: num(x.minUsd, 0, 10000, b.minUsd), platforms: plats,
    subs: bool(x.subs, b.subs), onlyWithText: bool(x.onlyWithText, b.onlyWithText), readName: bool(x.readName, b.readName),
    profanity: bool(x.profanity, b.profanity), urls: bool(x.urls, b.urls), maxChars: Math.round(num(x.maxChars, 20, 500, b.maxChars)),
    voice: typeof x.voice === 'string' ? x.voice.replace(/[^\w\s()\-.,]/g, '').slice(0, 80) : b.voice,
    rate: num(x.rate, 0.5, 2, b.rate), volume: num(x.volume, 0, 1, b.volume),
    where: x.where === 'studio' || x.where === 'obs' ? x.where : b.where, gapMs: Math.round(num(x.gapMs, 0, 5000, b.gapMs)),
    engine: x.engine === 'system' || x.engine === 'kokoro' ? x.engine : (b.engine ?? 'system'),
    kokoro: sanitizeKokoro(x.kokoro, b.kokoro ?? DEFAULT_KOKORO),
  };
}

export function sanitizeKokoro(o: unknown, b: KokoroTts = DEFAULT_KOKORO): KokoroTts {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return {
    voice: typeof x.voice === 'string' && /^[a-z]{2}_[a-z]{2,20}$/.test(x.voice) ? x.voice : b.voice,
    speed: Math.round(num(x.speed, 0.6, 1.6, b.speed) * 100) / 100,
  };
}

/** The events queue shows support events and stream events (follows, raids, hosts …), not plain chat. */
export const isHubEvent = (e: ChatEvent) => !e.cue && (e.kind === 'finance' || (e.kind === 'system' && !!e.ev));

/** Event filter groups (the events column chips). */
export type HubGroup = 'money' | 'subs' | 'raids' | 'follows' | 'other';
export function hubGroup(e: ChatEvent): HubGroup {
  if (e.kind === 'finance') {
    if (e.fkind === 'raid') return 'raids';
    if (e.fkind && ['sub', 'resub', 'giftSub', 'membership', 'milestone', 'giftMembership'].includes(e.fkind)) return 'subs';
    return 'money';
  }
  if (e.ev === 'follow') return 'follows';
  if (e.ev === 'host') return 'raids';
  return 'other';
}

// ---------------------------------------------------------------- text-to-speech text
/** A short, conservative word list (English) — bleeped, not moderated. */
const BAD = ['fuck', 'fucking', 'fucker', 'motherfucker', 'shit', 'bullshit', 'bitch', 'cunt', 'asshole', 'dick', 'cock', 'pussy', 'whore', 'slut', 'bastard', 'nigger', 'nigga', 'faggot', 'fag', 'retard', 'kys', 'rape'];
const BAD_RE = new RegExp(`\\b(${BAD.join('|')})(s|es|ed|ing)?\\b`, 'gi');
const URL_RE = /\b(?:https?:\/\/|www\.)\S+|\b[\w-]+\.(?:com|net|org|gg|tv|io|ly|me|co|xyz|live|link)(?:\/\S*)?\b/gi;

export function ttsFilter(text: string, t: Pick<TtsSettings, 'profanity' | 'urls' | 'maxChars'>): string {
  let s = text.replace(/[\u0000-\u001f]/g, ' ');
  if (t.urls) s = s.replace(URL_RE, 'link');
  if (t.profanity) s = s.replace(BAD_RE, 'beep');
  s = s.replace(/(.)\1{4,}/g, '$1$1$1');          // "loooooool" → "looo"
  s = s.replace(/\s+/g, ' ').trim();
  if (s.length > t.maxChars) s = s.slice(0, t.maxChars).replace(/\s+\S*$/, '') + '…';
  return s;
}

const SAY_AMOUNT = (e: ChatEvent) => {
  if (!e.display) return '';
  return e.display.replace(/^\$(\d+)\.00$/, '$$$1').replace(/\bsubs?\b/, (m) => (m === 'sub' ? 'sub' : 'subs'));
};

/** Why an event would NOT be read ('' = read it). */
export function ttsSkipReason(e: ChatEvent, t: TtsSettings): string {
  if (!t.on) return 'off';
  if (e.kind !== 'finance' || e.cue) return 'not support';
  if (!t.platforms[e.test ? 'test' : (e.platform as LivePlatform)]) return 'platform off';
  const subLike = e.fkind && ['sub', 'resub', 'giftSub', 'membership', 'milestone', 'giftMembership'].includes(e.fkind);
  if (e.fkind === 'raid') return 'raid';
  if (subLike && !t.subs) return 'subs off';
  if (!subLike && (e.usd || e.approxUsd || 0) < t.minUsd) return 'under minimum';
  const msg = ttsFilter(e.text, t);
  if (t.onlyWithText && (!msg || /^(gifted|resubscribed|subscribed|sent |is raiding)/i.test(e.text))) return 'no message';
  return '';
}

export function ttsText(e: ChatEvent, t: TtsSettings): string {
  const msg = ttsFilter(e.text, t);
  if (!t.readName) return msg;
  const amt = SAY_AMOUNT(e);
  const head = e.fkind === 'tiktokGift' && e.giftName ? `${e.user} sent ${e.giftName}` : amt ? `${e.user} sent ${amt}` : `${e.user} says`;
  return msg ? `${head}: ${msg}` : head;
}
