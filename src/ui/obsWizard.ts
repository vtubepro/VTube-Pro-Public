// "Set up OBS" in the studio (lane obs-wizard): opens the wizard (src/ui/obsWizardCore.ts) in its own full-size
// overlay. Everything goes to this PC's server, same-origin.
// Other lanes: `import('./obsWizard.ts').then((m) => m.openObsWizard())` (CONTRACT.md "obs-wizard").
import { helperPageUrl } from '../net/helper.ts';
import { mountObsWizard, obsSetupSummary as summary, type WizardHandle } from './obsWizardCore.ts';
import type { StepId } from '../../shared/obsSetup.ts';
import { toast } from './dom.ts';
export type { StepId } from '../../shared/obsSetup.ts';

const CSS = `
dialog.ow-dlg{padding:0;border:1px solid rgb(255 255 255/.1);border-radius:20px;background:#0b0f12;color:#eef3ef;width:min(1140px,calc(100vw - 32px));height:min(800px,calc(100vh - 32px));max-width:none;max-height:none;overflow:hidden;box-shadow:0 40px 120px -30px #000}
dialog.ow-dlg::backdrop{background:#05070bd9}
dialog.ow-dlg>.ow-host{height:100%}
@media (max-width:640px){dialog.ow-dlg{width:100vw;height:100dvh;border-radius:0;border:0}}
.ow-need{display:grid;gap:14px;place-content:center;height:100%;padding:24px 16px;max-width:480px;margin:0 auto;text-align:center;font:15px/1.5 Geist,ui-sans-serif,system-ui,"Segoe UI",sans-serif}
.ow-need h2{margin:0;font:700 26px/1.15 Archivo,ui-sans-serif,system-ui,sans-serif}.ow-need p{margin:0;color:#9aa6a0}
/* (a small dialog for three lines and three buttons: the full wizard frame was a huge empty panel that looked broken) */
dialog.ow-dlg:has(.ow-need){width:min(560px,calc(100vw - 32px));height:auto}
.ow.ow-need{grid-template-rows:none;height:auto;align-content:center;padding:32px 24px}
`;

let dlg: HTMLDialogElement | null = null;
let handle: WizardHandle | null = null;

/** Open "Set up OBS". `step` jumps to one step (else the first one that isn't done yet). */
export function openObsWizard(opts: { step?: StepId; full?: boolean } = {}) {
  // autopilot: "Set up OBS" first tries to add VTube Pro to OBS in one click; the wizard opens only where OBS needs you
  if (!opts.step && !opts.full) { void import('./autopilot/obsOneClick.ts').then((m) => m.addToObs()).then((r) => { if (r.open) { if (r.why) toast(r.why, 'info', 8000); openObsWizard({ step: r.step, full: true }); } }, () => openObsWizard({ full: true })); return; }
  if (!document.getElementById('ow-dlg-style')) document.head.append(Object.assign(document.createElement('style'), { id: 'ow-dlg-style', textContent: CSS }));
  if (!dlg) {
    dlg = document.createElement('dialog');
    dlg.className = 'ow-dlg';
    dlg.setAttribute('aria-label', 'Set up OBS');
    dlg.addEventListener('close', () => { handle?.destroy(); handle = null; });
    document.body.append(dlg);
  }
  const host = document.createElement('div');
  host.className = 'ow-host';
  dlg.replaceChildren(host);
  if (!dlg.open) dlg.showModal();
  const close = () => dlg?.close();
  handle?.destroy();
  handle = mountObsWizard(host, { where: 'local', startAt: opts.step, close,
    openHelperPage: (p) => { window.open(helperPageUrl(p), '_blank', 'noopener'); } });
}

/** How far the OBS setup is (for a tab badge). */
export async function obsSetupSummary() {
  return summary();
}
