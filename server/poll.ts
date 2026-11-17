// Chat polls: the live poll, templates, history and the HTTP / Stream Deck control (tally: shared/poll.ts).
//
//   GET    /api/poll/state                 → { poll: PollView | null, templates, presets, history, canSend }
//   POST   /api/poll/start  { template } | { question, options, durationSec, subDouble, donationVotes, usdPerVote, announce }
//   POST   /api/poll/end                   → ends the running poll now (winner reveal)
//   POST   /api/poll/hide   { shown? }     → hide / show the card on stream (no body = toggle); /api/poll/show = show
//   POST   /api/poll/clear                 → take an ended poll off stream
//   PUT    /api/poll/templates  { name, …poll }  · DELETE /api/poll/templates/:name
//   POST   /api/poll/test-vote { user, text, platform?, badges? }  a LOCAL test chat line (never sent anywhere)
// Everything is localhost-only (Streamer.bot / Touch Portal / Stream Deck run on this PC). Votes come from the chat hub
// (server/chat/hub.ts calls pollOnChat / pollOnFinance) for every connected platform at once; a vote never reaches the
// chat display — the pages show the poll's "+N votes" pulse instead. Results: cache/polls.json (last 50); templates:
// config/polls.json.
import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import type { ChatEvent } from '../shared/chat.ts';
import { POLL_PRESETS, PollTally, sanitizePoll, sanitizeTemplate, type PollDef, type PollResult, type PollTemplate } from '../shared/poll.ts';
import { broadcast } from './bus.ts';
import { HttpError, writeFileSoon } from './library.ts';
import { CACHE_DIR, CONFIG_DIR } from './paths.ts';
import { requireLocal, requireLocalOrStreamPc } from './routes/util.ts';

const TPL_FILE = path.join(CONFIG_DIR, 'polls.json');
const HIST_FILE = path.join(CACHE_DIR, 'polls.json');

let poll: PollTally | null = null;
let templates: PollTemplate[] | null = null;
let history: PollResult[] | null = null;
let pushT: NodeJS.Timeout | null = null;
let tickT: NodeJS.Timeout | null = null;
/** Hooks the chat side fills in (kept loose so this module never imports the hub: no import cycle). */
export const pollHooks = {
  /** Post a line to every chat that can send; returns how many did. Connectors today are read-only → 0 (skipped). */
  sendChat: (_text: string): number => 0,
  canSend: (): boolean => false,
  /** Speak on the OBS page with the Chat Hub's Windows voice. */
  say: (_text: string): Promise<unknown> => Promise.resolve(),
};

const readJson = <T>(f: string, d: T): T => { try { return JSON.parse(fs.readFileSync(f, 'utf8')) as T; } catch { return d; } };
// off the event loop (temp file + rename, coalesced: server/library.ts writeFileSoon); the poll data itself is in memory
const writeJson = (f: string, v: unknown) => {
  try { writeFileSoon(f, JSON.stringify(v, null, 1)); } catch (e) { console.warn('[poll] save', e); }
};
function getTemplates(): PollTemplate[] {
  if (!templates) { const r = readJson<unknown[]>(TPL_FILE, []); templates = (Array.isArray(r) ? r : []).map(sanitizeTemplate).filter((t): t is PollTemplate => typeof t !== 'string').slice(0, 40); }
  return templates;
}
function getHistory(): PollResult[] {
  if (!history) { const r = readJson<PollResult[]>(HIST_FILE, []); history = Array.isArray(r) ? r.slice(-50) : []; }
  return history;
}

// ---------------------------------------------------------------- pushes
function push(now = false) {
  if (now) { if (pushT) { clearTimeout(pushT); pushT = null; } broadcast({ type: 'poll', s: poll?.view(true) ?? null }); return; }
  if (pushT) return;
  pushT = setTimeout(() => { pushT = null; broadcast({ type: 'poll', s: poll?.view(true) ?? null }); }, 250);   // ≤ 4 pushes / s however busy chat is
}
function finish() {
  if (!poll) return;
  if (tickT) { clearInterval(tickT); tickT = null; }
  const r = poll.result();
  const h = getHistory(); h.push(r); if (h.length > 50) h.splice(0, h.length - 50); writeJson(HIST_FILE, h);
  push(true);
  const line = r.total ? `Poll: "${r.question}" — winner: ${r.winner} (${r.total} vote${r.total === 1 ? '' : 's'})` : `Poll: "${r.question}" ended with no votes`;
  try { const n = pollHooks.sendChat(line); if (n) console.log(`[poll] result posted to ${n} chat(s)`); } catch (e) { console.warn('[poll] send', e); }
  if (poll.def.announce) void pollHooks.say(r.total ? `The winner is ${r.winner.replace(' (tie)', ', a tie')}!` : 'The poll ended with no votes.').catch(() => {});
}

