// Stream-safe identity: streamers share their screen and go live with the studio open, so a real name (the Discord host
// sign-in) is never on screen by default:
//   * safeName() shows a neutral label, or the Display name the user chose, with an eye button that peeks at the real
//     name only while it is hovered or held, or for 5 s after a click / Enter. The peek is never remembered: every page
//     load starts hidden;
//   * the Display name lives in this browser's localStorage only ('vtp.displayName'). It is sent nowhere.
// The real name never goes into the DOM, a title, an aria-label, a log, an output page or a request until the user
// peeks, and the picture URL is never rendered at all.
import { h } from './dom.ts';
import { icon } from './icons.ts';

export const DISPLAY_NAME_KEY = 'vtp.displayName';
export const DISPLAY_NAME_MAX = 32;
export const PEEK_MS = 5000;
/** What the chip says when no Display name is set. */
export const SIGNED_IN = 'Signed in';
const CHANGE = 'vtp-display-name';

const ls = (): Storage | undefined => { try { return globalThis.localStorage; } catch { return undefined; } };

/** Display text only: no control characters or angle brackets, single spaces, at most 32 characters. */
export function cleanDisplayName(v: unknown): string {
  if (typeof v !== 'string') return '';
  return v.replace(/[\u0000-\u001f\u007f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, DISPLAY_NAME_MAX).trim();
}
/** The name the user chose for the screen, or null (then nothing but "Signed in" shows). */
export function displayName(): string | null {
  try { return cleanDisplayName(ls()?.getItem(DISPLAY_NAME_KEY) ?? '') || null; } catch { return null; }
}
/** Save (or clear, with '') the Display name in this browser. Returns what was saved. */
export function setDisplayName(v: string): string | null {
  const c = cleanDisplayName(v);
  try { if (c) ls()?.setItem(DISPLAY_NAME_KEY, c); else ls()?.removeItem(DISPLAY_NAME_KEY); } catch { /* blocked: shows "Signed in" */ }
  try { globalThis.dispatchEvent?.(new Event(CHANGE)); } catch { /* no window */ }
  return c || null;
}
/** Runs `fn` when the Display name changes here or in another tab. */
export function onDisplayNameChange(fn: () => void): () => void {
  const onStorage = (e: StorageEvent) => { if (e.key === DISPLAY_NAME_KEY || e.key === null) fn(); };
  globalThis.addEventListener?.(CHANGE, fn);
  globalThis.addEventListener?.('storage', onStorage as EventListener);
  return () => { globalThis.removeEventListener?.(CHANGE, fn); globalThis.removeEventListener?.('storage', onStorage as EventListener); };
}
/** The words the screen shows for "you": the Display name, else `fallback`. */
export const shownName = (fallback = SIGNED_IN) => displayName() ?? fallback;
/** Greeting text: "Welcome back!" or "Welcome back, <Display name>!" (never the real name). */
export const greeting = (head: string, tail = '') => { const n = displayName(); return `${head}${n ? `, ${n}` : ''}!${tail ? ` ${tail}` : ''}`; };

/**
 * The eye button. While it is hovered or held, or for PEEK_MS after a click / Enter / Space, `target` shows `real()`.
 * Otherwise `target` shows `hidden()`. Esc hides at once. Nothing is stored.
 */
export function peekButton(real: () => string, target: HTMLElement, hidden: () => string): HTMLButtonElement {
  let hover = false, hold = false, timer: ReturnType<typeof setTimeout> | null = null;
  const btn = h('button', { type: 'button', class: 'vw-peek', 'aria-label': 'Show my name', 'aria-pressed': 'false', title: 'Show my name for a moment' }) as HTMLButtonElement;
  const paint = () => {
    const on = hover || hold || !!timer;
    target.textContent = on ? real() : hidden();
    target.classList.toggle('vw-peeking', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.replaceChildren(icon(on ? 'eyeoff' : 'eye', 16));
  };
  const stop = () => { if (timer) clearTimeout(timer); timer = null; };
  btn.addEventListener('pointerenter', () => { hover = true; paint(); });
  btn.addEventListener('pointerleave', () => { hover = false; hold = false; paint(); });
  btn.addEventListener('pointerdown', () => { hold = true; paint(); });
  btn.addEventListener('pointerup', () => { hold = false; paint(); });
  btn.addEventListener('pointercancel', () => { hover = false; hold = false; paint(); });
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (timer) { stop(); paint(); return; }
    timer = setTimeout(() => { timer = null; paint(); }, PEEK_MS);
    paint();
  });
  btn.addEventListener('keydown', (e) => { if ((e as KeyboardEvent).key === 'Escape') { hover = false; hold = false; stop(); paint(); } });
  btn.addEventListener('blur', () => { hold = false; paint(); });
  paint();
  return btn;
}

/**
 * Someone's own name, stream-safe: `fallback` (or the Display name) + an eye that peeks at `real`.
 * For "Signed in as …" lines (the Discord host sign-in).
 */
export function safeName(real: string, fallback = 'your account'): HTMLElement {
  injectStreamSafeCss();
  const label = h('b', { class: 'vw-safe-name' });
  const hidden = () => shownName(fallback);
  return h('span', { class: 'vw-safe' }, label, peekButton(() => real || hidden(), label, hidden));
}

/** A neutral round avatar for "you" (no initial, no account picture). */
export function safeAvatar(size = 26): HTMLElement {
  return h('span', { class: 'vw-safe-avatar', 'aria-hidden': 'true', style: `width:${size}px;height:${size}px;border-radius:50%;flex:none;display:grid;place-items:center;background:var(--panel, #1a1f24);border:1px solid var(--line, #333);color:var(--dim, #9aa)` },
    icon('me', Math.round(size * 0.6)));
}

/** Shared look (scoped .vw-*, the studio's theme variables). Injected once by whoever mounts a chip first. */
export const STREAM_SAFE_CSS = `
.vw-peek { display:inline-grid; place-items:center; width:26px; height:26px; padding:0; margin-left:2px; border-radius:99px; border:1px solid transparent; background:none; color:var(--dim, #9aa); cursor:pointer; vertical-align:middle; transition:color .18s cubic-bezier(.16,1,.3,1), border-color .18s cubic-bezier(.16,1,.3,1); }
.vw-peek:hover, .vw-peek[aria-pressed="true"] { color:var(--text, #eef3ef); border-color:var(--line, #333); }
.vw-peek:focus-visible { outline:2px solid #7bd88f; outline-offset:2px; }
.vw-safe { display:inline-flex; align-items:center; gap:2px; }
.vw-safe-name.vw-peeking, .vw-who .vw-peeking { color:var(--text, #eef3ef); }
@media (prefers-reduced-motion: reduce) { .vw-peek { transition:none; } }
`;
export function injectStreamSafeCss() {
  if (typeof document === 'undefined' || document.getElementById('vw-safe-style')) return;
  document.head.append(h('style', { id: 'vw-safe-style' }, STREAM_SAFE_CSS));
}
