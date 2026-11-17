// The camera picture in the corner of the studio window (#campip) can be hidden while tracking carries on: for showing
// your settings on screen without showing yourself (issue #15, "camera display"). Only this window ever shows it; OBS
// never did. The choice is remembered in this browser. Pure helpers here so tools/campip_unit.ts can run them.

export const PIP_OFF_KEY = 'vtp.camPipOff';

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Hidden by the user (default: shown). A browser that blocks storage just means "shown". */
export function loadPipOff(s: Store | null | undefined): boolean {
  try { return s?.getItem(PIP_OFF_KEY) === '1'; } catch { return false; }
}

export function savePipOff(s: Store | null | undefined, off: boolean): void {
  try { s?.setItem(PIP_OFF_KEY, off ? '1' : '0'); } catch { /* storage blocked: it just isn't remembered */ }
}

export const pipButtonLabel = (off: boolean): string => (off ? 'Show camera' : 'Hide camera');

export const pipButtonTitle = (off: boolean): string => off
  ? 'Show your camera picture again (tracking never stopped)'
  : 'Hide your camera picture so you can show this window without showing yourself. Tracking carries on, and OBS never had the picture.';
