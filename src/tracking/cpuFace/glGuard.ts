// Proof (and guarantee) that the processor-only face worker never touches the graphics card from script: every way a
// worker can reach the GPU (an OffscreenCanvas 'webgl' / 'webgl2' / 'webgpu' context, a WebGL call on any context,
// navigator.gpu) is counted, and a GPU context request is refused (getContext returns null), so a future change that
// tries to sneak one in fails loudly in tests (tools/cpuface_bench.mjs asserts all counts are 0) instead of quietly
// waiting behind a game. 2D canvases (the old-Firefox ImageBitmap fallback, software there) are allowed and counted.

export interface GlGuardStats { contexts: number; refused: string[]; calls: number; gpu: number; canvas2d: number }

export const glStats: GlGuardStats = { contexts: 0, refused: [], calls: 0, gpu: 0, canvas2d: 0 };
let installed = false;

export function installGlGuard(scope: typeof globalThis = globalThis) {
  if (installed) return;
  installed = true;
  const g = scope as unknown as Record<string, { prototype: Record<string, unknown> } | undefined> & { navigator?: { gpu?: Record<string, unknown> } };
  const OC = g.OffscreenCanvas;
  if (OC) {
    const get = OC.prototype.getContext as (this: unknown, t: string, ...r: unknown[]) => unknown;
    OC.prototype.getContext = function (this: unknown, type: string, ...rest: unknown[]) {
      const t = String(type).toLowerCase();
      if (t === '2d') { glStats.canvas2d++; return get.call(this, type, ...rest); }
      glStats.contexts++;
      if (glStats.refused.length < 8) glStats.refused.push(t);
      return null;
    };
  }
  for (const name of ['WebGLRenderingContext', 'WebGL2RenderingContext']) {
    const C = g[name];
    if (!C) continue;
    for (const k of Object.getOwnPropertyNames(C.prototype)) {
      const d = Object.getOwnPropertyDescriptor(C.prototype, k);
      if (!d || typeof d.value !== 'function' || k === 'constructor') continue;
      const f = d.value as (...a: unknown[]) => unknown;
      try { Object.defineProperty(C.prototype, k, { ...d, value: function (this: unknown, ...a: unknown[]) { glStats.calls++; return f.apply(this, a); } }); } catch { /* frozen */ }
    }
  }
  const gpu = g.navigator?.gpu;
  if (gpu && typeof gpu.requestAdapter === 'function') {
    const ra = gpu.requestAdapter as (...a: unknown[]) => unknown;
    try { gpu.requestAdapter = (...a: unknown[]) => { glStats.gpu++; void ra; return Promise.resolve(null); }; } catch { /* read-only */ }
  }
}

export const glClean = () => glStats.contexts === 0 && glStats.calls === 0 && glStats.gpu === 0;
