// Scene tab → "DJ sync": lock the room's lights to the DJ's gear / software, with zero effort.
// One button turns it on; the helper (server/music) then listens for everything it knows (Ableton Link via Carabiner,
// Pioneer CDJs, Denon / Engine players, VirtualDJ, OSC tools, DJ controllers, a DMX light show) and the best source wins
// by itself (shared/musicClock.ts). This panel shows the live clock, what was found (one plain sentence + one fix per
// row), the manual fallbacks (tap, "this is beat 1", lights earlier / later) and the opt-ins. It also forwards the
// browser's Web MIDI to the helper (the OBS page can't read MIDI), never sending anything to the controller.
// Mounted by src/ui/scenePanel.ts (one line).
import type { App } from '../app.ts';
import type { MusicClock, SourceStatusRow } from '../../shared/musicClock.ts';
import { button, h, section, slider, toast, toggle } from './dom.ts';
import { djTrackBoot, trackLibraryEl } from './djTrackPanel.ts';

interface AdapterRow { id: string; label: string; state: 'off' | 'starting' | 'listening' | 'connected' | 'error' | 'unavailable'; says: string; found: string[]; rate?: number; extra?: Record<string, unknown> }
interface Config {
  enabled: boolean; adapters: Record<string, boolean>; prolinkTrackInfo: boolean; os2lPort: number; oscPort: number; traktorPort: number;
  mdns: boolean; artnet: boolean; sacn: boolean; dmxUniverses: number[]; artnetPollReply: boolean; autoLatency: boolean; manualMs: number;
  appsListen: string; phraseFrom: string; midiPorts: string[];
}
interface View { config: Config; adapters: AdapterRow[]; sources: SourceStatusRow[]; clock: MusicClock | null; audio: boolean; tap: boolean; loopbackOnly: boolean; carabiner?: 'found' | 'missing'; ifaces?: { name: string; address: string }[] }

