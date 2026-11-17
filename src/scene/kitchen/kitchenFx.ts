// Kitchen FX: flying food (instanced per food), sauce splats (instanced decals from npc/fx_atlas.png), billboards
// (stars, sweat, steam, anger veins, puffs, '!'), speech bubbles (canvas sprites) and the soft-serve eruption.
// Everything is rebuilt every frame from pure functions of the episode time (so every page matches).
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';

function vc(g: THREE.BufferGeometry, hex: string) {
  g = g.index ? g.toNonIndexed() : g;
  const c = new THREE.Color(hex);
  const n = g.attributes.position.count, a = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { a[i * 3] = c.r; a[i * 3 + 1] = c.g; a[i * 3 + 2] = c.b; }
  g.setAttribute('color', new THREE.BufferAttribute(a, 3));
  g.deleteAttribute('uv');
  return g;
}
const T = (g: THREE.BufferGeometry, x = 0, y = 0, z = 0, rx = 0, ry = 0, rz = 0, s = 1) => { g.scale(s, s, s); g.rotateX(rx); g.rotateY(ry); g.rotateZ(rz); g.translate(x, y, z); return g; };

/** the seven throwables, ~real size, centred */
function foodGeometries(): THREE.BufferGeometry[] {
  const burger = mergeGeometries([
    vc(T(new THREE.CylinderGeometry(0.055, 0.055, 0.025, 12), 0, -0.03), '#d99a4a'),
    vc(T(new THREE.CylinderGeometry(0.06, 0.06, 0.02, 12), 0, -0.008), '#5b2f18'),
    vc(T(new THREE.CylinderGeometry(0.062, 0.062, 0.006, 4), 0, 0.004, 0, 0, Math.PI / 4), '#ffc93c'),
    vc(T(new THREE.SphereGeometry(0.058, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), 0, 0.008, 0, 0, 0, 0, 1), '#e0a04e'),
  ]);
  const fries = mergeGeometries([
    vc(T(new THREE.CylinderGeometry(0.05, 0.035, 0.09, 4, 1, true), 0, 0, 0, 0, Math.PI / 4), '#d81f26'),
    ...[-0.02, 0, 0.02, -0.01, 0.012].map((x, k) => vc(T(new THREE.BoxGeometry(0.01, 0.1, 0.01), x, 0.04 + (k % 2) * 0.015, (k - 2) * 0.008), '#ffd24a')),
  ]);
  const nugget = vc(T(new THREE.DodecahedronGeometry(0.03, 0), 0, 0, 0, 0, 0, 0, 1), '#d8963a');
  const cup = mergeGeometries([
    vc(new THREE.CylinderGeometry(0.045, 0.036, 0.13, 10), '#ffffff'),
    vc(T(new THREE.CylinderGeometry(0.047, 0.047, 0.04, 10), 0, 0.005), '#d81f26'),
    vc(T(new THREE.CylinderGeometry(0.005, 0.005, 0.1, 4), 0.012, 0.1), '#ffc72c'),
  ]);
  const pickle = vc(T(new THREE.CylinderGeometry(0.03, 0.03, 0.006, 10), 0, 0, 0, Math.PI / 2), '#6aa33a');
  const bun = vc(new THREE.SphereGeometry(0.06, 12, 6, 0, Math.PI * 2, 0, Math.PI / 2), '#e0a04e');
  const lettuce = vc(T(new THREE.CircleGeometry(0.06, 7), 0, 0, 0, -Math.PI / 2), '#62be3c');
  return [burger, fries, nugget, cup, pickle, bun, lettuce].map((g) => g!);
}
export const FOOD_SPLAT = [0, 0, 1, 2, 3, 3, 3];   // food -> sauce kind (ketchup, mustard, soda, special sauce)

const CELL = { star: [1, 0], sweat: [1, 1], puff: [1, 2], bang: [1, 3], anger: [2, 0], ques: [2, 1], steam: [2, 2], lettuce: [2, 3], zzz: [3, 2], fire: [3, 3] } as const;
export type Billboard = keyof typeof CELL;

