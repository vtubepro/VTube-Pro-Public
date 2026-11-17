// The helper's own Track library page: http://127.0.0.1:5191/tools.html?view=djlib (src/tools/main.ts).
// The same panel as the studio's Scene tab → DJ sync → Track library (src/ui/djTrackPanel.ts), served by the server
// itself, so Find / Import / Pick a file / Allow folders / the beat finder all work here.
// No sound (the panel's browser-side analysis decodes offline, never plays), no storage of its own.
import { trackLibraryPageEl } from '../ui/djTrackPanel.ts';

// The studio's design tokens + the few studio classes the panel uses (button, switch, toast, tip, section chip), scoped
// to this page: tools.html has its own look and no studio stylesheet.
const CSS = `
body.djlib-page { --panel:#14171f; --card:#171b24; --card2:#1d2230; --card3:#262c3a; --line:#262b37; --line2:#3a4256;
  --text:#eef1f6; --dim:#a3abba; --faint:#8a93a3; --accent:#7bd88f; --accent2:#6cc7f5; --ok:#7bd88f; --ok-soft:rgb(123 216 143/.14); --warn:#ffb454; --err:#ff6b6b;
  color:var(--text); font:14px/1.45 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
.djlib { max-width:720px; margin:0 auto; padding:28px 16px 64px; }
.djlib .top { display:flex; align-items:center; gap:10px; font-weight:700; font-size:16px; margin-bottom:18px; }
.djlib .top svg { width:28px; height:28px; flex:none; }
.djlib h1 { font-size:26px; line-height:1.15; margin:0 0 6px; letter-spacing:-.01em; }
.djlib .lead { color:var(--dim); margin:0 0 14px; max-width:62ch; }
.djlib .card { border:1px solid var(--line); border-radius:16px; background:var(--panel); padding:4px 16px 12px; }
.djlib .card .dt-wrap { border-top:0; margin-top:6px; }
.djlib .back { color:var(--dim); font-size:12.5px; margin-top:12px; }
.djlib .btn { background:var(--card3); color:var(--text); border:1px solid #333b4b; border-radius:8px; padding:7px 11px; cursor:pointer; font:inherit; font-weight:500; }
.djlib .btn:hover { background:#2e3546; }
.djlib .btn.primary { background:var(--accent); color:#0b140d; border-color:transparent; font-weight:600; }
.djlib .btn:focus-visible, .djlib input:focus-visible, .djlib summary:focus-visible { outline:2px solid var(--accent); outline-offset:2px; }
.djlib input[type=search], .djlib input[type=number] { background:var(--card2); color:var(--text); border:1px solid var(--line); border-radius:8px; padding:7px 9px; font:inherit; }
.djlib details { margin-top:8px; } .djlib summary { cursor:pointer; color:var(--dim); font-size:12.5px; padding:4px 0; }
.djlib .row { display:grid; grid-template-columns:1fr auto; align-items:center; gap:8px; padding:6px 0; font-size:13px; }
.djlib .switch { position:relative; width:36px; height:20px; justify-self:end; }
.djlib .switch input { opacity:0; width:100%; height:100%; position:absolute; margin:0; cursor:pointer; z-index:1; }
.djlib .switch i { position:absolute; inset:0; background:#2d3340; border-radius:99px; transition:.15s; }
.djlib .switch i::after { content:''; position:absolute; left:3px; top:3px; width:14px; height:14px; border-radius:50%; background:#cfd5e0; transition:.15s; }
.djlib .switch input:checked + i { background:var(--accent); } .djlib .switch input:checked + i::after { left:19px; background:#0d1a10; }
.djlib .dj-tip { font-size:12px; color:var(--dim); line-height:1.45; border:1px dashed var(--line2); border-radius:10px; padding:8px 10px; margin:6px 0; }
.djlib .dj-sec { font-size:10.5px; font-weight:700; text-transform:uppercase; padding:1px 6px; border-radius:99px; background:var(--card3); }
body.djlib-page #toasts { position:fixed; left:50%; bottom:20px; transform:translateX(-50%); display:flex; flex-direction:column; gap:6px; z-index:9000; width:min(520px, calc(100vw - 32px)); }
body.djlib-page #toasts .toast { padding:10px 14px; border-radius:10px; background:#1b1f28; color:var(--text); border:1px solid #333a4a; font-size:13px; box-shadow:0 8px 24px #0008; transition:opacity .3s; }
body.djlib-page #toasts .toast.ok { border-color:var(--ok); } body.djlib-page #toasts .toast.warn, body.djlib-page #toasts .toast.err { border-color:var(--warn); }
body.djlib-page #toasts .toast.out { opacity:0; }
`;

export function mountDjlib(root: HTMLElement, mark: () => SVGElement) {
  const st = document.createElement('style'); st.textContent = CSS; document.head.append(st);
  document.body.classList.add('djlib-page');
  document.title = 'VTube Pro — Track library';
  const el = (tag: string, cls: string, ...kids: (Node | string)[]) => { const e = document.createElement(tag); if (cls) e.className = cls; e.append(...kids); return e; };
  const card = el('div', 'card', trackLibraryPageEl());
  root.replaceChildren(el('main', 'djlib',
    el('div', 'top', mark(), 'VTube Pro'),
    el('h1', '', 'Your track library'),
    el('p', 'lead', 'Press “Find my DJ libraries”, then “Import”. VTube Pro reads your DJ app’s collection (rekordbox, Engine DJ, Traktor, Serato, VirtualDJ, Mixxx) on this PC, read-only: nothing in your DJ app is changed, and nothing leaves this computer.'),
    card,
    el('p', 'back', 'Done? Go back to the studio tab: it shows your tracks by itself. Keep this tab open while you’re not live if it asks to learn tracks here.')));
}
