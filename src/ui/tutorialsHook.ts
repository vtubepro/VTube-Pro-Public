// Help / Tutorials entry point (beta.12 UX). The studio has "How does this work?" buttons (Live Control's header, the
// show dock, the Tools menu); they call openTutorials(topic). Until a tutorials module registers itself they open the
// Help guide for that topic (src/ui/help/helpViewer.ts), so nothing is ever a dead button.
// The tutorials workstream plugs in with ONE call, from its own file:
//   registerTutorials({ open: (topic) => ..., label: 'Tutorials' })
// Topics are plain ids: 'live', 'show-dock', 'rooms', 'privacy', 'transitions', 'me' (more may be added).
import { openHelp } from './help/helpViewer.ts';
import { AREA_HELP } from '../../shared/helpCatalog.ts';

export interface TutorialsProvider { open(topic?: string): void; /** Button text (default "Tutorials"). */ label?: string }
let provider: TutorialsProvider | null = null;
const subs = new Set<() => void>();

/** Plug a tutorials player in (returns the remover). */
export function registerTutorials(p: TutorialsProvider): () => void {
  provider = p; for (const f of subs) try { f(); } catch { /* a listener failed */ }
  return () => { if (provider === p) { provider = null; for (const f of subs) try { f(); } catch { /* */ } } };
}
export const hasTutorials = (): boolean => !!provider;
export const tutorialsLabel = (): string => provider?.label ?? 'Tutorials';
/** Called when a tutorials player registers / goes away (the buttons relabel). */
export function onTutorials(f: () => void): () => void { subs.add(f); return () => subs.delete(f); }

/** Help for this topic: the tutorial when there is one, else the Help guide. */
export function openTutorials(topic?: string) {
  if (provider) { try { provider.open(topic); return; } catch (e) { console.warn('[tutorials]', e); } }
  const area = topic === 'live' || topic === 'show-dock' || topic === 'privacy' || topic === 'transitions' ? 'onair' : topic === 'rooms' ? 'room' : topic === 'me' ? 'me' : undefined;
  const h = area ? (AREA_HELP as Record<string, { simple?: string } | undefined>)[area]?.simple : undefined;
  openHelp(h);
}
