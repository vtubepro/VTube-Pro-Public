// Where a model's joints are, found on the model itself: the import renders the unrigged model from the front (in this
// browser, offscreen) and runs MediaPipe Pose (the body tracker the studio already ships, /mediapipe) on the picture.
// Head, shoulders, elbows, wrists, hips, knees and ankles come back as image points; a ray through each one from the
// front finds where it enters and leaves the mesh, and the joint goes in the middle (so it sits inside the arm / leg,
// not on its surface). The joints feed the soft rig (src/avatar/softRig.ts, instant) and Blender's autorig
// (blender/autorig.py, the upgrade) through SoftRigConfig.joints. Creatures, blobs and objects (no person found, or
// an implausible one) fall back to the silhouette guess (guessSoftRig): a head + body rig that still leans and nods.
// No network: the pose model is the studio's own file. E2E: tools/model_import_e2e.mjs (rig lab).
import '../tracking/noTelemetry.ts'; // MediaPipe's usage logger never phones home
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { NormalizedLandmark } from '@mediapipe/tasks-vision';
import type { SoftJoint, SoftRigConfig, Vec3 } from '../../shared/types.ts';
import { guessSoftRig } from './softRig.ts';

const BASE = `${(import.meta as unknown as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/'}mediapipe`;

export interface JointFind {
  soft: SoftRigConfig;
  source: 'pose' | 'shape';
  /** Joints in the model's own units (after the import's fixes), for tests and the debug picture. */
  joints: Partial<Record<SoftJoint, [number, number, number]>>;
  /** Mean visibility of the landmarks used (0..1); 0 for the shape guess. */
  confidence: number;
  /** Why the pose wasn't used (shape fallback). */
  why?: string;
  /** The front render (data: URL) with the found joints drawn on, when asked for. */
  picture?: string;
}

type Lm = NormalizedLandmark;
let landmarker: Promise<{ detect(img: HTMLCanvasElement): { landmarks: Lm[][] } ; close(): void } | null> | null = null;

/** One IMAGE-mode pose landmarker, CPU (never competes with the live tracker on the GPU), made on first use. */
function poseModel() {
  landmarker ??= (async () => {
    try {
      const { FilesetResolver, PoseLandmarker } = await import('@mediapipe/tasks-vision');
      const fs = await FilesetResolver.forVisionTasks(`${BASE}/wasm`);
      return await PoseLandmarker.createFromOptions(fs, {
        baseOptions: { modelAssetPath: `${BASE}/pose_landmarker_full.task`, delegate: 'CPU' },
        runningMode: 'IMAGE', numPoses: 1, minPoseDetectionConfidence: 0.3, minPosePresenceConfidence: 0.3,
      });
    } catch (e) { console.warn('[poseJoints] pose model', e); landmarker = null; return null; }
  })();
  return landmarker;
}

async function loadRoot(src: ArrayBuffer | THREE.Object3D): Promise<{ root: THREE.Object3D; own: boolean }> {
  if (src instanceof THREE.Object3D) return { root: src, own: false };
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  const g = await loader.parseAsync(src, '');
  return { root: g.scene, own: true };
}

/** One renderer for every joint search (WebGL contexts are scarce: the studio, the preview and OBS pages use them). */
let shared: { r: THREE.WebGLRenderer; canvas: HTMLCanvasElement } | null = null;
function renderer(size: number) {
  if (!shared || shared.canvas.width !== size) {
    shared?.r.dispose();
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = size;
    const r = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true, alpha: false });
    r.setPixelRatio(1);
    r.setSize(size, size, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    shared = { r, canvas };
  }
  return shared;
}

type Frame = { x0: number; y0: number; w: number };

/** Front render of the model: orthographic, square, lit, plain background. Returns a 2D copy (the GL canvas is reused). */
function render(root: THREE.Object3D, box: THREE.Box3, size: number, flat: boolean): { canvas: HTMLCanvasElement; frame: Frame } {
  const { r, canvas: gl } = renderer(size);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(flat ? '#dfe3ea' : '#9aa3b0');
  scene.add(new THREE.HemisphereLight('#ffffff', '#606878', 2.2));
  const sun = new THREE.DirectionalLight('#ffffff', 1.6); sun.position.set(0.3, 0.6, 1); scene.add(sun);
  const clay = flat ? new THREE.MeshLambertMaterial({ color: '#c99a7e' }) : null;
  if (clay) scene.overrideMaterial = clay;
  const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3());
  const half = Math.max(s.x, s.y) * 0.58;
  const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, s.z * 4 + 10);
  cam.position.set(c.x, c.y, box.max.z + s.z + 1);
  cam.lookAt(c.x, c.y, box.min.z - 1);
  cam.updateProjectionMatrix();
  const parent = root.parent;
  scene.add(root);
  r.render(scene, cam);
  scene.remove(root);
  if (parent) parent.add(root);
  clay?.dispose();
  const copy = document.createElement('canvas');
  copy.width = copy.height = size;
  copy.getContext('2d')!.drawImage(gl, 0, 0);
  return { canvas: copy, frame: { x0: c.x - half, y0: c.y + half, w: half * 2 } };
}

