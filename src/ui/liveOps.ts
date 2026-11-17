// Shared "do the thing" helpers for the Simple views and the setup wizards: start / stop the camera and the mic the
// same way the Track tab does (same localStorage keys, so the legacy panels stay in sync), live face / lighting /
// framing checks, the OBS Browser Source numbers, copy buttons. Nothing here runs on its own: every action is a
// user click. An ?observer=1 studio never opens the camera or the microphone.
import type { App } from '../app.ts';
import { PREFERRED_CAMERA, PREFERRED_MIC, RESOLUTIONS, listCameras, listMics, preferred, type CameraOption } from '../tracking/camera.ts';
import { button, h, toast } from './dom.ts';
import { askOnceForBoth, autoPickMic, mediaFailed } from './autopilot/media.ts';

export const OBS_URL = 'http://127.0.0.1:5191/output.html';

export function copyText(text: string, what = 'Copied') {
  const done = () => toast(`${what} — paste it into OBS (Ctrl+V)`, 'ok', 2600);
  try { void navigator.clipboard.writeText(text).then(done, () => fallbackCopy(text, done)); } catch { fallbackCopy(text, done); }
}
function fallbackCopy(text: string, done: () => void) {
  const ta = h('textarea', { value: text, style: 'position:fixed;left:-9999px' }) as HTMLTextAreaElement;
  document.body.append(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch { toast('Copy failed — select the text and press Ctrl+C', 'warn'); }
  ta.remove();
}
/** A labelled value with a Copy button. */
export function copyRow(label: string, value: string, what = label) {
  return h('div', { class: 's-copy' }, h('span', { class: 'lbl' }, label), h('code', { title: value }, value), button('Copy', () => copyText(value, `${what} copied`)));
}

// ---------------------------------------------------------------- camera
let camCache: CameraOption[] | null = null;
export async function cameras(refresh = false) { if (!camCache || refresh) camCache = await listCameras().catch(() => []); return camCache; }
let micCache: CameraOption[] | null = null;
export async function mics(refresh = false) { if (!micCache || refresh) micCache = await listMics().catch(() => []); return micCache; }
export function savedCamera(list: CameraOption[]) { const s = localStorage.getItem('vtp.cam'); return list.find((c) => c.deviceId === s) ?? preferred(list, PREFERRED_CAMERA); }
export function savedMic(list: CameraOption[]) { const s = localStorage.getItem('vtp.mic'); return list.find((m) => m.deviceId === s) ?? preferred(list, PREFERRED_MIC); }

/** Start the webcam + face tracking (explicit user action). Returns false in an observer studio. */
export async function startCamera(app: App, deviceId?: string, resIndex?: number) {
  if (app.observer) { toast('Observer sandbox: the camera stays off here (it would fight your real studio).', 'warn', 5000); return false; }
  const idx = resIndex ?? Number(localStorage.getItem('vtp.res') ?? 2);
  const r = RESOLUTIONS[idx] ?? RESOLUTIONS[2];
  const fps = Number(localStorage.getItem('vtp.fps') ?? 60) || 60;
  if (deviceId) { localStorage.setItem('vtp.cam', deviceId); localStorage.setItem('vtp.camChosen', '1'); }
  localStorage.setItem('vtp.res', String(idx));
  await askOnceForBoth(); // autopilot: one browser question for camera + mic (src/ui/autopilot/media.ts)
  await app.startTracking({ deviceId: deviceId || localStorage.getItem('vtp.cam') || undefined, width: r.width, height: r.height, fps });
  // autopilot: the mic comes on with the camera (it only moves the mouth), unless it was turned off on purpose before
  if (app.trackingOn && !app.audio.active && localStorage.getItem('vtp.micOff') !== '1') await startMic(app);
  return app.trackingOn;
}

/** Turn the lip-sync microphone on (explicit user action) — same as the Track tab's "Use microphone". */
export async function startMic(app: App, deviceId?: string) {
  if (app.observer) { toast('Observer sandbox: the microphone stays off here.', 'warn', 5000); return false; }
  try {
    app.edit((p) => (p.tracking.audioLipSync = true), false);
    if (deviceId) { localStorage.setItem('vtp.mic', deviceId); localStorage.setItem('vtp.micChosen', '1'); }
    // autopilot: no choice yet → the best real microphone (never "Stereo Mix" / a virtual cable)
    const auto = localStorage.getItem('vtp.micChosen') ? null : await autoPickMic(PREFERRED_MIC);
    await app.audio.start(auto ? auto.id : localStorage.getItem('vtp.mic') ?? undefined);
    if (auto && !app.audio.deviceLabel) app.audio.deviceLabel = auto.label;
    localStorage.setItem('vtp.micOn', '1'); localStorage.removeItem('vtp.micOff');
    toast(`Microphone on${app.audio.deviceLabel ? ` (${app.audio.deviceLabel})` : ''} — your avatar's mouth now follows your voice too`, 'ok');
    return true;
  } catch (e) { if (!mediaFailed('mic', e)) toast(`The microphone didn't start: ${(e as Error).message}. Check Windows privacy settings → Microphone.`, 'err', 8000); return false; }
}
export function stopMic(app: App) { app.audio.stop(); localStorage.removeItem('vtp.micOn'); localStorage.setItem('vtp.micOff', '1'); }

/** 0..1 mic level for a meter (the noise filter's raw dBFS when running, else the analyser level). */
export function micLevel(app: App): number {
  const st = app.audio.fx?.stat;
  if (st && Number.isFinite(st.raw)) return Math.min(1, Math.max(0, (st.raw + 70) / 60));
  return Math.min(1, app.audio.last.level ?? 0);
}

// ---------------------------------------------------------------- live face check
export type Check = { state: 'ok' | 'warn' | 'err' | 'idle'; title: string; detail: string };
const sampler = { cv: null as HTMLCanvasElement | null, at: 0, luma: -1, faceLuma: -1 };
/** Lighting / framing / distance checks from the live camera + landmarks (cheap: a 48×27 sample twice a second). */
export function faceChecks(app: App): Check[] {
  if (!app.trackingOn) return [
    { state: 'idle', title: 'Face found', detail: 'Turn the camera on first.' },
    { state: 'idle', title: 'Lighting', detail: 'Waiting for the camera.' },
    { state: 'idle', title: 'Framing', detail: 'Waiting for the camera.' },
  ];
  const v = app.video.video;
  const lm = app.lastRaw?.face?.faceLandmarks?.[0];
  let box: { x0: number; y0: number; x1: number; y1: number } | null = null;
  if (lm && app.stats.tracked) {
    let x0 = 1, y0 = 1, x1 = 0, y1 = 0;
    for (let i = 0; i < lm.length; i += 4) { const p = lm[i]; if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
    box = { x0, y0, x1, y1 };
  }
  const now = performance.now();
  if (v.videoWidth && now - sampler.at > 500) {
    sampler.at = now;
    const cv = (sampler.cv ??= h('canvas', { width: 48, height: 27 }) as HTMLCanvasElement);
    const g = cv.getContext('2d', { willReadFrequently: true });
    if (g) {
      g.drawImage(v, 0, 0, 48, 27);
      const d = g.getImageData(0, 0, 48, 27).data;
      let sum = 0, fs = 0, fn = 0;
      for (let y = 0; y < 27; y++) for (let x = 0; x < 48; x++) {
        const i = (y * 48 + x) * 4, l = 0.2126 * d[i] + 0.7152 * d[i + 1] + 0.0722 * d[i + 2];
        sum += l;
        if (box && x / 48 >= box.x0 && x / 48 <= box.x1 && y / 27 >= box.y0 && y / 27 <= box.y1) { fs += l; fn++; }
      }
      sampler.luma = sum / (48 * 27);
      sampler.faceLuma = fn ? fs / fn : -1;
    }
  }
  const face: Check = app.stats.tracked ? { state: 'ok', title: 'Face found', detail: 'Tracking your face.' } : { state: 'err', title: 'No face yet', detail: 'Look at the camera. Is anything covering the lens?' };
  const L = sampler.faceLuma >= 0 ? sampler.faceLuma : sampler.luma;
  const light: Check = L < 0 ? { state: 'idle', title: 'Lighting', detail: 'Measuring…' }
    : L < 55 ? { state: 'err', title: 'Too dark', detail: 'Turn on a lamp in front of you (behind the screen works best).' }
      : sampler.faceLuma >= 0 && sampler.luma - sampler.faceLuma > 38 ? { state: 'warn', title: 'Backlit', detail: 'A bright light or window is behind you. Put light in front of you instead.' }
        : L > 215 ? { state: 'warn', title: 'Very bright', detail: 'Your face is almost white. Dim the light or move it a bit further away.' }
          : L < 85 ? { state: 'warn', title: 'A bit dark', detail: 'It works, but more light on your face makes expressions steadier.' }
            : { state: 'ok', title: 'Lighting is good', detail: 'Your face is evenly lit.' };
  let frame: Check = { state: 'idle', title: 'Framing', detail: 'Waiting for your face.' };
  if (box) {
    const cx = (box.x0 + box.x1) / 2, cy = (box.y0 + box.y1) / 2, w = box.x1 - box.x0;
    const cm = app.face.metric.Z > 0 ? ` (about ${Math.round(app.face.metric.Z * 100)} cm away)` : '';
    frame = w < 0.11 ? { state: 'warn', title: 'Move closer', detail: `Your face is small in the picture${cm}. Sit closer or zoom the camera in.` }
      : w > 0.5 ? { state: 'warn', title: 'Move back a little', detail: `Your face fills the picture${cm}. Leave room for head turns.` }
        : cx < 0.3 || cx > 0.7 ? { state: 'warn', title: 'Centre yourself', detail: 'Move so your face is in the middle of the picture.' }
          : cy < 0.2 || cy > 0.68 ? { state: 'warn', title: 'Adjust the height', detail: cy < 0.2 ? 'Your face is near the top edge: tilt the camera up a little.' : 'Your face is low: raise the camera to eye level.' }
            : { state: 'ok', title: 'Framing is good', detail: `Centred, good size${cm}.` };
  }
  return [face, light, frame];
}

/** A small live copy of the camera picture (same stream, no second camera open). */
export function cameraMirror(app: App): HTMLVideoElement {
  const v = h('video', { muted: true, autoplay: true, playsInline: true }) as HTMLVideoElement;
  const src = app.video.video;
  if (src.srcObject) v.srcObject = src.srcObject; else if (src.src) v.src = src.src;
  void v.play().catch(() => {});
  return v;
}
