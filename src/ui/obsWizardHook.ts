// Hand-offs to "Set up OBS" from other parts of the studio, by document events (no imports between lanes' files;
// CONTRACT.md "live-tabs" + "obs-wizard"). Installed once by src/main.ts; the wizard itself loads only when used.
//
//   document 'vtp:obs-wizard' (cancelable) {detail?: {from?, step?}}      → preventDefault() + open the wizard
//   document 'vtp:obs-transition' (cancelable) {detail: {name, ms, reply?}} → preventDefault() + set OBS's scene
//        transition through the helper (preview + apply in one click; the reply gets {ok, summary, undoId, error})
//   document 'vtp:obs-transitions' (cancelable) {detail: {reply}}           → reply({ok, transitions, current}) (read-only)
//   document 'vtp:obs-undo' (cancelable) {detail: {id, reply?}}             → undo that change (the latest one)
import type { StepId } from '../../shared/obsSetup.ts';
import type { ObsTransitionResult, ObsTransitions } from './obsTransitions.ts';

export const OBS_WIZARD_EVENT = 'vtp:obs-wizard';
export const OBS_TRANSITION_EVENT = 'vtp:obs-transition';
export const OBS_TRANSITIONS_EVENT = 'vtp:obs-transitions';
export const OBS_UNDO_EVENT = 'vtp:obs-undo';

let installed = false;
export function installObsWizardHooks() {
  if (installed) return;
  installed = true;
  document.addEventListener(OBS_WIZARD_EVENT, (e) => {
    e.preventDefault();
    const step = (e as CustomEvent<{ step?: StepId } | undefined>).detail?.step;
    void import('./obsWizard.ts').then((m) => m.openObsWizard(step ? { step } : {}));
  });
  document.addEventListener(OBS_TRANSITION_EVENT, (e) => {
    const d = (e as CustomEvent<{ name?: unknown; ms?: unknown; reply?: (r: ObsTransitionResult) => void } | undefined>).detail;
    if (!d || typeof d.name !== 'string' || typeof d.ms !== 'number') return;
    e.preventDefault();
    void import('./obsTransitions.ts').then((m) => m.setObsTransition(d.name as string, d.ms as number)).then((r) => d.reply?.(r));
  });
  document.addEventListener(OBS_TRANSITIONS_EVENT, (e) => {
    const d = (e as CustomEvent<{ reply?: (r: ObsTransitions | null) => void } | undefined>).detail;
    if (!d?.reply) return;
    e.preventDefault();
    void import('./obsTransitions.ts').then((m) => m.getObsTransitions()).then((r) => d.reply?.(r));
  });
  document.addEventListener(OBS_UNDO_EVENT, (e) => {
    const d = (e as CustomEvent<{ id?: unknown; reply?: (r: { ok: boolean; error?: string }) => void } | undefined>).detail;
    if (!d || typeof d.id !== 'string') return;
    e.preventDefault();
    void import('./obsTransitions.ts').then((m) => m.undoObsChange(d.id as string)).then((r) => d.reply?.(r));
  });
}
