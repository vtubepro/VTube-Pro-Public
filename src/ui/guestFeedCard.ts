// "Be a guest on someone else's show" (guest browser source): the card in the Party area, on the PC with the camera.
// One button turns it on and gives ONE link. The other streamer pastes that link into OBS as a Browser Source and your
// avatar shows up there on a see-through background. The link is silent (talk on Discord), your avatar file never leaves
// this PC, and the first OBS that opens the link owns it (any other OBS makes this card ask Allow / Block).
// Spec: docs/GUEST_BROWSER_SOURCE.md (sections 1, 6.3, 10); contract: shared/guestFeed.ts; help: docs/GUESTS_AND_PARTIES.md.
//
//   * everything talks to this PC's VTube Pro server (/api/guestfeed, server/guestFeed.ts);
//   * the card asks for its state only while it is on screen (2 s, 8 s when the tab is hidden, backing off after a failure);
//   * the pure parts (sanitizeView, cardModel) and the controller take no DOM and no network of their own, so
//     they can run under Node with a stub fetch and a tiny fake DOM.
import {
  GS_AUTO_OFF_MIN, GS_DELAY_MAX_MS, GS_DELAY_STEP_MS, GS_KNOCK_MS, GS_LADDER, GS_MAX_VIEWERS, GS_NAME_MAX, GS_SILENT_NOTE,
  asQuality, cardText, clampDelay, clean, obsSteps, parseViewHash, privacyText, sanitizeName,
  type GsCardState, type GsQuality, type GsRoute, type GsSettings, type GsView, type GsViewerInfo,
} from '../../shared/guestFeed.ts';
import { button, h } from './dom.ts';

export const GF_TITLE = 'Be a guest on someone else’s show';
const API = '/api/guestfeed';
const CARD_STATES: readonly GsCardState[] = ['off', 'starting', 'waiting', 'live', 'paused', 'asking', 'busy', 'noBrowser', 'crashed', 'noServer', 'inUse', 'idleOff'];
const ENGINE_DOWN = 'VTube Pro’s engine isn’t answering. Restart VTube Pro.';
const DONT_SHOW = 'Don’t show this link on stream. If you do, press New link.';

// ---------------------------------------------------------------- pure parts

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const nn = (v: unknown, lo: number, hi: number, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, Math.round(v))) : d);

/** The server's answer → a GsView the card can trust, or null (junk never throws; a link that does not parse is dropped). */
export function sanitizeView(raw: unknown): GsView | null {
  if (!isObj(raw) || raw.v !== 1 || !CARD_STATES.includes(raw.state as GsCardState)) return null;
  let url: string | null = null;
  if (typeof raw.url === 'string' && raw.url.length <= 2000) {
    try { const u = new URL(raw.url); if ((u.protocol === 'https:' || u.protocol === 'http:') && parseViewHash(u.hash)) url = raw.url; } catch { url = null; }
  }
  const viewers: GsViewerInfo[] = [];
  for (const x of (Array.isArray(raw.viewers) ? raw.viewers : []).slice(0, GS_MAX_VIEWERS)) {
    if (!isObj(x)) continue;
    viewers.push({
      id: clean(x.id, 24), label: clean(x.label, 40) || 'An OBS', since: nn(x.since, 0, 4e12), fps: nn(x.fps, 0, 240), kbps: nn(x.kbps, 0, 200_000),
      codec: clean(x.codec, 40), route: x.route === 'relay' || x.route === 'direct' ? x.route : 'unknown', // (the server already says relay / direct; routeOf() is for candidate types)
       rttMs: typeof x.rttMs === 'number' && Number.isFinite(x.rttMs) ? nn(x.rttMs, 0, 60_000) : null, visible: x.visible === true,
    });
  }
  const k = isObj(raw.knock) ? raw.knock : null;
  const priv = raw.privacy === 'relay' || raw.privacy === 'direct' ? raw.privacy : 'unknown';
  return {
    v: 1, enabled: raw.enabled === true, state: raw.state as GsCardState, says: clean(raw.says, 240), url,
    name: sanitizeName(raw.name), q: asQuality(raw.q), delayMs: clampDelay(raw.delayMs), autoOffMin: typeof raw.autoOffMin === 'number' && GS_AUTO_OFF_MIN.includes(raw.autoOffMin) ? raw.autoOffMin : 0,
    privacy: priv, privacySays: clean(raw.privacySays, 400), tier: GS_LADDER.includes(raw.tier as never) ? raw.tier as GsView['tier'] : 'full',
    relayKind: raw.relayKind === 'own' || raw.relayKind === 'official' ? raw.relayKind : null, viewers,
    knock: k && typeof k.kid === 'string' && /^[a-z0-9]{6}$/.test(k.kid) ? { kid: k.kid, label: clean(k.label, 40) || 'An OBS', at: nn(k.at, 0, 4e12) } : null,
    browser: raw.browser !== false, offAt: typeof raw.offAt === 'number' && Number.isFinite(raw.offAt) ? raw.offAt : null,
  };
}