// ---------------------------------------------------------------- control
export function startPoll(def: PollDef): PollTally {
  if (poll?.live) { poll.end(); finish(); }
  poll = new PollTally(def);
  if (tickT) clearInterval(tickT);
  tickT = setInterval(() => { if (poll?.tick()) finish(); }, 250);
  push(true);
  if (def.announce) void pollHooks.say(`Poll! ${def.question} Vote in chat: ${def.options.map((o, i) => `${i + 1}, ${o.label}`).join('. ')}.`).catch(() => {});
  return poll;
}
export function endPoll(): boolean { if (!poll?.live) return false; poll.end(); finish(); return true; }
export function showPoll(shown: boolean | 'toggle'): boolean {
  if (!poll) return false;
  poll.shown = shown === 'toggle' ? !poll.shown : shown;
  push(true);
  return poll.shown;
}
export function clearPoll() { if (poll?.live) endPoll(); poll = null; push(true); }
/** Start by template name ('' = the last saved template, else the Yes / No preset). */
export function startByName(name: string): PollTally {
  const all = [...getTemplates(), ...POLL_PRESETS];
  const k = name.trim().toLowerCase();
  const t = k ? all.find((x) => x.name.toLowerCase() === k) : getTemplates()[getTemplates().length - 1] ?? POLL_PRESETS[0];
  if (!t) throw new HttpError(404, `No saved poll called "${name}"`);
  return startPoll(t);
}
/** Stream Deck (shared/deck.ts kind 'poll'). */
export function pollDeck(action: string, template = ''): unknown {
  switch (action) {
    case 'start': return startByName(template).view();
    case 'end': return endPoll();
    case 'show': return showPoll(true);
    case 'hide': return showPoll(false);
    default: return showPoll('toggle');
  }
}

// ---------------------------------------------------------------- chat side (server/chat/hub.ts)
/** A chat line: true = it was a poll vote (keep it off the chat display). */
export function pollOnChat(e: Pick<ChatEvent, 'platform' | 'user' | 'text' | 'badges' | 'kind'>): boolean {
  if (!poll || e.kind !== 'chat') return false;
  const o = poll.vote(e.platform, e.user, e.text, { badges: e.badges });
  if (o === 'none') return false;
  if (o === 'counted' || o === 'changed') push();
  return o !== 'closed';            // after the end, "1" is just chat again
}
/** A support event: tips naming an option add donation votes (the event itself still shows as usual). */
export function pollOnFinance(e: Pick<ChatEvent, 'text' | 'usd' | 'test'>) {
  if (!poll?.live) return;
  if (poll.donate(e.text, Number(e.usd) || 0) !== null) push();
}

export const pollView = () => poll?.view() ?? null;

// ---------------------------------------------------------------- routes
export const pollRoutes = Router();
const body = (req: { body?: unknown }) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
const state = () => ({ poll: pollView(), templates: getTemplates(), presets: POLL_PRESETS, history: getHistory().slice(-20).reverse(), canSend: pollHooks.canSend() });

pollRoutes.get('/api/poll/state', (req, res) => { requireLocalOrStreamPc(req); res.json(state()); }); // (+ an output page on a paired stream PC: server/streamPc.ts)
pollRoutes.post('/api/poll/start', (req, res) => {
  requireLocal(req);
  const b = body(req);
  if (typeof b.template === 'string' && !b.question) { startByName(b.template); res.json(state()); return; }
  const def = sanitizePoll(b);
  if (typeof def === 'string') throw new HttpError(400, def);
  startPoll(def);
  res.json(state());
});
pollRoutes.post('/api/poll/end', (req, res) => { requireLocal(req); res.json({ ok: endPoll(), poll: pollView() }); });
pollRoutes.post('/api/poll/hide', (req, res) => { requireLocal(req); const s = body(req).shown; res.json({ ok: !!poll, shown: showPoll(typeof s === 'boolean' ? s : 'toggle') }); });
pollRoutes.post('/api/poll/show', (req, res) => { requireLocal(req); res.json({ ok: !!poll, shown: showPoll(true) }); });
pollRoutes.post('/api/poll/clear', (req, res) => { requireLocal(req); clearPoll(); res.json({ ok: true }); });
pollRoutes.put('/api/poll/templates', (req, res) => {
  requireLocal(req);
  const t = sanitizeTemplate(body(req));
  if (typeof t === 'string') throw new HttpError(400, t);
  const all = getTemplates().filter((x) => x.name.toLowerCase() !== t.name.toLowerCase());
  all.push(t); templates = all.slice(-40); writeJson(TPL_FILE, templates);
  res.json(state());
});
pollRoutes.delete('/api/poll/templates/:name', (req, res) => {
  requireLocal(req);
  const n = String(req.params.name).toLowerCase();
  templates = getTemplates().filter((x) => x.name.toLowerCase() !== n); writeJson(TPL_FILE, templates);
  res.json(state());
});
/** Local test vote (Chat Hub "fake votes" / tools): goes through the normal chat hub path, marked test. */
export const testVoteHook = { send: (_c: { platform: string; user: string; text: string; badges: string[] }) => {} };
pollRoutes.post('/api/poll/test-vote', (req, res) => {
  requireLocal(req);
  const b = body(req);
  const plats = ['twitch', 'youtube', 'kick', 'rumble', 'tiktok'];
  const platform = plats.includes(String(b.platform)) ? String(b.platform) : plats[Math.floor(Math.random() * plats.length)];
  const user = String(b.user ?? `tester${Math.floor(Math.random() * 9999)}`).slice(0, 40);
  testVoteHook.send({ platform, user, text: String(b.text ?? '1').slice(0, 80), badges: Array.isArray(b.badges) ? b.badges.map(String).slice(0, 4) : [] });
  res.json({ ok: true, poll: pollView() });
});
