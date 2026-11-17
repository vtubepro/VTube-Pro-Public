// Keep the studio tab awake while it is in use. Edge (sleeping tabs, efficiency mode), Chrome and Brave (Memory / Energy
// Saver) may freeze or even unload a background tab to save power. The studio is often a background tab while you stream
// (OBS in front): frozen, it stops tracking and your avatar stands still on stream. Two things, both feature-detected:
//  * while the studio is in use (camera on / OBS shows VTube Pro / a party: src/net/studioPresence.ts) the tab holds a
//    Web Lock. Chromium-based browsers don't freeze a tab that holds one (the camera and an open connection count too,
//    but not every set-up has them). Released as soon as the studio isn't in use, so an idle tab can still sleep.
//  * when the browser froze it anyway (the `resume` event after a freeze while in use) or unloaded it (document.wasDiscarded
//    on the reload, with the camera on last time), say so once, with where to switch it off.
// Never in an observer tab (it should stay cheap, and it never streams).
import { onStudioPresence, studioPresence } from '../net/studioPresence.ts';

/** Hold the lock? (pure: tools/browser_ui_unit.ts) */
export function wantAwake(p: { live: boolean; party: boolean }, observer: boolean): boolean {
  return !observer && (p.live || p.party);
}

export const SLEEP_HELP = 'To stop it, add this site to your browser’s list of sites that never sleep (Edge: Settings → System and performance; Chrome and Brave: Settings → Performance).';

export function installKeepAwake(observer: boolean, toast: (msg: string, kind?: 'info' | 'ok' | 'warn' | 'err', ms?: number) => void, cameraWasOn: () => boolean): void {
  if (observer) return;
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  let release: (() => void) | null = null;
  let pending = false;   // a request is out: never send a second one (the first would then be held for good)
  let want = false;
  const sync = () => {
    want = wantAwake(studioPresence(), observer);
    if (want && !release && !pending && locks?.request) {
      pending = true;
      void locks.request('vtp-studio-in-use', { mode: 'shared' }, () => new Promise<void>((res) => {
        pending = false;
        if (!want) { res(); return; }   // went idle before the grant: hand it straight back
        release = res;
      })).catch(() => { pending = false; release = null; });
    } else if (!want && release) { release(); release = null; }
  };
  onStudioPresence(sync);
  sync();
  // the browser froze this tab while it was in use (Page Lifecycle API; only Chromium-based browsers fire these)
  let frozenInUse = false;
  document.addEventListener('freeze', () => { frozenInUse = wantAwake(studioPresence(), observer); });
  document.addEventListener('resume', () => {
    if (!frozenInUse) return;
    frozenInUse = false;
    toast(`Your browser paused this tab to save power, so your avatar stood still for a moment. ${SLEEP_HELP}`, 'warn', 14000);
  });
  if ((document as Document & { wasDiscarded?: boolean }).wasDiscarded && cameraWasOn()) {
    window.setTimeout(() => toast(`Your browser closed this tab in the background to save memory and opened it again. ${SLEEP_HELP}`, 'warn', 14000), 2500);
  }
}
