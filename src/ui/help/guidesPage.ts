// The Guides page: every guide, as a page inside the studio (rail "Guides", Help → All guides). Owner: "guides need to
// be in the studio". It covers the area right of the rail and under the top bar; the studio underneath is
// never re-rendered. Two views:
//   list  — a search box + every guide, grouped (cards with title + one line); typing shows the
//           matching guides and the matching sections of any guide (the Help viewer's full-text search).
//   guide — the guide read right here (pictures, "On this page", links to other guides open in place), with
//           "← All guides" back to the list.
// "← Back to studio", Esc and picking a rail area close it. Same catalog as the Help viewer (helpViewer.ts): this
// computer's docs/ (no network needed). Read-only: never changes a setting, never makes a sound.
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { escapeHtml } from '../../../shared/markdown.ts';
import { buildIndex, getHelpCatalog, initHelpStyles, renderGuide, scrollToSection, searchHelp, type Catalog, type Entry } from './helpViewer.ts';

let root: HTMLElement | null = null;
let main: HTMLElement | null = null;
let searchEl: HTMLInputElement | null = null;
let backFrom: HTMLElement | null = null;
let cat: Catalog | null = null;
let current = '';
let seq = 0;
let hooks: { onChange?: () => void; beforeOpen?: () => void } = {};

export const isGuidesOpen = () => !!root?.isConnected;

/** Wire it once (src/ui/shell.ts): `beforeOpen` closes other pages, `onChange` repaints the rail. */
export function initGuidesPage(o: { onChange?: () => void; beforeOpen?: () => void }) {
  hooks = o;
  window.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !isGuidesOpen() || e.defaultPrevented) return;
    if (document.querySelector('.hv-back, .wiz-back, dialog[open], .gd-menu')) return; // something on top owns Esc
    e.preventDefault();
    if (searchEl && document.activeElement === searchEl && searchEl.value) { searchEl.value = ''; void paintList(); return; }
    closeGuides();
  }, true);
  window.addEventListener('resize', place);
}

/** Open the page: at the list, or right at a guide (`FILE.md#a`). */
export function openGuides(target?: string, from?: HTMLElement | null) {
  initHelpStyles();
  if (!isGuidesOpen()) {
    hooks.beforeOpen?.();
    backFrom = from ?? (document.activeElement instanceof HTMLElement ? document.activeElement : null);
    build();
    document.body.append(root!);
    document.body.classList.add('gp-open');
    place();
    hooks.onChange?.();
  }
  void start(target);
}
/** Close (Back to studio / Esc / a rail area). */
export function closeGuides() {
  if (!root) return;
  root.remove();
  root = main = searchEl = null;
  current = '';
  document.body.classList.remove('gp-open');
  if (backFrom?.isConnected) backFrom.focus({ preventScroll: true });
  backFrom = null;
  hooks.onChange?.();
}

function place() {
  if (!root) return;
  const top = document.getElementById('topbar')?.getBoundingClientRect();
  const rail = document.getElementById('tabs')?.getBoundingClientRect();
  const clean = document.body.classList.contains('clean');
  root.style.top = `${clean || !top ? 0 : Math.max(0, Math.round(top.bottom))}px`;
  root.style.left = `${clean || !rail || rail.width === 0 || rail.height < innerHeight / 3 ? 0 : Math.max(0, Math.round(rail.right))}px`;
}

