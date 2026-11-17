// Autopilot: "Invite a guest" before invites are set up. Guest links run on the streamer's own free invite server and a
// Discord sign-in (a one-time set-up, src/ui/wizards.ts "multiplayer"). Instead of an error with words like "relay",
// the studio says what's needed in one sentence and opens that set-up with one click. Hook: src/ui/guestLink.ts.
import type { App } from '../../app.ts';
import { h } from '../dom.ts';

const NOT_SET_UP = /connect discord first|not configured|sign in with discord|invite server|relay/i;
let open: HTMLElement | null = null;

/** The invite failed: when it is "not set up yet", explain + offer the set-up and return true (no error toast). */
export function inviteNeedsSetup(app: App, err: unknown): boolean {
  if (!NOT_SET_UP.test(String((err as Error)?.message ?? err))) return false;
  open?.remove();
  const close = () => { open?.remove(); open = null; };
  open = h('div', { class: 'ap-obs', role: 'dialog', 'aria-label': 'Invite a guest', 'data-ui': 'invite-setup', style: 'border-color: rgb(108 199 245 / .45)' },
    h('span', { class: 't' }, 'Guest links need a one-time set-up (about 5 minutes).', h('small', null, 'Your own free invite server and a Discord sign-in. Your guests need nothing.')),
    h('button', { class: 'primary', onClick: () => { close(); void import('../wizards.ts').then((m) => m.openNamed(app, 'multiplayer')); } }, 'Set it up now'),
    h('button', { onClick: close }, 'Not now'));
  // shares the one-click OBS card's look (src/ui/autopilot/obsOneClick.ts): load its styles
  void import('./obsOneClick.ts').then((m) => m.ensureCardStyle());
  document.body.append(open);
  return true;
}
