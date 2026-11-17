// Stream Deck & controllers (docs/STREAM_DECK.md): the action registry over HTTP + a live websocket for button decks.
//
//   GET  /api/deck/actions               → { actions, live }            every controllable action (shared/deck.ts)
//   GET  /api/deck/layout                → { layout, resolved, live, key }  the button layout the deck screen edits
//   PUT  /api/deck/layout                → save it (config/deck.json) + push to every connected deck
//   POST /api/deck/run/:id   {params}    → run an action (this PC's pages / tools; no key needed)
//   GET  /api/deck/run/:id?key=…&p=…     → same for "Website / GET request" buttons (the per-PC key: Chat Hub's deckKey)
//   POST /api/deck/press/:page/:index    → press a key of the layout (what the plugin + virtual deck send)
//   GET  /api/deck/press/:page/:index?key=…
//   WS   /ws/deck                        → hello (actions, layout, resolved, live) + layout / state pushes; send press / run
//   POST /api/deck/run/golive            → a Go Live key: ASKS the studio to open its confirm card. It never starts anything
//                                          (docs/GO_LIVE.md): the stream starts only when the person clicks Start on screen
//                                          within DECK_CONFIRM_MS. No click = nothing happens.
//   GET  /api/deck/golive                → { pending } the ask the studio should be showing (this PC's pages only)
//
// Everything is localhost-only and refuses other websites (Origin / Sec-Fetch-Site), exactly like the Chat Hub routes.
// Actions become the same bus commands the Scene tab / scripts already use; the studio owns the state, and the lit keys
// come from what it saved (cache/scene.json, read-only here) + the Chat Hub read-aloud switch.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage } from 'node:http';
import { Router, type Request } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { ACTION_BY_ID, DECK_ACTIONS, defaultLayout, keyIndexAt, liveFromScene, planRun, resolveLayout, sanitizeLayout,
  type DeckClientMsg, type DeckLayout, type DeckLiveState, type DeckServerMsg } from '../shared/deck.ts';
import { broadcast, busClientCount, busOriginOk, onUpgrade, outputPages } from './bus.ts';
import { DECK_CONFIRM_MS } from '../shared/broadcastTypes.ts';
import { hostHub } from './chat/hostHub.ts';
import { emoteSoundCfg, setEmoteSoundsOn } from './chat/emoteSounds.ts';
import { pollDeck } from './poll.ts';
import { goalsDeck, goalsHooks } from './goals.ts';
import { audienceDeck } from './audience.ts';
import { HttpError } from './library.ts';
import { CACHE_DIR, CONFIG_DIR, PORT } from './paths.ts';
import { requireLocal } from './routes/util.ts';

const FILE = path.join(CONFIG_DIR, 'deck.json');
const SCENE_FILE = path.join(CACHE_DIR, 'scene.json');

