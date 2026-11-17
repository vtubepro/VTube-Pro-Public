// Studio entry: shell, tabs, HUD meters, camera picture-in-picture, keyboard shortcuts.
import './storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import './licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import './net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import { flatHotkey } from './ui/flatPanel.ts';
import { App, TEST_EXPRESSIONS } from './app.ts';
import { api } from './api.ts';
import { invalidateLibrary } from './ui/panels.ts';
import { button, clear, h, toast } from './ui/dom.ts';
import { initShell } from './ui/shell.ts';
import { LIGHTING_STATES } from '../shared/lightShow.ts';
import { startHealthBeacon } from './stage/gfx/healthBeacon.ts';
import { installGfxNotice } from './ui/gfxNotice.ts';
import { fontWarmStats, warmFonts } from './ui/fontWarm.ts';
import { autoBench } from './ui/gfxPanel.ts';
import { stageKeys } from './ui/stagePanel.ts';
import { slapKey } from './ui/slapPanel.ts';
import { initTtrpg } from './ttrpg/studio/index.ts';
import { helpIsOpen, openHelp } from './ui/help/helpViewer.ts';
import { LAST_KEY, bootAvatarPlan } from './net/helperLib.ts';
import { installHideScreenHotkey } from './ui/live/hideHotkey.ts';
import { loadPipOff, pipButtonLabel, pipButtonTitle, savePipOff } from './ui/camPip.ts';
import { comboLabel, loadHideScreenKey } from '../shared/hotkey.ts';
import { installObsWizardHooks } from './ui/obsWizardHook.ts';
import { checkAiWaiting } from './ui/aiWaiting.ts';
import { installKeepAwake } from './ui/keepAwake.ts';
import { mountLaneWiring } from './ui/laneWiring.ts';

let app: App;
try {
  app = new App(document.getElementById('stage') as HTMLCanvasElement);
} catch (e) {
  // usually no WebGL 2 (hardware acceleration off, a Flatpak browser without the graphics card): the loading screen
  // turns into "couldn't start" with what to try (src/ui/splash.ts). Nothing below can run without the App.
  (window as unknown as { __vtpBootFail?: (err: unknown) => void }).__vtpBootFail?.(e);
  throw e;
}
(window as unknown as { vtp: App }).vtp = app; // handy for debugging from the console
// an AI already waiting for the user's OK when this page opened (then the helper's bus notice, src/ui/aiWaiting.ts)
void checkAiWaiting(); window.setInterval(() => void checkAiWaiting(false), 30_000);
startHealthBeacon(app); // face-tracking health → OBS pages (Auto graphics quality backs off when tracking slows)
installGfxNotice(app);
void import('./ui/gamingNudge.ts').then((m) => m.installGamingNudge(app)); // a fullscreen game while tracking is set to the graphics card: one question, "For games?" (src/ui/gamingNudge.ts)
void import('./ui/gameMode.ts').then((m) => m.installGameMode(app)); void import('./ui/logicPreview.ts').then((m) => m.mountLogicPreview(app)); // a game holding the graphics card: tracking off it, no second room render, one notice (src/ui/gameMode.ts); the room's seat analysis when the preview is off (src/ui/logicPreview.ts)
warmFonts(); (window as unknown as { vtpFontWarm: unknown }).vtpFontWarm = fontWarmStats; // fonts / symbol fallbacks the interface uses, warmed in idle time (src/ui/fontWarm.ts)  // an OBS page lowered the room quality by itself: one sentence, OK / Undo (src/ui/gfxNotice.ts)
autoBench(app);         // the first-run quality benchmark starts by itself once a room preview is up (src/ui/gfxPanel.ts)

