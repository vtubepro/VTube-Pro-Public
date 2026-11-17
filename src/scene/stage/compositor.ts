// StageCompositor — the OBS page's stage layout layer (docs/SCENES.md → "Stage modes"). Every page that renders a room
// (the host's OBS pages, every party guest's, the Scene-tab preview) runs one; it turns the scene state into the same
// StagePlan (the current mode's `plan`, src/scene/stage/registry.ts) and draws it:
//
//   composite plans (React Full / Medium, Gaming …)  a styled backdrop in the room's palette, the capture rect (OBS
//     passthrough hole = alpha 0, or the in-scene window), live performer cams (one scissored render of the scene per
//     cam, from its own camera — src/scene/stage/tileCams.ts), docked chat / support panels (DOM).
//   3d plans (Talk, React Big / Side, modes without a plan)  the normal room render; performers the camera can't clearly
//     see get cams in free space ("rail", React), and chat / support panels dock only while the in-world chat monitor /
//     support board / Sprocket's tablet can't show them in the current shot.
//
// Changes animate: every element tweens from where it is (a cam flies out of its performer's face in the room, the
// capture window grows out of the room's React screen); in passthrough the hole closes during a move and reopens once
// settled (like the React camera moves), reporting its rect for OBS automation / the *Fit my capture* button.
// Cost: nothing extra in plain 3d shots (render() returns false); cams cost one scene traversal each, limited to their
// rectangle (scissor) — no render targets, so no extra shader variants and no mid-show compiles.
// Layout look (shared/layoutLook.ts, docs/LAYOUTS.md): the screen-first (composite) layouts' cams can be boxed or
// cut-outs, see-through, re-cornered / resized; frame, radius, backdrop, screen dim, panels per layout (the `hud` bag);
// HUD layouts (the Full screen mode, shared/hud.ts) add HUD elements, drawn by ./hud.ts over the frame.
import * as THREE from 'three';
import type { SceneState } from '../../../shared/types.ts';
import { DEFAULT_CHAT_STATE } from '../../../shared/chat.ts';
import { HOST_KEY } from '../../../shared/scene.ts';
import { DEFAULT_STAGE, plan3d, sanitizeStageState, stagePalette, type Rect, type SceneStageState, type StagePlan, type TilePlan } from '../../../shared/stage.ts';
import type { Stage } from '../../stage/Stage.ts';
import type { ChatFeed } from '../../chat/feed.ts';
import type { ChatScene } from '../chatScene.ts';
import type { SceneRuntime } from '../SceneRuntime.ts';
import { RoomRays } from '../twoShot.ts';
import { stageModeDef, type ModePageCtx, type ModePerformer } from './registry.ts';
import { FrameFx, MAX_TILES } from './frameFx.ts';
import { capCover } from '../capcover/cover.ts';
import { TileCams, setTileSubjectHook } from './tileCams.ts';
import { StageDom, type TagSpec } from './stageDom.ts';
import { tvFeedMaterial, tvOfActor } from '../tv/tvApi.ts';
import { searchFreeSpace, type FreeSpaceResult } from './freeSpace.ts';
import { LAYOUT_BAG, activeSlot, applyLayout, overrideRect, sanitizeLayoutBag, slotKey, toRect, type LayoutBag, type LayoutSlot, type R4 } from '../../../shared/stageLayout.ts';
import { chatDockChoice, type ChatBoxCore } from '../../../shared/chatBox.ts';
import { HUD_BAG, chatTextOptions, layoutBaseLook, lookFor, sanitizeHudBag, type HudBag } from '../../../shared/hud.ts';
import { DEFAULT_LOOK, applyLookPlan, frameParams, type LayoutLook } from '../../../shared/layoutLook.ts';
import { HudLayer } from './hud.ts';

// walking-TV guests (tvguests PERFORMER_API.md): the cam frames the TV's screen (their runtime's faceInfo(), live world space)
setTileSubjectHook((rt, key) => {
  const tv = tvOfActor(rt.actors.get(key));
  const f = tv?.faceInfo?.();
  return f ? { center: f.center.clone(), size: Math.max(0.05, f.size) } : null;
});

export interface StageInputs {
  /** The state the page SHOWS (after a mode transition's cover). */
  state: SceneState;
  rt: SceneRuntime | null;
  /** Member key → display name. */
  name: (key: string) => string;
  /** Member key → 0..1 how much they're talking right now. */
  speak: (key: string) => number;
  /** Any chat platform live (chat status), for the docks' "auto". */
  chatLive: boolean;
  /** Host clock → this page (guests: the party offset), for the line-up test's end time. */
  now?: number;
  /** Mode page hooks: the bus (OBS pages) and the curtain (ModePageCtx.onBus / .curtain). */
  onBus?: ModePageCtx['onBus'];
  curtain?: ModePageCtx['curtain'];
}

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpRect = (a: Rect, b: Rect, t: number): Rect => ({ x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t), w: lerp(a.w, b.w, t), h: lerp(a.h, b.h, t) });
const sameRect = (a: Rect | null, b: Rect | null, eps = 0.002) => (!a || !b ? a === b : Math.abs(a.x - b.x) < eps && Math.abs(a.y - b.y) < eps && Math.abs(a.w - b.w) < eps && Math.abs(a.h - b.h) < eps);
const shrink = (r: Rect): Rect => ({ x: r.x + r.w / 2, y: r.y + r.h / 2, w: 0, h: 0 });
const MORPH = 0.6;

interface Tween { from: Rect; to: Rect; cur: Rect; t: number }
function tween(tw: Tween | null, to: Rect, spawn: Rect): Tween {
  if (!tw) return { from: spawn, to, cur: spawn, t: 0 };
  if (!sameRect(tw.to, to)) return { from: { ...tw.cur }, to, cur: tw.cur, t: 0 };
  return tw;
}
function stepTween(tw: Tween, dt: number) { tw.t = Math.min(1, tw.t + dt / MORPH); tw.cur = lerpRect(tw.from, tw.to, ease(tw.t)); }

interface TileState { key: string; tw: Tween; alpha: number; want: boolean; plan: TilePlan; speak: number }

export class StageCompositor {
  readonly dom: StageDom;
  private fx = new FrameFx();
  private cams = new TileCams();
  private rt: SceneRuntime | null = null;
  private plan: StagePlan | null = null;
  private layRaw: unknown = undefined;
  private lay: LayoutBag = { rooms: {} };
  private laySlot: LayoutSlot | null = null;
  private hudRaw: unknown = undefined;
  private hudBag: HudBag = sanitizeHudBag(undefined);
  /** The current composite layout's look (DEFAULT_LOOK in 3d views). */
  private look: LayoutLook = DEFAULT_LOOK;
  private pal: ReturnType<typeof stagePalette> | null = null;
  private palMemo: { id: string; theme: string | null; own: unknown; pal: ReturnType<typeof stagePalette> } | null = null;
  readonly hud: HudLayer;
  private tiles = new Map<string, TileState>();
  private cap: Tween | null = null;
  /** Chat polls (src/poll/pollCard.ts): the in-world chat prop in the shot right now (board first) — null = dock the card. */
  pollWorld: 'monitor' | 'board' | null = null;
  private capAlpha = 0;
  /** 0 = 3d view, 1 = composite (tweened). */
  private comp = 0;
  private compTo = 0;
  private capOpen = 0;
  private holeOpenSent = false;
  private holeBeat = 0;
  private free: FreeSpaceResult | null = null;
  private freeT = 0;
  private rail: string[] = [];
  private faceBoxes: Rect[] = [];
  private visibleProps: Rect[] = [];
  private need = { chat: false, support: false };
  private since = { chatMiss: 0, chatOk: 0, supMiss: 0, supOk: 0 };
  private docked: { chat: Rect | null; support: Rect | null } = { chat: null, support: null };
  private dockTw: { chat: Tween | null; support: Tween | null } = { chat: null, support: null };
  private rays: RoomRays | null = null;
  private time = 0;
  private dockOnly = false;
  private lastRaw: SceneState | null = null;
  private modeAttached: string | null = null;
  private inp: StageInputs | null = null;
  private perf = { tiles: 0, ms: 0, avg: 0 };
  /** High / Ultra graphics (src/stage/gfx/Graphics.ts renderComposite): draws the cams through the post chain; false =
   *  no post at this level. Set by the page. */
  post: ((fill: (target: THREE.WebGLRenderTarget) => void) => boolean) | null = null;
  /** OBS automation: the composite capture hole finished opening / closed. */
  onHole: ((open: boolean, rect: Rect | null, label: string) => void) | null = null;

