// A tiny, forgiving XML reader for DJ library exports (rekordbox.xml, Traktor collection.nml, VirtualDJ database.xml):
// start / end / empty tags with attributes, entities decoded; comments, CDATA, processing instructions and text skipped
// (none of these formats keep data in text nodes). Streams events over the string, so a 30 MB export never builds a DOM.
// Read-only: nothing here writes XML.

export interface XmlTag { name: string; attrs: Record<string, string>; empty: boolean }
const ENT: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
export function decodeEntities(s: string): string {
  if (s.indexOf('&') < 0) return s;
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === '#') { const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENT[e.toLowerCase()] ?? m;
  });
}
const ATTR = /([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
/**
 * Walk the document: `open(tag, path)` for every start / empty tag (path = the open ancestors' names), `close(name)` for
 * every end tag (and right after an empty tag's open). Returning false from `open` stops the walk.
 */
export function walkXml(src: string, open: (t: XmlTag, path: string[]) => boolean | void, close?: (name: string, path: string[]) => void): void {
  const path: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const lt = src.indexOf('<', i);
    if (lt < 0) break;
    if (src.startsWith('<!--', lt)) { const e = src.indexOf('-->', lt + 4); i = e < 0 ? n : e + 3; continue; }
    if (src.startsWith('<![CDATA[', lt)) { const e = src.indexOf(']]>', lt + 9); i = e < 0 ? n : e + 3; continue; }
    if (src[lt + 1] === '?' || src[lt + 1] === '!') { const e = src.indexOf('>', lt + 2); i = e < 0 ? n : e + 1; continue; }
    // the end of the tag: the first '>' outside quotes
    let j = lt + 1, q = '';
    for (; j < n; j++) { const c = src[j]; if (q) { if (c === q) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === '>') break; }
    if (j >= n) break;
    const body = src.slice(lt + 1, j);
    i = j + 1;
    if (body[0] === '/') {
      const name = body.slice(1).trim();
      // tolerate a missing / mismatched close: pop to the matching open
      const k = path.lastIndexOf(name);
      if (k >= 0) { path.length = k; close?.(name, path); }
      continue;
    }
    const empty = body.endsWith('/');
    const inner = empty ? body.slice(0, -1) : body;
    const m = /^([^\s/>]+)/.exec(inner);
    if (!m) continue;
    const name = m[1];
    const attrs: Record<string, string> = {};
    ATTR.lastIndex = m[1].length;
    let a: RegExpExecArray | null;
    while ((a = ATTR.exec(inner))) attrs[a[1]] = decodeEntities(a[3] ?? a[4] ?? '');
    if (open({ name, attrs, empty }, path) === false) return;
    if (empty) close?.(name, path); else path.push(name);
  }
}

/** A number attribute (NaN when missing / not a number). Commas as decimal points are accepted (some locales). */
export function attrNum(attrs: Record<string, string>, k: string): number {
  const v = attrs[k];
  if (v === undefined || v.trim() === '') return NaN;
  return Number(v.replace(',', '.'));
}
