// Tracking → Expression range & curves: the 52 ARKit channels, one at a time (shared/blendCurves.ts). Pick a channel, see what
// your face does to it live (the dot), and shape what the avatar gets: where "nothing" and "all the way" are on YOUR face (input
// range), how it rises (curve) and how far the avatar's shape may go (output range). Saved with the avatar; drives 3D (VRM / GLB)
// and 2D (Pro2D / Live2D-style) avatars alike. A channel you never touch stays exactly as tracked.
import type { App } from '../app.ts';
import { ARKIT } from '../core/arkit.ts';
import { BLEND_CURVE_DEFAULT, curveValue, fullCurve, isIdentityCurve, sanitizeBlendCurves, type BlendCurve } from '../../shared/blendCurves.ts';
import { button, h, section, select, slider } from './dom.ts';
import { live } from './bits.ts';

type Group = { id: string; label: string; test: (n: string) => boolean };
const GROUPS: Group[] = [
  { id: 'eyes', label: 'Eyes (blink, look, squint, wide)', test: (n) => n.startsWith('eye') },
  { id: 'brows', label: 'Brows', test: (n) => n.startsWith('brow') },
  { id: 'mouth', label: 'Mouth', test: (n) => n.startsWith('mouth') },
  { id: 'jaw', label: 'Jaw & tongue', test: (n) => n.startsWith('jaw') || n === 'tongueOut' },
  { id: 'cheek', label: 'Cheeks & nose', test: (n) => n.startsWith('cheek') || n.startsWith('nose') },
];
/** "mouthSmileLeft" → "Mouth smile left" */
export const channelLabel = (n: string) => n.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());

let pickGroup = 'jaw', pickChannel = 'jawOpen';   // (jawOpen lives in the Jaw & tongue group)

