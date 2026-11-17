// "What is it?" + a few taps on a picture of the model: the guided input of the 3D auto-rig (shared/rigTaps.ts has the steps,
// shared/rigTapView.ts the picture maths, blender/rigplan.py turns the taps into a skeleton).
//
// The model is read from its own file bytes (never the live avatar): it is drawn once from the front and once from the side
// into this dialog's own small renderer, which is released as soon as the dialog closes. Nothing is saved here: the dialog
// returns { bodyType, taps } and the caller sends it to the helper.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import type { Vec3 } from '../../shared/types.ts';
import { BODY_TYPES, BODY_TYPE_INFO, stepsFor, type BodyType, type RigTaps, type TapId, type TapStep } from '../../shared/rigTaps.ts';
import { frameFor, pictureToPoint, pointToPicture, toUvw, type Box, type TapView, type ViewFrame } from '../../shared/rigTapView.ts';
import { h } from './dom.ts';

export interface BodyTapsResult { bodyType: BodyType; taps: RigTaps }
export interface BodyTapsOptions {
  /** The model's file bytes (GLB / VRM). */
  bytes: ArrayBuffer;
  /** Preselect a type (the picker is skipped). */
  bodyType?: BodyType;
}

const PICTURE = 560;

const CSS = `
.bt-back{position:fixed;inset:0;z-index:9100;background:rgba(0,0,0,.6);display:flex;align-items:center;justify-content:center;padding:14px}
.bt{background:var(--card,#1a1f26);color:var(--text,#e6e8eb);border:1px solid var(--line,#2c343e);border-radius:16px;max-width:640px;width:100%;
 max-height:calc(100vh - 28px);overflow:auto;padding:18px 20px;box-shadow:0 20px 60px rgba(0,0,0,.5);line-height:1.4}
.bt h3{margin:0 0 4px;font-size:22px}.bt .bt-hint{color:var(--dim,#9aa4af);font-size:14px;margin:0 0 10px}
.bt .bt-types{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px;margin-top:12px}
.bt .bt-type{border:2px solid var(--line,#2c343e);background:var(--card2,#222932);color:inherit;border-radius:14px;padding:14px 10px;cursor:pointer;text-align:center;font:inherit}
.bt .bt-type:hover{border-color:#5aa7ff}.bt .bt-type b{display:block;font-size:18px;margin:4px 0}.bt .bt-type span.i{font-size:34px}.bt .bt-type span.d{font-size:13px;color:var(--dim,#9aa4af)}
.bt .bt-prompt{font-size:24px;font-weight:700;margin:2px 0}.bt .bt-prog{font-size:13px;color:var(--dim,#9aa4af)}
.bt canvas{width:100%;height:auto;aspect-ratio:1;border-radius:12px;cursor:crosshair;display:block;margin:10px 0;touch-action:manipulation}
.bt .bt-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}.bt .bt-row .sp{flex:1}
.bt button.b{border:1px solid var(--line,#2c343e);background:var(--card2,#222932);color:inherit;border-radius:10px;padding:10px 16px;font:inherit;font-size:15px;cursor:pointer}
.bt button.b.primary{background:#2d6cdf;border-color:#2d6cdf;color:#fff;font-weight:700}.bt button.b:disabled{opacity:.45;cursor:default}`;
let cssDone = false;

function loadModel(bytes: ArrayBuffer): Promise<THREE.Object3D> {
  const loader = new GLTFLoader();
  loader.setMeshoptDecoder(MeshoptDecoder);
  return loader.parseAsync(bytes, '').then((g) => g.scene);
}

/** Two pictures of the model (front, side) drawn once, plus the depth lookup for a tap. */
class Views {
  readonly box: Box;
  private meshes: THREE.Object3D[] = [];
  readonly pics = new Map<TapView, { canvas: HTMLCanvasElement; frame: ViewFrame }>();
  private ray = new THREE.Raycaster();
  private b3: THREE.Box3;

