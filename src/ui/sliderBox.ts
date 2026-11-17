// Every slider in the app = range + a number box (type an exact value; Enter / blur applies, Esc reverts, ↑ / ↓ step,
// Shift = ×10) + a ↺ reset-to-default button (double-clicking the slider resets too). A small notch under the track
// marks where the default sits; ↺ lights up once the value differs from it. dom.ts slider() and the few raw range
// inputs (TTRPG voice, light groups, prompter) all build through sliderControl().
// The pure helpers (parse / clamp / display) have no DOM dependency: tools/sliders_unit.ts tests them in Node.

export type SliderOpts = {
  /** The app's real default for this setting (from the DEFAULT_* objects / sanitizers): ↺ and double-click restore it. */
  def?: number;
  /** Unit shown in the number box ('×', 's', 'min', '°', 'mm' …). Auto: fmt()'s suffix, or a unit in the label ('(s)', '°'). */
  unit?: string;
  /** Typed values may go past the slider's own ends, up to these hard limits (default: the slider range). */
  hard?: [number, number];
  /** Number box shows value × scale (100 → percent, 1000 → mm). Auto-detected from fmt() when it is linear. */
  scale?: number;
  /** Text → value for non-numeric displays (e.g. a time of day '14:30'); return NaN when it can't be read. */
  parse?: (s: string) => number;
  /** Call onInput only on release (the range's 'change') instead of while dragging. */
  commit?: boolean;
  disabled?: boolean;
  /** Accessible name when the control is not inside a labelled row. */
  label?: string;
  /** Round typed values to whole steps (default: only when step ≥ 1 and the range is integral). */
  snap?: boolean;
};

export type Fmt = (v: number) => string;

/** Decimals needed to show `step` exactly (0.005 → 3, 0.05 → 2, 1 → 0). */
export function stepDecimals(step: number): number {
  if (!isFinite(step) || step <= 0) return 2;
  const s = String(step);
  if (/e-/i.test(s)) return Math.min(8, parseInt(s.split(/e-/i)[1], 10) + ((s.split(/e/i)[0].split('.')[1] ?? '').length));
  return Math.min(8, (s.split('.')[1] ?? '').length);
}

const NUM = /^\s*([-+−]?(?:\d+[.,]?\d*|[.,]\d+)(?:e[-+]?\d+)?)\s*(.*?)\s*$/i;

/** Read what the user typed: '1.5', '1,5', '−0.2', '12 min', '1.2×', '30%'. NaN when there is no number. */
export function parseTyped(text: string, parse?: (s: string) => number): number {
  const t = String(text ?? '').trim();
  if (!t) return NaN;
  if (parse) { const v = parse(t); if (isFinite(v)) return v; }
  const m = NUM.exec(t.replace(/−/g, '-'));
  if (!m) return NaN;
  const v = parseFloat(m[1].replace(',', '.'));
  return isFinite(v) ? v : NaN;
}

/** Clamp a typed value to the hard limits (default: slider range) and round it to the step's precision. */
export function clampTyped(v: number, min: number, max: number, step: number, hard?: [number, number], snap?: boolean): number {
  if (!isFinite(v)) return NaN;
  const lo = Math.min(hard?.[0] ?? min, min), hi = Math.max(hard?.[1] ?? max, max);
  let x = Math.min(hi, Math.max(lo, v));
  const doSnap = snap ?? (step >= 1 && Number.isInteger(min) && Number.isInteger(step));
  if (doSnap && step > 0) x = min + Math.round((x - min) / step) * step;
  const d = stepDecimals(step) + (doSnap ? 0 : 1);
  x = +x.toFixed(Math.min(8, d));
  return Math.min(hi, Math.max(lo, x));
}

/** One ↑ / ↓ press: ±step (±10 steps with Shift), clamped like a typed value. */
export function stepValue(v: number, dir: 1 | -1, big: boolean, min: number, max: number, step: number, hard?: [number, number]): number {
  const s = step > 0 ? step : (max - min) / 100;
  return clampTyped(+(v + dir * s * (big ? 10 : 1)).toFixed(10), min, max, s, hard);
}

