// "What can my PC do?" where the user meets each feature (shared/capability.ts, src/net/capability.ts):
//   capabilityChip(id)      a small chip next to a feature: "Ready" / "Ready, slower" / "Can run — set it up" / "Not on this PC" /
//                           "Coming soon", the reason as tooltip; clicking it opens the page. Hidden while the answer is "Ready"
//                           unless { always: true }. ("Ready" means this PC can run it AND it is installed.)
//   gateButton(btn, id)     a feature's main button: disabled when the answer is "Not on this PC", with the reason in a line under
//                           it (and as the tooltip). Never disables a button that only needs VTube Pro to be started.
//   openCapabilityPage()    the page: what this PC has, then every feature with its answer, the fix and what you get instead.
//                           With no server answering it says so first, with "Start VTube Pro".
// Plain words only (memory vtube-pro-zero-effort). No sound, nothing saved, nothing sent anywhere.
import { CPU_REF, INSTALL_HELPER, aiMemoryGB, capNext, capState, capWord, mainGpu, reasonText, type FeatureId, type FeatureRow } from '../../shared/capability.ts';
import { RTMW_NOTE } from '../../shared/gpuLicence.ts';
import { NOTE_TEXT } from '../../shared/rigMl.ts';
import { getCapability, onCapability, featureNow, type Capability } from '../net/capability.ts';
import { h } from './dom.ts';

const CSS = `
.cap-chip { display:inline-flex; align-items:center; gap:5px; font: 600 11.5px/1 system-ui, sans-serif; padding: 4px 8px; border-radius: 99px; border: 1px solid var(--line); background: var(--panel); color: var(--text); cursor: pointer; white-space: nowrap; vertical-align: middle; }
.cap-chip::before { content: ''; width: 7px; height: 7px; border-radius: 50%; background: currentColor; opacity: .9; flex: none; }
.cap-chip.ok { color: #7bd88f; } .cap-chip.slower { color: #ffcf6a; } .cap-chip.no { color: #ff9a8b; } .cap-chip.setup { color: #8fc2ff; } .cap-chip.soon { color: #b9b4d6; }
.cap details { border-radius: 10px; background: var(--panel); padding: 8px 12px; } .cap summary { cursor: pointer; font-weight: 600; font-size: 13.5px; }
.cap details ul { margin: 8px 0 2px; padding-left: 18px; display: grid; gap: 6px; font-size: 12.5px; line-height: 1.45; color: var(--dim); }
.cap-chip:focus-visible { outline: 2px solid #7bd88f; outline-offset: 2px; }
.cap-why { font-size: 12.5px; line-height: 1.4; color: var(--dim); margin: 4px 0 0; flex-basis: 100%; }
.cap-why b { color: var(--text); font-weight: 600; }
.cap-wrap { position: fixed; inset: 0; z-index: 9000; display: grid; place-items: center; background: #05070bb3; }
.cap { width: min(680px, calc(100vw - 32px)); max-height: calc(100dvh - 48px); overflow: auto; border-radius: 16px; border: 1px solid var(--line); background: var(--bg2, #0b0f12); color: var(--text); box-shadow: 0 30px 80px -20px #000c; padding: 22px 24px 20px; display: grid; gap: 14px; position: relative; box-sizing: border-box; }
.cap h2 { margin: 0; font-size: 21px; } .cap h3 { margin: 6px 0 0; font-size: 13px; letter-spacing: .4px; text-transform: uppercase; color: var(--dim); }
.cap p { margin: 0; line-height: 1.5; color: var(--dim); }
.cap-x { position: absolute; right: 12px; top: 10px; background: none; border: 0; color: var(--dim); font-size: 22px; cursor: pointer; }
.cap-pc { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 8px; }
.cap-pc div { padding: 10px 12px; border-radius: 10px; background: var(--panel); font-size: 14px; line-height: 1.35; overflow-wrap: anywhere; }
.cap-pc div span { display: block; font-size: 11.5px; color: var(--dim); letter-spacing: .3px; text-transform: uppercase; margin-bottom: 2px; }
.cap-note { border-radius: 12px; padding: 12px 14px; border: 1px solid rgb(110 168 255 / .45); background: rgb(110 168 255 / .08); display: grid; gap: 8px; }
.cap-rows { list-style: none; margin: 0; padding: 0; display: grid; gap: 6px; }
.cap-row { display: grid; grid-template-columns: 1fr auto; gap: 3px 10px; padding: 10px 12px; border-radius: 10px; background: var(--panel); }
.cap-row .t { font-weight: 600; font-size: 14px; } .cap-row .s { grid-column: 1 / -1; font-size: 13px; color: var(--dim); line-height: 1.45; }
.cap-row .s b { color: var(--text); font-weight: 600; }
.cap-foot { display: flex; gap: 10px; flex-wrap: wrap; }
.cap-btn { font: 600 14px/1 inherit; border-radius: 99px; padding: 11px 16px; border: 1px solid var(--line); background: var(--bg2, #11171b); color: var(--text); cursor: pointer; }
.cap-btn.primary { background: var(--accent); color: #0b1410; border-color: transparent; }
.cap-btn:focus-visible { outline: 2px solid #7bd88f; outline-offset: 3px; }
`;
const style = () => { if (!document.getElementById('cap-style')) document.head.append(h('style', { id: 'cap-style' }, CSS)); };

