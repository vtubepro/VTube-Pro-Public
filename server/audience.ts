// The chat audience on the helper (shared/audience.ts = the pure core; docs/SCENES.md "Chat audience"):
//   * the ROSTER: every active chatter gets a stable seat slot (pages seat slot i in the room's seat i);
//   * the QUESTION QUEUE: !ask (configurable) and paid messages → pending → a moderator approves / skips / pins /
//     answers now (the studio's Scene tab "Chat audience" panel and the Chat Hub's ❓ drawer); nothing reaches the
//     stream before a moderator approves it;
//   * SUPPORTER tiers for name effects (Patreon & other members, subs, tippers, VIPs): SupporterBook until the support
//     lane's shared/supporters.ts lookup is plugged in with setSupporterLookup().
// Broadcasts `{ type: 'audience', s: AudienceView }` on change (≤ 3 / s). RAM only: no chatter data is ever written to
// disk (the settings are: config/audience.json).
//
//   GET  /api/audience/view                          → AudienceView (pages; this PC + a paired stream PC)
//   GET  /api/audience/state                         → { settings, view, queue, counts, chatters } (this PC)
//   PUT  /api/audience/settings  {…AudienceSettings}  → state
//   POST /api/audience/q/:id/:action                 approve | skip | pin | unpin | answer | allow | delete | confirm-bump | drop-bump
//   POST /api/audience/next · /api/audience/done · /api/audience/applause · /api/audience/clear
//   POST /api/audience/test { what: 'crowd'|'chat'|'ask'|'paid'|'tip'|'laugh', n? }  LOCAL test chatters (never sent anywhere)
// Stream Deck: shared/deck.ts kind 'audience' (applause / next / done) → audienceDeck().
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { ChatEvent, ChatPlatform } from '../shared/chat.ts';
import { supportFromChat, type SupportEvent } from '../shared/support.ts';
import {
  AskQueue, AudienceRoster, DEFAULT_AUDIENCE, SupporterBook, isAskCommand, newObsWatch, obsGapApplies, obsWatchStep, lookOf, parseAsk, patronTier, personKey, sanitizeAudience, supportIdentity,
  type AudienceSettings, type AudienceView, type SupporterLookup, type EffectTier, type Identity,
} from '../shared/audience.ts';
import { broadcast } from './bus.ts';
import { HttpError, writeFileSoon } from './library.ts';
import { CONFIG_DIR } from './paths.ts';
import { requireLocal, requireLocalOrStreamPc } from './routes/util.ts';
import { streamPcOf } from './streamPcMark.ts';
import { addAnyChatCommand, addChatRemoval, addChatTap, type ChatLine } from './chatCommands.ts';
import { chatHub, chatListeners } from './chat/hub.ts';
import { supporterOf as linkedSupporterOf } from './support/supporters.ts';

const FILE = path.join(CONFIG_DIR, 'audience.json');

