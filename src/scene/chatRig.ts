// In-world chat props: the motorised drop-down CHAT MONITOR and the neon SUPPORT board — same family as the solo react
// screen (soloScreen.ts): ceiling plates → cables → a motor housing with a cyan LED strip and a lamp → the display
// drops on its cables (motor ease, damped landing bounce, lamp flash) → CRT power-on (screenFx.ts) → the live canvas.
// Exit: tube off → the whole unit winches back above the ceiling line. Plus a confetti / spark burst for alerts.
//
// The rig's origin is the centre of the shown display surface; +Z = the side it faces (the camera).
import * as THREE from 'three';
import { govChannel, pageGovernor } from '../../shared/flashGovernor.ts';
import { PowerSeq, ScreenFx } from './screenFx.ts';

export interface PropPlacement {
  center: THREE.Vector3;
  /** Yaw (rad) of the display normal. */
  yaw: number;
  /** Display width (m); height = width × aspect. */
  width: number;
  ceilingY: number;
  /** 'node' | 'scene.json' | 'auto' */
  source: string;
}

const easeOut = (x: number) => 1 - Math.pow(1 - THREE.MathUtils.clamp(x, 0, 1), 3);
const motor = (x: number) => { const t = THREE.MathUtils.clamp(x, 0, 1); return t * t * t * (t * (t * 6 - 15) + 10); };

