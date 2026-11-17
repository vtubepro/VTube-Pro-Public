// React screen: drops down from its rest position in 'react' mode. In the OBS output its surface is a
// true transparent HOLE (RGBA written as 0 with depth, so avatars in front still cover it) — a Window
// Capture placed BELOW the browser source in OBS shows through. In the studio preview it shows a
// placeholder, or a getDisplayMedia() capture of a window the performer picked. With "in-scene capture" the host's
// shared window (src/scene/screenShare.ts) is drawn ON the surface instead of the hole (look 'preview' + a source).
import * as THREE from 'three';
import type { ScreenInfo } from './contract.ts';
import { PowerSeq, ScreenFx } from './screenFx.ts';
import { orderQuad, shotCheck, type PCorner } from '../../shared/quad.ts';

export { orderQuad };
export type ScreenLook = 'hole' | 'preview';

export interface ScreenRect {
  /** Fractions of the output frame (0..1, top-left origin). */
  x: number; y: number; w: number; h: number;
  /** false when the screen isn't in the shot: a corner behind the camera or outside the frame, or a sliver
   *  (shared/quad.ts shotCheck — the same test that keeps the OBS hole closed). */
  visible: boolean;
}

/** World corners → projected (x, y fractions of the frame, top-left origin; z = NDC depth). */
export function projectCorners(world: THREE.Vector3[], camera: THREE.PerspectiveCamera): PCorner[] {
  camera.updateMatrixWorld();
  return world.map((w) => { const v = w.clone().project(camera); return [(v.x + 1) / 2, (1 - v.y) / 2, v.z] as PCorner; });
}
/** Projected corners → the bounding rect + whether the screen is in the shot. */
export function rectOf(c: PCorner[]): ScreenRect {
  const s = shotCheck(c);
  return { ...s.rect, visible: s.inShot };
}

/** The common face of the big react SCREEN and the solo side screen (src/scene/soloScreen.ts). */
export interface ReactSurface {
  /** 1 = wanted down (react), 0 = away. */
  target: number;
  /** Fully down (and settled). */
  readonly landed: boolean;
  /** 0..1 the OBS hole (or the preview picture) is open. */
  readonly holeOpen: number;
  /** Completely away (hidden, powered off). */
  readonly away: boolean;
  /** Fires once each time the screen lands (accent: lights dip, ON AIR). */
  onLand: (() => void) | null;
  update(dt: number, settled: boolean, time: number): void;
  finish(): void;
  setLook(look: ScreenLook): void;
  /** What the surface shows in 'preview' look (a shared window's VideoTexture, NO SIGNAL, …); null = placeholder. */
  setSource(tex: THREE.Texture | null): void;
  /** Aspect (w/h) of the source (a shared window) → letterboxed onto the surface; null = fill. */
  setSourceAspect(a: number | null): void;
  /** In-scene look: subtle scanlines / glass sheen. */
  setExtras(scanlines: boolean, glass: boolean): void;
  rect(camera: THREE.PerspectiveCamera): ScreenRect;
  quad(camera: THREE.PerspectiveCamera): [number, number][];
  /** The fully-down surface's 4 corners as a camera sees them (any order; z = NDC depth: in front of the camera when
   *  −1 < z < 1) — what decides whether the screen is in the shot at all. */
  corners(camera: THREE.PerspectiveCamera): PCorner[];
  frame(towards: THREE.Vector3): { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number };
  dispose(): void;
}

/** Auto, while the helper's fast window feed is starting: a dark screen waiting for its picture (a real monitor
 *  syncing), never a see-through hole. */
export function standbyTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 576;
  const g = c.getContext('2d')!;
  const bg = g.createRadialGradient(c.width / 2, c.height / 2, 40, c.width / 2, c.height / 2, c.width * 0.62);
  bg.addColorStop(0, '#0b1018'); bg.addColorStop(1, '#030507');
  g.fillStyle = bg; g.fillRect(0, 0, c.width, c.height);
  g.fillStyle = 'rgba(159,179,200,0.55)'; g.textAlign = 'right';
  g.font = '500 26px Inter, system-ui, sans-serif'; g.fillText('connecting…', c.width - 40, c.height - 36);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