let settings: AudienceSettings = (() => { try { return sanitizeAudience(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { return sanitizeAudience({}); } })();
const S = () => settings;
const book = new SupporterBook(S);
let lookup: SupporterLookup = book;
const roster = new AudienceRoster(S);
const queue = new AskQueue(S, `q${Date.now().toString(36)}-`);
// an asker whose question is on screen keeps their seat (their card sits above it), until its card has faded out after
// Done (cached per queue change and per second: the roster asks this for every member)
let stageRev = -1, stageAt = 0, stageKeys = new Set<string>();
roster.protect = (k) => {
  const now = Date.now();
  if (queue.rev !== stageRev || now - stageAt > 1000) { stageRev = queue.rev; stageAt = now; stageKeys = queue.stageKeys(settings.ask.cards, now); }
  return stageKeys.has(k);
};
// the seats the room on stream really has: each OBS page reports its room's count (POST /api/audience/seats); the
// biggest report of the last 75 s counts (0 = none: then settings.max)
const seatReports = new Map<string, { n: number; at: number }>();
roster.seatCap = () => {
  const now = Date.now();
  let n = 0;
  for (const [id, r] of seatReports) { if (now - r.at > 75_000) seatReports.delete(id); else n = Math.max(n, r.n); }
  return n;
};
let applause = { seq: 0, at: 0 };
/** The support lane delivers SupportEvents (audienceOnSupport): from then on the chat 'finance' lines are not read
 *  a second time. */
let nativeSupport = false;
let rev = 0;
let pushT: NodeJS.Timeout | null = null;
let lastSig = '';
/** A push when the oldest answered question's linger ends (the pages take its card down). */
let lingerT: NodeJS.Timeout | null = null;
/** Chat messages deleted lately (pages take their bubbles down): [id, at]. */
export const audienceTest = { roster: () => roster, queue: () => queue, book: () => book };
const removed: [string, number][] = [];

/** Plug in another supporter lookup (the support lane's shared/supporters.ts supporterOf). SupporterBook still feeds
 *  badges + session tips; the plugged lookup wins where it knows the chatter. */
export function setSupporterLookup(l: SupporterLookup | null) {
  lookup = l ? { supporterOf: (id) => better(l.supporterOf(id), book.supporterOf(id)) } : book;
  for (const m of roster.members.values()) roster.setTier(m.k, tierOf(m.platform, m.u, m.uid));
  push();
}
const better = (a: ReturnType<SupporterLookup['supporterOf']>, b: ReturnType<SupporterLookup['supporterOf']>) => (!a ? b : !b ? a : (a.tier && !b.tier) || (a.tier && b.tier && rank(a.tier) >= rank(b.tier)) ? a : b);
const rank = (t: EffectTier) => ['mod', 'vip', 'tipper', 'member', 'patron', 'patron_plus', 'patron_top'].indexOf(t);
const tierOf = (platform: ChatPlatform, user: string, uid?: string) => lookup.supporterOf({ platform, user, ...(uid ? { userId: uid } : {}) })?.tier ?? null;

// ---------------------------------------------------------------- the view + pushes
export function audienceView(): AudienceView {
  const s = settings;
  return {
    rev, at: Date.now(), on: s.on,
    members: roster.list().map((m) => ({ k: m.k, n: m.name, p: m.platform, ...(m.color ? { c: m.color } : {}), s: m.slot, j: m.joinedAt, ...(m.tier ? { t: m.tier } : {}) })),
    questions: queue.onStage(s.ask.cards, Date.now()),
    applause, tiers: book.tiers(500), pending: queue.counts().pending, look: lookOf(s),
    removed: removed.filter(([, at]) => Date.now() - at < 120_000).map(([id]) => id).slice(-60),
  };
}
/** Askers whose question is on screen sit in the audience (their card needs a head): someone who lost their seat while
 *  their question waited (a newcomer took it, the roster was full) is seated again when it goes on screen, or benched
 *  and moved up by prune. Only when their own key can be rebuilt (chat askers; a paid one from a support service may
 *  not have one). */
function seatStageAskers(now: number) {
  const cap = roster.cap(settings.max);
  let benched = false;
  for (const v of queue.onStage(settings.ask.cards, now)) {
    if (v.status === 'answered') continue;
    const m = roster.members.get(v.k);
    if (m) { if (m.slot >= cap) benched = true; continue; }
    const q = queue.get(v.id);
    if (!q?.rawName || personKey(q.platform, q.rawName, q.uid) !== q.k || hosts.has(q.k)) continue;
    // (their badges replay the seat rules: the broadcaster asking never sits in the audience; a test asker stays a test)
    roster.touch({ platform: q.platform, user: q.rawName, ...(q.uid ? { uid: q.uid } : {}), ...(q.color ? { color: q.color } : {}), ...(q.badges ? { badges: q.badges } : {}), ...(q.test ? { test: true } : {}) }, now, tierOf(q.platform, q.rawName, q.uid), true);
    if ((roster.members.get(v.k)?.slot ?? -1) >= cap) benched = true;
  }
  // an on-screen asker on the bench takes a seat now (prune seats protected askers first), not at the next 10 s tick
  if (benched) roster.prune(now);
}
function push(now = false) {
  const send = () => {
    pushT = null;
    if (settings.on) seatStageAskers(Date.now());
    const v = audienceView();
    const sig = JSON.stringify({ ...v, rev: 0, at: 0 });
    if (sig === lastSig) return;
    lastSig = sig; v.rev = ++rev;
    broadcast({ type: 'audience', s: v });
    if (lingerT) { clearTimeout(lingerT); lingerT = null; }
    const ends = v.questions.filter((q) => q.status === 'answered').map((q) => q.since + AskQueue.LINGER_MS);
    if (ends.length) lingerT = setTimeout(() => push(true), Math.max(50, Math.min(...ends) - Date.now() + 50));
  };
  if (now) { if (pushT) clearTimeout(pushT); send(); return; }
  if (!pushT) pushT = setTimeout(send, 330);
}
setInterval(() => { const r = roster.rev; roster.prune(Date.now()); if (roster.rev !== r) push(); }, 10_000).unref?.();
// keep 'stream': OBS going live after a break of 30 min or more (stopped, or closed) starts a new audience (people from
// an earlier stream leave); a quick restart or an OBS crash mid-show keeps everyone. Read-only; only when OBS is set up
// in VTube Pro — otherwise SESSION_GAP_MS in prune does it.
const obsWatch = newObsWatch(Date.now());
// the 6-hour fallback only once OBS has been off (or can't tell us: not set up) for half an hour: never mid-show
roster.gapApplies = (now) => obsGapApplies(obsWatch, now);
setInterval(() => {
  void import('./obs.ts').then(async ({ obs }) => {
    const enabled = !!obs.cfg.enabled;
    const r = enabled ? await obs.outputLive() : null, now = Date.now();
    if (obsWatchStep(obsWatch, enabled, r, now) && settings.keep !== 'minutes' && roster.newStream(now).length) push(true);
  }).catch(() => {});
}, 60_000).unref?.();

/** Who chat showed with the broadcaster badge (their own channel): never seated, not even for a paid question or a tip,
 *  which carry no badges. */
const hosts = new Set<string>();
function noteHost(e: { platform: ChatLine['platform']; user: string; uid?: string; badges?: readonly string[] }) {
  if (!e.user || !e.badges?.includes('broadcaster')) return;
  const k = personKey(e.platform, e.user, e.uid);
  hosts.delete(k); hosts.add(k);
  if (hosts.size > 16) hosts.delete(hosts.values().next().value!);
  // (seated before chat showed who they are: a tip / cheer from the service raced ahead of their chat line)
  if (roster.members.has(k)) { roster.remove(k); push(); }
}

// ---------------------------------------------------------------- chat side
function seen(e: Pick<ChatLine, 'platform' | 'user' | 'uid' | 'color' | 'badges' | 'vip' | 'test'>) {
  book.onChat(e);
  noteHost(e);
  roster.touch({ platform: e.platform, user: e.user, uid: e.uid, color: e.color, badges: e.badges, ...(e.test ? { test: true } : {}) }, Date.now(), tierOf(e.platform, e.user, e.uid));
  if (roster.rev !== lastRosterRev) { lastRosterRev = roster.rev; push(); }
}
let lastRosterRev = 0;
addChatTap((e) => seen(e));
// !ask (renamable; its other names too, !axe by default): a QUEUED question is consumed (it waits for a moderator: the
// raw line never reaches the stream); a line the queue turned down (off, not allowed, cooldown, empty) stays an ordinary
// chat line for the other features
addAnyChatCommand((e, name) => {
  if (!settings.ask.on || !isAskCommand(settings.ask, name)) return false;
  const text = parseAsk(e.text, name);
  if (text === null) return false;
  noteHost(e);
  const r = queue.ask({ platform: e.platform, user: e.user, uid: e.uid, id: e.id, color: e.color, badges: e.badges, test: e.test }, text, tierOf(e.platform, e.user, e.uid), Date.now());
  if (!r.ok) return false;
  console.log(`[audience] question ${r.replaced ? 'updated' : 'queued'} from ${e.user}`);
  push();
  return true;
});
addChatRemoval((r) => {
  const now = Date.now();
  if (r.kind === 'delete') {
    removed.push([r.target, now]); if (removed.length > 200) removed.splice(0, removed.length - 200);
    queue.deleted(r.target, now, r.platform);
    push(true);
    return;
  }
  // a ban / timeout: by the platform user id when the connector sent one (only that account, never every "Alex"),
  // else by login / name; seated or not (people who left the seats, the audience switched off) — the queue is checked too
  const t = r.target.toLowerCase();
  for (const m of [...roster.members.values()]) {
    if (m.platform !== r.platform) continue;
    if (r.target === '*' || (r.uid ? m.uid === r.uid : m.u === t || m.uid === r.target)) roster.remove(m.k);
  }
  queue.purge({ platform: r.platform, target: r.target, ...(r.uid ? { uid: r.uid } : {}) }, now);
  push(true);
});
chatListeners.add((e: ChatEvent) => {
  if (e.kind !== 'finance') return;
  noteHost(e);   // (before anything seats them: a cheer / Super Chat line carries the broadcaster badge, its support event doesn't)
  if (nativeSupport || e.cue) return;
  const ev = supportFromChat(e);
  // the chat line knows the supporter's platform user id (supportFromChat only has the name): use it
  if (ev) onSupport(ev, e.user ? { platform: e.platform, user: e.user, ...(e.uid ? { uid: e.uid } : {}) } : null);
});

function onSupport(ev: SupportEvent, who?: Identity | null) {
  const now = Date.now();
  const id = who === undefined ? supportIdentity(ev) : who;
  const k = book.onSupport(ev, now, id);
  if (k && id) {
    const plat = id.platform, user = id.user, uid = id.uid;
    {
      if (!hosts.has(k)) roster.touch({ platform: plat, user, uid }, now, tierOf(plat, user, uid));   // supporting = taking part: they get a seat
      roster.setTier(k, tierOf(plat, user, uid));
    }
  }
  const q = queue.support(ev, now, id);
  if (q) console.log(`[audience] ${q.kind === 'paid' ? 'paid question' : q.kind === 'bump' ? 'question bumped' : 'possible tip match (moderator confirms)'} from ${q.q.name}`);
  push();
}
/** The support lane's accepted SupportEvents (server/support/*): call for every event. */
export function audienceOnSupport(ev: SupportEvent) { nativeSupport = true; onSupport(ev); }

// ---------------------------------------------------------------- control
function act(id: string, action: string): boolean {
  const now = Date.now();
  switch (action) {
    case 'approve': return queue.approve(id, now);
    case 'skip': return queue.skip(id, now);
    case 'pin': return queue.pin(id, true, now);
    case 'unpin': return queue.pin(id, false, now);
    case 'answer': return queue.answer(id, now);
    case 'allow': return queue.allow(id);                 // "Show anyway" (the moderator saw the flagged text)
    case 'delete': return queue.remove(id);
    case 'confirm-bump': return queue.confirmBump(id, true);
    case 'drop-bump': return queue.confirmBump(id, false);
    default: throw new HttpError(400, 'Unknown action');
  }
}
export function audienceApplause() { applause = { seq: applause.seq + 1, at: Date.now() + 150 }; push(true); return applause; }
export function audienceNext() { const r = queue.next(Date.now()); push(true); return r; }
export function audienceDone() { const r = queue.done(Date.now()); push(true); return r; }
/** Stream Deck (shared/deck.ts kind 'audience'). */
export function audienceDeck(action: string): unknown {
  switch (action) {
    case 'applause': return audienceApplause();
    case 'next': return audienceNext();
    case 'done': return audienceDone();
    default: throw new HttpError(400, 'Unknown audience action');
  }
}

function state() {
  const view = audienceView(), o = queue.ordered();
  const fading = new Set(view.questions.filter((v) => v.status === 'answered').map((v) => v.id));
  const done = (q: { status: string; id: string }) => (q.status === 'answered' || q.status === 'skipped') && !fading.has(q.id);
  const open = o.filter((q) => !done(q)), fin = o.filter(done).sort((a, b) => b.since - a.since);
  return {
    settings, view,
    // every open question and every card still fading after Done (its row has Take down), then the newest finished ones
    queue: [...open, ...fin].slice(0, Math.max(80, open.length)).map((q) => ({ ...q })),
    counts: queue.counts(), chatters: roster.members.size, nativeSupport,
  };
}

// ---------------------------------------------------------------- local test chatters (Scene tab / tools; marked test)
const NAMES_A = ['Pixel', 'Neon', 'Lunar', 'Turbo', 'Cosmic', 'Sleepy', 'Mega', 'Tiny', 'Retro', 'Spicy', 'Velvet', 'Frosty', 'Atomic', 'Glitch', 'Mossy', 'Solar'];
const NAMES_B = ['Otter', 'Ninja', 'Wizard', 'Pancake', 'Comet', 'Gremlin', 'Panda', 'Taco', 'Falcon', 'Noodle', 'Badger', 'Pilot', 'Muffin', 'Squid', 'Raccoon', 'Biscuit'];
const COLORS = ['#ff7eb6', '#7ee0ff', '#ffd166', '#9bff8a', '#c3a6ff', '#ffab76', '#6fffd6', '#ff9aa2', '#b8f35d', '#8fb8ff'];
const PLATS: ChatPlatform[] = ['twitch', 'youtube', 'kick', 'rumble', 'tiktok'];
let testN = 0;
const testName = (i: number) => `${NAMES_A[i % 16]}${NAMES_B[Math.floor(i / 16) % 16]}${i >= 256 ? i : ''}`;
function testChat(i: number, text: string, badges: string[] = []) {
  chatHub.onChat({ platform: PLATS[i % 5] as never, username: testName(i), message: text, ts: Date.now(), badges, color: COLORS[i % COLORS.length], id: `test:aud:${Date.now()}:${++testN}` }, true);
}

// ---------------------------------------------------------------- routes
export const audienceRoutes = Router();
const body = (req: { body?: unknown }) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
audienceRoutes.get('/api/audience/view', (req, res) => { requireLocalOrStreamPc(req); res.json(audienceView()); });
audienceRoutes.get('/api/audience/state', (req, res) => { requireLocal(req); res.json(state()); });
/** An OBS page (this PC, or a paired stream PC): the room it shows has this many audience seats (or crowd places).
 *  Every 30 s while it has one. */
audienceRoutes.post('/api/audience/seats', (req, res) => {
  requireLocalOrStreamPc(req);
  const b = body(req);
  const n = Math.round(Number(b.n));
  const pc = streamPcOf(req);
  const id = `${pc ? `pc:${pc.id}:` : ''}${String(b.page ?? '').replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'page'}`;
  if (!(n >= 1 && n <= 200)) { res.status(400).json({ error: 'n: 1-200 seats' }); return; }
  const before = roster.seatCap();
  seatReports.set(id, { n, at: Date.now() });
  if (seatReports.size > 16) seatReports.delete(seatReports.keys().next().value as string);
  if (roster.seatCap() !== before) { const r = roster.rev; roster.prune(Date.now()); if (roster.rev !== r) push(true); }
  res.json({ ok: true, seats: roster.seatCap() });
});
/** Save new settings (a partial patch). Tiers are looked up again by the member's own identity (login + platform id). */
export function applyAudienceSettings(patch: unknown, save = true) {
  settings = sanitizeAudience(patch, settings);
  if (save) { try { writeFileSoon(FILE, JSON.stringify(settings, null, 1)); } catch (e) { console.warn('[audience] save', e); } }
  for (const m of roster.members.values()) roster.setTier(m.k, tierOf(m.platform, m.u, m.uid));
  roster.prune(Date.now());
  // the filter switches / lists apply to what is already on stream too: names + questions filtered again from what was typed
  roster.refilter();
  queue.refilter(Date.now());
  push(true);
  return settings;
}
audienceRoutes.put('/api/audience/settings', (req, res) => {
  requireLocal(req);
  applyAudienceSettings(body(req));
  res.json(state());
});
audienceRoutes.post('/api/audience/q/:id/:action', (req, res) => {
  requireLocal(req);
  const ok = act(String(req.params.id), String(req.params.action));
  push(true);
  res.json({ ok, ...state() });
});
audienceRoutes.post('/api/audience/next', (req, res) => { requireLocal(req); res.json({ ok: audienceNext(), ...state() }); });
audienceRoutes.post('/api/audience/done', (req, res) => { requireLocal(req); res.json({ ok: audienceDone(), ...state() }); });
audienceRoutes.post('/api/audience/applause', (req, res) => { requireLocal(req); res.json({ ok: true, applause: audienceApplause() }); });
audienceRoutes.post('/api/audience/clear', (req, res) => {
  requireLocal(req);
  const what = String(body(req).what ?? 'all');
  if (what === 'all' || what === 'audience') roster.clear();
  if (what === 'all' || what === 'questions') queue.clear();
  push(true);
  res.json(state());
});
audienceRoutes.post('/api/audience/test', (req, res) => {
  requireLocal(req);
  const b = body(req);
  const what = String(b.what ?? 'crowd');
  const n = Math.max(1, Math.min(200, Number(b.n) || 24));
  const base = Math.floor(Math.random() * 1000);
  const lines = ['hello from the back row!', 'this set looks amazing', 'LETS GOOO', 'first time here 👋', 'the lights 😮', 'W stream', 'good evening everyone', 'can we get a wave?'];
  switch (what) {
    case 'crowd': for (let i = 0; i < n; i++) testChat(base + i, lines[i % lines.length], i % 4 === 0 ? ['subscriber'] : []); break;
    case 'chat': testChat(base, lines[base % lines.length]); break;
    case 'laugh': testChat(base, 'KEKW that was so good'); break;
    case 'ask': {
      // (`command`: one of its other names, e.g. "axe"; anything else asks with the main command)
      const c = typeof b.command === 'string' && isAskCommand(settings.ask, b.command.toLowerCase()) ? b.command.toLowerCase() : settings.ask.command;
      testChat(base, `!${c} ${String(b.text ?? 'What got you into streaming?').slice(0, 300)}`); break;
    }
    case 'paid': chatHub.onFinance({ platform: 'youtube', username: testName(base), kind: 'superchat', amount: 10, currency: 'usd', usd: 10, message: String(b.text ?? 'Q: What is the best advice you ever got?').slice(0, 300), ts: Date.now(), id: `test:aud:sc:${Date.now()}:${++testN}` } as never, true); break;
    case 'tip': chatHub.onFinance({ platform: 'kick', username: testName(base), kind: 'tip', amount: 5, currency: 'usd', usd: 5, message: 'Test tip!', ts: Date.now(), id: `test:aud:tip:${Date.now()}:${++testN}` } as never, true); break;
    default: throw new HttpError(400, 'Unknown test');
  }
  res.json(state());
});

export const audienceDefaults = DEFAULT_AUDIENCE;

// ---------------------------------------------------------------- beta.13 integration: linked supporters
// The support lane's linked supporters (Patreon / Fourthwall / Ko-fi / Buy Me a Coffee members tied to a chatter by
// !link, the service's own social link or by hand: server/support/supporters.ts) style chatter names here too. Support
// money and messages already arrive as the support lane's mirrored chat 'finance' lines (ChatEvent.support), which this
// file reads like any platform's, so they are NOT also taken from the {type:'support'} bus (that would count them twice).
setSupporterLookup({
  supporterOf: (id) => {
    const info = linkedSupporterOf({ platform: id.platform, ...(id.userId ? { userId: id.userId } : {}), login: id.user });
    if (!info) return null;
    const cents = typeof info.cents === 'number' && Number.isFinite(info.cents) ? info.cents : 0;
    const tier = patronTier({ tierName: info.tier, ...(cents ? { amount: { minor: cents, currency: 'USD' } } : {}) }, settings);
    return { tier, source: info.source, since: Date.parse(info.since) || 0, tierName: info.tier, ...(cents ? { monthlyUsd: cents / 100 } : {}), tippedUsd: 0, lastTipAt: 0 };
  },
});
