// Finance (support event) normalisation — ported from an earlier overlay's src/finance.js (same parsing, same
// USD rules, same dedupe window), in TypeScript, extended with YouTube memberships (milestone / gifted) and the
// original-currency + approximate-USD display.
import { APPROX_USD, FINANCE_LABELS, MONEY_KINDS, PLATFORM_COLORS, SUPPORT_PLATFORMS, rantTier, superChatTier, type FinanceKind } from '../../shared/chat.ts';

/** A connector's raw support event (an earlier overlay's onFinance shape). */
export interface RawFinance {
  platform: string;
  username?: string;
  kind: string;
  amount?: unknown;
  currency?: string;
  usd?: number;
  message?: string;
  ts?: number;
  id?: string;
  color?: string | null;
  recipients?: string[];
  giftName?: string;
  comboCount?: number;
  /** Twitch msg-param-sub-plan: '1000' | '2000' | '3000' | 'Prime' (subs, resubs, gifted subs) */
  subPlan?: string;
  badges?: string[];
  /** The card's label instead of the kind's ("Fourthwall order", "Ko-fi tip" ... support services, server/support). */
  label?: string;
  /** The SupportEvent this line mirrors (server/support/hub.ts): consumers of the support bus skip the chat copy. */
  support?: string;
  /** The supporter's stable platform user id when known (see RawChat.uid). */
  uid?: string;
}

export interface NormFinance {
  platform: string; username: string; kind: FinanceKind; kindLabel: string;
  amount: number; currency: string; usd: number; approxUsd?: number;
  message: string; ts: number; id: string; displayAmount: string;
  color?: string; recipients?: string[]; giftName?: string; comboCount?: number; badges?: string[]; support?: string; subPlan?: string; uid?: string;
}

