// Camera QA probe (test pages only: output.html?sceneTest=…, loaded lazily by vtpOut.camEval()). Measures the shot the
// room is showing RIGHT NOW and lists what is wrong with it, so every room × shot type × group size can be checked
// automatically (tools/cam_eval.py renders the contact sheets and the summary table from these reports).
//
//   faces      every shown performer: in frame, size (face height / frame), head room, cut at an edge, how many of 9
//              face points the room / another performer / a prop hides, facing (0° = into the lens), lead room
//   set        void (pixels nothing drew — OBS would show whatever is under the browser source), rays that meet the
//              BACK of a single-sided surface (looking out through a wall = the unmodelled outside), the camera inside
//              geometry, foreground clutter right in front of the lens
//   screen     react screen (big or solo): framed, fill, occluded samples
//   props      chat monitor / support board: in frame, readable, never over a face or the screen, not hidden;
//              Sprocket's tablet (reported only)
// Pure measurement: never changes the scene state (the caller drives it through vtpOut.debugScene / vtpOut.step).
import * as THREE from 'three';
import { MeshBVH, StaticGeometryGenerator } from 'three-mesh-bvh';
import { SceneRuntime } from './SceneRuntime.ts';
import type { SceneActor } from './actor.ts';
import { EVAL_SAFE, FACE_BOX, boxOverflow, safeFor, sanitizeMotion, type MotionEnvelope, type ShotFamily } from '../../shared/framing.ts';
import { FrameGuard } from './frameGuard.ts';
import { drawnFace, onFaceSurface } from './faceDepth.ts';
import { isMoving } from './twoShot.ts';

/** Shot kinds (thresholds): the Talk / React / preset / walk-in kinds, plus the framing-guarantee families the acceptance
 *  harness measures (tools/cam_eval/accept.py): interview singles / two / establishing / monitor, gaming tiles, TTRPG
 *  close-ups, ambient (Preshow / BRB / Outro) cameras. */
export type ShotKind = 'talk' | 'group' | 'wide' | 'react' | 'solo' | 'preset' | 'follow' | 'single' | 'two' | 'establishing' | 'monitor' | 'tile' | 'ttrpg' | 'ambient';
export interface Issue { sev: 1 | 2 | 3; code: string; msg: string }
interface FaceReport {
  key: string; spot: number; u: number; v: number; hf: number; top: number; chin: number; inFrame: boolean; cut: string | null;
  occ: number; occBy: string[]; facing: number; lead: number | null; focus: boolean; dist: number;
  /** Share of the face points hidden only by a room part an engine animates (a passing drone: a moment, not the camera). */
  occMover: number;
  /** The face box in NDC (x0, x1, y0, y1: cheeks, chin … forehead; framing guarantee) and the head top's NDC y. */
  box: [number, number, number, number]; headY: number;
}
/** The framing guarantee's severity of a framed face on the fringe (outside title safe), per shot kind. */
const FACE_SAFE_SEV: Record<ShotKind, 0 | 1 | 2 | 3> = { talk: 3, solo: 3, group: 3, wide: 3, single: 3, two: 3, establishing: 3, tile: 3, ttrpg: 3, monitor: 3, follow: 2, preset: 1, ambient: 1, react: 0 };
/** The shot family whose evaluation line (shared/framing.ts EVAL_SAFE_BY, scene.json framing.safe) a kind is scored on. */
const FAMILY_OF: Record<ShotKind, ShotFamily> = { talk: 'talk', solo: 'solo', single: 'single', ttrpg: 'ttrpg', tile: 'tile', group: 'group', wide: 'wide', two: 'two', establishing: 'establishing',
  monitor: 'monitor', follow: 'talk', preset: 'wide', ambient: 'wide', react: 'wide' };
interface PropReport { kind: string; down: boolean; rect: number[] | null; hf: number; overFace: boolean; overScreen: boolean; occ: number; source: string; failed: boolean }

const UP = new THREE.Vector3(0, 1, 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;

interface Hit { d: number; back: boolean; culled: boolean; mesh: THREE.Mesh; area: number }
/** Double-sided first-hit probe against the room's occluder meshes (BVH), with the face normal → back-face detection. */
class Probe {
  private boxes = new Map<THREE.Mesh, THREE.Box3>();
  private inv = new THREE.Matrix4();
  private nm = new THREE.Matrix3();
  constructor(private meshes: THREE.Mesh[]) {}
  private box(m: THREE.Mesh) { let b = this.boxes.get(m); if (!b) { b = new THREE.Box3().setFromObject(m); this.boxes.set(m, b); } return b; }
  /** `still`: skip the room parts an engine animates (twoShot.ts isMoving). */
  first(o: THREE.Vector3, dir: THREE.Vector3, far: number, seeThrough = false, still = false): Hit | null {
    const world = new THREE.Ray(o, dir);
    const p = new THREE.Vector3();
    let best: Hit | null = null;
    for (const m of this.meshes) {
      if (!m.visible || (still && isMoving(m))) continue;
      if (seeThrough && glassy(m)) continue;
      const b = this.box(m);
      if (!b.containsPoint(o) && (!world.intersectBox(b, p) || p.distanceTo(o) > far)) continue;
      const g = m.geometry as THREE.BufferGeometry & { boundsTree?: MeshBVH };
      if (!g?.attributes?.position) continue;
      if (!g.boundsTree) { try { g.boundsTree = new MeshBVH(g); } catch { continue; } }
      const t = g.boundsTree;
      this.inv.copy(m.matrixWorld).invert();
      const lr = world.clone().applyMatrix4(this.inv);
      const h = t.raycastFirst(lr, THREE.DoubleSide);
      if (!h || !h.face) continue;
      const wp = h.point.clone().applyMatrix4(m.matrixWorld);
      const d = wp.distanceTo(o);
      if (d > far || (best && d >= best.d)) continue;
      const n = h.face.normal.clone().applyMatrix3(this.nm.getNormalMatrix(m.matrixWorld)).normalize();
      const back = n.dot(dir) > 0;
      const mat = (Array.isArray(m.material) ? m.material[h.face.materialIndex ?? 0] ?? m.material[0] : m.material) as THREE.Material | undefined;
      const pos = g.attributes.position as THREE.BufferAttribute;
      const tri = [h.face.a, h.face.b, h.face.c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld));
      const area = new THREE.Triangle(tri[0], tri[1], tri[2]).getArea();
      best = { d, back, culled: back && (mat?.side ?? THREE.FrontSide) === THREE.FrontSide, mesh: m, area };
    }
    return best;
  }
}

