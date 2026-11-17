// A scripted chat audience for TEST pages only (output.html?sceneTest=<room>&audienceDemo=<n>; tools/audience_e2e.mjs):
// <n> fake chatters run through the REAL roster + question queue (shared/audience.ts) on this page — nothing is sent
// anywhere. `at(s)` jumps the page's audience clock to s seconds into the script (manual clock: identical frames on every
// run): messages, emotes, a laugh, a tip cheer, an !ask approved then answered, a paid question, a big cheer (stadium
// wave), applause.
import { AskQueue, AudienceRoster, SupporterBook, chatKey, lookOf, sanitizeAudience, type AudienceView, type EffectTier } from '../../../shared/audience.ts';
import { supportFromChat } from '../../../shared/support.ts';
import type { ChatEvent, ChatPlatform } from '../../../shared/chat.ts';
import type { AudienceScene } from './audienceScene.ts';

const A = ['Pixel', 'Neon', 'Lunar', 'Turbo', 'Cosmic', 'Sleepy', 'Mega', 'Tiny', 'Retro', 'Spicy', 'Velvet', 'Frosty', 'Atomic', 'Glitch', 'Mossy', 'Solar', 'Captain', 'Lady', 'Sir', 'Doctor'];
const B = ['Otter', 'Ninja', 'Wizard', 'Pancake', 'Comet', 'Gremlin', 'Panda', 'Taco', 'Falcon', 'Noodle', 'Badger', 'Pilot', 'Muffin', 'Squid', 'Raccoon', 'Biscuit', 'Waffle', 'Yeti'];
const COLORS = ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff8a', '#c3a6ff', '#ffab76', '#6fffd6', '#ff9aa2', '#b8f35d', '#8fb8ff', '#ff5f5f', '#5fd3ff', '#e0a3ff', '#ffe08a'];
const PLATS: ChatPlatform[] = ['twitch', 'youtube', 'kick', 'twitch', 'youtube', 'rumble', 'tiktok'];
const LINES = ['this set is unreal', 'hi from Brazil!', 'LETS GOOO', 'first time here 👋', 'the lights 😮', 'W stream', 'good evening everyone', 'can we get a wave?', 'that desk is clean', 'hello chat', 'ok this is sick', 'GG', 'love this show', 'who else is watching from work'];

export interface DemoChatter { user: string; platform: ChatPlatform; color: string; tier: EffectTier | null; badges: string[] }

export class AudienceDemo {
  readonly base = Math.floor(Date.now() / 1000) * 1000;
  readonly chatters: DemoChatter[] = [];
  private settings = sanitizeAudience({ bubbles: true, ask: { paid: { on: true, minUsd: 5 }, cards: 2 }, max: 200, patron: { topTiers: ['gold'] }, manual: [] });
  private fed = new Set<string>();
  private script: { at: number; ev: ChatEvent }[] = [];
  private qAt: { ask: number; approve: number; paid: number; paidApprove: number; answer: number; next: number } = { ask: 1.0, approve: 2.0, paid: 2.5, paidApprove: 3.2, answer: 8.0, next: 16 };
  private applauseAt = 13.5;

  constructor(private scene: AudienceScene, n: number, private feed: { push(list: unknown[], tot?: unknown, snap?: boolean): void } | null) {
    const tiers: (EffectTier | null)[] = ['patron_top', 'patron_plus', 'patron', 'member', 'tipper', 'vip'];
    for (let i = 0; i < n; i++) {
      const user = `${A[i % A.length]}${B[(i * 7) % B.length]}${i >= A.length * 2 ? i : ''}`;
      this.chatters.push({ user, platform: PLATS[i % PLATS.length], color: COLORS[(i * 5) % COLORS.length], tier: i < 18 ? tiers[i % tiers.length] : i % 5 === 0 ? 'member' : null, badges: i % 5 === 0 ? ['subscriber'] : [] });
    }
    // the script (seconds after base)
    const say = (at: number, i: number, text: string, extra: Partial<ChatEvent> = {}) => {
      const c = this.chatters[i % n];
      this.script.push({ at, ev: { id: `demo:${at}:${i}`, kind: 'chat', platform: c.platform, user: c.user, text, ts: this.base + at * 1000, color: c.color, ...(c.badges.length ? { badges: c.badges } : {}), test: true, ...extra } });
    };
    for (let k = 0; k < 40; k++) say(0.3 + k * 0.45, (k * 13 + 3) % n, LINES[k % LINES.length]);
    say(1.2, 4, 'KEKW', { parts: [{ t: 'emote', n: 'KEKW', u: '/favicon.ico' }] });
    say(5.0, 9, 'LMAO 😂 that was so good');
    say(5.4, 10, 'lol');
    this.script.push({ at: 4.0, ev: this.tip(7, 10, 'Love this show!') });
    this.script.push({ at: 10.0, ev: this.tip(2, 150, 'For the whole crew!') });
    this.script.sort((a, b) => a.at - b.at);
  }

