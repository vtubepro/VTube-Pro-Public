// The chat audience on an output page (src/output.ts calls installAudience once; then attach / detach / update with the
// other room engines and setView on {type:'audience'} bus messages). Live pages fetch the server's current view at load
// (pages that open mid-show seat everyone at once); test pages (?sceneTest) never ask the server: &audienceDemo=<n> runs
// the scripted demo (demo.ts) instead.
import * as THREE from 'three';
import { api } from '../../api.ts';
import type { ChatFeed } from '../../chat/feed.ts';
import type { SceneChatState } from '../../../shared/chat.ts';
import type { CrowdScene } from '../crowd/crowdScene.ts';
import type { SceneRuntime } from '../SceneRuntime';
import { AudienceScene } from './audienceScene.ts';
import { AudienceDemo } from './demo.ts';
import { audienceShots } from './cams.ts';
import { lookPose } from '../cameraRig.ts';

export interface AudienceInstall {
  scene: AudienceScene;
  demo: AudienceDemo | null;
  /** vtpOut.audience (debug / tests) */
  hooks: { scene: AudienceScene; demo: AudienceDemo | null; info: () => unknown; look: (rt: SceneRuntime | null, pos: [number, number, number] | null, target?: [number, number, number], fov?: number) => boolean; shot: (rt: SceneRuntime | null, kind: 'asker' | 'reaction' | 'wide') => boolean; shots: typeof audienceShots };
}

export function installAudience(o: { feed: ChatFeed; crowd: CrowdScene | null; live: boolean; chatState: () => SceneChatState | undefined; test: URLSearchParams | null }): AudienceInstall {
  const scene = new AudienceScene(o.crowd);
  o.feed.on((fresh, snap) => scene.onChat(fresh, snap, o.chatState()));
  if (o.live) void api.get<unknown>('/api/audience/view').then((v) => { if (v) scene.setView(v); }).catch(() => { /* no answer: no audience */ });
  // the seats this page's room has: the server hands out no more (a 20-seat room on the default 80 would otherwise keep
  // the first 20 chatters in sight all stream); on attach and every 30 s while there is a room
  if (o.live) {
    const page = Math.random().toString(36).slice(2, 10);
    const report = (n: number) => { if (n > 0) void fetch('/api/audience/seats', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ n, page }) }).catch(() => { /* offline */ }); };
    scene.onSeats = report;
    setInterval(() => report(scene.seatCount()), 30_000);
  }
  let demo: AudienceDemo | null = null;
  const n = o.test ? parseInt(o.test.get('audienceDemo') || '', 10) : NaN;
  if (Number.isFinite(n) && n > 0) {
    demo = new AudienceDemo(scene, Math.min(200, n), o.feed);
    const at = parseFloat(o.test!.get('audienceAt') || '');
    setTimeout(() => { if (Number.isFinite(at)) demo!.at(at); else demo!.play(); }, 0);
  }
  let testCam: SceneRuntime['cameraOverride'] = null;
  const hooks: AudienceInstall['hooks'] = {
    scene, demo, shots: audienceShots,
    info: () => scene.info(),
    /** Test pages: hold the camera at a pose (world space) through the room's camera override; null = release. */
    look: (rt: SceneRuntime | null, pos: [number, number, number] | null, target?: [number, number, number], fov = 40) => {
      if (!rt) return false;
      const h = rt as unknown as { cameraOverride: SceneRuntime['cameraOverride'] };
      if (!pos) { if (testCam && h.cameraOverride === testCam) h.cameraOverride = (testCam as unknown as { prev: SceneRuntime['cameraOverride'] }).prev; testCam = null; return true; }
      const pose = lookPose(new THREE.Vector3(...pos), new THREE.Vector3(...(target ?? [0, 1, 0])), fov);
      const prev = testCam ? (testCam as unknown as { prev: SceneRuntime['cameraOverride'] }).prev : h.cameraOverride;
      const f = (() => ({ key: `audience-test:${pos.join(',')}`, pose, secs: 0 })) as NonNullable<SceneRuntime['cameraOverride']>;
      (f as unknown as { prev: SceneRuntime['cameraOverride'] }).prev = prev;
      testCam = f; h.cameraOverride = f;
      return true;
    },
    /** Test pages: the audience's own shot ('asker' | 'reaction' | 'wide') as a held camera. */
    shot: (rt: SceneRuntime | null, kind: 'asker' | 'reaction' | 'wide') => {
      const p = audienceShots.pose(kind, rt?.stage.camera.aspect ?? 16 / 9);
      if (!p || !rt) return false;
      const t = p.position.clone().add(new THREE.Vector3(0, 0, -1).applyQuaternion(p.quaternion));
      return hooks.look(rt, p.position.toArray() as [number, number, number], t.toArray() as [number, number, number], p.fov);
    },
  };
  return { scene, demo, hooks };
}
