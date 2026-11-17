// The support hub (beta.13, research section E): ONE helper-side bus for every way a viewer supports the show.
//
//   connectors (server/support/connectors/*) ──┐
//   relay inbox webhooks (inbox.ts) ───────────┤──> accept(): clean → dedupe by id (30 days, the log) → cross-source
//   chat finance lines (server/chat/hub.ts) ───┤    (`via` copies dropped when the native connector is live) → currency
//   the test injector ─────────────────────────┘    (display currency at receipt) → names + message filter / hold →
//                                                   append to the log (crash-safe) → bus {type:'support', ev} →
//                                                   the matching chat 'finance' line (old alerts, goal bar, crowd cheers,
//                                                   light cues) → supporters / showcase updates.
//
// Test events (test:true) go everywhere a real one goes (feed, alerts, the product card) but goals and timers ignore them
// unless the streamer's test mode is on. Replayed events (offline catch-up, replayed:true) update goals quietly: their
// chat line is sent as a catch-up batch (no alert) unless "play missed alerts" is on.
import fs from 'node:fs';
import path from 'node:path';
import { LIVE_PLATFORMS, SUPPORT_PLATFORM_NAMES, type ChatEvent, type ChatStatus, type FinanceKind, type LivePlatform, type SupportPlatform } from '../../shared/chat.ts';
import { minorPerMajor, SUPPORT_KINDS, supportFromChat, type SupportEvent, type SupportSource } from '../../shared/support.ts';
import {
  SERVICE_INFO, SUPPORT_SERVICES, buyerName, cleanText, defaultSupportSettings, filterMessage, initialModeration, sanitizeSupportSettings,
  type ServiceStatus, type ShowcaseView, type SupportService, type SupportSettings, type SupportStatus,
} from '../../shared/supportConfig.ts';
import type { BusMessage } from '../../shared/types.ts';
import type { RawChat } from '../chat/types.ts';
import type { RawFinance } from '../chat/finance.ts';
import { Rates } from './currency.ts';
import { SupportLog, type LoggedEvent } from './log.ts';
import { Vault, VAULT_LABEL, writeAtomic } from './vault.ts';
import type { ConnectorCtx, InboxDelivery, SupportConnector } from './types.ts';

export interface HubDeps {
  configDir: string;
  savesDir: string;
  cacheDir: string;
  broadcast(m: BusMessage): void;
  /** The chat hub (server/chat/hub.ts) or a test double. */
  chat: {
    onFinance(f: RawFinance, test?: boolean, exact?: boolean, quiet?: boolean): void;
    onChat(c: RawChat, test?: boolean): void;
    listeners: Set<(e: ChatEvent) => void>;
    status(): ChatStatus | null;
  };
  connectors: (id: SupportService) => SupportConnector | null;
  fetch?: typeof fetch;
  now?: () => number;
  vaultKind?: string;
}

const PENDING_MAX_MS = 10 * 60 * 1000;
type Listener = (ev: SupportEvent) => void;

export class SupportHub {
  settings: SupportSettings;
  readonly vault: Vault;
  readonly log: SupportLog;
  readonly rates: Rates;
  private conns = new Map<SupportService, SupportConnector>();
  private lastAt: Partial<Record<SupportService, number>> = {};
  private pendingMirror = new Map<string, { ev: SupportEvent; t: NodeJS.Timeout }>();
  private statusT: NodeJS.Timeout | null = null;
  /** When this helper started: what reached us from before then was missed while VTube Pro was closed (replayed). */
  readonly startedAt: number;
  private count = 0;
  readonly listeners = new Set<Listener>();
  /** Extra live checks for cross-source dedupe (a native source that already carries a platform's events). */
  private nativeExtra = new Map<string, () => boolean>();
  inboxState: SupportStatus['inbox'] = { state: 'off', relay: '', detail: '' };
  /** Set by the store (server/support/store.ts): the showcase view + purchase flash. */
  showcase: { view(): ShowcaseView; flash(ev: SupportEvent): void; refresh(): void } | null = null;
  /** Set by supporters.ts: membership events refresh the supporters list. */
  onMembers: (() => void) | null = null;
  private fetcher: typeof fetch;
  private now: () => number;
  private file: string;

