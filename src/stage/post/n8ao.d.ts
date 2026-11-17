// Minimal typings for n8ao 2.x (N8python/n8ao, CC0 — the package ships none). Only what Pipeline.ts uses.
declare module 'n8ao' {
  import type * as THREE from 'three';
  export interface N8AOConfiguration {
    aoSamples: number; aoRadius: number; denoiseSamples: number; denoiseRadius: number; distanceFalloff: number;
    intensity: number; denoiseIterations: number; renderMode: 0 | 1 | 2 | 3 | 4; color: THREE.Color; gammaCorrection: boolean;
    screenSpaceRadius: boolean; halfRes: boolean; depthAwareUpsampling: boolean; colorMultiply: boolean;
    transparencyAware: boolean; accumulate: boolean; neuralDenoise: boolean;
  }
  export class N8AOPostPass {
    constructor(scene: THREE.Scene, camera: THREE.Camera, width?: number, height?: number);
    configuration: N8AOConfiguration;
    /** true (n8ao's default): render() traverses the scene every frame and turns `transparencyAware` ON as soon as any
     *  material is transparent (2 extra whole-scene renders per frame from then on). Writing `transparencyAware` only
     *  clears this flag when the value CHANGES, so a page that wants the passes off clears it itself (Pipeline.ts). */
    autoDetectTransparency: boolean;
    /** The AO compositing pass. Its `transparencyAware` uniform is set true on every frame the passes run and never
     *  reset by n8ao (only a rebuilt material starts at false) — Pipeline.ts resets it together with the flags. */
    effectCompositerQuad?: { material: THREE.ShaderMaterial };
    camera: THREE.Camera;
    scene: THREE.Scene;
    renderToScreen: boolean;
    outputTargetInternal: THREE.WebGLRenderTarget;
    setDepthTexture(t: THREE.Texture): void;
    setSize(w: number, h: number): void;
    render(renderer: THREE.WebGLRenderer, inputBuffer: THREE.WebGLRenderTarget, outputBuffer: THREE.WebGLRenderTarget | null): void;
    dispose(): void;
  }
}
