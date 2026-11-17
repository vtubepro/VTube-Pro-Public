// "Remote studios" for performer guests who appear ON the interview monitor: their live avatar is moved to a small
// off-stage set (a themed backdrop far below the room, outside every camera's view) and a camera there renders them
// into a texture that the monitor's panel shows — the classic "guest via satellite" look. The avatar is the one this
// page already has (party guests: RAM only, model custody unchanged); nothing is copied or stored.
//
// Placement: SceneRuntime puts every actor at their spot each frame; the interview engine calls `place()` AFTER
// scene.update (the stage-mode page hook runs then), overwriting the mount's position / yaw only — seat pose, scale,
// tracking and visibility stay the runtime's.
import * as THREE from 'three';
import type { SceneActor } from '../actor.ts';
import { THEME_LOOKS } from './props.ts';
import type { SetTheme } from '../../../shared/talkshow.ts';
import { framingClassOf } from '../../../shared/framing.ts';
import { drawnFace } from '../faceDepth.ts';

/** Far below every shipped room (the lowest bounds reach about −1 700 m); guests 40 m apart. */
const BASE = new THREE.Vector3(0, -2600, 0);
const SPACING = 40;

export interface RemoteSlot { key: string; index: number; rt: THREE.WebGLRenderTarget; cam: THREE.PerspectiveCamera; set: THREE.Group; aspect: number; lastRender: number; face: THREE.Vector3 | null }

export class RemoteStudios {
  private slots = new Map<string, RemoteSlot>();
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private frame = 0;
  constructor(readonly parent: THREE.Object3D, readonly theme: SetTheme) {}