  constructor(readonly deps: HubDeps) {
    this.now = deps.now ?? Date.now;
    this.fetcher = deps.fetch ?? fetch;
    this.startedAt = this.now();
    this.file = path.join(deps.configDir, 'support.json');
    this.settings = this.loadSettings();
    this.vault = new Vault(deps.configDir);
    this.log = new SupportLog(path.join(deps.savesDir, 'support'), this.now);
    this.rates = new Rates(path.join(deps.cacheDir, 'support', 'rates.json'), this.fetcher);
    deps.chat.listeners.add((e) => this.fromChat(e));
  }

  // ---------------------------------------------------------------- settings
  private loadSettings(): SupportSettings {
    try { return sanitizeSupportSettings(JSON.parse(fs.readFileSync(this.file, 'utf8'))); } catch { return defaultSupportSettings(); }
  }
  saveSettings(patch: unknown): SupportSettings {
    const before = this.settings;
    this.settings = sanitizeSupportSettings(patch, before);
    writeAtomic(this.file, JSON.stringify(this.settings, null, 2));
    for (const s of SUPPORT_SERVICES) {
      const a = before.services[s], b = this.settings.services[s];
      if (a.enabled !== b.enabled || a.shopUrl !== b.shopUrl || a.creatorId !== b.creatorId) void this.restart(s);
    }
    this.showcase?.refresh();
    this.pushStatus();
    return this.settings;
  }

  // ---------------------------------------------------------------- connectors
  async start() {
    // keys saved → unlock them now (the connectors read them); none saved → leave the system key store alone
    if (!this.vault.empty) await this.vault.ready();
    // exchange rates are fetched only once the streamer has switched a tip / support service on (nothing by default)
    if (SUPPORT_SERVICES.some((s) => this.settings.services[s].enabled)) void this.rates.refresh(this.now());
    for (const s of SUPPORT_SERVICES) if (this.settings.services[s].enabled) await this.restart(s, false);
    this.pushStatus();
  }
  stop() {
    for (const c of this.conns.values()) try { c.stop(); } catch { /* */ }
    this.conns.clear();
    for (const p of this.pendingMirror.values()) clearTimeout(p.t);
  }

  connector(s: SupportService) { return this.conns.get(s) ?? null; }

  /** (Re)start one service's connector (after a key / settings change). `catchUp`: fetch what was missed. */
  async restart(s: SupportService, catchUp = true) {
    const old = this.conns.get(s);
    if (old) { try { old.stop(); } catch { /* */ } this.conns.delete(s); }
    if (!this.settings.services[s].enabled) { this.pushStatus(); return; }
    const c = this.deps.connectors(s);
    if (!c) return;
    this.conns.set(s, c);
    try { await c.start(this.ctx(s)); } catch (e) { console.warn(`[support:${s}] start`, (e as Error).message); }
    if (catchUp || !old) {
      // missed while closed: from the newest event we have (minus a margin), never older history on a first connect
      const last = this.log.lastOf(s);
      const since = last ? new Date(Date.parse(last) - 10 * 60 * 1000).toISOString() : new Date(this.now() - 10 * 60 * 1000).toISOString();
      try { await c.catchUp(since); } catch (e) { console.warn(`[support:${s}] catch-up`, (e as Error).message); }
    }
    this.pushStatus();
  }

  ctx(s: SupportService): ConnectorCtx {
    return {
      emit: (evs, o) => { for (const ev of evs) this.accept(ev, { replayed: o?.replayed ?? Date.parse(ev.occurredAt) < this.startedAt - 120_000, service: s }); },
      secret: (f) => this.vault.get(s, f),
      settings: () => this.settings,
      service: () => this.settings.services[s],
      status: () => this.pushStatus(),
      log: (...a) => console.log(`[support:${s}]`, ...a),
      fetch: this.fetcher,
      lastSeen: () => this.log.lastOf(s),
      nativeLive: (p) => this.nativeLive(p),
      storeChanged: () => this.showcase?.refresh(),
      membersChanged: () => this.onMembers?.(),
    };
  }

