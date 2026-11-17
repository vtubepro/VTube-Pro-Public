// ChatScene: the in-world chat + support props of a room (SceneState.chat, host-owned → identical on the studio
// preview, OBS and guests' OBS): the drop-down CHAT MONITOR, the neon SUPPORT board, and the chat buddy with the tablet.
// Attached to the current SceneRuntime by the page (output.ts); costs nothing while every option is off.
//
// Placement follows the CURRENT shot (SceneRuntime.resolveCamera of state.camera — never the walk-in follow cam):
// authored anchors first (CHAT_MONITOR_xx / CHAT_MONITOR, CHAT_BOARD_xx / CHAT_BOARD, CHAT_BUDDY_xx / CHAT_BUDDY nodes,
// or scene.json chatMonitors / chatBoards / chatBuddy keyed by SPOT_xx), else chatPlace.ts. A prop whose place is
// still good for a new shot stays; otherwise it winches up and drops again at the new place (the chat buddy walks).
// Support events → alert: the board (or the monitor's strip) shows a big card + flashes, confetti + sparks, the chat buddy
// hops, and the light engine gets cue('donation') (or 'screenLand' if it doesn't know that cue).
import * as THREE from 'three';
import { chatAlerts, DEFAULT_CHAT_STATE, type ChatEvent, type SceneChatState } from '../../shared/chat.ts';
import { HOST_KEY } from '../../shared/scene.ts';
import { ChatCanvas } from '../chat/chatCanvas.ts';
import type { ChatFeed } from '../chat/feed.ts';
import { ChatBuddy, BUDDY_AVATAR } from './chatBuddy.ts';
import { planStillGood, planTablet, type BuddyPlanInput, type TabletPlan } from './chatBuddyPlace.ts';
import { hash32, planRoam, type RoamSet } from './chatBuddyRoam.ts';
import { camOf, checkProp, performerRects, rectOf, rectOverlap, searchProp, type Performer, type PropSearch, type Rect, type ShotContext } from './chatPlace.ts';
import { Confetti, HangingRig, type PropPlacement } from './chatRig.ts';
import { SkinnedPropRig, themedProp, type PropRig } from './skinnedProp.ts';
import type { SceneRuntime } from './SceneRuntime.ts';
import { RoomRays } from './twoShot.ts';
import { ChatScreens } from './chatScreens.ts';

type Job<T> = { key: string; gen: Generator<void, T, void> };
const MONITOR_ASPECT = 4 / 3;     // portrait: height = width × 4/3
const BOARD_ASPECT = 9 / 16;

interface PropSlot {
  kind: 'monitor' | 'board';
  canvas: ChatCanvas;
  rig: PropRig | null;
  /** Placement to build once the current rig is away. */
  next: PropPlacement | null;
  key: string;
  job: Job<{ place: PropPlacement } | null> | null;
  side: number;
  failed: boolean;
}

export class ChatScene {
  private rt: SceneRuntime | null = null;
  private rays: RoomRays | null = null;
  private monitor: PropSlot = { kind: 'monitor', canvas: new ChatCanvas('monitor', 600, 800), rig: null, next: null, key: '', job: null, side: 0, failed: false };
  private board: PropSlot = { kind: 'board', canvas: new ChatCanvas('board', 800, 450), rig: null, next: null, key: '', job: null, side: 0, failed: false };
  private buddy: ChatBuddy | null = null;
  private buddyKey = '';
  private buddyJob: Job<TabletPlan> | null = null;
  /** Roam mode: the roam set search for the current shot (chatBuddyRoam.ts). */
  private roamJob: Job<RoamSet> | null = null;
  /** Last frame's camera (a jump = a cut: the chat buddy is moved during it, never mid-shot). */
  private camP: THREE.Vector3 | null = null;
  private camQ = new THREE.Quaternion();
  private buddyIn = false;
  private confetti = new Confetti();
  private alerts: ChatEvent[] = [];
  private alertT = 99;
  private shotKey = '';
  private shotT = 0;
  private time = 0;
  private off: () => void;
  private lastRev = -1;
  /** Test pages: time only advances through update() (mirrors the mover's manual clock). */
  manual = false;
  /** Something needs the stage (a raid event / raid-camera shot, src/scene/raid): monitor + board winch up meanwhile. */
  hold = false;
  /** While holding: only these props winch up ('chatMonitor', 'chatBoard'); null = both. */
  holdOnly: string[] | null = null;

  constructor(readonly feed: ChatFeed) {
    this.off = feed.on((fresh, snap) => this.onEvents(fresh, snap));
  }

  get state(): SceneChatState { return this.rt?.state.chat ?? DEFAULT_CHAT_STATE; }
  private get anyOn() { const s = this.state; return s.monitor || s.panel !== 'off' || s.buddy; }

  attach(rt: SceneRuntime) {
    if (this.rt === rt) return;
    this.detach();
    this.rt = rt;
    this.rays = null;
    rt.root.add(this.confetti.points);
    this.shotKey = '';
    this.screens = new ChatScreens(rt);   // the performer's own chat screens (Room editor, src/scene/chatScreens.ts)
    this.screens.live = this.monitor.canvas.live;
  }

  detach() {
    for (const s of [this.monitor, this.board]) { s.rig?.dispose(); s.rig = null; s.next = null; s.job = null; s.key = ''; }
    this.buddy?.dispose(); this.buddy = null; this.buddyIn = false; this.buddyKey = ''; this.buddyJob = null; this.roamJob = null; this.camP = null;
    this.confetti.points.removeFromParent();
    this.screens?.dispose(); this.screens = null;
    this.rt = null;
  }

