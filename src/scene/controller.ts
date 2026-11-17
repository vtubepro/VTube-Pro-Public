// Studio side of 3D scenes: the HOST owns the scene state (room, mode, camera, spots, presence, lights).
//
//  host / solo  → edits persist to /api/scene (the server broadcasts {type:'scene'} to this PC's OBS pages)
//                 and go to every party guest over the party link.
//  party guest  → receives the host's state and relays it to its own OBS pages on the local bus
//                 (with self = its party id so its OBS knows which avatar is "me"); can opt out ("Classic
//                 on my OBS") without affecting anyone else.
//  ?observer=1  → a sandbox: nothing is saved, broadcast or sent; only its own Scene-tab preview follows.
//
// Spot rules: the host's spot wins; guests are auto-assigned free spots, remembered per room by their Discord user
// id (stable; invite-code guests: by NAME) so a reconnecting guest (new random party id) gets their old seat back; moving someone onto an occupied spot
// swaps the two. Size classes (shared/avatarSize.ts): every spot has a fit per class (a fairy's table perch never
// takes a person; micro / macro performers prefer their own spots and fall back to ordinary ones), a move onto a spot
// that doesn't fit is refused with a warning, and auto-assigned micro / macro guests move up to their own spot once
// the room's size spots are known.
//
// Walks (entrances / exits / spot changes, src/scene/walkMover.ts): every presence / spot change is stamped as
// state.moves[key] = { from, to, at } (at = start, epoch ms). Door walks are queued 1.2 s apart; a guest who
// just joined walks in a few seconds later (their model is still downloading on the OBS pages). Guests convert
// the host's clock to theirs (state.sentAt) before relaying, so every OBS starts the walk at the same moment.
//
// Director API (later: an automatic director / stream deck / MCP): app.scene.setCamera('wide'),
// .setMode('react'), .setScene('test_room'|null), .move(key, spot), .setPresent(key, bool), .setFocus(key),
// or a bus command {type:'command', command:'scene', args:{camera?, mode?, sceneId?, focus?}}.
import { DEFAULT_AMBCAM, ambientCommand, type SceneAmbientCam } from '../../shared/ambientCam.ts';
import type { SceneInfo, SceneLightsState, SceneMode, SceneState } from '../../shared/types.ts';
import { baseRoomId } from '../../shared/roomId.ts';
import { pruneDeparted, restoreDeparted, syncInterviewLineup, type InterviewGuest } from '../../shared/talkshow.ts';
import { lineupWithoutWaiting, restoreSlot } from '../../shared/greenroom.ts';
import { HOST_KEY, MAX_SPOTS, MAX_SPOT_INDEX, defaultSceneState, isSceneId, sanitizeEntrances, sanitizeSceneState, sanitizeScreen } from '../../shared/scene.ts';
import { SIZE_LABEL, avatarSize, pickSpot, spotFit, type AvatarSize, type SeatSpot } from '../../shared/avatarSize.ts';
import { GM_SPOT, gmSeatRule } from '../../shared/ttrpg/state.ts';
import { isLightingState } from '../../shared/lightShow.ts';
import { api } from '../api.ts';
import type { Bus } from '../bus.ts';
import type { Party } from '../party.ts';
import { PreviewGate, type PreviewExtra, type PreviewHost, type PreviewPage, type PreviewReport, type RoomSummary } from './previewLink.ts';
import { bridgeStats, installPreviewBridge, previewIsolationOrigin } from './previewBridge.ts';
import { StudioChat } from '../chat/studioChat.ts';
import { installGoalsRelay } from '../goals/goalsRelay.ts';
import { installDeckRelay } from './djdeck/deckRelay.ts';
import { sanitizeDjDeckState, type SceneDjDeckState } from '../../shared/djDeck/state.ts';
import { followRoomPrefs, loadRoomPrefs, rememberRoomMemory, roomMemory } from '../net/roomPrefs.ts';
import { SceneSync } from './sceneSync.ts';
import { DEFAULT_CHAT_BOX, sanitizeChatBox } from '../../shared/chatBox.ts';
import { ScreenShareSender } from './screenShare.ts';
import { ScreenVideoHost } from './screenVideoHost.ts';
import { DEFAULT_VIDEO_STATE, type SceneVideoState } from '../../shared/screenVideo.ts';
import type { ScreenSettings } from '../../shared/types.ts';
import { CHAT_BOTS, DEFAULT_CHAT_STATE, sanitizeChatEvent, testChatEvents, type SceneChatState } from '../../shared/chat.ts';
import { DEFAULT_RAID_STATE, raidDonationValue, type SceneRaidState } from '../../shared/raid.ts';
import { DEFAULT_KITCHEN_STATE, kitchenUnrestAt, type SceneKitchenState } from '../../shared/kitchen.ts';
import { CLUB_BITS, CLUB_CELEBRATIONS, DEFAULT_CLUB_STATE, type SceneClubState } from '../../shared/club.ts';
import { DEFAULT_FESTIVAL_STATE, festivalLeavingRoom, festivalPatch, type SceneFestivalState } from '../../shared/festival.ts';
import { sanitizeLightStyleId } from '../../shared/lightStyles.ts';
import { reactiveLightsPatch } from '../../shared/lightDirector.ts';
import { shiftTtrpgClock, type SceneTtrpgState } from '../../shared/ttrpg/state.ts';
import { shiftSlapClock } from '../../shared/slap.ts';
import { shiftYachtClock } from '../../shared/yacht.ts';
import { shiftVoyageClock } from '../../shared/voyage.ts';
import { installVoyageHost } from './voyage/voyageHost.ts';
import { shiftLoungeClock } from '../../shared/lounge.ts';
import { DEFAULT_GFX, sanitizeGfx, type SceneGfxState } from '../../shared/graphics.ts';
import { DEFAULT_SPACE_STATE, spaceActsOf, spaceSupportKind, type SceneSpaceState } from '../../shared/space.ts';
import { AFK_CREW_MAX, DEFAULT_AFK_STATE, afkNamesOn, cleanCrewName, crewPurged, liveCrew, mergeCrew, sameCrew, sanitizeAfkState, type CrewSeen, type SceneAfkState } from '../../shared/afk.ts';
import { DEFAULT_ERA_STATE, eraAt, eraReanchor, eraShiftNow, sanitizeEraState, type SceneEraState } from '../../shared/era.ts';
import { ENV_WEATHERS, envDefaults, envHour, envWeatherAt, sanitizeEnvState, type EnvWeather, type SceneEnvState } from '../../shared/environment.ts';
import { DEFAULT_CAPCOVER, cleanCoverText, isCoverStyle, sanitizeCaptureCover, type SceneCaptureCover } from '../../shared/capcover.ts';
import { DEFAULT_BRB, isBrbStyle, sanitizeBrbState } from '../../shared/brb.ts';
import { brbArgsMerge, coverArgsPatch, lookToSceneArgs } from '../../shared/liveLook.ts';
import { DEFAULT_CURTAIN, curtainForPick, isCurtainStyle, sanitizeCurtainState, stampRoomCurtain, type CurtainStatus, type SceneCurtainState } from '../../shared/curtain.ts';
import { DEFAULT_STAGE, isModeId, resolveGaming, resolveReact, cleanStageName, sanitizeStageState, wantsLounge, type SceneStageState } from '../../shared/stage.ts';
import { stageModeDef, type ModeCtx, type ModeRoom } from './stage/registry.ts';
import { occupantOf, pickSpotOcc, spotFitOcc, type OccSpot, type Occupant, type OccupantRules } from '../../shared/occupant.ts';
import { seatRoutingOf } from './forms/spotKinds.ts';
import { FORMS_BAG, bigExitHold, formsBagOf, parseBigEntrance, parseForms, shiftFormsClock, spotIndexOfName, stampFormsBag, usesBigEntrance } from '../../shared/forms.ts';
import { isToggleId, parseRoomToggles, rememberToggles, rememberedToggles, stampToggle, toggleOn, togglesForRoom, type RoomToggleDef } from '../../shared/roomToggles.ts';
import { setPick } from '../../shared/camPick.ts';
import { GoalSignals, ReactionGate, manualReactionEvent, manualReactionSignal, matchReaction, matchSignal, pruneReactions, reactionsPending, reactionsStale, revertReactions, sanitizeRoomReactions, signalSource, stampReaction, type ReactionHit, type ReactionSignal, type ReactionSignalOn, type ReactionSource, type RoomReactionsConfig } from '../../shared/reactions.ts';
import { sanitizeGoalsView } from '../../shared/goalsView.ts';
import type { ChatEvent } from '../../shared/chat.ts';

export interface SceneMember { key: string; name: string; self: boolean; host: boolean; /** Discord user id (seat memory), when known. */ uid?: string;
  /** Real size + class (their profile's size, shared/avatarSize.ts): spot eligibility. */ size?: AvatarSize;
  /** Occupant class (room forms, shared/occupant.ts) with a room's rules: size + body plan (mech / vehicle). */ occ?: (rules?: OccupantRules, base?: number) => Occupant }

interface Memory { host?: number; byName?: Record<string, number>; /** Discord user id → spot. */ byUser?: Record<string, number> }

const MEM_KEY = 'vtp.scene.memory';
const putScene = (s: Record<string, unknown>) => fetch('/api/scene', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) })
  .then(async (r): Promise<unknown> => { if (!r.ok) throw new Error(`${r.status}`); try { return await r.json(); } catch { return null; } });
const GUEST_OPT = 'vtp.scene.guestClassic';
/** A guest's own graphics quality (the host's GPU isn't theirs): never taken from the host's state. */
const GFX_LOCAL = 'vtp.gfx.local';
/** Room prop toggles the host chose, per room (base room id, so every area of a room shares them): { room: { id: on } }. */
const TOGGLES_MEM = 'vtp.scene.toggles';

export class SceneController {
  /** What the host authored (host / solo) — or the host's state as received (guest). */
  state: SceneState = defaultSceneState();
  scenes: SceneInfo[] = [];
  /** Room summaries (spots / cameras) reported by a preview, per scene id. */
  rooms = new Map<string, RoomSummary>();
  report: PreviewReport | null = null;
  /** Guest only: show Classic on my OBS regardless of the host's room. */
  guestClassic = localStorage.getItem(GUEST_OPT) === '1';
  /** Observer sandbox: stand-in members (library avatars) to try spots with. */
  testMembers: PreviewExtra[] = [];
  private hostState: SceneState | null = null;
  private listeners = new Set<(what: string) => void>();
  private lastRole: string = 'none';
  private pages = new Set<PreviewPage>();
  private capture: MediaStream | null = null;
  private sendT = 0;
  /** The helper's scene state <-> this studio (src/scene/sceneSync.ts): first read retried until it answers, only this
   *  tab's changes are saved, other tabs' saves merged in, failed saves retried. */
  private readonly sync: SceneSync;
  /** The helper's state has been read (before that nothing is saved; edits are kept and replayed onto it). */
  private get loaded() { return this.sync.ready; }
  /** Edits made before the helper's state was read: replayed on it (an early edit used to save the defaults: Classic,
   *  chat off, over the streamer's room). */
  private early: { fn: (s: SceneState) => void; lead: number }[] = [];
  /** live-layout: the last scene save that failed (the helper said no / didn't answer) — shown, never silent. */
  saveError: { at: number; msg: string } | null = null;
  /** Host: when the last door walk was scheduled (epoch ms) — arrivals queue 1.2 s apart. */
  private doorSlot = 0;
  /** Guest: host clock → our clock (ms), the smallest recent (receive − sent) = least network delay. */
  private offsets: number[] = [];
  /** Live chat (read only): Scene-tab status + the party relay of the chat props' events (src/chat/studioChat.ts). */
  readonly chat: StudioChat;
  /** React screen share: the picked window → this PC's OBS pages (local WebRTC, in-scene capture). Host / solo only;
   *  an ?observer=1 studio never sends it (its preview still shows the window). */
  readonly share: ScreenShareSender;
  /** Screen video playlist clock (host / solo; src/scene/screenVideoHost.ts). */
  readonly video: ScreenVideoHost;

  constructor(private bus: Bus, private party: Party, readonly observer: boolean) {
    (window as unknown as { vtpScenePreview: PreviewHost }).vtpScenePreview = { connect: (p) => this.connectPreview(p) };
    // the shared room preview loaded from the other loopback name runs in its own process: same calls over a port
    installPreviewBridge((p) => this.connectPreview(p), previewIsolationOrigin(location), () => {
      const g = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
      return { obsW: g('vtp.scene.obsW'), obsH: g('vtp.scene.obsH'), lastAvatar: g('vtp.lastAvatar') };
    });
    void this.refreshScenes();
    this.sync = new SceneSync({
      get: () => api.get<SceneState>('/api/scene'),
      put: (body) => putScene(body),
      local: () => this.state,
      setLocal: (s) => { this.state = s; },
      loaded: (s) => this.onLoaded(s),
      merged: () => this.onMerged(),
      saved: (ok, err) => this.onSaved(ok, err),
    }, { readOnly: observer });
    this.sync.start();
    // other tabs' saves (a second tab): the server's own broadcast (no `src`: pages'
    // messages carry one; a guest studio's relay of its host's room has self = its party id)
    if (!observer) bus.on((m) => { if (m.type === 'scene' && m.self === HOST_KEY && !(m as { src?: string }).src) this.sync.remote(m.state); });
    // room favourites / recents / per-room seat + stage presets, kept by the helper: other tabs' changes (src/net/roomPrefs.ts)
    if (!observer) { followRoomPrefs(bus); void loadRoomPrefs(); }
    party.listeners.add(() => this.onParty());
    party.onScene = (s) => this.onHostState(s);
    party.onBeat = (b) => this.sendBeat(b);
    this.chat = new StudioChat(bus, party, observer);
    installDeckRelay(bus, party, observer);   // DJ decks → party guests (src/scene/djdeck/deckRelay.ts)
    installGoalsRelay(bus, party, observer);   // goals + the subathon timer → party guests (src/goals/goalsRelay.ts)
    this.share = new ScreenShareSender((m) => this.bus.send(m), (h) => this.bus.on(h), () => !this.observer && this.party.role !== 'guest');
    this.share.onStatus = () => this.emit('share');
    this.video = new ScreenVideoHost(this);
    // guests: keep this PC's OBS pages (which may open later) on the host's room
    setInterval(() => { if (this.party.role === 'guest') this.publishLocal(); }, 2000);
    // AFK cinematic mode: recent chatters' names for the ships (host / solo), stamped into SceneState.afk.crew
    bus.on((m) => { if (m.type === 'chat' && m.origin !== 'party') this.crewChat(Array.isArray(m.evs) ? m.evs : []); });
    setInterval(() => this.crewTick(), 5000);
    // raid: support events summon the room's donation event (Tagilla in Factory) — host / solo only
    bus.on((m) => { if (m.type === 'chat' && m.origin !== 'party' && !m.snap) this.raidSupport(Array.isArray(m.evs) ? m.evs : []); });
    // walking-ship rooms (scene.json `voyage`): support events + Kick rewards -> voyage stamps, the fork votes (host / solo only)
    installVoyageHost(this, bus);
    // space rooms: support events call down an orbital barrage / a threat event (src/scene/space)
    bus.on((m) => { if (m.type === 'chat' && m.origin !== 'party' && !m.snap) this.spaceSupport(Array.isArray(m.evs) ? m.evs : []); });
    // era rooms: support events shift time (src/scene/epoch/eras.ts)
    bus.on((m) => { if (m.type === 'chat' && m.origin !== 'party' && !m.snap) this.eraSupport(Array.isArray(m.evs) ? m.evs : []); });
    // kitchen rooms: support events fill the unrest meter (a frog seethes; halfway = a food fight; the top = a RIOT)
    bus.on((m) => { if (m.type === 'chat' && m.origin !== 'party' && !m.snap) this.kitchenChat(Array.isArray(m.evs) ? m.evs : []); });
    // rooms with scene.json `reactions`: support events → the room's alert reaction for that tier / platform (shared/reactions.ts)
    bus.on((m) => { if (m.type === 'chat' && m.origin !== 'party' && !m.snap) this.roomReactions(Array.isArray(m.evs) ? m.evs : []); });
    // …and a goal / stretch goal reached or time added to the subathon timer (this PC's helper pushes {type:'goals'}; a guest's
    // copy of the host's view carries origin 'party' and is never ours to react to)
    bus.on((m) => { if (m.type === 'goals' && m.origin !== 'party') this.goalReactions(m.s); });
    // …and put back the look / camera a finished reaction changed (host / solo; a studio reload mid-reaction too)
    setInterval(() => this.reactionTick(), 500);
    // room-change transitions: this PC's OBS pages report how their cover / load / reveal is going
    bus.on((m) => {
      if (m.type !== 'curtain' || !m.status || typeof m.status.page !== 'string') return;
      this.curtainPages.set(m.status.page.slice(0, 32), { ...m.status, at: Date.now() });
      if (this.curtainPages.size > 8) this.curtainPages.delete(this.curtainPages.keys().next().value as string);
      this.emit('curtain');
    });
  }