interface Blocker { name: string; box: THREE.Box3; sphere?: THREE.Sphere; obj?: THREE.Object3D; actor?: SceneActor }
/** Clear glass (every material transparent with opacity < 0.5, or transmissive): seen through, never hiding a face. */
function glassy(m: THREE.Mesh): boolean {
  const mats = (Array.isArray(m.material) ? m.material : [m.material]) as (THREE.Material & { transmission?: number })[];
  return mats.length > 0 && mats.every((x) => !!x && ((x.transparent && x.opacity < 0.5) || (x.transmission ?? 0) > 0.5));
}
/** Holo beams, glass, additive glows: drawn, but the face still reads through them. */
function seeThrough(o: THREE.Object3D): boolean {
  const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
  const mm = Array.isArray(m) ? m[0] : m;
  return !!mm && ((mm.transparent && (mm.opacity < 0.75 || !mm.depthWrite || (mm as THREE.ShaderMaterial).isShaderMaterial)) || mm.blending === THREE.AdditiveBlending);
}
function visibleChain(o: THREE.Object3D) { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; }

export class CamEval {
  private probe: Probe;
  private ray = new THREE.Raycaster();
  private pixels: Uint8Array | null = null;
  constructor(readonly rt: SceneRuntime, readonly chat: unknown) {
    this.probe = new Probe(rt.room.occluders);
  }

  private cam() { const c = this.rt.stage.camera; c.updateMatrixWorld(); c.updateProjectionMatrix(); return c; }

