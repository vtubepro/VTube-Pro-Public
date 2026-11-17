// The user's Room editor layer on a loaded room (docs/ROOM_EDITOR.md, shared/roomEdits.ts). SceneRuntime calls these:
//   snapshotRoom(room)              when the room has loaded, before scene.json touches it: the room as authored
//   applyRoomExtras(rt-ish)         what plain scene.json keys can't do: the react SCREEN moved / turned / scaled, solo
//                                   screens over a SCREEN_SOLO_xx node, the room's own CHAT_* anchors for edited spots
//   restoreRoom(room, pristine)     before a hot re-apply (a Save while the room is up): back to the authored room
//                                   (also the room's own objects the layer hid / moved: src/scene/roomObjects.ts)
//   PlacedProps                     the placed props: loaded once per model, drawn INSTANCED (one draw per mesh of a
//                                   model, whatever the number of copies), within the graphics level's triangle budget,
//                                   plus invisible ray proxies in room.occluders (the cameras, the framing guarantee and
//                                   the chat props treat a prop like any piece of furniture)
//   tweakPose(pose, tweak, pivot)   the live camera quick-adjust on top of a resolved shot
//   PlacedProps.tick(t)             every frame: light props (LIGHT_* in a prop's .glb, shared/propLights.ts) flicker /
//                                   pulse / strobe, within PROP_LIGHT_BUDGET real lights per room; the rest glow only
//                                   (EMIT_*); every animated lamp through the page's flash governor (Safe flashes)
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { GfxLevel } from '../../shared/graphics.ts';
import { propsInBudget, spotKey, type CamTweak, type PlacedProp, type ScreenEdit, type V3 } from '../../shared/roomEdits.ts';
import type { PropItem } from '../../shared/propPacks.ts';
import { PROP_LIGHT_BUDGET, glowLamp, lightExtras, propGlowLevel, propLightLevel, propLightPhase, propLightRed, propLightSpec, propLightsInBudget, type LightLike, type PropLightSpec } from '../../shared/propLights.ts';
import { GOV, govChannel, pageGovernor, type GovChannel } from '../../shared/flashGovernor.ts';
import type { CameraPreset, RoomInfo } from './contract.ts';
import type { CamPose } from './cameraRig.ts';
import { applyRoomObjects, newObjectsPristine, restoreRoomObjects, type ObjectsPristine } from './roomObjects.ts';

// ---------------------------------------------------------------- the authored room
interface SpotSnap { position: THREE.Vector3; forward: THREE.Vector3; yaw: number; cam: CameraPreset | null; approach: THREE.Vector3[] }
export interface RoomPristine {
  cams: Map<string, CameraPreset>;
  spots: (SpotSnap | null)[];
  screen: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3; shown: THREE.Vector3; worldScale: THREE.Vector3; roomPos: THREE.Vector3; roomQuat: THREE.Quaternion } | null;
  solo: Map<number, { center: THREE.Vector3; yaw: number; width: number }>;
  /** CHAT_* anchor nodes an edit parked (renamed `~NAME`), with their own names. */
  parked: Map<THREE.Object3D, string>;
  /** The room's own objects the layer hid / moved (their authored state, taken when first touched). */
  objects: ObjectsPristine;
}
const clonePreset = (c: CameraPreset): CameraPreset => ({ name: c.name, position: c.position.clone(), quaternion: c.quaternion.clone(), fov: c.fov, ...(c.live ? { live: c.live } : {}) });   // (a live camera stays live: contract.ts)