  /** UI subscription: 'state' (anything changed) or 'report' (preview numbers). */
  on(fn: (what: string) => void) { this.listeners.add(fn); return () => this.listeners.delete(fn); }

  get role() { return this.party.role; }
  /** Host (or solo) can edit; guests follow. */
  get canEdit() { return this.party.role !== 'guest'; }
  /** The state this PC's OBS shows. */
  get effective(): SceneState {
    if (this.party.role === 'guest') {
      const hs = this.hostState ?? { ...defaultSceneState(), rev: -1 };
      return { ...(this.guestClassic ? { ...hs, sceneId: null } : hs), gfx: this.localGfx };
    }
    return this.state;
  }
  /** Graphics quality this PC's OBS pages + preview use (shared/graphics.ts). */
  localGfx: SceneGfxState = (() => { try { return sanitizeGfx(JSON.parse(localStorage.getItem(GFX_LOCAL) || '{}')); } catch { return { ...DEFAULT_GFX }; } })();
  get gfx(): SceneGfxState { return this.party.role === 'guest' ? this.localGfx : this.state.gfx ?? DEFAULT_GFX; }
  setGfx(p: Partial<SceneGfxState>) {
    if (this.party.role === 'guest') {
      this.localGfx = sanitizeGfx({ ...this.localGfx, ...p });
      try { localStorage.setItem(GFX_LOCAL, JSON.stringify(this.localGfx)); } catch { /* full */ }
      this.publishLocal(); this.pushPreviews(); this.emit();
      return;
    }
    this.edit((s) => { s.gfx = sanitizeGfx({ ...(s.gfx ?? DEFAULT_GFX), ...p }); });
  }
  get selfKey() { return this.party.role === 'guest' ? this.party.myId : HOST_KEY; }

  async refreshScenes() {
    try { this.scenes = await api.get<SceneInfo[]>('/api/scenes'); } catch { this.scenes = []; }
    this.emit();
  }

  /** Everyone who could be in the room: the host first, then party members (and observer stand-ins). */
  members(): SceneMember[] {
    const P = this.party;
    if (P.role === 'guest') {
      const hostId = this.hostState?.hostId;
      return P.members.map((m) => ({ key: m.id === hostId ? HOST_KEY : m.id, name: m.id === P.myId ? `${m.name} (you)` : m.name, self: m.id === P.myId, host: m.id === hostId, uid: m.discord?.id }));
    }
    const out: SceneMember[] = [{ key: HOST_KEY, name: `${P.name || 'Me'} (host)`, self: true, host: true, size: avatarSize(P.myAvatar), occ: (rules, base) => occupantOf(P.myAvatar, rules, undefined, base) }];
    // (greenroom: a guest waiting in the green room is connected but not a member of the scene: no seat, no walk-in,
    //  not in the Interview line-up / on the monitor — src/net/greenRoom.ts)
    for (const r of P.remotes.values()) if (!P.green.hidden(r.id)) out.push({ key: r.id, name: r.discord?.username ? `${r.name} (@${r.discord.username})` : r.name, self: false, host: false, uid: r.discord?.id, size: avatarSize(r.profile), occ: (rules, base) => occupantOf(r.profile, rules, undefined, base) });
    // guestlink: Discord-camera guests (the host's crops of the call window) — local TV guests, placed like members
    for (const c of P.tv?.cams.list ?? []) out.push({ key: c.id, name: `${c.name} (Discord camera)`, self: false, host: false });
    for (const t of this.testMembers) out.push({ key: t.key, name: `${t.name} (test)`, self: false, host: false, size: this.testSizes.get(t.avatarId) ?? avatarSize(null), occ: (rules, base) => occupantOf(this.testBodies.get(t.avatarId) ?? null, rules, undefined, base) });
    return out;
  }

  spotCount(): number {
    const room = this.state.sceneId ? this.rooms.get(this.state.sceneId) : null;
    return room ? room.spots.filter(Boolean).length && Math.max(...room.spots.map((s, i) => (s ? i + 1 : 0))) : MAX_SPOTS;
  }
  private validSpot(i: number) {
    const room = this.state.sceneId ? this.rooms.get(this.state.sceneId) : null;
    // size spots (13…) only exist once a preview reported them
    return Number.isInteger(i) && i >= 0 && i < MAX_SPOT_INDEX && (room ? !!room.spots[i] : i < MAX_SPOTS);
  }
  /** Every spot of the current room with its size classes + body kinds (no preview yet: SPOT_01…12, ordinary). */
  private seatSpots(): (SeatSpot & OccSpot)[] {
    const room = this.state.sceneId ? this.rooms.get(this.state.sceneId) : null;
    if (!room) return Array.from({ length: MAX_SPOTS }, (_, i) => ({ index: i, sizes: null }));
    return room.spots.filter((s): s is NonNullable<typeof s> => !!s).map((s) => ({ index: s.index, sizes: s.sizes ?? null, kinds: s.kinds ?? null, pose: s.pose }));
  }
  /** The room's seat routing: occupant rules + the forms zones that convert for an occupant (src/scene/forms/spotKinds.ts). */
  private routing(s: SceneState = this.state) { return seatRoutingOf(s.sceneId ? this.scenes.find((x) => x.id === s.sceneId) ?? null : null); }
  /** A member as the seat rules see them (SPEC 6.1 C1): size class + body kind (a mech, a TV performer ...). */
  private occFor(m: SceneMember | undefined, s: SceneState = this.state): Occupant {
    const info = s.sceneId ? this.scenes.find((x) => x.id === s.sceneId) : undefined;
    const rules = this.routing(s).rules, base = (info?.avatarHeight ?? 1.5) * (s.avatarScale || 1);
    const o = m?.occ?.(rules, base) ?? occupantOf(null, rules, undefined, base);
    const cls = m?.size?.cls ?? 'normal';
    return o.size === cls ? o : { ...o, size: cls };
  }
  /** How well spot `i` suits a member (2 made for them, 1 fallback, 0 never — shared/occupant.ts spotFitOcc: the size
   *  class rule of shared/avatarSize.ts spotFit + body kinds + forms zones). */
  spotFitFor(key: string, i: number): 0 | 1 | 2 {
    const m = this.members().find((x) => x.key === key);
    const s = this.seatSpots().find((x) => x.index === i);
    return s ? spotFitOcc(s, this.occFor(m), this.routing().converts) : 0;
  }
  /** Last refused move / size problem, for the Scene tab (cleared on the next successful move). */
  sizeWarning = '';
  /** Size lines for the Scene tab: who is micro / macro and where that puts them. */
  sizeNotes(): string[] {
    const st = this.effective, out: string[] = [];
    const room = st.sceneId ? this.rooms.get(st.sceneId) : null;
    for (const m of this.members()) {
      const z = m.size;
      if (!z || z.auto || z.cls === 'normal') continue;
      const i = st.spots[m.key];
      const s = i !== undefined ? room?.spots[i] : null;
      const fit = s ? spotFit(s.sizes ?? null, z.cls) : 2;
      const where = !s ? '' : fit === 2 ? ` → ${s.label}` : z.cls === 'micro' ? ` → ${s.label} (no perch free: hovering / sitting there)` : z.cls === 'macro' ? ` → ${s.label} (no giant spot free: clamped to the head room)` : ` → ${s.label}`;
      out.push(`${m.name}: ${SIZE_LABEL[z.cls]}, ${z.height.toFixed(2)} m${where}`);
    }
    if (this.report?.room?.id === st.sceneId) for (const n of this.report?.room?.sizes?.notes ?? []) out.push(n);
    return out;
  }
  /** Observer stand-ins: their library profiles' sizes (fetched when they are added). */
  private testSizes = new Map<string, AvatarSize>();
  /** ...and their body plans (room forms: a stand-in mech gets the docking cradle). */
  private testBodies = new Map<string, { size?: unknown; body?: unknown; mech?: unknown; vehicle?: unknown }>();
  /** Members whose spot the host picked by hand (never moved up to a size spot automatically). */
  private picked = new Set<string>();
  /** A member's real size changed (the studio's own avatar settings, a guest's new profile): re-check the seats. */
  sizesChanged() {
    if (!this.canEdit) return;
    // (the performer just changed their own size: a new micro / macro host moves to their own spot too)
    this.upgradeHost = true;
    try { this.edit(() => {}); } finally { this.upgradeHost = false; }
  }
  private upgradeHost = false;
  /** The studio's own avatar loaded / changed (src/app.ts build): when that makes the host another occupant class (a
   *  human swapping to a mech), room forms re-stamp (the desk becomes a docking cradle on every page). */
  occupantChanged() {
    if (!this.canEdit || this.observer || !this.state.sceneId) return;
    // (compared with the occupant the last forms stamp used, not with the last call: a stamp made before App.build had
    //  set the avatar - the startup race, myAvatar still null, the host zone stamped 'standard' - is re-stamped as soon
    //  as the avatar is in; no stamp yet = nothing to correct, the first one reads the avatar as it is)
    if (this.stampedOcc === null || JSON.stringify(occupantOf(this.party.myAvatar)) === this.stampedOcc) return;
    const info = this.scenes.find((x) => x.id === this.state.sceneId);
    if (info && parseForms(info)) this.edit(() => {});
  }
  /** The studio's own occupant (JSON) the last forms stamp was made with (null = no stamp yet). */
  private stampedOcc: string | null = null;

  // ---------------------------------------------------------------- edits (host / solo)
  setScene(id: string | null, opts: { keepBack?: boolean; seats?: Record<string, number>; patch?: (s: SceneState) => void; explicitCurtain?: boolean } = {}) {
    if (!this.canEdit || (id !== null && !isSceneId(id))) return;
    this.edit((s) => {
      opts.patch?.(s);                               // (a mode change that moves the party here: the same state)
      // stage layouts: a room picked by hand ends a room-moving mode's way back; each room remembers its presets
      if (s.sceneId !== id) this.stageRoomSwitch(s, id, !!opts.keepBack);
      // room-change transition: a new change number (every OBS page covers it; hold mode waits for confirm = seq)
      // (the same room again = a retry token: a page whose room did not load loads it again - the cover says "Pick it again")
      s.curtain = curtainForPick(s.curtain, s.sceneId ?? null, id);
      // the rooms' own transitions (scene.json curtain: {in, out}) are resolved HERE, once, and stamped for that change
      if ((s.sceneId ?? null) !== id) {
        const info = (x: string | null) => (x ? this.scenes.find((r) => r.id === x) ?? null : null);
        s.curtain = stampRoomCurtain(s.curtain, info(s.sceneId ?? null), info(id), s.sceneId ?? null, !!opts.explicitCurtain);
      }
      // (another area of the same room — shared/roomId.ts — keeps its clock, weather and era)
      const sameRoom = !!s.sceneId && !!id && baseRoomId(s.sceneId) === baseRoomId(id);
      if (s.sceneId !== id && !sameRoom) delete s.env;   // time + weather: each room starts from its own defaults
      if (s.sceneId !== id && !sameRoom) delete s.era;   // era shifts: each room starts at its first era
      // a composed endshow (and a playing one) is this stage's: it never follows the host into another room's endshow
      if (s.sceneId !== id && !sameRoom && s.festival) s.festival = festivalLeavingRoom(s.festival);
      // room prop toggles: each room has its own (remembered per room; another area of the same room keeps them)
      if (s.sceneId !== id && !sameRoom) { const t = togglesForRoom(s.toggles, id ? rememberedToggles(this.toggleMemory(), baseRoomId(id)) : undefined); if (t) s.toggles = t; else delete s.toggles; }
      if (s.sceneId !== id && s.reactions) { revertReactions(s, Date.now(), true); delete s.reactions; }   // alert reactions stay in their room
      if (s.sceneId !== id) setPick(s, false);   // a new room starts on its own camera: nobody has picked here yet
      s.sceneId = id;
      if (id) {
        // restore this room's remembered host spot; keep guests' names → seats
        // (the server's copy first: the same seat from another tab, after a reinstall)
        const host = roomMemory(id)?.host ?? this.memory()[id]?.host;
        if (host !== undefined) this.assign(s, HOST_KEY, host);
        if (opts.seats) for (const [k, i] of Object.entries(opts.seats)) this.assign(s, k, i);
        const info = this.scenes.find((x) => x.id === id);
        if (info?.defaultCamera && s.camera !== 'talk' && s.camera !== 'group' && s.camera !== 'react') s.camera = 'wide';
        // a space room: stamp the battle's shared clock so every page (and guest) runs the same sky
        if (info?.eras?.list?.length && !s.era) s.era = this.freshEra(info.eras.every, info.eras.support?.min);
        if (info?.space && !s.space) s.space = { ...DEFAULT_SPACE_STATE, show: { ...DEFAULT_SPACE_STATE.show }, events: [], epoch: Date.now() + 1500, seed: (Math.random() * 2 ** 31) >>> 0, ...(info.space.intensity ? { intensity: info.space.intensity } : {}) };
      }
    });
  }
  /** Rooms with areas (shared/roomId.ts, docs/SCENES.md → "Areas"): move to another area of the current room — an area
   *  key, or 'next' / 'prev' to cycle (Stream Deck). The area is its own room id, so this is an ordinary room change
   *  (curtain, remembered seat, stage presets per area). */
  setArea(area: string) {
    const cur = this.state.sceneId;
    if (!cur) return;
    const info = this.scenes.find((x) => x.id === cur);
    const list = info?.areaList;
    if (!list?.length) return;
    let target = list.find((e) => e.key === area)?.id;
    if (area === 'next' || area === 'prev') {
      const i = Math.max(0, list.findIndex((e) => e.id === cur));
      target = list[(i + (area === 'next' ? 1 : list.length - 1)) % list.length].id;
    }
    if (target && target !== cur) this.setScene(target);
  }
  setMode(m: SceneMode) {
    // registered modes (src/scene/stage/registry.ts): exit / enter hooks may move the party to a room (and back)
    const def = stageModeDef(m);
    if (!def && m !== 'talk' && m !== 'react') return;
    let go: { room: string | null; seats?: Record<string, number> } | null = null;
    // react brings the screen down AND cuts to the react camera; back to talk returns to the talk framing
    // (one function applied to a dry-run copy first — does the mode move the party? — then to the real draft, so a room
    // move + the mode change reach every page as ONE state: the room's curtain covers both)
    const mutate = (s: SceneState) => {
      if (s.mode === m) return;
      const prev = structuredClone(s);
      const stage = sanitizeStageState(s.stage ?? DEFAULT_STAGE);
      const pdef = stageModeDef(prev.mode);
      try { pdef?.exit?.(this.modeCtx(s, prev, stage, prev.mode)); } catch (e) { console.warn('[stage] exit', e); }
      s.mode = m;
      setPick(s, false);   // the mode brings its own camera: a pick made in the last mode does not carry over
      s.camera = m === 'react' ? 'react' : def?.camera && m !== 'talk' ? def.camera : (s.camera === 'react' || (pdef?.camera && pdef.camera !== 'talk') ? 'talk' : s.camera);
      let r: ModeRoom | void = undefined;
      try { r = def?.enter?.(this.modeCtx(s, prev, stage, m)); } catch (e) { console.warn('[stage] enter', e); }
      if (r && r.room !== undefined && r.room !== s.sceneId) {
        stage.back ??= { sceneId: s.sceneId, mode: prev.mode };
        go = { room: r.room, seats: r.seats === 'order' ? this.orderSeats(s, stage) : r.seats && r.seats !== 'keep' ? r.seats : undefined };
      } else if (!r?.room && stage.back) {
        if (stage.back.sceneId !== s.sceneId) go = { room: stage.back.sceneId };
        delete stage.back;
      }
      stage.hole = !!def?.hole;
      // a transition for the mode change itself (the layout switches under the cover on every page)
      if (!go && s.sceneId && (def?.curtain || pdef?.curtain)) { const c = s.curtain ?? { ...DEFAULT_CURTAIN }; s.curtain = { ...c, seq: c.seq + 1 }; }
      s.stage = stage;
      // React while the host is outside the room and the layout would be solo (Solo forced, or Auto with nobody
      // else in): walk them in — the side screen drops once they're seated (SceneRuntime waits for the walk)
      if (m === 'react' && s.sceneId && s.present[HOST_KEY] === false) {
        const others = this.members().filter((x) => x.key !== HOST_KEY && s.present[x.key] !== false).length;
        const pref = s.reactLayout ?? 'auto';
        if (pref === 'solo' || (pref === 'auto' && others === 0)) delete s.present[HOST_KEY];
      }
    };
    mutate(structuredClone(this.state));
    const mv = go as { room: string | null; seats?: Record<string, number> } | null;
    if (mv) this.setScene(mv.room, { keepBack: true, seats: mv.seats, patch: mutate });
    else this.edit(mutate);
    // raid events held during React: the screen rolls up first (~2.5 s), then the brute comes
    if (m === 'talk' && this.raidHeld.length) { const q = this.raidHeld.splice(0); q.forEach((e, i) => this.raidEvent(e.k, e.extra, 3000 + i * 100)); }
  }

