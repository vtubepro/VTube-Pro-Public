// Live > "Stream extras" (docs/b16/LANES.md): ONE place that lists the screens the beta.16 lanes registered with registerB16Panel
// (Redeems & reactions, Throw, Stickers, Emote rain, Sound ...). A small button on the Live area opens it as a panel over the
// page; each card opens that lane's own screen. Simple first: the screens marked `simple` show, the rest sit under "More".
// Nothing is built until the user opens it (the panels are mounted on click, destroyed on close): idle = zero cost.
import { listB16Panels, onB16Panels, type B16Panel, type B16PanelHandle } from '../b16/panels.ts';
import { EXTRAS_HELP, EXTRAS_HELP_INDEX } from '../../shared/helpCatalog.ts';

const CSS = `
.vtx-btn { position: fixed; right: 16px; bottom: 16px; z-index: 60; min-height: 36px; padding: 0 14px; border-radius: 999px; border: 1px solid color-mix(in srgb, var(--text, #eef1f6) 18%, transparent);
  background: var(--card2, #222733); color: var(--text, #eef1f6); font: inherit; font-weight: 700; cursor: pointer; box-shadow: 0 6px 18px -8px #000c; }
.vtx-btn:hover { border-color: var(--accent, #7bd88f); }
.vtx-back { position: fixed; inset: 0; z-index: 400; background: #0009; display: flex; align-items: center; justify-content: center; padding: 18px; }
.vtx { width: min(920px, 100%); max-height: 100%; overflow: auto; background: var(--panel, #161920); color: var(--text, #eef1f6); border: 1px solid color-mix(in srgb, var(--text, #eef1f6) 16%, transparent);
  border-radius: 14px; padding: 16px; display: flex; flex-direction: column; gap: 12px; font-size: 13px; box-shadow: 0 24px 60px -20px #000; }
.vtx * { box-sizing: border-box; }
.vtx button { font: inherit; color: inherit; cursor: pointer; }
.vtx-head { display: flex; align-items: center; gap: 10px; }
.vtx-head h2 { margin: 0; font-size: 18px; flex: 1; }
.vtx-x { min-height: 32px; padding: 0 12px; border-radius: 8px; border: 1px solid color-mix(in srgb, var(--text, #eef1f6) 16%, transparent); background: var(--card2, #222733); }
.vtx-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(250px, 1fr)); gap: 10px; }
.vtx-card { text-align: left; padding: 12px; border-radius: 10px; border: 1px solid color-mix(in srgb, var(--text, #eef1f6) 14%, transparent); background: var(--card, #1b1f28); display: flex; flex-direction: column; gap: 4px; }
.vtx-card:hover { border-color: var(--accent, #7bd88f); }
.vtx-card b { font-size: 14px; }
.vtx-card span { color: var(--dim, #a3abba); }
.vtx-help { width: 32px; min-height: 32px; border-radius: 50%; border: 1px solid color-mix(in srgb, var(--text, #eef1f6) 16%, transparent); background: var(--card2, #222733); font-weight: 800; }
.vtx-help:hover { border-color: var(--accent, #7bd88f); }
.vtx-empty { padding: 16px; text-align: center; color: var(--dim, #a3abba); }
`;

let open: { close(): void } | null = null;

/** Open the Help guide at one screen's section. Help sits above this panel (its own layer is lower, so it is raised for the moment it is open). */
export function openExtrasHelp(target: string): void {
  void import('../ui/help/helpViewer.ts').then((m) => {
    m.openHelp(target);
    const hv = document.querySelector<HTMLElement>('.hv-back');
    if (hv) hv.style.zIndex = '500';
  }).catch(() => { /* no guide in this build: the button simply does nothing */ });
}

function ensureCss() {
  if (document.getElementById('vtp-extras-css')) return;
  const s = document.createElement('style'); s.id = 'vtp-extras-css'; s.textContent = CSS; document.head.append(s);
}
const node = <K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string) => { const e = document.createElement(tag); if (cls) e.className = cls; if (text !== undefined) e.textContent = text; return e; };