  private tip(i: number, usd: number, text: string): ChatEvent {
    const c = this.chatters[i % this.chatters.length];
    return { id: `demo:tip:${i}:${usd}`, kind: 'finance', platform: c.platform, user: c.user, text, ts: 0, fkind: 'superchat', amount: usd, currency: 'usd', usd, display: `$${usd}.00`, tier: '#ffca28', test: true };
  }

  /** The view at `s` seconds into the script (the real roster + queue, replayed from the start: deterministic). */
  viewAt(s: number): AudienceView {
    const S = () => this.settings;
    const book = new SupporterBook(S);
    const roster = new AudienceRoster(S);
    const queue = new AskQueue(S, 'dq');
    const t0 = this.base;
    // everyone was in chat in the last minutes (seated before the script starts)
    this.chatters.forEach((c, i) => { book.onChat({ platform: c.platform, user: c.user, badges: c.badges }); roster.touch({ platform: c.platform, user: c.user, color: c.color, badges: c.badges }, t0 - 60_000 + i * 100, c.tier); });
    const tiers: Record<string, EffectTier> = {};
    for (const c of this.chatters) if (c.tier) tiers[chatKey(c.platform, c.user)] = c.tier;
    const asker = this.chatters[5], payer = this.chatters[11];
    let askId = '', paidId = '';
    if (s >= this.qAt.ask) { const r = queue.ask({ platform: asker.platform, user: asker.user, color: asker.color }, 'What got you into streaming in the first place?', asker.tier, t0 + this.qAt.ask * 1000); if (r.ok) askId = r.q.id; }
    if (s >= this.qAt.approve && askId) queue.approve(askId, t0 + this.qAt.approve * 1000);
    if (s >= this.qAt.paid) {
      const ev = supportFromChat({ id: 'demo:paid', kind: 'finance', platform: payer.platform, user: payer.user, text: 'Q: What is the best advice you ever got?', ts: t0 + this.qAt.paid * 1000, fkind: 'superchat', amount: 10, currency: 'usd', usd: 10 });
      const r = ev ? queue.support(ev, t0 + this.qAt.paid * 1000) : null;
      if (r?.kind === 'paid') paidId = r.q.id;
    }
    if (s >= this.qAt.paidApprove && paidId) queue.approve(paidId, t0 + this.qAt.paidApprove * 1000);
    if (s >= this.qAt.answer && askId) queue.answer(askId, t0 + this.qAt.answer * 1000);
    if (s >= this.qAt.next) queue.next(t0 + this.qAt.next * 1000);
    return {
      rev: Math.round(s * 10), at: t0 + s * 1000, on: true,
      members: roster.list().map((m) => ({ k: m.k, n: m.name, p: m.platform, ...(m.color ? { c: m.color } : {}), s: m.slot, j: m.joinedAt, ...(m.tier ? { t: m.tier } : {}) })),
      questions: queue.onStage(2, t0 + s * 1000), applause: s >= this.applauseAt ? { seq: 1, at: t0 + this.applauseAt * 1000 } : { seq: 0, at: 0 },
      tiers, pending: queue.counts().pending, removed: [], look: lookOf(this.settings),
    };
  }

  /** Jump to `s` seconds: the page's audience clock, the view, the chat lines so far (into the chat feed too). */
  at(s: number) {
    this.scene.manual = true;
    this.scene.clock = this.base + s * 1000;
    this.scene.setView(this.viewAt(s));
    const fresh: ChatEvent[] = [];
    for (const x of this.script) if (x.at <= s && !this.fed.has(x.ev.id)) { this.fed.add(x.ev.id); fresh.push({ ...x.ev, ts: this.base + x.at * 1000 }); }
    if (fresh.length) { if (this.feed) this.feed.push(fresh); else this.scene.onChat(fresh, false); }
    return this.scene.info();
  }
  /** Start the script in real time from now (live preview of the demo). */
  play() { const run = ++this.run; const t0 = performance.now(); const tick = () => { if (run !== this.run) return; const s = (performance.now() - t0) / 1000; this.at(s); if (s < 20) setTimeout(tick, 100); }; tick(); }
  stop() { this.run++; }
  private run = 0;
}
