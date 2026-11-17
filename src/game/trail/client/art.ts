// The Trail — placeholder art per theme (grey-box but charming): the wagon, props, animals, NPCs, scenery, tombstones.
// Every builder returns a Group whose origin + axes match the sim / ASSET_SPEC contract (origin at the bottom centre
// for props; the wagon's origin at ground level, +Z forward). trailart's GLBs replace these (assets.ts).
import * as THREE from 'three';
import { ball, box, cone, cyl, labelSprite, mesh, outline, textTexture, toon, unitBox, unitCone, unitCyl, unitOcta, unitSphere, unitTorus, unitDodeca } from './kit.ts';

type T3 = [number, number, number];
const TH = (theme: string) => (theme === 'bayou' ? 'b' : theme === 'skyisles' ? 'l' : 'f');

// ---------------------------------------------------------------- the wagon
export interface WagonArt { root: THREE.Group; wheels: Record<string, THREE.Object3D>; body: THREE.Group;
  /** Optional damage states from the theme GLB (hidden until needed): a broken front-left wheel, a battered body, the raft. */
  dmg?: { wheel?: THREE.Object3D; body?: THREE.Object3D; raft?: THREE.Object3D } }
export function buildWagon(theme: string): WagonArt {
  const t = TH(theme);
  const root = new THREE.Group(), body = new THREE.Group();
  root.add(body);
  const wheels: Record<string, THREE.Object3D> = {};
  const wheelCol = t === 'b' ? '#4a3524' : t === 'l' ? '#f2c14e' : '#6b4a2e';
  const hub = t === 'l' ? '#fff6d0' : '#2a2320';
  for (const [k, p] of Object.entries({ FL: [-1.08, 0.55, 1.35], FR: [1.08, 0.55, 1.35], RL: [-1.08, 0.65, -1.35], RR: [1.08, 0.65, -1.35] } as Record<string, T3>)) {
    const r = k.startsWith('F') ? 0.55 : 0.65;
    const w = new THREE.Group();
    w.position.set(...p);
    const rim = mesh(unitTorus(), toon(wheelCol), [0, 0, 0], [r * 0.92, r * 0.92, r * 0.6], [0, Math.PI / 2, 0]);
    w.add(rim);
    if (t === 'l') w.add(ball('#ffffff', [0, 0, 0], [0.12, r * 0.85, r * 0.85]));
    for (let i = 0; i < 6; i++) w.add(box(wheelCol, [0, 0, 0], [0.05, r * 1.7, 0.06], [i * Math.PI / 6, 0, 0]));
    w.add(cyl(hub, [0, 0, 0], 0.12, 0.2, [0, 0, Math.PI / 2]));
    wheels[k] = w;
    root.add(w);
  }
  if (t === 'b') {
    // the Swamp Barge: a clawfoot bathtub lowrider under a patched canvas bonnet with Sprocket's face
    const tub = mesh(unitCapsuleLike(), toon('#f4f1e6'), [0, 1.18, 0], [1.02, 0.42, 1.95]);
    body.add(tub, box('#7cdb4f', [0, 1.58, 0], [2.05, 0.08, 3.9]), box('#e8e3d0', [0, 0.92, 0], [1.9, 0.12, 3.6]));
    for (const [x, z] of [[-0.7, 1.4], [0.7, 1.4], [-0.7, -1.4], [0.7, -1.4]]) body.add(ball('#d8b04a', [x, 0.72, z], [0.12, 0.2, 0.12]));
    // underglow + plate + lantern
    body.add(box('#ff3fd2', [0, 0.62, 0], [1.7, 0.04, 3.3]));
    (body.children[body.children.length - 1] as THREE.Mesh).material = toon('#ff3fd2', { emissive: '#ff3fd2', ei: 2.2 });
    const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.62, 0.2), new THREE.MeshBasicMaterial({ map: textTexture(['HONK IF', "YOU'RE DAMP"], { w: 256, h: 96, bg: '#ffe066', fg: '#1c2a14' }) }));
    plate.position.set(0, 1.05, -1.99); plate.rotation.y = Math.PI; body.add(plate);
    bonnet(body, '#e9dfc1', '#c9bb92', 7);
    const face = new THREE.Mesh(new THREE.CircleGeometry(0.62, 32), new THREE.MeshBasicMaterial({ map: frogFace(), transparent: true }));
    face.position.set(1.1, 2.05, 0.1); face.rotation.y = Math.PI / 2; body.add(face);
    const face2 = face.clone(); face2.position.x = -1.1; face2.rotation.y = -Math.PI / 2; body.add(face2);
    body.add(cyl('#3a3a3a', [0.9, 2.7, 1.3], 0.03, 0.4), ball('#ffd23f', [0.9, 2.95, 1.3], 0.09, { emissive: '#ffb020', ei: 2 }));
    body.add(mesh(unitTorus(), toon('#9aa0a6'), [-0.7, 2.75, -1.1], [0.18, 0.18, 0.18], [Math.PI / 2.4, 0, 0]));
  } else if (t === 'l') {
    // the Seraph Carriage: white + gold body, feathered wings, a red canopy with the winged emblem
    body.add(box('#fbf8f1', [0, 1.25, 0], [1.95, 0.8, 3.7]), box('#f2c14e', [0, 1.68, 0], [2.02, 0.08, 3.78]), box('#f2c14e', [0, 0.86, 0], [2.02, 0.08, 3.78]));
    bonnet(body, '#d83a4a', '#b82a3a', 6);
    for (const s of [-1, 1]) {
      const wing = new THREE.Group();
      for (let i = 0; i < 6; i++) wing.add(mesh(unitSphere(10), toon(i % 2 ? '#ffffff' : '#eef3ff'), [0, 0.08 * i, -0.3 * i], [0.06, 0.22 + i * 0.04, 0.55 - i * 0.03], [0.3 + i * 0.12, 0, 0]));
      wing.position.set(s * 1.1, 1.45, 0.6); wing.rotation.z = s * -0.25;
      body.add(wing);
    }
    const emb = new THREE.Mesh(new THREE.CircleGeometry(0.45, 32), new THREE.MeshBasicMaterial({ map: wingEmblem(), transparent: true }));
    emb.position.set(1.08, 2.1, 0); emb.rotation.y = Math.PI / 2; body.add(emb);
    const emb2 = emb.clone(); emb2.position.x = -1.08; emb2.rotation.y = -Math.PI / 2; body.add(emb2);
    body.add(cone('#f2c14e', [0, 2.95, 1.2], 0.08, 0.5, [0.5, 0, 0]), ball('#fff3b0', [0, 2.55, 1.9], 0.1, { emissive: '#ffe070', ei: 2 }));
  } else {
    body.add(box('#8a6038', [0, 1.2, 0], [1.9, 0.7, 3.7]), box('#6b4a2e', [0, 0.88, 0], [1.95, 0.08, 3.75]));
    bonnet(body, '#f1ead8', '#d8ceb6', 6);
  }
  // tongue + yoke toward the animals
  body.add(box('#6b4a2e', [0, 0.6, 2.7], [0.1, 0.1, 1.6]));
  outline(root);
  return { root, wheels, body };
}
function unitCapsuleLike() { return new THREE.CapsuleGeometry(0.5, 1.0, 6, 16).rotateX(Math.PI / 2).scale(2, 2, 1); }
function bonnet(body: THREE.Group, c1: string, c2: string, hoops: number) {
  const g = new THREE.CylinderGeometry(1.08, 1.08, 3.5, 20, 1, true, -Math.PI / 2, Math.PI);
  g.rotateX(Math.PI / 2); g.rotateZ(Math.PI / 2);
  const m = new THREE.Mesh(g, toon(c1, { side: THREE.DoubleSide }));
  m.rotation.z = Math.PI / 2;
  m.position.set(0, 1.6, -0.1);
  m.scale.set(1, 0.85, 1);
  body.add(m);
  for (let i = 0; i < hoops; i++) {
    const z = -1.8 + (3.5 / (hoops - 1)) * i;
    const h = new THREE.Mesh(new THREE.TorusGeometry(1.09, 0.035, 6, 20, Math.PI), toon(c2));
    h.position.set(0, 1.6, z - 0.1); h.scale.set(1, 0.85, 1);
    body.add(h);
  }
}
let frogTex: THREE.Texture | null = null;
function frogFace(): THREE.Texture {
  if (frogTex) return frogTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#6fd14a'; g.beginPath(); g.arc(128, 140, 110, 0, Math.PI * 2); g.fill();
  for (const x of [70, 186]) { g.fillStyle = '#6fd14a'; g.beginPath(); g.arc(x, 70, 50, 0, Math.PI * 2); g.fill(); g.fillStyle = '#fff'; g.beginPath(); g.arc(x, 70, 36, 0, Math.PI * 2); g.fill(); g.fillStyle = '#1b1b1b'; g.beginPath(); g.arc(x + 6, 74, 18, 0, Math.PI * 2); g.fill(); }
  g.strokeStyle = '#1f3a14'; g.lineWidth = 9; g.beginPath(); g.arc(128, 150, 62, 0.15 * Math.PI, 0.85 * Math.PI); g.stroke();
  g.fillStyle = '#ff7ab8'; g.beginPath(); g.ellipse(80, 170, 18, 10, 0, 0, Math.PI * 2); g.ellipse(176, 170, 18, 10, 0, 0, Math.PI * 2); g.fill();
  frogTex = new THREE.CanvasTexture(c); frogTex.colorSpace = THREE.SRGBColorSpace;
  return frogTex;
}
let wingTex: THREE.Texture | null = null;
function wingEmblem(): THREE.Texture {
  if (wingTex) return wingTex;
  const c = document.createElement('canvas'); c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fbf8f1'; g.beginPath(); g.arc(128, 128, 118, 0, Math.PI * 2); g.fill();
  g.strokeStyle = '#f2c14e'; g.lineWidth = 12; g.stroke();
  g.fillStyle = '#f2c14e';
  for (const s of [-1, 1]) for (let i = 0; i < 5; i++) { g.beginPath(); g.ellipse(128 + s * (30 + i * 14), 120 - i * 8, 12, 46 - i * 5, s * (0.5 + i * 0.12), 0, Math.PI * 2); g.fill(); }
  g.fillStyle = '#d83a4a'; g.beginPath(); g.arc(128, 140, 16, 0, Math.PI * 2); g.fill();
  wingTex = new THREE.CanvasTexture(c); wingTex.colorSpace = THREE.SRGBColorSpace;
  return wingTex;
}