  /** Is a platform's own connector live right now (a via-copy of its events is then dropped)? */
  nativeLive(p: string): boolean {
    if (this.nativeExtra.get(p)?.()) return true;
    if (!(LIVE_PLATFORMS as string[]).includes(p)) return false;
    const st = this.deps.chat.status()?.platforms[p as LivePlatform];
    return !!st && st.enabled && (st.state === 'live' || st.state === 'waiting' || st.state === 'connecting');
  }
  setNativeCheck(p: string, fn: () => boolean) { this.nativeExtra.set(p, fn); }

  /** A webhook from the inbox (or the local test route) for `provider`. */
  async hook(provider: string, d: InboxDelivery, replayed = false): Promise<{ ok: boolean; why?: string; n?: number }> {
    const s = provider as SupportService;
    if (!(SUPPORT_SERVICES as readonly string[]).includes(s)) return { ok: false, why: 'unknown service' };
    // a service the streamer switched off: its deliveries are dropped (acknowledged, never shown)
    if (!this.settings.services[s].enabled) return { ok: true, n: 0, why: 'service is off' };
    const c = this.conns.get(s);
    if (!c?.hook) return { ok: false, why: 'this service has no webhook' };
    const r = await c.hook(d);
    if (!r.ok) { console.warn(`[support:${s}] webhook rejected: ${r.why}`); return { ok: false, why: r.why }; }
    let n = 0;
    for (const ev of r.events) {
      const a = this.accept(ev, { replayed, service: s });
      // the disk refused: don't let the inbox drop it (it is delivered again on the next connect)
      if (a === 'disk') throw new Error('could not save the event');
      if (a === 'ok') n++;
    }
    for (const v of r.voids ?? []) this.void(v.id, v.why);
    return { ok: true, n };
  }

