// Chat connector settings: config/chat.json (gitignored, this PC only). The Rumble API key is a secret: it is never
// returned by the API, broadcast, or written anywhere else. "Import from an earlier overlay" READS the overlay's
// config.json (same field names: kick.channel, rumble.apiKey, youtube.handle …) with the performer's click.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CONFIG_DIR } from '../paths.ts';
import type { KickConfig } from './kick.ts';
import type { RumbleConfig } from './rumble.ts';
import type { YouTubeConfig } from './youtube.ts';
import { TIKFINITY_WS, TikTokChat, type TikTokConfig } from './tiktok.ts';
import type { TwitchConfig } from './twitch.ts';

export const CHAT_CONFIG_FILE = path.join(CONFIG_DIR, 'chat.json');

export interface ChatConfig {
  kick: KickConfig;
  rumble: RumbleConfig;
  youtube: YouTubeConfig;
  twitch: TwitchConfig;
  tiktok: TikTokConfig;
  /** Names that count as "you" for @mention highlights (channel names are added automatically). */
  names: string[];
  /** an earlier overlay VIPs (highlighted names). */
  vips: string[];
  /** Download emote images through this PC's server (cached in cache/chat/img). */
  emotes: boolean;
}

export const DEFAULT_CHAT_CONFIG: ChatConfig = {
  kick: { enabled: false, channel: '', chatroomId: null, channelId: null, sevenTv: true },
  rumble: { enabled: false, apiKey: '', streamId: '', ssePath: '', pollIntervalMs: 4000, announceFollowers: true },
  youtube: { enabled: false, handle: '', channelId: '', videoId: '', intervalMs: 1200, reconnectMs: 15000 },
  twitch: { enabled: false, channel: '' },
  tiktok: { enabled: false, user: '', bridge: TIKFINITY_WS, likes: false, joins: false },
  names: [], vips: [], emotes: true,
};

/** What the studio sees (no secrets). */
export interface ChatConfigPublic {
  kick: { enabled: boolean; channel: string; sevenTv: boolean };
  rumble: { enabled: boolean; hasKey: boolean; pollIntervalMs: number; announceFollowers: boolean };
  youtube: { enabled: boolean; handle: string; channelId: string; videoId: string };
  twitch: { enabled: boolean; channel: string };
  tiktok: { enabled: boolean; user: string; bridge: string; likes: boolean; joins: boolean };
  names: string[]; vips: string[]; emotes: boolean;
  exists: boolean;
}

const str = (v: unknown, max = 200) => (typeof v === 'string' ? v.trim().slice(0, max) : undefined);
const bool = (v: unknown, d: boolean) => (typeof v === 'boolean' ? v : d);
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
const ENDPOINT = (v: unknown) => { const s = str(v, 200); return s && /^(https?|wss?):\/\/[\w.\-:[\]]+(\/[\w\-./?=&%]*)?$/.test(s) ? s : undefined; };
const names = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string').map((x) => x.trim().slice(0, 40)).filter(Boolean).slice(0, 60) : undefined);

