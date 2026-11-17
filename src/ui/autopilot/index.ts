// Autopilot (beta.12, ZERO-EFFORT RULE): the studio does the work for first-time users. One hook in src/main.ts.
//   mountFirstRun  (firstRun.ts)  starter room on a brand-new install, React "Pick a window",
//                                 camera / mic recovery host (media.ts)
//   mountDoctor    (doctor.ts)    "Fix it" in the top bar: checks everything, fixes what it can, one sentence per row
// Also wired with one-line hooks: obsOneClick.ts (obsWizard.ts openObsWizard),
// media.ts (app.ts startTracking, liveOps.ts startCamera / startMic).
import type { App } from '../../app.ts';
import { mountFirstRun } from './firstRun.ts';
import { mountDoctor } from './doctor.ts';

export function mountAutopilot(app: App, opts: { go?: (area: 'live' | 'me' | 'room' | 'home') => void } = {}) {
  mountFirstRun(app);
  mountDoctor(app, opts);
}