// ---------------------------------------------------------------- props
export function buildProp(sub: string, theme: string, size: T3, label?: string, color?: string): THREE.Group {
  const t = TH(theme);
  const g = new THREE.Group();
  const [sx, sy, sz] = size;
  const labelled = (c: string, lines: string[], bg: string, fg: string) => {
    const b = box(c, [0, 0, 0], [sx * 2, sy * 2, sz * 2]);
    g.add(b);
    const tex = textTexture(lines, { w: 256, h: 128, fg, bg });
    for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.PlaneGeometry(sx * 1.7, sy * 1.5), new THREE.MeshBasicMaterial({ map: tex, transparent: true })); p.position.z = s * (sz + 0.004); if (s < 0) p.rotation.y = Math.PI; g.add(p); }
    for (const x of [-1, 1]) g.add(box('#3b2a1d', [x * sx * 0.98, 0, 0], [0.02, sy * 2.02, sz * 2.02]));
  };
  switch (sub) {
    case 'crate_food': labelled(t === 'l' ? '#e8d6a8' : '#b5874f', t === 'b' ? ['SWAMP', 'RATIONS'] : t === 'l' ? ['PILGRIM', 'BREAD'] : ['FOOD', '50 LBS'], 'rgba(0,0,0,0)', t === 'b' ? '#2a3a18' : '#5a3a1a'); break;
    case 'clothes_bundle': g.add(ball(t === 'b' ? '#7a6bd6' : t === 'l' ? '#d83a4a' : '#8a7a6a', [0, 0, 0], [sx, sy, sz]), box('#3b2a1d', [0, 0, 0], [0.04, sy * 2.05, sz * 2.05])); if (t === 'l') g.add(cyl('#c3263a', [0, sy * 0.95, 0], sx * 0.6, 0.05)); break;
    case 'ammo_box': labelled('#56644a', t === 'b' ? ['PEBBLES'] : t === 'l' ? ['HOLY', 'BOLTS'] : ['AMMO'], 'rgba(0,0,0,0)', '#e9f5d0'); break;
    case 'medicine': g.add(cyl(t === 'l' ? '#bfe6ff' : '#6cff9a', [0, 0, 0], sx, sy * 2, undefined, { emissive: t === 'l' ? '#7fd3ff' : '#3dff7a', ei: 0.9 }), cyl('#6b4a2e', [0, sy * 1.05, 0], sx * 0.8, 0.05)); break;
    case 'spare_wheel': { const w = mesh(unitTorus(), toon('#6b4a2e'), [0, 0, 0], [sx * 0.9, sx * 0.9, 0.35], [Math.PI / 2, 0, 0]); g.add(w); for (let i = 0; i < 4; i++) g.add(box('#6b4a2e', [0, 0, 0], [sx * 1.7, 0.04, 0.05], [0, i * Math.PI / 4, 0])); break; }
    case 'spare_axle': case 'spare_tongue': case 'plank': g.add(box(sub === 'plank' ? '#a07a4a' : '#6b4a2e', [0, 0, 0], [sx * 2, sy * 2, sz * 2])); break;
    case 'barrel': g.add(cyl('#8a5a2b', [0, 0, 0], sx, sy * 2), mesh(unitTorus(), toon('#3a3a3a'), [0, sy * 0.6, 0], [sx, sx, 0.2], [Math.PI / 2, 0, 0]), mesh(unitTorus(), toon('#3a3a3a'), [0, -sy * 0.6, 0], [sx, sx, 0.2], [Math.PI / 2, 0, 0])); break;
    case 'bucket': g.add(cyl('#a0a0a0', [0, 0, 0], sx, sy * 2)); break;
    case 'meme_frog':
      if (t === 'l') { g.add(cyl('#d83a4a', [0, -0.03, 0], sx * 1.1, 0.07), ball('#d83a4a', [0, 0.03, 0], [sx * 1.05, sx * 0.45, sx * 1.05]), cone('#f2c14e', [sx * 0.6, 0.12, 0], 0.03, 0.22, [0, 0, -0.5]), ball('#ffffff', [sx * 0.5, 0.05, 0], [0.04, 0.05, 0.02])); }
      else { g.add(ball('#8dff3a', [0, 0, 0], [sx, sy * 0.85, sz]), ball('#8dff3a', [-sx * 0.45, sy * 0.7, sz * 0.2], sx * 0.35), ball('#8dff3a', [sx * 0.45, sy * 0.7, sz * 0.2], sx * 0.35), ball('#ffffff', [-sx * 0.45, sy * 0.8, sz * 0.45], sx * 0.2), ball('#ffffff', [sx * 0.45, sy * 0.8, sz * 0.45], sx * 0.2), ball('#111111', [-sx * 0.45, sy * 0.8, sz * 0.6], sx * 0.1), ball('#111111', [sx * 0.45, sy * 0.8, sz * 0.6], sx * 0.1)); }
      break;
    case 'draft': return buildDraft(theme);
    default: g.add(box(color ?? '#aa8866', [0, 0, 0], [sx * 2, sy * 2, sz * 2]));
  }
  void label;
  outline(g, 0.0018);
  return g;
}