/** Rumble: the whole "Live Stream API" URL may be pasted (…/-livestream-api/get-data?key=XXXX): keep the key. */
export function rumbleKey(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  const m = /[?&]key=([^&\s#]+)/.exec(v);
  return (m ? decodeURIComponent(m[1]) : v).replace(/[^\w\-.~]/g, '').slice(0, 300);
}
/** YouTube: a pasted link → @handle / channel id / video id (youtube.com/@x, /channel/UC…, watch?v=…, /live/…, youtu.be/…). */
export function ytLink(v: string | undefined, d: { handle?: string; channelId?: string; videoId?: string }) {
  if (v === undefined) return d;
  let m: RegExpExecArray | null;
  if ((m = /youtube\.com\/(@[\w.\-]+)/i.exec(v))) return { ...d, handle: m[1] };
  if ((m = /youtube\.com\/channel\/(UC[\w-]{20,})/i.exec(v))) return { ...d, handle: '', channelId: m[1] };
  if ((m = /(?:[?&]v=|youtu\.be\/|\/live\/)([\w-]{11})/i.exec(v))) return { ...d, handle: '', videoId: m[1] };
  return { ...d, handle: v.slice(0, 100) };
}

export function sanitizeChatConfig(o: unknown, b: ChatConfig = DEFAULT_CHAT_CONFIG): ChatConfig {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, Record<string, unknown> | unknown>;
  const tw = (x.twitch ?? {}) as Record<string, unknown>, tt = (x.tiktok ?? {}) as Record<string, unknown>;
  const bt = b.twitch ?? DEFAULT_CHAT_CONFIG.twitch, bk = b.tiktok ?? DEFAULT_CHAT_CONFIG.tiktok;
  const bridge = str(tt.bridge, 200);
  const k = (x.kick ?? {}) as Record<string, unknown>, r = (x.rumble ?? {}) as Record<string, unknown>, y = (x.youtube ?? {}) as Record<string, unknown>;
  const id = (v: unknown, d: number | null | undefined) => (typeof v === 'number' && Number.isInteger(v) && v > 0 ? v : v === null ? null : d ?? null);
  const kickChannel = (str(k.channel, 60) ?? b.kick.channel).replace(/^https?:\/\/(www\.)?kick\.com\//i, '').replace(/[^\w-]/g, '').toLowerCase();
  const sameKick = kickChannel === b.kick.channel;   // (another channel typed in: the old one's ids no longer apply)
  return {
    kick: {
      enabled: bool(k.enabled, b.kick.enabled),
      channel: kickChannel,
      chatroomId: id(k.chatroomId, sameKick ? b.kick.chatroomId : null), channelId: id(k.channelId, sameKick ? b.kick.channelId : null),
      sevenTv: bool(k.sevenTv, b.kick.sevenTv !== false),
      apiBase: ENDPOINT(k.apiBase) ?? b.kick.apiBase, realtimeBase: ENDPOINT(k.realtimeBase) ?? b.kick.realtimeBase, pusher: ENDPOINT(k.pusher) ?? b.kick.pusher, sevenTvBase: ENDPOINT(k.sevenTvBase) ?? b.kick.sevenTvBase,
    },
    rumble: {
      enabled: bool(r.enabled, b.rumble.enabled),
      apiKey: rumbleKey(str(r.apiKey, 400)) ?? b.rumble.apiKey,
      streamId: str(r.streamId, 40) ?? b.rumble.streamId, ssePath: ENDPOINT(r.ssePath) ?? (r.ssePath === '' ? '' : b.rumble.ssePath),
      pollIntervalMs: num(r.pollIntervalMs, 2000, 60000, b.rumble.pollIntervalMs ?? 4000),
      announceFollowers: bool(r.announceFollowers, b.rumble.announceFollowers !== false),
      apiBase: ENDPOINT(r.apiBase) ?? b.rumble.apiBase,
    },
    youtube: {
      enabled: bool(y.enabled, b.youtube.enabled),
      ...ytLink(str(y.handle, 200), { handle: b.youtube.handle, channelId: str(y.channelId, 40) ?? b.youtube.channelId, videoId: str(y.videoId, 20) ?? b.youtube.videoId }),
      intervalMs: num(y.intervalMs, 700, 10000, b.youtube.intervalMs ?? 1200), reconnectMs: num(y.reconnectMs, 5000, 120000, b.youtube.reconnectMs ?? 15000),
      base: ENDPOINT(y.base) ?? b.youtube.base,
    },
    twitch: {
      enabled: bool(tw.enabled, bt.enabled),
      channel: (str(tw.channel, 80) ?? bt.channel).replace(/^https?:\/\/(www\.)?twitch\.tv\//i, '').replace(/[^\w]/g, '').toLowerCase().slice(0, 25),
      irc: ENDPOINT(tw.irc) ?? bt.irc,
    },
    tiktok: {
      enabled: bool(tt.enabled, bk.enabled),
      user: (str(tt.user, 60) ?? bk.user).replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '').replace(/\/live.*$/i, '').replace(/[^\w.@]/g, ''),
      bridge: bridge !== undefined ? (bridge === '' ? TIKFINITY_WS : TikTokChat.bridgeOk(bridge) ? bridge : bk.bridge) : bk.bridge,
      likes: bool(tt.likes, bk.likes === true), joins: bool(tt.joins, bk.joins === true),
    },
    names: names(x.names) ?? b.names,
    vips: names(x.vips) ?? b.vips,
    emotes: bool(x.emotes, b.emotes),
  };
}

export function chatConfigExists() { return fs.existsSync(CHAT_CONFIG_FILE); }
export function loadChatConfig(): ChatConfig {
  try { return sanitizeChatConfig(JSON.parse(fs.readFileSync(CHAT_CONFIG_FILE, 'utf8'))); } catch { return sanitizeChatConfig({}); }
}
export function saveChatConfig(c: ChatConfig) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CHAT_CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(c, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, CHAT_CONFIG_FILE);
}
export function publicChatConfig(c: ChatConfig): ChatConfigPublic {
  return {
    kick: { enabled: c.kick.enabled, channel: c.kick.channel, sevenTv: c.kick.sevenTv !== false },
    rumble: { enabled: c.rumble.enabled, hasKey: !!c.rumble.apiKey, pollIntervalMs: c.rumble.pollIntervalMs ?? 4000, announceFollowers: c.rumble.announceFollowers !== false },
    youtube: { enabled: c.youtube.enabled, handle: c.youtube.handle ?? '', channelId: c.youtube.channelId ?? '', videoId: c.youtube.videoId ?? '' },
    twitch: { enabled: c.twitch.enabled, channel: c.twitch.channel },
    tiktok: { enabled: c.tiktok.enabled, user: c.tiktok.user, bridge: c.tiktok.bridge, likes: c.tiktok.likes === true, joins: c.tiktok.joins === true },
    names: c.names, vips: c.vips, emotes: c.emotes, exists: chatConfigExists(),
  };
}

// ---------------------------------------------------------------- an earlier overlay import
/** Where the overlay usually lives (the performer can type another folder). */
export const OVERLAY_DEFAULT_DIR = path.join(os.homedir(), 'Desktop', 'my-overlay');

export interface OverlayPreview { ok: boolean; error?: string; dir: string; kick?: string; youtube?: string; rumbleKey: boolean; vips: number; enabled: string[] }

/** Read the overlay's config.json (read only). Returns the sanitised chat part + a secret-free preview. */
export function readOverlayConfig(dir: string): { cfg: Partial<ChatConfig>; preview: OverlayPreview } {
  const d = path.resolve(dir || OVERLAY_DEFAULT_DIR);
  const file = path.join(d, 'config.json');
  const empty = { cfg: {}, preview: { ok: false, dir: d, rumbleKey: false, vips: 0, enabled: [] } as OverlayPreview };
  if (!/^[\w\s:\\/.()'-]+$/.test(d)) return { ...empty, preview: { ...empty.preview, error: 'Unusual folder name' } };
  // a folder on this PC only: a network path (\\server\share, //server) makes Windows sign in to that server with
  // the user's account (an NTLM hash leak) just by reading it
  if (/^[\\/]{2}/.test(String(dir).trim()) || /^[\\/]{2}/.test(d)) return { ...empty, preview: { ...empty.preview, error: 'Pick a folder on this PC (not a network folder)' } };
  let j: Record<string, Record<string, unknown>>;
  try { j = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) { return { ...empty, preview: { ...empty.preview, error: `Can't read ${file}: ${(e as Error).message}` } }; }
  const k = j.kick ?? {}, r = j.rumble ?? {}, y = j.youtube ?? {};
  const key = typeof r.apiKey === 'string' && r.apiKey && !/^YOUR_/i.test(r.apiKey) ? r.apiKey : '';
  const cfg: Partial<ChatConfig> = {
    kick: { enabled: k.enabled === true && !!k.channel, channel: String(k.channel ?? ''), chatroomId: typeof k.chatroomId === 'number' ? k.chatroomId : null, channelId: typeof k.channelId === 'number' ? k.channelId : null, sevenTv: true },
    rumble: { enabled: r.enabled === true && !!key, apiKey: key, streamId: String(r.streamId ?? ''), ssePath: String(r.ssePath ?? ''), pollIntervalMs: typeof r.pollIntervalMs === 'number' ? r.pollIntervalMs : 4000, announceFollowers: r.announceFollowers !== false },
    youtube: { enabled: y.enabled === true && !!(y.handle || y.channelId || y.videoId), handle: String(y.handle ?? ''), channelId: String(y.channelId ?? ''), videoId: String(y.videoId ?? ''), intervalMs: typeof y.intervalMs === 'number' ? y.intervalMs : 1200, reconnectMs: typeof y.reconnectMs === 'number' ? y.reconnectMs : 15000 },
    vips: Array.isArray(j.vips) ? (j.vips as unknown as unknown[]).filter((v): v is string => typeof v === 'string') : [],
  };
  const clean = sanitizeChatConfig(cfg);
  const enabled = (['kick', 'rumble', 'youtube'] as const).filter((p) => clean[p].enabled);
  return {
    cfg: clean,
    preview: { ok: true, dir: d, kick: clean.kick.channel || undefined, youtube: clean.youtube.handle || clean.youtube.channelId || clean.youtube.videoId || undefined, rumbleKey: !!clean.rumble.apiKey, vips: clean.vips.length, enabled },
  };
}