function build() {
  if (!document.getElementById('gp-css')) document.head.append(h('style', { id: 'gp-css' }, GP_CSS));
  searchEl = h('input', { type: 'search', placeholder: 'Search every guide…', 'aria-label': 'Search the guides', autocomplete: 'off', spellcheck: false, 'data-ui': 'guides-search' }) as HTMLInputElement;
  let st = 0;
  searchEl.addEventListener('input', () => { clearTimeout(st); st = window.setTimeout(() => void paintList(), 120); });
  searchEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); (main?.querySelector('.gp-card, .gp-hit') as HTMLElement | null)?.click(); } });
  main = h('div', { class: 'gp-main' });
  root = h('section', { class: 'gp', 'aria-label': 'Guides', 'data-ui': 'guides-page' },
    h('header', { class: 'gp-bar' },
      h('button', { class: 'gp-close', title: 'Back to the studio (Esc)', 'data-ui': 'guides-close', onClick: () => closeGuides() }, icon('back', 18), h('span', null, 'Back to studio')),
      h('div', { class: 'gp-crumb' }, icon('book', 18), h('b', null, 'Guides')),
      h('div', { class: 'gp-search' }, icon('search', 16), searchEl)),
    main);
  root.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a') as HTMLAnchorElement | null;
    if (!a || !root?.contains(a)) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#hv:')) { e.preventDefault(); const t = href.slice(4); if (t.startsWith('#') || t === '') { if (!t) void paintList(); else jump(t.slice(1)); } else void showGuide(t); }
    else if (href.startsWith('#hv-file:')) { e.preventDefault(); a.title = `In your VTube Pro folder: ${href.slice(9)}`; a.classList.add('hv-nolink'); }
    else if (href.startsWith('#gp-sec:')) { e.preventDefault(); jump(href.slice(8)); }
  });
}

async function start(target?: string) {
  const my = ++seq;
  if (!cat) {
    main?.replaceChildren(h('p', { class: 'gp-note' }, 'Getting the guides…'));
    try { cat = await getHelpCatalog(); } catch {
      if (my !== seq || !main) return;
      main.replaceChildren(h('div', { class: 'gp-empty' }, h('h1', null, 'We couldn’t get the guides'), h('p', null, 'Check your internet, then try again.'),
        h('button', { class: 'btn primary', onClick: () => void start(target) }, 'Try again')));
      return;
    }
  }
  if (my !== seq) return;
  if (target && target !== 'README.md') await showGuide(target);
  else { if (searchEl) searchEl.value = ''; await paintList(); setTimeout(() => searchEl?.focus({ preventScroll: true }), 0); }
}

const groupsOf = (c: Catalog) => c.groups.map((g) => ({ g, ds: c.docs.filter((d) => d.group === g && d.file !== c.home) })).filter((x) => x.ds.length);
const card = (d: Entry) => h('button', { class: 'gp-card', 'data-guide': d.file, title: d.blurb, onClick: () => void showGuide(d.file) },
  h('b', null, d.title), h('span', null, d.blurb), d.notice ? h('em', null, d.notice.startsWith('This is an in-depth') ? 'In depth' : 'Host only') : null);