export function snapshotRoom(room: RoomInfo): RoomPristine {
  room.root.updateMatrixWorld(true);
  let screen: RoomPristine['screen'] = null;
  if (room.screen) {
    const n = room.screen.node;
    const rootInv = room.root.matrixWorld.clone().invert();
    const rel = rootInv.multiply(n.matrixWorld);
    const roomPos = new THREE.Vector3(), roomQuat = new THREE.Quaternion(), worldScale = new THREE.Vector3();
    rel.decompose(roomPos, roomQuat, worldScale);
    screen = { position: n.position.clone(), quaternion: n.quaternion.clone(), scale: n.scale.clone(), shown: room.screen.shownPosition.clone(), worldScale, roomPos, roomQuat };
  }
  return {
    cams: new Map([...room.cameras].map(([k, c]) => [k, clonePreset(c)])),
    spots: room.spots.map((s) => (s ? { position: s.position.clone(), forward: s.forward.clone(), yaw: s.yaw, cam: s.cam ? clonePreset(s.cam) : null, approach: s.approach.map((p) => p.clone()) } : null)),
    screen,
    solo: new Map([...room.soloScreens].map(([k, v]) => [k, { center: v.center.clone(), yaw: v.yaw, width: v.width }])),
    parked: new Map(),
    objects: newObjectsPristine(),
  };
}

/** Back to the room as authored (before scene.json and the user's layer): cameras, spots, the screen, solo screens, chat
 *  anchors, the room's own objects. SpotInfo / RoomInfo objects stay the same objects (actors and engines hold them).
 *  Returns the room objects it put back (their ray rest poses need taking again). */
export function restoreRoom(room: RoomInfo, p: RoomPristine): THREE.Object3D[] {
  room.cameras.clear();
  for (const [k, c] of p.cams) room.cameras.set(k, clonePreset(c));
  room.spots.forEach((s, i) => {
    const q = p.spots[i];
    if (!s || !q) return;
    s.position.copy(q.position); s.forward.copy(q.forward); s.yaw = q.yaw;
    s.cam = q.cam ? clonePreset(q.cam) : null;
    s.approach = q.approach.map((v) => v.clone());
  });
  if (room.screen && p.screen) {
    const n = room.screen.node;
    n.position.copy(p.screen.position); n.quaternion.copy(p.screen.quaternion); n.scale.copy(p.screen.scale);
    room.screen.shownPosition.copy(p.screen.shown);
  }
  room.soloScreens.clear();
  for (const [k, v] of p.solo) room.soloScreens.set(k, { center: v.center.clone(), yaw: v.yaw, width: v.width });
  for (const [o, name] of p.parked) o.name = name;
  p.parked.clear();
  const back = restoreRoomObjects(room, p.objects);
  room.root.updateMatrixWorld(true);
  return back;
}

const d2r = THREE.MathUtils.degToRad;
export const eulerOf = (rot: V3) => new THREE.Euler(d2r(rot[0]), d2r(rot[1]), d2r(rot[2]), 'YXZ');
export const rotOf = (q: THREE.Quaternion): V3 => { const e = new THREE.Euler().setFromQuaternion(q, 'YXZ'); return [e.x, e.y, e.z].map((r) => Math.round(THREE.MathUtils.radToDeg(r) * 100) / 100) as V3; };

/** The react SCREEN where the user put it: room-space position + rotation, scale on top of the authored size. */
export function placeScreen(room: RoomInfo, p: RoomPristine, e: ScreenEdit | null | undefined) {
  if (!room.screen || !p.screen || !e) return;
  const n = room.screen.node;
  room.root.updateMatrixWorld(true);
  const want = new THREE.Matrix4().compose(new THREE.Vector3(...e.pos), new THREE.Quaternion().setFromEuler(eulerOf(e.rot)), p.screen.worldScale.clone().multiplyScalar(e.scale));
  const world = room.root.matrixWorld.clone().multiply(want);
  const local = (n.parent ? n.parent.matrixWorld.clone().invert() : new THREE.Matrix4()).multiply(world);
  local.decompose(n.position, n.quaternion, n.scale);
  room.screen.shownPosition.copy(n.position);
  n.updateMatrixWorld(true);
}