/** Draft animal (giant toad / sky-pig / ox), origin at its centre (the sim capsule centre), facing +Z. */
export function buildDraft(theme: string): THREE.Group {
  const t = TH(theme);
  const g = new THREE.Group();
  if (t === 'b') {
    g.add(ball('#6fae3a', [0, -0.1, 0], [0.62, 0.45, 0.8]), ball('#8fcf4a', [0, -0.25, 0.25], [0.5, 0.25, 0.55]));
    for (const x of [-0.3, 0.3]) g.add(ball('#6fae3a', [x, 0.3, 0.5], 0.2), ball('#ffffff', [x, 0.36, 0.62], 0.12), ball('#111111', [x, 0.37, 0.72], 0.06));
    for (const [x, z] of [[-0.55, -0.4], [0.55, -0.4], [-0.45, 0.45], [0.45, 0.45]]) g.add(ball('#5a9230', [x, -0.45, z], [0.2, 0.1, 0.28]));
    g.add(cyl('#e0c040', [0, 0.5, 0.2], 0.22, 0.12), cyl('#e0c040', [0, 0.45, 0.2], 0.3, 0.02));
  } else if (t === 'l') {
    g.add(ball('#ffb3c8', [0, 0, 0], [0.5, 0.45, 0.75]), ball('#ffb3c8', [0, 0.1, 0.65], 0.32), cyl('#ff8fb0', [0, 0.05, 0.95], 0.13, 0.12, [Math.PI / 2, 0, 0]));
    for (const s of [-1, 1]) g.add(mesh(unitSphere(10), toon('#ffffff'), [s * 0.52, 0.3, 0.05], [0.05, 0.25, 0.4], [0, 0, s * 0.6]));
    g.add(mesh(unitTorus(), toon('#f2c14e', { emissive: '#ffd84a', ei: 1.2 }), [0, 0.62, 0.55], [0.22, 0.22, 0.22], [Math.PI / 2, 0, 0]));
    for (const [x, z] of [[-0.3, -0.45], [0.3, -0.45], [-0.3, 0.4], [0.3, 0.4]]) g.add(cyl('#ff9fbb', [x, -0.45, z], 0.09, 0.25));
    for (const x of [-0.13, 0.13]) g.add(ball('#111111', [x, 0.2, 0.93], 0.045));
  } else {
    g.add(ball('#7a5a3a', [0, 0, 0], [0.5, 0.48, 0.85]), ball('#7a5a3a', [0, 0.15, 0.8], [0.28, 0.28, 0.35]));
    for (const s of [-1, 1]) g.add(cone('#e8e0c8', [s * 0.3, 0.45, 0.8], 0.05, 0.3, [0, 0, s * -1.1]));
    for (const [x, z] of [[-0.3, -0.5], [0.3, -0.5], [-0.3, 0.5], [0.3, 0.5]]) g.add(cyl('#5a4028', [x, -0.5, z], 0.09, 0.4));
  }
  outline(g, 0.0018);
  return g;
}