function lampTexture(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#05070a'; g.fillRect(0, 0, 256, 64);
  g.strokeStyle = color; g.lineWidth = 4; g.strokeRect(3, 3, 250, 58);
  g.fillStyle = color; g.font = '900 36px Inter, "Segoe UI", system-ui, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(text, 128, 34);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export type RigKind = 'monitor' | 'board';

export class HangingRig {
  private gch = [govChannel('chat lamp'), govChannel('chat strip'), govChannel('chat neon')];
  target = 0;
  readonly rig = new THREE.Group();
  private unit = new THREE.Group();          // housing + display (winched as one)
  private cables: THREE.Mesh[] = [];
  private fx: ScreenFx;
  private seq = new PowerSeq(0.55, 0.25, 0.25, 0.15);
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private lampMat: THREE.MeshBasicMaterial;
  private strip: THREE.MeshStandardMaterial;
  private neon: THREE.MeshStandardMaterial | null = null;
  private a = 0; private landed = false; private tau = 99; private flash = 0;
  /** Alert pulse 0..1 (board flashes, lamp strobes). */
  pulse = 0;
  readonly H: number;
  private shownY: number;
  private retractY: number;
  private ceilLocal: number;
  onLand: (() => void) | null = null;

  constructor(readonly kind: RigKind, readonly place: PropPlacement, readonly aspect: number, map: THREE.Texture, lampText?: string) {
    const W = place.width, H = (this.H = W * aspect);
    this.rig.name = `vtp:chat:${kind}`;
    this.rig.position.copy(place.center);
    this.rig.rotation.set(0, place.yaw, 0);
    const metal = this.own(new THREE.MeshStandardMaterial({ color: 0x1b1e25, roughness: 0.42, metalness: 0.65 }));
    const dark = this.own(new THREE.MeshStandardMaterial({ color: 0x0b0d10, roughness: 0.55, metalness: 0.35 }));
    this.strip = this.own(new THREE.MeshStandardMaterial({ color: 0x08141a, emissive: new THREE.Color(kind === 'board' ? 0xff4fd8 : 0x35e3ff), emissiveIntensity: 0, roughness: 0.4 }));
    const box = (w: number, h: number, d: number, mat: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) => {
      const m = new THREE.Mesh(this.own(new THREE.BoxGeometry(w, h, d)), mat);
      m.position.set(x, y, z); parent.add(m); return m;
    };
    const hh = 0.13, hw = Math.min(W * 0.7, W - 0.1) + 0.2;
    // display: bezel + screen (+ neon tube frame on the board)
    const bez = kind === 'board' ? 0.05 : 0.035;
    box(W + bez * 2, H + bez * 2, 0.06, dark, this.unit, 0, 0, -0.01);
    box(W + bez * 2 + 0.01, 0.018, 0.064, metal, this.unit, 0, -(H / 2 + bez), -0.01);
    this.fx = new ScreenFx(false);
    this.fx.setMap(map);
    const surf = new THREE.Mesh(this.own(new THREE.PlaneGeometry(W, H)), this.fx.material);
    surf.position.z = 0.021;
    surf.name = `vtp:chat:${kind}:surface`;
    this.unit.add(surf);
    if (kind === 'board') {
      this.neon = this.own(new THREE.MeshStandardMaterial({ color: 0x220614, emissive: new THREE.Color(0xff4fd8), emissiveIntensity: 1.6, roughness: 0.35 }));
      const t = 0.022, z = 0.035, o = bez * 0.55;
      box(W + o * 2, t, t, this.neon, this.unit, 0, H / 2 + o, z);
      box(W + o * 2, t, t, this.neon, this.unit, 0, -H / 2 - o, z);
      box(t, H + o * 2, t, this.neon, this.unit, -W / 2 - o, 0, z);
      box(t, H + o * 2, t, this.neon, this.unit, W / 2 + o, 0, z);
    }
    // yoke + housing
    const top = H / 2 + bez;
    this.shownY = 0;
    const housingY = top + 0.09 + hh / 2;
    for (const sx of [-1, 1]) box(0.03, 0.1, 0.03, metal, this.unit, sx * W * 0.3, top + 0.045, -0.01);
    box(hw, hh, 0.16, metal, this.unit, 0, housingY, -0.01);
    box(hw - 0.08, 0.02, 0.01, this.strip, this.unit, 0, housingY - hh / 2 + 0.028, 0.072);
    const lt = this.own(lampTexture(lampText ?? (kind === 'board' ? 'SUPPORT' : 'LIVE CHAT'), kind === 'board' ? '#ff4fd8' : '#35e3ff'));
    this.lampMat = this.own(new THREE.MeshBasicMaterial({ map: lt, toneMapped: false, color: new THREE.Color(0.35, 0.35, 0.35) }));
    const lamp = new THREE.Mesh(this.own(new THREE.PlaneGeometry(0.34, 0.085)), this.lampMat);
    lamp.position.set(0, housingY + 0.005, 0.072);
    this.unit.add(lamp);
    this.rig.add(this.unit);
    // ceiling + cables (the cables run from the housing top to the ceiling plates)
    this.ceilLocal = Math.max(housingY + hh / 2 + 0.3, place.ceilingY - place.center.y);
    this.retractY = this.ceilLocal - (top - H - bez * 2) + 0.05;   // the display's bottom edge above the ceiling line
    for (const sx of [-1, 1]) {
      const cab = new THREE.Mesh(this.own(new THREE.CylinderGeometry(0.008, 0.008, 1, 6)), dark);
      cab.position.x = sx * (hw / 2 - 0.08);
      cab.userData.top = housingY + hh / 2;
      this.rig.add(cab); this.cables.push(cab);
      box(0.14, 0.025, 0.14, metal, this.rig, sx * (hw / 2 - 0.08), this.ceilLocal - 0.012, -0.01);
    }
    this.apply(0);
  }
  private own<T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T): T { this.owned.push(x); return x; }

  /** Fully retracted and dark. */
  get away() { return this.a <= 0 && this.seq.power <= 0; }
  get down() { return this.landed && this.seq.power >= 1; }
  /** 0..1 how far down (for the camera-side checks). */
  get lowered() { return this.a; }

  update(dt: number, time: number) {
    const want = this.target > 0.5;
    const off = this.seq.step(dt, want, this.landed, true);
    if (want) {
      this.a = Math.min(1, this.a + dt / 1.05);
      if (this.a >= 1 && !this.landed) { this.landed = true; this.tau = 0; this.flash = 1; this.onLand?.(); }
    } else if (off) {
      this.landed = false;
      this.a = Math.max(0, this.a - dt / 0.85);
    }
    this.tau += dt;
    this.flash = Math.max(0, this.flash - dt / 0.9);
    this.pulse = Math.max(0, this.pulse - dt / 1.6);
    this.fx.set(this.seq.power, this.seq.open, time);
    this.apply(time);
  }

  finish() {
    const want = this.target > 0.5;
    this.a = want ? 1 : 0; this.landed = want; this.tau = 99; this.flash = 0;
    this.seq.finish(want);
    this.fx.set(this.seq.power, this.seq.open, 0);
    this.apply(0);
  }

  private apply(time: number) {
    const k = this.landed ? 1 : motor(this.a);
    // damped bounce on the cables after landing (the unit dips below its rest height, then settles)
    const bounce = this.landed ? -0.045 * Math.sin(this.tau * 11) * Math.exp(-4.6 * this.tau) : 0;
    const y = THREE.MathUtils.lerp(this.retractY, this.shownY, k) + bounce;
    this.unit.position.y = y;
    this.unit.rotation.z = this.landed ? 0.012 * Math.sin(this.tau * 7.5) * Math.exp(-3 * this.tau) : 0;   // a little sway
    this.rig.visible = this.a > 0.001;
    for (const c of this.cables) {
      const y0 = y + (c.userData.top as number), len = Math.max(0.01, this.ceilLocal - y0);
      c.scale.y = len; c.position.y = y0 + len / 2;
    }
    const live = this.seq.power;
    const strobe = this.pulse > 0 ? (Math.sin(time * 34) > 0 ? 1 : 0.3) * this.pulse : 0;
    const blink = this.flash > 0 ? (Math.sin(time * 40) > 0 ? 1 : 0.35) * this.flash : 0;
    // photosensitivity: the lamp, the LED strip and the neon are outputs on the page's governor (their 3.5-6.4 Hz blinks)
    const gov = pageGovernor(performance.timeOrigin + performance.now());
    this.lampMat.color.setScalar(gov.step(this.gch[0], Math.max(0.3, 0.3 + 0.7 * live, blink, strobe)));
    this.strip.emissiveIntensity = gov.step(this.gch[1], 0.2 + 2.4 * Math.max(live, this.flash, strobe));
    if (this.neon) this.neon.emissiveIntensity = gov.step(this.gch[2], (0.3 + 1.6 * live) * (1 + 1.8 * this.pulse * (0.6 + 0.4 * Math.sin(time * 22))));
  }

  /** Display corners (world) when fully down. */
  corners(): THREE.Vector3[] {
    const W = this.place.width, H = this.H;
    const m = new THREE.Matrix4().compose(this.place.center, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.place.yaw), new THREE.Vector3(1, 1, 1));
    return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => new THREE.Vector3(x * W / 2, y * H / 2, 0).applyMatrix4(m));
  }

  dispose() {
    this.rig.removeFromParent();
    this.fx.dispose();
    for (const o of this.owned) o.dispose();
  }
}