  /** Fraction of pixels nothing was drawn on (alpha 0), measured on a fresh render with the room background off. */
  voidFraction(): { frac: number; top: number; bottom: number } {
    const st = this.rt.stage, r = st.renderer;
    const bg = st.background;
    st.background = null;
    st.render();
    st.background = bg;
    const gl = r.getContext();
    r.setRenderTarget(null);
    const w = gl.drawingBufferWidth, h = gl.drawingBufferHeight;
    // (one read-back buffer per probe, re-used by every measure: thousands of frames per harness page)
    if (!this.pixels || this.pixels.length !== w * h * 4) this.pixels = new Uint8Array(w * h * 4);
    const buf = this.pixels;
    gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, buf);
    let n = 0, e = 0, top = 0, bot = 0, nt = 0, nb = 0;
    for (let y = 0; y < h; y += 3) for (let x = 0; x < w; x += 3) {
      const a = buf[(y * w + x) * 4 + 3];
      n++; const v = a < 10 ? 1 : 0; e += v;
      if (y > h * 0.5) { nt++; top += v; } else { nb++; bot += v; }   // (GL rows start at the bottom)
    }
    return { frac: e / Math.max(1, n), top: top / Math.max(1, nt), bottom: bot / Math.max(1, nb) };
  }

  /** Follow a view ray the way the renderer sees it: through back faces of single-sided surfaces (culled), until a
   *  surface that is drawn. `wall` = it passed through the back of a big surface (a wall / floor seen from behind). */
  trace(o: THREE.Vector3, dir: THREE.Vector3, far: number, seeThrough = false, still = false): { d: number; wall: boolean; drawn: boolean } {
    let from = o.clone(), gone = 0, wall = false;
    for (let k = 0; k < 8; k++) {
      const h = this.probe.first(from, dir, far - gone, seeThrough, still);
      if (!h) return { d: Infinity, wall, drawn: false };
      if (!h.culled) return { d: gone + h.d, wall, drawn: true };
      if (h.area > 1.5) wall = true;
      gone += h.d + 0.002;
      from = o.clone().addScaledVector(dir, gone);
    }
    return { d: gone, wall, drawn: true };
  }

  /** Grid of rays through the frame: the set seen from behind a wall (looking out of / into the modelled set),
   *  foreground clutter, rays that leave the set horizontally / downwards. */
  setRays(nx = 32, ny = 18) {
    const cam = this.cam();
    let culled = 0, near = 0, open = 0, n = 0, grid = '';
    const far = cam.far;
    for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) {
      const ndc = new THREE.Vector3(((i + 0.5) / nx) * 2 - 1, 1 - ((j + 0.5) / ny) * 2, 0.5).unproject(cam);
      const dir = ndc.sub(cam.position).normalize();
      const h = this.trace(cam.position, dir, far);
      n++;
      if (!h.drawn) { if (dir.y < 0.12) open++; grid += 'o'; continue; }
      if (h.wall) culled++;
      if (h.d < 0.3) near++;
      grid += h.wall ? 'w' : h.d < 0.3 ? 'n' : '.';
    }
    // camera inside something: most directions meet the back of a surface first; behind a wall (outside the set):
    // several horizontal directions (or straight down) meet the back of a big surface
    let insideVotes = 0, outVotes = 0;
    for (const d of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]]) {
      const h = this.probe.first(cam.position, new THREE.Vector3(...d), 4);
      if (h && h.back && h.area > 0.05) insideVotes++;
    }
    for (let k = 0; k < 8; k++) {
      const a = (k / 8) * Math.PI * 2;
      const h = this.probe.first(cam.position, new THREE.Vector3(Math.cos(a), 0, Math.sin(a)), 8);
      if (h && h.back && h.area > 0.2) outVotes++;
    }
    const dn = this.probe.first(cam.position, new THREE.Vector3(0, -1, 0), 8);
    if (dn && dn.back && dn.area > 0.2) outVotes += 2;
    return { culled: culled / n, near: near / n, open: open / n, inside: insideVotes >= 4, outside: outVotes, grid };
  }

  /** What can hide a face besides the room: other performers (head sphere + torso box — exact skinned raycasts are
   *  far too slow), chat props and the solo screen (exact), anything skinned (its box). */
  private blockers(except: SceneActor | null): Blocker[] {
    const out: Blocker[] = [];
    const mounts = new Set<THREE.Object3D>();
    for (const a of this.rt.actors.values()) {
      mounts.add(a.mount);
      if (a === except || !a.mount.visible || !a.runtime) continue;
      // (the drawn face: its head is where the face is drawn — src/scene/faceDepth.ts)
      const f = drawnFace(a.runtime);
      if (!f) continue;
      // (round the head's middle: a drawn face sits on its front — volumes centred on the face would stand out in front)
      const hc = f.head;
      const h = (a.rest?.height ?? 1.6) * a.scale, w = f.size * 1.05, top = hc.y - f.size * 0.6;
      const bot = a.sit > 0.5 ? top - h * 0.32 : a.mount.position.y;
      out.push({ name: a.key, actor: a, sphere: new THREE.Sphere(hc.clone().add(new THREE.Vector3(0, f.size * 0.15, 0)), f.size * 0.72),
        box: new THREE.Box3(new THREE.Vector3(hc.x - w, bot, hc.z - w), new THREE.Vector3(hc.x + w, top, hc.z + w)) });
    }
    for (const c of this.rt.root.children) {
      if (c === this.rt.room.root || mounts.has(c) || !c.visible || (c as THREE.Points).isPoints) continue;
      // only the screen / chat rigs and skinned characters (Sprocket): room engines' skies, seas, crowds are not blockers
      const name = c.name || '';
      let skinnedAny = false;
      c.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinnedAny = true; });
      if (!/^vtp:(chat|solo)/.test(name) && !skinnedAny) continue;
      let skinned = false;
      c.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned = true; });
      const box = new THREE.Box3().setFromObject(c);
      if (box.isEmpty() || box.containsPoint(this.rt.stage.camera.position) || box.getSize(new THREE.Vector3()).length() > 12) continue;
      out.push(skinned ? { name: c.name || 'skinned', box: box.expandByScalar(-0.05) } : { name: c.name || 'prop', obj: c, box: box.expandByScalar(0.05) });
    }
    return out;
  }

  /** Is the segment camera → p hidden? 'room' | blocker name | null. */
  private hidden(p: THREE.Vector3, blockers: Blocker[]): string | null {
    const cam = this.rt.stage.camera.position;
    const d = p.clone().sub(cam), L = d.length();
    d.normalize();
    // (clear glass — a window, a glass door — doesn't hide a face: viewers see through it; a room part an engine animates —
    // a roaming drone, a flag, a turret — hides it only for a moment: 'mover', never the camera's fault)
    const h = this.trace(cam, d, L - 0.04, true, true);
    if (h.drawn && h.d > 0.02) return 'room';
    const hm = this.trace(cam, d, L - 0.04, true);
    if (hm.drawn && hm.d > 0.02) return 'mover';
    const ray = new THREE.Ray(cam, d), q = new THREE.Vector3();
    const within = (v: THREE.Vector3 | null) => !!v && v.distanceTo(cam) < L - 0.04;
    for (const b of blockers) {
      // (a performer: the head sphere + torso box only say "maybe" — the verdict is their posed mesh this frame, so a
      // giant beside a guest never hides them on the box alone, nor a mascot's fur ruff in the empty corner of its box)
      const maybe = (b.sphere && within(ray.intersectSphere(b.sphere, q))) || within(ray.intersectBox(b.box, q)) || b.box.containsPoint(cam);
      if (b.actor) {
        if (!maybe) continue;
        const bvh = this.posedOf(b.actor);
        if (!bvh) return b.name;
        const h = bvh.raycastFirst(new THREE.Ray(cam, d), THREE.DoubleSide);
        if (h && h.distance > 0.02 && h.distance < L - 0.04) return b.name;
        continue;
      }
      if (b.sphere && within(ray.intersectSphere(b.sphere, q))) return b.name;
      if (!within(ray.intersectBox(b.box, q)) && !b.box.containsPoint(cam)) continue;
      if (!b.obj) return b.name;
      this.ray.set(cam, d); this.ray.near = 0.02; this.ray.far = L - 0.04;
      const hit = this.ray.intersectObject(b.obj, true).find((x) => visibleChain(x.object) && !(x.object as THREE.Points).isPoints && !(x.object as THREE.Line).isLine && !seeThrough(x.object));
      if (hit) return b.name;
    }
    return null;
  }

  faces(kind: ShotKind): FaceReport[] {
    const cam = this.cam();
    const out: FaceReport[] = [];
    const right = new THREE.Vector3().crossVectors(cam.getWorldDirection(new THREE.Vector3()), UP).normalize();
    const focusKey = this.rt.state.focus;
    const shown = [...this.rt.actors.values()].filter((a) => a.shown && a.runtime && a.mount.visible);
    for (const a of shown) {
      // (the DRAWN face, live: a mascot whose eye bones sit deep in a big head is scored on the face it shows, never on
      // the space between its eyes — src/scene/faceDepth.ts)
      const f = drawnFace(a.runtime);
      if (!f) continue;
      const s = f.size;
      const pr = (p: THREE.Vector3) => { const v = p.clone().project(cam); return { u: (v.x + 1) / 2, v: (1 - v.y) / 2, z: v.z }; };
      const c = pr(f.center), top = pr(f.center.clone().add(new THREE.Vector3(0, s * 1.15, 0))), chin = pr(f.center.clone().add(new THREE.Vector3(0, -s * 0.8, 0)));
      const l = pr(f.center.clone().addScaledVector(right, -s * 0.6)), rr = pr(f.center.clone().addScaledVector(right, s * 0.6));
      const r0 = a.rest;
      const dy0 = r0?.drawn ? r0.face.center.y - r0.drawn.center.y : 0;
      // (a mech / vehicle: the framed head is the PILOT's — never the hull above it: desert_walker/SPEC.md §2.7, the same
      // cap the solvers and the guard frame to)
      const headCap = this.rt.classOf(a) === 'mech' ? s * 1.8 : s * 4;
      const headTop = r0 ? Math.max(s * FACE_BOX.up, Math.min(((r0.head?.top ?? (r0.floorY + r0.height - r0.face.center.y)) + dy0) * a.scale, headCap)) : s * FACE_BOX.up;
      const ht = pr(f.center.clone().add(new THREE.Vector3(0, headTop, 0)));
      const front = c.z > -1 && c.z < 1;
      const inFrame = front && top.v > 0 && chin.v < 1 && l.u > 0 && rr.u < 1;
      let cut: string | null = null;
      if (!front) cut = 'behind';
      else if (c.u < 0 || c.u > 1 || c.v < 0 || c.v > 1) cut = 'out';
      else if (top.v < 0) cut = 'top';
      else if (chin.v > 1) cut = 'bottom';
      else if (l.u < 0 || rr.u > 1) cut = 'side';
      // occlusion: 9 points over the face
      const blk = this.blockers(a);
      const pts = [[0, 0], [-0.35, 0], [0.35, 0], [0, 0.4], [0, -0.35], [-0.25, 0.25], [0.25, 0.25], [-0.25, -0.2], [0.25, -0.2]]
        .map(([x, y]) => f.center.clone().addScaledVector(right, x * s).add(new THREE.Vector3(0, y * s, 0)));
      let occ = 0, occM = 0; const by = new Set<string>();
      // facing: angle between the performer's facing and the direction to the camera
      const fwd = new THREE.Vector3(Math.sin(a.mount.rotation.y), 0, Math.cos(a.mount.rotation.y));
      // (occlusion is judged at the drawn face surface, not at a centre inside the head: src/scene/faceDepth.ts)
      const depth = f.depth;
      if (front) for (const p of pts) { const h = this.hidden(onFaceSurface(p, cam.position, depth, fwd), blk); if (h === 'mover') occM++; else if (h) { occ++; by.add(h); } }
      const toCam = cam.position.clone().sub(f.center).setY(0).normalize();
      const facing = THREE.MathUtils.radToDeg(Math.acos(THREE.MathUtils.clamp(fwd.dot(toCam), -1, 1)));
      const g = pr(f.center.clone().addScaledVector(fwd, 0.6));
      const dx = g.u - c.u;
      const lead = Math.abs(dx) > 0.02 ? (dx > 0 ? 1 - c.u : c.u) : null;
      out.push({ key: a.key, spot: a.spot ? a.spot.index + 1 : 0, u: r3(c.u), v: r3(c.v), hf: r3(chin.v - top.v), top: r3(top.v), chin: r3(chin.v), inFrame, cut,
        occ: occ / pts.length, occBy: [...by], occMover: occM / pts.length, facing: Math.round(facing), lead: lead === null ? null : r3(lead), focus: a.key === focusKey, dist: r3(f.center.distanceTo(cam.position)),
        box: [r3(l.u * 2 - 1), r3(rr.u * 2 - 1), r3(1 - chin.v * 2), r3(1 - top.v * 2)], headY: r3(1 - ht.v * 2) });
    }
    void kind;
    return out;
  }

  screen() {
    const rt = this.rt, cam = this.cam();
    if (rt.state.mode !== 'react') return null;
    const lay = rt.layout();
    const s = lay === 'solo' ? rt.solo : rt.screen;
    if (!s) return { layout: lay, missing: true };
    const rect = s.rect(cam);
    const fr = lay === 'solo' ? rt.solo!.frame() : rt.screen!.frame(cam.position);
    const across = new THREE.Vector3().crossVectors(UP, fr.normal).normalize();
    // (a performer whose face is BEHIND the screen — a giant standing at its back, head over the top: the body under that
    // face is behind the picture, which hides it; only the head can reach over the picture. The torso column hanging
    // from the face would poke through the screen plane and count the giant's own hidden body as covering the picture.)
    const side = (p: THREE.Vector3) => p.clone().sub(fr.center).dot(fr.normal) * cam.position.clone().sub(fr.center).dot(fr.normal);
    const blk = this.blockers(null).filter((o) => o.name !== 'vtp:soloScreen').map((o) => (o.sphere && side(o.sphere.center) < 0 ? { ...o, box: new THREE.Box3() } : o));
    let occ = 0, n = 0;
    for (let i = 0; i < 6; i++) for (let j = 0; j < 4; j++) {
      const p = fr.center.clone().addScaledVector(across, ((i + 0.5) / 6 - 0.5) * fr.width * 0.95).add(new THREE.Vector3(0, ((j + 0.5) / 4 - 0.5) * fr.height * 0.95, 0)).addScaledVector(fr.normal, 0.03);
      n++; if (this.hidden(p, blk)) occ++;
    }
    const x0 = Math.max(0, rect.x), y0 = Math.max(0, rect.y), x1 = Math.min(1, rect.x + rect.w), y1 = Math.min(1, rect.y + rect.h);
    return { layout: lay, rect: [r3(rect.x), r3(rect.y), r3(rect.w), r3(rect.h)], visible: rect.visible, fill: r3(Math.max(0, x1 - x0) * Math.max(0, y1 - y0)), wfrac: r3(rect.w), occ: occ / n };
  }

  props(faces: FaceReport[], screenRect: number[] | null): PropReport[] {
    const cam = this.cam();
    const ch = this.chat as { monitor?: { rig: { place: { center: THREE.Vector3; yaw: number; width: number; source: string }; down: boolean; H: number } | null; failed: boolean }; board?: { rig: { place: { center: THREE.Vector3; yaw: number; width: number; source: string }; down: boolean; H: number } | null; failed: boolean }; state?: { monitor: boolean; panel: string } };
    const out: PropReport[] = [];
    const st = this.rt.state.chat;
    for (const kind of ['monitor', 'board'] as const) {
      const want = kind === 'monitor' ? st?.monitor : st?.panel === 'panel';
      if (!want) continue;
      const slot = ch[kind];
      const rig = slot?.rig;
      if (!rig) { out.push({ kind, down: false, rect: null, hf: 0, overFace: false, overScreen: false, occ: 0, source: '', failed: !!slot?.failed }); continue; }
      const pl = rig.place, W = pl.width, H = rig.H;
      const q = new THREE.Quaternion().setFromAxisAngle(UP, pl.yaw);
      const at = (x: number, y: number) => new THREE.Vector3(x, y, 0.02).applyQuaternion(q).add(pl.center);
      const pts = [at(-W / 2, -H / 2), at(W / 2, -H / 2), at(-W / 2, H / 2), at(W / 2, H / 2)].map((p) => { const v = p.project(cam); return [(v.x + 1) / 2, (1 - v.y) / 2]; });
      const x0 = Math.min(...pts.map((p) => p[0])), x1 = Math.max(...pts.map((p) => p[0])), y0 = Math.min(...pts.map((p) => p[1])), y1 = Math.max(...pts.map((p) => p[1]));
      const ov = (a: number[], b: number[]) => Math.max(0, Math.min(a[2], b[2]) - Math.max(a[0], b[0])) * Math.max(0, Math.min(a[3], b[3]) - Math.max(a[1], b[1])) > 0;
      const pr = [x0, y0, x1, y1];
      const pd = pl.center.distanceTo(cam.position);
      const asp = this.rt.stage.camera.aspect || 16 / 9;
      const overFace = faces.some((f) => f.cut !== 'behind' && f.cut !== 'out' && f.dist > pd - 0.1 && ov(pr, [f.u - f.hf * 0.45 / asp, f.top, f.u + f.hf * 0.45 / asp, f.chin]));   // (a prop BEHIND a face is hidden by it, not covering it)
      const overScreen = !!screenRect && ov(pr, [screenRect[0], screenRect[1], screenRect[0] + screenRect[2], screenRect[1] + screenRect[3]]);
      const blk = this.blockers(null).filter((o) => o.obj !== (rig as unknown as { rig: THREE.Object3D }).rig);
      let occ = 0;
      const sp = [[0, 0], [-0.4, -0.4], [0.4, -0.4], [-0.4, 0.4], [0.4, 0.4]].map(([x, y]) => at(x * W, y * H));
      for (const p of sp) if (this.hidden(p, blk)) occ++;
      out.push({ kind, down: rig.down, rect: pr.map(r3), hf: r3(y1 - y0), overFace, overScreen, occ: occ / sp.length, source: pl.source, failed: !!slot?.failed });
    }
    return out;
  }

  buddy() {
    const ch = this.chat as { buddy?: { shown: boolean; tabletPoints(): THREE.Vector3[] | null; plan?: { mode: string } | null } | null };
    const b = ch.buddy;
    if (!this.rt.state.chat?.buddy || !b) return null;
    const cam = this.cam();
    const pts = b.shown ? b.tabletPoints() : null;
    if (!pts) return { shown: b.shown, mode: b.plan?.mode ?? null, inFrame: false, hf: 0, occ: 1 };
    const pr = pts.map((p) => p.clone().project(cam));
    const inFrame = pr.every((q) => q.z > -1 && q.z < 1 && Math.abs(q.x) < 0.99 && Math.abs(q.y) < 0.99);
    const hf = (Math.max(...pr.map((q) => q.y)) - Math.min(...pr.map((q) => q.y))) / 2;
    const blk = this.blockers(null).filter((o) => !/^vtp:chat:tablet|buddy|skinned/.test(o.name));
    let occ = 0;
    for (const p of pts) if (this.hidden(p, blk)) occ++;
    return { shown: b.shown, mode: b.plan?.mode ?? null, inFrame, hf: r3(hf), occ: occ / pts.length };
  }

  /** Full report for the current frame. `kind` sets the thresholds; `subjects` = the member keys the shot frames (the
   *  framing guarantee's face-safe check, every kind); `strict` = a cut / fringe face in a wide is severe too. */
  /** Each performer's posed mesh, baked once per measured frame (exact occlusion: the boxes only say "maybe"). */
  private stamp = 0;
  private posed = new Map<SceneActor, { stamp: number; bvh: MeshBVH | null; geo: THREE.BufferGeometry | null }>();
  private posedOf(a: SceneActor): MeshBVH | null {
    const c = this.posed.get(a);
    if (c && c.stamp === this.stamp) return c.bvh;
    c?.geo?.dispose();
    let bvh: MeshBVH | null = null, geo: THREE.BufferGeometry | null = null;
    try {
      const meshes: THREE.Mesh[] = [];
      const root = a.runtime?.model;
      if (root) {
        root.updateMatrixWorld(true);
        root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && !(o as THREE.Points).isPoints && !(o as THREE.Line).isLine && m.geometry?.attributes?.position && visibleChain(m) && !seeThrough(m)) meshes.push(m); });
      }
      if (meshes.length) {
        const gen = new StaticGeometryGenerator(meshes);
        gen.attributes = ['position'];
        geo = gen.generate();
        bvh = new MeshBVH(geo);
      }
    } catch { bvh = null; geo?.dispose(); geo = null; }
    this.posed.set(a, { stamp: this.stamp, bvh, geo });
    return bvh;
  }

  measure(kind: ShotKind, opts: { void?: boolean; subjects?: string[]; strict?: boolean; picture?: number[][] } = {}) {
    this.stamp++;
    if (kind === 'solo' && this.rt.state.mode === 'react' && this.rt.layout() === 'big') kind = 'react';   // (auto fell back to the big screen)
    const cam = this.cam();
    const faces = this.faces(kind);
    const set = this.setRays();
    const vd = opts.void === false ? null : this.voidFraction();
    const screen = this.screen();
    const sr = screen && 'rect' in screen ? screen.rect ?? null : null;
    const props = this.props(faces, sr);
    const buddy = this.buddy();
    const issues: Issue[] = [];
    const add = (sev: 1 | 2 | 3, code: string, msg: string) => issues.push({ sev, code, msg });
    // ---- the set
    if (vd && vd.frac > 0.002) add(vd.frac >= 0.03 ? 3 : vd.frac >= 0.008 ? 2 : 1, 'void', `${(vd.frac * 100).toFixed(1)}% of the frame shows nothing (void)`);
    if (set.outside >= 3) add(1, 'outside', `camera outside the walls (dollhouse view: ${set.outside}/10 directions) — fine while nothing unmodelled shows`);
    else if (set.culled > 0.1) add(1, 'backface', `${(set.culled * 100).toFixed(0)}% of view rays pass the back of a big surface`);
    if (set.inside) add(3, 'inside', 'camera is inside geometry');
    if (set.near > 0.12) add(2, 'clutter', `${(set.near * 100).toFixed(0)}% of the frame is blocked right in front of the lens`);
    // ---- performers
    const focus = faces.find((f) => f.focus) ?? faces[0];
    for (const f of faces) {
      const main = opts.subjects ? opts.subjects.includes(f.key) : kind === 'talk' || kind === 'solo' || kind === 'single' || kind === 'tile' || kind === 'ttrpg' ? f.focus : kind === 'group' || kind === 'react' || kind === 'wide' || kind === 'preset' || kind === 'two' || kind === 'establishing' ? true : f.focus;
      // ---- framing guarantee: a framed face inside its family's evaluation line, its head top never cut
      const fsev = FACE_SAFE_SEV[kind];
      const evalArea = safeFor(FAMILY_OF[kind], this.rt.framing.safe).evalArea;
      if (main && fsev && !f.cut && !(kind === 'react' && this.rt.layout() === 'big')) {
        const o = boxOverflow({ x0: f.box[0], x1: f.box[1], y0: f.box[2], y1: f.box[3] }, evalArea);
        if (o > 0.002) add(fsev, 'face-safe', `${f.key}@${f.spot} face on the fringe of the frame (${o.toFixed(3)} outside the ${FAMILY_OF[kind]} safe area)`);
        else if (f.headY > 1.005 && (kind !== 'tile')) add(kind === 'talk' || kind === 'single' || kind === 'ttrpg' ? 2 : 1, 'head-cut', `${f.key}@${f.spot} head top cut by the frame (${f.headY.toFixed(3)})`);
      }
      if (main && f.cut && opts.strict && (kind === 'wide' || kind === 'preset') && f.cut !== 'behind' && f.cut !== 'out') add(3, 'cut', `${f.key}@${f.spot} face cut at the ${f.cut} (strict)`);
      if (opts.subjects && !main) continue;
      if (kind === 'follow' && !f.focus) continue;
      if (kind === 'talk' && !f.focus) {
        // a neighbour in a talk shot: fine unless they hide the subject (the subject's own occlusion reports that)
        continue;
      }
      if (kind === 'react' && this.rt.layout() === 'big') {
        // the big react shot is about the screen (a fixed frame: OBS captures line up with it); audience heads along the
        // bottom edge are the cinema look
        if (f.cut === 'behind' || f.cut === 'out') continue;
        if (f.cut === 'bottom') { add(1, 'cut', `${f.key}@${f.spot} head along the bottom edge`); continue; }
      }
      if (f.cut && main) add(kind === 'preset' || kind === 'ambient' ? 1 : kind === 'wide' ? 2 : 3, 'cut', `${f.key}@${f.spot} face ${f.cut === 'behind' || f.cut === 'out' ? 'not in frame' : `cut at the ${f.cut}`}`);
      if (!f.cut && f.occ >= 0.33) add(kind === 'preset' || kind === 'ambient' ? 1 : f.focus || kind === 'group' || (opts.subjects && main) ? 3 : 2, 'occluded', `${f.key}@${f.spot} face ${Math.round(f.occ * 100)}% hidden by ${f.occBy.join('/')}`);
      else if (!f.cut && f.occ > 0) add(1, 'occluded', `${f.key}@${f.spot} face partly hidden by ${f.occBy.join('/')}`);
      if (!f.cut && f.occMover >= 0.33 && (f.focus || kind === 'group' || (opts.subjects && main))) add(2, 'mover', `${f.key}@${f.spot} face ${Math.round(f.occMover * 100)}% hidden for a moment by a moving room part`);
      if (!f.cut && (kind === 'talk' || kind === 'solo' || kind === 'single' || kind === 'ttrpg') && (opts.subjects ? main : f.focus)) {
        if (f.hf < (kind === 'solo' ? 0.05 : 0.09)) add(2, 'small', `talk face only ${(f.hf * 100).toFixed(0)}% of the frame height`);
        if (f.hf > 0.32) add(f.hf > 0.45 ? 2 : 1, 'tight', `talk face ${(f.hf * 100).toFixed(0)}% of the frame height (tight)`);
        if (kind === 'talk' && f.top < 0.03) add(2, 'headroom', 'no head room');
        if (kind === 'talk' && f.v > 0.52) add(2, 'headroom', `face low in the frame (v=${f.v.toFixed(2)}): too much head room`);
        if (f.facing > 100) add(3, 'back', `talk shot sees the back of ${f.key}'s head (${f.facing}°)`);
        else if (f.facing > 72) add(2, 'profile', `talk shot sees ${f.key} in profile (${f.facing}°)`);
        if (kind === 'talk' && f.lead !== null && f.lead < 0.3) add(1, 'lead', `looking towards the near frame edge (lead ${f.lead.toFixed(2)})`);
      }
      if (!f.cut && (kind === 'group')) {
        // (a room-wide group of 9–12 spread over the set can't be closer than ~2% per face)
        const minHf = faces.length <= 4 ? 0.04 : faces.length <= 8 ? 0.028 : 0.019;
        if (f.hf < minHf) add(2, 'small', `${f.key}@${f.spot} face only ${(f.hf * 100).toFixed(1)}% of the frame height`);
        if (f.facing > 110) add(2, 'back', `group shot sees the back of ${f.key}@${f.spot}`);
      }
    }
    if (kind === 'group' && faces.length) {
      const us = faces.filter((f) => !f.cut).map((f) => f.u);
      if (us.length) { const c = (Math.min(...us) + Math.max(...us)) / 2; if (Math.abs(c - 0.5) > 0.12) add(1, 'balance', `group off-centre (${c.toFixed(2)})`); }
      const tops = faces.filter((f) => !f.cut).map((f) => f.top);
      if (tops.length && Math.min(...tops) > 0.4) add(1, 'headroom', 'group sits low in the frame (lots of head room)');
    }
    if ((kind === 'talk' || kind === 'solo') && !focus) add(3, 'nobody', 'no performer in the shot');
    if (opts.subjects) for (const k of opts.subjects) if (!faces.some((f) => f.key === k)) add(3, 'nobody', `${k} (a subject) is not shown`);
    // ---- a picture the shot frames (the call-in monitor): in a two-shot its 4 corners inside the safe area, in its own
    // close-up never cut by the frame
    if (opts.picture?.length) {
      const q = opts.picture.map((p) => new THREE.Vector3(p[0], p[1], p[2]).project(cam));
      const lim = kind === 'monitor' ? { x: 1, top: 1, bottom: 1 } : safeFor(FAMILY_OF[kind], this.rt.framing.safe).evalArea;
      const o = q.some((v) => v.z > 1) ? 1 : Math.max(0, ...q.map((v) => Math.max(Math.abs(v.x) - lim.x, v.y - lim.top, -lim.bottom - v.y)));
      if (o > 0.002) add(3, 'picture-safe', `the call-in picture ${kind === 'monitor' ? 'is cut by the frame' : 'is outside the safe area'} (${o.toFixed(3)})`);
    }
    // ---- moving set pieces in the ray tests (a scrolling world, a transforming desk): the shot solver would jitter
    const mv = this.movingOccluders();
    if (mv.length) add(3, 'moving-occluder', `${mv.length} moving mesh(es) are in the room's occluders (${mv.slice(0, 3).join(', ')})`);
    // (an occluder that moved since the last frame measured — an engine animating a room part that is still ray-tested:
    // shots solved at different moments / on different pages could differ; a note for the room's engine)
    const mm = this.movedOccluders();
    if (mm.length) add(1, 'moved-occluder', `${mm.length} occluder(s) moved since the last frame (${mm.slice(0, 3).join(', ')})`);
    // ---- react screen
    if (screen) {
      if ('missing' in screen) add(3, 'screen', 'react mode but no screen');
      else {
        if (!screen.visible) add(3, 'screen', 'react screen not fully in frame');
        if (screen.occ > 0.05) add(screen.occ > 0.2 ? 3 : 2, 'screen', `react screen ${Math.round(screen.occ * 100)}% hidden`);
        if (screen.layout === 'big' && screen.fill < 0.3) add(2, 'screen', `react screen fills only ${Math.round(screen.fill * 100)}% of the frame`);
        if (screen.layout === 'solo' && (screen.wfrac < 0.4 || screen.wfrac > 0.8)) add(2, 'screen', `solo screen ${Math.round(screen.wfrac * 100)}% of the width`);
      }
    }
    // ---- chat props
    for (const p of kind === 'follow' ? [] : props) {
      if (!p.rect) { add(p.failed && this.rt.state.mode !== 'react' ? 2 : 1, 'prop', `chat ${p.kind}: ${p.failed ? 'no place found for this shot' : 'not placed yet'}`); continue; }
      const out = p.rect[0] < 0 || p.rect[1] < -0.05 || p.rect[2] > 1 || p.rect[3] > 1;
      if (out) add(2, 'prop', `chat ${p.kind} not fully in frame`);
      if (p.overFace) add(3, 'prop', `chat ${p.kind} over a face`);
      if (p.overScreen) add(3, 'prop', `chat ${p.kind} over the react screen`);
      if (p.occ > 0.2) add(2, 'prop', `chat ${p.kind} ${Math.round(p.occ * 100)}% hidden`);
      if (p.hf < (p.kind === 'monitor' ? 0.2 : 0.12)) add(1, 'prop', `chat ${p.kind} small (${Math.round(p.hf * 100)}% of the height)`);
    }
    return {
      kind, camKey: this.rt.state.camera, mode: this.rt.state.mode, layout: this.rt.layout(),
      cam: { pos: cam.position.toArray().map(r3), dir: cam.getWorldDirection(new THREE.Vector3()).toArray().map(r3), fov: r3(cam.fov) },
      faces, set: { culled: r3(set.culled), near: r3(set.near), open: r3(set.open), inside: set.inside, outside: set.outside, void: vd ? r3(vd.frac) : null, grid: set.grid },
      screen, props, buddy, issues, score: issues.reduce((a, i) => a + i.sev * i.sev, 0),
    };
  }

  private occSnap = new Map<THREE.Mesh, number[]>();
  /** Occluders whose world matrix changed since the previous call (a room engine animating a ray-tested part). */
  movedOccluders(): string[] {
    const out: string[] = [];
    const seen = new Set<THREE.Mesh>();
    for (const m of this.rt.room.occluders) {
      seen.add(m);
      const e = m.matrixWorld.elements, prev = this.occSnap.get(m);
      if (prev && prev.some((v, i) => Math.abs(v - e[i]) > 1e-6)) out.push(m.name || m.parent?.name || 'mesh');
      this.occSnap.set(m, e.slice());
    }
    for (const k of [...this.occSnap.keys()]) if (!seen.has(k)) this.occSnap.delete(k);
    return out;
  }
  /** Room occluders under a moving group (userData.vtpMoving, or the voyage world `vtp:voyage:world`): the shot solver,
   *  cam_eval and the follow planner must never ray-test the scrolling world (docs: moving rooms render in the ship frame). */
  movingOccluders(): string[] {
    const out: string[] = [];
    for (const m of this.rt.room.occluders) {
      for (let p: THREE.Object3D | null = m; p; p = p.parent) if (p.userData?.vtpMoving || p.name === 'vtp:voyage:world') { out.push(m.name || 'mesh'); break; }
    }
    return out;
  }

  /** Motion stress (moving rooms): the framed faces measured at every extreme of a motion envelope (the deck pitching /
   *  rolling / heaving relative to the camera, a camera kick) — the worst overflow outside title safe and who. Pure
   *  projection of the current camera, perturbed; the camera itself is restored. */
  stress(env: MotionEnvelope | null, subjects?: string[], kind: ShotKind = 'talk'): { worst: number; who: string; phases: number } {
    const m = sanitizeMotion(env);
    const area = safeFor(FAMILY_OF[kind], this.rt.framing.safe).evalArea;
    const cam = this.cam();
    if (!m) return { worst: 0, who: '', phases: 0 };
    const keep = { p: cam.position.clone(), q: cam.quaternion.clone() };
    let worst = 0, who = '', n = 0;
    const shown = [...this.rt.actors.values()].filter((a) => a.shown && a.runtime && a.mount.visible && (!subjects || subjects.includes(a.key)));
    try {
      for (const sp of [-1, 1]) for (const sy of [-1, 1]) for (const sr of [-1, 1]) for (const sh of [-1, 1]) {
        cam.position.copy(keep.p); cam.quaternion.copy(keep.q);
        const r = new THREE.Vector3(1, 0, 0).applyQuaternion(keep.q), f = new THREE.Vector3(0, 0, -1).applyQuaternion(keep.q);
        cam.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(r, sp * (m.pitch + m.kick) * Math.PI / 180));
        cam.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(UP, sy * m.yaw * Math.PI / 180));
        cam.quaternion.premultiply(new THREE.Quaternion().setFromAxisAngle(f, sr * m.roll * Math.PI / 180));
        cam.position.y += sh * m.heave;
        cam.updateMatrixWorld();
        n++;
        const right = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.quaternion);
        for (const a of shown) {
          const fi = drawnFace(a.runtime);
          if (!fi) continue;
          const c = fi.center, s = fi.size;
          const q = [c.clone().addScaledVector(right, s * FACE_BOX.side), c.clone().addScaledVector(right, -s * FACE_BOX.side), c.clone().addScaledVector(UP, s * FACE_BOX.up), c.clone().addScaledVector(UP, -s * FACE_BOX.down)].map((p) => p.project(cam));
          if (q.some((v) => v.z > 1)) continue;
          const o = boxOverflow({ x0: Math.min(...q.map((v) => v.x)), x1: Math.max(...q.map((v) => v.x)), y0: Math.min(...q.map((v) => v.y)), y1: Math.max(...q.map((v) => v.y)) }, area);
          if (o > worst) { worst = o; who = a.key; }
        }
      }
    } finally { cam.position.copy(keep.p); cam.quaternion.copy(keep.q); cam.updateMatrixWorld(); }
    return { worst: r3(worst), who, phases: n };
  }

  /** Remote studios (interview guests on the monitor, src/scene/talkshow/remote.ts): each guest's face box in its own
   *  panel camera — inside the panel's title safe, the backdrop behind the whole head. `engine` = window.vtpInterview. */
  remote(engine: unknown): { key: string; box: number[]; over: number; backdrop: boolean }[] {
    const rs = (engine as { remote?: { slots?: Map<string, { cam: THREE.PerspectiveCamera; face: THREE.Vector3 | null; set: THREE.Object3D; index: number }> } } | null)?.remote;
    const out: { key: string; box: number[]; over: number; backdrop: boolean }[] = [];
    if (!rs?.slots) return out;
    for (const [key, s] of rs.slots) {
      const a = this.rt.actors.get(key);
      const f = drawnFace(a?.runtime);
      if (!f || !s.face) continue;
      s.cam.updateMatrixWorld(); s.cam.updateProjectionMatrix();
      const right = new THREE.Vector3(1, 0, 0).applyQuaternion(s.cam.quaternion);
      const q = [f.center.clone().addScaledVector(right, f.size * FACE_BOX.side), f.center.clone().addScaledVector(right, -f.size * FACE_BOX.side), f.center.clone().addScaledVector(UP, f.size * FACE_BOX.up), f.center.clone().addScaledVector(UP, -f.size * FACE_BOX.down)].map((p) => p.project(s.cam));
      const box = [Math.min(...q.map((v) => v.x)), Math.max(...q.map((v) => v.x)), Math.min(...q.map((v) => v.y)), Math.max(...q.map((v) => v.y))];
      // the cyclorama (radius 2.6 m x scale, 3.4 m tall from 1.4 - 1.7) reaches above the head top
      const r0 = a!.rest, dyr = r0?.drawn ? (r0.face.center.y - r0.drawn.center.y) * a!.scale : 0, top = r0?.head ? r0.head.top * a!.scale + dyr : f.size * 1.2;
      const setTop = s.set.position.y + (1.4 + 1.7) * s.set.scale.y;
      out.push({ key, box: box.map(r3), over: r3(boxOverflow({ x0: box[0], x1: box[1], y0: box[2], y1: box[3] }, safeFor('remote', this.rt.framing.safe).evalArea)), backdrop: f.center.y + top < setTop });
    }
    return out;
  }
}