// ---- shell: top bar (status chips, Simple / Advanced, theme, help), the area rail and the panel (src/ui/shell.ts) ----
const shell = initShell(app);
// phones: no helper / OBS calls to action, Pro2D show mode, camera recovery; every studio: graphics-memory recovery (src/mobile/)
void import('./mobile/phoneUi.ts').then((m) => m.installPhone(app));
// no graphics card for the browser (software 3D): what the studio changed + how to fix it (src/ui/softwareGlNotice.ts)
if (app.softGl.active) void import('./ui/softwareGlNotice.ts').then((m) => m.mountSoftwareGlNotice(app));
// autopilot: the obvious next steps happen by themselves + "Fix it" on every screen (src/ui/autopilot/index.ts)
void import('./ui/autopilot/index.ts').then((m) => m.mountAutopilot(app, { go: (a) => shell.go(a) }));
// a background studio tab in use (camera, OBS, a party) must not be frozen by the browser's power saving (src/ui/keepAwake.ts)
installKeepAwake(app.observer, toast, () => { try { return !!localStorage.getItem('vtp.tracking'); } catch { return false; } });
// "Set up OBS" hand-offs (Live → OBS tab, transitions): document events, the wizard loads only when used
installObsWizardHooks();
// "Just drop a model": a model file / folder / zip dropped anywhere → the import report + fixes (src/ui/dropImport.ts)
void import('./ui/dropImport.ts').then((m) => m.mountDropImport(app));
// beta.12 lane wiring: 2D drops → 2D importer / avatar maker, show dock Room + Me rows, Tools → Create a 2D avatar (src/ui/laneWiring.ts)
mountLaneWiring(app);
// audio mixer: every voice's level + volume, Mute for me (cameras still follow), noise gates (src/ui/audioMixerPanel.ts)
void import('./ui/audioMixerPanel.ts').then((m) => m.mountAudioMixer(app));
void import('./ui/stage/interviewHost.ts').then((m) => m.mountInterviewHost(app)); // Interview: THE auto director (cues to every OBS page) + its hotkeys / Stream Deck commands
// ---- tabletop RPG mode: the TTRPG drawer, launcher + the stage-mode entry (src/ttrpg, docs/TTRPG.md) ----
initTtrpg(app);

// ---- viewport overlays ----
const viewport = document.getElementById('viewport')!;
const hud = document.getElementById('hud')!;
const statusLine = document.getElementById('statusline')!;
const titled = (b: HTMLElement, title: string) => { b.title = title; return b; };
// "Hide camera": the corner camera picture off while tracking carries on, to show your settings without showing yourself
// (issue #15; src/ui/camPip.ts). It only appears while the camera is on.
const pipStore = (() => { try { return localStorage; } catch { return null; } })();
let pipOff = loadPipOff(pipStore);
const pipBtn = button(pipButtonLabel(pipOff), () => { pipOff = !pipOff; savePipOff(pipStore, pipOff); syncPip(); });
viewport.append(h('div', { class: 'viewbar' },
  titled(button('Head', () => { app.focus = 'head'; app.frameCamera(); }), 'Show your head up close'),
  titled(button('Bust', () => { app.focus = 'bust'; app.frameCamera(); }), 'Show your head and shoulders'),
  titled(button('Full', () => { app.focus = 'full'; app.frameCamera(); }), 'Show your whole avatar'),
  titled(button('Calibrate', () => void calibrate()), 'Calibrate (C): look at the screen with a relaxed face for 2 seconds, so small movements read right'),
  pipBtn,
  titled(button('Hide menus (H)', () => document.body.classList.toggle('clean')), 'Hide the menus for a clean window (H)'),
));
const banner = h('div', { class: 'banner', style: 'display:none' });
const meters = h('div', { class: 'meters' });
hud.append(banner, meters);
const METERS = ['jawOpen', 'mouthSmileLeft', 'mouthSmileRight', 'eyeBlinkLeft', 'eyeBlinkRight', 'browInnerUp', 'browDownLeft', 'mouthPucker', 'mouthFunnel', 'cheekPuff'];
const meterEls = METERS.map((m) => {
  const fill = h('i'), raw = h('b'), val = h('span', null, '0');
  meters.append(h('div', { class: 'meter' }, h('span', null, m.replace('mouth', 'm.').replace('eye', 'e.')), h('div', { class: 'bar' }, fill, raw), val));
  return { m, fill, raw, val };
});

// camera PiP with landmark overlay. clarity (owner: users thought VTube Pro was "stealing their camera feed"): it says
// who sees it. Only this window shows it: output.html (OBS) never has it. The caption sits outside the mirrored
// video / canvas, so its text never flips.
const pip = document.getElementById('campip')!;
const pipCanvas = h('canvas');
pip.title = 'Your camera, only on your screen. It moves your avatar. OBS and your viewers see your avatar, not this picture.';
pip.append(app.video.video, pipCanvas, h('span', { class: 'pip-cap', 'aria-hidden': 'true' }, 'Your camera · only on your screen'));
/** The picture hidden or shown by the user (CSS `.pip-off`), and the button that does it (only while the camera is on). */
function syncPip() {
  pip.classList.toggle('pip-off', pipOff);
  pipBtn.textContent = pipButtonLabel(pipOff);
  pipBtn.title = pipButtonTitle(pipOff);
  pipBtn.style.display = app.trackingOn ? '' : 'none';
}
syncPip();

async function calibrate() {
  if (!app.trackingOn) { toast('Turn on your camera first (Home → Turn on camera).', 'warn'); return; }
  toast('Relax your face and look at the screen…');
  await app.face.calibrate(2);
  toast('Calibrated ✔', 'ok');
}

