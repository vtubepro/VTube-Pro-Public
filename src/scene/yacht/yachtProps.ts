// Yacht life — the hand props: champagne flutes (two instanced draws for all of them: glass + wine), the stewards'
// silver trays and the champagne bottle. The crew GLB's PROP_flute / PROP_tray / PROP_bottle are used when the room's
// unit file has them (re-centred: base at the origin, drawn with the crew atlas); otherwise clean procedural ones.
// Immediate mode: every frame the crew / effects place what they need (begin → flute() … → end), no allocations.
import * as THREE from 'three';

const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), S = new THREE.Vector3(), E = new THREE.Euler();
const FLUTE_H = 0.235;

function lathe(pts: [number, number][], seg = 14) { return new THREE.LatheGeometry(pts.map(([r, y]) => new THREE.Vector2(r, y)), seg); }

/** base at y = 0, centred on x/z, scaled so its height is `h` (null = keep) */
function recentre(g: THREE.BufferGeometry, h: number | null): THREE.BufferGeometry {
  const c = g.clone();
  c.computeBoundingBox();
  const b = c.boundingBox!;
  c.translate(-(b.min.x + b.max.x) / 2, -b.min.y, -(b.min.z + b.max.z) / 2);
  if (h) { const k = h / Math.max(1e-3, b.max.y - b.min.y); c.scale(k, k, k); }
  return c;
}

export type PropSource = { geo: THREE.BufferGeometry } | undefined;

export class YachtProps {
  readonly group = new THREE.Group();
  private glass: THREE.InstancedMesh;
  private wine: THREE.InstancedMesh | null;
  private n = 0;
  readonly trays: THREE.Group[] = [];
  readonly bottle: THREE.Group;
  private mats: THREE.Material[] = [];
  private geos: THREE.BufferGeometry[] = [];

  constructor(atlasMat: THREE.Material | null, props: { flute?: PropSource; tray?: PropSource; bottle?: PropSource }, max = 24) {
    this.group.name = 'yacht:props';
    // ---- flutes
    if (props.flute && atlasMat) {
      const g = recentre(props.flute.geo, FLUTE_H); this.geos.push(g);
      this.glass = new THREE.InstancedMesh(g, atlasMat, max);
      this.wine = null;
    } else {
      const bowl: [number, number][] = [[0.0, 0.0], [0.034, 0.0], [0.036, 0.004], [0.006, 0.012], [0.004, 0.02], [0.0035, 0.1], [0.012, 0.112], [0.024, 0.135], [0.029, 0.175], [0.03, 0.235], [0.028, 0.235]];
      const liquid: [number, number][] = [[0.0, 0.108], [0.011, 0.113], [0.022, 0.135], [0.026, 0.17], [0.0265, 0.2], [0.0, 0.2]];
      const gg = lathe(bowl, 16), gw = lathe(liquid, 12);
      this.geos.push(gg, gw);
      const gm = new THREE.MeshStandardMaterial({ color: 0xeaf4ff, roughness: 0.05, metalness: 0.0, transparent: true, opacity: 0.38, depthWrite: false, side: THREE.DoubleSide, envMapIntensity: 1.4 });
      gm.name = 'yacht:glass';
      const wm = new THREE.MeshStandardMaterial({ color: 0xf1c75a, roughness: 0.2, metalness: 0.1, emissive: 0x5a3a08, emissiveIntensity: 0.35, transparent: true, opacity: 0.9 });
      wm.name = 'yacht:wine';
      this.mats.push(gm, wm);
      this.wine = new THREE.InstancedMesh(gw, wm, max);
      this.glass = new THREE.InstancedMesh(gg, gm, max);
      this.wine.renderOrder = 7; this.glass.renderOrder = 8;
    }
    for (const m of [this.glass, this.wine]) if (m) { m.count = 0; m.frustumCulled = false; m.castShadow = false; this.group.add(m); }
    // ---- trays
    let silver: THREE.MeshStandardMaterial | null = null;
    for (let i = 0; i < 2; i++) {
      const t = new THREE.Group(); t.name = `yacht:tray${i}`;
      if (props.tray && atlasMat) {
        const g = recentre(props.tray.geo, null); this.geos.push(g);
        t.add(new THREE.Mesh(g, atlasMat));
      } else {
        if (!silver) { silver = new THREE.MeshStandardMaterial({ color: 0xd9dbe4, metalness: 0.92, roughness: 0.22 }); silver.name = 'yacht:silver'; this.mats.push(silver); }
        const disc = new THREE.CylinderGeometry(0.18, 0.17, 0.012, 28); disc.translate(0, 0.006, 0);
        const rim = new THREE.TorusGeometry(0.18, 0.006, 6, 32); rim.rotateX(Math.PI / 2); rim.translate(0, 0.013, 0);
        this.geos.push(disc, rim);
        t.add(new THREE.Mesh(disc, silver), new THREE.Mesh(rim, silver));
      }
      t.visible = false;
      this.trays.push(t); this.group.add(t);
    }
    // ---- bottle
    this.bottle = new THREE.Group(); this.bottle.name = 'yacht:bottle';
    if (props.bottle && atlasMat) {
      const g = recentre(props.bottle.geo, 0.34); this.geos.push(g);
      this.bottle.add(new THREE.Mesh(g, atlasMat));
    } else {
      const body = lathe([[0, 0], [0.043, 0], [0.045, 0.006], [0.045, 0.2], [0.04, 0.23], [0.022, 0.265], [0.016, 0.3], [0.0165, 0.335], [0, 0.335]], 18);
      const foil = lathe([[0, 0.262], [0.0235, 0.262], [0.0175, 0.3], [0.018, 0.342], [0.0, 0.342]], 14);
      const label = new THREE.CylinderGeometry(0.0462, 0.0462, 0.07, 22, 1, true); label.translate(0, 0.12, 0);
      this.geos.push(body, foil, label);
      const green = new THREE.MeshStandardMaterial({ color: 0x0c2a14, roughness: 0.12, metalness: 0.2 }); green.name = 'yacht:bottle';
      const gold = new THREE.MeshStandardMaterial({ color: 0xe0b457, roughness: 0.3, metalness: 0.95 }); gold.name = 'yacht:foil';
      const cream = new THREE.MeshStandardMaterial({ color: 0xf2ead8, roughness: 0.6, metalness: 0 }); cream.name = 'yacht:label';
      this.mats.push(green, gold, cream);
      this.bottle.add(new THREE.Mesh(body, green), new THREE.Mesh(foil, gold), new THREE.Mesh(label, cream));
    }
    this.bottle.visible = false;
    this.group.add(this.bottle);
    this.group.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  }

  begin() { this.n = 0; }

  /** A flute standing at `p` (its base) — tilt (rad, about the local X after yaw) for a hand-held one. */
  flute(p: THREE.Vector3, yaw = 0, scale = 1, tilt = 0) {
    if (this.n >= this.glass.instanceMatrix.count) return;
    E.set(tilt, yaw, 0, 'YXZ'); Q.setFromEuler(E);
    M.compose(p, Q, S.setScalar(scale));
    this.glass.setMatrixAt(this.n, M);
    this.wine?.setMatrixAt(this.n, M);
    this.n++;
  }

  end() {
    for (const m of [this.glass, this.wine]) if (m) { m.count = this.n; m.instanceMatrix.needsUpdate = true; }
  }

  get count() { return this.n; }

  dispose() {
    this.group.removeFromParent();
    for (const g of this.geos) g.dispose();
    for (const m of this.mats) m.dispose();
    this.glass.dispose(); this.wine?.dispose();
  }
}

export { FLUTE_H };
