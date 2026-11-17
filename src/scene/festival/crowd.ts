// The festival audience: hundreds of instanced low-poly people (one draw) in the room's AUDIENCE_AREA_xx anchors,
// animated in the vertex shader from the beat: bouncing on the beat, hands up in builds and drops, fist pumps on the
// kick, swaying in breakdowns, phone lights up in the slow parts. Lit like a festival crowd from the stage: a dark body
// with a rim and top light in the show's colours. A room may supply its own crowd unit (scene.json festival.crowd.unit:
// a GLB with meshes CROWD_BODY, ARM_L, ARM_R whose origins are the shoulders). People between the camera and a
// performer's face, or right in front of the lens, are hidden.
//   AUDIENCE_AREA_xx  empty: the centre of an area; extras rx / rz (half extents, m), density (people / m², default 1.1),
//                     shape 'ellipse' | 'box' (default box), keepOut "x,z,r;…" (room frame)
//   AUDIENCE_SEAT_xx  single spots (chat-driven audience members, other engines); the crowd keeps 0.6 m clear of them
import * as THREE from 'three';
import { FESTIVAL_BUDGET, hash3, type Tier } from '../../../shared/festival.ts';
import { mergeGeos } from './movers.ts';

const VS = /* glsl */ `
uniform float uBeat, uKick, uHands, uJump, uSway, uPhones, uTime;
uniform vec3 uShoulderL, uShoulderR;
attribute vec4 aPerson;   // phase, enthusiasm, height scale, hidden
attribute float aPart;    // 0 body, 1 left arm, 2 right arm, 3 phone
varying vec3 vN; varying vec3 vW; varying float vPart; varying float vPhone; varying float vTone;
mat3 rotZ(float a) { float c = cos(a), s = sin(a); return mat3(c, s, 0.0, -s, c, 0.0, 0.0, 0.0, 1.0); }
void main() {
  vPart = aPart; vPhone = 0.0; vTone = aPerson.y;
  if (aPerson.w > 0.5) { gl_Position = vec4(2.0, 2.0, 2.0, 1.0); return; }
  float ph = aPerson.x, en = aPerson.y;
  vec3 p = position * aPerson.z; vec3 n = normal;
  float bp = fract(uBeat + ph * 0.12);
  // (a third of the crowd keeps a hand / fist up whatever the section; the rest follow the music)
  float hands = clamp(uHands * (0.45 + 0.75 * en) + 0.75 * step(0.66, fract(ph * 3.71)), 0.0, 1.0);
  float pump = uKick * en * 0.5;
  // phone holders (in the slow parts) keep their right hand up with the light on
  float phoneOn = max(uPhones * step(0.62, fract(ph * 7.3)), step(0.93, fract(ph * 7.3)));   // (a few phones are always up)
  if (aPart > 0.5) {
    float side = aPart < 1.5 ? 1.0 : -1.0;
    vec3 sh = (aPart < 1.5 ? uShoulderL : uShoulderR) * aPerson.z;
    // arms: hanging (0) → raised (hands up, a little out to the side), fist pump on the kick
    float lift = hands * (2.6 + 0.25 * sin(uTime * 2.0 + ph * 6.0)) + pump * 0.6 * step(0.3, hands);
    if (side < 0.0) lift = max(lift, phoneOn * 2.5);
    float a = -lift, o2 = side * (0.2 + 0.25 * hands);
    mat3 R = rotZ(o2);
    mat3 Rl = mat3(1.0, 0.0, 0.0, 0.0, cos(a), sin(a), 0.0, -sin(a), cos(a));
    p = sh + R * (Rl * (p - sh)); n = R * (Rl * n);
    if (aPart > 2.5) { vPhone = phoneOn; if (phoneOn < 0.01) p = vec3(0.0, -10.0, 0.0); }
  }
  // bounce + sway
  float jump = uJump * (0.5 + 0.7 * en) * pow(abs(sin(3.14159 * bp)), 1.5) * 0.16;
  float sway = uSway * sin(uBeat * 1.5708 + ph * 6.28) * 0.08;
  p.x += sway * p.y; p.y += jump;
  vec4 w = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vW = w.xyz; vN = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * n);
  gl_Position = projectionMatrix * viewMatrix * w;
}`;
const FS = /* glsl */ `
uniform vec3 uBase, uWash, uTop; uniform float uLevel; uniform float uLit; uniform float uTopW;
varying vec3 vN; varying vec3 vW; varying float vPart; varying float vPhone; varying float vTone;
void main() {
  if (vPart > 2.5) { gl_FragColor = vec4(vec3(0.75, 0.85, 1.0) * 1.3 * vPhone, 1.0); return; }
  vec3 v = normalize(cameraPosition - vW);
  float rim = pow(1.0 - abs(dot(vN, v)), 2.2);
  float top = max(0.0, vN.y);
  // (a warm shirt on some people: relative to the room's crowd colour - a fixed lift turned a dark silhouette crowd orange)
  vec3 base = uBase * (0.6 + 0.9 * vTone) * (1.0 + 0.8 * step(0.7, vTone));
  vec3 col = base + (uWash * rim * 0.32 + uTop * top * 0.16 * uTopW) * uLevel * uLit;
  gl_FragColor = vec4(col, 1.0);
}`;

