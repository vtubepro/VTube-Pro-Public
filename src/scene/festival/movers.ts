// Moving heads (beam / spot / wash): instanced bodies (base + head + lens), volumetric cones and floor hits.
//   cones   one InstancedMesh for every class: a unit cylinder shaped in the vertex shader (lens radius → end radius
//           over the throw), additive; fragment = soft edge (view angle) × throw falloff × scrolling dust noise × haze,
//           a gobo break-up for spots, very soft washes, a "hot lens" boost when the beam points at the camera. Beam
//           fixtures split into 3 through a spinning prism on High / Ultra (extra instances, same draw).
//   floor   where a spot / wash meets the deck or the audience floor: a soft gobo pool (one instanced draw).
//   bodies  base + head + lens: 3 instanced draws (the head turns with pan / tilt, the lens takes the beam colour).
// Lens glare (the fake bloom) goes to the shared Glare. Everything lives in the room's frame.
import * as THREE from 'three';
import { FESTIVAL_BUDGET, heldLevel, type Tier } from '../../../shared/festival.ts';
import type { FestivalGov, GovOwner } from './gov.ts';
import { evalMover, type LookFrame, type MoverOut } from '../../../shared/festivalDirector.ts';
import { NOISE_GLSL, aimDir, fxMaterial, glow, lin, type Fixture, type Glare } from './common.ts';
import { roleMover, type RGB } from '../../../shared/festivalRoles.ts';

type MoverKind = 'beam' | 'spot' | 'wash';
const SPEC: Record<MoverKind, { half: [number, number]; reach: number; lensR: number; edge: number; gain: number; dust: number; gobo: number }> = {
  beam: { half: [1.2, 4.5], reach: 75, lensR: 0.08, edge: 2.0, gain: 3.2, dust: 0.55, gobo: 0 },
  spot: { half: [5, 13], reach: 48, lensR: 0.11, edge: 2.0, gain: 1.1, dust: 0.45, gobo: 1 },
  wash: { half: [11, 24], reach: 26, lensR: 0.16, edge: 3.4, gain: 0.1, dust: 0.3, gobo: 0 },
};