  constructor(private stage: Stage, private chatScene: ChatScene, private feed: ChatFeed) {
    this.dom = new StageDom(feed, () => this.inp?.state.chat);
    this.hud = new HudLayer({ feed, chat: () => this.inp?.state.chat ?? DEFAULT_CHAT_STATE });
  }

  /** The capture area this page shows (fractions) — the composite capture rect or the 3d React screen — for the capture
   *  cover's canvas size; `composite` = a flat rect (else a screen surface, 16:9). */
  coverArea(): { rect: Rect; composite: boolean } | null {
    const c = this.cap?.to ?? null;
    return c ? { rect: c, composite: this.plan?.view === 'composite' } : null;
  }

  // ---------------------------------------------------------------- state → runtime
  /** The state handed to the SceneRuntime: while a layout docks the chat itself, the in-world chat props step out. */
  runtimeState(s: SceneState): SceneState {
    this.lastRaw = s;
    // (live-tabs: Live → Privacy → Hide chat — the chat monitor + buddy step out; a support board on its own panel stays)
    if (!s.chat || (!this.dockOnly && !s.chat.hidden)) return s;
    return { ...s, chat: { ...s.chat, monitor: false, panel: this.dockOnly || s.chat.panel === 'monitor' ? 'off' : s.chat.panel, buddy: false } };
  }
  private setDockOnly(on: boolean) {
    if (on === this.dockOnly) return;
    this.dockOnly = on;
    if (this.rt && this.lastRaw) this.rt.setState(this.runtimeState(this.lastRaw));
  }

  private stageOf(s: SceneState): SceneStageState { return s.stage ? sanitizeStageState(s.stage) : DEFAULT_STAGE; }

  /** Ordered performers (host first, then join order, then anyone else on this page). */
  private performers(s: SceneState, rt: SceneRuntime): ModePerformer[] {
    const st = this.stageOf(s);
    const order = [...st.order];
    if (!order.includes(HOST_KEY)) order.unshift(HOST_KEY);
    const seen = new Set<string>();
    const out: ModePerformer[] = [];
    const add = (key: string) => {
      if (seen.has(key)) return;
      const a = rt.actors.get(key);
      const present = s.present[key] !== false && (!!rt.seatOf(key) || (s.spots[key] !== undefined && !a?.runtime));
      if (!a && s.spots[key] === undefined) return;
      seen.add(key);
      out.push({ key, name: this.inp?.name(key) ?? key, host: key === HOST_KEY, cls: a?.size.cls ?? 'normal', present, seated: !!a?.runtime && !!rt.seatOf(key) && !rt.mover.busy(a), speak: Math.max(0, Math.min(1, this.inp?.speak(key) ?? 0)) });
    };
    for (const k of order) add(k);
    for (const k of [...rt.actors.keys()].sort()) add(k);
    return out;
  }

