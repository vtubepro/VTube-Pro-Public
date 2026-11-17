// Docked tools, tool side (docked workstream): used by chathub.html, deck.html and live.html. Docked (a frame in the
// studio's drawer, ?docked=1): the page's "Pop out ↗" asks the studio to open it in its own window, Esc closes the
// drawer and the studio's light / dark tokens are copied in. In its own window: "Dock back" puts it back in the
// studio (BroadcastChannel, same origin) and closes the window. No studio imports: these pages stay small.
// live-tabs: a docked frame hands the "Hide my screen" hotkey up to the studio (it has the keyboard, not the studio).
import { forwardHideScreenHotkey } from './live/hideHotkey.ts';
export const DOCK_CHANNEL = 'vtp-dock';
export type DockTool = 'chathub' | 'deck' | 'aiconnect' | 'live';
export type DockMsg = { k: 'dock' | 'popout' | 'close'; tool: DockTool } | { k: 'open'; tool: DockTool; open: DockTool };

type Host = { vtpDock?: { msg(m: DockMsg): void } };
/** The studio hosting this page as a drawer (same origin), or null. */
function host(): Host['vtpDock'] | null {
  try { return window.parent !== window ? (window.parent as unknown as Host).vtpDock ?? null : null; } catch { return null; }
}
export const isDocked = () => new URLSearchParams(location.search).get('docked') === '1' && !!host();

/** Tell the studio (drawer host, or any open studio tab for 'dock'). */
export function dockSend(m: DockMsg) {
  const h = host();
  if (h && m.k !== 'dock') { h.msg(m); return; }
  try { const ch = new BroadcastChannel(DOCK_CHANNEL); ch.postMessage(m); ch.close(); } catch { /* old browser */ }
}

/** Docked: studio tokens (dark / light), compact class, Esc → close the drawer. Call once at start-up. */
export function initDockedPage(tool: DockTool) {
  if (!isDocked()) return;
  forwardHideScreenHotkey();
  // F1 = the studio's Help (the frame has the keyboard): never let the browser open its own help tab from here
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'F1' || e.ctrlKey || e.altKey || e.metaKey) return;
    e.preventDefault(); e.stopImmediatePropagation();
    try { window.parent.postMessage({ k: 'vtp-help-f1' }, location.origin); } catch { /* not same origin */ }
  }, true);
  const root = document.documentElement;
  root.classList.add('vtp-docked');
  const sync = () => {
    try {
      const p = window.parent.document.documentElement, cs = window.parent.getComputedStyle(p);
      for (const v of ['--bg', '--panel', '--card', '--card2', '--card3', '--line', '--line2', '--text', '--dim', '--faint', '--accent', '--accent-ink', '--focus', '--font-ui', '--font-display']) {
        const x = cs.getPropertyValue(v).trim(); if (x) root.style.setProperty(`--vtp${v.slice(1)}`, x);
      }
      root.dataset.theme = p.dataset.theme === 'light' ? 'light' : 'dark';
      root.style.colorScheme = root.dataset.theme;
    } catch { /* not same origin */ }
  };
  sync();
  try { new MutationObserver(sync).observe(window.parent.document.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class', 'style'] }); } catch { /* */ }
  addEventListener('keydown', (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || e.defaultPrevented) return;
    if (document.querySelector('.modal, dialog[open], [role=dialog]')) return; // the page's own dialog closes first
    const a = document.activeElement as HTMLElement | null;
    if (a && (a.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) && (a as HTMLInputElement).value) return;
    dockSend({ k: 'close', tool });
  });
}

/** The page's own "Dock back" button in a window the studio opened (docked, the drawer's header has "Pop out ↗"). */
export function dockButtonSpec(tool: DockTool): { label: string; title: string; run(): void } | null {
  if (isDocked()) return null;
  if (!window.opener) return null; // opened by hand / an OBS dock: nothing to dock back into
  return {
    label: 'Dock back', title: 'Put this back inside the studio window and close this window',
    run: () => { dockSend({ k: 'dock', tool }); setTimeout(() => window.close(), 150); },
  };
}