const I = { nose: 0, lSh: 11, rSh: 12, lEl: 13, rEl: 14, lWr: 15, rWr: 16, lHip: 23, rHip: 24, lKn: 25, rKn: 26, lAn: 27, rAn: 28 };
type Joints = Partial<Record<SoftJoint, THREE.Vector3>>;

/** Find the joints. `src`: the model's bytes (a GLB / VRM) or an already loaded object (not modified). */
export async function findJoints(src: ArrayBuffer | THREE.Object3D, opts: { picture?: boolean; size?: number } = {}): Promise<JointFind> {
  const { root, own } = await loadRoot(src);
  try {
    root.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(root);
    const size = box.getSize(new THREE.Vector3());
    const H = size.y || 1;
    const shape = (why: string): JointFind => {
      const soft = guessSoftRig(root);
      return { soft: { ...soft, jointSource: 'shape' }, source: 'shape', joints: {}, confidence: 0, why };
    };
    if (box.isEmpty()) return shape('empty model');
    // a standing person is much shallower front-to-back than tall (four-legged animals, cars, beds are not)
    if (size.z > 0.75 * H) return shape('it is longer front-to-back than a standing person (an animal or an object?)');
    const model = await poseModel();
    if (!model) return shape('the body tracker could not start');

    // ---- the mesh, seen from the front: is a point on it, and where is its middle in depth
    const ray = new THREE.Raycaster();
    const meshes: THREE.Object3D[] = [];
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) meshes.push(o); });
    const hits = (x: number, y: number) => { ray.set(new THREE.Vector3(x, y, box.max.z + 1), new THREE.Vector3(0, 0, -1)); return ray.intersectObjects(meshes, false); };
    const on = (p: THREE.Vector3) => hits(p.x, p.y).length > 0;
    const zMid = (box.min.z + box.max.z) / 2;
    const depth = (p: THREE.Vector3): number => {
      for (const r of [0, 0.01, 0.02, 0.035]) {
        for (const [dx, dy] of r ? [[r, 0], [-r, 0], [0, r], [0, -r]] : [[0, 0]]) {
          const h = hits(p.x + dx * H, p.y + dy * H);
          if (h.length) return (h[0].point.z + h[h.length - 1].point.z) / 2;
        }
      }
      return zMid;
    };
    const at = (v: THREE.Vector3) => new THREE.Vector3(v.x, v.y, depth(v));
    /** A bone lies on the body: at least 2 of 3 points along it are on the mesh. */
    const along = (a: THREE.Vector3, b: THREE.Vector3) => [0.25, 0.5, 0.75].filter((t) => on(a.clone().lerp(b, t))).length >= 2;
    const inBox = (v: THREE.Vector3) => v.x > box.min.x - 0.05 * H && v.x < box.max.x + 0.05 * H && v.y > box.min.y - 0.05 * H && v.y < box.max.y + 0.05 * H;

    /** Joints from one set of landmarks, with a quality score (or why it was rejected). */
    const build = (lm: Lm[], frame: Frame): { joints: Joints; quality: number } | { why: string } => {
      const P = (i: number) => new THREE.Vector3(frame.x0 + lm[i].x * frame.w, frame.y0 - lm[i].y * frame.w, 0);
      const vis = (i: number) => lm[i].visibility ?? 0;
      const seen = [I.lSh, I.rSh, I.lHip, I.rHip, I.nose].reduce((a, i) => a + vis(i), 0) / 5;
      if (seen < 0.45) return { why: `the body tracker wasn’t sure (${Math.round(seen * 100)} %)` };
      // the person's left is the picture's right (the model faces the camera); some results come back mirrored
      const swap = P(I.lSh).x < P(I.rSh).x;
      const pick = (k: 0 | 1, pair: [number, number]) => (k === 0 ? (swap ? pair[1] : pair[0]) : (swap ? pair[0] : pair[1]));
      const hp = [P(pick(0, [I.lHip, I.rHip])), P(pick(1, [I.lHip, I.rHip]))];
      const nose = P(I.nose), hipMid = hp[0].clone().add(hp[1]).multiplyScalar(0.5);
      let fixes = 0;
      // arms: shoulder → elbow → wrist must lie on the body. Big heads fool the tracker into putting the shoulders on
      // the cheeks: then the shoulder goes one forearm-length in from the elbow, along the arm.
      const arms = ([0, 1] as const).map((k) => {
        let sh = P(pick(k, [I.lSh, I.rSh]));
        const el = P(pick(k, [I.lEl, I.rEl]));
        let wr = P(pick(k, [I.lWr, I.rWr]));
        const v = (vis(pick(k, [I.lEl, I.rEl])) + vis(pick(k, [I.lWr, I.rWr]))) / 2;
        // a wrist off the mesh (past the hand): back along the forearm to where the arm ends
        if (!on(wr)) {
          const dir = wr.clone().sub(el);
          let last: THREE.Vector3 | null = null;
          for (let t = 0.05; t <= 1.0001; t += 0.05) { const q = el.clone().addScaledVector(dir, t); if (on(q)) last = q; }
          if (last) { wr = last.addScaledVector(dir.normalize(), -0.03 * H); fixes++; }
        }
        if (!along(sh, el) && along(el, wr)) {
          const s2 = el.clone().add(el.clone().sub(wr));
          if (Math.sign(s2.x - hipMid.x) === Math.sign(el.x - hipMid.x)) { sh = s2; fixes++; }
        }
        return { sh, el, wr, vis: v, ok: wr.distanceTo(sh) > 0.12 * H && inBox(wr) && along(sh, el) && along(el, wr) };
      });
      const sh = [arms[0].sh, arms[1].sh];
      const shMid = sh[0].clone().add(sh[1]).multiplyScalar(0.5);
      if (!(shMid.y > hipMid.y + 0.08 * H && nose.y > shMid.y && sh[0].distanceTo(sh[1]) > 0.06 * H && [shMid, hipMid, nose].every(inBox) && on(hipMid) && on(shMid))) return { why: 'what was found doesn’t look like an upright body' };
      const legs = ([0, 1] as const).map((k) => {
        const hip = hp[k], kn = P(pick(k, [I.lKn, I.rKn])), an = P(pick(k, [I.lAn, I.rAn]));
        const v = (vis(pick(k, [I.lKn, I.rKn])) + vis(pick(k, [I.lAn, I.rAn]))) / 2;
        return { hip, kn, an, vis: v, ok: hip.y - an.y > 0.15 * H && kn.y < hip.y && an.y < kn.y && along(hip, kn) && along(kn, an) };
      });
      const joints: Joints = {};
      const cx = (shMid.x + hipMid.x) / 2;
      const torso = (v: THREE.Vector3) => at(new THREE.Vector3(cx + (v.x - cx) * 0.3, v.y, 0));
      const hips = hipMid.clone().lerp(shMid, 0.08);
      joints.hips = torso(hips);
      joints.spine = torso(hips.clone().lerp(shMid, 0.38));
      joints.chest = torso(hips.clone().lerp(shMid, 0.72));
      joints.neck = torso(shMid.clone().lerp(nose, 0.3));
      joints.head = torso(shMid.clone().lerp(nose, 0.6));
      joints.headTop = new THREE.Vector3(joints.head.x, box.max.y, joints.head.z);
      // limbs come in pairs: both sides judged together (chibis and baggy clothes often leave one side less certain)
      const armsOk = arms.every((a) => a.ok) && (arms[0].vis + arms[1].vis) / 2 > 0.3;
      const legsOk = legs.every((l) => l.ok) && (legs[0].vis + legs[1].vis) / 2 > 0.25;
      if (armsOk) arms.forEach((x, k) => {
        const s = k === 0 ? 'left' : 'right';
        joints[`${s}UpperArm`] = at(x.sh.clone().lerp(shMid, 0.12)); joints[`${s}LowerArm`] = at(x.el); joints[`${s}Hand`] = at(x.wr);
      });
      if (legsOk) legs.forEach((x, k) => {
        const s = k === 0 ? 'left' : 'right';
        joints[`${s}UpperLeg`] = at(x.hip); joints[`${s}LowerLeg`] = at(x.kn); joints[`${s}Foot`] = at(new THREE.Vector3(x.an.x, Math.max(x.an.y, box.min.y + 0.02 * H), 0));
      });
      // a person has a pair: both arms or both legs (a four-legged creature seen from the front can pass for a torso
      // with one arm; then the head + body rig is the honest choice)
      if (!armsOk && !legsOk) return { why: 'no pair of arms or legs found (a creature?)' };
      return { joints, quality: seen + (armsOk ? 0.25 : 0) + (legsOk ? 0.25 : 0) - fixes * 0.03 };
    };

    // two looks: as it is (textures), and a flat skin-coloured clay (helps untextured / odd-coloured models); the more
    // plausible body wins
    let best: { joints: Joints; quality: number; canvas: HTMLCanvasElement; frame: Frame } | null = null;
    let why = 'no person found in the picture (a creature or an object?)';
    for (const flat of [false, true]) {
      const shot = render(root, box, opts.size ?? 512, flat);
      let res: { landmarks: Lm[][] };
      try { res = model.detect(shot.canvas); } catch (e) { console.warn('[poseJoints] detect', e); continue; }
      const lm = res.landmarks?.[0];
      if (!lm || lm.length < 29) continue;
      const b = build(lm, shot.frame);
      if ('why' in b) { why = b.why; continue; }
      if (!best || b.quality > best.quality) best = { ...b, canvas: shot.canvas, frame: shot.frame };
    }
    if (!best) return shape(why);
    const { joints } = best;
    // ---- to the soft rig's bbox space
    const uvw = (v: THREE.Vector3): Vec3 => [(v.x - box.min.x) / (size.x || 1), (v.y - box.min.y) / H, (v.z - box.min.z) / (size.z || 1)];
    const J: Partial<Record<SoftJoint, Vec3>> = {};
    for (const [k, v] of Object.entries(joints)) J[k as SoftJoint] = uvw(v!).map((x) => Math.round(x * 1e4) / 1e4) as Vec3;
    const soft: SoftRigConfig = {
      hips: J.hips![1], chest: J.chest![1], neck: J.neck![1],
      leftShoulder: J.leftUpperArm ?? null, rightShoulder: J.rightUpperArm ?? null, leftHand: J.leftHand ?? null, rightHand: J.rightHand ?? null,
      blend: 0.05, joints: J, jointSource: 'pose',
    };
    const out: JointFind = { soft, source: 'pose', joints: Object.fromEntries(Object.entries(joints).map(([k, v]) => [k, [v!.x, v!.y, v!.z]])), confidence: Math.min(1, best.quality / 1.5) };
    if (opts.picture) out.picture = drawJoints(best.canvas, best.frame, joints);
    return out;
  } finally {
    if (own) root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry?.dispose(); for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt?.dispose(); } });
  }
}

