// Goals, stretch goals, incentives + the subathon timer in the HELPER (beta.13): the engine (server/goalsEngine.ts) wired
// to the chat hub (every platform's finance lines, follows, raids, mod commands), the support lane's {type:'support'}
// bus messages (deduped against the chat lines), the Stream Deck, OBS (a new stream) and these routes. Every page draws
// the engine's view ({type:'goals', s} on the bus; GET /api/goals/view for pages that load later).
//
//   GET  /api/goals/view                         the view (this PC's pages + a paired stream PC's output page)
//   GET  /api/goals/state                        the studio panel: config, view, audit logs, history, presets
//   PUT  /api/goals/config  {currency?, show?, mods?, celebrate?, wheel?, incentives?, streamGapH?}
//   POST /api/goals/goal    {…GoalDef}            create / update   · DELETE /api/goals/goal/:id
//   POST /api/goals/template {id}                 a goal from a template (3 clicks: open, pick, done)
//   POST /api/goals/goal/:id/reset · /goal/:id/adjust {delta, note} · /order {ids} · /new-stream
//   POST /api/goals/entry/:seq/void {void}        undo / redo a mis-counted event (or a manual adjustment)
//   POST /api/goals/sub/start {template?|config?} · /sub/config {config} · /sub/stop · /sub/pause {on?} · /sub/add {ms|text, note}
//        /sub/undo {n?|seq?} · /sub/redo {seq} · /sub/happy {mult, ms} · /sub/sleep {on?} · /sub/reopen {ms}
//   POST /api/goals/wheel/spin · /test {on} · /test/event {what} · /incentive/:id/try
// Everything that writes is localhost-only. Nothing here talks to a platform or plays a sound (sounds are {type:'showsound'}
// bus messages the studio plays).
import fs from 'node:fs';
import path from 'node:path';
import { Router, type Request } from 'express';
import type { ChatEvent } from '../shared/chat.ts';
import { parseDuration } from '../shared/goals.ts';
import { subathonTemplate } from '../shared/subathon.ts';
import { broadcast, broadcastTaps } from './bus.ts';
import { CHAT_CACHE, chatListeners } from './chat/hub.ts';
import { HttpError } from './library.ts';
import { CACHE_DIR, CONFIG_DIR } from './paths.ts';
import { requireLocal, requireLocalOrStreamPc } from './routes/util.ts';
import { GoalsEngine, type GoalsConfig, type LegacyGoal } from './goalsEngine.ts';

/** Filled in by server/deck.ts (no import cycle): run any Stream Deck action (room cue, lighting state, club moment …). */
export const goalsHooks = {
  runDeck: (_action: string, _params: Record<string, unknown>): { ok: boolean; error?: string } => ({ ok: false, error: 'the Stream Deck registry is not ready' }),
};

const SCENE_FILE = path.join(CACHE_DIR, 'scene.json');
const TOTALS_FILE = path.join(CHAT_CACHE, 'totals.json');
const readJson = (f: string): unknown => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };

/** The old single chat goal (Chat & events → Goal, kept in the scene state) + when the session totals started. */
function legacyGoal(): LegacyGoal | null {
  const sc = readJson(SCENE_FILE) as { chat?: { goal?: { on?: unknown; target?: unknown; label?: unknown } } } | null;
  const g = sc?.chat?.goal;
  if (!g) return null;
  const t = readJson(TOTALS_FILE) as { since?: unknown } | null;
  return { on: g.on === true, target: typeof g.target === 'number' && g.target > 0 ? g.target : 100, label: typeof g.label === 'string' ? g.label.slice(0, 40) : 'Stream goal', since: Number(t?.since) || Date.now() };
}
/** Support lines of this session from the chat log (cache/chat/events-YYYY-MM-DD.jsonl), at most a week back. */
function chatSince(since: number): ChatEvent[] {
  const out: ChatEvent[] = [];
  const from = Math.max(since, Date.now() - 7 * 86_400_000);
  for (let d = new Date(new Date(from).toISOString().slice(0, 10)).getTime(); d <= Date.now() + 86_400_000; d += 86_400_000) {
    const f = path.join(CHAT_CACHE, `events-${new Date(d).toISOString().slice(0, 10)}.jsonl`);
    let text = '';
    try { text = fs.readFileSync(f, 'utf8'); } catch { continue; }
    for (const l of text.split('\n')) { if (!l.includes('"finance"')) continue; try { const e = JSON.parse(l) as ChatEvent; if (e.kind === 'finance' && e.ts >= since) out.push(e); } catch { /* */ } }
  }
  return out;
}