export const CONE_VS = /* glsl */ `
attribute vec4 aShape;   // lens radius, end radius, throw (m), gobo spin
attribute vec4 aLook;    // gobo kind (0 none, 1 spot), edge exponent, dust, gain
varying float vAlong; varying float vFres; varying vec3 vCol; varying vec3 vWorld; varying float vAng; varying vec4 vLook; varying float vSpin; varying float vHot;
void main() {
  float v = uv.y;                                   // 0 at the lens, 1 at the end of the throw
  float r = mix(aShape.x, aShape.y, v);
  vec3 p = vec3(position.x * r, v * aShape.z, position.z * r);
  vec4 wp = modelMatrix * instanceMatrix * vec4(p, 1.0);
  vec4 mv = viewMatrix * wp;
  float slope = (aShape.y - aShape.x) / max(0.01, aShape.z);
  vec3 nl = normalize(vec3(position.x, -slope, position.z));
  vec3 nn = normalize(mat3(viewMatrix) * mat3(modelMatrix) * mat3(instanceMatrix) * nl);
  vFres = abs(dot(nn, normalize(-mv.xyz)));
  vec3 axis = normalize(mat3(modelMatrix) * mat3(instanceMatrix) * vec3(0.0, 1.0, 0.0));
  vec3 lensW = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
  vHot = max(0.0, dot(axis, normalize(cameraPosition - lensW)));
  vAlong = v; vCol = instanceColor; vWorld = wp.xyz; vAng = atan(position.z, position.x); vLook = aLook; vSpin = aShape.w;
  gl_Position = projectionMatrix * mv;
}`;
export const CONE_FS = /* glsl */ `
uniform float uTime; uniform float uHaze; uniform float uDust; uniform float uHotK;
varying float vAlong; varying float vFres; varying vec3 vCol; varying vec3 vWorld; varying float vAng; varying vec4 vLook; varying float vSpin; varying float vHot;
${NOISE_GLSL}
void main() {
  float along = clamp(vAlong, 0.0, 1.0);
  float edge = pow(clamp(vFres, 0.0, 1.0), vLook.y);
  float throwF = pow(1.0 - along, 1.35) * (0.35 + 0.65 * smoothstep(0.0, 0.015, along)) + 0.25 * exp(-along * 40.0);
  float dust = 1.0;
  if (uDust > 0.5) dust = 0.35 + 1.3 * smoothstep(0.25, 0.8, fbm3(vWorld * 0.42 + vec3(0.0, -uTime * 0.35, uTime * 0.22))) * vLook.z + (1.0 - vLook.z) * 0.45;
  float gobo = 1.0;
  if (vLook.x > 0.5) gobo = 0.35 + 0.65 * smoothstep(0.15, 0.75, 0.5 + 0.5 * cos(vAng * 6.0 + vSpin));
  float hot = 1.0 + uHotK * pow(vHot, 16.0);
  float a = edge * throwF * dust * gobo * uHaze * vLook.w * hot;
  gl_FragColor = vec4(vCol * a, a);
}`;
const POOL_VS = /* glsl */ `
attribute vec4 aPool;  // gobo (0/1), spin, softness, -
varying vec2 vUv; varying vec3 vCol; varying vec4 vPool;
void main() { vUv = uv; vCol = instanceColor; vPool = aPool; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;
const POOL_FS = /* glsl */ `
varying vec2 vUv; varying vec3 vCol; varying vec4 vPool;
void main() {
  vec2 d = vUv - 0.5; float r = length(d) * 2.0;
  float disc = smoothstep(1.0, 1.0 - vPool.z, r);
  float g = 1.0;
  if (vPool.x > 0.5) g = 0.3 + 0.7 * smoothstep(0.2, 0.7, 0.5 + 0.5 * cos(atan(d.y, d.x) * 6.0 + vPool.y)) * smoothstep(0.0, 0.25, r);
  float a = disc * g;
  gl_FragColor = vec4(vCol * a, a);
}`;
const LENS_FS = /* glsl */ `varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.0); }`;
const LENS_VS = /* glsl */ `varying vec3 vCol; void main() { vCol = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;

interface Mover extends GovOwner {
  f: Fixture; kind: MoverKind;
  /** room-frame lens position, rest yaw (deg) from the anchor's facing, glare slot */
  lens: THREE.Vector3; restYaw: number; slot: number;
  out: MoverOut;
  /** face protection fade (0..1) and the beam drawn this frame (for performer lighting / debug) */
  fade: number; dir: THREE.Vector3; level: number;
  /** the lens glare's facing term, low-passed (Safe flashes ON) */
  faceS?: number;
  /** the beam's last direction and its swing speed (rad/s, low-passed): Safe flashes ON dims fast swings */
  pdir?: THREE.Vector3; spd?: number;
}
/** Safe flashes ON: the swing speed (rad/s) at which a beam is half as bright */
export const SAFE_SWING = 1.0, SAFE_SWING_FLOOR = 0.35;
const Y = new THREE.Vector3(0, 1, 0);
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), V2 = new THREE.Vector3(), D = new THREE.Vector3(), C = new THREE.Color();
const RC: RGB = [0, 0, 0];

export interface MoverFrameIn {
  look: LookFrame; prev: LookFrame | null; mix: number;
  /** master level (state × intensity × blackout) */
  master: number;
  /** photosensitivity: depth for a flash key */
  gate: (key: string, atBeat: number) => number;
  /** the photosensitivity governor every output passes (shared/flashGovernor.ts via ./gov.ts) */
  gov: FestivalGov;
  /** Talk / Interview background: beams as a soft backdrop (a third of the cone light, no lens glare at the camera) */
  calm?: boolean;
  /** Safe flashes ON (soft hot cores, a low-passed lens glare) */
  safe?: boolean;
  /** the room's beam brightness (festival.beamGain) */
  beamGain?: number;
  time: number;
  /** camera position in the room frame, and the faces to protect (room frame), null = no protection (wide shots) */
  cam: THREE.Vector3; faces: THREE.Vector3[] | null;
  floorY: number; deckY: number; deckFront: number;
  haze: number;
}

export class MoverRig {
  readonly group = new THREE.Group();
  readonly movers: Mover[] = [];
  private cones: THREE.InstancedMesh;
  private pools: THREE.InstancedMesh | null = null;
  private heads: THREE.InstancedMesh;
  private bases: THREE.InstancedMesh;
  private lenses: THREE.InstancedMesh;
  private coneShape: Float32Array; private coneLook: Float32Array; private poolA: Float32Array;
  private prism: boolean;
  private coneMat: THREE.ShaderMaterial;
  private reach: number;
  private disposables: { dispose(): void }[] = [];
  private outA: MoverOut = { level: 0, flash: false, key: '', r: 0, g: 0, b: 0, yaw: 0, pitch: 0, zoom: 0 };

