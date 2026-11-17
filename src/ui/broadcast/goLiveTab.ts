// VTube Pro Live: the Go Live tab of the Live panel. One persistent element (`el`) that the Live panel mounts into its pane.
//
// What it shows, top to bottom: the "Which one do you stream with?" card, the big Go Live button (live timer, End show,
// resume offer), the confirm card, the health tile, Record and "Save last 60 s", then "Check my setup" and "Where you stream".
//
// Rules this file keeps (docs/BROADCAST_PROTOCOL.md section 1, plan graft G1):
//  * Nothing starts by itself. A stream, a recording or the private test starts only from a button the person pressed,
//    through a fresh single-use token that /api/broadcast/intent issues when the confirm card opens. There is exactly one
//    call site each for /start, /dry-run and starting a recording below, and every one of them runs behind `once`, so a
//    double click is one request.
//  * A Stream Deck key can only ASK: the helper remembers the key press and tells the studio (postDeckAsk, from the bus word
//    'golive-ask'; the tab also reads GET /api/deck/golive once when it opens, the key press, the 10 second
//    window and the single-use check all live on the Helper, so the card is the same there). The tab then shows a card, and only the person's click
//    on that card asks for a token (source 'deck-confirmed', carrying the helper's own press time, which the helper checks and uses up)
//    and then starts, through the same single start call below. No click in 10 seconds: the card goes away and nothing started.
//  * It asks the helper nothing while it is not on screen (setActive(false), a hidden window, or detached from the page).
//  * Stream keys are typed into a password box, sent once to POST /keys/:id and cleared; they are never kept, drafted or logged.
//  * Every sentence about health comes from HEALTH_TEXT (view.ts), never from a number.
//  * A server without /api/broadcast routes, or one that does not answer, gets a calm "restart / start it" card.
import { h } from '../dom.ts';
import { openHelp } from '../help/helpViewer.ts';
import { createBroadcastApi, type BroadcastApi, type DeckAskView } from './api.ts';
import { renderChoice } from './choiceCard.ts';
import { renderConfirm } from './confirmToast.ts';
import { renderDestinations, type DestHandlers, type DestUi } from './destinationsCard.ts';
import { renderHealth } from './healthTile.ts';
import { renderPreflight } from './preflightCard.ts';
import { ensureGoLiveCss } from './styles.ts';
import {
  CONFIRM_CLOSE_MS, DRY_RUN_SECONDS, END_ARM_MS, KEY_HELP, Once, PLATFORM_NAME, availView, confirmView, dryRunPlan, failText, fixDestId, formatTimer,
  goButtonView, keyLooksOk, onAirSeconds, planFor, pollDelayMs, readyDests, recordPlan, recordView, replayView, type Avail, type GoInputs,
} from './view.ts';
import type {
  BackendChoice, BroadcastBusMessage, BroadcastStatus, DestPlatform, FixId, GoLivePlan, IntentGrant, PreflightReport,
} from '../../../shared/broadcastTypes.ts';

export interface GoLiveTabOpts {
  /** False = a view-only window (an observer tab): it shows the state and never acts. Read each time. */
  canRun(): boolean;
  toast(msg: string, kind?: 'ok' | 'warn' | 'err' | 'info'): void;
  api?: BroadcastApi;
  now?(): number;
}

export interface GoLiveTab {
  el: HTMLElement;
  /** On screen or not. Off = no requests, no timers. Idempotent. */
  setActive(on: boolean): void;
  /** A `broadcast` bus message from the helper (state, health, notice). Optional: polling covers the same ground. */
  ingestBus(m: BroadcastBusMessage): void;
  refresh(): Promise<void>;
  destroy(): void;
}

// ---- the Stream Deck's ask, from outside the tab (the studio's bus listener calls this; the tab may not exist yet)
let inboxAsk: DeckAskView | null = null;
const inboxSubs = new Set<(a: DeckAskView | null) => void>();
/** A Go Live key press (or its cancel, null) reached this studio. It only ever OPENS a card; it can start nothing. */
export function postDeckAsk(a: DeckAskView | null): void {
  inboxAsk = a && Number.isFinite(a.pressedAt) && Number.isFinite(a.expiresAt) ? { pressedAt: a.pressedAt, expiresAt: a.expiresAt } : null;
  for (const f of [...inboxSubs]) { try { f(inboxAsk); } catch { /* a tab must not break the others */ } }
}