const CARABINER_URL = 'https://github.com/Deep-Symmetry/carabiner/releases';
const CSS = `
.dj-card { border:1px solid var(--line); border-radius:12px; background:var(--card); padding:10px 12px; margin:4px 0 10px; }
.dj-src { display:flex; align-items:center; gap:7px; font-size:12px; color:var(--dim); min-height:16px; }
.dj-src b { color:var(--text); font-weight:650; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.dj-dot { width:9px; height:9px; border-radius:50%; background:var(--faint); flex:none; }
.dj-dot.ok { background:var(--ok); box-shadow:0 0 7px var(--ok); } .dj-dot.warn { background:var(--warn); } .dj-dot.err { background:var(--err); }
.dj-main { display:flex; align-items:flex-end; justify-content:space-between; gap:10px; margin:6px 0 4px; }
.dj-bpm { font: 700 34px/1 ui-monospace, Consolas, monospace; letter-spacing:-.02em; }
.dj-bpm small { font-size:12px; font-weight:600; color:var(--dim); margin-left:4px; letter-spacing:0; }
.dj-beats { display:flex; gap:6px; padding-bottom:4px; }
.dj-beats i { width:16px; height:16px; border-radius:50%; background:var(--card3); border:1px solid var(--line2); transition: background 40ms, box-shadow 40ms; }
.dj-beats i.on { background:var(--accent2); border-color:transparent; box-shadow:0 0 10px var(--accent2); }
.dj-beats i.on.down { background:var(--pink); box-shadow:0 0 12px var(--pink); }
.dj-phrase { display:flex; align-items:center; gap:8px; font-size:12px; margin-top:6px; min-height:20px; }
.dj-sec { font-size:10.5px; font-weight:800; letter-spacing:.08em; text-transform:uppercase; padding:2px 7px; border-radius:99px; background:var(--card3); color:var(--dim); }
.dj-sec.build { background:var(--warn-soft); color:var(--warn); } .dj-sec.drop { background:var(--err-soft); color:var(--err); } .dj-sec.breakdown { background:var(--accent2-soft); color:var(--accent2); } .dj-sec.groove, .dj-sec.intro, .dj-sec.outro { background:var(--accent-soft); color:var(--accent); }
.dj-bar { flex:1; height:6px; border-radius:99px; background:var(--card3); overflow:hidden; } .dj-bar i { display:block; height:100%; width:0; background:linear-gradient(90deg, var(--warn), var(--err)); }
.dj-track { font-size:12px; color:var(--text); margin-top:6px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-height:15px; }
.dj-track span { color:var(--dim); }
.dj-lat { font-size:11.5px; color:var(--faint); margin-top:4px; min-height:14px; }
.dj-rows { display:flex; flex-direction:column; gap:6px; margin:6px 0 8px; }
.dj-row { display:grid; grid-template-columns: 12px 1fr; gap:4px 8px; align-items:start; padding:7px 9px; border:1px solid var(--line); border-radius:10px; background:var(--card); }
.dj-row .dj-dot { margin-top:4px; }
.dj-row .t { font-weight:650; font-size:12.5px; }
.dj-row .s { grid-column:2; color:var(--dim); font-size:12px; line-height:1.35; }
.dj-row .f { grid-column:2; display:flex; flex-wrap:wrap; gap:4px; }
.dj-row .f span { font-size:11px; padding:1px 7px; border-radius:99px; background:var(--card2); color:var(--text); border:1px solid var(--line); }
.dj-row .a { grid-column:2; display:flex; flex-wrap:wrap; gap:6px; margin-top:2px; }
.dj-row.off { opacity:.62; }
.dj-tip { border:1px dashed var(--line2); border-radius:10px; padding:8px 10px; font-size:12px; line-height:1.45; color:var(--dim); margin:4px 0 10px; }
.dj-tip b { color:var(--text); }
.dj-tap { display:grid; grid-template-columns: 1fr 1fr; gap:6px; margin:4px 0 6px; }
.dj-tap button { padding:12px 6px; font-weight:700; }
.dj-hero { text-align:center; padding:6px 4px 2px; }
.dj-hero p { color:var(--dim); font-size:12.5px; line-height:1.45; margin:6px 0 10px; }
.dj-hero .btn.primary { padding:10px 18px; font-size:14px; }
.dj-small { font-size:11.5px; color:var(--faint); line-height:1.4; }
`;
let cssDone = false;

// ---------------------------------------------------------------- helper API (module state survives re-renders)
let view: View | undefined;     // undefined = loading
let lastErr = '';
let body: HTMLElement | null = null;
let card: HTMLElement | null = null;
let poll = 0, anim = 0;
let live: { c: MusicClock; at: number } | null = null;
let busOff: (() => void) | null = null;
let readOnly = false;
let observerTab = false;
let trackApp: App | null = null;