/** The built-in person (≈ 150 triangles): body + head, two arms (pivot at the shoulders), a phone in the right hand. */
function person(): { geo: THREE.BufferGeometry; shL: THREE.Vector3; shR: THREE.Vector3 } {
  const part = (g: THREE.BufferGeometry, id: number) => { g = g.index ? g.toNonIndexed() : g; g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(id), 1)); return g; };
  // (≈ 330 triangles: two legs, hips, a tapered torso with shoulders, a neck, a head, arms with forearms + hands)
  const legL = new THREE.CylinderGeometry(0.075, 0.055, 0.86, 7); legL.translate(0.095, 0.43, 0);
  const legR = new THREE.CylinderGeometry(0.075, 0.055, 0.86, 7); legR.translate(-0.095, 0.43, 0);
  const hips = new THREE.SphereGeometry(0.17, 9, 5); hips.scale(1, 0.55, 0.72); hips.translate(0, 0.88, 0);
  // (a human back-view silhouette: a waist narrower than the chest, broad sloped shoulders, a neck, a small head -
  // a straight cylinder body under a rim light read as a pawn)
  const torso = new THREE.CylinderGeometry(0.21, 0.13, 0.56, 10); torso.scale(1, 1, 0.55); torso.translate(0, 1.15, 0);
  const shoulders = new THREE.SphereGeometry(0.24, 10, 6); shoulders.scale(1.0, 0.33, 0.5); shoulders.translate(0, 1.41, 0);
  const neck = new THREE.CylinderGeometry(0.05, 0.06, 0.12, 6); neck.translate(0, 1.5, 0);
  const head = new THREE.SphereGeometry(0.098, 10, 7); head.scale(0.88, 1.12, 1); head.translate(0, 1.645, 0.01);
  const shL = new THREE.Vector3(0.22, 1.41, 0), shR = new THREE.Vector3(-0.22, 1.41, 0);
  const arm = (sh: THREE.Vector3, s: number) => {
    const up = new THREE.CylinderGeometry(0.045, 0.04, 0.3, 6); up.translate(sh.x + s * 0.02, sh.y - 0.16, 0);
    const lo = new THREE.CylinderGeometry(0.038, 0.032, 0.28, 6); lo.translate(sh.x + s * 0.03, sh.y - 0.45, 0.01);
    const hand = new THREE.SphereGeometry(0.042, 6, 4); hand.translate(sh.x + s * 0.03, sh.y - 0.62, 0.01);
    return mergeGeos([up, lo, hand]);
  };
  const armL = arm(shL, 1), armR = arm(shR, -1);
  const phone = new THREE.PlaneGeometry(0.05, 0.08); phone.translate(shR.x - 0.03, shR.y - 0.66, 0.04);
  const parts = [part(legL, 0), part(legR, 0), part(hips, 0), part(torso, 0), part(shoulders, 0), part(neck, 0), part(head, 0), part(armL, 1), part(armR, 2), part(phone, 3)];
  const geo = mergeGeos(parts);
  const ap = new Float32Array(parts.reduce((a, g) => a + g.getAttribute('aPart').count, 0));
  let o = 0; for (const g of parts) { ap.set(g.getAttribute('aPart').array as Float32Array, o); o += g.getAttribute('aPart').count; }
  geo.setAttribute('aPart', new THREE.BufferAttribute(ap, 1));
  for (const g of parts) g.dispose();
  return { geo, shL, shR };
}