/** Quality choices: 720p at 30 frames a second is the default. */
export const QUALITY_CHOICES: readonly [GsQuality, string][] = [[720, '720p · 30 frames a second'], [1080, '1080p · 30 frames a second (sharper, uses more of this PC)']];
export const autoOffLabel = (min: number): string => (min <= 0 ? 'Never' : min < 60 ? `After ${min} minutes` : `After ${min / 60} hour${min === 60 ? '' : 's'}`);
export const delayLabel = (ms: number): string => (ms <= 0 ? 'No delay' : `${ms} ms`);
const ROUTE_WORDS: Record<GsRoute, string> = { relay: 'address hidden', direct: 'direct connection', unknown: '' };
/** One viewer's line: "OBS …a1b2 · 30 frames a second · 2900 kbit/s · address hidden". Plain text only. */
export function viewerLine(v: GsViewerInfo): string {
  return [v.label, v.visible ? '' : 'not showing right now', v.fps > 0 ? `${v.fps} frames a second` : '', v.kbps > 0 ? `${v.kbps} kbit/s` : '', ROUTE_WORDS[v.route]].filter(Boolean).join(' · ');
}
const dotOf = (s: GsCardState): 'ok' | 'warn' | 'err' | 'off' =>
  s === 'live' ? 'ok' : s === 'noBrowser' || s === 'crashed' || s === 'noServer' || s === 'inUse' ? 'err' : s === 'off' || s === 'idleOff' ? 'off' : 'warn';
const clock = (ms: number) => { try { return new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }); } catch { return ''; } };

export interface GfModel {
  /** loading: nothing asked yet. down: VTube Pro did not answer. ready: a view */
  kind: 'loading' | 'down' | 'ready';
  says: string;
  dot: 'ok' | 'warn' | 'err' | 'off';
  /** the buttons that exist right now */
  turnOn: boolean; turnOff: boolean; copy: boolean; renew: boolean; recheck: boolean;
  url: string | null;
  /** the privacy sentence (only while a link exists) */
  privacy: string | null;
  /** "how to paste it into OBS" (only while a link exists) */
  steps: string[]; notes: string[];
  viewers: { id: string; line: string }[];
  knock: { kid: string; label: string; prompt: string } | null;
  /** shown while off when this PC has no Chrome or Edge */
  warn: string | null;
  settings: { q: GsQuality; delayMs: number; name: string; autoOffMin: number } | null;
  offAtText: string | null;
}
const EMPTY: Omit<GfModel, 'kind' | 'says' | 'dot'> = { turnOn: false, turnOff: false, copy: false, renew: false, recheck: false, url: null, privacy: null, steps: [], notes: [], viewers: [], knock: null, warn: null, settings: null, offAtText: null };

/** What the card shows for a view (or for no view). Pure: the card draws exactly this. */
export function cardModel(view: GsView | null, o: { down?: string }): GfModel {
  if (!view) return o.down ? { ...EMPTY, kind: 'down', says: o.down, dot: 'err' } : { ...EMPTY, kind: 'loading', says: 'Getting ready…', dot: 'warn' };
  const n = view.viewers.length;
  const linked = view.enabled && !!view.url;
  return {
    ...EMPTY, kind: 'ready', says: cardText(view.state, n), dot: dotOf(view.state),
    turnOn: !view.enabled, turnOff: view.enabled, copy: linked, renew: view.enabled, recheck: view.enabled && view.state === 'noServer',
    url: linked ? view.url : null,
    privacy: linked ? privacyText(view.privacy) : null,
    steps: linked ? obsSteps(view.q) : [], notes: linked ? [GS_SILENT_NOTE, DONT_SHOW] : [],
    viewers: view.enabled ? view.viewers.map((v) => ({ id: v.id, line: viewerLine(v) })) : [],
    knock: view.enabled && view.knock ? { kid: view.knock.kid, label: view.knock.label, prompt: cardText('asking') } : null,
    warn: !view.enabled && !view.browser ? cardText('noBrowser') : null,
    settings: { q: view.q, delayMs: view.delayMs, name: view.name, autoOffMin: view.autoOffMin },
    offAtText: view.enabled && view.offAt ? `Turns off by itself at ${clock(view.offAt)} if nobody is watching.` : null,
  };
}