/** The chip's colour class: green = ready, amber = slower, blue = can run once set up, red = not on this PC, grey = coming soon. */
const chipClass = (f: FeatureRow) => { const s = capState(f); return s === 'setup' ? 'setup' : s === 'soon' ? 'soon' : f.status; };
function paintChip(chip: HTMLElement, f: FeatureRow | null, always: boolean, label?: string) {
  if (!f) { chip.style.display = 'none'; return; }
  const word = capWord(f);
  chip.className = `cap-chip ${chipClass(f)}`;
  chip.textContent = label ? `${label}: ${word.replace(/^\w/, (c) => c.toLowerCase())}` : word;
  chip.title = `${reasonText(f)} (click: what can my PC do?)`;
  chip.setAttribute('aria-label', `${f.name}: ${word}. ${reasonText(f)}`);
  chip.style.display = capState(f) === 'ready' && f.status === 'ok' && !always ? 'none' : '';
}

// One subscription paints every chip / gated button on the page; entries whose element has left the page are dropped
// (panels repaint often, so this must not grow). An entry goes once it was in the page and left it, or when it never got
// into the page within a minute; one that is attached late still repaints.
interface Live { el: HTMLElement; id: FeatureId; paint: (f: FeatureRow | null) => void; seen: boolean; at: number }
const lives = new Set<Live>();
let subscribed = false;
const gone = (l: Live) => {
  if (l.el.isConnected) { l.seen = true; return false; }
  return l.seen || Date.now() - l.at > 60_000;
};
function track(el: HTMLElement, id: FeatureId, paint: (f: FeatureRow | null) => void) {
  for (const l of lives) if (gone(l)) lives.delete(l);
  const l: Live = { el, id, paint, seen: false, at: Date.now() };
  lives.add(l);
  paint(featureNow(id));
  if (!subscribed) {
    subscribed = true;
    onCapability((c) => {
      for (const x of lives) {
        if (gone(x)) { lives.delete(x); continue; }
        x.paint(c.matrix.find((f) => f.id === x.id) ?? null);
      }
    });
  }
  void getCapability().catch(() => null);
}

/** A chip with this feature's answer on this PC. */
export function capabilityChip(id: FeatureId, opts: { always?: boolean; label?: string } = {}): HTMLElement {
  style();
  const chip = h('button', { type: 'button', class: 'cap-chip', 'data-cap': id, style: 'display:none', onClick: (e: MouseEvent) => { e.stopPropagation(); e.preventDefault(); openCapabilityPage(); } });
  track(chip, id, (f) => paintChip(chip, f, !!opts.always, opts.label));
  return chip;
}

/** Disable a feature's button with the reason when this PC can't run it ("slower": the button stays, a line says so).
 *  Returns the reason line; it is placed right after the button (now, or as soon as the button is in the page). */
export function gateButton(btn: HTMLButtonElement, id: FeatureId, opts: { keepForHelper?: boolean } = {}): HTMLElement {
  style();
  const line = h('p', { class: 'cap-why', 'data-cap-why': id, style: 'display:none' });
  const apply = (f: FeatureRow | null) => {
    // keepForHelper: the panel already says "Start VTube Pro" its own way, so a missing server does not disable the button
    if (f && opts.keepForHelper && f.fix === INSTALL_HELPER) f = null;
    if (!f || f.status !== 'no') {
      if (btn.dataset.capOff) { btn.disabled = false; delete btn.dataset.capOff; btn.title = btn.dataset.capTitle ?? ''; }
      line.style.display = f?.status === 'slower' ? '' : 'none';
      if (f?.status === 'slower') line.replaceChildren(h('b', null, 'Slower on this PC: '), f.why);
      return;
    }
    if (!btn.dataset.capOff) { btn.dataset.capTitle = btn.title; btn.dataset.capOff = '1'; }
    btn.disabled = true;
    btn.title = reasonText(f);
    line.replaceChildren(h('b', null, capState(f) === 'soon' ? 'Coming soon: ' : 'Not on this PC: '), f.why, f.fix ? ` ${f.fix}.` : '', f.fallback ? ` Instead: ${f.fallback}` : '', ' ',
      h('button', { type: 'button', class: 'cap-chip', title: 'Fixed it? Check this PC again', onClick: (e: MouseEvent) => { e.preventDefault(); void getCapability(true).catch(() => null); } }, 'Check again'));
    line.style.display = '';
  };
  const place = () => { if (btn.parentNode && !line.isConnected) btn.after(line); };
  place();
  if (!line.isConnected) requestAnimationFrame(place);
  track(btn, id, apply);
  return line;
}

