// Tiny DOM toolkit: h() element builder + labelled controls.
import { sliderControl, type Fmt, type SliderOpts } from './sliderBox.ts';
export { sliderControl, syncSlider, type SliderOpts } from './sliderBox.ts';

type Child = Node | string | number | null | undefined | false | Child[];
type Props = Record<string, unknown> & { class?: string; style?: string | Partial<CSSStyleDeclaration> };

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props | null = null, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props) {
    for (const [k, v] of Object.entries(props)) {
      if (v === undefined || v === null || v === false) continue;
      if (k === 'class') el.className = String(v);
      else if (k === 'style') typeof v === 'string' ? (el.style.cssText = v) : Object.assign(el.style, v);
      else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
      else if (k in el && k !== 'list') (el as unknown as Record<string, unknown>)[k] = v;
      else el.setAttribute(k, v === true ? '' : String(v));
    }
  }
  append(el, children);
  return el;
}

function append(el: HTMLElement, children: Child[]) {
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    if (Array.isArray(c)) append(el, c);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** Called before clear() empties a container: something that must outlive it (the shared room preview frame,
 *  src/ui/previewFrame.ts) moves itself out first. */
let beforeClear: ((el: HTMLElement) => void) | null = null;
export function onBeforeClear(fn: (el: HTMLElement) => void) { beforeClear = fn; }
export function clear(el: HTMLElement) { beforeClear?.(el); while (el.firstChild) el.removeChild(el.firstChild); }

/** A titled panel section. Click the title to collapse / expand it; that choice is remembered per panel
 *  (see rerender() below), so it survives re-renders, tab switches and reloads. */
export function section(title: string, ...children: Child[]) {
  const s: HTMLElement = h('section', { class: 'sec' },
    h('h3', { class: 'sec-h', onClick: () => rememberOpen(s, !s.classList.toggle('collapsed')) }, title), ...children);
  s.dataset.key = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'section';
  return s;
}

export function row(label: string, control: Node, hint?: string) {
  return h('label', { class: 'row', title: hint ?? '' }, h('span', { class: 'lbl' }, label), control);
}

/** A labelled slider with a number box (type an exact value) and ↺ reset-to-default (sliderBox.ts).
 *  `fmt` (or `opts.fmt`-style): how the value reads, e.g. (v) => `${v.toFixed(2)}×` (its unit shows in the box).
 *  `opts.def`: the setting's real default (↺ / double-click); `opts.hard`: typed values may go past the slider's ends. */
export function slider(label: string, value: number, min: number, max: number, step: number, onInput: (v: number) => void, hint?: string, fmt?: Fmt | SliderOpts, opts?: SliderOpts) {
  const o: SliderOpts & { fmt?: Fmt } = typeof fmt === 'function' ? { ...opts, fmt } : { ...fmt, ...opts };
  return h('label', { class: 'row slider', title: hint ?? '' }, h('span', { class: 'lbl' }, label), sliderControl(value, min, max, step, onInput, { ...o, name: label }));
}

export function toggle(label: string, value: boolean, onChange: (v: boolean) => void, hint?: string) {
  const input = h('input', { type: 'checkbox', checked: value, onChange: (e: Event) => onChange((e.target as HTMLInputElement).checked) });
  return h('label', { class: 'row toggle', title: hint ?? '' }, h('span', { class: 'lbl' }, label), h('span', { class: 'switch' }, input, h('i')));
}

export function select<T extends string>(label: string, value: T, options: [T, string][], onChange: (v: T) => void, hint?: string) {
  const s = h('select', { onChange: (e: Event) => onChange((e.target as HTMLSelectElement).value as T) },
    ...options.map(([v, l]) => h('option', { value: v, selected: v === value }, l)));
  return row(label, s, hint);
}

export function color(label: string, value: string, onInput: (v: string) => void) {
  return row(label, h('input', { type: 'color', value, onInput: (e: Event) => onInput((e.target as HTMLInputElement).value) }));
}

export function button(text: string, onClick: (e: MouseEvent) => void, cls = '', tut?: string) {
  return h('button', { class: `btn ${cls}`, onClick, 'data-tut': tut }, text);
}
/** Tutorials (src/ui/tutorials): name an element so a tutorial can point at it (data-tut, space-separated names). */
export function tut<T extends HTMLElement>(el: T, name: string): T { el.dataset.tut = el.dataset.tut ? `${el.dataset.tut} ${name}` : name; return el; }

let toastHelp: ((msg: string) => string | null) | null = null;
/** Adds a one-line fix under error / warning toasts (src/ui/premium.ts). */
export function setToastHelp(fn: (msg: string) => string | null) { toastHelp = fn; }
let toastSink: ((msg: string, kind: 'info' | 'ok' | 'warn' | 'err', fix: string | null) => void) | null = null;
/** UX redesign: every toast is also kept in the notification tray's list (src/ui/notifyTray.ts). */
export function setToastSink(fn: typeof toastSink) { toastSink = fn; }

export function toast(msg: string, kind: 'info' | 'ok' | 'warn' | 'err' = 'info', ms = 3800) {
  let host = document.getElementById('toasts');
  if (!host) { host = h('div', { id: 'toasts' }); document.body.append(host); }
  const fix = kind === 'err' || kind === 'warn' ? toastHelp?.(msg) ?? null : null; // premium.ts: "how to fix it" line
  try { toastSink?.(msg, kind, fix); } catch { /* the tray never blocks a toast */ }
  const t = h('div', { class: `toast ${kind}`, role: kind === 'err' ? 'alert' : 'status' }, msg, fix ? h('span', { class: 'pm-fix' }, fix) : null);
  if (fix) ms = Math.max(ms, 7000);
  host.append(t);
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 400); }, ms);
}