// ---------------------------------------------------------------- the controller (no DOM)

export interface GfEnv {
  fetch?: typeof fetch;
  notify(msg: string, kind?: 'info' | 'ok' | 'warn' | 'err', ms?: number): void;
  copy?(text: string): Promise<boolean>;
  openHelp?(): void;
  knockToast?(label: string, decide: (allow: boolean) => void): () => void;
  timer?: { set(fn: () => void, ms: number): unknown; clear(t: unknown): void };
  now?(): number;
  /** false = the owner of the card drives refresh() itself (tests) */
  poll?: boolean;
}
export interface GfHandle { refresh(fresh?: boolean): Promise<void>; stop(): void; view(): GsView | null; model(): GfModel }

let lastView: GsView | null = null; // (a card built again by a re-render starts from the last answer: no flash of "Getting ready")

class Controller {
  view: GsView | null = lastView;
  down = '';
  busy = false;
  /** settings the user is changing right now: a poll must not put the old value back */
  dirty = 0;
  private timer: unknown = null;
  private fails = 0;
  private seen = false;
  private stopped = false;
  private readonly born: number;
  private kn: { kid: string; close: () => void } | null = null;
  private readonly asked = new Set<string>();
  constructor(readonly env: GfEnv, readonly host: { isConnected: boolean }, readonly paint: () => void) { this.born = this.now(); }
  now = () => this.env.now?.() ?? Date.now();

