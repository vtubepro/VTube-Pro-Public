// Interview set pieces, generated per room theme (shared/talkshow.ts SetTheme): the host's talk-show DESK (curved front
// panel with the show's name plate, a desk mic, a mug and cue cards — themed props per room), the guest MONITOR housings
// (a retro TV on a chrome pedestal, a crate-top CRT, a field-radio CRT with an antenna, a hanging menu-board screen)
// and the sidekick's little band stand. All original designs; every material is owned + disposed by the set.
//
// Monitor housings follow the screen-skin contract (src/scene/screenSkins.ts): origin = the centre of the picture
// rectangle, +Z towards the viewer, the picture (W × H) is the only thing the OBS hole cuts, frames stay outside it.
import * as THREE from 'three';
import type { MonitorStyle, SetTheme } from '../../../shared/talkshow.ts';

type Own = <T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T) => T;

export interface ThemeLook {
  top: number; panel: number; trim: number; accent: number;
  /** Front panel pattern: 'wood' | 'metal' | 'stripes' | 'crate' | 'stone' | 'holo' | 'tile' | 'plank'. */
  pattern: string;
  plateBg: string; plateFg: string; font: string;
  /** Desk-top props. */
  props: ('mic' | 'mug' | 'cards' | 'radio' | 'ammo' | 'burger' | 'fries' | 'candle' | 'hourglass' | 'lantern' | 'map' | 'puck' | 'tablet' | 'glass' | 'plant' | 'jar')[];
}

export const THEME_LOOKS: Record<SetTheme, ThemeLook> = {
  studio: { top: 0x2a1c14, panel: 0x6b3a8c, trim: 0xd9b25c, accent: 0x35e3ff, pattern: 'wood', plateBg: '#1b0f24', plateFg: '#ffd35c', font: '900 {s}px Impact, "Arial Black", sans-serif', props: ['mic', 'mug', 'cards', 'plant'] },
  swamp: { top: 0x4a3420, panel: 0x2f5a2c, trim: 0x9ccf5a, accent: 0xff4fd8, pattern: 'plank', plateBg: '#10240f', plateFg: '#b7ff6a', font: '900 {s}px "Segoe Script", "Brush Script MT", cursive', props: ['mic', 'jar', 'cards'] },
  dorms: { top: 0x5a4632, panel: 0x6d6a5c, trim: 0xb89a62, accent: 0xffb347, pattern: 'plank', plateBg: '#2a2418', plateFg: '#ffcf7a', font: '900 {s}px Impact, "Arial Black", sans-serif', props: ['mic', 'mug', 'radio', 'cards'] },
  factory: { top: 0x2b2d30, panel: 0x4b5a3f, trim: 0xe0b400, accent: 0xff9a1f, pattern: 'metal', plateBg: '#111', plateFg: '#ffcc00', font: '900 {s}px Impact, "Arial Black", sans-serif', props: ['mic', 'ammo', 'cards'] },
  labs: { top: 0xe8edf2, panel: 0xf4f6f8, trim: 0x1f8fff, accent: 0x38b6ff, pattern: 'tile', plateBg: '#f5f8fb', plateFg: '#0d6bd6', font: '800 {s}px Inter, "Segoe UI", sans-serif', props: ['mic', 'tablet', 'mug'] },
  camp: { top: 0x5b4a2c, panel: 0x4a4f2c, trim: 0xa3884d, accent: 0xff7a2a, pattern: 'crate', plateBg: '#23260f', plateFg: '#e3d18f', font: '900 {s}px "Stencil", Impact, sans-serif', props: ['mic', 'radio', 'ammo', 'map'] },
  fob: { top: 0x3b3326, panel: 0x6b1f2a, trim: 0xc9a44a, accent: 0xff5a5a, pattern: 'wood', plateBg: '#2a0c10', plateFg: '#f5d27a', font: '900 {s}px Impact, "Arial Black", sans-serif', props: ['mic', 'glass', 'radio', 'map'] },
  bridge: { top: 0x23272e, panel: 0x30343c, trim: 0xf2c200, accent: 0x33d6ff, pattern: 'stripes', plateBg: '#0b0e12', plateFg: '#ffd200', font: '900 {s}px Impact, "Arial Black", sans-serif', props: ['mic', 'puck', 'mug'] },
  epoch: { top: 0x3a3450, panel: 0x514a6e, trim: 0xd8b86a, accent: 0x9d7bff, pattern: 'stone', plateBg: '#1a1530', plateFg: '#e9d49a', font: '700 {s}px "Palatino Linotype", "Book Antiqua", Georgia, serif', props: ['candle', 'hourglass', 'cards'] },
  kitchen: { top: 0xd9d9d9, panel: 0xd61f26, trim: 0xffc72c, accent: 0xffc72c, pattern: 'tile', plateBg: '#c8161d', plateFg: '#ffcf2e', font: '900 {s}px "Arial Rounded MT Bold", "Arial Black", sans-serif', props: ['mic', 'burger', 'fries', 'glass'] },
  harbour: { top: 0x3d2a1a, panel: 0x5a3b22, trim: 0xc8a24e, accent: 0xffb14a, pattern: 'wood', plateBg: '#241709', plateFg: '#f2cf7d', font: '700 {s}px "Palatino Linotype", "Book Antiqua", Georgia, serif', props: ['lantern', 'map', 'candle'] },
  lounge: { top: 0x1c1a24, panel: 0x2a2436, trim: 0xd8a24a, accent: 0xff5ab8, pattern: 'holo', plateBg: '#120f1c', plateFg: '#ffd27a', font: '800 {s}px Inter, "Segoe UI", sans-serif', props: ['mic', 'glass', 'tablet'] },
};

