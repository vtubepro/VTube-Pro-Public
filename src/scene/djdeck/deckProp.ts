// DJ decks: the generic DJ setup, built from code (shared/djDeck/layout.ts): two players + a 4-channel mixer, or a
// one-piece 4-channel controller with a laptop beside it. No brand names, no logos. Every control is a separately
// animatable, named part: knobs, faders, the tempo faders, the crossfader, buttons, pads, the jog platters, the drum
// lever, the level meters and the screens (src/scene/djdeck/deckScreens.ts).
// Budget (3060 @ 1080p "High"): ~20 draw calls — the static body is merged per material, buttons / pads / knobs /
// fader caps are instanced (one draw each, per-instance colour for the LEDs), the two platters + meters + screens are
// their own meshes. No lights are added (a new light recompiles every lit material in the room): the LEDs are
// unlit colours and the body has a little emissive so it reads in a dark booth.
import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { rigLayout, type LayoutId, type Part, type RigLayout } from '../../../shared/djDeck/layout.ts';

/** Per-frame input (all optional: missing = rest). */
export interface PropFrame {
  /** 0..1 as the controller reports them (see shared/djDeck/reader.ts DeckSnapshot.x). */
  x: Record<string, number>;
  /** Platter angle per side (turns, clockwise). */
  jog: { L: number; R: number };
  held: Set<string>;
  lit: Set<string>;
  /** 0..1 glow per part right after a touch (fades). */
  glow: Map<string, number>;
  /** Meter levels 0..1 per channel (1-4) and master. */
  level: number[];
  /** Beat phase 0..1 (LED breathing). */
  beat: number;
}

const KNOB_SWEEP = THREE.MathUtils.degToRad(300);
const tmpM = new THREE.Matrix4(), tmpQ = new THREE.Quaternion(), tmpS = new THREE.Vector3(1, 1, 1), tmpP = new THREE.Vector3(), tmpC = new THREE.Color();
const DIM = new THREE.Color(0x2a2d34);
const Y = new THREE.Vector3(0, 1, 0), X = new THREE.Vector3(1, 0, 0);

interface Inst { mesh: THREE.InstancedMesh; i: number; part: Part; pos: THREE.Vector3; scale: THREE.Vector3 }

/** Gear-local position of a layout point (DJ faces +Z: x = −u, z = v). */
const at = (u: number, y: number, v: number, out = new THREE.Vector3()) => out.set(-u, y, v);

export class DeckProp {
  readonly root = new THREE.Group();
  /** The gear's top-surface frame (scaled to the performer). */
  readonly gear = new THREE.Group();
  readonly layout: RigLayout;
  /** Named parts: knobs / faders / jogs are Object3Ds named `djdeck:<id>`; LEDs are slots of the instanced meshes. */
  readonly parts = new Map<string, { part: Part; obj?: THREE.Object3D; inst?: Inst }>();
  private jogs: Partial<Record<'L' | 'R', { spin: THREE.Object3D; ring: THREE.Mesh; base: THREE.Color }>> = {};
  private meters: { ch: number; i: number }[] = [];
  private meterLv: THREE.InstancedBufferAttribute | null = null;
  private insts: THREE.InstancedMesh[] = [];
  private knobInst: Inst[] = [];
  private markInst: Inst[] = [];
  private capInst: Inst[] = [];
  private ledInst: Inst[] = [];
  private disposables: { dispose(): void }[] = [];
  readonly screens: { id: string; mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture; side: 'L' | 'R' | 'M' }[] = [];
  facade: { mesh: THREE.Mesh; canvas: HTMLCanvasElement; tex: THREE.CanvasTexture } | null = null;
  stand: THREE.Group | null = null;
  /** Lever tilt per side. */
  private levers = new Map<string, THREE.Object3D>();

  constructor(readonly id: LayoutId) {
    this.layout = rigLayout(id);
    this.root.name = 'djdeck';
    this.gear.name = 'djdeck:gear';
    this.root.add(this.gear);
    this.build();
  }

