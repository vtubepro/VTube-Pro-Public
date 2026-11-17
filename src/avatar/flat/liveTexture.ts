// A texture of a canvas that is redrawn every frame (a 2D avatar's picture: rigged 2D models draw a new pose each frame).
// three.js uploads an sRGB CanvasTexture into an SRGB8_ALPHA8 texture, which Chrome can't copy GPU-to-GPU: it reads
// the canvas back and converts it on the CPU, every frame. On the OBS page that cost 3-10 ms per frame per 2D avatar
// (1.3-4.8 MB pictures; tools/live2d_soak_e2e.mjs). Marked as a video texture, three.js uploads it as plain RGBA8 (the
// fast path) and decodes sRGB in the shader instead: its own materials through DECODE_VIDEO_TEXTURE, ours through
// needsVideoDecode (src/scene/screenFx.ts: TV screens, monitors).
import * as THREE from 'three';

export function liveCanvasTexture(canvas: HTMLCanvasElement): THREE.CanvasTexture {
  const t = new THREE.CanvasTexture(canvas) as THREE.CanvasTexture & { isVideoTexture: boolean; update: () => void };
  t.colorSpace = THREE.SRGBColorSpace;
  t.isVideoTexture = true;
  t.update = () => {};   // (three calls a video texture's update() once per frame; the owner sets needsUpdate itself)
  return t;
}