/** Coerce anything that might be an amount into a finite non-negative number ("5.00", "$5", "1,250.50" …). */
export function toNumber(v: unknown): number {
  if (v == null || v === '') return 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  let s = String(v).trim();
  if (!s) return 0;
  s = s.replace(/[^0-9.,-]/g, '');
  if (!s || s === '-' || s === '.' || s === ',') return 0;
  const hasDot = s.includes('.'), hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) s = s.replace(/\./g, '').replace(',', '.');
    else s = s.replace(/,/g, '');
  } else if (hasComma) {
    const after = s.slice(s.lastIndexOf(',') + 1);
    s = after.length === 2 ? s.replace(',', '.') : s.replace(/,/g, '');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/** Pull a USD-ish money value out of a mixed payload (dollars first, then cents). */
export function extractMoneyFields(obj: unknown): { amountDollars: number; cents: number } {
  if (!obj || typeof obj !== 'object') return { amountDollars: 0, cents: 0 };
  const o = obj as Record<string, unknown>;
  const bags = [o, o.rant, o.tip, o.gift, o.donation, o.wallet, o.payload, o.metadata].filter((x): x is Record<string, unknown> => !!x && typeof x === 'object');
  for (const b of bags) {
    for (const k of ['amount_dollars', 'dollars', 'usd', 'amount_usd', 'price_dollars', 'value_dollars']) {
      if (b[k] != null && b[k] !== '') { const d = toNumber(b[k]); if (d > 0) return { amountDollars: d, cents: Math.round(d * 100) }; }
    }
    for (const k of ['amount_cents', 'price_cents', 'rant_price_cents', 'cents', 'value_cents', 'price']) {
      if (b[k] != null && b[k] !== '') {
        const c = toNumber(b[k]);
        if (c > 0) {
          if (k.endsWith('_cents') || k === 'cents') return { amountDollars: +(c / 100).toFixed(2), cents: Math.round(c) };
          if (k === 'price' && Number.isInteger(c) && c >= 50) return { amountDollars: +(c / 100).toFixed(2), cents: Math.round(c) };
          if (k === 'price') return { amountDollars: c, cents: Math.round(c * 100) };
        }
      }
    }
  }
  return { amountDollars: 0, cents: 0 };
}

const COUNT_UNITS = ['kicks', 'bits', 'jewels', 'coins', 'subs', 'months', 'viewers'];
/** TikTok: a gift's coin value → the creator's approximate payout (1 coin = 1 diamond ≈ $0.005). */
export const TIKTOK_USD_PER_COIN = 0.005;

export function normalizeFinance(evt: RawFinance): NormFinance | null {
  if (!evt || typeof evt !== 'object') return null;
  const platform = String(evt.platform || 'unknown').toLowerCase();
  const username = String(evt.username || 'anonymous').trim() || 'anonymous';
  let kind = String(evt.kind || 'tip').trim() || 'tip';
  if (kind === 'super_chat' || kind === 'superChat') kind = 'superchat';
  if (kind === 'super_sticker' || kind === 'superSticker') kind = 'supersticker';
  if (kind === 'gift_sub' || kind === 'giftsub' || kind === 'gifted_sub') kind = 'giftSub';
  if (kind === 'wallet_tip' || kind === 'rumble_wallet') kind = 'wallet';
  if (kind === 'jewel' || kind === 'youtube_gift' || kind === 'yt_gift' || kind === 'gift_jewel') kind = 'jewels';
  if (kind === 'gift' && platform === 'youtube') kind = 'jewels';
  if (kind === 'gift' && platform === 'tiktok') kind = 'tiktokGift';
  if (kind === 'cheer' || kind === 'bit') kind = 'bits';
  if (!(kind in FINANCE_LABELS)) kind = 'tip';
  const k = kind as FinanceKind;

  let currency = String(evt.currency || '').toLowerCase().trim();
  let amount = toNumber(evt.amount);
  let usd: number | null = typeof evt.usd === 'number' && Number.isFinite(evt.usd) ? evt.usd : null;
  if (!currency) {
    if (k === 'kicks') currency = 'kicks';
    else if (k === 'bits') currency = 'bits';
    else if (k === 'tiktokGift') currency = 'coins';
    else if (k === 'jewels') currency = 'jewels';
    else if (k === 'giftSub' || k === 'giftMembership') currency = 'subs';
    else if (k === 'sub' || k === 'resub' || k === 'membership' || k === 'milestone') currency = 'months';
    else if (k === 'raid') currency = 'viewers';
    else currency = 'usd';
  }
  if (currency === 'dollar' || currency === 'dollars' || currency === '$') currency = 'usd';
  if (currency === 'kick') currency = 'kicks';
  if (currency === 'sub') currency = 'subs';
  if (currency === 'month') currency = 'months';
  if (currency === 'viewer') currency = 'viewers';
  if (currency === 'jewel' || currency === 'ruby' || currency === 'rubies') currency = 'jewels';

  if (usd == null || (usd === 0 && currency === 'usd')) {
    if (currency === 'kicks' || currency === 'bits') usd = amount > 0 ? +(amount / 100).toFixed(2) : 0;
    else if (currency === 'coins') usd = amount > 0 ? +(amount * TIKTOK_USD_PER_COIN).toFixed(2) : 0;
    else if (currency === 'jewels') usd = amount > 0 ? +(amount / 100).toFixed(2) : 0;   // Overlay estimate: 100 Rubies = $1
    else if (currency === 'usd') usd = amount;
    else usd = usd ?? 0;
  }
  usd = Number.isFinite(usd) ? +Number(usd).toFixed(2) : 0;
  if (COUNT_UNITS.includes(currency)) amount = Math.round(amount);
  else amount = +Number(amount).toFixed(2);

  // non-USD money: keep the original, add an approximate USD for display (never counted)
  let approxUsd: number | undefined;
  if (MONEY_KINDS.has(k) && !COUNT_UNITS.includes(currency) && currency !== 'usd' && APPROX_USD[currency]) approxUsd = +(amount * APPROX_USD[currency]).toFixed(2);

  const message = evt.message != null ? String(evt.message) : '';
  const ts = Number(evt.ts) || Date.now();
  const id = evt.id || [platform, k, username.toLowerCase(), amount, currency, Math.floor(ts / 5000), message.slice(0, 40)].join(':');
  const display = k === 'membership' ? 'Member' : k === 'giftMembership' ? `${amount} membership${amount === 1 ? '' : 's'}` : formatAmount(amount, currency);
  const out: NormFinance = { platform, username, kind: k, kindLabel: (typeof evt.label === 'string' && evt.label.trim().slice(0, 32)) || FINANCE_LABELS[k], amount, currency, usd, message, ts, id, displayAmount: display };
  if (approxUsd) out.approxUsd = approxUsd;
  if (evt.color) out.color = evt.color;
  if (evt.recipients?.length) out.recipients = evt.recipients;
  if (evt.giftName) out.giftName = evt.giftName;
  if (evt.comboCount) out.comboCount = evt.comboCount;
  if (evt.subPlan && /^(1000|2000|3000|Prime)$/.test(evt.subPlan)) out.subPlan = evt.subPlan;
  if (evt.badges?.length) out.badges = evt.badges;
  if (typeof evt.support === 'string' && evt.support) out.support = evt.support;
  if (evt.uid) out.uid = String(evt.uid);
  return out;
}

const SYM: Record<string, string> = {
  cad: 'CA$', aud: 'A$', nzd: 'NZ$', hkd: 'HK$', sgd: 'SG$', twd: 'NT$', mxn: 'MX$', brl: 'R$', gbp: '£', eur: '€', jpy: '¥', cny: 'CN¥', krw: '₩',
  inr: '₹', php: '₱', vnd: '₫', ils: '₪', uah: '₴', ngn: '₦', thb: '฿', try: '₺', pln: 'zł', czk: 'Kč', chf: 'CHF ', idr: 'Rp', myr: 'RM',
};

/** Original-unit display (Overlay formatAmount, but Kicks stay Kicks — the $ value is shown separately). */
export function formatAmount(a: number, cur: string): string {
  if (cur === 'usd') return `$${a.toFixed(2)}`;
  if (cur === 'kicks') return `${a.toLocaleString('en-US')} Kick${a === 1 ? '' : 's'}`;
  if (cur === 'bits') return `${a.toLocaleString('en-US')} bit${a === 1 ? '' : 's'}`;
  if (cur === 'coins') return `${a.toLocaleString('en-US')} coin${a === 1 ? '' : 's'}`;
  if (cur === 'jewels') return `${a} Jewel${a === 1 ? '' : 's'}`;
  if (cur === 'subs') return `${a} sub${a === 1 ? '' : 's'}`;
  if (cur === 'months') return a > 1 ? `${a} months` : '1 month';
  if (cur === 'viewers') return `${a} viewer${a === 1 ? '' : 's'}`;
  if (SYM[cur]) return `${SYM[cur]}${cur === 'jpy' || cur === 'krw' || cur === 'vnd' || cur === 'idr' ? Math.round(a).toLocaleString('en-US') : a.toFixed(2)}`;
  return a ? `${a} ${cur.toUpperCase()}` : '';
}

/** Card colour: the platform's own (Super Chat renderer), else a tier by value. */
export function tierColor(n: NormFinance): string {
  if (n.color && /^#[0-9a-f]{6}$/i.test(n.color)) return n.color.toLowerCase();
  const v = n.usd || n.approxUsd || 0;
  if (n.kind === 'superchat' || n.kind === 'supersticker') return superChatTier(v);
  if (n.kind === 'rant' || n.kind === 'wallet') return rantTier(v);
  if (n.kind === 'jewels') return '#c084fc';
  if (n.platform === 'kick') return '#53fc18';
  if (n.platform === 'twitch') return '#9146ff';
  if (n.platform === 'tiktok') return '#fe2c55';
  if (n.platform === 'youtube') return '#2ba640';
  if (n.platform === 'rumble') return '#85c742';
  if ((SUPPORT_PLATFORMS as readonly string[]).includes(n.platform)) return PLATFORM_COLORS[n.platform as keyof typeof PLATFORM_COLORS];
  return '#ffd84a';
}

/** Sliding-window deduper (Overlay createFinanceDeduper): true = new. */
export function createFinanceDeduper(windowMs = 15000, maxSize = 500) {
  const seen = new Map<string, number>();
  return function isNew(evt: NormFinance): boolean {
    if (!evt || !evt.id) return true;
    const now = evt.ts || Date.now();
    if (seen.size > maxSize) {
      for (const [k, t] of seen) if (now - t > windowMs) seen.delete(k);
      if (seen.size > maxSize) for (const k of [...seen.keys()].slice(0, seen.size - maxSize)) seen.delete(k);
    }
    if (seen.has(evt.id)) return false;
    const shortKey = [evt.platform, evt.kind, String(evt.username || '').toLowerCase(), evt.amount, evt.currency, Math.floor(now / 5000)].join(':');
    if (seen.has(shortKey)) return false;
    seen.set(evt.id, now);
    seen.set(shortKey, now);
    return true;
  };
}
