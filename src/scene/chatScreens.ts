// In-world chat screens the performer placed with the Room editor (shared/roomEdits.ts ChatScreen, docs/ROOM_EDITOR.md →
// "Chat in the room"): any number (≤ 8) anywhere in a room, each with its own size, opacity, frame and facing. They show
// the live chat whenever the chat is "In the room" (SceneState.chat.monitor, with the same "only while chat is active"
// rule as the automatic monitor) and REPLACE the automatic chat monitor in that room.
//
// Readable at any size: each screen's canvas is sized to the panel (px per metre, capped) and the text is measured on a
// fixed reference width, so a bigger screen shows MORE lines at the same text size — never stretched text (ChatCanvas
// textRefW); `text` scales it. Owned by ChatScene (src/scene/chatScene.ts), which feeds it the chat each frame.
import * as THREE from 'three';
import type { SceneChatState } from '../../shared/chat.ts';
import type { ChatScreen } from '../../shared/roomEdits.ts';
import { ChatCanvas } from '../chat/chatCanvas.ts';
import type { ChatFeed } from '../chat/feed.ts';
import type { SceneRuntime } from './SceneRuntime.ts';

/** Canvas px per metre of screen (text reference: a 0.9 m wide monitor = 600 px wide text), capped per screen. */
const PX_PER_M = 640, MAX_PX = 1600, REF_W_M = 0.9;
const registry = new WeakMap<SceneRuntime, ChatScreens>();
/** The chat screens of a room (the Room editor moves them live while dragging). */
export const chatScreensOf = (rt: SceneRuntime) => registry.get(rt) ?? null;

interface Built { c: ChatScreen; obj: THREE.Group; canvas: ChatCanvas; panel: THREE.Mesh; mats: THREE.Material[]; geos: THREE.BufferGeometry[] }

export class ChatScreens {
  /** The Room editor page shows them all the time (to place them), whatever the chat setting. */
  static alwaysShow = false;
  readonly group = new THREE.Group();
  readonly objects = new Map<string, THREE.Group>();
  private built: Built[] = [];
  private sig = '';
  private infoRef: unknown = null;
  private shown = 0;
  live: Record<string, boolean> = {};

  constructor(private rt: SceneRuntime) {
    this.group.name = 'vtp:chatScreens';
    rt.room.root.add(this.group);
    registry.set(rt, this);
  }
  /** Placed chat screens in this room (the automatic monitor stays away while there are any). */
  get count() { return this.built.length; }

  private list(): ChatScreen[] { return ((this.rt.info as { chatScreens?: ChatScreen[] }).chatScreens ?? []).slice(0, 8); }

  private rebuild(list: ChatScreen[]) {
    this.clear();
    for (const c of list) {
      const wpx = Math.min(MAX_PX, c.width * PX_PER_M), k = wpx / (c.width * PX_PER_M);
      const canvas = new ChatCanvas('monitor', Math.max(64, Math.round(wpx)), Math.max(64, Math.round(Math.min(MAX_PX, c.height * PX_PER_M * k))));
      canvas.textRefW = REF_W_M * PX_PER_M * k * c.text;   // (text px = 29 × font × textRefW / 600: the same size in metres on any screen)
      canvas.live = this.live;
      const obj = new THREE.Group();
      obj.name = `chatScreen:${c.uid}`;
      obj.userData.vtpChatScreen = c.uid;
      const geos: THREE.BufferGeometry[] = [], mats: THREE.Material[] = [];
      const pg = new THREE.PlaneGeometry(c.width, c.height); geos.push(pg);
      const pm = new THREE.MeshBasicMaterial({ map: canvas.texture, transparent: true, opacity: c.opacity, toneMapped: false, depthWrite: c.opacity >= 0.99 }); mats.push(pm);
      const panel = new THREE.Mesh(pg, pm);
      panel.userData.vtpChatScreen = c.uid;
      obj.add(panel);
      if (c.frame) {
        const fg = new THREE.BoxGeometry(c.width + 0.06, c.height + 0.06, 0.04).translate(0, 0, -0.025); geos.push(fg);
        const fm = new THREE.MeshStandardMaterial({ color: 0x10141c, roughness: 0.6, metalness: 0.3, transparent: true, opacity: c.opacity }); mats.push(fm);
        const frame = new THREE.Mesh(fg, fm);
        frame.userData.vtpChatScreen = c.uid;
        const eg = new THREE.BoxGeometry(c.width + 0.07, 0.012, 0.045).translate(0, -c.height / 2 - 0.03, -0.02); geos.push(eg);
        const em = new THREE.MeshBasicMaterial({ color: 0x35e3ff, transparent: true, opacity: c.opacity }); mats.push(em);
        obj.add(frame, new THREE.Mesh(eg, em));
      }
      place(obj, c);
      obj.visible = false;
      this.group.add(obj);
      this.objects.set(c.uid, obj);
      this.built.push({ c, obj, canvas, panel, mats, geos });
    }
  }

  /** Each frame (ChatScene.step): follow the room's layer, fade in / out, face the camera, redraw the chat on change. */
  update(dt: number, feed: ChatFeed, st: SceneChatState, want: boolean) {
    if (this.rt.info !== this.infoRef) {
      this.infoRef = this.rt.info;
      const list = this.list(), sig = JSON.stringify(list);
      if (sig !== this.sig) { this.sig = sig; this.rebuild(list); }
    }
    if (!this.built.length) return;
    const on = want || ChatScreens.alwaysShow;
    this.shown = THREE.MathUtils.clamp(this.shown + (on ? dt : -dt) / 0.35, 0, 1);
    const cam = this.rt.stage.camera;
    const now = Date.now();
    for (const b of this.built) {
      b.obj.visible = this.shown > 0.001;
      if (!b.obj.visible) continue;
      b.obj.scale.setScalar(0.85 + 0.15 * this.shown);
      for (const m of b.mats) (m as THREE.MeshBasicMaterial).opacity = b.c.opacity * this.shown;
      if (b.c.face === 'camera') {
        const w = b.obj.getWorldPosition(new THREE.Vector3());
        const to = cam.position.clone().sub(w);
        const parentQ = b.obj.parent ? b.obj.parent.getWorldQuaternion(new THREE.Quaternion()) : new THREE.Quaternion();
        to.applyQuaternion(parentQ.invert());
        b.obj.rotation.set(0, Math.atan2(to.x, to.z), 0, 'YXZ');
      }
      b.canvas.update(feed, st, now);
    }
  }

  private clear() {
    for (const b of this.built) { b.obj.removeFromParent(); for (const g of b.geos) g.dispose(); for (const m of b.mats) m.dispose(); b.canvas.texture.dispose(); }
    this.built = [];
    this.objects.clear();
  }
  dispose() { this.clear(); this.group.removeFromParent(); registry.delete(this.rt); }
}

/** Put a chat screen's object where its entry says (room space). */
export function place(o: THREE.Object3D, c: Pick<ChatScreen, 'pos' | 'yaw' | 'pitch'>) {
  o.position.set(...c.pos);
  o.rotation.set(THREE.MathUtils.degToRad(c.pitch ?? 0), THREE.MathUtils.degToRad(c.yaw), 0, 'YXZ');
}
