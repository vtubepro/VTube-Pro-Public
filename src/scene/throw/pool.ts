// ONE draw call for everything that flies at the head (beta.16, docs/b16/THROW.md): thrown items, impact stars, the headpat
// hand and its hearts are instances of a single camera-facing quad. Their pictures live in a small shared atlas (8 x 8 cells of
// 128 px): a picture is drawn into a cell the first time it is used and kept while it is in use or recently used.
//
// Budget: at most THROW_LIMITS.maxInFlight items + their stars on screen; nothing is created per frame (the instance
// buffers are allocated once, at the first throw); with nothing to draw the mesh is hidden and the page does nothing.
// `dispose()` frees the atlas and the buffers (the mount calls it after the feature has been idle for a while).
//
// Only pictures from shared/throwables.ts imgSrc() are ever drawn: platform emotes through the helper's allow-listed picture
// proxy, starter props that ship with the app, the host's own files. A picture that fails to load stays a plain round blob.
import * as THREE from 'three';
import { markShared } from '../../avatar/gpuDispose.ts';

const GRID = 8;
const CELL = 128;
export const POOL_CAPACITY = 96;
/** Cell 0 is the impact star (the starter prop `star`). */
const STAR_CELL = 0;

const VERT = /* glsl */ `
attribute vec3 iPos;
attribute vec2 iSize;
attribute vec3 iMisc;       // rotation (rad), alpha, cell index
varying vec2 vUv;
varying float vAlpha;
uniform float uGrid;
uniform float uScale;       // the avatar space's world scale: sizes are in avatar-space units like the positions
void main() {
  float c = iMisc.z;
  vec2 cell = vec2(mod(c, uGrid), floor(c / uGrid));
  vec2 q = position.xy + 0.5;
  vUv = vec2((cell.x + q.x) / uGrid, (uGrid - 1.0 - cell.y + q.y) / uGrid);
  vAlpha = iMisc.y;
  vec4 mv = modelViewMatrix * vec4(iPos, 1.0);
  float cr = cos(iMisc.x), sr = sin(iMisc.x);
  vec2 p = position.xy * iSize;
  mv.xy += vec2(p.x * cr - p.y * sr, p.x * sr + p.y * cr) * uScale;
  gl_Position = projectionMatrix * mv;
}`;
const FRAG = /* glsl */ `
uniform sampler2D uMap;
varying vec2 vUv;
varying float vAlpha;
void main() {
  vec4 t = texture2D(uMap, vUv);
  gl_FragColor = vec4(t.rgb, t.a * vAlpha);
  if (gl_FragColor.a < 0.01) discard;
  #include <colorspace_fragment>
}`;

interface Cell { key: string; used: number; ready: boolean }

export class ThrowPool {
  readonly mesh: THREE.Mesh;
  private geo: THREE.InstancedBufferGeometry;
  private mat: THREE.ShaderMaterial;
  private pos: Float32Array; private size: Float32Array; private misc: Float32Array;
  private aPos: THREE.InstancedBufferAttribute; private aSize: THREE.InstancedBufferAttribute; private aMisc: THREE.InstancedBufferAttribute;
  private canvas: HTMLCanvasElement | null; private ctx: CanvasRenderingContext2D | null;
  private tex: THREE.CanvasTexture;
  private cells: (Cell | null)[] = new Array(GRID * GRID).fill(null);
  private byKey = new Map<string, number>();
  private n = 0;
  private dirty = false;
  private disposed = false;

