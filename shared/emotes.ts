// Custom emotes from the streamer's own channels (owner: "integrate and read custom emotes from my channels"): the
// platforms' own emotes (Twitch, Kick, YouTube member emoji) plus the third-party sets every chat app shows
// (7TV, BetterTTV, FrankerFaceZ). Pure: the providers' JSON → EmoteDef lists, the word index that turns plain chat text
// into emote parts, and the helpers the hub (server/chat/emotes.ts) and the Emotes panel (src/ui/emotesPanel.ts) share. No network, no DOM.
//
// Sources and what we read (all public, read only, no account):
//   7TV   https://7tv.io/v3/emote-sets/global · /v3/users/{twitch|kick}/{platform user id} → emote_set.emotes[]
//         image: https:{data.host.url}/2x.webp (animated when data.animated); zero-width = the active emote's flags & 1
//   BTTV  https://api.betterttv.net/3/cached/emotes/global · /3/cached/users/{twitch|youtube}/{id} → channelEmotes +
//         sharedEmotes;   image: https://cdn.betterttv.net/emote/{id}/2x.webp
//   FFZ   https://api.frankerfacez.com/v1/set/global (default_sets) · /v1/room/{twitch login} (→ room.twitch_id + set)
//         image: emoticon.urls["2"] (animated.["2"] when the emote is animated; FFZ serves those as webp)
//   Kick  https://kick.com/emotes/{slug} → [channel group {slug, emotes}, {name:'Global'}, {name:'Emojis'}]
//         image: https://files.kick.com/emotes/{id}/fullsize (GIF / WebP as uploaded: animated when the upload was)
//   Twitch  positions in the IRC `emotes` tag (server/chat/twitch.ts); there is no public list to read without a login
//   YouTube custom / member emoji arrive inline in the chat runs (server/chat/youtube.ts); there is no public list, so
//         the ones seen in chat are remembered.
import type { ChatPart, LivePlatform } from './chat.ts';

export type EmoteSource = 'twitch' | 'kick' | 'youtube' | '7tv' | 'bttv' | 'ffz';
export const EMOTE_SOURCES: EmoteSource[] = ['kick', 'twitch', 'youtube', '7tv', 'bttv', 'ffz'];
export const EMOTE_SOURCE_LABEL: Record<EmoteSource, string> = { twitch: 'Twitch', kick: 'Kick', youtube: 'YouTube', '7tv': '7TV', bttv: 'BetterTTV', ffz: 'FrankerFaceZ' };
/** channel = the streamer's own channel set · global = everyone's · seen = learned from chat (no list to read). */
export type EmoteScope = 'channel' | 'global' | 'seen';

export interface EmoteDef {
  id: string;
  name: string;
  src: EmoteSource;
  /** Image URL (https; pages load it through /api/chat/img). */
  url: string;
  scope: EmoteScope;
  /** Which chat the channel set belongs to (a 7TV set of the Kick channel = 'kick'). */
  platform?: LivePlatform;
  animated?: boolean;
  /** Zero-width (7TV): drawn over the emote before it. */
  zw?: boolean;
  /** Subscribers only (Kick / Twitch tier emotes). */
  sub?: boolean;
}

/** Stable key of an emote: "<source>:<id>" (sound rules and usage stats use it). */
export const emoteKey = (e: { src: EmoteSource; id: string }) => `${e.src}:${e.id}`;
export const EMOTE_KEY_RE = /^(twitch|kick|youtube|7tv|bttv|ffz):[\w:.~-]{1,80}$/;
const NAME_RE = /^\S{1,60}$/;
const ID_RE = /^[\w:.~-]{1,80}$/;
type J = Record<string, unknown>;
const obj = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '');
const https = (u: string) => (u.startsWith('//') ? `https:${u}` : u);
const okDef = (d: EmoteDef) => NAME_RE.test(d.name) && ID_RE.test(d.id) && /^https:\/\/[\w.-]+\//.test(d.url);

// ---------------------------------------------------------------- 7TV
/** A 7TV emote set (`/v3/emote-sets/global`, or a user's `emote_set`). */
export function parse7tvSet(set: unknown, scope: EmoteScope, platform?: LivePlatform): EmoteDef[] {
  const out: EmoteDef[] = [];
  for (const e0 of arr(obj(set).emotes)) {
    const e = obj(e0), d = obj(e.data), host = obj(d.host);
    const id = str(e.id) || str(d.id), name = str(e.name) || str(d.name), base = str(host.url);
    if (!id || !name || !base) continue;
    const files = arr(host.files).map(obj);
    const want = files.find((f) => f.name === '2x.webp') ?? files.find((f) => /^2x\./.test(str(f.name))) ?? files.find((f) => /\.webp$/.test(str(f.name)));
    const def: EmoteDef = { id, name, src: '7tv', url: `${https(base)}/${want ? str(want.name) : '2x.webp'}`, scope, ...(platform ? { platform } : {}) };
    if (d.animated === true) def.animated = true;
    if ((Number(e.flags) & 1) === 1) def.zw = true;
    if (okDef(def)) out.push(def);
  }
  return out;
}
/** `/v3/users/{platform}/{id}` → its active emote set (empty when the user has none / isn't on 7TV). */
export function parse7tvUser(user: unknown, platform: LivePlatform): EmoteDef[] {
  return parse7tvSet(obj(user).emote_set, 'channel', platform);
}