  private lastT = NaN;
  constructor(fixtures: Fixture[], tier: Tier, private glare: Glare | null, readonly roomBox: THREE.Box3) {
    this.group.name = 'festival:movers';
    const B = FESTIVAL_BUDGET[tier];
    this.prism = B.prism; this.reach = B.reach;
    for (const f of fixtures) {
      const kind = f.kind as MoverKind;
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(f.quat);
      const restYaw = THREE.MathUtils.radToDeg(Math.atan2(fwd.x, fwd.z)) * 0.0;        // pan 0 = towards the crowd (+Z)
      const lens = f.pos.clone().add(new THREE.Vector3(0, f.hung ? -0.42 : 0.42, 0));
      this.movers.push({ f, kind, lens, restYaw, slot: glare ? glare.add(lens, kind === 'beam' ? 0.9 : 1.3) : -1, out: { level: 0, flash: false, key: '', r: 0, g: 0, b: 0, yaw: 0, pitch: 0, zoom: 0 }, fade: 1, dir: new THREE.Vector3(0, -1, 0), level: 0 });
    }
    const n = this.movers.length;
    const nCones = n + (this.prism ? this.movers.filter((m) => m.kind === 'beam').length * 2 : 0);
    // ---- cones
    const cyl = new THREE.CylinderGeometry(1, 1, 1, 14, 1, true);
    cyl.translate(0, 0.5, 0);
    this.coneShape = new Float32Array(Math.max(1, nCones) * 4); this.coneLook = new Float32Array(Math.max(1, nCones) * 4);
    cyl.setAttribute('aShape', new THREE.InstancedBufferAttribute(this.coneShape, 4));
    cyl.setAttribute('aLook', new THREE.InstancedBufferAttribute(this.coneLook, 4));
    this.coneMat = fxMaterial(CONE_VS, CONE_FS, { uTime: { value: 0 }, uHaze: { value: 0.7 }, uDust: { value: B.dust ? 1 : 0 }, uHotK: { value: 1.5 } });
    this.cones = new THREE.InstancedMesh(cyl, this.coneMat, Math.max(1, nCones));
    this.cones.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, nCones) * 3), 3);
    this.cones.frustumCulled = false; this.cones.renderOrder = 10; this.cones.name = 'festival:cones'; this.cones.count = 0;
    glow(this.cones);
    this.group.add(this.cones);
    this.disposables.push(cyl, this.coneMat);
    // ---- floor pools
    const nPools = B.floorHits ? this.movers.filter((m) => m.kind !== 'beam').length : 0;
    this.poolA = new Float32Array(Math.max(1, nPools) * 4);
    if (nPools) {
      const pg = new THREE.PlaneGeometry(1, 1); pg.rotateX(-Math.PI / 2);
      pg.setAttribute('aPool', new THREE.InstancedBufferAttribute(this.poolA, 4));
      const pm = fxMaterial(POOL_VS, POOL_FS, {});
      pm.polygonOffset = true; pm.polygonOffsetFactor = -2; pm.polygonOffsetUnits = -2;
      this.pools = new THREE.InstancedMesh(pg, pm, nPools);
      this.pools.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nPools * 3), 3);
      this.pools.frustumCulled = false; this.pools.renderOrder = 9; this.pools.name = 'festival:pools'; this.pools.count = 0;
      this.group.add(this.pools);
      this.disposables.push(pg, pm);
    }
    // ---- bodies: base (static, follows the anchor), head (pan / tilt), lens (beam colour)
    const body = new THREE.MeshStandardMaterial({ color: 0x17191e, metalness: 0.45, roughness: 0.5 });
    const baseG = new THREE.BoxGeometry(0.46, 0.16, 0.36); baseG.translate(0, 0.08, 0);
    const yokeL = new THREE.BoxGeometry(0.06, 0.38, 0.14); yokeL.translate(-0.2, 0.33, 0);
    const yokeR = yokeL.clone(); yokeR.translate(0.4, 0, 0);
    const baseAll = mergeGeos([baseG, yokeL, yokeR]);
    const headG = new THREE.CylinderGeometry(0.15, 0.13, 0.42, 12); headG.translate(0, 0.02, 0);
    const lensG = new THREE.CircleGeometry(0.13, 16); lensG.rotateX(-Math.PI / 2); lensG.translate(0, 0.235, 0);
    this.bases = new THREE.InstancedMesh(baseAll, body, Math.max(1, n));
    this.heads = new THREE.InstancedMesh(headG, body, Math.max(1, n));
    const lensMat = new THREE.ShaderMaterial({ vertexShader: LENS_VS, fragmentShader: LENS_FS, toneMapped: false, fog: false, side: THREE.DoubleSide });
    this.lenses = new THREE.InstancedMesh(lensG, lensMat, Math.max(1, n));
    this.lenses.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(Math.max(1, n) * 3), 3);
    for (const im of [this.bases, this.heads, this.lenses]) { im.frustumCulled = false; im.count = n; this.group.add(im); }
    this.bases.name = 'festival:mh-bases'; this.heads.name = 'festival:mh-heads'; this.lenses.name = 'festival:mh-lenses';
    this.movers.forEach((m, i) => {
      // the base hangs under the truss (flipped) or stands on the deck
      Q.copy(m.f.quat); if (m.f.hung) Q.multiply(Q2.setFromAxisAngle(new THREE.Vector3(1, 0, 0), Math.PI));
      M4.compose(m.f.pos, Q, S.set(1, 1, 1)); this.bases.setMatrixAt(i, M4);
    });
    this.disposables.push(body, baseAll, headG, lensG, lensMat);
  }

  /** cones / pools / heads for this frame */
  update(fi: MoverFrameIn) {
    const U = this.coneMat.uniforms; U.uTime.value = fi.time; U.uHaze.value = fi.haze;
    // Safe flashes ON: a beam swinging through the camera's line flares its hot core and its lens glare - a peak per
    // pass the governors never see. The hot core is softened and the glare's facing term low-passed (300 ms)
    U.uHotK.value = fi.safe ? 0.35 : 1.5;
    const fdt = Number.isFinite(this.lastT) ? Math.min(0.25, Math.max(0, fi.time - this.lastT)) : 0; this.lastT = fi.time;
    let ci = 0, pi = 0;
    const colA = this.coneColor();
    for (let i = 0; i < this.movers.length; i++) {
      const m = this.movers[i];
      const sp = SPEC[m.kind];
      const o = evalMover(m.kind, fi.look, m.f.geo, m.out);
      if (fi.prev && fi.mix < 1) {
        // cross-fade: blend pan / tilt / colour / level with the previous look
        const p = evalMover(m.kind, fi.prev, m.f.geo, this.outA), k = fi.mix;
        o.yaw = p.yaw + (o.yaw - p.yaw) * k; o.pitch = p.pitch + (o.pitch - p.pitch) * k;
        o.r = p.r + (o.r - p.r) * k; o.g = p.g + (o.g - p.g) * k; o.b = p.b + (o.b - p.b) * k;
        o.level = p.level + (o.level - p.level) * k; o.zoom = p.zoom + (o.zoom - p.zoom) * k;
      }
      // a show with colour roles (shared/festivalRoles.ts): white beams in their phrases, the quiet colour in breakdowns,
      // a build bleaching toward white
      const rf = fi.look.roles;
      if (rf) { RC[0] = o.r; RC[1] = o.g; RC[2] = o.b; roleMover(m.kind, rf, RC); o.r = RC[0]; o.g = RC[1]; o.b = RC[2]; }
      let lv = o.level * fi.master;
      if (o.flash) lv = heldLevel(o.level, fi.gate(`mv${o.key}`, fi.look.beat), fi.look.level) * fi.master;
      aimDir(o.yaw + m.restYaw, o.pitch, m.dir);
      // a fixture hung under a truss can't shine up through it, one on the deck can't shine into the deck
      if (m.f.hung && m.dir.y > 0.2 && m.kind !== 'beam') m.dir.y = 0.2;
      m.dir.normalize();
      // face protection: a beam that crosses the camera → face line fades out
      const target = fi.faces ? (this.crosses(m.lens, m.dir, sp.reach, fi.cam, fi.faces) ? 0 : 1) : 1;
      m.fade += (target - m.fade) * 0.25;
      lv *= m.fade;
      // Safe flashes ON: a beam swinging fast across the sky is a stripe of light crossing a region several times a second
      // (a fan pumping open and shut, a dense rig sweeping a wide shot) - the governors never see motion. Like the lasers'
      // rays, a beam dims with the square of its swing speed (half bright at ~57 deg/s; the calm clock's sweeps stay bright)
      if (fi.safe && fdt > 0) {
        // (a jump of more than ~20 deg in one frame is a snap - a look change, the drop - not a sweep: no dimming; and never
        //  below 35 %: the beam stays a beam, its stripe through a region just far softer)
        const ang = m.pdir ? Math.acos(Math.min(1, Math.max(-1, m.pdir.dot(m.dir)))) : 0;
        const w = ang > 0.35 ? 0 : ang / fdt;
        m.spd = (m.spd ?? w) + (w - (m.spd ?? w)) * Math.min(1, fdt / 0.1);
        lv *= Math.max(SAFE_SWING_FLOOR, 1 / (1 + (m.spd / SAFE_SWING) ** 2));
      }
      (m.pdir ??= new THREE.Vector3()).copy(m.dir);
      lv = fi.gov.out(m, lv, o.r, o.g, o.b); o.r = fi.gov.r; o.g = fi.gov.g; o.b = fi.gov.b;
      m.level = lv;
      const half = THREE.MathUtils.degToRad(sp.half[0] + (sp.half[1] - sp.half[0]) * o.zoom);
      const reach = sp.reach * this.reach;
      const endR = sp.lensR + Math.tan(half) * reach;
      // head + lens
      Q.setFromUnitVectors(Y, m.dir);
      M4.compose(V.copy(m.f.pos).addScaledVector(Y, m.f.hung ? -0.42 : 0.42), Q, S.set(1, 1, 1));
      this.heads.setMatrixAt(i, M4); this.lenses.setMatrixAt(i, M4);
      const hot = Math.min(1.6, lv * 1.3);
      C.setRGB(lin(o.r) * hot, lin(o.g) * hot, lin(o.b) * hot);
      this.lenses.setColorAt(i, C);
      if (this.glare && m.slot >= 0) {
        const face0 = Math.pow(Math.max(0, m.dir.dot(V2.copy(fi.cam).sub(m.lens).normalize())), 6);
        m.faceS = fi.safe ? (m.faceS ?? face0) + (face0 - (m.faceS ?? face0)) * (1 - Math.exp(-fdt / 0.3)) : face0;
        const gl = lv * (0.12 + (fi.safe ? 0.4 : 0.88) * m.faceS) * (m.kind === 'beam' ? 1 : 0.7) * (fi.calm ? 0.25 : 1);
        this.glare.set(m.slot, lin(o.r) * gl, lin(o.g) * gl, lin(o.b) * gl);
      }
      if (lv < 0.004) continue;
      // cone(s): the beam class splits into 3 through the prism on High / Ultra
      const parts = m.kind === 'beam' && this.prism ? 3 : 1;
      for (let k = 0; k < parts; k++) {
        D.copy(m.dir);
        if (k > 0) { const ang = fi.time * 1.6 + k * 2.094 + m.f.geo.seed * 6; V2.set(Math.cos(ang), 0, Math.sin(ang)); const perp = V2.sub(V.copy(m.dir).multiplyScalar(V2.dot(m.dir))).normalize(); D.addScaledVector(perp, 0.07).normalize(); }
        Q.setFromUnitVectors(Y, D);
        M4.compose(m.lens, Q, S.set(1, 1, 1));
        this.cones.setMatrixAt(ci, M4);
        const g = lv * sp.gain * (parts > 1 ? 0.5 : 1) * (fi.calm ? 0.3 : 1) * (fi.beamGain ?? 1);
        C.setRGB(lin(o.r) * colA, lin(o.g) * colA, lin(o.b) * colA);
        this.cones.setColorAt(ci, C);
        this.coneShape.set([sp.lensR, endR, reach, fi.time * 0.8 + m.f.geo.seed * 9], ci * 4);
        this.coneLook.set([sp.gobo, sp.edge, sp.dust, g], ci * 4);
        ci++;
      }
      // floor pool
      if (this.pools && m.kind !== 'beam' && m.dir.y < -0.05) {
        let y = fi.floorY;
        let t = (y - m.lens.y) / m.dir.y;
        const hx = m.lens.x + m.dir.x * t, hz = m.lens.z + m.dir.z * t;
        if (m.lens.y > fi.deckY + 0.5 && hz < fi.deckFront) { y = fi.deckY; t = (y - m.lens.y) / m.dir.y; }
        if (t > 0 && t < reach) {
          const px = m.lens.x + m.dir.x * t, pz = m.lens.z + m.dir.z * t;
          void hx;
          const r = sp.lensR + Math.tan(half) * t;
          const stretch = 1 / Math.max(0.25, -m.dir.y);
          const yaw = Math.atan2(m.dir.x, m.dir.z);
          Q.setFromAxisAngle(Y, yaw);
          M4.compose(V.set(px, y + 0.03, pz), Q, S.set(r * 2, 1, r * 2 * Math.min(4, stretch)));
          this.pools.setMatrixAt(pi, M4);
          const pg = lv * (m.kind === 'spot' ? 0.5 : 0.28) * Math.min(1, 6 / Math.max(1, r)) * fi.haze;
          C.setRGB(lin(o.r) * pg, lin(o.g) * pg, lin(o.b) * pg);
          this.pools.setColorAt(pi, C);
          this.poolA.set([m.kind === 'spot' ? 1 : 0, fi.time * 0.8 + m.f.geo.seed * 9, m.kind === 'spot' ? 0.25 : 0.7, 0], pi * 4);
          pi++;
        }
      }
    }
    this.cones.count = ci;
    this.cones.instanceMatrix.needsUpdate = true;
    if (this.cones.instanceColor) this.cones.instanceColor.needsUpdate = true;
    (this.cones.geometry.getAttribute('aShape') as THREE.InstancedBufferAttribute).needsUpdate = true;
    (this.cones.geometry.getAttribute('aLook') as THREE.InstancedBufferAttribute).needsUpdate = true;
    this.heads.instanceMatrix.needsUpdate = true; this.lenses.instanceMatrix.needsUpdate = true;
    if (this.lenses.instanceColor) this.lenses.instanceColor.needsUpdate = true;
    if (this.pools) {
      this.pools.count = pi; this.pools.instanceMatrix.needsUpdate = true;
      if (this.pools.instanceColor) this.pools.instanceColor.needsUpdate = true;
      (this.pools.geometry.getAttribute('aPool') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  private coneColor() { return 1; }

  /** Does the beam (lens → lens + dir·reach) pass within ~0.5 m of the camera → face line of any face? */
  private crosses(p: THREE.Vector3, d: THREE.Vector3, reach: number, cam: THREE.Vector3, faces: THREE.Vector3[]): boolean {
    for (const f of faces) {
      // closest approach between the beam ray and the camera→face segment (sampled: 6 points on the segment)
      for (let k = 1; k <= 6; k++) {
        V.copy(cam).lerp(f, k / 6.5);
        const t = V2.copy(V).sub(p).dot(d);
        if (t < 0 || t > reach) continue;
        const dist = V2.copy(p).addScaledVector(d, t).distanceTo(V);
        if (dist < 0.45 + t * 0.03) return true;
      }
    }
    return false;
  }

  /** the beams that light the performers (performer lighting / debug): lens, dir, colour × level */
  lit(): { lens: THREE.Vector3; dir: THREE.Vector3; level: number; kind: MoverKind }[] { return this.movers.filter((m) => m.level > 0.05).map((m) => ({ lens: m.lens, dir: m.dir, level: m.level, kind: m.kind })); }

  dispose() { for (const d of this.disposables) d.dispose(); this.group.removeFromParent(); }
}

/** Merge non-indexed / indexed geometries with the same attributes (position, normal, uv). */
export function mergeGeos(list: THREE.BufferGeometry[]): THREE.BufferGeometry {
  const parts = list.map((g) => (g.index ? g.toNonIndexed() : g));
  const out = new THREE.BufferGeometry();
  for (const name of ['position', 'normal', 'uv']) {
    const arrs = parts.map((g) => g.getAttribute(name) as THREE.BufferAttribute | undefined);
    if (arrs.some((a) => !a)) continue;
    const size = arrs[0]!.itemSize;
    const total = arrs.reduce((s, a) => s + a!.count * size, 0);
    const data = new Float32Array(total);
    let off = 0;
    for (const a of arrs) { data.set(a!.array as Float32Array, off); off += a!.count * size; }
    out.setAttribute(name, new THREE.BufferAttribute(data, size));
  }
  for (const g of parts) if (!list.includes(g)) g.dispose();
  return out;
}
