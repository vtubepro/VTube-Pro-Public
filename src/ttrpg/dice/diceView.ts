// Dice on the table: the newest roll is thrown into DICE_TRAY (the physics track from its seed, faces forced to the
// host's result), dropped advantage dice dim, crits get juice (a gold burst / a red puff, a glow pulse, a floating
// NAT 20 / NAT 1 card). The previous roll's dice stay in the tray until the next throw. Physics loads lazily (Rapier
// WASM) the first time a roll arrives.
import * as THREE from 'three';
import type { TtrpgRoll } from '../../../shared/ttrpg/state.ts';
import { dieGeometry, dieShape, dieTexture, type DieLook } from './diceGeo.ts';
import { physicalDice, sampleTrack, simulateThrow, type Throw } from './diceSim.ts';
import type { Tray } from '../scene/anchors.ts';
import { roundRect } from '../scene/mapCanvas.ts';

export const DICE_LOOKS: Record<string, { body: string; ink: string; edge?: string; rough: number; metal: number; clear?: number }> = {
  bone: { body: '#efe6d2', ink: '#2b1d10', rough: 0.55, metal: 0 },
  brass: { body: '#b8913e', ink: '#241703', rough: 0.3, metal: 0.85 },
  resin: { body: '#7b2fbf', ink: '#ffe9a8', rough: 0.25, metal: 0, clear: 0.6 },
  glass: { body: '#58c7e8', ink: '#ffffff', edge: '#0b3a4a', rough: 0.1, metal: 0, clear: 1 },
  neon: { body: '#101216', ink: '#39ff88', rough: 0.35, metal: 0.2 },
  pearl: { body: '#f4eef6', ink: '#6a2d7a', rough: 0.2, metal: 0.1, clear: 0.8 },
  plastic: { body: '#d23a3a', ink: '#ffffff', rough: 0.45, metal: 0 },
};

interface LiveDie { mesh: THREE.Mesh; body: THREE.Group; kept: boolean; sides: number; track: Throw['tracks'][number] }

export class DiceView {
  readonly group = new THREE.Group();
  private dice: LiveDie[] = [];
  private cur: { roll: TtrpgRoll; thr: Throw } | null = null;
  private pending = '';
  private fx: THREE.Group = new THREE.Group();
  private sparks: { p: THREE.Points; v: Float32Array; t: number; color: THREE.Color } | null = null;
  private card: THREE.Sprite | null = null;
  private lookKey = 'bone';
  /** Debug / tests: last throw's fingerprint + sim cost. */
  last: { id: string; hash: string; ms: number; settle: number; values: number[] } | null = null;
  /** 0..1 excitement (crit) for the GM + lights. */
  excite = 0;
  /** Seconds since the current roll's dice settled (-1 = still rolling / none). */
  sinceSettle = -1;
  private material = new Map<string, THREE.MeshPhysicalMaterial>();

  constructor(private tray: Tray, look: { style?: string; color?: string; ink?: string } | undefined) {
    this.group.name = 'ttrpg:dice';
    this.group.position.copy(tray.position);
    this.group.quaternion.copy(tray.quaternion);
    this.group.add(this.fx);
    this.lookKey = look?.style && look.style in DICE_LOOKS ? look.style : 'bone';
    this.custom = look;
  }
  private custom: { style?: string; color?: string; ink?: string } | undefined;

  private dieLook(): DieLook & { rough: number; metal: number; clear?: number } {
    const b = DICE_LOOKS[this.lookKey];
    return { ...b, body: this.custom?.color ?? b.body, ink: this.custom?.ink ?? b.ink, style: this.lookKey };
  }