/** The slice of a window the frame guard reads (a test passes a fake). */
export interface FrameProbe {
  self: unknown; top: unknown;
  location: { origin: string; ancestorOrigins?: ArrayLike<string> };
}
/** True when this page sits inside a page from ANOTHER origin (or one we cannot read). A framed Go Live button can be lured
 *  under a hidden overlay, so no token is asked for there. Not framed, or framed only by the same origin, is fine. The server
 *  also refuses to be framed by strangers (frame-ancestors); this is the second lock. */
export function framedByStranger(w: FrameProbe): boolean {
  if (w.top === w.self) return false;
  const own = w.location.origin;
  const anc = w.location.ancestorOrigins;
  if (anc) for (let i = 0; i < anc.length; i++) if (anc[i] !== own) return true;
  try { return (w.top as { location: { origin: string } }).location.origin !== own; } catch { return true; }   // a cross-origin top throws: that is a stranger
}
const FRAMED_SAY = 'For your safety, Go Live only works in a VTube Pro window of its own. Open VTube Pro directly and try again.';
const OBS_KEY_NOTE = 'OBS keeps your stream key in its own settings once you go live. Whatever your OBS streamed to before is put back when the show ends.';
const REPORT_STALE_MS = 3 * 60_000;
type SecKey = 'notice' | 'choice' | 'hero' | 'confirm' | 'health' | 'controls' | 'pre' | 'dest';
interface Sec { el: HTMLElement; sig: string; pending: boolean }