// ---------------------------------------------------------------- helpers
export class PropKit {
  constructor(readonly own: Own) {}
  std(color: number, roughness = 0.6, metalness = 0.1, extra: THREE.MeshStandardMaterialParameters = {}) {
    return this.own(new THREE.MeshStandardMaterial({ color, roughness, metalness, ...extra }));
  }
  basic(map: THREE.Texture | null, color = 0xffffff, extra: THREE.MeshBasicMaterialParameters = {}) {
    return this.own(new THREE.MeshBasicMaterial({ map, color, toneMapped: false, ...extra }));
  }
  tex(w: number, h: number, draw: (g: CanvasRenderingContext2D, w: number, h: number) => void, srgb = true) {
    const c = document.createElement('canvas'); c.width = w; c.height = h;
    draw(c.getContext('2d')!, w, h);
    const t = this.own(new THREE.CanvasTexture(c));
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return t;
  }
  mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0) {
    const o = new THREE.Mesh(this.own(g), m); o.position.set(x, y, z); parent.add(o); return o;
  }
  box(w: number, h: number, d: number, m: THREE.Material, p: THREE.Object3D, x = 0, y = 0, z = 0) { return this.mesh(new THREE.BoxGeometry(w, h, d), m, p, x, y, z); }
  cyl(r0: number, r1: number, h: number, m: THREE.Material, p: THREE.Object3D, x = 0, y = 0, z = 0, seg = 16) { return this.mesh(new THREE.CylinderGeometry(r0, r1, h, seg), m, p, x, y, z); }
  sphere(r: number, m: THREE.Material, p: THREE.Object3D, x = 0, y = 0, z = 0, seg = 16) { return this.mesh(new THREE.SphereGeometry(r, seg, Math.max(6, seg >> 1)), m, p, x, y, z); }
  /** Rounded box: extruded rounded rectangle (w × h, depth d along z), centred. */
  rbox(w: number, h: number, d: number, r: number, m: THREE.Material, p: THREE.Object3D, x = 0, y = 0, z = 0) {
    // (the bevel grows the solid on both faces: extrude less so the TOTAL depth is d, centred on z)
    const bt = Math.min(r, d * 0.2) * 0.5, bs = Math.min(r * 0.6, 0.02);
    const s = roundRect(w - bs * 2, h - bs * 2, Math.max(0.001, r - bs));
    const g = new THREE.ExtrudeGeometry(s, { depth: Math.max(0.002, d - bt * 2), bevelEnabled: true, bevelThickness: bt, bevelSize: bs, bevelSegments: 2, curveSegments: 6 });
    g.translate(0, 0, -(d - bt * 2) / 2);
    return this.mesh(g, m, p, x, y, z);
  }
}

export function roundRect(w: number, h: number, r: number): THREE.Shape {
  const s = new THREE.Shape(), x = -w / 2, y = -h / 2, q = Math.min(r, w / 2, h / 2);
  s.moveTo(x + q, y); s.lineTo(x + w - q, y); s.quadraticCurveTo(x + w, y, x + w, y + q); s.lineTo(x + w, y + h - q);
  s.quadraticCurveTo(x + w, y + h, x + w - q, y + h); s.lineTo(x + q, y + h); s.quadraticCurveTo(x, y + h, x, y + h - q);
  s.lineTo(x, y + q); s.quadraticCurveTo(x, y, x + q, y);
  return s;
}

const hex = (n: number) => `#${n.toString(16).padStart(6, '0')}`;
function shade(n: number, k: number) { const c = new THREE.Color(n); c.multiplyScalar(k); return `#${c.getHexString()}`; }

/** Front-panel pattern (canvas, sRGB): wood grain, brushed metal, hazard stripes, crate slats, stone blocks, tiles… */
function panelTexture(k: PropKit, look: ThemeLook, seed = 5) {
  let r = seed; const rnd = () => { r = (r * 16807) % 2147483647; return r / 2147483647; };
  const base = hex(look.panel), dark = shade(look.panel, 0.7), light = shade(look.panel, 1.25);
  return k.tex(1024, 256, (g, w, h) => {
    g.fillStyle = base; g.fillRect(0, 0, w, h);
    switch (look.pattern) {
      case 'wood': case 'plank': {
        const plank = look.pattern === 'plank' ? 64 : 0;
        for (let i = 0; i < 90; i++) { g.strokeStyle = rnd() < 0.5 ? dark : light; g.globalAlpha = 0.18 + rnd() * 0.25; g.lineWidth = 1 + rnd() * 3; const y = rnd() * h; g.beginPath(); g.moveTo(0, y); g.bezierCurveTo(w * 0.3, y + (rnd() - 0.5) * 18, w * 0.7, y + (rnd() - 0.5) * 18, w, y + (rnd() - 0.5) * 10); g.stroke(); }
        g.globalAlpha = 1;
        if (plank) for (let y = plank; y < h; y += plank) { g.fillStyle = shade(look.panel, 0.45); g.fillRect(0, y - 2, w, 4); }
        break;
      }
      case 'metal': case 'crate': {
        for (let i = 0; i < 260; i++) { g.fillStyle = rnd() < 0.5 ? dark : light; g.globalAlpha = 0.05 + rnd() * 0.08; g.fillRect(rnd() * w, rnd() * h, 60 + rnd() * 200, 1 + rnd() * 2); }
        g.globalAlpha = 1;
        const step = look.pattern === 'crate' ? 128 : 256;
        for (let x = step; x < w; x += step) { g.fillStyle = shade(look.panel, 0.5); g.fillRect(x - 3, 0, 6, h); }
        for (let x = 24; x < w; x += step) for (const y of [20, h - 20]) { g.fillStyle = shade(look.trim, 0.8); g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); }
        if (look.pattern === 'crate') { g.fillStyle = 'rgba(0,0,0,0.35)'; g.font = '700 38px "Stencil", Impact, sans-serif'; g.fillText('7.62×39', w * 0.07, h * 0.55); g.fillText('№ 13', w * 0.8, h * 0.55); }
        break;
      }
      case 'stripes': {
        g.fillStyle = shade(look.panel, 0.9); g.fillRect(0, 0, w, h);
        g.save(); g.beginPath(); g.rect(0, h - 44, w, 44); g.clip();
        for (let x = -60; x < w + 60; x += 56) { g.fillStyle = '#f2c200'; g.beginPath(); g.moveTo(x, h); g.lineTo(x + 28, h); g.lineTo(x + 72, h - 44); g.lineTo(x + 44, h - 44); g.fill(); }
        g.restore();
        for (let x = 80; x < w; x += 160) { g.strokeStyle = 'rgba(255,255,255,0.12)'; g.lineWidth = 3; g.strokeRect(x - 60, 22, 120, 140); }
        break;
      }
      case 'stone': {
        for (let y = 0; y < h; y += 64) for (let x = (y / 64) % 2 ? -60 : 0; x < w; x += 120) {
          g.fillStyle = shade(look.panel, 0.85 + rnd() * 0.3); g.fillRect(x + 3, y + 3, 114, 58);
        }
        break;
      }
      case 'tile': {
        for (let y = 0; y < h; y += 42) for (let x = 0; x < w; x += 42) { g.fillStyle = shade(look.panel, 0.94 + rnd() * 0.08); g.fillRect(x + 2, y + 2, 38, 38); }
        break;
      }
      case 'holo': {
        const gr = g.createLinearGradient(0, 0, w, 0); gr.addColorStop(0, dark); gr.addColorStop(0.5, light); gr.addColorStop(1, dark);
        g.fillStyle = gr; g.fillRect(0, 0, w, h);
        for (let x = 0; x < w; x += 16) { g.fillStyle = 'rgba(255,255,255,0.05)'; g.fillRect(x, 0, 1, h); }
        break;
      }
    }
  });
}