  // ---------------------------------------------------------------- the pipeline
  /** Accept one event. Returns why it was dropped, or 'ok'. */
  accept(raw: SupportEvent, o: { replayed?: boolean; service?: SupportService; fromChat?: boolean } = {}): 'ok' | 'dupe' | 'native' | 'bad' | 'disk' {
    const ev = this.clean(raw);
    if (!ev) return 'bad';
    if (this.log.has(ev.id)) return 'dupe';
    // cross-source: StreamElements / Streamlabs copies of a platform whose own connector is live
    if (ev.via && ev.source !== ev.via && this.nativeLive(ev.source)) return 'native';
    ev.receivedAt = new Date(this.now()).toISOString();
    if (o.replayed) ev.replayed = true;
    // money in the display currency, at receipt (the original stays in `amount`)
    if (ev.amount && ev.amount.minor > 0) {
      const want = this.settings.displayCurrency;
      if (!ev.display || ev.display.currency !== want) {
        const d = this.rates.convert(ev.amount, want, this.settings.bitCents);
        if (d) ev.display = d; else delete ev.display;
      }
    }
    // names: merch buyers by the streamer's rule (first name by default), never an e-mail
    if (ev.kind === 'purchase') ev.who = { ...ev.who, name: buyerName(ev.who.name, ev.who.anonymous, this.settings.buyerNames) };
    else ev.who = { ...ev.who, name: ev.who.anonymous ? 'Someone' : buyerName(ev.who.name, false, 'full') };
    if (ev.recipient) ev.recipient = { ...ev.recipient, name: cleanText(ev.recipient.name, 40) || 'someone' };
    // the message: links / e-mails stripped, blocklisted words held, everything held when the streamer asked
    if (ev.message) {
      // the streamer's switches: the word filter and link removal can each be off (then: as typed, made render-safe)
      const f = filterMessage(ev.message.text, this.settings.filterMessages === false ? [] : this.settings.blocklist, { stripLinks: this.settings.stripLinks !== false });
      if (!f.text) delete ev.message;
      else ev.message = { text: f.text, moderated: ev.message.moderated === 'hidden' ? 'hidden' : initialModeration(f, this.settings.holdMessages) };
    }
    try { this.log.append({ t: 'ev', ev }); } catch (e) { console.warn('[support] log write failed, event not shown:', (e as Error).message); return 'disk'; }
    this.count++;
    if (o.service) this.lastAt[o.service] = this.now();
    this.deps.broadcast({ type: 'support', ev });
    for (const l of this.listeners) try { l(ev); } catch (err) { console.warn('[support] listener', err); }
    // the old chat line (alerts, goal bar ...): not for chat-born events (they are chat lines already) and not for
    // connectors whose platform's chat already carries them
    const conn = o.service ? this.conns.get(o.service) : null;
    // (a connector whose platform's chat already carries its events doesn't mirror; redemptions have no chat line,
    //  so they go out as the 'reward' system line the rooms map rewards from)
    if (!o.fromChat && (!conn || conn.mirrorsChat || ev.kind === 'redemption')) {
      if (ev.message?.moderated === 'pending') {
        const t = setTimeout(() => this.releaseMirror(ev.id), PENDING_MAX_MS);
        this.pendingMirror.set(ev.id, { ev, t });
      } else this.mirror(ev);
    }
    if (ev.kind === 'purchase' && !ev.replayed && this.onStream(ev)) this.showcase?.flash(ev);
    if (ev.kind === 'membership' && (ev.source === 'patreon' || ev.source === 'fourthwall' || ev.source === 'kofi' || ev.source === 'bmc')) this.onMembers?.();
    this.pushStatus();
    return 'ok';
  }