/** Test pages: the framing guarantee's ray budget times `mul` (1 = as shipped) — probes of what a bigger one would find. */
export function setGuardBudget(mul: number): number { FrameGuard.budgetMul = Number.isFinite(mul) && mul > 0 ? mul : 1; return FrameGuard.budgetMul; }

/** Test pages: the framing guarantee's ladder statistics on this page since the last reset (FrameGuard.stats). */
export function guardStats(reset = false) {
  const s = { ...FrameGuard.stats };
  if (reset) Object.assign(FrameGuard.stats, { ladders: 0, raysMax: 0, raysSum: 0, msMax: 0, msSum: 0, capped: 0 });
  return { ladders: s.ladders, raysMax: s.raysMax, raysAvg: s.ladders ? Math.round(s.raysSum / s.ladders) : 0, msMax: +s.msMax.toFixed(1), msAvg: s.ladders ? +(s.msSum / s.ladders).toFixed(2) : 0, capped: s.capped };
}

/** Test pages: the framing guarantee on / off on this page (before / after comparisons). Clears the shot caches. */
export function setGuard(on: boolean, rt?: SceneRuntime | null): void {
  FrameGuard.off = !on;
  try { (rt as unknown as { shotCache?: Map<string, unknown> } | null)?.shotCache?.clear(); } catch { /* */ }
}

