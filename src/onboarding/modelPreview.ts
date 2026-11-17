// The "Add my model" wizard's own 3D preview: a private Stage + AvatarRuntime that loads the picked file straight
// from its bytes. It never touches the live studio avatar, the bus or OBS (the performer may be live), and it runs
// without the helper (VRM / GLB / single-file glTF). It plays test faces (Smile, Say "Ahh", Look ←, Blink …) through
// synthetic tracking frames, measures what the model can do (ModelFacts for src/onboarding/modelCheck.ts), finds
// eye / mouth spots, takes snapshots and the 8-angle check. Renders at ≤ 30 fps and only while it is on screen.
import * as THREE from 'three';
import type { AvatarProfile, SurfaceMarker, TrackingFrame } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { AvatarRuntime } from '../avatar/AvatarRuntime.ts';
import { eyeBoneMarkers } from '../avatar/bakedEyes.ts';
import { guessFaceMarkers, type FaceGuess } from '../avatar/faceGuess.ts';
import { collectMeshes } from '../avatar/surfacePatch.ts';
import { Stage } from '../stage/Stage.ts';
import { emptyFrame } from '../tracking/faceSolver.ts';
import { h } from '../ui/dom.ts';
import { ANGLES, guessMechanical, type ModelFacts } from './modelCheck.ts';

const PROBE = ['hips', 'spine', 'chest', 'neck', 'head', 'jaw', 'leftEye', 'rightEye',
  'leftUpperArm', 'leftLowerArm', 'leftHand', 'rightUpperArm', 'rightLowerArm', 'rightHand',
  'leftUpperLeg', 'leftLowerLeg', 'leftFoot', 'rightUpperLeg', 'rightLowerLeg', 'rightFoot',
  'leftIndexProximal', 'leftMiddleProximal', 'leftLittleProximal', 'rightIndexProximal', 'rightMiddleProximal', 'rightLittleProximal'];

/** A test pose: face channels (ARKit), gaze (−1..1, + = the avatar's left), head (radians), speech visemes, an emote. */
export interface TestPose { face?: Record<string, number>; gaze?: [number, number]; head?: [number, number, number]; visemes?: Record<string, number>; emote?: string; shake?: boolean }
export const TESTS: Record<string, TestPose> = {
  Smile: { face: { mouthSmileLeft: 1, mouthSmileRight: 1, cheekSquintLeft: 0.5, cheekSquintRight: 0.5 } },
  'Say “Ahh”': { face: { jawOpen: 0.65 }, visemes: { aa: 1 } },
  'Say “Ooh”': { face: { jawOpen: 0.25, mouthFunnel: 0.6, mouthPucker: 0.7 }, visemes: { U: 1 } },
  'Say “Eee”': { face: { jawOpen: 0.2, mouthStretchLeft: 0.8, mouthStretchRight: 0.8 }, visemes: { I: 1 } },
  'Say “Mmm”': { face: { mouthClose: 0.6, mouthPressLeft: 0.7, mouthPressRight: 0.7 }, visemes: { PP: 1 } },
  Blink: { face: { eyeBlinkLeft: 1, eyeBlinkRight: 1 } },
  'Look ←': { gaze: [-0.85, 0], face: { eyeLookOutRight: 0.8, eyeLookInLeft: 0.8 } },
  'Look →': { gaze: [0.85, 0], face: { eyeLookOutLeft: 0.8, eyeLookInRight: 0.8 } },
  Surprised: { face: { jawOpen: 0.7, mouthFunnel: 0.4, browOuterUpLeft: 1, browOuterUpRight: 1, browInnerUp: 1, eyeWideLeft: 1, eyeWideRight: 1 } },
  Angry: { face: { browDownLeft: 1, browDownRight: 1, mouthFrownLeft: 0.8, mouthFrownRight: 0.8, noseSneerLeft: 0.6, noseSneerRight: 0.6 } },
  Sad: { face: { browInnerUp: 1, mouthFrownLeft: 1, mouthFrownRight: 1 } },
  'Turn head': { head: [0.45, 0.05, 0.08] },
  'Talk with hands': { emote: 'idle_talking', face: { jawOpen: 0.35 }, visemes: { aa: 0.6, O: 0.4 } },
  'Shake it': { shake: true },
};

