// Supporters ↔ chatters (beta.13, research C): who in chat is a patron / member, so the audience lane can style names
// ("Patron glow"). The helper-side lookup is supporterOf(); pages get the same list over the bus
// ({type:'supporters'}, shared/supporters.ts makeSupporterLookup).
//
// Members come from: Patreon (the members list: active patrons + tier), and membership events of Fourthwall / Ko-fi /
// Buy Me a Coffee (active for 35 days after their last payment). A member is tied to a chat identity by:
//   1. social  - Patreon social_connections named a Twitch account id (automatic);
//   2. link    - `!link ABC123` in chat with a code the streamer made for that supporter (Studio → Support & store →
//                Supporters → "Make a link code"), valid 24 hours, single use;
//   3. claim   - `!link` (or `!link <name on Patreon>`) in chat: the studio shows "NightOwl42 on Twitch says they are
//                Starlight Sam on Patreon", with the best match, and the streamer presses ✓;
//   4. manual  - the streamer types the chat name next to a supporter. Manual always wins.
// Saved in saves/support/links.json (this PC only). Chat lines carry the display name, not the platform user id, so
// links are keyed by the lower-cased name (plus the user id when a source gives one).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { ChatEvent, ChatPlatform } from '../../shared/chat.ts';
import type { SupportEvent, SupportSource } from '../../shared/support.ts';
import { makeSupporterLookup, type ChatIdentity, type SupporterEntry, type SupporterInfo } from '../../shared/supporters.ts';
import { cleanText } from '../../shared/supportConfig.ts';
import type { PatreonConnector } from './connectors/patreon.ts';
import type { SupportHub } from './hub.ts';
import { writeAtomic } from './vault.ts';

interface Link { linkedId: string; chat: { platform: ChatPlatform; userId?: string; login?: string }; how: 'link' | 'manual' | 'claim'; at: number }
interface Code { code: string; linkedId: string; expires: number }
export interface Claim { id: string; chat: { platform: ChatPlatform; login: string }; said: string; at: number; suggest: string }
/** A member we know of (any service). */
export interface Member { linkedId: string; name: string; source: SupportSource; tier: string; rank: number; cents?: number; since: string; active: boolean; social?: { twitch?: string; youtube?: string }; /** last payment seen (event members) */ last?: number }

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ACTIVE_DAYS = 35;
const plain = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');

export class Supporters {
  private links: Link[] = [];
  private codes: Code[] = [];
  claims: Claim[] = [];
  /** Members seen in membership events (Fourthwall / Ko-fi / BMC): linkedId → member. */
  private seen = new Map<string, Member>();
  private list: SupporterEntry[] = [];
  private lookup = makeSupporterLookup([]);
  private file: string;
  private pushT: NodeJS.Timeout | null = null;

  constructor(private hub: SupportHub, savesDir: string) {
    this.file = path.join(savesDir, 'support', 'links.json');
    try {
      const j = JSON.parse(fs.readFileSync(this.file, 'utf8')) as { links?: Link[]; codes?: Code[]; seen?: Member[]; claims?: Claim[] };
      this.links = j.links ?? []; this.codes = (j.codes ?? []).filter((c) => c.expires > Date.now()); this.claims = j.claims ?? [];
      for (const m of j.seen ?? []) this.seen.set(m.linkedId, m);
    } catch { /* first run */ }
    hub.onMembers = () => this.rebuild();
    hub.listeners.add((ev) => this.onEvent(ev));
    this.rebuild();
  }

  // ---------------------------------------------------------------- the lookup
  supporterOf(who: ChatIdentity): SupporterInfo | null { return this.lookup(who); }
  entries(): SupporterEntry[] { return this.list; }

  /** Every member we know (the studio's Supporters list). */
  members(): Member[] {
    const out: Member[] = [];
    const pat = this.hub.connector('patreon') as PatreonConnector | null;
    if (pat) for (const m of pat.members.values()) {
      const t = pat.tiers.get(m.tierId);
      // (SupporterInfo.cents is US cents: the tier's amount_cents is; the member's own amount is in the campaign currency)
      const usdCents = t?.cents || (m.cents ? Math.round(this.hub.rates.usd({ minor: m.cents, currency: pat.currency }) * 100) : 0);
      out.push({ linkedId: `patreon:${m.id}`, name: m.name, source: 'patreon', tier: t?.title || (m.active ? 'Patron' : ''), rank: t?.rank ?? 0, ...(usdCents ? { cents: usdCents } : {}), since: m.since, active: m.active, social: m.social });
    }
    const cutoff = Date.now() - ACTIVE_DAYS * 86400_000;
    for (const m of this.seen.values()) out.push({ ...m, active: (m.last ?? 0) > cutoff });
    return out;
  }

  private rebuild() {
    const members = this.members().filter((m) => m.active);
    const byId = new Map(members.map((m) => [m.linkedId, m]));
    const list: SupporterEntry[] = [];
    const info = (m: Member, how: SupporterInfo['how']): SupporterInfo => ({ tier: m.tier || 'Supporter', rank: m.rank, ...(m.cents ? { cents: m.cents } : {}), source: m.source, since: m.since || new Date().toISOString(), how });
    const manual = new Set(this.links.filter((l) => l.how === 'manual').map((l) => l.linkedId));
    for (const m of members) {
      // social: only when the streamer didn't set this one by hand
      if (m.social?.twitch && !manual.has(m.linkedId)) list.push({ chat: { platform: 'twitch', userId: m.social.twitch }, name: m.name, linkedId: m.linkedId, info: info(m, 'social') });
      if (m.social?.youtube && /^UC[\w-]{20,}$/.test(m.social.youtube) && !manual.has(m.linkedId)) list.push({ chat: { platform: 'youtube', userId: m.social.youtube }, name: m.name, linkedId: m.linkedId, info: info(m, 'social') });
    }
    for (const l of this.links) {
      const m = byId.get(l.linkedId);
      if (!m) continue;
      list.push({ chat: { ...l.chat }, name: m.name, linkedId: l.linkedId, info: info(m, l.how === 'manual' ? 'manual' : 'link') });
    }
    this.list = list;
    this.lookup = makeSupporterLookup(list);
    if (this.pushT) return;
    this.pushT = setTimeout(() => { this.pushT = null; this.hub.deps.broadcast({ type: 'supporters', list: this.list }); }, 500);
  }

