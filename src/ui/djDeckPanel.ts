// Scene tab → "DJ decks": put a DJ setup at the DJ spot that copies your DJ controller, and let your hands play it
// (src/scene/djdeck/*, docs/DJ_SYNC.md "DJ decks"). Zero effort: turn it on; the decks already look like your
// controller and know it if it's one of the built-in ones (DDJ-GRV6, FLX4, FLX6, SB3, 400, 200, REV1 + the ones DJ
// sync reads). Anything else: "Teach my controller" (move each control when asked) or move a control and click its
// part on the drawing. "Record my controller" saves 20 s of the controller's raw MIDI for checking a map later.
// Listen-only: nothing here sends anything to the controller.
import type { App } from '../app.ts';
import { button, h, rerender, section, select, slider, toast, toggle } from './dom.ts';
import { rigLayout, type LayoutId, type Part } from '../../shared/djDeck/layout.ts';
import { sanitizeDeckSnapshot, type DeckSnapshot } from '../../shared/djDeck/reader.ts';
import { DEFAULT_DJDECK_STATE, sanitizeDjDeckState } from '../../shared/djDeck/state.ts';

interface DeckView {
  port: string | null; device: string | null;
  profile: { id: string; name: string; known: boolean; layout: string; note?: string; doc: number; inferred: number; learned: number } | null;
  lastAt: number;
  learn: { step: number; steps: number; say: string; part: string; got: string[]; done: boolean } | null;
  grab: { part: string | null; kind: string; at: number } | null;
  record: { on: boolean; until: number; events: number; file: string | null };
  taught: string[];
}
type Reply = { ok?: boolean; says?: string; view?: DeckView } & Partial<DeckView>;

let dv: DeckView | null | undefined;   // undefined = loading, null = VTube Pro did not answer
let busy = false;
let snap: DeckSnapshot | null = null, snapAt = 0;
let timer = 0;
/** The section on screen (the Scene tab rebuilds sections, and rerender may keep the old DOM: always look it up). */
const rootEl = () => document.querySelector<HTMLElement>('[data-djd-root]');
let busOff: (() => void) | null = null;
let msg = '';
const CSS = `.djd-svg{width:100%;height:auto;background:#0b0d12;border-radius:8px;display:block;margin:6px 0}
.djd-svg .p{fill:#2a2f3b;stroke:#4a5163;stroke-width:.6;cursor:pointer}.djd-svg .p:hover{stroke:#fff}
.djd-svg .on{fill:#ff3fd2}.djd-svg .lit{fill:#3fbf6a}.djd-svg .want{stroke:#ffd23a;stroke-width:2}.djd-svg .taught{stroke:#35e3ff}
.djd-step{background:#1b2030;border-radius:8px;padding:8px 10px;margin:6px 0;font-weight:600}`;
let cssDone = false;

async function api<T>(method: string, path: string, data?: unknown): Promise<T> {
  // (POSTs come from a button: the helper only takes Teach / Record with the click header)
  const r = await fetch(`/api/music/deck${path}`, { method, cache: 'no-store', headers: { 'content-type': 'application/json', ...(method === 'POST' ? { 'x-vtp-user-action': '1' } : {}) }, body: data === undefined ? undefined : JSON.stringify(data) });
  if (!r.ok) throw new Error((await r.json().catch(() => ({})) as { error?: string }).error || `HTTP ${r.status}`);
  return r.json() as Promise<T>;
}
let shapeKey = '';
let liveRender: (() => void) | null = null;
/** The parts that change every second (the teach step, what was moved, the recording) are painted straight into a
 *  live box, so they update even while the pointer rests on the panel (rerender waits for that). */