// ---------------------------------------------------------------- BetterTTV
const bttvUrl = (id: string) => `https://cdn.betterttv.net/emote/${id}/2x.webp`;
export function parseBttvList(list: unknown, scope: EmoteScope, platform?: LivePlatform): EmoteDef[] {
  const out: EmoteDef[] = [];
  for (const e0 of arr(list)) {
    const e = obj(e0), id = str(e.id), name = str(e.code);
    if (!id || !name) continue;
    const def: EmoteDef = { id, name, src: 'bttv', url: bttvUrl(id), scope, ...(platform ? { platform } : {}) };
    if (e.animated === true || e.imageType === 'gif') def.animated = true;
    if (okDef(def)) out.push(def);
  }
  return out;
}
/** `/3/cached/users/{twitch|youtube}/{id}` → the channel's own + shared emotes. */
export function parseBttvUser(user: unknown, platform: LivePlatform): EmoteDef[] {
  const u = obj(user);
  return [...parseBttvList(u.channelEmotes, 'channel', platform), ...parseBttvList(u.sharedEmotes, 'channel', platform)];
}

// ---------------------------------------------------------------- FrankerFaceZ
function ffzEmotes(set: unknown, scope: EmoteScope, platform?: LivePlatform): EmoteDef[] {
  const out: EmoteDef[] = [];
  for (const e0 of arr(obj(set).emoticons)) {
    const e = obj(e0), id = str(e.id), name = str(e.name), urls = obj(e.urls), anim = obj(e.animated);
    const still = str(urls['2']) || str(urls['1']) || str(urls['4']);
    const moving = str(anim['2']) || str(anim['1']) || str(anim['4']);
    if (!id || !name || !(still || moving)) continue;
    const def: EmoteDef = { id, name, src: 'ffz', url: https(moving || still), scope, ...(platform ? { platform } : {}) };
    if (moving) def.animated = true;
    if (okDef(def)) out.push(def);
  }
  return out;
}
/** `/v1/set/global` → the default (everyone's) sets only. */
export function parseFfzGlobal(json: unknown): EmoteDef[] {
  const j = obj(json), sets = obj(j.sets);
  const ids = arr(j.default_sets).map(str);
  return ids.flatMap((id) => ffzEmotes(sets[id], 'global'));
}
/** `/v1/room/{login}` → the channel's set + the Twitch user id FFZ knows (7TV / BTTV need it). */
export function parseFfzRoom(json: unknown): { emotes: EmoteDef[]; twitchId: string | null } {
  const j = obj(json), room = obj(j.room), sets = obj(j.sets);
  const set = str(room.set);
  const tid = str(room.twitch_id);
  return { emotes: set ? ffzEmotes(sets[set], 'channel', 'twitch') : [], twitchId: /^\d{1,20}$/.test(tid) ? tid : null };
}

// ---------------------------------------------------------------- Kick
export const kickEmoteUrl = (id: string) => `https://files.kick.com/emotes/${id}/fullsize`;
/** `https://kick.com/emotes/{slug}` → the channel's emotes (the group with a slug) + Kick's global ones. Emoji are
 *  left out (they are characters, not channel emotes). */
export function parseKickEmotes(json: unknown, slug: string): EmoteDef[] {
  const out: EmoteDef[] = [];
  for (const g0 of arr(json)) {
    const g = obj(g0);
    const own = typeof g.slug === 'string' && g.slug.toLowerCase() === slug.toLowerCase();
    const global = !own && /^global$/i.test(str(g.name));
    if (!own && !global) continue;
    for (const e0 of arr(g.emotes)) {
      const e = obj(e0), id = str(e.id), name = str(e.name);
      if (!/^\d{1,20}$/.test(id) || !name) continue;
      const def: EmoteDef = { id, name, src: 'kick', url: kickEmoteUrl(id), scope: own ? 'channel' : 'global', platform: 'kick' };
      if (e.subscribers_only === true) def.sub = true;
      if (okDef(def)) out.push(def);
    }
  }
  return out;
}