export class ModelPreview {
  readonly el: HTMLElement;
  readonly canvas: HTMLCanvasElement;
  readonly stage: Stage;
  rt: AvatarRuntime | null = null;
  focus: 'full' | 'bust' | 'head' = 'bust';
  private hint: HTMLElement;
  private tag: HTMLElement;
  private test: { pose: TestPose; start: number; until: number } | null = null;
  private raf = 0;
  private last = 0;
  private disposed = false;
  private emoteId = 1;
  private picking: ((m: SurfaceMarker | null) => void) | null = null;
  private down: { x: number; y: number } | null = null;
  private src: ArrayBuffer | string | null = null;
  private loadSeq = 0;

  constructor() {
    this.canvas = h('canvas', { 'aria-label': '3D preview of your model. Drag to turn it, scroll to zoom.' }) as HTMLCanvasElement;
    this.tag = h('span', { class: 'ob-prev-tag' }, 'Preview: not on stream');
    this.hint = h('div', { class: 'ob-prev-hint', style: 'display:none' });
    this.el = h('div', { class: 'ob-prev' }, this.canvas, this.tag, this.hint);
    this.stage = new Stage(this.canvas, { transparent: false, tier: 'medium', controls: true, outlines: false });
    this.canvas.addEventListener('pointerdown', (e) => { this.down = { x: e.clientX, y: e.clientY }; });
    this.canvas.addEventListener('pointerup', (e) => this.onUp(e));
    const loop = (t: number) => {
      if (this.disposed) return;
      this.raf = requestAnimationFrame(loop);
      if (!this.el.isConnected || document.hidden) return;
      if (t - this.last < 1000 / 30) return;
      const dt = Math.min(0.1, (t - (this.last || t)) / 1000);
      this.last = t;
      this.tick(dt);
    };
    this.raf = requestAnimationFrame(loop);
  }

  /** Load (or rebuild after a profile change). `src` = the model's bytes or URL; omitted = the last one. */
  async load(profile: AvatarProfile, src?: ArrayBuffer | string): Promise<AvatarRuntime> {
    if (src !== undefined) this.src = src;
    if (this.src === null) throw new Error('No model loaded');
    const seq = ++this.loadSeq;
    const p = normalizeProfile(JSON.parse(JSON.stringify(profile)));
    const s = this.src;
    const rt = await AvatarRuntime.load(p, typeof s === 'string' ? s : s.slice(0), this.stage.anchor);
    if (seq !== this.loadSeq || this.disposed) { rt.dispose(); throw new Error('superseded'); }
    this.rt?.dispose();
    this.rt = rt;
    this.stage.anchor.rotation.set(0, 0, 0);
    this.stage.anchor.updateMatrixWorld(true);
    this.frame();
    return rt;
  }

  frame(focus = this.focus) {
    this.focus = focus;
    if (!this.rt) return;
    this.stage.anchor.updateMatrixWorld(true);
    // (a 2D avatar: its whole art, bottom-anchored, in every focus but 'head' — a bust's cut edge out of view, else faded)
    const card = this.stage.frame(this.rt.bounds(), focus, focus === 'full' ? undefined : this.rt.faceInfo(), this.rt.cardBox());
    if (this.rt.flat) this.rt.flat.cutHidden = card;
  }

  play(name: string, seconds = 2.2) {
    const pose = TESTS[name];
    if (!pose) return;
    const now = performance.now() / 1000;
    if (pose.emote) this.emoteId++;
    this.test = { pose, start: now, until: now + (pose.emote ? 3 : seconds) };
  }

  /** Waits for one click on the model (not a drag); resolves the surface point, or null if cancelled. */
  pick(hint: string): Promise<SurfaceMarker | null> {
    this.picking?.(null);
    this.hint.textContent = hint; this.hint.style.display = '';
    this.canvas.style.cursor = 'crosshair';
    return new Promise((res) => { this.picking = (m) => { this.picking = null; this.hint.style.display = 'none'; this.canvas.style.cursor = ''; res(m); }; });
  }
  cancelPick() { this.picking?.(null); }

  private onUp(e: PointerEvent) {
    const d = this.down; this.down = null;
    if (!this.picking || !this.rt || !d || Math.hypot(e.clientX - d.x, e.clientY - d.y) > 5) return;
    const r = this.canvas.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const hit = this.rt.pick(ndc, this.stage.camera);
    if (hit) this.picking(hit);
    else { this.hint.textContent = 'Click right on the model.'; }
  }

