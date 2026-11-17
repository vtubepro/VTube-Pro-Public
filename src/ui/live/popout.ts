// Live Control pop-out (live.html): the same surface as the studio's Live area in its own window — a second monitor or
// an OBS "Custom Browser Dock" (http://127.0.0.1:5191/live.html). Same origin, so it goes through the same loopback
// guards as every other page (/ws/deck and /ws refuse other websites). Party / outfit / health info arrives from the
// studio window as the bus liveStatus; if the studio is closed the tiles say so and the buttons reach nobody.
import '../../storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import '../../licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import '../../net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import { Bus } from '../../bus.ts';
import { EMPTY_STATUS, LIVE_STATUS_CMD, sanitizeStatus, type LiveStatus } from '../../../shared/liveControl.ts';
import { el, mountLiveControl } from './liveControl.ts';
import { dockButtonSpec } from '../dockEmbed.ts';
import { deckClient } from './deckClient.ts';
import { installHideScreenHotkey } from './hideHotkey.ts';

const CSS = `
:root, :root[data-theme=dark] { --bg:#0e1015; --panel:#13161d; --card:#1b1f28; --card2:#242a36; --card3:#2d3442; --line:#262b37; --text:#eef1f6; --dim:#a3abba; --faint:#717a8b;
  --accent:#7bd88f; --accent-ink:#08130b; --focus:#8ab4ff; --font-ui:"Segoe UI Variable Text","Segoe UI",Inter,system-ui,sans-serif; --font-display:"Segoe UI Variable Display","Segoe UI",Inter,system-ui,sans-serif; color-scheme: dark; }
:root[data-theme=light] { --bg:#eef0f4; --panel:#e6e9ef; --card:#ffffff; --card2:#f1f3f7; --card3:#e4e8ef; --line:#e0e4eb; --text:#141821; --dim:#525c6e; --faint:#7a8496; --accent:#23904a; --accent-ink:#ffffff; color-scheme: light; }
* { box-sizing: border-box; } html, body { margin: 0; height: 100%; background: var(--bg); color: var(--text); font: 13px/1.35 var(--font-ui); }
#app { height: 100%; padding: 12px; display: flex; flex-direction: column; } #app > .lc { flex: 1; }
html.narrow body { height: auto; } html.narrow #app { height: auto; padding: 8px; }
.lc-toast { position: fixed; right: 12px; bottom: 12px; background: var(--card2); border-radius: 10px; padding: 10px 14px; max-width: 420px; z-index: 9; box-shadow: 0 0 0 1px var(--line) inset, 0 12px 28px -12px #000a; }
.lc-toast.err { box-shadow: inset 3px 0 0 #ff6b6b, 0 0 0 1px var(--line) inset; } .lc-toast.ok { box-shadow: inset 3px 0 0 #3ddc84, 0 0 0 1px var(--line) inset; } .lc-toast.warn { box-shadow: inset 3px 0 0 #ffb454, 0 0 0 1px var(--line) inset; }
`;
// livepremium: light / dark like the studio (?theme=light|dark wins, else the system setting); narrow = OBS dock
const themeQ = new URLSearchParams(location.search).get('theme');
const applyTheme = () => { document.documentElement.dataset.theme = themeQ === 'light' || themeQ === 'dark' ? themeQ : matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'; };
applyTheme(); try { matchMedia('(prefers-color-scheme: light)').addEventListener('change', applyTheme); } catch { /* old browser */ }
const narrow = () => document.documentElement.classList.toggle('narrow', innerWidth < 760);
narrow(); addEventListener('resize', narrow);
document.head.append(el('style', null, CSS));
let status: LiveStatus = EMPTY_STATUS, seenAt = 0;
const subs = new Set<() => void>();
const bus = new Bus('control');
bus.on((m) => {
  if (m.type === 'command' && m.command === LIVE_STATUS_CMD) { status = sanitizeStatus(m.args); seenAt = Date.now(); for (const s of subs) s(); }
});
let tt = 0;
const toast = (msg: string, kind: string = 'info') => {
  document.querySelector('.lc-toast')?.remove();
  const t = el('div', { class: `lc-toast ${kind}`, role: 'status' }, msg); document.body.append(t);
  clearTimeout(tt); tt = window.setTimeout(() => t.remove(), 3500);
};
// no studio heartbeat for 5 s: show an empty studio (health tile goes grey)
setInterval(() => { if (seenAt && Date.now() - seenAt > 5000) { seenAt = 0; status = EMPTY_STATUS; for (const s of subs) s(); } }, 1000);
// (guest-camera thumbnails: the studio only grabs them while a view that shows them asks, at most every 1.5 s)
let thumbAsk = 0;
const wantThumbs = () => { const t = Date.now(); if (t - thumbAsk < 1500) return; thumbAsk = t; bus.send({ type: 'command', command: 'live', args: { op: 'thumbs' } }); };
mountLiveControl(document.getElementById('app')!, { status: () => status, onStatus: (cb) => { subs.add(cb); }, canRun: true, popout: true, toast, wantThumbs });
// live-tabs: the "Hide my screen" hotkey works here too (the pop-out / an OBS dock has the keyboard): the deck action
installHideScreenHotkey(() => { void deckClient().run('cover', { on: 'toggle' }).then((r) => toast(r.ok ? 'Hide my screen: switched' : `Hide my screen: ${r.error ?? 'failed'}`, r.ok ? 'ok' : 'err')); });
// docked: opened from the studio → "Dock back" (shows Live in the studio and closes this window)
const dockBack = dockButtonSpec('live');
if (dockBack) {
  const b = el('button', { class: 'lc-btn', 'data-live': 'dockback', 'data-tip': 'Dock back', 'data-hint': 'Show Live in the studio window and close this one', onClick: dockBack.run }, 'Dock back');
  const put = () => { const hd = document.querySelector('.lc-head'); if (hd && !hd.contains(b)) hd.append(b); };
  put(); document.addEventListener('vtp-live-layout', put); new MutationObserver(put).observe(document.getElementById('app')!, { childList: true, subtree: false });
  setInterval(put, 1000);
}