  // the one place that talks to the server
  private async call(method: 'GET' | 'PUT' | 'POST' | 'DELETE', path = '', body?: unknown): Promise<unknown> {
    const f = this.env.fetch ?? fetch.bind(globalThis);
    const r = await f(API + path, { method, cache: 'no-store', headers: { ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...(method === 'GET' ? {} : { 'x-vtp-user-action': '1' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    const j: unknown = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(isObj(j) && typeof j.error === 'string' && j.error ? clean(j.error, 200) : `VTube Pro said no (${r.status})`), { status: r.status });
    return j;
  }

  async refresh(fresh = false): Promise<void> {
    if (this.stopped) return;
    try {
      const v = sanitizeView(await this.call('GET', fresh ? '?fresh=1' : ''));
      if (!v) throw new Error('bad answer');
      this.take(v); this.down = ''; this.fails = 0;
    } catch (e) {
      this.fails++;
      const st = (e as { status?: number }).status;
      // (403 = this window is not on the PC with the camera; anything else = the engine is not answering)
      this.down = st === 403 ? clean((e as Error).message, 200) : ENGINE_DOWN;
      this.view = null;
    }
    this.paint();
  }

  private take(v: GsView) {
    this.view = lastView = v;
    const k = v.enabled ? v.knock : null;
    if (!k) { this.closeKnock(); return; }
    if (this.kn?.kid === k.kid || this.asked.has(k.kid)) return;
    this.asked.add(k.kid); // (one toast per question)
    this.closeKnock();
    const close = (this.env.knockToast ?? defaultKnockToast)(k.label, (allow) => void this.decide(k.kid, allow));
    this.kn = { kid: k.kid, close };
  }
  private closeKnock() { this.kn?.close(); this.kn = null; }

  /** a click: run `f`, show a plain error, ask again afterwards */
  async run(f: () => Promise<void>): Promise<void> {
    if (this.busy) return;
    this.busy = true; this.paint();
    try { await f(); } catch (e) { this.env.notify((e as Error).message, 'err', 7000); }
    finally { this.busy = false; await this.refresh(); }
  }
  private async put(patch: GsSettings, path = ''): Promise<void> {
    const attempt = async (): Promise<unknown> => this.call('PUT', path, patch);
    let j: unknown;
    try { j = await attempt(); } catch (e) {
      if ((e as { status?: number }).status !== 429) throw e;
      await new Promise((ok) => (this.env.timer ? this.env.timer.set(() => ok(null), 700) : setTimeout(() => ok(null), 700))); // ("One moment…": changes may come at most every 500 ms)
      j = await attempt();
    }
    const v = sanitizeView(j);
    if (v) this.take(v);
  }

  turnOn() { return this.run(async () => { await this.put({ enabled: true }); this.env.notify('On. Copy the link and send it to the other streamer.', 'ok', 5000); }); }
  turnOff() { return this.run(async () => { const v = sanitizeView(await this.call('DELETE')); if (v) this.take(v); this.env.notify('Off. The link no longer works.', 'info', 5000); }); }
  renew() { return this.run(async () => { const v = sanitizeView(await this.call('POST', '/renew', {})); if (v) this.take(v); this.env.notify('New link ready. The old one stopped working: copy this one and send it again.', 'ok', 7000); }); }
  recheck() { return this.run(() => this.refresh(true)); }
  /** Allow / Block for the OBS that is knocking */
  decide(kid: string, allow: boolean) { this.closeKnock(); return this.run(async () => { await this.call('POST', '/knock', { kid, allow }); this.env.notify(allow ? 'Let in. It connects in a moment.' : 'Blocked. That OBS can’t use the link for 10 minutes.', allow ? 'ok' : 'info', 5000); }); }
  /** settings (quality, delay, name, turn-off-by-itself): saved on their own, not part of the busy lock */
  async save(patch: GsSettings): Promise<void> {
    this.dirty++;
    try { await this.put(patch); } catch (e) { this.env.notify((e as Error).message, 'err', 7000); } finally { this.dirty--; }
    await this.refresh();
  }
  async copyLink(): Promise<void> {
    const url = this.view?.enabled ? this.view.url : null;
    if (!url) return;
    const ok = await (this.env.copy ?? copyText)(url);
    this.env.notify(ok ? 'Link copied. Send it to the other streamer.' : 'Couldn’t copy. Press “Show the link”, select it and press Ctrl+C.', ok ? 'ok' : 'warn', ok ? 4000 : 8000);
  }

  // ---- the poll loop: only while the card is on screen
  start() {
    if (this.env.poll === false) return;
    this.tick();
  }
  private set(ms: number) { const t = this.env.timer; this.timer = t ? t.set(() => this.tick(), ms) : setTimeout(() => this.tick(), ms); }
  private tick() {
    this.timer = null;
    if (this.stopped) return;
    if (this.host.isConnected) this.seen = true;
    else if (this.seen || this.now() - this.born > 10_000) { this.stop(); return; } // the panel was closed (or never shown): stop asking
    else { this.set(300); return; }                                                  // (not attached yet)
    void this.refresh().then(() => {
      if (this.stopped) return;
      const hidden = typeof document !== 'undefined' && document.hidden;
      this.set(Math.min(15_000, Math.max(hidden ? 8000 : 2000, this.fails ? 2000 * 2 ** Math.min(this.fails, 3) : 0)));
    });
  }
  stop() {
    this.stopped = true;
    if (this.timer != null) { const t = this.env.timer; if (t) t.clear(this.timer); else clearTimeout(this.timer as ReturnType<typeof setTimeout>); this.timer = null; }
    this.closeKnock();
  }
}

/** Copy to the clipboard; false when the browser says no. */
export async function copyText(text: string): Promise<boolean> {
  try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
}

/** The "A new OBS opened your link. Let it in?" toast with Allow / Block. Returns a function that removes it. */
export function defaultKnockToast(label: string, decide: (allow: boolean) => void): () => void {
  if (typeof document === 'undefined') return () => {};
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  let gone = false;
  const t = h('div', { class: 'toast warn gf-knock', role: 'alert', 'data-gf': 'knock' },
    h('div', null, h('b', null, label), ' opened your guest link. Let it in?'),
    h('div', { class: 'btns tight', style: 'margin-top:6px' }, button('Allow', () => { remove(); decide(true); }, 'primary'), button('Block', () => { remove(); decide(false); })));
  const remove = () => { if (gone) return; gone = true; clearTimeout(timer); t.remove(); };
  const timer = setTimeout(remove, GS_KNOCK_MS); // (no answer in 30 s counts as Block, on the server's side)
  host.append(t);
  return remove;
}

// ---------------------------------------------------------------- drawing

const CSS = `
.gf-state{display:flex;gap:8px;align-items:flex-start;margin:8px 0}.gf-dot{flex:0 0 10px;width:10px;height:10px;border-radius:50%;margin-top:6px;background:var(--faint,#888)}
.gf-dot.ok{background:var(--ok,#3ccf8e)}.gf-dot.warn{background:var(--warn,#f0b429)}.gf-dot.err{background:var(--err,#ff6b5b)}
.gf-link{width:100%;box-sizing:border-box;font:12px/1.35 ui-monospace,Consolas,monospace;padding:8px 10px;border-radius:8px;border:1px solid var(--line,#2c2f3d);background:var(--input,rgba(127,127,127,.08));color:var(--text,inherit)}
.gf-ask{padding:8px 10px;border-radius:10px;margin:8px 0;background:#2a2f3d;border-left:3px solid var(--warn,#f0b429)}
.gf-step{font-weight:700;margin-top:12px}.gf-viewer{padding:6px 0;border-top:1px solid var(--line,rgba(127,127,127,.2))}
.gf-set{margin-top:10px;border-top:1px solid var(--line,rgba(127,127,127,.2));padding-top:6px}.gf-ms{min-width:64px;text-align:right;font-variant-numeric:tabular-nums}
`;

/** Mount the card into `host`. It keeps itself up to date while it is on screen; `stop()` ends it earlier. */
export function mountGuestFeedCard(host: HTMLElement, env: GfEnv): GfHandle {
  if (typeof document !== 'undefined' && document.head && !document.getElementById('gf-style')) document.head.append(h('style', { id: 'gf-style' }, CSS));
  const dyn = h('div', { 'data-gf': 'status' });
  const set = h('div', { class: 'gf-set', 'data-gf': 'settings' });
  const C: Controller = new Controller(env, host, () => paint());
  let sig = '', linkOpen = false; // (the link stays open across redraws)

  // ---- settings: built once, synced from the view when the user is not touching them
  const qSel = h('select', { 'aria-label': 'Picture quality', onChange: () => void C.save({ q: asQuality((qSel as HTMLSelectElement).value) }) }, ...QUALITY_CHOICES.map(([q, l]) => h('option', { value: String(q) }, l))) as HTMLSelectElement;
  const delayVal = h('span', { class: 'gf-ms' }, delayLabel(0));
  let delayT: unknown = null;
  const delayIn = h('input', {
    type: 'range', min: '0', max: String(GS_DELAY_MAX_MS), step: String(GS_DELAY_STEP_MS), value: '0', 'aria-label': 'Delay my picture',
    onInput: () => { delayVal.textContent = delayLabel(clampDelay((delayIn as HTMLInputElement).value)); },
    onChange: () => { // (the server takes one change per half second: wait for the slider to settle)
      delayVal.textContent = delayLabel(clampDelay((delayIn as HTMLInputElement).value));
      const t = env.timer;
      // (a pending timer already holds one `dirty`: cancelling it keeps that one for the new timer, so the count stays balanced)
      if (delayT != null) { if (t) t.clear(delayT); else clearTimeout(delayT as ReturnType<typeof setTimeout>); } else C.dirty++;
      const go = () => { delayT = null; C.dirty--; void C.save({ delayMs: clampDelay((delayIn as HTMLInputElement).value) }); };
      delayT = t ? t.set(go, 600) : setTimeout(go, 600);
    },
  }) as HTMLInputElement;
  const nameIn = h('input', { type: 'text', maxlength: String(GS_NAME_MAX), placeholder: 'Optional', 'aria-label': 'Your name', autocomplete: 'off', onChange: () => void C.save({ name: sanitizeName((nameIn as HTMLInputElement).value) }) }) as HTMLInputElement;
  const offSel = h('select', { 'aria-label': 'Turn off by itself', onChange: () => void C.save({ autoOffMin: Number((offSel as HTMLSelectElement).value) }) }, ...GS_AUTO_OFF_MIN.map((m) => h('option', { value: String(m) }, autoOffLabel(m)))) as HTMLSelectElement;
  const row = (label: string, ctl: Node, hint: string) => h('label', { class: 'row', title: hint }, h('span', { class: 'lbl' }, label), ctl);
  set.append(
    row('Picture quality', qSel, 'Normal is 720p at 30 frames a second. 1080p is sharper and uses more of this PC.'),
    row('Delay my picture', h('span', { style: 'display:flex;gap:8px;align-items:center;flex:1' }, delayIn, delayVal), 'Holds your picture back in their OBS so your mouth lines up with your voice from Discord. Raise it until it matches.'),
    row('Your name', nameIn, 'Shown in their OBS while it connects, for example “Waiting for Hana’s PC…”.'),
    row('Turn off by itself', offSel, 'Turns the link off after nobody has watched for this long. It never turns off during a show.'));
  const syncSettings = (m: GfModel) => {
    if (!m.settings) return;
    const s = m.settings;
    if (C.dirty > 0) return; // (the user is changing something: don't put the old value back)
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    (qSel as HTMLSelectElement).value = String(s.q);
    (offSel as HTMLSelectElement).value = String(s.autoOffMin);
    if (active !== delayIn) { delayIn.value = String(s.delayMs); delayVal.textContent = delayLabel(s.delayMs); }
    if (active !== nameIn) nameIn.value = s.name;
  };

  // ---- the part that changes with the state
  const body = h('div');
  function paint() {
    const m = cardModel(C.view, { down: C.down });
    const s = JSON.stringify([m, C.busy]);
    set.style.display = m.settings ? '' : 'none';
    syncSettings(m);
    if (s === sig) return;
    sig = s;
    const dis = C.busy;
    const kids: (Node | null)[] = [h('div', { class: 'gf-state', role: 'status' }, h('span', { class: `gf-dot ${m.dot}` }), h('span', { 'data-gf': 'says' }, m.says))];
    if (m.warn) kids.push(h('p', { class: 'note', style: 'color:#f5c451' }, m.warn));
    const btns: HTMLElement[] = [];
    if (m.turnOn) btns.push(button('Turn on', () => void C.turnOn(), 'primary'));
    if (m.copy) btns.push(button('Copy link', () => void C.copyLink(), 'primary'));
    if (m.renew) btns.push(button('New link', () => void C.renew()));
    if (m.turnOff) btns.push(button('Turn off', () => void C.turnOff(), 'danger'));
    if (m.recheck) btns.push(button('Check again', () => void C.recheck()));
    for (const b of btns) if (dis) b.setAttribute('disabled', '');
    if (btns.length) kids.push(h('div', { class: 'btns' }, ...btns));
    if (m.url) kids.push(h('details', { open: linkOpen, onToggle: (e: Event) => { linkOpen = (e.target as HTMLDetailsElement).open; } }, h('summary', null, 'Show the link'), h('input', { class: 'gf-link', type: 'text', readonly: true, value: m.url, 'aria-label': 'Your guest link', 'data-gf': 'url', onClick: (e: Event) => (e.target as HTMLInputElement).select() })));
    if (m.knock) kids.push(h('div', { class: 'gf-ask', 'data-gf': 'knock' }, h('div', null, h('b', null, m.knock.label), ' — ', m.knock.prompt),
      h('div', { class: 'btns tight', style: 'margin-top:6px' }, button('Allow', () => void C.decide(m.knock!.kid, true), 'primary'), button('Block', () => void C.decide(m.knock!.kid, false)))));
    if (m.privacy) kids.push(h('p', { class: 'note', 'data-gf': 'privacy' }, m.privacy));
    if (m.viewers.length) kids.push(h('div', { class: 'gf-step' }, 'Watching now'), ...m.viewers.map((v) => h('div', { class: 'gf-viewer', 'data-gf': 'viewer' }, v.line)));
    if (m.offAtText) kids.push(h('p', { class: 'note' }, m.offAtText));
    if (m.steps.length) kids.push(h('div', { class: 'gf-step' }, 'Now they add it in OBS'), h('ol', { 'data-gf': 'steps' }, ...m.steps.map((t) => h('li', null, t))), ...m.notes.map((t) => h('p', { class: 'note' }, t)));
    body.replaceChildren(...kids.filter((x): x is Node => !!x));
  }

  host.append(h('section', { class: 'sec', 'data-key': 'be-a-guest-on-someone-elses-show', 'data-tut': 'guestfeed' },
    h('h3', { class: 'sec-h' }, GF_TITLE),
    h('p', { class: 'note' }, 'A friend runs a show in OBS and doesn’t use VTube Pro? Send them one link. They paste it into OBS and your avatar shows up on their stream with a see-through background, moving with your face. They install nothing. Your avatar file never leaves this PC.'),
    body, set,
    h('div', { class: 'btns tight' }, button('How does this work?', () => env.openHelp?.(), 'ghost'))));
  paint();
  C.start();
  return { refresh: (fresh) => C.refresh(fresh), stop: () => C.stop(), view: () => C.view, model: () => cardModel(C.view, { down: C.down }) };
}
