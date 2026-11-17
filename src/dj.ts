// DJ impostor feed: renders the studio's current avatar (live face/body tracking) from the exact eye point
// of a host 3D scene's camera and hands each frame to the host page as an ImageBitmap.
//
// The host (e.g. an earlier overlay's rave scene) embeds http://<host>:5191/dj.html in a tiny iframe and
// talks to it with postMessage:
//   host → dj  { type:'vtp-dj:view', eye:[x,y,z], px, light? }   (every host frame; only the latest is kept)   eye in AVATAR space (metres, +Z faces
//              the crowd/camera, feet at y = meta.footY); px = wanted render size (square, CSS px).
//   dj → host  { type:'vtp-dj:meta', avatarId, name, height, footY, center:[x,y,z], radius, faceY, faceSize }
//              { type:'vtp-dj:frame', bitmap, eye, center, halfSize, live, stamps }   pushed as soon as tracking arrives   halfSize = half the side of
//              the square the image covers on the plane through `center` perpendicular to eye→center.
// Rendering is driven by bus/host messages (not rAF), so it keeps working when the iframe is off-screen
// and the browser throttles its animation frames.
//
// URL params: ?avatar=<id> pins one (default: follow the studio), ?tier=low|medium|high|ultra, ?fps=90,
// ?lead=18 (ms of head prediction added for the hop to the host).

import './storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import './licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import './net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import * as THREE from 'three';
import type { TrackingFrame } from '../shared/types.ts';
import { normalizeProfile } from '../shared/defaults.ts';
import { api } from './api.ts';
import { AvatarRuntime } from './avatar/AvatarRuntime.ts';
import { Bus } from './bus.ts';
import { SourceLock, type SourceMsg } from './outputFollow.ts';
import { Stage } from './stage/Stage.ts';
import { emptyFrame } from './tracking/faceSolver.ts';

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('stage') as HTMLCanvasElement;
const stage = new Stage(canvas, { transparent: true, tier: (q.get('tier') as never) || 'high', controls: false });
const bus = new Bus('output');
const pinned = q.get('avatar');

// ---------------------------------------------------------------- avatar
let runtime: AvatarRuntime | null = null;
let loadingId = '';
let reloadAfter = false;
/** Rest-pose measurements (stable while the avatar moves). */
let meta = { height: 1.6, footY: 0, center: new THREE.Vector3(0, 0.8, 0), radius: 1, faceY: 1.5, faceSize: 0.25 };
const metaMsg = () => ({ type: 'vtp-dj:meta', avatarId: runtime?.profile.id, name: runtime?.profile.name, height: meta.height, footY: meta.footY, center: meta.center.toArray(), radius: meta.radius, faceY: meta.faceY, faceSize: meta.faceSize });

async function load(avatarId: string, force = false): Promise<void> {
  if (loadingId === avatarId) { if (force) reloadAfter = true; return; }
  if (!force && runtime?.profile.id === avatarId) return;
  loadingId = avatarId;
  try {
    const p = normalizeProfile(await api.avatar(avatarId));
    const rt = await AvatarRuntime.load(p, api.modelUrl(p), stage.anchor);
    runtime?.dispose();
    runtime = rt;
    stage.anchor.updateMatrixWorld(true);
    const box = rt.bounds(), size = box.getSize(new THREE.Vector3());
    // generous radius: arms go up, hair swings, gesture effects spawn above the hands
    const face = rt.faceInfo();
    meta = {
      height: size.y || 1.6, footY: box.min.y, center: box.getCenter(new THREE.Vector3()), radius: Math.max(size.x, size.y, size.z) * 0.62 + 0.1,
      faceY: face?.center.y ?? box.max.y - size.y * 0.12, faceSize: face?.size ?? size.y * 0.2,
    };
    post(metaMsg());
  } catch (e) {
    console.error('dj: load failed', avatarId, e);
  } finally { loadingId = ''; }
  if (reloadAfter) { reloadAfter = false; return load(avatarId, true); }
}

