// Procedural drink props in the avatars' toon / cel style: low-poly lathe shapes, flat colour blocks,
// 3-band toon ramp + inverted-hull outlines (same outline shader as the avatars). Built in "prop units":
// origin = the prop's centre, +Y = its axis (bottom → top), 1 unit ≈ a cup's height, +X = the side the
// fingers point to (mug handle), +Z = the outward face (logos / labels).

import * as THREE from 'three';
import type { SnackProp } from '../../shared/types.ts';
import { makeOutline, outlineMaterial } from './toon.ts';
import { markShared } from './gpuDispose.ts';

let ramp: THREE.DataTexture | null = null;
function toonRamp() {
  if (ramp) return ramp;
  // same 3-band cel ramp family as the avatars (shadow, mid, lit)
  const d = new Uint8Array([150, 150, 150, 255, 215, 215, 215, 255, 255, 255, 255, 255]);
  ramp = markShared(new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat));   // every prop's: outlives each avatar
  ramp.minFilter = ramp.magFilter = THREE.NearestFilter;
  ramp.needsUpdate = true;
  return ramp;
}

export interface BuiltProp {
  root: THREE.Group;
  /** Outline hulls (need the viewport aspect every frame). */
  outlines: THREE.Mesh[];
  /** Top rim radius and half height (prop units) — for placing the rim at the lips. */
  rimR: number;
  halfH: number;
  /** Body radius at the grip (prop units): the hand wraps around this. */
  gripR: number;
  dispose(): void;
}

const SEG = 16;

function lathe(profile: [number, number][], seg = SEG) {
  const g = new THREE.LatheGeometry(profile.map(([r, y]) => new THREE.Vector2(Math.max(0.0001, r), y)), seg);
  g.computeVertexNormals();
  return g;
}

/** A thin band around a lathe body between heights y0..y1 at radii r0 (bottom) .. r1 (top). */
function band(r0: number, r1: number, y0: number, y1: number, seg = SEG) {
  const g = new THREE.CylinderGeometry(r1, r0, y1 - y0, seg, 1, true);
  g.translate(0, (y0 + y1) / 2, 0);
  return g;
}