async function api<T>(method: string, path: string, data?: unknown, click = false): Promise<T> {
  const r = await fetch(`/api/music${path}`, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...(click ? { 'x-vtp-user-action': '1' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error || `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
async function refresh() {
  try { view = await api<View>('GET', ''); lastErr = ''; }
  catch { lastErr = 'VTube Pro isn’t answering right now.'; }
  if (view && !readOnly && !observerTab) void midi.apply(view.config.enabled, view.config.midiPorts ?? []);
  renderBody();
}
async function patch(p: Partial<Config> | Record<string, unknown>) {
  if (readOnly) { toast('This is a test tab: DJ sync settings are read-only here.', 'warn'); return; }
  try { view = await api<View>('PUT', '', p); if (!observerTab) void midi.apply(view.config.enabled, view.config.midiPorts ?? []); renderBody(); } catch (e) { toast(`DJ sync: ${(e as Error).message}`, 'err'); }
}

// ---------------------------------------------------------------- Web MIDI → helper (controllers + MIDI clock)
// Opens ONLY the inputs the user picked, and only while DJ sync is on (on older Windows the app that opens a MIDI
// port first owns it: we must never grab the DJ's controller just because the studio started before rekordbox).
const MIDI_KEY = 'vtp.djsync.midi';
class MidiForward {
  private ws: WebSocket | null = null;
  private q = new Map<string, [number, number, number, number][]>();
  private busy: string[] = [];
  private timer = 0;
  private want = new Set<string>();
  private on = false;
  private opened = new Map<string, MIDIInput>();
  access: MIDIAccess | null = null;
  /** Input names the browser sees (after access was given). */
  ports: string[] = [];
  error = '';
  get started() { return !!this.access; }
  /** Ask the browser for MIDI (a click: it may prompt once). Lists the inputs; opens nothing by itself. */
  async allow(ask: boolean): Promise<boolean> {
    if (this.access) return true;
    if (!('requestMIDIAccess' in navigator)) { this.error = 'This browser can’t read MIDI. Use Chrome or Edge for the studio.'; return false; }
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });   // (never SysEx: nothing can be sent to the controller)
      this.error = '';
      try { localStorage.setItem(MIDI_KEY, '1'); } catch { /* storage off */ }
      this.access.onstatechange = () => this.bind();
      this.bind();
      return true;
    } catch (e) {
      if (ask) this.error = (e as Error).name === 'SecurityError' || (e as Error).name === 'NotAllowedError' ? 'The browser said no to MIDI. Click the lock icon in the address bar → allow MIDI devices, then try again.' : `MIDI didn’t start: ${(e as Error).message}`;
      return false;
    }
  }
  /** Follow the helper's settings: DJ sync on + the picked ports → those are open; anything else → closed. */
  async apply(enabled: boolean, picked: string[]) {
    this.on = enabled; this.want = new Set(picked);
    const need = enabled && picked.length > 0;
    if (need && !this.access) {
      let allowed = false; try { allowed = localStorage.getItem(MIDI_KEY) === '1'; } catch { /* storage off */ }
      if (!allowed || !(await this.allow(false))) return;
    }
    this.bind();
    if (need && !this.ws) this.connect();
    if (need && !this.timer) this.timer = window.setInterval(() => this.flush(), 10);
    if (!need && this.timer) { clearInterval(this.timer); this.timer = 0; this.q.clear(); }
  }
  private bind() {
    const a = this.access; if (!a) return;
    this.ports = [];
    this.busy = [];
    const seen = new Set<string>();
    for (const input of a.inputs.values()) {
      const name = input.name || input.id;
      this.ports.push(name); seen.add(name);
      const use = this.on && this.want.has(name);
      if (!use) {
        if (this.opened.has(name)) { input.onmidimessage = null; void input.close().catch(() => {}); this.opened.delete(name); }
        continue;
      }
      if (this.opened.has(name)) continue;
      this.opened.set(name, input);
      input.onmidimessage = (e: MIDIMessageEvent) => {
        const d = e.data; if (!d || !d.length) return;
        const t = performance.timeOrigin + e.timeStamp;
        let list = this.q.get(name); if (!list) { list = []; this.q.set(name, list); }
        if (list.length < 512) list.push([t, d[0], d[1] ?? 0, d[2] ?? 0]);
      };
      input.open().catch(() => { this.busy.push(name); this.sendBusy(); });
    }
    for (const n of [...this.opened.keys()]) if (!seen.has(n)) this.opened.delete(n);
  }
  private connect() {
    try {
      const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/music`);
      ws.onclose = () => { if (this.ws === ws) { this.ws = null; if (this.on && this.want.size) setTimeout(() => { if (!this.ws) this.connect(); }, 3000); } };
      ws.onopen = () => this.sendBusy();
      this.ws = ws;
    } catch { /* retried by onclose */ }
  }
  private sendBusy() { if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'midi', port: '', m: [], busy: this.busy })); }
  private flush() {
    if (!this.q.size || this.ws?.readyState !== WebSocket.OPEN) { if (this.q.size > 8) this.q.clear(); return; }
    for (const [port, m] of this.q) this.ws.send(JSON.stringify({ type: 'midi', port, m }));
    this.q.clear();
  }
}
const midi = new MidiForward();