/** In-scene capture with nothing shared (yet): a NO SIGNAL card. */
export function noSignalTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 576;
  const g = c.getContext('2d')!;
  const bars = ['#c0c0c0', '#c0c000', '#00c0c0', '#00c000', '#c000c0', '#c00000', '#0000c0'];
  bars.forEach((b, i) => { g.fillStyle = b; g.fillRect((i * c.width) / 7, 0, c.width / 7 + 1, c.height * 0.62); });
  g.fillStyle = '#10131a'; g.fillRect(0, c.height * 0.62, c.width, c.height * 0.38);
  g.fillStyle = 'rgba(8,10,14,0.82)'; g.fillRect(c.width * 0.18, c.height * 0.2, c.width * 0.64, c.height * 0.3);
  g.fillStyle = '#ffffff'; g.textAlign = 'center';
  g.font = '800 76px Inter, system-ui, sans-serif'; g.fillText('NO SIGNAL', c.width / 2, c.height * 0.39);
  g.fillStyle = '#9fb3c8'; g.font = '500 28px Inter, system-ui, sans-serif';
  g.fillText('Studio → Show → React screen → Pick a window', c.width / 2, c.height * 0.8);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function placeholderTexture(): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 1024; c.height = 576;
  const g = c.getContext('2d')!;
  g.fillStyle = '#0d1016'; g.fillRect(0, 0, c.width, c.height);
  g.strokeStyle = '#1f2633'; g.lineWidth = 2;
  for (let x = 0; x <= c.width; x += 64) { g.beginPath(); g.moveTo(x, 0); g.lineTo(x, c.height); g.stroke(); }
  for (let y = 0; y <= c.height; y += 64) { g.beginPath(); g.moveTo(0, y); g.lineTo(c.width, y); g.stroke(); }
  g.strokeStyle = '#4cc9f0'; g.lineWidth = 8; g.setLineDash([28, 18]); g.strokeRect(10, 10, c.width - 20, c.height - 20);
  g.setLineDash([]);
  g.fillStyle = '#e8eef7'; g.textAlign = 'center';
  g.font = '700 58px Inter, system-ui, sans-serif'; g.fillText('YOUR WINDOW GOES HERE', c.width / 2, c.height / 2 - 20);
  g.fillStyle = '#9fb3c8'; g.font = '500 30px Inter, system-ui, sans-serif';
  g.fillText('OBS: Window Capture below this browser source', c.width / 2, c.height / 2 + 40);
  g.fillText('(studio preview placeholder)', c.width / 2, c.height / 2 + 84);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export class ReactScreen implements ReactSurface {
  /** 0 = rolled up / hidden … 1 = fully down. */
  progress = 0;
  target = 0;
  onLand: (() => void) | null = null;
  private original: THREE.Material | THREE.Material[];
  private fx: ScreenFx;
  private seq = new PowerSeq();
  private wasLanded = false;
  private placeholder: THREE.CanvasTexture | null = null;
  private source: THREE.Texture | null = null;
  private plane: THREE.Vector3[];
  private topY: number;
  /** Texture flips so pictures read upright whatever way the room's UVs were authored. */
  private flip = { u: false, v: false };

  constructor(readonly info: ScreenInfo, private look: ScreenLook, towards = new THREE.Vector3(0, 1.2, 0)) {
    this.original = info.surface.material;
    const g = info.surface.geometry;
    g.computeBoundingBox();
    const b = g.boundingBox!;
    // plane corners in surface space (the thin axis is whichever extent is ~0)
    const s = b.getSize(new THREE.Vector3());
    const thin = s.x < s.y && s.x < s.z ? 'x' : s.y < s.z ? 'y' : 'z';
    const pts: THREE.Vector3[] = [];
    for (const u of [0, 1]) for (const v of [0, 1]) {
      const p = new THREE.Vector3();
      const axes = (['x', 'y', 'z'] as const).filter((a) => a !== thin);
      p[thin] = (b.min[thin] + b.max[thin]) / 2;
      p[axes[0]] = u ? b.max[axes[0]] : b.min[axes[0]];
      p[axes[1]] = v ? b.max[axes[1]] : b.min[axes[1]];
      pts.push(p);
    }
    this.plane = pts;
    // top edge in the node's own space (origins differ: centre, top-centre …) - the unroll fallback pins it
    info.node.updateWorldMatrix(true, true);
    const toNode = info.node.matrixWorld.clone().invert().multiply(info.surface.matrixWorld);
    this.topY = Math.max(...pts.map((c) => c.clone().applyMatrix4(toNode).y));
    this.flip = uvFlip(info, this.frame(towards).normal);
    this.fx = new ScreenFx(look === 'hole', true);
    this.fx.setFlip(this.flip.u, this.flip.v);
    info.surface.material = this.fx.material;
    this.setLook(look);
    this.apply();
  }

  get landed() { return this.progress >= 1; }
  get holeOpen() { return this.seq.open; }
  get away() { return this.progress <= 0 && this.seq.power <= 0; }

  setLook(look: ScreenLook) {
    this.look = look;
    const m = this.info.surface;
    this.fx.hole = look === 'hole';
    m.renderOrder = look === 'hole' ? -1 : 0;
    if (look === 'hole') { this.fx.setMap(null); return; }
    this.placeholder ??= placeholderTexture();
    this.fx.setMap(this.source ?? this.placeholder);
  }


  /** settled: the camera reached the react shot (the hole only opens then). */
  update(dt: number, settled = true, time = 0) {
    const want = this.target > 0.5;
    const off = this.seq.step(dt, want, this.landed, settled);
    // down: ~1.3 s with a little settle; up (only once the tube is off): ~0.8 s
    if (want && this.progress < 1) this.progress = Math.min(1, this.progress + dt / 1.3);
    else if (!want && off && this.progress > 0) this.progress = Math.max(0, this.progress - dt / 0.8);
    if (this.landed && !this.wasLanded) this.onLand?.();
    this.wasLanded = this.landed;
    this.fx.set(this.seq.power, this.seq.open, time);
    this.apply();
  }

  finish() { this.progress = this.target > 0.5 ? 1 : 0; this.seq.finish(this.target > 0.5); this.wasLanded = this.landed; this.fx.set(this.seq.power, this.seq.open, 0); this.apply(); }

  private apply() {
    const n = this.info.node, p = this.progress;
    const e = this.target >= this.progress ? easeOutBounceSoft(p) : p * p * (3 - 2 * p);
    n.visible = p > 0.001;
    n.position.copy(this.info.shownPosition);
    if (this.info.restOffsetY > 0) {
      n.position.y += this.info.restOffsetY * (1 - e);
      n.scale.y = 1;
    } else {
      // no rest offset authored: unroll from the top edge like a projector screen
      n.scale.y = Math.max(0.001, e);
      n.position.y += this.topY * (1 - e);
    }
  }

  setSource(tex: THREE.Texture | null) { this.source = tex; if (this.look === 'preview') this.setLook('preview'); }
  setExtras(scanlines: boolean, glass: boolean) { this.fx.setExtras(scanlines, glass); }
  setSourceAspect(a: number | null) {
    // surface aspect = its horizontal edge / its vertical edge (corners: u0v0, u0v1, u1v0, u1v1 along the plane's axes)
    const w = this.worldCorners();
    const e1 = w[2].clone().sub(w[0]), e2 = w[1].clone().sub(w[0]);
    const [hz, vt] = Math.abs(e1.y) < Math.abs(e2.y) ? [e1, e2] : [e2, e1];
    this.fx.setFit(a, hz.length() / Math.max(1e-6, vt.length()));
  }

  private worldCorners(): THREE.Vector3[] {
    const n = this.info.node;
    const saveP = n.position.clone(), saveS = n.scale.clone();
    n.position.copy(this.info.shownPosition); n.scale.y = 1;
    n.updateWorldMatrix(true, true);
    const w = this.plane.map((c) => c.clone().applyMatrix4(this.info.surface.matrixWorld));
    n.position.copy(saveP); n.scale.copy(saveS);
    n.updateWorldMatrix(true, true);
    return w;
  }

  /** The fully-down surface's 4 corners in a camera's frame (fractions, top-left origin), ordered TL, TR, BR, BL as
   *  seen — the exact passthrough hole (for an OBS corner-pin) even when the screen is angled. */
  quad(camera: THREE.PerspectiveCamera): [number, number][] {
    return orderQuad(this.corners(camera).map((p) => [p[0], p[1]] as [number, number]));
  }

  corners(camera: THREE.PerspectiveCamera): PCorner[] { return projectCorners(this.worldCorners(), camera); }

  /** Where the fully-down screen lands in a camera's frame (for the OBS window-capture crop numbers). */
  rect(camera: THREE.PerspectiveCamera): ScreenRect { return rectOf(this.corners(camera)); }

  /** World centre, normal (towards `towards`, e.g. the room centre) and size of the fully-down surface (auto react camera). */
  frame(towards: THREE.Vector3): { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number } {
    const n = this.info.node;
    const saveP = n.position.clone(), saveS = n.scale.clone();
    n.position.copy(this.info.shownPosition); n.scale.y = 1;
    n.updateWorldMatrix(true, true);
    const w = this.plane.map((c) => c.clone().applyMatrix4(this.info.surface.matrixWorld));
    n.position.copy(saveP); n.scale.copy(saveS);
    n.updateWorldMatrix(true, true);
    const center = w.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(0.25);
    // corners: (u0v0, u0v1, u1v0, u1v1)
    const du = w[2].clone().sub(w[0]), dv = w[1].clone().sub(w[0]);
    const normal = du.clone().cross(dv).normalize();
    const along = du.length() >= dv.length() ? du : dv, across = du.length() >= dv.length() ? dv : du;
    // face the room: the side the viewer is on (towards the room centre)
    if (towards.clone().sub(center).dot(normal) < 0) normal.negate();
    return { center, normal, width: along.length(), height: across.length() };
  }

  dispose() {
    this.info.surface.material = this.original;
    this.placeholder?.dispose();
    this.fx.dispose();
  }
}