export interface CrowdArea { center: THREE.Vector3; yaw: number; rx: number; rz: number; density: number; ellipse: boolean; keepOut: [number, number, number][] }
export interface CrowdFrame { beat: number; kick: number; hands: number; jump: number; sway: number; phones: number; time: number; level: number; wash: THREE.Color; top: THREE.Color }

export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  private attr: Float32Array;
  private pos: THREE.Vector3[] = [];
  private U: Record<string, THREE.IUniform>;
  private hideAt = 0;
  private changedAt: number[] = [];
  /** waving flags on poles in the crowd (scene.json festival.crowd.flags) */
  readonly flags: THREE.InstancedMesh | null = null;
  private flagAttr: Float32Array | null = null;
  private flagPos: THREE.Vector3[] = [];
  constructor(areas: CrowdArea[], seats: THREE.Vector3[], tier: Tier, base: string, density = 1, unit?: { geo: THREE.BufferGeometry; shL: THREE.Vector3; shR: THREE.Vector3 }, boost = 1, flags = 0, flagColors: string[] = [], lit = 1, flagsFar = 0) {
    const max = Math.round(FESTIVAL_BUDGET[tier].crowd * density * boost);
    // places: jittered grid per area, sorted front (nearest the stage, -Z of the area… by default the stage is at -Z) first
    const cand: { p: THREE.Vector3; yaw: number; k: number }[] = [];
    let ai = 0;
    for (const a of areas) {
      const step = 1 / Math.sqrt(Math.max(0.2, a.density));
      const c = Math.cos(a.yaw), s = Math.sin(a.yaw);
      for (let z = -a.rz; z <= a.rz; z += step) for (let x = -a.rx; x <= a.rx; x += step) {
        // (no rows: each person anywhere in a cell 1.3 cells wide, the rows offset by half a cell at random)
        const row = hash3(ai + 13, Math.round(z * 10), 5) * step;
        const jx = x + row + (hash3(ai, Math.round(x * 10), Math.round(z * 10)) - 0.5) * step * 1.3, jz = z + (hash3(ai + 7, Math.round(x * 10), Math.round(z * 10)) - 0.5) * step * 1.3;
        if (a.ellipse && (jx * jx) / (a.rx * a.rx) + (jz * jz) / (a.rz * a.rz) > 1) continue;
        const p = new THREE.Vector3(a.center.x + jx * c + jz * s, a.center.y, a.center.z - jx * s + jz * c);
        if (a.keepOut.some(([kx, kz, kr]) => Math.hypot(p.x - kx, p.z - kz) < kr)) continue;
        if (seats.some((q) => Math.hypot(p.x - q.x, p.z - q.z) < 0.6)) continue;
        // people face the stage (towards -Z of the room) with a little scatter; the front rows denser
        // (front = nearest the stage in the room (-Z), whatever the area's own yaw: an area turned to face the stage (yaw
        // 180, every room) sorted its back rows first, and a budget cut (a lower tier, the auto-downgrade) kept the rows
        // behind a wide camera and emptied the field in front of it)
        const ext = Math.abs(a.rz * c) + Math.abs(a.rx * s);
        cand.push({ p, yaw: Math.PI + (hash3(ai, Math.round(jx * 50), Math.round(jz * 50)) - 0.5) * 0.7, k: (p.z - a.center.z + ext) / (2 * Math.max(1e-3, ext)) + hash3(ai + 3, Math.round(jx * 30), Math.round(jz * 30)) * 0.35 });
      }
      ai++;
    }
    cand.sort((a, b) => a.k - b.k);
    const keep = cand.slice(0, max);
    const P = unit ?? person();
    const g = P.geo;
    const n = Math.max(1, keep.length);
    this.attr = new Float32Array(n * 4);
    g.setAttribute('aPerson', new THREE.InstancedBufferAttribute(this.attr, 4));
    this.U = { uTopW: { value: 1 }, uLit: { value: lit }, uBeat: { value: 0 }, uKick: { value: 0 }, uHands: { value: 0 }, uJump: { value: 0 }, uSway: { value: 0 }, uPhones: { value: 0 }, uTime: { value: 0 }, uLevel: { value: 1 },
      uShoulderL: { value: P.shL }, uShoulderR: { value: P.shR }, uBase: { value: new THREE.Color(base).convertSRGBToLinear() }, uWash: { value: new THREE.Color() }, uTop: { value: new THREE.Color() } };
    const mat = new THREE.ShaderMaterial({ vertexShader: VS, fragmentShader: FS, uniforms: this.U, fog: false });
    this.mesh = new THREE.InstancedMesh(g, mat, n);
    this.mesh.name = 'festival:crowd'; this.mesh.frustumCulled = false;
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3();
    keep.forEach((c, i) => {
      // heights 1.5-1.95 m and builds vary (a crowd, not an auditorium of identical people)
      const h = 0.86 + 0.26 * hash3(i, 11) * hash3(i, 12) + 0.08 * hash3(i, 13), wd = 0.85 + 0.35 * hash3(i, 14);
      M.compose(c.p, Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), c.yaw), S.set(wd, 1, wd)); this.mesh.setMatrixAt(i, M);
      this.attr.set([hash3(i, 1), hash3(i, 2), h, 0], i * 4);
      this.pos.push(c.p.clone().add(new THREE.Vector3(0, 1.6 * h, 0)));
    });
    this.mesh.count = keep.length;
    // flags: on poles held up by people spread through the crowd (fewer on the lower tiers)
    const nf = Math.min(keep.length, Math.round(flags * (tier === 'low' ? 0.3 : tier === 'medium' ? 0.6 : 1)));
    const zMin = keep.reduce((m, q) => Math.min(m, q.p.z), Infinity);
    if (nf > 0) {
      const fg = flagGeometry();
      this.flagAttr = new Float32Array(nf * 2);
      fg.setAttribute('aFlagI', new THREE.InstancedBufferAttribute(this.flagAttr, 2));
      const fm = new THREE.ShaderMaterial({ vertexShader: FLAG_VS, fragmentShader: FLAG_FS, uniforms: this.U, fog: false, side: THREE.DoubleSide });
      const fl = new THREE.InstancedMesh(fg, fm, nf);
      fl.name = 'festival:flags'; fl.frustumCulled = false;
      const cols = flagColors.length ? flagColors : ['#c8102e', '#ffffff', '#1d4ed8', '#ffb300', '#16a34a', '#111111'];
      const C = new THREE.Color();
      for (let i = 0; i < nf; i++) {
        // (held up in the middle and the back of the crowd: the front rows stay clear for the stage)
        // (held up in the front half of the field: the back rows near a wide camera stay clear)
        // (festival.crowd.flagsFar: that share of the flags is held up anywhere in the field - near a wide camera too)
        const near = keep.filter((q) => q.p.z > zMin + 15 && q.p.z < zMin + 45 + 150 * flagsFar);   // (in the crowd, never by the stage edge)
        const pool = near.length > 40 ? near : keep;
        const c = pool[Math.min(pool.length - 1, Math.floor(pool.length * (0.08 + 0.9 * hash3(i, 91))))];
        M.compose(c.p, Q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), hash3(i, 92) * Math.PI * 2), S.set(0.55 + 0.3 * hash3(i, 96), 0.75 + 0.5 * hash3(i, 93), 0.55 + 0.3 * hash3(i, 96))); fl.setMatrixAt(i, M);   // (smaller cloth, poles at varied heights)
        fl.setColorAt(i, C.set(cols[i % cols.length]).convertSRGBToLinear());
        this.flagAttr.set([hash3(i, 94) * 6.28, 0], i * 2);
        this.flagPos.push(c.p.clone().add(new THREE.Vector3(0, 4.2, 0)));
      }
      (this as { flags: THREE.InstancedMesh | null }).flags = fl;
    }
  }
  get count() { return this.mesh.count; }

  /** hide people near the lens and between the camera and the protected faces (room frame), a few times a second */
  protect(cam: THREE.Vector3, faces: THREE.Vector3[], now: number) {
    if (now - this.hideAt < 250) return;
    this.hideAt = now;
    const ab = new THREE.Vector3(), ap = new THREE.Vector3();
    let changed = false;
    for (let i = 0; i < this.pos.length; i++) {
      const p = this.pos[i];
      // (hysteresis + at most one change a second per person: a person hiding / reappearing in front of a bright stage
      // as an avatar's face moves an inch was a flicker of a region of the frame)
      const was = this.attr[i * 4 + 3] > 0.5, k = was ? 1.35 : 1;
      if (now - (this.changedAt[i] ?? -1e9) < 1000) continue;
      let hide = p.distanceTo(cam) < 2.2 * k;
      for (const f of faces) {
        if (hide) break;
        ab.copy(f).sub(cam); const L2 = ab.lengthSq(); if (L2 < 1e-6) continue;
        const t = Math.max(0, Math.min(1, ap.copy(p).sub(cam).dot(ab) / L2));
        if (t > 0.02 && t < 0.98 && ap.copy(cam).addScaledVector(ab, t).distanceTo(p) < 0.55 * k) hide = true;
      }
      const v = hide ? 1 : 0;
      if (this.attr[i * 4 + 3] !== v) { this.attr[i * 4 + 3] = v; changed = true; this.changedAt[i] = now; }
    }
    if (changed) (this.mesh.geometry.getAttribute('aPerson') as THREE.InstancedBufferAttribute).needsUpdate = true;
    // flags: never in front of a face or right at the lens
    if (this.flags && this.flagAttr) {
      let fc = false;
      for (let i = 0; i < this.flagPos.length; i++) {
        const p = this.flagPos[i];
        let hide = p.distanceTo(cam) < 6;
        for (const f of faces) {
          if (hide) break;
          ab.copy(f).sub(cam); const L2 = ab.lengthSq(); if (L2 < 1e-6) continue;
          const t = Math.max(0, Math.min(1, ap.copy(p).sub(cam).dot(ab) / L2));
          if (t > 0.02 && t < 0.98 && ap.copy(cam).addScaledVector(ab, t).distanceTo(p) < 1.6) hide = true;
        }
        const v = hide ? 1 : 0;
        if (this.flagAttr[i * 2 + 1] !== v) { this.flagAttr[i * 2 + 1] = v; fc = true; }
      }
      if (fc) (this.flags.geometry.getAttribute('aFlagI') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  /** how much of the show's top light reaches the crowd (festival.crowd.top: 0 = a silhouette crowd, the rim only) */
  setTop(v: number) { this.U.uTopW.value = v; }

  /** the room's own rim colour on the crowd (festival.crowd.rim: fire light on the heads, whatever the show's wash) */
  rimTint: THREE.Color | null = null;

  update(f: CrowdFrame) {
    const U = this.U;
    U.uBeat.value = f.beat; U.uKick.value = f.kick; U.uHands.value = f.hands; U.uJump.value = f.jump; U.uSway.value = f.sway; U.uPhones.value = f.phones; U.uTime.value = f.time; U.uLevel.value = f.level;
    (U.uWash.value as THREE.Color).copy(f.wash); (U.uTop.value as THREE.Color).copy(f.top);
    if (this.rimTint) { (U.uWash.value as THREE.Color).lerp(this.rimTint, 0.45); (U.uTop.value as THREE.Color).lerp(this.rimTint, 0.3); }
  }

  dispose() {
    this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); this.mesh.removeFromParent();
    if (this.flags) { this.flags.geometry.dispose(); (this.flags.material as THREE.Material).dispose(); this.flags.removeFromParent(); }
  }
}

/** a flag on a pole: the pole (a thin box, 5 m) + a 2 × 1.25 m cloth (8 × 4 quads, aCloth = how far from the pole) */
function flagGeometry(): THREE.BufferGeometry {
  const pole = new THREE.BoxGeometry(0.05, 5.0, 0.05); pole.translate(0, 2.5, 0);
  const cloth = new THREE.PlaneGeometry(2.0, 1.25, 8, 4); cloth.translate(1.0 + 0.03, 4.3, 0);
  const pg = pole.toNonIndexed(), cg = cloth.toNonIndexed();
  const g = new THREE.BufferGeometry();
  const P = [pg, cg].map((x) => x.getAttribute('position').array as Float32Array);
  const pos = new Float32Array(P[0].length + P[1].length); pos.set(P[0]); pos.set(P[1], P[0].length);
  const cl = new Float32Array(pos.length / 3);
  for (let i = P[0].length / 3; i < cl.length; i++) cl[i] = Math.max(0.001, (pos[i * 3] - 0.03) / 2.0);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('aCloth', new THREE.BufferAttribute(cl, 1));
  pole.dispose(); cloth.dispose(); pg.dispose(); cg.dispose();
  return g;
}
const FLAG_VS = /* glsl */ `
uniform float uTime; uniform float uKick;
attribute float aCloth; attribute vec2 aFlagI;
varying vec3 vCol; varying float vCloth; varying float vFold;
void main() {
  vec3 p = position; vFold = 0.0;
  if (aCloth > 0.0) {
    float ph = aFlagI.x;
    p.z += sin(p.x * 4.0 - uTime * 5.2 + ph) * 0.16 * aCloth + sin(p.x * 9.0 - uTime * 8.0 + ph * 2.0) * 0.04 * aCloth;
    vFold = cos(p.x * 4.0 - uTime * 5.2 + ph) * aCloth;
    p.y += sin(p.x * 3.0 - uTime * 4.0 + ph) * 0.05 * aCloth;
  }
  // flags wave up a little on the kick (held up higher)
  p.y += 0.25 * uKick * step(0.5, aCloth + step(2.5, position.y));
  vCol = instanceColor; vCloth = aCloth;
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  gl_Position = aFlagI.y > 0.5 ? vec4(2.0, 2.0, 2.0, 1.0) : projectionMatrix * viewMatrix * wp;
}`;
const FLAG_FS = /* glsl */ `
uniform vec3 uWash; uniform vec3 uTop; uniform float uLevel; uniform float uLit;
varying vec3 vCol; varying float vCloth; varying float vFold;
void main() {
  vec3 c = vCloth > 0.0 ? (vCol * (0.22 + 0.45 * uLevel) + uWash * 0.08 + uTop * 0.06) * max(uLit, 0.7) * (0.55 + 0.45 * (0.5 + 0.5 * vFold)) : vec3(0.05);   // (cloth keeps its colour; the folds shade it)
  gl_FragColor = vec4(c, 1.0);
}`;

/** A room crowd unit (GLB: CROWD_BODY + ARM_L / ARM_R (+ PHONE)) → the crowd geometry, or null. */
export function unitFrom(root: THREE.Object3D): { geo: THREE.BufferGeometry; shL: THREE.Vector3; shR: THREE.Vector3 } | null {
  root.updateMatrixWorld(true);
  const get = (n: string) => { let o: THREE.Mesh | null = null; root.traverse((x) => { if (!o && x.name === n && (x as THREE.Mesh).isMesh) o = x as THREE.Mesh; }); return o as THREE.Mesh | null; };
  const body = get('CROWD_BODY'), al = get('ARM_L'), ar = get('ARM_R'), ph = get('PHONE');
  if (!body || !al || !ar) return null;
  const bake = (m: THREE.Mesh, id: number) => { let g = m.geometry.clone(); g.applyMatrix4(m.matrixWorld); if (g.index) g = g.toNonIndexed(); if (!g.getAttribute('uv')) g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count * 2), 2)); if (!g.getAttribute('normal')) g.computeVertexNormals(); g.setAttribute('aPart', new THREE.BufferAttribute(new Float32Array(g.getAttribute('position').count).fill(id), 1)); return g; };
  const parts = [bake(body, 0), bake(al, 1), bake(ar, 2), ...(ph ? [bake(ph, 3)] : [])];
  const geo = mergeGeos(parts);
  const ap = new Float32Array(parts.reduce((a, g) => a + g.getAttribute('aPart').count, 0));
  let o = 0; for (const g of parts) { ap.set(g.getAttribute('aPart').array as Float32Array, o); o += g.getAttribute('aPart').count; }
  geo.setAttribute('aPart', new THREE.BufferAttribute(ap, 1));
  const shL = al.getWorldPosition(new THREE.Vector3()), shR = ar.getWorldPosition(new THREE.Vector3());
  return { geo, shL, shR };
}