/** How fmt() shows numbers: { scale, unit } when it is value × scale + a fixed suffix (checked at 3 points), else null. */
export function fmtShape(fmt: Fmt | undefined, min: number, max: number): { scale: number; unit: string } | null {
  if (!fmt) return { scale: 1, unit: '' };
  const pts = [min + (max - min) * 0.37, min + (max - min) * 0.81, max].filter((x) => Math.abs(x) > 1e-9);
  let scale = NaN, unit: string | null = null;
  for (const x of pts) {
    let s: string;
    try { s = String(fmt(x)); } catch { return null; }
    const m = NUM.exec(s.replace(/−/g, '-'));
    if (!m) return null;
    const n = parseFloat(m[1].replace(',', '.'));
    const u = m[2].trim();
    if (unit === null) unit = u; else if (u !== unit) return null;
    const k = n / x;
    if (isNaN(scale)) scale = k;
    // fmt rounds for display: accept it when it matches value × scale within half a displayed digit
    const dec = (m[1].split(/[.,]/)[1] ?? '').length;
    if (Math.abs(n - x * scale) > 0.5 * 10 ** -dec + 1e-9 + Math.abs(x * scale) * 0.02) return null;
  }
  if (!isFinite(scale) || scale === 0) return null;
  // snap near-round factors (0.999 → 1, 99.8 → 100)
  for (const r of [1, 10, 60, 100, 1000]) if (Math.abs(scale / r - 1) < 0.03) scale = r;
  return { scale, unit: unit ?? '' };
}

/** A unit written in the label: 'Quiet after (s)' → 's', 'Gaze range°' → '°', 'Light delay (ms)' → 'ms'. */
export function labelUnit(label: string): string {
  const m = /\((ms|s|min|m|cm|mm|px|%|°|×|x|per second|Hz)\)\s*$/i.exec(label) ?? /\(\w+°\)\s*$/.exec(label);
  if (m) return m[0].includes('°') ? '°' : m[1] === 'per second' ? '/s' : m[1];
  if (/°\s*$/.test(label)) return '°';
  return '';
}

/** Text for the number box: value × scale at the step's precision (+1 decimal when the value is off-grid). */
export function boxText(v: number, step: number, scale = 1): string {
  if (!isFinite(v)) return '';
  const x = v * scale;
  let d = stepDecimals(step * scale);
  if (Math.abs(+x.toFixed(d) - x) > 10 ** -(d + 2) && d < 6) d++;
  return x.toFixed(Math.max(0, d)).replace(/^-0(\.0*)?$/, '0$1');
}

export function sameValue(a: number, b: number, step: number): boolean {
  return Math.abs(a - b) <= Math.max(1e-9, (step > 0 ? step : 0.001) * 0.25);
}

// ---------------------------------------------------------------- DOM

const CSS = `
.row.slider { grid-template-columns: 116px minmax(56px, 1fr) auto; column-gap: 6px; }
.sl-ctl { display: contents; }
.sl-inline { display: inline-flex; align-items: center; gap: 6px; min-width: 0; flex: 1; }
.sl-inline .sl-track { flex: 1; min-width: 50px; }
.sl-track { position: relative; display: block; min-width: 0; }
.sl-track input[type=range] { display: block; width: 100%; margin: 0; }
.sl-track[data-def]::after { content: ''; position: absolute; left: calc(7px + (100% - 14px) * var(--def)); bottom: -3px; width: 2px; height: 4px;
  margin-left: -1px; border-radius: 1px; background: var(--faint, #717a8b); opacity: .75; pointer-events: none; }
.sl-end { display: inline-flex; align-items: center; gap: 3px; }
.sl-num { display: inline-flex; align-items: baseline; width: 58px; height: 24px; padding: 0 5px 0 4px; border: 1px solid var(--line2, #333a4a);
  border-radius: 7px; background: var(--input, #10131a); cursor: text; transition: border-color .12s; }
.sl-num:hover { border-color: var(--faint, #717a8b); }
.sl-num:focus-within { border-color: var(--focus, #8ab4ff); }
.sl-num.bad { border-color: var(--err, #ff6b6b); }
.sl-num input.sl-in { all: unset; flex: 1; min-width: 0; width: 100%; height: 22px; line-height: 22px; text-align: right; font: inherit; font-size: 12px;
  font-variant-numeric: tabular-nums; color: var(--text, #eef1f6); }
.sl-num input.sl-in:focus-visible { outline: none !important; }
.sl-num i { font-style: normal; font-size: 10.5px; color: var(--faint, #717a8b); margin-left: 2px; white-space: nowrap; max-width: 26px; overflow: hidden; }
.sl-num.wide { width: 72px; }
.sl-reset { width: 18px; height: 22px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--faint, #717a8b); opacity: .35;
  font: 600 14px/1 system-ui, sans-serif; cursor: default; display: grid; place-items: center; transition: opacity .12s, color .12s, background .12s; }
.sl-reset.on { opacity: 1; color: var(--accent, #7bd88f); cursor: pointer; }
.sl-reset.on:hover { background: var(--accent-soft, #7bd88f22); }
.sl-reset:disabled { opacity: .2; cursor: default; }
.sl-ctl.off .sl-num, .sl-inline.off .sl-num, .sl-num:has(input:disabled) { opacity: .5; }
.sl-ctl:has(input[type=range]:disabled) .sl-reset, .sl-inline:has(input[type=range]:disabled) .sl-reset { opacity: .2; pointer-events: none; }
`;
let styled = false;
function style() {
  if (styled || typeof document === 'undefined') return;
  styled = true;
  const s = document.createElement('style');
  s.id = 'vtp-slider-css';
  s.textContent = CSS;
  // last in <head>: wins over styles.css and the theme sheet (same specificity), also when the theme is re-applied
  const put = () => document.head.append(s);
  put();
  // theme.ts may append its sheet later; keep ours after it
  queueMicrotask(put);
  setTimeout(put, 0);
}