  /** Show `roll` (thrown at roll.at). Re-entrant: the newest roll wins. */
  async show(roll: TtrpgRoll | null) {
    if (!roll || roll.secret || !roll.dice.length) return;
    if (this.cur?.roll.id === roll.id || this.pending === roll.id) return;
    this.pending = roll.id;
    const phys = physicalDice(roll.dice);
    const thr = await simulateThrow(phys, roll.seed, { w: this.tray.w, d: this.tray.d, rim: this.tray.rim, die: this.tray.die });
    if (this.pending !== roll.id) return;
    this.pending = '';
    this.clearDice();
    this.cur = { roll, thr };
    this.last = { id: roll.id, hash: thr.hash, ms: thr.ms, settle: thr.settle, values: thr.tracks.map((t) => t.value) };
    const look = this.dieLook();
    let di = 0;
    for (const tr of thr.tracks) {
      const shape = dieShape(tr.kind as never);
      const key = `${tr.kind}:${tr.sides}:${tr.tens}`;
      let mat = this.material.get(key);
      if (!mat) {
        mat = new THREE.MeshPhysicalMaterial({ map: dieTexture(shape, tr.sides, tr.tens, look), roughness: look.rough, metalness: look.metal, clearcoat: look.clear ?? 0.3, clearcoatRoughness: 0.2 });
        this.material.set(key, mat);
      }
      const mesh = new THREE.Mesh(dieGeometry(shape), mat.clone());   // per die: dimming / glow must not touch its twin
      mesh.quaternion.copy(tr.fix);
      mesh.castShadow = false;
      const body = new THREE.Group();
      body.scale.setScalar(this.tray.die);
      body.add(mesh);
      body.visible = false;
      this.group.add(body);
      // which physical dice were dropped (advantage): map back through the roll's dice list
      const src = roll.dice[Math.min(roll.dice.length - 1, di)];
      const kept = src?.k !== false;
      if (tr.sides !== 100) di++;
      this.dice.push({ mesh, body, kept, sides: tr.sides, track: tr });
    }
  }

  update(dt: number, now: number) {
    const c = this.cur;
    this.excite = Math.max(0, this.excite - dt * 0.6);
    if (!c) return;
    const t = (now - c.roll.at) / 1000;
    const p = new THREE.Vector3(), q = new THREE.Quaternion();
    for (const d of this.dice) {
      if (t < 0) { d.body.visible = false; continue; }
      d.body.visible = true;
      sampleTrack(d.track, c.thr.fps, t, p, q);
      d.body.position.copy(p);
      d.body.quaternion.copy(q);
      const settled = t > c.thr.settle + 0.15;
      const m = d.mesh.material as THREE.MeshPhysicalMaterial;
      if (settled && !d.kept) { d.body.scale.setScalar(this.tray.die * 0.92); m.opacity = 0.45; m.transparent = true; }
    }
    const settledT = t - c.thr.settle;
    if (settledT >= 0 && this.sinceSettle < 0 && c.roll.crit) this.juice(c.roll.crit);
    this.sinceSettle = settledT >= 0 ? settledT : -1;
    this.updateFx(dt);
  }

