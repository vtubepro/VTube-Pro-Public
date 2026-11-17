// The in-app Help viewer: every user guide (shared/helpCatalog.ts) bundled into the studio at build time, so it works
// offline, with the studio server stopped, and in the release zip. A searchable overlay: guide list on the left, the
// rendered guide (shared/markdown.ts) on the right, links between guides open in place, Back goes back. Opened from the
// top bar's ? button, F1, the "?" next to each area's title (AREA_HELP) and the guided set-ups. Read-only: it never
// changes a setting, never talks to OBS, never makes a sound.
// Studio targets like `LIVE_PANEL.md#polls` are matched to the bundled guides by their file name.
// The Guides page (src/ui/help/guidesPage.ts, rail "Guides") shows the same catalog as a full page in the studio.
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { HELP_DOCS, HELP_GROUPS, splitTarget, type HelpDoc } from '../../../shared/helpCatalog.ts';
import { escapeHtml, markdownSections, renderMarkdownDoc, type MdSection } from '../../../shared/markdown.ts';

// The bundled guides. Keep this list literal (Vite reads it at build time) and in step with HELP_DOCS: tools/docs_unit.ts
// checks both ways. Files missing from a build are simply not offered.
const RAW = import.meta.glob<() => Promise<string>>([
  '/docs/README.md', '/docs/QUICK_START.md', '/docs/TUTORIALS.md', '/docs/SIMPLE_MODE.md', '/docs/ADVANCED_MODE.md', '/docs/LIVE_PANEL.md', '/docs/GO_LIVE.md', '/docs/BRB_SCREENS.md',
  '/docs/GUESTS_AND_PARTIES.md', '/docs/HOSTING_SETUP.md', '/docs/STREAM_DECK.md', '/docs/STREAM_EXTRAS.md', '/docs/CHAT_HUB.md', '/docs/MULTICAM.md', '/docs/VOICE.md', '/docs/LIP_SYNC.md', '/docs/SOUND.md', '/docs/PHONE_TRACKING.md', '/docs/TWO_PC_STREAMING.md',
  '/docs/AVATARS_SIMPLE.md', '/docs/ENVIRONMENTS_SIMPLE.md', '/docs/AVATARS_ADVANCED.md', '/docs/ENVIRONMENTS_ADVANCED.md', '/docs/PRO2D.md', '/docs/MOVING_ROOMS.md',
  '/docs/MAKE_WITH_CLAUDE_OR_CODEX.md', '/docs/ARTIST_AVATARS.md', '/docs/ARTIST_ENVIRONMENTS.md', '/docs/AI_CONNECT.md', '/docs/INTEGRATION.md', '/docs/GPU_TRACKING.md',
], { query: '?raw', import: 'default' });
const IMG = import.meta.glob<string>('/docs/img/*.{png,jpg,jpeg,webp,gif,svg}', { query: '?url', import: 'default', eager: true });

const base = (p: string) => p.slice(p.lastIndexOf('/') + 1);
const loaders = new Map<string, () => Promise<string>>(Object.entries(RAW).map(([p, f]) => [base(p), f]));
const images = new Map<string, string>(Object.entries(IMG).map(([p, u]) => [base(p), u]));
/** The guides present in this build, in catalog order. */
export const helpDocs = (): HelpDoc[] => HELP_DOCS.filter((d) => loaders.has(d.file));

const cache = new Map<string, string>();
async function load(file: string): Promise<string | null> {
  if (cache.has(file)) return cache.get(file)!;
  const f = loaders.get(file);
  if (!f) return null;
  try { const md = await f(); cache.set(file, md); return md; } catch { return null; }
}