  constructor(private root: THREE.Object3D) {
    root.updateMatrixWorld(true);
    this.b3 = new THREE.Box3().setFromObject(root);
    this.box = { min: this.b3.min.toArray() as Vec3, max: this.b3.max.toArray() as Vec3 };
    root.traverse((o) => { if ((o as THREE.Mesh).isMesh) this.meshes.push(o); });
    const r = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true, alpha: false });
    r.setPixelRatio(1);
    r.setSize(PICTURE, PICTURE, false);
    r.outputColorSpace = THREE.SRGBColorSpace;
    try {
      for (const view of ['front', 'side'] as const) this.pics.set(view, this.draw(r, view));
    } finally { r.dispose(); r.forceContextLoss(); }
  }

  private draw(r: THREE.WebGLRenderer, view: TapView) {
    const frame = frameFor(view, this.box);
    const scene = new THREE.Scene();
    scene.background = new THREE.Color('#dfe3ea');
    scene.add(new THREE.HemisphereLight('#ffffff', '#606878', 2.3));
    const sun = new THREE.DirectionalLight('#ffffff', 1.5); sun.position.set(view === 'side' ? -1 : 0.3, 0.6, view === 'side' ? 0.3 : 1); scene.add(sun);
    const c = this.b3.getCenter(new THREE.Vector3()), s = this.b3.getSize(new THREE.Vector3());
    const half = frame.w / 2;
    const cam = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 4 * Math.max(s.x, s.y, s.z) + 20);
    const reach = Math.max(s.x, s.y, s.z) * 2 + 2;
    if (view === 'front') { cam.position.set(c.x, c.y, this.b3.max.z + reach); cam.lookAt(c.x, c.y, this.b3.min.z - 1); }
    else { cam.position.set(this.b3.min.x - reach, c.y, c.z); cam.lookAt(this.b3.max.x + 1, c.y, c.z); }
    cam.updateProjectionMatrix();
    const parent = this.root.parent;
    scene.add(this.root);
    r.render(scene, cam);
    scene.remove(this.root);
    if (parent) parent.add(this.root);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = PICTURE;
    canvas.getContext('2d')!.drawImage(r.domElement, 0, 0);
    return { canvas, frame };
  }

  /** The point in the model under a spot on the picture; the depth is the middle of where a ray goes in and out. */
  point(view: TapView, fx: number, fy: number): Vec3 {
    const { frame } = this.pics.get(view)!;
    const flat = pictureToPoint(frame, this.box, fx, fy, null);
    const dirv = view === 'front' ? new THREE.Vector3(0, 0, -1) : new THREE.Vector3(1, 0, 0);
    const origin = (p: Vec3) => (view === 'front' ? new THREE.Vector3(p[0], p[1], this.b3.max.z + 1) : new THREE.Vector3(this.b3.min.x - 1, p[1], p[2]));
    const near = frame.w * 0.02;
    for (const rad of [0, near * 0.5, near, near * 1.8]) {
      const offs = rad ? [[rad, 0], [-rad, 0], [0, rad], [0, -rad]] : [[0, 0]];
      for (const [dh, dv] of offs) {
        const q: Vec3 = view === 'front' ? [flat[0] + dh, flat[1] + dv, flat[2]] : [flat[0], flat[1] + dv, flat[2] + dh];
        this.ray.set(origin(q), dirv);
        const hits = this.ray.intersectObjects(this.meshes, false);
        if (hits.length) {
          const a = view === 'front' ? hits[0].point.z : hits[0].point.x;
          const b = view === 'front' ? hits[hits.length - 1].point.z : hits[hits.length - 1].point.x;
          return pictureToPoint(frame, this.box, fx, fy, (a + b) / 2);
        }
      }
    }
    return flat;   // off the model: the middle of the box
  }

  dispose() {
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.isMesh) return;
      m.geometry?.dispose();
      for (const mt of Array.isArray(m.material) ? m.material : [m.material]) mt?.dispose();
    });
  }
}

