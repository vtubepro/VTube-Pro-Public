// YouTube Live connector — ported from an earlier overlay (src/chat/youtube.js). Reads a channel's live chat
// WITHOUT OAuth or a Data-API quota through YouTube's InnerTube chat endpoint (the data the public watch page uses):
// resolves the live video from the @handle / channel id / video id, then polls get_live_chat with the page's
// continuation. Defensive parser (every action in isolation, unknown renderers ignored, stale continuation →
// re-resolve), Super Chat / Super Sticker amounts in their own currency, Jewels gifts (youtubeGifts.ts).
// Added here: memberships (new member, milestone, gifted memberships with the count, gift redemptions as a line),
// emoji / custom emoji as message parts, deleted messages / removed authors. Read only (never posts).
import type { ChatPart } from '../../shared/chat.ts';
import { extractGiftItems } from './youtubeGifts.ts';
import type { ConnectorHooks } from './types.ts';

export interface YouTubeConfig {
  enabled: boolean;
  handle?: string;
  channelId?: string;
  videoId?: string;
  intervalMs?: number;
  reconnectMs?: number;
  /** Test / override endpoint (the mock server), default https://www.youtube.com */
  base?: string;
}

type Data = Record<string, any>;  // eslint-disable-line @typescript-eslint/no-explicit-any
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36';
const COOKIE = 'CONSENT=YES+1; SOCS=CAI';   // skip the EU consent interstitial

class StaleError extends Error { stale = true; }

const CURRENCY_PREFIXES: [string, string][] = [
  ['US$', 'usd'], ['CA$', 'cad'], ['AU$', 'aud'], ['A$', 'aud'], ['NZ$', 'nzd'], ['HK$', 'hkd'], ['NT$', 'twd'], ['MX$', 'mxn'], ['SG$', 'sgd'], ['R$', 'brl'],
  ['CN¥', 'cny'], ['Rp', 'idr'], ['RM', 'myr'], ['CHF', 'chf'], ['PHP', 'php'], ['$', 'usd'], ['£', 'gbp'], ['€', 'eur'], ['¥', 'jpy'], ['₩', 'krw'],
  ['₹', 'inr'], ['₱', 'php'], ['₫', 'vnd'], ['₪', 'ils'], ['₴', 'uah'], ['₦', 'ngn'], ['฿', 'thb'], ['₺', 'try'], ['zł', 'pln'], ['Kč', 'czk'],
];

/** "$5.00", "¥500", "R$5,00", "₹1,250.00", "SEK 50.00" → value + currency (Overlay parseSuperchat). */
export function parseSuperchat(raw: string): { value: number; currency: string } {
  const s = String(raw || '').trim();
  if (!s) return { value: 0, currency: 'usd' };
  let currency = '';
  for (const [sym, code] of CURRENCY_PREFIXES) if (s.includes(sym)) { currency = code; break; }
  if (!currency) { const m = s.match(/\b([A-Z]{3})\b/); currency = m ? m[1].toLowerCase() : 'usd'; }
  let num = s.replace(/[^0-9.,]/g, '');
  const hasDot = num.includes('.'), hasComma = num.includes(',');
  if (hasDot && hasComma) num = num.lastIndexOf(',') > num.lastIndexOf('.') ? num.replace(/\./g, '').replace(',', '.') : num.replace(/,/g, '');
  else if (hasComma) { const after = num.slice(num.lastIndexOf(',') + 1); num = after.length === 2 ? num.replace(',', '.') : num.replace(/,/g, ''); }
  else if (hasDot) { const after = num.slice(num.lastIndexOf('.') + 1); if (after.length === 3 && num.replace(/\./g, '').length > 3) num = num.replace(/\./g, ''); }
  const value = parseFloat(num);
  return { value: Number.isFinite(value) ? value : 0, currency };
}

// ---------------------------------------------------------------- InnerTube transport
interface LiveOpts { liveId: string; apiKey: string; clientVersion: string; continuation: string }
type IdArg = { liveId: string } | { channelId: string } | { handle: string };

export class YouTubeChat {
  private stopped = false;
  private live: LiveOpts | null = null;
  private startTs = 0;
  private seen = new Set<string>();
  private offlineLogged = false;
  private idArg: IdArg | null;
  private names = new Map<string, string>();   // channel id → last display name (removed-author purges)
  private readonly intervalMs: number;
  private readonly reconnectMs: number;

