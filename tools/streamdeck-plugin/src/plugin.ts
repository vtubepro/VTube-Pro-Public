// VTube Pro — Stream Deck plugin (Stream Deck SDK v2, @elgato/streamdeck). docs/STREAM_DECK.md
//
// Three actions:
//   • "VTube Pro Page key" (com.vtubepro.deck.key): put it on every key. Each key shows whatever the layout in
//     VTube Pro → Stream Deck & controllers has at the same row / column, with live on / off state, and follows the
//     page keys (Next page / Previous page / Go to page) per device.
//   • "VTube Pro action" (com.vtubepro.deck.action): one fixed action picked in the property inspector.
//   • "VTube Pro Go Live" (com.vtubepro.deck.golive): ASKS the studio to go live. The key never starts a stream: the studio
//     shows a confirm card and the stream starts only if the person clicks Go Live now there within 10 seconds (docs/GO_LIVE.md).
// Both talk to the local VTube Pro server over ws://127.0.0.1:<port>/ws/deck (port 5191 unless changed in the inspector).
import streamDeck, { action, SingletonAction, type KeyAction, type KeyDownEvent, type SendToPluginEvent, type WillAppearEvent, type WillDisappearEvent, type DidReceiveSettingsEvent } from '@elgato/streamdeck';
import WebSocket from 'ws';
import { faceSvg, mapCoordinates, svgDataUrl, type Face } from './face.js';

type JsonObject = { [k: string]: any };
interface Resolved { name: string; cols: number; rows: number; pages: { name: string; keys: Face[] }[] }
interface ActionDef { id: string; label: string; group: string; icon: string; hint: string; params?: { key: string; label: string; type: string; options?: { value: string; label: string }[]; default?: string | number }[]; stateful?: boolean; local?: boolean }

// ---------------------------------------------------------------- link to VTube Pro
class Link {
  port = 5191;
  ws: WebSocket | null = null;
  online = false;
  resolved: Resolved | null = null;
  actions: ActionDef[] = [];
  live: JsonObject = {};
  private seq = 0;
  private waits = new Map<string, (r: { ok: boolean; error?: string }) => void>();
  private retry = 1000;
  onChange: () => void = () => {};

  start() {
    const ws = new WebSocket(`ws://127.0.0.1:${this.port}/ws/deck`);
    this.ws = ws;
    ws.on('open', () => { this.online = true; this.retry = 1000; });
    ws.on('message', (data) => {
      let m: JsonObject; try { m = JSON.parse(String(data)); } catch { return; }
      if (m.t === 'hello') { this.actions = m.actions; this.resolved = m.resolved; this.live = m.live; }
      else if (m.t === 'layout') this.resolved = m.resolved;
      else if (m.t === 'state') { this.resolved = m.resolved; this.live = m.live; }
      else if (m.t === 'result' && m.id) { this.waits.get(m.id)?.({ ok: !!m.ok, error: m.error }); this.waits.delete(m.id); return; }
      this.onChange();
    });
    const down = () => {
      if (this.ws !== ws) return;
      this.ws = null; this.online = false; this.onChange();
      setTimeout(() => this.start(), this.retry); this.retry = Math.min(10_000, this.retry * 2); // never gives up: VTube Pro may start later
    };
    ws.on('close', down);
    ws.on('error', () => { try { ws.close(); } catch { /* */ } });
  }
  restart(port: number) { this.port = port; const w = this.ws; this.ws = null; try { w?.close(); } catch { /* */ } this.start(); }
  send(m: JsonObject): Promise<{ ok: boolean; error?: string }> {
    if (!this.ws || !this.online) return Promise.resolve({ ok: false, error: 'VTube Pro is not running' });
    const id = String(++this.seq);
    this.ws.send(JSON.stringify({ ...m, id }));
    return new Promise((res) => { this.waits.set(id, res); setTimeout(() => { if (this.waits.delete(id)) res({ ok: false, error: 'timeout' }); }, 4000); });
  }
}
const link = new Link();

const draw = (a: KeyAction<JsonObject>, f: Face | null, offline: boolean) =>
  Promise.all([a.setImage(svgDataUrl(faceSvg(f, 144, { offline }))), a.setTitle('')]).catch(() => {});

// ---------------------------------------------------------------- the page mirror
type PageSettings = { page?: number | 'follow' };
const devicePage = new Map<string, number>();

@action({ UUID: 'com.vtubepro.deck.key' })
class PageKey extends SingletonAction<PageSettings> {
  private coords = new Map<string, { column: number; row: number } | undefined>();
  private settings = new Map<string, PageSettings>();