let eng: GoalsEngine | null = null;
let obsWas: boolean | null = null;
let sceneMtime = -1;
export function goals(): GoalsEngine {
  if (eng) return eng;
  eng = new GoalsEngine({
    configFile: path.join(CONFIG_DIR, 'goals.json'), dir: path.join(CACHE_DIR, 'goals'),
    broadcast: (m) => broadcast(m as unknown as Parameters<typeof broadcast>[0]),
    runDeck: (a, p) => goalsHooks.runDeck(a, p),
    legacy: legacyGoal, chatSince,
  });
  const e = eng;
  setInterval(() => e.tick(), 1000).unref();
  // the old Goal settings (Chat & events) stay in step with goal #1; one stat a few seconds
  setInterval(() => {
    try { const m = fs.statSync(SCENE_FILE).mtimeMs; if (m === sceneMtime) return; sceneMtime = m; e.syncLegacy(legacyGoal()); } catch { /* no scene yet */ }
  }, 3000).unref();
  // pages that missed a push catch up; the clock offset stays fresh
  setInterval(() => { const v = e.view(); if (v.goals.length || v.sub || v.wheel.spin) e.push(true); }, 10_000).unref();
  // OBS started streaming → "every stream" goals start over (read-only; only when OBS is set up in VTube Pro)
  setInterval(() => {
    void import('./obs.ts').then(async ({ obs }) => {
      if (!obs.cfg.enabled) return;
      const on = await obs.outputActive();
      if (on === true && obsWas === false && e.cfg.goals.some((g) => g.reset === 'stream')) e.newStream('OBS started streaming');
      if (on !== null) obsWas = on;
    }).catch(() => {});
  }, 60_000).unref();
  process.on('exit', () => { try { e.close(); } catch { /* best effort */ } });
  return e;
}

// every chat line the hub emits (all platforms): finance → support events, follows, raids, mod / incentive commands
chatListeners.add((ev) => { try { goals().onChatEvent(ev); } catch (err) { console.warn('[goals] chat', err); } });
// the support lane's events (deduped against the chat lines by id + the cross-path window)
broadcastTaps.add((m) => { if ((m as { type?: string }).type === 'support') { try { goals().onSupport((m as unknown as { ev: unknown }).ev); } catch (err) { console.warn('[goals] support', err); } } });

/** At helper start (server/index.ts): the engine up now, so OBS pages get the timer + goals right after a restart. */
export function startGoals() { try { goals().push(true); } catch (e) { console.warn('[goals] start', e); } }

/** "Reset session totals" (Chat & events): the migrated goal #1 starts over with it. */
export function goalsTotalsReset() { goals().totalsReset(); }

/** Stream Deck (shared/deck.ts kind 'goals'). */
export function goalsDeck(action: string, args: Record<string, unknown>): unknown {
  const e = goals(), d = String(args.do ?? ''), mins = Number(args.minutes) || 5;
  if (action === 'wheel') return e.spin(undefined, 'Stream Deck');
  if (action === 'subathon') {
    switch (d) {
      case 'pause': return e.subPause(true, 'Stream Deck');
      case 'resume': return e.subPause(false, 'Stream Deck');
      case 'add': return e.subAdjust(mins * 60_000, 'Stream Deck');
      case 'sub': return e.subAdjust(-mins * 60_000, 'Stream Deck');
      case 'undo': return e.subUndo(1, 'Stream Deck');
      case 'happy': return e.subHappy(Number(args.mult) || 2, mins * 60_000, 'Stream Deck');
      case 'happy-off': return e.subHappy(1, 0, 'Stream Deck');
      case 'sleep': return e.subSleep('toggle', 'Stream Deck');
      case 'start': return !!e.subStart();
      default: return e.subPause('toggle', 'Stream Deck');
    }
  }
  // goal: by name or number (1 = the first); empty = the first
  const k = String(args.goal ?? '').trim().toLowerCase();
  const g = !k ? e.cfg.goals[0] : /^\d+$/.test(k) ? e.cfg.goals[Number(k) - 1] : e.cfg.goals.find((x) => x.title.toLowerCase() === k) ?? e.cfg.goals.find((x) => x.title.toLowerCase().includes(k));
  if (d === 'newstream') { e.newStream('Stream Deck'); return true; }
  if (!g) throw new Error(k ? `No goal called "${args.goal}"` : 'No goal yet: make one in Goals & subathon');
  if (d === 'add') return e.adjustGoal(g.id, Number(args.amount) || 0, 'Stream Deck', '');
  const show = d === 'show' ? true : d === 'hide' ? false : !g.show;
  return e.saveGoal({ ...g, show });
}

