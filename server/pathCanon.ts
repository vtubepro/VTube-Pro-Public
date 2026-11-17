// The path forms a security rule must be tested against (lane aiskills, beta.12, Grok review: "/API/ai-addons/..." from a
// web page slipped past a local-only rule because Express 5 routes case-insensitively, ignores a trailing slash and
// the guards tested the raw path). Express may route ANY of these forms to the same handler, so a rule that blocks a
// path must block every form: the raw path, and the canonical one (percent-decoded once, "\" and repeated "/" folded,
// "." / ".." resolved, lower case) with and without a trailing slash. No imports from the guards (no cycles).
import path from 'node:path';

/** The canonical form: decoded once (an invalid escape keeps the raw text), lower case, single slashes, dots resolved,
 *  no trailing slash (except "/"). */
export function canonicalPath(raw: string): string {
  let p = String(raw ?? '');
  // absolute-form request target ("POST http://127.0.0.1:5191/API/x HTTP/1.1"): Express routes its pathname
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) { try { p = new URL(p).pathname; } catch { /* keep it */ } }
  p = p.split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch { /* keep it raw */ }
  p = p.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  if (!p.startsWith('/')) p = `/${p}`;
  p = path.posix.normalize(p);
  return p.length > 1 ? p.replace(/\/+$/, '') : p;
}

/** Every form of `raw` a rule must check (deduplicated). */
export function pathForms(raw: string): string[] {
  let r = String(raw ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(r)) { try { r = new URL(r).pathname; } catch { /* keep it */ } }
  r = r.split('?')[0];
  const c = canonicalPath(r);
  return [...new Set([r, r.toLowerCase(), c, c === '/' ? c : `${c}/`])];
}

/** true when ANY form of the path matches ANY of the rules. */
export function matchesAnyForm(raw: string, rules: readonly RegExp[]): boolean {
  const forms = pathForms(raw);
  return rules.some((r) => forms.some((f) => { r.lastIndex = 0; return r.test(f); }));
}