/** The parts of the merged layer plain scene.json keys can't express (called after cams / cameraOverrides /
 *  spotOverrides were applied): the screen, solo screens over authored SCREEN_SOLO nodes, the room's own CHAT_* anchors
 *  parked for spots the user placed a chat display for (the user's place wins), the room's own objects hidden / moved. */
export function applyRoomExtras(room: RoomInfo, p: RoomPristine, info: { screenEdit?: unknown; soloScreens?: unknown; userEdits?: { soloScreens?: Record<string, unknown>; chatMonitors?: Record<string, unknown>; chatBoards?: Record<string, unknown>; buddySpots?: Record<string, unknown>; hiddenObjects?: unknown; movedObjects?: unknown } }) {
  placeScreen(room, p, info.screenEdit as ScreenEdit | undefined);
  const ue = info.userEdits;
  if (!ue) return;
  applyRoomObjects(room, p.objects, ue);          // the room's own objects hidden / moved (src/scene/roomObjects.ts)
  for (const [k, v] of Object.entries(ue.soloScreens ?? {})) {
    const m = /^SPOT_(\d\d)$/.exec(k);
    const o = v as { position?: V3; yaw?: number; width?: number };
    if (!m || !o?.position) continue;
    room.soloScreens.set(+m[1] - 1, { center: room.root.localToWorld(new THREE.Vector3(...o.position)), yaw: d2r(o.yaw ?? 0), width: THREE.MathUtils.clamp(o.width ?? 2.4, 0.8, 5) });
  }
  const park = (kind: string, rec: Record<string, unknown> | undefined) => {
    for (const k of Object.keys(rec ?? {})) {
      const xx = /^SPOT_(\d\d)$/.exec(k)?.[1];
      if (!xx) continue;
      room.root.traverse((o) => { if (o.name === `${kind}_${xx}`) { p.parked.set(o, o.name); o.name = `~${o.name}`; } });
    }
  };
  park('CHAT_MONITOR', ue.chatMonitors);
  park('CHAT_BOARD', ue.chatBoards);
  park('BUDDY_SPOT', ue.buddySpots);
  park('CHAT_BUDDY', ue.buddySpots);
}

// ---------------------------------------------------------------- live camera quick-adjust
/** A resolved shot with the user's tweak for that angle: orbit / tilt round a pivot `pivotDist` m in front of the lens,
 *  dolly along the view, height (aim kept level), lens. Pure: the same pose on every page. */
export function tweakPose(pose: CamPose, t: CamTweak, pivotDist: number): CamPose {
  const fwd = new THREE.Vector3(0, 0, -1).applyQuaternion(pose.quaternion).normalize();
  const d = THREE.MathUtils.clamp(pivotDist, 0.5, 40);
  const pivot = pose.position.clone().addScaledVector(fwd, d);
  const off = pose.position.clone().sub(pivot);
  if (t.orbit) off.applyAxisAngle(new THREE.Vector3(0, 1, 0), d2r(t.orbit));
  if (t.tilt) {
    const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0));
    if (right.lengthSq() > 1e-6) {
      right.normalize();
      // (+ = from higher; never past 80° from level)
      const cur = Math.asin(THREE.MathUtils.clamp(off.clone().normalize().y, -1, 1));
      const next = THREE.MathUtils.clamp(cur + d2r(t.tilt), d2r(-80), d2r(80));
      off.applyAxisAngle(right, -(next - cur));
    }
  }
  if (t.dolly) off.setLength(Math.max(0.3, off.length() - t.dolly));
  const lift = new THREE.Vector3(0, t.height || 0, 0);
  const pos = pivot.clone().add(off).add(lift), target = pivot.clone().add(lift);
  const m = new THREE.Matrix4().lookAt(pos, target, new THREE.Vector3(0, 1, 0));
  // (a pose that looked straight up / down keeps its own orientation)
  const q = Math.abs(fwd.y) > 0.995 && !t.orbit && !t.tilt ? pose.quaternion.clone() : new THREE.Quaternion().setFromRotationMatrix(m);
  return { position: pos, quaternion: q, fov: THREE.MathUtils.clamp(pose.fov + (t.fov || 0), 8, 100) };
}

