// Built-in GM embodiments ("a couple options for what represents this character best"): talking objects that need no
// model — a d20 with a face, a living spellbook, a skull lantern, a field radio, a holo orb — and a voice-only glow.
// Each is built from primitives + canvas textures (no downloads), ~1 unit tall, and animated by the speech sample
// (mouth open 0..1), the mood colour, and crit reactions. Room figures (scene.json ttrpg.gmStyles GLBs) and library
// avatars are handled in gmEmbodiment.ts.
import * as THREE from 'three';
import type { GmBuiltin } from '../../../shared/ttrpg/state.ts';

export interface GmFigure {
  root: THREE.Group;
  /** Height of the figure's "face" above its origin (unit figure, before scaling) — cameras aim here. */
  face: number;
  update(dt: number, s: { open: number; speaking: boolean; t: number; excite: number; look: THREE.Vector3 | null; color: THREE.Color }): void;
  dispose(): void;
}

const mats: THREE.Material[] = [];
const std = (color: string | THREE.Color, o: Partial<THREE.MeshStandardMaterialParameters> = {}) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.55, metalness: 0.05, ...o }); mats.push(m); return m; };
const glowMat = (color: string | THREE.Color, opacity = 1) => { const m = new THREE.MeshBasicMaterial({ color, transparent: opacity < 1, opacity, toneMapped: false, depthWrite: opacity >= 1 }); mats.push(m); return m; };

function eyes(parent: THREE.Object3D, y: number, z: number, gap: number, r: number) {
  const white = std('#fbfbf6', { roughness: 0.3 }), pupil = std('#101014', { roughness: 0.2 });
  const out: { eye: THREE.Mesh; pupil: THREE.Mesh; lid: THREE.Mesh }[] = [];
  for (const sx of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.SphereGeometry(r, 20, 14), white);
    e.scale.set(1, 1.15, 0.45); e.position.set(sx * gap, y, z);
    const p = new THREE.Mesh(new THREE.SphereGeometry(r * 0.48, 16, 10), pupil);
    p.position.set(0, 0, r * 0.82); p.scale.set(1, 1, 0.5);
    e.add(p);
    const lid = new THREE.Mesh(new THREE.SphereGeometry(r * 1.05, 20, 10, 0, Math.PI * 2, 0, Math.PI / 2), std('#000000'));
    lid.rotation.x = -Math.PI / 2; lid.scale.set(1, 0.001, 1); lid.position.z = 0.001;
    e.add(lid);
    parent.add(e);
    out.push({ eye: e, pupil: p, lid });
  }
  return out;
}

function blinkAt(t: number) { const c = t % 4.1; return c < 0.12 ? Math.sin((c / 0.12) * Math.PI) : 0; }

/** A cartoon mouth: a dark rounded shape that opens vertically (flat, drawn — never 3D teeth). */
function mouth(parent: THREE.Object3D, y: number, z: number, w: number) {
  const g = new THREE.Group();
  const shape = new THREE.Shape();
  shape.absellipse(0, 0, w / 2, w * 0.22, 0, Math.PI * 2, false, 0);
  const m = new THREE.Mesh(new THREE.ShapeGeometry(shape, 24), glowMat('#2a0d12'));
  const tongue = new THREE.Mesh(new THREE.CircleGeometry(w * 0.2, 16), glowMat('#d9536b'));
  tongue.position.set(0, -w * 0.08, 0.001); tongue.scale.set(1.3, 0.6, 1);
  const teeth = new THREE.Mesh(new THREE.PlaneGeometry(w * 0.62, w * 0.07), glowMat('#fbf7ee'));
  teeth.position.set(0, w * 0.15, 0.002);
  g.add(m, tongue, teeth);
  g.position.set(0, y, z);
  parent.add(g);
  return (open: number) => { g.scale.set(1 - open * 0.15, 0.18 + open * 1.1, 1); teeth.visible = open > 0.25; tongue.visible = open > 0.35; };
}

