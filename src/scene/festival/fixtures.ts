// Static fixtures: PAR cans (uplight a short soft cone into the haze), Atomic-style strobes (long white lens + a wide
// flash cone), blinders (2 × 4 warm cells, slow thermal decay), pixel bars / LED strips (instanced pixels) and the
// stage flash (a screen-space exposure bump on strobe / blinder / drop hits, always through the photosensitivity gate).
// Bodies, lenses and cones are instanced per class; only colours (and the few cone instances) change per frame.
import * as THREE from 'three';
import { FESTIVAL_BUDGET, heldLevel, pickSubset, type Tier } from '../../../shared/festival.ts';
import type { FestivalGov, GovOwner } from './gov.ts';
import { evalFlat, strobeLevel, type DirectorFrame, type FixGeo, type FlatOut, type LookFrame, type Lvl } from '../../../shared/festivalDirector.ts';
import { CONE_FS, CONE_VS, mergeGeos } from './movers.ts';
import { fxMaterial, glow, lin, type Fixture, type Glare } from './common.ts';
import { roleFlat, spreadStepColor, structureColor, structureLevel, phraseEase, type RGB, type RoleFrame, type StructureCfg } from '../../../shared/festivalRoles.ts';

const LENS_VS = /* glsl */ `varying vec3 vCol; void main() { vCol = instanceColor; gl_Position = projectionMatrix * modelViewMatrix * instanceMatrix * vec4(position, 1.0); }`;
const LENS_FS = /* glsl */ `varying vec3 vCol; void main() { gl_FragColor = vec4(vCol, 1.0); }`;
const Y = new THREE.Vector3(0, 1, 0), ZF = new THREE.Vector3(0, 0, 1);
const M4 = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), V = new THREE.Vector3(), C = new THREE.Color();

interface Flat extends GovOwner { f: Fixture; dir: THREE.Vector3; slot: number; level: number; out: FlatOut; cells: number }
interface Pixel extends GovOwner { x: number; y: number; z: number; geo: FixGeo; group: string }
const RGB1: RGB = [0, 0, 0];
const PM = { beat: 0, bar: 0, barPos: 0, dropCount: 0, lastDrop: 0 };
interface SCol { sl: StructureIn | null; colors: readonly (readonly number[])[]; step: number; ease: number }
/** a structure fixture's colour: the show's structure role, else the look's palette spread across the rig (mirrored) */
function structColor(c: SCol, x: number, out: RGB): RGB { return c.sl?.rf ? structureColor(c.sl.rf, Math.abs(x), out) : spreadStepColor(c.colors, c.step, c.ease, Math.abs(x), out); }

/** The structure (keylight) layer this frame (shared/festivalRoles.ts): the section level already eased by the room
 *  engine, the pulse (the kick, or a slow breath with Safe flashes ON), the show's own level (0 in a blackout), the stage
 *  level without blackouts (`base`), the show's colour roles (null: the look's palette, stepping per phrase). */
export interface StructureIn { cfg: StructureCfg; target: number; pulse: number; show: number; base: number; rf: RoleFrame | null }

export interface FlatFrameIn {
  look: LookFrame; prev: LookFrame | null; mix: number; d: DirectorFrame;
  master: number; gate: (key: string, atBeat: number) => number;
  /** the photosensitivity governor every output passes */
  gov: FestivalGov;
  /** Talk / Interview background: strobes and blinders stay off (nothing flashes behind a face) */
  calm?: boolean;
  time: number; dt: number; haze: number; cam: THREE.Vector3;
  /** the structure layer (null / absent = the pixel bars follow the look, as before) */
  structure?: StructureIn | null;
}

export class FlatRig {
  readonly group = new THREE.Group();
  private pars: Flat[] = []; private strobes: Flat[] = []; private blinders: Flat[] = [];
  private parBody: THREE.InstancedMesh | null = null; private parLens: THREE.InstancedMesh | null = null;
  private stBody: THREE.InstancedMesh | null = null; private stLens: THREE.InstancedMesh | null = null;
  private blBody: THREE.InstancedMesh | null = null; private blLens: THREE.InstancedMesh | null = null;
  private cones: THREE.InstancedMesh | null = null; private coneShape: Float32Array; private coneLook: Float32Array;
  private stGov: GovOwner = {}; private flashGov: GovOwner = {}; private flashSm = 0;
  private pixels: Pixel[] = []; private pixMesh: THREE.InstancedMesh | null = null;
  private flash: THREE.Mesh;
  private flashU: { uFlash: { value: THREE.Color } };
  /** the flash level now (debug) */
  flashNow = 0;
  private disposables: { dispose(): void }[] = [];
  private o1: FlatOut = { level: 0, flash: false, key: '', r: 0, g: 0, b: 0 }; private o2: FlatOut = { level: 0, flash: false, key: '', r: 0, g: 0, b: 0 };
  private sl: Lvl = { v: 0, flash: false, key: '' };
  private sCol: SCol = { sl: null, colors: [], step: 0, ease: 1 };