// ---------------------------------------------------------------- the guides: bundled with the studio
/** One guide in the viewer. `file` is its key: the docs file name. */
export interface Entry extends Omit<HelpDoc, 'group'> { group: string; src?: string; notice?: string }
export interface Catalog {
  /** Always 'local' (docs/ bundled). */
  from: 'local';
  groups: string[];
  docs: Entry[];
  /** The index shown for "no target" / "README.md". */
  home: string;
  load(key: string): Promise<string | null>;
  /** Any target (`FILE.md#a`) → [key, anchor]; key '' = not found. */
  resolve(target: string): [string, string];
  /** A guide picture's address for this build ('' = not available). */
  image(src: string): string | null;
}
const bundledCatalog = (): Catalog => ({
  from: 'local', groups: [...HELP_GROUPS], docs: helpDocs(), home: 'README.md', load,
  resolve: (t) => {
    let [f, a] = splitTarget(t);
    return [loaders.has(f) ? f : '', a];
  },
  image: (src) => images.get(base(src)) ?? null,
});

/** The guides this studio shows: the ones bundled from the docs folder. */
let localCat: Catalog | null = null;
export const getHelpCatalog = (): Promise<Catalog> => Promise.resolve(localCat ??= bundledCatalog());
const catalog = getHelpCatalog;
/** Kept for the shell: the guides are bundled, so there is nothing to load ahead of time. */
export function preloadHelp() { void getHelpCatalog(); }