  private mat<T extends THREE.Material>(m: T): T { this.disposables.push(m); return m; }
  private geo<T extends THREE.BufferGeometry>(g: T): T { this.disposables.push(g); return g; }

  private build() {
    const L = this.layout, g = this.gear;
    const body = this.mat(new THREE.MeshStandardMaterial({ color: 0x15171c, roughness: 0.58, metalness: 0.35, emissive: 0x0b0d12, emissiveIntensity: 1 }));
    const plate = this.mat(new THREE.MeshStandardMaterial({ color: 0x23262e, roughness: 0.42, metalness: 0.5, emissive: 0x0d0f14 }));
    const black = this.mat(new THREE.MeshStandardMaterial({ color: 0x050506, roughness: 0.9, metalness: 0 }));
    const metal = this.mat(new THREE.MeshStandardMaterial({ color: 0xb9bec8, roughness: 0.28, metalness: 0.95, emissive: 0x1a1c22 }));
    const statics: Record<string, THREE.BufferGeometry[]> = { body: [], plate: [], black: [], metal: [] };
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, into: keyof typeof statics, round = 0) => {
      const geo = round > 0 ? new RoundedBoxGeometry(w, h, d, 2, round) : new THREE.BoxGeometry(w, h, d);
      geo.translate(x, y, z); statics[into].push(geo);
    };
    // housings (top surface at y = 0; the body hangs below it) + an inset top plate
    for (const hz of L.housings) {
      const c = at(hz.u, 0, hz.v);
      if (hz.raised) { box(hz.w - 0.012, hz.h, hz.d, c.x, hz.h / 2, c.z, 'body', 0.004); box(hz.w - 0.02, 0.002, hz.d - 0.008, c.x, hz.h + 0.001, c.z, 'plate'); continue; }
      box(hz.w, hz.h, hz.d, c.x, -hz.h / 2, c.z, 'body', 0.008);
      box(hz.w - 0.014, 0.002, hz.d - 0.014, c.x, 0.001, c.z, 'plate');
    }
    // slots for the faders, wells for the jogs, LED-meter backs
    for (const p of L.parts) {
      const c = at(p.u, p.y, p.v);
      if (p.kind === 'fader' || p.kind === 'tempo') box(0.004, 0.003, p.len + 0.01, c.x, 0.0025, c.z, 'black');
      if (p.kind === 'xfader') box(p.len + 0.012, 0.003, 0.004, c.x, 0.0025, c.z, 'black');
      if (p.kind === 'meter') box(p.w + 0.004, 0.002, p.len + 0.004, c.x, 0.002, c.z, 'black');
      if (p.kind === 'jog') {
        const ring = new THREE.TorusGeometry(p.r + 0.006, 0.0045, 8, 64); ring.rotateX(Math.PI / 2); ring.translate(c.x, 0.004, c.z); statics.metal.push(ring);
        const well = new THREE.CylinderGeometry(p.r + 0.004, p.r + 0.004, 0.003, 48); well.translate(c.x, 0.0015, c.z); statics.black.push(well);
        // the platter's rim (a plain metal cylinder: turning it changes nothing on screen, so it is static)
        const rim = new THREE.CylinderGeometry(p.r, p.r * 0.985, 0.014, 64, 1, true); rim.translate(c.x, 0.009, c.z); statics.metal.push(rim);
      }
    }
    const mats = { body, plate, black, metal };
    for (const [k, list] of Object.entries(statics)) {
      if (!list.length) continue;
      const merged = this.geo(mergeGeometries(list.map((x) => x.index ? x.toNonIndexed() : x), false) ?? new THREE.BufferGeometry());
      for (const x of list) x.dispose();
      const m = new THREE.Mesh(merged, mats[k as keyof typeof mats]); m.name = `djdeck:body-${k}`; m.castShadow = false; m.receiveShadow = false;
      g.add(m);
    }
    this.buildJogs(metal, black);
    this.buildInstanced();
    this.buildMeters();
    this.buildScreens(body, black);
  }

  private buildJogs(metal: THREE.Material, black: THREE.Material) {
    const top = this.jogTopTexture();
    for (const p of this.layout.parts) {
      if (p.kind !== 'jog') continue;
      const s = p.side as 'L' | 'R';
      const grp = new THREE.Group(); grp.name = `djdeck:${p.id}`;
      at(p.u, 0, p.v, grp.position);
      // the platter's top (one textured disc: grooves, position dots, the centre display + its pointer) turns
      const spin = new THREE.Mesh(this.geo(new THREE.CircleGeometry(p.r * 0.995, 64)), this.mat(new THREE.MeshStandardMaterial({ map: top, color: 0xffffff, roughness: 0.35, metalness: 0.6, emissive: 0x0a0c10 })));
      spin.name = `djdeck:${p.id}:platter`;
      spin.geometry.rotateX(-Math.PI / 2); spin.position.y = 0.016;
      const ringMat = this.mat(new THREE.MeshBasicMaterial({ color: p.led }));
      const ring = new THREE.Mesh(this.geo(new THREE.TorusGeometry(p.r * 0.38, 0.0022, 6, 48)), ringMat); ring.rotation.x = Math.PI / 2; ring.position.y = 0.017;
      grp.add(spin, ring);
      void metal; void black;
      this.gear.add(grp);
      this.jogs[s] = { spin, ring, base: new THREE.Color(p.led) };
      this.parts.set(p.id, { part: p, obj: grp });
    }
  }

  private jogTopTexture(): THREE.CanvasTexture {
    const c = document.createElement('canvas'); c.width = c.height = 256;
    const x = c.getContext('2d')!;
    const gr = x.createRadialGradient(128, 128, 10, 128, 128, 128); gr.addColorStop(0, '#30343d'); gr.addColorStop(1, '#16181d');
    x.fillStyle = gr; x.fillRect(0, 0, 256, 256);
    x.strokeStyle = 'rgba(255,255,255,0.06)';
    for (let r = 40; r < 128; r += 3) { x.beginPath(); x.arc(128, 128, r, 0, Math.PI * 2); x.stroke(); }
    x.fillStyle = 'rgba(255,255,255,0.5)';
    for (let k = 0; k < 4; k++) { const a = k * Math.PI / 2; x.beginPath(); x.arc(128 + Math.sin(a) * 112, 128 - Math.cos(a) * 112, 3, 0, Math.PI * 2); x.fill(); }
    // the centre display with its pointer (turns with the platter)
    x.fillStyle = '#0a1626'; x.beginPath(); x.arc(128, 128, 46, 0, Math.PI * 2); x.fill();
    x.strokeStyle = 'rgba(120,180,255,0.35)'; x.lineWidth = 2; x.beginPath(); x.arc(128, 128, 46, 0, Math.PI * 2); x.stroke();
    x.fillStyle = '#ffffff'; x.fillRect(125, 128, 6, 40);
    const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4;
    this.disposables.push(t);
    return t;
  }

  private buildInstanced() {
    const L = this.layout;
    const roundBtns = L.parts.filter((p) => p.kind === 'button' && p.r > 0 && p.w <= 0.016 && p.id.match(/\.(play|cue|shift)$/));
    const rectBtns = L.parts.filter((p) => (p.kind === 'button' && !roundBtns.includes(p)) || p.kind === 'pad');
    const knobs = L.parts.filter((p) => p.kind === 'knob' || p.kind === 'encoder');
    const caps = L.parts.filter((p) => p.kind === 'fader' || p.kind === 'tempo' || p.kind === 'xfader');
    const led = this.mat(new THREE.MeshBasicMaterial({ color: 0xffffff }));
    const mk = (geo: THREE.BufferGeometry, mat: THREE.Material, list: Part[], name: string, scale: (p: Part) => THREE.Vector3, y: (p: Part) => number, into: Inst[]) => {
      if (!list.length) return;
      const m = new THREE.InstancedMesh(this.geo(geo), mat, list.length); m.name = `djdeck:${name}`;
      m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      list.forEach((p, i) => {
        const inst: Inst = { mesh: m, i, part: p, pos: at(p.u, p.y + y(p), p.v), scale: scale(p) };
        into.push(inst);
        if (!this.parts.has(p.id) || name === 'knobs') this.parts.set(p.id, { part: p, inst });
        tmpM.compose(inst.pos, tmpQ.identity(), inst.scale); m.setMatrixAt(i, tmpM);
        m.setColorAt(i, tmpC.set(p.led));
      });
      m.userData.ids = list.map((p) => p.id);
      m.frustumCulled = false;
      this.insts.push(m); this.gear.add(m);
    };
    // LED buttons + pads: a unit box / cylinder scaled per part, coloured per instance
    mk(new THREE.CylinderGeometry(0.5, 0.5, 1, 20), led, roundBtns, 'buttons-round', (p) => new THREE.Vector3(p.r * 2, 0.006, p.r * 2), () => 0.003, this.ledInst);
    mk(new RoundedBoxGeometry(1, 1, 1, 1, 0.12), led, rectBtns, 'buttons', (p) => new THREE.Vector3(p.w, p.kind === 'pad' ? 0.007 : 0.005, p.d), (p) => (p.kind === 'pad' ? 0.0035 : 0.0025), this.ledInst);
    // knobs: a dark rubber body + a white pointer line
    const knobMat = this.mat(new THREE.MeshStandardMaterial({ color: 0x1b1d22, roughness: 0.62, metalness: 0.15, emissive: 0x08090c }));
    const kgeo = new THREE.CylinderGeometry(0.46, 0.5, 1, 20); kgeo.translate(0, 0.5, 0);
    mk(kgeo, knobMat, knobs, 'knobs', (p) => new THREE.Vector3(p.r * 2, p.kind === 'encoder' ? 0.014 : 0.017, p.r * 2), () => 0, this.knobInst);
    const markGeo = new THREE.BoxGeometry(1, 1, 1); markGeo.translate(0, 0, 0.5);
    mk(markGeo, this.mat(new THREE.MeshBasicMaterial({ color: 0xeef2ff })), knobs, 'knob-marks', (p) => new THREE.Vector3(Math.max(0.0012, p.r * 0.14), 0.0012, p.r * 0.9), (p) => (p.kind === 'encoder' ? 0.0142 : 0.0172), this.markInst);
    // fader caps (light grey, a dark line across the top)
    const capMat = this.mat(new THREE.MeshStandardMaterial({ color: 0xc9ccd3, roughness: 0.45, metalness: 0.2, emissive: 0x202227 }));
    mk(new RoundedBoxGeometry(1, 1, 1, 1, 0.15), capMat, caps, 'fader-caps', (p) => (p.kind === 'xfader' ? new THREE.Vector3(p.d, 0.012, p.w) : new THREE.Vector3(p.w, 0.012, p.d)), () => 0.008, this.capInst);
    for (const inst of this.capInst) this.parts.set(inst.part.id, { part: inst.part, inst });
    // the drum-release levers
    for (const p of L.parts.filter((x) => x.kind === 'lever')) {
      const piv = new THREE.Group(); piv.name = `djdeck:${p.id}`; at(p.u, p.y, p.v, piv.position);
      const stick = new THREE.Mesh(this.geo(new THREE.BoxGeometry(p.w, 0.024, 0.008)), capMat); stick.position.y = 0.012;
      const tip = new THREE.Mesh(this.geo(new THREE.BoxGeometry(p.w * 1.3, 0.006, 0.014)), this.mat(new THREE.MeshBasicMaterial({ color: p.led }))); tip.position.y = 0.025;
      piv.add(stick, tip); this.gear.add(piv);
      this.levers.set(p.id, piv); this.parts.set(p.id, { part: p, obj: piv });
    }
  }

  private buildMeters() {
    const list = this.layout.parts.filter((x) => x.kind === 'meter');
    if (!list.length) return;
    const lv = new THREE.InstancedBufferAttribute(new Float32Array(list.length), 1); lv.setUsage(THREE.DynamicDrawUsage);
    const geo = this.geo(new THREE.PlaneGeometry(1, 1)); geo.rotateX(-Math.PI / 2);
    geo.setAttribute('lvl', lv);
    {
      const mat = this.mat(new THREE.ShaderMaterial({
        vertexShader: `attribute float lvl; varying vec2 vUv; varying float vLevel;
          void main(){ vUv = uv; vLevel = lvl; vec4 p = vec4(position, 1.0);
            #ifdef USE_INSTANCING
            p = instanceMatrix * p;
            #endif
            gl_Position = projectionMatrix * modelViewMatrix * p; }`,
        fragmentShader: `varying float vLevel; varying vec2 vUv;
          void main(){
            float seg = floor(vUv.y * 12.0); float inSeg = fract(vUv.y * 12.0);
            if (inSeg > 0.78) discard;
            float on = step(seg + 0.5, vLevel * 12.0);
            vec3 c = seg >= 10.0 ? vec3(1.0, 0.16, 0.12) : seg >= 7.0 ? vec3(1.0, 0.62, 0.08) : vec3(0.22, 1.0, 0.36);
            gl_FragColor = vec4(c * (0.12 + 0.88 * on), 1.0);
            #include <colorspace_fragment>
          }`,
      }));
      const m = new THREE.InstancedMesh(geo, mat, list.length); m.name = 'djdeck:meters'; m.frustumCulled = false;
      list.forEach((p, i) => {
        m.setMatrixAt(i, tmpM.compose(at(p.u, 0.0032, p.v, tmpP), tmpQ.identity(), tmpS.set(p.w, 1, p.len)));
        this.meters.push({ ch: +(/^ch(\d)/.exec(p.id)?.[1] ?? 0), i });
        this.parts.set(p.id, { part: p, obj: m });
      });
      this.meterLv = lv;
      this.insts.push(m); this.gear.add(m);
    }
  }

  private canvasScreen(w: number, h: number) {
    const canvas = document.createElement('canvas'); canvas.width = w; canvas.height = h;
    const tex = new THREE.CanvasTexture(canvas); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    this.disposables.push(tex);
    return { canvas, tex };
  }

  private buildScreens(body: THREE.Material, black: THREE.Material) {
    for (const s of this.layout.screens) {
      const grp = new THREE.Group(); grp.name = `djdeck:${s.id}`;
      at(s.u, s.y, s.v, grp.position);
      const { canvas, tex } = this.canvasScreen(512, Math.round(512 * s.h / s.w));
      const face = new THREE.Mesh(this.geo(new THREE.PlaneGeometry(s.w, s.h)), this.mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false })));
      const back = new THREE.Mesh(this.geo(new THREE.BoxGeometry(s.w + 0.012, s.h + 0.012, 0.008)), body);
      // face the DJ (−Z), leaning back by `tilt` from vertical
      const lean = new THREE.Group(); lean.rotation.set(s.tilt, Math.PI, 0, 'XYZ');
      face.position.z = 0.0042; back.position.z = 0;
      lean.add(back, face); lean.position.y = s.h / 2 * Math.cos(s.tilt) + 0.01;
      grp.add(lean);
      if (s.id === 'laptop') {
        const base = new THREE.Mesh(this.geo(new THREE.BoxGeometry(s.w + 0.01, 0.012, s.h * 0.95)), body); base.position.set(0, 0.006, -s.h * 0.475);
        lean.position.y = 0.012 + s.h / 2 * Math.cos(s.tilt); lean.position.z = 0;
        const lh = this.layout.h;
        const riser = new THREE.Mesh(this.geo(new THREE.BoxGeometry(s.w * 0.8, lh, s.h * 0.9)), black); riser.position.set(0, -lh / 2, -s.h * 0.45);
        grp.add(base, riser);
        // turned toward the DJ (who stands ~0.45 m in front of the gear's middle)
        const dx = 0 - grp.position.x, dz = -0.45 - grp.position.z;
        grp.rotation.y = Math.atan2(-dx, -dz);
      }
      this.gear.add(grp);
      this.screens.push({ id: s.id, mesh: face, canvas, tex, side: s.side });
    }
  }

  /** A booth stand under the gear (height = floor → top surface, in gear units) with an LED facade facing the room. */
  setStand(on: boolean, heightGear: number) {
    if (!on) { if (this.stand) this.stand.visible = false; return; }
    const L = this.layout;
    const H = Math.max(0.2, heightGear - L.h);
    if (!this.stand || Math.abs((this.stand.userData.h as number) - H) > 0.005) {
      if (this.stand) { this.gear.remove(this.stand); this.stand.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); }); }
      const st = new THREE.Group(); st.name = 'djdeck:stand'; st.userData.h = H;
      // the stand covers the gear and whatever stands beside it (a laptop)
      let x0 = -L.w / 2, x1 = L.w / 2;
      for (const sc of L.screens) { x0 = Math.min(x0, -sc.u - sc.w * 0.55); x1 = Math.max(x1, -sc.u + sc.w * 0.55); }
      const w = x1 - x0 + 0.12, d = L.d + 0.1, top = -L.h, cx = (x0 + x1) / 2;
      const bodyM = this.mat(new THREE.MeshStandardMaterial({ color: 0x101114, roughness: 0.7, metalness: 0.2, emissive: 0x07080a }));
      const sz = (L.d / 2 - d / 2) + 0.03;
      const g1 = new RoundedBoxGeometry(w, H, d, 2, 0.01); g1.translate(cx, top - H / 2, sz);
      const g2 = new THREE.BoxGeometry(w + 0.03, 0.03, d + 0.03); g2.translate(cx, top - 0.015, sz);
      const shell = new THREE.Mesh(mergeGeometries([g1.toNonIndexed(), g2.toNonIndexed()], false) ?? g1, bodyM); shell.name = 'djdeck:stand-body';
      g1.dispose(); g2.dispose();
      st.add(shell);
      // the facade: track title + waveform for the audience (painted by deckScreens)
      const fw = (L.w + 0.12) * 0.92, fh = Math.min(H * 0.55, fw * 0.28);
      if (!this.facade) { const { canvas, tex } = this.canvasScreen(1024, Math.round(1024 * fh / fw)); this.facade = { mesh: new THREE.Mesh(new THREE.PlaneGeometry(fw, fh), this.mat(new THREE.MeshBasicMaterial({ map: tex, toneMapped: false }))), canvas, tex }; }
      else { this.facade.mesh.geometry.dispose(); this.facade.mesh.geometry = new THREE.PlaneGeometry(fw, fh); }
      this.facade.mesh.name = 'djdeck:facade';
      this.facade.mesh.position.set(0, top - 0.05 - fh / 2, sz + d / 2 + 0.002);
      const strip = new THREE.Mesh(new THREE.BoxGeometry(w * 0.98, 0.008, 0.004), this.mat(new THREE.MeshBasicMaterial({ color: 0xff3fd2 })));
      strip.name = 'djdeck:stand-led'; strip.position.set(cx, top - H + 0.03, sz + d / 2 + 0.003);
      st.add(this.facade.mesh, strip);
      this.stand = st; this.gear.add(st);
    }
    this.stand.visible = true;
  }

  /** Gear-local contact point of a part as it is right now (where a fingertip / palm touches it). */
  contact(id: string, f: PropFrame | null, out = new THREE.Vector3()): THREE.Vector3 | null {
    const h = this.parts.get(id); if (!h) return null;
    const p = h.part;
    at(p.u, p.y, p.v, out);
    switch (p.kind) {
      case 'jog': out.y = 0.017; break;
      case 'fader': out.z = p.v - p.len / 2 + (f?.x[id] ?? 0.5) * p.len; out.y = 0.016; break;
      case 'tempo': out.z = p.v + p.len / 2 - (f?.x[id] ?? 0.5) * p.len; out.y = 0.016; break;
      case 'xfader': out.x = -(p.u - p.len / 2 + (f?.x[id] ?? 0.5) * p.len); out.y = 0.016; break;
      case 'knob': case 'encoder': out.y = p.y + 0.019; break;
      case 'lever': out.y = p.y + 0.028; break;
      default: out.y = p.y + 0.008;
    }
    return out;
  }

  /** Animate every part (cheap: instance matrices + a few uniforms). */
  update(f: PropFrame) {
    // knobs + pointers
    for (let k = 0; k < this.knobInst.length; k++) {
      const a = this.knobInst[k], b = this.markInst[k];
      const v = f.x[a.part.id];
      const ang = a.part.kind === 'encoder' ? -(v ?? 0) * Math.PI * 2 : -((v ?? 0.5) - 0.5) * KNOB_SWEEP;
      tmpQ.setFromAxisAngle(Y, ang);
      tmpM.compose(a.pos, tmpQ, a.scale); a.mesh.setMatrixAt(a.i, tmpM);
      tmpM.compose(b.pos, tmpQ, b.scale); b.mesh.setMatrixAt(b.i, tmpM);
    }
    // fader caps
    for (const c of this.capInst) {
      const p = c.part, v = f.x[p.id] ?? (p.kind === 'fader' ? 0.85 : 0.5);
      tmpP.copy(c.pos);
      if (p.kind === 'fader') tmpP.z = p.v - p.len / 2 + v * p.len;
      else if (p.kind === 'tempo') tmpP.z = p.v + p.len / 2 - v * p.len;
      else tmpP.x = -(p.u - p.len / 2 + v * p.len);
      tmpM.compose(tmpP, tmpQ.identity(), c.scale); c.mesh.setMatrixAt(c.i, tmpM);
    }
    // LEDs: dim when off, bright when held / lit / just touched; held parts sink 1.5 mm
    const breathe = 0.75 + 0.25 * Math.cos(f.beat * Math.PI * 2);
    for (const l of this.ledInst) {
      const id = l.part.id, held = f.held.has(id), lit = f.lit.has(id), glow = f.glow.get(id) ?? 0;
      let k = l.part.kind === 'pad' ? 0.28 : 0.13;
      if (lit) k = /\.play$/.test(id) ? breathe : 0.9;
      k = Math.max(k, glow * 0.9, held ? 1.25 : 0);
      tmpC.set(l.part.led).multiplyScalar(k);
      if (k < 0.2) tmpC.lerp(DIM, 0.55);
      l.mesh.setColorAt(l.i, tmpC);
      tmpP.copy(l.pos); if (held) tmpP.y -= 0.0015;
      tmpM.compose(tmpP, tmpQ.identity(), l.scale); l.mesh.setMatrixAt(l.i, tmpM);
    }
    for (const m of this.insts) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; }
    // jogs
    for (const s of ['L', 'R'] as const) {
      const j = this.jogs[s]; if (!j) continue;
      j.spin.rotation.y = -(f.jog[s] % 1) * Math.PI * 2;
      const touched = f.held.has(`${s}.jog`), glow = f.glow.get(`${s}.jog`) ?? 0;
      (j.ring.material as THREE.MeshBasicMaterial).color.copy(j.base).multiplyScalar(touched ? 1.4 : 0.45 + 0.55 * glow);
    }
    for (const [id, piv] of this.levers) piv.rotation.x = f.held.has(id) ? ((f.x[id] ?? 1) > 0.5 ? 0.35 : -0.35) : 0;
    if (this.meterLv) { for (const m of this.meters) this.meterLv.setX(m.i, f.level[m.ch] ?? 0); this.meterLv.needsUpdate = true; }
  }

  dispose() {
    this.root.removeFromParent();
    if (this.stand) this.stand.traverse((o) => { if ((o as THREE.Mesh).isMesh) (o as THREE.Mesh).geometry.dispose(); });
    for (const d of this.disposables) try { d.dispose(); } catch { /* gone */ }
    for (const m of this.insts) m.dispose();
    this.disposables = [];
  }
}

void X;