  private pageFor(id: string, dev: string) {
    const s = this.settings.get(id), n = link.resolved?.pages.length ?? 1;
    const p = typeof s?.page === 'number' ? s.page - 1 : devicePage.get(dev) ?? 0;
    return Math.min(Math.max(0, p), Math.max(0, n - 1));
  }
  private faceOf(id: string, dev: string): { face: Face | null; page: number; index: number } {
    const r = link.resolved, page = this.pageFor(id, dev);
    if (!r) return { face: null, page, index: -1 };
    const index = mapCoordinates(r, this.coords.get(id));
    return { face: index >= 0 ? r.pages[page]?.keys[index] ?? null : null, page, index };
  }
  redraw() {
    for (const a of this.actions) if (a.isKey()) draw(a, this.faceOf(a.id, a.device.id).face, !link.online);
  }
  override onWillAppear(ev: WillAppearEvent<PageSettings>) {
    if (!ev.action.isKey()) return;
    this.coords.set(ev.action.id, ev.action.coordinates);
    this.settings.set(ev.action.id, ev.payload.settings ?? {});
    draw(ev.action, this.faceOf(ev.action.id, ev.action.device.id).face, !link.online);
  }
  override onWillDisappear(ev: WillDisappearEvent<PageSettings>) { this.coords.delete(ev.action.id); this.settings.delete(ev.action.id); }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<PageSettings>) { this.settings.set(ev.action.id, ev.payload.settings ?? {}); this.redraw(); }
  override async onKeyDown(ev: KeyDownEvent<PageSettings>) {
    const dev = ev.action.device.id, { face, page, index } = this.faceOf(ev.action.id, dev);
    if (!face?.a) return;
    const def = link.actions.find((x) => x.id === face.a);
    if (def?.local) {
      // page keys are handled here, per device
      const n = link.resolved?.pages.length ?? 1, cur = devicePage.get(dev) ?? 0;
      devicePage.set(dev, face.a === 'page-next' ? (cur + 1) % n : face.a === 'page-prev' ? (cur - 1 + n) % n : Math.min(n - 1, Math.max(0, face.go ?? 0)));
      this.redraw();
      return;
    }
    const r = await link.send({ t: 'press', page, index });
    (r.ok ? ev.action.showOk() : ev.action.showAlert()).catch(() => {});
    if (!r.ok) streamDeck.logger.warn(`press ${page}/${index}: ${r.error}`);
  }
  override onSendToPlugin(ev: SendToPluginEvent<JsonObject, PageSettings>) { handlePi(ev.payload); }
}
// ---------------------------------------------------------------- one fixed action
type OneSettings = { action?: string; params?: JsonObject; title?: string };
@action({ UUID: 'com.vtubepro.deck.action' })
class OneAction extends SingletonAction<OneSettings> {
  private settings = new Map<string, OneSettings>();
  private face(s: OneSettings): Face | null {
    const def = link.actions.find((x) => x.id === s.action);
    if (!def) return { a: 'x', title: 'Pick an action', icon: '⚙️', color: '#1d2230', on: null };
    return { a: def.id, title: s.title || def.label, icon: def.icon, color: '#1d2230', on: def.stateful ? isOn(def, s.params ?? {}) : null };
  }
  redraw() { for (const a of this.actions) if (a.isKey()) draw(a, this.face(this.settings.get(a.id) ?? {}), !link.online); }
  override onWillAppear(ev: WillAppearEvent<OneSettings>) { this.settings.set(ev.action.id, ev.payload.settings ?? {}); if (ev.action.isKey()) draw(ev.action, this.face(ev.payload.settings ?? {}), !link.online); }
  override onWillDisappear(ev: WillDisappearEvent<OneSettings>) { this.settings.delete(ev.action.id); }
  override onDidReceiveSettings(ev: DidReceiveSettingsEvent<OneSettings>) { this.settings.set(ev.action.id, ev.payload.settings ?? {}); this.redraw(); }
  override async onKeyDown(ev: KeyDownEvent<OneSettings>) {
    const s = this.settings.get(ev.action.id) ?? ev.payload.settings ?? {};
    if (!s.action) { ev.action.showAlert().catch(() => {}); return; }
    const r = await link.send({ t: 'run', action: s.action, params: s.params ?? {} });
    (r.ok ? ev.action.showOk() : ev.action.showAlert()).catch(() => {});
  }
  override onSendToPlugin(ev: SendToPluginEvent<JsonObject, OneSettings>) { handlePi(ev.payload); }
}
/** Mirror of shared/deck.ts keyActive for the fixed action (the live state comes from the server). */
function isOn(def: ActionDef, p: JsonObject): boolean | null {
  const L = link.live, P = (k: string) => String(p[k] ?? def.params?.find((x) => x.key === k)?.default ?? '');
  switch (def.id) {
    case 'lighting': return L.lighting === (P('state') || 'show');
    case 'mode': return L.mode === P('mode');
    case 'room': return (L.sceneId ?? '') === P('sceneId');
    case 'cover': return !!L.cover;
    case 'chat-hide': return P('on') === 'false' ? !(L as JsonObject).chatHidden : !!(L as JsonObject).chatHidden;
    case 'camera-move': return Math.abs(Number((L as JsonObject).camMove ?? 1.2) - (Number(P('secs')) || 0)) < 0.051;
    case 'video': return !!L.videoOn;
    case 'video-audio': return !!L.videoAudio;
    case 'weather': return L.weather === P('weather');
    case 'raid': return !!L.raid;
    case 'hub-tts': return !!L.tts;
  }
  return null;
}