/** Hunting animals / thieves: body along +Z, origin at the capsule centre. `len` = body length (m). */
export function buildAnimal(kind: string, len: number): THREE.Group {
  const g = new THREE.Group();
  const s = len;
  const eyes = (y: number, z: number, x = 0.12) => { for (const e of [-x, x]) g.add(ball('#ffffff', [e * s, y * s, z * s], 0.06 * s), ball('#111111', [e * s, y * s, (z + 0.035) * s], 0.03 * s)); };
  switch (kind) {
    case 'hog': case 'sky_boar':
      g.add(ball(kind === 'hog' ? '#6b4a3a' : '#c79a86', [0, 0, 0], [0.28 * s, 0.26 * s, 0.5 * s]), ball(kind === 'hog' ? '#7a5a48' : '#d8ac98', [0, 0.05 * s, 0.42 * s], 0.18 * s), cyl('#e0a090', [0, 0.02 * s, 0.6 * s], 0.08 * s, 0.07 * s, [Math.PI / 2, 0, 0]));
      for (const x of [-0.08, 0.08]) g.add(cone('#f4f0e0', [x * s, -0.02 * s, 0.58 * s], 0.02 * s, 0.1 * s, [0.8, 0, 0]));
      if (kind === 'hog') g.add(ball('#3f8a2d', [0, 0.25 * s, -0.1 * s], [0.14 * s, 0.03 * s, 0.14 * s]));
      else for (const x of [-1, 1]) g.add(ball('#ffffff', [x * 0.28 * s, 0.18 * s, 0], [0.04 * s, 0.14 * s, 0.25 * s]));
      eyes(0.14, 0.52, 0.08);
      for (const [x, z] of [[-0.15, -0.3], [0.15, -0.3], [-0.15, 0.3], [0.15, 0.3]]) g.add(cyl('#4a3226', [x * s, -0.25 * s, z * s], 0.05 * s, 0.2 * s));
      break;
    case 'snail':
      g.add(ball('#c8b27a', [0, -0.12 * s, 0.1 * s], [0.18 * s, 0.1 * s, 0.5 * s]), mesh(unitTorus(), toon('#b04ad8'), [0, 0.12 * s, -0.08 * s], [0.25 * s, 0.25 * s, 0.4 * s], [0, Math.PI / 2, 0]), ball('#ff7ad8', [0, 0.12 * s, -0.08 * s], [0.12 * s, 0.22 * s, 0.22 * s]));
      for (const x of [-0.06, 0.06]) g.add(cyl('#c8b27a', [x * s, 0.05 * s, 0.5 * s], 0.015 * s, 0.25 * s, [0.3, 0, 0]), ball('#111', [x * s, 0.17 * s, 0.54 * s], 0.035 * s));
      break;
    case 'gator': case 'wyvern':
      g.add(ball(kind === 'gator' ? '#4a6b2a' : '#5a3a6b', [0, 0, 0], [0.2 * s, 0.13 * s, 0.5 * s]), box(kind === 'gator' ? '#557a30' : '#6b4a7a', [0, -0.02 * s, 0.55 * s], [0.18 * s, 0.1 * s, 0.35 * s]), cone(kind === 'gator' ? '#4a6b2a' : '#5a3a6b', [0, 0, -0.62 * s], 0.1 * s, 0.35 * s, [-Math.PI / 2, 0, 0]));
      g.add(box('#111111', [0, 0.06 * s, 0.45 * s], [0.2 * s, 0.035 * s, 0.05 * s]));
      for (const [x, z] of [[-0.18, -0.25], [0.18, -0.25], [-0.18, 0.25], [0.18, 0.25]]) g.add(ball('#3e5a22', [x * s, -0.1 * s, z * s], [0.06 * s, 0.04 * s, 0.08 * s]));
      if (kind === 'wyvern') for (const x of [-1, 1]) g.add(mesh(unitSphere(10), toon('#7a5a8a', { side: THREE.DoubleSide }), [x * 0.4 * s, 0.12 * s, 0], [0.4 * s, 0.02 * s, 0.25 * s], [0, 0, x * 0.3]));
      break;
    case 'slime':
      g.add(mesh(unitSphere(), toon('#6fe0ff', { transparent: 0.75 }), [0, -0.05 * s, 0], [0.45 * s, 0.35 * s, 0.45 * s]));
      eyes(0.1, 0.33, 0.12);
      break;
    case 'goose':
      g.add(ball('#f4f4f0', [0, 0, 0], [0.3 * s, 0.26 * s, 0.45 * s]), cyl('#f4f4f0', [0, 0.35 * s, 0.3 * s], 0.06 * s, 0.4 * s, [0.3, 0, 0]), ball('#f4f4f0', [0, 0.55 * s, 0.38 * s], 0.1 * s), cone('#ff9a2a', [0, 0.54 * s, 0.52 * s], 0.04 * s, 0.14 * s, [Math.PI / 2, 0, 0]));
      break;
    case 'thief':
      g.add(ball('#7a7a82', [0, 0, 0], [0.26 * s, 0.24 * s, 0.42 * s]), ball('#8a8a92', [0, 0.1 * s, 0.38 * s], 0.18 * s), box('#1a1a1e', [0, 0.14 * s, 0.5 * s], [0.3 * s, 0.07 * s, 0.1 * s]));
      for (let i = 0; i < 4; i++) g.add(ball(i % 2 ? '#2a2a2e' : '#9a9aa2', [0, 0.05 * s, (-0.5 - i * 0.1) * s], 0.07 * s));
      eyes(0.16, 0.5, 0.07);
      g.add(box('#b5874f', [0, 0.35 * s, 0], [0.4 * s, 0.25 * s, 0.3 * s]));
      break;
    default: // deer / rabbit / bear / cloud_sheep / duck …
      g.add(ball('#8a6a4a', [0, 0, 0], [0.25 * s, 0.25 * s, 0.45 * s]), ball('#8a6a4a', [0, 0.25 * s, 0.4 * s], 0.15 * s));
      eyes(0.3, 0.52, 0.06);
      for (const [x, z] of [[-0.12, -0.3], [0.12, -0.3], [-0.12, 0.3], [0.12, 0.3]]) g.add(cyl('#5a4028', [x * s, -0.3 * s, z * s], 0.04 * s, 0.3 * s));
  }
  outline(g, 0.0018);
  return g;
}

