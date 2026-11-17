// Engine stand-in for the walking TV (until / unless the tvart GLB is installed — S\tv\CONTRACT.md): a cute TV set on
// little legs with cartoon-glove arms, built in code per skin (80s wood-grain CRT with rabbit ears, 90s grey portable,
// modern flat panel on a stand-body), plus a procedural animator for every contract clip (idle, walk / run, sit,
// talk gestures, wave, laugh, clap, shock, point, shrug, enter hop, exit wave, static glitch, tumble).
//
// Space: metres, root at the floor between the feet, +Z forward, Y up (like every avatar). The screen mesh is named
// TV_SCREEN (UV 0..1 = picture, +V up), so the runtime treats both the same way.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import type { TvSkin } from '../../../shared/tv.ts';
import type { TvAnimator, TvPoseState } from './tvAnim.ts';

export interface TvRig {
  root: THREE.Group;
  hips: THREE.Group;          // pelvis pivot (the legs hang from it; the set sits on it)
  set: THREE.Group;           // the TV set (screen, bezel, knobs, antennas) — pivot at its bottom centre
  screen: THREE.Mesh;
  screenAspect: number;
  legs: { hip: THREE.Group; knee: THREE.Group; foot: THREE.Object3D }[];
  arms: { sh: THREE.Group; el: THREE.Group; hand: THREE.Object3D }[];
  antennas: THREE.Object3D[];
  led: THREE.Mesh;
  plate: THREE.Mesh;          // name plate under the screen
  dims: { w: number; h: number; d: number; hipY: number; leg: number };
}

const toonish = (hex: string, rough = 0.6, metal = 0) => new THREE.MeshStandardMaterial({ color: new THREE.Color(hex), roughness: rough, metalness: metal });

function woodTexture(base: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = base; g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 70; i++) {
    const y = Math.random() * 256, a = 0.05 + Math.random() * 0.12;
    g.strokeStyle = `rgba(40,20,8,${a})`; g.lineWidth = 1 + Math.random() * 2.5;
    g.beginPath();
    for (let x = 0; x <= 256; x += 16) g.lineTo(x, y + Math.sin(x * 0.03 + i) * 4 + Math.sin(x * 0.11 + i * 3) * 1.5);
    g.stroke();
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace; t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

/** Name plate texture (their display name on a little brand badge under the screen). */
export function plateTexture(name: string, accent: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512; c.height = 96;
  const g = c.getContext('2d')!;
  g.fillStyle = '#15171c'; g.fillRect(0, 0, 512, 96);
  g.strokeStyle = accent; g.lineWidth = 6; g.strokeRect(3, 3, 506, 90);
  g.fillStyle = '#f2f2f5';
  let size = 54;
  g.font = `700 ${size}px system-ui, Segoe UI, sans-serif`;
  const txt = (name || 'Guest').slice(0, 24);
  while (g.measureText(txt).width > 470 && size > 20) { size -= 2; g.font = `700 ${size}px system-ui, Segoe UI, sans-serif`; }
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(txt, 256, 50);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** A gently bulged plane for CRT faces (UV 0..1, +V up). */
function screenGeometry(w: number, h: number, bulge: number): THREE.BufferGeometry {
  const g = new THREE.PlaneGeometry(w, h, 16, 12);
  const p = g.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) / (w / 2), y = p.getY(i) / (h / 2);
    p.setZ(i, bulge * (1 - 0.5 * (x * x + y * y)));
  }
  g.computeVertexNormals();
  return g;
}