// ---------------------------------------------------------------- Go Live (ask only)
/** Same number as DECK_CONFIRM_MS in shared/broadcastTypes.ts (tools/golive_guard_unit.ts checks that they match). */
const GOLIVE_CONFIRM_MS = 10_000;
const GOLIVE_ACTION = 'golive';
@action({ UUID: 'com.vtubepro.deck.golive' })
class GoLiveKey extends SingletonAction<JsonObject> {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private face(state: 'idle' | 'asked' | 'offline' | 'refused'): Face {
    const t = state === 'asked' ? 'Confirm on screen' : state === 'refused' ? 'Open VTube Pro' : 'Go Live';
    return { a: GOLIVE_ACTION, title: t, icon: state === 'asked' ? '⏳' : '🔴', color: state === 'asked' ? '#7a4b00' : '#1d2230', on: state === 'asked' ? true : null };
  }
  private show(a: KeyAction<JsonObject>, state: 'idle' | 'asked' | 'offline' | 'refused') { draw(a, this.face(state), state === 'offline'); }
  redraw() { for (const a of this.actions) if (a.isKey() && !this.timers.has(a.id)) this.show(a, link.online ? 'idle' : 'offline'); }
  override onWillAppear(ev: WillAppearEvent<JsonObject>) { if (ev.action.isKey()) this.show(ev.action, link.online ? 'idle' : 'offline'); }
  override onWillDisappear(ev: WillDisappearEvent<JsonObject>) { const t = this.timers.get(ev.action.id); if (t) clearTimeout(t); this.timers.delete(ev.action.id); }
  override async onKeyDown(ev: KeyDownEvent<JsonObject>) {
    if (!ev.action.isKey()) return;
    const key = ev.action;
    const r = await link.send({ t: 'run', action: GOLIVE_ACTION });   // asks only; there is no way to start from here
    if (!r.ok) { key.showAlert().catch(() => {}); this.show(key, 'refused'); this.rest(key, 4000); return; }
    this.show(key, 'asked');
    this.rest(key, GOLIVE_CONFIRM_MS);                                // no click on screen = nothing happened; the key goes back
  }
  private rest(key: KeyAction<JsonObject>, ms: number) {
    const old = this.timers.get(key.id); if (old) clearTimeout(old);
    this.timers.set(key.id, setTimeout(() => { this.timers.delete(key.id); this.show(key, link.online ? 'idle' : 'offline'); }, ms));
  }
}

// ---------------------------------------------------------------- property inspector messages
function handlePi(m: JsonObject) {
  if (m?.t === 'getActions') streamDeck.ui.sendToPropertyInspector({ t: 'actions', actions: link.actions as any, online: link.online, port: link.port, pages: link.resolved?.pages.length ?? 0 }).catch(() => {});
  else if (m?.t === 'setPort' && Number.isInteger(m.port) && m.port > 0 && m.port < 65536) {
    streamDeck.settings.setGlobalSettings({ port: m.port }).catch(() => {});
    link.restart(m.port);
  }
}

const pageKey = new PageKey(), oneAction = new OneAction(), goLiveKey = new GoLiveKey();
link.onChange = () => { pageKey.redraw(); oneAction.redraw(); goLiveKey.redraw(); };
streamDeck.actions.registerAction(pageKey);
streamDeck.actions.registerAction(oneAction);
streamDeck.actions.registerAction(goLiveKey);
streamDeck.connect().then(async () => {
  try { const g = await streamDeck.settings.getGlobalSettings<{ port?: number }>(); if (Number.isInteger(g.port)) link.port = g.port!; } catch { /* default port */ }
  link.start();
});