  private save() { writeAtomic(this.file, JSON.stringify({ links: this.links, codes: this.codes, claims: this.claims.slice(-100), seen: [...this.seen.values()] })); }

  // ---------------------------------------------------------------- membership events (Fourthwall / Ko-fi / BMC)
  private onEvent(ev: SupportEvent) {
    if (ev.test || ev.kind !== 'membership' || ev.source === 'patreon') return;
    const id = ev.who.linkedId || `${ev.source}:name:${plain(ev.who.name)}`;
    if (ev.who.anonymous) return;
    const prev = this.seen.get(id);
    const m: Member = { linkedId: id, name: ev.who.name, source: ev.source, tier: ev.tierName || prev?.tier || 'Member', rank: 1, cents: ev.amount?.currency === 'USD' ? ev.amount.minor : prev?.cents, since: prev?.since || ev.occurredAt, active: true, last: Date.now() };
    this.seen.set(id, m);
    this.save();
    this.rebuild();
  }

  // ---------------------------------------------------------------- !link in chat
  /** Called for every chat line (server/support/index.ts). Returns true when it was a !link command. */
  onChat(e: ChatEvent): boolean {
    if (e.kind !== 'chat' || e.test && !/^\s*!link\b/i.test(e.text)) return false;
    const m = /^\s*!link(?:\s+(.{1,60}))?\s*$/i.exec(e.text);
    if (!m) return false;
    const login = e.user.trim().toLowerCase();
    if (!login) return true;
    const arg = (m[1] ?? '').trim();
    const code = arg.toUpperCase().replace(/[^A-Z0-9]/g, '');
    const c = code.length === 6 ? this.codes.find((x) => x.code === code && x.expires > Date.now()) : undefined;
    if (c) {
      this.codes = this.codes.filter((x) => x !== c);
      this.links = this.links.filter((l) => !(l.linkedId === c.linkedId && l.chat.platform === e.platform && l.chat.login === login));
      this.links.push({ linkedId: c.linkedId, chat: { platform: e.platform, login }, how: 'link', at: Date.now() });
      this.save(); this.rebuild();
      return true;
    }
    // a claim for the streamer to confirm, with the closest member by name
    const said = cleanText(arg, 60);
    const want = plain(said || e.user);
    const suggest = this.members().filter((x) => x.active).map((x) => ({ x, d: plain(x.name).includes(want) || want.includes(plain(x.name)) ? 0 : 1 })).sort((a, b) => a.d - b.d)[0];
    this.claims = this.claims.filter((x) => !(x.chat.platform === e.platform && x.chat.login === login));
    this.claims.push({ id: crypto.randomBytes(6).toString('hex'), chat: { platform: e.platform, login }, said, at: Date.now(), suggest: suggest && suggest.d === 0 ? suggest.x.linkedId : '' });
    this.save();
    this.hub.pushStatus();
    return true;
  }

  // ---------------------------------------------------------------- the studio's actions
  makeCode(linkedId: string): { code: string; expires: string } {
    if (!this.members().some((m) => m.linkedId === linkedId)) throw Object.assign(new Error('That supporter isn’t on the list any more.'), { status: 404 });
    let code = '';
    do { code = Array.from(crypto.randomBytes(6), (b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join(''); } while (this.codes.some((c) => c.code === code));
    const c: Code = { code, linkedId, expires: Date.now() + 24 * 3600_000 };
    this.codes = [...this.codes.filter((x) => x.expires > Date.now() && x.linkedId !== linkedId), c];
    this.save();
    return { code, expires: new Date(c.expires).toISOString() };
  }
  setManual(linkedId: string, platform: ChatPlatform, name: string) {
    const login = cleanText(name, 48).replace(/^@/, '').toLowerCase();
    this.links = this.links.filter((l) => !(l.linkedId === linkedId && l.how === 'manual'));
    if (login) this.links.push({ linkedId, chat: { platform, login }, how: 'manual', at: Date.now() });
    this.save(); this.rebuild();
  }
  unlink(linkedId: string) { this.links = this.links.filter((l) => l.linkedId !== linkedId); this.save(); this.rebuild(); }
  answerClaim(id: string, linkedId: string | null) {
    const c = this.claims.find((x) => x.id === id);
    if (!c) return false;
    this.claims = this.claims.filter((x) => x !== c);
    if (linkedId) this.links.push({ linkedId, chat: { ...c.chat }, how: 'claim', at: Date.now() });
    this.save(); this.rebuild();
    return true;
  }
  linksOf(linkedId: string) { return this.links.filter((l) => l.linkedId === linkedId).map((l) => ({ platform: l.chat.platform, login: l.chat.login ?? '', userId: l.chat.userId ?? '', how: l.how })); }
}

/** The process-wide instance (set by server/support/index.ts): import { supporterOf } from '../support/supporters.ts'. */
let current: Supporters | null = null;
export function setSupporters(s: Supporters) { current = s; }
/** Is this chatter a supporter? (tier, source, since) - null when not, or before the support hub started. */
export function supporterOf(who: ChatIdentity): SupporterInfo | null { return current?.supporterOf(who) ?? null; }