export function buildGreybox(skin: TvSkin, name: string): TvRig {
  const root = new THREE.Group(); root.name = 'TV_ROOT';
  const hips = new THREE.Group(); hips.name = 'TV_HIPS';
  const set = new THREE.Group(); set.name = 'TV_SET';
  root.add(hips); hips.add(set);
  const shape = skin.shape;
  const leg = shape === 'flat' ? 0.5 : 0.52;
  const hipY = leg + 0.04;
  hips.position.y = hipY;
  const dark = toonish('#24262b', 0.7);
  const glove = toonish('#f4f4f2', 0.8);
  const shoe = toonish(skin.accent, 0.5);
  const bezel = toonish(skin.bezel, 0.45);
  const acc = toonish(skin.accent, 0.4);
  let w: number, h: number, d: number, sw: number, sh: number, sx = 0, sy: number;
  const antennas: THREE.Object3D[] = [];

  if (shape === 'crt' || shape === 'portable') {
    const crt = shape === 'crt';
    w = crt ? 0.66 : 0.56; h = crt ? 0.52 : 0.46; d = crt ? 0.48 : 0.4;
    const bodyMat = crt ? new THREE.MeshStandardMaterial({ map: woodTexture(skin.body), roughness: 0.55 }) : toonish(skin.body, 0.55);
    const body = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 4, 0.05), bodyMat);
    body.position.set(0, h / 2, 0);
    set.add(body);
    // back hump of an old tube set
    const hump = new THREE.Mesh(new RoundedBoxGeometry(w * 0.7, h * 0.75, d * 0.5, 3, 0.06), crt ? bodyMat : toonish(skin.body, 0.6));
    hump.position.set(0, h * 0.48, -d * 0.55);
    set.add(hump);
    // front bezel + screen (CRT: screen left, control column right; portable: centred, speaker below)
    sw = crt ? 0.44 : 0.4; sh = sw * 3 / 4; sx = crt ? -0.06 : 0; sy = crt ? h * 0.52 : h * 0.56;
    const bz = new THREE.Mesh(new RoundedBoxGeometry(sw + 0.06, sh + 0.06, 0.03, 3, 0.02), bezel);
    bz.position.set(sx, sy, d / 2 + 0.005);
    set.add(bz);
    if (crt) {
      const panel = new THREE.Mesh(new RoundedBoxGeometry(0.1, h * 0.8, 0.02, 2, 0.008), bezel);
      panel.position.set(w / 2 - 0.09, h / 2, d / 2 + 0.005);
      set.add(panel);
      for (let i = 0; i < 2; i++) {
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.03, 0.03, 20), acc);
        knob.name = `TV_KNOB_${i + 1}`;
        knob.rotation.x = Math.PI / 2;
        knob.position.set(w / 2 - 0.09, h * (0.7 - i * 0.2), d / 2 + 0.03);
        set.add(knob);
      }
      // rabbit ears
      for (const s of [-1, 1]) {
        const ant = new THREE.Group(); ant.name = s < 0 ? 'TV_ANTENNA_L' : 'TV_ANTENNA_R';
        const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.008, 0.4, 8), toonish('#c9c9c9', 0.3, 0.8));
        rod.position.y = 0.2;
        const tip = new THREE.Mesh(new THREE.SphereGeometry(0.018, 12, 8), acc);
        tip.position.y = 0.41;
        ant.add(rod, tip);
        ant.position.set(s * 0.04, h + 0.02, -d * 0.2);
        ant.rotation.z = -s * 0.45;
        set.add(ant); antennas.push(ant);
      }
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.06, 0.03, 16), dark);
      base.position.set(0, h + 0.015, -d * 0.2);
      set.add(base);
    } else {
      // speaker grille, handle, telescopic antenna
      const grille = new THREE.Mesh(new RoundedBoxGeometry(sw, 0.06, 0.012, 2, 0.005), dark);
      grille.position.set(0, h * 0.12, d / 2 + 0.004);
      set.add(grille);
      const handle = new THREE.Mesh(new THREE.TorusGeometry(0.16, 0.018, 8, 24, Math.PI), dark);
      handle.position.set(0, h, 0);
      set.add(handle);
      const ant = new THREE.Group(); ant.name = 'TV_ANTENNA_R';
      const rod = new THREE.Mesh(new THREE.CylinderGeometry(0.005, 0.007, 0.36, 8), toonish('#d0d0d0', 0.3, 0.8));
      rod.position.y = 0.18;
      const tip = new THREE.Mesh(new THREE.SphereGeometry(0.014, 10, 8), acc);
      tip.position.y = 0.37;
      ant.add(rod, tip);
      ant.position.set(w / 2 - 0.06, h - 0.02, -d * 0.2);
      ant.rotation.z = -0.55;
      set.add(ant); antennas.push(ant);
    }
  } else {
    // flat panel on a little stand-body (the legs + arms belong to the stand-body)
    w = 0.8; h = 0.47; d = 0.07;
    const torso = new THREE.Mesh(new RoundedBoxGeometry(0.32, 0.22, 0.2, 3, 0.05), toonish(skin.body, 0.5));
    torso.position.set(0, 0.11, 0);
    set.add(torso);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.035, 0.12, 12), dark);
    neck.position.set(0, 0.26, -0.02);
    set.add(neck);
    const panel = new THREE.Mesh(new RoundedBoxGeometry(w, h, d, 3, 0.015), bezel);
    panel.position.set(0, 0.3 + h / 2, 0);
    set.add(panel);
    const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.5, 0.006, 0.01), new THREE.MeshBasicMaterial({ color: new THREE.Color(skin.accent), toneMapped: false }));
    strip.position.set(0, 0.3 + 0.012, d / 2 + 0.002);
    set.add(strip);
    sw = w - 0.04; sh = sw * 9 / 16; sy = 0.3 + h / 2 + 0.005;
    h = 0.3 + h;     // overall set height
    d = 0.2;
  }

  const screen = new THREE.Mesh(screenGeometry(sw, sh, shape === 'flat' ? 0 : 0.018), new THREE.MeshBasicMaterial({ color: 0x0a0c10 }));
  screen.name = 'TV_SCREEN';
  screen.position.set(sx, sy, (shape === 'flat' ? 0.035 : d / 2) + 0.022);
  set.add(screen);

  // on-air LED + name plate
  const led = new THREE.Mesh(new THREE.SphereGeometry(0.012, 10, 8), new THREE.MeshBasicMaterial({ color: 0x33ff66, toneMapped: false }));
  led.name = 'TV_LED';
  const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.2, 0.0375), new THREE.MeshBasicMaterial({ map: plateTexture(name, skin.accent), toneMapped: false }));
  plate.name = 'TV_NAME';
  if (shape === 'flat') { led.position.set(w / 2 - 0.05, 0.315, 0.04); plate.position.set(0, 0.11, 0.101); }
  else if (shape === 'crt') { led.position.set(w / 2 - 0.09, h * 0.25, d / 2 + 0.02); plate.position.set(sx, sy - sh / 2 - 0.045, d / 2 + 0.021); plate.scale.setScalar(0.9); }
  else { led.position.set(sw / 2 - 0.02, h * 0.12, d / 2 + 0.012); plate.position.set(0, sy - sh / 2 - 0.042, d / 2 + 0.021); plate.scale.setScalar(0.8); }
  set.add(led, plate);

  // legs (hang from the hips) + shoes
  const legs: TvRig['legs'] = [];
  for (const s of [-1, 1]) {
    const hip = new THREE.Group(); hip.position.set(s * 0.11, 0, 0);
    const thigh = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.03, leg / 2, 10), dark);
    thigh.position.y = -leg / 4;
    const knee = new THREE.Group(); knee.position.y = -leg / 2;
    const shin = new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.028, leg / 2, 10), dark);
    shin.position.y = -leg / 4;
    const foot = new THREE.Mesh(new RoundedBoxGeometry(0.1, 0.06, 0.17, 3, 0.025), shoe);
    foot.position.set(0, -leg / 2 - 0.01, 0.03);
    knee.add(shin, foot);
    hip.add(thigh, knee);
    hips.add(hip);
    legs.push({ hip, knee, foot });
  }
  // arms (from the set's sides) + glove hands
  const arms: TvRig['arms'] = [];
  const shY = shape === 'flat' ? 0.14 : h * 0.45;
  const shX = shape === 'flat' ? 0.16 : w / 2;
  for (const s of [-1, 1]) {
    const sh0 = new THREE.Group(); sh0.position.set(s * (shX + 0.01), shY, 0);
    const up = new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.02, 0.2, 8), dark);
    up.position.y = -0.1;
    const el = new THREE.Group(); el.position.y = -0.2;
    const fo = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.018, 0.18, 8), dark);
    fo.position.y = -0.09;
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.045, 14, 10), glove);
    hand.scale.set(1, 1.1, 0.8);
    hand.position.y = -0.2;
    el.add(fo, hand);
    sh0.add(up, el);
    sh0.rotation.z = s * 0.22;   // arms slightly out
    set.add(sh0);
    arms.push({ sh: sh0, el, hand });
  }
  root.traverse((o) => { if ((o as THREE.Mesh).isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  screen.castShadow = false;
  return { root, hips, set, screen, screenAspect: sw / sh, legs, arms, antennas, led, plate, dims: { w, h, d, hipY, leg } };
}

// ---------------------------------------------------------------- procedural animator
const TAU = Math.PI * 2;
const sm = (x: number) => { const k = Math.min(1, Math.max(0, x)); return k * k * (3 - 2 * k); };

export class ProceduralTvAnimator implements TvAnimator {
  private t = Math.random() * 10;
  private ant = { a: 0, v: 0 };
  private lastBodyY = 0;
  constructor(private rig: TvRig) {}

  update(dt: number, s: TvPoseState) {
    this.t += dt;
    const R = this.rig, t = this.t;
    const g = Math.min(1, s.gait);
    const sit = sm(s.sit);
    const phase = s.stride * TAU;
    const talk = s.talk;
    // ---- reset
    R.set.position.set(0, 0, 0); R.set.rotation.set(0, 0, 0); R.set.scale.set(1, 1, 1);
    R.hips.rotation.set(0, 0, 0);
    R.hips.position.set(0, R.dims.hipY, 0);
    // ---- legs: walk swing / sit fold
    R.legs.forEach((L, i) => {
      const side = i === 0 ? 1 : -1;
      const sw = Math.sin(phase + (i ? Math.PI : 0));
      const walkHip = -0.55 * g * sw;
      const walkKnee = 0.75 * g * Math.max(0, Math.sin(phase + (i ? Math.PI : 0) + 1.2));
      // seated: thighs forward (−X rotation lifts the leg to the front), shins down
      L.hip.rotation.set(walkHip * (1 - sit) - 1.5 * sit, 0, 0.04 * side * sit);
      L.knee.rotation.set(walkKnee * (1 - sit) + 1.45 * sit, 0, 0);
    });
    // ---- body: step bob, sway; seated: the set sits on the seat (hips drop to the root)
    const L = s.lively ? 1 : 0;                            // calm (default): a fraction of the lively amplitudes
    const bob = g * (L ? 0.03 : 0.011) * Math.abs(Math.cos(phase)) + (1 - g) * (L ? 0.006 : 0.0015) * Math.sin(t * 1.7) * (1 - sit);
    const roll = g * (L ? 0.05 : 0.018) * Math.sin(phase) + (1 - g) * (L ? 0.015 : 0.004) * Math.sin(t * 0.9 + 1);
    R.hips.position.y = R.dims.hipY * (1 - sit) + bob + sit * 0.03;
    R.hips.position.z = -0.08 * sit;
    R.set.rotation.z = roll;
    R.set.rotation.x = 0.06 * g + (s.run ? 0.05 : 0);
    // ---- talk: a little bounce on the syllables, lean in
    const tk = talk * (L ? 1 : 0.35);
    R.set.position.y += tk * 0.012 * Math.max(0, Math.sin(t * 13));
    R.set.rotation.x += tk * 0.03 * Math.sin(t * 5.3);
    R.set.rotation.y = tk * 0.05 * Math.sin(t * 2.1) + (1 - g) * (L ? 0.03 : 0.008) * Math.sin(t * 0.37);
    // ---- arms: counter swing / idle hang / talk gestures
    R.arms.forEach((A, i) => {
      const side = i === 0 ? 1 : -1;
      const sw = Math.sin(phase + (i ? 0 : Math.PI));
      A.sh.rotation.set(-(L ? 0.6 : 0.35) * g * sw - tk * (i === 1 ? 0.9 + 0.35 * Math.sin(t * 6) : 0.3 + 0.2 * Math.sin(t * 4.5 + 1)), 0, side * (0.22 + (L ? 0.05 : 0.012) * Math.sin(t * 1.3 + i)));
      A.el.rotation.set(-0.4 * g - tk * (i === 1 ? 0.9 : 0.4) - 0.15 - sit * 0.6, 0, 0);
    });
    // ---- one-shots (blended over the base pose)
    if (s.shot) this.oneShot(s.shot.name, s.shot.t, s.shot.w);
    if (s.airborne) { R.hips.position.y += 0.08; R.legs.forEach((L) => { L.hip.rotation.x = -0.5; L.knee.rotation.x = 0.9; }); }
    // ---- antennas: spring wobble driven by the body's vertical motion
    const by = R.hips.position.y + R.set.position.y;
    const acc = (by - this.lastBodyY) / Math.max(dt, 1e-3);
    this.lastBodyY = by;
    // calm: a stiff, well-damped spring that barely reacts (lively: the old floppy one)
    if (L) this.ant.v += (-this.ant.a * 90 - this.ant.v * 6 - acc * 6) * dt;
    else this.ant.v += (-this.ant.a * 160 - this.ant.v * 22 - acc * 1.2) * dt;
    const lim = L ? 0.5 : 0.12;
    this.ant.a = Math.max(-lim, Math.min(lim, this.ant.a + this.ant.v * dt));
    R.antennas.forEach((a, i) => { a.rotation.x = this.ant.a * (i ? 1 : 0.8); });
  }

  private oneShot(name: string, t: number, w: number) {
    const R = this.rig;
    const [L, Rt] = R.arms;          // L = avatar-left (+X), Rt = avatar-right
    const lerpX = (o: THREE.Object3D, v: number) => { o.rotation.x += (v - o.rotation.x) * w; };
    const lerpZ = (o: THREE.Object3D, v: number) => { o.rotation.z += (v - o.rotation.z) * w; };
    switch (name) {
      case 'wave': case 'exit_wave':
        lerpX(Rt.sh, -2.6); lerpZ(Rt.sh, -0.5); lerpX(Rt.el, -0.3); Rt.el.rotation.z += w * 0.5 * Math.sin(t * 16); break;
      case 'laugh':
        R.set.rotation.x -= w * 0.12; R.set.position.y += w * 0.02 * Math.abs(Math.sin(t * 18));
        lerpX(L.sh, -0.7); lerpX(Rt.sh, -0.7); lerpX(L.el, -1.6); lerpX(Rt.el, -1.6); break;
      case 'clap': {
        const c = Math.abs(Math.sin(t * 9));
        lerpX(L.sh, -1.2); lerpX(Rt.sh, -1.2); lerpZ(L.sh, 0.9 - c * 0.35); lerpZ(Rt.sh, -0.9 + c * 0.35); lerpX(L.el, -0.6); lerpX(Rt.el, -0.6); break;
      }
      case 'react_shock':
        R.set.rotation.x -= w * 0.2; R.hips.position.z -= w * 0.05; R.set.position.y += w * 0.03;
        lerpX(L.sh, -2.5); lerpX(Rt.sh, -2.5); lerpZ(L.sh, 0.6); lerpZ(Rt.sh, -0.6); break;
      case 'point':
        lerpX(Rt.sh, -1.5); lerpZ(Rt.sh, -0.1); lerpX(Rt.el, 0); break;
      case 'shrug':
        R.set.position.y += w * 0.02; lerpX(L.sh, -0.3); lerpX(Rt.sh, -0.3); lerpZ(L.sh, 1.1); lerpZ(Rt.sh, -1.1); lerpX(L.el, -1.3); lerpX(Rt.el, -1.3); break;
      case 'enter_hop': {
        const k = Math.sin(Math.min(1, t / 0.6) * Math.PI);
        R.hips.position.y += w * 0.18 * k; R.set.scale.set(1 - 0.06 * k * w, 1 + 0.1 * k * w, 1 - 0.06 * k * w);
        lerpX(L.sh, -2.2); lerpX(Rt.sh, -2.2); break;
      }
      case 'static_glitch':
        R.set.position.x += w * 0.012 * Math.sin(t * 73); R.set.rotation.z += w * 0.05 * Math.sin(t * 51); break;
      case 'tumble': {
        const f = t < 0.5 ? sm(t / 0.5) : t < 1.4 ? 1 : 1 - sm((t - 1.4) / 0.8);
        R.hips.rotation.x = -1.35 * f * w; R.hips.position.y = R.hips.position.y * (1 - 0.7 * f * w); R.hips.position.z -= 0.2 * f * w;
        lerpX(L.sh, -2.8 * f); lerpX(Rt.sh, -2.8 * f); break;
      }
    }
  }

  dispose() { /* geometry is disposed with the model */ }
}
