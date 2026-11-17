// The streamer's emotes, read for them (owner: "integrate and read custom emotes from my channels"): from the channel
// names already in the chat settings (config/chat.json) the helper reads each channel's emote sets — the platform's own
// (Kick's own list) and 7TV / BetterTTV / FrankerFaceZ — keeps them in
// cache/chat/emotes/ (read again every 30 minutes, or when "Refresh" is pressed) and:
//   · turns emote words in chat into emote parts (enrich), for every platform the extension sets cover
//     (Twitch: 7TV + BTTV + FFZ · Kick: 7TV · YouTube: BTTV + the 7TV / BTTV globals);
//   · remembers the native emotes it sees (Twitch / Kick / YouTube member emoji: YouTube has no public list);
//   · counts what chat used this stream (the Emotes panel's "Used this stream").
// Everything read is public and read only (no account). Failures are kept per set with a plain sentence; a set that
// fails keeps its last good copy. Pure parsing lives in shared/emotes.ts (tools/emotes_unit.ts).
import fs from 'node:fs';
import path from 'node:path';
import { CACHE_DIR } from '../paths.ts';
import { getJson } from './kick.ts';
import type { ChatEvent, ChatPart, LivePlatform } from '../../shared/chat.ts';
import {
  buildIndex, emoteKey, emotesOf, enrichParts, parse7tvSet, parse7tvUser, parseBttvList, parseBttvUser, parseFfzGlobal, parseFfzRoom,
  parseKickEmotes, partKey, seenDef, EMOTE_SOURCE_LABEL,
  type EmoteDef, type EmoteIndex, type EmoteListing, type EmoteSetInfo, type EmoteStats, type EmoteUse, type EmoteSource, type EmoteScope,
} from '../../shared/emotes.ts';

export interface EmoteBases { seventv: string; bttv: string; ffz: string; kick: string; youtube: string }
export const EMOTE_BASES: EmoteBases = { seventv: 'https://7tv.io', bttv: 'https://api.betterttv.net', ffz: 'https://api.frankerfacez.com', kick: 'https://kick.com', youtube: 'https://www.youtube.com' };
/** A JSON read: resolves the parsed body; rejects with an Error whose `status` is the HTTP status when there was one. */
export type JsonGet = (url: string, opts?: { kick?: boolean; headers?: Record<string, string> }) => Promise<unknown>;
export type TextGet = (url: string) => Promise<string>;

/** The channels the emotes are read for (from config/chat.json). */
export interface EmoteChannels {
  twitch?: { login: string };
  kick?: { slug: string; sevenTv: boolean };
  youtube?: { channelId?: string; handle?: string };
}

const TTL = 30 * 60_000;                       // (lists change when the streamer adds an emote: read every 30 min)
const RETRY = 10 * 60_000;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const SEEN_MAX = 600;

interface SetSpec { key: string; src: EmoteSource; scope: EmoteScope; platform?: LivePlatform; label: string; read: () => Promise<EmoteDef[]> }
interface SetEntry { info: EmoteSetInfo; emotes: EmoteDef[]; tried: number }
interface Use { name: string; url: string; n: number; users: Set<string>; last: number }

const httpStatus = (e: unknown): number => {
  const s = (e as { status?: unknown })?.status;
  if (typeof s === 'number') return s;
  const m = /\b(\d{3})\b/.exec(String((e as Error)?.message ?? ''));
  return m ? Number(m[1]) : 0;
};
const fileOf = (dir: string, key: string) => path.join(dir, `${key.replace(/[^\w.-]/g, '_')}.json`);

export class EmoteStore {
  private sets = new Map<string, SetEntry>();
  private seen = new Map<string, EmoteDef>();
  private index: Partial<Record<LivePlatform, EmoteIndex>> = {};
  private byUrl = new Map<string, EmoteDef>();
  private uses = new Map<string, Use>();
  private since: number;
  private total = 0;
  private chans: EmoteChannels = {};
  private twitchId: string | null = null;
  private kickUserId: string | null = null;
  private ytId: string | null = null;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private seenDirty = false;
  private bases: EmoteBases;
  refreshedAt = 0;

  constructor(private opt: { dir: string; json: JsonGet; text?: TextGet; bases?: Partial<EmoteBases>; now?: () => number }) {
    this.bases = { ...EMOTE_BASES, ...(opt.bases ?? {}) };
    this.since = this.now();
    try { const j = JSON.parse(fs.readFileSync(path.join(opt.dir, 'seen.json'), 'utf8')) as EmoteDef[]; for (const e of j) if (e?.src && e.id && e.url) this.seen.set(emoteKey(e), e); } catch { /* none yet */ }
  }
  private now() { return this.opt.now ? this.opt.now() : Date.now(); }

