// Observer mode (?observer=1): a read-only studio tab that never saves, never sends to OBS and never touches the camera.
// Testers on Brave and Edge (2026-10-04): "Observer mode may not remain visible or active after loading". Two causes:
//  * active: every module read `?observer` from the address on its own, so a page load that lost the query (the sign-in
//    round trip returns to /studio/ without it, a reload from a bookmark or the browser's restored tab) silently turned the
//    sandbox into a normal, writing studio. Now the choice sticks to the TAB (sessionStorage): once a tab is an observer it
//    stays one until it is closed, or `?observer=0` is opened in it on purpose.
//  * visible: the only signs were a small top-bar chip (crowded out next to the other buttons) and a note in the
//    Simple views. The shell now shows one line in every area's header (src/ui/shell.ts observerBar).
// Pure decision + one reader, so the App, the party, the splash and the panels all agree.

export const OBSERVER_KEY = 'vtp.observer';
type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

/** `?observer=0|off|false|no` = leave observer mode; any other `?observer` (also a bare `?observer`) = observer. */
export function observerFromQuery(search: string): boolean | null {
  const q = new URLSearchParams(search);
  if (!q.has('observer')) return null;
  return !/^(0|off|false|no)$/i.test((q.get('observer') ?? '').trim());
}

/** Decide (and remember for this tab): the address wins when it says something, else what this tab was before. */
export function resolveObserver(search: string, tab: Store | null | undefined): boolean {
  const q = observerFromQuery(search);
  try {
    if (q === true) tab?.setItem(OBSERVER_KEY, '1');
    else if (q === false) tab?.removeItem(OBSERVER_KEY);
    else return tab?.getItem(OBSERVER_KEY) === '1';
  } catch { /* storage blocked: the address alone decides */ }
  return q === true;
}

let cached: boolean | null = null;
/** Is this tab an observer sandbox? Decided once per page load. */
export function isObserverTab(): boolean {
  if (cached !== null) return cached;
  let tab: Storage | null = null;
  try { tab = window.sessionStorage; } catch { /* blocked */ }
  cached = resolveObserver(location.search, tab);
  return cached;
}