function paintLive() {
  // (looked up each time: rerender may keep the old DOM when the new build prints the same)
  const el = rootEl()?.querySelector<HTMLElement>('[data-djd-live]'), render = liveRender; if (!el || !render) return;
  const L = dv?.learn, rec = dv?.record;
  const kids: (Node | null)[] = [
    L ? h('div', null,
      h('div', { class: 'djd-step', role: 'status' }, `Step ${Math.min(L.step + 1, L.steps)} of ${L.steps}: ${L.say}`),
      h('div', { class: 'btns tight' }, button('Skip this one', () => void act('/learn', { do: 'skip' }, render)), button('Stop teaching', () => void act('/learn', { do: 'cancel' }, render)))) : null,
    dv?.grab && !L ? h('p', { class: 'note' }, dv.grab.part ? `You moved the ${partLabel(dv.grab.part)}. Wrong part? Move it again, then click the right one below.` : `You moved ${dv.grab.kind} VTube Pro doesn’t know yet: click its part below.`) : null,
    msg ? h('p', { class: 'note' }, msg) : null,
    rec?.on ? h('p', { class: 'note', role: 'status' }, `Recording your controller… ${Math.max(0, Math.ceil((rec.until - (performance.timeOrigin + performance.now())) / 1000))} s (move everything you use)`) : null,
    rec?.file && !rec.on ? h('p', { class: 'note' }, `Saved for checking: cache/diag/${rec.file} (only your controller’s button and fader messages, nothing else).`) : null,
  ];
  el.replaceChildren(...kids.filter((x): x is Node => !!x));
}
async function refresh(render: () => void) {
  try { dv = await api<DeckView>('GET', ''); } catch (e) { dv = dv ?? null; }
  const key = JSON.stringify(dv === undefined ? 'u' : dv === null ? 'n' : [dv.port, dv.profile?.id, dv.profile?.known, dv.profile?.learned, !!dv.learn, dv.taught.length, dv.record.on]);
  if (key !== shapeKey) { shapeKey = key; render(); }
  paintLive();
}
async function act(path: string, body: unknown, render: () => void) {
  if (busy) return; busy = true;
  try {
    const r = await api<Reply>('POST', path, body);
    if (r.view) dv = r.view; else if (r.port !== undefined) dv = r as DeckView;
    msg = r.says ?? '';
    if (r.ok === false && r.says) toast(r.says, 'warn');
  } catch (e) { toast(`DJ decks: ${(e as Error).message}`, 'err'); }
  finally { busy = false; shapeKey = ''; render(); paintLive(); clearTimeout(timer); timer = window.setTimeout(pollTick, 300); }
}