// ---------------------------------------------------------------- tracking from the studio bus
let frame: TrackingFrame = emptyFrame();
const shown: TrackingFrame = emptyFrame();
let lastFrameAt = 0;
// one publisher at a time (the same lock as output.ts, src/outputFollow.ts): the studio where the performer last
// switched avatar, holding while it talks; a stalled studio gets it back
const lock = new SourceLock();
bus.on((m) => {
  if ((m.type === 'frame' || m.type === 'load') && !lock.accept(m as SourceMsg, performance.now())) return;
  if (m.type === 'frame' && !m.peer) { frame = m.frame; lastFrameAt = performance.now(); }
  else if ((m.type === 'load' || m.type === 'profile') && (!pinned || pinned === m.avatarId)) {
    if (m.type === 'profile' && runtime?.profile.id !== m.avatarId) return;
    void load(m.avatarId, m.type === 'profile');
  }
});

async function start() {
  if (pinned) return load(pinned);
  // the studio re-announces its avatar every 2 s: wait for that before guessing, so we don't flash another model
  await new Promise((r) => setTimeout(r, 2600));
  if (runtime || loadingId) return;
  const list = await api.avatars().catch(() => []);
  const last = localStorage.getItem('vtp.lastAvatar');
  const id = (last && list.find((a) => a.id === last)?.id) || list[0]?.id;
  if (id) await load(id);
}
void start();

// Frames arrive at the studio's rate with jitter; ease toward the newest (same as the OBS output page).
const _q = new THREE.Quaternion();
const shownBones: Record<string, THREE.Quaternion> = {};
function ease(dt: number): TrackingFrame {
  const k = 1 - Math.exp(-150 * dt);
  const L = (a: number | undefined, b: number) => (a === undefined || !Number.isFinite(a) ? b : a + (b - a) * k);
  for (const n in frame.face) shown.face[n] = L(shown.face[n] ?? 0, frame.face[n]);
  for (const n in shown.face) if (!(n in frame.face)) shown.face[n] = L(shown.face[n], 0);
  for (let i = 0; i < 3; i++) { shown.head[i] = L(shown.head[i], frame.head[i]); shown.headPos[i] = L(shown.headPos[i], frame.headPos[i]); }
  shown.gaze = [L(shown.gaze[0], frame.gaze[0]), L(shown.gaze[1], frame.gaze[1])];
  const sm = shown.mouth as unknown as Record<string, number>, fm = frame.mouth as unknown as Record<string, number>;
  for (const n in fm) sm[n] = L(sm[n], fm[n]);
  shown.tracked = frame.tracked;
  shown.fx = frame.fx;
  shown.visemes = frame.visemes;
  if (frame.lips) {
    shown.lips ??= { u: [...frame.lips.u], l: [...frame.lips.l] };
    for (let i = 0; i < frame.lips.u.length; i++) { shown.lips.u[i] = L(shown.lips.u[i], frame.lips.u[i]); shown.lips.l[i] = L(shown.lips.l[i], frame.lips.l[i]); }
  } else shown.lips = undefined;
  const out: Record<string, [number, number, number, number]> = {};
  for (const b in frame.bones ?? {}) {
    _q.fromArray(frame.bones![b]);
    const cur = (shownBones[b] ??= _q.clone());
    cur.slerp(_q, k);
    out[b] = [cur.x, cur.y, cur.z, cur.w];
  }
  shown.bones = out;
  return shown;
}

