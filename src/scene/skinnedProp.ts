// Themed chat monitor / support board (room skins, shared/screenSkin.ts): the same prop as chatRig.ts's HangingRig
// (placement, drop timing, alert pulse, the live chat canvas on a ScreenFx surface) with the room's housing and arrival
// from screenSkins.ts. The studio theme keeps HangingRig; chatScene.ts picks one per room.
import * as THREE from 'three';
import type { PropPlacement, RigKind } from './chatRig.ts';
import { PowerSeq, ScreenFx } from './screenFx.ts';
import { buildSkin, SkinDriver, type BuiltSkin } from './screenSkins.ts';
import type { SkinChoice } from './soloScreen.ts';

/** What chatScene.ts needs from a prop rig (HangingRig or SkinnedPropRig). */
export interface PropRig {
  target: number;
  pulse: number;
  onLand: (() => void) | null;
  readonly rig: THREE.Group;
  readonly place: PropPlacement;
  readonly H: number;
  readonly away: boolean;
  readonly down: boolean;
  update(dt: number, time: number): void;
  dispose(): void;
}

/** Does this room skin need the themed rig (anything but the plain studio look)? */
export const themedProp = (s: SkinChoice | null | undefined): s is SkinChoice => !!s && (s.spec.theme !== 'studio' || !!s.template);

export class SkinnedPropRig implements PropRig {
  target = 0;
  pulse = 0;
  onLand: (() => void) | null = null;
  readonly rig = new THREE.Group();
  readonly H: number;
  private fx: ScreenFx;
  private seq: PowerSeq;
  private skin: BuiltSkin;
  private drive: SkinDriver;
  private owned: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];

  constructor(readonly kind: RigKind, readonly place: PropPlacement, readonly aspect: number, map: THREE.Texture, choice: SkinChoice) {
    const W = place.width, H = (this.H = W * aspect);
    this.rig.name = `vtp:chat:${kind}`;
    this.rig.position.copy(place.center);
    this.rig.rotation.set(0, place.yaw, 0);
    this.fx = new ScreenFx(false);
    this.fx.setMap(map);
    this.fx.setStyle(choice.spec.powerOn);
    this.seq = new PowerSeq(choice.spec.powerOn === 'crt' ? 0.55 : 0.7, 0.25, 0.25, 0.15);
    const surf = new THREE.Mesh(this.own(new THREE.PlaneGeometry(W, H)), this.fx.material);
    surf.name = `vtp:chat:${kind}:surface`;
    const ceilLocal = Math.max(H / 2 + 0.45, place.ceilingY - place.center.y);
    this.skin = buildSkin(choice.spec, { prop: kind, W, H, ceilLocal, floorLocal: null, surface: surf, own: (x) => this.own(x), template: choice.template });
    this.rig.add(this.skin.root);
    this.drive = new SkinDriver(this.skin, choice.spec.motion, ceilLocal, null);
    this.drive.apply(0, 0);
    this.rig.visible = false;
  }
  private own<T extends THREE.Material | THREE.BufferGeometry | THREE.Texture>(x: T): T { this.owned.push(x); return x; }

  get away() { return this.drive.a <= 0 && this.seq.power <= 0; }
  get down() { return this.drive.landed && this.seq.power >= 1; }
  get lowered() { return this.drive.a; }

  update(dt: number, time: number) {
    const want = this.target > 0.5;
    const off = this.seq.step(dt, want, this.drive.landed, true);
    if (this.drive.step(dt, want, off)) this.onLand?.();
    this.pulse = Math.max(0, this.pulse - dt / 1.6);
    this.fx.set(this.seq.power, this.seq.open, time);
    this.drive.apply(time, this.seq.power, this.pulse);
    this.rig.visible = this.drive.visible;
  }

  finish() {
    const want = this.target > 0.5;
    this.drive.finish(want); this.seq.finish(want);
    this.fx.set(this.seq.power, this.seq.open, 0);
    this.drive.apply(0, this.seq.power);
    this.rig.visible = this.drive.visible;
  }

  corners(): THREE.Vector3[] {
    const W = this.place.width, H = this.H;
    const m = new THREE.Matrix4().compose(this.place.center, new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), this.place.yaw), new THREE.Vector3(1, 1, 1));
    return [[-1, -1], [1, -1], [-1, 1], [1, 1]].map(([x, y]) => new THREE.Vector3(x * W / 2, y * H / 2, 0).applyMatrix4(m));
  }

  dispose() {
    this.rig.removeFromParent();
    this.fx.dispose();
    for (const o of this.owned) o.dispose();
  }
}