export function debounce<A extends unknown[]>(fn: (...a: A) => void, ms: number) {
  let t: ReturnType<typeof setTimeout> | undefined;
  return (...a: A) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

// ---------------------------------------------------------------- state-preserving re-renders
// Panels are plain "build the DOM from the current state" functions, re-run whenever a setting changes.
// rerender(container, build) makes that invisible to the user:
//   • while the user is busy in the container (slider / spot map being dragged, text being typed, a
//     <select> popup open) the rebuild waits and runs once they let go;
//   • the new tree is built next to the old one; when it prints identical (e.g. a slider that already
//     shows its new value) the old DOM is kept untouched and the new one dropped;
//   • an element marked `data-tick` holds text that changes all the time (link stats, timers, progress): the
//     comparison skips what is inside it, so when only those change their new content is copied into the old
//     DOM instead of swapping the whole tree (owner 2026-10-02: "things keep refreshing … when I'm in a party");
//   • otherwise the old tree is swapped out and scroll positions (the container, its scrolling ancestors
//     and inner scroll boxes), the focused control + caret, and the open / collapsed state of every
//     section() and <details> are restored. Open states persist per panel (localStorage 'vtp.ui.open').
// A container's scope is its nearest [data-ui] ancestor (renderPanel sets it to the tab id).

type Build = () => void;
export type RerenderOpts = {
  /** false = always swap in the new tree (when code outside the build keeps references to built nodes). */
  reuse?: boolean;
};

// ---- remembered open / collapsed state
const OPEN_KEY = 'vtp.ui.open';
let openState: Record<string, boolean> | null = null;
function opens(): Record<string, boolean> {
  if (!openState) {
    try { const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '{}'); openState = v && typeof v === 'object' ? v : {}; } catch { openState = {}; }
  }
  return openState!;
}
let openSaveT: ReturnType<typeof setTimeout> | undefined;
function saveOpens() {
  clearTimeout(openSaveT);
  openSaveT = setTimeout(() => { try { localStorage.setItem(OPEN_KEY, JSON.stringify(openState ?? {})); } catch { /* storage off */ } }, 200);
}
// (UX redesign: the Simple views' cards fold too, src/ui/bits.ts card(); their key is "c:<title>", apart from sections)
const COLLAPSIBLE = 'section.sec[data-key], section.s-card[data-key], details';
const CONTROL = 'select,option,button,input,textarea';
/** First real text in `el` (skipping text inside controls, e.g. a <select> in a <summary>). */
function firstText(el: Element | null): string {
  if (!el) return '';
  const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  for (let n = w.nextNode(); n; n = w.nextNode()) {
    const c = n.parentElement?.closest(CONTROL);
    if (c && el.contains(c)) continue;
    const t = (n.textContent ?? '').trim();
    if (t) return t.slice(0, 60);
  }
  return '';
}
function openBase(el: Element): string {
  const d = (el as HTMLElement).dataset?.key;
  if (el.tagName === 'SECTION') return el.classList.contains('s-card') ? `c:${d}` : `s:${d}`;
  return `d:${d ?? firstText(el.querySelector(':scope > summary'))}`;
}
/** A folding card's chevron says whether it is open (screen readers). */
function syncFold(el: Element) {
  const b = el.querySelector(':scope > h3 > .s-fold');
  if (b) { const open = String(!el.classList.contains('collapsed')); if (b.getAttribute('aria-expanded') !== open) b.setAttribute('aria-expanded', open); }
}
/** Fold / unfold one of the Simple views' cards and remember it for that panel (src/ui/bits.ts card()). */
export function foldCard(card: HTMLElement, open?: boolean) {
  const want = open ?? card.classList.contains('collapsed');
  card.classList.toggle('collapsed', !want);
  syncFold(card);
  rememberOpen(card, want);
}
/** Visit every collapsible under the scope root with its stable key ("face/s:eyes", "tracking/d:Per-expression gain…#1"). */
function eachCollapsible(root: HTMLElement, fn: (el: Element, key: string) => void, ignore?: (el: Element) => boolean) {
  const scope = root.dataset.ui ?? '';
  const seen = new Map<string, number>();
  for (const el of root.querySelectorAll(COLLAPSIBLE)) {
    if (ignore?.(el)) continue;
    const b = openBase(el), n = seen.get(b) ?? 0;
    seen.set(b, n + 1);
    fn(el, `${scope}/${b}${n ? `#${n}` : ''}`);
  }
}
function rememberOpen(el: Element, open: boolean) {
  const root = el.closest('[data-ui]') as HTMLElement | null;
  if (!root) return;
  eachCollapsible(root, (x, k) => { if (x === el && opens()[k] !== open) { opens()[k] = open; saveOpens(); } });
}
/** Re-apply the remembered open / collapsed state to everything inside `container`
 *  (`ignore`: elements that don't count, e.g. the old tree still sitting next to a fresh build). */
export function applyOpenState(container: HTMLElement, ignore?: (el: Element) => boolean) {
  wire();
  const root = container.closest('[data-ui]') as HTMLElement | null;
  if (!root) return;
  const st = opens();
  eachCollapsible(root, (el, k) => {
    if (!(k in st) || !container.contains(el)) return;
    if (el.tagName === 'SECTION') { el.classList.toggle('collapsed', !st[k]); syncFold(el); }
    else if ((el as HTMLDetailsElement).open !== st[k]) (el as HTMLDetailsElement).open = st[k];
  }, ignore);
}

// ---- what the user is doing right now
let wired = false;
let pointerIn: Element | null = null;           // target of the pointer currently held down
let selectOpen: HTMLSelectElement | null = null; // a <select> whose popup is (probably) open
let selectUntil = 0;
const pending = new Map<HTMLElement, { cs: HTMLElement[]; build: Build; opts: RerenderOpts }>();
let flushT: ReturnType<typeof setTimeout> | undefined;
let pollT: ReturnType<typeof setInterval> | undefined;
function wire() {
  if (wired) return;
  wired = true;
  const soon = () => { if (!pending.size) return; clearTimeout(flushT); flushT = setTimeout(flush, 40); };
  document.addEventListener('pointerdown', (e) => {
    pointerIn = e.target as Element;
    stopHolds();
    if (e.target instanceof HTMLSelectElement) { selectOpen = e.target; selectUntil = performance.now() + 8000; } else selectOpen = null;
  }, true);
  const up = () => { pointerIn = null; soon(); };
  document.addEventListener('pointerup', up, true);
  document.addEventListener('pointercancel', up, true);
  document.addEventListener('change', (e) => { if (e.target === selectOpen) selectOpen = null; soon(); }, true);
  document.addEventListener('focusout', (e) => { if (e.target === selectOpen) selectOpen = null; soon(); }, true);
  document.addEventListener('keydown', (e) => {
    const t = e.target;
    if (t instanceof HTMLSelectElement && (e.key === ' ' || e.key === 'Enter' || e.key === 'F4' || (e.altKey && e.key === 'ArrowDown'))) { selectOpen = t; selectUntil = performance.now() + 8000; }
    else if (t instanceof HTMLSelectElement && (e.key === 'Escape' || e.key === 'Tab')) { selectOpen = null; soon(); }
    stopHolds();
  }, true);
  window.addEventListener('wheel', stopHolds, { capture: true, passive: true });
  window.addEventListener('touchstart', stopHolds, { capture: true, passive: true });
  // <details> opened / closed (toggle doesn't bubble → capture)
  document.addEventListener('toggle', (e) => { const d = e.target; if (d instanceof HTMLDetailsElement) rememberOpen(d, d.open); }, true);
}
const TEXTY = /^(text|search|url|tel|email|password|number)$/;
function editing(el: Element | null): boolean {
  if (!el) return false;
  if (el instanceof HTMLTextAreaElement) return !el.readOnly && !el.disabled;
  if (el instanceof HTMLInputElement) return TEXTY.test(el.type) && !el.readOnly && !el.disabled;
  return (el as HTMLElement).isContentEditable === true;
}
function busy(cs: HTMLElement[]): boolean {
  const inside = (n: Element | null) => !!n && cs.some((c) => c.contains(n));
  if (pointerIn && pointerIn.isConnected && inside(pointerIn)) return true;
  const a = document.activeElement;
  if (inside(a) && editing(a)) return true;
  if (selectOpen && selectOpen.isConnected && performance.now() < selectUntil && inside(selectOpen)) return true;
  return false;
}
function flush() {
  for (const [k, p] of [...pending]) {
    if (!p.cs[0].isConnected) { pending.delete(k); continue; }
    if (busy(p.cs)) continue;
    pending.delete(k);
    try { run(p.cs, p.build, p.opts); } catch (e) { console.error('rerender failed', e); }
  }
  if (!pending.size && pollT) { clearInterval(pollT); pollT = undefined; }
}

/** Forget a queued rerender (e.g. the container is about to show something else). */
export function cancelRerender(container: HTMLElement) { pending.delete(container); }

/** Rebuild `container` (or several containers rebuilt together) with `build`, keeping the user's place.
 *  `build` appends fresh content into the container(s) exactly as it would into empty ones. */
export function rerender(target: HTMLElement | HTMLElement[], build: Build, opts: RerenderOpts = {}) {
  wire();
  const cs = Array.isArray(target) ? target : [target];
  if (cs[0].isConnected && running === 0 && busy(cs)) {
    pending.set(cs[0], { cs, build, opts });
    if (!pollT) pollT = setInterval(flush, 500);
    return;
  }
  pending.delete(cs[0]);
  run(cs, build, opts);
}

// ---- snapshot / restore helpers
/** Serialise what the user can see (tags, attributes, text and live control values). */
function print(nodes: ArrayLike<Node>, out: string[] = []): string[] {
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 3) { out.push('"', (n as Text).data); continue; }
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    out.push('<', e.tagName);
    for (const a of e.attributes) out.push(' ', a.name, '=', a.value);
    if (e instanceof HTMLInputElement) out.push('|', e.value, e.checked ? '|c' : '', e.disabled ? '|d' : '');
    else if (e instanceof HTMLSelectElement || e instanceof HTMLTextAreaElement) out.push('|', e.value, e.disabled ? '|d' : '');
    else if (e instanceof HTMLOptionElement) out.push(e.selected ? '|s' : '', e.disabled ? '|d' : '');
    else if (e instanceof HTMLButtonElement) out.push(e.disabled ? '|d' : '');
    else if (e instanceof HTMLDetailsElement) out.push(e.open ? '|o' : '');
    out.push('>');
    if (!e.hasAttribute('data-tick')) print(e.childNodes, out);   // data-tick: compared as a closed box
    out.push('</>');
  }
  return out;
}
/** The data-tick boxes among `nodes` in document order (not ones nested inside another tick box). */
function ticks(nodes: ArrayLike<Node>): Element[] {
  const out: Element[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType !== 1) continue;
    const e = n as Element;
    if (e.hasAttribute('data-tick')) { out.push(e); continue; }
    for (const t of e.querySelectorAll('[data-tick]')) { const up = t.parentElement?.closest('[data-tick]'); if (!up || !e.contains(up)) out.push(t); }
  }
  return out;
}
function baseKey(e: Element): string {
  const d = (e as HTMLElement).dataset?.key;
  if (d && e.tagName !== 'SECTION') return `k:${d}`;
  const sec = e.closest('section.sec[data-key]') as HTMLElement | null;
  const lbl = e.closest('.row')?.querySelector('.lbl')?.textContent ?? '';
  const txt = e.tagName === 'BUTTON' || e.tagName === 'SUMMARY' ? (e.textContent ?? '').slice(0, 40) : '';
  return `${sec?.dataset.key ?? ''}|${lbl}|${e.tagName}:${(e as HTMLInputElement).type ?? ''}|${txt}|${e.getAttribute('placeholder') ?? ''}|${e.getAttribute('class') ?? ''}`;
}
/** A key that finds "the same control" in a rebuilt tree: section + row label + kind (+ n-th of those). */
function keyIn(root: Element, e: Element): string {
  const b = baseKey(e);
  let n = 0;
  for (const x of root.getElementsByTagName(e.tagName)) { if (x === e) break; if (baseKey(x) === b) n++; }
  return `${b}#${n}`;
}
function findKey(root: Element, tag: string, key: string): Element | null {
  const seen = new Map<string, number>();
  for (const x of root.getElementsByTagName(tag)) {
    const b = baseKey(x), n = seen.get(b) ?? 0;
    seen.set(b, n + 1);
    if (`${b}#${n}` === key) return x;
  }
  return null;
}
type Caret = { s: number | null; e: number | null; d: 'forward' | 'backward' | 'none' | null };
function caretOf(el: Element): Caret | null {
  try { const i = el as HTMLInputElement; return typeof i.selectionStart !== 'number' ? null : { s: i.selectionStart, e: i.selectionEnd, d: i.selectionDirection }; } catch { return null; }
}
function restoreCaret(el: Element, c: Caret | null) {
  if (!c || c.s === null) return;
  try { (el as HTMLInputElement).setSelectionRange(c.s, c.e ?? c.s, c.d ?? undefined); } catch { /* not a text control */ }
}

