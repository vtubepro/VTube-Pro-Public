// A small, safe Markdown renderer shared by the in-app Help viewer (src/ui/help/helpViewer.ts) and the server's
// /api/docs pages (server/routes/docsView.ts). It covers what the docs use: headings (with GitHub-style ids, so
// `FILE.md#some-heading` links work the same here and on GitHub), paragraphs, **bold**, *italic*, `code`, links,
// images, nested lists, tables, fenced code, > quotes and --- rules. Every piece of text is HTML-escaped: raw HTML in a
// doc is shown as text, never run. No dependencies (it runs in the browser, in Node and in tools/docs_unit.ts).

export interface MdHeading { level: number; text: string; id: string }
export interface MdSection { id: string; title: string; level: number; text: string }
export interface MdLink { href: string; external: boolean }
export interface MdOptions {
  /** Map a link target (as written in the doc) to the real href. Default: keep it, external links open a new tab. */
  link?: (href: string) => MdLink;
  /** Map an image path (as written in the doc) to a URL, or null to drop the image. Default: keep it. */
  image?: (src: string) => string | null;
}

export const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Plain text of a heading / inline run (markup removed), as GitHub sees it for the anchor. */
export function plainInline(s: string): string {
  return s
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1$2');
}

/** GitHub-style heading anchor: lower case, punctuation dropped, every space becomes '-'. */
export function slugify(text: string): string {
  return plainInline(text).trim().toLowerCase().replace(/[^\p{L}\p{N}\s_-]/gu, '').replace(/ /g, '-');
}

/** Unique ids in document order (a repeated heading gets -1, -2 … like GitHub). */
export function slugger() {
  const seen = new Map<string, number>();
  return (text: string) => {
    const base = slugify(text) || 'section';
    const n = seen.get(base);
    seen.set(base, (n ?? -1) + 1);
    return n === undefined ? base : `${base}-${n + 1}`;
  };
}

const defaultLink = (href: string): MdLink => ({ href, external: /^[a-z][a-z0-9+.-]*:/i.test(href) });

function inline(s: string, o: MdOptions): string {
  // pull out code spans first so nothing inside them is formatted
  const codes: string[] = [];
  let t = s.replace(/`([^`]+)`/g, (_m, c: string) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  t = escapeHtml(t);
  t = t.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_m, alt: string, src: string) => {
    const url = (o.image ?? ((x: string) => x))(src.replace(/&amp;/g, '&'));
    return url ? `<img src="${escapeHtml(url)}" alt="${alt}" loading="lazy">` : '';
  });
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, text: string, href: string) => {
    const raw = href.replace(/&amp;/g, '&');
    if (/^\s*javascript:/i.test(raw)) return text;
    const l = (o.link ?? defaultLink)(raw);
    return `<a href="${escapeHtml(l.href)}"${l.external ? ' target="_blank" rel="noopener noreferrer"' : ''}>${text}</a>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[^\w*])\*([^*\s][^*]*?)\*(?!\w)/g, '$1<i>$2</i>')
    .replace(/(^|[^\w])_([^_\s][^_]*?)_(?!\w)/g, '$1<i>$2</i>');
  return t.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => `<code>${escapeHtml(codes[+i])}</code>`);
}