  // ---------------------------------------------------------------- which sets
  /** The streamer's channels changed (the chat settings were saved / the helper started): read their sets. */
  configure(ch: EmoteChannels, opts: { refresh?: boolean } = {}) {
    const prev = JSON.stringify(this.chans);
    this.chans = ch;
    if (prev !== JSON.stringify(ch)) {
      // another channel: its ids are found again; sets of channels no longer configured are dropped
      if (ch.twitch?.login !== JSON.parse(prev || '{}').twitch?.login) this.twitchId = null;
      if (ch.kick?.slug !== JSON.parse(prev || '{}').kick?.slug) this.kickUserId = null;
      if (ch.youtube?.channelId !== JSON.parse(prev || '{}').youtube?.channelId || ch.youtube?.handle !== JSON.parse(prev || '{}').youtube?.handle) this.ytId = null;
    }
    const ytc = [ch.youtube?.channelId, ch.youtube?.handle].find((v) => !!v && /^UC[\w-]{20,}$/.test(v));
    this.ytId ??= ytc ?? null;
    this.loadCached();
    this.rebuild();
    if (opts.refresh !== false) void this.refresh(false);
    if (!this.timer && opts.refresh !== false) { this.timer = setInterval(() => void this.refresh(false), 10 * 60_000); this.timer.unref?.(); }
  }
  stop() { if (this.timer) clearInterval(this.timer); this.timer = null; }

  /** The Twitch channel's user id from its IRC ROOMSTATE (7TV / BTTV look channels up by id). */
  noteTwitchId(id: string) {
    if (!/^\d{1,20}$/.test(id) || id === this.twitchId) return;
    this.twitchId = id;
    // the sets that waited for this id are read now (not after the 10-minute retry)
    for (const [k, e] of this.sets) if (e.info.error && /^(7tv|bttv):twitch:|^twitch:channel:/.test(k)) e.tried = 0;
    void this.refresh(false);
  }

  private specs(): SetSpec[] {
    const b = this.bases, J = this.opt.json;
    // nobody's chat is connected: nothing to read (no request to 7TV / BTTV / FFZ for people who don't use chat)
    if (!this.chans.twitch?.login && !this.chans.kick?.slug && !this.chans.youtube) return [];
    const out: SetSpec[] = [
      { key: '7tv:global', src: '7tv', scope: 'global', label: '7TV · everyone', read: async () => parse7tvSet(await J(`${b.seventv}/v3/emote-sets/global`), 'global') },
      { key: 'bttv:global', src: 'bttv', scope: 'global', label: 'BetterTTV · everyone', read: async () => parseBttvList(await J(`${b.bttv}/3/cached/emotes/global`), 'global') },
      { key: 'ffz:global', src: 'ffz', scope: 'global', label: 'FrankerFaceZ · everyone', read: async () => parseFfzGlobal(await J(`${b.ffz}/v1/set/global`)) },
    ];
    const tw = this.chans.twitch;
    if (tw?.login) {
      const login = tw.login;
      out.push({ key: `ffz:twitch:${login}`, src: 'ffz', scope: 'channel', platform: 'twitch', label: 'FrankerFaceZ · your Twitch', read: async () => { const r = parseFfzRoom(await J(`${b.ffz}/v1/room/${encodeURIComponent(login)}`)); if (r.twitchId && !this.twitchId) this.twitchId = r.twitchId; return r.emotes; } });
      out.push({ key: `7tv:twitch:${login}`, src: '7tv', scope: 'channel', platform: 'twitch', label: '7TV · your Twitch', read: async () => { const id = await this.twitchUserId(); return parse7tvUser(await J(`${b.seventv}/v3/users/twitch/${id}`), 'twitch'); } });
      out.push({ key: `bttv:twitch:${login}`, src: 'bttv', scope: 'channel', platform: 'twitch', label: 'BetterTTV · your Twitch', read: async () => { const id = await this.twitchUserId(); return parseBttvUser(await J(`${b.bttv}/3/cached/users/twitch/${id}`), 'twitch'); } });
    }
    const k = this.chans.kick;
    if (k?.slug) {
      const slug = k.slug;
      out.push({ key: `kick:${slug}`, src: 'kick', scope: 'channel', platform: 'kick', label: 'Your Kick channel', read: async () => parseKickEmotes(await J(`${b.kick}/emotes/${encodeURIComponent(slug)}`, { kick: true }), slug) });
      if (k.sevenTv) out.push({ key: `7tv:kick:${slug}`, src: '7tv', scope: 'channel', platform: 'kick', label: '7TV · your Kick', read: async () => { const id = await this.kickUid(); return parse7tvUser(await J(`${b.seventv}/v3/users/kick/${id}`), 'kick'); } });
    }
    const yt = this.chans.youtube;
    if (yt?.channelId || yt?.handle) {
      const tag = (yt.channelId || yt.handle || '').replace(/[^\w@.-]/g, '');
      out.push({ key: `bttv:youtube:${tag}`, src: 'bttv', scope: 'channel', platform: 'youtube', label: 'BetterTTV · your YouTube', read: async () => { const id = await this.youtubeId(); return parseBttvUser(await J(`${b.bttv}/3/cached/users/youtube/${id}`), 'youtube'); } });
    }
    return out;
  }

