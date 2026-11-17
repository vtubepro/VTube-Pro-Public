// The connector contract (beta.13, research section E2): every support service is one SupportConnector that turns its
// own events into SupportEvents (shared/support.ts) and hands them to the hub (server/support/hub.ts), which dedupes,
// converts the currency, filters messages, logs, broadcasts and mirrors them into chat.
//
//   start(ctx)        connect (socket / start polling). Never throws: problems go to ctx.status().
//   stop()            disconnect, stop timers.
//   catchUp(since)    fetch what happened since `since` (ISO) while VTube Pro was closed: events come back marked
//                     replayed:true (goals update quietly unless "play missed alerts" is on). 0 when the service has no
//                     history (Ko-fi, Throne: their inbox on the relay keeps 7 days instead).
//   test()            sample events in this service's real shape (test:true): the studio's "Send a test" button.
//   status()          { state, detail } in plain words.
//   hook(delivery)    a webhook delivery from the relay inbox (or the local test route): verify its signature with the
//                     secret kept on THIS PC, then parse. Bad signature = rejected, never shown.
import crypto from 'node:crypto';
import type { SupportEvent, SupportKind, SupportSource } from '../../shared/support.ts';
import type { ServiceSettings, ServiceState, SupportService, SupportSettings } from '../../shared/supportConfig.ts';

export interface InboxDelivery {
  /** The relay's sequence number (acked after handling). */
  seq: number;
  provider: string;
  /** When the relay received it (epoch ms): Stripe's signature tolerance is checked against this, not "now". */
  at: number;
  /** Lower-cased header names the relay kept (signature headers, content-type). */
  headers: Record<string, string>;
  body: Buffer;
}

/** `voids`: refunds / cancellations of events we already have (goals drop them). */
export type HookResult = { ok: true; events: SupportEvent[]; voids?: { id: string; why: string }[]; note?: string } | { ok: false; why: string };

export interface ConnectorCtx {
  /** Hand events to the hub (it fills receivedAt, dedupes, logs, broadcasts). */
  emit(evs: SupportEvent[], o?: { replayed?: boolean }): void;
  /** A secret of THIS service ('' when not saved). */
  secret(field: string): string;
  settings(): SupportSettings;
  service(): ServiceSettings;
  status(state: ServiceState, detail: string): void;
  log(...a: unknown[]): void;
  /** Injectable for tests (fixtures): every outside call goes through it. */
  fetch: typeof fetch;
  /** The newest occurredAt this service gave us (catch-up starts there). */
  lastSeen(): string;
  /** Is this platform's own connector live (cross-source dedupe for StreamElements / Streamlabs copies)? */
  nativeLive(p: string): boolean;
  /** Fourthwall: products went stale (store cache refresh). */
  storeChanged?(): void;
  /** Patreon: members changed (supporters refresh). */
  membersChanged?(): void;
}

export interface SupportConnector {
  readonly id: SupportService;
  /** Its events also go out as chat 'finance' lines (old alerts / goal bar). false for a source whose platform's chat
   *  already carries these events as chat lines. */
  readonly mirrorsChat: boolean;
  start(ctx: ConnectorCtx): Promise<void> | void;
  stop(): void;
  catchUp(sinceIso: string): Promise<number>;
  test(): SupportEvent[];
  status(): { state: ServiceState; detail: string };
  hook?(d: InboxDelivery): Promise<HookResult> | HookResult;
}

// ---------------------------------------------------------------- helpers every connector uses
/** A SupportEvent with the defaults filled in. `pid` = the provider's own object id (order id, checkout session id ...):
 *  the SAME object reached by webhook and by polling gets the SAME id, so it is counted once. */
export function mkEvent(source: SupportSource, pid: string, kind: SupportKind, o: Partial<SupportEvent> & { who: SupportEvent['who'] }): SupportEvent {
  const now = new Date().toISOString();
  return {
    id: `${source}:${String(pid).slice(0, 160)}`,
    source, kind, recurring: false, test: false, occurredAt: now, receivedAt: now, replayed: false,
    ...o,
  };
}

/** Major-unit money ("12.50", 12.5) → minor units of `currency` (JPY minor = major). */
export function toMinor(v: unknown, currency: string): number {
  const n = typeof v === 'number' ? v : typeof v === 'string' ? parseFloat(v.replace(/[^0-9.\-]/g, '')) : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  const zero = ['JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'XAF', 'XOF', 'PYG', 'RWF', 'KMF', 'GNF', 'BIF', 'DJF', 'VUV', 'XPF'].includes(currency.toUpperCase());
  return Math.round(n * (zero ? 1 : 100));
}

export const iso = (v: unknown, d = new Date().toISOString()): string => {
  if (typeof v === 'number' && Number.isFinite(v)) return new Date(v > 1e12 ? v : v * 1000).toISOString();
  if (typeof v === 'string') { const t = Date.parse(v); if (Number.isFinite(t)) return new Date(t).toISOString(); }
  return d;
};
export const cur = (v: unknown, d = 'USD'): string => (typeof v === 'string' && /^[a-z]{3}$/i.test(v.trim()) ? v.trim().toUpperCase() : d);
export const s = (v: unknown, max = 200): string => (typeof v === 'string' ? v.trim().slice(0, max) : typeof v === 'number' ? String(v) : '');

/** Constant-time compare of two strings (signatures). */
export function safeEq(a: string, b: string): boolean {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
export const hmac = (alg: 'sha256' | 'md5', key: string | Buffer, data: Buffer | string) => crypto.createHmac(alg, key).update(data);

export function parseJson(b: Buffer): unknown { try { return JSON.parse(b.toString('utf8')); } catch { return null; } }

/** A tiny poller: runs `fn` every `ms` (first run right away), never overlapping, stops cleanly. */
export class Poller {
  private t: NodeJS.Timeout | null = null;
  private busy = false;
  private stopped = true;
  constructor(private fn: () => Promise<void>, private ms: () => number) {}
  start() { this.stopped = false; void this.tick(); }
  stop() { this.stopped = true; if (this.t) clearTimeout(this.t); this.t = null; }
  private async tick() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try { await this.fn(); } catch { /* the connector reports through status() */ } finally { this.busy = false; }
    if (!this.stopped) this.t = setTimeout(() => void this.tick(), this.ms());
  }
}

/** Plain-words errors for an HTTP answer from a service. */
export function httpProblem(name: string, status: number): string {
  if (status === 401 || status === 403) return `${name} didn’t accept that key. Copy it again and paste it here.`;
  if (status === 404) return `${name} couldn’t find that. Check the key belongs to the right account.`;
  if (status === 429) return `${name} asked us to slow down. We try again in a minute.`;
  if (status >= 500) return `${name} is having trouble right now. We keep trying.`;
  return `${name} said no (${status}). Try the key again.`;
}