/** The drawing of the decks (the DJ's view: the near edge at the bottom). Click a part to teach it. */
function diagram(lay: LayoutId, render: () => void): SVGSVGElement {
  const L = rigLayout(lay), k = 1000;
  const W = L.w + 0.04, D = L.d + 0.04;
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${Math.round(W * k)} ${Math.round(D * k)}`); svg.setAttribute('class', 'djd-svg');
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Your DJ decks, seen from where you stand');
  const X = (u: number) => (u + W / 2) * k, Y = (v: number) => (D / 2 - v) * k;
  for (const hs of L.housings) { const r = document.createElementNS(NS, 'rect'); r.setAttribute('x', `${X(hs.u - hs.w / 2)}`); r.setAttribute('y', `${Y(hs.v + hs.d / 2)}`); r.setAttribute('width', `${hs.w * k}`); r.setAttribute('height', `${hs.d * k}`); r.setAttribute('rx', '8'); r.setAttribute('fill', hs.raised ? '#1d212b' : '#15171c'); svg.append(r); }
  const want = dv?.learn?.part ?? '', taught = new Set(dv?.taught ?? []);
  const on = new Set(snap && performance.now() - snapAt < 3000 ? snap.on : []), recent = new Set(Object.entries(snap?.k ?? {}).filter(([, a]) => a < 400).map(([id]) => id)), lit = new Set(snap?.lit ?? []);
  for (const p of L.parts) {
    let el: SVGElement;
    const round = p.kind === 'jog' || p.kind === 'knob' || p.kind === 'encoder' || (p.kind === 'button' && /\.(play|cue|shift)$/.test(p.id) && p.w <= 0.016);
    if (round) { el = document.createElementNS(NS, 'circle'); el.setAttribute('cx', `${X(p.u)}`); el.setAttribute('cy', `${Y(p.v)}`); el.setAttribute('r', `${p.r * k}`); }
    else {
      const [w, d] = p.kind === 'fader' || p.kind === 'tempo' ? [p.w, p.len] : p.kind === 'xfader' ? [p.len, p.w] : p.kind === 'meter' ? [p.w, p.len] : [p.w, p.d];
      el = document.createElementNS(NS, 'rect'); el.setAttribute('x', `${X(p.u - w / 2)}`); el.setAttribute('y', `${Y(p.v + d / 2)}`); el.setAttribute('width', `${w * k}`); el.setAttribute('height', `${d * k}`); el.setAttribute('rx', '3');
    }
    const cls = ['p', on.has(p.id) || recent.has(p.id) ? 'on' : lit.has(p.id) ? 'lit' : '', p.id === want ? 'want' : '', taught.has(p.id) ? 'taught' : ''].filter(Boolean).join(' ');
    el.setAttribute('class', cls);
    const t = document.createElementNS(NS, 'title'); t.textContent = p.label; el.append(t);
    if (p.kind !== 'meter') el.addEventListener('click', () => bindPart(p, render));
    svg.append(el);
  }
  return svg;
}
function bindPart(p: Part, render: () => void) {
  if (!dv?.grab) { toast(`Move the ${p.label} on your controller first, then click it here.`, 'warn'); return; }
  void act('/learn', { do: 'bind', part: p.id, kind: p.kind }, render);
}

let curRender: (() => void) | null = null;
const partLabel = (id: string) => rigLayout('ctrl4').byId.get(id)?.label ?? rigLayout('cdj').byId.get(id)?.label ?? id;
let goneSince = 0;
function pollTick() {
  timer = 0;
  // (the Scene tab rebuilds sections: a new one may not be in the page yet — keep polling a little while)
  if (!rootEl() || !curRender) {
    goneSince ||= performance.now();
    if (performance.now() - goneSince < 30000) timer = window.setTimeout(pollTick, 500);
    return;
  }
  goneSince = 0;
  void refresh(curRender).finally(() => { timer = window.setTimeout(pollTick, dv?.learn || dv?.record.on ? 400 : 2000); });
}

/** The "DJ decks" section of the Scene tab. */
export function djDeckSection(app: App): HTMLElement {
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const S = app.scene;
  const outer = h('div', { 'data-djd-root': '1' });
  const build = (into: HTMLElement) => {
    const st = S.effective.djdeck ? sanitizeDjDeckState(S.effective.djdeck) : DEFAULT_DJDECK_STATE;
    // (observer / test tabs: read-only unless a test asks for the buttons with &djTest=1: they'd teach the helper)
    const edit = S.canEdit && (!S.observer || /[?&]djTest=1/.test(location.search));
    const info = S.scenes.find((x) => x.id === S.effective.sceneId) as unknown as { club?: { djSpot?: string }; festival?: { djSpot?: string }; djdeck?: { spot?: string } } | undefined;
    const djSpot = info?.djdeck?.spot ?? info?.club?.djSpot ?? info?.festival?.djSpot;
    const where = djSpot ? `at the DJ booth (${djSpot.replace('SPOT_', 'spot ').replace(/ 0/, ' ')})` : 'in front of you, wherever you stand';
    const lay: LayoutId = st.look === 'auto' ? (dv?.profile?.layout === 'ctrl4' ? 'ctrl4' : 'cdj') : st.look;
    // one plain sentence about the controller
    let says: string;
    if (dv === undefined) says = 'Looking for your controller…';
    else if (dv === null) says = 'VTube Pro is not answering, so the DJ decks can’t be read right now.';
    else if (!dv.port) says = 'No controller yet. In DJ sync above: turn DJ sync on and press “Find my controller”, then move a fader — the decks copy it.';
    else if (dv.profile?.id === 'generic' && !dv.profile.known) says = `VTube Pro doesn’t know your ${dv.port} yet. Press “Teach my controller” (about a minute), or move a control and click its part below.`;
    else says = `Copying your ${dv.profile?.name ?? dv.port}${dv.profile?.doc ? ' — every control from the maker’s MIDI list' : ''}${dv.profile?.learned ? `, ${dv.profile.learned} taught by you` : ''}.`;
    const L = dv?.learn, rec = dv?.record;
    liveRender = render;
    into.append(...([
      h('p', { class: 'note' }, says),
      toggle('Show DJ decks', st.on, (v) => S.setDjDeck({ on: v }), `A DJ setup ${where} that copies your controller: jogs, faders, knobs, pads, screens`),
      st.on ? h('div', null,
        toggle('My hands play the decks', st.hands, (v) => S.setDjDeck({ hands: v }), 'Your avatar’s hands go to whatever you touch on your controller. Face, head and expressions stay tracked'),
        select('Between moves', st.idle, [['groove', 'Groove over the decks'], ['tracked', 'My tracked arms']], (v) => S.setDjDeck({ idle: v }), 'Groove: your hands hover over the decks and you nod to the beat. Tracked: your camera moves your arms'),
        select('Looks like', st.look, [['auto', 'My controller'], ['cdj', 'Players + mixer'], ['ctrl4', '4-channel controller']], (v) => S.setDjDeck({ look: v })),
        select('Stand', st.stand, [['auto', 'Automatic'], ['on', 'Always'], ['off', 'Never']], (v) => S.setDjDeck({ stand: v }), 'Automatic: a stand only where the room has no table under the decks'),
        slider('Higher / lower', st.height, -0.25, 0.25, 0.01, (v) => S.setDjDeck({ height: v }), 'Moves the decks up or down (they are sized to your avatar by themselves)', { def: 0, unit: ' m' }),
        slider('Nearer / further', st.dist, -0.25, 0.25, 0.01, (v) => S.setDjDeck({ dist: v }), undefined, { def: 0, unit: ' m' })) : null,
      h('div', { 'data-tick': '1', 'data-djd-live': '1' }),
      h('div', { 'data-tick': '1', 'data-djd-svg': '1' }, diagram(lay, render)),
      edit && dv ? h('div', { class: 'btns tight' },
        L ? null : button('Teach my controller', () => void act('/learn', { do: 'start' }, render), dv.profile?.known ? '' : 'primary'),
        rec?.on ? null : button('Record my controller for 20 s', () => void act('/record', { sec: 20 }, render)),
        dv.taught.length ? button('Forget what I taught', () => void act('/learn', { do: 'forget' }, render)) : null) : null,
      h('p', { class: 'note' }, 'Listen-only: VTube Pro never sends anything to your controller.'),
    ] as (Node | null)[]).filter((x): x is Node => !!x));
    paintLive();
  };
  // rebuild whichever copy of the section is on screen (or this new one before it is placed)
  const render = () => { const el = rootEl() ?? outer; rerender(el, () => build(el)); };
  if (!busOff) busOff = app.bus.on((m) => {
    if (m.type !== 'djdeck' || m.origin === 'party') return;
    const s = sanitizeDeckSnapshot(m.s); if (!s) return;
    snap = s; snapAt = performance.now();
    const svgHost = rootEl()?.querySelector<HTMLElement>('[data-djd-svg]');
    if (svgHost) { const st = S.effective.djdeck ? sanitizeDjDeckState(S.effective.djdeck) : DEFAULT_DJDECK_STATE; const lay: LayoutId = st.look === 'auto' ? s.lay : st.look; svgHost.replaceChildren(diagram(lay, curRender ?? render)); }
  });
  curRender = render;   // (the Scene tab rebuilds this section: the poll always repaints the newest one)
  shapeKey = '';
  if (!timer) timer = window.setTimeout(pollTick, 0);
  build(outer);
  return section('DJ decks', outer);
}
