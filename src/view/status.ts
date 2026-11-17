// What the guest viewer says in the other streamer's OBS preview. The words are shared/guestFeed.ts viewerText (plain, no jargon);
// this file picks WHICH state to show (pure, tested) and draws the small plate (textContent only: a name can never become markup).
import { viewerText, type GsViewerState } from '../../shared/guestFeed.ts';
import type { PictureState } from './picture.ts';

const HARD: readonly GsViewerState[] = ['badLink', 'oldLink', 'tooOld', 'noGl'];
const TERMINAL: readonly GsViewerState[] = ['blocked', 'full', 'off'];
/** The connection phases that become "the picture stopped" once a picture was shown and then went away. */
const SOFT: readonly GsViewerState[] = ['live', 'connecting', 'waiting', 'failed', 'noServer'];

/** The state whose sentence is on screen: nothing while there is a picture (fresh or held), the real reason when there is none. */
export function shownState(phase: GsViewerState, picture: PictureState, lost: boolean): GsViewerState {
  if (HARD.includes(phase) || TERMINAL.includes(phase)) return phase;
  if (picture !== 'none') return 'live';
  if (lost && SOFT.includes(phase)) return 'lost';
  return phase;
}
export const plateText = (phase: GsViewerState, picture: PictureState, lost: boolean, name: string): string => viewerText(shownState(phase, picture, lost), name);

const CSS = '#gs-plate{position:fixed;left:12px;bottom:12px;max-width:min(78vw,680px);box-sizing:border-box;padding:8px 14px;border-radius:12px;background:rgba(16,18,26,.78);color:#fff;font:600 clamp(13px,2.4vh,24px)/1.4 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;pointer-events:none;white-space:normal}#gs-plate[hidden]{display:none}';

export function mountPlate(root: HTMLElement): { set(text: string): void } {
  const s = document.createElement('style'); s.textContent = CSS; document.head.append(s);
  const p = document.createElement('div');
  p.id = 'gs-plate'; p.hidden = true; p.setAttribute('role', 'status'); p.setAttribute('aria-live', 'polite');
  root.append(p);
  let cur = '';
  return { set(text: string) { if (text === cur) return; cur = text; p.textContent = text; p.hidden = !text; } };
}