export function buildFigure(kind: GmBuiltin, tint = '#8fd3ff'): GmFigure {
  const root = new THREE.Group();
  root.name = `gm:${kind}`;
  const body = new THREE.Group();
  root.add(body);
  const tintC = new THREE.Color(tint);
  let update: GmFigure['update'];
  let face = 0.55;
  switch (kind) {
    case 'd20': {
      const geo = new THREE.IcosahedronGeometry(0.36, 0);
      const mat = std(tintC.clone().multiplyScalar(0.85), { flatShading: true, roughness: 0.35, metalness: 0.1, emissive: tintC.clone().multiplyScalar(0.15) });
      const die = new THREE.Mesh(geo, mat);
      const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geo), new THREE.LineBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0.55 }));
      die.add(edges);
      die.position.y = 0.5; body.add(die);
      const faceG = new THREE.Group(); faceG.position.set(0, 0.5, 0.29); body.add(faceG);
      const E = eyes(faceG, 0.06, 0.02, 0.1, 0.055);
      const setMouth = mouth(faceG, -0.08, 0.035, 0.14);
      // little "20" on the forehead
      const c = document.createElement('canvas'); c.width = 128; c.height = 64;
      const x = c.getContext('2d')!; x.font = '900 52px system-ui'; x.fillStyle = '#ffffff'; x.textAlign = 'center'; x.textBaseline = 'middle'; x.fillText('20', 64, 34);
      const tag = new THREE.Mesh(new THREE.PlaneGeometry(0.1, 0.05), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, toneMapped: false }));
      tag.position.set(0, 0.17, 0.03); faceG.add(tag);
      face = 0.5;
      let spin = 0;
      update = (dt, s) => {
        body.position.y = Math.sin(s.t * 1.6) * 0.03;
        spin += dt * (0.15 + s.excite * 6);
        die.rotation.set(Math.sin(s.t * 0.7) * 0.08 + (s.speaking ? Math.sin(s.t * 9) * 0.04 : 0), Math.sin(s.t * 0.5) * 0.18 + (s.excite > 0.01 ? spin : 0), Math.sin(s.t * 0.9) * 0.05);
        faceG.rotation.copy(die.rotation);
        faceG.position.set(0, 0.5, 0).add(new THREE.Vector3(0, 0, 0.29).applyEuler(die.rotation));
        setMouth(s.open);
        const b = blinkAt(s.t);
        for (const e of E) { e.lid.scale.y = b; e.eye.scale.y = 1.15 * (1 - b * 0.8); if (s.look) { const l = s.look.clone(); e.pupil.position.x = THREE.MathUtils.clamp(l.x, -1, 1) * 0.02; e.pupil.position.y = THREE.MathUtils.clamp(l.y, -1, 1) * 0.015; } }
        mat.emissive.copy(s.color).multiplyScalar(0.12 + s.open * 0.35 + s.excite * 0.6);
      };
      break;
    }
    case 'tome': {
      // a living spellbook lying on the air, fore-edge towards the players: the top cover lifts like a jaw and the
      // pages glow when it talks; two eyes peek over the cover's front edge
      const cover = std('#5b2a1a', { roughness: 0.7 }), gold = std('#d6a84a', { metalness: 0.7, roughness: 0.3 }), page = std('#f3e7c9', { roughness: 0.9 });
      const book = new THREE.Group(); book.position.y = 0.42; book.rotation.x = 0.55; book.scale.setScalar(1.7); body.add(book);
      const spine = new THREE.Mesh(new THREE.BoxGeometry(0.44, 0.08, 0.035), cover); spine.position.set(0, 0, -0.16); book.add(spine);
      const pages = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.05, 0.29), page); book.add(pages);
      const bottom = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.018, 0.33), cover); bottom.position.set(0, -0.034, 0); book.add(bottom);
      const hinge = new THREE.Group(); hinge.position.set(0, 0.034, -0.16); book.add(hinge);
      const top = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.018, 0.33), cover); top.position.set(0, 0, 0.16); hinge.add(top);
      const orn = new THREE.Mesh(new THREE.TorusGeometry(0.07, 0.009, 8, 28), gold); orn.rotation.x = Math.PI / 2; orn.position.set(0, 0.011, 0.14); hinge.add(orn);
      const gem = new THREE.Mesh(new THREE.SphereGeometry(0.022, 16, 10), glowMat(tintC)); gem.position.set(0, 0.015, 0.14); hinge.add(gem);
      const glow = new THREE.Mesh(new THREE.PlaneGeometry(0.38, 0.06), glowMat(tintC, 0.0)); glow.position.set(0, 0.012, 0.15); book.add(glow);
      const E = eyes(hinge, 0.035, 0.29, 0.1, 0.035);
      face = 0.45;
      update = (dt, s) => {
        body.position.y = Math.sin(s.t * 1.3) * 0.035;
        hinge.rotation.x = -(0.05 + s.open * 0.5 + s.excite * 0.35);
        (glow.material as THREE.MeshBasicMaterial).opacity = Math.min(0.9, s.open * 1.3 + s.excite);
        (glow.material as THREE.MeshBasicMaterial).color.copy(s.color);
        glow.scale.y = 0.4 + s.open * 2.2;
        (gem.material as THREE.MeshBasicMaterial).color.copy(s.color).multiplyScalar(0.6 + s.open);
        book.rotation.z = Math.sin(s.t * 0.8) * 0.06 + (s.speaking ? Math.sin(s.t * 7) * 0.03 : 0);
        const b = blinkAt(s.t + 1.3); for (const e of E) { e.lid.scale.y = b; e.eye.scale.y = 1.15 * (1 - b * 0.8); }
      };
      break;
    }
    case 'skull': {
      const bone = std('#e8dcc2', { roughness: 0.8 }), dark = glowMat('#120a08');
      const head = new THREE.Group(); head.position.y = 0.5; body.add(head);
      const cran = new THREE.Mesh(new THREE.SphereGeometry(0.2, 28, 20), bone); cran.scale.set(1, 1.05, 1.1); head.add(cran);
      const cheek = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.1, 0.2), bone); cheek.position.set(0, -0.12, 0.05); head.add(cheek);
      const sockets: THREE.Mesh[] = [];
      for (const sx of [-1, 1]) {
        const s = new THREE.Mesh(new THREE.CircleGeometry(0.055, 20), dark); s.position.set(sx * 0.075, -0.02, 0.2); s.scale.y = 1.15; head.add(s);
        const ember = new THREE.Mesh(new THREE.SphereGeometry(0.022, 12, 8), glowMat('#ff8a2a')); ember.position.set(sx * 0.075, -0.02, 0.19); head.add(ember); sockets.push(ember);
      }
      const nose = new THREE.Mesh(new THREE.CircleGeometry(0.025, 3), dark); nose.position.set(0, -0.1, 0.215); nose.rotation.z = Math.PI; head.add(nose);
      const jawP = new THREE.Group(); jawP.position.set(0, -0.14, -0.04); head.add(jawP);
      const jaw = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.06, 0.2), bone); jaw.position.set(0, -0.04, 0.1); jawP.add(jaw);
      const c = document.createElement('canvas'); c.width = 256; c.height = 48;
      const x = c.getContext('2d')!; x.fillStyle = '#f4ecd8'; x.fillRect(0, 0, 256, 48); x.strokeStyle = '#6b5a45'; x.lineWidth = 4; for (let i = 1; i < 8; i++) { x.beginPath(); x.moveTo(i * 32, 0); x.lineTo(i * 32, 48); x.stroke(); }
      const teethTex = new THREE.CanvasTexture(c); teethTex.colorSpace = THREE.SRGBColorSpace;
      const upper = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.035), new THREE.MeshBasicMaterial({ map: teethTex })); upper.position.set(0, -0.155, 0.152); head.add(upper);
      const lower = new THREE.Mesh(new THREE.PlaneGeometry(0.15, 0.03), new THREE.MeshBasicMaterial({ map: teethTex })); lower.position.set(0, -0.005, 0.201); jawP.add(lower);
      // lantern chain + ring
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.05, 0.008, 8, 20), std('#6b5b45', { metalness: 0.8, roughness: 0.4 })); ring.position.y = 0.26; head.add(ring);
      const light = new THREE.PointLight('#ff8a2a', 0.0, 0.8, 2); light.position.set(0, 0.05, 0.9); head.add(light);
      face = 0.5;
      update = (dt, s) => {
        body.position.y = Math.sin(s.t * 1.1) * 0.025;
        jawP.rotation.x = s.open * 0.45 + s.excite * 0.3;
        head.rotation.set(-0.05 + (s.speaking ? Math.sin(s.t * 6) * 0.03 : 0), Math.sin(s.t * 0.4) * 0.2, Math.sin(s.t * 0.6) * 0.04);
        const glow = 0.45 + s.open * 0.55 + s.excite * 0.6;
        for (const e of sockets) { (e.material as THREE.MeshBasicMaterial).color.copy(s.color).lerp(new THREE.Color('#ff8a2a'), 0.5).multiplyScalar(glow); e.scale.setScalar(0.8 + s.open * 0.5); }
        light.intensity = 0.03 + s.open * 0.12 + s.excite * 0.4;
      };
      break;
    }
    case 'radio': {
      const olive = std('#4f5a34', { roughness: 0.75 }), black = std('#1b1b1b', { roughness: 0.6 }), steel = std('#9aa1a6', { metalness: 0.8, roughness: 0.35 });
      const box = new THREE.Mesh(new THREE.BoxGeometry(0.46, 0.3, 0.2), olive); box.position.y = 0.2; body.add(box);
      const grille = new THREE.Mesh(new THREE.CircleGeometry(0.085, 32), black); grille.position.set(-0.11, 0.2, 0.101); body.add(grille);
      const cone = new THREE.Mesh(new THREE.CircleGeometry(0.05, 32), glowMat(tintC)); cone.position.set(-0.11, 0.2, 0.103); body.add(cone);
      const dial = new THREE.Mesh(new THREE.PlaneGeometry(0.16, 0.07), glowMat('#f2c14e')); dial.position.set(0.1, 0.25, 0.101); body.add(dial);
      const needle = new THREE.Mesh(new THREE.PlaneGeometry(0.004, 0.06), glowMat('#b0231c')); needle.position.set(0.06, 0.25, 0.103); body.add(needle);
      for (const kx of [0.05, 0.14]) { const k = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.022, 0.03, 16), black); k.rotation.x = Math.PI / 2; k.position.set(kx, 0.13, 0.11); body.add(k); }
      const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.004, 0.006, 0.5, 8), steel); ant.position.set(0.19, 0.6, -0.05); ant.rotation.z = -0.15; body.add(ant);
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), glowMat('#ff3b30')); tip.position.set(0.227, 0.845, -0.05); body.add(tip);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.12, 0.012, 8, 20, Math.PI), black); handle.position.set(0, 0.35, 0); body.add(handle);
      face = 0.22;
      update = (dt, s) => {
        cone.scale.setScalar(0.7 + s.open * 0.55);
        (cone.material as THREE.MeshBasicMaterial).color.copy(s.color).multiplyScalar(0.35 + s.open * 1.1 + s.excite);
        needle.position.x = 0.06 + (Math.sin(s.t * 0.7) * 0.5 + 0.5) * 0.08 + (s.speaking ? Math.sin(s.t * 31) * 0.004 : 0);
        (tip.material as THREE.MeshBasicMaterial).color.setRGB(Math.sin(s.t * 4) > 0.2 || s.speaking ? 1 : 0.15, 0.1, 0.08);
        body.rotation.z = s.speaking ? Math.sin(s.t * 40) * 0.004 * s.open : 0;
        body.position.y = s.excite * Math.abs(Math.sin(s.t * 14)) * 0.03;
      };
      break;
    }
    case 'orb': case 'voice': default: {
      const orb = kind === 'orb';
      const core = new THREE.Mesh(new THREE.SphereGeometry(orb ? 0.16 : 0.1, 32, 24), glowMat(tintC, orb ? 0.85 : 0.9)); core.position.y = 0.5; body.add(core);
      const halo = new THREE.Mesh(new THREE.SphereGeometry(orb ? 0.24 : 0.2, 32, 24), glowMat(tintC, 0.18)); halo.position.y = 0.5; body.add(halo);
      const rings: THREE.Mesh[] = [];
      if (orb) for (let i = 0; i < 3; i++) { const r = new THREE.Mesh(new THREE.TorusGeometry(0.24 + i * 0.05, 0.004, 6, 64), glowMat(tintC, 0.6)); r.position.y = 0.5; r.rotation.set(Math.PI / 2 + i * 0.5, i, 0); body.add(r); rings.push(r); }
      const base = orb ? new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.16, 0.05, 32), std('#20262c', { metalness: 0.7, roughness: 0.3 })) : null;
      if (base) { base.position.y = 0.05; body.add(base); const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.1, 0.38, 24, 1, true), glowMat(tintC, 0.15)); beam.position.y = 0.26; body.add(beam); }
      const light = new THREE.PointLight(tintC, 0.3, 1.5, 2); light.position.y = 0.5; body.add(light);
      face = 0.5;
      update = (dt, s) => {
        const k = 1 + s.open * 0.35 + s.excite * 0.5;
        core.scale.setScalar(k); halo.scale.setScalar(1 + s.open * 0.6 + Math.sin(s.t * 2) * 0.04);
        (core.material as THREE.MeshBasicMaterial).color.copy(s.color).multiplyScalar(0.8 + s.open * 0.6);
        (halo.material as THREE.MeshBasicMaterial).color.copy(s.color);
        rings.forEach((r, i) => { r.rotation.z += dt * (0.4 + i * 0.25) * (1 + s.open * 2 + s.excite * 4); });
        light.color.copy(s.color); light.intensity = 0.2 + s.open * 0.9 + s.excite * 2;
        body.position.y = Math.sin(s.t * 1.4) * 0.02;
      };
    }
  }
  return {
    root, face, update: (dt, s) => update(dt, s),
    dispose: () => root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh) { m.geometry.dispose(); const mm = m.material as THREE.Material | THREE.Material[]; (Array.isArray(mm) ? mm : [mm]).forEach((x) => { (x as THREE.MeshBasicMaterial).map?.dispose(); x.dispose(); }); } }),
  };
}