  constructor(private cfg: YouTubeConfig, private hooks: ConnectorHooks) {
    this.intervalMs = Math.max(700, Number(cfg.intervalMs) || 1200);
    this.reconnectMs = Number(cfg.reconnectMs) || 15000;
    this.idArg = YouTubeChat.resolveId(cfg);
  }
  private log(...a: unknown[]) { this.hooks.log(...a); }
  private get base() { return (this.cfg.base || 'https://www.youtube.com').replace(/\/+$/, ''); }

  static resolveId(cfg: YouTubeConfig): IdArg | null {
    if (cfg.videoId) return { liveId: String(cfg.videoId) };
    if (cfg.channelId) return { channelId: String(cfg.channelId) };
    if (cfg.handle) {
      const c = String(cfg.handle).trim();
      if (/^UC[\w-]{20,}$/.test(c)) return { channelId: c };
      return { handle: c.startsWith('@') ? c : '@' + c };
    }
    return null;
  }

  private liveUrl(id: IdArg) {
    if ('liveId' in id) return `${this.base}/watch?v=${encodeURIComponent(id.liveId)}`;
    if ('channelId' in id) return `${this.base}/channel/${encodeURIComponent(id.channelId)}/live`;
    return `${this.base}/${id.handle}/live`;
  }

  private async fetchLivePage(id: IdArg): Promise<LiveOpts> {
    const res = await fetch(this.liveUrl(id), { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9', Cookie: COOKIE }, redirect: 'follow', signal: AbortSignal.timeout(15000) });
    const html = await res.text();
    const idMatch = html.match(/<link rel="canonical" href="https:\/\/www\.youtube\.com\/watch\?v=([\w-]{6,})"/) || html.match(/"videoId":"([\w-]{6,})"/);
    if (!idMatch) throw new Error('Live stream was not found');
    const liveId = idMatch[1];
    if (/['"]isReplay['"]:\s*true/.test(html)) throw new Error(`${liveId} is a finished live`);
    if (/"isLiveNow":\s*false/.test(html) && !/"isLiveNow":\s*true/.test(html)) throw new Error(`${liveId} is not live now`);
    const keyMatch = html.match(/['"]INNERTUBE_API_KEY['"]:\s*['"]([\w-]+)['"]/);
    const verMatch = html.match(/['"]INNERTUBE_CONTEXT_CLIENT_VERSION['"]:\s*['"]([\d.]+)['"]/) || html.match(/['"]clientVersion['"]:\s*['"]([\d.]+)['"]/);
    if (!keyMatch) throw new Error('API key was not found');
    if (!verMatch) throw new Error('client version was not found');
    let continuation = '';
    const chatBlock = html.indexOf('"liveChatRenderer"');
    if (chatBlock >= 0) {
      const slice = html.slice(chatBlock, chatBlock + 20000);
      const m = slice.match(/"reloadContinuationData":\s*\{\s*"continuation":\s*"([^"]+)"/) || slice.match(/"continuation":\s*"([^"]+)"/);
      if (m) continuation = m[1];
    }
    if (!continuation) { const m = html.match(/"reloadContinuationData":\s*\{\s*"continuation":\s*"([^"]+)"/) || html.match(/['"]continuation['"]:\s*['"]([^'"]+)['"]/); if (m) continuation = m[1]; }
    if (!continuation) throw new Error('continuation was not found');
    return { liveId, apiKey: keyMatch[1], clientVersion: verMatch[1], continuation };
  }

  private async fetchChatPage(o: LiveOpts): Promise<{ data: Data; actions: Data[]; continuation: string }> {
    const res = await fetch(`${this.base}/youtubei/v1/live_chat/get_live_chat?key=${encodeURIComponent(o.apiKey)}&prettyPrint=false`, {
      method: 'POST',
      headers: { 'User-Agent': UA, 'Content-Type': 'application/json', Origin: 'https://www.youtube.com', Referer: `https://www.youtube.com/watch?v=${o.liveId}`, 'X-YouTube-Client-Name': '1', 'X-YouTube-Client-Version': o.clientVersion, Cookie: COOKIE },
      body: JSON.stringify({ context: { client: { clientName: 'WEB', clientVersion: o.clientVersion, hl: 'en', gl: 'US', utcOffsetMinutes: 0 } }, continuation: o.continuation }),
      signal: AbortSignal.timeout(15000),
    });
    let data: Data | null = null;
    try { data = await res.json() as Data; } catch { /* */ }
    if (res.status !== 200 || !data || typeof data !== 'object') {
      const err = new Error(`get_live_chat HTTP ${res.status}`) as Error & { stale?: boolean };
      if (res.status >= 400 && res.status < 500) err.stale = true;
      throw err;
    }
    const lcc = data.continuationContents?.liveChatContinuation;
    if (!lcc) throw new StaleError('response has no liveChatContinuation');
    let continuation = '';
    for (const c of Array.isArray(lcc.continuations) ? lcc.continuations : []) {
      const d = c.invalidationContinuationData || c.timedContinuationData || c.reloadContinuationData || c.liveChatReplayContinuationData || null;
      if (d?.continuation) { continuation = d.continuation; break; }
    }
    if (!continuation) throw new StaleError('no next continuation');
    return { data, actions: Array.isArray(lcc.actions) ? lcc.actions : [], continuation };
  }

  // ---------------------------------------------------------------- lifecycle
  start() {
    this.stopped = false;
    if (!this.idArg) { this.log('no videoId / channelId / handle configured — disabled'); this.hooks.onStatus('error', 'no channel configured'); return; }
    void this.supervise();
  }
  stop() { this.stopped = true; this.live = null; }

  private async supervise() {
    while (!this.stopped) {
      let connected = false;
      try { connected = await this.runSession(); } catch (e) { this.log('session error:', (e as Error).message); }
      if (this.stopped) break;
      if (connected) { this.offlineLogged = false; await sleep(2500); continue; }
      if (!this.offlineLogged) { this.log('no live stream found — waiting for the next broadcast…'); this.offlineLogged = true; }
      await sleep(this.reconnectMs);
    }
  }

  private async runSession(): Promise<boolean> {
    let o: LiveOpts;
    this.hooks.onStatus('connecting', 'looking for the live stream');
    try { o = await this.fetchLivePage(this.idArg!); } catch (e) {
      const msg = (e as Error).message;
      if (!/not found|not live|finished live/i.test(msg)) { this.log('live page fetch failed:', msg); this.hooks.onStatus('error', msg); }
      else this.hooks.onStatus('waiting', 'not live');
      return false;
    }
    this.live = o;
    this.startTs = Date.now();
    this.log(`live chat connected (video ${o.liveId})`);
    this.hooks.onStatus('live', `video ${o.liveId}`);
    let errStreak = 0;
    while (!this.stopped && this.live === o) {
      let page;
      try { page = await this.fetchChatPage(o); errStreak = 0; } catch (e) {
        if ((e as { stale?: boolean }).stale) { this.log(`live chat ended (${(e as Error).message}) — re-resolving…`); break; }
        errStreak++;
        if (errStreak === 1) this.log('chat error:', (e as Error).message);
        if (errStreak >= 8) { this.log(`giving up after ${errStreak} consecutive errors — reconnecting…`); break; }
        await sleep(Math.min(8000, this.intervalMs * errStreak));
        continue;
      }
      o.continuation = page.continuation;
      this.handlePage(page.data, page.actions);
      await sleep(this.intervalMs);
    }
    if (this.live === o) this.live = null;
    return true;
  }

  // ---------------------------------------------------------------- parsing
  /** One get_live_chat response → events (exported for tests via handlePage). */
  handlePage(data: Data, actions: Data[]) {
    for (const a of actions) {
      try { this.handleAction(a); } catch (e) { this.log('skipped unparseable action:', (e as Error).message); }
    }
    try {
      for (const g of extractGiftItems(data)) {
        if (this.seen.has(g.id)) continue;
        this.seen.add(g.id);
        if (g.ts < this.startTs - 8000) continue;
        const combo = g.comboCount;
        this.hooks.onFinance({
          platform: 'youtube', username: g.author.replace(/^@+/, '') || 'youtube_user', kind: 'jewels', amount: g.jewels || 1, currency: 'jewels',
          usd: g.jewels > 0 ? +(g.jewels / 100).toFixed(2) : 0, message: combo > 1 ? `${g.display} ×${combo}` : g.display, ts: g.ts,
          color: '#c084fc', id: `youtube:jewels:${g.id}`, giftName: g.giftName, comboCount: combo || undefined,
        });
      }
    } catch { /* never break chat for a gift parse failure */ }
    this.trim(this.seen, 3000);
  }

  private handleAction(action: Data) {
    // moderation (read only)
    const del = action.markChatItemAsDeletedAction || action.removeChatItemAction;
    if (del?.targetItemId) { this.hooks.onRemove({ kind: 'delete', platform: 'youtube', target: `youtube:${del.targetItemId}` }); return; }
    const byAuthor = action.markChatItemsByAuthorAsDeletedAction || action.removeChatItemByAuthorAction;
    if (byAuthor?.externalChannelId) { const ch = String(byAuthor.externalChannelId); this.hooks.onRemove({ kind: 'purge', platform: 'youtube', target: this.names.get(ch) ?? ch, uid: ch }); return; }   // (the channel id: only that account)

    const item = action.addChatItemAction?.item;
    if (!item || typeof item !== 'object') return;
    const kind = Object.keys(item).find((k) => /^liveChat\w+Renderer$/.test(k));
    if (!kind) return;
    const r = item[kind] as Data;
    const base: Data = kind === 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer' ? (r.header?.liveChatSponsorshipsHeaderRenderer || r) : r;
    const id = String(base.id || r.id || '');
    if (id) { if (this.seen.has(id)) return; this.seen.add(id); }
    const tsUsec = Number(base.timestampUsec || r.timestampUsec);
    const ts = Number.isFinite(tsUsec) && tsUsec > 0 ? tsUsec / 1000 : Date.now();
    if (ts < this.startTs - 8000) return;     // the join fetch's history
    const name = (runsText(base.authorName) || 'youtube_user').replace(/^@+/, '') || 'youtube_user';
    const chanId = String(base.authorExternalChannelId || r.authorExternalChannelId || '');
    if (chanId) { this.names.set(chanId, name); if (this.names.size > 4000) this.names.clear(); }
    const badges: string[] = [];
    for (const entry of Array.isArray(base.authorBadges) ? base.authorBadges : []) {
      const b = entry?.liveChatAuthorBadgeRenderer;
      if (!b) continue;
      if (b.customThumbnail) badges.push('member');
      else { const t = b.icon?.iconType; if (t === 'OWNER') badges.push('broadcaster'); else if (t === 'MODERATOR') badges.push('moderator'); else if (t === 'VERIFIED') badges.push('verified'); }
    }
    const msgParts = toParts(base.message);
    const text = partsText(msgParts);
    const fid = id ? `youtube:${id}` : undefined;
    switch (kind) {
      case 'liveChatTextMessageRenderer':
        this.hooks.onChat({ platform: 'youtube', username: name, message: text, color: null, ts, badges, parts: hasEmote(msgParts) ? msgParts : undefined, id: fid, ...(chanId ? { uid: chanId } : {}) });
        return;
      case 'liveChatPaidMessageRenderer':
      case 'liveChatPaidStickerRenderer': {
        const sticker = kind === 'liveChatPaidStickerRenderer';
        const rawAmt = runsText(r.purchaseAmountText);
        const { value, currency } = parseSuperchat(rawAmt);
        const color = colorHex6(sticker ? (r.backgroundColor ?? r.moneyChipBackgroundColor) : (r.bodyBackgroundColor ?? r.headerBackgroundColor));
        const stickerAlt = sticker ? String(r.sticker?.accessibility?.accessibilityData?.label || '') : '';
        if (!(value > 0) && rawAmt) this.log(`superchat parse failed for "${rawAmt}" from ${name}`);
        this.hooks.onFinance({
          platform: 'youtube', username: name, kind: sticker ? 'supersticker' : 'superchat', amount: value > 0 ? +value.toFixed(2) : 0, currency,
          usd: currency === 'usd' ? +value.toFixed(2) : 0, message: text || (sticker ? `(super sticker${stickerAlt ? `: ${stickerAlt}` : ''})` : (value > 0 ? '' : rawAmt)),
          ts, color, badges, id: fid ? `youtube:${sticker ? 'supersticker' : 'superchat'}:${id}` : undefined, ...(chanId ? { uid: chanId } : {}),
        });
        return;
      }
      case 'liveChatMembershipItemRenderer': {
        // milestone: headerPrimaryText "Member for 6 months"; new member: headerSubtext "Welcome to <level>!" / "New member"
        const primary = runsText(r.headerPrimaryText);
        const sub = runsText(r.headerSubtext);
        const months = parseInt((primary.match(/(\d+)\s*month/i) || [])[1] || '0', 10);
        if (primary) {
          this.hooks.onFinance({ platform: 'youtube', username: name, kind: 'milestone', amount: months || 1, currency: 'months', message: text || primary, ts, badges, id: fid ? `youtube:milestone:${id}` : undefined, giftName: sub || undefined });
        } else {
          this.hooks.onFinance({ platform: 'youtube', username: name, kind: 'membership', amount: 1, currency: 'months', message: sub || 'became a member', ts, badges, id: fid ? `youtube:member:${id}` : undefined, giftName: (sub.match(/welcome to (.+?)!?$/i) || [])[1] });
        }
        return;
      }
      case 'liveChatSponsorshipsGiftPurchaseAnnouncementRenderer': {
        const primary = runsText(base.primaryText);
        const n = parseInt((primary.replace(/,/g, '').match(/(\d+)/) || [])[1] || '1', 10) || 1;
        this.hooks.onFinance({ platform: 'youtube', username: name, kind: 'giftMembership', amount: n, currency: 'subs', message: primary || `gifted ${n} membership${n === 1 ? '' : 's'}`, ts, badges, id: fid ? `youtube:giftmember:${id}` : undefined });
        return;
      }
      case 'liveChatSponsorshipsGiftRedemptionAnnouncementRenderer':
        this.hooks.onChat({ platform: 'youtube', username: name, message: text || 'received a gift membership', color: '#2ba640', ts, system: true, id: fid });
        return;
      default:
        // unknown renderers (engagement messages, polls, …) are ignored; Jewels gifts come from the deep-scan
    }
  }

  private trim(set: Set<string>, max: number) { if (set.size <= max) return; let drop = set.size - max; for (const k of set) { if (drop-- <= 0) break; set.delete(k); } }
}

function runsText(node: Data | undefined): string {
  if (!node) return '';
  if (typeof node.simpleText === 'string') return node.simpleText;
  return partsText(toParts(node));
}
/** runs → parts: text, standard emoji as their character, custom emoji as images. */
function toParts(node: Data | undefined): ChatPart[] {
  if (!node) return [];
  if (typeof node.simpleText === 'string') return [{ t: 'text', v: node.simpleText }];
  if (!Array.isArray(node.runs)) return [];
  const out: ChatPart[] = [];
  for (const run of node.runs) {
    if (!run) continue;
    if (typeof run.text === 'string') { const last = out[out.length - 1]; if (last?.t === 'text') last.v += run.text; else out.push({ t: 'text', v: run.text }); continue; }
    const em = run.emoji;
    if (em) {
      const shortcut = em.shortcuts?.[0] || '';
      const thumbs = em.image?.thumbnails;
      const url = Array.isArray(thumbs) && thumbs.length ? String(thumbs[thumbs.length - 1].url || '') : '';
      if (em.isCustomEmoji && /^https:\/\//.test(url)) out.push({ t: 'emote', n: shortcut || ':emoji:', u: url });
      else { const ch = em.emojiId || shortcut; const last = out[out.length - 1]; if (last?.t === 'text') last.v += ch; else out.push({ t: 'text', v: ch }); }
    }
  }
  return out;
}
const partsText = (p: ChatPart[]) => p.map((x) => (x.t === 'text' ? x.v : x.n)).join('').trim();
const hasEmote = (p: ChatPart[]) => p.some((x) => x.t === 'emote');
function colorHex6(n: unknown): string | null {
  if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  return '#' + (n >>> 0).toString(16).padStart(8, '0').slice(2).toLowerCase();
}
