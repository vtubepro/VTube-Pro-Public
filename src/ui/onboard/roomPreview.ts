// "Add my room": the wizard's private 3D preview of the room file (never the live studio or OBS). Shows every place to
// sit or stand as a little stand-in person (green = fine, orange = a problem, blue = selected, numbered), lets the
// performer click to add a place, drag a person to move it, and renders what each place's camera sees ("Test the
// camera view"). Renders only on demand (orbit / edits), never in a loop, so an open wizard costs the GPU nothing
// while idle. Pure three.js; the room logic is shared/roomCheck.ts.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { TriangleSoup, Mat4 } from '../../../shared/roomGlb.ts';
import type { CamPlace, V3 } from '../../../shared/roomSeats.ts';
import { faceHeight } from '../../../shared/roomSeats.ts';

export interface MarkerSpot {
  name: string; label: string; position: V3; yawDeg: number; pose: 'sit' | 'stand'; seatHeight?: number;
  state: 'ok' | 'warn' | 'new'; cam?: CamPlace | null;
}
const COLORS = { ok: 0x7bd88f, new: 0x7bd88f, warn: 0xffb454, sel: 0x6cc7f5 } as const;

export class RoomPreview {
  readonly el: HTMLDivElement;
  private renderer: THREE.WebGLRenderer | null = null;
  private scene = new THREE.Scene();
  private camera = new THREE.PerspectiveCamera(45, 4 / 3, 0.05, 2000);
  private controls: OrbitControls | null = null;
  private room = new THREE.Group();          // the room as loaded, under the fix (units / up / floor) matrix
  private markers = new THREE.Group();
  private meshes: THREE.Mesh[] = [];
  private bounds = new THREE.Box3();
  private spots: MarkerSpot[] = [];
  private selected: string | null = null;
  private drag: { name: string; moved: boolean } | null = null;
  private ray = new THREE.Raycaster();
  private hint: HTMLDivElement;
  private tag: HTMLDivElement;
  private ro: ResizeObserver | null = null;
  private pending = false;
  /** Click on the room (not on a person) while `addMode` is on. */
  onPick: ((p: V3, normalUp: number) => void) | null = null;
  /** A person was dragged to a new point (called on release). */
  onMove: ((name: string, p: V3, normalUp: number) => void) | null = null;
  onSelect: ((name: string | null) => void) | null = null;
  addMode = false;