const BULLET = /^(\s*)([-*+]|\d+[.)])\s+/;
const isBlockStart = (l: string) => /^(#{1,6} |```|\||>|\s*([-*+]|\d+[.)])\s|---+\s*$|!\[)/.test(l);

interface Item { text: string; children: string[] }
/** Render a list block (lines already collected, indentation relative to the list's own indent). */
function list(lines: string[], o: MdOptions, depth = 0): string {
  const first = BULLET.exec(lines[0]);
  const ordered = !!first && /\d/.test(first[2]);
  const indent = first ? first[1].length : 0;
  const items: Item[] = [];
  for (const l of lines) {
    const m = BULLET.exec(l);
    if (m && m[1].length <= indent + 1) items.push({ text: l.slice(m[0].length), children: [] });
    else if (items.length) {
      const last = items[items.length - 1];
      if (m || last.children.length) last.children.push(l);
      else last.text += ` ${l.trim()}`;
    }
  }
  const start = ordered && first ? parseInt(first[2], 10) : 1;
  const tag = ordered ? 'ol' : 'ul';
  return `<${tag}${ordered && start !== 1 ? ` start="${start}"` : ''}>${items.map((it) => {
    const kids = it.children.filter((c) => c.trim());
    const sub = kids.length && depth < 4 ? (BULLET.test(kids[0]) ? list(kids, o, depth + 1) : `<p>${inline(kids.map((c) => c.trim()).join(' '), o)}</p>`) : '';
    return `<li>${inline(it.text, o)}${sub}</li>`;
  }).join('')}</${tag}>`;
}

/** Markdown → HTML, plus the headings (for a table of contents). */
export function renderMarkdownDoc(md: string, o: MdOptions = {}): { html: string; headings: MdHeading[] } {
  const out: string[] = [];
  const headings: MdHeading[] = [];
  const slug = slugger();
  const lines = md.replace(/\r\n?/g, '\n').split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (/^\s*```/.test(l)) {
      const code: string[] = [];
      while (++i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i]);
      out.push(`<pre><code>${escapeHtml(code.join('\n'))}</code></pre>`);
    } else if (/^#{1,6} /.test(l)) {
      const n = /^#+/.exec(l)![0].length, text = l.slice(n + 1).replace(/\s+#+\s*$/, '').trim();
      const id = slug(text);
      headings.push({ level: n, text: plainInline(text), id });
      out.push(`<h${n} id="${escapeHtml(id)}">${inline(text, o)}</h${n}>`);
    } else if (/^\s*\|/.test(l)) {
      const rows: string[][] = [];
      for (; i < lines.length && /^\s*\|/.test(lines[i]); i++) rows.push(lines[i].trim().replace(/^\||\|$/g, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|')));
      i--;
      const body = rows.filter((r) => !r.every((c) => /^:?-+:?$/.test(c)));
      const head = rows.length > 1 && rows[1].every((c) => /^:?-+:?$/.test(c));
      out.push(`<div class="md-table"><table>${body.map((r, k) => `<tr>${r.map((c) => (k || !head ? `<td>${inline(c, o)}</td>` : `<th>${inline(c, o)}</th>`)).join('')}</tr>`).join('')}</table></div>`);
    } else if (/^\s*>/.test(l)) {
      const q: string[] = [];
      for (; i < lines.length && /^\s*>/.test(lines[i]); i++) q.push(lines[i].replace(/^\s*>\s?/, ''));
      i--;
      out.push(`<blockquote>${renderMarkdownDoc(q.join('\n'), o).html}</blockquote>`);
    } else if (BULLET.test(l)) {
      const block: string[] = [];
      for (; i < lines.length; i++) {
        const x = lines[i];
        if (BULLET.test(x) || /^\s{2,}\S/.test(x)) block.push(x);
        else if (!x.trim() && i + 1 < lines.length && (BULLET.test(lines[i + 1]) || /^\s{2,}\S/.test(lines[i + 1]))) continue; // loose list
        else break;
      }
      i--;
      out.push(list(block, o));
    } else if (/^\s*(---+|\*\*\*+)\s*$/.test(l)) out.push('<hr>');
    else if (l.trim()) {
      const para = [l.trim()];
      while (i + 1 < lines.length && lines[i + 1].trim() && !isBlockStart(lines[i + 1])) para.push(lines[++i].trim());
      out.push(`<p>${inline(para.join(' '), o)}</p>`);
    }
  }
  return { html: out.join('\n'), headings };
}

export function renderMarkdown(md: string, o: MdOptions = {}): string { return renderMarkdownDoc(md, o).html; }

/** The doc split at its headings, as plain text (for search). Text before the first heading belongs to the title. */
export function markdownSections(md: string): MdSection[] {
  const slug = slugger();
  const out: MdSection[] = [];
  let cur: MdSection = { id: '', title: '', level: 0, text: '' };
  let fence = false;
  for (const l of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (!fence && /^\s*\|?[\s:|-]*-{3,}[\s:|-]*$/.test(l)) continue; // table rule lines / --- rules: no text
    const m = !fence && /^(#{1,6}) (.+?)\s*#*\s*$/.exec(l);
    if (m) {
      if (cur.title || cur.text.trim()) out.push(cur);
      const title = plainInline(m[2]);
      cur = { id: slug(m[2]), title, level: m[1].length, text: '' };
    } else cur.text += `${plainInline(l.replace(/^\s*([-*+>]|\d+[.)]|\|)\s*/, '').replace(/\|/g, ' '))} `;
  }
  if (cur.title || cur.text.trim()) out.push(cur);
  for (const s of out) s.text = s.text.replace(/\*\*/g, '').replace(/\s+/g, ' ').trim(); // (** left by bold that wrapped)
  return out;
}

/** Every link target written in a doc (for the docs check: tools/docs_unit.ts). */
export function markdownLinks(md: string): string[] {
  const out: string[] = [];
  let fence = false;
  for (const l of md.replace(/\r\n?/g, '\n').split('\n')) {
    if (/^\s*```/.test(l)) { fence = !fence; continue; }
    if (fence) continue;
    const t = l.replace(/`[^`]*`/g, '');
    for (const m of t.matchAll(/!?\[[^\]]*\]\(([^)\s]+)\)/g)) out.push(m[1]);
  }
  return out;
}
