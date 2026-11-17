// ux-simplicity: how the first-run home, the tour and the Help button reach the rest of the product.
// Every other lane's module is found with a lazy import.meta.glob, so this compiles and runs with or without them
// (T\portal\CONTRACT.md):
//  - "Add my model" wizard (model-onboarding, src/ui/modelWizard.ts);
//  - "Add my room" (room-onboarding, src/ui/onboard/roomKind.ts on the shared shell src/ui/onboard/shell.ts);
//  - the F1 Help viewer (docs-user, src/ui/help/helpViewer.ts);
// Missing modules fall back to the nearest plain thing (the right area, the guide on GitHub). Nothing here starts the
// camera, saves, or makes a sound.
import type { App } from '../../app.ts';
import { toast } from '../dom.ts';

declare global {
  interface ImportMeta {
    glob<M = unknown>(pattern: string | string[], options?: { query?: string; import?: string; eager?: boolean }): Record<string, M>;
  }
}

interface HelpMod { openHelp?: (target?: string) => void }
interface ModelMod { openModelWizard?: (app: App, opts?: { onDone?: (id: string) => void }) => void }
interface ImportMod { openModelImport?: (app: App, input?: null, opts?: { onDone?: (id: string) => void }) => void }
interface RoomKindMod { roomKind?: (app: App) => unknown }
interface ShellMod { openOnboarding?: (kind: never, opts?: Record<string, unknown>) => void }

const HELP = import.meta.glob<() => Promise<HelpMod>>('../help/helpViewer.ts');
const MODEL = import.meta.glob<() => Promise<ModelMod>>('../modelWizard.ts');
const IMPORT = import.meta.glob<() => Promise<ImportMod>>('../dropImport.ts');
const ROOMKIND = import.meta.glob<() => Promise<RoomKindMod>>('../onboard/roomKind.ts');
const OBSHELL = import.meta.glob<() => Promise<ShellMod>>('../onboard/shell.ts');
const first = async <M>(g: Record<string, () => Promise<M>>): Promise<M | null> => {
  const f = Object.values(g)[0];
  if (!f) return null;
  try { return await f(); } catch { return null; }
};
/** Does this build include the in-app Help viewer? (Decides whether F1 is ours.) */
export const hasHelpViewer = () => Object.keys(HELP).length > 0;

// ---------------------------------------------------------------- flows
/** "Use my own model": the drop-anywhere importer (beta.12: the one front door, src/ui/dropImport.ts; its "step by step"
 *  is the guided wizard), else the Add my model wizard, else the Me area (which has the import drop). */
export async function addMyModel(app: App, fallback: () => void, onDone?: () => void): Promise<void> {
  const imp = await first(IMPORT);
  if (imp?.openModelImport) { imp.openModelImport(app, null, { onDone: () => { onDone?.(); app.emit('library'); } }); return; }
  const m = await first(MODEL);
  if (m?.openModelWizard) { m.openModelWizard(app, { onDone: () => { onDone?.(); app.emit('library'); } }); return; }
  fallback();
}
/** "Add my own room": the room wizard on the shared onboarding shell, else the Room area. */
export async function addMyRoom(app: App, fallback: () => void): Promise<void> {
  const [k, s] = await Promise.all([first(ROOMKIND), first(OBSHELL)]);
  if (k?.roomKind && s?.openOnboarding) { s.openOnboarding(k.roomKind(app) as never); return; }
  fallback();
}

// ---------------------------------------------------------------- help
const REPO = 'https://github.com/vtubepro/VTube-Pro-Public';
/** `FILE.md#anchor` → the same guide on GitHub (used only when the bundled Help viewer is missing). */
export function webDocUrl(target: string): string {
  const [file, anchor = ''] = target.split('#');
  return `${REPO}/blob/main/docs/${file || 'README.md'}${anchor ? `#${anchor}` : ''}`;
}
/** Open a guide section: the in-app Help viewer (works offline), else the guide on GitHub. */
export async function openGuide(target: string): Promise<void> {
  const help = await first(HELP);
  if (help?.openHelp) { help.openHelp(target); return; }
  // (window.open with noopener always returns null, so there is nothing to check; the toast names the page either way)
  window.open(webDocUrl(target), '_blank', 'noopener');
  toast('The guide opened in a new tab.', 'info', 3000);
}

/** "Ask for help" (studio Help menu + Help me): the repository's Issues page. Opens in a new tab. */
export const HELP_CHAT_URL = `${REPO}/issues`;
/** Public bug tracker: the repository's Issues page (new issue). */
export const REPORT_URL = `${REPO}/issues/new/choose`;
/** "Changelog" (studio Help menu): the project's releases page on GitHub. */
export const changelogUrl = (): string => `${REPO}/releases`; // sync: window.open stays in the click