  // ---------------------------------------------------------------- per frame
  update(dt: number, inp: StageInputs) {
    this.inp = inp;
    this.time += dt;
    const rt = inp.rt;
    if (rt !== this.rt) this.bind(rt);
    if (!rt) { this.dom.hideAll(); this.hud.hideAll(); this.pollWorld = null; return; }
    // the frame passes' programs, compiled when a room first shows (not on the first React / Gaming switch mid-show)
    this.fx.warm(this.stage.renderer);
    const s = inp.state;
    const st = this.stageOf(s);
    const aspect = this.stage.camera.aspect || 16 / 9;
    const def = stageModeDef(s.mode);
    // mode page hooks
    if (this.modeAttached !== s.mode) {
      stageModeDef(this.modeAttached)?.page?.detach?.();
      this.modeAttached = s.mode;
      def?.page?.attach?.(rt);
    }
    const performers = this.performers(s, rt);
    const chatSt = s.chat ?? DEFAULT_CHAT_STATE;
    const inUse = this.feed.events.length > 0 || inp.chatLive;
    const wantChat = !chatSt.hidden && (st.dock.chat === 'always' || (st.dock.chat === 'auto' && inUse));
    const wantSup = st.dock.support === 'always' || (st.dock.support === 'auto' && (inUse || this.feed.support.length > 0 || chatSt.goal.on));
    // the chat box placed by the streamer (shared/chatBox.ts): the layouts don't keep a column for it, it sits where chosen.
    // chatfx: the place for THIS room + mode (per room / per mode places), and the precedence over the Layout editor's old
    // per-preset chat rect (chatDockChoice) — decided once the plan's label is known, below
    const layRaw0 = (s.modes ?? {})[LAYOUT_BAG];
    if (layRaw0 !== this.layRaw) { this.layRaw = layRaw0; this.lay = sanitizeLayoutBag(layRaw0); }
    const roomId = s.sceneId ?? rt.info.id;
    const pre = chatDockChoice(st.chatBox, roomId, s.mode, false, aspect);
    let box: ChatBoxCore | null = pre.use === 'box' ? pre.place : null;
    this.chatPlace = pre.place;
    this.chatAlways = st.dock.chat === 'always';
    const ctx: ModePageCtx = {
      state: s, stage: st, aspect, performers,
      room: { id: rt.info.id, info: rt.info, theme: rt.skins?.solo?.spec.theme ?? null, hasScreen: !!rt.screen },
      inScene: rt.compositeInScene, docks: { chat: wantChat && !box, support: wantSup }, rt,
      bag: (san) => san((s.modes ?? {})[s.mode]),
      ...(inp.onBus ? { onBus: inp.onBus } : {}), ...(inp.curtain ? { curtain: inp.curtain } : {}),
    };
    let plan: StagePlan | null = null;
    try { plan = def?.page?.plan?.(ctx) ?? null; } catch (e) { console.warn('[stage] plan', e); }
    // 3D room shots (Talk, TTRPG, …): the chat box gets a dock whenever it is not Off (chatfx: "On screen" / "Both" used to
    // show nothing in Talk unless the box was "Always"); while the room's own chat screen (monitor / buddy) is in the shot,
    // look3d's hysteresis keeps the box away ("When active"), so the world chat still wins where the camera sees it.
    // Support docks only in the modes that ask for it (Interview: chat 'docked').
    if (!plan) plan = plan3d(def?.label ?? s.mode, false, wantChat, wantSup && def?.chat === 'docked');
    // the Layout editor's old chat rect for this preset loses to a room / room + mode place (and is what is used under an
    // every-room place: the more specific choice; the Chat panel says so)
    const slot0 = activeSlot(this.lay, roomId, s.mode, plan.label);
    const choice = chatDockChoice(st.chatBox, roomId, s.mode, Array.isArray(slot0?.chat), aspect);
    if (choice.use !== 'box') box = null;
    // (the Layout editor's rect wins here: the plan was made without a chat column because the box looked fixed — put
    // the chat at that rect; applyLayout / overrideRect below keep it there)
    if (wantChat && choice.use === 'layout' && Array.isArray(slot0?.chat)) plan = { ...plan, docks: { ...plan.docks, chat: toRect(slot0.chat as R4) } };
    // the chat box: at the streamer's place (every mode), and "Always" means every mode — Talk / React Big too (it used to
    // dock only in the modes that dock by themselves: "Beside your game" showed no chat in Talk)
    if (wantChat && box) plan = { ...plan, docks: { ...plan.docks, chat: choice.rect } };
    else if (wantChat && this.chatAlways && plan.docks.chat === null) plan = { ...plan, docks: { ...plan.docks, chat: 'auto' } };
    this.fixedChat = plan.docks.chat && plan.docks.chat !== 'auto' && plan.view !== 'composite' ? plan.docks.chat : null;
    this.dom.chatOpacity = box ? box.opacity : 1;
    // custom layout (Show → Layout editor, shared/stageLayout.ts): the host's per-element placement for this room / mode / preset
    this.laySlot = activeSlot(this.lay, roomId, s.mode, plan.label);
    // (a room / room + mode chat place wins over the slot's chat rect: the slot keeps everything else)
    if (this.laySlot && choice.use !== 'layout' && Array.isArray(this.laySlot.chat)) { const { chat: _c, ...rest } = this.laySlot; void _c; this.laySlot = rest as LayoutSlot; }
    this.chatChoice = choice.use;
    // the layout's look (per layout: cams boxed / cut-out, size + corner, frame, opacities …) — composite plans only
    const hudRaw = (s.modes ?? {})[HUD_BAG];
    if (hudRaw !== this.hudRaw) { this.hudRaw = hudRaw; this.hudBag = sanitizeHudBag(hudRaw); }
    this.look = plan.view === 'composite' ? lookFor(this.hudBag, slotKey(s.mode, plan.label), layoutBaseLook(this.hudBag, s.mode, plan.label, st.backdrop)) : DEFAULT_LOOK;
    plan = applyLookPlan(plan, this.look);
    plan = applyLayout(plan, this.look.safe !== undefined ? { ...this.lay, safe: this.look.safe } : this.lay, this.laySlot);
    try { def?.page?.update?.(dt, ctx); } catch (e) { console.warn('[stage] mode update', e); }
    // the mode's hard keep-outs for the docks this frame (an interview monitor, projector screens …)
    let modeKo: Rect[] = [];
    try { modeKo = (def?.page?.keepOut?.(ctx) ?? []).filter((r) => r && r.w > 0 && r.h > 0); } catch (e) { console.warn('[stage] keepOut', e); modeKo = []; }
    this.keepOut = modeKo;
    this.plan = plan;
    const composite = plan.view === 'composite';
    this.setDockOnly(composite || def?.chat === 'docked');
    rt.composite = composite;
    this.compTo = composite ? 1 : 0;
    if (this.comp < this.compTo) this.comp = Math.min(this.compTo, this.comp + dt / MORPH);
    else if (this.comp > this.compTo) this.comp = Math.max(this.compTo, this.comp - dt / MORPH);
    this.cams.frame();
    this.applyInset(dt, plan);

    // ---- palette
    // (stagePalette builds a fresh object per call for a scene's own colours: memoized on its three inputs)
    const palId = rt.info.id, palTheme = rt.skins?.solo?.spec.theme ?? null, palOwn = (rt.info as unknown as { stage?: { palette?: unknown } }).stage?.palette;
    if (!this.palMemo || this.palMemo.id !== palId || this.palMemo.theme !== palTheme || this.palMemo.own !== palOwn) this.palMemo = { id: palId, theme: palTheme, own: palOwn, pal: stagePalette(palId, palTheme, palOwn) };
    const pal = this.palMemo.pal;
    this.fx.setPalette(pal);
    this.dom.setPalette(pal);
    this.pal = pal;

    // ---- 3d view: who the camera clearly sees, free space for the rail + docks (4×/s, settled shots only)
    if (!composite) this.look3d(dt, rt, plan, performers, wantChat, wantSup, chatSt);
    else { this.rail = []; this.free = null; this.pollWorld = null; }

    // ---- tiles: plan tiles (composite) or rail tiles (3d), each tweened from where it is / where the performer is
    const want = new Map<string, { rect: Rect; plan: TilePlan }>();
    if (composite) for (const t of plan.tiles) want.set(t.key, { rect: t.rect, plan: t });
    else if (this.free) this.free.rail.forEach((r0, i) => { const rect = overrideRect(this.laySlot, `cam${i}`) ?? r0.rect; want.set(r0.key, { rect, plan: { key: r0.key, rect, framing: 'bust', backdrop: 'room', tag: 'inside', ...(r0.key === HOST_KEY ? { hero: true } : {}) } }); });
    for (const [key, w] of want) {
      let ts = this.tiles.get(key);
      if (!ts) { ts = { key, tw: tween(null, w.rect, this.spawnRect(rt, key, w.rect)), alpha: 0, want: true, plan: w.plan, speak: 0 }; this.tiles.set(key, ts); }
      ts.tw = tween(ts.tw, w.rect, ts.tw.cur); ts.want = true; ts.plan = w.plan;
    }
    for (const ts of this.tiles.values()) {
      if (!want.has(ts.key)) { if (ts.want) { ts.want = false; ts.tw = tween(ts.tw, this.spawnRect(rt, ts.key, ts.tw.cur), ts.tw.cur); } }
      stepTween(ts.tw, dt);
      ts.alpha = ts.want ? Math.min(1, ts.alpha + dt / 0.35) : Math.max(0, ts.alpha - dt / 0.4);
      ts.speak += (Math.min(1, inp.speak(ts.key) * 1.6) - ts.speak) * (1 - Math.exp(-dt * 12));
      if (!ts.want && ts.alpha <= 0) this.tiles.delete(ts.key);
    }
    this.cams.forget(new Set(this.tiles.keys()));
    this.tvFeed = !!st.tvFeed;
    this.dropTvQuads(new Set(this.tiles.keys()));

    // ---- capture rect: composite = the plan's; 3d = the room's React screen (morph source / target, test pattern)
    const r3 = rt.reactRect();
    const capTo = composite ? plan.capture : r3?.rect ?? null;
    if (capTo) {
      const spawn = this.cap?.cur ?? r3?.rect ?? shrink(capTo);
      this.cap = tween(this.cap, capTo, spawn);
      stepTween(this.cap, dt);
      this.capAlpha = Math.min(1, this.capAlpha + dt / 0.3);
    } else if (this.cap) { stepTween(this.cap, dt); this.capAlpha = Math.max(0, this.capAlpha - dt / 0.3); if (this.capAlpha <= 0) this.cap = null; }
    // passthrough hole: closed while anything moves, opens (0.3 s) once settled — OBS automation lines up then.
    // (React in-scene — In-scene, or Auto while the fast feed comes up — draws the window / standby / NO SIGNAL here
    // instead: never a hole just because no frame has arrived yet. Gaming keeps its hole unless a window is shared:
    // rt.compositeInScene)
    const moving = (this.cap && this.cap.t < 1) || this.comp !== this.compTo;
    const passthrough = composite && !rt.compositeInScene;
    if (!passthrough || moving || !this.cap) this.capOpen = Math.max(0, this.capOpen - dt / 0.12);
    else this.capOpen = Math.min(1, this.capOpen + dt / 0.3);
    this.reportHole(passthrough && this.capOpen >= 1 && this.comp >= 1 ? this.cap!.to : null, plan.label);

    // ---- docks: composite = the plan's rects; 3d = the free-space result while needed
    let dChat = chatSt.hidden ? null : composite ? (plan.docks.chat as Rect | null) : this.need.chat ? this.fixedChat ?? this.free?.chat ?? null : null;
    let dSup = composite ? (plan.docks.support as Rect | null) : this.need.support ? this.free?.support ?? null : null;
    if (!composite) { if (dChat) dChat = overrideRect(this.laySlot, 'chat') ?? dChat; if (dSup) dSup = overrideRect(this.laySlot, 'support') ?? dSup; }
    // hard keep-outs (mode hook): checked EVERY frame, moving cameras included — a dock that would touch one is
    // re-placed now (free space → ticker), else hidden; a tween never sweeps across one (it snaps)
    const ko = !composite ? this.keepOut : [];
    // (a chat box the streamer placed stays exactly there: their choice is never moved behind their back)
    const keepChat = !!dChat && this.chatChoice === 'box' && !!this.fixedChat;
    if (ko.length && ((dChat && !keepChat && hitsAny(dChat, ko)) || (dSup && hitsAny(dSup, ko)))) {
      const cam = this.stage.camera, r3k = rt.reactRect();
      this.free = searchFreeSpace({ aspect: cam.aspect || 16 / 9, hard: [...this.faceBoxes, ...this.visibleProps, ...(r3k ? [r3k.rect] : []), ...ko], soft: [], rail: this.rail, chat: this.need.chat, support: this.need.support, prev: null, preferRow: this.insetOn, ticker: true });
      if (!keepChat) dChat = this.need.chat ? this.free.chat : null;
      dSup = this.need.support ? this.free.support : null;
      if (dChat && !keepChat && hitsAny(dChat, ko)) dChat = null;
      if (dSup && hitsAny(dSup, ko)) dSup = null;
    }
    const twDock = (k: 'chat' | 'support', r: Rect | null) => {
      // a jump to a far-away place (another corner, another layout): fade out where it is, appear at the new place
      // (a 0.6 s slide across the frame could pass over a face)
      const tw0 = this.dockTw[k];
      if (r && tw0 && !this.dockJump[k] && !sameRect(tw0.to, r) && farApart(tw0.cur, r)) this.dockJump[k] = r;
      if (r && this.dockJump[k]) {
        this.dockJump[k] = r;
        this.dockFade[k] = Math.max(0, this.dockFade[k] - dt / 0.18);
        if (this.dockFade[k] > 0 && tw0) return tw0.cur;
        this.dockTw[k] = { from: r, to: r, cur: r, t: 1 };
        this.dockJump[k] = null;
        return r;
      }
      if (!r) this.dockJump[k] = null;
      this.dockFade[k] = Math.min(1, this.dockFade[k] + dt / 0.25);
      if (r) {
        this.dockTw[k] = tween(this.dockTw[k], r, this.dockTw[k]?.cur ?? r);
        stepTween(this.dockTw[k]!, dt);
        if (ko.length && hitsAny(this.dockTw[k]!.cur, ko)) this.dockTw[k] = { from: r, to: r, cur: r, t: 1 };
      } else if (ko.length && this.dockTw[k] && hitsAny(this.dockTw[k]!.cur, ko)) this.dom.shown[k] = 0;   // (no fade-out over a screen)
      return r ? this.dockTw[k]!.cur : null;
    };
    this.docked = { chat: twDock('chat', dChat), support: twDock('support', dSup) };
    const W = this.stage.canvas.clientWidth || 1920, H = this.stage.canvas.clientHeight || 1080;
    this.dom.chatText = st.chatText ?? 1;
    this.dom.dockOpacity = this.look.panels;
    // the chat box as plain text (its style, or this layout's look): the HUD layer draws it, the panel steps out
    const chatText = (this.look.chat === 'auto' ? (this.chatPlace?.style === 'text' ? 'text' : 'panel') : this.look.chat) === 'text';
    this.dom.fade = { chat: this.dockFade.chat, support: this.dockFade.support };
    this.dom.docks(chatText ? null : this.docked.chat, this.docked.support, W, H, dt);
    this.hud.chatDock(chatText ? this.docked.chat : null, chatTextOptions(this.hudBag.chatText), { frameW: W, frameH: H, now: Date.now(), dt, palette: pal, chat: chatSt },
      st.chatText ?? 1, Math.max(0.3, Math.min(1, this.chatPlace?.opacity ?? 1)) * this.dockFade.chat);
    // ---- HUD elements (HUD layouts): fade with the composite view
    this.hud.update(composite || this.comp > 0 ? plan.hud : null, { frameW: W, frameH: H, now: Date.now(), dt, palette: pal, chat: chatSt }, this.comp);

    // ---- name tags
    const tags: TagSpec[] = [];
    for (const ts of this.tiles.values()) {
      if (ts.plan.tag === 'none' || ts.alpha <= 0.02 || ts.tw.cur.w < 0.03) continue;
      const pf = performers.find((p) => p.key === ts.key);
      tags.push({ key: ts.key, name: inp.name(ts.key), rect: ts.tw.cur, where: ts.plan.tag === 'below' ? 'below' : 'inside', hero: !!ts.plan.hero, speak: ts.speak, alpha: ts.alpha * (ts.tw.t < 1 ? ts.tw.t : 1) * this.look.tags, sub: pf && !pf.seated ? (pf.present ? 'joining…' : 'away') : '' });
    }
    this.dom.tagsFor(tags, H);
    // ---- line-up test
    const test = (st.test ?? 0) > (inp.now ?? Date.now());
    this.testOn = test;
    this.dom.testLabel(test && this.cap ? this.cap.cur : null, H);
  }
  private testOn = false;

