// The chat audience's people: stylized "bean folk" built from a handful of procedural parts (no downloads, no models),
// all GPU-instanced — one draw per part kind for the whole audience (≈ 16 draws for 200 people). Every person gets a
// seeded look (height, width, skin, shirt = their chat colour, hair, one of 10 hats / hairdos) and a pose per frame
// (sit ↔ stand, lean, bounce, arms, head, mouth, blink, pop-in scale) written straight into the instance matrices.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

export interface BodyLook { h: number; w: number; skin: THREE.Color; shirt: THREE.Color; hair: THREE.Color; hat: THREE.Color; topper: number }
export interface BodyPose {
  x: number; y: number; z: number; yaw: number;
  /** 1 = seated on a seat `seatH` high, 0 = standing on the floor (blends) */
  sit: number; seatH: number;
  lift: number; lean: number; roll: number;
  /** arms: forward raise (x) and sideways raise (z) per side, radians (0 = hanging) */
  aLx: number; aLz: number; aRx: number; aRz: number;
  headYaw: number; headPitch: number; headRoll: number;
  mouth: number; blink: number;
  /** 0 … 1 (join / leave) */
  scale: number;
  visible: boolean;
}
export const newPose = (): BodyPose => ({ x: 0, y: 0, z: 0, yaw: 0, sit: 1, seatH: 0.45, lift: 0, lean: 0, roll: 0, aLx: 0, aLz: 0.12, aRx: 0, aRz: 0.12, headYaw: 0, headPitch: 0, headRoll: 0, mouth: 0, blink: 0, scale: 1, visible: true });

// ---------------------------------------------------------------- proportions (metres at h = w = 1)
export const BODY_H = 0.56, LEG = 0.27, HEAD_R = 0.165, SHOULDER = 0.47, ARM = 0.27;
/** head centre above the body base */
export const HEAD_Y = BODY_H + HEAD_R * 0.78;
/** the top of the head (+ hats) above the body base */
export const HEAD_TOP = HEAD_Y + HEAD_R * 1.15;

let rampTex: THREE.DataTexture | null = null;
function ramp() {
  if (rampTex) return rampTex;
  rampTex = new THREE.DataTexture(new Uint8Array([110, 110, 122, 255, 196, 196, 204, 255, 255, 255, 255, 255]), 3, 1, THREE.RGBAFormat);
  rampTex.minFilter = rampTex.magFilter = THREE.NearestFilter; rampTex.needsUpdate = true;
  return rampTex;
}

function vcolor(g: THREE.BufferGeometry, f: (y: number) => number) {
  const p = g.attributes.position, c = new Float32Array(p.count * 3);
  for (let i = 0; i < p.count; i++) { const k = f(p.getY(i)); c[i * 3] = c[i * 3 + 1] = c[i * 3 + 2] = k; }
  g.setAttribute('color', new THREE.BufferAttribute(c, 3));
  return g;
}
const strip = (g: THREE.BufferGeometry) => { g.deleteAttribute('uv'); return g; };

