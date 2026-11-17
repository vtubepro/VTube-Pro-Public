// Feeds the 2D rigs' world (shared/rig2d/world.ts) from the OBS / preview page (src/output.ts, two one-line hooks):
//   feedRig2DWorld(stage, scene, level)  each frame: the room's key light (direction + colour, in the camera's view
//                                        space), the hemisphere light as fill + ambient, the light show's wash
//                                        colours, the environment's wind, the graphics level → tier;
//   rig2dChatHook(chatFeed)              chat messages + stream events (subs, raids, cheers, donations …) → events.
// With no room (classic stage) the stage's own key light is used; nothing here changes any light.
import * as THREE from 'three';
import { envWind } from '../../../scene/environment/index.ts';
import { pushRig2DEvent, setRig2DWorld, type Rig2DTier } from '../../../../shared/rig2d/world.ts';
import type { ChatEvent } from '../../../../shared/chat.ts';

interface StageLike { keyLight: THREE.DirectionalLight; camera: THREE.Camera; scene?: THREE.Scene }
interface SceneLike { lights?: unknown }

const dir = new THREE.Vector3(), tmp = new THREE.Vector3();
const lin = (c: THREE.Color, k: number): [number, number, number] => [c.r * k, c.g * k, c.b * k];

/** A graphics level ('performance' | 'balanced' | 'high' | 'ultra', or a tracking tier) → the rigs' tier. */
export function rig2dTierOf(level: string | undefined): Rig2DTier {
  if (level === 'performance' || level === 'low') return 'low';
  if (level === 'balanced' || level === 'medium') return 'medium';
  return 'high';
}

export function feedRig2DWorld(stage: StageLike, scene: SceneLike | null, level: string | undefined) {
  try {
    const key = stage.keyLight, cam = stage.camera;
    cam.updateMatrixWorld();
    // the direction the light travels (position → target), into the camera's view space
    dir.copy(key.target.getWorldPosition(tmp)).sub(key.getWorldPosition(new THREE.Vector3())).normalize();
    dir.transformDirection(cam.matrixWorldInverse);
    // key intensity 2 = a normal key (Stage default); colour linear
    const k = Math.min(2.5, key.intensity / 2);
    const root = (stage.scene ?? key.parent) as THREE.Object3D | null;
    const hemi = root?.children.find((l) => (l as THREE.HemisphereLight).isHemisphereLight) as THREE.HemisphereLight | undefined;
    const hk = hemi ? Math.min(2.5, hemi.intensity / 1.6) : 1;
    const sky = hemi ? lin(hemi.color, 0.45 * hk) : [0.45, 0.45, 0.48] as [number, number, number];
    const ground = hemi ? lin(hemi.groundColor, 0.3 * hk) : [0.3, 0.3, 0.33] as [number, number, number];
    const pal = (scene?.lights as { washPalette?: [THREE.Color, THREE.Color]; houseLevel?: number } | undefined);
    const show: [number, number, number] = pal?.washPalette ? lin(pal.washPalette[0].clone().lerp(pal.washPalette[1], 0.5), 0.35 * Math.min(1, pal.houseLevel ?? 0.5)) : [0, 0, 0];
    setRig2DWorld({
      key: { dir: [dir.x, dir.y, dir.z], color: lin(key.color, k) },
      // fill from below-front (the hemisphere's ground colour), ambient = its sky colour
      fill: { dir: [0, 0.6, -0.8], color: ground },
      ambient: sky, show,
      wind: envWind.active ? Math.min(2, envWind.strength) : 0.3,
      windDir: envWind.active && envWind.x < 0 ? -1 : 1,
      tier: rig2dTierOf(level),
    });
  } catch { /* the rigs keep their defaults */ }
}

/** Chat messages and stream events reach the rigs' state machines / particle triggers. */
export function rig2dChatHook(feed: { on(fn: (fresh: ChatEvent[], snap?: boolean) => void): unknown }) {
  feed.on((fresh, snap) => {
    if (snap) return; // a history snapshot on (re)connect is not "now"
    for (const e of fresh) {
      if (e.kind === 'chat') pushRig2DEvent('chat', e.text ?? '');
      else if (e.kind === 'finance' && e.fkind) {
        const k = e.fkind;
        const name = k === 'bits' ? 'cheer' : k === 'resub' || k === 'giftSub' || k === 'membership' || k === 'giftMembership' ? 'sub' : k === 'superchat' || k === 'supersticker' || k === 'tip' || k === 'rant' || k === 'wallet' ? 'donation' : k;
        pushRig2DEvent('event', name);
        if (name !== k) pushRig2DEvent('event', k);
      } else if (e.kind === 'system' && /follow/i.test(e.text ?? '')) pushRig2DEvent('event', 'follow');
    }
  });
}