let layout: DeckLayout | null = null;
function getLayout(): DeckLayout {
  if (layout) return layout;
  try { layout = sanitizeLayout(JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch { layout = defaultLayout(); }
  return layout;
}
function saveLayout(l: DeckLayout) {
  layout = l;
  try { fs.mkdirSync(CONFIG_DIR, { recursive: true }); const tmp = FILE + '.tmp'; fs.writeFileSync(tmp, JSON.stringify(l, null, 1)); fs.renameSync(tmp, FILE); }
  catch (e) { console.warn('[deck] save', e); }
}

let sceneCache: { mtime: number; data: unknown } = { mtime: -1, data: null };
function readLive(): DeckLiveState {
  try {
    const st = fs.statSync(SCENE_FILE);
    if (st.mtimeMs !== sceneCache.mtime) sceneCache = { mtime: st.mtimeMs, data: JSON.parse(fs.readFileSync(SCENE_FILE, 'utf8')) };
  } catch { sceneCache = { mtime: -1, data: null }; /* no saved scene (yet) = defaults */ }
  let tts = false;
  try { tts = !!hostHub().tts.on; } catch { /* hub not ready */ }
  let emoteSounds = false;
  try { emoteSounds = emoteSoundCfg().on; } catch { /* not readable */ }
  return { ...liveFromScene(sceneCache.data, tts, busClientCount()), emoteSounds };
}

// ---------------------------------------------------------------- Go Live from a key (the Go Live rule, docs/GO_LIVE.md)
/** A Stream Deck key can only ASK. The key press is remembered here (by this process, never by the page that claims it);
 *  the studio shows a confirm card; the stream starts only if the person clicks Start on that card within DECK_CONFIRM_MS
 *  and the intent route redeems the press with confirm() below (once). Nothing in this file calls a broadcast backend. */
export interface DeckAsk { pressedAt: number; expiresAt: number }
export interface DeckGoLiveDeps {
  now?: () => number;
  /** How long the key waits for the click. */
  ttlMs?: number;
  /** Is a studio page open that can show the card? */
  studioOpen?: () => boolean;
  /** Tell the studio pages to show the card / take it down. */
  onAsk?: (a: DeckAsk) => void;
  onExpire?: (a: DeckAsk) => void;
  /** Timer hooks for tests (default: setTimeout, unref'd). */
  setTimer?: (fn: () => void, ms: number) => { cancel(): void };
}
export type DeckConfirmResult = { ok: true } | { ok: false; code: 'not-confirmed'; say: string };
export interface DeckGoLiveGate {
  /** The key was pressed. Idempotent while an ask is still open. */
  press(): { ok: true; ask: DeckAsk } | { ok: false; error: string };
  /** The ask the studio should be showing right now (null once it ran out or was used). */
  pending(): DeckAsk | null;
  /** Called by the intent route for a 'deck-confirmed' request: true only for the real, unexpired, unused key press. */
  confirm(claimedPressedAt: unknown): DeckConfirmResult;
  cancel(): void;
}
const NOT_CONFIRMED = 'Press Go Live on the Stream Deck, then confirm it on screen within 10 seconds.';
export function createDeckGoLiveGate(d: DeckGoLiveDeps = {}): DeckGoLiveGate {
  const now = d.now ?? Date.now, ttl = d.ttlMs ?? DECK_CONFIRM_MS;
  const studioOpen = d.studioOpen ?? (() => true);
  const setTimer = d.setTimer ?? ((fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return { cancel: () => clearTimeout(t) }; });
  let ask: DeckAsk | null = null, timer: { cancel(): void } | null = null;
  const live = (): DeckAsk | null => {
    if (ask && now() - ask.pressedAt > ttl) drop(true);
    return ask;
  };
  function drop(expired: boolean) {
    const a = ask; ask = null; timer?.cancel(); timer = null;
    if (a && expired) { try { d.onExpire?.(a); } catch { /* the studio is gone */ } }
  }
  return {
    press() {
      const cur = live();
      if (cur) return { ok: true, ask: cur };
      if (!studioOpen()) return { ok: false, error: 'Open VTube Pro in your browser first, then press the key again.' };
      const t = now();
      ask = { pressedAt: t, expiresAt: t + ttl };
      timer = setTimer(() => { if (ask && ask.pressedAt === t) drop(true); }, ttl + 50);
      try { d.onAsk?.(ask); } catch { /* the studio is gone: the ask simply runs out */ }
      return { ok: true, ask };
    },
    pending: live,
    confirm(claimed) {
      const cur = live();
      if (!cur || typeof claimed !== 'number' || claimed !== cur.pressedAt || now() - cur.pressedAt > ttl) return { ok: false, code: 'not-confirmed', say: NOT_CONFIRMED };
      drop(false); // single use
      return { ok: true };
    },
    cancel: () => drop(false),
  };
}
/** Bus words of the ask. A page that does not know them ignores them (unknown commands are no-ops), and a page that does
 *  can only OPEN a card: the start still needs the person's click and a server-side confirm() of the real key press. */
export const DECK_GOLIVE_ASK = 'golive-ask';
export const DECK_GOLIVE_CANCEL = 'golive-cancel';
export const deckGoLive: DeckGoLiveGate = createDeckGoLiveGate({
  studioOpen: () => busClientCount() - outputPages().count > 0,
  onAsk: (a) => broadcast({ type: 'command', command: DECK_GOLIVE_ASK, args: { pressedAt: a.pressedAt, expiresAt: a.expiresAt, ttlMs: DECK_CONFIRM_MS } } as Parameters<typeof broadcast>[0]),
  onExpire: () => broadcast({ type: 'command', command: DECK_GOLIVE_CANCEL, args: {} } as Parameters<typeof broadcast>[0]),
});

/** Custom command keys and the bus: names that would ask for, start or fake a stream are refused on a key. */
export const GOLIVE_COMMAND = /^(go[-_ ]?live|broadcast|start[-_ ]?(stream|record|output|broadcast)|stream[-_ ]?(start|on)|intent)/i;

// ---------------------------------------------------------------- running
export function runAction(id: string, params: Record<string, unknown> | undefined): { ok: boolean; error?: string; local?: string; result?: unknown } {
  if (id === 'golive') {
    const r = deckGoLive.press();
    return r.ok ? { ok: true, result: { asked: true, expiresAt: r.ask.expiresAt, say: 'Confirm Go Live on screen.' } } : { ok: false, error: r.error };
  }
  if (id === 'command' && typeof params?.command === 'string' && GOLIVE_COMMAND.test(params.command.trim())) return { ok: false, error: 'Going live can only be started on screen' };
  const plan = planRun(id, params, readLive());
  switch (plan.kind) {
    case 'error': return { ok: false, error: plan.error };
    case 'local': return { ok: true, local: plan.action };
    case 'hub': return { ok: true, result: hostHub().act(plan.action) ?? null };
    case 'poll': try { return { ok: true, result: pollDeck(plan.action, plan.template) ?? null }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    case 'emotesnd': { const on = setEmoteSoundsOn(plan.on ?? undefined); setTimeout(pushState, 50); return { ok: true, result: { on } }; }
    case 'goals': try { const r = goalsDeck(plan.action, plan.args); setTimeout(pushState, 300); return { ok: true, result: r ?? null }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    case 'audience': try { return { ok: true, result: audienceDeck(plan.action) ?? null }; } catch (e) { return { ok: false, error: (e as Error).message }; }
    case 'bus':
      broadcast({ type: 'command', command: plan.command, args: plan.args } as Parameters<typeof broadcast>[0]);
      setTimeout(pushState, 400); setTimeout(pushState, 1500); // the studio saves the new state a moment later
      return { ok: true };
  }
}
// goals / stretch goals / incentives run room cues, lighting states, club moments … through this same registry
// (a goal / incentive is automation: it may never ask for, let alone start, a stream, so it cannot run the Go Live key)
goalsHooks.runDeck = (action, params) => (action === 'golive' ? { ok: false, error: 'Going live can only be started on screen' } : runAction(action, params));
function pressKey(page: number, index: number) {
  const l = getLayout(), p = l.pages[page], k = p?.keys[index];
  if (!k) return { ok: false, error: 'Empty key' };
  return runAction(k.action, k.params);
}

// ---------------------------------------------------------------- live pushes
const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 1024 * 1024 }); // key presses only
const send = (ws: WebSocket, m: DeckServerMsg) => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); };
const all = (m: DeckServerMsg) => { for (const c of wss.clients) send(c, m); };
let lastSig = '';
function pushState(force = false) {
  if (!wss.clients.size && !force) return;
  const live = readLive(), resolved = resolveLayout(getLayout(), live);
  // the live state itself is part of the signature: a room / mode the studio changed on its own (first-run default room,
  // a change from the studio's Room area) must reach Live too, even when no deck key lights up for it
  const sig = JSON.stringify(resolved.pages.map((p) => p.keys.map((k) => k.on))) + JSON.stringify(live);
  if (!force && sig === lastSig) return;
  lastSig = sig;
  all({ t: 'state', resolved, live });
}
setInterval(() => pushState(), 700).unref(); // cheap: one stat of cache/scene.json, JSON only when it changed