function cellGeom(r: number, c: number, grid = 4) {
  const g = new THREE.PlaneGeometry(1, 1);
  const uv = g.attributes.uv as THREE.BufferAttribute;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, (c + uv.getX(i)) / grid, 1 - (r + 1 - uv.getY(i)) / grid);
  return g;
}

const M = new THREE.Matrix4(), P = new THREE.Vector3(), S = new THREE.Vector3(), QQ = new THREE.Quaternion(), Z = new THREE.Vector3(0, 0, 1);

export class KitchenFx {
  readonly group = new THREE.Group();
  private food: THREE.InstancedMesh[] = [];
  private splat: THREE.InstancedMesh[] = [];
  private bills = new Map<Billboard, THREE.InstancedMesh>();
  private nFood: number[] = [];
  private nSplat: number[] = [];
  private nBill = new Map<Billboard, number>();
  private bubbles = new Map<string, { sprite: THREE.Sprite; used: boolean; aspect: number }>();
  private cream: THREE.InstancedMesh;
  private nCream = 0;
  readonly alarm = new THREE.PointLight(0xff2a1a, 0, 14, 1.4);

  constructor(atlas: THREE.Texture) {
    this.group.name = 'kitchen:fx';
    const foodMat = new THREE.MeshToonMaterial({ vertexColors: true });
    for (const g of foodGeometries()) {
      const m = new THREE.InstancedMesh(g, foodMat, 40); m.count = 0; m.frustumCulled = false; this.group.add(m); this.food.push(m);
    }
    atlas.colorSpace = THREE.SRGBColorSpace;
    for (let k = 0; k < 4; k++) {
      const mat = new THREE.MeshBasicMaterial({ map: atlas, transparent: true, alphaTest: 0.35, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2, side: THREE.DoubleSide });
      const m = new THREE.InstancedMesh(cellGeom(0, k), mat, 64); m.count = 0; m.frustumCulled = false; m.renderOrder = 2; this.group.add(m); this.splat.push(m);
    }
    for (const [name, [r, c]] of Object.entries(CELL) as [Billboard, readonly [number, number]][]) {
      const mat = new THREE.MeshBasicMaterial({ map: atlas, transparent: true, depthWrite: false, alphaTest: 0.05 });
      const m = new THREE.InstancedMesh(cellGeom(r, c), mat, 96); m.count = 0; m.frustumCulled = false; m.renderOrder = 5; this.group.add(m); this.bills.set(name, m);
    }
    this.cream = new THREE.InstancedMesh(new THREE.SphereGeometry(0.05, 8, 6), new THREE.MeshToonMaterial({ color: 0xfff6e0 }), 160);
    this.cream.count = 0; this.cream.frustumCulled = false; this.group.add(this.cream);
    this.alarm.position.set(0, 3.0, -4.5);
    this.group.add(this.alarm);
  }

  begin() {
    this.nFood = this.food.map(() => 0); this.nSplat = this.splat.map(() => 0); this.nBill.clear(); this.nCream = 0;
    for (const b of this.bubbles.values()) b.used = false;
  }

  foodAt(kind: number, pos: THREE.Vector3, spin: number, axis: THREE.Vector3, scale = 1) {
    const m = this.food[kind % this.food.length], n = this.nFood[kind % this.food.length];
    if (n >= m.instanceMatrix.count) return;
    QQ.setFromAxisAngle(axis, spin);
    M.compose(pos, QQ, S.setScalar(scale));
    m.setMatrixAt(n, M); this.nFood[kind % this.food.length] = n + 1;
  }

  splatAt(kind: number, pos: THREE.Vector3, normal: THREE.Vector3, size: number, rot: number) {
    const m = this.splat[kind % 4], n = this.nSplat[kind % 4];
    if (n >= m.instanceMatrix.count || size <= 0.002) return;
    QQ.setFromUnitVectors(Z, normal).multiply(new THREE.Quaternion().setFromAxisAngle(Z, rot));
    M.compose(pos, QQ, S.set(size, size, size));
    m.setMatrixAt(n, M); this.nSplat[kind % 4] = n + 1;
  }