/** NPC stand-ins by id / role (theme-flavoured), origin at the feet, facing +Z, ~1.6 m. */
export function buildNpc(id: string, theme: string, name: string): THREE.Group {
  const t = TH(theme);
  const g = new THREE.Group();
  const look: Record<string, [string, string]> = t === 'b'
    ? { shopkeeper: ['#6fae3a', '#b07a4a'], ferryman: ['#b8c8d8', '#2a3a5a'], talker_1: ['#ff9a3a', '#7a6bd6'], talker_2: ['#7a7a82', '#3a3a3a'], talker_3: ['#5a8a4a', '#d8c090'] }
    : t === 'l' ? { shopkeeper: ['#e8e0d0', '#ffffff'], ferryman: ['#dfe9ff', '#5a7ab8'], talker_1: ['#c0c8d8', '#7a8aa8'], talker_2: ['#6fe0ff', '#3a8ab8'], talker_3: ['#ffe0c8', '#f2c14e'] }
      : { shopkeeper: ['#e8c8a8', '#6b4a2e'], ferryman: ['#e8c8a8', '#2a3a5a'], talker_1: ['#e8c8a8', '#7a5a3a'], talker_2: ['#e8c8a8', '#4a6a8a'], talker_3: ['#e8c8a8', '#b84a4a'] };
  const [skin, cloth] = look[id] ?? look.talker_1 ?? ['#ddd', '#555'];
  g.add(mesh(unitCyl(), toon(cloth), [0, 0.55, 0], [0.32, 1.1, 0.28]), ball(skin, [0, 1.3, 0], [0.3, 0.28, 0.28]));
  g.add(ball('#ffffff', [-0.1, 1.36, 0.24], 0.07), ball('#ffffff', [0.1, 1.36, 0.24], 0.07), ball('#111', [-0.1, 1.36, 0.3], 0.035), ball('#111', [0.1, 1.36, 0.3], 0.035));
  if (id === 'shopkeeper') g.add(mesh(unitTorus(), toon('#222'), [-0.1, 1.36, 0.28], 0.08), mesh(unitTorus(), toon('#222'), [0.1, 1.36, 0.28], 0.08));
  if (id === 'ferryman') g.add(cyl('#1a2a4a', [0, 1.58, 0], 0.22, 0.12), cyl('#1a2a4a', [0, 1.52, 0.08], 0.28, 0.03));
  if (t === 'l' && id === 'shopkeeper') g.add(mesh(unitTorus(), toon('#f2c14e', { emissive: '#ffd84a', ei: 1 }), [0, 1.72, 0], [0.18, 0.18, 0.18], [Math.PI / 2, 0, 0]));
  const tag = labelSprite(name, { height: 0.2, fg: '#ffe9a8' });
  tag.position.set(0, 1.95, 0);
  g.add(tag);
  outline(g, 0.0018);
  return g;
}