// ---------------------------------------------------------------- stage lights follow the host's show
const lights = { hemi: [] as THREE.HemisphereLight[], dir: [] as THREE.DirectionalLight[] };
stage.scene.traverse((o) => {
  if ((o as THREE.HemisphereLight).isHemisphereLight) lights.hemi.push(o as THREE.HemisphereLight);
  else if ((o as THREE.DirectionalLight).isDirectionalLight) lights.dir.push(o as THREE.DirectionalLight);
});
const base = {
  hemi: lights.hemi.map((l) => ({ c: l.color.clone(), g: l.groundColor.clone(), i: l.intensity })),
  dir: lights.dir.map((l) => ({ c: l.color.clone(), i: l.intensity })),
  env: stage.scene.environmentIntensity,
};
interface HostLight { ambient?: number[]; key?: number[]; rim?: number[]; flash?: number }
const _c = new THREE.Color();
/** Colours are [r,g,b,intensityScale] in 0..1 sRGB; missing entries keep the studio's own lighting. */
function applyLight(L: HostLight | undefined) {
  const set = (light: THREE.Light, c: THREE.Color, i: number, v?: number[]) => {
    if (!v) { light.color.copy(c); light.intensity = i; return; }
    light.color.copy(_c.setRGB(v[0], v[1], v[2], THREE.SRGBColorSpace));
    light.intensity = i * (v[3] ?? 1);
  };
  const flash = Math.max(0, Math.min(1, L?.flash ?? 0));
  lights.hemi.forEach((l, i) => {
    set(l, base.hemi[i].c, base.hemi[i].i, L?.ambient);
    l.groundColor.copy(base.hemi[i].g).multiplyScalar(L?.ambient ? 0.35 : 1);
    l.intensity += flash * 2.5;
  });
  // Stage adds the key first, then the rim
  lights.dir.forEach((l, i) => set(l, base.dir[i].c, base.dir[i].i, i === 0 ? L?.key : L?.rim));
  stage.scene.environmentIntensity = base.env * (L?.ambient ? 0.5 + 0.5 * (L.ambient[3] ?? 1) : 1);
}

// ---------------------------------------------------------------- host protocol
let host: { win: MessageEventSource; origin: string } | null = null;
function post(m: Record<string, unknown>, transfer: Transferable[] = []) {
  if (!host) return;
  (host.win as Window).postMessage(m, { targetOrigin: host.origin, transfer });
}

let size = 0;
function setSize(px: number) {
  // quantised so a moving camera doesn't reallocate the drawing buffer every frame
  const steps = [192, 256, 384, 512, 640, 768, 1024];
  const n = steps.find((s) => s >= px) ?? 1024;
  if (n === size) return;
  size = n;
  canvas.style.width = canvas.style.height = n + 'px';
  stage.resize();
}

// ---------------------------------------------------------------- push-mode rendering (lowest latency)
// The host streams its camera every frame; we keep only the latest. We render the moment a new tracking
// frame arrives (not when the host next asks), capped at ?fps (default 60). When tracking is idle the host's
// camera moves still trigger renders so the impostor keeps the right angle.
interface ViewMsg { type: 'vtp-dj:view'; eye: number[]; px?: number; light?: HostLight }
let view: ViewMsg | null = null;
let busy = false, dirty = false, frameDirty = false;
let last = performance.now(), lastRender = 0, frameRecvAbs = 0;
let timer: ReturnType<typeof setTimeout> | null = null;
const maxFps = parseFloat(q.get('fps') || '90'); // above the studio's frame rate: the cap never delays a fresh frame
/** Extra head extrapolation (ms) to cover the bitmap hop + host composite; ?lead=0 turns it off. */
const leadMs = q.has('lead') ? parseFloat(q.get('lead')!) || 0 : 18;
const abs = () => performance.timeOrigin + performance.now();
const tune = normalizeProfile({ id: '_', modelFile: '' }).tracking;
const eye = new THREE.Vector3();
const cam = stage.camera;

addEventListener('message', (e: MessageEvent) => {
  const m = e.data as { type?: string };
  if (!m || typeof m.type !== 'string' || !m.type.startsWith('vtp-dj:') || !e.source) return;
  const first = !host || host.origin !== e.origin;
  host = { win: e.source, origin: e.origin };
  if (first && runtime) post(metaMsg());
  if (m.type === 'vtp-dj:view') { view = m as ViewMsg; dirty = true; schedule(); }
});
bus.on((m) => { if (m.type === 'frame' && !m.peer) { frameRecvAbs = abs(); frameDirty = true; schedule(); } });