const LOOP_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i;
function guard(req: Request | IncomingMessage) {
  if (!LOOP_HOST.test(String(req.headers.host ?? ''))) throw new HttpError(403, 'Loopback host only'); // DNS rebinding
  const origin = req.headers.origin;
  if (origin && !busOriginOk(origin)) throw new HttpError(403, 'Only VTube Pro pages on this PC may use this');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request refused');
}
const LOOPBACK = /^(127\.0\.0\.1|::1|::ffff:127\.0\.0\.1)$/;
onUpgrade('/ws/deck', (req, socket, head) => {
  try { guard(req); if (!LOOPBACK.test(req.socket.remoteAddress ?? '')) throw new Error('not local'); }
  catch { socket.destroy(); return; }
  wss.handleUpgrade(req, socket, head, (ws) => {
    const live = readLive(), l = getLayout();
    send(ws, { t: 'hello', actions: DECK_ACTIONS, layout: l, resolved: resolveLayout(l, live), live });
    ws.on('message', (data) => {
      let m: DeckClientMsg;
      try { m = JSON.parse(String(data)); } catch { return; }
      if (m?.t === 'press' && Number.isInteger(m.page) && Number.isInteger(m.index)) {
        const r = pressKey(m.page, m.index);
        send(ws, { t: 'result', id: m.id, ok: r.ok, error: r.error });
      } else if (m?.t === 'run' && typeof m.action === 'string') {
        const r = runAction(m.action, m.params && typeof m.params === 'object' ? m.params : undefined);
        send(ws, { t: 'result', id: m.id, ok: r.ok, error: r.error });
      }
    });
    ws.on('error', () => ws.terminate());
  });
});

