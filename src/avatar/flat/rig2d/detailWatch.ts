// Sharper 2D models in close-ups (HQ decision #10): how tall a rigged 2D model's picture is ON SCREEN, measured where it
// is drawn, so its picture size and texture tier follow the shot (src/avatar/flat/rig2d/source.ts setDetail):
//   * the room card: every render pass that draws it (the main camera, a party tile, a corner cam) reports its height
//     in that pass's pixels (its world height × the pass's projection, as src/avatar/lod/AvatarDetail.ts measures 3D
//     avatars); the biggest of the last half second counts;
//   * the overlay: its box on the page × the device pixel ratio;
//   * the NEXT camera shot, before the cut: rooms announce each new shot ('vtp:camshot', src/scene/SceneRuntime.ts) and
//     its size is promoted at once, so a close-up starts sharp;
//   * Head / Bust / Full in the studio and on the classic stage move the camera directly: the next frame measures it.
// Promotion is immediate, shrinking waits (setDetail's hysteresis). Used by src/avatar/flat/FlatAvatar.ts (two lines).
import * as THREE from 'three';

interface DetailSource { setDetail?(px: number, now?: number): void }
interface CardLike { mesh: THREE.Mesh; H: number }

const v = new THREE.Vector3(), vp = new THREE.Vector4();

export class DetailWatch {
  private seen = 0;
  private window = 0;
  private lastBufH = 1080;
  private onShot = (e: Event) => this.shot((e as CustomEvent<{ pose: { position: THREE.Vector3; fov: number } }>).detail?.pose);
  private prevBefore: THREE.Mesh['onBeforeRender'] | null = null;

  constructor(private source: DetailSource, private card: CardLike | null, private overlayEl: () => HTMLElement | null) {
    if (card) {
      const prev = card.mesh.onBeforeRender;
      this.prevBefore = prev;
      card.mesh.onBeforeRender = (r, sc, cam, geo, mat, grp) => {
        prev?.call(card.mesh, r, sc, cam, geo, mat, grp);
        try { this.measure(r, cam); } catch { /* never break a render pass */ }
      };
    }
    try { addEventListener('vtp:camshot', this.onShot); } catch { /* no page */ }
  }

  /** The card's picture height in this render pass's pixels. */
  private measure(r: THREE.WebGLRenderer, cam: THREE.Camera) {
    const c = this.card!;
    r.getCurrentViewport(vp);
    // (a tiny pass — a warm-up, a thumbnail, a 1 px probe — says nothing about the shot and must not shrink the next one)
    const bufH = vp.w;
    if (!(bufH >= 64)) return;
    this.lastBufH = bufH;
    // (the picture mesh is H tall; its parents scale it: the card's fit k, the talk squash, the actor). Read from the
    // matrix as drawn, never recomputed: getWorldPosition() would rebuild matrixWorld mid-render and undo what the card
    // set for this pass (its near-camera lens correction, src/avatar/flat/card.ts)
    const worldH = c.H * Math.abs(v.setFromMatrixScale(c.mesh.matrixWorld).y || 1);
    v.setFromMatrixPosition(c.mesh.matrixWorld).applyMatrix4(cam.matrixWorldInverse);
    const P = cam.projectionMatrix.elements;
    const persp = (cam as THREE.PerspectiveCamera).isPerspectiveCamera;
    const px = persp ? (bufH / 2) * Math.abs(P[5]) * worldH / Math.max(1e-4, -v.z) : (bufH / 2) * Math.abs(P[5]) * worldH;
    if (px > this.seen) this.seen = px;
  }

  /** A room's next shot (before the cut): its size for this picture at once. */
  private shot(pose?: { position: THREE.Vector3; fov: number }) {
    if ((globalThis as { __vtpNoDetail?: boolean }).__vtpNoDetail) return;
    const c = this.card;
    if (!c || !pose?.position || !Number.isFinite(pose.fov)) return;
    const worldH = c.H * Math.abs(v.setFromMatrixScale(c.mesh.matrixWorld).y || 1);
    const d = v.setFromMatrixPosition(c.mesh.matrixWorld).distanceTo(pose.position);
    const px = (this.lastBufH / 2) / Math.tan(THREE.MathUtils.degToRad(pose.fov) / 2) * worldH / Math.max(1e-4, d);
    this.source.setDetail?.(px);
  }

  private prev = 0;
  /** Per frame (FlatAvatar.update): the biggest size of the last half second (a frame drawn bigger promotes at once;
   *  setDetail shrinks only after 2 s comfortably smaller). */
  step(dt: number) {
    if ((globalThis as { __vtpNoDetail?: boolean }).__vtpNoDetail) return;   // (tests that compare fixed-size pictures)
    this.window += dt;
    const ov = this.overlayEl();
    if (ov) { const h = parseFloat(ov.style.height); if (h > 0) this.seen = Math.max(this.seen, h * (globalThis.devicePixelRatio || 1)); }
    const px = Math.max(this.seen, this.prev);
    if (px > 0) this.source.setDetail?.(px);
    if (this.window >= 0.5) { this.prev = this.seen; this.seen = 0; this.window = 0; }
  }

  dispose() {
    try { removeEventListener('vtp:camshot', this.onShot); } catch { /* no page */ }
    if (this.card && this.prevBefore !== null) this.card.mesh.onBeforeRender = this.prevBefore;
  }
}