// ---------------------------------------------------------------- placed props
const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder);
interface PropModel {
  parts: { geometry: THREE.BufferGeometry; material: THREE.Material | THREE.Material[]; matrix: THREE.Matrix4 }[]; tris: number; box: THREE.Box3;
  /** LIGHT_* nodes (model space) — the lamps of a light prop. */
  lights: { spec: PropLightSpec; matrix: THREE.Matrix4 }[];
}
/** One animated lamp of a placed model, an output on the page's flash governor: every copy's real light and glow of
 *  that lamp show its `level` (0..1) this frame. With Safe flashes on, `level` ramps from `from` to `to` over the slot
 *  `knot` (tick); `hi` / `lo` = the governed level's extremes in that slot. */
interface PropLightDrive { spec: PropLightSpec; phase: number; red: boolean; ch: GovChannel; level: number; from: number; to: number; hi: number; lo: number; knot: number }
/** Models by URL (shared by every runtime of the page; geometry is never disposed while the page lives — a room change
 *  back and forth must not re-download). */
const models = new Map<string, Promise<PropModel | null>>();
function loadModel(url: string): Promise<PropModel | null> {
  let p = models.get(url);
  if (!p) {
    p = loader.loadAsync(url).then((g) => {
      g.scene.updateMatrixWorld(true);
      const parts: PropModel['parts'] = [];
      const lights: PropModel['lights'] = [];
      let tris = 0;
      g.scene.traverse((o) => {
        if (/^LIGHT_/.test(o.name) && lights.length < 8) {
          // (a KHR_lights_punctual node is the light itself, or a group holding it: its values are the defaults)
          const kl = ((o as THREE.Light).isLight ? o : o.children.find((c) => (c as THREE.Light).isLight)) as LightLike | undefined;
          lights.push({ spec: propLightSpec(o.name, lightExtras(o.userData, kl)), matrix: o.matrixWorld.clone() });
        }
        const m = o as THREE.Mesh;
        if (!m.isMesh || (m as THREE.SkinnedMesh).isSkinnedMesh) return;
        parts.push({ geometry: m.geometry, material: m.material, matrix: m.matrixWorld.clone() });
        const idx = m.geometry.index;
        tris += Math.floor((idx ? idx.count : m.geometry.attributes.position?.count ?? 0) / 3);
      });
      const box = new THREE.Box3().setFromObject(g.scene);
      return { parts, tris, box, lights };
    }).catch((e) => { console.warn('[props] could not load', url, e); return null; });
    models.set(url, p);
  }
  return p;
}

let catalogP: Promise<Map<string, PropItem>> | null = null;
/** The prop catalog (GET /api/props), once per page; `fresh` re-reads it (a pack was installed). */
export function propCatalog(fresh = false): Promise<Map<string, PropItem>> {
  if (!catalogP || fresh) {
    catalogP = fetch('/api/props').then((r) => (r.ok ? r.json() : { items: [] })).then((j: { items?: PropItem[] }) => new Map((j.items ?? []).map((i) => [i.src, i])))
      .catch(() => new Map<string, PropItem>());
  }
  return catalogP;
}

export interface PropsHost { room: RoomInfo; root: THREE.Object3D; exposure: number; level: () => GfxLevel; changed: () => void }

/** The placed props of one room. `edit` mode (the Room editor) draws each copy as its own object so it can be picked and
 *  dragged; otherwise copies of a model are instanced. */