// ---------------------------------------------------------------- the live clock card (updated ~20 times a second)
function cardEl(): HTMLElement {
  if (card) return card;
  const dots = h('div', { class: 'dj-beats', 'aria-hidden': 'true' }, h('i'), h('i'), h('i'), h('i'));
  const src = h('div', { class: 'dj-src' }, h('span', { class: 'dj-dot' }), h('b', null, '…'));
  const bpm = h('div', { class: 'dj-bpm' }, '—', h('small', null, 'BPM'));
  const sec = h('span', { class: 'dj-sec' }, '');
  const prog = h('i');
  const phrase = h('div', { class: 'dj-phrase' }, sec, h('span', { class: 'ph' }, ''), h('div', { class: 'dj-bar' }, prog));
  const track = h('div', { class: 'dj-track' }, '');
  const lat = h('div', { class: 'dj-lat' }, '');
  card = h('div', { class: 'dj-card', 'data-tick': '1', role: 'status', 'aria-live': 'off' }, src, h('div', { class: 'dj-main' }, bpm, dots), phrase, track, lat);
  const draw = () => {
    if (!card?.isConnected) { anim = 0; return; }
    anim = requestAnimationFrame(draw);
    const now = performance.timeOrigin + performance.now();
    const c = live && now - live.at < 1500 ? live.c : null;
    const v = view;
    const dot = src.firstElementChild as HTMLElement, name = src.lastElementChild as HTMLElement;
    let label: string, cls: string;
    if (c && c.src !== 'audio') { label = `Following ${c.srcName}`; cls = c.on ? 'ok' : 'warn'; }
    else if (c) { label = 'Following your music input (no DJ gear found yet)'; cls = 'warn'; }
    else if (v?.audio) { label = 'Your music input drives the lights — DJ gear takes over when found'; cls = 'warn'; }
    else { label = 'Waiting for DJ gear, a DJ app or music'; cls = ''; }
    if (name.textContent !== label) name.textContent = label;
    dot.className = `dj-dot ${cls}`;
    const bpmTxt = c && c.bpm > 0 ? c.bpm.toFixed(1) : '—';
    if (bpm.firstChild!.textContent !== bpmTxt) bpm.firstChild!.textContent = bpmTxt;
    // beat dots: extrapolate the clock to now
    const beat = c && c.bpm > 0 ? c.beat + (c.on ? (now - live!.at) * c.bpm / 60000 : 0) : NaN;
    const inBar = Number.isFinite(beat) ? ((c!.bar + Math.floor(beat) - Math.floor(c!.beat)) % 4 + 4) % 4 : -1;
    const ph = Number.isFinite(beat) ? beat - Math.floor(beat) : 1;
    [...dots.children].forEach((d, i) => { const on = i === inBar && ph < 0.35; d.classList.toggle('on', on); d.classList.toggle('down', i === 0); });
    // phrase + drop countdown
    const p = c?.phrase;
    const s = c?.sec ?? null;
    sec.textContent = s ? s : '';
    sec.className = `dj-sec ${s ?? ''}`;
    sec.style.display = s ? '' : 'none';
    const el = c && c.on && c.bpm > 0 ? (now - live!.at) * c.bpm / 60000 : 0;
    const drop = p?.dropIn !== undefined ? Math.max(0, p.dropIn - el) : undefined;
    const nextIn = p?.nextIn !== undefined ? Math.max(0, p.nextIn - el) : undefined;
    const phTxt = drop !== undefined && drop > 0.5 ? `drop in ${Math.ceil(drop)} beats`
      : nextIn !== undefined && nextIn > 0.5 && p?.next ? `${p.next} in ${Math.ceil(nextIn)} beats`
      : p?.known ? ''                                              // (the section chip says it)
      : p && c?.src === 'audio' ? 'sections from the audio'
      : !p && c && c.src !== 'audio' && c.on ? 'no phrase info from this source' : '';
    const phEl = phrase.children[1] as HTMLElement;
    if (phEl.textContent !== phTxt) phEl.textContent = phTxt;
    const frac = p?.known && p.len > 0 ? Math.min(1, (p.pos + el) / p.len) : 0;
    prog.style.width = `${(frac * 100).toFixed(1)}%`;
    (phrase.children[2] as HTMLElement).style.visibility = p?.known && p.len > 0 ? 'visible' : 'hidden';
    const tr = c?.track;
    const nPlaying = c?.decks?.filter((d) => d.playing).length ?? 0;
    const trTxt = tr?.title ? `♪ ${tr.title}${tr.artist ? ` — ${tr.artist}` : ''}` : nPlaying ? `${nPlaying} deck${nPlaying === 1 ? '' : 's'} playing` : '';
    if (track.textContent !== trTxt) track.textContent = trTxt;
    const cal = v?.sources.find((r) => r.owner)?.calib;
    const latTxt = !c || c.src === 'audio' ? '' : cal?.state === 'locked' ? `In sync with your audio (${c.latMs >= 0 ? '+' : ''}${c.latMs} ms, measured)` : v?.audio ? 'Measuring the delay from your music input…' : v?.config.manualMs ? `Lights shifted ${v.config.manualMs} ms by hand` : 'Turn on a music input (Lights, above) and the delay is measured for you.';
    if (lat.textContent !== latTxt) lat.textContent = latTxt;
  };
  if (!anim) anim = requestAnimationFrame(draw);
  return card;
}

