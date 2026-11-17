// Money in the streamer's display currency (beta.13). Daily central-bank rates from Frankfurter (frankfurter.dev: ECB
// reference rates, no key, no quota), fetched at most once a day by the helper and cached in cache/support/rates.json.
// Every event is converted ONCE, at receipt, and the result is stored on the event (SupportEvent.display) next to the
// original amount, so totals never drift when tomorrow's rate differs. Offline / a currency Frankfurter doesn't list:
// the static approximate table (shared/chat.ts APPROX_USD), marked rateSource 'approx'.
// Bits: 1 bit = `bitCents` US cents (1 by default); Kicks / Jewels already arrive as a USD estimate.
import fs from 'node:fs';
import path from 'node:path';
import { APPROX_USD } from '../../shared/chat.ts';
import { minorPerMajor, type SupportDisplayMoney, type SupportMoney } from '../../shared/support.ts';
import { writeAtomic } from './vault.ts';

export interface RateTable { base: string; date: string; rates: Record<string, number>; fetchedAt: number; source: string }
export const FRANKFURTER = 'https://api.frankfurter.dev/v1/latest?base=USD';
const DAY = 24 * 3600 * 1000;

export class Rates {
  table: RateTable | null = null;
  private inflight: Promise<void> | null = null;
  constructor(private file: string, private fetcher: typeof fetch = fetch, private url = FRANKFURTER) {
    try { const t = JSON.parse(fs.readFileSync(file, 'utf8')) as RateTable; if (t && t.base === 'USD' && t.rates) this.table = t; } catch { /* first run */ }
  }

  /** Refresh when the cached table is older than ~20 h (never blocks a conversion: the old table / approx is used). */
  refresh(now = Date.now()): Promise<void> {
    if (this.table && now - this.table.fetchedAt < 20 * 3600 * 1000) return Promise.resolve();
    if (this.inflight) return this.inflight;
    this.inflight = (async () => {
      try {
        const r = await this.fetcher(this.url, { headers: { 'User-Agent': 'vtube-pro/1.0 (support rates)' }, signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const j = (await r.json()) as { base?: string; date?: string; rates?: Record<string, number> };
        if (j.base !== 'USD' || !j.rates || typeof j.date !== 'string') throw new Error('unexpected answer');
        const rates: Record<string, number> = { USD: 1 };
        for (const [k, v] of Object.entries(j.rates)) if (/^[A-Z]{3}$/.test(k) && typeof v === 'number' && v > 0 && Number.isFinite(v)) rates[k] = v;
        this.table = { base: 'USD', date: j.date, rates, fetchedAt: now, source: 'frankfurter' };
        fs.mkdirSync(path.dirname(this.file), { recursive: true });
        writeAtomic(this.file, JSON.stringify(this.table));
      } catch (e) {
        console.warn('[support] exchange rates not refreshed:', (e as Error).message);
      } finally { this.inflight = null; }
    })();
    return this.inflight;
  }

  /** Units of `cur` per 1 USD, and where that number came from. */
  perUsd(cur: string): { r: number; source: string; date: string } | null {
    const c = cur.toUpperCase();
    if (c === 'USD') return { r: 1, source: this.table?.source ?? 'fixed', date: this.table?.date ?? today() };
    const t = this.table;
    if (t && t.rates[c] && Date.now() - t.fetchedAt < 14 * DAY) return { r: t.rates[c], source: t.source, date: t.date };
    const a = APPROX_USD[c.toLowerCase()];
    if (a) return { r: 1 / a, source: 'approx', date: today() };
    if (t && t.rates[c]) return { r: t.rates[c], source: `${t.source} (old)`, date: t.date };
    return null;
  }

  /** Convert an event amount into `to` (minor units). null = no rate known for that currency. */
  convert(m: SupportMoney, to: string, bitCents = 1): SupportDisplayMoney | null {
    const target = to.toUpperCase();
    let usdMajor: number;
    let src = '', date = '';
    if (m.valuedAt === 'bits') {
      usdMajor = (m.minor * bitCents) / 100;
      src = 'bits';
    } else {
      const from = this.perUsd(m.currency);
      if (!from) return null;
      usdMajor = m.minor / minorPerMajor(m.currency) / from.r;
      src = m.currency.toUpperCase() === 'USD' ? '' : from.source; date = from.date;
    }
    const t = this.perUsd(target);
    if (!t) return null;
    const major = usdMajor * t.r;
    const source = [src, target === 'USD' ? '' : t.source].filter(Boolean)[0] || (m.currency.toUpperCase() === target ? 'same' : t.source);
    return { minor: Math.round(major * minorPerMajor(target)), currency: target, rateSource: source, rateDate: date || t.date };
  }

  /** The USD value (major) of an event amount, for the old chat totals (ChatTotals.usd). */
  usd(m: SupportMoney, bitCents = 1): number {
    const d = this.convert(m, 'USD', bitCents);
    return d ? d.minor / 100 : 0;
  }
}

const today = () => new Date().toISOString().slice(0, 10);