function drawJoints(canvas: HTMLCanvasElement, f: { x0: number; y0: number; w: number }, joints: Partial<Record<SoftJoint, THREE.Vector3>>): string {
  const c = document.createElement('canvas');
  c.width = canvas.width; c.height = canvas.height;
  const g = c.getContext('2d')!;
  g.drawImage(canvas, 0, 0);
  const px = (v: THREE.Vector3) => [((v.x - f.x0) / f.w) * c.width, ((f.y0 - v.y) / f.w) * c.height];
  const link = (a: SoftJoint, b: SoftJoint) => { const A = joints[a], B = joints[b]; if (!A || !B) return; const [x1, y1] = px(A), [x2, y2] = px(B); g.beginPath(); g.moveTo(x1, y1); g.lineTo(x2, y2); g.stroke(); };
  g.strokeStyle = '#18e08a'; g.lineWidth = 3;
  for (const [a, b] of [['hips', 'spine'], ['spine', 'chest'], ['chest', 'neck'], ['neck', 'head'], ['head', 'headTop'],
    ['chest', 'leftUpperArm'], ['leftUpperArm', 'leftLowerArm'], ['leftLowerArm', 'leftHand'], ['chest', 'rightUpperArm'], ['rightUpperArm', 'rightLowerArm'], ['rightLowerArm', 'rightHand'],
    ['hips', 'leftUpperLeg'], ['leftUpperLeg', 'leftLowerLeg'], ['leftLowerLeg', 'leftFoot'], ['hips', 'rightUpperLeg'], ['rightUpperLeg', 'rightLowerLeg'], ['rightLowerLeg', 'rightFoot']] as [SoftJoint, SoftJoint][]) link(a, b);
  g.fillStyle = '#ff3d7f';
  for (const v of Object.values(joints)) { const [x, y] = px(v!); g.beginPath(); g.arc(x, y, 5, 0, Math.PI * 2); g.fill(); }
  return c.toDataURL('image/png');
}