// ---------------------------------------------------------------- rows
/** Short names for the "also listening for" line. */
const QUIET: Record<string, string> = { link: 'Ableton Link', prolink: 'Pioneer CDJs', stagelinq: 'Denon / Engine players', os2l: 'VirtualDJ', osc: 'OSC tools', midi: 'DJ controllers', artnet: 'DMX light shows', traktor: 'Traktor deck data' };
const DOT: Record<AdapterRow['state'], string> = { off: '', starting: '', listening: '', connected: 'ok', error: 'err', unavailable: 'warn' };
function adapterRow(a: AdapterRow, v: View): HTMLElement {
  const acts: HTMLElement[] = [];
  if (a.id === 'link' && a.state !== 'connected') {
    if (v.carabiner === 'found') acts.push(button('Start Carabiner', () => void api<{ ok: boolean; says: string }>('POST', '/carabiner/start', {}, true).then((r) => toast(r.says, r.ok ? 'ok' : 'warn')).catch((e) => toast(String(e), 'err')), 'primary'));
    else acts.push(h('a', { class: 'btn', href: CARABINER_URL, target: '_blank', rel: 'noopener' }, 'Get Carabiner (free)'));
  }
  if (a.id === 'midi' && !readOnly) {
    // the user picks the controller: only that port is ever opened (and only while DJ sync is on)
    const picked = v.config.midiPorts ?? [];
    if (!midi.started) acts.push(button('Find my controller', () => void midi.allow(true).then(() => renderBody(true))));
    else if (midi.error) acts.push(h('span', { class: 'dj-small' }, midi.error));
    else if (!midi.ports.length) acts.push(h('span', { class: 'dj-small' }, 'No MIDI device is plugged in.'));
    for (const name of midi.ports.slice(0, 8)) {
      const on = picked.includes(name);
      acts.push(button(on ? `✓ ${name}` : `Use ${name}`, () => void patch({ midiPorts: on ? picked.filter((x) => x !== name) : [...picked, name] }), on ? 'primary' : ''));
    }
    for (const name of picked.filter((x) => !midi.ports.includes(x))) acts.push(h('span', { class: 'dj-small' }, `${name} (not plugged in)`));
  }
  if (a.id === 'prolink' && (a.state === 'connected' || v.config.prolinkTrackInfo)) {
    const t = toggle('Track names + drop countdown', v.config.prolinkTrackInfo, (on) => void patch({ prolinkTrackInfo: on }), 'Says hello on the DJ network as a virtual player (#7 or higher — never a real player number) so the players share their track info and rekordbox phrases. It never controls anything.');
    acts.push(t);
  }
  const shown = a.state === 'off' ? (v.config.adapters[a.id] === false ? 'Turned off.' : a.says) : a.says;
  return h('div', { class: `dj-row ${a.state === 'off' ? 'off' : ''}`, 'data-ad': a.id },
    h('span', { class: `dj-dot ${DOT[a.state]}` }), h('span', { class: 't' }, a.label),
    h('div', { class: 's' }, shown),
    a.found.length ? h('div', { class: 'f' }, ...a.found.slice(0, 6).map((f) => h('span', null, f))) : null,
    acts.length ? h('div', { class: 'a' }, ...acts) : null);
}

