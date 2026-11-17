// The click behind a Create "fix" button (shared/createGate.ts GateFix), so the simple Create card and the Advanced builder do exactly
// the same thing:
//   setup   "Set it up for me": open the helper's ComfyUI page on Character 3D. That page lists every download with its size and licence
//           (Hunyuan3D: not for the EU, UK or South Korea); nothing downloads before the person presses Yes there.
// No sound, no network of its own.
import { helperOrigin } from '../net/aiHelper.ts';
import { CHARACTER_SETUP_PAGE, type GateFix } from '../../shared/createGate.ts';

/** A page of the server (relative path) as a URL the studio can open: on the server's own address when the studio runs on the dev server. */
export const helperPage = (p: string) => `${location.port === '5190' ? helperOrigin() : ''}${p}`;

/** The address a "setup" fix opens (the helper's own, with the size it chose, else Character 3D on the helper page). */
export const fixPage = (fix: GateFix) => helperPage(fix.url ?? CHARACTER_SETUP_PAGE);

/** Do what the button says. */
export function runGateFix(fix: GateFix): void {
  window.open(fixPage(fix), '_blank', 'noopener');
}