// ---------------------------------------------------------------- routes
export const deckRoutes = Router();
const keyOk = (req: Request) => {
  const k = String(req.query.key ?? ''), want = hostHub().deckKey;
  if (k.length !== want.length || !crypto.timingSafeEqual(Buffer.from(k), Buffer.from(want))) throw new HttpError(403, 'Wrong or missing key (copy the URL from Stream Deck & controllers)');
};
const G = (req: Request) => { requireLocal(req); guard(req); };
/** GET params: ?p=<json> or plain ?state=show&… */
const queryParams = (req: Request): Record<string, unknown> => {
  const q = { ...req.query } as Record<string, unknown>; delete q.key;
  if (typeof q.p === 'string') { try { const j = JSON.parse(q.p); if (j && typeof j === 'object') return j; } catch { /* plain */ } }
  return q;
};
const reply = (r: ReturnType<typeof runAction>) => { if (!r.ok) throw new HttpError(r.error?.startsWith('Unknown') ? 404 : 400, r.error ?? 'failed'); return r; };

deckRoutes.get('/api/deck/actions', (req, res) => { G(req); res.json({ actions: DECK_ACTIONS, live: readLive() }); });
/** What the studio shows as the deck's Go Live ask (this PC's pages; the key press itself lives on the server). */
deckRoutes.get('/api/deck/golive', (req, res) => { G(req); res.setHeader('Cache-Control', 'no-store'); res.json({ pending: deckGoLive.pending() }); });
deckRoutes.get('/api/deck/layout', (req, res) => {
  G(req); const live = readLive(), l = getLayout();
  res.json({ layout: l, resolved: resolveLayout(l, live), live, key: hostHub().deckKey, port: PORT });
});
deckRoutes.put('/api/deck/layout', (req, res) => {
  G(req);
  const l = sanitizeLayout(req.body);
  saveLayout(l);
  const live = readLive(), resolved = resolveLayout(l, live);
  all({ t: 'layout', layout: l, resolved });
  res.json({ layout: l, resolved });
});
// params: JSON body {params} or, for tools that can only send a bare POST (Touch Portal / Companion / curl), the query string
deckRoutes.post('/api/deck/run/:id', (req, res) => {
  G(req);
  const b = (req.body ?? {}) as { params?: unknown };
  res.json(reply(runAction(String(req.params.id), b.params && typeof b.params === 'object' ? b.params as Record<string, unknown> : queryParams(req))));
});
deckRoutes.get('/api/deck/run/:id', (req, res) => { G(req); keyOk(req); res.json(reply(runAction(String(req.params.id), queryParams(req)))); });
deckRoutes.post('/api/deck/press/:page/:index', (req, res) => { G(req); res.json(reply(pressKey(Number(req.params.page), Number(req.params.index)))); });
deckRoutes.get('/api/deck/press/:page/:index', (req, res) => { G(req); keyOk(req); res.json(reply(pressKey(Number(req.params.page), Number(req.params.index)))); });
/** Plugin helper: which layout key a physical key shows (Stream Deck coordinates). */
deckRoutes.get('/api/deck/at/:page/:col/:row', (req, res) => { G(req); const l = getLayout(); res.json({ index: keyIndexAt(l, Number(req.params.col), Number(req.params.row)) }); });