  /** `loadImage(src)` is how a picture gets loaded (a test can pass a stub). */
  constructor(private readonly loadImage: (src: string) => Promise<CanvasImageSource | null> = defaultLoad) {
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.canvas.height = GRID * CELL;
    this.ctx = this.canvas.getContext('2d');
    this.tex = markShared(new THREE.CanvasTexture(this.canvas));
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.tex.generateMipmaps = false; this.tex.minFilter = THREE.LinearFilter; this.tex.magFilter = THREE.LinearFilter;
    const base = new THREE.PlaneGeometry(1, 1);
    this.geo = new THREE.InstancedBufferGeometry();
    this.geo.index = base.index; this.geo.setAttribute('position', base.getAttribute('position')); this.geo.setAttribute('uv', base.getAttribute('uv'));
    this.pos = new Float32Array(POOL_CAPACITY * 3); this.size = new Float32Array(POOL_CAPACITY * 2); this.misc = new Float32Array(POOL_CAPACITY * 3);
    this.aPos = new THREE.InstancedBufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage);
    this.aSize = new THREE.InstancedBufferAttribute(this.size, 2).setUsage(THREE.DynamicDrawUsage);
    this.aMisc = new THREE.InstancedBufferAttribute(this.misc, 3).setUsage(THREE.DynamicDrawUsage);
    this.geo.setAttribute('iPos', this.aPos); this.geo.setAttribute('iSize', this.aSize); this.geo.setAttribute('iMisc', this.aMisc);
    this.geo.instanceCount = 0;
    this.mat = new THREE.ShaderMaterial({
      vertexShader: VERT, fragmentShader: FRAG, transparent: true, depthTest: false, depthWrite: false,
      uniforms: { uMap: { value: this.tex }, uGrid: { value: GRID }, uScale: { value: 1 } },
    });
    this.mesh = new THREE.Mesh(this.geo, this.mat);
    this.mesh.name = 'vtp_throw';
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 22;
    this.mesh.visible = false;
  }

  /** The avatar space's world scale (rooms scale avatars). */
  setScale(s: number) { this.mat.uniforms.uScale.value = s; }

  // ---------------------------------------------------------------- pictures

  /**
   * The atlas cell for a picture. A placeholder blob is drawn at once; the real picture replaces it when it has loaded.
   * Returns -1 when every cell is in use right now (the item is skipped, never queued).
   */
  cellFor(key: string, src: string, now: number): number {
    const have = this.byKey.get(key);
    if (have !== undefined) { this.cells[have]!.used = now; return have; }
    let at = -1, oldest = Infinity;
    for (let c = 1; c < this.cells.length; c++) {            // (cell 0 is the star)
      const e = this.cells[c];
      if (!e) { at = c; break; }
      if (e.used < oldest && now - e.used > 4000) { oldest = e.used; at = c; }
    }
    if (at < 0) return -1;
    const old = this.cells[at];
    if (old) this.byKey.delete(old.key);
    this.cells[at] = { key, used: now, ready: false };
    this.byKey.set(key, at);
    this.blob(at);
    void this.loadInto(at, key, src);
    return at;
  }
  /** The star's cell (loaded by `loadStar`). */
  readonly starCell = STAR_CELL;
  loadStar(src: string) {
    if (this.cells[STAR_CELL]) return;
    this.cells[STAR_CELL] = { key: 'star', used: Infinity, ready: false };
    this.drawStarBlob();
    void this.loadInto(STAR_CELL, 'star', src);
  }

  private async loadInto(cell: number, key: string, src: string) {
    let img: CanvasImageSource | null = null;
    try { img = await this.loadImage(src); } catch { img = null; }
    if (this.disposed || !this.ctx || this.cells[cell]?.key !== key) return;       // the cell was given to another picture meanwhile
    if (!img) return;
    const x = (cell % GRID) * CELL, y = Math.floor(cell / GRID) * CELL;
    const iw = (img as HTMLImageElement).naturalWidth || (img as ImageBitmap).width || CELL, ih = (img as HTMLImageElement).naturalHeight || (img as ImageBitmap).height || CELL;
    const k = Math.min((CELL - 8) / iw, (CELL - 8) / ih);
    this.ctx.clearRect(x, y, CELL, CELL);
    this.ctx.drawImage(img, x + (CELL - iw * k) / 2, y + (CELL - ih * k) / 2, iw * k, ih * k);
    this.cells[cell]!.ready = true;
    this.tex.needsUpdate = true;
  }
  private blob(cell: number) {
    if (!this.ctx) return;
    const x = (cell % GRID) * CELL + CELL / 2, y = Math.floor(cell / GRID) * CELL + CELL / 2;
    this.ctx.clearRect(x - CELL / 2, y - CELL / 2, CELL, CELL);
    this.ctx.fillStyle = 'rgba(235,225,205,0.92)';
    this.ctx.beginPath(); this.ctx.arc(x, y, CELL * 0.34, 0, Math.PI * 2); this.ctx.fill();
    this.tex.needsUpdate = true;
  }
  private drawStarBlob() {
    if (!this.ctx) return;
    const cx = CELL / 2, cy = CELL / 2;
    this.ctx.clearRect(0, 0, CELL, CELL);
    this.ctx.fillStyle = '#ffd84a'; this.ctx.strokeStyle = '#fff6c4'; this.ctx.lineWidth = 5;
    this.ctx.beginPath();
    for (let i = 0; i < 10; i++) { const r = i % 2 ? CELL * 0.2 : CELL * 0.46, a = -Math.PI / 2 + (i * Math.PI) / 5; this.ctx.lineTo(cx + Math.cos(a) * r, cy + Math.sin(a) * r); }
    this.ctx.closePath(); this.ctx.fill(); this.ctx.stroke();
    this.tex.needsUpdate = true;
  }

  // ---------------------------------------------------------------- drawing

  begin() { this.n = 0; }
  /** One quad. Positions and sizes are avatar-space units; `rot` radians; the cell from `cellFor`. Dropped silently past the capacity. */
  push(cell: number, x: number, y: number, z: number, w: number, h: number, rot: number, alpha: number) {
    if (cell < 0 || this.n >= POOL_CAPACITY || alpha <= 0.004) return;
    const i = this.n++;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.size[i * 2] = w; this.size[i * 2 + 1] = h;
    this.misc[i * 3] = rot; this.misc[i * 3 + 1] = alpha; this.misc[i * 3 + 2] = cell;
    this.dirty = true;
  }
  /** Upload what was pushed. Hides the mesh when nothing is on. */
  end() {
    this.geo.instanceCount = this.n;
    this.mesh.visible = this.n > 0;
    if (this.n > 0 || this.dirty) { this.aPos.needsUpdate = true; this.aSize.needsUpdate = true; this.aMisc.needsUpdate = true; this.dirty = this.n > 0; }
  }
  get count() { return this.n; }
  /** Pictures that have loaded (tests, diagnostics). */
  readyCount() { let c = 0; for (const e of this.cells) if (e?.ready) c++; return c; }

  dispose() {
    this.disposed = true;
    this.mesh.removeFromParent();
    this.geo.dispose(); this.mat.dispose(); this.tex.dispose();
    if (this.canvas) this.canvas.width = this.canvas.height = 0;
    this.canvas = null; this.ctx = null;
    this.cells.fill(null); this.byKey.clear();
  }
}

async function defaultLoad(src: string): Promise<CanvasImageSource | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.decoding = 'async';
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}
