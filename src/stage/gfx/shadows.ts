// Performer shadows onto the floor — performers only, the room never re-renders or recompiles for them.
//   blob (High): a soft contact shadow under each performer (one small transparent quad each).
//   map  (Ultra): a real soft shadow — the performers' depth from a mostly-overhead light (the key light's side),
//        rendered with an override depth material into a 1024² map (only objects on PERFORMER_LAYER), received by a
//        floor quad per performer with a PCSS-lite filter (blocker search → penumbra grows with the distance to the
//        floor, so feet are sharp and heads are soft).
import * as THREE from 'three';

export const PERFORMER_LAYER = 7;

export interface ShadowActor { obj: THREE.Object3D; floorY: number; height: number; sit: number; shown: boolean }

let blobTex: THREE.Texture | null = null;
function blobTexture() {
  if (blobTex) return blobTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const gr = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  gr.addColorStop(0, 'rgba(0,0,0,1)'); gr.addColorStop(0.45, 'rgba(0,0,0,0.72)'); gr.addColorStop(0.8, 'rgba(0,0,0,0.18)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  blobTex = new THREE.CanvasTexture(c);
  return blobTex;
}

const RECV_VERT = /* glsl */ `
  varying vec3 vW;
  void main() { vec4 w = modelMatrix * vec4(position, 1.0); vW = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`;
const RECV_FRAG = /* glsl */ `
  #include <packing>
  uniform sampler2D tShadow; uniform mat4 uShadowMat; uniform float uOpacity, uSoft, uBias; uniform vec3 uCenter; uniform float uR;
  varying vec3 vW;
  const vec2 PD[12] = vec2[](vec2(-0.326,-0.406), vec2(-0.840,-0.074), vec2(-0.696,0.457), vec2(-0.203,0.621), vec2(0.962,-0.195), vec2(0.473,-0.480),
    vec2(0.519,0.767), vec2(0.185,-0.893), vec2(0.507,0.064), vec2(0.896,0.412), vec2(-0.322,-0.933), vec2(-0.792,-0.598));
  float dAt(vec2 uv) { return unpackRGBAToDepth(texture2D(tShadow, uv)); }
  void main() {
    vec4 sc = uShadowMat * vec4(vW, 1.0);
    vec3 p = sc.xyz / sc.w * 0.5 + 0.5;
    if (p.x < 0.0 || p.x > 1.0 || p.y < 0.0 || p.y > 1.0) discard;
    float z = p.z - uBias;
    float avg = 0.0, n = 0.0;
    for (int i = 0; i < 12; i++) { float d = dAt(p.xy + PD[i] * 0.012); if (d < z) { avg += d; n += 1.0; } }
    if (n < 0.5) discard;
    avg /= n;
    float pen = clamp((z - avg) * uSoft, 0.0015, 0.03);
    float lit = 0.0;
    for (int i = 0; i < 12; i++) lit += step(z, dAt(p.xy + PD[i] * pen));
    float sh = 1.0 - lit / 12.0;
    float edge = 1.0 - smoothstep(uR * 0.7, uR, length(vW.xz - uCenter.xz));
    gl_FragColor = vec4(0.0, 0.0, 0.0, sh * uOpacity * edge * (1.0 - pen * 14.0));
  }`;

export class PerformerShadows {
  readonly group = new THREE.Group();
  private blobs: THREE.Mesh[] = [];
  private recv: THREE.Mesh[] = [];
  private mode: 'off' | 'blob' | 'map' = 'off';
  private rt: THREE.WebGLRenderTarget | null = null;
  private cam = new THREE.OrthographicCamera(-2, 2, 2, -2, 0.1, 20);
  private depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
  private shadowMat = new THREE.Matrix4();
  private recvMat: THREE.ShaderMaterial | null = null;
  private box = new THREE.Box3();
  private tmp = new THREE.Vector3();
  // (scratch for the per-frame update, so it allocates nothing)
  private liveBuf: ShadowActor[] = [];
  private tmpC = new THREE.Vector3();
  private tmpS = new THREE.Vector3();
  /** Receiver radius per quad, read by that quad's onBeforeRender (bound once when the quad is made). */
  private recvR: number[] = [];
  private boxes = new Map<THREE.Object3D, { box: THREE.Box3; at: number }>();
  /** ms spent per frame (EMA, CPU side). */
  cost = 0;

  /** GPU memory of the shadow map (bytes: RGBA8 + depth; 0 when off / blob). */
  memoryBytes(): number { return this.rt ? this.rt.width * this.rt.height * 8 : 0; }

  constructor(private scene: THREE.Scene) {
    this.group.name = 'vtp:gfx:shadows';
    scene.add(this.group);
    this.cam.layers.set(PERFORMER_LAYER);
  }

  setMode(m: 'off' | 'blob' | 'map') {
    if (m === this.mode) return;
    this.mode = m;
    for (const b of this.blobs) b.visible = false;
    for (const r of this.recv) r.visible = false;
    if (m !== 'map') { this.rt?.dispose(); this.rt = null; }
    if (m === 'map' && !this.rt) {
      this.rt = new THREE.WebGLRenderTarget(1024, 1024, { depthBuffer: true, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
      this.recvMat = new THREE.ShaderMaterial({
        vertexShader: RECV_VERT, fragmentShader: RECV_FRAG, transparent: true, depthWrite: false,
        polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4,
        uniforms: { tShadow: { value: this.rt.texture }, uShadowMat: { value: this.shadowMat }, uOpacity: { value: 0.5 }, uSoft: { value: 0.9 }, uBias: { value: 0.002 }, uCenter: { value: new THREE.Vector3() }, uR: { value: 1.4 } },
      });
      for (const r of this.recv) r.material = this.recvMat;
    }
  }

  /** Make sure every performer mesh is on the shadow layer (idempotent; call when actors change). */
  tag(obj: THREE.Object3D) { obj.traverse((o) => { if ((o as THREE.Mesh).isMesh) o.layers.enable(PERFORMER_LAYER); }); }

  private boundsOf(obj: THREE.Object3D, now: number) {
    let e = this.boxes.get(obj);
    if (!e || now - e.at > 400) {
      e = { box: e?.box ?? new THREE.Box3(), at: now };
      e.box.setFromObject(obj, false);
      this.boxes.set(obj, e);
    }
    return e.box;
  }

  /** Per frame, before the main render. `lightDir` = world direction TOWARDS the key light. */
  update(renderer: THREE.WebGLRenderer, actors: ShadowActor[], lightDir: THREE.Vector3, now = performance.now()) {
    const t0 = performance.now();
    if (this.mode === 'off') { this.group.visible = false; return; }
    const live = this.liveBuf;
    live.length = 0;
    for (const a of actors) if (a.shown) live.push(a);
    this.group.visible = true;
    // ---- quads
    while (this.blobs.length < live.length) {
      const b = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: blobTexture(), transparent: true, depthWrite: false, opacity: 0.42, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4 }));
      b.rotation.x = -Math.PI / 2; b.renderOrder = -1; b.name = 'vtp:gfx:blob';
      this.group.add(b); this.blobs.push(b);
      const r = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), this.recvMat ?? new THREE.MeshBasicMaterial({ visible: false }));
      r.rotation.x = -Math.PI / 2; r.renderOrder = -1; r.name = 'vtp:gfx:shadowrecv';
      this.group.add(r); this.recv.push(r);
      const qi = this.recv.length - 1;
      r.onBeforeRender = () => {
        if (!this.recvMat) return;
        (this.recvMat.uniforms.uCenter.value as THREE.Vector3).copy(r.position); this.recvMat.uniforms.uR.value = this.recvR[qi]; this.recvMat.uniformsNeedUpdate = true;
      };
    }
    for (let i = 0; i < this.blobs.length; i++) { this.blobs[i].visible = false; this.recv[i].visible = false; }
    if (!live.length) return;
    if (this.mode === 'blob') {
      live.forEach((a, i) => {
        const b = this.blobs[i];
        a.obj.getWorldPosition(this.tmp);
        const r = a.height * (0.34 - 0.06 * a.sit);
        b.position.set(this.tmp.x, a.floorY + 0.004, this.tmp.z);
        b.scale.set(r * 2, r * 2, 1);
        (b.material as THREE.MeshBasicMaterial).opacity = 0.42 * (1 - 0.35 * a.sit);
        b.visible = true;
      });
    } else if (this.rt && this.recvMat) {
      // light camera over all performers
      this.box.makeEmpty();
      for (const a of live) this.box.union(this.boundsOf(a.obj, now));
      const c = this.box.getCenter(this.tmpC), size = this.box.getSize(this.tmpS);
      const dir = this.tmp.set(lightDir.x * 0.45, Math.max(1.1, lightDir.y), lightDir.z * 0.45).normalize();
      const reach = size.length() + 3;
      this.cam.position.copy(c).addScaledVector(dir, reach);
      this.cam.up.set(0, 0, -1);
      this.cam.lookAt(c);
      const half = Math.max(size.x, size.z, size.y * 0.6) * 0.5 + 0.6;
      this.cam.left = -half; this.cam.right = half; this.cam.top = half; this.cam.bottom = -half;
      this.cam.near = 0.05; this.cam.far = reach * 2;
      this.cam.updateProjectionMatrix();
      this.cam.updateMatrixWorld();
      this.shadowMat.multiplyMatrices(this.cam.projectionMatrix, this.cam.matrixWorldInverse);
      // depth of the performers only
      const prevT = renderer.getRenderTarget(), prevO = this.scene.overrideMaterial, prevB = this.scene.background, prevF = this.scene.fog;
      const prevClear = renderer.getClearColor(new THREE.Color()), prevA = renderer.getClearAlpha();
      this.scene.overrideMaterial = this.depthMat; this.scene.background = null; this.scene.fog = null;
      renderer.setRenderTarget(this.rt);
      renderer.setClearColor(0xffffff, 1);
      renderer.clear(true, true, false);
      renderer.render(this.scene, this.cam);
      renderer.setRenderTarget(prevT);
      renderer.setClearColor(prevClear, prevA);
      this.scene.overrideMaterial = prevO; this.scene.background = prevB; this.scene.fog = prevF;
      live.forEach((a, i) => {
        const r = this.recv[i];
        a.obj.getWorldPosition(this.tmp);
        const R = a.height * 1.1 + 0.4;
        r.position.set(this.tmp.x, a.floorY + 0.004, this.tmp.z);
        r.scale.set(R * 2, R * 2, 1);
        r.material = this.recvMat!;
        r.visible = true;
        this.recvR[i] = R;
      });
    }
    this.cost += (performance.now() - t0 - this.cost) * 0.05;
  }

  dispose() {
    this.group.removeFromParent();
    for (const m of [...this.blobs, ...this.recv]) { m.geometry.dispose(); if (m.material !== this.recvMat) (m.material as THREE.Material).dispose(); }
    this.recvMat?.dispose(); this.rt?.dispose(); this.depthMat.dispose();
  }
}