/** Test pages: the motion envelope the framing guarantee works with (SceneRuntime.motionHook), or null to clear it.
 *  Only when no room engine owns the hook (the voyage engine sets its own). */
export function setTestMotion(env: MotionEnvelope | null): boolean {
  const m = sanitizeMotion(env);
  const cur = SceneRuntime.motionHook as (((rt: SceneRuntime, f: string) => MotionEnvelope | null) & { test?: boolean }) | null;
  if (cur && !cur.test) return false;
  if (!m) { SceneRuntime.motionHook = null; return true; }
  const hook = Object.assign(() => m, { test: true });
  SceneRuntime.motionHook = hook;
  return true;
}

/** Room facts the harness needs (spots, cameras, door, path) — world space. */
export function roomFacts(rt: SceneRuntime) {
  const r = rt.room;
  const v = (p: THREE.Vector3) => p.toArray().map(r3);
  return {
    id: rt.info.id,
    spots: r.spots.map((s) => s && { i: s.index + 1, label: s.label, pose: s.pose, pos: v(s.position), yaw: r3(THREE.MathUtils.radToDeg(s.yaw)), cam: !!s.cam }),
    cameras: [...r.cameras.keys()],
    choices: rt.cameraNames(),
    door: r.doorOutside ? v(r.doorOutside.position) : null,
    path: r.path.map(v),
    screen: !!r.screen,
    bounds: r.bounds.isEmpty() ? null : [v(r.bounds.min), v(r.bounds.max)],
  };
}