/** The bean body: a lathe from the base (y 0) to the shoulders, darker "trousers" band at the bottom (vertex colour). */
function bodyGeom() {
  const pts: THREE.Vector2[] = [];
  const prof = [[0, 0], [0.12, 0.01], [0.185, 0.05], [0.205, 0.14], [0.2, 0.28], [0.185, 0.4], [0.16, 0.49], [0.115, 0.545], [0.05, 0.562], [0, 0.565]];
  for (const [r, y] of prof) pts.push(new THREE.Vector2(r, y));
  const g = new THREE.LatheGeometry(pts, 14);
  // a collar-ish lighter band near the top and dark trousers at the bottom
  return strip(vcolor(g, (y) => (y < 0.17 ? 0.42 : y > 0.5 ? 0.92 : 1)));
}
function capsule(r: number, len: number, seg = 8) {
  const g = new THREE.CapsuleGeometry(r, len, 3, seg);
  g.translate(0, -len / 2 - r * 0.6, 0);   // pivot at the top (shoulder / hip)
  return strip(g);
}
function headGeom() { return strip(new THREE.SphereGeometry(HEAD_R, 16, 12)); }
function eyesGeom() {
  const e = (x: number) => { const g = new THREE.SphereGeometry(0.027, 8, 6); g.scale(0.85, 1.25, 0.6); g.translate(x, 0.025, HEAD_R * 0.93); return g; };
  // a catch-light: vertex colour × the dark eye colour ≈ white
  const hl = (x: number) => { const g = new THREE.SphereGeometry(0.0085, 6, 4); g.translate(x + 0.008, 0.04, HEAD_R * 0.93 + 0.014); return vcolor(g, () => 70); };
  const a = vcolor(e(-0.058), () => 1), b = vcolor(e(0.058), () => 1);
  return strip(mergeGeometries([a, b, hl(-0.058), hl(0.058)])!);
}
/** mouth: a little dark half-disc in head space at its own origin (scaled in y to open) */
function mouthGeom() {
  const g = new THREE.CircleGeometry(0.04, 12, Math.PI, Math.PI);
  g.scale(1, 0.9, 1);
  return strip(g);
}
const MOUTH_AT = new THREE.Vector3(0, -0.045, HEAD_R * 0.97);
/** cheeks: two soft pink dots (part of the eyes mesh would need another colour: their own mesh) */
function cheeksGeom() {
  // a soft dot on the head's surface below each eye, facing out along the surface normal there
  const c = (x: number) => {
    const y = -0.03, z = Math.sqrt(Math.max(0, HEAD_R * HEAD_R - x * x - y * y)) + 0.003;
    const g = new THREE.CircleGeometry(0.024, 12);
    g.rotateY(Math.atan2(x, z)); g.translate(x, y, z);
    return g;
  };
  return strip(mergeGeometries([c(0.095), c(-0.095)])!);
}

// toppers (head space, head centre = origin): [geometry, colour source]
function cap(r: number, open: number, back = 0) { const g = new THREE.SphereGeometry(r, 16, 8, 0, Math.PI * 2, 0, open); g.rotateX(back); return g; }
function toppers(): { g: THREE.BufferGeometry; hair: boolean }[] {
  const R = HEAD_R;
  const hairShort = () => cap(R * 1.05, 1.25, -0.35);
  const list: { g: THREE.BufferGeometry; hair: boolean }[] = [];
  list.push({ g: hairShort(), hair: true });                                                                     // 0 short hair
  { const b = new THREE.SphereGeometry(R * 0.42, 10, 8); b.translate(0, R * 0.95, -R * 0.45); list.push({ g: mergeGeometries([hairShort(), b])!, hair: true }); }   // 1 bun
  { const parts: THREE.BufferGeometry[] = [hairShort()]; for (let i = 0; i < 6; i++) { const c = new THREE.ConeGeometry(R * 0.22, R * 0.6, 6); const a = (i / 6) * Math.PI * 2; c.rotateX(-0.6 * Math.cos(a)); c.rotateZ(0.6 * Math.sin(a)); c.translate(Math.sin(a) * R * 0.5, R * 1.02, Math.cos(a) * R * 0.5 - R * 0.15); parts.push(c); } list.push({ g: mergeGeometries(parts)!, hair: true }); } // 2 spiky
  { const c = cap(R * 1.1, 1.35, -0.15); const rim = new THREE.TorusGeometry(R * 1.02, R * 0.12, 6, 20); rim.rotateX(Math.PI / 2); rim.translate(0, R * 0.25, -R * 0.05); const pom = new THREE.SphereGeometry(R * 0.2, 8, 6); pom.translate(0, R * 1.15, -R * 0.1); list.push({ g: mergeGeometries([c, rim, pom])!, hair: false }); } // 3 beanie
  { const c = cap(R * 1.07, 1.3, -0.1); const brim = new THREE.CylinderGeometry(R * 0.75, R * 0.75, R * 0.07, 16, 1, false, -Math.PI / 2, Math.PI); brim.rotateY(Math.PI / 2); brim.translate(0, R * 0.32, R * 0.62); list.push({ g: mergeGeometries([c, brim])!, hair: false }); } // 4 cap
  { const t = new THREE.CylinderGeometry(R * 0.7, R * 0.76, R * 1.2, 16); t.translate(0, R * 1.35, 0); const b = new THREE.CylinderGeometry(R * 1.15, R * 1.15, R * 0.08, 18); b.translate(0, R * 0.8, 0); list.push({ g: mergeGeometries([t, b])!, hair: false }); } // 5 top hat
  { const c = new THREE.ConeGeometry(R * 0.55, R * 1.5, 12); c.rotateZ(0.2); c.translate(-R * 0.15, R * 1.55, 0); const p = new THREE.SphereGeometry(R * 0.17, 8, 6); p.translate(-R * 0.45, R * 2.28, 0); list.push({ g: mergeGeometries([c, p])!, hair: false }); } // 6 party hat
  { const band = new THREE.TorusGeometry(R * 1.08, R * 0.09, 6, 18, Math.PI); band.translate(0, 0.02, 0); const cupL = new THREE.CylinderGeometry(R * 0.38, R * 0.38, R * 0.3, 12); cupL.rotateZ(Math.PI / 2); cupL.translate(-R * 1.05, 0, 0); const cupR = cupL.clone(); cupR.translate(R * 2.1, 0, 0); list.push({ g: mergeGeometries([band, cupL, cupR])!, hair: false }); } // 7 headphones
  { const ear = (s: number) => { const c = new THREE.ConeGeometry(R * 0.32, R * 0.6, 4); c.rotateZ(-s * 0.35); c.translate(s * R * 0.62, R * 1.02, -R * 0.05); return c; }; list.push({ g: mergeGeometries([hairShort(), ear(1), ear(-1)])!, hair: true }); } // 8 cat ears
  { const b = new THREE.TorusGeometry(R * 0.28, R * 0.12, 6, 12); b.scale(1.3, 0.8, 0.6); b.translate(R * 0.55, R * 0.85, R * 0.2); const k = new THREE.SphereGeometry(R * 0.13, 8, 6); k.translate(R * 0.55, R * 0.85, R * 0.25); list.push({ g: mergeGeometries([hairShort(), b, k])!, hair: true }); } // 9 bow
  return list.map((t) => ({ g: strip(t.g), hair: t.hair }));
}
export const TOPPERS = 10;