  private own<T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T) { this.owned.push(x); return x; }

  origin(i: number) { return BASE.clone().add(new THREE.Vector3(i * SPACING, 0, 0)); }

  /** Make / keep a slot for a guest (index = their panel), with a render target of the panel's aspect. */
  slot(key: string, index: number, aspect: number, px: number): RemoteSlot {
    let s = this.slots.get(key);
    const w = Math.round(Math.min(1024, Math.max(256, px))), h = Math.round(w / aspect);
    if (s && (s.index !== index || Math.abs(s.aspect - aspect) > 0.01 || s.rt.width !== w)) { this.drop(key); s = undefined; }
    if (!s) {
      const rt = new THREE.WebGLRenderTarget(w, h, { samples: 4, type: THREE.UnsignedByteType });
      rt.texture.colorSpace = THREE.LinearSRGBColorSpace;
      rt.texture.generateMipmaps = false;
      rt.texture.minFilter = THREE.LinearFilter;
      const cam = new THREE.PerspectiveCamera(28, aspect, 0.05, 12);
      const set = this.buildSet(index);
      this.parent.add(set);
      s = { key, index, rt, cam, set, aspect, lastRender: -1, face: null };
      this.slots.set(key, s);
    }
    return s;
  }

  /** The backdrop: a curved cyclorama with the theme's colours + a soft window / skyline, lit by itself (unlit). */
  private buildSet(i: number): THREE.Group {
    const look = THEME_LOOKS[this.theme] ?? THEME_LOOKS.studio;
    const g = new THREE.Group();
    g.name = `vtp:interview:remote${i}`;
    g.position.copy(this.origin(i));
    const c = document.createElement('canvas'); c.width = 1024; c.height = 512;
    const x = c.getContext('2d')!;
    const top = `#${new THREE.Color(look.panel).multiplyScalar(0.55).getHexString()}`, bot = `#${new THREE.Color(look.panel).multiplyScalar(0.18).getHexString()}`;
    const gr = x.createLinearGradient(0, 0, 0, 512); gr.addColorStop(0, top); gr.addColorStop(1, bot);
    x.fillStyle = gr; x.fillRect(0, 0, 1024, 512);
    // a "home studio" window with a city at night, bokeh lights, a shelf line
    let r = 17 + i * 31; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
    x.fillStyle = 'rgba(0,0,0,0.35)'; x.fillRect(90 + i * 40, 90, 320, 240);
    for (let k = 0; k < 22; k++) { const bx = 100 + i * 40 + rnd() * 300, bw = 12 + rnd() * 28, bh = 40 + rnd() * 150; x.fillStyle = 'rgba(20,24,40,0.9)'; x.fillRect(bx, 330 - bh, bw, bh); for (let wy = 330 - bh + 6; wy < 326; wy += 10) if (rnd() < 0.35) { x.fillStyle = 'rgba(255,210,120,0.8)'; x.fillRect(bx + 3, wy, 3, 4); } }
    x.strokeStyle = 'rgba(255,255,255,0.18)'; x.lineWidth = 8; x.strokeRect(90 + i * 40, 90, 320, 240); x.fillStyle = 'rgba(255,255,255,0.18)'; x.fillRect(248 + i * 40, 90, 6, 240);
    for (let k = 0; k < 40; k++) { const bx = 520 + rnd() * 480, by = 60 + rnd() * 300, br = 8 + rnd() * 26; const bg = x.createRadialGradient(bx, by, 0, bx, by, br); bg.addColorStop(0, `rgba(255,${180 + (rnd() * 70) | 0},${120 + (rnd() * 100) | 0},0.35)`); bg.addColorStop(1, 'rgba(0,0,0,0)'); x.fillStyle = bg; x.fillRect(bx - br, by - br, br * 2, br * 2); }
    x.fillStyle = 'rgba(0,0,0,0.3)'; x.fillRect(560, 380, 400, 10);
    const t = this.own(new THREE.CanvasTexture(c)); t.colorSpace = THREE.SRGBColorSpace;
    const mat = this.own(new THREE.MeshBasicMaterial({ map: t, side: THREE.BackSide, fog: false }));
    // a half cylinder behind the guest (radius 2.6 m, 3.4 m tall), open towards the camera (+Z)
    const geo = this.own(new THREE.CylinderGeometry(2.6, 2.6, 3.4, 32, 1, true, Math.PI / 2, Math.PI));
    const cyc = new THREE.Mesh(geo, mat);
    cyc.position.set(0, 1.4, 0.2);
    cyc.frustumCulled = false;
    g.add(cyc);
    const floor = new THREE.Mesh(this.own(new THREE.CircleGeometry(2.7, 32)), this.own(new THREE.MeshBasicMaterial({ color: new THREE.Color(look.panel).multiplyScalar(0.12), fog: false })));
    floor.rotation.x = -Math.PI / 2;
    g.add(floor);
    return g;
  }

  /** Put the guest's avatar into their remote set (after scene.update) and aim that set's camera at their face. */
  place(a: SceneActor, s: RemoteSlot, dt = 1 / 30) {
    const o = this.origin(s.index);
    a.mount.position.copy(o);
    a.mount.rotation.set(0, 0, 0);
    const sp = a.spot;
    if (!sp) return;
    // (the drawn face: a mascot whose eye bones sit deep in its head is framed on the face it shows — faceDepth.ts)
    const f = a.drawnFaceAt(sp);
    if (!f) return;
    // the backdrop grows with the guest (a giant's head never pokes out over the cyclorama; framing guarantee)
    const shown = (a.rest?.height ?? 1.6) * a.scale;
    const k = Math.max(1, shown / 2.2);
    if (Math.abs(s.set.scale.x - k) > 1e-3) { s.set.scale.setScalar(k); s.set.updateMatrixWorld(true); }
    // the face relative to the spot, in the spot's own frame → the same offset in the remote set (facing +Z) …
    const local = f.center.clone().sub(sp.position).applyAxisAngle(new THREE.Vector3(0, 1, 0), -sp.yaw);
    let want = o.clone().add(local), size = f.size;
    // … or better the live face (markers / eye bones) once the avatar is posed there
    try {
      a.mount.updateMatrixWorld(true);
      const live = drawnFace(a.runtime);
      if (live && live.center.distanceTo(want) < 1.2) { want = live.center.clone(); size = Math.min(live.size, f.size * 1.6); }
    } catch { /* keep the estimate */ }
    if (!s.face || s.face.distanceTo(want) > 1) s.face = want.clone();
    else s.face.lerp(want, 1 - Math.exp(-2.5 * dt));
    const face = s.face;
    // bust framing: the face ≈ 20 % of the panel height with a little head room; a narrow (portrait) panel still
    // fits the shoulders across
    // (a fairy's floor scales with them: never a speck in the middle of the panel)
    const floor = Math.min(0.5, Math.max(0.12, shown * 0.33)), fl2 = Math.min(0.55, Math.max(0.14, shown * 0.37));
    // the whole head stays inside the panel's safe area (framing guarantee: a big mascot head / tall hair); a mech's
    // PILOT is the guest — the bust frames the pilot's face, never the hull above it
    const mech = framingClassOf(a.runtime?.profile as unknown as { body?: unknown; mech?: unknown } | undefined, a.size.cls) === 'mech';
    const dyr = a.rest?.drawn ? (a.rest.face.center.y - a.rest.drawn.center.y) * a.scale : 0;
    const top = a.rest?.head ? Math.max(f.size * 1.15, Math.min(a.rest.head.top * a.scale + dyr, f.size * (mech ? 1.8 : 4))) : f.size * 1.15;
    const fh = Math.max(floor, size * 5.2, top / 0.33, Math.max(fl2, size * 4.5) / Math.max(0.3, s.aspect));
    const fov = 28;
    const dist = (fh / 2) / Math.tan(THREE.MathUtils.degToRad(fov) / 2);
    s.cam.fov = fov; s.cam.aspect = s.aspect; s.cam.near = Math.min(0.05, dist * 0.2); s.cam.far = dist + 4 * k;
    s.cam.position.set(face.x, face.y + f.size * 0.2, face.z + dist);
    s.cam.lookAt(face.x, face.y - fh * 0.12, face.z);
    s.cam.updateProjectionMatrix();
    s.cam.updateMatrixWorld();
  }

  /** Render the guests' sets (every other frame each; only when wanted). */
  render(renderer: THREE.WebGLRenderer, scene: THREE.Scene, want: (s: RemoteSlot) => boolean) {
    this.frame++;
    const prevT = renderer.getRenderTarget(), prevXr = renderer.xr.enabled, prevAuto = renderer.autoClear;
    const prevClear = renderer.getClearColor(new THREE.Color()), prevAlpha = renderer.getClearAlpha();
    const bg = scene.background, fog = scene.fog;
    try {
      renderer.xr.enabled = false; renderer.autoClear = true;
      scene.background = null;
      for (const s of this.slots.values()) {
        if (!want(s) || (this.frame + s.index) % 2) continue;
        renderer.setRenderTarget(s.rt);
        renderer.setClearColor(0x000000, 1);
        renderer.clear();
        renderer.render(scene, s.cam);
        s.lastRender = this.frame;
      }
    } finally {
      scene.background = bg; scene.fog = fog;
      renderer.setRenderTarget(prevT); renderer.xr.enabled = prevXr; renderer.autoClear = prevAuto;
      renderer.setClearColor(prevClear, prevAlpha);
    }
  }

  texture(key: string): THREE.Texture | null { return this.slots.get(key)?.rt.texture ?? null; }
  has(key: string) { return this.slots.has(key); }
  keys() { return [...this.slots.keys()]; }

  drop(key: string) {
    const s = this.slots.get(key);
    if (!s) return;
    s.rt.dispose();
    s.set.removeFromParent();
    this.slots.delete(key);
  }

  dispose() {
    for (const k of [...this.slots.keys()]) this.drop(k);
    for (const o of this.owned) o.dispose();
  }
}
