// Solo react screen: a screen that arrives beside the host (their camera-right). Generated rig, so any room gets one;
// its housing is the room's skin (shared/screenSkin.ts, src/scene/screenSkins.ts): the studio's motorised projector
// screen (ceiling plates → cables → a motor housing with an ON AIR lamp → the screen unrolls with a weighted bottom
// bar), Kingsmarch's rising scrying mirror, the Helldivers hologram, the Labs ceiling display, the Factory's chain-hoist
// tarp, the Dorms' bedsheet — or the room's own GLB node. Whatever the skin, the picture is the same flat W×H rectangle
// (in-scene capture draws on it, the OBS passthrough hole is exactly it): power-on (the skin's style) → the hole fades
// open once the camera has settled (screenFx.ts). Exit reverses it.
import * as THREE from 'three';
import type { ScreenLook, ScreenRect, ReactSurface } from './screen.ts';
import { orderQuad, placeholderTexture, projectCorners, rectOf } from './screen.ts';
import type { PCorner } from '../../shared/quad.ts';
import { PowerSeq, ScreenFx } from './screenFx.ts';
import { buildSkin, SkinDriver, SURF_Z, type BuiltSkin } from './screenSkins.ts';
import type { ResolvedSkinSpec } from '../../shared/screenSkin.ts';

export interface SoloPlacement {
  /** World centre of the shown screen surface. */
  center: THREE.Vector3;
  /** Yaw (rad) of the surface normal (the side the viewer is on). */
  yaw: number;
  /** Surface width (m); height = width × 9/16. */
  width: number;
  /** World height the cables hang from. */
  ceilingY: number;
  /** World height of the floor below (floor-standing skins: emitters, rune circles); null / missing = none found. */
  floorY?: number | null;
  /** Where it came from: 'node' (SCREEN_SOLO*), 'scene.json', or 'auto'. */
  source: string;
}

/** A resolved room skin (+ the room's template node for custom housings). */
export interface SkinChoice { spec: ResolvedSkinSpec; template: THREE.Object3D | null }
const STUDIO: SkinChoice = { spec: { theme: 'studio', motion: 'unroll', powerOn: 'crt', node: null, source: 'default', warnings: [] }, template: null };
const ON_DUR = { crt: 0.55, hologram: 0.8, shimmer: 0.9, fade: 0.7 } as const;

export class SoloScreen implements ReactSurface {
  target = 0;
  onLand: (() => void) | null = null;
  readonly rig = new THREE.Group();
  private surface: THREE.Mesh;
  private fx: ScreenFx;
  private seq: PowerSeq;
  private placeholder: THREE.CanvasTexture | null = null;
  private source: THREE.Texture | null = null;
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];
  private skin: BuiltSkin;
  private drive: SkinDriver;
  readonly H: number;

  constructor(readonly place: SoloPlacement, private look: ScreenLook, readonly skinChoice: SkinChoice = STUDIO) {
    const W = place.width, H = (this.H = W * 9 / 16);
    const spec = skinChoice.spec;
    this.rig.name = 'vtp:soloScreen';
    this.rig.position.copy(place.center);
    this.rig.rotation.set(0, place.yaw, 0);
    this.fx = new ScreenFx(look === 'hole', true);
    this.fx.setStyle(spec.powerOn);
    this.seq = new PowerSeq(ON_DUR[spec.powerOn] ?? 0.55, 0.3, 0.25, 0.2);
    this.surface = new THREE.Mesh(this.own(new THREE.PlaneGeometry(W, H)), this.fx.material);
    this.surface.name = 'vtp:soloSurface';
    const ceilLocal = Math.max(H / 2 + 0.5, place.ceilingY - place.center.y);
    const floorLocal = place.floorY != null && Number.isFinite(place.floorY) ? place.floorY - place.center.y : null;
    this.skin = buildSkin(spec, { prop: 'solo', W, H, ceilLocal, floorLocal, surface: this.surface, own: (x) => this.own(x), template: skinChoice.template });
    this.rig.add(this.skin.root);
    this.drive = new SkinDriver(this.skin, spec.motion, ceilLocal, floorLocal);
    this.setLook(look);
    this.drive.apply(0, 0);
    this.rig.visible = false;
  }

  private own<T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T): T { this.owned.push(x); return x; }

  get landed() { return this.drive.landed; }
  get holeOpen() { return this.seq.open; }
  get away() { return this.drive.a <= 0 && this.seq.power <= 0; }

  setLook(look: ScreenLook) {
    this.look = look;
    this.fx.hole = look === 'hole';
    this.surface.renderOrder = look === 'hole' ? -1 : 0;
    if (look === 'hole') { this.fx.setMap(null); return; }
    this.placeholder ??= placeholderTexture();
    this.fx.setMap(this.source ?? this.placeholder);
  }

  update(dt: number, settled: boolean, time: number) {
    const want = this.target > 0.5;
    const off = this.seq.step(dt, want, this.drive.landed, settled);
    if (this.drive.step(dt, want, off)) this.onLand?.();
    this.fx.set(this.seq.power, this.seq.open, time);
    this.drive.apply(time, this.seq.power);
    this.rig.visible = this.drive.visible;
  }

  finish() {
    const want = this.target > 0.5;
    this.drive.finish(want);
    this.seq.finish(want);
    this.fx.set(this.seq.power, this.seq.open, 0);
    this.drive.apply(0, this.seq.power);
    this.rig.visible = this.drive.visible;
  }

  setSource(tex: THREE.Texture | null) { this.source = tex; if (this.look === 'preview') this.setLook('preview'); }
  setSourceAspect(a: number | null) { this.fx.setFit(a, 16 / 9); }
  setExtras(scanlines: boolean, glass: boolean) { this.fx.setExtras(scanlines, glass); }

  /** The rest-pose rectangle's corners (world): the same for every skin. */
  private worldCorners(): THREE.Vector3[] {
    this.rig.updateWorldMatrix(true, false);
    const W = this.place.width, H = this.H;
    return [[-W / 2, -H / 2], [W / 2, -H / 2], [-W / 2, H / 2], [W / 2, H / 2]].map(([x, y]) => new THREE.Vector3(x, y, SURF_Z).applyMatrix4(this.rig.matrixWorld));
  }

  /** The fully-down surface's 4 corners in a camera's frame (fractions, top-left origin), ordered TL, TR, BR, BL as
   *  seen — the exact passthrough hole (for an OBS corner-pin) even when the screen is angled. */
  quad(camera: THREE.PerspectiveCamera): [number, number][] {
    return orderQuad(this.corners(camera).map((p) => [p[0], p[1]] as [number, number]));
  }

  corners(camera: THREE.PerspectiveCamera): PCorner[] { return projectCorners(this.worldCorners(), camera); }

  /** Where the fully-down surface lands in a camera's frame (`visible` = in the shot: shared/quad.ts shotCheck). */
  rect(camera: THREE.PerspectiveCamera): ScreenRect { return rectOf(this.corners(camera)); }

  frame(): { center: THREE.Vector3; normal: THREE.Vector3; width: number; height: number } {
    return { center: this.place.center.clone(), normal: new THREE.Vector3(Math.sin(this.place.yaw), 0, Math.cos(this.place.yaw)), width: this.place.width, height: this.H };
  }

  dispose() {
    this.rig.removeFromParent();
    this.placeholder?.dispose();
    this.fx.dispose();
    for (const o of this.owned) o.dispose();
  }
}