  private async twitchUserId(): Promise<string> {
    if (this.twitchId) return this.twitchId;
    const login = this.chans.twitch?.login ?? '';
    const r = parseFfzRoom(await this.opt.json(`${this.bases.ffz}/v1/room/${encodeURIComponent(login)}`).catch(() => null));
    if (r.twitchId) { this.twitchId = r.twitchId; return r.twitchId; }
    throw Object.assign(new Error('waiting for your Twitch chat to connect once (it tells us the channel id)'), { status: 0, soft: true });
  }
  private async kickUid(): Promise<string> {
    if (this.kickUserId) return this.kickUserId;
    const slug = this.chans.kick?.slug ?? '';
    const j = await this.opt.json(`${this.bases.kick}/api/v2/channels/${encodeURIComponent(slug)}`, { kick: true }) as Record<string, unknown>;
    const id = String(j?.user_id ?? (j?.user as Record<string, unknown> | undefined)?.id ?? '');
    if (!/^\d{1,20}$/.test(id)) throw new Error('Kick did not say who owns this channel');
    this.kickUserId = id;
    return id;
  }
  private async youtubeId(): Promise<string> {
    if (this.ytId) return this.ytId;
    const h = (this.chans.youtube?.handle ?? '').trim();
    if (!h || !this.opt.text) throw new Error('add your YouTube channel to read its emotes');
    const html = await this.opt.text(`${this.bases.youtube}/${h.startsWith('@') ? h : '@' + h}`);
    const m = /"externalId":"(UC[\w-]{20,})"/.exec(html) ?? /"browseId":"(UC[\w-]{20,})"/.exec(html) ?? /channel_id=(UC[\w-]{20,})/.exec(html);
    if (!m) throw new Error('YouTube did not show the channel id for this handle');
    this.ytId = m[1];
    return m[1];
  }

  // ---------------------------------------------------------------- reading
  /** Read every set older than 30 minutes (force: all of them now). One run at a time. */
  refresh(force: boolean): Promise<void> {
    if (this.running) return this.running;
    this.running = (async () => {
      const now = this.now();
      for (const s of this.specs()) {
        const cur = this.sets.get(s.key);
        if (!force && cur && ((cur.info.at && now - cur.info.at < TTL) || (cur.info.error && now - cur.tried < RETRY))) continue;
        await this.readSet(s);
      }
      this.refreshedAt = this.now();
      this.rebuild();
    })().finally(() => { this.running = null; });
    return this.running;
  }
  private async readSet(s: SetSpec) {
    const prev = this.sets.get(s.key);
    const info: EmoteSetInfo = { key: s.key, src: s.src, scope: s.scope, ...(s.platform ? { platform: s.platform } : {}), label: s.label, count: prev?.emotes.length ?? 0, at: prev?.info.at ?? 0 };
    try {
      const emotes = (await s.read()).slice(0, 3000);
      this.sets.set(s.key, { info: { ...info, count: emotes.length, at: this.now() }, emotes, tried: this.now() });
      this.save(s.key, emotes);
    } catch (e) {
      const st = httpStatus(e);
      if (st === 404 || st === 400) {
        // the channel simply isn't on that service (no 7TV / BTTV account): nothing to show, nothing wrong
        this.sets.set(s.key, { info: { ...info, count: 0, at: this.now() }, emotes: [], tried: this.now() });
        this.save(s.key, []);
        return;
      }
      const why = (e as { soft?: boolean }).soft ? (e as Error).message
        : st === 403 || st === 429 ? `${EMOTE_SOURCE_LABEL[s.src]} is busy or refused the request right now (tries again later)`
        : `couldn't reach ${EMOTE_SOURCE_LABEL[s.src]} (no internet, or it is down); tries again later`;
      this.sets.set(s.key, { info: { ...info, error: why }, emotes: prev?.emotes ?? [], tried: this.now() });
    }
  }
  private save(key: string, emotes: EmoteDef[]) {
    try { fs.mkdirSync(this.opt.dir, { recursive: true }); const f = fileOf(this.opt.dir, key), tmp = f + '.tmp'; fs.writeFileSync(tmp, JSON.stringify({ at: this.now(), emotes })); fs.renameSync(tmp, f); }
    catch { /* the cache is best effort */ }
  }
  private loadCached() {
    for (const s of this.specs()) {
      if (this.sets.has(s.key)) continue;
      try {
        const j = JSON.parse(fs.readFileSync(fileOf(this.opt.dir, s.key), 'utf8')) as { at: number; emotes: EmoteDef[] };
        if (!Array.isArray(j.emotes)) continue;
        this.sets.set(s.key, { info: { key: s.key, src: s.src, scope: s.scope, ...(s.platform ? { platform: s.platform } : {}), label: s.label, count: j.emotes.length, at: Number(j.at) || 0 }, emotes: j.emotes, tried: 0 });
      } catch { /* not cached yet */ }
    }
  }

