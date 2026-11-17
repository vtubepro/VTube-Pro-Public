// Pro2D → 3D review renders in the APP renderer (lane to3d): this page runs in a separate, muted, headless browser the
// helper starts (server/to3d/render.ts), never in the live studio's process and never on the bus. It loads one round's
// candidate VRM + profile.json from the helper (a one-time token), renders the shots the plan lists (the 8 angles, the
// expression sheet, the head close-ups the compare step aligns on, with the iris centres projected), uploads each PNG and
// says done. The performer's tracking never reaches it: every pose is a synthetic frame. Makes no sound.
import * as THREE from 'three';
import type { AvatarProfile, TrackingFrame } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import { Stage } from '../stage/Stage.ts';
import { emptyFrame } from '../tracking/faceSolver.ts';
import { TESTS, type TestPose } from '../onboarding/modelPreview.ts';

interface Shot { name: string; focus: 'head' | 'bust' | 'full'; yaw: number; pose?: string | null; eyes?: boolean }
interface Plan { model: string; profile: AvatarProfile; size: number; gapMs: number; shots: Shot[] }

const q = new URLSearchParams(location.search);
const token = q.get('t') ?? '';
const base = `/api/to3d/render/${encodeURIComponent(token)}`;
const say = (s: string) => { document.title = s; console.log('[to3d render]', s); };

function frameFor(pose: TestPose | undefined): TrackingFrame {
  const f = emptyFrame();
  if (!pose) return { ...f, tracked: true };
  const face = { ...(pose.face ?? {}) };
  const g = (k: string) => face[k] ?? 0;
  const out: TrackingFrame = {
    ...f, tracked: true, face, head: pose.head ?? [0, 0, 0], gaze: pose.gaze ?? [0, 0],
    mouth: { open: g('jawOpen'), wide: (g('mouthStretchLeft') + g('mouthStretchRight')) / 2, smile: (g('mouthSmileLeft') + g('mouthSmileRight')) / 2,
      frown: (g('mouthFrownLeft') + g('mouthFrownRight')) / 2, pucker: g('mouthPucker'), funnel: g('mouthFunnel'), tongue: g('tongueOut'), closure: Math.max(g('mouthPressLeft'), g('mouthClose')) },
  };
  if (pose.visemes) { let s = 0; const v: Record<string, number> = {}; for (const [k, x] of Object.entries(pose.visemes)) { v[k] = x; s += x; } v.sil = Math.max(0, 1 - s); return { ...out, visemes: v, mouth: { ...out.mouth!, speak: 1 } }; }
  return out;
}

/** The iris centres (character's L / R) in canvas pixels: the iris material's vertices, skinned, averaged per side. */
function irisPixels(rt: AvatarRuntime, cam: THREE.Camera, w: number, h: number): Record<string, [number, number]> | null {
  const sides: Record<'L' | 'R', THREE.Vector3[]> = { L: [], R: [] };
  const v = new THREE.Vector3(), loc = new THREE.Vector3();
  rt.model.updateMatrixWorld(true);
  rt.model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.vtpGenerated || m.userData.vtpOutline) return;
    const mats = Array.isArray(m.material) ? m.material : [m.material];
    const geo = m.geometry as THREE.BufferGeometry;
    const groups = geo.groups.length ? geo.groups : [{ start: 0, count: geo.index ? geo.index.count : geo.attributes.position.count, materialIndex: 0 }];
    for (const gr of groups) {
      const mat = mats[gr.materialIndex ?? 0];
      if (!mat || !/EyeIris/i.test(mat.name)) continue;
      const idx = geo.index;
      for (let k = gr.start; k < gr.start + gr.count; k += 3) {
        const i = idx ? idx.getX(k) : k;
        m.getVertexPosition(i, v);
        m.localToWorld(v);
        loc.copy(v); rt.wrapper.worldToLocal(loc);
        sides[loc.x >= 0 ? 'L' : 'R'].push(v.clone());
      }
    }
  });
  const px = (list: THREE.Vector3[]): [number, number] | null => {
    if (!list.length) return null;
    const c = list.reduce((a, b) => a.add(b), new THREE.Vector3()).divideScalar(list.length).project(cam);
    return [+(((c.x + 1) / 2) * w).toFixed(2), +(((1 - c.y) / 2) * h).toFixed(2)];
  };
  let L = px(sides.L), R = px(sides.R);
  if (!L || !R) {   // no VRoid iris: the eye bones
    const hum = rt.humanoid ?? rt.vrm?.humanoid ?? null;
    const b = (n: 'leftEye' | 'rightEye') => { const o = hum?.getRawBoneNode(n); return o ? o.getWorldPosition(new THREE.Vector3()) : null; };
    const l = b('leftEye'), r = b('rightEye');
    L = l ? px([l]) : null; R = r ? px([r]) : null;
  }
  return L && R ? { L, R } : null;
}

async function main() {
  const plan = await (await fetch(`${base}/plan`)).json() as Plan;
  const canvas = document.getElementById('stage') as HTMLCanvasElement;
  canvas.style.width = `${plan.size}px`; canvas.style.height = `${plan.size}px`;
  const stage = new Stage(canvas, { transparent: true, tier: 'high', controls: false, preserve: true, outlines: true });
  stage.resize();
  say('loading');
  const profile = normalizeProfile(JSON.parse(JSON.stringify(plan.profile)));
  const rt = await AvatarRuntime.load(profile, plan.model, stage.anchor);
  const eyes: Record<string, Record<string, [number, number]>> = {};
  for (const s of plan.shots) {
    say(`shot ${s.name}`);
    stage.anchor.rotation.set(0, THREE.MathUtils.degToRad(s.yaw), 0);
    stage.anchor.updateMatrixWorld(true);
    const f = frameFor(s.pose ? TESTS[s.pose] : undefined);
    for (let k = 0; k < 14; k++) { try { rt.update({ ...f, t: k * 0.1 }, null, rt.profile.tracking, 0.1, stage.camera.aspect); } catch (e) { console.warn(e); } }
    stage.anchor.updateMatrixWorld(true);
    stage.frame(rt.bounds(), s.focus, s.focus === 'full' ? undefined : rt.faceInfo(), rt.cardBox());
    stage.render(); stage.render();
    const blob = await new Promise<Blob | null>((res) => canvas.toBlob((b) => res(b), 'image/png'));
    if (s.eyes) { const e = irisPixels(rt, stage.camera, canvas.width, canvas.height); if (e) eyes[s.name] = e; }
    if (blob) await fetch(`${base}/shot?name=${encodeURIComponent(s.name)}`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: blob });
    if (plan.gapMs > 0) await new Promise((r) => setTimeout(r, plan.gapMs));
  }
  await fetch(`${base}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ eyes, size: [canvas.width, canvas.height] }) });
  say('done');
  rt.dispose(); stage.dispose();
}

main().catch(async (e) => {
  say('failed');
  try { await fetch(`${base}/done`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ error: String((e as Error)?.message ?? e).slice(0, 400) }) }); } catch { /* VTube Pro times out */ }
});
