// Blocked site data (cookies and site data turned off for this site, some privacy browsers, Firefox with storage off)
// makes `localStorage` throw, or be null, and the studio reads its settings while it boots: it could not start at all
// (2026-10-03, the "stuck at 4%" report). Swap in a memory-only stand-in instead: everything works, settings just last
// until the tab closes. The first import of every page entry, so it runs before any other module of a page.
export const blockedStorage: string[] = [];

function memoryStorage(): Storage {
  const mem = new Map<string, string>();
  return {
    get length() { return mem.size; },
    key: (i: number) => [...mem.keys()][i] ?? null,
    getItem: (k: string) => mem.get(String(k)) ?? null,
    setItem: (k: string, v: string) => { mem.set(String(k), String(v)); },
    removeItem: (k: string) => { mem.delete(String(k)); },
    clear: () => { mem.clear(); },
  };
}

for (const name of ['localStorage', 'sessionStorage'] as const) {
  try {
    const s = window[name];
    if (s) { s.getItem('vtp.probe'); continue; }
  } catch { /* blocked: replace it below */ }
  try {
    Object.defineProperty(window, name, { value: memoryStorage(), configurable: true });
    blockedStorage.push(name);
  } catch { /* the browser won't let us: modules that guard their own reads still work */ }
}
if (blockedStorage.length) console.warn(`[vtube-pro] this browser blocks site data here (${blockedStorage.join(', ')}): settings last until the tab closes`);