  /** Crit juice: sparks / smoke from the kept d20, a floating card, the dice glow. */
  private juice(kind: 'hi' | 'lo') {
    this.excite = kind === 'hi' ? 1 : 0.6;
    const d20 = this.dice.find((d) => d.sides === 20 && d.kept) ?? this.dice[0];
    const origin = d20 ? d20.body.position.clone() : new THREE.Vector3();
    const n = kind === 'hi' ? 160 : 90;
    const pos = new Float32Array(n * 3), vel = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      pos.set([origin.x, origin.y, origin.z], i * 3);
      const a = Math.random() * Math.PI * 2, up = kind === 'hi' ? 0.6 + Math.random() * 0.8 : 0.15 + Math.random() * 0.3, sp = (kind === 'hi' ? 0.35 : 0.12) * (0.4 + Math.random());
      vel.set([Math.cos(a) * sp, up, Math.sin(a) * sp], i * 3);
    }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const color = new THREE.Color(kind === 'hi' ? '#ffd257' : '#b3261e');
    const pm = new THREE.PointsMaterial({ color, size: this.tray.die * (kind === 'hi' ? 0.35 : 0.8), transparent: true, opacity: 1, depthWrite: false, blending: kind === 'hi' ? THREE.AdditiveBlending : THREE.NormalBlending, toneMapped: false });
    if (this.sparks) { this.sparks.p.geometry.dispose(); (this.sparks.p.material as THREE.Material).dispose(); this.sparks.p.removeFromParent(); }
    const pts = new THREE.Points(g, pm);
    this.fx.add(pts);
    this.sparks = { p: pts, v: vel, t: 0, color };
    // floating card
    const cv = document.createElement('canvas'); cv.width = 512; cv.height = 192;
    const x = cv.getContext('2d')!;
    const grd = x.createLinearGradient(0, 0, 512, 0);
    grd.addColorStop(0, kind === 'hi' ? '#ffb300' : '#6d0f0b'); grd.addColorStop(1, kind === 'hi' ? '#ffe28a' : '#c2281c');
    x.fillStyle = grd; roundRect(x, 8, 8, 496, 176, 40); x.fill();
    x.lineWidth = 10; x.strokeStyle = '#ffffff'; x.stroke();
    x.font = '900 118px system-ui, "Segoe UI", sans-serif'; x.textAlign = 'center'; x.textBaseline = 'middle';
    x.fillStyle = kind === 'hi' ? '#3a1f00' : '#fff1ec'; x.fillText(kind === 'hi' ? 'NAT 20!' : 'NAT 1…', 256, 104);
    const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace;
    this.card?.removeFromParent();
    const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, toneMapped: false }));
    sp.renderOrder = 999;
    sp.position.copy(origin).add(new THREE.Vector3(0, this.tray.die * 2.2, 0));
    sp.scale.set(this.tray.die * 4.2, this.tray.die * 1.6, 1);
    sp.userData.t = 0;
    this.fx.add(sp);
    this.card = sp;
    for (const d of this.dice) if (d.sides === 20 && d.kept) { const m = d.mesh.material as THREE.MeshPhysicalMaterial; m.emissive = color.clone(); m.emissiveIntensity = 0.8; }
  }

  private updateFx(dt: number) {
    const s = this.sparks;
    if (s) {
      s.t += dt;
      const a = s.p.geometry.getAttribute('position') as THREE.BufferAttribute;
      for (let i = 0; i < a.count; i++) { s.v[i * 3 + 1] -= dt * 1.2; a.setXYZ(i, a.getX(i) + s.v[i * 3] * dt, Math.max(0.002, a.getY(i) + s.v[i * 3 + 1] * dt), a.getZ(i) + s.v[i * 3 + 2] * dt); }
      a.needsUpdate = true;
      (s.p.material as THREE.PointsMaterial).opacity = Math.max(0, 1 - s.t / 2.2);
      if (s.t > 2.4) { s.p.removeFromParent(); s.p.geometry.dispose(); (s.p.material as THREE.Material).dispose(); this.sparks = null; }
    }
    if (this.card) {
      const t = (this.card.userData.t += dt);
      const k = t < 0.25 ? t / 0.25 : 1;
      this.card.material.opacity = t > 3.2 ? Math.max(0, 1 - (t - 3.2) / 0.6) : 1;
      this.card.position.y += dt * this.tray.die * 0.4;
      this.card.scale.set(this.tray.die * 4.2 * (0.6 + 0.4 * k), this.tray.die * 1.6 * (0.6 + 0.4 * k), 1);
      if (t > 3.8) { this.card.removeFromParent(); this.card = null; }
    }
    for (const d of this.dice) { const m = d.mesh.material as THREE.MeshPhysicalMaterial; if (m.emissiveIntensity > 0) m.emissiveIntensity = Math.max(0, m.emissiveIntensity - dt * 0.25); }
  }

  /** Where the dice are (world, for the dice camera). */
  center(out = new THREE.Vector3()): THREE.Vector3 { return this.group.localToWorld(out.set(0, 0, 0)); }
  get rolling() { const c = this.cur; return !!c && Date.now() >= c.roll.at - 300 && Date.now() - c.roll.at < (c.thr.settle + 2.2) * 1000; }
  get current() { return this.cur?.roll ?? null; }

  private clearDice() {
    for (const d of this.dice) { d.body.removeFromParent(); d.mesh.geometry.dispose(); (d.mesh.material as THREE.Material).dispose(); }
    this.dice = [];
  }
  dispose() {
    this.clearDice();
    for (const m of this.material.values()) m.dispose();
    this.material.clear();
    this.sparks?.p.geometry.dispose();
    this.card?.material.map?.dispose();
    this.group.removeFromParent();
  }
}
