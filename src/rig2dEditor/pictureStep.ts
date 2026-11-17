// "Just one picture": the maker's tap step. The user's single picture is shown big with three plain prompts in order (the eye
// on the LEFT of the picture, the other eye, the mouth), each with "There isn't one"; the dots can be dragged afterwards,
// then "Looks right" builds the rig (shared/rig2d/edit/picture.ts). No jargon, no ML, nothing leaves the computer.
import type { PicturePixels, PictureTaps } from '../../shared/rig2d/edit/picture.ts';
import { capabilityChip } from '../ui/capabilityView.ts';

export interface PictureStepOpts {
  pic: PicturePixels;
  name: string;
  /** "Looks right": the taps (picture pixels; a skipped part is absent). */
  onBuild(taps: PictureTaps): void;
  onCancel(): void;
}

const KEYS = ['eyeL', 'eyeR', 'mouth'] as const;
type Key = typeof KEYS[number];
const PROMPT: Record<Key, string> = { eyeL: 'Tap the eye on the LEFT of the picture', eyeR: 'Tap the other eye', mouth: 'Tap the mouth' };
const SHORT: Record<Key, string> = { eyeL: 'eye', eyeR: 'eye', mouth: 'mouth' };

let styled = false;
function injectStyle() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'r2e-pic-style';
  s.textContent = `
.r2e-pic { position: absolute; inset: 0; z-index: 5; display: flex; flex-direction: column; gap: 10px; padding: 14px; background: var(--r2e-stage, #1b1d24); }
.r2e-pic h3 { margin: 0; font-size: 20px; }
.r2e-pic .sub { margin: 2px 0 0; color: var(--r2e-dim, #a3abba); }
.r2e-pic .row { display: flex; gap: 10px; flex-wrap: wrap; align-items: center; }
.r2e-pic .hold { position: relative; flex: 1; min-height: 0; display: flex; align-items: center; justify-content: center; }
.r2e-pic .pix { position: relative; touch-action: none; cursor: crosshair; border-radius: 6px; overflow: visible; background-color: #2a2d36; background-image: linear-gradient(45deg, #ffffff10 25%, transparent 25%, transparent 75%, #ffffff10 75%), linear-gradient(45deg, #ffffff10 25%, transparent 25%, transparent 75%, #ffffff10 75%); background-size: 20px 20px; background-position: 0 0, 10px 10px; }
.r2e-pic canvas { display: block; width: 100%; height: 100%; border-radius: 6px; }
.r2e-pic .dot { position: absolute; width: 34px; height: 34px; margin: -17px 0 0 -17px; border-radius: 50%; border: 3px solid #fff; box-shadow: 0 0 0 2px #000a, 0 2px 8px #0008; background: #6cc7f588; cursor: grab; touch-action: none; }
.r2e-pic .dot.mouth { background: #ff8aa088; }
.r2e-pic .dot span { position: absolute; left: 50%; top: 100%; transform: translateX(-50%); margin-top: 4px; padding: 1px 7px; border-radius: 99px; background: #000b; color: #fff; font-size: 12px; white-space: nowrap; pointer-events: none; }
`;
  document.head.append(s);
}

const el = <K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> | null = null, ...kids: (Node | string | null | false)[]): HTMLElementTagNameMap[K] => {
  const e = document.createElement(tag);
  if (props) for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined || v === false) continue;
    if (k === 'class') e.className = String(v);
    else if (k === 'style') e.style.cssText = String(v);
    else if (k.startsWith('on') && typeof v === 'function') e.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    else if (k in e) (e as unknown as Record<string, unknown>)[k] = v;
    else e.setAttribute(k, String(v));
  }
  for (const c of kids) if (c !== null && c !== false) e.append(c);
  return e;
};