// ---- events ----
const prompt = h('div', { id: 'prompt', style: 'display:none' });
viewport.append(prompt);
app.on((what) => {
  if (what.startsWith('prompt:')) {
    const body = what.slice(7);
    prompt.style.display = body ? '' : 'none';
    if (body) {
      const [step, say, rem] = body.split('|');
      clear(prompt);
      prompt.append(h('small', null, `Step ${step} · ${rem}s`), h('div', null, say));
    }
    return;
  }
  if (what.startsWith('status:')) { statusLine.textContent = what.slice(7); return; }
  if (what === 'avatar') {
    // only the views that show the avatar; the re-render keeps the user's place and skips unchanged DOM
    shell.onApp('avatar');
    statusLine.textContent = '';
  }
  if (what === 'costume' || what === 'setup') shell.onApp(what);
  if (what === 'library') { invalidateLibrary(); shell.onApp('library'); }
  if (what === 'tracking') { pip.classList.toggle('on', app.trackingOn); syncPip(); shell.onApp('tracking'); }
  if (what === 'placing') {
    banner.style.display = app.placing ? '' : 'none';
    clear(banner);
    if (app.placing) banner.append(`Click on the model to place: ${placeName(app.placing.kind)}  `, button('Cancel', () => app.cancelPlace()));
  }
});
const placeName = (k: string) => ({ eyeL: 'left eye', eyeR: 'right eye', mouth: 'mouth', jiggle: 'jiggle centre', shoulderL: 'left shoulder', shoulderR: 'right shoulder', handL: 'left hand', handR: 'right hand' } as Record<string, string>)[k] ?? k;

// Hide my screen (the capture cover): Ctrl+B by default, rebindable in Live → Privacy (src/ui/live/hideHotkey.ts).
// Global: any area, any Live tab, a docked tool's frame (it forwards the press); not while typing in a text field.
installHideScreenHotkey(() => {
  if (!app.scene.canEdit) { toast('Only the host can hide the screen', 'warn', 1600); return; }
  const on = !app.scene.capcover.on; app.scene.toggleCapCover(on);
  toast(on ? `Your screen is hidden (${comboLabel(loadHideScreenKey(localStorage))} shows it again)` : 'Your screen is showing again', 'ok', 1600);
});
// F1 = Help, from anywhere in the studio: also while typing in a search box, on the 3D view or with a menu open. Capture
// phase + preventDefault, before any other handler can return early: otherwise Chrome / Edge open their own help tab.
// (Help's own window handles F1 itself while it is open: it focuses its search box.) Docked tool frames forward F1 here.
window.addEventListener('keydown', (e) => {
  if (e.key !== 'F1' || e.ctrlKey || e.altKey || e.metaKey) return;
  e.preventDefault();
  if (!helpIsOpen()) openHelp();
}, true);
window.addEventListener('message', (e) => { if (e.origin === location.origin && (e.data as { k?: string } | null)?.k === 'vtp-help-f1' && !helpIsOpen()) openHelp(); });
window.addEventListener('keydown', (e) => {
  if ((e.target as HTMLElement).closest('input,textarea,select') || (e.target as HTMLElement).isContentEditable) return; // (typing: never a shortcut)
  // Shift+T / R / G …: show modes; Shift+< / >: the current mode's presets (src/ui/stagePanel.ts)
  if (stageKeys(e, app)) return;
  // Shift+S: send the slapper (Scene tab → 🖐 Slap!, src/ui/slapPanel.ts)
  if (slapKey(e, app)) return;
  // a 2D avatar's expression / motion hotkeys (src/ui/flatPanel.ts)
  if (flatHotkey(e, app)) return;
  // Ctrl+1..9 wear outfit N, Ctrl+0 none (Alt+digit too: some browsers keep Ctrl+digit for tab switching). N counts outfits only,
  // like the numbered cards in Me and the Wardrobe (accessories are switches, not outfits)
  const digit = /^Digit([0-9])$/.exec(e.code)?.[1] ?? (/^[0-9]$/.test(e.key) ? e.key : null);
  if (digit !== null && (e.ctrlKey || e.altKey) && !e.shiftKey && !e.metaKey) {
    e.preventDefault();
    const n = Number(digit);
    const c = n === 0 ? null : app.profile?.costumes.filter((x) => x.kind !== 'accessory')[n - 1];
    if (c === undefined) toast(`No outfit #${n}`, 'warn', 1500);
    else void app.setCostume(c ? c.id : null);
    return;
  }
  // Shift+1..5: lighting states (Preshow, Show, React, BRB, Outro - src/scene/lightShow.ts)
  if (digit !== null && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey && +digit >= 1 && +digit <= 5) {
    e.preventDefault();
    const st = LIGHTING_STATES[+digit - 1];
    if (app.scene.effective.sceneId && app.scene.canEdit) { app.scene.setLighting(st.id); toast(`Lighting: ${st.label}`, 'ok', 1200); }
    return;
  }
  // Shift+Enter: confirm a held room-change transition (Scene tab → Transitions → "Hold until I confirm")
  if (e.key === 'Enter' && e.shiftKey && !e.ctrlKey && !e.altKey && !e.metaKey) {
    if (app.scene.canEdit && app.scene.curtainWaiting) { e.preventDefault(); app.scene.confirmCurtain(); toast('Scene revealed', 'ok', 1200); }
    return;
  }
  if (e.key === '?') { shell.showShortcuts(); return; }
  if (e.key === 'Escape') { app.cancelPlace(); document.body.classList.remove('clean'); }
  else if (e.key === 'h' || e.key === 'H') document.body.classList.toggle('clean');
  else if (e.key === 'c' || e.key === 'C') void calibrate();
  else if (e.key === 'f' || e.key === 'F') app.frameCamera();
  else if (/^[1-9]$/.test(e.key)) app.preview(Object.keys(TEST_EXPRESSIONS)[Number(e.key)]);
});