  /** Header connection lights (platform → live). */
  setLive(live: Record<string, boolean>) { this.monitor.canvas.live = live; this.board.canvas.live = live; if (this.buddy) this.buddy.canvas.live = live; if (this.screens) this.screens.live = live; }
  /** The performer's own in-world chat screens (they replace the automatic monitor in their room). */
  private screens: ChatScreens | null = null;

  // ---------------------------------------------------------------- events → reactions
  private onEvents(fresh: ChatEvent[], snap: boolean) {
    if (snap || !this.rt) return;
    const st = this.state;
    for (const e of fresh) {
      if (e.kind === 'chat') this.buddy?.talk(Date.now());
      if (chatAlerts(e, st) && (st.panel !== 'off' || st.buddy || st.monitor)) { this.alerts.push(e); if (this.alerts.length > 12) this.alerts.shift(); }
    }
  }

  private playAlert(e: ChatEvent) {
    const st = this.state;
    const slot = st.panel === 'panel' ? this.board : st.panel === 'monitor' || st.monitor ? this.monitor : null;
    const at = Date.now();
    if (slot) slot.canvas.alert = { e, at };
    if (slot === this.monitor && st.panel !== 'monitor') slot.canvas.alert = null;       // the plain monitor just shows the card in the list
    const rig = slot?.rig && slot.rig.down ? slot.rig : this.board.rig?.down ? this.board.rig : this.monitor.rig?.down ? this.monitor.rig : null;
    const tier = e.tier ?? '#ffd84a';
    const colors = [tier, '#ffffff', '#ff4fd8', '#35e3ff', '#ffd84a', '#7cff6b'];
    let seed = 0; for (const ch of e.id) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    if (rig) {
      rig.pulse = 1;
      const top = rig.place.center.clone().add(new THREE.Vector3(0, rig.H / 2 + 0.2, 0));
      const n = new THREE.Vector3(Math.sin(rig.place.yaw), 0, Math.cos(rig.place.yaw));
      this.confetti.burst(top, n, colors, 170, seed);
    } else if (this.buddy?.shown) {
      this.confetti.burst(this.buddy.actor.mount.position.clone().setY(1.4), new THREE.Vector3(0, 0, 1).applyQuaternion(this.buddy.actor.mount.quaternion), colors, 120, seed);
    }
    this.buddy?.cheer();
    // the light engine's celebration (photosensitivity-gated inside it)
    const L = this.rt?.lights as unknown as { cue?: (w: string) => void; cues?: string[] } | undefined;
    // the kind of celebration (shared/lightStyles.ts cueEval) when the engine knows it: raids, subs, micro-gifts, big ones
    const f = e.fkind ?? '', usd = e.usd ?? 0;
    const kind = f === 'raid' ? 'raid' : /sub|member|milestone/i.test(f) ? 'sub' : f === 'kicks' || f === 'jewels' ? 'bits' : usd >= 50 ? 'big' : 'donation';
    try { L?.cue?.(L.cues?.includes(kind) ? kind : L.cues?.includes('donation') ? 'donation' : 'screenLand'); } catch { /* optional hook */ }
  }

  // ---------------------------------------------------------------- per frame
  /** Cost of update() (ms, smoothed / peak) — vtpOut.chat.debug(). */
  private perf = { avg: 0, peak: 0, redraws: 0 };
  update(dt: number) {
    const t0 = performance.now();
    this.step(dt);
    const ms = performance.now() - t0;
    this.perf.avg = this.perf.avg * 0.97 + ms * 0.03;
    this.perf.peak = Math.max(this.perf.peak * 0.995, ms);
  }
  private step(dt: number) {
    const rt = this.rt;
    if (!rt) return;
    this.time += dt;
    const st = this.state;
    // the performer's own chat screens: shown like the monitor (chat in the room, active, not held by an event)
    const on = !st.autoDrop || Date.now() - this.feed.lastChatAt < st.idleSecs * 1000;
    this.screens?.update(dt, this.feed, st, st.monitor && on && !(this.hold && (!this.holdOnly || this.holdOnly.includes('chatMonitor'))));
    const idle = !this.anyOn && !this.monitor.rig && !this.board.rig && !this.buddy && !this.confetti.points.visible;
    if (idle) { this.alerts.length = 0; return; }
    // re-plan on shot / roster / option changes (checked every 0.3 s — resolveCamera is cheap)
    this.shotT -= dt;
    if (this.shotT <= 0 || rt.state.rev !== this.lastRev) { this.shotT = 0.3; this.lastRev = rt.state.rev; this.replan(); }
    this.stepJobs();
    // The chat buddy waited for the monitor / board to find their places (or a re-plan was asked for): plan him now
    if (st.buddy && !this.buddyKey && !this.buddyJob && this.lastCtx && this.shotKey) this.planBuddy(this.lastCtx, this.shotKey);
    // monitor: shown when on (and chat is active, with auto-drop) and placed
    const active = !st.autoDrop || Date.now() - this.feed.lastChatAt < st.idleSecs * 1000;
    const held = (p: string) => this.hold && (!this.holdOnly || this.holdOnly.includes(p));
    this.drive(this.monitor, st.monitor && active && !held('chatMonitor') && !this.screens?.count, dt);
    this.drive(this.board, st.panel === 'panel' && !held('chatBoard'), dt);
    // alerts, one at a time
    this.alertT += dt;
    if (this.alerts.length && this.alertT > 7.5) { this.alertT = 0; this.playAlert(this.alerts.shift()!); }
    this.confetti.update(dt, this.time);
    // canvases (only while visible; redraw only on change)
    const now = Date.now();
    if (this.monitor.rig?.rig.visible && this.monitor.canvas.update(this.feed, st, now)) this.perf.redraws++;
    if (this.board.rig?.rig.visible && this.board.canvas.update(this.feed, st, now)) this.perf.redraws++;
    // the chat buddy
    this.driveBuddy(dt, st);
  }