/** Does the surface's U run right→left / V top→bottom for a viewer in front of it? (correlate UVs with world axes) */
function uvFlip(info: ScreenInfo, normal: THREE.Vector3): { u: boolean; v: boolean } {
  const g = info.surface.geometry, pos = g.attributes.position, uv = g.attributes.uv;
  if (!pos || !uv) return { u: false, v: false };
  info.node.updateWorldMatrix(true, true);
  const m = info.surface.matrixWorld;
  const up = new THREE.Vector3(0, 1, 0);
  up.addScaledVector(normal, -up.dot(normal));
  if (up.lengthSq() < 1e-6) up.set(0, 0, -1);
  up.normalize();
  const right = new THREE.Vector3().crossVectors(up, normal).normalize();   // viewer looks along -normal
  let cu = 0, cv = 0, mu = 0, mv = 0, mx = 0, my = 0;
  const n = pos.count, p = new THREE.Vector3(), P: [number, number][] = [];
  for (let i = 0; i < n; i++) { p.fromBufferAttribute(pos, i).applyMatrix4(m); P.push([p.dot(right), p.dot(up)]); mx += P[i][0]; my += P[i][1]; mu += uv.getX(i); mv += uv.getY(i); }
  mx /= n; my /= n; mu /= n; mv /= n;
  for (let i = 0; i < n; i++) { cu += (uv.getX(i) - mu) * (P[i][0] - mx); cv += (uv.getY(i) - mv) * (P[i][1] - my); }
  // three.js textures: flipY = true, so uv.v = 1 is the TOP of the picture
  return { u: cu < 0, v: cv < 0 };
}

function easeOutBounceSoft(k: number) {
  // ease-out with a small single bounce at the bottom (screen "drops" into place)
  if (k < 0.8) { const t = k / 0.8; return 1 - Math.pow(1 - t, 3) * 1.0 + 0.0; }
  const t = (k - 0.8) / 0.2;
  return 1 - Math.sin(t * Math.PI) * 0.025;
}