// ---- HUD refresh (10 Hz is plenty for UI) ----
setInterval(() => {
  // (status chips: src/ui/shell.ts) — the raw blendshape meters are for tuning: only where you chose Advanced (Show,
  // Chat and OBS always show every setting, but that is no reason to show face meters to a Simple user)
  const meterShown = app.trackingOn && shell.isTuning();
  meters.style.display = meterShown ? '' : 'none';
  // (the meters' bars are only written while they are shown, the camera overlay only while its picture is on screen)
  if (meterShown) for (const e of meterEls) {
    const v = app.frame.face[e.m] ?? 0, r = app.face.raw[e.m] ?? 0;
    e.fill.style.width = `${v * 100}%`; e.raw.style.left = `${r * 100}%`; e.val.textContent = v.toFixed(2);
  }
  pip.classList.toggle('mirror', app.tune.mirror);
  if (!pipOff && !document.hidden) drawOverlay();
}, 100);

/** The tracker result the overlay canvas shows now (a new one is drawn, the same one is not drawn again). */
let overlayRaw: unknown = null;

function drawOverlay() {
  const raw = app.lastRaw;
  const v = app.video.video;
  if (!app.trackingOn || !raw || !v.videoWidth) return;
  const ow = 280, oh = Math.round((280 * v.videoHeight) / v.videoWidth);
  // same result, same size: the canvas already shows it (setting width / height clears and reallocates the canvas)
  if (raw === overlayRaw && pipCanvas.width === ow && pipCanvas.height === oh) return;
  overlayRaw = raw;
  if (pipCanvas.width !== ow) pipCanvas.width = ow;
  if (pipCanvas.height !== oh) pipCanvas.height = oh;
  const ctx = pipCanvas.getContext('2d')!;
  ctx.clearRect(0, 0, pipCanvas.width, pipCanvas.height);
  const W = pipCanvas.width, H = pipCanvas.height;
  const lm = raw.face?.faceLandmarks?.[0];
  if (lm) { ctx.fillStyle = '#7bd88f'; for (let i = 0; i < lm.length; i += 2) ctx.fillRect(lm[i].x * W, lm[i].y * H, 1.2, 1.2); }
  const pose = raw.pose?.landmarks?.[0];
  if (pose) { ctx.fillStyle = '#ff6bb5'; for (const p of pose) if ((p.visibility ?? 1) > 0.5) ctx.fillRect(p.x * W - 2, p.y * H - 2, 4, 4); }
  for (const hand of raw.hands?.landmarks ?? []) { ctx.fillStyle = '#4cc9f0'; for (const p of hand) ctx.fillRect(p.x * W - 1.5, p.y * H - 1.5, 3, 3); }
}

// ---- server status: the shell's top bar polls it ----

// ---- boot ----
void (async () => {
  try {
    const list = await api.avatars();
    // (a starter that opens only because the user's pick is missing from a short list is not saved over the pick:
    //  src/net/helperLib.ts bootAvatarPlan)
    const { id, remember } = bootAvatarPlan(list, { last: localStorage.getItem(LAST_KEY) });
    if (id) await app.loadAvatar(id, false, true, remember);
    await app.resume();
    shell.onApp('tracking');
  } catch {
    toast('VTube Pro’s engine stopped. Restart VTube Pro.', 'err', 10000);
  }
})();