  constructor() {
    this.el = document.createElement('div');
    this.el.className = 'ob-prev ob-room-prev';
    this.el.style.aspectRatio = '4 / 3';
    this.tag = document.createElement('div'); this.tag.className = 'ob-prev-tag'; this.tag.textContent = 'Preview: only you see this';
    this.hint = document.createElement('div'); this.hint.className = 'ob-prev-hint'; this.hint.style.display = 'none';
    this.el.append(this.tag, this.hint);
    this.scene.background = new THREE.Color(0x14181d);
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x3a3f4a, 2.4));
    const sun = new THREE.DirectionalLight(0xffffff, 1.1); sun.position.set(4, 8, 6); this.scene.add(sun);
    this.scene.add(this.room, this.markers);
  }

  private ensureRenderer() {
    if (this.renderer) return this.renderer;
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, powerPreference: 'low-power' });
    r.setPixelRatio(Math.min(1.5, window.devicePixelRatio || 1));
    r.outputColorSpace = THREE.SRGBColorSpace;
    r.toneMapping = THREE.NoToneMapping;
    this.el.prepend(r.domElement);
    this.renderer = r;
    const c = new OrbitControls(this.camera, r.domElement);
    c.enableDamping = false; c.screenSpacePanning = true; c.maxPolarAngle = Math.PI * 0.495;
    c.addEventListener('change', () => this.requestRender());
    this.controls = c;
    r.domElement.addEventListener('pointerdown', (e) => this.down(e));
    r.domElement.addEventListener('pointermove', (e) => this.move(e));
    r.domElement.addEventListener('pointerup', (e) => this.up(e));
    this.ro = new ResizeObserver(() => this.resize());
    this.ro.observe(this.el);
    this.resize();
    return r;
  }

  private resize() {
    const r = this.renderer; if (!r) return;
    const w = Math.max(2, this.el.clientWidth), h = Math.max(2, this.el.clientHeight);
    r.setSize(w, h, false);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    this.requestRender();
  }

  requestRender() {
    if (this.pending) return;
    this.pending = true;
    requestAnimationFrame(() => { this.pending = false; this.render(); });
  }
  /** Draw now (also works while the tab is hidden: tests call it directly). */
  render() { const r = this.ensureRenderer(); r.render(this.scene, this.camera); }

  setHint(text: string | null) { this.hint.textContent = text ?? ''; this.hint.style.display = text ? '' : 'none'; }

  /** Load the room file (GLB / glTF bytes). Meshopt is decoded; Draco / KTX2 throw (the helper converts those). */
  async load(bytes: ArrayBuffer): Promise<void> {
    this.ensureRenderer();
    const loader = new GLTFLoader();
    loader.setMeshoptDecoder(MeshoptDecoder);
    const gltf = await new Promise<{ scene: THREE.Group }>((res, rej) => loader.parse(bytes, '', (g) => res(g as unknown as { scene: THREE.Group }), (e) => rej(e)));
    this.room.clear();
    this.room.add(gltf.scene);
    this.meshes = [];
    gltf.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (/^(COLLIDE_|.*__COLLIDE_)/.test(o.name) || (m.isMesh && ([] as THREE.Material[]).concat(m.material).every((mt) => /^M_Hidden/.test(mt?.name ?? '')))) { o.visible = false; return; }
      if (m.isMesh) this.meshes.push(m);
      if ((o as THREE.Light).isLight) o.visible = false;
    });
    this.setFix(null);
  }

  /** The units / up-axis / floor correction (column-major, glTF space). */
  setFix(m: Mat4 | null) {
    this.room.matrixAutoUpdate = false;
    if (m) this.room.matrix.fromArray(Array.from(m)); else this.room.matrix.identity();
    this.room.updateMatrixWorld(true);
    this.bounds.makeEmpty();
    for (const mesh of this.meshes) if (mesh.visible) this.bounds.expandByObject(mesh);
    this.requestRender();
  }

  /** Triangles of the loaded room in the FILE's space (before the fix), for the shared seat finder. */
  soup(maxTris = 600_000): TriangleSoup {
    const parts: Float32Array[] = []; let count = 0;
    const save = this.room.matrix.clone();
    this.room.matrix.identity(); this.room.updateMatrixWorld(true);
    let total = 0;
    for (const m of this.meshes) { const g = m.geometry as THREE.BufferGeometry; total += (g.index ? g.index.count : g.attributes.position.count) / 3; }
    const step = total > maxTris ? total / maxTris : 1;
    const v = new THREE.Vector3();
    for (const m of this.meshes) {
      if (/(^|__)(SCREEN|SPOT_|CAM_)/.test(m.name) || /(^|__)(SCREEN|SPOT_|CAM_)/.test(m.parent?.name ?? '')) continue;
      const g = m.geometry as THREE.BufferGeometry, pos = g.attributes.position, idx = g.index;
      const nt = Math.floor((idx ? idx.count : pos.count) / 3);
      const take = Math.max(1, Math.floor(nt / step));
      const out = new Float32Array(take * 9);
      let w = 0;
      for (let t = 0; t < take; t++) {
        const ti = Math.min(nt - 1, Math.floor(t * step));
        for (let k = 0; k < 3; k++) {
          const vi = idx ? idx.getX(ti * 3 + k) : ti * 3 + k;
          v.fromBufferAttribute(pos, vi).applyMatrix4(m.matrixWorld);
          out[w++] = v.x; out[w++] = v.y; out[w++] = v.z;
        }
      }
      parts.push(out); count += take;
    }
    this.room.matrix.copy(save); this.room.updateMatrixWorld(true);
    const tris = new Float32Array(count * 9); let o = 0;
    for (const p of parts) { tris.set(p, o); o += p.length; }
    return { tris, count, unreadable: [] };
  }

  /** Show these places (fixed space). */
  setSpots(spots: MarkerSpot[], selected: string | null = this.selected) {
    this.spots = spots; this.selected = selected;
    for (const c of [...this.markers.children]) { this.markers.remove(c); disposeDeep(c); }
    spots.forEach((s, i) => this.markers.add(this.person(s, i + 1, s.name === selected)));
    this.requestRender();
  }
  select(name: string | null) { this.setSpots(this.spots, name); this.onSelect?.(name); }
  get selection() { return this.selected; }

  private person(s: MarkerSpot, n: number, sel: boolean): THREE.Group {
    const g = new THREE.Group();
    g.name = `marker:${s.name}`;
    g.position.set(...s.position);
    g.rotation.y = (s.yawDeg * Math.PI) / 180;
    const col = sel ? COLORS.sel : COLORS[s.state];
    const mat = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.85, depthTest: true });
    const ghost = new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.28, depthTest: false });
    const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rx = 0) => {
      for (const m of [mat, ghost]) { const me = new THREE.Mesh(geo, m); me.position.set(x, y, z); me.rotation.x = rx; me.renderOrder = m === ghost ? 10 : 0; me.userData.marker = s.name; g.add(me); }
    };
    const face = faceHeight(s);
    if (s.pose === 'sit') {
      const seat = s.seatHeight ?? 0.45;
      add(new THREE.CapsuleGeometry(0.15, Math.max(0.1, face - seat - 0.38), 4, 10), 0, seat + (face - seat - 0.12) / 2, -0.04);
      add(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), -0.09, seat + 0.06, 0.2, Math.PI / 2);
      add(new THREE.CapsuleGeometry(0.07, 0.34, 4, 8), 0.09, seat + 0.06, 0.2, Math.PI / 2);
      add(new THREE.CapsuleGeometry(0.06, Math.max(0.05, seat - 0.12), 4, 8), -0.09, seat / 2, 0.4);
      add(new THREE.CapsuleGeometry(0.06, Math.max(0.05, seat - 0.12), 4, 8), 0.09, seat / 2, 0.4);
    } else {
      add(new THREE.CapsuleGeometry(0.17, face - 0.55, 4, 10), 0, (face - 0.12) / 2 + 0.05, 0);
    }
    add(new THREE.SphereGeometry(0.12, 16, 12), 0, face, 0.02);
    // nose: which way the person faces
    add(new THREE.ConeGeometry(0.05, 0.14, 10), 0, face, 0.16, Math.PI / 2);
    // floor ring + number
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.26, 0.34, 32), new THREE.MeshBasicMaterial({ color: col, side: THREE.DoubleSide, depthTest: false, transparent: true, opacity: 0.95 }));
    ring.rotation.x = -Math.PI / 2; ring.position.y = 0.015; ring.renderOrder = 11; ring.userData.marker = s.name; g.add(ring);
    const tag = numberSprite(String(n), col);
    tag.position.set(0, face + 0.34, 0); tag.renderOrder = 12; g.add(tag);
    return g;
  }

  /** Point the orbit camera at everything (room + places). */
  frame(fromCam?: CamPlace | null, front: [number, number] = [0, 1], prefix: string | null = null) {
    this.ensureRenderer();
    const go = (pos: THREE.Vector3, target: THREE.Vector3) => { this.camera.position.copy(pos); this.controls!.target.copy(target); this.controls!.update(); this.requestRender(); };
    if (fromCam) { go(new THREE.Vector3(...fromCam.position), new THREE.Vector3(...fromCam.target)); return; }
    // a room with areas: frame one area (its places carry the AREA__ prefix)
    const shown = prefix === null ? this.spots : this.spots.filter((s) => s.name.startsWith(prefix));
    const heads = shown.map((s) => new THREE.Vector3(s.position[0], s.position[1] + faceHeight(s), s.position[2]));
    // the room's own wide camera (what the stream sees) when every place is in its view
    let wide: THREE.Object3D | null = null;
    const wideName = new RegExp(`^${prefix ?? '(?:[A-Z0-9_-]+__)?'}CAM_WIDE$`);
    this.room.traverse((o) => { if (!wide && wideName.test(o.name)) wide = o; });
    const w = wide as THREE.Object3D | null;
    if (w) {
      const p = w.getWorldPosition(new THREE.Vector3()), q = w.getWorldQuaternion(new THREE.Quaternion());
      const test = new THREE.PerspectiveCamera(42, this.camera.aspect || 4 / 3, 0.05, 2000);
      test.position.copy(p); test.quaternion.copy(q); test.updateMatrixWorld(true);
      if (heads.every((v) => { const n = v.clone().project(test); return n.z < 1 && Math.abs(n.x) <= 0.95 && Math.abs(n.y) <= 0.95; })) {
        go(p, p.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(q).multiplyScalar(5)));
        return;
      }
    }
    const b = this.bounds.clone();
    if (heads.length) {
      // from the front of the places, inside the room, at a standing eye height, far enough to fit them all
      const box = new THREE.Box3().setFromPoints(heads);
      const c = box.getCenter(new THREE.Vector3()); c.y = Math.max(0.8, c.y - 0.3);
      const spread = Math.max(1.5, box.getSize(new THREE.Vector3()).length());
      let dist = Math.max(3, spread * 1.05);
      if (!b.isEmpty()) {
        const room = (v: number, lo: number, hi: number, d: number) => (d > 0 ? (hi - 0.4 - v) / d : d < 0 ? (lo + 0.4 - v) / d : Infinity);
        dist = Math.max(2, Math.min(dist, room(c.x, b.min.x, b.max.x, front[0]), room(c.z, b.min.z, b.max.z, front[1])));
      }
      go(new THREE.Vector3(c.x + front[0] * dist, c.y + 1.1 + dist * 0.12, c.z + front[1] * dist), c);
      return;
    }
    if (w) { const p = w.getWorldPosition(new THREE.Vector3()); go(p, p.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(w.getWorldQuaternion(new THREE.Quaternion())).multiplyScalar(5))); return; }
    if (!b.isEmpty()) {
      const c = b.getCenter(new THREE.Vector3()), s = b.getSize(new THREE.Vector3());
      c.y = Math.min(b.min.y + 1.0, c.y);
      go(new THREE.Vector3(c.x, b.min.y + Math.min(2.4, s.y * 0.7), c.z + Math.min(s.z * 0.45, 9)), c);
      return;
    }
    go(new THREE.Vector3(0, 2, 5), new THREE.Vector3(0, 1, 0));
  }

  /** What a camera sees (the stand-in people stay, their rings / numbers hide): a PNG data URL. */
  viewFrom(cam: CamPlace, w = 480, h = 270): string {
    const r = this.ensureRenderer();
    const c = new THREE.PerspectiveCamera(cam.yfovDeg, w / h, 0.05, 2000);
    c.position.set(...cam.position); c.lookAt(...cam.target);
    return this.offscreen(r, c, w, h, true);
  }

  /** A picture of the current orbit view. */
  snapshot(w = 640, h = 480): string {
    const r = this.ensureRenderer();
    const c = this.camera.clone(); c.aspect = w / h; c.updateProjectionMatrix();
    return this.offscreen(r, c, w, h, false);
  }

  /** The room from 8 sides around its places (the shell's 8-angle check). */
  angles(w = 320, h = 240): { label: string; url: string }[] {
    const r = this.ensureRenderer();
    const t = this.controls!.target.clone();
    const dist = Math.max(4, this.camera.position.distanceTo(t));
    const names = ['Front', 'Front right', 'Right', 'Back right', 'Back', 'Back left', 'Left', 'Front left'];
    return names.map((label, i) => {
      const a = (i * Math.PI) / 4;
      const c = new THREE.PerspectiveCamera(50, w / h, 0.05, 2000);
      c.position.set(t.x + Math.sin(a) * dist * 0.85, t.y + dist * 0.45, t.z + Math.cos(a) * dist * 0.85);
      c.lookAt(t);
      return { label, url: this.offscreen(r, c, w, h, false) };
    });
  }

  private offscreen(r: THREE.WebGLRenderer, c: THREE.Camera, w: number, h: number, peopleOnly: boolean): string {
    const rt = new THREE.WebGLRenderTarget(w, h, { colorSpace: THREE.SRGBColorSpace, samples: 4 });
    const hidden: THREE.Object3D[] = [];
    if (peopleOnly) this.markers.traverse((o) => { if (o.visible && ((o as THREE.Sprite).isSprite || (o as THREE.Mesh).renderOrder >= 10)) { o.visible = false; hidden.push(o); } });
    r.setRenderTarget(rt);
    r.render(this.scene, c);
    const px = new Uint8Array(w * h * 4);
    r.readRenderTargetPixels(rt, 0, 0, w, h, px);
    r.setRenderTarget(null);
    rt.dispose();
    for (const o of hidden) o.visible = true;
    const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d')!;
    const img = ctx.createImageData(w, h);
    for (let y = 0; y < h; y++) img.data.set(px.subarray((h - 1 - y) * w * 4, (h - y) * w * 4), y * w * 4);
    ctx.putImageData(img, 0, 0);
    this.requestRender();
    return cv.toDataURL('image/png');
  }

  // ---------------------------------------------------------------- picking + dragging
  private ndc(e: PointerEvent) {
    const b = this.renderer!.domElement.getBoundingClientRect();
    return new THREE.Vector2(((e.clientX - b.left) / b.width) * 2 - 1, -((e.clientY - b.top) / b.height) * 2 + 1);
  }
  private hitRoom(e: PointerEvent): { p: V3; up: number } | null {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const hit = this.ray.intersectObjects(this.meshes, false).find((x) => x.object.visible);
    if (!hit) return null;
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : new THREE.Vector3(0, 1, 0);
    return { p: [hit.point.x, hit.point.y, hit.point.z], up: n.y };
  }
  private hitMarker(e: PointerEvent): string | null {
    this.ray.setFromCamera(this.ndc(e), this.camera);
    const hit = this.ray.intersectObjects(this.markers.children, true)[0];
    return (hit?.object.userData.marker as string | undefined) ?? null;
  }
  private down(e: PointerEvent) {
    const m = this.hitMarker(e);
    if (m) {
      this.drag = { name: m, moved: false };
      this.controls!.enabled = false;
      (e.target as HTMLElement).setPointerCapture(e.pointerId);
      if (this.selected !== m) this.select(m);
      return;
    }
    if (this.addMode) {
      const h = this.hitRoom(e);
      if (h) { e.preventDefault(); this.onPick?.(h.p, h.up); }
    }
  }
  private move(e: PointerEvent) {
    if (!this.drag) { this.renderer!.domElement.style.cursor = this.addMode ? 'crosshair' : this.hitMarker(e) ? 'grab' : ''; return; }
    const h = this.hitRoom(e);
    if (!h) return;
    this.drag.moved = true;
    const g = this.markers.children.find((c) => c.name === `marker:${this.drag!.name}`);
    if (g) { g.position.set(h.p[0], h.p[1], h.p[2]); this.requestRender(); }
    this.renderer!.domElement.style.cursor = 'grabbing';
  }
  private up(e: PointerEvent) {
    if (!this.drag) return;
    const d = this.drag; this.drag = null;
    this.controls!.enabled = true;
    try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* already released */ }
    if (!d.moved) return;
    const h = this.hitRoom(e);
    if (h) this.onMove?.(d.name, h.p, h.up); else this.setSpots(this.spots);
  }

  /** Look from a point at a point (the orbit keeps working from there). */
  lookAt(from: V3, to: V3) {
    this.ensureRenderer();
    this.camera.position.set(...from);
    this.controls!.target.set(...to);
    this.controls!.update();
    this.requestRender();
  }

  /** Where a world point shows on screen (client px), or null when behind the camera. Used by the test harness. */
  project(p: V3): { x: number; y: number } | null {
    if (!this.renderer) return null;
    const v = new THREE.Vector3(...p).project(this.camera);
    if (v.z > 1) return null;
    const b = this.renderer.domElement.getBoundingClientRect();
    return { x: b.left + ((v.x + 1) / 2) * b.width, y: b.top + ((1 - v.y) / 2) * b.height };
  }

  dispose() {
    this.ro?.disconnect();
    this.controls?.dispose();
    disposeDeep(this.room); disposeDeep(this.markers);
    this.renderer?.dispose();
    this.renderer?.forceContextLoss();
    this.renderer?.domElement.remove();
    this.renderer = null;
  }
}

function numberSprite(text: string, color: number): THREE.Sprite {
  const cv = document.createElement('canvas'); cv.width = cv.height = 64;
  const x = cv.getContext('2d')!;
  x.fillStyle = `#${color.toString(16).padStart(6, '0')}`; x.beginPath(); x.arc(32, 32, 28, 0, Math.PI * 2); x.fill();
  x.fillStyle = '#0b1410'; x.font = 'bold 34px system-ui, sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText(text, 32, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(cv), depthTest: false, transparent: true }));
  sp.scale.set(0.28, 0.28, 1);
  return sp;
}

function disposeDeep(o: THREE.Object3D) {
  o.traverse((c) => {
    const m = c as THREE.Mesh;
    m.geometry?.dispose?.();
    for (const mt of ([] as (THREE.Material | undefined)[]).concat(m.material)) { (mt as THREE.SpriteMaterial | undefined)?.map?.dispose(); mt?.dispose?.(); }
  });
}