  /** Where a new cam grows from: the performer's face in the current room shot (3d), else its own centre. */
  private spawnRect(rt: SceneRuntime, key: string, to: Rect): Rect {
    const a = rt.actors.get(key), spot = rt.seatOf(key);
    const f = a && spot ? a.faceAt(spot) : null;
    if (f && this.comp < 0.5) {
      const cam = this.stage.camera;
      const p = f.center.clone().project(cam);
      if (p.z < 1 && Math.abs(p.x) < 1.2 && Math.abs(p.y) < 1.2) {
        const s = Math.max(0.02, (f.size / Math.max(0.1, f.center.distanceTo(cam.position))) / (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2)));
        return { x: (p.x + 1) / 2 - s * 1.2 / cam.aspect, y: (1 - p.y) / 2 - s * 1.2, w: s * 2.4 / cam.aspect, h: s * 2.4 };
      }
    }
    return shrink(to);
  }

  /** React Big / Side: the room shot drawn in plan.inset (the camera's view widened around it: setViewOffset). */
  private insetK = 1;
  private insetR: Rect = { x: 0, y: 0, w: 1, h: 1 };
  private insetOn = false;
  private applyInset(dt: number, plan: StagePlan) {
    const to = plan.view === '3d' && plan.inset ? plan.inset : null;
    const k = to ? to.w : 1;
    this.insetK = this.insetK < k ? Math.min(k, this.insetK + dt / MORPH * 0.4) : this.insetK > k ? Math.max(k, this.insetK - dt / MORPH * 0.4) : k;
    if (to) this.insetR = to;
    const cam = this.stage.camera;
    if (this.insetK >= 0.999) { if (this.insetOn) { cam.clearViewOffset(); this.insetOn = false; } return; }
    const W = this.stage.canvas.clientWidth || 1920, H = this.stage.canvas.clientHeight || 1080;
    const f = (1 - this.insetK) / (1 - (this.insetR.w || 0.8) + 1e-6);
    cam.setViewOffset(W * this.insetK, H * this.insetK, -this.insetR.x * W * f, -this.insetR.y * H * f, W, H);
    this.insetOn = true;
  }

  private bind(rt: SceneRuntime | null) {
    if (this.insetOn) { this.stage.camera.clearViewOffset(); this.insetOn = false; this.insetK = 1; }
    stageModeDef(this.modeAttached)?.page?.detach?.();
    this.modeAttached = null;
    this.rt = rt; this.cams.bind(rt); this.rays = null;
    this.tiles.clear(); this.blockers = []; this.cap = null; this.capOpen = 0; this.comp = this.compTo = 0; this.free = null; this.rail = [];
    this.need = { chat: false, support: false }; this.dockTw = { chat: null, support: null };
    if (this.holeOpenSent) { this.holeOpenSent = false; this.onHole?.(false, null, ''); }
  }

  /** What a docked poll card must never touch this frame (normalised screen rects): faces, props, mode keep-outs
   *  (interview screens), performer cams, the capture / React screen and the docked chat + support. */
  pollAvoid(): Rect[] {
    const out: Rect[] = [...this.visibleProps, ...this.keepOut];
    if (this.comp < 1) out.push(...this.faceBoxes);
    for (const t of this.tiles.values()) if (t.alpha > 0.02) out.push(t.tw.cur);
    if (this.cap && this.capAlpha > 0.02) out.push(this.cap.cur);
    if (this.docked.chat) out.push(this.docked.chat);
    if (this.docked.support) out.push(this.docked.support);
    return out.filter((r) => r && r.w > 0 && r.h > 0);
  }

  // ---------------------------------------------------------------- 3d views
  private look3d(dt: number, rt: SceneRuntime, plan: StagePlan, performers: ModePerformer[], wantChat: boolean, wantSup: boolean, chatSt: typeof DEFAULT_CHAT_STATE) {
    this.freeT -= dt;
    const settled = !rt.rig.moving && rt.rig.settledFor > 0.25;
    // chat / support shown by the in-world rigs right now?
    let d: ReturnType<ChatScene['debug']> | null = null;
    try { d = this.chatScene.debug(); } catch { d = null; }
    const mon = d?.monitor as { down?: boolean; center?: number[]; width?: number } | undefined;
    const brd = d?.board as { down?: boolean; center?: number[]; width?: number } | undefined;
    const monitorOn = !!chatSt.monitor && !!mon?.down;
    const boardOn = chatSt.panel === 'panel' && !!brd?.down;
    const buddyOn = !!chatSt.buddy && !!d?.buddy?.shown && !!d.check && ['world', 'fore', 'overlay'].includes(d.check.mode as string);
    const chatSeen = monitorOn || buddyOn, supSeen = boardOn || (chatSt.panel === 'monitor' && monitorOn);
    this.pollWorld = boardOn ? 'board' : monitorOn ? 'monitor' : null;
    // hysteresis: dock after 1.2 s without the rig (settled shot), undock after 0.6 s with it
    const hy = (want: boolean, seen: boolean, k: 'chat' | 'support') => {
      const miss = k === 'chat' ? 'chatMiss' : 'supMiss', ok = k === 'chat' ? 'chatOk' : 'supOk';
      if (!want) { this.since[miss] = 0; this.since[ok] = 0; return false; }
      if (seen) { this.since[ok] += dt; this.since[miss] = 0; } else if (settled || this.need[k]) { this.since[miss] += dt; this.since[ok] = 0; }
      if (this.need[k]) return this.since[ok] < 0.6;
      return this.since[miss] > 1.2;
    };
    // ("Always": the box stays even while an in-world chat prop is in the shot)
    this.need.chat = hy(wantChat && plan.docks.chat !== null, chatSeen, 'chat') || (wantChat && this.chatAlways && plan.docks.chat !== null);
    this.need.support = hy(wantSup && plan.docks.support !== null, supSeen, 'support');
    if (!settled || this.freeT > 0) return;
    this.freeT = 0.25;
    const cam = this.stage.camera;
    cam.updateMatrixWorld();
    const camPos = cam.getWorldPosition(new THREE.Vector3());
    this.rays ??= new RoomRays(rt.room);
    const vt = Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2);
    // faces: visible ones are keep-outs; unclear ones go to the rail (React)
    const faces: Rect[] = [];
    const rail: string[] = [];
    const caps = this.capsules(rt);
    // React: nobody sits in front of the window — a performer covering > 12 % of the room's screen in this shot is
    // left out of the room render and gets a cam instead (their own cam still shows them)
    const r3b = plan.rail ? rt.reactRect() : null;
    const blockers: string[] = [];
    const hints: Record<string, [number, number]> = {};
    // how much of the screen a performer's real bounds (costumes / big mascots are much wider than a capsule) cover,
    // at their seat or moved to another spot (translated, not re-measured)
    const covers = (box: THREE.Box3, shift: THREE.Vector3 | null) => {
      const pts = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => new THREE.Vector3(k & 1 ? box.max.x : box.min.x, k & 2 ? box.max.y : box.min.y, k & 4 ? box.max.z : box.min.z).add(shift ?? new THREE.Vector3()).project(cam));
      if (pts.some((q) => q.z > 1)) return 0;
      const xs = pts.map((q) => (q.x + 1) / 2), ys = pts.map((q) => (1 - q.y) / 2);
      const w = Math.min(Math.max(...xs), r3b!.rect.x + r3b!.rect.w) - Math.max(Math.min(...xs), r3b!.rect.x), h = Math.min(Math.max(...ys), r3b!.rect.y + r3b!.rect.h) - Math.max(Math.min(...ys), r3b!.rect.y);
      return w > 0 && h > 0 ? (w * h) / Math.max(1e-6, r3b!.rect.w * r3b!.rect.h) : 0;
    };
    if (r3b) {
      const taken = new Set([...rt.actors.values()].map((a) => rt.seatOf(a.key)?.index).filter((i): i is number => i !== undefined));
      for (const a of rt.actors.values()) {
        if (!a.runtime || !a.mount.visible || rt.mover.busy(a)) continue;      // (walking to another seat: seen walking)
        const box = a.runtime.bounds();
        if (box.isEmpty() || covers(box, null) <= 0.12) continue;
        blockers.push(a.key);
        // a seat where they wouldn't be in front of the window (the host's controller walks them there: reseatForBig)
        const here = rt.seatOf(a.key);
        if (!here) continue;
        const free = rt.room.spots.filter((s): s is NonNullable<typeof s> => !!s && !taken.has(s.index) && s.pose === here.pose)
          .sort((p, q) => p.position.distanceToSquared(here.position) - q.position.distanceToSquared(here.position));
        const ok = free.find((s) => covers(box, s.position.clone().sub(here.position)) <= 0.04);
        if (ok) { hints[a.key] = [here.index, ok.index]; taken.add(ok.index); }
      }
    }
    this.blockers = blockers;
    this.reseatHints = hints;
    for (const p of performers) {
      if (!p.present) continue;
      const a = rt.actors.get(p.key), spot = rt.seatOf(p.key);
      const f = a && spot ? a.faceAt(spot) : null;
      if (!a || !spot || !f || blockers.includes(p.key)) { if (plan.rail) rail.push(p.key); continue; }
      const q = f.center.clone().project(cam);
      const dist = f.center.distanceTo(camPos);
      // (the head, not the face marker: face measures range from the eyes only to the whole head)
      const head = Math.max(f.size, (a.rest?.height ?? 1.6) * a.scale * 0.11);
      const hf = head / Math.max(0.05, dist) / (2 * vt) / (this.insetOn ? 1 / this.insetK : 1);
      const inFrame = q.z < 1 && Math.abs(q.x) < 0.96 && Math.abs(q.y) < 0.94;
      // well inside = the whole HEAD (a big mascot's head reaches far past its face centre), not just the face centre:
      // anyone the frame edge cuts gets their own cam
      const hwN = (hf * 1.25 * 2) / cam.aspect, hhN = hf * 1.4;
      const wellIn = q.z < 1 && Math.abs(q.x) < 0.88 && Math.abs(q.y) < 0.86 && Math.abs(q.x) + hwN < 0.98 && q.y + hhN < 0.98;
      if (inFrame) {
        const cx = (q.x + 1) / 2, cy = (1 - q.y) / 2, hw = hf * 1.25 / cam.aspect;
        faces.push({ x: cx - hw, y: cy - hf * 1.7, w: hw * 2, h: hf * 3.0 });
      }
      if (!plan.rail) continue;
      const toCam = camPos.clone().sub(f.center).setY(0).normalize();
      const front = spot.forward.dot(toCam) > -0.1;
      let clear = wellIn && hf >= 0.035 && front && this.rays.hit(f.center, camPos, 0.15) === Infinity;
      if (clear) for (const c of caps) if (c.key !== p.key && segCapsule(camPos, f.center, c)) { clear = false; break; }
      if (!clear) rail.push(p.key);
    }
    this.faceBoxes = faces;
    // hysteresis on the rail list itself: only change it when it differs twice in a row
    const sig = rail.join(',');
    if (sig !== this.rail.join(',')) { if (this.railPending === sig) { this.rail = rail; this.railPending = ''; } else this.railPending = sig; } else this.railPending = '';
    // in-world props on screen: never cover them
    const props: Rect[] = [];
    const propRect = (pr: { center?: number[]; width?: number } | undefined, asp: number) => {
      if (!pr?.center || !pr.width) return;
      const c = new THREE.Vector3(...(pr.center as [number, number, number]));
      const hw = pr.width / 2, hh = pr.width * asp / 2;
      const pts = [[-hw, -hh], [hw, -hh], [hw, hh], [-hw, hh]].map(([x, y]) => new THREE.Vector3(c.x + x, c.y + y, c.z).project(cam));
      const xs = pts.map((v) => (v.x + 1) / 2), ys = pts.map((v) => (1 - v.y) / 2);
      props.push({ x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) });
    };
    if (monitorOn) propRect(mon, 4 / 3);
    if (boardOn) propRect(brd, 9 / 16);
    this.visibleProps = props;
    const r3 = rt.reactRect();
    const hard = [...faces, ...props, ...(r3 ? [r3.rect] : []), ...this.keepOut, ...(this.fixedChat && this.need.chat ? [this.fixedChat] : [])];
    this.free = searchFreeSpace({ aspect: cam.aspect || 16 / 9, hard, soft: [], rail: this.rail, chat: this.need.chat && !this.fixedChat, support: this.need.support, prev: this.free, preferRow: this.insetOn, ticker: this.keepOut.length > 0 });
  }
  private railPending = '';
  /** Docks on their way to a far-away place (fading out first) and their fade (0..1). */
  private dockJump: { chat: Rect | null; support: Rect | null } = { chat: null, support: null };
  private dockFade = { chat: 1, support: 1 };
  /** The chat box at a place the streamer picked (3d views; composite plans carry it in plan.docks.chat). */
  private fixedChat: Rect | null = null;
  /** Docked chat "Always" (SceneStageState.dock.chat). */
  private chatAlways = false;
  /** chatfx: the chat box place for this room + mode (shared/chatBox.ts resolveChatBox) and which place the stream uses. */
  private chatPlace: ChatBoxCore | null = null;
  private chatChoice: 'box' | 'layout' | 'auto' = 'auto';
  /** The current mode's hard keep-outs for the docks (ModePageHooks.keepOut), this frame. */
  private keepOut: Rect[] = [];
  /** React Big: member key → [their seat, a free seat where they wouldn't cover the screen] (studio report). */
  reseatHints: Record<string, [number, number]> = {};
  /** Performers hidden from the room render (in front of the React screen); they're on the rail. */
  private blockers: string[] = [];

  /** Performers as capsules (feet → head): the cheap stand-in for their skinned meshes (never raycast those). */
  private capsules(rt: SceneRuntime) {
    const out: { key: string; a: THREE.Vector3; b: THREE.Vector3; r: number }[] = [];
    for (const a of rt.actors.values()) {
      if (!a.runtime || !a.mount.visible || !a.rest) continue;
      const h = a.rest.height * a.scale, f = a.rest.face.size * a.scale;
      const r = THREE.MathUtils.clamp(Math.max(f * 1.1, h * 0.12), 0.08, 0.6);
      const base = a.mount.position, top = h * (a.sit > 0.5 ? 0.78 : 1);
      out.push({ key: a.key, a: base.clone().setY(base.y + Math.min(r, top * 0.4)), b: base.clone().setY(base.y + Math.max(r, top - r * 0.6)), r: r * 0.8 });
    }
    return out;
  }

  private reportHole(rect: Rect | null, label: string) {
    const now = performance.now();
    if (rect && (!this.holeOpenSent || now - this.holeBeat > 5000)) { this.holeOpenSent = true; this.holeBeat = now; this.onHole?.(true, rect, label); }
    else if (!rect && this.holeOpenSent) { this.holeOpenSent = false; this.onHole?.(false, null, label); }
  }

  // ---------------------------------------------------------------- render
  /** Draw the frame when the layout needs to (returns false = the page renders the room as usual). */
  render(): boolean {
    const rt = this.rt, plan = this.plan;
    if (!rt || !plan) return false;
    const tiles = [...this.tiles.values()].filter((t) => t.alpha > 0.01 && t.tw.cur.w > 0.004 && t.tw.cur.h > 0.004);
    const composite = this.comp > 0;
    if (!composite && !tiles.length && !this.testOn && !this.blockers.length) return false;
    const r = this.stage.renderer;
    const W = this.stage.canvas.clientWidth || 1, H = this.stage.canvas.clientHeight || 1;
    const pr = r.getPixelRatio();
    const autoClear = r.autoClear;
    const clearColor = r.getClearColor(new THREE.Color()), clearAlpha = r.getClearAlpha();
    const base3d = this.comp < 1;
    this.tgt = null;
    const hideM = base3d && this.comp <= 0 ? this.blockers.map((k) => rt.actors.get(k)?.mount).filter((m): m is THREE.Group => !!m && m.visible) : [];
    for (const m of hideM) m.visible = false;
    if (base3d) this.stage.render();
    else { r.setRenderTarget(null); r.setClearColor(0x000000, 0); r.clear(true, true, true); }
    for (const m of hideM) m.visible = true;
    r.autoClear = false;
    // ---- performer cams: through the post chain (High / Ultra: bloom, grade, SMAA) in composite frames, else
    //      scissored straight onto the canvas
    const t0 = performance.now();
    const far = Math.max(60, this.stage.camera.far);
    const bg = this.stage.background;
    let posted = false;
    if (!base3d && tiles.length && this.post) {
      try { posted = this.post((target) => { this.tgt = target; for (const ts of tiles) this.renderTile(r, rt, ts, W, H, far, bg); this.tgt = null; }); }
      catch (e) { console.warn('[stage] post', e); posted = false; this.tgt = null; }
      r.setRenderTarget(null);
      r.autoClear = false;
    }
    if (!posted) for (const ts of tiles) this.renderTile(r, rt, ts, W, H, far, bg);
    this.postOn = posted;
    r.setScissorTest(false);
    r.setViewport(0, 0, W, H);
    const ms = performance.now() - t0;
    this.perf = { tiles: tiles.length, ms, avg: this.perf.avg * 0.95 + ms * 0.05 };
    // ---- frame passes
    const u = this.fx.uniforms;
    (u.uRes.value as THREE.Vector2).set(W * pr, H * pr);
    u.uTime.value = this.time;
    u.uScale.value = (H * pr) / 1080;
    u.uView.value = composite ? 1 : 0;
    u.uAlpha.value = this.comp;
    u.uTest.value = this.testOn ? 1 : 0;
    const px = (rc: Rect, out: THREE.Vector4) => out.set(rc.x * W * pr, (1 - rc.y - rc.h) * H * pr, rc.w * W * pr, rc.h * H * pr);
    const cap = this.cap;
    const video = composite ? rt.capturePicture : null;
    const look = this.look, fp = frameParams(look), sc = u.uScale.value as number;
    const capR = look.screenRadius * sc;
    if (cap && (composite || this.testOn)) {
      px(cap.cur, u.uCap.value as THREE.Vector4);
      (u.uCapP.value as THREE.Vector4).set(capR, composite ? this.capOpen : 1, video ? 2 : 1, 0);
    } else (u.uCapP.value as THREE.Vector4).set(0, 0, 0, 0);
    (u.uLook.value as THREE.Vector4).set(look.backdrop, look.dim, look.blur, look.screenDim);
    (u.uLook2.value as THREE.Vector4).set(fp.capRing, look.panels, fp.tileShadow, 0);
    const tv = u.uTiles.value as THREE.Vector4[], tp = u.uTileP.value as THREE.Vector4[], tq = u.uTileQ.value as THREE.Vector4[];
    let n = 0;
    for (const ts of tiles) {
      if (n >= MAX_TILES) break;
      // (whole pixels, exactly the cam's scissor in renderTile: a fractional edge column left uncovered by the cam render
      //  but skipped by the solid pass showed through as a 1 px line beside a cut-out)
      const c0 = ts.tw.cur, ix = Math.round(c0.x * W), iy = Math.round((1 - c0.y - c0.h) * H);
      tv[n].set(ix * pr, iy * pr, Math.round(c0.w * W) * pr, Math.round(c0.h * H) * pr);
      const cut = ts.plan.backdrop === 'cutout';
      // (look: radius; the old 16 px stays capped at 12 % of a small cam, bigger radii up to a pill; cut-outs: square)
      const rr = composite ? look.radius : 16, k12 = Math.max(0.12, (rr / 16) * 0.12);
      const rad = cut ? 0 : Math.min(rr * sc, tv[n].z * Math.min(0.5, k12), tv[n].w * Math.min(0.5, k12));
      const bez = !composite || fp.bezel < 0 ? Math.max(rad * 0.45, 4 * sc) : fp.bezel * sc;
      tp[n].set(rad, bez, ts.plan.hero ? 1 : 0, ts.speak);
      tq[n].set(ts.alpha, cut ? 1 : 0, composite ? fp.glow : 0, composite ? look.camOpacity : 1);
      n++;
    }
    u.uTileN.value = n;
    const dv = u.uDocks.value as THREE.Vector4[], dp = u.uDockP.value as THREE.Vector4[];
    const docks = [this.docked.chat, this.docked.support];
    const sh = [this.dom.shown.chat, this.dom.shown.support];
    const fd = [this.dockFade.chat, this.dockFade.support];
    for (let i = 0; i < 2; i++) { const d = docks[i]; if (d && composite) { px(d, dv[i]); dp[i].set(14 * u.uScale.value, sh[i] * fd[i], 0, 0); } else dp[i].set(0, 0, 0, 0); }
    // ---- layout look: see-through cams (their picture's alpha x opacity), the cut-outs' alpha for shadow / outline
    const cutN = composite ? tiles.filter((t) => t.plan.backdrop === 'cutout').length : 0;
    const fade = composite && n > 0 && look.camOpacity < 0.999;
    if (fade) this.fx.drawUnder(r, 3);
    const cutFx = cutN > 0 && (look.shadow > 0.01 || look.outline > 0.05);
    if (cutFx) { const b = r.getDrawingBufferSize(new THREE.Vector2()); this.fx.copyCut(r, b.x, b.y); } else this.fx.dropCut();
    (u.uCutP.value as THREE.Vector4).set(look.outline * sc, look.shadow, 12 * sc, cutFx ? 1 : 0);
    (u.uOutC.value as THREE.Color).setStyle(look.outlineColor, THREE.LinearSRGBColorSpace);
    // ---- in-scene capture (a shared window / the fast feed): after the cams, masked by them (Full's cams in front)
    const src = composite && this.comp > 0.5 && this.cap ? rt.capturePicture : null;
    if (src && this.cap) {
      const c0 = this.cap.cur;
      this.fx.drawVideo(r, src.tex, new THREE.Vector4(c0.x * W * pr, (1 - c0.y - c0.h) * H * pr, c0.w * W * pr, c0.h * H * pr), src.aspect, capR);
    }
    this.fx.draw(r, 0, base3d && composite);
    // behind cut-out / see-through cams: what the solid pass skipped there (+ shadow / outline), then the window
    if (cutN > 0 || fade) {
      this.fx.drawUnder(r, 2);
      if (src && this.cap) this.fx.drawVideoBehind(r);
    }
    // capture cover (src/scene/capcover): over the capture rect, never over a cam (the 3d React screens draw it on the mesh)
    if (capCover.visible && composite && this.cap) { const c0 = this.cap.cur; this.fx.drawCover(r, new THREE.Vector4(c0.x * W * pr, (1 - c0.y - c0.h) * H * pr, c0.w * W * pr, c0.h * H * pr), capR); }
    this.fx.draw(r, 1);
    r.autoClear = autoClear;
    r.setClearColor(clearColor, clearAlpha);
    return true;
  }

  private hidden: THREE.Object3D[] = [];
  private renderTile(r: THREE.WebGLRenderer, rt: SceneRuntime, ts: TileState, W: number, H: number, far: number, bg: string | null) {
    const rc = ts.tw.cur;
    const x = Math.round(rc.x * W), y = Math.round((1 - rc.y - rc.h) * H), w = Math.round(rc.w * W), h = Math.round(rc.h * H);
    if (w < 4 || h < 4) return;
    const pose = this.cams.pose(ts.key, w / h, ts.plan.framing);
    const tg = this.tgt, pr = r.getPixelRatio();
    if (tg) {
      tg.viewport.set(x * pr, y * pr, w * pr, h * pr); tg.scissor.copy(tg.viewport); tg.scissorTest = true;
      r.setRenderTarget(tg);
    } else { r.setViewport(x, y, w, h); r.setScissor(x, y, w, h); r.setScissorTest(true); }
    const bd = ts.plan.backdrop;
    // walking-TV guests (S\tv\PERFORMER_API.md), with the option on: their live picture, framed like a TV
    if (this.tvFeed && tvOfActor(rt.actors.get(ts.key)) && this.drawTvFeed(r, ts.key, w / h)) return;
    if (!pose) {
      // nobody at that seat yet (joining / walked out): the studio backdrop with the name tag
      this.fx.drawStudio(r, new THREE.Vector4(x * pr, y * pr, w * pr, h * pr), !!tg);
      return;
    }
    const cam = this.cams.camera(ts.key, pose, w / h, far);
    if (bd === 'room') {
      r.setClearColor(bg ?? '#0b0d12', 1);
      r.clear(true, true, true);
      // only this performer of the party: a neighbour at the cam's edge costs a whole skinned render per cam (8 cams
      // with everyone in view measured 17 ms/frame; one performer per cam scales linearly)
      this.isolateActors(rt, ts.key, true);
    } else {
      if (bd === 'clean') this.fx.drawStudio(r, new THREE.Vector4(x * pr, y * pr, w * pr, h * pr), !!tg);
      else { r.setClearColor(0x000000, 0); r.clear(true, false, false); }
      r.clearDepth();
      this.isolate(rt, ts.key, true);
    }
    r.render(this.stage.scene, cam);
    this.isolate(rt, ts.key, false);
  }

  /** The post pipeline's scene target while the cams render into it (renderComposite), else null (the canvas). */
  private tgt: THREE.WebGLRenderTarget | null = null;
  /** The last composite frame went through the post chain. */
  postOn = false;

  /** SceneStageState.tvFeed (set each update). */
  private tvFeed = false;
  private tvQuads = new Map<string, { scene: THREE.Scene; mat: THREE.ShaderMaterial }>();
  private tvCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
  private drawTvFeed(r: THREE.WebGLRenderer, key: string, aspect: number): boolean {
    let q = this.tvQuads.get(key);
    if (!q) {
      const mat = tvFeedMaterial(key, { fx: 'tv', aspect });
      if (!mat) return false;
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), mat);
      mesh.frustumCulled = false;
      scene.add(mesh);
      q = { scene, mat };
      this.tvQuads.set(key, q);
    }
    (q.mat.userData as { setAspect?: (a: number) => void }).setAspect?.(aspect);
    r.clear(true, true, true);
    r.render(q.scene, this.tvCam);
    return true;
  }
  private dropTvQuads(keep: Set<string>) {
    for (const [k, q] of this.tvQuads) if (!keep.has(k) || !this.tvFeed) { q.mat.dispose(); (q.scene.children[0] as THREE.Mesh).geometry.dispose(); this.tvQuads.delete(k); }
  }

  /** Room cams: the other performers step out of this render (the room stays). */
  private isolateActors(rt: SceneRuntime, key: string, on: boolean) {
    if (!on) return;
    for (const a of rt.actors.values()) if (a.key !== key && a.mount.visible) { a.mount.visible = false; this.hidden.push(a.mount); }
    // (the in-world chat's confetti is for room shots: in a cam it's a handful of huge squares in front of a face)
    for (const c of rt.root.children) if (c.name === 'vtp:chat:confetti' && c.visible) { c.visible = false; this.hidden.push(c); }
  }

  /** Clean / cut-out cams: only the performer (and the lights) are drawn. */
  private isolate(rt: SceneRuntime, key: string, on: boolean) {
    if (!on) { for (const o of this.hidden) o.visible = true; this.hidden.length = 0; return; }
    const keep = rt.actors.get(key)?.mount;
    const hide = (o: THREE.Object3D) => { if (o.visible) { o.visible = false; this.hidden.push(o); } };
    for (const o of this.stage.scene.children) {
      if ((o as THREE.Light).isLight) continue;
      if (o === rt.root) { for (const c of rt.root.children) if (c !== keep) hide(c); continue; }
      hide(o);
    }
  }

  /** Debug / studio report. */
  info() {
    const p = this.plan;
    return {
      label: p?.label ?? '', view: p?.view ?? '3d', key: p?.key ?? '', custom: !!this.laySlot,
      capture: p?.view === 'composite' ? p.capture : this.cap?.to ?? null,
      open: this.capOpen >= 1,
      tiles: [...this.tiles.values()].filter((t) => t.want).map((t) => ({ key: t.key, rect: t.tw.to, hero: !!t.plan.hero, slot: p?.view === 'composite' ? p.tiles.findIndex((x) => x.key === t.key) : (this.free?.rail.findIndex((x) => x.key === t.key) ?? -1) })),
      rail: this.rail, blockers: this.blockers, reseat: this.reseatHints, docks: { chat: this.docked.chat, support: this.docked.support }, need: { ...this.need },
      faces: this.faceBoxes, props: this.visibleProps, keepOut: this.keepOut,
      perf: { tiles: this.perf.tiles, ms: +this.perf.ms.toFixed(2), avg: +this.perf.avg.toFixed(2), post: this.postOn },
      look: this.look, hud: (p?.view === 'composite' ? p.hud ?? [] : []).map((e) => ({ id: e.id, type: e.type, rect: e.rect })), chatText: this.hud.chatInfo(),
    };
  }

  dispose() { this.bind(null); this.dom.dispose(); this.hud.dispose(); this.fx.dispose(); }
}

