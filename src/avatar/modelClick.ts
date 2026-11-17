// The host clicks or taps the avatar in the studio preview -> bus command `model-clicked` (shared/b16Commands.ts), which the helper turns into
// VTube Studio's ModelClickedEvent for subscribed plugins. Studio only, one small message per click, nothing runs between clicks.
// The helper says (bus command `model-click-subscribed`) whether any plugin listens to ModelClickedEvent; while none does a click is not even
// raycast (a skinned, morph-heavy avatar makes that a visible stall) and nothing is sent. Until the helper has said so, the answer is "nobody".
// A drag (orbiting the camera) or a long press is not a click. Coordinates are VTS ones: -1..1 of the frame, +y up.
import * as THREE from 'three';
import { MODEL_CLICKED_COMMAND, commandMessage, type ModelClicked } from '../../shared/b16Commands.ts';
import type { BusMessage } from '../../shared/types.ts';

/** Bus commands (the same strings as server/tracking/vtsApi.ts; tools/model_click_unit.ts checks they match). */
export const MODEL_CLICK_SUBSCRIBED = 'model-click-subscribed';
export const MODEL_CLICK_ASK = 'model-click-ask';
const NAME = /^[\w .:\-/()]{1,64}$/;
const MAX_PARTS = 16;
export const CLICK_MOVE_PX = 6;
export const CLICK_MAX_MS = 400;

/** Pointer position -> VTS frame units (-1..1, +y up). */
export function vtsPoint(rect: { left: number; top: number; width: number; height: number }, cx: number, cy: number): { x: number; y: number } {
  const w = rect.width || 1, h = rect.height || 1;
  const f = (v: number) => Math.round(Math.max(-3, Math.min(3, v)) * 1000) / 1000;
  return { x: f(((cx - rect.left) / w) * 2 - 1), y: f(1 - ((cy - rect.top) / h) * 2) };
}
/** Browser button (0 left, 1 middle, 2 right) -> VTS mouseButtonID (0 left, 1 right, 2 middle). */
export const vtsButton = (b: number): number => (b === 2 ? 1 : b === 1 ? 2 : 0);

let subscribed = false;
/** Does any VTS plugin listen to ModelClickedEvent right now (as far as the helper said)? */
export const modelClickSubscribed = (): boolean => subscribed;
export function setModelClickSubscribed(on: boolean) { subscribed = !!on; }

/**
 * Keep the subscriber flag current from the bus: the helper announces every change, and the studio asks once now and again whenever
 * the bus reconnects (the helper only answers while its plugin server runs; no answer = nobody listens). Returns the undo.
 */
export function watchModelClickSubscribers(bus: { on(f: (m: BusMessage) => void): () => void; onLink?(f: (up: boolean) => void): () => void; send(m: BusMessage): void }): () => void {
  const ask = () => bus.send(commandMessage(MODEL_CLICK_ASK, {}));
  const offMsg = bus.on((m) => {
    if (m.type !== 'command' || m.command !== MODEL_CLICK_SUBSCRIBED) return;
    const a = m.args as { on?: unknown } | null;
    subscribed = !!a && a.on === true;
  });
  const offLink = bus.onLink?.((up) => { if (up) ask(); else subscribed = false; });
  ask();
  return () => { offMsg(); offLink?.(); subscribed = false; };
}

// The avatar's meshes, remembered for a moment: a costume change adds or hides meshes, so the list is rebuilt every few seconds.
const MESH_TTL_MS = 3000;
const meshCache = new WeakMap<THREE.Object3D, { at: number; meshes: THREE.Mesh[] }>();
function meshesOf(root: THREE.Object3D): THREE.Mesh[] {
  const now = performance.now(), c = meshCache.get(root);
  const all = c && now - c.at < MESH_TTL_MS ? c.meshes : (() => {
    const list: THREE.Mesh[] = [];
    root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !m.userData.vtpItem && !o.name.startsWith('Normalized_')) list.push(m); });
    meshCache.set(root, { at: now, meshes: list });
    return list;
  })();
  const shown = (o: THREE.Object3D | null): boolean => { for (let p = o; p && p !== root.parent; p = p.parent) if (!p.visible) return false; return true; };
  return all.filter((m) => shown(m));
}

/** Which parts of the avatar are under the pointer (front-most first), by the names `art-list` offers (mesh name, then material name). */
export function partsUnder(camera: THREE.Camera, root: THREE.Object3D, ndcX: number, ndcY: number): { hit: boolean; parts: string[] } {
  const meshes = meshesOf(root);
  if (!meshes.length) return { hit: false, parts: [] };
  camera.updateMatrixWorld();
  const rc = new THREE.Raycaster();
  rc.setFromCamera(new THREE.Vector2(ndcX, ndcY), camera);
  const hits = rc.intersectObjects(meshes, false);
  const parts: string[] = [];
  const add = (n: string | undefined) => { if (n && NAME.test(n) && !parts.includes(n) && parts.length < MAX_PARTS) parts.push(n); };
  for (const h of hits) {
    const m = h.object as THREE.Mesh;
    add(m.name);
    const mats = [m.material].flat();
    add((mats.length > 1 ? mats[h.face?.materialIndex ?? 0] : mats[0])?.name);
  }
  return { hit: hits.length > 0, parts };
}

export interface ModelClickHost {
  canvas: HTMLElement;
  camera: () => THREE.Camera;
  /** The avatar's root object (null = none loaded). */
  root: () => THREE.Object3D | null;
  send: (m: BusMessage) => void;
  /** Does any plugin listen? Default: the flag the helper keeps current (watchModelClickSubscribers). */
  subscribed?: () => boolean;
}

/** Listen for clicks on the preview canvas. Returns the undo. */
export function installModelClick(h: ModelClickHost): () => void {
  let down: { x: number; y: number; t: number; b: number } | null = null;
  const onDown = (e: PointerEvent) => { down = { x: e.clientX, y: e.clientY, t: performance.now(), b: e.button }; };
  const onUp = (e: PointerEvent) => {
    const d = down; down = null;
    if (!d || d.b !== e.button) return;
    if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > CLICK_MOVE_PX || performance.now() - d.t > CLICK_MAX_MS) return;
    if (!(h.subscribed ?? modelClickSubscribed)()) return;   // nobody listens: no raycast, no message
    const p = vtsPoint(h.canvas.getBoundingClientRect(), e.clientX, e.clientY);
    const root = h.root();
    const u = root ? partsUnder(h.camera(), root, p.x, p.y) : { hit: false, parts: [] as string[] };
    const msg: ModelClicked = { x: p.x, y: p.y, button: vtsButton(e.button), hit: u.hit, ...(u.parts.length ? { parts: u.parts } : {}) };
    h.send(commandMessage(MODEL_CLICKED_COMMAND, msg));
  };
  h.canvas.addEventListener('pointerdown', onDown);
  h.canvas.addEventListener('pointerup', onUp);
  return () => { h.canvas.removeEventListener('pointerdown', onDown); h.canvas.removeEventListener('pointerup', onUp); down = null; };
}