  // ---------------------------------------------------------------- the word index per chat
  private list(key: string) { return this.sets.get(key)?.emotes ?? []; }
  private rebuild() {
    const tw = this.chans.twitch?.login, k = this.chans.kick?.slug, yt = this.chans.youtube;
    const ytTag = (yt?.channelId || yt?.handle || '').replace(/[^\w@.-]/g, '');
    const G7 = this.list('7tv:global'), GB = this.list('bttv:global'), GF = this.list('ffz:global');
    this.index = {
      twitch: buildIndex(tw ? this.list(`7tv:twitch:${tw}`) : [], tw ? this.list(`bttv:twitch:${tw}`) : [], tw ? this.list(`ffz:twitch:${tw}`) : [], G7, GB, GF),
      kick: buildIndex(k ? this.list(`7tv:kick:${k}`) : [], G7),
      youtube: buildIndex(ytTag ? this.list(`bttv:youtube:${ytTag}`) : [], GB, G7),
    };
    this.byUrl.clear();
    for (const e of this.sets.values()) for (const d of e.emotes) this.byUrl.set(d.url, d);
  }

  /** Third-party emote words → emote parts; every emote part gets its key (stats / sounds). */
  enrich(platform: LivePlatform, text: string, parts: ChatPart[] | undefined): ChatPart[] | undefined {
    const out = enrichParts(text, parts, this.index[platform] ?? null);
    if (!out) return out;
    return out.map((p) => {
      if (p.t !== 'emote' || p.k) return p;
      const d = this.byUrl.get(p.u);
      if (d) return { ...p, k: emoteKey(d), ...(d.zw ? { zw: true } : {}) };
      const k = partKey(p);                           // (Twitch / Kick / YouTube natives: the key from the CDN URL)
      return k ? { ...p, k } : p;
    });
  }

  /** A chat event went out: count its emotes, remember the natives. Returns its emotes (for the sound trigger). */
  note(e: ChatEvent): { key: string; name: string; url: string }[] {
    if (e.kind !== 'chat' || !e.parts) return [];
    const em = emotesOf(e.parts);
    if (!em.length) return em;
    const user = e.user.toLowerCase(), now = this.now();
    const once = new Set<string>();
    for (const x of em) {
      if (!e.test) {
        const u = this.uses.get(x.key) ?? { name: x.name, url: x.url, n: 0, users: new Set<string>(), last: 0 };
        u.n++; u.last = now; if (u.users.size < 5000) u.users.add(user);
        this.uses.set(x.key, u);
        this.total++;
      }
      if (once.has(x.key)) continue;
      once.add(x.key);
      if (!this.seen.has(x.key) && e.platform !== 'test') {
        const p = e.parts.find((q) => q.t === 'emote' && (q.k === x.key || q.u === x.url));
        const d = p && p.t === 'emote' ? seenDef(p, e.platform as LivePlatform) : null;
        if (d) { this.seen.set(x.key, d); this.seenDirty = true; while (this.seen.size > SEEN_MAX) this.seen.delete(this.seen.keys().next().value as string); }
      }
    }
    if (this.seenDirty) this.saveSeenSoon();
    return em;
  }
  private seenT: NodeJS.Timeout | null = null;
  private saveSeenSoon() {
    if (this.seenT) return;
    this.seenT = setTimeout(() => {
      this.seenT = null; this.seenDirty = false;
      try { fs.mkdirSync(this.opt.dir, { recursive: true }); fs.writeFileSync(path.join(this.opt.dir, 'seen.json'), JSON.stringify([...this.seen.values()])); } catch { /* best effort */ }
    }, 3000);
    this.seenT.unref?.();
  }