const tm = new THREE.Matrix4(), tb = new THREE.Matrix4(), th = new THREE.Matrix4(), tr = new THREE.Matrix4(), tt = new THREE.Matrix4();
const te = new THREE.Euler(), tq = new THREE.Quaternion(), tv = new THREE.Vector3(), ts = new THREE.Vector3();
const ZERO = new THREE.Matrix4().makeScale(0, 0, 0);

export class AudienceBodies {
  readonly group = new THREE.Group();
  private parts: Record<'body' | 'head' | 'eyes' | 'mouth' | 'cheeks' | 'arms' | 'legs', THREE.InstancedMesh>;
  private tops: THREE.InstancedMesh[] = [];
  private topN: number[] = [];
  private owned: (THREE.Material | THREE.BufferGeometry)[] = [];
  readonly cap: number;
  /** the looks (index = person index) */
  looks: (BodyLook | null)[] = [];
  /** the shared toon materials (the engine dims them with the house lights) */
  readonly mats: THREE.MeshToonMaterial[] = [];

  constructor(cap: number) {
    this.cap = cap;
    this.group.name = 'audience-bodies';
    const toon = (o: THREE.MeshToonMaterialParameters = {}) => { const m = new THREE.MeshToonMaterial({ gradientMap: ramp(), ...o }); this.owned.push(m); this.mats.push(m); return m; };
    const mk = (g: THREE.BufferGeometry, m: THREE.Material, n: number, name: string) => {
      this.owned.push(g);
      const im = new THREE.InstancedMesh(g, m, n);
      im.name = `audience-${name}`;
      im.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      im.count = 0; im.frustumCulled = false;
      im.castShadow = false; im.receiveShadow = false;
      this.group.add(im);
      return im;
    };
    const white = new THREE.Color(1, 1, 1);
    this.parts = {
      body: mk(bodyGeom(), toon({ vertexColors: true }), cap, 'body'),
      head: mk(headGeom(), toon(), cap, 'head'),
      eyes: mk(eyesGeom(), toon({ color: '#1c1a24', vertexColors: true }), cap, 'eyes'),
      mouth: mk(mouthGeom(), toon({ color: '#5a1f2c', side: THREE.DoubleSide }), cap, 'mouth'),
      cheeks: mk(cheeksGeom(), (() => { const m = new THREE.MeshBasicMaterial({ color: '#ff8fa3', transparent: true, opacity: 0.45, depthWrite: false }); this.owned.push(m); return m; })(), cap, 'cheeks'),
      arms: mk(capsule(0.048, ARM - 0.06), toon(), cap * 2, 'arms'),
      legs: mk(capsule(0.06, LEG - 0.08), toon(), cap * 2, 'legs'),
    };
    // per-instance colours need an instanceColor buffer from the start
    for (const k of ['body', 'head', 'arms', 'legs'] as const) for (let i = 0; i < this.parts[k].instanceMatrix.count; i++) this.parts[k].setColorAt(i, white);
    for (const t of toppers()) {
      const im = mk(t.g, toon(), cap, `top${this.tops.length}`);
      for (let i = 0; i < cap; i++) im.setColorAt(i, white);
      im.userData.hair = t.hair;
      this.tops.push(im);
    }
    this.topN = this.tops.map(() => 0);
  }