function tipFor(v: View): HTMLElement | null {
  const live = (id: string) => v.adapters.find((a) => a.id === id)?.state === 'connected';
  if (live('prolink') || live('stagelinq') || live('os2l') || (live('link') && (v.adapters.find((a) => a.id === 'link')?.extra?.peers as number) > 0)) return null;
  return h('div', { class: 'dj-tip' },
    h('b', null, 'rekordbox + a DDJ controller? '), 'In rekordbox open Preferences, turn on ', h('b', null, 'Ableton Link'), ' (in newer versions under Extensions / Advanced), then click ', h('b', null, 'LINK'), ' at the top of rekordbox. Then start Carabiner (the free Link helper above). ',
    h('br'), h('b', null, 'Traktor, Serato, djay: '), 'turn on Ableton Link the same way. ', h('b', null, 'VirtualDJ'), ' and ', h('b', null, 'CDJs / Denon players'), ' on your network are found by themselves. ',
    h('br'), 'Nothing to connect? The ', h('b', null, 'music input'), ' (Lights, above) keeps the show in time on its own.');
}

let lastSig = '';
function renderBody(force = false) {
  if (!body) return;
  const v = view;
  // rebuild only when something shown changes (a button replaced under the pointer would swallow the click)
  const sig = JSON.stringify([v === undefined ? 0 : [v.config, v.adapters.map((a) => [a.id, a.state, a.says, a.found, a.id === 'link' ? a.extra?.peers ?? 0 : 0]), v.tap, v.loopbackOnly, v.carabiner, v.ifaces], lastErr, readOnly, midi.started, midi.error, midi.ports]);
  if (!force && sig === lastSig && body.childElementCount) return;
  lastSig = sig;
  const kids: (HTMLElement | null)[] = [];
  if (v === undefined) kids.push(h('p', { class: 'note' }, lastErr || 'Checking…'));
  else if (!v.config.enabled) {
    kids.push(h('div', { class: 'dj-hero' },
      h('p', null, 'Lock the room’s lights, beams and drops to the DJ’s decks: rekordbox, Traktor, Serato, VirtualDJ, Pioneer CDJs, Denon players and DJ controllers. VTube Pro finds them by itself and picks the best one.'),
      button('Turn on DJ sync', () => void patch({ enabled: true }), 'primary'),
      h('p', { class: 'dj-small' }, 'It only listens: it never controls your decks, mixer or controller, and never touches your audio.')));
  } else {
    kids.push(cardEl());
    // rows: what is connected, what needs a fix; everything still just listening folds into one quiet line
    const enabled = v.adapters.filter((a) => v.config.adapters[a.id] !== false);
    const djLive = enabled.some((a) => a.state === 'connected' && a.id !== 'midi' && a.id !== 'artnet');
    const shownRow = (a: AdapterRow) => a.state === 'connected' || a.state === 'error'
      || (a.id === 'link' && a.state === 'unavailable' && !djLive)
      || (a.id === 'midi' && !readOnly);
    const order = (a: AdapterRow) => (a.state === 'connected' ? 0 : a.state === 'error' ? 1 : 2);
    const rows = enabled.filter(shownRow).sort((a, b) => order(a) - order(b));
    const quiet = enabled.filter((a) => !shownRow(a) && a.state !== 'off');
    kids.push(h('div', { class: 'dj-rows' }, ...rows.map((a) => adapterRow(a, v)),
      quiet.length ? h('div', { class: 'dj-small', 'data-ad': 'quiet' }, `${rows.length ? 'Also listening' : 'Listening'} for: ${quiet.map((a) => QUIET[a.id] ?? a.label).join(', ')}.`) : null));
    kids.push(tipFor(v));
    // manual fallbacks
    const tapBtn = button(v.tap ? 'Tap (tapping)' : 'Tap the beat', () => void api<{ bpm: number | null; taps: number }>('POST', '/tap', { t: performance.timeOrigin + performance.now() }).then((r) => { tapBtn.textContent = r.bpm ? `Tap · ${r.bpm.toFixed(1)}` : `Tap (${r.taps}/4)`; }).catch(() => {}));
    tapBtn.title = 'Tap along with the kick: after 4 taps the show follows your tempo (DJ gear still wins when it is there)';
    const oneBtn = button('This is beat 1', () => void api('POST', '/downbeat', { t: performance.timeOrigin + performance.now() }).then(() => toast('Got it: bars start here.', 'ok')).catch(() => {}));
    oneBtn.title = 'Press exactly on the first beat of a bar if the drops land on the wrong beat';
    kids.push(h('div', { class: 'dj-tap' }, tapBtn, oneBtn));
    if (v.tap) kids.push(h('div', { class: 'btns tight' }, button('Stop following my taps', () => void api('POST', '/tap/clear', {}).then(refresh))));
    if (trackApp) kids.push(trackLibraryEl(trackApp));   // Track library: light shows built per track (src/ui/djTrackPanel.ts)
    kids.push(toggle('Measure the delay automatically', v.config.autoLatency, (on) => void patch({ autoLatency: on }), 'Compares the DJ’s beats with the kicks your music input hears and shifts the lights to match — no sound is ever played'));
    kids.push(slider('Lights earlier / later (ms)', v.config.manualMs, -250, 250, 5, (ms) => void patch({ manualMs: Math.round(ms) }), '+ = later. Only if the lights still feel off after the automatic measurement.', { def: 0, hard: [-500, 500] }));
    // more settings
    const tg = (id: string, label: string, hint: string) => toggle(label, v.config.adapters[id] !== false, (on) => void patch({ adapters: { [id]: on } }), hint);
    const isWin = /Windows/i.test(navigator.userAgent);
    kids.push(h('details', null, h('summary', null, 'More DJ sync settings'),
      tg('link', 'Ableton Link (Carabiner)', 'rekordbox performance mode, Traktor, Serato, djay, Engine DJ'),
      tg('prolink', 'Pioneer CDJ / XDJ network', 'Pro DJ Link: CDJs, XDJs, DJM mixers, rekordbox in export mode'),
      tg('stagelinq', 'Denon / Engine DJ players', 'StageLinQ: SC6000, Prime 4, SC Live…'),
      tg('os2l', 'VirtualDJ (OS2L)', `VirtualDJ finds VTube Pro by itself; without Bonjour set its os2lDirectIp to 127.0.0.1:${v.config.os2lPort}`),
      tg('osc', 'OSC in', `Port ${v.config.oscPort}: rkbx_link, open-beat-control, TouchDesigner… (see the guide for our addresses)`),
      tg('midi', 'DJ controllers + MIDI clock', 'Reads your controller’s faders and pads (listen-only) and MIDI clock from Traktor, Mixxx or a mixer'),
      tg('artnet', 'DMX light show in (Art-Net / sACN)', 'SoundSwitch, Engine Lighting, QLC+… drive the stage’s fixtures'),
      tg('traktor', 'Traktor deck data (community mod)', 'Only with the traktor-api-client mod installed in Traktor (see the guide). Off by default.'),
      h('label', { class: 'row', title: 'OSC and VirtualDJ (OS2L) take DJ data from apps on this PC only, unless you pick the network the DJ computer is on. Anyone on that network could then send beats and drops.' },
        h('span', { class: 'lbl' }, 'DJ apps on another computer'),
        h('select', { onChange: (e: Event) => void patch({ appsListen: (e.target as HTMLSelectElement).value }) },
          h('option', { value: '', selected: !v.config.appsListen }, 'No — this PC only'),
          ...(v.ifaces ?? []).map((f) => h('option', { value: f.address, selected: v.config.appsListen === f.address }, `Yes, on ${f.name} (${f.address})`)),
          h('option', { value: 'all', selected: v.config.appsListen === 'all' }, 'Yes, on every network'))),
      h('label', { class: 'row', title: 'Track names and the drop countdown normally come only from the source that sets the tempo. Pick another source if a tool (rkbx_link over OSC, Traktor deck data) knows them.' },
        h('span', { class: 'lbl' }, 'Track info + drop countdown from'),
        h('select', { onChange: (e: Event) => void patch({ phraseFrom: (e.target as HTMLSelectElement).value }) },
          ...([['', 'The source that sets the tempo'], ['osc', 'OSC tool (rkbx_link…)'], ['prolink', 'Pioneer CDJs'], ['traktor', 'Traktor deck data']] as [string, string][]).map(([val, l]) => h('option', { value: val, selected: (v.config.phraseFrom ?? '') === val }, l)))),
      v.config.adapters.artnet !== false ? toggle('Answer Art-Net polls', v.config.artnetPollReply, (on) => void patch({ artnetPollReply: on }), 'Some lighting desks only send to devices that answer. Off = VTube Pro stays silent on your network.') : null,
      isWin ? h('div', { class: 'btns tight' }, button('Let DJ gear on my network reach VTube Pro', () => void api<{ ok: boolean; says: string }>('POST', '/firewall', {}, true).then((r) => toast(r.says, r.ok ? 'ok' : 'warn')).catch((e) => toast(String(e), 'err')))) : null,
      h('div', { class: 'btns tight' }, button('Measure the delay again', () => void api('POST', '/calibration/reset', {}).then(() => toast('Measuring again from the next kicks.', 'ok')).catch(() => {})), button('Turn DJ sync off', () => void patch({ enabled: false }))),
      h('p', { class: 'dj-small' }, 'Guide: docs/DJ_SYNC.md (every DJ app and controller, step by step).')));
    if (v.loopbackOnly) kids.push(h('p', { class: 'dj-small' }, 'Test run: DJ sync listens on this PC only.'));
  }
  if (readOnly) kids.push(h('p', { class: 'dj-small' }, 'Test tab (observer): DJ sync settings are read-only here.'));
  body.replaceChildren(...kids.filter((k): k is HTMLElement => !!k));
}