export class PlacedProps {
  readonly group = new THREE.Group();
  /** Real lights of light props: a pool that only grows while the room is up (a light count change recompiles every
   *  shader in the scene, so a Save that moves or removes a torch never does; unused lights sit at intensity 0). */
  private readonly lightGroup = new THREE.Group();
  private pool: { point: THREE.PointLight[]; spot: THREE.SpotLight[] } = { point: [], spot: [] };
  private lit: { light: THREE.PointLight | THREE.SpotLight; base: number; drv: PropLightDrive | null }[] = [];
  /** EMIT_* materials of drawn light props (this runtime's clones) and the lamp that drives each. */
  private glow = new Map<THREE.MeshStandardMaterial, { base: number; drv: PropLightDrive }>();
  /** The animated lamps drawn now, by `<model>#<lamp>`: each is one output on the page's flash governor, and every real
   *  light + glow of that lamp shows its governed level. Kept across re-syncs (a Save never resets a governor channel). */
  private drives = new Map<string, PropLightDrive>();
  /** Safe flashes off: the animated lamps summed, counted by the governor as one more output (tick). */
  private readonly areaCh = govChannel('prop lights summed');
  /** Per placement (edit mode): its object, for picking / the gizmo. */
  readonly objects = new Map<string, THREE.Object3D>();
  private proxies: THREE.Mesh[] = [];
  private mats = new Map<THREE.Material, THREE.Material>();
  private seq = 0;
  /** What the last sync drew / left out (editor + debug). */
  info = { placed: 0, drawn: 0, over: [] as string[], tris: 0, draws: 0, missing: [] as string[], lights: 0, lightsOver: 0 };
  /** The Room editor page: every runtime draws its props one object per copy (pickable). */
  static editAll = false;
  edit = PlacedProps.editAll;
  constructor(private host: PropsHost) {
    this.group.name = 'vtp:placedProps';
    host.root.add(this.group);
    this.lightGroup.name = 'vtp:propLights';
    host.root.add(this.lightGroup);
  }
  /** A material with the room's exposure applied (like the room's own materials), shared per source material. */
  private mat(m: THREE.Material): THREE.Material {
    let c = this.mats.get(m);
    if (!c) {
      c = m.clone();
      const sm = c as THREE.MeshStandardMaterial;
      if (sm.color && this.host.exposure !== 1) sm.color.multiplyScalar(this.host.exposure);
      this.mats.set(m, c);
    }
    return c;
  }
  private matOf(m: THREE.Material | THREE.Material[]) { return Array.isArray(m) ? m.map((x) => this.mat(x)) : this.mat(m); }

  /** Draw exactly `list` (replaces what was there). Resolves once every model is in. */
  async sync(list: PlacedProp[]): Promise<void> {
    const seq = ++this.seq;
    const cat = list.length ? await propCatalog() : new Map<string, PropItem>();
    const srcs = [...new Set(list.map((p) => p.src))];
    const got = new Map<string, PropModel | null>();
    await Promise.all(srcs.map(async (s) => { const it = cat.get(s); got.set(s, it ? await loadModel(it.file) : null); }));
    if (seq !== this.seq) return;                                   // a newer sync took over
    this.clear();
    const usable = list.filter((p) => got.get(p.src));
    const budget = propsInBudget(usable, (s) => got.get(s)?.tris ?? 0, (s) => got.get(s)?.parts.length ?? 1, this.host.level());
    const drawn = usable.filter((p) => budget.drawn.has(p.uid));
    this.info = { placed: list.length, drawn: drawn.length, over: budget.over, tris: budget.tris, draws: budget.draws, missing: list.filter((p) => !got.get(p.src)).map((p) => p.src), lights: 0, lightsOver: 0 };
    const bySrc = new Map<string, PlacedProp[]>();
    for (const p of drawn) { const a = bySrc.get(p.src) ?? []; a.push(p); bySrc.set(p.src, a); }
    for (const [src, ps] of bySrc) {
      const model = got.get(src)!;
      if (this.edit) {
        for (const p of ps) {
          const o = new THREE.Group();
          o.name = `prop:${p.uid}`;
          o.userData.vtpProp = p.uid; o.userData.vtpSrc = p.src;
          placeObject(o, p);
          for (const part of model.parts) {
            const m = new THREE.Mesh(part.geometry, this.matOf(part.material));
            m.matrixAutoUpdate = false; m.matrix.copy(part.matrix);
            m.userData.vtpProp = p.uid;
            o.add(m);
            this.proxies.push(m);                                       // (edit mode: the drawn mesh is its own ray proxy)
          }
          this.group.add(o);
          this.objects.set(p.uid, o);
        }
        continue;
      }
      for (const part of model.parts) {
        const im = new THREE.InstancedMesh(part.geometry, this.matOf(part.material), ps.length);
        const pm = new THREE.Matrix4();
        ps.forEach((p, i) => { im.setMatrixAt(i, placementMatrix(p, pm).multiply(part.matrix)); });
        im.instanceMatrix.needsUpdate = true;
        im.computeBoundingSphere();
        im.castShadow = false; im.receiveShadow = false;
        im.name = `props:${src}`;
        this.group.add(im);
        // ray proxies: one invisible mesh per copy, the same geometry (its BVH is built once and shared)
        for (const p of ps) {
          const m = new THREE.Mesh(part.geometry, im.material);
          m.visible = false; m.matrixAutoUpdate = false;
          m.matrix.copy(placementMatrix(p, new THREE.Matrix4()).multiply(part.matrix));
          m.userData.vtpProp = p.uid;
          this.group.add(m);
          this.proxies.push(m);
        }
      }
    }
    this.group.updateMatrixWorld(true);
    this.host.room.occluders.push(...this.proxies);
    this.syncLights(drawn, (s) => got.get(s) ?? null);
    this.host.changed();
  }