/** The curve graph: input on the bottom, avatar output up the side, the dot = what your face is doing right now. */
function graph(curve: () => Partial<BlendCurve> | undefined, input: () => number): SVGSVGElement {
  const S = 140, ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${S} ${S}`); svg.setAttribute('width', String(S)); svg.setAttribute('height', String(S));
  svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', 'Response curve: your face on the bottom, the avatar up the side');
  svg.style.cssText = 'background:#0003;border-radius:8px;flex:none';
  const mk = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string>) => { const e = document.createElementNS(ns, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); svg.append(e); return e; };
  mk('line', { x1: '0', y1: String(S), x2: String(S), y2: '0', stroke: '#fff3', 'stroke-dasharray': '3 3' });   // as tracked
  const line = mk('polyline', { fill: 'none', stroke: 'var(--accent, #7cf)', 'stroke-width': '2' });
  const dot = mk('circle', { r: '4.5', fill: '#fff' });
  const drop = mk('line', { stroke: '#fff5', 'stroke-dasharray': '2 2' });
  const paint = () => {
    const c = curve();
    const pts: string[] = [];
    for (let i = 0; i <= 40; i++) { const x = i / 40; pts.push(`${(x * S).toFixed(1)},${((1 - curveValue(c, x)) * S).toFixed(1)}`); }
    line.setAttribute('points', pts.join(' '));
    const v = Math.min(1, Math.max(0, input())), o = curveValue(c, v);
    dot.setAttribute('cx', (v * S).toFixed(1)); dot.setAttribute('cy', ((1 - o) * S).toFixed(1));
    drop.setAttribute('x1', (v * S).toFixed(1)); drop.setAttribute('x2', (v * S).toFixed(1)); drop.setAttribute('y1', String(S)); drop.setAttribute('y2', ((1 - o) * S).toFixed(1));
  };
  paint();
  (svg as unknown as { paint: () => void }).paint = paint;
  return svg;
}

export function blendCurvesSection(app: App): HTMLElement {
  const saved = () => app.profile?.tracking.blendCurves;
  const get = (ch: string): BlendCurve => fullCurve(saved()?.[ch]);
  const set = (ch: string, patch: Partial<BlendCurve>) => {
    if (app.observer) return;
    app.edit((p) => {
      const all = { ...(p.tracking.blendCurves ?? {}) };
      all[ch] = { ...get(ch), ...patch };
      p.tracking.blendCurves = sanitizeBlendCurves(all, ARKIT);
      if (!p.tracking.blendCurves) delete p.tracking.blendCurves;
    }, false);
  };
  const editedCount = () => Object.keys(saved() ?? {}).length;

  const box = h('div');
  const draw = () => {
    const g = GROUPS.find((x) => x.id === pickGroup) ?? GROUPS[0];
    const names = ARKIT.filter((n) => g.test(n));
    if (!names.includes(pickChannel as never)) pickChannel = names[0];
    const ch = pickChannel;
    const input = () => app.frame?.face?.[ch] ?? 0;
    const svg = graph(() => saved()?.[ch], input);
    const readout = h('p', { class: 'note', 'aria-live': 'off' });
    const upd = () => {
      (svg as unknown as { paint: () => void }).paint();
      const v = input(), o = curveValue(saved()?.[ch], v);
      readout.textContent = app.trackingOn || app.trackingSource !== 'webcam'
        ? `Your face: ${v.toFixed(2)}  →  avatar: ${o.toFixed(2)}${isIdentityCurve(saved()?.[ch]) ? ' (straight through)' : ''}`
        : 'Start tracking to see your face move the dot.';
    };
    const sl = (label: string, key: keyof BlendCurve, min: number, max: number, step: number, hint: string) =>
      slider(label, get(ch)[key], min, max, step, (v) => { set(ch, { [key]: v }); upd(); }, hint, { def: BLEND_CURVE_DEFAULT[key] });
    box.replaceChildren(
      select('Part of the face', g.id, GROUPS.map((x) => [x.id, x.label] as [string, string]), (v) => { pickGroup = v; draw(); }),
      select('Channel', ch, names.map((n) => [n, `${channelLabel(n)}${isIdentityCurve(saved()?.[n]) ? '' : '  ●'}`] as [string, string]), (v) => { pickChannel = v; draw(); },
        'A ● marks a channel you changed. Everything else reaches the avatar exactly as tracked.'),
      h('div', { style: 'display:flex;gap:12px;align-items:flex-start;flex-wrap:wrap;margin:8px 0' }, svg,
        h('div', { style: 'flex:1;min-width:220px' },
          sl('Face: none', 'inLo', 0, 0.9, 0.01, 'Your face: the tracker value that should count as "not at all" for you (raise it to cut a resting twitch)'),
          sl('Face: full', 'inHi', 0.1, 1, 0.01, 'Your face: the tracker value that should count as "fully" (lower it if your face never gets that far)'),
          sl('Curve', 'gamma', 0.25, 4, 0.01, 'Below 1 the shape comes in early, above 1 it holds back until you mean it'),
          sl('Avatar: least', 'outLo', 0, 1, 0.01, 'The lowest the avatar’s shape goes (above 0 keeps a little of it always on)'),
          sl('Avatar: most', 'outHi', 0, 1, 0.01, 'The most the avatar’s shape may reach (cap a shape that pokes through the mesh; below "least" flips it)'))),
      readout,
      h('div', { class: 's-row' },
        button('Reset this channel', () => { if (!app.observer) { app.edit((p) => { const all = { ...(p.tracking.blendCurves ?? {}) }; delete all[ch]; p.tracking.blendCurves = sanitizeBlendCurves(all, ARKIT); if (!p.tracking.blendCurves) delete p.tracking.blendCurves; }, false); draw(); } }, 'ghost'),
        button(`Reset all${editedCount() ? ` (${editedCount()} changed)` : ''}`, () => { if (!app.observer && app.profile) { app.edit((p) => { delete p.tracking.blendCurves; }, false); draw(); } }, 'ghost')));
    upd();
    live(() => { if (!svg.isConnected) return false; upd(); return true; });
  };
  draw();
  return section('Expression range & curves',
    h('p', { class: 'note' }, 'For each of the 52 face channels: tell VTube Pro where “nothing” and “all the way” are on YOUR face, how it should rise, and how far the avatar may go. Works for 3D and 2D avatars and is saved with this avatar. Untouched channels stay exactly as tracked.'),
    box);
}