  private tick(dt: number) {
    const rt = this.rt;
    if (rt) {
      const now = performance.now() / 1000;
      let f: TrackingFrame = emptyFrame();
      const t = this.test;
      if (t && now > t.until) this.test = null;
      else if (t) {
        const ramp = Math.min(1, (now - t.start) / 0.25, (t.until - now) / 0.3);
        const face: Record<string, number> = {};
        for (const [k, v] of Object.entries(t.pose.face ?? {})) face[k] = v * ramp;
        const g = (k: string) => face[k] ?? 0;
        const head: [number, number, number] = t.pose.shake ? [Math.sin((now - t.start) * 9) * 0.5 * ramp, 0, Math.sin((now - t.start) * 7) * 0.12 * ramp]
          : t.pose.head ? [t.pose.head[0] * ramp, t.pose.head[1] * ramp, t.pose.head[2] * ramp] : [0, 0, 0];
        f = {
          ...f, t: now, tracked: true, face, head,
          gaze: t.pose.gaze ? [t.pose.gaze[0] * ramp, t.pose.gaze[1] * ramp] : [0, 0],
          mouth: { open: g('jawOpen'), wide: (g('mouthStretchLeft') + g('mouthStretchRight')) / 2, smile: (g('mouthSmileLeft') + g('mouthSmileRight')) / 2,
            frown: (g('mouthFrownLeft') + g('mouthFrownRight')) / 2, pucker: g('mouthPucker'), funnel: g('mouthFunnel'), tongue: g('tongueOut'),
            closure: Math.max(g('mouthPressLeft'), g('mouthClose')) },
        };
        if (t.pose.visemes) {
          const vis: Record<string, number> = {};
          let s = 0;
          for (const [k, v] of Object.entries(t.pose.visemes)) { vis[k] = v * ramp; s += v * ramp; }
          vis.sil = Math.max(0, 1 - s);
          f = { ...f, visemes: vis, mouth: { ...f.mouth, speak: ramp } };
        }
        if (t.pose.emote) f = { ...f, emote: { id: this.emoteId, name: t.pose.emote, at: Date.now() - Math.round((now - t.start) * 1000) } };
      }
      try { rt.update(f, null, rt.profile.tracking, dt, this.stage.camera.aspect); } catch (e) { console.warn('[model preview]', e); }
    }
    this.stage.render();
  }

  /** A picture of the preview (data: URL, ≤ 480 px). */
  async snapshot(max = 480): Promise<string> {
    this.stage.render();
    const c = this.canvas, s = Math.min(1, max / Math.max(c.width, c.height));
    const out = document.createElement('canvas');
    out.width = Math.round(c.width * s); out.height = Math.round(c.height * s);
    out.getContext('2d')!.drawImage(c, 0, 0, out.width, out.height);
    return out.toDataURL('image/png');
  }
  /** A PNG of the preview for the avatar's thumbnail. */
  thumbnail(): Promise<Blob | null> {
    this.stage.render();
    return new Promise((res) => this.canvas.toBlob((b) => res(b), 'image/png'));
  }

  /** The 8-angle check: the whole model from 8 sides, then back to the front. */
  async angles(): Promise<{ label: string; url: string }[]> {
    if (!this.rt) return [];
    const keep = this.focus;
    const saved = this.test; this.test = null;
    const out: { label: string; url: string }[] = [];
    const cam = this.stage.camera.position.clone(), tgt = this.stage.controls?.target.clone();
    this.frame('full');
    for (const a of ANGLES) {
      this.stage.anchor.rotation.y = THREE.MathUtils.degToRad(a.yaw);
      this.stage.anchor.updateMatrixWorld(true);
      this.tick(0.016);
      out.push({ label: a.label, url: await this.snapshot(360) });
    }
    this.stage.anchor.rotation.y = 0;
    this.stage.anchor.updateMatrixWorld(true);
    this.focus = keep;
    this.stage.camera.position.copy(cam);
    if (tgt && this.stage.controls) { this.stage.controls.target.copy(tgt); this.stage.controls.update(); }
    this.test = saved;
    return out;
  }

  /** What the loaded model can do (for the report card / the plan). */
  facts(file: string, extra: { mechanical?: boolean; quadruped?: boolean } = {}): ModelFacts | null {
    return this.rt ? runtimeFacts(this.rt, file, extra) : null;
  }