// ---------------------------------------------------------------- confetti + sparks (one Points draw)
const CONF_N = 260;
export class Confetti {
  readonly points: THREE.Points;
  private pos = new Float32Array(CONF_N * 3);
  private vel = new Float32Array(CONF_N * 3);
  private col = new Float32Array(CONF_N * 3);
  private life = new Float32Array(CONF_N);
  private geo = new THREE.BufferGeometry();
  private mat: THREE.PointsMaterial;
  private alive = 0;

  constructor() {
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3).setUsage(THREE.DynamicDrawUsage));
    this.geo.setAttribute('color', new THREE.BufferAttribute(this.col, 3).setUsage(THREE.DynamicDrawUsage));
    this.mat = new THREE.PointsMaterial({ size: 0.05, vertexColors: true, transparent: true, depthWrite: false, toneMapped: false, sizeAttenuation: true });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.name = 'vtp:chat:confetti';
    this.points.frustumCulled = false;
    this.points.visible = false;
  }

  /** Burst from a point (world), mostly towards `dir`, in the event's colours. */
  burst(at: THREE.Vector3, dir: THREE.Vector3, colors: string[], n = 160, seed = 1) {
    let r = seed >>> 0 || 1;
    const rnd = () => { r ^= r << 13; r ^= r >>> 17; r ^= r << 5; return ((r >>> 0) % 10000) / 10000; };
    const cs = colors.map((c) => new THREE.Color(c));
    let spawned = 0;
    for (let i = 0; i < CONF_N && spawned < n; i++) {
      if (this.life[i] > 0) continue;
      const u = rnd() * Math.PI * 2, v = rnd() * 0.9 + 0.1;
      const sp = 1.6 + rnd() * 2.6;
      this.pos[i * 3] = at.x + (rnd() - 0.5) * 0.3; this.pos[i * 3 + 1] = at.y + (rnd() - 0.5) * 0.2; this.pos[i * 3 + 2] = at.z + (rnd() - 0.5) * 0.3;
      this.vel[i * 3] = dir.x * sp * 0.6 + Math.cos(u) * sp * 0.55 * v;
      this.vel[i * 3 + 1] = 1.6 + rnd() * 2.4;
      this.vel[i * 3 + 2] = dir.z * sp * 0.6 + Math.sin(u) * sp * 0.55 * v;
      const c = cs[i % cs.length];
      const spark = rnd() < 0.25;
      this.col[i * 3] = spark ? 1 : c.r; this.col[i * 3 + 1] = spark ? 0.95 : c.g; this.col[i * 3 + 2] = spark ? 0.7 : c.b;
      this.life[i] = 2.2 + rnd() * 1.4;
      spawned++;
    }
    this.alive = Math.max(this.alive, spawned);
    this.points.visible = true;
  }

  update(dt: number, time: number) {
    if (!this.points.visible) return;
    let any = false;
    for (let i = 0; i < CONF_N; i++) {
      if (this.life[i] <= 0) { this.pos[i * 3 + 1] = -1e4; continue; }
      any = true;
      this.life[i] -= dt;
      const j = i * 3;
      // flutter: drag + sideways wobble once falling
      this.vel[j + 1] -= 4.2 * dt;
      const drag = Math.exp(-1.6 * dt);
      this.vel[j] *= drag; this.vel[j + 2] *= drag; if (this.vel[j + 1] < -0.9) this.vel[j + 1] = -0.9;
      this.pos[j] += (this.vel[j] + 0.25 * Math.sin(time * 6 + i)) * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += (this.vel[j + 2] + 0.25 * Math.cos(time * 5 + i * 1.7)) * dt;
      if (this.life[i] <= 0) this.pos[j + 1] = -1e4;
    }
    this.mat.opacity = 1;
    this.geo.attributes.position.needsUpdate = true;
    this.geo.attributes.color.needsUpdate = true;
    if (!any) this.points.visible = false;
  }

  dispose() { this.points.removeFromParent(); this.geo.dispose(); this.mat.dispose(); }
}
