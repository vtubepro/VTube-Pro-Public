// The OBS page without WebGL 2 (OBS on its OpenGL renderer, browser hardware acceleration off, …) used to go blank and
// transparent: nothing on stream and nothing that said why. Imported FIRST by src/output.ts: it probes WebGL 2 before
// anything else runs; without it the page shows a plain card with the fix (shared/obsGlHelp.ts) and tells the helper
// (bus hello with gl:false → GET /api/obs/outputs noGl → the studio's "Fix it" OBS row says what to change in OBS).
import { Bus } from './bus.ts';
import { outputHelloFields } from '../shared/obsPages.ts';
import { OBS_GL_TITLE, obsGlSteps } from '../shared/obsGlHelp.ts';

function hasWebGl2(): boolean {
  try {
    const gl = document.createElement('canvas').getContext('webgl2');
    if (!gl) return false;
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return true;
  } catch { return false; }
}

export const outputHasGl = hasWebGl2();
let shown = false;

/** Show the card + tell the helper (once). Also used when the page's renderer can't start or its context is lost for
 *  good (some drivers hand out one context and then block the page). */
export function showNoGl() {
  if (shown) return;
  shown = true;
  const q = new URLSearchParams(location.search);
  const inObs = !!(window as unknown as { obsstudio?: unknown }).obsstudio;
  const card = document.createElement('div');
  card.id = 'vtp-no-gl';
  card.setAttribute('role', 'alert');
  card.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;z-index:2147483647;font:600 2.2vw/1.35 system-ui,Segoe UI,sans-serif;color:#fff';
  const box = document.createElement('div');
  box.style.cssText = 'background:#1b1f2a;border:0.35vw solid #f5c451;border-radius:1.4vw;padding:2.6vw 3.2vw;max-width:70vw;box-shadow:0 1vw 4vw rgba(0,0,0,.5)';
  const h = document.createElement('div'); h.textContent = OBS_GL_TITLE; h.style.cssText = 'font-size:3.4vw;margin-bottom:1vw;color:#f5c451';
  const why = document.createElement('div'); why.style.cssText = 'font-weight:500;margin-bottom:1.2vw';
  why.textContent = inObs ? 'OBS’s browser has no 3D graphics, so your avatar can’t be drawn.' : 'This browser has no 3D graphics (WebGL 2), so your avatar can’t be drawn.';
  const ol = document.createElement('ol'); ol.style.cssText = 'margin:0;padding-left:2.6vw;font-weight:500';
  for (const s of inObs ? obsGlSteps(navigator.userAgent) : ['Turn on hardware acceleration (graphics acceleration) in this browser’s settings, then reload.']) { const li = document.createElement('li'); li.textContent = s; ol.append(li); }
  box.append(h, why, ol); card.append(box);
  const show = () => document.body.append(card);
  if (document.body) show(); else addEventListener('DOMContentLoaded', show);
  // tell the helper (the studio's Fix it reads it); kept open so the page stays listed
  new Bus('output', () => ({ ...outputHelloFields(q, window as unknown as Parameters<typeof outputHelloFields>[1]), gl: false }));
}

/** The page's WebGL canvas: a context lost and not back within 3 s means this browser can't draw (show the card). */
export function watchGl(canvas: HTMLCanvasElement) {
  let t = 0;
  canvas.addEventListener('webglcontextlost', () => { clearTimeout(t); t = window.setTimeout(showNoGl, 3000); });
  canvas.addEventListener('webglcontextrestored', () => clearTimeout(t));
}

if (!outputHasGl) showNoGl();