  private drive(s: PropSlot, want: boolean, dt: number) {
    if (s.rig) {
      const stale = !!s.next;
      s.rig.target = want && !stale && !s.failed ? 1 : 0;
      s.rig.update(dt, this.time);
      if (s.rig.away && (stale || !want || s.failed)) { s.rig.dispose(); s.rig = null; }
    }
    if (!s.rig && want && s.next) {
      // the room's skin (shared/screenSkin.ts): a themed housing, or the studio's HangingRig
      const skin = this.rt!.skins?.[s.kind];
      const asp = s.kind === 'monitor' ? MONITOR_ASPECT : BOARD_ASPECT;
      s.rig = themedProp(skin) ? new SkinnedPropRig(s.kind, s.next, asp, s.canvas.texture, skin) : new HangingRig(s.kind, s.next, asp, s.canvas.texture);
      s.rig.onLand = () => { /* the lamp flashes; no light dip for props */ };
      this.rt!.root.add(s.rig.rig);
      s.next = null;
      s.rig.target = 1;
    }
  }

  // ---------------------------------------------------------------- planning
  private context(): ShotContext | null {
    const rt = this.rt!;
    const aspect = rt.stage.camera.aspect || 16 / 9;
    const shot = rt.resolveCamera(rt.state.camera, aspect);
    this.ctxShot = shot.key;
    this.rays ??= new RoomRays(rt.room);
    const performers: Performer[] = [];
    let anchor: Performer | null = null;
    const focusKey = rt.state.camera === 'talk' ? rt.state.focus : HOST_KEY;
    for (const a of rt.actors.values()) {
      if (!a.runtime || !a.spot || rt.state.present[a.key] === false) continue;
      const face = a.faceAt(a.spot);
      if (!face) continue;
      const p: Performer = { face, floor: a.spot.position.clone().setY(0), height: (a.rest?.height ?? 1.6) * a.scale, host: a.key === HOST_KEY };
      performers.push(p);
      if (a.key === focusKey || (!anchor && a.key === HOST_KEY)) anchor = p;
    }
    anchor ??= performers[0] ?? null;
    const cam = camOf(shot.pose, aspect);
    const keepOut: Rect[] = [];
    if (rt.state.mode === 'react') {
      const lay = rt.layout();
      const r = lay === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (r) keepOut.push({ x0: r.x, y0: r.y, x1: r.x + r.w, y1: r.y + r.h });
    }
    this.lastCtx = { pose: shot.pose, aspect, performers, keepOut, rays: this.rays, anchor, spots: rt.room.spots.filter((s) => !!s).map((s) => s!.position.clone().setY(0)) };
    return this.lastCtx;
  }

  private preKey = '';
  private preAt = 0;
  private ctxShot = '';
  /** The last planning context (the live check reuses it instead of resolving the shot again). */
  private lastCtx: ShotContext | null = null;
  private replan() {
    const rt = this.rt!, st = this.state;
    if (!this.anyOn) { this.monitor.next = null; this.board.next = null; if (this.buddy) this.planBuddyOff(); return; }
    const who = [...rt.actors.values()].filter((a) => a.spot && rt.state.present[a.key] !== false).map((a) => `${a.key}@${a.spot!.index}`).sort().join(',');
    // cheap pre-check: resolving the shot + the performers' faces costs a few ms (camera ray tests) — only when
    // something that picks the shot changed, a re-plan was asked for, or every 2 s as a safety net
    // (the solo screen landing / leaving changes what must stay clear: plan again then)
    const sp = rt.solo?.place.center;
    const solo = rt.state.mode === 'react' && rt.layout() === 'solo' ? `${sp ? `${sp.x.toFixed(1)},${sp.y.toFixed(1)},${sp.z.toFixed(1)}` : '-'}${rt.soloPending ? 'p' : ''}` : '';
    const pre = `${rt.state.camera}|${rt.state.focus}|${rt.state.mode}|${rt.layout()}|${solo}|${who}|${JSON.stringify(st)}|${rt.stage.camera.aspect.toFixed(3)}`;
    const nowMs = performance.now();
    if (this.shotKey && pre === this.preKey && nowMs - this.preAt < 2000) return;
    this.preKey = pre; this.preAt = nowMs;
    const ctx = this.context();
    if (!ctx) return;
    // (what must stay clear — the react / solo screen once it has landed — is part of the shot too)
    const keep = ctx.keepOut.map((r) => [r.x0, r.y0, r.x1, r.y1].map((v) => v.toFixed(2)).join(',')).join(';');
    const key = `${this.ctxShot}|${rt.state.mode}|${rt.layout()}|${solo}|${keep}|${who}|${st.side}|${st.size.toFixed(2)}|${st.panel}|${st.monitor}|${st.buddy}|${ctx.aspect.toFixed(3)}|${st.buddyModel}|${st.tablet}|${st.tabletText}|${st.font}|${st.buddyMode}|${st.buddyRange}`;
    if (key === this.shotKey) return;
    this.shotKey = key;
    const spot = rt.actors.get(HOST_KEY)?.spot ?? null;
    // monitor first, then the board (avoids the monitor), then the chat buddy (avoids both)
    if (st.monitor) this.planProp(this.monitor, ctx, { aspect: MONITOR_ASPECT, frac: 0.5 * st.size, minH: 0.5, maxH: 1.7 * st.size, side: st.side, prevSide: this.monitor.side, vPref: 0.47, authored: this.authored('MONITOR', spot?.index ?? -1, MONITOR_ASPECT) }, key);
    if (st.panel === 'panel') {
      const mRect = this.propRect(this.monitor, ctx);
      const ctx2 = { ...ctx, keepOut: mRect ? [...ctx.keepOut, mRect] : ctx.keepOut };
      const side = st.side === 'auto' ? (this.monitor.side ? (-this.monitor.side > 0 ? 'right' : 'left') : 'auto') : st.side === 'left' ? 'right' : 'left';
      this.planProp(this.board, ctx2, { aspect: BOARD_ASPECT, frac: 0.3 * st.size, minH: 0.35, maxH: 1.1 * st.size, side: st.monitor ? side as PropSearch['side'] : st.side, prevSide: this.board.side, vPref: 0.3, authored: this.authored('BOARD', spot?.index ?? -1, BOARD_ASPECT) }, key);
    }
    if (st.buddy) this.planBuddy(ctx, key);
    else this.planBuddyOff();
  }

