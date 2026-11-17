// The onboarding wizards' links to the rest of the app (T\portal\CONTRACT.md "onboarding-shell"):
//  - is VTube Pro's own server answering? ("the helper": the studio's server on this PC), and the "Open Helper" button
//    (which can only say what to do: start VTube Pro);
//  - the F1 Help viewer (a guide + section).
// The Help module is found with a lazy import.meta.glob, so this file compiles and runs with or without it (a build
// without it gets plain fallbacks). Shared by "Add my model" and "Add my room".
import { api } from '../../api.ts';
import { button, h, toast } from '../dom.ts';

declare global {
  interface ImportMeta {
    glob<M = unknown>(pattern: string | string[], options?: { query?: string; import?: string; eager?: boolean }): Record<string, M>;
  }
}

interface HelpMod { openHelp?: (target?: string) => void }

const HELP = import.meta.glob<() => Promise<HelpMod>>('../help/helpViewer.ts');
const first = async <M>(g: Record<string, () => Promise<M>>): Promise<M | null> => {
  const f = Object.values(g)[0];
  if (!f) return null;
  try { return await f(); } catch { return null; }
};

/** Test override (observer pages only): `?helper=0|1` or the wizard test hook. null = detect. */
let forced: boolean | null = null;
export function forceHelper(v: boolean | null) { forced = v; }

/** Is the studio's server reachable right now? */
export async function helperAvailable(): Promise<boolean> {
  if (forced !== null) return forced;
  try { await api.status(); return true; } catch { return false; }
}

/** "Open Helper": nothing to open (the studio is the program), so say what to do. */
export async function openHelper(): Promise<void> {
  toast('Start VTube Pro on this PC (the “Start VTube Pro” shortcut), then click “Try again”.', 'info', 9000);
}

/** The one-sentence notice with its button. `why` = what needs it, in plain words. */
export function helperNote(why: string, onRetry?: () => void): HTMLElement {
  return h('div', { class: 'ob-helper', role: 'note' },
    h('div', { class: 'ob-helper-t' }, h('b', null, why), ' ',
      h('span', null, 'That part runs in VTube Pro’s own server on this PC. Everything else works right here.')),
    h('div', { class: 'ob-row' },
      button('Open VTube Pro', () => void openHelper(), 'primary'),
      onRetry ? button('Try again', onRetry) : null));
}

/** Open a guide in the F1 Help viewer ("AVATARS_SIMPLE.md#add-my-model"). */
export async function openGuide(target: string, label = 'the Help guide (F1)'): Promise<void> {
  const help = await first(HELP);
  if (help?.openHelp) { help.openHelp(target); return; }
  toast(`See ${label}: ${target.replace(/\.md.*$/, '').replace(/_/g, ' ').toLowerCase()}.`, 'info', 7000);
}
