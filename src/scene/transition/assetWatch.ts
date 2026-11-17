// "Is anything still loading?" for the room-change transition (src/scene/transition/curtain.ts).
//
// Every room engine loads through three.js loaders on THREE.DefaultLoadingManager (GLTFLoader, TextureLoader, the
// HDRI loaders …) or plain fetch() (NPC clip JSON, a room's traffic meta). Both are counted here, globally, so a new
// engine is covered without registering anything. Long-lived / unrelated requests (the fast window feed, OBS hole
// reports, chat, POSTs) are not counted: only GETs of asset-looking URLs.
import * as THREE from 'three';

let installed = false;
let loaders = 0;
let fetches = 0;
let changedAt = 0;
let started = 0;
let finished = 0;

const ASSET = /\.(glb|gltf|bin|json|png|jpe?g|webp|ktx2|hdr|exr|basis|wasm)(\?|#|$)|\/api\/scenes\/|\/library\/|\/assets\//i;
const SKIP = /\/api\/(obs|chat|screen|feed|command|output|party|diag)/i;

function bump() { changedAt = performance.now(); }

export function installAssetWatch() {
  if (installed) return;
  installed = true;
  const m = THREE.DefaultLoadingManager;
  const start = m.itemStart.bind(m), end = m.itemEnd.bind(m), err = m.itemError.bind(m);
  m.itemStart = (url: string) => { loaders++; started++; bump(); start(url); };
  m.itemEnd = (url: string) => { loaders = Math.max(0, loaders - 1); finished++; bump(); end(url); };
  // (three calls itemError AND itemEnd for a failed item: count the end only)
  m.itemError = (url: string) => { bump(); err(url); };
  const f = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    const track = (method === 'GET' || method === 'HEAD') && ASSET.test(url) && !SKIP.test(url);
    if (!track) return f(input, init);
    fetches++; started++; bump();
    // the body is usually read right after (json() / arrayBuffer()): count until the response settles + a beat
    return f(input, init).finally(() => { setTimeout(() => { fetches = Math.max(0, fetches - 1); finished++; bump(); }, 60); });
  };
}

/** Loads in flight right now. */
export const assetsPending = () => loaders + fetches;
/** ms since the last load started / ended. */
export const assetsQuietFor = () => performance.now() - changedAt;
/** The room model's own download (SceneRuntime.load), PER REQUEST: only the newest request counts - an older download
 *  still reading can neither paint the cover's "N of M MB" nor keep its quiet timer alive. The cover can abort it
 *  (a load that stalled): the request's fetch carries the signal. */
let roomReq = { id: 0, loaded: 0, total: 0, at: 0, ctl: null as AbortController | null };
/** A new room download starts: its id + the signal its fetch must carry (an older one is aborted: superseded). */
export function beginRoomLoad(now = performance.now()): { id: number; signal: AbortSignal } {
  roomReq.ctl?.abort();
  const ctl = new AbortController();
  roomReq = { id: roomReq.id + 1, loaded: 0, total: 0, at: now, ctl };
  bump();
  return { id: roomReq.id, signal: ctl.signal };
}
/** Bytes of request `id` (ignored unless it is the newest). total 0 = unknown: a known total is kept. */
export function noteRoomBytes(id: number, loaded: number, total: number, now = performance.now()) {
  if (id !== roomReq.id) return;
  roomReq.loaded = loaded; if (total > 0) roomReq.total = total; roomReq.at = now;
  bump();
}
/** The newest room download: bytes so far / total (0 = unknown) and ms since its last byte (or its start). */
export function roomProgress(now = performance.now()) { return { id: roomReq.id, loaded: roomReq.loaded, total: roomReq.total, quietMs: now - roomReq.at }; }
/** Give up on the newest room download (the cover's stall rule): its fetch rejects, the page reports the failure. */
export function abortRoomLoad() { roomReq.ctl?.abort(); }
/** The newest download finished (or failed): nothing left to abort. */
export function endRoomLoad(id: number) { if (id === roomReq.id) roomReq.ctl = null; }
/** Totals since the page opened (progress estimate: finished / started over a window). */
export const assetCounts = () => ({ started, finished });
