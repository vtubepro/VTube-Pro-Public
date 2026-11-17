// Patreon (research A5 + C), API v2 ONLY (v1 retired 2026-10-07). The creator's own Creator Access Token reads the
// campaign, its tiers and its members (who is an active patron, which tier, since when, and the Twitch / YouTube
// accounts a patron connected on Patreon: social_connections). Webhooks (via the relay inbox; X-Patreon-Signature =
// hex HMAC-MD5(secret, body), X-Patreon-Event) make a new patron instant. Patreon has no tips: a patron is a
// 'membership' with recurring:true. The members list feeds supporterOf() (server/support/supporters.ts).
import crypto from 'node:crypto';
import type { SupportEvent } from '../../../shared/support.ts';
import { Poller, httpProblem, iso, mkEvent, parseJson, s, safeEq, type ConnectorCtx, type HookResult, type InboxDelivery, type SupportConnector } from '../types.ts';

type J = Record<string, unknown>;
const o = (v: unknown): J => (v && typeof v === 'object' ? v as J : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
export const PATREON_API = 'https://www.patreon.com/api/oauth2/v2';

export function verifyPatreon(body: Buffer, header: string | undefined, secret: string): boolean {
  if (!header || !secret) return false;
  return safeEq(crypto.createHmac('md5', secret).update(body).digest('hex'), header.trim().toLowerCase());
}

export interface PatreonTier { id: string; title: string; cents: number; rank: number }
export interface PatreonMember {
  id: string; name: string; active: boolean; cents: number; tierId: string; since: string; userId: string;
  /** Platform user ids the patron connected on Patreon (social_connections). */
  social: { twitch?: string; youtube?: string; discord?: string };
}

/** Tiers ranked by price (1 = cheapest). */
export function rankTiers(list: { id: string; title: string; cents: number }[]): Map<string, PatreonTier> {
  const sorted = [...list].filter((t) => t.cents > 0).sort((a, b) => a.cents - b.cents);
  return new Map(sorted.map((t, i) => [t.id, { ...t, rank: i + 1 }]));
}

/** A JSON:API members page (+ included tiers / users) → members. */
export function parseMembers(page: J): { members: PatreonMember[]; tiers: { id: string; title: string; cents: number }[]; next: string } {
  const inc = arr(page.included).map(o);
  const users = new Map(inc.filter((x) => x.type === 'user').map((u) => [s(u.id, 40), o(u.attributes)]));
  const tiers = inc.filter((x) => x.type === 'tier').map((t) => ({ id: s(t.id, 40), title: s(o(t.attributes).title, 60), cents: Number(o(t.attributes).amount_cents) || 0 }));
  const members: PatreonMember[] = [];
  for (const m of arr(page.data).map(o)) {
    const a = o(m.attributes), rel = o(m.relationships);
    const uid = s(o(o(rel.user).data).id, 40);
    const tierIds = arr(o(rel.currently_entitled_tiers).data).map((t) => s(o(t).id, 40)).filter(Boolean);
    const cents = Number(a.currently_entitled_amount_cents) || 0;
    const top = tierIds.map((id) => tiers.find((t) => t.id === id)).filter(Boolean).sort((x, y) => y!.cents - x!.cents)[0];
    const sc = o(users.get(uid)?.social_connections);
    const social: PatreonMember['social'] = {};
    const tw = s(o(sc.twitch).user_id, 40); if (tw) social.twitch = tw;
    const yt = s(o(sc.youtube).user_id, 60); if (yt) social.youtube = yt;
    const dc = s(o(sc.discord).user_id, 40); if (dc) social.discord = dc;
    members.push({
      id: s(m.id, 60), name: s(a.full_name, 60) || s(users.get(uid)?.full_name, 60), active: a.patron_status === 'active_patron', cents,
      tierId: top?.id ?? tierIds[0] ?? '', since: iso(a.pledge_relationship_start, ''), userId: uid, social,
    });
  }
  return { members, tiers, next: s(o(o(o(page.meta).pagination).cursors).next, 200) };
}

/** A new pledge (webhook members:pledge:create, or a polled member that started after `since`) → its event. The id is
 *  the member + pledge start, so the webhook and the poll agree. */
/** `currency`: the CAMPAIGN's currency (Campaign.currency): currently_entitled_amount_cents is in it (tiers' amount_cents
 *  are US cents and only rank tiers). */
export function patronEvent(m: PatreonMember, tiers: Map<string, PatreonTier>, test = false, currency = 'USD'): SupportEvent | null {
  if (!m.id || !m.active) return null;
  const t = tiers.get(m.tierId);
  return mkEvent('patreon', `${m.id}:${(m.since || '').slice(0, 19)}`, 'membership', {
    who: { name: m.name.split(' ')[0] || 'Someone', anonymous: !m.name, linkedId: `patreon:${m.id}` },
    ...(m.cents ? { amount: { minor: m.cents, currency: /^[A-Z]{3}$/.test(currency) ? currency : 'USD', valuedAt: 'cash' as const } } : {}),
    tierName: t?.title || 'Patron', recurring: true, firstOfRecurring: true, units: { months: 1, tier: t?.title || '' },
    occurredAt: m.since || new Date().toISOString(), test,
  });
}

export class PatreonConnector implements SupportConnector {
  readonly id = 'patreon' as const;
  readonly mirrorsChat = true;
  private ctx: ConnectorCtx | null = null;
  private st: { state: 'off' | 'connecting' | 'live' | 'waiting' | 'error'; detail: string } = { state: 'off', detail: '' };
  private poller: Poller | null = null;
  campaignId = '';
  /** The campaign's currency (pledge amounts are in it). */
  currency = 'USD';
  tiers = new Map<string, PatreonTier>();
  members = new Map<string, PatreonMember>();
  refreshedAt = 0;
  private startedAt = '';

  private async api(path: string): Promise<J> {
    const c = this.ctx!;
    const r = await c.fetch(`${PATREON_API}${path}`, { headers: { authorization: `Bearer ${c.secret('token')}`, 'user-agent': 'vtube-pro/1.0 (support)' }, signal: AbortSignal.timeout(20000) });
    if (!r.ok) throw new Error(httpProblem('Patreon', r.status));
    return o(await r.json());
  }

  async start(ctx: ConnectorCtx) {
    this.ctx = ctx;
    if (!ctx.secret('token')) { this.st = ctx.secret('hookSecret') ? { state: 'live', detail: 'Connected by webhook ✓ (add the token for tiers and name effects)' } : { state: 'waiting', detail: 'Paste your Creator’s Access Token.' }; return; }
    this.st = { state: 'connecting', detail: 'Checking your token…' };
    try {
      const camps = await this.api('/campaigns?fields%5Bcampaign%5D=creation_name,patron_count,currency');
      this.campaignId = s(o(arr(camps.data)[0]).id, 40);
      const cc = s(o(o(arr(camps.data)[0]).attributes).currency, 3).toUpperCase();
      if (/^[A-Z]{3}$/.test(cc)) this.currency = cc;
      if (!this.campaignId) { this.st = { state: 'error', detail: 'That Patreon account has no creator page yet.' }; return; }
    } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; return; }
    this.startedAt = new Date().toISOString();
    // members: the whole list every 15 minutes (status changes, tier changes, the daily re-check); webhooks are instant
    // (with the webhook a new patron is instant: polling is the daily-ish status re-check; without it, a new patron shows
    //  within 2 minutes: a 5000-patron campaign is ~10 requests per poll, far under Patreon's 100 / minute)
    this.poller = new Poller(async () => { await this.refresh(false); }, () => (ctx.secret('hookSecret') && ctx.settings().inboxServices.includes('patreon') ? 15 * 60_000 : 2 * 60_000));
    this.poller.start();
  }
  stop() { this.poller?.stop(); this.poller = null; this.st = { state: 'off', detail: '' }; }
  status() { return this.st; }

  /** Reload tiers + every member (paginated). New pledges since `startedAt` become events. */
  async refresh(replayed: boolean, since = this.startedAt): Promise<number> {
    const c = this.ctx!;
    try {
      const fields = 'include=currently_entitled_tiers,user&fields%5Bmember%5D=full_name,patron_status,currently_entitled_amount_cents,pledge_relationship_start&fields%5Btier%5D=title,amount_cents&fields%5Buser%5D=full_name,social_connections&page%5Bcount%5D=500';
      const all: PatreonMember[] = [];
      const tierList = new Map<string, { id: string; title: string; cents: number }>();
      let cursor = '';
      for (let i = 0; i < 40; i++) {
        const page = await this.api(`/campaigns/${this.campaignId}/members?${fields}${cursor ? `&page%5Bcursor%5D=${encodeURIComponent(cursor)}` : ''}`);
        const p = parseMembers(page);
        all.push(...p.members);
        for (const t of p.tiers) tierList.set(t.id, t);
        if (!p.next) break;
        cursor = p.next;
      }
      this.tiers = rankTiers([...tierList.values()]);
      this.members = new Map(all.map((m) => [m.id, m]));
      this.refreshedAt = Date.now();
      const active = all.filter((m) => m.active).length;
      this.st = { state: 'live', detail: `Connected ✓ · ${active} patron${active === 1 ? '' : 's'}` };
      c.membersChanged?.();
      const after = Date.parse(since) || Date.now();
      const evs = all.filter((m) => m.active && Date.parse(m.since) > after).map((m) => patronEvent(m, this.tiers, false, this.currency)).filter((e): e is SupportEvent => !!e);
      if (evs.length) c.emit(evs, replayed ? { replayed: true } : undefined);
      return evs.length;
    } catch (e) { this.st = { state: 'error', detail: (e as Error).message }; return 0; }
  }

  async catchUp(since: string) { if (!this.campaignId) return 0; return this.refresh(true, since); }

  hook(d: InboxDelivery): HookResult {
    const c = this.ctx;
    const secret = c?.secret('hookSecret') ?? '';
    if (!secret) return { ok: false, why: 'Paste your Patreon webhook secret so we can check its webhooks.' };
    if (!verifyPatreon(d.body, d.headers['x-patreon-signature'], secret)) return { ok: false, why: 'signature did not match' };
    const trig = s(d.headers['x-patreon-event'], 40);
    const j = o(parseJson(d.body));
    const p = parseMembers({ data: [j.data], included: j.included });
    const m = p.members[0];
    if (m) {
      if (p.tiers.length) { const cur = [...this.tiers.values()].map((t) => ({ id: t.id, title: t.title, cents: t.cents })); for (const t of p.tiers) if (!cur.some((x) => x.id === t.id)) cur.push(t); this.tiers = rankTiers(cur); }
      const prev = this.members.get(m.id);
      if (!m.name && prev) m.name = prev.name;
      if (!Object.keys(m.social).length && prev) m.social = prev.social;
      this.members.set(m.id, m);
      c?.membersChanged?.();
    }
    if (trig === 'members:pledge:create' && m) { const e = patronEvent(m, this.tiers, false, this.currency); return { ok: true, events: e ? [e] : [] }; }
    return { ok: true, events: [] };
  }

  test(): SupportEvent[] {
    const tiers = rankTiers([{ id: 't1', title: 'Night Owl', cents: 500 }, { id: 't2', title: 'Moon Club', cents: 1500 }]);
    const e = patronEvent({ id: 'test-member', name: 'ExampleSam', active: true, cents: 1500, tierId: 't2', since: new Date().toISOString(), userId: 'u1', social: {} }, tiers, true);
    return e ? [e] : [];
  }
}

