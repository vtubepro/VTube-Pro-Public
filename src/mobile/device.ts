// Is this a phone (or a small touch tablet)? One answer for the whole studio: the phone tracking profile, the phone
// layout / wording (html.vtp-phone), Pro2D show mode, and the device facts the 2D texture hook gets
// (src/avatar/flat/rig2d/textureTier.ts). Safe to import anywhere (OBS pages, Node tests): nothing runs at import that
// needs a page. Test switch: ?phone=1 / ?phone=0 (kept for the tab in sessionStorage 'vtp.phone').
import type { TextureDevice } from '../avatar/flat/rig2d/textureTier.ts';
import { softGlKnown } from '../stage/gfx/softwareGl.ts';

const ss = (() => { try { return window.sessionStorage; } catch { return undefined; } })();
const ls = (() => { try { return window.localStorage; } catch { return undefined; } })();
try { const q = new URLSearchParams(location.search).get('phone'); if (q === '1' || q === '0') ss?.setItem('vtp.phone', q); } catch { /* no page / storage */ }

/** Pure rule (tools/mobile2d_unit.ts): a phone / small touch tablet from the user agent and the screen. */
export function phoneFrom(o: { ua: string; coarse: boolean; touch: number; short: number }): boolean {
  if (/iPhone|iPod|Android.+Mobile|Mobile.+Firefox|Windows Phone/i.test(o.ua)) return true;
  // iPads say "Macintosh": touch points give them away; small touch screens count too
  if (/Macintosh/i.test(o.ua) && o.touch > 1) return o.short <= 900;
  return o.coarse && o.touch > 0 && o.short <= 600;
}
let phone: boolean | null = null;
export function isPhone(): boolean {
  if (phone !== null) return phone;
  const forced = ss?.getItem('vtp.phone');
  if (forced === '1' || forced === '0') return (phone = forced === '1');
  try {
    phone = phoneFrom({ ua: navigator.userAgent, coarse: matchMedia('(pointer: coarse)').matches, touch: navigator.maxTouchPoints || 0, short: Math.min(screen.width, screen.height) });
  } catch { phone = false; }
  return phone;
}
export const isIos = () => { try { return /iPhone|iPad|iPod/i.test(navigator.userAgent) || (/Macintosh/i.test(navigator.userAgent) && (navigator.maxTouchPoints || 0) > 1); } catch { return false; } };

/** A file input's accept list that never greys files out on a phone: iOS / Android turn unknown extensions (.moc3,
 *  .vtp2, .psd …) into "can't pick"; application/octet-stream lets every file through. Desktop keeps its filter. */
export const pickAccept = (list: string) => (isPhone() ? `${list},application/octet-stream` : list);

// ---------------------------------------------------------------- low detail (after a graphics-memory crash)
const LOW = 'vtp.lowDetail';
/** On after "Reload in low detail" (src/mobile/lowDetail.ts): the light graphics level, and the 2D texture hook is told. */
export const lowDetail = () => ls?.getItem(LOW) === '1';
export function setLowDetail(on: boolean) { try { if (on) ls?.setItem(LOW, '1'); else ls?.removeItem(LOW); } catch { /* storage off */ } }

let gpu: { maxTexture: number; compressed: TextureDevice['compressed'] } | null = null;
/** The graphics chip: MAX_TEXTURE_SIZE (4096 when it can't be asked) and the compressed formats WebGL 2 takes. Asked
 *  once, on a throwaway context. */
export function gpuCaps(): { maxTexture: number; compressed: TextureDevice['compressed'] } {
  if (gpu) return gpu;
  gpu = { maxTexture: 4096, compressed: { astc: false, bc7: false, etc2: false } };
  try {
    const c = document.createElement('canvas');
    const gl = c.getContext('webgl2');
    if (gl) {
      gpu = { maxTexture: Number(gl.getParameter(gl.MAX_TEXTURE_SIZE)) || 4096,
        compressed: { astc: !!gl.getExtension('WEBGL_compressed_texture_astc'), bc7: !!gl.getExtension('EXT_texture_compression_bptc'), etc2: !!gl.getExtension('WEBGL_compressed_texture_etc') } };
      (gl.getExtension('WEBGL_lose_context') as { loseContext(): void } | null)?.loseContext();
    }
  } catch { /* keep the safe defaults */ }
  return gpu;
}
export const gpuMaxTexture = () => gpuCaps().maxTexture;

/** What the 2D texture hook gets (src/avatar/flat/rig2d/textureTier.ts): `outputPx` = the picture's height on this page. */
export function textureDevice(outputPx: number): TextureDevice {
  const mem = (() => { try { return (navigator as Navigator & { deviceMemory?: number }).deviceMemory; } catch { return undefined; } })();
  const caps = gpuCaps();
  return { maxTexture: caps.maxTexture, compressed: caps.compressed, software: !!softGlKnown()?.active, outputPx: Math.round(outputPx) || 1024,
    deviceClass: isPhone() ? 'phone' : 'desktop', lowDetail: lowDetail(), ...(typeof mem === 'number' ? { memoryGB: mem } : {}) };
}