  /** Bound every string, known values only (connectors are trusted code, but payloads are not). */
  private clean(e: SupportEvent): SupportEvent | null {
    if (!e || typeof e.id !== 'string' || !e.id.includes(':')) return null;
    if (!SUPPORT_KINDS.includes(e.kind)) return null;
    const id = e.id.replace(/[\u0000-\u001f]/g, '').slice(0, 200);
    const out: SupportEvent = {
      id, source: e.source, kind: e.kind, recurring: !!e.recurring, test: !!e.test, replayed: !!e.replayed,
      occurredAt: typeof e.occurredAt === 'string' && Number.isFinite(Date.parse(e.occurredAt)) ? new Date(Date.parse(e.occurredAt)).toISOString() : new Date(this.now()).toISOString(),
      receivedAt: new Date(this.now()).toISOString(),
      who: { name: cleanText(e.who?.name ?? '', 60) || 'Someone', anonymous: !!e.who?.anonymous },
    };
    if (e.via === 'streamelements' || e.via === 'streamlabs') out.via = e.via;
    if (e.who?.chat && typeof e.who.chat.userId === 'string') out.who.chat = { platform: e.who.chat.platform, userId: e.who.chat.userId.slice(0, 64), ...(e.who.chat.login ? { login: cleanText(e.who.chat.login, 48) } : {}) };
    if (e.who?.linkedId) out.who.linkedId = String(e.who.linkedId).slice(0, 80);
    if (e.amount && Number.isFinite(e.amount.minor) && e.amount.minor >= 0 && /^[A-Z]{3}$/.test(e.amount.currency)) out.amount = { minor: Math.round(Math.min(e.amount.minor, 1e12)), currency: e.amount.currency, ...(e.amount.valuedAt ? { valuedAt: e.amount.valuedAt } : {}) };
    if (e.display && Number.isFinite(e.display.minor)) out.display = { ...e.display };
    if (e.units) { const u: NonNullable<SupportEvent['units']> = {}; for (const k of ['bits', 'subs', 'months', 'gifted', 'kicks'] as const) { const v = e.units[k]; if (typeof v === 'number' && Number.isFinite(v) && v >= 0) u[k] = Math.round(Math.min(v, 1e9)); } if (e.units.tier) u.tier = cleanText(e.units.tier, 40); if (Object.keys(u).length) out.units = u; }
    if (e.recipient?.name) out.recipient = { name: cleanText(e.recipient.name, 40), ...(e.recipient.chat ? { chat: e.recipient.chat } : {}) };
    if (e.message?.text) out.message = { text: String(e.message.text).slice(0, 2000), moderated: e.message.moderated === 'hidden' ? 'hidden' : e.message.moderated === 'pending' ? 'pending' : 'ok' };
    if (e.item?.name) {
      out.item = { name: cleanText(e.item.name, 120) };
      if (e.item.imageUrl && /^https:\/\/[^\s"'<>]{4,500}$/.test(e.item.imageUrl)) out.item.imageUrl = e.item.imageUrl;
      if (e.item.productId) out.item.productId = String(e.item.productId).slice(0, 80);
      if (typeof e.item.qty === 'number' && e.item.qty > 0) out.item.qty = Math.round(Math.min(e.item.qty, 1e6));
      if (typeof e.item.priceMinor === 'number' && e.item.priceMinor >= 0) out.item.priceMinor = Math.round(e.item.priceMinor);
    }
    if (e.tierName) out.tierName = cleanText(e.tierName, 60);
    if (e.firstOfRecurring) out.firstOfRecurring = true;
    return out;
  }

  // ---------------------------------------------------------------- chat in both directions
  /** A chat platform's finance line (Twitch / YouTube / Kick / Rumble / TikTok) → its SupportEvent (same id as
   *  supportFromChat gives, so a consumer that also converts chat lines dedupes by id). */
  private fromChat(e: ChatEvent) {
    if (e.kind !== 'finance' || e.support || e.cue || e.fkind === 'raid') return;
    if (!(LIVE_PLATFORMS as string[]).includes(e.platform)) return;
    if (this.nativeExtra.get(e.platform)?.()) return; // a native source is live: it carries these
    const ev = supportFromChat(e, this.settings.displayCurrency);
    if (!ev) return;
    // non-USD display currency: supportFromChat only fills USD; convert from the amount (or the platform's USD value)
    if (!ev.display || ev.display.currency !== this.settings.displayCurrency) {
      delete ev.display;
      if (!ev.amount && e.usd) ev.amount = { minor: Math.round(e.usd * 100), currency: 'USD', valuedAt: 'estimate' };
    }
    if (e.fkind === 'bits' && ev.amount) ev.amount = { minor: Math.round(e.amount ?? 0), currency: 'USD', valuedAt: 'bits' };
    if (e.fkind === 'bits') ev.units = { ...(ev.units ?? {}), bits: Math.round(e.amount ?? 0) };
    if (e.recipients?.length && !ev.recipient && e.recipients.length === 1) ev.recipient = { name: e.recipients[0] };
    // (supportFromChat copies ChatEvent.tier, which is the card COLOUR on chat lines, into tierName: not a tier)
    if (ev.tierName && /^#[0-9a-f]{3,8}$/i.test(ev.tierName)) delete ev.tierName;
    this.accept(ev, { fromChat: true });
  }

  /** The chat 'finance' line for a SupportEvent (old alerts, goal bar, crowd cheers, light cues). */
  mirror(ev: SupportEvent) {
    const platform = ev.source as SupportPlatform | LivePlatform;
    if (ev.kind === 'redemption') {
      if (this.onStream(ev)) this.deps.chat.onChat({ platform: ev.source as LivePlatform, username: ev.who.name, message: `redeemed ${ev.item?.name ?? 'a reward'}`, ts: Date.parse(ev.occurredAt) || this.now(), system: true, ev: 'reward', id: ev.id }, ev.test);
      return;
    }
    const raw = toRawFinance(ev, this.rates.usd.bind(this.rates), this.settings.bitCents);
    if (!raw) return;
    // quiet = counted / listed but no alert, no celebration, no read-aloud: missed events, and a service's own test
    // events (Fourthwall "Send test", Stripe / BMC test mode) unless the studio's Send-a-test button sent them
    const quiet = (ev.replayed && !this.settings.playMissedAlerts) || !this.onStream(ev);
    this.deps.chat.onFinance({ ...raw, platform }, ev.test, true, quiet);
  }
  private releaseMirror(id: string, hidden = false) {
    const p = this.pendingMirror.get(id);
    if (!p) return;
    clearTimeout(p.t);
    this.pendingMirror.delete(id);
    const ev = hidden || p.ev.message?.moderated !== 'ok' ? { ...p.ev, message: undefined } : p.ev;
    this.mirror(ev);
  }

  // ---------------------------------------------------------------- moderation, voids, manual + test events
  moderate(id: string, m: 'ok' | 'hidden'): boolean {
    const e = this.log.get(id);
    if (!e?.message) return false;
    this.log.append({ t: 'mod', id, m, at: this.now() });
    this.deps.broadcast({ type: 'support-mod', id, moderated: m });
    const p = this.pendingMirror.get(id);
    if (p) { p.ev = { ...p.ev, message: p.ev.message ? { ...p.ev.message, moderated: m } : undefined }; this.releaseMirror(id, m === 'hidden'); }
    return true;
  }
  /** A refund / cancellation / "Remove": found anywhere in the log (not only the recent feed), voided once. */
  void(id: string, why: string): boolean {
    if (!this.log.exists(id)) return false;
    if (this.log.isVoided(id)) return true;
    this.log.append({ t: 'void', id, why: cleanText(why, 40) || 'removed', at: this.now() });
    this.deps.broadcast({ type: 'support-void', id, why: cleanText(why, 40) || 'removed' });
    return true;
  }

  /** "Add a supporter by hand" (cash at an event, a gift sent by mail ...). */
  manual(o: { name: string; amount?: number; currency?: string; kind?: SupportEvent['kind']; message?: string; item?: string }): SupportEvent | null {
    const currency = (o.currency || this.settings.displayCurrency).toUpperCase();
    const minor = typeof o.amount === 'number' && o.amount > 0 ? Math.round(o.amount * minorPerMajor(currency)) : 0;
    const now = new Date(this.now()).toISOString();
    const ev: SupportEvent = {
      id: `manual:${this.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, source: 'manual', kind: o.kind && SUPPORT_KINDS.includes(o.kind) ? o.kind : 'tip',
      who: { name: o.name || 'Someone', anonymous: !o.name }, recurring: false, test: false, occurredAt: now, receivedAt: now, replayed: false,
      ...(minor ? { amount: { minor, currency, valuedAt: 'cash' as const } } : {}),
      ...(o.message ? { message: { text: o.message, moderated: 'ok' as const } } : {}),
      ...(o.item ? { item: { name: o.item } } : {}),
    };
    return this.accept(ev) === 'ok' ? this.log.get(ev.id) : null;
  }

  /** Test events show on stream only when the studio's Send-a-test button made them (one shot) or the streamer turned on
   *  "show the services' test events on stream"; a real event always does. */
  private testLoud = false;
  private onStream(ev: SupportEvent) { return !ev.test || this.testLoud || this.settings.testsOnStream; }

  /** The test injector: sample events (test:true) for one service / chat platform, or every source. */
  test(which = 'all'): number {
    this.testLoud = true;
    try { return this.runTests(which); } finally { this.testLoud = false; }
  }
  private runTests(which: string): number {
    let n = 0;
    const mark = (e: SupportEvent): SupportEvent => ({ ...e, id: `${e.id}~t${this.now().toString(36)}${(n++).toString(36)}`, test: true, occurredAt: new Date(this.now()).toISOString() });
    const services = which === 'all' ? SUPPORT_SERVICES : (SUPPORT_SERVICES as readonly string[]).includes(which) ? [which as SupportService] : [];
    for (const s of services) {
      const c = this.conns.get(s) ?? this.deps.connectors(s);
      if (!c) continue;
      for (const e of c.test()) this.accept(mark(e), { service: this.conns.has(s) ? s : undefined });
    }
    // chat platforms: through the chat hub (their own test lines), converted back like real ones
    const chatTests: Record<string, [string, LivePlatform]> = { twitch: ['bits', 'twitch'], youtube: ['superchat', 'youtube'], kick: ['kicks', 'kick'], rumble: ['rant', 'rumble'], tiktok: ['tiktok', 'tiktok'] };
    for (const [p, [what]] of Object.entries(chatTests)) {
      if (which !== 'all' && which !== p) continue;
      const before = this.count;
      this.deps.chat.onFinance(testFinance(what, this.now() + n), true);
      n += this.count - before;
    }
    if (which === 'manual' || which === 'all') { const before = this.count; this.accept(mark({ id: 'manual:test', source: 'manual', kind: 'tip', who: { name: 'Your friend', anonymous: false }, amount: { minor: 500, currency: this.settings.displayCurrency }, message: { text: 'A tip you added by hand', moderated: 'ok' }, recurring: false, test: true, occurredAt: '', receivedAt: '', replayed: false })); n += this.count - before; }
    return n;
  }

  // ---------------------------------------------------------------- status
  status(): SupportStatus {
    const services = {} as Record<SupportService, ServiceStatus>;
    for (const s of SUPPORT_SERVICES) {
      const c = this.conns.get(s);
      const st = c?.status() ?? { state: 'off' as const, detail: '' };
      services[s] = {
        id: s, enabled: this.settings.services[s].enabled, state: this.settings.services[s].enabled ? st.state : 'off',
        detail: this.settings.services[s].enabled ? st.detail : '',
        saved: this.vault.saved(s), hook: this.settings.inboxServices.includes(s), lastEventAt: this.lastAt[s] ?? 0,
      };
    }
    const t = this.rates.table;
    return {
      services, vault: { kind: this.vault.kind, label: VAULT_LABEL[this.vault.kind] }, inbox: { ...this.inboxState },
      rates: { date: t?.date ?? '', source: t?.source ?? 'approx', currency: this.settings.displayCurrency }, events: this.count,
    };
  }
  pushStatus() {
    if (this.statusT) return;
    this.statusT = setTimeout(() => { this.statusT = null; this.deps.broadcast({ type: 'supportStatus', s: this.status() }); }, 300);
  }

  recent(n = 100): LoggedEvent[] { return this.log.latest(n); }
}

// ---------------------------------------------------------------- SupportEvent → the old chat line
const KIND_WORD: Partial<Record<SupportEvent['kind'], string>> = { tip: 'tip', purchase: 'order', membership: 'member', wishlist_gift: 'gift', gift: 'gift', sub: 'sub' };
export function chatLabel(ev: SupportEvent): string {
  const name = (SUPPORT_PLATFORM_NAMES as Record<string, string>)[ev.source];
  if (!name) return '';
  if (ev.source === 'patreon') return 'Patreon';
  if (ev.source === 'stripe') return 'Tip';
  const w = KIND_WORD[ev.kind];
  return (w ? `${name} ${w}` : name).slice(0, 32);
}
export function toRawFinance(ev: SupportEvent, usdOf: (m: NonNullable<SupportEvent['amount']>, bitCents?: number) => number, bitCents = 1): RawFinance | null {
  const src = ev.source as string;
  const k = ev.kind;
  let kind: FinanceKind;
  if (k === 'tip' || k === 'other') kind = 'tip';
  else if (k === 'purchase') kind = 'purchase';
  else if (k === 'wishlist_gift') kind = 'wishlist';
  else if (k === 'membership') kind = src === 'patreon' ? 'patron' : 'membership';
  else if (k === 'sub') kind = (ev.units?.months ?? 1) > 1 ? 'resub' : 'sub';
  else if (k === 'gift') kind = src === 'youtube' || src === 'fourthwall' ? 'giftMembership' : 'giftSub';
  else if (k === 'bits') kind = 'bits';
  else if (k === 'superchat') kind = 'superchat';
  else return null;
  const pfx = `${src}:`;
  const id = ev.id.startsWith(pfx) ? ev.id.slice(pfx.length) : ev.id;
  const raw: RawFinance = { platform: src, username: ev.who.name, kind, ts: Date.parse(ev.occurredAt) || Date.now(), id, support: ev.id };
  const label = chatLabel(ev);
  if (label) raw.label = label;
  if (k === 'bits') { const bits = ev.units?.bits ?? ev.amount?.minor ?? 0; raw.amount = bits; raw.currency = 'bits'; raw.usd = +((bits * bitCents) / 100).toFixed(2); }
  else if (k === 'sub' || k === 'gift') {
    const n = k === 'gift' ? ev.units?.gifted ?? ev.units?.subs ?? 1 : ev.units?.months ?? 1;
    raw.amount = n; raw.currency = k === 'gift' ? 'subs' : 'months';
    if (ev.amount) raw.usd = usdOf(ev.amount, bitCents);
    if (ev.recipient) raw.recipients = [ev.recipient.name];
  } else if (ev.amount && ev.amount.minor > 0) {
    raw.amount = ev.amount.minor / minorPerMajor(ev.amount.currency);
    raw.currency = ev.amount.currency.toLowerCase();
    raw.usd = usdOf(ev.amount, bitCents);
  } else if (k === 'membership') { raw.amount = ev.units?.months ?? 1; raw.currency = 'months'; }
  const msg = ev.message && ev.message.moderated === 'ok' ? ev.message.text : '';
  const item = ev.item ? `${ev.item.qty && ev.item.qty > 1 ? `${ev.item.qty}× ` : ''}${ev.item.name}` : '';
  // what they bought / gifted stays in the line even when they wrote a message (the alert shows both)
  const what = k === 'purchase' && item ? `bought ${item}` : k === 'wishlist_gift' && item ? `gifted ${item}` : k === 'other' && item ? item : ev.tierName && k === 'membership' ? `joined ${ev.tierName}` : '';
  raw.message = what && msg ? `${what}: ${msg}` : msg || what;
  if (item) raw.giftName = item.slice(0, 40);
  return raw;
}

/** Chat test lines for the chat platforms (the shapes server/chat/hub.ts testEvents uses). */
function testFinance(what: string, n: number): RawFinance {
  const ts = Date.now(), id = `test:${what}:${n.toString(36)}`;
  const u = ['NightOwl42', 'PixelPioneer', 'NeonNomad', 'Beatsmith'][n % 4];
  switch (what) {
    case 'bits': return { platform: 'twitch', username: u, kind: 'bits', amount: 500, currency: 'bits', message: 'Test cheer, take my bits!', ts, id };
    case 'superchat': return { platform: 'youtube', username: u, kind: 'superchat', amount: 5, currency: 'usd', message: 'Test Super Chat!', ts, id, color: '#1de9b6' };
    case 'kicks': return { platform: 'kick', username: u, kind: 'kicks', amount: 500, currency: 'kicks', message: 'Test Kicks!', ts, id };
    case 'rant': return { platform: 'rumble', username: u, kind: 'rant', amount: 10, currency: 'usd', usd: 10, message: 'Test Rumble Rant', ts, id };
    default: return { platform: 'tiktok', username: u, kind: 'tiktokGift', amount: 1000, currency: 'coins', message: 'sent Lion', giftName: 'Lion', ts, id };
  }
}

/** Sources the studio lists in the feed filter. */
export const FEED_SOURCES: SupportSource[] = ['twitch', 'youtube', 'kick', 'rumble', 'tiktok', ...SUPPORT_SERVICES, 'manual'];
export const serviceName = (s: SupportService) => SERVICE_INFO[s].name;