/** "On this PC: Low: ready · Medium: ready · High: ready, slower · Ultra: not on this PC" under the room quality buttons. */
export function gfxTierLine(): HTMLElement {
  style();
  return h('div', { class: 'cap-tiers', style: 'display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:6px 0;font-size:12px;color:var(--dim)' }, 'On this PC:',
    capabilityChip('gfx-performance', { always: true, label: 'Low' }), capabilityChip('gfx-balanced', { always: true, label: 'Medium' }),
    capabilityChip('gfx-high', { always: true, label: 'High' }), capabilityChip('gfx-ultra', { always: true, label: 'Ultra' }));
}

// ---------------------------------------------------------------- the page
const GROUPS: { title: string; ids: FeatureId[] }[] = [
  { title: 'Tracking and voice', ids: ['gpu-lipsync', 'maxine', 'rtmw', 'openseeface', 'face-model', 'arms-front', 'captions', 'kokoro'] },
  { title: 'Making avatars', ids: ['blender-rig', 'rig-ml', 'picture-to-life', 'see-through'] },
  { title: 'Room quality', ids: ['gfx-performance', 'gfx-balanced', 'gfx-high', 'gfx-ultra'] },
];
let root: HTMLElement | null = null;
function close() { root?.remove(); root = null; window.removeEventListener('keydown', onKey, true); }
const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && root) { e.preventDefault(); e.stopPropagation(); close(); } };

const speedWord = (s: number | null) => (s === null ? 'not measured' : s >= 0.7 ? 'fast' : s >= 0.4 ? 'average' : 'slow');
function pcFacts(c: Capability): HTMLElement {
  const r = c.report;
  const g = mainGpu(r);
  const mem = g?.unified ? `${aiMemoryGB(r)} GB (shared)` : g?.vramGB ? `${g.vramGB} GB` : g?.integrated ? 'shared with the system' : g ? 'not known' : '-';
  const fact = (label: string, value: string) => h('div', null, h('span', null, label), value);
  return h('div', { class: 'cap-pc' },
    fact('Graphics card', g ? g.name : 'None found'),
    fact('Video memory', mem),
    fact('Processor', `${r.cpu.cores} cores, ${speedWord(r.cpu.speed)}${r.cpu.speed !== null ? ` (${Math.round(r.cpu.speed * 100)}% of ${CPU_REF})` : ''}`),
    fact('Memory', r.ramGB ? `${r.ramGB} GB` : r.source === 'browser' ? '8 GB or more' : 'not known'),
    fact('Free disk space', r.diskFreeGB !== null ? `${r.diskFreeGB} GB` : 'needs VTube Pro to check'),
    fact('Graphics in this browser', r.webgpu === null ? 'checking' : r.webgpu ? 'Modern (WebGPU)' : 'Basic (no WebGPU)'),
    ...(r.osName ? [fact('System', r.osName)] : []));
}

function helperNote(c: Capability): HTMLElement | null {
  if (c.helper === 'ok') return null;
  if (c.helper === 'none') {
    return h('div', { class: 'cap-note', 'data-cap-note': 'none' },
      h('p', null, h('b', null, 'This is what your browser can see on its own. '), 'VTube Pro’s server did not answer, so graphics memory, disk space and what is installed could not be checked. Start VTube Pro, then check again.'));
  }
  return h('div', { class: 'cap-note', 'data-cap-note': 'old' },
    h('p', null, h('b', null, 'This copy of VTube Pro cannot do the full check. '), 'Below is what your browser can see on its own.'));
}