/** Open the Stream extras panel (optionally straight into one screen). Opening it twice just closes the old one first. */
export function openStreamExtras(panelId?: string): void {
  open?.close();
  ensureCss();
  const back = node('div', 'vtx-back');
  const box = node('div', 'vtx'); box.setAttribute('role', 'dialog'); box.setAttribute('aria-label', 'Stream extras'); box.setAttribute('aria-modal', 'true');
  back.append(box);
  let handle: B16PanelHandle | void = undefined;
  let offList: (() => void) | null = null;

  const close = () => {
    try { handle?.destroy(); } catch { /* a screen that fails to close must not trap the user */ }
    offList?.(); back.remove(); document.removeEventListener('keydown', onKey, true);
    if (open === me) open = null;
  };
  const me = { close };
  open = me;
  // (Esc closes the guide first when it is open on top of this panel)
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !document.querySelector('.hv-back')) { e.stopPropagation(); close(); } };
  document.addEventListener('keydown', onKey, true);
  back.addEventListener('pointerdown', (e) => { if (e.target === back) close(); });

  const head = (title: string, onBack?: () => void, helpTarget?: string) => {
    const hd = node('div', 'vtx-head');
    if (onBack) { const b = node('button', 'vtx-x', 'Back'); b.type = 'button'; b.addEventListener('click', onBack); hd.append(b); }
    const t = node('h2', '', title); hd.append(t);
    if (helpTarget) {
      const q = node('button', 'vtx-help', '?'); q.type = 'button'; q.dataset.help = helpTarget; q.title = `Help: ${title}`; q.setAttribute('aria-label', `Help for ${title}`);
      q.addEventListener('click', () => openExtrasHelp(helpTarget)); hd.append(q);
    }
    const x = node('button', 'vtx-x', 'Close'); x.type = 'button'; x.addEventListener('click', close); hd.append(x);
    return hd;
  };

  const showPanel = (p: B16Panel) => {
    handle?.destroy(); handle = undefined; offList?.(); offList = null;
    const host = node('div'); host.dataset.panel = p.id;
    box.replaceChildren(head(p.title, () => showList(), EXTRAS_HELP[p.id] ?? EXTRAS_HELP_INDEX), host);
    try { handle = p.mount(host); } catch (e) { host.textContent = 'This screen could not open.'; console.warn('[b16] panel', p.id, e); }
  };
  let showMore = false;
  const showList = () => {
    handle?.destroy(); handle = undefined;
    const draw = () => {
      const all = listB16Panels(), simple = all.filter((p) => p.simple), more = all.filter((p) => !p.simple);
      const card = (p: B16Panel) => {
        const c = node('button', 'vtx-card'); c.type = 'button'; c.dataset.panel = p.id;
        c.append(node('b', '', p.title), node('span', '', p.blurb));
        c.addEventListener('click', () => showPanel(p));
        return c;
      };
      const kids: HTMLElement[] = [head('Stream extras', undefined, EXTRAS_HELP_INDEX)];
      if (!all.length) kids.push(node('div', 'vtx-empty', 'Stream extras are still starting. Give it a few seconds.'));
      else {
        const g = node('div', 'vtx-grid'); g.append(...(simple.length ? simple : more).map(card)); kids.push(g);
        if (simple.length && more.length) {
          const mb = node('button', 'vtx-x', showMore ? 'Hide the rest' : `More (${more.length})`); mb.type = 'button';
          mb.addEventListener('click', () => { showMore = !showMore; draw(); });
          kids.push(mb);
          if (showMore) { const g2 = node('div', 'vtx-grid'); g2.append(...more.map(card)); kids.push(g2); }
        }
      }
      box.replaceChildren(...kids);
    };
    draw();
    offList?.(); offList = onB16Panels(draw);
  };

  document.body.append(back);
  const want = panelId ? listB16Panels().find((p) => p.id === panelId) : undefined;
  if (want) showPanel(want); else showList();
}

/** The small "Stream extras" button the Live area carries (position: fixed, bottom right). Returns the function that removes it. */
export function mountExtrasButton(): () => void {
  ensureCss();
  const b = node('button', 'vtx-btn', 'Stream extras'); b.type = 'button'; b.dataset.extras = '1';
  b.title = 'Redeems & reactions, throw, stickers, emote rain and more';
  b.addEventListener('click', () => openStreamExtras());
  document.body.append(b);
  return () => { b.remove(); };
}