  private propRect(s: PropSlot, ctx: ShotContext): Rect | null {
    const pl = s.next ?? s.rig?.place;
    if (!pl) return null;
    const cam = camOf(ctx.pose, ctx.aspect);
    const asp = s.kind === 'monitor' ? MONITOR_ASPECT : BOARD_ASPECT;
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), pl.yaw);
    const W = pl.width, H = W * asp;
    const r = rectOf([[-1, -1], [1, 1], [-1, 1], [1, -1]].map(([x, y]) => new THREE.Vector3(x * W / 2, y * H / 2 + (y > 0 ? 0.25 : 0), 0).applyQuaternion(q).add(pl.center)), cam);
    return { x0: r.x0 - 0.01, y0: r.y0 - 0.01, x1: r.x1 + 0.01, y1: r.y1 + 0.01 };
  }

  private planProp(s: PropSlot, ctx: ShotContext, search: PropSearch, key: string) {
    // still a good place for this shot? keep it
    const cur = s.rig && !s.next ? s.rig.place : s.next;
    if (cur) {
      const c = checkProp(ctx, search, cur);
      const hf = c.rect.y1 - c.rect.y0;
      if (c.ok && hf > search.frac * 0.55 && hf < search.frac * 1.7) { s.key = key; s.job = null; s.failed = false; return; }
    }
    s.key = key;
    s.job = { key, gen: searchProp(ctx, search) };
  }

  private authored(kind: 'MONITOR' | 'BOARD' | 'BUDDY', spotIndex: number, aspect: number): PropPlacement[] {
    const rt = this.rt!, rays = this.rays!;
    const out: PropPlacement[] = [];
    const spotName = spotIndex >= 0 ? `SPOT_${String(spotIndex + 1).padStart(2, '0')}` : '';
    const want = new Set([`CHAT_${kind}_${String(spotIndex + 1).padStart(2, '0')}`, `CHAT_${kind}`]);
    rt.room.root.traverse((o) => {
      if (!want.has(o.name)) return;
      if (o.name === `CHAT_${kind}` && spotIndex >= 0 && rt.room.spots[spotIndex] && o.getWorldPosition(new THREE.Vector3()).distanceTo(rt.room.spots[spotIndex]!.position) > 4.5) return;
      const p = o.getWorldPosition(new THREE.Vector3());
      const f = new THREE.Vector3(0, 0, 1).applyQuaternion(o.getWorldQuaternion(new THREE.Quaternion()));
      const wx = Number((o.userData as Record<string, unknown>).width);
      const width = Number.isFinite(wx) && wx > 0.2 ? wx : kind === 'MONITOR' ? 0.9 : 1.4;
      out.push({ center: p, yaw: Math.atan2(f.x, f.z), width, ceilingY: rays.ceilingAbove(p) ?? p.y + width * aspect / 2 + 1.2, source: 'node' });
    });
    const key = kind === 'MONITOR' ? 'chatMonitors' : kind === 'BOARD' ? 'chatBoards' : 'chatBuddy';
    const j = (rt.info as unknown as Record<string, Record<string, { position?: number[]; yaw?: number; width?: number }> | undefined>)[key]?.[spotName];
    if (j && Array.isArray(j.position) && j.position.length === 3 && j.position.every((v) => Number.isFinite(v))) {
      const p = rt.room.root.localToWorld(new THREE.Vector3(...(j.position as [number, number, number])));
      const width = THREE.MathUtils.clamp(Number(j.width) || (kind === 'MONITOR' ? 0.9 : 1.4), 0.3, 4);
      const pl: PropPlacement = { center: p, yaw: THREE.MathUtils.degToRad(Number(j.yaw) || 0), width, ceilingY: rays.ceilingAbove(p) ?? p.y + width * aspect / 2 + 1.2, source: 'scene.json' };
      // (the performer's own Room editor place comes first: docs/ROOM_EDITOR.md)
      if ((rt.info as { userEdits?: Record<string, Record<string, unknown> | undefined> }).userEdits?.[key]?.[spotName]) out.unshift(pl); else out.push(pl);
    }
    return out;
  }

  private stepJobs() {
    const t0 = performance.now();
    for (const s of [this.monitor, this.board]) {
      const j = s.job;
      if (!j) continue;
      for (;;) {
        const r = j.gen.next();
        if (r.done) {
          s.job = null;
          const got = r.value;
          s.failed = !got;
          if (got) {
            const cx = (got.place.center.clone().project(camOf(this.rt!.resolveCamera(this.rt!.state.camera).pose, this.rt!.stage.camera.aspect || 16 / 9)).x);
            s.side = cx < 0 ? -1 : 1;
            const same = s.rig && s.rig.place.center.distanceTo(got.place.center) < 0.02 && Math.abs(s.rig.place.width - got.place.width) < 0.01;
            s.next = same ? null : got.place;
          } else s.next = null;
          // no good place for this shot: put it away (never cover a face / the react screen)
          if (!got) s.next = null;
          // the board plans against the monitor's new place → re-plan it next time round
          if (s === this.monitor && this.state.panel === 'panel') this.shotKey = '';
          // the chat buddy plans against the props' places: plan him again now that this one is known
          this.buddyKey = '';
          break;
        }
        if (performance.now() - t0 > 2.5) return;
      }
    }
    const bj = this.buddyJob;
    if (bj) for (;;) {
      const r = bj.gen.next();
      if (r.done) { this.buddyJob = null; if (r.value) this.sendPlan(r.value, bj.key); break; }
      if (performance.now() - t0 > 2) return;
    }
    const rj = this.roamJob;
    if (rj) for (;;) {
      const r = rj.gen.next();
      if (r.done) { this.roamJob = null; this.gotRoam(r.value); break; }
      if (performance.now() - t0 > 2) return;
    }
  }

  // ---------------------------------------------------------------- the chat buddy (tablet first: chatBuddyPlace.ts)
  private planBuddy(ctx: ShotContext, key: string) {
    // another model picked: the old buddy poofs away, the new one pops in
    const model = this.state.buddyModel || BUDDY_AVATAR;
    if (this.buddy && this.buddy.modelId !== model) {
      if (this.buddy.shown) this.confetti.burst(this.buddy.actor.mount.position.clone().setY(this.buddy.actor.mount.position.y + this.buddy.height * 0.5), new THREE.Vector3(0, 0.3, 0), ['#f1f8e9', '#dfe7ea', '#c5e1a5', '#ffffff'], 70, 7);
      this.buddy.dispose(); this.buddy = null; this.buddyIn = false; this.buddyJob = null;
    }
    if (!this.buddy) {
      this.buddy = new ChatBuddy(this.rt!.room, this.rt!.root, model);
      this.buddy.canvas.live = this.monitor.canvas.live;
      this.buddy.onPoof = (at) => this.confetti.burst(at, new THREE.Vector3(0, 0.3, 0), ['#f1f8e9', '#dfe7ea', '#c5e1a5', '#ffffff'], 70, Math.floor(at.x * 1000) >>> 0);
      void this.buddy.load();
    }
    const b = this.buddy;
    if (!b.ready) { this.buddyKey = ''; return; }
    // the monitor / board are still looking for their place: plan him once they know it (he must stay clear of them)
    // — but never wait long (a prop with no place for this shot may keep searching)
    if (this.monitor.job || this.board.job) {
      this.buddyWait ||= performance.now();
      if (performance.now() - this.buddyWait < 600) { this.buddyKey = ''; return; }
    }
    this.buddyWait = 0;
    const roam = this.state.buddyMode !== 'stay';
    if (key === this.buddyKey && (b.plan || this.buddyJob || (roam && (b.roam || this.roamJob)))) return;
    this.buddyKey = key;
    if (key.split('|')[0] !== this.buddyBadKey) { this.buddyBadKey = key.split('|')[0]; this.buddyBad = []; this.buddyNoFore = false; }
    const inp = this.buddyInput(ctx);
    // roam (default): he lives in the room — the roam set of this shot first; the tablet plans only when no spot shows him
    if (roam) { this.buddyJob = null; this.roamJob = { key, gen: planRoam(inp, this.state.buddyRange ?? 'room', key) }; return; }
    this.roamJob = null;
    if (b.roam) b.setRoam(null);
    // the current place still shows the tablet well in this shot: stay (he just turns to the lens)
    if (b.plan && this.buddyIn && planStillGood(inp, b.plan)) { this.buddyJob = null; return; }
    this.buddyJob = { key, gen: planTablet(inp) };
  }
  private buddyInput(ctx: ShotContext): BuddyPlanInput {
    const b = this.buddy!;
    const avoid: Rect[] = [];
    for (const s of [this.monitor, this.board]) { const r = this.propRect(s, ctx); if (r) avoid.push(r); }
    const cur = b.shown && b.plan?.mode === 'world' ? b.plan.pos.clone() : null;
    b.baseHeight = this.buddyHeight() * b.heightK;
    b.setTablet(this.state.tablet ?? 1, this.state.tabletText ?? 1, this.state.font);
    return { ctx, height: b.baseHeight, geoAt: b.geoAt, avoid, cur, anchors: this.buddyAnchors(), preferSide: this.monitor.side ? -this.monitor.side : 0, bad: this.buddyBad, noFore: this.buddyNoFore, exact: (pts, from) => this.exactClear(pts, from) };
  }
  /** Since when he waits for the props' places (0 = not waiting; capped at 0.6 s). */
  private buddyWait = 0;
  /** The foreground peek turned out hidden for this shot (the live check): overlay instead. */
  private buddyNoFore = false;
  /** Places found hidden on screen for the current shot (reset when the shot changes). */
  private buddyBad: THREE.Vector3[] = [];
  private buddyBadKey = '';
  private buddyCheckT = 0;
  private buddyMiss = 0;
  /** Performers as capsules (feet → head, where they are right now): the cheap stand-in for their skinned meshes —
   *  raycasting skinned meshes costs tens of ms per ray with a big party (never do that per frame). */
  private proxies(walkers = true): { a: THREE.Vector3; b: THREE.Vector3; r: number }[] {
    const out: { a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
    const rt = this.rt!;
    for (const a of rt.actors.values()) {
      if (!a.runtime || !a.mount.visible || !a.rest) continue;
      if (!walkers && rt.mover.busy(a)) continue;              // someone walking past: a moment, not a bad place
      const h = a.rest.height * a.scale;
      const f = a.rest.face.size * a.scale;
      const r = THREE.MathUtils.clamp(Math.max(f * 1.1, h * 0.12), 0.08, 0.6);
      const base = a.mount.position.clone();
      const top = h * (a.sit > 0.5 ? 0.78 : 1);
      out.push({ a: base.clone().setY(base.y + Math.min(r, top * 0.4)), b: base.clone().setY(base.y + Math.max(r, top - r * 0.6)), r });
    }
    return out;
  }
  /** Nothing of the room (BVH) or a performer (capsules) between `from` and each point. */
  private exactClear(pts: THREE.Vector3[], from: THREE.Vector3, walkers = true): boolean {
    const caps = this.proxies(walkers);
    this.rays ??= new RoomRays(this.rt!.room);
    for (const p of pts) {
      const L = p.distanceTo(from);
      if (L < 0.05) continue;
      const q = from.clone().lerp(p, (L - 0.03) / L);
      for (const c of caps) if (segSegDist(from, q, c.a, c.b) < c.r) return false;
      if (!this.rays.clear(from, q)) return false;
    }
    return true;
  }
  /** Live check (twice a second, settled shots): is the real tablet on screen, big enough and unhidden? If not
   *  (twice in a row) that place is marked bad for this shot and he goes somewhere else. */
  private checkBuddyLive(dt: number) {
    const b = this.buddy, rt = this.rt!;
    if (b?.roaming) { this.checkRoamLive(dt); return; }
    if (!b?.plan || b.plan.mode === 'overlay' || b.plan !== b.active || b.busy || rt.rig.moving || !b.shown) { this.buddyMiss = 0; return; }
    this.buddyCheckT -= dt;
    if (this.buddyCheckT > 0) return;
    this.buddyCheckT = 0.5;
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    // only judge the shot he was planned for (not a walk-in follow cam / a camera still on its way)
    const pose = this.lastCtx?.pose;
    if (!pose || cam.getWorldPosition(new THREE.Vector3()).distanceTo(pose.position) > 0.05 || Math.abs(cam.getWorldQuaternion(new THREE.Quaternion()).dot(pose.quaternion)) < 0.9995) { this.buddyMiss = 0; return; }
    const pts = b.tabletPoints();
    if (!pts) return;
    const pr = pts.map((p) => p.clone().project(cam));
    const inFrame = pr.every((q) => q.z > -1 && q.z < 1 && Math.abs(q.x) < 0.99 && Math.abs(q.y) < 0.99);
    const hf = (Math.max(...pr.map((q) => q.y)) - Math.min(...pr.map((q) => q.y))) / 2 / 0.907;   // the points span 90.7 % of the screen
    // hidden behind the chat monitor / board (their housings aren't in the room's rays)?
    const ctx = this.lastCtx;
    const tr = ctx ? rectOf(pts, camOf(ctx.pose, ctx.aspect)) : null;
    let behindProp = false;
    if (ctx && tr) for (const s of [this.monitor, this.board]) { const r = this.propRect(s, ctx); if (r && rectOverlap(r, tr) > 0.0005) behindProp = true; }
    const ok = inFrame && !behindProp && hf >= b.geo.hfMin * 0.9 && !this.tabletOverFace(pts, cam) && this.exactClear(pts, cam.position, false);
    this.buddyMiss = ok ? 0 : this.buddyMiss + 1;
    if (this.buddyMiss >= 2) {
      this.buddyMiss = 0;
      if (b.plan.mode === 'fore') this.buddyNoFore = true;
      else { this.buddyBad.push(b.plan.pos.clone()); if (this.buddyBad.length > 24) this.buddyBad.shift(); }
      this.buddyKey = ''; this.shotKey = '';
    }
  }
  /** Roam: while the tablet is up, twice a second — is it really seen (in frame, big enough, nothing in front)? If not
   *  (twice) that spot stops being a "readable" one for this shot and he walks to another. */
  private checkRoamLive(dt: number) {
    const b = this.buddy!, rt = this.rt!;
    if (!b.roamShowing || rt.rig.moving) { this.buddyMiss = 0; return; }
    this.buddyCheckT -= dt;
    if (this.buddyCheckT > 0) return;
    this.buddyCheckT = 0.5;
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    const pts = b.tabletPoints();
    if (!pts) return;
    const pr = pts.map((p) => p.clone().project(cam));
    const inFrame = pr.every((q) => q.z > -1 && q.z < 1 && Math.abs(q.x) < 0.99 && Math.abs(q.y) < 0.99);
    const hf = (Math.max(...pr.map((q) => q.y)) - Math.min(...pr.map((q) => q.y))) / 2 / 0.907;
    const ctx = this.lastCtx;
    const tr = ctx ? rectOf(pts, camOf(ctx.pose, ctx.aspect)) : null;
    let behindProp = false;
    if (ctx && tr) for (const s of [this.monitor, this.board]) { const r = this.propRect(s, ctx); if (r && rectOverlap(r, tr) > 0.0005) behindProp = true; }
    const ok = inFrame && !behindProp && hf >= b.geo.hfMin * 0.9 && !this.tabletOverFace(pts, cam) && this.exactClear(pts, cam.position, false);
    this.buddyMiss = ok ? 0 : this.buddyMiss + 1;
    if (this.buddyMiss >= 2) { this.buddyMiss = 0; b.roamBadTab(); }
  }
  /** The shown tablet (through the LIVE camera) over a face — a performer's or the buddy's own? The planner never
   *  plans that; this is the safety net for what is really on screen (a camera / performer that moved since). */
  private tabletOverFace(pts: THREE.Vector3[], cam: THREE.PerspectiveCamera): boolean {
    const b = this.buddy!;
    // (the points span 90.7 % of the screen: widen to the whole screen)
    const r = rectOf(pts, cam), cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2, k = 1 / 0.907;
    const tab: Rect = { x0: cx + (r.x0 - cx) * k, y0: cy + (r.y0 - cy) * k, x1: cx + (r.x1 - cx) * k, y1: cy + (r.y1 - cy) * k };
    const faces = (this.lastCtx?.performers ?? []).map((q) => performerRects(q, cam).face);
    const own = b.facePoints(cam);
    if (own) faces.push(rectOf(own, cam));
    return faces.some((f) => rectOverlap(tab, f) > 0);
  }
  /** BUDDY_SPOT_xx (for the host's SPOT_xx) / BUDDY_SPOT / CHAT_BUDDY_xx / CHAT_BUDDY nodes + scene.json buddySpots. */
  private buddyAnchors(): { pos: THREE.Vector3; source: string }[] {
    const rt = this.rt!;
    const spot = rt.actors.get(HOST_KEY)?.spot ?? null;
    const xx = spot ? String(spot.index + 1).padStart(2, '0') : '';
    const out: { pos: THREE.Vector3; source: string }[] = [];
    rt.room.root.traverse((o) => {
      const m = /^(BUDDY_SPOT|CHAT_BUDDY)(?:_(\d\d))?$/.exec(o.name);
      if (!m) return;
      const p = o.getWorldPosition(new THREE.Vector3());
      if (m[2] ? m[2] !== xx : !!spot && p.distanceTo(spot.position) > 4.5) return;
      out.push({ pos: p, source: 'node' });
    });
    const js = (rt.info as unknown as { buddySpots?: Record<string, number[][]> }).buddySpots?.[spot ? `SPOT_${xx}` : ''];
    if (Array.isArray(js)) for (const v of js.slice(0, 8)) if (Array.isArray(v) && v.length === 3 && v.every((n) => Number.isFinite(n))) out.push({ pos: rt.room.root.localToWorld(new THREE.Vector3(v[0], v[1], v[2])), source: 'scene.json' });
    return out;
  }
  private buddyHeight() { return (this.rt!.info.avatarHeight ?? 1.5) * (this.rt!.state.avatarScale || 1) * 0.72; }

  private sendPlan(plan: TabletPlan, key = '') {
    const b = this.buddy;
    if (!b?.ready) { this.buddyKey = ''; return; }
    // roam mode: this plan is only the fallback for messages (no spot of the shot gives a readable tablet)
    if (b.roam) { if (b.roam.key === key) b.roam.msgPlan = plan; return; }
    const first = !this.buddyIn;
    this.buddyIn = true;
    b.apply(plan, first ? this.state.buddyAt || 0 : 0);
  }

  /** Roam set for this shot: he roams it; no readable spot → also plan the tablet (the message fallback); no spot at
   *  all (tight close-ups, a big react screen, full-frame capture layouts) → the tablet plans (peek / overlay). */
  private gotRoam(set: RoamSet) {
    const b = this.buddy;
    if (!b?.ready || set.key !== this.buddyKey || this.state.buddyMode === 'stay') { if (!b?.ready) this.buddyKey = ''; return; }
    const ctx = this.lastCtx;
    if (set.pts.length) {
      this.buddyIn = true;
      b.setRoam(set);
      // the message fallback (no readable spot here, or none within a short hurry): planned right away, with the same
      // 10 % readability margin as the roam spots (a plan right at the limit reads too small once he really holds it)
      if (ctx) this.buddyJob = { key: set.key, gen: planTablet(this.marginInput(ctx)) };
      return;
    }
    b.setRoam(null);
    if (ctx) this.buddyJob = { key: set.key, gen: planTablet(this.marginInput(ctx)) };
  }
  /** Roam mode's tablet plans: the same 10 % readability margin as the roam spots. */
  private marginInput(ctx: ShotContext): BuddyPlanInput {
    const inp = this.buddyInput(ctx), g0 = inp.geoAt;
    inp.geoAt = (h) => { const g = g0(h), m = g.hfMin * 1.1; return { ...g, hfMin: m, hfPref: Math.max(g.hfPref, m * 1.2), hfMax: Math.max(g.hfMax, m * 1.9) }; };
    return inp;
  }

  private planBuddyOff() {
    const b = this.buddy;
    if (!b) return;
    if (this.buddyIn || b.roam) { this.buddyIn = false; b.leave(); this.buddyJob = null; this.roamJob = null; this.buddyKey = ''; }
  }

  /** A camera cut: if the new shot sees him somewhere wrong (over a face / the react screen, cut by the frame edge, a
   *  giant in front of the lens) he vanishes on the cut frame and walks in again once the new shot is planned. */
  private cutCheck() {
    const b = this.buddy, rt = this.rt!;
    if (!b?.roaming || !b.shown) return;
    const cam = rt.stage.camera;
    const m = b.actor.mount.position, h = b.height;
    const r = new THREE.Vector3(1, 0, 0).applyQuaternion(cam.getWorldQuaternion(new THREE.Quaternion())).setY(0).normalize();
    const body = rectOf([m.clone().addScaledVector(r, -h * 0.3), m.clone().addScaledVector(r, h * 0.3).setY(m.y + h * 0.95)], cam);
    if (body.front && (body.x1 < 0 || body.x0 > 1 || body.y1 < 0 || body.y0 > 1)) return;          // off-screen: walks in from there
    const area = Math.max(1e-6, (body.x1 - body.x0) * (body.y1 - body.y0));
    const vis = Math.max(0, Math.min(1, body.x1) - Math.max(0, body.x0)) * Math.max(0, Math.min(1, body.y1) - Math.max(0, body.y0));
    let bad = !body.front || vis / area < 0.8 || body.y1 - body.y0 > 0.62;
    for (const q of this.lastCtx?.performers ?? []) if (rectOverlap(body, performerRects(q, cam).face) > 0) bad = true;
    if (rt.state.mode === 'react') {
      const sr = rt.layout() === 'solo' ? rt.solo?.rect(cam) : rt.screen?.rect(cam);
      if (sr && rectOverlap(body, { x0: sr.x, y0: sr.y, x1: sr.x + sr.w, y1: sr.y + sr.h }) > 0) bad = true;
    }
    if (bad) b.hideForCut();
  }

  private driveBuddy(dt: number, st: SceneChatState) {
    const b = this.buddy;
    if (!b) return;
    if (!b.ready) return;
    if (st.buddy && !this.buddyIn && !this.buddyJob && !this.roamJob) this.buddyKey = '', this.shotKey = '';      // loaded after planning: plan again
    const rt = this.rt!;
    b.baseHeight = this.buddyHeight() * b.heightK;
    b.cam.copy(rt.stage.camera.position);
    b.camera = rt.stage.camera;
    const host = rt.actors.get(HOST_KEY);
    b.hostHead = host?.spot ? host.faceAt(host.spot)?.center ?? null : null;
    // roam: the shared timeline's seed / epoch (the host's toggle stamp + the room), who he looks at, cuts
    b.seed = hash32(st.buddyAt || 1, rt.info.id);
    b.epoch = (st.buddyAt || 0) / 1000;
    b.planning = !!this.roamJob;
    b.heads = this.lastCtx?.performers.map((q) => q.face.center) ?? [];
    const cam = rt.stage.camera;
    cam.updateMatrixWorld();
    const cp = cam.getWorldPosition(new THREE.Vector3()), cq = cam.getWorldQuaternion(new THREE.Quaternion());
    if (this.camP && !rt.rig.moving && (cp.distanceTo(this.camP) > 0.3 || Math.abs(cq.dot(this.camQ)) < 0.995)) this.cutCheck();
    this.camP = cp; this.camQ.copy(cq);
    b.update(dt, rt.stage.camera.aspect || 16 / 9, this.feed, st);
    this.checkBuddyLive(dt);
    // gone: free everything (nothing runs while the option is off)
    if (!st.buddy && !b.busy && !b.shown && !this.buddyIn && !b.overlay.visible) { b.dispose(); this.buddy = null; }
  }

  /** Debug / test summary. */
  debug() {
    const r = (s: PropSlot) => s.rig ? { source: s.rig.place.source, width: +s.rig.place.width.toFixed(2), center: s.rig.place.center.toArray().map((v) => +v.toFixed(2)), down: s.rig.down, target: s.rig.target, side: s.side } : { next: !!s.next, job: !!s.job, failed: s.failed };
    const bp = this.buddy?.plan;
    const check = bp ? { mode: bp.mode, source: bp.source, hf: +bp.hf.toFixed(3), score: +bp.score.toFixed(2), perch: bp.perch, corner: bp.corner, height: +bp.height.toFixed(2), fore: bp.fore ?? null, lift: +bp.lift.toFixed(3), cheer: bp.cheer ?? 1, hop: bp.hop ?? 1 } : null;
    return { perf: { avg: +this.perf.avg.toFixed(3), peak: +this.perf.peak.toFixed(2), redraws: this.perf.redraws }, check, monitor: r(this.monitor), board: r(this.board), buddy: this.buddy ? { ready: this.buddy.ready, shown: this.buddy.shown, busy: this.buddy.busy, target: this.buddy.target?.position.toArray().map((v) => +v.toFixed(2)) ?? null, pos: this.buddy.actor.mount.position.toArray().map((v) => +v.toFixed(2)), model: this.buddy.modelId, loaded: this.buddy.loadedId, fallback: this.buddy.fallback, hold: this.buddy.ready ? this.buddy.geo.hold : null, hfMin: +this.buddy.hfMin.toFixed(3), tablet: [this.buddy.canvas.W, this.buddy.canvas.H], height: +this.buddy.height.toFixed(2), roam: this.roamDebug() } : null, alerts: this.alerts.length, shot: this.shotKey };
  }

  /** Roam state (debug / harness): the set, the timeline sample, whether the tablet is up. */
  roamDebug() {
    const b = this.buddy;
    if (!b) return null;
    const set = b.roam, s = b.rs;
    return { on: b.roaming, planning: !!this.roamJob, set: set ? { n: set.pts.length, tabs: set.pts.filter((p) => p.tab).length, perches: set.pts.filter((p) => p.perch).length, height: +set.height.toFixed(2), msgPlan: set.msgPlan?.mode ?? null, stats: set.stats } : null, seg: s?.seg ? { k: s.seg.k, bit: s.bit, pt: s.seg.pt, fall: !!s.seg.fall } : null, raise: s ? +s.raise.toFixed(2) : 0, gait: s ? +s.gait.toFixed(2) : 0, showing: b.roamShowing, at: b.atPt, joins: { ...b.joinStats } };
  }

  dispose() { this.detach(); this.off(); this.monitor.canvas.dispose(); this.board.canvas.dispose(); this.confetti.dispose(); }
}

/** Closest distance between segments p1-q1 and p2-q2. */
function segSegDist(p1: THREE.Vector3, q1: THREE.Vector3, p2: THREE.Vector3, q2: THREE.Vector3): number {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  let s = 0, t = 0;
  if (a <= 1e-9 && e <= 1e-9) return p1.distanceTo(p2);
  if (a <= 1e-9) t = THREE.MathUtils.clamp(f / e, 0, 1);
  else {
    const c = d1.dot(r);
    if (e <= 1e-9) s = THREE.MathUtils.clamp(-c / a, 0, 1);
    else {
      const b = d1.dot(d2), den = a * e - b * b;
      s = den > 1e-9 ? THREE.MathUtils.clamp((b * f - c * e) / den, 0, 1) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-c / a, 0, 1); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - c) / a, 0, 1); }
    }
  }
  return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
}