const ORDER: Record<FeatureRow['status'], number> = { ok: 0, slower: 1, no: 2 };
function rowEl(f: FeatureRow): HTMLElement {
  const s = h('div', { class: 's' }, f.why);
  const next = capNext(f);
  if (next) s.append(' ', h('b', null, 'To use it: '), next);
  if (f.status !== 'ok' && f.fix) s.append(' ', h('b', null, capState(f) === 'soon' ? 'When it arrives: ' : 'To get it: '), `${f.fix}.`);
  if (f.status !== 'ok' && f.fallback) s.append(' ', h('b', null, 'Instead: '), f.fallback);
  return h('li', { class: 'cap-row', 'data-cap-row': f.id, 'data-status': f.status, 'data-state': capState(f) },
    h('span', { class: 't' }, f.name), h('span', { class: `cap-chip ${chipClass(f)}`, style: 'cursor:default' }, capWord(f)), s);
}

/** The exact licence facts behind the optional add-ons, kept out of the main text (plain words above; details on request). */
function licenceDetails(): HTMLElement {
  return h('details', { 'data-cap-licences': '1' }, h('summary', null, 'Licence details'),
    h('ul', null,
      h('li', null, h('b', null, 'GPU lip sync: '), 'NVIDIA Audio2Face-3D v2.3.1 (NVIDIA Open Model License).'),
      h('li', null, h('b', null, 'Face expressions: '), 'NVIDIA Maxine AR SDK (NVIDIA licence; free, not bundled with VTube Pro).'),
      h('li', null, h('b', null, 'Whole-body & finger pose: '), RTMW_NOTE),
      h('li', null, h('b', null, 'Light face tracker: '), 'OpenSeeFace (BSD 2-Clause, by Emiliana).'),
      h('li', null, h('b', null, 'Smart skeleton: '), 'two models, SkinTokens (best) and UniRig (smaller card), both under the MIT licence. ',
        NOTE_TEXT['gpl-shape-encoder'], ' ', NOTE_TEXT['training-data'], ' ', NOTE_TEXT['opt-config'])));
}

function paint(body: HTMLElement, c: Capability, refresh: () => void) {
  const counts = { ready: 0, slower: 0, setup: 0, no: 0, soon: 0 };
  for (const f of c.matrix) { const s = capState(f); counts[s]++; if (f.status === 'slower' && s !== 'no' && s !== 'soon') counts.slower++; }
  const summary = [`${counts.ready + counts.setup} can run on this PC`, `${counts.ready} of them ready to use`, counts.setup ? `${counts.setup} to set up first` : '',
    counts.slower ? `${counts.slower} slower than usual` : '', counts.no ? `${counts.no} not on this PC` : '', counts.soon ? `${counts.soon} coming soon` : ''].filter(Boolean);
  body.replaceChildren(
    h('h2', null, 'What can my PC do?'),
    h('p', { 'data-cap-summary': '1' }, `${summary.join(' · ')}. Measured on this computer; nothing is sent anywhere.`),
    ...[helperNote(c)].filter((x): x is HTMLElement => !!x),
    pcFacts(c),
    ...GROUPS.flatMap((g) => [h('h3', null, g.title), h('ul', { class: 'cap-rows' },
      ...g.ids.map((id) => c.matrix.find((f) => f.id === id)).filter((f): f is FeatureRow => !!f).sort((a, b) => (g.title === 'Room quality' ? 0 : ORDER[a.status] - ORDER[b.status])).map(rowEl))]),
    licenceDetails(),
    h('div', { class: 'cap-foot' },
      h('button', { type: 'button', class: 'cap-btn', onClick: refresh }, 'Check again'),
      h('button', { type: 'button', class: 'cap-btn primary', onClick: close }, 'Done')),
  );
}

/** Open the "What can my PC do?" page over the studio. */
export function openCapabilityPage(): void {
  style();
  close();
  const body = h('div', { class: 'cap', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'What can my PC do?' }, h('h2', null, 'What can my PC do?'), h('p', null, 'Checking this computer…'));
  root = h('div', { class: 'cap-wrap', onClick: (e: MouseEvent) => { if (e.target === root) close(); } }, body);
  const x = h('button', { type: 'button', class: 'cap-x', 'aria-label': 'Close', onClick: close }, '×');
  document.body.append(root);
  window.addEventListener('keydown', onKey, true);
  const show = (fresh: boolean) => {
    const mine = root;
    getCapability(fresh).then((c) => { if (root === mine) { paint(body, c, () => show(true)); body.prepend(x); } })
      .catch(() => { if (root === mine) body.replaceChildren(x, h('h2', null, 'What can my PC do?'), h('p', null, 'This computer could not be checked right now. Try again in a moment.')); });
  };
  show(false);
}