  // ---------------------------------------------------------------- what the panel reads
  listing(): EmoteListing {
    const sets = this.specs().map((s) => this.sets.get(s.key)?.info ?? { key: s.key, src: s.src, scope: s.scope, ...(s.platform ? { platform: s.platform } : {}), label: s.label, count: 0, at: 0 });
    const emotes: EmoteDef[] = [], have = new Set<string>();
    for (const s of this.specs()) for (const e of this.list(s.key)) { const k = emoteKey(e); if (!have.has(k)) { have.add(k); emotes.push(e); } }
    for (const e of this.seen.values()) { const k = emoteKey(e); if (!have.has(k)) { have.add(k); emotes.push(e); } }
    return { sets, emotes, refreshing: !!this.running, at: this.refreshedAt };
  }
  stats(n = 60): EmoteStats {
    const top: EmoteUse[] = [...this.uses.entries()].map(([key, u]) => ({ key, name: u.name, url: u.url, n: u.n, users: u.users.size, last: u.last }))
      .sort((a, b) => b.n - a.n || b.last - a.last).slice(0, n);
    return { since: this.since, total: this.total, top };
  }
  resetStats() { this.uses.clear(); this.total = 0; this.since = this.now(); }
}

/** The channels of the chat settings (config/chat.json). */
export function emoteChannelsOf(c: { twitch: { channel: string }; kick: { channel: string; sevenTv?: boolean }; youtube: { channelId?: string; handle?: string } }): EmoteChannels {
  const login = String(c.twitch.channel || '').toLowerCase().replace(/^https?:\/\/(www\.)?twitch\.tv\//, '').replace(/[^a-z0-9_]/g, '');
  const slug = String(c.kick.channel || '').toLowerCase().replace(/^https?:\/\/(www\.)?kick\.com\//, '').replace(/[^a-z0-9_-]/g, '');
  const ch: EmoteChannels = {};
  if (login) ch.twitch = { login };
  if (slug) ch.kick = { slug, sevenTv: c.kick.sevenTv !== false };
  const cid = String(c.youtube.channelId || ''), hd = String(c.youtube.handle || '').trim();
  if (cid || hd) ch.youtube = { ...(cid ? { channelId: cid } : {}), ...(hd ? { handle: hd } : {}) };
  return ch;
}

// ---------------------------------------------------------------- the helper's store (real network)
/** JSON over https: Kick's endpoints through node:https with a browser's headers (its Cloudflare refuses Node's fetch,
 *  see server/chat/kick.ts), everything else with fetch. 12 s timeout, 2 MB at most. */
export const netJson: JsonGet = async (url, o) => {
  if (o?.kick) return getJson(url, { 'User-Agent': UA, Accept: 'application/json', 'Accept-Language': 'en-US,en;q=0.9' }, 12000);
  const r = await fetch(url, { headers: { 'User-Agent': 'vtube-pro/1.0', Accept: 'application/json', ...(o?.headers ?? {}) }, signal: AbortSignal.timeout(12000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const t = await r.text();
  if (t.length > 8 << 20) throw new Error('too big');
  return JSON.parse(t);
};
const netText: TextGet = async (url) => {
  const r = await fetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html', 'Accept-Language': 'en-US,en;q=0.9', Cookie: 'CONSENT=YES+1; SOCS=CAI' }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  return (await r.text()).slice(0, 3 << 20);
};
/** Tests only: VTP_EMOTE_BASE=http://127.0.0.1:<port> points every provider at a local mock (/7tv /bttv /ffz /kick
 *  /yt under it). Loopback http only: never a way to send the helper anywhere else. */
function testBases(): Partial<EmoteBases> | undefined {
  const b = process.env.VTP_EMOTE_BASE;
  if (!b || !/^http:\/\/127\.0\.0\.1:\d{2,5}$/.test(b)) return undefined;
  return { seventv: `${b}/7tv`, bttv: `${b}/bttv`, ffz: `${b}/ffz`, kick: `${b}/kick`, youtube: `${b}/yt` };
}
export const emoteStore = new EmoteStore({ dir: path.join(CACHE_DIR, 'chat', 'emotes'), json: netJson, text: netText, bases: testBases() });