  /** Write every person's pose (index = person, poses[i] = null → hidden). Colours are written when `colours` is set
   *  (a look changed). */
  write(poses: (BodyPose | null)[], colours: boolean) {
    const P = this.parts;
    const n = Math.min(this.cap, poses.length);
    for (const k of PART_KEYS) P[k].count = k === 'arms' || k === 'legs' ? n * 2 : n;
    this.topN.fill(0);
    for (let i = 0; i < n; i++) {
      const p = poses[i], look = this.looks[i];
      // every person with a look keeps a fixed hat slot (hidden ones a zero matrix there): colours only change with the line-up
      const ti = look ? look.topper % this.tops.length : -1, tk = ti >= 0 ? this.topN[ti]++ : -1;
      if (ti >= 0 && colours) this.tops[ti].setColorAt(tk, this.tops[ti].userData.hair ? look!.hair : look!.hat);
      if (!p || !look || !p.visible || p.scale <= 0.001) {
        if (ti >= 0) this.tops[ti].setMatrixAt(tk, ZERO);
        for (const k of FACE_KEYS) P[k].setMatrixAt(i, ZERO);
        P.arms.setMatrixAt(i * 2, ZERO); P.arms.setMatrixAt(i * 2 + 1, ZERO);
        P.legs.setMatrixAt(i * 2, ZERO); P.legs.setMatrixAt(i * 2 + 1, ZERO);
        continue;
      }
      const s = p.scale, H = look.h * s, W = look.w * s;
      // the base of the body: on the seat when sitting, on the legs when standing
      const baseY = p.y + baseOf(p, look) * s + p.lift;
      // root frame: position + yaw
      tb.makeRotationY(p.yaw).setPosition(p.x, baseY, p.z);
      te.set(p.lean, 0, p.roll, 'YXZ'); tq.setFromEuler(te);
      tr.makeRotationFromQuaternion(tq);
      tb.multiply(tr);                                                 // body frame (unscaled)
      tm.copy(tb).scale(ts.set(W, H, W)); P.body.setMatrixAt(i, tm);
      // head
      te.set(p.headPitch, p.headYaw, p.headRoll, 'YXZ'); tq.setFromEuler(te);
      th.compose(tv.set(0, HEAD_Y * H, 0), tq, ts.set(s * look.h * 0.98, s * look.h * 0.98, s * look.h * 0.98));
      th.premultiply(tb);
      P.head.setMatrixAt(i, th);
      tm.copy(th); if (p.blink > 0) tm.scale(ts.set(1, Math.max(0.08, 1 - p.blink), 1)); P.eyes.setMatrixAt(i, tm);
      P.cheeks.setMatrixAt(i, th);
      tm.copy(th).multiply(tt.makeTranslation(MOUTH_AT.x, MOUTH_AT.y, MOUTH_AT.z)).scale(ts.set(1, 0.25 + 1.6 * p.mouth, 1)); P.mouth.setMatrixAt(i, tm);
      // topper
      this.tops[ti].setMatrixAt(tk, th);
      // arms (shoulders on the body's sides, pivot at the top)
      for (let side = 0; side < 2; side++) {
        const sx = side ? 1 : -1;
        const ax = side ? p.aRx : p.aLx, az = side ? p.aRz : p.aLz;
        te.set(-ax, 0, sx * az, 'YXZ'); tq.setFromEuler(te);
        tm.compose(tv.set(sx * 0.165 * W, SHOULDER * H, 0), tq, ts.set(s * look.h, s * look.h, s * look.h)).premultiply(tb);
        P.arms.setMatrixAt(i * 2 + side, tm);
      }
      // legs: hanging straight when standing; forward and down from the seat edge when sitting
      for (let side = 0; side < 2; side++) {
        const sx = side ? 1 : -1;
        const pitch = p.sit * 1.25;   // thighs forward
        te.set(-pitch, 0, 0, 'YXZ'); tq.setFromEuler(te);
        tm.makeRotationY(p.yaw).setPosition(p.x, baseY - p.lift * (1 - p.sit) * 0, p.z);
        tt.compose(tv.set(sx * 0.085 * W, 0.04 * H, 0.03 * p.sit), tq, ts.set(s * look.h, s * look.h, s * look.h));
        tm.multiply(tt);
        P.legs.setMatrixAt(i * 2 + side, tm);
      }
      if (colours) {
        P.body.setColorAt(i, look.shirt); P.head.setColorAt(i, look.skin);
        P.arms.setColorAt(i * 2, look.shirt); P.arms.setColorAt(i * 2 + 1, look.shirt);
        tc.copy(look.shirt).multiplyScalar(0.42); P.legs.setColorAt(i * 2, tc); P.legs.setColorAt(i * 2 + 1, tc);
      }
    }
    for (let t = 0; t < this.tops.length; t++) { this.tops[t].count = this.topN[t]; this.tops[t].instanceMatrix.needsUpdate = true; if (colours && this.tops[t].instanceColor) this.tops[t].instanceColor!.needsUpdate = true; }
    for (const k of PART_KEYS) { P[k].instanceMatrix.needsUpdate = true; if (colours && P[k].instanceColor) P[k].instanceColor!.needsUpdate = true; }
  }

