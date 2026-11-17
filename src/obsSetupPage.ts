// The helper's own "Set up OBS" page (lane obs-wizard): http://127.0.0.1:5191/obs/setup (server/obsSetup.ts serves the
// built obs-setup.html; this PC only). The same wizard as the studio's (src/ui/obsWizardCore.ts), full page. On this
// page the OBS password may be typed (it is served by this computer); `?step=connect` opens that step.
import { mountObsWizard } from './ui/obsWizardCore.ts';
import { STEPS, type StepId } from '../shared/obsSetup.ts';

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[::1\])$/i;
const app = document.getElementById('app')!;
if (!LOOPBACK.test(location.hostname)) {
  // a copy of this page somewhere else: it only works in VTube Pro, on this computer
  app.textContent = 'This page only works in VTube Pro on your computer. Open VTube Pro, then press Set up OBS in the studio.';
} else {
  const s = new URLSearchParams(location.search).get('step');
  const startAt = STEPS.some((x) => x.id === s) ? (s as StepId) : undefined;
  mountObsWizard(app, { where: 'helper', startAt });
}