/** Tombstone (ASSET_SPEC §2.3), origin at the bottom, the engraving facing +Z. */
export function buildTombstone(theme: string, name: string, cause: string, epitaph: string): THREE.Group {
  const t = TH(theme);
  const g = new THREE.Group();
  const stone = t === 'l' ? '#eef1f6' : t === 'b' ? '#6b7a66' : '#8a8378';
  g.add(box(stone, [0, 0.45, 0], [0.6, 0.9, 0.18]), mesh(unitCyl(24), toon(stone), [0, 0.9, 0], [0.3, 0.18, 0.3], [Math.PI / 2, 0, 0]));
  g.add(box(t === 'b' ? '#4a5a3a' : '#bfc8d8', [0, 0.04, 0.05], [0.8, 0.08, 0.5]));
  const tex = textTexture([`HERE LIES`, name.toUpperCase().slice(0, 18), `died of ${cause}`.slice(0, 28), `"${epitaph.slice(0, 30)}"`], { w: 512, h: 512, fg: t === 'l' ? '#5a6a8a' : '#20281c', size: 46 });
  const p = new THREE.Mesh(new THREE.PlaneGeometry(0.52, 0.52), new THREE.MeshBasicMaterial({ map: tex, transparent: true }));
  p.position.set(0, 0.55, 0.095);
  g.add(p);
  if (t === 'b') g.add(ball('#6fae3a', [0.22, 0.95, 0.05], 0.07));
  if (t === 'l') g.add(mesh(unitTorus(), toon('#f2c14e', { emissive: '#ffd84a', ei: 0.8 }), [0, 1.2, 0], [0.14, 0.14, 0.14], [Math.PI / 2, 0, 0]));
  outline(g, 0.0018);
  return g;
}