/** The show's name plate (canvas): bevelled plate with the title, theme colours. */
export function namePlate(k: PropKit, look: ThemeLook, title: string) {
  return k.tex(1024, 256, (g, w, h) => {
    const gr = g.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, look.plateBg); gr.addColorStop(1, '#000');
    g.fillStyle = gr; g.fillRect(0, 0, w, h);
    g.strokeStyle = hex(look.trim); g.lineWidth = 14; g.strokeRect(10, 10, w - 20, h - 20);
    g.strokeStyle = 'rgba(255,255,255,0.25)'; g.lineWidth = 3; g.strokeRect(26, 26, w - 52, h - 52);
    let size = 128; const text = title.toUpperCase();
    for (; size > 40; size -= 4) { g.font = look.font.replace('{s}', String(size)); if (g.measureText(text).width < w * 0.84) break; }
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.shadowColor = look.plateFg; g.shadowBlur = 18;
    g.fillStyle = look.plateFg; g.fillText(text, w / 2, h * 0.54);
    g.shadowBlur = 0;
  });
}

// ---------------------------------------------------------------- the desk
export interface BuiltDesk { root: THREE.Group; plate: THREE.Mesh; accent: THREE.MeshStandardMaterial; occluders: THREE.Mesh[]; micHead: THREE.Object3D | null }

/** A talk-show desk: origin = floor centre, +Z = the audience side (the host sits at −Z). */
/** `seats`: desk-local x of each person sitting behind it (the host + co-hosts: a mic in front of each, the other props
 *  in the gaps); missing = one person in the middle (as before). */