/** A members:pledge:create delivery in Patreon's documented JSON:API shape (valid JSON: the docs' sample has trailing commas). */
export const PATREON_FIXTURE = {
  data: {
    attributes: { currently_entitled_amount_cents: 1500, full_name: 'Example Sam', is_follower: false, last_charge_date: '2026-10-09T15:00:00+00:00', last_charge_status: 'Paid', note: '', patron_status: 'active_patron', pledge_relationship_start: '2026-10-09T14:59:58+00:00' },
    id: '00000000-0000-0000-0000-000000000000',
    relationships: { address: { data: null }, campaign: { data: { id: '123456', type: 'campaign' } }, currently_entitled_tiers: { data: [{ id: '54321', type: 'tier' }] }, user: { data: { id: '987654321', type: 'user' } } },
    type: 'member',
  },
  included: [
    { attributes: { creation_name: 'late-night streams', patron_count: 42 }, id: '123456', type: 'campaign' },
    { attributes: { full_name: 'Example Sam', social_connections: { twitch: { user_id: '1234567', url: 'https://twitch.tv/example', scopes: [] }, youtube: null, discord: null } }, id: '987654321', type: 'user' },
    { attributes: { amount_cents: 1500, title: 'Moon Club', published: true }, id: '54321', type: 'tier' },
  ],
};