// ---------------------------------------------------------------- scenery (decor kinds from levels.ts + road scatter)
export function buildDecor(kind: string, theme: string, s = 1, color?: string): THREE.Object3D {
  const g = new THREE.Group();
  switch (kind) {
    case 'cypress': g.add(cyl('#5a4636', [0, 1.5 * s, 0], 0.25 * s, 3 * s), cone('#3f6a3a', [0, 3.6 * s, 0], 1.2 * s, 3 * s), cone('#4f7a3a', [0, 5 * s, 0], 0.8 * s, 2 * s)); for (let i = 0; i < 3; i++) g.add(cone('#8aa87a', [(i - 1) * 0.6 * s, 2.6 * s, 0.5 * s], 0.12 * s, 0.9 * s, [Math.PI, 0, 0])); break;
    case 'reeds': for (let i = 0; i < 7; i++) { const a = i * 2.3; g.add(cyl('#6a8a3a', [Math.cos(a) * 0.3 * s, 0.7 * s, Math.sin(a) * 0.3 * s], 0.025 * s, 1.4 * s), ball('#5a3a22', [Math.cos(a) * 0.3 * s, 1.4 * s, Math.sin(a) * 0.3 * s], [0.05 * s, 0.16 * s, 0.05 * s])); } break;
    case 'lilypad': g.add(cyl('#4f9a3a', [0, 0.03, 0], 0.9 * s, 0.05)); if (s > 1) g.add(ball('#ff8ad8', [0.2, 0.15, 0.1], 0.14)); break;
    case 'mushroom': g.add(cyl('#f4ecd8', [0, 0.4 * s, 0], 0.12 * s, 0.8 * s), ball('#d84ab0', [0, 0.85 * s, 0], [0.5 * s, 0.25 * s, 0.5 * s]), ball('#ffffff', [0.2 * s, 1.0 * s, 0.1 * s], 0.07 * s), ball('#ffffff', [-0.15 * s, 0.98 * s, -0.2 * s], 0.06 * s)); break;
    case 'stump': g.add(cyl('#6b4a2e', [0, 0.3 * s, 0], 0.4 * s, 0.6 * s)); break;
    case 'firefly': { const f = ball('#d8ff5a', [0, 1.2 * s, 0], 0.06, { emissive: '#d8ff5a', ei: 3 }); f.userData.bob = 1; g.add(f); break; }
    case 'cloudpuff': for (let i = 0; i < 5; i++) g.add(ball('#ffffff', [(i - 2) * 0.5 * s, (0.4 + (i % 2) * 0.25) * s, ((i * 7) % 3 - 1) * 0.3 * s], (0.5 + (i % 3) * 0.15) * s)); break;
    case 'crystal': g.add(mesh(unitOcta(), toon('#7fd3ff', { emissive: '#4fb8ff', ei: 1.2 }), [0, 0.8 * s, 0], [0.35 * s, 0.8 * s, 0.35 * s])); break;
    case 'shrine': for (const x of [-0.6, 0.6]) g.add(cyl('#ffffff', [x * s, 0.8 * s, 0], 0.1 * s, 1.6 * s)); g.add(box('#f2c14e', [0, 1.7 * s, 0], [1.6 * s, 0.15 * s, 0.5 * s]), box('#f2c14e', [0, 1.9 * s, 0], [1.2 * s, 0.1 * s, 0.4 * s])); break;
    case 'flowertree': g.add(cyl('#b88a6a', [0, 1 * s, 0], 0.15 * s, 2 * s), ball('#ffc0dc', [0, 2.4 * s, 0], 1 * s), ball('#ffd6e8', [0.5 * s, 2.2 * s, 0.3 * s], 0.6 * s)); break;
    case 'featherpost': g.add(cyl('#fbf8f1', [0, 0.8 * s, 0], 0.06 * s, 1.6 * s), mesh(unitSphere(10), toon('#f2c14e'), [0, 1.8 * s, 0], [0.08 * s, 0.4 * s, 0.03 * s], [0, 0, 0.4])); break;
    case 'star': { const st = mesh(unitOcta(), toon('#fff3a0', { emissive: '#ffe070', ei: 2.5 }), [0, 2 * s, 0], 0.15 * s); st.userData.bob = 1; g.add(st); break; }
    case 'pine': g.add(cyl('#5a4636', [0, 0.8 * s, 0], 0.18 * s, 1.6 * s), cone('#2f5a3a', [0, 2.4 * s, 0], 1.1 * s, 2.6 * s), cone('#3a6a44', [0, 3.6 * s, 0], 0.7 * s, 1.8 * s)); break;
    case 'rock': g.add(mesh(unitDodeca(), toon(color ?? '#8a8378', { flat: true }), [0, 0.35 * s, 0], [0.7 * s, 0.45 * s, 0.6 * s])); break;
    case 'bush': g.add(ball(color ?? '#5a8a3a', [0, 0.4 * s, 0], 0.6 * s), ball(color ?? '#6a9a44', [0.4 * s, 0.35 * s, 0.2 * s], 0.45 * s)); break;
    case 'cactus': g.add(cyl('#5a8a4a', [0, 1 * s, 0], 0.22 * s, 2 * s), cyl('#5a8a4a', [0.35 * s, 1.1 * s, 0], 0.14 * s, 0.8 * s)); break;
    case 'grasstuft': for (let i = 0; i < 5; i++) g.add(cone('#8aa84e', [(i - 2) * 0.12 * s, 0.25 * s, ((i * 3) % 5 - 2) * 0.1 * s], 0.05 * s, 0.5 * s)); break;
    case 'tallgrass': {
      // a patch of blades (micro players hide here): s = half-width x, yaw = half-depth z (levels.ts packs them)
      const blades = new THREE.InstancedMesh(unitCone(4), toon(color ?? '#6a9a3a'), 140);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), sc = new THREE.Vector3();
      let r = 7;
      const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
      for (let i = 0; i < 140; i++) { sc.set(0.07, 0.8 + rnd() * 0.8, 0.07); q.setFromEuler(new THREE.Euler((rnd() - 0.5) * 0.4, 0, (rnd() - 0.5) * 0.4)); m.compose(new THREE.Vector3((rnd() - 0.5) * 2, sc.y / 2, (rnd() - 0.5) * 2), q, sc); blades.setMatrixAt(i, m); }
      g.add(blades);
      return g;
    }
    case 'campfire': {
      for (let i = 0; i < 5; i++) g.add(cyl('#5a3a22', [0, 0.12, 0], 0.07, 0.9, [Math.PI / 2, i * 1.25, 0.25]));
      const f = cone('#ff9a3a', [0, 0.45, 0], 0.3, 0.8); (f.material as THREE.MeshToonMaterial) = toon('#ff9a3a', { emissive: '#ff6a1a', ei: 2.5 }) as THREE.MeshToonMaterial; f.userData.flame = 1; g.add(f);
      const f2 = cone('#ffe070', [0, 0.35, 0], 0.16, 0.5); (f2.material as THREE.MeshToonMaterial) = toon('#ffe070', { emissive: '#ffd040', ei: 3 }) as THREE.MeshToonMaterial; f2.userData.flame = 1; g.add(f2);
      const light = new THREE.PointLight('#ff9a4a', 30, 14, 1.6); light.position.y = 1; light.userData.flicker = 1; g.add(light);
      return g;
    }
    case 'sign': {
      const tex = textTexture(theme === 'bayou' ? ['BAYOU', 'GENERAL STORE'] : theme === 'skyisles' ? ['SKY', 'PROVISIONS'] : ['GENERAL', 'STORE'], { w: 512, h: 192, fg: color ?? '#8dff3a', bg: '#101812' });
      const p = new THREE.Mesh(new THREE.PlaneGeometry(3, 1.1), new THREE.MeshBasicMaterial({ map: tex }));
      g.add(p);
      return g;
    }
    case 'signwall': { const p = new THREE.Mesh(new THREE.PlaneGeometry(2, 1), new THREE.MeshBasicMaterial({ map: textTexture(['SIGN HERE'], { w: 256, h: 128, bg: '#f4ecd8', fg: '#5a3a22' }) })); p.position.set(0, 0.8, 3.7); g.add(p); return g; }
    default: g.add(box(color ?? '#999', [0, 0.3, 0], [0.6, 0.6, 0.6]));
  }
  outline(g, 0.0016);
  return g;
}
/** Scenery kinds scattered along the travel road by biome. */
export function roadDecorKinds(theme: string, biome: string): string[] {
  if (theme === 'bayou') return biome === 'hotbox' ? ['mushroom', 'mushroom', 'stump', 'reeds', 'firefly', 'rock'] : biome === 'mudflats' ? ['reeds', 'stump', 'lilypad', 'rock', 'reeds'] : ['cypress', 'reeds', 'lilypad', 'mushroom', 'cypress', 'firefly'];
  if (theme === 'skyisles') return biome === 'heights' ? ['crystal', 'star', 'shrine', 'cloudpuff'] : biome === 'cloudsea' ? ['cloudpuff', 'cloudpuff', 'featherpost', 'star'] : ['flowertree', 'cloudpuff', 'shrine', 'featherpost', 'crystal'];
  return biome === 'mountains' ? ['pine', 'rock', 'pine', 'rock'] : biome === 'hills' ? ['pine', 'bush', 'rock', 'grasstuft'] : ['bush', 'grasstuft', 'rock', 'cactus', 'pine'];
}
export { unitBox };