/** `size`: a desk shaped for the host (room forms, shared/forms.ts deskSpec): top height + depth (m); missing = 0.76 / 0.64. */
export function buildDesk(k: PropKit, theme: SetTheme, width: number, title: string, seats?: number[], size?: { height?: number; depth?: number }): BuiltDesk {
  const look = THEME_LOOKS[theme] ?? THEME_LOOKS.studio;
  const root = new THREE.Group(); root.name = 'vtp:interview:desk';
  const W = width, D = size?.depth ?? 0.64, H = size?.height ?? 0.76, bow = 0.13;
  // top-view outline: a slab whose front bows out towards the audience
  const outline = new THREE.Shape();
  outline.moveTo(-W / 2, -D / 2); outline.lineTo(W / 2, -D / 2); outline.lineTo(W / 2, D / 2 - 0.02);
  outline.quadraticCurveTo(0, D / 2 + bow * 2, -W / 2, D / 2 - 0.02); outline.lineTo(-W / 2, -D / 2);
  const topMat = k.std(look.top, look.pattern === 'tile' || look.pattern === 'holo' ? 0.25 : 0.45, look.pattern === 'metal' ? 0.5 : 0.08);
  const topG = new THREE.ExtrudeGeometry(outline, { depth: 0.05, bevelEnabled: true, bevelThickness: 0.012, bevelSize: 0.014, bevelSegments: 2, curveSegments: 16 });
  topG.rotateX(-Math.PI / 2);                                        // shape xy → xz (y up), extrude along +y
  const top = k.mesh(topG, topMat, root, 0, H - 0.05, 0);
  top.scale.z = -1;                                                  // shape +y = audience (+Z)
  // front panel: a curved band under the bowed edge
  const pts: THREE.Vector2[] = [];
  const N = 24;
  for (let i = 0; i <= N; i++) {
    const t = i / N, x = -W / 2 + 0.035 + (W - 0.07) * t;
    const u = (x / (W / 2));
    pts.push(new THREE.Vector2(x, D / 2 - 0.05 + bow * (1 - u * u) * 0.92));
  }
  const curve = new THREE.CatmullRomCurve3(pts.map((p) => new THREE.Vector3(p.x, 0, p.y)));
  const frontG = new THREE.BufferGeometry();
  const pos: number[] = [], uv: number[] = [], idx: number[] = [];
  const PH = H - 0.1, M = 64;
  for (let i = 0; i <= M; i++) {
    const p = curve.getPoint(i / M);
    for (const [j, y] of [[0, 0.04], [1, 0.04 + PH]] as const) { pos.push(p.x, y, p.z); uv.push(i / M, j); }
    if (i < M) { const a = i * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
  }
  frontG.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  frontG.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  frontG.setIndex(idx); frontG.computeVertexNormals();
  const panelMat = k.std(0xffffff, 0.55, look.pattern === 'metal' || look.pattern === 'stripes' ? 0.45 : 0.05, { map: panelTexture(k, look), side: THREE.DoubleSide });
  const front = k.mesh(frontG, panelMat, root);
  // sides + a modesty back panel low down (open knee space above)
  const side = k.std(look.panel, 0.5, 0.1, { color: new THREE.Color(look.panel).multiplyScalar(0.8) });
  for (const sx of [-1, 1]) k.box(0.04, PH, D - 0.08, side, root, sx * (W / 2 - 0.04), 0.04 + PH / 2, -0.02);
  k.box(W - 0.1, 0.22, 0.03, side, root, 0, 0.15, -D / 2 + 0.06);
  // kick plate + trim + accent light strip under the top
  const trim = k.std(look.trim, 0.3, 0.75);
  const kick = k.mesh(new THREE.TubeGeometry(curve, 48, 0.022, 6, false), trim, root, 0, 0.045, 0.004);
  kick.scale.set(1.0, 1, 1);
  const accent = k.std(0x111111, 0.4, 0, { emissive: new THREE.Color(look.accent), emissiveIntensity: 1.6 }) as THREE.MeshStandardMaterial;
  k.mesh(new THREE.TubeGeometry(curve, 48, 0.011, 6, false), accent, root, 0, H - 0.085, 0.012);
  // name plate on the front (follows the bow: a gently curved strip)
  const plateW = Math.min(W * 0.62, 0.95), plateH = plateW / 4;
  const pg = new THREE.PlaneGeometry(plateW, plateH, 16, 1);
  const pp = pg.attributes.position as THREE.BufferAttribute;
  for (let i = 0; i < pp.count; i++) { const x = pp.getX(i), u = x / (W / 2); pp.setZ(i, D / 2 - 0.05 + bow * (1 - u * u) * 0.92 + 0.012); }
  pg.computeVertexNormals();
  const plate = k.mesh(pg, k.basic(namePlate(k, look, title), 0xffffff), root, 0, 0.04 + PH * 0.56, 0);
  plate.name = 'vtp:interview:plate';
  // desk-top props (on the audience half, clear of the host's face line)
  let micHead: THREE.Object3D | null = null;
  const y0 = H + 0.005;
  const multi = !!seats && seats.length > 1;
  const sx = multi ? [...seats!].sort((a, b) => a - b) : [];
  // (several people: the props sit in the gaps between them and at the ends, clear of every face line)
  const place = multi
    ? [[sx[0] - 0.38, 0.03], [sx[sx.length - 1] + 0.38, 0.05], ...sx.slice(1).map((x, i) => [(x + sx[i]) / 2, 0.12]), [(sx[0] + sx[1]) / 2, 0.16]].filter(([x]) => Math.abs(x) < W / 2 - 0.12)
    : [[-W * 0.3, 0.02], [W * 0.3, 0.05], [W * 0.14, 0.14], [-W * 0.12, 0.16]];
  let slot = 0;
  for (const p of look.props) {
    if (p === 'mic' && multi) {
      // a mic in front of everyone at the desk
      for (const x of sx) { const g = new THREE.Group(); g.position.set(x + 0.02, y0, -0.02); root.add(g); const m = buildDeskProp(k, p, g, look); if (x === (seats![0] ?? 0)) micHead = m ?? micHead; }
      continue;
    }
    if (!place.length) break;
    const [x, z] = p === 'mic' ? [(seats?.[0] ?? 0) + W * 0.02, -0.02] : place[slot++ % place.length];
    const g = new THREE.Group(); g.position.set(x, y0, z); root.add(g);
    micHead = buildDeskProp(k, p, g, look) ?? micHead;
  }
  const occluders = [top, front];
  root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return { root, plate, accent, occluders, micHead };
}

function buildDeskProp(k: PropKit, p: ThemeLook['props'][number], g: THREE.Group, look: ThemeLook): THREE.Object3D | null {
  const dark = k.std(0x1c1d21, 0.45, 0.6), chrome = k.std(0xc8ccd2, 0.22, 0.95);
  switch (p) {
    case 'mic': {
      // a classic desk mic: heavy round base, gooseneck, capsule angled at the host
      k.cyl(0.075, 0.085, 0.03, dark, g, 0, 0.015, 0, 24);
      const neck = new THREE.CatmullRomCurve3([new THREE.Vector3(0, 0.03, 0), new THREE.Vector3(0, 0.14, -0.01), new THREE.Vector3(0, 0.24, -0.06), new THREE.Vector3(0, 0.29, -0.13)]);
      k.mesh(new THREE.TubeGeometry(neck, 24, 0.008, 6, false), chrome, g);
      const head = new THREE.Group(); head.position.set(0, 0.3, -0.15); head.rotation.x = -0.9; g.add(head);
      k.cyl(0.028, 0.022, 0.1, chrome, head, 0, 0, 0, 16);
      const grille = k.std(0x2a2c30, 0.8, 0.3);
      k.sphere(0.03, grille, head, 0, 0.055, 0, 14);
      k.cyl(0.031, 0.031, 0.012, k.std(look.accent, 0.4, 0.2, { emissive: new THREE.Color(look.accent), emissiveIntensity: 0.6 }), head, 0, 0.02, 0, 16);
      return head;
    }
    case 'mug': { const m = k.std(look.trim, 0.35, 0.05); k.cyl(0.042, 0.038, 0.1, m, g, 0, 0.05, 0, 18); const hd = k.mesh(new THREE.TorusGeometry(0.028, 0.008, 6, 12, Math.PI), m, g, 0.045, 0.055, 0); hd.rotation.z = -Math.PI / 2; k.cyl(0.037, 0.037, 0.004, k.std(0x2a160a, 0.2, 0), g, 0, 0.096, 0); return null; }
    case 'cards': { const w = k.std(0xf3efe2, 0.9, 0); for (let i = 0; i < 4; i++) { const c = k.box(0.1, 0.004, 0.15, w, g, (i % 2) * 0.004, 0.002 + i * 0.004, 0); c.rotation.y = 0.15 * (i - 1.5); } return null; }
    case 'radio': { const b = k.std(0x3c4230, 0.7, 0.3); k.box(0.2, 0.12, 0.09, b, g, 0, 0.06, 0); k.cyl(0.004, 0.004, 0.32, chrome, g, 0.07, 0.28, 0, 6); k.cyl(0.02, 0.02, 0.012, dark, g, -0.05, 0.08, 0.05).rotation.x = Math.PI / 2; return null; }
    case 'ammo': { const b = k.std(0x4a5230, 0.65, 0.4); k.box(0.26, 0.16, 0.12, b, g, 0, 0.08, 0); k.box(0.2, 0.015, 0.03, dark, g, 0, 0.168, 0); return null; }
    case 'burger': { const bun = k.std(0xd08a3a, 0.7, 0); k.sphere(0.06, bun, g, 0, 0.055, 0).scale.set(1, 0.55, 1); k.cyl(0.062, 0.062, 0.018, k.std(0x5a2e14, 0.7, 0), g, 0, 0.035, 0, 18); k.cyl(0.066, 0.066, 0.006, k.std(0x3aa33a, 0.6, 0), g, 0, 0.046, 0, 18); k.cyl(0.058, 0.058, 0.02, bun, g, 0, 0.012, 0, 18); return null; }
    case 'fries': { const box = k.std(0xd61f26, 0.6, 0); k.box(0.08, 0.1, 0.05, box, g, 0, 0.05, 0); const fry = k.std(0xf5c542, 0.7, 0); for (let i = 0; i < 9; i++) { const f = k.box(0.008, 0.08, 0.008, fry, g, -0.03 + (i % 5) * 0.015, 0.12, -0.012 + Math.floor(i / 5) * 0.02); f.rotation.z = (i - 4) * 0.05; } return null; }
    case 'candle': { k.cyl(0.03, 0.035, 0.012, chrome, g, 0, 0.006, 0); k.cyl(0.02, 0.02, 0.14, k.std(0xefe6d2, 0.8, 0), g, 0, 0.08, 0); k.sphere(0.012, k.basic(null, 0xffc46b), g, 0, 0.165, 0, 8).scale.set(1, 1.8, 1); return null; }
    case 'hourglass': { const f = k.std(0xb08a3c, 0.3, 0.8); k.cyl(0.05, 0.05, 0.012, f, g, 0, 0.006, 0); k.cyl(0.05, 0.05, 0.012, f, g, 0, 0.19, 0); const gl = k.std(0xd9ecff, 0.05, 0, { transparent: true, opacity: 0.35 }); k.cyl(0.04, 0.008, 0.085, gl, g, 0, 0.055, 0); k.cyl(0.008, 0.04, 0.085, gl, g, 0, 0.14, 0); k.cyl(0.03, 0.006, 0.05, k.std(0xe0b060, 0.8, 0), g, 0, 0.04, 0); return null; }
    case 'lantern': { const f = k.std(0x2b2b2b, 0.5, 0.7); k.box(0.1, 0.012, 0.1, f, g, 0, 0.006, 0); k.box(0.1, 0.012, 0.1, f, g, 0, 0.17, 0); k.box(0.08, 0.14, 0.08, k.std(0xffd08a, 0.2, 0, { emissive: new THREE.Color(0xffa84a), emissiveIntensity: 1.2, transparent: true, opacity: 0.8 }), g, 0, 0.088, 0); return null; }
    case 'map': { const m = k.box(0.34, 0.004, 0.24, k.std(0xd9c79a, 0.9, 0), g, 0, 0.002, 0); m.rotation.y = 0.25; return null; }
    case 'puck': { k.cyl(0.07, 0.08, 0.025, dark, g, 0, 0.012, 0, 20); const holo = k.basic(null, 0x33d6ff, { transparent: true, opacity: 0.35, blending: THREE.AdditiveBlending, depthWrite: false }); k.cyl(0.05, 0.065, 0.12, holo, g, 0, 0.09, 0, 20); return null; }
    case 'tablet': { const t = k.box(0.2, 0.012, 0.14, dark, g, 0, 0.006, 0); t.rotation.y = -0.3; const s = k.box(0.18, 0.002, 0.12, k.basic(null, 0x1a6fb0), g, 0, 0.013, 0); s.rotation.y = -0.3; return null; }
    case 'glass': { const gl = k.std(0xcfe8ff, 0.05, 0, { transparent: true, opacity: 0.4 }); k.cyl(0.035, 0.03, 0.11, gl, g, 0, 0.055, 0, 16); k.cyl(0.032, 0.028, 0.06, k.std(0xd88a2a, 0.2, 0, { transparent: true, opacity: 0.8 }), g, 0, 0.032, 0, 16); return null; }
    case 'plant': { k.cyl(0.05, 0.04, 0.08, k.std(0x8a4a2a, 0.8, 0), g, 0, 0.04, 0, 14); const leaf = k.std(0x3f9a3a, 0.7, 0); for (let i = 0; i < 6; i++) { const l = k.sphere(0.035, leaf, g, Math.cos(i) * 0.03, 0.11 + (i % 3) * 0.02, Math.sin(i) * 0.03, 8); l.scale.set(0.6, 1.4, 0.4); l.rotation.z = Math.cos(i * 2) * 0.5; } return null; }
    case 'jar': { const gl = k.std(0xcfe8c8, 0.1, 0, { transparent: true, opacity: 0.45 }); k.cyl(0.05, 0.05, 0.14, gl, g, 0, 0.07, 0, 16); k.cyl(0.052, 0.052, 0.02, chrome, g, 0, 0.15, 0, 16); k.sphere(0.02, k.basic(null, 0xcaff5a), g, 0, 0.06, 0, 8); return null; }
  }
  return null;
}

// ---------------------------------------------------------------- monitor housings
export interface BuiltHousing {
  /** Moves with the arrival (rise / drop); the picture surface is parented here at (0, 0, zSurf). */
  root: THREE.Group; moving: THREE.Group;
  /** Local extents of the moving group (arrival distance). */
  topY: number; bottomY: number;
  /** Things that glow / blink with the power (ON AIR lamp, tally). */
  lamps: THREE.MeshStandardMaterial[];
  occluders: THREE.Mesh[];
  /** Arrival: 'rise' from the floor, 'drop' from above. */
  motion: 'rise' | 'drop';
  /** Picture surface z (in front of the housing face). */
  zSurf: number;
}

/** Picture aspect per style (retro sets are 4:3). */
export const MONITOR_ASPECT: Record<MonitorStyle, number> = { tv: 4 / 3, crt: 4 / 3, fieldcrt: 4 / 3, holo: 16 / 9, terminal: 16 / 9, menuboard: 16 / 9, mirror: 16 / 9, skin: 16 / 9 };

/** Rough outer size of a style's housing around a W x H picture (w, h, depth behind the picture; floor-standing?). */
export function housingSize(style: MonitorStyle, W: number, H: number): { w: number; h: number; d: number; floor: boolean } {
  switch (style) {
    case 'tv': return { w: W * 1.22 + 0.2, h: H + 0.3, d: Math.max(0.45, W * 0.55), floor: true };
    case 'crt': case 'fieldcrt': return { w: W + 0.4, h: H + 0.3, d: Math.max(0.45, W * 0.55), floor: true };
    case 'terminal': return { w: W + 0.14, h: H + 0.14, d: 0.25, floor: true };
    case 'menuboard': return { w: W + 0.14, h: H + 0.4, d: 0.12, floor: false };
    default: return { w: W + 0.4, h: H + 0.4, d: 0.3, floor: false };
  }
}

/** Generated housings for tv / crt / fieldcrt / menuboard / terminal. `floorLocal` = the floor below the picture centre
 *  (local y, negative), `ceilLocal` = the ceiling above (for hanging mounts). */
export function buildHousing(k: PropKit, style: MonitorStyle, theme: SetTheme, W: number, H: number, floorLocal: number, ceilLocal: number): BuiltHousing {
  const look = THEME_LOOKS[theme] ?? THEME_LOOKS.studio;
  const root = new THREE.Group(), moving = new THREE.Group(); root.add(moving);
  root.name = 'vtp:interview:monitor';
  const lamps: THREE.MeshStandardMaterial[] = [], occ: THREE.Mesh[] = [];
  const lampMat = (c: number) => { const m = k.std(0x220808, 0.4, 0, { emissive: new THREE.Color(c), emissiveIntensity: 0.2 }) as THREE.MeshStandardMaterial; lamps.push(m); return m; };
  const dark = k.std(0x15161a, 0.5, 0.4), chrome = k.std(0xc9cdd3, 0.22, 0.95);
  let topY = H / 2, bottomY = -H / 2, motion: 'rise' | 'drop' = 'rise';
  const cab = (color: number, rough = 0.5, metal = 0.2) => k.std(color, rough, metal);
  switch (style) {
    case 'tv': case 'crt': case 'fieldcrt': {
      // a chunky cabinet around a 4:3 tube: bezel, knob panel (tv), handles + antenna (field), wood / plastic shell
      const field = style === 'fieldcrt', retro = style === 'tv';
      const bw = field ? 0.09 : 0.1, side = retro ? W * 0.22 : field ? 0.12 : 0.1;
      const CW = W + bw * 2 + side, CH = H + bw * 2 + (field ? 0.06 : 0.04), CD = Math.max(0.45, W * 0.55);
      const shellCol = retro ? 0x5a3a20 : field ? 0x4b5236 : 0x6b6b66;
      const shell = cab(shellCol, retro ? 0.55 : 0.6, field ? 0.35 : 0.1);
      const cx = side / 2;                                             // knob panel on the right
      const body = k.rbox(CW, CH, CD, 0.05, shell, moving, cx, 0, -CD / 2 - 0.005); occ.push(body);
      // bezel (a frame around the picture, standing proud of the shell)
      const bez = cab(retro ? 0x1a1a1a : 0x222320, 0.45, 0.25);
      const fr = new THREE.Shape(); const ow = W + bw * 2, oh = H + bw * 2;
      fr.moveTo(-ow / 2, -oh / 2); fr.lineTo(ow / 2, -oh / 2); fr.lineTo(ow / 2, oh / 2); fr.lineTo(-ow / 2, oh / 2); fr.lineTo(-ow / 2, -oh / 2);
      const hole = roundRect(W + 0.01, H + 0.01, 0.04); fr.holes.push(hole as unknown as THREE.Path);
      const bg = new THREE.ExtrudeGeometry(fr, { depth: 0.035, bevelEnabled: true, bevelThickness: 0.01, bevelSize: 0.012, bevelSegments: 2, curveSegments: 6 });
      k.mesh(bg, bez, moving, 0, 0, -0.02);
      if (retro || style === 'crt') {
        // knob panel: two dials, a speaker grille, the ON AIR tally
        const px = W / 2 + bw + side / 2;
        const grille = k.tex(128, 256, (g, w, h) => { g.fillStyle = '#1b1b1b'; g.fillRect(0, 0, w, h); g.fillStyle = '#3a3a3a'; for (let y = 8; y < h; y += 12) for (let x = 8; x < w; x += 12) { g.beginPath(); g.arc(x, y, 3.2, 0, 7); g.fill(); } });
        k.mesh(new THREE.PlaneGeometry(side * 0.72, CH * 0.36), k.std(0xffffff, 0.8, 0, { map: grille }), moving, px, -CH * 0.22, 0.012);
        for (const [dy, r] of [[CH * 0.28, 0.055], [CH * 0.08, 0.045]] as const) {
          const kn = k.cyl(r, r * 1.08, 0.04, chrome, moving, px, dy, 0.03, 20); kn.rotation.x = Math.PI / 2;
          k.box(0.008, r * 0.9, 0.012, dark, moving, px, dy + r * 0.3, 0.052);
        }
        k.cyl(0.02, 0.02, 0.02, lampMat(0xff3030), moving, px, CH * 0.43, 0.012, 12).rotation.x = Math.PI / 2;
      }
      if (field) {
        // carry handles, corner guards, a whip antenna and a stencilled unit plate
        const bar = k.std(0x2c2f24, 0.5, 0.6);
        for (const sx of [-1, 1]) { k.box(0.04, CH * 0.7, 0.04, bar, moving, cx + sx * (CW / 2 + 0.02), 0, -CD * 0.25); }
        const tube = new THREE.CatmullRomCurve3([new THREE.Vector3(-CW * 0.3, CH / 2, -CD * 0.4), new THREE.Vector3(-CW * 0.3, CH / 2 + 0.09, -CD * 0.4), new THREE.Vector3(CW * 0.3, CH / 2 + 0.09, -CD * 0.4), new THREE.Vector3(CW * 0.3, CH / 2, -CD * 0.4)]);
        k.mesh(new THREE.TubeGeometry(tube, 16, 0.018, 6, false), bar, moving, cx, 0, 0);
        const ant = k.cyl(0.006, 0.004, 0.9, chrome, moving, cx + CW * 0.4, CH / 2 + 0.45, -CD * 0.7, 6); ant.rotation.z = -0.18;
        k.sphere(0.014, chrome, moving, cx + CW * 0.4 + 0.08, CH / 2 + 0.89, -CD * 0.7, 8);
        const plate = k.tex(512, 96, (g, w, h) => { g.fillStyle = '#2d3321'; g.fillRect(0, 0, w, h); g.fillStyle = '#d8d0a0'; g.font = '700 54px "Stencil", Impact, sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('FIELD MONITOR  R-12', w / 2, h / 2 + 3); });
        k.mesh(new THREE.PlaneGeometry(W * 0.6, W * 0.6 * 96 / 512), k.std(0xffffff, 0.8, 0.1, { map: plate }), moving, 0, -H / 2 - bw * 0.62, 0.02);
        k.cyl(0.018, 0.018, 0.02, lampMat(0x39ff5a), moving, W / 2 + bw * 0.5, -H / 2 - bw * 0.55, 0.02, 12).rotation.x = Math.PI / 2;
      }
      if (retro) {
        // rabbit ears on top
        for (const sx of [-1, 1]) { const a = k.cyl(0.005, 0.004, 0.62, chrome, moving, cx + sx * 0.14, CH / 2 + 0.28, -CD * 0.5, 6); a.rotation.z = sx * -0.45; }
        k.sphere(0.05, dark, moving, cx, CH / 2 + 0.02, -CD * 0.5, 12).scale.set(1.4, 0.6, 1);
      }
      topY = CH / 2 + (retro ? 0.55 : field ? 0.9 : 0);
      bottomY = -CH / 2;
      // what it stands on: a chrome pedestal (tv), a stack of crates (crt / field)
      const floorD = -CH / 2 - floorLocal;                               // (floorLocal < 0) → distance from cabinet bottom down to the floor
      if (floorLocal < -CH / 2 - 0.05) {
        const h = -floorLocal - CH / 2;
        if (retro) {
          k.cyl(0.05, 0.05, h - 0.06, chrome, moving, cx, -CH / 2 - (h - 0.06) / 2, -CD / 2, 16);
          k.cyl(0.34, 0.38, 0.06, dark, moving, cx, -CH / 2 - h + 0.03, -CD / 2, 28);
          k.box(CW * 0.7, 0.04, CD * 0.7, dark, moving, cx, -CH / 2 - 0.02, -CD / 2);
        } else {
          const crate = k.std(field ? 0x55502e : 0x6a5334, 0.8, 0.05, { map: panelTexture(k, { ...look, panel: field ? 0x55502e : 0x6a5334, pattern: 'crate' }, 9) });
          let y = -CH / 2, n = 0;
          while (y > floorLocal + 0.05 && n < 4) { const ch = Math.min(0.42, y - floorLocal); const c = k.box(CW * (0.96 - n * 0.04) , ch - 0.01, CD * 1.05, crate, moving, cx + (n % 2 ? 0.03 : -0.02), y - ch / 2, -CD / 2); c.rotation.y = (n % 2 ? 0.05 : -0.04); occ.push(c); y -= ch; n++; }
        }
      }
      void floorD;
      break;
    }
    case 'menuboard': case 'terminal': {
      // a slim panel: menu board hanging on two rods (kitchen) / a white clinical display on a floor stand (labs)
      const menu = style === 'menuboard';
      const fw = 0.05, CW = W + fw * 2, CH = H + fw * 2 + (menu ? 0.16 : 0.06);
      const shell = cab(menu ? 0x202020 : 0xf1f3f5, menu ? 0.4 : 0.3, menu ? 0.6 : 0.1);
      const body = k.rbox(CW, CH, 0.07, 0.02, shell, moving, 0, menu ? 0.06 : 0.02, -0.045); occ.push(body);
      if (menu) {
        const hdr = k.tex(1024, 128, (g, w, h) => { g.fillStyle = '#c8161d'; g.fillRect(0, 0, w, h); g.fillStyle = '#ffc72c'; g.font = '900 82px "Arial Rounded MT Bold", "Arial Black", sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('NOW SERVING', w / 2, h / 2 + 4); });
        k.mesh(new THREE.PlaneGeometry(W, 0.14), k.basic(hdr), moving, 0, H / 2 + 0.085, 0.002);
        motion = 'drop';
        const up = Math.max(0.3, ceilLocal - (H / 2 + 0.16));
        for (const sx of [-1, 1]) k.cyl(0.012, 0.012, up, chrome, moving, sx * W * 0.35, H / 2 + 0.16 + up / 2, -0.05, 8);
        topY = ceilLocal; bottomY = -CH / 2;
      } else {
        k.box(W * 0.9, 0.012, 0.01, k.std(0x0d6bd6, 0.3, 0, { emissive: new THREE.Color(0x38b6ff), emissiveIntensity: 1.2 }), moving, 0, -H / 2 - 0.035, 0.001);
        const lg = -floorLocal - CH / 2;
        if (lg > 0.1) { k.box(0.08, lg, 0.06, shell, moving, 0, -CH / 2 - lg / 2, -0.08); k.box(0.7, 0.03, 0.4, shell, moving, 0, floorLocal + 0.015, -0.1); }
        topY = CH / 2; bottomY = floorLocal;
      }
      k.cyl(0.012, 0.012, 0.01, lampMat(menu ? 0xffc72c : 0x38b6ff), moving, W / 2 - 0.03, -H / 2 - 0.03, 0.001, 10).rotation.x = Math.PI / 2;
      break;
    }
    default: break;
  }
  root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return { root, moving, topY, bottomY, lamps, occluders: occ, motion, zSurf: 0.004 };
}

// ---------------------------------------------------------------- sidekick band stand
/** A co-host's chair at the desk (generated seats: layout.ts): a talk-show swivel chair in the theme's colours, the seat
 *  surface at `seatH` above the floor, facing +Z; the sitter's hips land on the origin. */
export function buildChair(k: PropKit, theme: SetTheme, seatH: number): { root: THREE.Group; occluders: THREE.Mesh[] } {
  const look = THEME_LOOKS[theme] ?? THEME_LOOKS.studio;
  const root = new THREE.Group(); root.name = 'vtp:interview:chair';
  const H = THREE.MathUtils.clamp(seatH, 0.3, 0.9);
  const cushion = k.std(new THREE.Color(look.panel).multiplyScalar(0.72).getHex(), 0.7, 0.05);
  const frame = k.std(look.trim, 0.3, 0.75), dark = k.std(0x16171b, 0.5, 0.4);
  const seat = k.rbox(0.5, 0.46, 0.09, 0.07, cushion, root, 0, H - 0.045, -0.06);
  seat.rotation.x = -Math.PI / 2;
  const back = k.rbox(0.47, 0.5, 0.08, 0.08, cushion, root, 0, H + 0.3, -0.31);
  back.rotation.x = -0.1;
  k.box(0.3, 0.035, 0.035, frame, root, 0, H + 0.02, -0.3);
  k.cyl(0.03, 0.03, 0.26, frame, root, 0, H + 0.13, -0.3, 8);
  k.cyl(0.035, 0.035, Math.max(0.05, H - 0.14), frame, root, 0, (H - 0.14) / 2 + 0.05, -0.06, 10);
  k.cyl(0.07, 0.07, 0.05, dark, root, 0, H - 0.115, -0.06, 12);
  // a five-spoke base
  for (let i = 0; i < 5; i++) { const a = (i / 5) * Math.PI * 2, sp = k.box(0.03, 0.025, 0.27, dark, root, Math.sin(a) * 0.13, 0.05, -0.06 + Math.cos(a) * 0.13); sp.rotation.y = a; }
  root.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return { root, occluders: [seat, back] };
}

export function buildStand(k: PropKit, kind: 'keys' | 'drums' | 'none', theme: SetTheme): THREE.Group {
  const look = THEME_LOOKS[theme] ?? THEME_LOOKS.studio;
  const g = new THREE.Group(); g.name = 'vtp:interview:stand';
  if (kind === 'none') return g;
  const dark = k.std(0x17181c, 0.45, 0.5), chrome = k.std(0xc9cdd3, 0.22, 0.95);
  if (kind === 'keys') {
    // a keyboard on an X stand in front of the sidekick (+Z side), angled towards the audience
    const kb = new THREE.Group(); kb.position.set(0, 0.62, 0.52); kb.rotation.x = -0.12; g.add(kb);
    k.box(0.86, 0.06, 0.26, k.std(look.panel, 0.4, 0.3), kb, 0, 0, 0);
    const keys = k.tex(512, 64, (c, w, h) => { c.fillStyle = '#f4f4f0'; c.fillRect(0, 0, w, h); c.fillStyle = '#222'; for (let i = 0; i < 36; i++) { c.fillRect(i * (w / 36), 0, 1.5, h); if ([1, 3, 6, 8, 10].includes(i % 12)) c.fillRect(i * (w / 36) - 4, 0, 8, h * 0.6); } });
    k.mesh(new THREE.PlaneGeometry(0.78, 0.12), k.std(0xffffff, 0.5, 0, { map: keys }), kb, 0, 0.031, 0.05).rotation.x = -Math.PI / 2;
    for (const sx of [-1, 1]) { const l = k.box(0.03, 0.72, 0.03, chrome, g, sx * 0.25, 0.3, 0.52); l.rotation.z = sx * 0.5; }
    k.box(0.9, 0.02, 0.02, k.std(0x111111, 0.4, 0, { emissive: new THREE.Color(look.accent), emissiveIntensity: 1.2 }), kb, 0, 0.034, -0.12);
  } else {
    // a small drum kit: kick + snare + a cymbal, beside and in front of the sidekick
    const shell = k.std(look.accent, 0.35, 0.3, { emissive: new THREE.Color(look.accent), emissiveIntensity: 0.15 });
    const kick = k.cyl(0.24, 0.24, 0.3, shell, g, 0.1, 0.26, 0.42, 24); kick.rotation.x = Math.PI / 2;
    const head = k.tex(256, 256, (c, w, h) => { c.fillStyle = '#f2efe6'; c.beginPath(); c.arc(w / 2, h / 2, w / 2, 0, 7); c.fill(); c.fillStyle = look.plateFg; c.font = '900 58px Impact, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle'; c.fillText('♪ ♫', w / 2, h / 2); });
    const hd = k.mesh(new THREE.CircleGeometry(0.235, 24), k.std(0xffffff, 0.6, 0, { map: head }), g, 0.1, 0.26, 0.572);
    void hd;
    k.cyl(0.16, 0.16, 0.12, shell, g, -0.28, 0.55, 0.36, 20);
    k.cyl(0.155, 0.155, 0.005, k.std(0xf2efe6, 0.6, 0), g, -0.28, 0.612, 0.36, 20);
    k.cyl(0.012, 0.012, 0.55, chrome, g, -0.28, 0.27, 0.36, 6);
    k.cyl(0.012, 0.012, 1.0, chrome, g, 0.42, 0.5, 0.22, 6);
    const cym = k.cyl(0.2, 0.2, 0.01, k.std(0xd4a93c, 0.25, 0.9), g, 0.42, 1.0, 0.22, 24); cym.rotation.x = 0.2;
  }
  g.traverse((o) => { o.castShadow = false; o.receiveShadow = false; });
  return g;
}