function schedule() {
  if (busy || !view) return;
  const now = performance.now();
  // while the studio is streaming, ONLY tracking frames trigger renders (each uses the latest camera):
  // a camera-triggered render just before a frame lands would make that frame wait out the fps cap
  const tracking = now - lastFrameAt < 150;
  if (!frameDirty && tracking) return;
  const wait = 1000 / (maxFps + 1) - (now - lastRender);
  if (wait <= 0.5) { if (timer) { clearTimeout(timer); timer = null; } void render(); return; }
  if (!timer) timer = setTimeout(() => { timer = null; if (frameDirty || (dirty && performance.now() - lastFrameAt >= 150)) void render(); }, wait);
}

async function render() {
  if (busy || !view) return;
  busy = true;
  const v = view;
  dirty = frameDirty = false;
  const recv = frameRecvAbs;
  try {
    const now = performance.now();
    const dt = Math.min(0.1, (now - last) / 1000);
    last = lastRender = now;
    if (!runtime) return;
    const t0 = abs();
    setSize(v.px ?? 512);
    applyLight(v.light);
    let f = ease(dt);
    const live = now - lastFrameAt < 3000;
    // predict the head to when this image is on screen: time since the frame arrived + the hop ahead
    if (live && f.tracked && frame.headVel) {
      const a = Math.min(0.06, (now - lastFrameAt + leadMs) / 1000);
      const hv = frame.headVel, pv = frame.posVel ?? [0, 0, 0];
      f = { ...f, head: [f.head[0] + hv[0] * a, f.head[1] + hv[1] * a, f.head[2] + hv[2] * a],
        headPos: [f.headPos[0] + pv[0] * a, f.headPos[1] + pv[1] * a, f.headPos[2] + pv[2] * a] };
    }
    const tuning = runtime.profile.tracking ?? tune;
    if (live && f.bones && Object.keys(f.bones).length) runtime.update(f, null, tuning, dt, 1, f.bones);
    else runtime.update(live ? f : { ...f, tracked: false }, null, tuning, dt, 1);

    // camera at the host's eye, looking at the avatar's centre, just wide enough for its bounding sphere
    eye.fromArray(v.eye);
    const c = meta.center, R = meta.radius;
    const d = Math.max(eye.distanceTo(c), R * 1.08);
    if (eye.distanceTo(c) < 1e-3) eye.set(c.x, c.y, c.z + d);
    const half = Math.asin(Math.min(0.95, R / d));
    cam.fov = THREE.MathUtils.radToDeg(half * 2);
    cam.aspect = 1; cam.zoom = 1;
    cam.clearViewOffset();
    cam.position.copy(eye);
    cam.up.set(0, 1, 0);
    cam.lookAt(c);
    cam.near = Math.max(0.01, d - R * 1.6);
    cam.far = d + R * 3;
    cam.updateProjectionMatrix();
    stage.render();
    const t1 = abs();
    // flipY: WebGL ignores UNPACK_FLIP_Y for ImageBitmaps, so hand the host a bottom-up image
    const bitmap = await createImageBitmap(canvas, { imageOrientation: 'flipY', premultiplyAlpha: 'premultiply' });
    const t2 = abs();
    post({ type: 'vtp-dj:frame', bitmap, eye: eye.toArray(), center: c.toArray(), halfSize: d * Math.tan(half), live: live && frame.tracked,
      stamps: { recv: recv, start: t0, rendered: t1, bitmap: t2 } }, [bitmap]);
  } catch (e) {
    console.error('dj: frame failed', e);
  } finally {
    busy = false;
    if (dirty || frameDirty) schedule();
  }
}

// debugging handle (read-only use)
(window as unknown as { vtpDj: unknown }).vtpDj = { get runtime() { return runtime; }, get frame() { return frame; }, get meta() { return meta; } };
