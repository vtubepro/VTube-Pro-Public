// Shared GPU uniforms of the capture cover (src/scene/capcover/cover.ts): the React screens' ScreenFx materials and the
// stage layouts' FrameFx read the SAME uniform objects, so one texture upload per frame reaches every surface.
// (Its own tiny module so screenFx.ts / frameFx.ts never import the Canvas2D styles.)
import type * as THREE from 'three';

export const coverUniforms: { uCover: THREE.IUniform<THREE.Texture | null>; uCoverOn: THREE.IUniform<number> } = {
  uCover: { value: null },
  /** 1 while the cover is drawn (in / hold / out), 0 = off (the surfaces ignore uCover). */
  uCoverOn: { value: 0 },
};