type Sync = (v: number) => void;
const SYNC = new WeakMap<HTMLInputElement, Sync>();

/** Move a slider built by sliderControl() to `v` from code (a clock that ticks, a value changed elsewhere):
 *  range, number box, notch and ↺ state follow; onInput is NOT called. Returns false for a plain range. */
export function syncSlider(range: HTMLInputElement | null | undefined, v: number): boolean {
  const f = range ? SYNC.get(range) : undefined;
  if (!f) return false;
  f(v);
  return true;
}

/** Range + number box + ↺. `inline` = a self-contained flex span (for raw rows); else `display: contents` children of a
 *  .row.slider grid. */
export function sliderControl(value: number, min: number, max: number, step: number, onInput: (v: number) => void,
  o: SliderOpts & { fmt?: Fmt; name?: string; inline?: boolean } = {}): HTMLElement {
  style();
  const name = o.label ?? o.name ?? '';
  const shape = o.scale !== undefined ? { scale: o.scale, unit: o.unit ?? '' } : fmtShape(o.fmt, min, max);
  const scale = shape?.scale ?? 1;
  const unit = o.unit ?? (shape?.unit || labelUnit(name));
  const textual = !shape && !!o.fmt;           // fmt shows something that isn't value × k (a clock time): show fmt()
  const show = (v: number) => (textual ? o.fmt!(v) : boxText(v, step, scale));
  const readBox = (s: string) => {
    const v = parseTyped(s, o.parse);
    return o.parse && isFinite(o.parse(s.trim())) ? v : v / scale;
  };
  let cur = value;

  const range = document.createElement('input');
  range.type = 'range';
  range.min = String(min); range.max = String(max); range.step = String(step); range.value = String(value);
  if (name) range.setAttribute('aria-label', name);
  const track = document.createElement('span');
  track.className = 'sl-track';
  track.append(range);

  const wrap = document.createElement('span');
  wrap.className = 'sl-num' + (show(max).length + unit.length > 7 || show(min).length + unit.length > 7 ? ' wide' : '');
  const box = document.createElement('input');
  box.type = 'text';
  box.className = 'sl-in';
  box.inputMode = o.parse ? 'text' : 'decimal';
  box.spellcheck = false;
  box.autocomplete = 'off';
  box.value = show(value);
  const lo = Math.min(o.hard?.[0] ?? min, min), hi = Math.max(o.hard?.[1] ?? max, max);
  box.setAttribute('aria-label', name ? `${name}: exact value` : 'Exact value');
  box.title = `Type a value (${show(lo)}–${show(hi)}${unit ? ' ' + unit : ''}). Enter applies, Esc undoes, ↑ ↓ step (Shift = ×10).`;
  wrap.append(box);
  if (unit) { const u = document.createElement('i'); u.textContent = unit; u.setAttribute('aria-hidden', 'true'); wrap.append(u); }
  // clicks on the box frame / unit focus the box (and never fall through to the row <label>'s range)
  wrap.addEventListener('mousedown', (e) => { if (e.target !== box) { e.preventDefault(); if (!box.disabled) { box.focus(); box.select(); } } });
  wrap.addEventListener('click', (e) => { if (e.target !== box) e.preventDefault(); });

  const reset = document.createElement('button');
  reset.type = 'button';
  reset.className = 'sl-reset';
  reset.textContent = '↺';
  const hasDef = o.def !== undefined && isFinite(o.def);
  const defTxt = hasDef ? `${show(o.def!)}${unit ? ' ' + unit : ''}` : '';
  reset.title = hasDef ? `Reset to default (${defTxt}) — or double-click the slider` : 'No default for this setting';
  reset.setAttribute('aria-label', hasDef ? `Reset ${name || 'value'} to default, ${defTxt}` : 'No default');
  if (hasDef) {
    track.dataset.def = '';
    track.style.setProperty('--def', String(Math.min(1, Math.max(0, (o.def! - min) / (max - min || 1)))));
    track.title = `Default ${defTxt} (double-click to reset)`;
  }

  const end = document.createElement('span');
  end.className = 'sl-end';
  end.append(wrap, reset);
  const root = document.createElement('span');
  root.className = o.inline ? 'sl-inline' : 'sl-ctl';
  root.append(track, end);

  const paint = () => {
    const changed = hasDef && !sameValue(cur, o.def!, step);
    reset.classList.toggle('on', changed);
    reset.tabIndex = changed ? 0 : -1;
    reset.setAttribute('aria-disabled', changed ? 'false' : 'true');
  };
  const disable = (d: boolean) => { range.disabled = d; box.disabled = d; reset.disabled = d || !hasDef; root.classList.toggle('off', d); };
  disable(!!o.disabled);
  paint();

  const sync: Sync = (v) => {
    cur = v;
    if (document.activeElement !== range) range.value = String(v);
    if (document.activeElement !== box) box.value = show(v);
    paint();
  };
  SYNC.set(range, sync);
  const apply = (v: number, fire = true) => {
    cur = v;
    range.value = String(v);
    box.value = show(v);
    paint();
    if (fire) onInput(v);
  };

  range.addEventListener('input', () => {
    const v = parseFloat(range.value);
    cur = v; box.value = show(v); paint();
    if (!o.commit) onInput(v);
  });
  if (o.commit) range.addEventListener('change', () => onInput(parseFloat(range.value)));
  range.addEventListener('dblclick', (e) => { if (!hasDef || range.disabled) return; e.preventDefault(); apply(o.def!); });
  reset.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); if (hasDef && !reset.disabled && !range.disabled && !sameValue(cur, o.def!, step)) apply(o.def!); });

  let flash: ReturnType<typeof setTimeout> | undefined;
  const bad = () => { wrap.classList.add('bad'); clearTimeout(flash); flash = setTimeout(() => wrap.classList.remove('bad'), 900); };
  const commitBox = () => {
    const raw = box.value;
    if (raw.trim() === show(cur).trim()) { box.value = show(cur); return; }
    const v = clampTyped(readBox(raw), min, max, step, o.hard, o.snap);
    if (!isFinite(v)) { bad(); box.value = show(cur); return; }
    if (v !== readBox(raw) && Math.abs(v - readBox(raw)) > 10 ** -(stepDecimals(step) + 1)) bad(); // clamped: show it
    if (sameValue(v, cur, step / 10)) { box.value = show(cur); return; }
    apply(v);
  };
  box.addEventListener('focus', () => { setTimeout(() => { if (document.activeElement === box) box.select(); }, 0); });
  box.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commitBox(); box.select(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); box.value = show(cur); box.blur(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      const typed = clampTyped(readBox(box.value), min, max, step, o.hard, o.snap);
      const base = isFinite(typed) ? typed : cur;
      apply(stepValue(base, e.key === 'ArrowUp' ? 1 : -1, e.shiftKey, min, max, step, o.hard));
      box.select();
    }
  });
  box.addEventListener('blur', commitBox);
  return root;
}
