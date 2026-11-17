// Walking-TV guests (webcam / VTube Studio performers, src/scene/tv — tvguests' PERFORMER_API v2) on the interview
// monitor: their LIVE picture, with their own chroma key + backdrop (tvFeedMaterial), rendered into a small texture the
// monitor panel samples. The video itself stays the feed registry's (RAM only — never saved or exported).
import * as THREE from 'three';
import { tvFeedMaterial, tvFeedOf } from '../tv/tvApi.ts';

export class TvFeedCards {
  private cards = new Map<string, { rt: THREE.WebGLRenderTarget; scene: THREE.Scene; cam: THREE.OrthographicCamera; mat: THREE.ShaderMaterial; mesh: THREE.Mesh; aspect: number; frame: number }>();
  private frame = 0;

  /** The member's card texture (made on first use), or null when they aren't a TV / have no feed on this page. */
  texture(key: string, aspect: number): THREE.Texture | null {
    const f = tvFeedOf(key);
    if (!f) { this.drop(key); return null; }
    let c = this.cards.get(key);
    if (c && Math.abs(c.aspect - aspect) > 0.01) { this.drop(key); c = undefined; }
    if (!c) {
      const mat = tvFeedMaterial(key, { fx: 'clean', aspect });
      if (!mat) return null;
      (mat.userData as { setAspect?: (a: number) => void }).setAspect?.(aspect);
      const w = 640, h = Math.round(w / aspect);
      const rt = new THREE.WebGLRenderTarget(w, h, { type: THREE.UnsignedByteType });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      rt.texture.generateMipmaps = false;
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 2); cam.position.z = 1;
      c = { rt, scene, cam, mat, mesh, aspect, frame: -1 };
      this.cards.set(key, c);
    }
    return c.rt.texture;
  }

  /** Feed state ('live', 'stalled' …) for the panel's card text. */
  state(key: string) { return tvFeedOf(key)?.state ?? 'none'; }
  /** Their mic level 0..1 (the TV performer's own voice). */
  level(key: string) { return tvFeedOf(key)?.level ?? 0; }

  render(renderer: THREE.WebGLRenderer) {
    if (!this.cards.size) return;
    this.frame++;
    const prev = renderer.getRenderTarget();
    try {
      for (const c of this.cards.values()) {
        if (this.frame % 2) continue;
        renderer.setRenderTarget(c.rt);
        renderer.render(c.scene, c.cam);
      }
    } finally { renderer.setRenderTarget(prev); }
  }

  keep(keys: Set<string>) { for (const k of [...this.cards.keys()]) if (!keys.has(k)) this.drop(k); }

  drop(key: string) {
    const c = this.cards.get(key);
    if (!c) return;
    c.rt.dispose(); c.mat.dispose(); c.mesh.geometry.dispose();
    this.cards.delete(key);
  }

  dispose() { for (const k of [...this.cards.keys()]) this.drop(k); }
}