export function createGoLiveTab(o: GoLiveTabOpts): GoLiveTab {
  ensureGoLiveCss();
  const now = o.now ?? Date.now;
  const api = o.api ?? createBroadcastApi();
  const root = h('div', { class: 'gl-root', 'data-gl': 'root' });

  // ---- state
  let active = false, destroyed = false, avail: Avail = 'loading', fails = 0, refreshSeq = 0;
  let st: BroadcastStatus | null = null, report: PreflightReport | null = null, checking = false, firstLook = false;
  let confirm: { kind: 'go' | 'dry'; plan: GoLivePlan; grant: IntentGrant; at: number } | null = null;
  let choiceOpen = false, armEnd = 0, resumeDismissed = 0;
  const timers = { poll: 0, tick: 0, arm: 0, confirm: 0, dry: 0, deck: 0 };
  /** The Stream Deck key press waiting for a click on screen (null = none). */
  let deckAsk: DeckAskView | null = null;
  /** Every action that starts, stops or records runs through this one guard: a second click while one runs is ignored. */
  const once = new Once();
  const destOnce = new Once();
  const dui: DestUi = { editing: null, adding: false, draft: {} };

  /** In the page and drawn (not inside a hidden area). */
  const onScreen = () => root.isConnected && root.getClientRects().length > 0;
  const canRun = () => o.canRun();
  const canAct = () => canRun() && avail === 'ready';
  /** The page is inside another site's frame: no token is asked for from here (docs/GO_LIVE.md, clickjacking). */
  const framed = () => { try { return framedByStranger(window); } catch { return true; } };
  const isLive = () => !!st && (st.goLive.phase === 'live' || st.goLive.phase === 'reconnecting' || st.goLive.phase === 'starting');
  const inputs = (): GoInputs => ({ avail, readOnly: !canRun(), status: st, report, busy: once.busy || checking, confirmOpen: !!confirm || !!deckAsk });

  // ---- sections (each repaints only when what it shows changed, and never under a text box being typed in)
  const secs = {} as Record<SecKey, Sec>;
  const mk = (key: SecKey, cls = 'gl-sec'): HTMLElement => { const el = h('div', { class: cls, 'data-sec': key }); secs[key] = { el, sig: '\u0000', pending: false }; return el; };
  const cols = h('div', { class: 'gl-cols' });
  const helpRow = h('div', { class: 'gl-head', 'data-gl': 'help-row' }, h('span', { class: 'gl-grow' }),
    h('button', { class: 'gl-btn s', type: 'button', 'data-gl': 'help', title: 'How Go Live works', 'aria-label': 'Help for Go Live', onClick: () => openHelp('GO_LIVE.md') }, '?'));
  root.append(helpRow, mk('notice'), mk('choice'), mk('hero'), mk('confirm'), mk('health'), mk('controls'), cols);
  cols.append(mk('pre'), mk('dest'));
  const typing = (s: Sec) => { const a = document.activeElement; return !!a && s.el.contains(a) && (a instanceof HTMLInputElement || a instanceof HTMLTextAreaElement || a instanceof HTMLSelectElement); };
  function setSec(key: SecKey, sig: string, build: () => HTMLElement | null) {
    const s = secs[key];
    if (s.sig === sig) return;
    if (typing(s)) { s.pending = true; return; }
    s.sig = sig; s.pending = false;
    const next = build();
    s.el.replaceChildren(...(next ? [next] : []));
  }
  root.addEventListener('focusout', () => { setTimeout(() => { if (!destroyed && Object.values(secs).some((s) => s.pending)) paint(); }, 0); });

  // ---- painting
  function paint() {
    if (destroyed) return;
    const av = availView(avail);
    if (avail !== 'ready') {
      setSec('notice', `n:${avail}`, () => h('div', { class: 'gl-card gl-notice', 'data-gl': 'notice', 'data-avail': avail, role: 'status' },
        h('h3', null, av.title), h('p', { class: 'gl-dim' }, av.say),
        av.action === 'none' ? null : h('button', { class: 'gl-btn', type: 'button', 'data-gl': 'check-again', onClick: () => { avail = 'loading'; fails = 0; paint(); void refresh().then(schedule); } }, 'Check again')));
      for (const k of ['choice', 'hero', 'confirm', 'health', 'controls', 'pre', 'dest'] as const) setSec(k, `x:${avail}`, () => null);
      return;
    }
    setSec('notice', 'ready', () => null);
    const act = canAct();
    // which one do you stream with
    setSec('choice', JSON.stringify([st?.choice, st?.engineAvailable, choiceOpen, act]), () => renderChoice(st, { open: choiceOpen, canAct: act, onPick: (c) => void pick(c), onToggle: () => { choiceOpen = !choiceOpen; paint(); } }));
    // the big button
    const gv = goButtonView(inputs());
    const g = st?.goLive;
    const offer = g?.resumeOffer && g.phase === 'idle' && g.resumeOffer.endedAt !== resumeDismissed ? g.resumeOffer : null;
    setSec('hero', JSON.stringify([gv, armEnd > 0, g?.phase, g?.dryRun, st?.keyNote, st?.choice, g?.error, offer, canRun(), !!confirm, !!deckAsk]), () => {
      const arm = gv.action === 'end' && armEnd > 0;
      const onAir = isLive();
      const btn = h('button', { class: `gl-go ${arm ? 'arm' : gv.mode}`, type: 'button', 'data-gl': 'go', 'data-mode': gv.mode, disabled: !gv.enabled, 'aria-describedby': 'gl-go-sub',
        onClick: (ev: MouseEvent) => onHero(ev) }, arm ? 'Press again to end the show' : gv.label);
      return h('div', { class: 'gl-hero', 'data-gl': 'hero' },
        offer ? h('div', { class: 'gl-banner', 'data-gl': 'resume', role: 'status' }, h('span', null, 'You were live a little while ago. Go live again?'),
          h('button', { class: 'gl-btn pri s', type: 'button', 'data-gl': 'resume-go', disabled: !gv.enabled, onClick: (ev: MouseEvent) => void openConfirm('go', planFor(readyDests(st!.destinations).filter((d) => offer.destIds.includes(d.id))), ev) }, 'Go live again'),
          h('button', { class: 'gl-btn s', type: 'button', onClick: () => { resumeDismissed = offer.endedAt; paint(); } }, 'Not now')) : null,
        onAir ? h('div', { class: 'gl-onair', 'data-gl': 'onair' }, h('span', { class: 'dot', 'aria-hidden': 'true' }), h('span', null, g!.dryRun ? 'Private test' : g!.phase === 'reconnecting' ? 'Reconnecting' : g!.phase === 'starting' ? 'Starting' : 'On air'),
          h('span', { class: 'gl-timer', 'data-gl': 'timer' }, formatTimer(onAirSeconds(g!, now())))) : null,
        btn,
        h('div', { class: 'gl-sub', id: 'gl-go-sub', 'data-gl': 'sub' }, gv.sub),
        g?.error ? h('div', { class: 'gl-banner', role: 'alert', 'data-gl': 'error' }, h('span', null, g.error)) : null,
        st && st.choice === 'obs' && !onAir ? h('div', { class: 'gl-keynote', 'data-gl': 'keynote' }, st.keyNote ?? OBS_KEY_NOTE) : null);
    });
    // the confirm card
    setSec('confirm', JSON.stringify([confirm?.kind, confirm?.grant.planHash, confirm?.grant.token.length, once.busy, deckAsk?.pressedAt, act, st?.destinations]), () => {
      if (!confirm && deckAsk && act && !isLive()) {
        // the Stream Deck asked: the same card, with the 10 second promise. Only a click on its button asks for a token.
        const dv = confirmView(planFor(st?.destinations ?? []), st?.destinations ?? []);
        const card = renderConfirm({
          view: { ...dv, heading: 'Your Stream Deck asked to go live', lines: [...dv.lines, 'Press Go Live now within 10 seconds. If you do not, nothing starts.'], cancelLabel: 'Not now' },
          busy: once.busy, onGo: (ev) => void deckGo(ev), onCancel: () => dropDeckAsk(),
        });
        card.dataset.source = 'deck';
        queueMicrotask(() => { if (card.isConnected && !card.contains(document.activeElement)) card.focus({ preventScroll: false }); });
        return card;
      }
      if (!confirm) return null;
      const card = renderConfirm({ view: confirmView(confirm.plan, st?.destinations ?? []), busy: once.busy, onGo: (ev) => void confirmGo(ev), onCancel: () => closeConfirm() });
      queueMicrotask(() => { if (card.isConnected && !card.contains(document.activeElement)) card.focus({ preventScroll: false }); });
      return card;
    });
    // health
    const showHealth = isLive() || (st?.health.id ?? 'idle') !== 'idle';
    setSec('health', JSON.stringify([showHealth, st?.health.id]), () => showHealth ? renderHealth(st?.health, { canAct: act, onFix: (f) => void onFix(f) }) : null);
    // record + save last 60 s
    const rec = recordView(g?.record, { avail, readOnly: !canRun(), status: st, busy: once.busy });
    const rep = replayView(st, { readOnly: !canRun(), busy: once.busy });
    setSec('controls', JSON.stringify([rec, rep]), () => h('div', { class: 'gl-card', 'data-gl': 'controls' }, h('div', { class: 'gl-row' },
      h('button', { class: `gl-btn${rec.active ? ' bad' : ''}`, type: 'button', 'data-gl': 'record', 'data-active': rec.active ? '1' : '0', disabled: !rec.enabled, title: rec.sub, onClick: (ev: MouseEvent) => void onRecord(ev) }, rec.label),
      rep.show ? h('button', { class: 'gl-btn', type: 'button', 'data-gl': 'replay', disabled: !rep.enabled, title: rep.sub, onClick: () => void onReplay() }, rep.label) : null,
      h('span', { class: 'gl-dim gl-small gl-grow' }, rec.active ? rec.sub : ''))));
    // check my setup
    // the private test needs a test receiver on this computer; a normal install has none, so the button is not offered then
    const canTest = act && !isLive() && !!st && st.choice === 'obs' && st.dryRunAvailable === true;
    setSec('pre', JSON.stringify([report, checking, act, canTest]), () => renderPreflight({ report, running: checking, canAct: act, onCheck: () => void runCheck(), onFix: (f) => void onFix(f), onAccept: () => void runCheck(true), onTest: canTest ? ((ev) => void onDryRun(ev)) : null }));
    // where you stream
    setSec('dest', JSON.stringify([st?.destinations, g?.destinations, dui.editing, dui.adding, act, isLive()]), () => renderDestinations({
      destinations: st?.destinations ?? [], live: g?.destinations ?? [], ui: dui, canAct: act, locked: isLive(), handlers: destHandlers }));
  }

  // ---- talking to the helper
  async function refresh(): Promise<void> {
    if (destroyed) return;
    const seq = ++refreshSeq;
    const r = await api.status();
    if (destroyed || seq !== refreshSeq) return;   // (a newer answer is already in)
    if (r.ok) {
      fails = 0; avail = 'ready'; st = r;
      if (!firstLook) { firstLook = true; void firstReport(); }
      else if (canRun() && !isLive() && !checking && !once.busy && report && now() - report.at > REPORT_STALE_MS) void runCheck(report.verdict === 'check' && report.canGoLive);
    } else if (++fails >= 2 || avail === 'loading') { avail = 'no-helper'; }
    syncTick(); paint();
  }
  /** First time the tab is on screen: show the last check, and run one if there is none (detect, default: no button needed). */
  async function firstReport() {
    const g = await api.getPreflight();
    if (destroyed) return;
    if (g.ok && g.report) { report = g.report; paint(); }
    if (canRun() && !isLive() && (!report || now() - report.at > REPORT_STALE_MS)) await runCheck();
  }
  async function runCheck(accept = false) {
    if (!canAct() || checking) return;
    checking = true; paint();
    const r = await api.runPreflight(accept);
    checking = false;
    if (destroyed) return;
    if (r.ok) report = r.report; else o.toast(failText(r.code, r.error), 'warn');
    paint();
  }
  const afterChange = async () => { report = null; await refresh(); await runCheck(); };

  // ---- the big button
  function onHero(ev: MouseEvent) {
    const gv = goButtonView(inputs());
    if (!gv.enabled) return;
    if (!canRun()) { o.toast('This is a view-only window. Use your main VTube Pro window.', 'warn'); return; }
    if (gv.action === 'end') { void onEnd(); return; }
    if (gv.action === 'confirm' && st) void openConfirm('go', planFor(st.destinations), ev);
  }
  /** Ask for a fresh single-use token for exactly the plan the card is about to show, then open the card. */
  async function openConfirm(kind: 'go' | 'dry', plan: GoLivePlan, ev: MouseEvent) {
    if (!canAct() || confirm) return;
    if (kind === 'go' && plan.destIds.length === 0) { o.toast('Add where you stream first.', 'warn'); return; }
    if (framed()) { o.toast(FRAMED_SAY, 'warn'); return; }
    const trusted = ev.isTrusted;   // a real click, not a script: VTube Pro checks it
    const p = once.run(async () => {
      const res = await api.intent({ source: 'click', plan, gesture: { trusted, at: now() } });
      if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
      confirm = { kind, plan, grant: res, at: now() };
      window.clearTimeout(timers.confirm);
      timers.confirm = window.setTimeout(() => { if (confirm) { closeConfirm(); o.toast('That took too long. Press Go Live again when you are ready.', 'info'); } }, CONFIRM_CLOSE_MS);
    });
    paint(); await p; paint();
  }
  function closeConfirm() { window.clearTimeout(timers.confirm); confirm = null; paint(); }

  // ---- a Stream Deck Go Live key press (the helper asked; the person's click on the card is the confirmation)
  function dropDeckAsk() { window.clearTimeout(timers.deck); deckAsk = null; paint(); }
  function takeDeckAsk(a: DeckAskView | null) {
    if (destroyed) return;
    window.clearTimeout(timers.deck);
    if (!a || a.expiresAt <= now()) { if (deckAsk) { deckAsk = null; paint(); } return; }
    deckAsk = a;
    timers.deck = window.setTimeout(() => { if (deckAsk && deckAsk.pressedAt === a.pressedAt) { deckAsk = null; paint(); } }, Math.max(0, a.expiresAt - now()) + 50);
    paint();
  }
  async function pollDeckAsk() {
    if (!canRun()) return;
    const a = await api.deckPending();
    if (a && !destroyed) takeDeckAsk(a);
  }
  /** The click on the Stream Deck card: ask for a token that carries the helper's own key-press time, then start with it. */
  async function deckGo(ev: MouseEvent) {
    const a = deckAsk;
    if (!a || !canAct() || confirm || once.busy) return;
    if (a.expiresAt <= now()) { dropDeckAsk(); o.toast('That took too long. Press the Go Live key on your Stream Deck again.', 'info'); return; }
    const plan = planFor(st?.destinations ?? []);
    if (plan.destIds.length === 0) { dropDeckAsk(); o.toast('Add where you stream first.', 'warn'); return; }
    if (framed()) { dropDeckAsk(); o.toast(FRAMED_SAY, 'warn'); return; }
    const trusted = ev.isTrusted;   // a real click, not a script: VTube Pro checks it
    const p = once.run(async () => {
      window.clearTimeout(timers.deck); deckAsk = null;   // a key press is good for one click, whatever comes back
      const res = await api.intent({ source: 'deck-confirmed', plan, gesture: { trusted, at: now() }, deckPressedAt: a.pressedAt });
      if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
      await runStart(res, plan);
    });
    paint(); await p; paint();
    await refresh(); schedule();
  }
  /** The one call site of POST /start: used by the confirm card and by the Stream Deck card. */
  async function runStart(grant: IntentGrant, plan: GoLivePlan) {
    const res = await api.start({ token: grant.token, plan });
    if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
    if (st) st = { ...st, goLive: res.state };
    o.toast('You are live. Have a great show!', 'ok');
  }
  /** The one place a stream (or the private test) is started: the button on the confirm card. */
  async function confirmGo(_ev: MouseEvent) {
    const c = confirm;
    if (!c || !canAct()) return;
    const send = async () => {
      if (c.kind === 'dry') {
        const res = await api.dryRun({ token: c.grant.token, seconds: DRY_RUN_SECONDS });
        if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
        if (st) st = { ...st, goLive: res.state };
        o.toast('Private test started. It stops by itself in about ten seconds. Nothing is sent to your stream.', 'info');
        window.clearTimeout(timers.dry);
        timers.dry = window.setTimeout(() => { void finishDry(); }, (DRY_RUN_SECONDS + 1) * 1000);
        return;
      }
      await runStart(c.grant, c.plan);
    };
    const p = once.run(async () => {
      window.clearTimeout(timers.confirm);
      try { await send(); } finally { confirm = null; }   // a token works once: whatever happens, the card is done (it stays, greyed out, while the request runs)
    });
    paint(); await p; paint();
    await refresh(); schedule();
  }
  async function finishDry() {
    if (destroyed) return;
    await refresh();
    if (st?.goLive.dryRun) await api.stop({ reason: 'dry-run-done' });
    await refresh();
  }
  /** End show asks twice (the first press changes the button), then stops. No token: stopping never needs one. */
  async function onEnd() {
    if (!armEnd) {
      armEnd = now(); window.clearTimeout(timers.arm);
      timers.arm = window.setTimeout(() => { armEnd = 0; paint(); }, END_ARM_MS);
      paint(); return;
    }
    window.clearTimeout(timers.arm); armEnd = 0;
    const dry = !!st?.goLive.dryRun;
    const p = once.run(async () => {
      const res = await api.stop({ reason: dry ? 'dry-run-done' : 'end-show' });
      if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
      if (st) st = { ...st, goLive: res.state };
      o.toast(dry ? 'Test finished.' : 'Your show has ended.', 'ok');
    });
    paint(); await p;
    await refresh(); void runCheck(); schedule();
  }

  // ---- record, replay, private test
  async function onRecord(ev: MouseEvent) {
    const rv = recordView(st?.goLive.record, { avail, readOnly: !canRun(), status: st, busy: once.busy });
    if (!rv.enabled) return;
    const trusted = ev.isTrusted;
    const p = once.run(async () => {
      if (rv.active) {
        const res = await api.record({ action: 'stop' });
        if (!res.ok) o.toast(failText(res.code, res.error), 'warn'); else o.toast('Recording saved.', 'ok');
        return;
      }
      // a recording is a start too: the Record button is the deliberate click, and it still carries a fresh token
      if (framed()) { o.toast(FRAMED_SAY, 'warn'); return; }
      const plan = recordPlan();
      const grant = await api.intent({ source: 'click', plan, gesture: { trusted, at: now() } });
      if (!grant.ok) { o.toast(failText(grant.code, grant.error), 'warn'); return; }
      const res = await api.record({ action: 'start', token: grant.token, plan });
      if (!res.ok) o.toast(failText(res.code, res.error), 'warn'); else o.toast('Recording started.', 'ok');
    });
    paint(); await p;
    await refresh();
  }
  async function onReplay() {
    const rv = replayView(st, { readOnly: !canRun(), busy: once.busy });
    if (!rv.enabled) return;
    const p = once.run(async () => {
      const res = await api.replay();
      if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
      o.toast(res.result.say || (res.result.ok ? 'Saved your last moments as a clip.' : 'That didn’t save. Try again.'), res.result.ok ? 'ok' : 'warn');
    });
    paint(); await p;
    await refresh();
  }
  /** "Try a 10 second private test": the same kind of token as a real start, for a plan that can never reach a destination. */
  async function onDryRun(ev: MouseEvent) {
    if (!canAct() || confirm || isLive()) return;
    await openConfirm('dry', dryRunPlan(), ev);
  }

  // ---- fixes
  async function onFix(fixId: FixId) {
    if (!canAct()) { o.toast('This is a view-only window. Use your main VTube Pro window.', 'warn'); return; }
    // the fixes that are only steps on this page need no request
    if (fixId === 'paste-key') { dui.editing = fixDestId('paste-key', st?.destinations ?? []) ?? null; dui.adding = false; paint(); return; }
    if (fixId === 'add-destination') { dui.adding = true; paint(); return; }
    const res = await api.fix({ fixId, destId: fixDestId(fixId, st?.destinations ?? []) });
    if (!res.ok) { o.toast(failText(res.code, res.error), 'warn'); return; }
    if (res.say) o.toast(res.say, res.done ? 'ok' : 'info');
    if (res.next === 'destination-editor') { dui.adding = true; paint(); }
    await afterChange();
  }

  // ---- which one do you stream with
  async function pick(c: BackendChoice) {
    if (!canAct()) return;
    choiceOpen = false;
    if (st && c === st.choice) { paint(); return; }
    const r = await destOnce.run(() => api.setBackend(c));
    if (r.ran && !r.value.ok) o.toast(failText(r.value.code, r.value.error), 'warn');
    await afterChange();
  }

  // ---- destinations and stream keys
  const destHandlers: DestHandlers = {
    toggle: (id) => void (async () => {
      const d = st?.destinations.find((x) => x.id === id); if (!d || !canAct()) return;
      const r = await destOnce.run(() => api.saveDestination({ id, platform: d.platform, enabled: !d.enabled }));
      if (r.ran && !r.value.ok) o.toast(failText(r.value.code, r.value.error), 'warn');
      await afterChange();
    })(),
    startAdd: () => { dui.adding = !dui.adding; paint(); },
    add: (platform: DestPlatform) => void (async () => {
      if (!canAct()) return;
      const r = await destOnce.run(() => api.saveDestination({ platform, label: PLATFORM_NAME[platform], enabled: true }));
      if (!r.ran) return;
      if (!r.value.ok) { o.toast(failText(r.value.code, r.value.error), 'warn'); return; }
      dui.adding = false; dui.editing = r.value.destination.id;
      await afterChange();
    })(),
    edit: (id) => { dui.editing = id; dui.adding = false; paint(); },
    draftSet: (k, v) => { dui.draft[k] = v; },
    saveMeta: (id, f) => void (async () => {
      const d = st?.destinations.find((x) => x.id === id); if (!d || !canAct()) return;
      const r = await destOnce.run(() => api.saveDestination({ id, platform: d.platform, label: f.label.trim() || d.label, ...(d.platform === 'custom' && f.url.trim() ? { url: f.url.trim() } : {}) }));
      if (!r.ran) return;
      if (!r.value.ok) { o.toast(failText(r.value.code, r.value.error), 'warn'); return; }
      for (const k of Object.keys(dui.draft)) if (k.startsWith(`${id}:`)) delete dui.draft[k];
      o.toast('Saved.', 'ok'); await afterChange();
    })(),
    remove: (id) => void (async () => {
      if (!canAct()) return;
      const r = await destOnce.run(() => api.removeDestination(id));
      if (r.ran && !r.value.ok) { o.toast(failText(r.value.code, r.value.error), 'warn'); return; }
      if (dui.editing === id) dui.editing = null;
      await afterChange();
    })(),
    saveKey: (id, input) => void (async () => {
      if (!canAct()) return;
      if (!keyLooksOk(input.value)) { o.toast(KEY_HELP, 'warn'); return; }
      const key = input.value; input.value = '';   // the box is empty before the request leaves
      const r = await destOnce.run(() => api.saveKey(id, key));
      if (!r.ran) return;
      if (!r.value.ok) { o.toast(failText(r.value.code, r.value.error), 'warn'); return; }
      o.toast('Saved. VTube Pro keeps it safe on this computer.', 'ok'); await afterChange();
    })(),
    clearKey: (id) => void (async () => {
      if (!canAct()) return;
      const r = await destOnce.run(() => api.clearKey(id));
      if (r.ran && !r.value.ok) { o.toast(failText(r.value.code, r.value.error), 'warn'); return; }
      o.toast('Forgot that key.', 'ok'); await afterChange();
    })(),
  };

  // ---- polling and the clock (nothing runs while the tab is not on screen)
  function schedule() {
    window.clearTimeout(timers.poll);
    if (destroyed) return;
    const d = pollDelayMs({ active, docHidden: document.hidden, connected: onScreen(), avail, live: isLive() });
    if (d === null) {
      // not asking anything: only look again, locally, whether to start (no request is made here)
      if (active) timers.poll = window.setTimeout(() => { if (avail === 'no-helper') { avail = 'loading'; void refresh().then(schedule); } else schedule(); }, 2000);
      return;
    }
    timers.poll = window.setTimeout(async () => {
      // (asked again at the moment of asking: the tab may have been hidden or taken off the page since it was scheduled)
      if (pollDelayMs({ active, docHidden: document.hidden, connected: onScreen(), avail, live: isLive() }) !== null) await refresh();
      schedule();
    }, d);
  }
  function syncTick() {
    const need = active && !destroyed && isLive();
    if (need && !timers.tick) timers.tick = window.setInterval(tick, 1000);
    if (!need && timers.tick) { window.clearInterval(timers.tick); timers.tick = 0; }
  }
  function tick() {
    if (!onScreen() || document.hidden || !st) return;
    const t = root.querySelector('[data-gl="timer"]');
    if (t) t.textContent = formatTimer(onAirSeconds(st.goLive, now()));
  }
  const onVisible = () => { if (!document.hidden && active && !destroyed) void refresh().then(schedule); };
  document.addEventListener('visibilitychange', onVisible);

  inboxSubs.add(takeDeckAsk);
  if (inboxAsk) takeDeckAsk(inboxAsk);
  paint();
  return {
    el: root,
    setActive(on) {
      if (destroyed || on === active) return;
      active = on;
      if (on) { void refresh().then(schedule); void pollDeckAsk(); }
      else { window.clearTimeout(timers.poll); }
      syncTick();
    },
    ingestBus(m) {
      if (destroyed || m.type !== 'broadcast') return;
      if (m.k === 'state') { st = m.s; avail = 'ready'; syncTick(); if (active) paint(); }
      else if (m.k === 'health' && st) { st = { ...st, health: m.h }; if (active) paint(); }
      else if (m.k === 'notice') o.toast(m.n.say, m.n.tone === 'bad' ? 'err' : m.n.tone === 'warn' ? 'warn' : m.n.tone === 'ok' ? 'ok' : 'info');
    },
    refresh,
    destroy() {
      destroyed = true;
      for (const k of Object.keys(timers) as (keyof typeof timers)[]) { window.clearTimeout(timers[k]); window.clearInterval(timers[k]); }
      document.removeEventListener('visibilitychange', onVisible);
      inboxSubs.delete(takeDeckAsk);
      root.remove();
    },
  };
}