  bill(kind: Billboard, pos: THREE.Vector3, size: number, cam: THREE.Camera, roll = 0) {
    const m = this.bills.get(kind)!; const n = this.nBill.get(kind) ?? 0;
    if (n >= m.instanceMatrix.count) return;
    QQ.copy(cam.quaternion);
    if (roll) QQ.multiply(new THREE.Quaternion().setFromAxisAngle(Z, roll));
    M.compose(pos, QQ, S.set(size, size, size));
    m.setMatrixAt(n, M); this.nBill.set(kind, n + 1);
  }

  creamAt(pos: THREE.Vector3, s: number) {
    if (this.nCream >= this.cream.instanceMatrix.count) return;
    M.compose(pos, QQ.identity(), S.setScalar(s));
    this.cream.setMatrixAt(this.nCream++, M);
  }

  bubble(text: string, pos: THREE.Vector3, loud: boolean, h: number) {
    let b = this.bubbles.get(text + (loud ? '!' : ''));
    if (!b) {
      const c = document.createElement('canvas');
      const ctx = c.getContext('2d')!;
      const fs = 44, font = `${loud ? '900' : '700'} ${fs}px Impact, "Arial Black", sans-serif`;
      ctx.font = font;
      const words = text.split(' '); const lines: string[] = []; let cur = '';
      for (const w of words) { const t = cur ? cur + ' ' + w : w; if (ctx.measureText(t).width > 520 && cur) { lines.push(cur); cur = w; } else cur = t; }
      if (cur) lines.push(cur);
      const W = Math.min(600, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 60), H = lines.length * (fs + 8) + 60;
      c.width = Math.ceil(W); c.height = Math.ceil(H + 30);
      const g = c.getContext('2d')!;
      g.font = font; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillStyle = loud ? '#fff4c2' : '#ffffff'; g.strokeStyle = '#111'; g.lineWidth = 6;
      const r = 26;
      g.beginPath(); g.roundRect(4, 4, W - 8, H - 8, r); g.fill(); g.stroke();
      g.beginPath(); g.moveTo(W * 0.4, H - 6); g.lineTo(W * 0.32, H + 24); g.lineTo(W * 0.52, H - 6); g.closePath(); g.fill(); g.stroke();
      g.fillStyle = loud ? '#c8141a' : '#1a1a1a';
      lines.forEach((l, i) => g.fillText(l, W / 2, 30 + (fs + 8) * (i + 0.5)));
      const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
      const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, depthTest: false, transparent: true }));
      sp.renderOrder = 20; sp.center.set(0.35, 0);
      this.group.add(sp);
      b = { sprite: sp, used: false, aspect: c.width / c.height };
      this.bubbles.set(text + (loud ? '!' : ''), b);
    }
    b.used = true;
    b.sprite.visible = true;
    b.sprite.position.copy(pos);
    b.sprite.scale.set(h * b.aspect, h, 1);
  }

  end() {
    this.food.forEach((m, k) => { m.count = this.nFood[k]; m.instanceMatrix.needsUpdate = true; });
    this.splat.forEach((m, k) => { m.count = this.nSplat[k]; m.instanceMatrix.needsUpdate = true; });
    for (const [k, m] of this.bills) { m.count = this.nBill.get(k) ?? 0; m.instanceMatrix.needsUpdate = true; }
    this.cream.count = this.nCream; this.cream.instanceMatrix.needsUpdate = true;
    for (const [k, b] of this.bubbles) {
      if (!b.used) {
        b.sprite.visible = false;
        if (this.bubbles.size > 24) { b.sprite.removeFromParent(); (b.sprite.material as THREE.SpriteMaterial).map?.dispose(); b.sprite.material.dispose(); this.bubbles.delete(k); }
      }
    }
  }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh || (o as THREE.Sprite).isSprite) {
        (m.geometry as THREE.BufferGeometry | undefined)?.dispose?.();
        const mats = Array.isArray(m.material) ? m.material : [m.material];
        for (const x of mats) { (x as THREE.MeshBasicMaterial).map?.dispose?.(); x?.dispose?.(); }
      }
    });
  }
}

export { P as _tmpP };