/** The pieces a page needs to show one guide: links that open in place, pictures from this build. */
export function guideLinker(cat: Catalog, current: () => string) {
  return (href: string) => {
    if (/^(https?:|mailto:)/i.test(href)) return { href, external: true };
    if (href.startsWith('#')) return { href: `#hv:${current().split('#')[0]}${href}`, external: false };
    const m = /^(?:\.\/|docs\/|\.\.\/docs\/)?([A-Za-z0-9_]+\.md)(#[\w-]*)?$/.exec(href);
    if (m && loaders.has(m[1])) return { href: `#hv:${m[1]}${m[2] ?? ''}`, external: false };
    return { href: `#hv-file:${href.replace(/^\.\.\//, '').replace(/^\.\//, m ? 'docs/' : '')}`, external: false };
  };
}
/** Scroll `main` so the section heading `el` sits at the top (below `pad` px of sticky bar), flash it, and keep it there
 *  while the guide's pictures above it finish loading (each one pushes the text down) unless the reader scrolls first. */
export function scrollToSection(main: HTMLElement, el: HTMLElement, pad = 0) {
  const place = () => { main.scrollTop = Math.max(0, main.scrollTop + el.getBoundingClientRect().top - main.getBoundingClientRect().top - pad - 12); return main.scrollTop; };
  let set = place();
  el.classList.add('hv-flash'); window.setTimeout(() => el.classList.remove('hv-flash'), 1600);
  const art = el.closest('article') ?? main;
  const until = Date.now() + 8000;
  for (const img of art.querySelectorAll('img')) {
    if (img.complete || !(img.compareDocumentPosition(el) & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const again = () => { if (Date.now() < until && el.isConnected && Math.abs(main.scrollTop - set) < 2) set = place(); };
    img.addEventListener('load', again, { once: true }); img.addEventListener('error', again, { once: true });
  }
}
/** One guide as HTML, or null when missing. */
export async function renderGuide(cat: Catalog, file: string, current: () => string): Promise<{ html: string; headings: { level: number; id: string; text: string }[] } | null> {
  const md = await cat.load(file);
  if (md === null) return null;
  const { html, headings } = renderMarkdownDoc(md, { link: guideLinker(cat, current), image: (src) => cat.image(src) });
  return { html, headings };
}

// ---------------------------------------------------------------- search
interface Hit { doc: Entry; sec: MdSection; score: number }
let index: { doc: Entry; secs: MdSection[] }[] | null = null;
let indexOf: Catalog | null = null;
export async function buildIndex(cat: Catalog) {
  if (index && indexOf === cat) return index;
  const all = await Promise.all(cat.docs.map(async (doc) => ({ doc, secs: markdownSections((await cat.load(doc.file)) ?? '') })));
  index = all; indexOf = cat;
  return all;
}
const words = (q: string) => q.toLowerCase().split(/[^\p{L}\p{N}+#.-]+/u).filter((w) => w.length > 1 || /\d/.test(w));
function count(hay: string, w: string) { let n = 0, i = hay.indexOf(w); while (i >= 0 && n < 20) { n++; i = hay.indexOf(w, i + w.length); } return n; }
export function searchHelp(idx: { doc: Entry; secs: MdSection[] }[], q: string): Hit[] {
  const ws = words(q);
  if (!ws.length) return [];
  const hits: Hit[] = [];
  for (const { doc, secs } of idx) for (const sec of secs) {
    const title = sec.title.toLowerCase(), text = sec.text.toLowerCase(), dt = doc.title.toLowerCase();
    let score = 0, ok = true;
    for (const w of ws) {
      const t = count(title, w), x = count(text, w), d = dt.includes(w) ? 1 : 0;
      if (!t && !x && !d) { ok = false; break; }
      score += t * 8 + Math.min(x, 6) + d * 2;
    }
    if (!ok) continue;
    const phrase = q.toLowerCase().trim();
    if (title.includes(phrase)) score += 12;
    else if (ws.length > 1 && text.includes(phrase)) score += 8; // the words together beat the words apart
    score += sec.level === 2 ? 2 : sec.level === 1 ? 1 : 0;
    // (clarity: a beginner searching "camera" got engineering notes first: in-depth guides rank lower)
    if (doc.notice?.startsWith('This is an in-depth')) score = Math.round(score / 2);
    hits.push({ doc, sec, score });
  }
  return hits.sort((a, b) => b.score - a.score).slice(0, 40);
}
function snippet(text: string, q: string) {
  const ws = words(q);
  const low = text.toLowerCase();
  let at = -1;
  for (const w of ws) { const i = low.indexOf(w); if (i >= 0 && (at < 0 || i < at)) at = i; }
  const start = Math.max(0, at - 60);
  let s = (start ? '…' : '') + text.slice(start, start + 180) + (start + 180 < text.length ? '…' : '');
  s = escapeHtml(s);
  for (const w of ws) s = s.replace(new RegExp(`(${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')})`, 'gi'), '<mark>$1</mark>');
  return s;
}

// ---------------------------------------------------------------- the viewer
const LAST = 'vtp.help.last';
const store = { get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } }, set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* storage off */ } } };
let open: { show(target: string, push?: boolean): void; close(): void; alive(): boolean } | null = null;
let extras: { shortcuts?: () => void } = {};
/** The shell gives Help a way to open the keyboard-shortcut sheet. */
export function setHelpExtras(x: { shortcuts?: () => void }) { extras = x; }
export const helpIsOpen = () => !!open;

/** Open Help at a guide (`FILE.md` or `FILE.md#section`); no target = the last
 *  guide read (or the index). */
export function openHelp(target?: string) {
  injectCss();
  const want = target || store.get(LAST) || 'README.md';
  if (open && !open.alive()) open.close(); // its overlay was removed from outside: start over
  if (open) { open.show(want); return; }
  const prevFocus = document.activeElement as HTMLElement | null;
  const history: string[] = [];
  let current = '';
  let cat: Catalog | null = null;
  const search = h('input', { type: 'search', placeholder: 'Search all guides…', 'aria-label': 'Search the guides', autocomplete: 'off', spellcheck: false }) as HTMLInputElement;
  const nav = h('nav', { class: 'hv-nav', 'aria-label': 'Guides' });
  const results = h('div', { class: 'hv-results', role: 'listbox', 'aria-label': 'Search results' });
  const article = h('article', { class: 'hv-doc', tabindex: -1 });
  const toc = h('div', { class: 'hv-toc' });
  const sub = h('span', null, 'Guides work offline');
  const backBtn = h('button', { class: 'btn ghost', title: 'Back', 'aria-label': 'Back', disabled: true, onClick: () => { const t = history.pop(); if (t) show(t, false); backBtn.disabled = !history.length; } }, icon('prev', 16), 'Back') as HTMLButtonElement;
  const tabBtn = h('button', {
    class: 'btn ghost', title: 'Open this guide in a browser tab (needs the studio running)',
    onClick: () => {
      const [f, a] = splitTarget(current);
      const url = `/api/docs/${f}${a ? `#${a}` : ''}`;
      window.open(url, '_blank', 'noopener');
    },
  }, icon('popout', 16), 'New tab');
  const keysBtn = extras.shortcuts ? h('button', { class: 'btn ghost', title: 'Keyboard shortcuts (?)', onClick: () => { close(); extras.shortcuts?.(); } }, icon('keys', 16), 'Shortcuts') : null;
  const closeBtn = h('button', { class: 'icon-btn', 'aria-label': 'Close Help', title: 'Close (Esc)', onClick: () => close() }, icon('x', 16));
  const dialog = h('div', { class: 'hv', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Help' },
    h('header', { class: 'hv-head' },
      h('div', { class: 'hv-title' }, icon('help', 20), h('b', null, 'Help'), sub),
      h('div', { class: 'hv-search' }, icon('search', 16), search),
      h('div', { class: 'hv-acts' }, backBtn, tabBtn, keysBtn, closeBtn)),
    h('div', { class: 'hv-body' }, h('aside', { class: 'hv-side' }, results, nav), h('div', { class: 'hv-main' }, toc, article)));
  const back = h('div', { class: 'wiz-back hv-back', onClick: (e: Event) => { if (e.target === back) close(); } }, dialog);

  // guide list (filled once the guides are here)
  function fillNav(c: Catalog) {
    nav.replaceChildren();
    for (const g of c.groups) {
      const ds = c.docs.filter((d) => d.group === g);
      if (!ds.length) continue;
      nav.append(h('h4', null, g), ...ds.map((d) => h('button', { class: 'hv-doclink', 'data-file': d.file, title: d.blurb, onClick: () => show(d.file) }, h('b', null, d.title), h('span', null, d.blurb))));
    }
    if (!c.docs.length) nav.append(h('p', { class: 'note' }, 'No guides are bundled in this build. They are in the docs folder of your VTube Pro folder.'));
  }
  function loading() {
    nav.replaceChildren(h('p', { class: 'note' }, 'Getting the guides…'));
    article.replaceChildren(h('p', { class: 'note' }, 'Getting the guides…'));
    toc.replaceChildren();
  }
  function failed() {
    const retry = h('button', { class: 'btn primary', onClick: () => { start(current || want); } }, 'Try again');
    const site = h('a', { href: 'https://github.com/vtubepro/VTube-Pro-Public/tree/main/docs', target: '_blank', rel: 'noopener' }, 'Open the guides on GitHub');
    nav.replaceChildren();
    toc.replaceChildren();
    article.replaceChildren(h('h1', null, 'We couldn’t get the guides'), h('p', null, 'Press Try again.'), h('p', null, retry, ' ', site));
  }
  function start(t: string) {
    loading();
    catalog().then((c) => { cat = c; fillNav(c); void show(t, false); }, () => { current = t; failed(); });
  }

  /** A start page listing every guide, by group (only used when the catalog has no home file). */
  function homeHtml(c: Catalog) {
    let html = '<h1>All guides</h1><p>Pick a guide, or search above. Stuck? Press <b>Help</b> at the top, then <b>Ask for help</b>.</p>';
    for (const g of c.groups) {
      const ds = c.docs.filter((d) => d.group === g);
      if (!ds.length) continue;
      html += `<h2 id="${escapeHtml(g.toLowerCase().replace(/[^a-z0-9]+/g, '-'))}">${escapeHtml(g)}</h2><ul>`;
      for (const d of ds) html += `<li><a href="#hv:${escapeHtml(d.file)}">${escapeHtml(d.title)}</a>: ${escapeHtml(d.blurb)}</li>`;
      html += '</ul>';
    }
    return html;
  }
  async function show(target: string, push = true) {
    if (!cat) { start(target); return; }
    const c = cat;
    let [file, anchor] = c.resolve(target);
    if (!file) [file, anchor] = [splitTarget(target)[0], ''];
    if (!file && c.home) file = c.home;
    const key = `${file}${anchor ? `#${anchor}` : ''}`;
    if (push && current && current !== key) { history.push(current); backBtn.disabled = false; }
    current = key;
    if (file) store.set(LAST, file);
    for (const b of nav.querySelectorAll<HTMLElement>('.hv-doclink')) b.classList.toggle('on', b.dataset.file === file);
    const main = article.parentElement!;
    if (!file) { // no guide picked: the index
      article.innerHTML = homeHtml(c);
      toc.replaceChildren();
      main.scrollTop = 0;
      return;
    }
    const r = await renderGuide(c, file, () => current);
    if (current !== key) return; // another click won
    if (!r) {
      article.replaceChildren(h('h1', null, 'Not bundled'), h('p', null, `“${file}” is not part of the in-app Help. Look for it in the docs folder of your VTube Pro folder.`));
      toc.replaceChildren();
      return;
    }
    const { html, headings } = r;
    article.innerHTML = html;
    const subs = headings.filter((x) => x.level === 2);
    toc.replaceChildren(...(subs.length > 2 ? [h('span', null, 'On this page'), ...subs.map((x) => h('a', { href: `#hv:${file}#${x.id}` }, x.text))] : []));
    const el = anchor ? article.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`) : null;
    if (el) scrollToSection(main, el, toc.offsetHeight);
    else main.scrollTop = 0;
  }
  // links inside the guide and the page index
  dialog.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest?.('a') as HTMLAnchorElement | null;
    if (!a) return;
    const href = a.getAttribute('href') ?? '';
    if (href.startsWith('#hv:')) { e.preventDefault(); void show(href.slice(4)); }
    else if (href.startsWith('#hv-file:')) { e.preventDefault(); a.title = `In your VTube Pro folder: ${href.slice(9)}`; a.classList.add('hv-nolink'); }
  });

  // search
  let st = 0;
  const runSearch = async () => {
    const q = search.value.trim();
    if (!q || !cat) { results.replaceChildren(); nav.style.display = ''; return; }
    const idx = await buildIndex(cat);
    if (search.value.trim() !== q) return;
    const hits = searchHelp(idx, q);
    nav.style.display = 'none';
    results.replaceChildren(h('h4', null, hits.length ? `${hits.length === 40 ? '40+' : hits.length} result${hits.length === 1 ? '' : 's'}` : 'No results'),
      ...(hits.length ? hits.map((x) => {
        const b = h('button', { class: 'hv-hit', role: 'option', onClick: () => show(`${x.doc.file}${x.sec.id ? `#${x.sec.id}` : ''}`) },
          h('b', null, x.sec.title || x.doc.title), h('small', null, x.doc.title, x.doc.notice?.startsWith('This is an in-depth') ? ' · In depth' : ''));
        const p = h('span'); p.innerHTML = snippet(x.sec.text, q); b.append(p);
        return b;
      }) : [h('p', { class: 'note' }, 'Try one word, like “OBS”, “mic”, “guest” or “outfit”.')]));
  };
  search.addEventListener('input', () => { clearTimeout(st); st = window.setTimeout(() => void runSearch(), 120); });
  search.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); (results.querySelector('.hv-hit') as HTMLButtonElement | null)?.click(); }
    if (e.key === 'ArrowDown') { e.preventDefault(); (results.querySelector('.hv-hit') as HTMLButtonElement | null)?.focus(); }
  });
  results.addEventListener('keydown', (e) => {
    const cur = document.activeElement as HTMLElement | null;
    if (!cur?.classList.contains('hv-hit')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); (cur.nextElementSibling as HTMLElement | null)?.focus(); }
    if (e.key === 'ArrowUp') { e.preventDefault(); const p = cur.previousElementSibling as HTMLElement | null; (p?.classList.contains('hv-hit') ? p : search).focus(); }
  });

  // keys: Esc closes; the studio's one-key shortcuts (H, C, F, 1–9, G…) stay off while Help is open
  const onKey = (e: KeyboardEvent) => {
    if (!back.isConnected) { close(); return; } // never keep swallowing keys for an overlay that is gone
    if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (search.value && document.activeElement === search) { search.value = ''; void runSearch(); } else close(); return; }
    if (e.key === 'F1') { e.preventDefault(); e.stopImmediatePropagation(); search.focus(); return; }
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); e.stopImmediatePropagation(); search.focus(); search.select(); return; }
    if (e.key === '/' && !(e.target as HTMLElement).closest?.('input,textarea')) { e.preventDefault(); e.stopImmediatePropagation(); search.focus(); return; }
    if (!e.ctrlKey && !e.altKey && !e.metaKey) e.stopImmediatePropagation();
  };
  window.addEventListener('keydown', onKey, true);
  function close() {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
    open = null;
    prevFocus?.focus?.();
  }
  document.body.append(back);
  open = { show: (t, p) => void show(t, p), close, alive: () => back.isConnected };
  start(want);
  search.focus();
}

// ---------------------------------------------------------------- style
let cssDone = false;
/** The Help styles (also the area "?" buttons): the shell calls this at start. */
export function initHelpStyles() { injectCss(); }
function injectCss() {
  if (cssDone) return;
  cssDone = true;
  const s = document.createElement('style');
  s.id = 'vtp-help';
  s.textContent = HELP_CSS;
  document.head.append(s);
}
const HELP_CSS = `
.hv-back { z-index: 90; padding: 18px; }
.hv { width: min(1240px, 100%); height: min(860px, calc(100vh - 36px)); display: grid; grid-template-rows: auto 1fr; background: var(--panel); border: 1px solid var(--line2); border-radius: 18px; box-shadow: 0 24px 80px #000a; overflow: hidden; color: var(--text); }
.hv-head { display: flex; gap: 12px; align-items: center; padding: 12px 14px; border-bottom: 1px solid var(--line); background: var(--bg2); }
.hv-title { display: flex; gap: 8px; align-items: center; flex: none; }
.hv-title b { font-size: 17px; }
.hv-title span { color: var(--faint); font-size: 12px; }
.hv-search { flex: 1; min-width: 120px; display: flex; gap: 8px; align-items: center; padding: 0 10px; border: 1px solid var(--line2); border-radius: 10px; background: var(--input); }
.hv-search input { flex: 1; border: 0 !important; background: transparent !important; padding: 8px 0 !important; color: var(--text); font-size: 14px; outline: none; box-shadow: none !important; }
.hv-acts { display: flex; gap: 6px; align-items: center; flex: none; }
.hv-acts .btn { display: inline-flex; gap: 6px; align-items: center; }
.hv-body { display: grid; grid-template-columns: 290px 1fr; min-height: 0; }
.hv-side { border-right: 1px solid var(--line); overflow: auto; padding: 8px 10px 16px; background: var(--bg2); }
.hv-side h4 { margin: 14px 6px 6px; font-size: 11.5px; text-transform: uppercase; letter-spacing: .06em; color: var(--faint); }
.hv-doclink, .hv-hit { display: block; width: 100%; text-align: left; padding: 8px 10px; margin: 2px 0; border-radius: 10px; border: 1px solid transparent; background: transparent; color: var(--text); cursor: pointer; font: inherit; }
.hv-doclink b, .hv-hit b { display: block; font-size: 13.5px; font-weight: 600; }
.hv-doclink span, .hv-hit span, .hv-hit small { display: block; font-size: 12px; color: var(--dim); line-height: 1.4; margin-top: 2px; }
.hv-hit small { color: var(--accent2); }
.hv-hit mark { background: var(--accent-soft); color: var(--text); border-radius: 3px; padding: 0 1px; }
.hv-doclink:hover, .hv-hit:hover, .hv-hit:focus-visible { background: var(--card2); }
.hv-doclink.on { background: var(--accent-soft); border-color: color-mix(in srgb, var(--accent) 40%, transparent); }
.hv-main { overflow: auto; padding: 8px 34px 60px; scroll-behavior: auto; }
.hv-toc { position: sticky; top: -8px; z-index: 1; display: flex; flex-wrap: wrap; gap: 4px 12px; padding: 10px 0 8px; margin-bottom: 4px; background: var(--panel); border-bottom: 1px solid var(--line); font-size: 12.5px; }
.hv-toc:empty { display: none; }
.hv-toc span { color: var(--faint); }
.hv-toc a { color: var(--accent2); text-decoration: none; }
.hv-toc a:hover { text-decoration: underline; }
.hv-doc { max-width: 860px; font-size: 14.5px; line-height: 1.62; outline: none; }
.hv-doc h1 { font: 650 28px/1.2 var(--font-display, inherit); letter-spacing: -.015em; margin: 18px 0 10px; }
.hv-doc h2 { font-size: 21px; margin: 34px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--line); }
.hv-doc h3 { font-size: 16.5px; margin: 24px 0 8px; }
.hv-doc h4 { font-size: 14.5px; margin: 18px 0 6px; }
.hv-doc h1, .hv-doc h2, .hv-doc h3, .hv-doc h4 { scroll-margin-top: 48px; transition: background 400ms; border-radius: 6px; }
.hv-doc .hv-flash { background: var(--accent-soft); }
.hv-doc p { margin: 8px 0; }
.hv-doc ul, .hv-doc ol { margin: 8px 0; padding-left: 24px; }
.hv-doc li { margin: 4px 0; }
.hv-doc li > ul, .hv-doc li > ol { margin: 4px 0; }
.hv-doc a { color: var(--accent2); }
.hv-doc a.hv-nolink { color: var(--dim); cursor: help; text-decoration: underline dotted; }
.hv-doc :not(pre) > code { word-break: keep-all; overflow-wrap: break-word; }
.hv-doc code { background: var(--card2); border: 1px solid var(--line); padding: 0 5px; border-radius: 5px; font-size: .9em; }
.hv-doc pre { background: var(--card2); border: 1px solid var(--line); padding: 12px 14px; border-radius: 10px; overflow: auto; }
.hv-doc pre code { background: none; border: 0; padding: 0; }
.hv-doc blockquote { margin: 12px 0; padding: 6px 14px; border-left: 3px solid var(--accent2); background: var(--accent2-soft); border-radius: 0 10px 10px 0; }
.hv-doc .md-table { overflow-x: auto; margin: 10px 0; }
.hv-doc table { border-collapse: collapse; font-size: 13.5px; }
.hv-doc th, .hv-doc td { border: 1px solid var(--line2); padding: 6px 10px; text-align: left; vertical-align: top; }
.hv-doc th { background: var(--card2); }
.hv-doc img { max-width: 100%; height: auto; border-radius: 10px; border: 1px solid var(--line); margin: 6px 0; }
.hv-doc hr { border: 0; border-top: 1px solid var(--line); margin: 24px 0; }
@media (max-width: 860px) { .hv-body { grid-template-columns: 1fr; grid-template-rows: auto 1fr; } .hv-side { max-height: 32vh; border-right: 0; border-bottom: 1px solid var(--line); } .hv-main { padding: 8px 16px 40px; } .hv-title span, .hv-acts .btn span { display: none; } }
.area-help { margin-left: 2px; width: 26px; height: 26px; border-radius: 50%; display: inline-grid; place-items: center; border: 1px solid var(--line2); background: transparent; color: var(--dim); cursor: pointer; flex: none; }
.area-help:hover { color: var(--text); border-color: var(--accent2); }
`;