  /** Where the eyes / mouth probably are (the same guess the studio makes for a model without a face rig). */
  guessFace(): FaceGuess | null {
    const rt = this.rt;
    if (!rt) return null;
    const ms = collectMeshes(rt.model);
    const g = guessFaceMarkers(rt.model, ms, rt.humanoid?.getRawBoneNode('head') ?? null, rt.profile.transform.yaw);
    const eb = eyeBoneMarkers(rt.model, ms, rt.anchor, { left: rt.humanoid?.getRawBoneNode('leftEye') ?? null, right: rt.humanoid?.getRawBoneNode('rightEye') ?? null });
    if (eb) return { eyes: eb, mouth: g?.mouth ?? null, mascot: g?.mascot ?? false };
    return g;
  }

  dispose() {
    this.disposed = true;
    cancelAnimationFrame(this.raf);
    this.picking?.(null);
    this.rt?.dispose(); this.rt = null;
    this.stage.dispose();
    this.el.remove();
  }
}

/** What a loaded avatar runtime can do (the wizard's preview, or the live studio avatar: "Best lip sync for me"). */
export function runtimeFacts(rt: AvatarRuntime, file: string, extra: { mechanical?: boolean; quadruped?: boolean } = {}): ModelFacts {
  const hum = rt.humanoid ?? rt.vrm?.humanoid ?? null;
  const bones = hum ? PROBE.filter((n) => { try { return !!hum.getRawBoneNode(n as Parameters<typeof hum.getRawBoneNode>[0]); } catch { return false; } }) : [];
  let height = 0;
  try {
    const box = new THREE.Box3().setFromObject(rt.model);
    const s = rt.model.getWorldScale(new THREE.Vector3()).y || 1;
    if (!box.isEmpty()) height = (box.max.y - box.min.y) / s;
  } catch { /* unmeasurable */ }
  const morphs = new Set<string>(), names = new Set<string>();
  let textured = false;
  rt.model.traverse((o) => {
    const m = o as THREE.Mesh;
    if (!m.isMesh || m.userData.vtpGenerated || m.userData.vtpOutline) return;
    for (const n of Object.keys(m.morphTargetDictionary ?? {})) if (!n.startsWith('vtp_')) morphs.add(n);
    for (const mat of Array.isArray(m.material) ? m.material : [m.material]) {
      if (!mat) continue;
      if (mat.name) names.add(mat.name);
      if ((mat as THREE.MeshStandardMaterial).map) textured = true;
    }
  });
  // facing: in the wrapper's space (after the file's own rotation, before the profile's turn) the character's left
  // side must be on +X when it faces the camera (+Z)
  let facesAway = false;
  try {
    const pair = (['leftUpperArm', 'rightUpperArm'] as const).map((b) => hum?.getRawBoneNode(b) ?? null);
    const legs = (['leftUpperLeg', 'rightUpperLeg'] as const).map((b) => hum?.getRawBoneNode(b) ?? null);
    const [l, r] = pair[0] && pair[1] ? pair : legs;
    if (l && r) {
      rt.wrapper.updateWorldMatrix(true, true);
      const lx = rt.wrapper.worldToLocal(l.getWorldPosition(new THREE.Vector3())).x, rx = rt.wrapper.worldToLocal(r.getWorldPosition(new THREE.Vector3())).x;
      facesAway = lx < rx - 1e-4;
    }
  } catch { /* unknown */ }
  const e = rt.info.expressions;
  const p = rt.profile;
  return {
    file, rig: rt.info.rig, bones, arkit: e.arkit, named: e.named, vrm: e.vrm, triangles: rt.info.triangles, height,
    jaw: !!rt.jawRig, drawnFace: rt.info.proceduralMouth || rt.info.proceduralEyes,
    morphs: [...morphs], vrmExpressions: rt.vrm?.expressionManager?.expressions.map((x) => x.expressionName) ?? [],
    lookAt: !!rt.vrm?.lookAt || bones.includes('leftEye'), springs: rt.info.springJoints, textured,
    facesAway, turned: Math.round(((p.transform.yaw % 360) + 360) % 360) === 180, mechanical: extra.mechanical || !!p.rig.mechanical || rt.mechanical || (!rt.vrm && guessMechanical([...names])), quadruped: extra.quadruped ?? p.body === 'quadruped', faceMapCurrent: p.faceMap,
  };
}