// ---------------------------------------------------------------- routes
export const goalsRoutes = Router();
const body = (req: Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;
const by = (req: Request) => (typeof body(req).by === 'string' ? String(body(req).by).slice(0, 40) : 'studio');
const done = <T>(v: T | string): T => { if (typeof v === 'string') throw new HttpError(400, v); return v; };

goalsRoutes.get('/api/goals/view', (req, res) => { requireLocalOrStreamPc(req); res.setHeader('Cache-Control', 'no-store'); res.json(goals().view()); });
goalsRoutes.get('/api/goals/state', (req, res) => { requireLocal(req); res.setHeader('Cache-Control', 'no-store'); res.json(goals().panelState()); });
goalsRoutes.put('/api/goals/config', (req, res) => {
  requireLocal(req);
  const b = body(req), patch: Partial<GoalsConfig> = {};
  for (const k of ['currency', 'show', 'mods', 'celebrate', 'wheel', 'incentives', 'streamGapH'] as const) if (b[k] !== undefined) (patch as Record<string, unknown>)[k] = b[k];
  goals().setConfig(patch);
  res.json(goals().panelState());
});
goalsRoutes.post('/api/goals/goal', (req, res) => { requireLocal(req); done(goals().saveGoal(body(req))); res.json(goals().panelState()); });
goalsRoutes.delete('/api/goals/goal/:id', (req, res) => { requireLocal(req); goals().removeGoal(String(req.params.id)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/template', (req, res) => { requireLocal(req); done(goals().addTemplate(String(body(req).id ?? ''))); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/goal/:id/reset', (req, res) => { requireLocal(req); if (!goals().resetGoal(String(req.params.id))) throw new HttpError(404, 'No such goal'); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/goal/:id/adjust', (req, res) => {
  requireLocal(req);
  const b = body(req);
  if (!goals().adjustGoal(String(req.params.id), Number(b.delta), by(req), String(b.note ?? '').slice(0, 120))) throw new HttpError(400, 'Type an amount (a minus sign takes off)');
  res.json(goals().panelState());
});
goalsRoutes.post('/api/goals/order', (req, res) => { requireLocal(req); const ids = body(req).ids; goals().orderGoals(Array.isArray(ids) ? ids.map(String) : []); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/new-stream', (req, res) => { requireLocal(req); goals().newStream('studio'); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/entry/:seq/void', (req, res) => {
  requireLocal(req);
  if (!goals().voidEntry(Number(req.params.seq), body(req).void !== false, by(req))) throw new HttpError(404, 'That entry is not in the log any more');
  res.json(goals().panelState());
});
goalsRoutes.post('/api/goals/sub/start', (req, res) => {
  requireLocal(req);
  const b = body(req);
  const t = String(b.template ?? '');
  goals().subStart(t === 'classic' || t === 'chill' || t === 'weekend' ? subathonTemplate(t) : b.config ?? undefined);
  res.json(goals().panelState());
});
goalsRoutes.post('/api/goals/sub/config', (req, res) => { requireLocal(req); goals().subConfig(body(req).config ?? {}); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/stop', (req, res) => { requireLocal(req); goals().subStop(); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/pause', (req, res) => { requireLocal(req); const on = body(req).on; goals().subPause(typeof on === 'boolean' ? on : 'toggle', by(req)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/add', (req, res) => {
  requireLocal(req);
  const b = body(req);
  const text = typeof b.text === 'string' ? b.text.trim() : '';
  const ms = typeof b.ms === 'number' ? b.ms : (text.startsWith('-') ? -1 : 1) * parseDuration(text.replace(/^[+-]/, ''));
  if (!ms || !Number.isFinite(ms)) throw new HttpError(400, 'Type a time like 5m, 1h30m or -10m');
  if (!goals().subAdjust(Math.max(-30 * 86_400_000, Math.min(30 * 86_400_000, ms)), by(req), String(b.note ?? '').slice(0, 80))) throw new HttpError(409, 'Start a subathon first');
  res.json(goals().panelState());
});
goalsRoutes.post('/api/goals/sub/undo', (req, res) => { requireLocal(req); const b = body(req); goals().subUndo(Number(b.n) || 1, by(req), Number(b.seq) || undefined); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/redo', (req, res) => { requireLocal(req); if (!goals().subRedo(Number(body(req).seq) || 0, by(req))) throw new HttpError(409, 'That change is not undone (or not in the log any more)'); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/happy', (req, res) => { requireLocal(req); const b = body(req); goals().subHappy(Math.min(10, Math.max(1, Number(b.mult) || 1)), Math.min(86_400_000, Math.max(0, Number(b.ms) || 0)), by(req)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/sleep', (req, res) => { requireLocal(req); const on = body(req).on; goals().subSleep(typeof on === 'boolean' ? on : 'toggle', by(req)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/sub/reopen', (req, res) => { requireLocal(req); goals().subReopen(Math.max(60_000, Number(body(req).ms) || 3_600_000), by(req)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/wheel/spin', (req, res) => { requireLocal(req); goals().spin(undefined, by(req)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/test', (req, res) => { requireLocal(req); goals().setTest(body(req).on === true); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/test/event', (req, res) => { requireLocal(req); goals().testEvent(String(body(req).what ?? 'tip').slice(0, 16)); res.json(goals().panelState()); });
goalsRoutes.post('/api/goals/incentive/:id/try', (req, res) => { requireLocal(req); if (!goals().tryIncentive(String(req.params.id))) throw new HttpError(404, 'No such incentive'); res.json(goals().panelState()); });
// tests only (VTP_GOALS_TEST_INJECT=1): stand in for the support lane's connectors - broadcast a {type:'support'} event
if (process.env.VTP_GOALS_TEST_INJECT === '1') {
  goalsRoutes.post('/api/goals/_inject', (req, res) => { requireLocal(req); broadcast({ type: 'support', ev: body(req).ev } as unknown as Parameters<typeof broadcast>[0]); res.json({ ok: true }); });
}