// ---------------------------------------------------------------- chat parts: which emote is this?
/** The key of an emote part: its own `k`, else read from a platform's CDN URL (natives arrive without one). */
export function partKey(p: { n: string; u: string; k?: string }): string | null {
  if (p.k && EMOTE_KEY_RE.test(p.k)) return p.k;
  let m = /static-cdn\.jtvnw\.net\/emoticons\/v[12]\/([\w-]+)\//.exec(p.u);
  if (m) return `twitch:${m[1]}`;
  m = /files\.kick\.com\/emotes\/(\d+)/.exec(p.u);
  if (m) return `kick:${m[1]}`;
  m = /cdn\.7tv\.app\/emote\/([\w]+)\//.exec(p.u);
  if (m) return `7tv:${m[1]}`;
  m = /cdn\.betterttv\.net\/emote\/([\w]+)\//.exec(p.u);
  if (m) return `bttv:${m[1]}`;
  m = /cdn\.frankerfacez\.com\/emote\/(\d+)\//.exec(p.u);
  if (m) return `ffz:${m[1]}`;
  if (/(ggpht|googleusercontent|ytimg)\.com\//.test(p.u)) { const n = p.n.replace(/[^\w:.~-]/g, '').slice(0, 60); return n ? `youtube:${n}` : null; }
  return null;
}
/** The emote a native part shows, as a "seen in chat" EmoteDef (Twitch / Kick / YouTube natives). */
export function seenDef(p: { n: string; u: string; k?: string }, platform: LivePlatform): EmoteDef | null {
  const key = partKey(p);
  if (!key) return null;
  const i = key.indexOf(':'), src = key.slice(0, i) as EmoteSource, id = key.slice(i + 1);
  if (src !== 'twitch' && src !== 'kick' && src !== 'youtube') return null;
  const def: EmoteDef = { id, name: p.n.slice(0, 60) || id, src, url: p.u, scope: 'seen', platform };
  return okDef(def) ? def : null;
}

/** Name → emote for one chat (the first list wins a name clash: pass channel sets before global ones). */
export type EmoteIndex = Map<string, EmoteDef>;
export function buildIndex(...lists: EmoteDef[][]): EmoteIndex {
  const m: EmoteIndex = new Map();
  for (const l of lists) for (const e of l) if (!m.has(e.name)) m.set(e.name, e);
  return m;
}

/** Third-party emotes in a message: the words of its text parts that name an emote become emote parts (the platform's
 *  own emote parts are kept as they are). `parts` absent = the plain `text`. Returns undefined when nothing changed and
 *  there were no parts to begin with. */
export function enrichParts(text: string, parts: ChatPart[] | undefined, index: EmoteIndex | null): ChatPart[] | undefined {
  if (!index || !index.size) return parts;
  const src: ChatPart[] = parts ?? [{ t: 'text', v: text }];
  const out: ChatPart[] = [];
  let changed = false;
  const pushText = (v: string) => { if (!v) return; const last = out[out.length - 1]; if (last && last.t === 'text') last.v += v; else out.push({ t: 'text', v }); };
  for (const p of src) {
    if (p.t !== 'text') { out.push(p); continue; }
    for (const w of p.v.split(/(\s+)/)) {
      const e = w && !/^\s/.test(w) ? index.get(w) : undefined;
      if (e) { out.push({ t: 'emote', n: e.name, u: e.url, k: emoteKey(e), ...(e.zw ? { zw: true } : {}) }); changed = true; }
      else pushText(w);
    }
  }
  if (!changed) return parts;
  return out;
}

/** The emotes of a message, in order (key, name, image), for usage stats and emote sounds. */
export function emotesOf(parts: ChatPart[] | undefined): { key: string; name: string; url: string }[] {
  const out: { key: string; name: string; url: string }[] = [];
  for (const p of parts ?? []) {
    if (p.t !== 'emote') continue;
    const key = partKey(p);
    if (key) out.push({ key, name: p.n, url: p.u });
  }
  return out;
}

/** Search the list the Emotes panel shows (case-insensitive name contains; empty = all). */
export function searchEmotes<T extends { name: string }>(list: T[], q: string): T[] {
  const s = q.trim().toLowerCase();
  return s ? list.filter((e) => e.name.toLowerCase().includes(s)) : list;
}

// ---------------------------------------------------------------- the panel's API shapes (GET /api/chat/emotes …)
export interface EmoteSetInfo {
  /** "7tv:twitch:71092938", "bttv:global" … */
  key: string;
  src: EmoteSource;
  scope: EmoteScope;
  platform?: LivePlatform;
  /** "Your Kick channel", "7TV · global" … */
  label: string;
  count: number;
  /** Epoch ms of the last good read (0 = never). */
  at: number;
  /** A plain-language problem ("7TV doesn't know this channel yet" …), when the last read failed. */
  error?: string;
}
export interface EmoteListing { sets: EmoteSetInfo[]; emotes: EmoteDef[]; refreshing: boolean; at: number }
export interface EmoteUse { key: string; name: string; url: string; n: number; users: number; last: number }
export interface EmoteStats { since: number; total: number; top: EmoteUse[] }
