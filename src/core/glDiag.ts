// What graphics the studio really draws with, for the diagnostics bundle (state.json → "webgl"): the WebGL renderer
// string, the GPU vendor / class from it (src/stage/gfx/gpuClass.ts), which ANGLE backend Chrome / Edge picked
// (Direct3D 11, Vulkan, OpenGL, Metal, SwiftShader = no graphics card), software rendering, and the few capabilities
// the quality presets depend on. Lets a helper tell an AMD / Intel / software-3D report from an NVIDIA one at a glance
// (docs/AMD_TEST_PLAN.md). Read-only; never throws.
import { gpuClass } from '../stage/gfx/gpuClass.ts';
import { isSoftwareRenderer } from '../stage/gfx/softwareGl.ts';

export interface GlDiag {
  renderer: string;
  vendor: string;
  gpuClass: string;
  /** ANGLE backend parsed from the renderer string ('' when the browser does not say: Firefox, Safari). */
  backend: '' | 'd3d11' | 'd3d9' | 'vulkan' | 'opengl' | 'metal' | 'swiftshader';
  software: boolean;
  webgl2: boolean;
  halfFloatTargets: boolean | null;
  maxTextureSize: number | null;
  maxSamples: number | null;
}

export function angleBackend(renderer: string): GlDiag['backend'] {
  const r = renderer.toLowerCase();
  if (/swiftshader/.test(r)) return 'swiftshader';
  if (!/angle/.test(r)) return '';
  if (/direct3d11|d3d11/.test(r)) return 'd3d11';
  if (/direct3d9|d3d9/.test(r)) return 'd3d9';
  if (/vulkan/.test(r)) return 'vulkan';
  if (/metal/.test(r)) return 'metal';
  if (/opengl|\bgl\b/.test(r)) return 'opengl';
  return '';
}

/** `gl` = the stage's own context when there is one (its real capabilities), else a throwaway probe. */
export function glDiag(gl?: WebGL2RenderingContext | WebGLRenderingContext | null): GlDiag {
  let own = true, ctx = gl ?? null;
  try { if (!ctx && typeof document !== 'undefined') { ctx = document.createElement('canvas').getContext('webgl2'); own = false; } } catch { ctx = null; }
  let renderer = '';
  try {
    if (ctx) {
      const ext = ctx.getExtension('WEBGL_debug_renderer_info');
      renderer = String((ext && ctx.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || ctx.getParameter(ctx.RENDERER) || '');
    }
  } catch { /* lost context */ }
  const cls = gpuClass(renderer);
  const num = (k: number) => { try { const v = ctx?.getParameter(k); return typeof v === 'number' ? v : null; } catch { return null; } };
  const isGl2 = !!ctx && typeof (ctx as WebGL2RenderingContext).texStorage2D === 'function';
  let half: boolean | null = null;
  try { if (ctx) half = !!(ctx.getExtension('EXT_color_buffer_float') || ctx.getExtension('EXT_color_buffer_half_float')); } catch { half = null; }
  const out: GlDiag = {
    renderer: renderer.slice(0, 200), vendor: cls.vendor, gpuClass: cls.id, backend: angleBackend(renderer), software: isSoftwareRenderer(renderer),
    webgl2: isGl2, halfFloatTargets: half, maxTextureSize: ctx ? num(ctx.MAX_TEXTURE_SIZE) : null, maxSamples: isGl2 ? num((ctx as WebGL2RenderingContext).MAX_SAMPLES) : null,
  };
  if (!own) try { ctx?.getExtension('WEBGL_lose_context')?.loseContext(); } catch { /* gone */ }
  return out;
}
