// The studio's own version: ONE place, so every screen that shows it (the loading screen, src/ui/splash.ts) agrees.
// only the version: a default import would put the whole package.json (dependency list) into the web bundle
import { version as pkgVersion } from '../../package.json';

export const STUDIO_VERSION: string = typeof pkgVersion === 'string' ? pkgVersion : '';

/** Put the version on <html data-vtp-version> (so a script can read it). */
export function exposeStudioVersion(): void {
  try { if (STUDIO_VERSION) document.documentElement.dataset.vtpVersion = STUDIO_VERSION; } catch { /* no DOM */ }
}

interface Ver { core: number[]; pre: string[] }
function parse(v: string): Ver | null {
  const m = /^\s*v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?\s*$/.exec(String(v ?? ''));
  return m ? { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] } : null;
}

/** Semver order ("1.0.0-beta.9" < "1.0.0-beta.10" < "1.0.0"). null when either side isn't a version. */
export function compareVersions(a: string, b: string): number | null {
  const x = parse(a), y = parse(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] < y.core[i] ? -1 : 1;
  if (!x.pre.length || !y.pre.length) return x.pre.length === y.pre.length ? 0 : x.pre.length ? -1 : 1; // a release beats its betas
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return -1;
    if (q === undefined) return 1;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p < +q ? -1 : 1;
    if (pn !== qn) return pn ? -1 : 1;
    return p < q ? -1 : 1;
  }
  return 0;
}