/** Far enough apart that a dock should fade out + in instead of sliding across the frame (no overlap, centres > 0.25). */
function farApart(a: Rect, b: Rect) {
  const ov = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  return !ov && Math.hypot(a.x + a.w / 2 - b.x - b.w / 2, a.y + a.h / 2 - b.y - b.h / 2) > 0.25;
}

/** Does a dock rect touch any keep-out (1.5 px at 1080p of slack)? */
function hitsAny(r: Rect, ko: Rect[]) {
  const e = 0.0014;
  return ko.some((k) => r.x < k.x + k.w + e && r.x + r.w > k.x - e && r.y < k.y + k.h + e && r.y + r.h > k.y - e);
}

/** Does the segment p → q pass through the capsule (a–b, radius r)? */
function segCapsule(p: THREE.Vector3, q: THREE.Vector3, c: { a: THREE.Vector3; b: THREE.Vector3; r: number }) {
  const d1 = q.clone().sub(p), d2 = c.b.clone().sub(c.a), rr = p.clone().sub(c.a);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(rr);
  let s = 0, t = 0;
  const cc = d1.dot(rr), b = d1.dot(d2), den = a * e - b * b;
  s = den > 1e-9 ? THREE.MathUtils.clamp((b * f - cc * e) / den, 0, 0.97) : 0;
  t = e > 1e-9 ? (b * s + f) / e : 0;
  if (t < 0) { t = 0; s = THREE.MathUtils.clamp(-cc / a, 0, 0.97); } else if (t > 1) { t = 1; s = THREE.MathUtils.clamp((b - cc) / a, 0, 0.97); }
  return p.clone().addScaledVector(d1, s).distanceTo(c.a.clone().addScaledVector(d2, t)) < c.r;
}