export function buildProp(kind: SnackProp): BuiltProp {
  const root = new THREE.Group();
  root.name = `vtp_prop_${kind}`;
  const mats: THREE.Material[] = [];
  const geos: THREE.BufferGeometry[] = [];
  const parts: { mesh: THREE.Mesh; outline: boolean }[] = [];
  const mat = (color: THREE.ColorRepresentation, o: Partial<THREE.MeshToonMaterialParameters> = {}) => {
    const m = new THREE.MeshToonMaterial({ color, gradientMap: toonRamp(), ...o });
    mats.push(m);
    return m;
  };
  const add = (g: THREE.BufferGeometry, m: THREE.Material, outline = true, name = '') => {
    geos.push(g);
    const mesh = new THREE.Mesh(g, m);
    mesh.name = name;
    mesh.castShadow = true;
    mesh.userData.vtpNoToon = true;
    root.add(mesh);
    parts.push({ mesh, outline });
    return mesh;
  };

  let rimR = 0.36, halfH = 0.5, gripR = 0.32;
  switch (kind) {
    case 'coffee': {
      // take-away cup: tapered white body, kraft sleeve with a round logo, domed lid with a sip slot
      const cup = mat('#f6f1e7');
      add(lathe([[0, -0.5], [0.27, -0.5], [0.29, -0.46], [0.35, 0.36], [0.36, 0.4]]), cup);
      add(band(0.327, 0.357, -0.2, 0.2), mat('#b8834f'), true, 'sleeve');
      // logo disc on the outward face (+Z)
      const logo = new THREE.CircleGeometry(0.1, 20);
      logo.translate(0, 0.01, 0);
      const lm = add(logo, mat('#2f8f5b'), false, 'logo');
      lm.position.set(0, 0.0, 0.347); lm.rotation.x = -0.07;
      const star = new THREE.CircleGeometry(0.045, 5);
      const sm = add(star, mat('#f6f1e7'), false, 'logoStar');
      sm.position.set(0, 0.002, 0.349); sm.rotation.x = -0.07;
      // lid: rim ring + dome + sip slot (dark)
      add(lathe([[0.0, 0.4], [0.39, 0.4], [0.395, 0.45], [0.36, 0.47], [0.33, 0.5], [0.0, 0.52]]), mat('#ede6da'), true, 'lid');
      const slot = new THREE.CapsuleGeometry(0.028, 0.08, 4, 8);
      slot.rotateZ(Math.PI / 2);
      const sl = add(slot, mat('#3b2a20'), false, 'slot');
      sl.position.set(0, 0.52, 0.2); sl.scale.set(1, 0.4, 1);
      rimR = 0.37; halfH = 0.5; gripR = 0.33;
      break;
    }
    case 'mug': {
      // chunky ceramic mug: thick rim, coffee surface inside, handle on +X
      const body = mat('#e8676f');
      add(lathe([[0, -0.4], [0.4, -0.4], [0.43, -0.36], [0.43, 0.36], [0.4, 0.4], [0.35, 0.38], [0.35, 0.1]]), body);
      add(band(0.436, 0.436, 0.14, 0.22), mat('#fff4e6'), false, 'stripe');
      const coffee = new THREE.CircleGeometry(0.35, SEG);
      coffee.rotateX(-Math.PI / 2);
      const cm = add(coffee, mat('#5a3421'), false, 'coffee');
      cm.position.y = 0.3;
      const foam = new THREE.CircleGeometry(0.13, 12);
      foam.rotateX(-Math.PI / 2);
      const fm = add(foam, mat('#e9d3b4'), false, 'foam');
      fm.position.set(0.05, 0.302, 0.03);
      const handle = new THREE.TorusGeometry(0.2, 0.06, 8, 14, Math.PI * 1.15);
      handle.rotateZ(-Math.PI * 0.575);
      const hm = add(handle, body, true, 'handle');
      hm.position.set(0.43, 0.0, 0);
      rimR = 0.42; halfH = 0.4; gripR = 0.43;
      break;
    }
    case 'can': {
      // soda can: silver tapered ends, red body with a white swoosh band, pull tab on top
      const metal = mat('#c9ced6');
      add(lathe([[0, -0.47], [0.22, -0.47], [0.29, -0.4], [0.3, -0.36]]), metal, true, 'bottom');
      add(band(0.3, 0.3, -0.36, 0.34), mat('#e63946'), true, 'body');
      const sw = band(0.302, 0.302, -0.02, 0.1);
      add(sw, mat('#ffffff'), false, 'swoosh');
      add(band(0.303, 0.303, 0.1, 0.13), mat('#ffd166'), false, 'stripe');
      add(lathe([[0.3, 0.34], [0.25, 0.44], [0.26, 0.47], [0.24, 0.47], [0.22, 0.45], [0, 0.45]]), metal, true, 'top');
      const tab = new THREE.BoxGeometry(0.12, 0.012, 0.06);
      const tm = add(tab, mat('#aab2bd'), false, 'tab');
      tm.position.set(0.04, 0.458, 0);
      rimR = 0.25; halfH = 0.47; gripR = 0.3;
      break;
    }
    case 'bottle': {
      // cola bottle: dark glass body, red label with a white wave, red cap
      const glass = mat('#4a2414', { transparent: true, opacity: 0.92 });
      add(lathe([[0, -0.7], [0.22, -0.7], [0.25, -0.64], [0.26, -0.1], [0.24, 0.1], [0.14, 0.34], [0.1, 0.5], [0.1, 0.58], [0.115, 0.6]]), glass);
      add(band(0.265, 0.265, -0.4, -0.08), mat('#d62828'), false, 'label');
      add(band(0.268, 0.268, -0.27, -0.22), mat('#ffffff'), false, 'wave');
      add(lathe([[0, 0.58], [0.125, 0.58], [0.13, 0.62], [0.125, 0.7], [0, 0.7]], 12), mat('#e63946'), true, 'cap');
      rimR = 0.11; halfH = 0.7; gripR = 0.26;
      break;
    }
    case 'glass': {
      // wine glass: clear bowl (an outline hull would show through it as a dark blob — instead a drawn
      // rim ring + a glint stripe give the toon-glass read), red wine, thin stem, round foot
      const clear = mat('#dff3ff', { transparent: true, opacity: 0.3, depthWrite: false });
      add(lathe([[0, -0.08], [0.2, -0.04], [0.3, 0.12], [0.32, 0.3], [0.29, 0.5]], 20), clear, false, 'bowl');
      add(new THREE.TorusGeometry(0.29, 0.014, 6, 24).rotateX(Math.PI / 2).translate(0, 0.5, 0), mat('#f4fbff'), true, 'rim');
      const glint = new THREE.PlaneGeometry(0.035, 0.28);
      const gm = add(glint, mat('#ffffff', { transparent: true, opacity: 0.75, depthWrite: false }), false, 'glint');
      gm.position.set(-0.13, 0.28, 0.27); gm.rotation.set(0, -0.45, 0.12);
      const wine = lathe([[0, -0.07], [0.19, -0.03], [0.27, 0.1], [0.285, 0.2], [0, 0.2]], 20);
      add(wine, mat('#8e1330'), false, 'wine');
      add(new THREE.CylinderGeometry(0.03, 0.035, 0.46, 8).translate(0, -0.31, 0), clear, false, 'stem');
      add(lathe([[0, -0.54], [0.22, -0.54], [0.2, -0.52], [0.04, -0.49], [0, -0.48]], 20), mat('#e6f5ff'), true, 'foot');
      rimR = 0.29; halfH = 0.54; gripR = 0.04;
      break;
    }
  }
  const outlines: THREE.Mesh[] = [];
  for (const p of parts) {
    if (!p.outline) continue;
    const om = outlineMaterial('#141414', 0.0026, p.mesh.material as THREE.Material);
    mats.push(om);
    const o = makeOutline(p.mesh, om);
    geos.push(o.geometry);
    outlines.push(o);
  }
  return {
    root, outlines, rimR, halfH, gripR,
    dispose() { root.removeFromParent(); for (const g of geos) g.dispose(); for (const m of mats) m.dispose(); },
  };
}