  /** Head top (root space) of a pose with a look: where the name tag sits. */
  headTop(p: BodyPose, look: BodyLook, out: THREE.Vector3): THREE.Vector3 {
    const s = p.scale;
    const baseY = p.y + baseOf(p, look) * s + p.lift;
    const top = HEAD_TOP * look.h * s * (look.topper === 5 ? 1.35 : look.topper === 6 ? 1.45 : 1);
    // lean moves the head forward / back a little
    return out.set(p.x + Math.sin(p.yaw) * Math.sin(p.lean) * top, baseY + top * Math.cos(p.lean), p.z + Math.cos(p.yaw) * Math.sin(p.lean) * top);
  }

  dispose() {
    for (const o of this.owned) o.dispose();
    this.group.removeFromParent();
  }
  drawCalls() { return Object.values(this.parts).filter((m) => m.count > 0).length + this.tops.filter((m) => m.count > 0).length; }
}
const tc = new THREE.Color();
const PART_KEYS = ['body', 'head', 'eyes', 'mouth', 'cheeks', 'arms', 'legs'] as const;
const FACE_KEYS = ['body', 'head', 'eyes', 'mouth', 'cheeks'] as const;
/** The body base above the seat origin: on the seat when sitting; standing up from a seat = a little above it (the legs
 *  hang straight into the bench); standing seats = on the legs. */
function baseOf(p: BodyPose, look: BodyLook) {
  const stand = p.seatH > 0 ? p.seatH + 0.17 * look.h : LEG * look.h;
  return p.sit * p.seatH + (1 - p.sit) * stand;
}
