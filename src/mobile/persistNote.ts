// When the browser says it may clear this site's saved models (navigator.storage.persist() answered no: Safari unless
// the studio is on the Home Screen, Chrome for little-used sites), say once, in plain words, what keeps them.
// Listens for 'vtp:persist-denied' (raised after a model is saved in the browser).
import { toast } from '../ui/dom.ts';
import { isIos, isPhone } from './device.ts';

const KEY = 'vtp.persistNoted';
export const PERSIST_PHONE = 'Add VTube Pro to your Home Screen so your phone keeps your avatars.';
export const PERSIST_DESKTOP = 'This browser may clear avatars saved here if you don’t visit for a while. Keep a copy: Me → Download a backup.';

export function installPersistNote() {
  window.addEventListener('vtp:persist-denied', () => {
    try { if (localStorage.getItem(KEY)) return; localStorage.setItem(KEY, '1'); } catch { /* storage off: say it anyway */ }
    window.setTimeout(() => toast(isPhone() ? `${PERSIST_PHONE} ${isIos() ? '(Share → Add to Home Screen.)' : '(Menu ⋮ → Add to Home screen.)'}` : PERSIST_DESKTOP, 'warn', 12000), 1500);
  });
}