  constructor(fixtures: Fixture[], tier: Tier, private glare: Glare | null) {
    this.group.name = 'festival:flats';
    const B = FESTIVAL_BUDGET[tier];
    const dirOf = (f: Fixture) => {
      const a = f.extras.aim;
      if (Array.isArray(a) && a.length >= 3) return new THREE.Vector3(+a[0], +a[1], +a[2]).sub(f.pos).normalize();
      return ZF.clone().applyQuaternion(f.quat).normalize();
    };
    const mk = (f: Fixture, size: number): Flat => ({ f, dir: dirOf(f), slot: this.glare ? this.glare.add(f.pos.clone().addScaledVector(dirOf(f), 0.2), size) : -1, level: 0, out: { level: 0, flash: false, key: '', r: 0, g: 0, b: 0 }, cells: 0 });
    for (const f of fixtures) {
      if (f.kind === 'par') this.pars.push(mk(f, 1.1));
      else if (f.kind === 'strobe') this.strobes.push(mk(f, 2.6));
      else if (f.kind === 'blinder') this.blinders.push(mk(f, 2.2));
    }
    const body = new THREE.MeshStandardMaterial({ color: 0x15171b, metalness: 0.4, roughness: 0.55 });
    const lensMat = new THREE.ShaderMaterial({ vertexShader: LENS_VS, fragmentShader: LENS_FS, toneMapped: false, fog: false, side: THREE.DoubleSide });
    this.disposables.push(body, lensMat);
    const inst = (g: THREE.BufferGeometry, m: THREE.Material, list: Flat[], name: string, color: boolean) => {
      if (!list.length) return null;
      const im = new THREE.InstancedMesh(g, m, list.length);
      if (color) im.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(list.length * 3), 3);
      list.forEach((x, i) => { Q.setFromUnitVectors(ZF, x.dir); M4.compose(x.f.pos, Q, S.set(1, 1, 1)); im.setMatrixAt(i, M4); });
      im.frustumCulled = false; im.name = name; this.group.add(im); this.disposables.push(g);
      return im;
    };
    // PAR can: a short cylinder pointing along +Z, lens disc at the front
    const parG = new THREE.CylinderGeometry(0.13, 0.15, 0.32, 12); parG.rotateX(Math.PI / 2);
    const parL = new THREE.CircleGeometry(0.12, 14); parL.translate(0, 0, 0.165);
    this.parBody = inst(parG, body, this.pars, 'festival:par-bodies', false);
    this.parLens = inst(parL, lensMat, this.pars, 'festival:par-lenses', true);
    // strobe: a long box with a white lens strip
    const stG = new THREE.BoxGeometry(0.62, 0.22, 0.2);
    const stL = new THREE.PlaneGeometry(0.54, 0.12); stL.translate(0, 0, 0.101);
    this.stBody = inst(stG, body, this.strobes, 'festival:strobe-bodies', false);
    this.stLens = inst(stL, lensMat, this.strobes, 'festival:strobe-lenses', true);
    // blinder: a panel of 2 × 4 cells
    const blG = new THREE.BoxGeometry(0.62, 0.34, 0.16);
    const cells: THREE.BufferGeometry[] = [];
    for (let r = 0; r < 2; r++) for (let c = 0; c < 4; c++) { const g = new THREE.CircleGeometry(0.06, 12); g.translate(-0.225 + c * 0.15, -0.075 + r * 0.15, 0.081); cells.push(g); }
    const blL = mergeGeos(cells); cells.forEach((g) => g.dispose());
    this.blBody = inst(blG, body, this.blinders, 'festival:blinder-bodies', false);
    this.blLens = inst(blL, lensMat, this.blinders, 'festival:blinder-lenses', true);
    // soft cones: PARs (narrow uplights) + strobes (wide flash), the movers' cone shader
    const nCones = this.pars.length + this.strobes.length;
    this.coneShape = new Float32Array(Math.max(1, nCones) * 4); this.coneLook = new Float32Array(Math.max(1, nCones) * 4);
    if (nCones) {
      const cyl = new THREE.CylinderGeometry(1, 1, 1, 12, 1, true); cyl.translate(0, 0.5, 0);
      cyl.setAttribute('aShape', new THREE.InstancedBufferAttribute(this.coneShape, 4));
      cyl.setAttribute('aLook', new THREE.InstancedBufferAttribute(this.coneLook, 4));
      const cm = fxMaterial(CONE_VS, CONE_FS, { uTime: { value: 0 }, uHaze: { value: 0.7 }, uDust: { value: B.dust ? 1 : 0 } });
      this.cones = new THREE.InstancedMesh(cyl, cm, nCones);
      this.cones.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(nCones * 3), 3);
      this.cones.frustumCulled = false; this.cones.renderOrder = 10; this.cones.name = 'festival:flat-cones'; this.cones.count = 0;
      glow(this.cones); this.group.add(this.cones); this.disposables.push(cyl, cm);
    }
    // pixel bars: each FX_PIXEL anchor is a bar along its local +X (extras length m, pixels n); the budget thins pixels
    const bars = fixtures.filter((f) => f.kind === 'pixel');
    const want = bars.reduce((a, f) => a + Math.max(2, Math.round(Number(f.extras.pixels) || 12)), 0);
    const keep = Math.min(1, B.pixel / Math.max(1, want));
    let gi = 0;
    const all: { p: THREE.Vector3; group: string }[] = [];
    for (const f of bars) {
      const n = Math.max(2, Math.round((Number(f.extras.pixels) || 12) * keep));
      const len = Number(f.extras.length) || 1.2;
      const ax = new THREE.Vector3(1, 0, 0).applyQuaternion(f.quat);
      for (let k = 0; k < n; k++) all.push({ p: f.pos.clone().addScaledVector(ax, (k / (n - 1) - 0.5) * len), group: f.group });
    }
    if (all.length) {
      const bb = new THREE.Box3(); for (const a of all) bb.expandByPoint(a.p);
      const sz = bb.getSize(new THREE.Vector3()), c0 = bb.min;
      for (const a of all) {
        const x = sz.x > 0.01 ? ((a.p.x - c0.x) / sz.x) * 2 - 1 : 0, y = sz.y > 0.01 ? (a.p.y - c0.y) / sz.y : 0.5, z = sz.z > 0.01 ? (a.p.z - c0.z) / sz.z : 0.5;
        this.pixels.push({ x: a.p.x, y: a.p.y, z: a.p.z, group: a.group, geo: { x, y, z, i: gi, n: all.length, seed: ((gi * 2654435761) >>> 0) / 4294967296 } }); gi++;
      }
      const pg = new THREE.BoxGeometry(0.075, 0.075, 0.075);
      this.pixMesh = new THREE.InstancedMesh(pg, lensMat, this.pixels.length);
      this.pixMesh.instanceColor = new THREE.InstancedBufferAttribute(new Float32Array(this.pixels.length * 3), 3);
      this.pixels.forEach((p, i) => { M4.makeTranslation(p.x, p.y, p.z); this.pixMesh!.setMatrixAt(i, M4); });
      this.pixMesh.frustumCulled = false; this.pixMesh.name = 'festival:pixels'; glow(this.pixMesh);
      this.group.add(this.pixMesh); this.disposables.push(pg);
    }
    // the stage flash: a screen-space exposure bump (alpha untouched)
    this.flashU = { uFlash: { value: new THREE.Color(0, 0, 0) } };
    const fm = fxMaterial(/* glsl */ `void main() { gl_Position = vec4(position.xy * 2.0, 0.0, 1.0); }`, /* glsl */ `uniform vec3 uFlash; void main() { gl_FragColor = vec4(uFlash, 1.0); }`, this.flashU as unknown as Record<string, THREE.IUniform>);
    fm.depthTest = false;
    this.flash = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), fm);
    this.flash.frustumCulled = false; this.flash.renderOrder = 999; this.flash.name = 'festival:flash';
    this.group.add(this.flash); this.disposables.push(this.flash.geometry, fm);
    void pickSubset;
  }

  get counts() { return { pars: this.pars.length, strobes: this.strobes.length, blinders: this.blinders.length, pixels: this.pixels.length }; }

  update(fi: FlatFrameIn) {
    const { look, d } = fi;
    let ci = 0;
    const cone = (pos: THREE.Vector3, dir: THREE.Vector3, r: number, g: number, b: number, lensR: number, half: number, reach: number, edge: number, gain: number) => {
      if (!this.cones || gain < 0.004) return;
      Q.setFromUnitVectors(Y, dir); M4.compose(pos, Q, S.set(1, 1, 1));
      this.cones.setMatrixAt(ci, M4); C.setRGB(r, g, b); this.cones.setColorAt(ci, C);
      this.coneShape.set([lensR, lensR + Math.tan(THREE.MathUtils.degToRad(half)) * reach, reach, 0], ci * 4);
      this.coneLook.set([0, edge, 0.4, gain], ci * 4);
      ci++;
    };
    if (this.cones) { (this.cones.material as THREE.ShaderMaterial).uniforms.uTime.value = fi.time; (this.cones.material as THREE.ShaderMaterial).uniforms.uHaze.value = fi.haze; }
    const blend = (g: FixGeo, out: FlatOut) => {
      const a = evalFlat(look, g, out);
      if (fi.prev && fi.mix < 1) { const p = evalFlat(fi.prev, g, this.o2), k = fi.mix; a.level = p.level + (a.level - p.level) * k; a.r = p.r + (a.r - p.r) * k; a.g = p.g + (a.g - p.g) * k; a.b = p.b + (a.b - p.b) * k; }
      return a;
    };
    // structure (keylight) layer: the set's outline - its own slow level with a floor no blackout takes, colour on 8-bar
    // lines (the show's structure role, else the look's palette), never a flash key
    const SL = fi.structure ?? null;
    const sLv = SL ? SL.base * structureLevel(SL.cfg, SL.target, SL.pulse, SL.show) : 0;
    let pStep = 0, pEase = 1;
    if (SL && !SL.rf) { const M = PM; M.beat = look.beat; M.bar = look.bar; M.barPos = look.barPos; M.dropCount = look.step - Math.floor(look.bar / 8); M.lastDrop = look.beat - look.dropAge; const pe = phraseEase(M); pStep = pe.step; pEase = pe.ease; }
    // (no closures per frame: the structure colour / membership read these)
    const sCol = this.sCol; sCol.sl = SL; sCol.colors = look.colors; sCol.step = pStep; sCol.ease = pEase;
    // PARs
    this.pars.forEach((x, i) => {
      const o = blend(x.f.geo, x.out);
      const inS = !!SL && !!SL.cfg.groups && SL.cfg.groups.includes(x.f.group);
      if (inS) { structColor(sCol, x.f.geo.x, RGB1); o.r = RGB1[0]; o.g = RGB1[1]; o.b = RGB1[2]; o.level = sLv; o.flash = false; }
      else if (look.roles) { RGB1[0] = o.r; RGB1[1] = o.g; RGB1[2] = o.b; roleFlat(look.roles, RGB1); o.r = RGB1[0]; o.g = RGB1[1]; o.b = RGB1[2]; }
      let lv = inS ? o.level : o.level * fi.master; if (o.flash) lv = heldLevel(o.level, fi.gate(`par${o.key}`, look.beat), look.level) * fi.master;
      lv = fi.gov.out(x, lv, o.r, o.g, o.b); o.r = fi.gov.r; o.g = fi.gov.g; o.b = fi.gov.b;
      x.level = lv;
      C.setRGB(lin(o.r) * lv * 1.4, lin(o.g) * lv * 1.4, lin(o.b) * lv * 1.4); this.parLens!.setColorAt(i, C);
      this.glare?.set(x.slot, lin(o.r) * lv * 0.45, lin(o.g) * lv * 0.45, lin(o.b) * lv * 0.45);
      cone(V.copy(x.f.pos).addScaledVector(x.dir, 0.17), x.dir, lin(o.r), lin(o.g), lin(o.b), 0.12, 7, 9, 1.8, lv * 0.32);
    });
    // strobes: the accent / countdown / drop hits, gated
    const st = strobeLevel(look, d, this.sl);
    let sv = fi.calm ? 0 : st.v * Math.min(1.2, fi.master + 0.3);
    if (st.flash && sv > 0) sv *= fi.gate(`st${st.key}`, look.beat);
    sv = fi.gov.level(this.stGov, sv);                                   // (the strobes fire together: one channel)
    let flash = 0;
    // (a show with colour roles: its strobe colour - a 5,600 K white)
    const sr = look.roles ? lin(look.roles.strobe[0]) : 1, sg = look.roles ? lin(look.roles.strobe[1]) : 1, sb = look.roles ? lin(look.roles.strobe[2]) : 1;
    this.strobes.forEach((x, i) => {
      x.level = sv;
      C.setRGB(sv * 2.2 * sr, sv * 2.2 * sg, sv * 2.4 * sb); this.stLens!.setColorAt(i, C);
      this.glare?.set(x.slot, sv * 0.9 * sr, sv * 0.9 * sg, sv * sb);
      cone(V.copy(x.f.pos).addScaledVector(x.dir, 0.12), x.dir, sr, sg, 1.05 * sb, 0.3, 28, 14, 2.4, sv * 0.22);
    });
    void sv;
    // blinders: director hits (drop, downbeat / bar accents), warm tungsten, ~300 ms thermal decay
    const bTarget = fi.calm ? 0 : d.blinder * Math.min(1.2, fi.master + 0.3) * (d.blinderKey ? fi.gate(`bl${d.blinderKey}`, look.beat) : 1);
    const decay = Math.exp(-fi.dt / 0.32);
    // (warm tungsten; a show with colour roles: its blinder colour)
    const bc = look.roles?.blinder, br = bc ? bc[0] : 1, bgc = bc ? bc[1] : 0.78, bb = bc ? bc[2] : 0.5;
    // (lens / glare: the tungsten numbers as tuned; a role colour scales them by its own channels)
    const kr = bc ? lin(br) : 1, kg = bc ? lin(bgc) / 0.5711 : 1, kb = bc ? lin(bb) / 0.2140 : 1;
    this.blinders.forEach((x, i) => {
      x.level = Math.max(bTarget, x.level * decay);
      const v = fi.gov.out(x, x.level, br, bgc, bb);
      C.setRGB(v * 3.2 * kr, v * 1.9 * kg, v * 0.75 * kb); this.blLens!.setColorAt(i, C);
      this.glare?.set(x.slot, v * 0.9 * kr, v * 0.55 * kg, v * 0.22 * kb);
    });
    const bl = this.blinders.reduce((a, x) => Math.max(a, x.level), 0);
    void bl;
    // pixels
    if (this.pixMesh) {
      for (let i = 0; i < this.pixels.length; i++) {
        const P = this.pixels[i];
        // (the structure layer: every pixel bar, or the room's structure groups)
        if (SL && (!SL.cfg.groups || SL.cfg.groups.includes(P.group))) {
          structColor(sCol, P.geo.x, RGB1);
          const lv = fi.gov.out(P, sLv, RGB1[0], RGB1[1], RGB1[2]);
          const k = lv * 1.6;
          C.setRGB(lin(fi.gov.r) * k, lin(fi.gov.g) * k, lin(fi.gov.b) * k);
          this.pixMesh.setColorAt(i, C);
          continue;
        }
        const o = blend(P.geo, this.o1);
        let lv = o.level * fi.master; if (o.flash) lv = heldLevel(o.level, fi.gate(`px${o.key}`, look.beat), look.level) * fi.master;
        lv = fi.gov.out(this.pixels[i], lv, o.r, o.g, o.b); o.r = fi.gov.r; o.g = fi.gov.g; o.b = fi.gov.b;
        const k = lv * 1.6;
        C.setRGB(lin(o.r) * k, lin(o.g) * k, lin(o.b) * k);
        this.pixMesh.setColorAt(i, C);
      }
      this.pixMesh.instanceColor!.needsUpdate = true;
    }
    // stage flash (drop white hit rides on the strobes' gate decision)
    // the stage flash (a screen-wide exposure bump) only for the drop's white hit, soft and slow to fade: strobes and
    // blinders no longer drive it (a governor holding a strobe-driven veil at its peak greyed the whole picture)
    const want = d.white * 0.09 * Math.min(1, fi.master + 0.3);
    this.flashSm = want > this.flashSm ? want : this.flashSm * Math.exp(-fi.dt / 0.35);
    flash = fi.gov.level(this.flashGov, this.flashSm);
    this.flashNow = flash;
    this.flashU.uFlash.value.setRGB(flash, flash * 0.96, flash * 0.9);
    this.flash.visible = flash > 0.002;
    for (const im of [this.parLens, this.stLens, this.blLens]) if (im?.instanceColor) im.instanceColor.needsUpdate = true;
    if (this.cones) {
      this.cones.count = ci; this.cones.instanceMatrix.needsUpdate = true; this.cones.instanceColor!.needsUpdate = true;
      (this.cones.geometry.getAttribute('aShape') as THREE.InstancedBufferAttribute).needsUpdate = true;
      (this.cones.geometry.getAttribute('aLook') as THREE.InstancedBufferAttribute).needsUpdate = true;
    }
  }

  dispose() { for (const d of this.disposables) d.dispose(); this.group.removeFromParent(); }
}