/** Ask what the model is and take the taps. Resolves null when cancelled (or the model cannot be drawn). */
export async function askBodyTaps(opts: BodyTapsOptions): Promise<BodyTapsResult | null> {
  if (!cssDone) { cssDone = true; const st = document.createElement('style'); st.textContent = CSS; document.head.append(st); }
  let views: Views;
  try { views = new Views(await loadModel(opts.bytes)); } catch (e) { console.warn('[bodyTaps] could not draw the model', e); return null; }

  return new Promise<BodyTapsResult | null>((resolve) => {
    const back = h('div', { class: 'bt-back' });
    const card = h('div', { class: 'bt', role: 'dialog', 'aria-label': 'Tell us what it is' });
    back.append(card);
    let type: BodyType | null = opts.bodyType ?? null;
    const taps: RigTaps = {};
    const order: TapId[] = [];         // for Back
    let i = 0;
    let steps: readonly TapStep[] = [];
    let viewOverride: TapView | null = null;
    const done = (r: BodyTapsResult | null) => { views.dispose(); back.remove(); document.removeEventListener('keydown', onKey); resolve(r); };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') done(null); };
    document.addEventListener('keydown', onKey);
    document.body.append(back);

    const btn = (label: string, fn: () => void, cls = '') => { const b = h('button', { class: `b ${cls}`, type: 'button', onClick: fn }, label) as HTMLButtonElement; return b; };

    const pickType = () => {
      card.replaceChildren(
        h('h3', null, 'What is it?'),
        h('p', { class: 'bt-hint' }, 'Pick the closest one. Then you tap a few spots on a picture of it.'),
        h('div', { class: 'bt-types' }, ...BODY_TYPES.map((t) => {
          const info = BODY_TYPE_INFO[t];
          return h('button', { class: 'bt-type', type: 'button', onClick: () => { type = t; start(); } },
            h('span', { class: 'i' }, info.icon), h('b', null, info.label), h('span', { class: 'd' }, info.blurb));
        })),
        h('div', { class: 'bt-row', style: 'margin-top:14px' }, btn('Cancel', () => done(null))),
      );
    };

    const start = () => { steps = stepsFor(type!); i = 0; order.length = 0; for (const k of Object.keys(taps)) delete taps[k as TapId]; viewOverride = null; show(); };

    const draw = (canvas: HTMLCanvasElement, view: TapView, current: TapStep) => {
      const pic = views.pics.get(view)!;
      canvas.width = canvas.height = PICTURE;
      const g = canvas.getContext('2d')!;
      g.drawImage(pic.canvas, 0, 0);
      for (const s of steps) {
        const uvw = taps[s.id];
        if (!uvw) continue;
        const p: Vec3 = [views.box.min[0] + uvw[0] * (views.box.max[0] - views.box.min[0]), views.box.min[1] + uvw[1] * (views.box.max[1] - views.box.min[1]), views.box.min[2] + uvw[2] * (views.box.max[2] - views.box.min[2])];
        const [fx, fy] = pointToPicture(pic.frame, p);
        g.beginPath(); g.arc(fx * PICTURE, fy * PICTURE, s.id === current.id ? 11 : 8, 0, Math.PI * 2);
        g.fillStyle = s.color; g.fill(); g.lineWidth = 3; g.strokeStyle = '#fff'; g.stroke();
      }
      g.fillStyle = 'rgba(20,24,30,.78)'; g.font = '600 15px system-ui,sans-serif';
      const label = view === 'front' ? 'Seen from the front' : 'Seen from the side (it faces right)';
      g.fillRect(8, 8, g.measureText(label).width + 16, 26); g.fillStyle = '#fff'; g.fillText(label, 16, 27);
    };

    const show = () => {
      if (i >= steps.length) return summary();
      const step = steps[i];
      const view = viewOverride ?? step.view;
      const canvas = document.createElement('canvas');
      draw(canvas, view, step);
      canvas.addEventListener('click', (ev) => {
        const r = canvas.getBoundingClientRect();
        const fx = (ev.clientX - r.left) / r.width, fy = (ev.clientY - r.top) / r.height;
        const p = views.point(view, fx, fy);
        taps[step.id] = toUvw(views.box, p);
        order.push(step.id);
        i++; viewOverride = null;
        show();
      });
      card.replaceChildren(
        h('div', { class: 'bt-prog' }, `${BODY_TYPE_INFO[type!].icon} ${BODY_TYPE_INFO[type!].label} · step ${i + 1} of ${steps.length}`),
        h('div', { class: 'bt-prompt' }, step.prompt),
        h('p', { class: 'bt-hint' }, step.hint),
        canvas,
        h('div', { class: 'bt-row' },
          btn('Back', () => { if (order.length) { const last = order.pop()!; delete taps[last]; i = steps.findIndex((s) => s.id === last); } else { type = null; pickType(); return; } show(); }),
          btn(view === 'front' ? 'Turn it to the side' : 'Turn it to the front', () => { viewOverride = view === 'front' ? 'side' : 'front'; show(); }),
          h('span', { class: 'sp' }),
          step.optional ? btn('Skip', () => { i++; viewOverride = null; show(); }) : null,
          btn('Cancel', () => done(null)),
        ),
      );
    };

    const summary = () => {
      const placed = steps.filter((s) => taps[s.id]).length;
      card.replaceChildren(
        h('h3', null, 'All set'),
        h('p', { class: 'bt-hint' }, `${placed} spot${placed === 1 ? '' : 's'} marked. We build the skeleton from them and fill in anything you skipped by looking at the shape.`),
        h('div', { class: 'bt-row' },
          btn('Start over', start),
          h('span', { class: 'sp' }),
          btn('Cancel', () => done(null)),
          btn('Build the skeleton', () => done({ bodyType: type!, taps: { ...taps } }), 'primary'),
        ),
      );
    };

    if (type) start(); else pickType();
  });
}