  /** The real lights + glowing materials of the drawn light props. */
  private syncLights(drawn: PlacedProp[], model: (src: string) => PropModel | null) {
    const want: { key: string; src: string; i: number; spec: PropLightSpec; matrix: THREE.Matrix4; place: THREE.Matrix4 }[] = [];
    for (const p of drawn) {
      const m = model(p.src);
      m?.lights.forEach((l, i) => want.push({ key: `${p.uid}#${i}`, src: p.src, i, spec: l.spec, matrix: placementMatrix(p).multiply(l.matrix), place: placementMatrix(p) }));
    }
    // photosensitivity: ONE governed output per animated lamp of a MODEL (its phase from the model, + 0.37 per lamp). The
    // lamp's glow is one material shared by every copy, so every copy's real light shows the glow's level: a prop never
    // reads as a bulb and its light flashing out of step. Channels by key survive a re-sync.
    const drives = new Map<string, PropLightDrive>();
    const drive = (src: string, i: number, spec: PropLightSpec): PropLightDrive | null => {
      if (spec.effect === 'steady') return null;                    // (never changes: no governor step)
      const key = `${src}#${i}`;
      let d = drives.get(key);
      if (!d) {
        const old = this.drives.get(key);
        const at = { spec, phase: propLightPhase(src) + i * 0.37, red: propLightRed(spec.color) };
        d = old ? { ...old, ...at } : { ...at, ch: govChannel(`prop light ${key}`), level: 1, from: 1, to: 1, hi: 1, lo: 1, knot: NaN };
        drives.set(key, d);
      }
      return d;
    };
    const real = propLightsInBudget(want, PROP_LIGHT_BUDGET[this.host.level()] ?? 0);
    this.lit = [];
    const used = { point: 0, spot: 0 };
    const pos = new THREE.Vector3(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
    for (const w of want) {
      if (!real.has(w.key)) continue;
      const kind = w.spec.kind === 'spot' ? 'spot' : 'point';
      let l = this.pool[kind][used[kind]];
      if (!l) {
        l = kind === 'spot' ? new THREE.SpotLight(0xffffff, 0, 9, 0.35, 0.5, 2) : new THREE.PointLight(0xffffff, 0, 6, 2);
        l.name = `vtp:propLight:${kind}${used[kind]}`;
        l.castShadow = false;
        this.lightGroup.add(l);
        if (l instanceof THREE.SpotLight) this.lightGroup.add(l.target);
        (this.pool[kind] as THREE.Light[]).push(l);
      }
      used[kind]++;
      w.matrix.decompose(pos, q, sc);
      l.position.copy(pos);
      l.color.set(w.spec.color);
      l.distance = w.spec.range * Math.max(sc.x, sc.y, sc.z);
      if (l instanceof THREE.SpotLight) {
        l.angle = THREE.MathUtils.degToRad(Math.min(170, w.spec.angle)) / 2;
        l.penumbra = w.spec.penumbra;
        if (w.spec.target) l.target.position.set(...w.spec.target).applyMatrix4(w.place);
        else l.target.position.copy(pos).add(new THREE.Vector3(0, 0, -3).applyQuaternion(q));
      }
      const base = (kind === 'spot' ? 30 : 6) * w.spec.intensity;   // (the room light engine's units: src/scene/lights.ts)
      const drv = drive(w.src, w.i, w.spec);
      l.intensity = base * (drv ? drv.level : 1);
      this.lit.push({ light: l, base, drv });
    }
    for (const kind of ['point', 'spot'] as const) for (const l of this.pool[kind].slice(used[kind])) l.intensity = 0;
    this.info.lights = this.lit.length;
    this.info.lightsOver = want.filter((w) => w.spec.kind !== 'emissive').length - this.lit.length;
    // glow: every EMIT_<group> material of a drawn light prop follows the lamp of its group (else the first lamp)
    this.glow.clear();
    for (const src of new Set(drawn.map((p) => p.src))) {
      const m = model(src);
      if (!m?.lights.length) continue;
      for (const part of m.parts) {
        for (const src0 of Array.isArray(part.material) ? part.material : [part.material]) {
          const c = this.mats.get(src0) as THREE.MeshStandardMaterial | undefined;
          const lamp = c?.emissive && !this.glow.has(c) ? glowLamp(src0.name, m.lights) : null;
          const drv = lamp && drive(src, m.lights.indexOf(lamp), lamp.spec);
          if (c && drv) this.glow.set(c, { base: (c.userData.vtpGlowBase ??= c.emissiveIntensity) as number, drv });
        }
      }
    }
    this.drives = drives;
    this.lightGroup.updateMatrixWorld(true);
  }

  /** Every rendered frame (SceneRuntime.update): light props flicker / pulse / strobe through the page's flash governor
   *  (shared/flashGovernor.ts: with Safe flashes on, held to 3 flashes a second and the red rule; off, a faster one sets
   *  the OBS "Flashing lights" notice). Cheap: one governor step per animated lamp of a model, whatever the number of
   *  copies; steady lamps never touch the governor. `now` = epoch ms (the governor's clock). */
  tick(t: number, now = performance.timeOrigin + performance.now()) {
    if (!this.lit.length && !this.glow.size) return;
    if (this.drives.size) {
      const gov = pageGovernor(now);
      // Safe flashes on: each governed level is then redrawn as straight ramps between samples on ONE shared clock
      // (GOV.GAP slots of `now`, the governor's own plain slots). Samples are values the governed level really had, one
      // per slot, so a ramp never flashes more often or deeper than its lamp; and every prop lamp and glow ramps over
      // the same instants, so any number of them lighting one area together turn at most once a slot too: ≤ 3 flashes a
      // second for the area, not only for each light. (Each governed channel alone can't pass 3, but two moving
      // opposite ways between the governor's windows could, summed.)
      const knot = Math.floor(now / GOV.GAP), u = Math.min(1, (now - knot * GOV.GAP) / GOV.GAP);
      let sum = 0;
      for (const d of this.drives.values()) {
        const g = gov.step(d.ch, propLightLevel(d.spec, t, d.phase, gov.safe), d.red);   // (safe: SAFE_SPEED, a calm flicker)
        if (!gov.safe) { d.level = d.from = d.to = d.hi = d.lo = g; d.knot = knot; sum += g; continue; }
        if (knot !== d.knot) {
          // the new sample: of the slot just ended (its highest, its lowest, the level now), the value farthest from the
          // last sample, so a short governed flash between two samples is drawn (later and softer), never lost
          const ext = Math.abs(d.hi - d.to) >= Math.abs(d.lo - d.to) ? d.hi : d.lo;
          d.from = d.level; d.to = Math.abs(g - d.to) > Math.abs(ext - d.to) ? g : ext; d.knot = knot; d.hi = d.lo = g;
        } else { if (g > d.hi) d.hi = g; if (g < d.lo) d.lo = g; }
        d.level = d.from + (d.to - d.from) * u;
      }
      // Safe flashes off: the governor counts each lamp; the lamps summed (several props lighting one area out of step,
      // each under the limit alone) are one more output it counts, so the "Flashing lights" notice sees those too
      if (!gov.safe && this.drives.size > 1) gov.step(this.areaCh, sum / this.drives.size);
    }
    for (const l of this.lit) l.light.intensity = l.base * (l.drv ? l.drv.level : 1);
    for (const [m, g] of this.glow) m.emissiveIntensity = g.base * propGlowLevel(g.drv.level);
  }
  /** Edit mode, the same props (uids + models) moved / turned / scaled: updated in place (no reload, the gizmo keeps its
   *  object). false = a sync is needed. */
  update(list: PlacedProp[]): boolean {
    if (!this.edit || list.length !== this.objects.size || this.seq === 0) return false;
    for (const p of list) { const o = this.objects.get(p.uid); if (!o || o.userData.vtpSrc !== p.src) return false; }
    for (const p of list) placeObject(this.objects.get(p.uid)!, p);
    this.group.updateMatrixWorld(true);
    this.host.changed();
    return true;
  }
  /** Room-space box of a placed copy's model (before its placement), for the editor's checks. */
  static async boxOf(src: string): Promise<THREE.Box3 | null> {
    const it = (await propCatalog()).get(src);
    const m = it ? await loadModel(it.file) : null;
    return m ? m.box.clone() : null;
  }
  private clear() {
    const gone = new Set<THREE.Mesh>(this.proxies);
    if (gone.size) {
      const keep = this.host.room.occluders.filter((m) => !gone.has(m));
      this.host.room.occluders.length = 0;
      this.host.room.occluders.push(...keep);
    }
    this.proxies = [];
    for (const c of [...this.group.children]) { this.group.remove(c); if ((c as THREE.InstancedMesh).isInstancedMesh) (c as THREE.InstancedMesh).dispose(); }
    this.objects.clear();
  }
  dispose() {
    this.seq++;
    this.clear();
    this.group.removeFromParent();
    for (const l of [...this.pool.point, ...this.pool.spot]) { l.removeFromParent(); (l as THREE.SpotLight).target?.removeFromParent(); l.dispose(); }
    this.pool = { point: [], spot: [] }; this.lit = []; this.glow.clear(); this.drives.clear();
    this.lightGroup.removeFromParent();
    for (const m of this.mats.values()) m.dispose();
    this.mats.clear();
  }
}

/** The room-space matrix of a placement. */
export function placementMatrix(p: Pick<PlacedProp, 'pos' | 'rot' | 'scale'>, out = new THREE.Matrix4()): THREE.Matrix4 {
  return out.compose(new THREE.Vector3(...p.pos), new THREE.Quaternion().setFromEuler(eulerOf(p.rot)), new THREE.Vector3(p.scale, p.scale, p.scale));
}
export function placeObject(o: THREE.Object3D, p: Pick<PlacedProp, 'pos' | 'rot' | 'scale'>) {
  o.position.set(...p.pos); o.quaternion.setFromEuler(eulerOf(p.rot)); o.scale.setScalar(p.scale);
}

export const spotName = spotKey;