export function mountPictureStep(host: HTMLElement, opts: PictureStepOpts): { dispose(): void } {
  injectStyle();
  const { pic } = opts;
  const taps: Partial<Record<Key, [number, number]>> = {};
  let step = 0;
  const head = el('div'), actions = el('div', { class: 'row' });
  const canvas = el('canvas'), pix = el('div', { class: 'pix' }, canvas), hold = el('div', { class: 'hold' }, pix);
  canvas.width = pic.w; canvas.height = pic.h;
  canvas.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(pic.rgba), pic.w, pic.h), 0, 0);
  // a slow PC: "Works, slower" next to the steps (hidden when it simply works): src/ui/capabilityView.ts
  const root = el('div', { class: 'r2e-pic', role: 'dialog', 'aria-label': 'Tap the eyes and the mouth' }, head, capabilityChip('picture-to-life'), actions, hold);
  host.append(root);

  const fit = () => {
    const W = hold.clientWidth, H = hold.clientHeight;
    if (W < 10 || H < 10) return;
    const k = Math.min(W / pic.w, H / pic.h);
    pix.style.width = `${Math.floor(pic.w * k)}px`; pix.style.height = `${Math.floor(pic.h * k)}px`;
  };
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(fit) : null;
  ro?.observe(hold);
  const dots = new Map<Key, HTMLElement>();
  const place = (k: Key) => {
    const p = taps[k];
    let d = dots.get(k);
    if (!p) { d?.remove(); dots.delete(k); return; }
    if (!d) {
      // (no title tooltip: it covered the dot's own label; the heading says "Drag the dots")
      d = el('div', { class: `dot${k === 'mouth' ? ' mouth' : ''}`, 'aria-label': `${SHORT[k]} dot: drag to move` }, el('span', null, SHORT[k]));
      d.addEventListener('pointerdown', (e) => {
        e.stopPropagation(); e.preventDefault();
        d!.setPointerCapture(e.pointerId); d!.style.cursor = 'grabbing';
        const move = (ev: PointerEvent) => { taps[k] = at(ev); place(k); };
        const up = () => { d!.style.cursor = ''; d!.removeEventListener('pointermove', move); d!.removeEventListener('pointerup', up); d!.removeEventListener('pointercancel', up); };
        d!.addEventListener('pointermove', move); d!.addEventListener('pointerup', up); d!.addEventListener('pointercancel', up);
      });
      dots.set(k, d); pix.append(d);
    }
    d.style.left = `${(p[0] / pic.w) * 100}%`; d.style.top = `${(p[1] / pic.h) * 100}%`;
  };
  const at = (e: PointerEvent | MouseEvent): [number, number] => {
    const r = pix.getBoundingClientRect();
    return [Math.max(0, Math.min(pic.w - 1, ((e.clientX - r.left) / r.width) * pic.w)), Math.max(0, Math.min(pic.h - 1, ((e.clientY - r.top) / r.height) * pic.h))];
  };
  pix.addEventListener('pointerdown', (e) => {
    if (step >= KEYS.length) return;
    taps[KEYS[step]] = at(e); place(KEYS[step]);
    step++; render();
  });

  function render() {
    const review = step >= KEYS.length;
    head.replaceChildren(
      el('h3', null, review ? 'Drag the dots if one is not quite right' : PROMPT[KEYS[step]]),
      el('p', { class: 'sub' }, review ? 'Then press "Looks right". We cut out the background, give it blinking eyes and a talking mouth, and it moves like an avatar.'
        : 'Step ' + (step + 1) + ' of 3. Tap right on the middle of it.'));
    actions.replaceChildren(
      ...(review ? [] : [el('button', { onClick: () => { step++; render(); } }, "There isn't one")]),
      el('button', { class: 'primary', disabled: !review, onClick: () => opts.onBuild(Object.fromEntries(KEYS.filter((k) => taps[k]).map((k) => [k, taps[k]])) as PictureTaps) }, 'Looks right'),
      el('button', { onClick: () => { for (const k of KEYS) { delete taps[k]; place(k); } step = 0; render(); } }, 'Start over'),
      el('button', { onClick: () => opts.onCancel() }, 'Cancel'));
  }
  render();
  requestAnimationFrame(fit);
  return { dispose() { ro?.disconnect(); root.remove(); } };
}