  /** Which React layout is in effect, and why (Scene tab). */
  layoutReason(): { layout: 'solo' | 'big'; text: string } {
    const s = this.effective;
    const room = s.sceneId ? this.rooms.get(s.sceneId) : null;
    const members = this.members();
    const inRoom = members.filter((m) => s.present[m.key] !== false);
    const pref = s.reactLayout ?? 'auto';
    const bigScreen = room ? room.screen : true;
    const who = (k: string) => (k === this.selfKey ? 'you\u2019re' : `${members.find((m) => m.key === k)?.name ?? 'they'} is`);
    const pending = this.report?.room?.soloPending && s.mode === 'react';
    const focus = inRoom.find((m) => m.key === s.focus) ?? inRoom.find((m) => m.key === HOST_KEY) ?? inRoom[0];
    const seatedWho = focus && focus.key === this.selfKey ? 'you\u2019re' : `${focus?.name ?? 'they'} is`;
    const solo = (why: string) => ({ layout: 'solo' as const, text: `Solo side \u2014 ${why}${pending ? ` (the screen drops once ${seatedWho} seated)` : ''}` });
    const big = (why: string) => ({ layout: 'big' as const, text: `Big centre \u2014 ${why}` });
    if (!inRoom.length) return bigScreen ? big('nobody is in the room' + (s.present[HOST_KEY] === false ? ' (pressing React walks you in)' : '')) : solo('this room has no big screen');
    if (!bigScreen) return solo('this room has no big screen');
    if (pref === 'solo') return solo('forced (React layout: Solo side)');
    if (pref === 'big') return big('forced (React layout: Big centre)');
    return inRoom.length === 1 ? solo(`${who(inRoom[0].key)} the only one in the room`) : big(`${inRoom.length} people are in the room (Auto)`);
  }
  /** The host picks a camera. `hand` (default): by hand (Live panel, Stream Deck, MCP, Scene tab) - it then wins over every
   *  automatic camera until Auto / a mode or room change (shared/camPick.ts). `hand = false` = Auto: the mode's own camera,
   *  and the room's directors may cut again. */
  setCamera(c: string, hand = true) { if (/^[A-Za-z0-9_]{1,48}$/.test(c)) this.edit((s) => { s.camera = c; setPick(s, hand); }); }
  setFocus(key: string) { this.edit((s) => { s.focus = key; }); }
  /** In the room or outside. `how`: 'walk' (through the door), 'instant' (appear / vanish in the seat), default = the
   *  Entrances setting. */
  setPresent(key: string, on: boolean, how?: 'walk' | 'instant') {
    if (how) this.presentHow.set(key, how);
    try { this.edit((s) => { if (on) delete s.present[key]; else s.present[key] = false; }); } finally { this.presentHow.delete(key); }
  }
  /** Entrances (Live panel → People): walk in / out or appear instantly; how new party members arrive. */
  setEntrances(p: Partial<NonNullable<SceneState['entrances']>>) { this.edit((s) => { s.entrances = { ...sanitizeEntrances(s.entrances), ...p }; }); }
  private presentHow = new Map<string, 'walk' | 'instant'>();
  /** Camera follows entrances (host / guests). */
  setFollow(f: Partial<SceneState['follow']>) { this.edit((s) => { s.follow = { ...s.follow, ...f }; }); }
  setLights(l: Partial<SceneLightsState>) { this.edit((s) => { s.lights = { ...s.lights, ...l }; }); }
  /** Lighting state (Scene tab buttons, Shift+1..5, POST /api/scene/lighting, OBS scene mapping). */
  setLighting(id: string) { if (isLightingState(id) && id !== this.state.lights.state) this.setLights({ state: id }); }
  setAvatarScale(v: number) { this.edit((s) => { s.avatarScale = v; }); }
  /** In-world chat props (monitor / support board / chat buddy). Switching the buddy on stamps its walk-in. */
  setChat(p: Partial<SceneChatState>) {
    this.edit((s) => {
      const cur = s.chat ?? { ...DEFAULT_CHAT_STATE };
      const next = { ...cur, ...p, goal: { ...cur.goal, ...(p.goal ?? {}) } };
      if (p.buddy === true && !cur.buddy) next.buddyAt = Date.now() + 300;
      s.chat = next;
    });
  }
  setTransition(v: number) { this.edit((s) => { s.transition = v; }); }
  /** Background combat options (shared/raid.ts). Changing what fights re-stamps the shared seed + clock origin. */
  setRaid(p: Partial<SceneRaidState>) {
    this.edit((s) => {
      const cur = s.raid ?? { ...DEFAULT_RAID_STATE, events: [] };
      const next: SceneRaidState = { ...cur, ...p, events: p.events ?? cur.events };
      const restamp = !cur.epoch || (['on', 'intensity', 'freq', 'factions'] as const).some((k) => k in p && JSON.stringify(p[k]) !== JSON.stringify(cur[k]));
      if (restamp) { next.epoch = Date.now() + 1500; next.seed = (Math.random() * 2 ** 31) >>> 0; }
      s.raid = next;
    });
  }
  /** A timed raid event on every page ('tagilla', 'skirmish', 'donation' = the room's donation event, or a room's own kind). */
  raidEvent(k: string, extra: { user?: string; amount?: string; id?: string; big?: boolean; usd?: number } = {}, lead = 600) {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) return;
    // never start the brute while React mode's screen is down: hold it, stamp it once we're back in Talk
    // (a big donation interrupts React instead: the pages winch the screen up and cut to him, then React resumes)
    if (this.state.mode === 'react' && (k === 'tagilla' || k === 'donation') && !extra.big) { this.raidHeld.push({ k, extra }); if (this.raidHeld.length > 8) this.raidHeld.shift(); return; }
    this.edit((s) => {
      const cur = s.raid ?? { ...DEFAULT_RAID_STATE, events: [] };
      const now = Date.now();
      const events = cur.events.filter((e) => e.at > now - 10 * 60_000).slice(-7);
      events.push({ k, at: now + lead, id: (extra.id ?? `${k}-${now}`).slice(0, 80), cam: s.camera, ...(extra.user ? { user: extra.user } : {}), ...(extra.amount ? { amount: extra.amount } : {}), ...(extra.big ? { big: true } : {}), ...(extra.usd ? { usd: extra.usd } : {}) });
      s.raid = { ...cur, events, epoch: cur.epoch || now + 1500 };
    });
  }
  private raidSeen = new Set<string>();
  private raidHeld: { k: string; extra: { user?: string; amount?: string; id?: string; big?: boolean; usd?: number } }[] = [];
  private raidSupport(evs: unknown[]) {
    if (this.observer || !this.canEdit || !this.state.sceneId) return;
    const st = this.state.raid ?? DEFAULT_RAID_STATE;
    if (!st.tagilla && !st.bigOn) return;
    // only rooms that declare raid support (scene.json "raid") or that a preview reported BG_* / Tagilla anchors for
    const r = this.report?.raid;
    const known = this.report?.room?.id === this.state.sceneId && r;
    if (known ? !r.tagilla && !r.fight : !this.scenes.find((x) => x.id === this.state.sceneId)?.raid) return;
    for (const raw of evs.slice(0, 50)) {
      const e = sanitizeChatEvent(raw);
      if (!e || e.kind !== 'finance' || this.raidSeen.has(e.id)) continue;
      this.raidSeen.add(e.id);
      if (this.raidSeen.size > 500) this.raidSeen = new Set([...this.raidSeen].slice(-200));
      const usd = raidDonationValue(e);
      const big = st.bigOn && usd >= Math.max(1, st.bigMin ?? 100);
      if (!big && (!st.tagilla || usd < Math.max(0.01, st.min))) continue;
      this.raidEvent('donation', { user: e.user, amount: e.display ?? (e.usd ? `$${e.usd.toFixed(2)}` : ''), id: `sup:${e.id}`, usd, ...(big ? { big: true } : {}) });
    }
  }
  /** Kitchen options (shared/kitchen.ts). Changing the crew / fights re-stamps the shared seed + clock origin. */
  setKitchen(p: Partial<SceneKitchenState>) {
    this.edit((s) => {
      const cur = s.kitchen ?? { ...DEFAULT_KITCHEN_STATE, events: [] };
      const next: SceneKitchenState = { ...cur, ...p, events: p.events ?? cur.events };
      const restamp = !cur.epoch || (['on', 'fights', 'freq'] as const).some((k) => k in p && p[k] !== cur[k]);
      if (restamp) { next.epoch = Date.now() + 1500; next.seed = (Math.random() * 2 ** 31) >>> 0; }
      s.kitchen = next;
    });
  }
  /** Club options (shared/club.ts: background bits, the DJ pose, the entrance camera, sounds, big-donation line). */
  setClub(p: Partial<SceneClubState>) {
    this.edit((s) => { const cur = s.club ?? { ...DEFAULT_CLUB_STATE, events: [] }; s.club = { ...cur, ...p, events: p.events ?? cur.events }; });
  }
  /** DJ decks (shared/djDeck/state.ts): the decks at the DJ spot + the hands playing them. */
  setDjDeck(p: Partial<SceneDjDeckState>) {
    this.edit((s) => { s.djdeck = sanitizeDjDeckState({ ...sanitizeDjDeckState(s.djdeck), ...p }); });
  }
  /** Festival stages (shared/festival.ts): show, pyro, intensity, pinned look, the Look Lab curation; `cue` fires an effect on every page. */
  setFestival(p: Partial<SceneFestivalState> & { cue?: string }) {
    this.edit((s) => { s.festival = festivalPatch(s.festival ?? DEFAULT_FESTIVAL_STATE, p, Date.now() + 400); });
  }
  /** A timed club moment on every page: a background bit ('conga', 'danceoff' …) or a celebration test ('tip', 'sub', 'bits', 'raid', 'big'). */
  clubEvent(k: string, extra: { user?: string; usd?: number } = {}, lead = 700) {
    if (![...CLUB_BITS, ...CLUB_CELEBRATIONS].includes(k as never)) return;
    this.edit((s) => {
      const cur = s.club ?? { ...DEFAULT_CLUB_STATE, events: [] };
      const now = Date.now();
      const events = cur.events.filter((e) => e.at > now - 5 * 60_000).slice(-7);
      events.push({ k: k as SceneClubState['events'][number]['k'], at: now + lead, seed: (Math.random() * 2 ** 31) >>> 0, ...(extra.user ? { user: extra.user.slice(0, 32) } : {}), ...(extra.usd ? { usd: extra.usd } : {}) });
      s.club = { ...cur, events };
    });
  }
  /** Club areas: 'dj' (the host at the decks, a guest b2b / on the hype mic) or 'balcony' (the host takes the balcony —
   *  the entrance camera plays — guests to the balcony rail / VIP sofa). Spots from scene.json `club.areas`, else the club's defaults. */
  clubArea(area: string) {
    const info = this.state.sceneId ? this.scenes.find((x) => x.id === this.state.sceneId) : null;
    const club = (info as unknown as { club?: { areas?: Record<string, { host: string; guests?: string[] }>; djSpot?: string; balconySpot?: string } } | null)?.club;
    if (!club) return;
    const idx = (n: string) => { const m = /(\d+)$/.exec(n); return m ? +m[1] - 1 : -1; };
    const areas = club.areas ?? { dj: { host: club.djSpot ?? 'SPOT_01', guests: ['SPOT_02', 'SPOT_12'] }, balcony: { host: club.balconySpot ?? 'SPOT_03', guests: ['SPOT_04', 'SPOT_05', 'SPOT_06', 'SPOT_07', 'SPOT_08', 'SPOT_09', 'SPOT_10', 'SPOT_11'] } };
    const a = areas[area]; if (!a) return;
    const hostSpot = idx(a.host);
    if (hostSpot >= 0) this.move(HOST_KEY, hostSpot);
    const free = (a.guests ?? []).map(idx).filter((i) => i >= 0);
    const guests = this.members().filter((m) => m.key !== HOST_KEY && this.state.present[m.key] !== false);
    guests.forEach((g, k) => { if (free[k] !== undefined && this.state.spots[g.key] !== free[k]) this.move(g.key, free[k]); });
  }
  /** Music lighting style ('auto', a style id, 'u:<n>' = a saved one, '' = off). */
  setLightStyle(id: string) { const v = id === 'off' || id === '' ? '' : sanitizeLightStyleId(id); if (v || id === 'off' || id === '') this.setLights({ style: v || undefined }); }
  /** A timed kitchen event on every page: 'foodfight', 'riot', 'manager' (inspection) or 'stir' (one frog seethes). */
  kitchenEvent(k: string, extra: { user?: string; amount?: string; id?: string } = {}, lead = 600) {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) return;
    this.edit((s) => {
      const cur = s.kitchen ?? { ...DEFAULT_KITCHEN_STATE, events: [] };
      const now = Date.now();
      const events = cur.events.filter((e) => e.at > now - 10 * 60_000).slice(-7);
      events.push({ k, at: now + lead, id: (extra.id ?? `${k}-${now}`).slice(0, 80), ...(extra.user ? { user: extra.user } : {}), ...(extra.amount ? { amount: extra.amount } : {}) });
      s.kitchen = { ...cur, events, epoch: cur.epoch || now + 1500 };
    });
  }
  /** One support event's worth of unrest ($ USD value): stir a frog, a food fight at half, a riot at the top (meter resets). */
  kitchenSupport(usd: number, user?: string, amount?: string, id?: string) {
    if (!(usd > 0)) return;
    const now = Date.now();
    const st = this.state.kitchen ?? DEFAULT_KITCHEN_STATE;
    const u0 = kitchenUnrestAt(st, now), u = u0 + usd, top = Math.max(1, st.riotAt);
    const tag = (id ?? `sup-${now}`).slice(0, 60);
    this.kitchenEvent('stir', { user, amount, id: `stir:${tag}` }, 100);
    if (u >= top) {
      this.kitchenEvent('riot', { user, amount, id: `riot:${tag}` }, 1200);
      this.setKitchen({ unrest: 0, unrestAt: now });
    } else {
      if (u0 < top / 2 && u >= top / 2) this.kitchenEvent('foodfight', { user, amount, id: `fight:${tag}` }, 900);
      this.setKitchen({ unrest: u, unrestAt: now });
    }
  }
  private kitchenSeen = new Set<string>();
  private kitchenChat(evs: unknown[]) {
    if (this.observer || !this.canEdit || !this.state.sceneId) return;
    const st = this.state.kitchen ?? DEFAULT_KITCHEN_STATE;
    if (!st.donations) return;
    const k = this.report?.kitchen;
    const known = this.report?.room?.id === this.state.sceneId && k;
    if (known ? !k.room : !this.scenes.find((x) => x.id === this.state.sceneId)?.kitchen) return;
    for (const raw of evs.slice(0, 50)) {
      const e = sanitizeChatEvent(raw);
      if (!e || e.kind !== 'finance' || this.kitchenSeen.has(e.id)) continue;
      this.kitchenSeen.add(e.id);
      if (this.kitchenSeen.size > 500) this.kitchenSeen = new Set([...this.kitchenSeen].slice(-200));
      const usd = raidDonationValue(e);
      if (usd > 0) this.kitchenSupport(usd, e.user, e.display ?? `$${usd.toFixed(2)}`, e.id);
    }
  }
  /** Space battle options (shared/space.ts). Changing what flies re-stamps the shared seed + clock origin. */
  setSpace(p: Partial<SceneSpaceState>) {
    this.edit((s) => {
      const cur = s.space ?? { ...DEFAULT_SPACE_STATE, show: { ...DEFAULT_SPACE_STATE.show }, events: [] };
      const next: SceneSpaceState = { ...cur, ...p, show: { ...cur.show, ...(p.show ?? {}) }, events: p.events ?? cur.events };
      const restamp = !cur.epoch || (['on', 'intensity', 'freq', 'show'] as const).some((k) => k in p && JSON.stringify(p[k]) !== JSON.stringify(cur[k]));
      if (restamp) { next.epoch = Date.now() + 1500; next.seed = (Math.random() * 2 ** 31) >>> 0; }
      s.space = next;
    });
  }
  /** A timed space event on every page ('threat', 'barrage', 'laser', 'warp', 'flyby', 'dogfight', 'strafe', 'hellbomb'). */
  spaceEvent(k: string, extra: { user?: string; amount?: string; id?: string } = {}) {
    if (!/^[a-z][a-z0-9_]{0,23}$/.test(k)) return;
    this.edit((s) => {
      const cur = s.space ?? { ...DEFAULT_SPACE_STATE, show: { ...DEFAULT_SPACE_STATE.show }, events: [] };
      const now = Date.now();
      const events = cur.events.filter((e) => e.at > now - 10 * 60_000).slice(-9);
      events.push({ k, at: now + 600, id: (extra.id ?? `${k}-${now}`).slice(0, 80), ...(extra.user ? { user: extra.user } : {}), ...(extra.amount ? { amount: extra.amount } : {}) });
      s.space = { ...cur, events, epoch: cur.epoch || now + 1500, seed: cur.epoch ? cur.seed : (Math.random() * 2 ** 31) >>> 0 };
    });
  }
  private spaceSeen = new Set<string>();
  private spaceSupport(evs: unknown[]) {
    if (this.observer || !this.canEdit || !this.state.sceneId) return;
    const st = this.state.space ?? DEFAULT_SPACE_STATE;
    if (!st.support) return;
    // only space rooms (scene.json "space", or a preview that reported SPACE_* anchors)
    const r = this.report?.space;
    const known = this.report?.room?.id === this.state.sceneId && r;
    if (known ? !r.space : !this.scenes.find((x) => x.id === this.state.sceneId)?.space) return;
    // the room's own list of acts (scene.json space.acts): support only calls in what the room keeps
    const acts = spaceActsOf(this.scenes.find((x) => x.id === this.state.sceneId)?.space);
    for (const raw of evs.slice(0, 50)) {
      const e = sanitizeChatEvent(raw);
      if (!e || e.kind !== 'finance' || this.spaceSeen.has(e.id)) continue;
      this.spaceSeen.add(e.id);
      if (this.spaceSeen.size > 500) this.spaceSeen = new Set([...this.spaceSeen].slice(-200));
      const kind = spaceSupportKind(st, raidDonationValue(e), acts);
      if (kind) this.spaceEvent(kind, { user: e.user, amount: e.display ?? (e.usd ? `$${e.usd.toFixed(2)}` : ''), id: `sup:${e.id}` });
    }
  }
  // ---------------------------------------------------------------- room alert reactions (scene.json `reactions`, shared/reactions.ts)
  private reactGate = new ReactionGate();
  private reactCfg: { src: unknown; cfg: RoomReactionsConfig | null } = { src: undefined, cfg: null };
  /** The current room's reactions (null = the room has none: nothing is ever stamped). */
  reactionsConfig(): RoomReactionsConfig | null {
    const src = this.scenes.find((x) => x.id === this.state.sceneId)?.reactions;
    if (src !== this.reactCfg.src) this.reactCfg = { src, cfg: sanitizeRoomReactions(src) };
    return this.reactCfg.cfg;
  }
  private goalSignals = new GoalSignals();
  /** `goal` and `timerAdd` keep their own cooldown: a support reaction in progress never swallows them. */
  private signalGates: Record<ReactionSignalOn, ReactionGate> = { goal: new ReactionGate(), timerAdd: new ReactionGate() };
  /** The helper's goals view (bus): a goal just reached / time just added → the room's `goal` / `timerAdd` rules. */
  private goalReactions(raw: unknown) {
    if (this.observer || !this.canEdit || !this.state.sceneId) return;
    const cfg = this.reactionsConfig();
    if (!cfg) return;
    for (const sig of this.goalSignals.feed(sanitizeGoalsView(raw))) this.playSignal(cfg, sig, false);
  }
  private playSignal(cfg: RoomReactionsConfig, sig: ReactionSignal, forced: boolean): boolean {
    const hit = matchSignal(cfg, sig);
    const gate = this.signalGates[sig.on];
    if (!hit || !(forced ? gate.force(hit) : gate.accept({ id: `${sig.on}:${sig.id}` }, hit))) return false;
    this.playReaction(hit, signalSource(sig));
    return true;
  }
  private roomReactions(evs: unknown[]) {
    if (this.observer || !this.canEdit || !this.state.sceneId) return;
    const cfg = this.reactionsConfig();
    if (!cfg) return;
    for (const raw of evs.slice(0, 50)) {
      const e = sanitizeChatEvent(raw);
      if (!e || (e.kind !== 'finance' && e.kind !== 'system')) continue;
      const hit = matchReaction(cfg, e);
      if (hit && this.reactGate.accept(e, hit)) this.playReaction(hit, e);
    }
  }
  /** Stamp one reaction: look / camera now (put back after `secs`), clip / cue / light override / smash on every page,
   *  space / raid events with the supporter's name. */
  private playReaction(hit: ReactionHit, e: ReactionSource) {
    let out: ReturnType<typeof stampReaction> | null = null;
    this.edit((s) => { out = stampReaction(s, hit, e); });
    const o = out as ReturnType<typeof stampReaction> | null;
    if (!o) return;
    const extra = { ...(o.user ? { user: o.user } : {}), ...(o.amount ? { amount: o.amount } : {}), id: o.stamp.id };
    if (o.space) this.spaceEvent(o.space, extra);
    if (o.raid) this.raidEvent(o.raid, extra);
  }
  /** Bus / Stream Deck / Scene tab: play the room's reaction for a made-up event ({tier | usd, platform?, fkind?, amount?, user?},
   *  or a made-up goal / timer add: {on: 'goal' | 'timerAdd', amount?, user?}). */
  testReaction(o: Record<string, unknown>) {
    if (this.observer || !this.canEdit) return false;
    const cfg = this.reactionsConfig();
    if (!cfg) return false;
    const sig = manualReactionSignal(o);
    if (sig) return this.playSignal(cfg, sig, true);                // {on: 'goal' | 'timerAdd', amount?, user?}
    const e = manualReactionEvent(o);
    const hit = matchReaction(cfg, e);
    if (!hit || !this.reactGate.force(hit)) return false;
    this.playReaction(hit, e);
    return true;
  }
  private reactionTick() {
    if (this.observer || !this.canEdit || !this.loaded) return;
    const now = Date.now();
    if (!reactionsPending(this.state, now) && !reactionsStale(this.state, now)) return;   // idle room: nothing to do
    // put back what finished reactions changed, then drop the finished stamps (an idle room keeps no stamps at all, so the
    // pages go back to their zero-cost early-out instead of walking the last reactions for minutes)
    this.edit((s) => { revertReactions(s, now); pruneReactions(s, now); });
  }
  // ---------------------------------------------------------------- eras (scene.json `eras`: the time crystal shifts the world around the stage)
  private eraRoom() { return this.scenes.find((x) => x.id === this.state.sceneId)?.eras ?? null; }
  /** eras of the current room (id + name), [] = not an era room */
  eraList(): { id: string; name?: string }[] { return (this.scenes.find((x) => x.id === this.effective.sceneId)?.eras?.list ?? []).map((e) => ({ id: e.id, name: e.name })); }
  eraTiming() { const e = this.scenes.find((x) => x.id === this.effective.sceneId)?.eras; return { build: e?.build ?? 5.2, shift: e?.shift ?? 4.6 }; }
  get eraState(): SceneEraState | null { const s = this.effective.era; return s ? sanitizeEraState(s) : null; }
  private freshEra(every?: number, min?: number): SceneEraState {
    const ev = Math.min(15, Math.max(1, every ?? DEFAULT_ERA_STATE.every));
    return { ...DEFAULT_ERA_STATE, every: ev, base: Date.now() + ev * 60_000, index: 1, seed: (Math.random() * 2 ** 31) >>> 0, min: min ?? DEFAULT_ERA_STATE.min };
  }
  /** Era options (on / every / support / min). Turning shifts on or changing the interval re-anchors: the next shift is `every` from now. */
  setEra(p: Partial<SceneEraState>) {
    const room = this.eraRoom(); if (!room?.list?.length) return;
    this.edit((s) => {
      const n = room.list!.length, now = Date.now(), timing = { build: room.build ?? 5.2, shift: room.shift ?? 4.6 };
      const cur = s.era ? sanitizeEraState(s.era) : this.freshEra(room.every, room.support?.min);
      let next: SceneEraState = sanitizeEraState({ ...cur, ...p });
      if ((p.every !== undefined && p.every !== cur.every) || (p.on === true && !cur.on)) next = eraReanchor(next, n, now, timing);
      s.era = next;
    });
  }
  /** Shift now (Scene tab button, support events): the crystal forms in 0.25 s on every page. */
  eraShift() {
    const room = this.eraRoom(); if (!room?.list?.length) return;
    this.edit((s) => {
      const n = room.list!.length, now = Date.now(), timing = { build: room.build ?? 5.2, shift: room.shift ?? 4.6 };
      const cur = s.era ? sanitizeEraState(s.era) : this.freshEra(room.every, room.support?.min);
      if (eraAt(cur, n, now, timing).shift) return;       // one at a time
      s.era = eraShiftNow(cur, n, now, 250, timing);
    });
  }
  private eraSeen = new Set<string>();
  private eraSupportAt = 0;
  private eraSupport(evs: unknown[]) {
    if (this.observer || !this.canEdit || !this.state.sceneId || !this.eraRoom()?.list?.length) return;
    const st = this.state.era;
    if (!st?.support) return;
    for (const raw of evs.slice(0, 50)) {
      const e = sanitizeChatEvent(raw);
      if (!e || e.kind !== 'finance' || this.eraSeen.has(e.id)) continue;
      this.eraSeen.add(e.id);
      if (this.eraSeen.size > 500) this.eraSeen = new Set([...this.eraSeen].slice(-200));
      if (raidDonationValue(e) < Math.max(0.01, st.min) || Date.now() - this.eraSupportAt < 20_000) continue;
      this.eraSupportAt = Date.now();
      this.eraShift();
    }
  }
  /** Time + weather in effect for the current room (the host's SceneState.env, else the room's scene.json defaults). */
  get envState(): SceneEnvState {
    const s = this.effective;
    const cfg = this.scenes.find((x) => x.id === s.sceneId)?.environment;
    return s.env ? sanitizeEnvState(s.env, envDefaults(cfg)) : envDefaults(cfg);
  }
  /** Time of day / weather (shared/environment.ts). The clock stays continuous: changing speed / clock re-anchors the
   *  cycle at "now"; a weather change crossfades from what is showing now. */
  setEnv(p: Partial<SceneEnvState>) {
    this.edit((s) => {
      const cfg = this.scenes.find((x) => x.id === s.sceneId)?.environment;
      const cur = s.env ? sanitizeEnvState(s.env, envDefaults(cfg)) : { ...envDefaults(cfg), seed: (Math.random() * 2 ** 31) >>> 0 };
      const now = Date.now();
      const next: SceneEnvState = { ...cur, ...p };
      const hourNow = envHour(cur, now);
      if ('hour' in p) next.epoch = now;
      else if ('speed' in p || 'clock' in p) { next.hour = hourNow; next.epoch = now; }
      if (next.clock === 'real') next.tz = -new Date().getTimezoneOffset();
      const w = envWeatherAt(cur, cfg, now);
      const showing: EnvWeather = w.k > 0.5 ? w.to : w.from;
      if (p.weather && (p.weather !== cur.weather || cur.weatherMode !== 'manual')) { next.weatherFrom = showing; next.weatherAt = now; next.weatherMode = p.weatherMode ?? 'manual'; }
      else if (p.weatherMode === 'manual' && cur.weatherMode !== 'manual') { next.weather = showing; next.weatherFrom = showing; next.weatherAt = now; }
      s.env = sanitizeEnvState(next, cur);
    });
  }
  // ---------------------------------------------------------------- room-change transitions (shared/curtain.ts)
  /** Transition settings in effect (the host's; defaults when never set). */
  get curtain(): SceneCurtainState { return sanitizeCurtainState(this.effective.curtain ?? DEFAULT_CURTAIN); }
  /** Style / duration / hold / boot / pool. Turning hold on never holds a change that already happened. */
  setCurtain(p: Partial<SceneCurtainState>) {
    this.edit((s) => {
      const cur = sanitizeCurtainState(s.curtain ?? DEFAULT_CURTAIN);
      const next = sanitizeCurtainState({ ...cur, ...p, seq: cur.seq, confirm: cur.confirm });
      if (next.hold && !cur.hold) next.confirm = cur.seq;
      s.curtain = next;
    });
  }
  /** Hold mode: the host says the new room may show (every OBS page of the host and of every guest reveals it). */
  confirmCurtain() {
    if (!this.canEdit) return;
    const c = this.curtain;
    if (c.confirm >= c.seq) return;
    this.edit((s) => { const cur = sanitizeCurtainState(s.curtain ?? DEFAULT_CURTAIN); s.curtain = { ...cur, confirm: cur.seq }; });
  }
  /** A hold-mode change is waiting for the host's confirm. */
  get curtainWaiting(): boolean { const c = this.effective.curtain; return !!c && c.hold && c.confirm < c.seq; }
  // ---------------------------------------------------------------- capture cover (shared/capcover.ts)
  /** The capture cover in effect (the host's; off when never set). */
  get capcover(): SceneCaptureCover { return sanitizeCaptureCover(this.effective.capcover ?? DEFAULT_CAPCOVER); }
  /** Cover on / off, style, card text. Stays up until the host turns it off (never auto-dismissed). */
  setCapCover(p: Partial<SceneCaptureCover>) {
    this.edit((s) => { s.capcover = sanitizeCaptureCover({ ...(s.capcover ?? DEFAULT_CAPCOVER), ...p }); });
  }
  toggleCapCover(on?: boolean) { this.setCapCover({ on: on ?? !this.capcover.on }); }
  // ---------------------------------------------------------------- room prop toggles (shared/roomToggles.ts)
  /** The current room's toggles: what its preview measured (scene.json + glb extras), else its scene.json list. */
  roomToggles(id: string | null = this.effective.sceneId): RoomToggleDef[] {
    if (!id) return [];
    const r = this.rooms.get(id)?.toggles;
    if (r) return r.map((t) => ({ id: t.id, label: t.label, nodes: [], default: t.default }));
    return parseRoomToggles(this.scenes.find((x) => x.id === id)?.toggles);
  }
  /** Is toggle `id` of the current room shown (the host's choice, else its default)? */
  toggleOn(id: string): boolean { return toggleOn(this.roomToggles(), this.effective.toggles, id); }
  /** Show / hide a room prop toggle on every page (on: true / false / 'toggle'). Remembered for this room. */
  setToggle(id: string, on: boolean | 'toggle') {
    if (!isToggleId(id) || !this.canEdit || !this.state.sceneId) return;
    const defs = this.roomToggles(this.state.sceneId);
    this.edit((s) => { s.toggles = stampToggle(defs, s.toggles, id, on); });
    // (the observer sandbox never remembers anything)
    if (!this.observer && this.state.sceneId) try { localStorage.setItem(TOGGLES_MEM, JSON.stringify(rememberToggles(this.toggleMemory(), baseRoomId(this.state.sceneId), this.state.toggles))); } catch { /* full / blocked */ }
  }
  private toggleMemory(): unknown {
    if (this.observer) return {};
    try { return JSON.parse(localStorage.getItem(TOGGLES_MEM) || '{}'); } catch { return {}; }
  }
  /** This PC's OBS pages' transition reports (bus 'curtain'), by page. */
  readonly curtainPages = new Map<string, CurtainStatus & { at: number }>();
  /** Scene-tab preview only: play a transition there without changing rooms (never on OBS). */
  testCurtain(style: string) { for (const p of this.pages) try { p.curtainTest?.(style); } catch { this.pages.delete(p); } }
  /** Quality benchmark (~10 s) on the Scene-tab preview (src/stage/gfx/bench.ts). null = no preview page with a room. */
  async benchGfx(): Promise<import('../../shared/graphics.ts').GfxBenchResult | null> {
    for (const p of this.pages) if (p.gfxBench && this.report?.room) { try { return await p.gfxBench({ targetFps: this.gfx.targetFps ?? 60 }); } catch { return null; } }
    return null;
  }

  // ---------------------------------------------------------------- AFK cinematic mode + chatter names on ships (shared/afk.ts, src/scene/afk)
  /** AFK settings in effect (the host's; defaults when never set). */
  get afk(): SceneAfkState { return sanitizeAfkState(this.effective.afk ?? DEFAULT_AFK_STATE); }
  /** On / off, title card, names, pace … (Scene tab, Simple's Away row, bus / MCP `scene {afk}`, POST /api/scene/afk; no default key). Turning it on
   *  stamps a fresh seed + clock origin, so every OBS page and guest cuts in step; with "walk me out" the host walks out of
   *  the room while AFK and back in when it ends. */
  setAfk(p: Partial<SceneAfkState>) {
    if (!this.canEdit) return;
    const was = !!this.state.afk?.on;
    this.edit((s) => {
      const cur = sanitizeAfkState(s.afk ?? DEFAULT_AFK_STATE);
      const next = sanitizeAfkState({ ...cur, ...p, crew: p.crew ?? cur.crew });
      if (next.on && !cur.on) { next.epoch = Date.now() + 400; next.seed = (Math.random() * 2 ** 31) >>> 0; setPick(s, false); }   // (the cinematic director takes the camera)
      if (next.on && !cur.on && next.hideHost && s.present[HOST_KEY] !== false) { s.present[HOST_KEY] = false; next.hostOut = true; }
      if (!next.on && cur.on && cur.hostOut) delete s.present[HOST_KEY];
      if (!next.on) delete next.hostOut;
      s.afk = next;
    });
    if (!was && this.state.afk?.on) this.crewTick(true);
  }
  toggleAfk(on?: boolean) { this.setAfk({ on: on ?? !this.state.afk?.on }); }
  /** Recent chatters (name → last message, epoch ms), this session; moderated names never come back. */
  private crewLast = new Map<string, CrewSeen>();
  private crewBans = new Set<string>();
  /** message id → author (a mod deleting a message keeps its author off the ships). */
  private crewAuthors = new Map<string, string>();
  private crewStampAt = 0;
  private crewSeeded = false;
  /** Words that never go on a ship (host setting, this browser). */
  afkBlock(): string[] {
    try { const v = JSON.parse(localStorage.getItem('vtp.afk.block') || '[]'); return Array.isArray(v) ? v.filter((w): w is string => typeof w === 'string').slice(0, 60) : []; } catch { return []; }
  }
  setAfkBlock(words: string[]) {
    const list = [...new Set(words.map((w) => w.trim().toLowerCase().slice(0, 32)).filter((w) => w.length >= 3))].slice(0, 60);
    if (!this.observer) try { localStorage.setItem('vtp.afk.block', JSON.stringify(list)); } catch { /* full */ }
    this.crewTick(true);
  }
  private crewChat(evs: unknown[]) {
    if (this.party.role === 'guest') return;
    const bots = new Set([...CHAT_BOTS, ...(this.state.chat?.bots ?? [])]);
    let removed = false;
    for (const raw of evs.slice(0, 120)) {
      const e = sanitizeChatEvent(raw);
      if (!e || e.test) continue;
      if (e.kind === 'delete') { const u = this.crewAuthors.get(e.target ?? ''); if (u) { this.crewBan(u); removed = true; } continue; }
      if (e.kind === 'purge') {
        // (who goes: crewPurged = the rule of every chat holder, by platform user id when there is one; a chat clear takes
        // everyone on THAT platform; the target name is barred as well, it may not have chatted yet)
        for (const k of crewPurged(this.crewLast, e)) { this.crewBans.add(k); this.crewLast.delete(k); }
        if (e.target && e.target !== '*') this.crewBan(e.target);
        removed = true; continue;
      }
      if (e.kind !== 'chat' && e.kind !== 'finance') continue;
      this.crewAuthors.set(e.id, e.user);
      if (this.crewAuthors.size > 500) this.crewAuthors.delete(this.crewAuthors.keys().next().value as string);
      const n = cleanCrewName(e.user), k = n.toLowerCase();
      if (!n || bots.has(k) || (e.badges ?? []).includes('broadcaster') || this.crewBans.has(k)) continue;
      this.crewLast.delete(k);
      this.crewLast.set(k, { n, ts: Math.min(Date.now(), e.ts), platform: e.platform, ...(e.uid ? { uid: e.uid } : {}) });
      if (this.crewLast.size > 200) this.crewLast.delete(this.crewLast.keys().next().value as string);
    }
    // (a moderated name leaves the ships at once — and the saved state — whether or not names are showing)
    if (removed && this.canEdit && this.loaded && this.state.afk?.crew.length) this.crewStamp();
  }
  private crewBan(user: string) {
    const k = cleanCrewName(user).toLowerCase();
    if (!k) return;
    this.crewBans.add(k);
    this.crewLast.delete(k);
  }
  /** Stamp the crew list when it changed (≤ every 8 s; a moderation removal at once). Only while names are shown. */
  private crewTick(force = false) {
    if (!this.canEdit || !this.loaded) return;
    const st = this.state.afk;
    if (!st || !afkNamesOn(st)) return;
    if (!this.crewSeeded) {
      // a studio reload keeps the names already on the ships (+ the chat it just loaded)
      this.crewSeeded = true;
      for (const c of liveCrew(st.crew)) if (!this.crewLast.has(c.n.toLowerCase())) this.crewLast.set(c.n.toLowerCase(), { n: c.n, ts: Math.min(Date.now(), c.at) });
      this.crewChat(this.chat.events);
    }
    if (!force && Date.now() - this.crewStampAt < 8000) return;
    this.crewStamp();
  }
  private crewStamp() {
    const now = Date.now(), cur = this.state.afk?.crew ?? [];
    const next = mergeCrew(cur, [...this.crewLast.values()].map((v) => ({ user: v.n, ts: v.ts })), now, { max: AFK_CREW_MAX, block: this.afkBlock(), banned: this.crewBans });
    if (sameCrew(next, cur)) return;
    this.crewStampAt = now;
    this.setAfk({ crew: next });
  }
  /** Scene tab: sample names on the ships (they stay until Clear, or until real chatters push them out). */
  afkTestNames() {
    const now = Date.now();
    ['SkyRider', 'MapleFox', 'CaptainComet', 'NightOwl', 'WaveRunner', 'RiverStone', 'QuietPilot', 'LunaFox'].forEach((n, i) => this.crewLast.set(n.toLowerCase(), { n, ts: now - i }));
    if (this.canEdit) this.crewStamp();
  }
  /** Scene tab: forget every name (the ships go blank until someone chats). */
  afkClearNames() { this.crewLast.clear(); this.setAfk({ crew: [] }); }

  // ---------------------------------------------------------------- stage layouts (shared/stage.ts, src/scene/stage)
  /** Stage layout settings in effect (the host's; defaults when never set). */
  get stage(): SceneStageState { return sanitizeStageState(this.effective.stage ?? DEFAULT_STAGE); }
  /** React size / gaming layout / strip / cam / docks / lounge. The room's presets are remembered per room. */
  setStage(p: Partial<SceneStageState>) {
    this.edit((s) => {
      const cur = sanitizeStageState(s.stage ?? DEFAULT_STAGE);
      const next = sanitizeStageState({ ...cur, ...p, dock: { ...cur.dock, ...(p.dock ?? {}) }, order: cur.order, back: cur.back, hole: cur.hole, test: cur.test });
      s.stage = next;
      // the 3D React layouts follow the preset (Side = the solo side screen, Big = the room's big screen)
      if (p.react) s.reactLayout = p.react === 'side' ? 'solo' : p.react === 'big' ? 'big' : 'auto';
      if (s.sceneId) this.rememberStage(s.sceneId, next);
    });
    // Gaming with 3+ in the room and the lounge just switched on: go there
    if (p.lounge === true && this.state.mode === 'gaming') this.maybeLounge();
  }
  // ---------------------------------------------------------------- names on the cams
  private nameMem: { def: string; rooms: Record<string, string> } | null = null;
  /** This browser's "My name on screen": a default + per-room overrides (the observer sandbox keeps it in memory). */
  myNames(): { def: string; rooms: Record<string, string> } {
    if (this.nameMem) return this.nameMem;
    let o: { def?: unknown; rooms?: unknown } = {};
    try { if (!this.observer) o = JSON.parse(localStorage.getItem('vtp.stage.myName') || '{}'); } catch { /* ignore */ }
    const rooms: Record<string, string> = {};
    if (o.rooms && typeof o.rooms === 'object') for (const [k, v] of Object.entries(o.rooms as Record<string, unknown>)) if (typeof v === 'string' && cleanStageName(v)) rooms[k] = cleanStageName(v);
    this.nameMem = { def: typeof o.def === 'string' ? cleanStageName(o.def) : '', rooms };
    return this.nameMem;
  }
  /** Set my name on the cams: everywhere (`default`) or only in the current room (`room`); '' clears it. */
  setMyName(name: string, scope: 'default' | 'room') {
    const n = cleanStageName(name), m = this.myNames(), room = this.state.sceneId;
    if (scope === 'default') m.def = n;
    else if (room) { if (n) m.rooms[room] = n; else delete m.rooms[room]; }
    if (!this.observer) try { localStorage.setItem('vtp.stage.myName', JSON.stringify(m)); } catch { /* full / blocked */ }
    this.edit((s) => this.applyMyName(s));
  }
  /** Host: the name a guest's cam shows ('' = their own party name). */
  setGuestName(key: string, name: string) {
    this.edit((s) => {
      const st = sanitizeStageState(s.stage ?? DEFAULT_STAGE), names = { ...(st.names ?? {}) }, n = cleanStageName(name);
      if (n) names[key] = n; else delete names[key];
      if (Object.keys(names).length) st.names = names; else delete st.names;
      s.stage = sanitizeStageState(st);
    });
  }
  /** The host's name for this room (room override, else the default) into the shared state (`room`: the room being
   *  entered — a room switch runs before `sceneId` changes). */
  private applyMyName(s: SceneState, room: string | null = s.sceneId) {
    const m = this.myNames(), n = (room && m.rooms[room]) || m.def;
    const st = sanitizeStageState(s.stage ?? DEFAULT_STAGE), names = { ...(st.names ?? {}) };
    if ((names[HOST_KEY] ?? '') === n) return;
    if (n) names[HOST_KEY] = n; else delete names[HOST_KEY];
    if (Object.keys(names).length) st.names = names; else delete st.names;
    s.stage = sanitizeStageState(st);
  }

  /** Per-room presets (this browser): React size + gaming layout + cam options, restored when the room is picked. */
  private rememberStage(room: string, st: SceneStageState) {
    try {
      const all = JSON.parse(localStorage.getItem('vtp.stage.rooms') || '{}') as Record<string, Partial<SceneStageState>>;
      all[room] = { react: st.react, gaming: st.gaming, strip: st.strip, corner: st.corner, cam: st.cam, framing: st.framing, backdrop: st.backdrop };
      localStorage.setItem('vtp.stage.rooms', JSON.stringify(all));
    } catch { /* full / blocked */ }
    if (!this.observer) rememberRoomMemory(room, { stage: { react: st.react, gaming: st.gaming, strip: st.strip, corner: st.corner, cam: st.cam, framing: st.framing, backdrop: st.backdrop } });
  }
  private stageRoomSwitch(s: SceneState, id: string | null, keepBack: boolean) {
    const st = sanitizeStageState(s.stage ?? DEFAULT_STAGE);
    if (!keepBack) delete st.back;
    delete st.reseat;                                // (Big re-seating is per room)
    try {
      const mem = id && !this.observer ? (roomMemory(id)?.stage as Partial<SceneStageState> | undefined) ?? (JSON.parse(localStorage.getItem('vtp.stage.rooms') || '{}') as Record<string, Partial<SceneStageState>>)[id] : null;
      if (mem) Object.assign(st, sanitizeStageState({ ...st, ...mem }), { order: st.order, back: st.back, hole: st.hole });
    } catch { /* ignore */ }
    s.stage = sanitizeStageState(st);
    this.applyMyName(s, id);
    if (s.stage.react) s.reactLayout = s.stage.react === 'side' ? 'solo' : s.stage.react === 'big' ? 'big' : 'auto';
  }
  /** Host → SPOT_01, guests in join order → SPOT_02 … (rooms whose seats are a row: the Gaming Lounge). */
  private orderSeats(s: SceneState, st: SceneStageState): Record<string, number> {
    const keys = [HOST_KEY, ...st.order.filter((k) => k !== HOST_KEY)].filter((k) => this.members().some((m) => m.key === k) && s.present[k] !== false);
    return Object.fromEntries(keys.slice(0, MAX_SPOTS).map((k, i) => [k, i]));
  }
  /** Gaming with more than two in the room → the Gaming Lounge (host rule; the curtain plays on every page). */
  private maybeLounge() {
    const s = this.state, st = sanitizeStageState(s.stage ?? DEFAULT_STAGE);
    if (!this.canEdit || s.mode !== 'gaming' || s.sceneId === st.loungeRoom) return;
    const n = this.members().filter((m) => s.present[m.key] !== false).length;
    if (!wantsLounge(st, n) || !this.scenes.some((x) => x.id === st.loungeRoom && x.ready !== false)) return;
    this.edit((d) => { const g = sanitizeStageState(d.stage ?? DEFAULT_STAGE); g.back ??= { sceneId: d.sceneId, mode: 'gaming' }; d.stage = g; });
    this.setScene(st.loungeRoom, { keepBack: true, seats: this.orderSeats(this.state, sanitizeStageState(this.state.stage ?? DEFAULT_STAGE)) });
  }
  /** React Big: anyone sitting in front of the big screen (room summary `reactBlock`, measured on the preview) walks to
   *  the nearest free seat that isn't — and back to their own seat once React leaves Big. No free seat: they stay and the
   *  OBS pages show them as a cam (the room render leaves them out). */
  private reseatForBig(s: SceneState) {
    const st = sanitizeStageState(s.stage ?? DEFAULT_STAGE);
    const room = s.sceneId ? this.rooms.get(s.sceneId) : null;
    const mem = this.members().filter((m) => s.present[m.key] !== false);
    const big = s.mode === 'react' && !!room?.screen && resolveReact(st.react, Math.max(1, mem.length), room.screen) === 'big';
    const block = new Set(room?.reactBlock ?? []);
    const res: Record<string, number> = { ...(st.reseat ?? {}) };
    for (const k of Object.keys(res)) if (!mem.some((m) => m.key === k)) delete res[k];
    // (the preview measured real models: a big mascot in front of the screen, and where it can go instead)
    const hints = this.report?.room?.id === s.sceneId ? this.report?.stage?.reseat ?? {} : {};
    if (big && room) for (const [k, [from, to]] of Object.entries(hints)) {
      if (s.spots[k] !== from || !mem.some((m) => m.key === k) || Object.entries(s.spots).some(([k2, v]) => k2 !== k && v === to) || !room.spots[to]) continue;
      if (res[k] === undefined) res[k] = from;
      s.spots[k] = to;
    }
    if (big && block.size && room) {
      const taken = new Set(Object.values(s.spots));
      for (const m of mem) {
        const i = s.spots[m.key];
        if (i === undefined || !block.has(i)) continue;
        const here = room.spots[i];
        const free = room.spots.filter((x): x is NonNullable<typeof x> => !!x && !block.has(x.index) && !taken.has(x.index) && spotFitOcc(x, this.occFor(m, s), this.routing(s).converts) > 0);
        if (!free.length || !here) continue;
        free.sort((a, b) => (a.x - here.x) ** 2 + (a.z - here.z) ** 2 - ((b.x - here.x) ** 2 + (b.z - here.z) ** 2));
        if (res[m.key] === undefined) res[m.key] = i;
        taken.delete(i); s.spots[m.key] = free[0].index; taken.add(free[0].index);
      }
    } else if (!big) {
      for (const [k, i] of Object.entries(res)) {
        if (s.spots[k] !== undefined && !Object.entries(s.spots).some(([k2, v]) => k2 !== k && v === i)) s.spots[k] = i;
        delete res[k];
      }
    }
    if (Object.keys(res).length) st.reseat = res; else delete st.reseat;
    if (JSON.stringify(st.reseat ?? null) !== JSON.stringify(sanitizeStageState(s.stage ?? DEFAULT_STAGE).reseat ?? null)) s.stage = st;
  }

  private lastHints = '';

  /** Line-up test: every OBS page draws a grid + the hole's edge for 12 s (setting up the capture under the browser source). */
  lineupTest(on = true) { this.edit((s) => { const st = sanitizeStageState(s.stage ?? DEFAULT_STAGE); if (on) st.test = Date.now() + 12_000; else delete st.test; s.stage = st; }); }
  /** The Scene tab asks for a redraw (an async OBS check finished …). */
  poke() { this.emit(); }
  /** A registered mode's settings bag (SceneState.modes[id]). */
  modeBag(id: string): unknown { return (this.effective.modes ?? {})[id]; }
  setModeBag(id: string, v: unknown) {
    // (the Interview bag is the Interview director's controls: Auto cam, a pinned / cut shot, the floor, the show open - the host
    // asking for the director hands the camera back to it, even over a stale hand pick: shared/camPick.ts)
    if (isModeId(id)) this.edit((s) => { s.modes = { ...(s.modes ?? {}), [id]: v }; if (id === 'interview') setPick(s, false); });
  }
  /** What the current React / Gaming preset resolves to for who is in the room (Scene tab). */
  stageReason(): { react: string; gaming: string; n: number } {
    const s = this.effective, st = this.stage;
    const n = Math.max(1, this.members().filter((m) => s.present[m.key] !== false).length);
    const room = s.sceneId ? this.rooms.get(s.sceneId) : null;
    return { react: resolveReact(st.react, n, room ? room.screen : true), gaming: resolveGaming(st.gaming, n), n };
  }
  private modeCtx(s: SceneState, prev: SceneState, stage: SceneStageState, id: string): ModeCtx {
    const mem = this.members();
    const order = [HOST_KEY, ...stage.order.filter((k) => k !== HOST_KEY)];
    const rank = (k: string) => { const i = order.indexOf(k); return i < 0 ? 999 : i; };
    const ms = mem.map((m) => ({ key: m.key, name: m.name, host: m.host, self: m.self, cls: m.size?.cls })).sort((a, b) => rank(a.key) - rank(b.key));
    return {
      state: s, prev, stage, members: ms, present: ms.filter((m) => s.present[m.key] !== false), scenes: this.scenes,
      bag: (san) => san((s.modes ?? {})[id]), setBag: (v) => { s.modes = { ...(s.modes ?? {}), [id]: v }; },
    };
  }

  /** React layout: 'auto' (solo side screen when one performer is in the room), 'solo' or 'big'. */
  setReactLayout(v: 'auto' | 'solo' | 'big') { this.edit((s) => { s.reactLayout = v; }); }

  /** Move a member to a spot (swapping with whoever sits there). The host's own pick is remembered per room. */
  move(key: string, spot: number) {
    if (!this.validSpot(spot)) return;
    const m = this.members().find((x) => x.key === key);
    const cls = m?.size?.cls ?? 'normal';
    if (this.spotFitFor(key, spot) === 0) {
      const sp = this.state.sceneId ? this.rooms.get(this.state.sceneId)?.spots[spot] : null;
      const kind = this.occFor(m).kind;
      this.sizeWarning = sp?.kinds?.length && !sp.kinds.includes(kind)
        ? `${m?.name ?? 'They'} can’t take “${sp?.label ?? `spot ${spot + 1}`}”: it is for ${sp.kinds.join(' / ')} performers, they are a ${kind}.`
        : `${m?.name ?? 'They'} can’t take “${sp?.label ?? `spot ${spot + 1}`}”: it is for ${(sp?.sizes ?? []).join(' / ') || 'other sizes'} performers, they are ${SIZE_LABEL[cls].toLowerCase()}.`;
      this.emit();
      return;
    }
    // swapping: whoever sits there must fit our old spot too, else they get a free spot that suits them
    this.sizeWarning = '';
    this.picked.add(key);
    this.edit((s) => {
      const other = Object.keys(s.spots).find((k) => k !== key && s.spots[k] === spot);
      const cur = s.spots[key];
      this.assign(s, key, spot);
      if (other && cur !== undefined && this.spotFitFor(other, cur) === 0) delete s.spots[other];
    });
  }

  /** Bus / MCP remote control. */
  command(a: Record<string, unknown>) {
    if (typeof a.lighting === 'string') this.setLighting(a.lighting);
    // live-tabs: the camera move between shots (s, 0 = cut) and Live → Privacy → Hide chat ({chat: {hidden: bool | 'toggle'}})
    if (typeof a.transition === 'number' && Number.isFinite(a.transition)) this.setTransition(Math.round(Math.min(5, Math.max(0, a.transition)) * 100) / 100);
    // live-tabs BRB card look: {brb: {style?, theme?, text?}} (BRB itself = lighting 'brb')
    const bb = a.brb as Record<string, unknown> | undefined;
    if (bb && typeof bb === 'object') this.edit((s) => { s.brb = sanitizeBrbState(brbArgsMerge({ ...sanitizeBrbState(s.brb ?? DEFAULT_BRB) }, bb)); });
    const ch = a.chat as Record<string, unknown> | undefined;
    if (ch && typeof ch === 'object' && (typeof ch.hidden === 'boolean' || ch.hidden === 'toggle')) {
      const cur = this.effective.chat?.hidden === true, hide = ch.hidden === 'toggle' ? !cur : ch.hidden === true;
      if (hide !== cur) this.setChat({ hidden: hide });
    }
    // screen video: {video: {action?: 'play' | 'stop' | 'toggle' | 'next' | 'restart', slot?, audio?: bool | 'toggle', volume?, on?}}
    const vd = a.video as Record<string, unknown> | undefined;
    if (vd && typeof vd === 'object') this.video.control({ action: typeof vd.action === 'string' ? vd.action : undefined, slot: typeof vd.slot === 'string' ? vd.slot : undefined,
      audio: vd.audio === 'toggle' || typeof vd.audio === 'boolean' ? vd.audio as boolean | 'toggle' : undefined, volume: typeof vd.volume === 'number' ? vd.volume : undefined, on: typeof vd.on === 'boolean' ? vd.on : undefined });
    // ambient cameras (shared/ambientCam.ts): {ambcam: {on?: bool | 'toggle', state?, move?, action?: 'next' | 'auto', cut?, speed?, cycle?}}
    const ac = a.ambcam as Record<string, unknown> | undefined;
    if (ac && typeof ac === 'object') this.setAmbientCam((x) => ambientCommand(x, ac, this.state.lights.state, Date.now()), true);
    // AFK cinematic mode: {afk: {on?: true | false | 'toggle', overlay?: 'off'|'brb'|'soon'|'custom', text?, names?: 'afk'|'always'|'off', pace?, events?, hideHost?}}
    const ak = a.afk as Record<string, unknown> | undefined;
    if (ak && typeof ak === 'object') {
      const p: Partial<SceneAfkState> = {};
      if (ak.overlay === 'off' || ak.overlay === 'brb' || ak.overlay === 'soon' || ak.overlay === 'custom') p.overlay = ak.overlay;
      if (typeof ak.text === 'string') p.text = ak.text;
      if (ak.names === 'afk' || ak.names === 'always' || ak.names === 'off') p.names = ak.names;
      if (ak.pace === 'calm' || ak.pace === 'normal' || ak.pace === 'snappy') p.pace = ak.pace;
      if (typeof ak.events === 'boolean') p.events = ak.events;
      if (typeof ak.hideHost === 'boolean') p.hideHost = ak.hideHost;
      if (typeof ak.on === 'boolean') p.on = ak.on; else if (ak.on === 'toggle') p.on = !this.state.afk?.on;
      if (Object.keys(p).length) this.setAfk(p);
    }
    if (a.reactLayout === 'auto' || a.reactLayout === 'solo' || a.reactLayout === 'big') this.setReactLayout(a.reactLayout);
    // transitions: {curtain: {confirm?: true, style?, dur?, hold?, boot?, minHold?}} (style set before a sceneId in the same command)
    const cu = a.curtain as Record<string, unknown> | undefined;
    if (cu && typeof cu === 'object') {
      const p: Partial<SceneCurtainState> = {};
      if (isCurtainStyle(cu.style)) p.style = cu.style;
      if (typeof cu.hold === 'boolean') p.hold = cu.hold;
      if (typeof cu.boot === 'boolean') p.boot = cu.boot;
      if (typeof cu.dur === 'number' && Number.isFinite(cu.dur)) p.dur = cu.dur;
      if (typeof cu.minHold === 'number' && Number.isFinite(cu.minHold)) p.minHold = cu.minHold;
      if (typeof cu.rooms === 'boolean') p.rooms = cu.rooms;
      if (Object.keys(p).length) this.setCurtain(p);
      if (cu.confirm === true) this.confirmCurtain();
    }
    // capture cover: {cover: {on?: bool | 'toggle', style?, text?}}
    const cv = a.cover as Record<string, unknown> | undefined;
    if (cv && typeof cv === 'object') {
      const p: Partial<SceneCaptureCover> = coverArgsPatch(cv, this.capcover.on);
      if (Object.keys(p).length) this.setCapCover(p);
    }
    // (a room added a moment ago, e.g. Creator Console "Use it now": rescan the room list first so its info is known)
    // (a style given together with the room is for that change: it wins over the rooms' own transitions)
    const explicitCurtain = !!cu && typeof cu === 'object' && isCurtainStyle(cu.style);
    if (typeof a.sceneId === 'string' && isSceneId(a.sceneId) && !this.scenes.some((x) => x.id === a.sceneId)) { const id = a.sceneId; void this.refreshScenes().then(() => this.setScene(id, { explicitCurtain })); }
    else if (typeof a.sceneId === 'string' || a.sceneId === null) this.setScene(a.sceneId as string | null, { explicitCurtain });
    // room prop toggles: {toggle: {id, on?: bool | 'toggle'}} or a list of them (after a sceneId in the same command)
    const tg = a.toggle as unknown;
    for (const t of (Array.isArray(tg) ? tg : tg ? [tg] : []).slice(0, 16)) {
      const x = (t && typeof t === 'object' ? t : {}) as Record<string, unknown>;
      if (isToggleId(x.id)) this.setToggle(x.id, typeof x.on === 'boolean' ? x.on : 'toggle');
    }
    if (typeof a.area === 'string') this.setArea(a.area);            // {area: 'bar' | 'next' | 'prev'} (rooms with areas)
    // stage layouts: {stage: {react?, gaming?, strip?, corner?, cam?, framing?, backdrop?, dock?, lounge?}, lineup?: true}
    const sg = a.stage as Record<string, unknown> | undefined;
    if (sg && typeof sg === 'object') { const cur = this.stage; const next = sanitizeStageState({ ...cur, ...sg, dock: { ...cur.dock, ...(sg.dock && typeof sg.dock === 'object' ? sg.dock : {}) } }); this.setStage({ react: next.react, gaming: next.gaming, strip: next.strip, corner: next.corner, cam: next.cam, framing: next.framing, backdrop: next.backdrop, dock: next.dock, lounge: next.lounge, tvFeed: next.tvFeed, chatText: next.chatText,
      ...(sg.chatBox && typeof sg.chatBox === 'object' ? { chatBox: sanitizeChatBox({ ...(cur.chatBox ?? DEFAULT_CHAT_BOX), ...sg.chatBox }) } : {}) }); }
    if (a.lineup === true || a.lineup === false) this.lineupTest(a.lineup);
    if (isModeId(a.mode) && (a.mode === 'talk' || a.mode === 'react' || stageModeDef(a.mode))) this.setMode(a.mode);
    if (typeof a.camera === 'string') this.setCamera(a.camera, a.camPick !== false);   // (deck.ts: Auto sends camPick:false)
    if (typeof a.focus === 'string') this.setFocus(a.focus);
    // lounge events (hangout rooms): {lounge: {event, n?, user?} | flags} (loaded lazily: the panel module imports this one)
    if (a.lounge && typeof a.lounge === 'object') { const lo = a.lounge as Record<string, unknown>; void import('../ui/loungePanel.ts').then((m) => m.loungeCommand(this, lo)).catch((e) => console.warn('[lounge]', e)); }
    // people in the room: {present: {key, on: bool | 'toggle', how?: 'walk' | 'instant'}}, {entrances: {walk?, join?}}
    const pr = a.present as Record<string, unknown> | undefined;
    if (pr && typeof pr === 'object' && typeof pr.key === 'string' && /^[@A-Za-z0-9_-]{1,64}$/.test(pr.key)) {
      const inNow = this.state.present[pr.key] !== false;
      const on = pr.on === 'toggle' ? !inNow : pr.on === true;
      if (typeof pr.on === 'boolean' || pr.on === 'toggle') this.setPresent(pr.key, on, pr.how === 'walk' || pr.how === 'instant' ? pr.how : undefined);
    }
    const en = a.entrances as Record<string, unknown> | undefined;
    if (en && typeof en === 'object') {
      const cur = sanitizeEntrances(this.state.entrances);
      const p: Partial<NonNullable<SceneState['entrances']>> = {};
      if (typeof en.walk === 'boolean') p.walk = en.walk; else if (en.walk === 'toggle') p.walk = !cur.walk;
      if (en.join === 'walk' || en.join === 'seated' || en.join === 'outside') p.join = en.join;
      if (Object.keys(p).length) this.setEntrances(p);
    }
    // raid: {raid: {on?, intensity?, freq?, event?: 'tagilla' | 'skirmish' | …}}
    const r = a.raid as Record<string, unknown> | undefined;
    if (r && typeof r === 'object') {
      const p: Partial<SceneRaidState> = {};
      if (typeof r.on === 'boolean') p.on = r.on;
      if (r.intensity === 'chill' || r.intensity === 'normal' || r.intensity === 'hot') p.intensity = r.intensity;
      if (typeof r.freq === 'number' && Number.isFinite(r.freq)) p.freq = Math.min(3, Math.max(0.25, r.freq));
      if (typeof r.calm === 'boolean') p.calm = r.calm; else if (r.calm === 'toggle') p.calm = !this.state.raid?.calm;
      if (Object.keys(p).length) this.setRaid(p);
      if (typeof r.event === 'string') this.raidEvent(r.event);
    }
    // music lighting style: {lightStyle: 'neon_rave' | 'auto' | 'off' | 'u:0'}
    if (typeof a.lightStyle === 'string') this.setLightStyle(a.lightStyle);
    // reactive lights (Stream Deck / scripts): {reactiveLights: {on?: bool | 'toggle', mood?: 'room'|'calm'|'club'|'rave'|'next', safe?: bool}}
    const rl = a.reactiveLights as Record<string, unknown> | undefined;
    if (rl && typeof rl === 'object') this.setLights(reactiveLightsPatch(this.state.lights, rl));
    // club: {club: {bits?, freq?, djHands?, sound?, entranceCam?, event?: 'conga' | … | 'tip' | 'raid' …, area?: 'dj' | 'balcony'}}
    const cl = a.club as Record<string, unknown> | undefined;
    if (cl && typeof cl === 'object') {
      const p: Partial<SceneClubState> = {};
      for (const k of ['bits', 'djHands', 'sound', 'entranceCam'] as const) if (typeof cl[k] === 'boolean') p[k] = cl[k] as boolean;
      if (typeof cl.freq === 'number' && Number.isFinite(cl.freq)) p.freq = Math.min(3, Math.max(0.25, cl.freq));
      if (Object.keys(p).length) this.setClub(p);
      if (typeof cl.event === 'string') this.clubEvent(cl.event, { user: typeof cl.user === 'string' ? cl.user : undefined, usd: typeof cl.usd === 'number' ? cl.usd : undefined });
      if (typeof cl.area === 'string') this.clubArea(cl.area);
    }
    // festival stages: {festival: {show?, pyro?, intensity?, look?, cue?: 'drop' | 'flames' | 'co2' | 'confetti' | 'fireworks' | 'gerbs' | 'blinders' | 'blackout' | 'cue:<name>'}}
    if (a.festival && typeof a.festival === 'object') this.setFestival(a.festival as Partial<SceneFestivalState> & { cue?: string });
    // kitchen: {kitchen: {on?, fights?, freq?, event?: 'foodfight' | 'riot' | 'manager', donate?: usd}}
    const kc = a.kitchen as Record<string, unknown> | undefined;
    if (kc && typeof kc === 'object') {
      const p: Partial<SceneKitchenState> = {};
      if (typeof kc.on === 'boolean') p.on = kc.on;
      if (typeof kc.fights === 'boolean') p.fights = kc.fights;
      if (typeof kc.freq === 'number' && Number.isFinite(kc.freq)) p.freq = Math.min(3, Math.max(0.25, kc.freq));
      if (Object.keys(p).length) this.setKitchen(p);
      if (typeof kc.event === 'string') this.kitchenEvent(kc.event);
      if (typeof kc.donate === 'number' && Number.isFinite(kc.donate)) this.kitchenSupport(Math.min(10000, Math.max(0, kc.donate)));
    }
    // environment: {env: {on?, hour?, weather?, clock?: 'cycle'|'real'|'fixed', speed?, auto?: bool}}
    const ev = a.env as Record<string, unknown> | undefined;
    if (ev && typeof ev === 'object') {
      const p: Partial<SceneEnvState> = {};
      if (typeof ev.on === 'boolean') p.on = ev.on;
      if (typeof ev.hour === 'number' && Number.isFinite(ev.hour)) p.hour = ((ev.hour % 24) + 24) % 24;
      if (ev.clock === 'cycle' || ev.clock === 'real' || ev.clock === 'fixed') p.clock = ev.clock;
      if (typeof ev.speed === 'number' && Number.isFinite(ev.speed)) p.speed = Math.min(1440, Math.max(0.1, ev.speed));
      if (typeof ev.weather === 'string' && (ENV_WEATHERS as readonly string[]).includes(ev.weather)) p.weather = ev.weather as EnvWeather;
      if (typeof ev.auto === 'boolean') p.weatherMode = ev.auto ? 'cycle' : 'manual';
      if (Object.keys(p).length) this.setEnv(p);
    }
    // space: {space: {on?, intensity?, freq?, event?: 'threat' | 'barrage' | …}}
    const sp = a.space as Record<string, unknown> | undefined;
    if (sp && typeof sp === 'object') {
      const p: Partial<SceneSpaceState> = {};
      if (typeof sp.on === 'boolean') p.on = sp.on;
      if (sp.intensity === 'chill' || sp.intensity === 'normal' || sp.intensity === 'hot') p.intensity = sp.intensity;
      if (typeof sp.freq === 'number' && Number.isFinite(sp.freq)) p.freq = Math.min(3, Math.max(0.25, sp.freq));
      if (Object.keys(p).length) this.setSpace(p);
      if (typeof sp.event === 'string') this.spaceEvent(sp.event);
    }
    // alert reactions: {reaction: {tier?: 'small'|'medium'|'large'|'huge', usd?, platform?, fkind?, amount?, user?}}
    if (a.reaction && typeof a.reaction === 'object') this.testReaction(a.reaction as Record<string, unknown>);
  }

  /** Observer sandbox only: add / remove stand-in performers (library avatars). */
  setTestMembers(ids: string[]) {
    if (!this.observer) return;
    this.testMembers = ids.slice(0, 11).map((id) => ({ key: `lib:${id}`, avatarId: id, name: id }));
    this.edit((s) => this.autoAssign(s), 1500);
    // their size classes decide their spots: re-seat once the profiles are in
    void Promise.all(ids.slice(0, 11).filter((id) => !this.testSizes.has(id)).map((id) => api.get<{ size?: unknown }>(`/api/avatars/${encodeURIComponent(id)}`).then((p) => { this.testSizes.set(id, avatarSize(p)); const b = p as { size?: unknown; body?: unknown; mech?: unknown; vehicle?: unknown }; this.testBodies.set(id, { size: b.size, body: b.body, mech: b.mech, vehicle: b.vehicle }); }).catch(() => {})))
      .then(() => this.edit(() => {}, 1500));
  }

  setGuestClassic(on: boolean) {
    this.guestClassic = on;
    localStorage.setItem(GUEST_OPT, on ? '1' : '0');
    this.publishLocal();
    this.emit();
  }

  /** The react screen's window: shown in the Scene-tab preview directly, and (host / solo, not observer) streamed to
   *  this PC's OBS pages for in-scene capture. null = stop (OBS shows NO SIGNAL in in-scene mode). */
  setCapture(stream: MediaStream | null) {
    this.capture?.getTracks().forEach((t) => { if (t.readyState === 'live' && stream !== this.capture) t.stop(); });
    this.capture = stream;
    stream?.getVideoTracks()[0]?.addEventListener('ended', () => { if (this.capture === stream) this.setCapture(null); });
    for (const p of this.pages) p.setCapture(stream);
    this.share.setStream(stream);
    this.emit();
  }

  /** Ask the performer to pick a window / screen (browser picker). Browsers never let a page re-open a picked window
   *  by itself, so after a studio reload this has to be clicked again (OBS shows NO SIGNAL meanwhile). */
  async pickSource(): Promise<void> {
    const stream = await navigator.mediaDevices.getDisplayMedia({
      // ≤ 1080p: a shared TAB is otherwise UPSCALED to the ideal size (measured: 3808×1970, 13 ms encode, 60–245 ms
      // jitter buffer) and big windows cost encode + decode time for pixels the 3D screen can't show anyway
      video: { frameRate: { ideal: 60, max: 60 }, width: { max: 1920 }, height: { max: 1080 } },
      audio: false,                                   // the window's sound stays in the performer's OBS audio routing
      selfBrowserSurface: 'exclude', surfaceSwitching: 'include',
    } as DisplayMediaStreamOptions);
    this.setCapture(stream);
  }

  /** Screen video (shared/screenVideo.ts): edit the host's settings / clock. */
  /** Ambient cameras (Scene tab / Stream Deck): replace the whole bag through `fn`. */
  setAmbientCam(fn: (v: SceneAmbientCam) => SceneAmbientCam, command = false) {
    this.edit((s) => {
      const was = !!s.ambcam?.on;
      s.ambcam = fn(structuredClone(s.ambcam ?? DEFAULT_AMBCAM));
      if (s.ambcam.on && (!was || command)) setPick(s, false);   // the host asked for the ambient cameras (on / next / a move / auto): they take the camera
    });
  }
  setVideo(fn: (v: SceneVideoState) => void) { this.edit((s) => { const v = structuredClone(s.video ?? DEFAULT_VIDEO_STATE); fn(v); s.video = v; }); }
  /** This studio drives the screen-video clock (host / solo, once the saved scene state is in). */
  get videoHost() { return this.loaded && this.party.role !== 'guest'; }

  /** React screen content settings (host). */
  setScreen(p: Partial<ScreenSettings>) { this.edit((s) => { s.screen = { ...sanitizeScreen(s.screen), ...p, glassV: 2 }; }); }
  get capturing() { return !!this.capture; }
  get captureStream() { return this.capture; }

  // ---------------------------------------------------------------- internals
  private edit(fn: (s: SceneState) => void, joinLead = 3000) {
    if (!this.canEdit) return;
    if (!this.loaded && !this.observer) { this.early.push({ fn, lead: joinLead }); if (this.early.length > 200) this.early.shift(); }
    const s = structuredClone(this.state);
    fn(s);
    this.autoAssign(s);
    this.stampMoves(this.state, s, joinLead);
    this.stampForms(this.state, s);
    s.rev = (s.rev || 0) + 1;
    this.state = sanitizeSceneState(s);
    this.remember();
    this.changed(true);
  }

  private assign(s: SceneState, key: string, spot: number) {
    const cur = s.spots[key];
    const other = Object.keys(s.spots).find((k) => k !== key && s.spots[k] === spot);
    if (other) { if (cur !== undefined) s.spots[other] = cur; else delete s.spots[other]; }
    s.spots[key] = spot;
  }

  /** Interview line-up ↔ the party (host): a line-up guest whose member left and came back (link guests get a NEW id
   *  on every join) is re-linked by name, so their camera reaches the monitor instead of a dead entry; in Interview mode
   *  a member who joins goes into the line-up by themselves (a free slot, else the slot of someone who has left). */
  /** Interview guests who left the party: name → their line-up entry + slot (30 min), for when they come back. */
  private departed = new Map<string, { entry: InterviewGuest; index: number; at: number }>();
  private syncInterviewGuests(s: SceneState) {
    const bag = (s.modes as Record<string, unknown> | undefined)?.interview as { guests?: InterviewGuest[] } | undefined;
    if (!bag || !Array.isArray(bag.guests) || this.party.role === 'guest') return;
    const members = this.members().filter((m) => m.key !== HOST_KEY && !m.key.startsWith('lib:')).map((m) => ({ key: m.key, name: m.name, tv: !!this.party.tvOf?.(m.key) }));
    // greenroom: a guest sent back to the green room leaves the line-up (their slot is remembered for the next time)
    const G = this.party.green;
    const held = lineupWithoutWaiting(bag.guests, (k) => G.hidden(k));
    for (const r of held.removed) { const e = G.entry(r.key); if (e) e.slot = r.slot; }
    const before = new Set(held.guests.map((g) => g.key).filter(Boolean));
    // (a co-host held in the green room comes back as a co-host — into a co-host place while there is one)
    const coKeys = new Set(members.map((m) => m.key).filter((k) => G.entry(k)?.slot?.role === 'cohost'));
    // a member who left and came back (link guests: a new id) returns to their old slot / place / role
    const clean = (n: string) => n.replace(/ \(.*\)$/, '').trim().toLowerCase();
    const now = Date.now();
    for (const [k, v] of this.departed) if (now - v.at > 30 * 60_000) this.departed.delete(k);
    let lineup = held.guests;
    for (const m of members) {
      if (lineup.some((g) => g.key === m.key)) continue;
      const d = this.departed.get(clean(m.name));
      if (!d) continue;
      this.departed.delete(clean(m.name));
      lineup = restoreDeparted(lineup, d.entry, m.key, m.tv, d.index);
    }
    bag.guests = syncInterviewLineup(lineup, members, s.mode === 'interview', coKeys);
    // …and whoever is gone now leaves the line-up (no "perpetual guest" on the monitor); remembered for 30 min
    const here = new Set(members.map((m) => m.key));
    const pr = pruneDeparted(bag.guests, here);
    for (const d of pr.departed) this.departed.set(d.entry.name.trim().toLowerCase(), { entry: d.entry, index: d.index, at: now });
    while (this.departed.size > 8) this.departed.delete(this.departed.keys().next().value!);
    bag.guests = pr.guests;
    // …and back in their old slot + place when brought on again
    for (const k of bag.guests.map((g) => g.key)) {
      const e = k && !before.has(k) ? G.entry(k) : undefined;
      if (!k || !e?.slot) continue;
      bag.guests = restoreSlot(bag.guests, k, e.slot);
      e.slot = null;
    }
  }

  /** Host keeps their spot; members without a (valid, unique) spot get their remembered seat or the first free one. */
  private autoAssign(s: SceneState) {
    this.syncInterviewGuests(s);
    const members = this.members().map((m) => m.key);
    const keep = new Set(members);
    for (const k of Object.keys(s.spots)) if (!keep.has(k)) delete s.spots[k];
    for (const k of Object.keys(s.present)) if (!keep.has(k)) delete s.present[k];
    if (!keep.has(s.focus)) s.focus = HOST_KEY;
    const taken = new Set<number>();
    const order = [HOST_KEY, ...members.filter((k) => k !== HOST_KEY)];
    // (size class + body kind + forms zones: shared/occupant.ts spotFitOcc)
    const route = this.routing(s);
    const occs = new Map(this.members().map((m) => [m.key, this.occFor(m, s)]));
    const occ = (k: string) => occs.get(k) ?? this.occFor(undefined, s);
    const seats = this.seatSpots();
    const fitAt = (k: string, i: number) => { const x = seats.find((q) => q.index === i); return x ? spotFitOcc(x, occ(k), route.converts) : 0; };
    for (const k of order) {
      const i = s.spots[k];
      // (a spot that doesn't suit their size any more — e.g. they changed their avatar — is given up)
      if (i === undefined || !this.validSpot(i) || taken.has(i) || fitAt(k, i) === 0) delete s.spots[k];
      else taken.add(i);
    }
    // micro / macro guests seated on an ordinary spot by default move up to their own spot once one is free
    for (const k of order) {
      const i = s.spots[k];
      if (i === undefined || (k === HOST_KEY && !this.upgradeHost) || this.picked.has(k) || fitAt(k, i) !== 1) continue;
      const up = pickSpotOcc(seats.filter((q) => spotFitOcc(q, occ(k), route.converts) === 2), occ(k), taken, -1, route.converts);
      if (up >= 0) { taken.delete(i); s.spots[k] = up; taken.add(up); }
    }
    const mem = s.sceneId ? this.memory()[s.sceneId] ?? {} : {};
    const names = new Map(this.members().map((m) => [m.key, m.name]));
    const uids = new Map(this.members().map((m) => [m.key, m.uid]));
    for (const k of order) {
      if (s.spots[k] !== undefined) continue;
      const uid = uids.get(k);
      const want = k === HOST_KEY ? mem.host : (uid ? mem.byUser?.[uid] : undefined) ?? mem.byName?.[names.get(k) ?? ''];
      // their remembered seat when it still suits their size as well as the best free one, else the best free one
      // (TTRPG rooms keep the GM's chair for the GM: shared/ttrpg/state.ts gmSeatRule)
      const gmRule = gmSeatRule(this.scenes.find((x) => x.id === s.sceneId), s.ttrpg, k);
      const ok = seats.filter((q) => this.validSpot(q.index) && (q.index !== GM_SPOT || gmRule === 'free'));
      let pick = pickSpotOcc(ok, occ(k), taken, want !== undefined && this.validSpot(want) && (want !== GM_SPOT || gmRule === 'free') ? want : gmRule === 'free' && s.ttrpg?.on ? GM_SPOT : -1, route.converts);
      if (pick < 0 && gmRule === 'last') pick = pickSpotOcc(seats.filter((q) => q.index === GM_SPOT && this.validSpot(q.index)), occ(k), taken, -1, route.converts);
      if (pick >= 0) { s.spots[k] = pick; taken.add(pick); }
    }
    if (this.party.role === 'host') s.hostId = this.party.myId; else delete s.hostId;
    this.reseatForBig(s);
    // stage layouts: the strip / tile order = join order (host first); leavers drop out, newcomers go last
    const st = sanitizeStageState(s.stage ?? DEFAULT_STAGE);
    const ord = [HOST_KEY, ...st.order.filter((k) => k !== HOST_KEY && keep.has(k))];
    for (const k of members) if (!ord.includes(k)) ord.push(k);
    if (ord.join(',') !== st.order.join(',') || !s.stage) { st.order = ord; s.stage = st; }
  }

  /** Timed walk events for every member whose place (spot, or outside = -1) changed. */
  private stampMoves(prev: SceneState, next: SceneState, joinLead: number) {
    if (next.sceneId !== prev.sceneId || !next.sceneId) { next.moves = {}; return; }     // new room: everyone just appears
    const where = (s: SceneState, k: string) => (s.present[k] !== false && s.spots[k] !== undefined ? s.spots[k] : -1);
    const now = Date.now();
    const keys = new Set([...Object.keys(prev.spots), ...Object.keys(next.spots)]);
    const moves: SceneState['moves'] = {};
    for (const k of Object.keys(next.moves ?? {})) if (next.spots[k] !== undefined) moves[k] = next.moves[k];
    const ent = sanitizeEntrances(next.entrances);
    // who is new to the PARTY (not merely getting a first seat: a full room, a size spot appearing later) — Joiners
    // "Outside" / "Seated" apply only to them
    const roster = new Set(this.members().map((m) => m.key));
    const fresh = (k: string) => k !== HOST_KEY && roster.has(k) && !this.knownMembers.has(k);
    // host changes first, then joins (a stable order → a stable door queue)
    for (const k of [...keys].sort((a, b) => (a === HOST_KEY ? -1 : b === HOST_KEY ? 1 : a.localeCompare(b)))) {
      const joined = prev.spots[k] === undefined && next.spots[k] !== undefined && prev.present[k] === undefined && k !== HOST_KEY;
      const newcomer = joined && fresh(k);
      // greenroom: brought on from the green room — they come INTO the room (never "wait outside"), walking in when
      // walk-ins are on, else appearing in their seat (Joiners "Seated" too)
      const gr = this.party.green.entry(k);
      const brought = newcomer && !!gr?.entering;
      if (gr?.entering && next.spots[k] !== undefined) gr.entering = false;
      // Entrances → "Guests who join: wait outside": they're in the party but not in the room until the host brings them in
      if (newcomer && !brought && ent.join === 'outside' && next.present[k] === undefined) next.present[k] = false;
      const a = where(prev, k), b = where(next, k);
      if (a === b) continue;
      // instant (walk-ins off, "already here", or a joiner who arrives seated): a walk that ended long ago — every page
      // lands them straight in their seat (or out of the room), no door, no follow camera
      const how = this.presentHow.get(k);
      const instant = how ? how === 'instant' : !ent.walk || (newcomer && ent.join === 'seated');
      if (instant && (a === -1 || b === -1)) { moves[k] = { from: a, to: b, at: now - 600_000 }; continue; }
      let at = now + (joined ? joinLead : 150);
      if (a === -1 || b === -1) { at = Math.max(at, this.doorSlot + 1200); this.doorSlot = at; }
      moves[k] = { from: a, to: b, at };
    }
    next.moves = moves;
    this.knownMembers = roster;
  }
  /** Party member keys already seen by stampMoves (Joiners settings apply to anyone not in here). */
  private knownMembers = new Set<string>();

  /** Room forms (shared/forms.ts): every zone's form picked from who is at it (size + body plan), stamped into
   *  SceneState.modes.forms next to the walks (a walk-in starts its zone's change; a walk-out ends it after they are out).
   *  Rooms without `forms` carry no bag. */
  private stampForms(prev: SceneState, next: SceneState) {
    const info = next.sceneId ? this.scenes.find((x) => x.id === next.sceneId) : undefined;
    const defs = info ? parseForms(info) : null;
    const modes = (next.modes ?? {}) as Record<string, unknown>;
    if (!defs || !next.sceneId) { if (FORMS_BAG in modes) { const m = { ...modes }; delete m[FORMS_BAG]; next.modes = m; } return; }
    const big = parseBigEntrance(info);
    const base = (info?.avatarHeight ?? 1.5) * (next.avatarScale || 1);
    this.stampedOcc = JSON.stringify(occupantOf(this.party.myAvatar));
    const members = this.members().map((m) => ({ key: m.key, spot: next.spots[m.key] ?? -1, present: next.present[m.key] !== false, occ: m.occ?.(defs.rules, base) ?? occupantOf(null, defs.rules, undefined, base) }));
    // (the zones' stamps from the committed state; the lock as this edit leaves it: setFormLock)
    const cur = formsBagOf(next.modes, next.sceneId), old = formsBagOf(prev.modes, next.sceneId);
    const before = old ? { ...old, lock: cur?.lock } : cur;
    const bag = stampFormsBag(before, { defs, sceneId: next.sceneId, now: Date.now(), roomChanged: prev.sceneId !== next.sceneId, members, spotIndex: spotIndexOfName,
      moves: next.moves, holdFor: (o) => (big && usesBigEntrance(big, o) ? bigExitHold(big) : 1.2) });
    if (JSON.stringify(bag) !== JSON.stringify(modes[FORMS_BAG] ?? null)) next.modes = { ...modes, [FORMS_BAG]: bag };
  }
  /** Host: lock a zone's form by hand (null = automatic again) - a "show the dock" button, a Stream Deck key. */
  setFormLock(zone: string, form: string | null) {
    this.edit((s) => {
      const b = formsBagOf(s.modes, s.sceneId);
      if (!b) return;
      const lock = { ...(b.lock ?? {}) };
      if (form) lock[zone] = form; else delete lock[zone];
      s.modes = { ...(s.modes ?? {}), [FORMS_BAG]: { ...b, lock } };
    });
  }

  private memory(): Record<string, Memory> {
    try { return JSON.parse(localStorage.getItem(MEM_KEY) || '{}') as Record<string, Memory>; } catch { return {}; }
  }
  private remember() {
    const s = this.state;
    if (!s.sceneId || this.observer) return;
    const all = this.memory();
    const m: Memory = all[s.sceneId] ?? {};
    m.byName ??= {};
    for (const mem of this.members()) {
      const i = s.spots[mem.key];
      if (i === undefined) continue;
      if (mem.key === HOST_KEY) m.host = i;
      else if (mem.uid) (m.byUser ??= {})[mem.uid] = i;
      else if (!mem.key.startsWith('lib:')) m.byName[mem.name] = i;
    }
    all[s.sceneId] = m;
    try { localStorage.setItem(MEM_KEY, JSON.stringify(all)); } catch { /* full */ }
    if (m.host !== undefined) rememberRoomMemory(s.sceneId, { host: m.host });
  }

  /** Something changed: persist (host), tell guests, this PC's OBS, previews and the UI. */
  private changed(persist: boolean) {
    if (persist && !this.observer && this.canEdit) {
      // the server saves it and broadcasts {type:'scene'} to this PC's OBS pages (src/scene/sceneSync.ts: only what this
      // tab changed; held until the helper's state is read; retried while the helper is away)
      this.sync.schedule();
      if (this.party.role === 'host' && this.loaded) { clearTimeout(this.sendT); this.sendT = window.setTimeout(() => this.party.sendScene(this.state), 50); }
    }
    this.pushPreviews();
    this.emit();
  }

  /** The helper's saved state is in: adopt it, replay the edits made before, tell the guests (a host studio that
   *  reloads mid-party used to send them the defaults = Classic until its next edit). */
  private onLoaded(s: SceneState) {
    this.state = s;
    for (const e of this.early.splice(0)) this.edit(e.fn, e.lead);
    this.changed(false);
    // (re-seat whoever joined meanwhile and send the guests the real room: onParty sends it whether or not seats changed)
    this.onParty();
  }
  /** Another tab's save was merged into this tab's state. */
  private onMerged() {
    if (this.party.role === 'host' && !this.observer) { clearTimeout(this.sendT); this.sendT = window.setTimeout(() => this.party.sendScene(this.state), 50); }
    this.pushPreviews();
    this.emit();
  }
  private onSaved(ok: boolean, err?: string) {
    if (!ok) { console.warn('scene save failed', err); this.saveError = { at: Date.now(), msg: err ?? 'save failed' }; this.emit('save'); return; }
    if (this.saveError) { this.saveError = null; this.emit('save'); }
  }

  private onParty() {
    const was = this.lastRole;
    this.lastRole = this.party.role;
    if (was === 'guest' && this.party.role !== 'guest') { this.leftParty(); return; }
    if (this.party.role === 'guest') { this.pushPreviews(); this.emit(); return; }
    // roster changed (join / leave): re-seat, keep the host's pick
    const before = JSON.stringify(this.state.spots) + this.state.hostId + JSON.stringify((this.state.modes as Record<string, unknown> | undefined)?.interview ?? null) + JSON.stringify((this.state.modes as Record<string, unknown> | undefined)?.[FORMS_BAG] ?? null);
    const s = structuredClone(this.state);
    this.autoAssign(s);
    this.stampMoves(this.state, s, 3000);
    this.stampForms(this.state, s);
    // (in Classic nothing is saved just because someone joined — only the host's own edits persist)
    if (JSON.stringify(s.spots) + s.hostId + JSON.stringify((s.modes as Record<string, unknown> | undefined)?.interview ?? null) + JSON.stringify((s.modes as Record<string, unknown> | undefined)?.[FORMS_BAG] ?? null) + JSON.stringify(s.stage?.order ?? []) !== before + JSON.stringify(this.state.stage?.order ?? [])) { s.rev++; this.state = sanitizeSceneState(s); this.remember(); this.changed(!!s.sceneId); if (!s.sceneId && this.party.role === 'host' && !this.observer && this.loaded) this.party.sendScene(this.state); this.maybeLounge(); }
    else {
      // same seats, but a newcomer needs the room (once the helper's state is in: never the start-up defaults)
      if (this.party.role === 'host' && !this.observer && this.loaded) this.party.sendScene(this.state);
      this.pushPreviews(); this.emit();
    }
  }

  private onHostState(s: SceneState) {
    const st = sanitizeSceneState(s);
    // host clock → ours, so this PC's OBS pages start each walk when the host's do
    if (st.sentAt) {
      this.offsets.push(Date.now() - st.sentAt);
      if (this.offsets.length > 12) this.offsets.shift();
      const off = Math.min(...this.offsets);
      for (const m of Object.values(st.moves)) m.at += off;
      if (st.raid) { if (st.raid.epoch > 0) st.raid.epoch += off; for (const e of st.raid.events) e.at += off; }
      if (st.space) { if (st.space.epoch > 0) st.space.epoch += off; for (const e of st.space.events) e.at += off; }
      if (st.kitchen) { if (st.kitchen.epoch > 0) st.kitchen.epoch += off; if (st.kitchen.unrestAt > 0) st.kitchen.unrestAt += off; for (const e of st.kitchen.events) e.at += off; }
      if (st.env) { if (st.env.epoch > 0) st.env.epoch += off; if (st.env.weatherAt > 0) st.env.weatherAt += off; }
      if (st.era && st.era.base > 0) st.era.base += off;
      if (st.stage?.test) st.stage.test += off;
      if (st.video?.now && !st.video.now.paused) st.video.now.at += off;   // screen video: host clock → ours
      if (st.ttrpg) shiftTtrpgClock(st.ttrpg, off);
      shiftSlapClock(st.modes, off);
      shiftYachtClock(st.modes, off);
      shiftVoyageClock(st.modes, off);
      shiftLoungeClock(st.modes, off);
      shiftFormsClock(st.modes, off);                         // room forms: the zones' change stamps
      for (const r of st.reactions ?? []) { r.at += off; r.until += off; }
      delete st.sentAt;
    }
    this.hostState = st;
    this.publishLocal();
    this.pushPreviews();
    this.emit();
  }

  /** Guest: hand the host's room to this PC's OBS pages (bus), marked with who "me" is. */
  private publishLocal() {
    // (not before the host's state has arrived: a guest studio that reloads mid-party used to send Classic meanwhile)
    if (this.party.role !== 'guest' || this.observer || !this.hostState) return;
    this.bus.send({ type: 'scene', state: this.effective, self: this.party.myId });
  }

  /** Left the party (guest → solo): OBS goes back to our own saved room. */
  leftParty() {
    this.hostState = null;
    // (an empty save: the helper re-broadcasts this PC's own state, so its OBS pages leave the host's room)
    if (!this.observer && this.state.sceneId) this.sync.schedule(true);
    else if (!this.observer) this.bus.send({ type: 'scene', state: this.state, self: HOST_KEY });
    this.pushPreviews();
    this.emit();
  }

  /** Is this studio tracking right now? (set by the UI that has the App: scenePanel / simple / wizards) — previews
   *  only use it for the opt-in "while tracking" savings. */
  trackingProbe: (() => boolean) | null = null;
  /** Preview pause / fps per connected preview (src/scene/previewLink.ts PreviewGate; `.state` = what it was told last). */
  private gates = new Map<PreviewPage, PreviewGate>();

  private connectPreview(page: PreviewPage) {
    this.pages.add(page);
    for (const [p, g] of this.gates) if (!this.pages.has(p)) { g.dispose(); this.gates.delete(p); }   // (pages dropped on an error)
    // (nobody can see it → the preview stops drawing: it runs on this page's main thread, next to the tracker)
    const tracking = () => {
      try { return this.trackingProbe ? !!this.trackingProbe() : !!(window as unknown as { vtp?: { trackingOn?: boolean } }).vtp?.trackingOn; } catch { return false; }
    };
    try { this.gates.get(page)?.dispose(); this.gates.set(page, new PreviewGate(page, tracking)); } catch (e) { console.warn('[scene] preview gate', e); }
    queueMicrotask(() => { this.pushPreview(page); if (this.capture) page.setCapture(this.capture); });
    return {
      report: (r: PreviewReport) => {
        this.report = r;
        const sig = (x: RoomSummary | undefined) => (x ? x.spots.map((s) => (s ? `${s.index}:${(s.sizes ?? []).join('/')}` : '-')).join(',') : '');
        if (r.room && (!this.rooms.has(r.room.id) || sig(this.rooms.get(r.room.id)) !== sig(r.room))) {
          this.rooms.set(r.room.id, r.room);
          // the room's real spot list is known now (incl. its size spots): drop seats it doesn't have, seat by size
          if (this.canEdit && r.room.id === this.state.sceneId) this.edit(() => {});
        } else if (r.room) this.rooms.set(r.room.id, r.room);
        this.emit('report');
        // React Big: the preview found someone in front of the screen and a seat for them — re-seat (once per hint)
        const hk = JSON.stringify(r.stage?.reseat ?? {});
        if (this.canEdit && hk !== '{}' && hk !== this.lastHints && this.state.mode === 'react') { this.lastHints = hk; this.edit(() => {}); }
      },
      disconnect: () => { this.pages.delete(page); this.gates.get(page)?.dispose(); this.gates.delete(page); },
    };
  }
  private pushPreview(p: PreviewPage) {
    try { p.apply(this.effective, this.selfKey, this.party.role === 'guest' ? [] : this.testMembers); } catch { this.pages.delete(p); }
  }
  private pushPreviews() { for (const p of this.pages) this.pushPreview(p); }
  /** Observer sandbox: a test chat / support event played in the Scene-tab preview(s) only. */
  previewChat(what: string) { const evs = testChatEvents(what); for (const p of this.pages) try { p.chat?.(evs); } catch { this.pages.delete(p); } }
  /** Beat packets (studio analysis, or the host's relayed to a guest) → the Scene-tab previews' lights. */
  sendBeat(b: unknown) { for (const p of this.pages) try { p.beat?.(b); } catch { this.pages.delete(p); } }
  /** Preset browser: play a look in the Scene-tab preview(s) only — nothing is saved or sent (null = stop). */
  previewLook(look: unknown) { this.previewing = look; for (const p of this.pages) try { p.lookPreview?.(look); } catch { this.pages.delete(p); } this.emit(); }
  previewing: unknown = null;

  /** TTRPG table (src/ttrpg/studio → shared/ttrpg/state.ts): the host's session writes the whole table here; it is saved,
   *  sent to this PC's OBS pages and to every guest like the rest of the scene (null = off). Host / solo only. */
  setTtrpg(t: SceneTtrpgState | null) {
    this.edit((s) => {
      // (the table's own camera control - Auto, a pinned shot, a seat - or opening the table hands the camera to its director)
      if (t && (t.cam !== s.ttrpg?.cam || t.camWho !== s.ttrpg?.camWho || (t.on && !s.ttrpg?.on))) setPick(s, false);
      if (t) s.ttrpg = t; else delete s.ttrpg;
    });
  }

  /** The separate-process preview link (src/scene/previewBridge.ts): diagnostics. */
  get bridge() { return bridgeStats; }
  private emit(what = 'state') { for (const l of this.listeners) try { l(what); } catch (e) { console.warn(e); } }
}

