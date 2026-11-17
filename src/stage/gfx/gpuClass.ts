// GPU class from the WebGL renderer string (vendor-neutral: NVIDIA, AMD, Intel, Apple). Used only as a FALLBACK for
// the quality benchmark (src/stage/gfx/bench.ts) when the browser has no GPU timer query, and for the "what to expect"
// text. `speed` = rough raster throughput relative to an RTX 5090 (= 1), from public 3DMark Time Spy graphics scores
// (docs/PERFORMANCE.md §5 lists the figures). Deliberately coarse: a class, never a promise.
import type { GfxLevel } from '../../../shared/graphics.ts';

export interface GpuClass { id: string; label: string; speed: number; pick: GfxLevel; vendor: 'nvidia' | 'amd' | 'intel' | 'apple' | 'other'; integrated: boolean }

const C = (id: string, label: string, speed: number, pick: GfxLevel): Omit<GpuClass, 'vendor' | 'integrated'> => ({ id, label, speed, pick });

/** First match wins (most specific first). */
const TABLE: [RegExp, Omit<GpuClass, 'vendor' | 'integrated'>][] = [
  [/rtx\s*50[89]0|rtx\s*4090|rx\s*9070\s*xt|rx\s*7900\s*xtx/, C('enthusiast', 'RTX 4090 / 5080+ class', 0.75, 'high')],
  [/rtx\s*(40[78]0|50[67]0)|rtx\s*3090|rx\s*(7900|9070|7800)/, C('upper', 'RTX 4070 / 3090 / RX 7800 class', 0.45, 'high')],
  [/rtx\s*(3080|3070|4060\s*ti|2080\s*ti)|rx\s*(6800|6900|6950|7700)|arc\s*b580/, C('upper-mid', 'RTX 3070 / RX 6800 class', 0.3, 'high')],
  [/rtx\s*(3060\s*ti|4060|2080|2070|5050)|rx\s*(6700|6750|7600|6650)|arc\s*a7[57]0/, C('mid', 'RTX 3060 Ti / RX 6700 class', 0.22, 'balanced')],
  [/rtx\s*(3060|2060|3050)|gtx\s*1080|gtx\s*1660|rx\s*(6600|5700|5600|6500)|arc\s*a[35][0-9]0/, C('mainstream', 'GTX 1080 / RTX 3060 / RX 6600 class', 0.16, 'balanced')],
  [/gtx\s*(1070|1060|980|970|1650)|rx\s*(580|590|570|480|5500|vega)|radeon\s*vii/, C('entry', 'GTX 1060 / RX 580 class', 0.09, 'performance')],
  [/intel.*(iris|uhd|hd graphics)|radeon\(tm\)\s*graphics|radeon\s*graphics|vega\s*\d+\s*graphics|mali|adreno|swiftshader|llvmpipe|microsoft basic/, C('integrated', 'integrated / software GPU', 0.03, 'performance')],
  [/apple m\d (max|ultra)/, C('upper-mid', 'Apple M-series Max / Ultra', 0.25, 'high')],
  [/apple m\d/, C('entry', 'Apple M-series', 0.09, 'performance')],
];

export function gpuClass(renderer: string): GpuClass {
  const g = renderer.toLowerCase().replace(/\((tm|r)\)/g, '');
  const vendor: GpuClass['vendor'] = /nvidia|geforce|rtx|gtx/.test(g) ? 'nvidia' : /amd|radeon|\brx\s?\d/.test(g) ? 'amd' : /intel|arc/.test(g) ? 'intel' : /apple/.test(g) ? 'apple' : 'other';
  for (const [re, c] of TABLE) if (re.test(g)) return { ...c, vendor, integrated: c.id === 'integrated' };
  // unknown discrete card: assume mainstream (Medium) — the benchmark / Auto-lower correct it
  return { ...C('unknown', 'unknown GPU', 0.16, 'balanced'), vendor, integrated: false };
}

/** The page's WebGL renderer string (unmasked when the browser allows it). */
export function rendererString(gl: WebGLRenderingContext | WebGL2RenderingContext): string {
  try {
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    return String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || '');
  } catch { return ''; }
}

/** Can this context render the High / Ultra HDR post chain (half-float colour targets)? WebGL2 core only guarantees
 *  RGBA8; RGBA16F needs EXT_color_buffer_float (or _half_float). Every desktop NVIDIA / AMD / Intel driver has it, but
 *  if one does not, High / Ultra fall back to Medium instead of rendering black. */
export function canRenderHalfFloat(gl: WebGLRenderingContext | WebGL2RenderingContext): boolean {
  try { return !!(gl.getExtension('EXT_color_buffer_float') || gl.getExtension('EXT_color_buffer_half_float')); } catch { return false; }
}