/** Studio start (src/ui/laneWiring.ts): if the user allowed MIDI once, forward the controller from the start — not only
 *  after the Scene tab was opened. Never from observer / test tabs. */
export function djSyncBoot(app: App) {
  if (app.scene.observer) return;
  djTrackBoot(app);   // (Track library: audio matching from the music input while DJ sync is on)
  observerTab = false;
  let allowed = false; try { allowed = localStorage.getItem(MIDI_KEY) === '1'; } catch { /* storage off */ }
  if (!allowed) return;   // (never asked for MIDI: nothing to do until the user presses "Find my controller")
  // follow the helper's settings: the picked controller opens only while DJ sync is on, and closes when it goes off
  const follow = () => void api<View>('GET', '').then((v) => midi.apply(v.config.enabled, v.config.midiPorts ?? [])).catch(() => {});
  follow();
  window.setInterval(() => { if (!body?.isConnected) follow(); }, 10000);
}

/** The "DJ sync" section of the Scene tab. */
export function djSyncSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  readOnly = app.scene.observer && !/[?&]djTest=1/.test(location.search);
  observerTab = app.scene.observer;
  trackApp = app;
  if (!body) body = h('div', { 'data-tick': '1', class: 'dj-body' });
  if (!busOff) busOff = app.bus.on((m) => { if (m.type === 'musicclock') live = { c: m.c, at: performance.timeOrigin + performance.now() }; });
  if (!poll) {
    void refresh();
    poll = window.setInterval(() => { if (body?.isConnected) void refresh(); }, 1500);
  } else renderBody(true);
  return section('DJ sync', body);
}
