// Tutorials: "is it done?" — each TutState read straight from the studio. Read-only: nothing here changes anything.
import type { App } from '../../app.ts';
import type { TutState } from './types.ts';
import { pollObs } from '../simple.ts';
import { wizardOpen } from '../wizard.ts';
import { onboardingOpen } from '../onboard/shell.ts';
import { discord } from '../../net/discordClient.ts';

let modelSaved = 0;
let listening = false;
/** Start watching for things that happen once (a model saved). Called when a tutorial starts. */
export function watchOnce() {
  if (!listening) {
    listening = true;
    document.addEventListener('vtp-onboard', (e) => { const d = (e as CustomEvent).detail as { kind?: string; saved?: boolean } | undefined; if (d?.kind === 'model' && d.saved) modelSaved = Date.now(); });
  }
}
let since = 0;
export function resetOnce() { since = Date.now(); }

// hosting set up (Discord connected + signed in): asked at most every 4 s while a tutorial looks at it
let partyReady = false, partyAt = 0;
function hostingReady() {
  if (Date.now() - partyAt > 4000) { partyAt = Date.now(); void discord.status().then((d) => { partyReady = !!(d.configured && d.signedIn); }).catch(() => { partyReady = false; }); }
  return partyReady;
}

const dialogOpen = () => !!document.querySelector('dialog.ss-dlg[open], dialog.ow-dlg[open], .vtpi-shade, .rp-over');

export function tutState(app: App, s: TutState): boolean {
  const sc = app.scene;
  const eff = sc.effective;
  switch (s) {
    case 'camera-on': return app.trackingOn;
    case 'face-found': return app.trackingOn && !!app.stats.tracked;
    case 'mic-on': return !!app.audio.active;
    case 'avatar-on': return !!app.profile;
    // saved: the import window says "Added" (its Wear it now button; the guided Add my model: Use it now), or it closed after saving
    case 'avatar-added': return modelSaved > since || !!document.querySelector('[data-tut~="imp-use"], [data-tut~="ob-use"]');
    case 'outfit-on': return !!app.profile?.costume;
    case 'room-on': return !!eff.sceneId;
    case 'in-obs': return pollObs() > 0;
    case 'mode-react': return eff.mode === 'react';
    case 'sharing': return sc.capturing;
    case 'cover-on': return !!sc.capcover.on;
    case 'cover-off': return !sc.capcover.on;
    case 'brb-on': return eff.lights?.state === 'brb';
    case 'brb-off': return eff.lights?.state !== 'brb';
    case 'host': return app.party.role === 'host';
    case 'party-ready': return app.party.role === 'host' || hostingReady();
    case 'chat-on': return !!sc.chat.status?.configured;
    case 'live-open': return document.querySelector('.area-body')?.getAttribute('data-ui') === 'simple:onair';
    case 'wizard-open': return wizardOpen() || onboardingOpen() || dialogOpen();
    case 'wizard-closed': return !(wizardOpen() || onboardingOpen() || dialogOpen());
  }
}