// scroll positions that can't be reached yet (content still loading) are re-applied for a moment
const holds = new Map<Element, { top: number; until: number }>();
let holdRaf = 0;
function stopHolds() { holds.clear(); }
function tickHolds() {
  holdRaf = 0;
  const now = performance.now();
  for (const [el, hd] of holds) {
    if (el.scrollTop !== hd.top) el.scrollTop = hd.top;
    if (Math.abs(el.scrollTop - hd.top) <= 1 || now > hd.until || !el.isConnected) holds.delete(el);
  }
  if (holds.size) holdRaf = requestAnimationFrame(tickHolds);
}
/** Scroll `el` to `top`, and keep trying for ~2.5 s while late content grows it (any user scroll cancels). */
export function holdScroll(el: Element, top: number) {
  wire();
  if (el.scrollTop !== top) el.scrollTop = top;
  if (Math.abs(el.scrollTop - top) <= 1) { holds.delete(el); return; }
  holds.set(el, { top, until: performance.now() + 2500 });
  if (!holdRaf) holdRaf = requestAnimationFrame(tickHolds);
}
/** The scroll position `el` is at, or is still being brought back to. */
export function scrollTarget(el: Element) { return holds.get(el)?.top ?? el.scrollTop; }

let running = 0;
function run(cs: HTMLElement[], build: Build, opts: RerenderOpts) {
  // detached (or nested inside another rerender): nothing on screen to preserve
  if (!cs[0].isConnected || running > 0) {
    for (const c of cs) clear(c);
    build();
    for (const c of cs) applyOpenState(c);
    return;
  }
  running++;
  try {
    // --- snapshot
    const outer: [Element, number][] = [];
    const seenEl = new Set<Element>();
    for (const c of cs) for (let e: Element | null = c; e; e = e.parentElement) {
      if (seenEl.has(e)) continue;
      seenEl.add(e);
      if (e.scrollTop > 0 || holds.has(e)) outer.push([e, scrollTarget(e)]);
    }
    const inner: { c: HTMLElement; key: string; tag: string; top: number }[] = [];
    for (const c of cs) for (const e of c.querySelectorAll('.log, textarea, .scroll')) if (e.scrollTop > 0) inner.push({ c, key: keyIn(c, e), tag: e.tagName, top: e.scrollTop });
    const active = document.activeElement;
    const focusC = active && active !== document.body ? cs.find((c) => c.contains(active)) ?? null : null;
    const focusKey = focusC ? keyIn(focusC, active!) : null;
    const caret = focusC ? caretOf(active!) : null;
    const before = cs.map((c) => print(c.childNodes).join(''));

    // --- build next to the old content (after a marker), watching for nodes it moves out of the old tree
    const marks = cs.map((c) => { const m = document.createComment('rerender'); c.append(m); return m; });
    const mo = new MutationObserver(() => {});
    for (const c of cs) mo.observe(c, { childList: true, subtree: true });
    const fresh = () => cs.map((_, i) => { const out: Node[] = []; for (let n = marks[i].nextSibling; n; n = n.nextSibling) out.push(n); return out; });
    const drop = (lists: Node[][]) => { for (const l of lists) for (const n of l) n.parentNode?.removeChild(n); };
    const undoMoves = (recs: MutationRecord[]) => {
      // persistent nodes a builder re-appends (a live meter, a shared box) go back where they were
      for (let i = recs.length - 1; i >= 0; i--) {
        const r = recs[i];
        let ref = r.nextSibling;
        for (let j = r.removedNodes.length - 1; j >= 0; j--) {
          const n = r.removedNodes[j];
          if (n.nodeType !== 1 || n.parentNode === r.target) continue;
          try { r.target.insertBefore(n, ref && ref.parentNode === r.target ? ref : null); ref = n; } catch { /* target gone */ }
        }
      }
    };
    let recs: MutationRecord[];
    try { build(); }
    catch (e) {
      recs = mo.takeRecords(); mo.disconnect();
      drop(fresh()); undoMoves(recs); marks.forEach((m) => m.remove());
      throw e;
    }
    recs = mo.takeRecords();
    mo.disconnect();
    const made = fresh();
    const isOld = (el: Element) => cs.some((c, i) => c.contains(el) && !!(marks[i].compareDocumentPosition(el) & Node.DOCUMENT_POSITION_PRECEDING));
    for (const c of cs) applyOpenState(c, isOld);

    // --- identical to what's on screen? keep the old DOM untouched
    if (opts.reuse !== false && made.every((l, i) => print(l).join('') === before[i])) {
      const freshTicks = made.map((l) => ticks(l));
      drop(made);
      undoMoves(recs);
      marks.forEach((m) => m.remove());
      // the same structure, so the old and new tick boxes pair up in order: copy the new content in
      cs.forEach((c, i) => {
        const old = ticks(c.childNodes), nu = freshTicks[i];
        if (old.length === nu.length) old.forEach((o, j) => { const f = nu[j]; if (o !== f && !o.isEqualNode(f)) o.replaceChildren(...f.childNodes); });
      });
      if (focusC && document.activeElement !== active && active instanceof HTMLElement && active.isConnected) { active.focus({ preventScroll: true }); restoreCaret(active, caret); }
      for (const [e, top] of outer) holdScroll(e, top);
      return;
    }

    // --- swap: drop the old content, put the user back where they were
    for (let i = 0; i < cs.length; i++) {
      const c = cs[i], m = marks[i];
      while (c.firstChild && c.firstChild !== m) c.removeChild(c.firstChild);
      m.remove();
    }
    for (const [e, top] of outer) holdScroll(e, top);
    for (const s of inner) { const e = findKey(s.c, s.tag, s.key); if (e) e.scrollTop = s.top; }
    if (focusC && focusKey) {
      const e = findKey(focusC, active!.tagName, focusKey) as HTMLElement | null;
      if (e && typeof e.focus === 'function') { e.focus({ preventScroll: true }); restoreCaret(e, caret); }
    }
  } finally { running--; }
}