async function paintList() {
  const c = cat, m = main;
  if (!c || !m) return;
  current = '';
  const q = searchEl?.value.trim() ?? '';
  if (!q) {
    m.replaceChildren(
      h('div', { class: 'gp-hero' }, h('h1', null, 'Guides'), h('p', null, 'Every guide, right here in the studio. Search finds any word.')),
      ...groupsOf(c).map(({ g, ds }) => h('section', { class: 'gp-group' }, h('h2', null, g), h('div', { class: 'gp-grid' }, ...ds.map(card)))));
    m.scrollTop = 0;
    return;
  }
  const words = q.toLowerCase().split(/\s+/).filter(Boolean);
  const named = c.docs.filter((d) => d.file !== c.home && words.every((w) => `${d.title} ${d.blurb}`.toLowerCase().includes(w)));
  const idx = await buildIndex(c);
  if ((searchEl?.value.trim() ?? '') !== q || main !== m) return;
  const hits = searchHelp(idx, q);
  m.replaceChildren(
    h('div', { class: 'gp-hero small' }, h('h1', null, hits.length || named.length ? `Results for “${q}”` : `Nothing found for “${q}”`),
      h('p', null, hits.length || named.length ? `${named.length} guide${named.length === 1 ? '' : 's'} by name · ${hits.length === 40 ? '40+' : hits.length} section${hits.length === 1 ? '' : 's'} that mention it` : 'Try one word, like “OBS”, “mic”, “guest” or “outfit”.')),
    named.length ? h('section', { class: 'gp-group' }, h('h2', null, 'Guides'), h('div', { class: 'gp-grid' }, ...named.map(card))) : '',
    hits.length ? h('section', { class: 'gp-group' }, h('h2', null, 'Sections'), h('div', { class: 'gp-hits', 'data-ui': 'guides-hits' }, ...hits.map((x) => {
      const b = h('button', { class: 'gp-hit', onClick: () => void showGuide(`${x.doc.file}${x.sec.id ? `#${x.sec.id}` : ''}`) },
        h('b', null, x.sec.title || x.doc.title), h('small', null, x.doc.title));
      const p = h('span'); p.innerHTML = snippet(x.sec.text, q); b.append(p);
      return b;
    }))) : '');
  m.scrollTop = 0;
}

function snippet(text: string, q: string) {
  const ws = q.toLowerCase().split(/\s+/).filter((w) => w.length > 1);
  const low = text.toLowerCase();
  let at = -1;
  for (const w of ws) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const s0 = Math.max(0, at - 60);
  let s = escapeHtml((s0 ? '…' : '') + text.slice(s0, s0 + 180) + (s0 + 180 < text.length ? '…' : ''));
  for (const w of ws) s = s.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return s;
}

async function showGuide(target: string) {
  const c = cat, m = main;
  if (!c || !m) return;
  const [file, anchor] = c.resolve(target);
  if (!file) { await paintList(); return; }
  current = `${file}${anchor ? `#${anchor}` : ''}`;
  const key = current;
  const r = await renderGuide(c, file, () => current);
  if (current !== key || main !== m) return;
  const entry = c.docs.find((d) => d.file === file);
  const art = h('article', { class: 'hv-doc gp-doc', tabindex: -1, 'data-ui': 'guides-doc', 'data-guide': file });
  if (r) art.innerHTML = r.html;
  else art.replaceChildren(h('h1', null, 'Not here'), h('p', null, `“${file}” is not part of the guides in this studio.`));
  const subs = (r?.headings ?? []).filter((x) => x.level === 2);
  const toc = subs.length > 2 ? h('nav', { class: 'gp-toc', 'aria-label': 'On this page' }, h('span', null, 'On this page'), ...subs.map((x) => h('a', { href: `#gp-sec:${x.id}` }, x.text))) : null;
  m.replaceChildren(
    h('div', { class: 'gp-docbar' },
      h('button', { class: 'gp-list', 'data-ui': 'guides-all', onClick: () => { if (searchEl) searchEl.value = ''; void paintList(); } }, icon('prev', 16), h('span', null, 'All guides')),
      entry ? h('span', { class: 'gp-where' }, entry.group) : null),
    h('div', { class: 'gp-read' }, art, toc));
  m.scrollTop = 0;
  if (anchor) jump(anchor); else art.focus({ preventScroll: true });
}

function jump(id: string) {
  const m = main;
  const el = m?.querySelector<HTMLElement>(`.gp-doc [id="${CSS.escape(id)}"]`);
  if (!m || !el) return;
  scrollToSection(m, el, (m.querySelector('.gp-docbar') as HTMLElement | null)?.offsetHeight ?? 0);
}

const GP_CSS = `
.gp { position: fixed; z-index: 46; top: 48px; left: 78px; right: 0; bottom: 0; display: grid; grid-template-rows: auto 1fr; background: var(--bg); color: var(--text); }
.clean .gp { top: 0 !important; left: 0 !important; }
body.gp-open .tt-launch, body.gp-open .tt-drawer { display: none !important; }
.gp-bar { display: flex; align-items: center; gap: 14px; padding: 10px 28px; border-bottom: 1px solid var(--line); background: var(--bg2, var(--bg)); }
.gp-close, .gp-list { display: inline-flex; align-items: center; gap: 8px; height: 40px; padding: 0 16px 0 12px; border-radius: 12px; border: 1px solid var(--line2); background: var(--card); color: var(--text); font: 650 14px/1 inherit; cursor: pointer; flex: none; }
.gp-list { height: 34px; font-size: 13px; }
.gp-close:hover, .gp-list:hover { background: var(--card2); border-color: var(--accent); }
.gp-crumb { display: inline-flex; align-items: center; gap: 8px; color: var(--accent); flex: none; }
.gp-crumb b { color: var(--text); font-size: 16px; }
.gp-search { flex: 1; max-width: 560px; margin-left: auto; display: flex; gap: 8px; align-items: center; padding: 0 12px; border: 1px solid var(--line2); border-radius: 12px; background: var(--input, var(--card)); }
.gp-search input { flex: 1; min-width: 0; border: 0 !important; background: transparent !important; padding: 10px 0 !important; color: var(--text); font-size: 14px; outline: none; box-shadow: none !important; }
.gp-main { overflow-y: auto; overflow-x: hidden; padding: 8px 32px 64px; overscroll-behavior: contain; }
.gp-note { color: var(--dim); padding: 24px 0; }
.gp-hero { max-width: 1180px; margin: 18px auto 6px; }
.gp-hero h1 { margin: 0; font: 750 34px/1.1 var(--font-display, inherit); letter-spacing: -.02em; }
.gp-hero.small h1 { font-size: 24px; }
.gp-hero p { margin: 8px 0 0; color: var(--dim); font-size: 15px; }
.gp-group { max-width: 1180px; margin: 22px auto 0; }
.gp-group h2 { margin: 0 0 10px; font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
.gp-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 10px; }
.gp-card { position: relative; text-align: left; padding: 14px 16px; border-radius: 14px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; cursor: pointer; transition: border-color 160ms, transform 160ms; }
.gp-card:hover, .gp-card:focus-visible { border-color: var(--accent); transform: translateY(-1px); }
.gp-card b { display: block; font-size: 15px; font-weight: 650; }
.gp-card span { display: block; margin-top: 4px; font-size: 12.5px; line-height: 1.45; color: var(--dim); }
.gp-card em { position: absolute; top: 10px; right: 12px; font-style: normal; font-size: 10px; text-transform: uppercase; letter-spacing: .08em; color: var(--accent2); }
.gp-hits { display: grid; gap: 6px; }
.gp-hit { text-align: left; padding: 10px 14px; border-radius: 12px; border: 1px solid var(--line); background: var(--card); color: var(--text); font: inherit; cursor: pointer; }
.gp-hit:hover, .gp-hit:focus-visible { border-color: var(--accent); }
.gp-hit b { display: block; font-size: 14px; }
.gp-hit small { display: block; font-size: 12px; color: var(--accent2); margin-top: 2px; }
.gp-hit span { display: block; font-size: 12.5px; color: var(--dim); margin-top: 4px; line-height: 1.45; }
.gp-hit mark { background: var(--accent-soft); color: var(--text); border-radius: 3px; padding: 0 1px; }
.gp-docbar { position: sticky; top: -8px; z-index: 2; display: flex; align-items: center; gap: 12px; max-width: 1180px; margin: 0 auto; padding: 12px 0 10px; background: var(--bg); }
.gp-where { font-size: 12px; text-transform: uppercase; letter-spacing: .08em; color: var(--faint); }
.gp-read { display: grid; grid-template-columns: minmax(0, 860px) 240px; gap: 36px; max-width: 1180px; margin: 0 auto; align-items: start; }
.gp-toc { position: sticky; top: 52px; display: grid; gap: 6px; padding: 12px 14px; border-left: 1px solid var(--line); font-size: 12.5px; }
.gp-toc span { color: var(--faint); text-transform: uppercase; letter-spacing: .06em; font-size: 11px; }
.gp-toc a { color: var(--accent2); text-decoration: none; }
.gp-toc a:hover { text-decoration: underline; }
.gp-doc, .gp-doc:focus, .gp-doc:focus-visible { outline: none; box-shadow: none; }
.gp-empty { max-width: 640px; margin: 48px auto; }
@media (max-width: 1100px) { .gp-read { grid-template-columns: minmax(0, 1fr); } .gp-toc { display: none; } }
@media (max-width: 760px) { .gp-bar { padding: 8px 12px; gap: 8px; flex-wrap: wrap; } .gp-close span { display: none; } .gp-main { padding: 8px 14px 48px; } }
`;
