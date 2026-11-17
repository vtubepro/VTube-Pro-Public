// OBS output: a transparent page that renders the avatar(s) driven by the studio's live frames.
// Add as an OBS Browser Source: http://127.0.0.1:5191/output.html  (transparent background built in)
// URL params (override the studio's OBS-tab settings): ?avatar=<id> (default: follow the studio),
// ?focus=full|bust|head, ?fps=60, ?scale=1, ?x=0&y=0 (offset, fractions of the frame), ?solo=1 (ignore party)
// Performance / debugging: ?diag=1 (on-page fps · frame ms · bus latency · frames/s overlay), ?tier=low|medium|high|ultra,
// ?gfx=auto|low|medium|high|ultra (= performance|balanced|…; scene graphics quality, src/stage/gfx — overrides the studio's setting),
// ?autoLower=0 (this page never lowers its preset by itself; benchmarks),
// ?dpr=1.5 (fixed render scale, e.g. supersampling; disables the adaptive scale), ?adaptive=0 (never lower the
// render scale when frames run late), ?avatarDetail=auto|full|lighter|lightest (Avatar detail for this PC's own avatar,
// overrides the studio's setting; L0..L3 pins a level on every OBS page, not only test pages: harmless, it holds a level and turns the pressure off; docs/PERFORMANCE.md "Avatar detail")
//
// Multiplayer: when the studio hosts / joins a party it announces the members ({type:'party'}) and
// relays each guest's frames tagged with `peer`; every member gets a slot next to the local performer.
// Their avatars are opened in memory from the local RAM vault (never a file: src/net/partyView.ts) and their
// network frames go through the jitter buffer / extrapolation / voice-led mouth of src/net/remoteSmoother.ts.
//
// 3D scenes (docs/SCENES.md): when the host's scene state ({type:'scene'} on the bus, /api/scene at start)
// names a room, everyone is rendered IN the room at their spots (src/scene/SceneRuntime.ts); sceneId null =
// the Classic layout above. Test / preview params (never follow the bus or the server's scene state):
//   ?sceneTest=<id>[&mode=react][&cam=wide|group|talk|react|CAM_x][&spot=1..12][&extra=frog,robot][&screen=placeholder]
//   ?preview=1   the studio's Scene-tab preview (driven directly by the studio page, see scene/previewLink.ts)
// Live pages: ?cam=CAM_x|wide|group|talk|react pins THIS page's camera (several OBS sources = several angles) while the
// room has that camera and the host is in Talk mode; otherwise (and for the entrance follow-cam / raid, kitchen … directors) it follows the host.
// Stage modes (src/scene/stage/*, SceneState.stage): Talk / React presets / Gaming layouts are drawn by the stage
// compositor (performer cams, the capture rect, docked chat + support). Test pages: &mode=gaming|react|<mode id>
//   &react=auto|full|big|medium|side &gaming=auto|corner|strip-bottom|strip-top|column &strip=s|m|l &corner=bl|br|tl|tr
//   &camsize=s|m|l &framing=bust|full &backdrop=room|clean|cutout &docks=auto|always|off &lineup=1 &content=<aspect>
// Room-change transitions (src/scene/transition/*, SceneState.curtain): a new room is covered by an animated card
// BEFORE the old one is torn down and revealed once it has loaded + warmed up (or the host confirms). Test pages:
// &curtain=boot also covers the first room; vtpOut.curtain / vtpOut.curtainTest('bw-hop').
// Room alert reactions (scene.json `reactions`, src/scene/reactions.ts, SceneState.reactions): test pages add
// &reactions=host — the page plays the HOST's part itself, so support events from this PC's server (POST /api/chat/test,
// never the live studio) fire the room's reactions here; vtpOut.reactions.debug() / .test({tier:'huge'}) / .test({on:'goal'|'timerAdd', amount}) / .goalsView(<GoalsView>).

import './audio/silentPageAuto.ts'; // FIRST: this page never makes a sound (owner: every sound plays in the studio)
import { silenceReport } from './audio/silentPage.ts';
import { showNoGl, watchGl } from './outputNoGl.ts'; // no WebGL 2 (OBS on OpenGL …): a card with the fix instead of a blank source, and Fix it hears about it
import './storageGuard.ts'; // (must stay the first import: a memory-only stand-in when the page may not keep site data)
import './licenseNotice.ts'; // hosted copies say that VTube Pro is free (LICENSE); never shown on this PC or the home network
import './net/lanPage.ts'; // a stream PC's page follows the gaming PC's mode
import { BrbOverlay } from './scene/brb/overlay.ts';
import * as THREE from 'three';
import type { BusMessage, OutputSettings, PartyMember, SceneInfo, SceneState, TrackingFrame } from '../shared/types.ts';
import { normalizeProfile } from '../shared/defaults.ts';
import { adoptBuildFree, reloadForSave, sameAvatarBuild } from '../shared/profileBuild.ts';
import type { PartyLodStatus } from '../shared/modelStats.ts';
import { HOST_KEY, defaultSceneState, sanitizeSceneState } from '../shared/scene.ts';
import { api } from './api.ts';
import { AvatarRuntime } from './avatar/AvatarRuntime.ts';
import { LoadSlicer, isCancelled } from './avatar/loadSlicer.ts';
import { Bus } from './bus.ts';
import { outputHelloFields } from '../shared/obsPages.ts';
import { isRoomId } from '../shared/roomId.ts';
import { FpsGate, FrameSync } from './outputSync.ts';
import { LatestLoads, SourceLock } from './outputFollow.ts';
import { OutputPerf } from './outputPerf.ts';
import { outputStamps } from './outputStamps.ts';   // VTube Pro Live page telemetry (off unless VTube Pro asks, src/outputStamps.ts)
import type { GsPage } from './guestSend.ts';   // (types only: the sender itself is loaded on demand for ?gsSend=1)
import { installTtrpg } from './ttrpg/scene/outputHook.ts';
import { partyView } from './net/partyView.ts';
import { TV_SELF, tvPage } from './scene/tv/tvPage.ts';
import { Stage } from './stage/Stage.ts';
import { emptyFrame } from './tracking/faceSolver.ts';
import { measureRest } from './scene/actor.ts';
import { SceneRuntime, type ActorSpec } from './scene/SceneRuntime.ts';
import { capPreviewTextures, floatSkinIndices } from './stage/gfx/previewTextures.ts';
import './scene/walkMover.ts'; // installs the walking entrances / exits (AvatarMover)
import { PreviewLoop, previewWakeEnd, type PreviewExtra, type PreviewHost, type PreviewPage, type PreviewReport } from './scene/previewLink.ts';
import { bridgeOrigin, connectBridge, type PreviewEnv } from './scene/previewBridge.ts';
import { ScreenShareReceiver } from './scene/screenShare.ts';
import { ScreenFeedReceiver, feedWanted } from './scene/screenFeed.ts';
import { PIN_REASK_MS, pinFromAnswer, refusalFromAnswer } from '../shared/obsHole.ts';
import { beatClock } from './scene/beatClock.ts';
import { musicClock } from './scene/musicClockRx.ts';
import './scene/lightShow.ts'; // installs the beat-reactive light engine (SceneLights factory)
import { ChatFeed } from './chat/feed.ts';
import { setShowSoundSink, setLiveClockSink, relayShowSound } from './audio/showSoundRelay.ts';
import { PollOverlay, pollDemo, pollStore } from './poll/pollCard.ts';
import { ProductOverlay, connectShowcase, showcaseDemo } from './support/productCard.ts';
import { GoalsOverlay } from './goals/goalsOverlay.ts';
import { GoalsWorld } from './goals/goalsWorld.ts';
import { TimerDisplays } from './goals/timerDisplays.ts';
import { goalsDemo, goalsStore } from './goals/goalsStore.ts';
import { ChatScene } from './scene/chatScene.ts';
import { sanitizeChatState, type ChatStatus } from '../shared/chat.ts';
import { RaidScene } from './scene/raid/raidScene.ts';
import { TownScene } from './scene/town/townScene.ts';
import { sanitizeRaidState } from '../shared/raid.ts';
import { Graphics, type GfxRoom } from './stage/gfx/Graphics.ts';
import { DEFAULT_GFX, parseGfxChoice } from '../shared/graphics.ts';
import { AVATAR_DETAIL_NAMES, avatarDetailOf, detailThreshold, parseAvatarDetailParam, type AvatarDetailChoice } from '../shared/avatarDetail.ts';
import { DetailGovernor } from './avatar/lod/detailGovernor.ts';
import { pressureHelps, type AvatarDetail } from './avatar/lod/AvatarDetail.ts';
import { runGfxBench } from './stage/gfx/bench.ts';
import { isSoftwareRenderer } from './stage/gfx/softwareGl.ts';
import { StarveGuard, type StarveLevel } from './stage/gfx/starve.ts';
import { estimateVram } from './stage/gfx/vramEstimate.ts';
import { sanitizeGpuStat, type GpuStat, type ObsPerfReport } from '../shared/gpuStat.ts';
import { SpaceScene } from './scene/space/spaceScene.ts';
import { KitchenScene } from './scene/kitchen/kitchenScene.ts';
import { CrowdScene } from './scene/crowd/crowdScene.ts';
import { ClubScene } from './scene/club/clubScene.ts';
import { DeckScene } from './scene/djdeck/deckScene.ts';
import { sanitizeDjDeckState } from '../shared/djDeck/state.ts';
import { installAudience } from './scene/audience/install.ts';
import { sanitizeKitchenState } from '../shared/kitchen.ts';
import './scene/space/spaceMover.ts'; // cryo join / drop-pod leave cinematics for rooms that declare them (AvatarMover factory)
import './scene/arrivals/liftMover.ts'; // captain's lift entrances / exits (wraps the factory above; only rooms that use it)
import { sanitizeSpaceState } from '../shared/space.ts';
import { EnvScene } from './scene/environment/index.ts';
import { ENV_WEATHERS, sanitizeEnvState } from '../shared/environment.ts';
import { TrafficScene } from './scene/traffic/trafficScene.ts';
import { AfkScene, afkTestState } from './scene/afk/afkScene.ts';
import { EpochScene } from './scene/epoch/epochScene.ts';
import { sanitizeEraState } from '../shared/era.ts';
import { Curtain } from './scene/transition/curtain.ts';
import { capCover } from './scene/capcover/cover.ts';
import { sanitizeToggles } from '../shared/roomToggles.ts';
import { resolveCurtainStyle } from './scene/transition/styles.ts';
import { StageCompositor } from './scene/stage/compositor.ts';
import { stageModeDef } from './scene/stage/registry.ts';
import { sanitizeStageState } from '../shared/stage.ts';
import { DEFAULT_CURTAIN } from '../shared/curtain.ts';
import { SlapScene } from './scene/slap/slapScene.ts';
import { YachtScene } from './scene/yacht/yachtScene.ts';
import { VoyageScene } from './scene/voyage/voyageScene.ts';
import { ShowSkyScene } from './scene/showSky/showSky.ts';
import { FestivalScene } from './scene/festival/festivalScene.ts';
import { CrewScene } from './scene/crew/crewScene.ts';
import { LoungeScene } from './scene/lounge/loungeScene.ts';
import { RacewayScene } from './scene/space/raceway/racewayScene.ts';
import './scene/frontline/frontlineMover.ts'; // drop-pod join / dropship leave for frontline rooms (wraps the mover factory)
import { FrontlineScene } from './scene/frontline/frontlineScene.ts';
import { WarzoneScene } from './scene/warzone/warzoneScene.ts';
import { formsScene } from './scene/forms/formsScene.ts';
import { activeBigMover } from './scene/forms/bigEntrance.ts'; // big-character entrances (hangar doors / floor lift / drop) for rooms with `bigEntrance` (wraps the mover factory)
import { setFlatOverlayHost } from './avatar/flat/overlay.ts';
import { FLAT_CONTENT_EVENT } from './avatar/flat/FlatAvatar.ts';
import { Flat2dScene } from './scene/flat2d/flat2dScene.ts';
import { feedRig2DWorld, rig2dChatHook } from './avatar/flat/rig2d/worldFeed.ts';
import { applyFlatProfileInPlace, latestGate } from './avatar/flat/rig2d/liveOpts.ts';
import { ReactionScene } from './scene/reactions.ts';
import { GoalSignals, ReactionGate, manualReactionEvent, manualReactionSignal, matchReaction, matchSignal, pruneReactions, reactionsPending, reactionsStale, revertReactions, sanitizeRoomReactions, signalSource, stampReaction, type ReactionSignal } from '../shared/reactions.ts';
import { sanitizeGoalsView } from '../shared/goalsView.ts';
import { sanitizeChatEvent, type ChatEvent } from '../shared/chat.ts';
import { mountB16 } from './b16/mount.ts';
/** 2D environments (scene.json `flat2d`: flat parallax layers, src/scene/flat2d); free elsewhere. */
const flat2dScene = new Flat2dScene();

const q = new URLSearchParams(location.search);
const canvas = document.getElementById('stage') as HTMLCanvasElement;
/** ?gsSend=1 = the guest browser source's SENDER page (src/guestSend.ts, docs/GUEST_BROWSER_SOURCE.md): the helper runs it in a headless,
 *  muted browser. It shows only the avatar: Classic layout, solo, focus bust, low graphics, 30 fps, a canvas of the tier's size (set by
 *  guestSend.ts), no room, no react feed, no chat / poll / goals / overlays, no sound. Nothing is drawn unless a viewer is connected and
 *  visible (`gsPage.run`). Every other page is unchanged. */
const gsSend = q.get('gsSend') === '1';
const gsPage: GsPage = { run: false, fps: 30, frame: null, kick: () => kickLoop() };
/** The idle sender's render loop looks this often (ms) whether a viewer is visible yet; `gsPage.kick()` makes it look at once when one shows up. */
const GS_IDLE_LOOK_MS = 1000;
const tier = (gsSend ? 'medium' : (q.get('tier') as never) || 'high') as never;
// no preserveDrawingBuffer: the page never reads its canvas back, and CEF (OBS) then swaps instead of copying
const stage = (() => { try { return new Stage(canvas, { transparent: true, tier, controls: false, preserve: q.has('preview') || q.has('spSend') || gsSend, asyncEnv: q.has('preview') && q.get('asyncCompile') !== '0' }); } catch (e) { showNoGl(); throw e; } })();
watchGl(canvas);
// 2D avatars in overlay mode (src/avatar/flat/overlay.ts): a flat layer over the room, under the page's own cards
if (!gsSend) { const l = document.createElement('div'); l.className = 'vtp-flat-layer'; l.style.cssText = 'position:fixed;inset:0;pointer-events:none;overflow:hidden;z-index:3'; document.body.append(l); setFlatOverlayHost(l); }
// hello = kind of page (OBS / browser tab / preview / test), whether it runs inside OBS, and its size: the helper shows
// "OBS is connected" from it (shared/obsPages.ts, GET /api/obs/outputs)
const bus = new Bus('output', () => outputHelloFields(q, window as unknown as Parameters<typeof outputHelloFields>[1]));
if (q.has('spSend')) void import('./streamPcSend.ts').then((m) => m.startStreamSender(canvas, (x) => bus.send(x as unknown as BusMessage), (h) => bus.on(h as unknown as (m: BusMessage) => void), { stamp: q.get('spStamp') === '1' })); // Stream PC mode B: send what this page draws to the stream PC (server/streamPc.ts)
if (gsSend) void import('./guestSend.ts').then((m) => m.startGuestSend({ page: gsPage, canvas, on: (h) => bus.on(h as unknown as (m: BusMessage) => void) })); // guest browser source: send the finished picture to the other streamer's OBS
{ let t = 0; addEventListener('resize', () => { clearTimeout(t); t = window.setTimeout(() => bus.resendHello(), 800); }); }
void mountB16({ role: 'output', bus });   // beta.16 stream extras: plays the studio's stamps (src/b16/mount.ts, one lazy loader)
const pinned = q.get('avatar');
/** Test rig (&test=1 with a pinned ?avatar=): the performer is driven ONLY by vtpOut.test.frame() (never the live camera
 *  frames on the bus) and vtpOut.test.profile() layers an in-memory profile override (never saved). */
const testRig = q.get('test') === '1' && !!pinned; // test hooks: local builds / loopback pages only
let testFrame: TrackingFrame | null = null;
let testOverride: Record<string, unknown> | null = null;
const solo = q.has('solo') || gsSend;
const preview = q.has('preview');
/** Room editor (src/scene/roomEdit/editor.ts, docs/ROOM_EDITOR.md): ?roomEdit=<room> = a test page of that room with the
 *  editor over it — it never follows the bus' scene state and never publishes; its Save goes to the helper. */
const roomEditId = isRoomId(q.get('roomEdit')) ? q.get('roomEdit') : null;
const sceneTest = q.get('sceneTest') ?? roomEditId;
/** The room this page shows comes from the URL, never the bus: a test page, or the Room editor — also on the web build
 *  with no URL test switches in play (sceneTest null) the editor must still open. */
const urlRoom = sceneTest ?? roomEditId;
/** Test pages (?avatar=<id>&mechWalk=1, or =0.5): a walking machine walks on the spot at that share of its top speed, hands on
 *  the sticks (src/avatar/mech.ts treadmill: Classic review of the gait; desert_walker SPEC §2.9). */
const mechWalk = q.has('mechWalk') ? Math.min(1, Math.max(0, parseFloat(q.get('mechWalk') || '') || 0.7)) : 0;
/** Scene state comes from the URL / the studio page, never from the bus or the server. */
const sceneLocal = preview || !!urlRoom || testRig || gsSend;   // (gsSend: never follows the studio's room: Classic)
/** ?cam= on a LIVE page (test pages set state.camera from it instead): this page's own camera (SceneRuntime.cameraPin). */
const camPin = !sceneLocal && /^[A-Za-z0-9_]{1,64}$/.test(q.get('cam') || '') ? q.get('cam') : null;
/** Live chat + support events → the in-world chat props (src/scene/chatScene.ts). Test pages only read the bus with &chatBus=1. */
const chatFeed = new ChatFeed();
rig2dChatHook(chatFeed); // chat + stream events -> 2D rigs' state machines / particles (live2d lane)
const chatScene = new ChatScene(chatFeed);
/** Stage layouts (src/scene/stage/compositor.ts): React presets, Gaming, performer cams, docked chat / support. */
const stageComp = new StageCompositor(stage, chatScene, chatFeed);
// (made once: the render loop passed fresh closures with these same bodies every frame)
const stageOnBus = (fn: Parameters<typeof bus.on>[0]) => bus.on(fn);
const stagePollAvoid = () => stageComp.pollAvoid();
let chatAnyLive = false;
/** Test pages: &reactions=host plays the host's part of the room's alert reactions (it needs the bus's support events). */
const reactHost = !!sceneTest && q.get('reactions') === 'host';
const chatFromBus = !gsSend && (!urlRoom || q.has('chatBus') || reactHost);
// Sounds: none here (src/audio/silentPage.ts). Read-aloud plays in the studio (src/audio/mixer/showSounds.ts); the room
// engines' sounds (club horns, slap punches, the poll sting) are SENT to the studio from real OBS pages only (previews,
// ?sceneTest and test pages send nothing; ?voice=0 opts a second OBS page out)
if (!sceneLocal && q.get('voice') !== '0') {
  setShowSoundSink((id, s) => bus.send({ type: 'showsound', id, s }));
  setLiveClockSink((src, lag) => bus.send({ type: 'liveclock', src, lag }));
}
// chat polls (server/poll.ts → {type:'poll'}): the card in the world (chat monitor / board) or docked; the winner sting
// plays in the studio
const pollOverlay = new PollOverlay();
pollStore.onReveal = (v) => relayShowSound(`poll:${v.id}`, { k: 'sting' });
if (sceneLocal && q.get('pollDemo')) pollDemo(q.get('pollDemo')!);
else if (!sceneLocal) void api.get<{ poll: unknown }>('/api/poll/state').then((r) => { if (r?.poll) pollStore.set(r.poll); }).catch(() => {});
// Support & store (beta.13): the product showcase + "Sam just bought this!" (src/support/productCard.ts, server/support/store.ts)
const productOverlay = new ProductOverlay();
if (sceneLocal && q.get('showcaseDemo')) showcaseDemo(q.get('showcaseDemo')!);
else if (!sceneLocal) connectShowcase(bus, true);
// goals, stretch goals + the subathon timer (server/goals.ts → {type:'goals'}): the docked card, celebrations and the wheel
// (src/goals/goalsOverlay.ts) + the in-world board (src/goals/goalsWorld.ts). Test pages: ?goalsDemo=1 (local, no server)
// or &goalsBus=1 (read the helper like a real OBS page). A guest's page shows its host's (relayed: src/goals/goalsRelay.ts).
const goalsOverlay = new GoalsOverlay();
const goalsWorld = new GoalsWorld();
/** The countdown drawn onto room meshes (TIMER_DISPLAY nodes / scene.json timerDisplays): src/goals/timerDisplays.ts; free in rooms without one. */
const timerDisplays = new TimerDisplays();
const goalsFromBus = !sceneLocal || q.has('goalsBus');
if (sceneLocal && q.get('goalsDemo')) goalsDemo(q.get('goalsDemo')!);
else if (goalsFromBus) void api.get<unknown>('/api/goals/view').then((v) => { if (selfKey === HOST_KEY) goalsStore.set(v); }).catch(() => { /* an older version: no goals */ });
/** Background combat + raid events (src/scene/raid/*): SceneState.raid; free while off. */
const raidScene = new RaidScene();
/** Room alert reactions (scene.json `reactions`, src/scene/reactions.ts): one-shot ALERT_* clips, the alert light cue +
 *  override, smashes — from SceneState.reactions (host-stamped); free in rooms without them. */
const reactionScene = new ReactionScene(raidScene);
/** Scene graphics quality (src/stage/gfx): SceneState.gfx (obs / preview) or ?gfx=; Balanced = no-op, Classic untouched. */
const gfxPin = gsSend ? 'low' : q.get('gfx');
const gfx = new Graphics(stage, preview ? 'preview' : 'obs', parseGfxChoice(gfxPin));
SceneRuntime.levelHook = () => gfx.level;   // (placed-prop budgets per graphics level: src/scene/roomEdits.ts)
/** Avatar detail (src/avatar/lod/*): lighter levels of THIS PC's own very detailed avatar ('self' + the 'lib:' stand-ins;
 *  party guests always stay Full). The choice comes from the scene state (SceneGfxState.avatarDetail, per PC) or
 *  ?avatarDetail=; Auto's OBS pressure (detailGovernor) is the first lever when frames run late. */
const detailParam = parseAvatarDetailParam(q.get('avatarDetail'));
let detailChoice: AvatarDetailChoice = detailParam?.choice ?? avatarDetailOf(undefined);
const detailGov = new DetailGovernor();
/** Pressure only on real OBS pages: not with ?adaptive=0, not the studio preview, not on a pinned test level. */
const detailPressureOn = !preview && q.get('adaptive') !== '0' && detailParam?.pin === undefined;
const LEVER_HOLD_MS = 4000;
let lastDetailAt = -1e9, lastGfxAt = -1e9;
// (the stage layouts' performer cams go through the same post chain on High / Ultra)
queueMicrotask(() => { stageComp.post = (fill) => gfx.renderComposite(fill); });
// "Lower quality automatically" stepped an OBS page down: the studio says so in one sentence, with OK and Undo
// (src/ui/gfxNotice.ts). Test pages and the studio's own preview never announce.
if (!sceneLocal && !preview) gfx.onLower = (from, to, why, cause) => { if (cause !== 'starved') bus.send({ type: 'gfxlower', from, to, why }); };   // (a starved page announces itself: 'obsstarve' below)
/** Living harbour rooms (scene.json `town`: animated sea, boats, gulls, the ambient crowd — src/scene/town/*); free elsewhere. */
const townScene = new TownScene();
// support events → the townsfolk cheer (src/scene/town)
chatFeed.on((fresh, snap) => townScene.onSupport(fresh, snap));
setInterval(() => {
  const c = (townScene as unknown as { crowd?: { lodBias: number } | null }).crowd;
  if (c) c.lodBias = gfx.level === 'performance' ? -1 : gfx.level === 'high' || gfx.level === 'ultra' || tier === 'ultra' ? 1 : tier === 'low' ? -1 : 0;
}, 1000);
/** Space battle outside the viewport (src/scene/space/*): SceneState.space; free in rooms without SPACE_* anchors. */
const spaceScene = new SpaceScene();
/** Time of day + weather + night lights (scene.json `environment`, src/scene/environment/*); free in other rooms. */
const envScene = new EnvScene();
/** Sky traffic: ships landing / taking off, cruisers, car streams (scene.json `traffic`, src/scene/traffic/*); free elsewhere. */
const trafficScene = new TrafficScene();
/** AFK / starting-soon cinematic director + chatter names on ships (SceneState.afk, scene.json afk / shipNames — src/scene/afk/*); free while off. */
const afkScene = new AfkScene(trafficScene);
/** The living void + era shifts (scene.json `epoch` / `eras`: sky vortex, eclipse, time rifts, shards, the time crystal, hub NPCs — src/scene/epoch/*); free elsewhere. */
const epochScene = new EpochScene();
/** The kitchen (fast-food room: crew, food fights, the manager, the unrest meter, riots — src/scene/kitchen/*); free elsewhere. */
const kitchenScene = new KitchenScene();
/** Ambient background crowd (scene.json `crowd` + ACTIVITY_xx anchors: the Studio Swamp's frogs — src/scene/crowd/*); free elsewhere. */
const crowdScene = new CrowdScene();
// support events → the crowd cheers, the band speeds up, the neon sign flashes (src/scene/crowd)
chatFeed.on((fresh, snap) => crowdScene.onSupport(fresh, snap));
/** The club (scene.json `club` + CLUB_* anchors: the Studio Club's LED wall, bits, celebrations, DJ pose, entrance camera — src/scene/club/*); free elsewhere. */
const clubScene = new ClubScene(crowdScene);
chatFeed.on((fresh, snap) => clubScene.onChat(fresh as never, snap));
/** DJ decks at the DJ spot copying the DJ's controller; the host's hands play them (src/scene/djdeck/*, SceneState.djdeck). */
const deckScene = new DeckScene();
/** The chat audience (scene.json `audience` / AUDIENCE_SEAT_xx / AUDIENCE_AREA_xx seats, or names over a background crowd — src/scene/audience/*): every active chatter seated with their name, !ask questions, supporter name effects; free elsewhere. */
const audience = installAudience({ feed: chatFeed, crowd: crowdScene, live: !sceneLocal, chatState: () => shownState?.chat, test: sceneTest ? q : null });
/** Yacht life (scene.json `yacht`: crew, drinks, fireworks, flybys, fleets, skirmishes, storm lightning — src/scene/yacht/*); free elsewhere. */
const yachtScene = new YachtScene();
/** The puppet deck crew (rooms with a `crew` key; the voyage engine plugs in with crewScene.setFeed()). */
const crewScene = new CrewScene();
chatFeed.on((fresh, snap) => yachtScene.onSupport(fresh, snap));
/** Voyage (scene.json `voyage`: a walking ship - the world streams past, battles, storms, treasure stops, support overlays,
 *  src/scene/voyage/*); free elsewhere. Drives the environment's hour + weather through envScene.drive. */
const voyageScene = new VoyageScene(envScene);
/** Show sky (scene.json `showSky`: a music-reactive night sky with planets + the room's searchlights / lasers into it, in the
 *  lighting states the room lists - default Preshow; src/scene/showSky/*); free elsewhere. */
const showSkyScene = new ShowSkyScene();
showSkyScene.setPalette(() => {
  const p = (scene?.lights as unknown as { washPalette?: [THREE.Color, THREE.Color] } | undefined)?.washPalette;
  return p && p[0].r + p[0].g + p[0].b + p[1].r + p[1].g + p[1].b > 0.15 ? p : null;
});
voyageScene.showSky = showSkyScene;
/** Festival stages (scene.json `festival` + FX_<TYPE>_<GROUP>_<NN> anchors: moving heads, lasers, LED walls, pyro, the crowd,
 *  the show director - src/scene/festival/*); free elsewhere. */
const festivalScene = new FestivalScene();
SceneRuntime.earlyLights = (root, info) => festivalScene.preLights(root, info);   // (the talk set's spots exist before the room's first compile)
chatFeed.on((fresh, snap) => voyageScene.onSupport(fresh as never, snap));
/** Lounge events (scene.json `lounge`: donations + gifted subs → bar drinks / shots / bottle wall, the patio firepit + fireworks, champagne + balloons — src/scene/lounge/*); free elsewhere. */
const loungeScene = new LoungeScene();
chatFeed.on((fresh, snap) => loungeScene.onSupport(fresh, snap));
/** A space race course + station defence + a living lounge (scene.json `raceway`: the Grim Hex race deck — src/scene/space/raceway/*); free elsewhere. */
const racewayScene = new RacewayScene();
// support events → victory laps, salutes, confetti, bounties, the armada (src/scene/space/raceway)
chatFeed.on((fresh, snap) => racewayScene.onSupport(fresh, snap));
/** A talk show on the front line (scene.json `frontline`: hd_frontline — bug swarm, defenders, supports, dropships; src/scene/frontline/*); free elsewhere. */
const frontlineScene = new FrontlineScene();
// chat → hive aggression; donations / subs / raids / Kick channel-point rewards → supports
chatFeed.on((fresh, snap) => frontlineScene.onChat(fresh, snap));
/** The battle outside a warzone room (scene.json `warzone`: warzone_compound — shells, RPGs, air strikes, vehicles, flares
 *  around the raid engine's frog-vs-militia fights; src/scene/warzone/*); free elsewhere. Channel-point rewards → set pieces. */
const warzoneScene = new WarzoneScene(raidScene);
chatFeed.on((fresh, snap) => warzoneScene.onChat(fresh as never, snap));
/** "Slap!" (SceneState.modes.slap, src/scene/slap/*): the host's minion runs in and knocks a performer over; idle otherwise. */
const slapScene = new SlapScene({ page: preview ? 'preview' : urlRoom ? 'test' : 'obs' });
slapScene.chat = chatScene;

// ---------------------------------------------------------------- layout settings
let settings: OutputSettings = { scale: 1, offset: [0, 0], focus: 'bust', layout: 'row' };
const urlOverride = (s: OutputSettings): OutputSettings => ({
  ...s,
  scale: q.has('scale') ? parseFloat(q.get('scale')!) || 1 : s.scale,
  offset: [q.has('x') ? parseFloat(q.get('x')!) || 0 : s.offset[0], q.has('y') ? parseFloat(q.get('y')!) || 0 : s.offset[1]],
  focus: (q.get('focus') as OutputSettings['focus']) || s.focus,
});
// URL params shape the source at load; once the performer moves a slider in the studio, that wins
function applySettings(s: OutputSettings, fromUrl = false) { settings = gsSend ? { ...s, scale: 1, offset: [0, 0], focus: 'bust' } : fromUrl ? urlOverride(s) : s; relayout(); }   // (gsSend: always the bust shot, whatever the studio's OBS tab says)
void api.get<OutputSettings>('/api/output').then((s) => applySettings(s, true)).catch(() => applySettings(settings, true));

// ---------------------------------------------------------------- slots (you + up to 7 party guests)
/** A finished avatar build of a slot (Slot.build), shown or dropped by its LatestLoads. */
/** `staged`: measured (measureRest) and warmed off-stage before the swap (stageModel): shown with no compile gate hold. */
interface Built { rt: AvatarRuntime; fresh: THREE.Group; name: string; tv: boolean; staged?: boolean }
/** Later, when the page is idle (an outgoing model's GPU release: src/avatar/gpuDispose.ts rules, after the swap). */
const whenIdle = (f: () => void) => { const w = window as Window & { requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number }; if (w.requestIdleCallback) w.requestIdleCallback(f, { timeout: 2000 }); else setTimeout(f, 200); };
/** Model loads in frame-sized slices (src/avatar/loadSlicer.ts; ?loadSlices=0 = the old one-go build). */
const LOAD_SLICES = q.get('loadSlices') !== '0';
/** The self slot's recent load events + the studio announcements this page ignored (vtpOut.follow.log()). */
const followLog: [number, string, string][] = [];
function followTrace(ev: string, id: string) {
  const l = followLog[followLog.length - 1];
  if (l && l[1] === ev && l[2] === id && ev.startsWith('ignored')) return;
  followLog.push([Math.round(performance.now()), ev, id]);
  if (followLog.length > 40) followLog.shift();
}
class Slot {
  runtime: AvatarRuntime | null = null;
  /** Avatar space of this performer. A FRESH group per load: avatars are always built at identity, then the
   *  anchor is placed (classic layout) or handed to the scene (spot, facing, scale). */
  anchor = new THREE.Group();
  frame: TrackingFrame = emptyFrame();
  /** Studio frames → what the runtime sees at each render (sub-steps, head / bone lead, blink hold). */
  sync = new FrameSync();
  lastFrameAt = 0;
  name = '';
  /** The runtime shown came from a TV load (tvPage keeps its own slot -> runtime map of those). */
  private tvShown = false;
  /** Avatar loads, the newest request wins (src/outputFollow.ts): a switch while a load still runs starts the new one at
   *  once, and the overtaken load is dropped when it lands (it used to replace the newer avatar until the next heartbeat). */
  private readonly loads: LatestLoads<Built>;
  /** 'self' = this PC's performer, a party member id, or 'lib:<avatarId>' (preview / sceneTest stand-ins). */
  constructor(readonly id: string, public slot: number) {
    stage.anchor.add(this.anchor);
    this.loads = new LatestLoads<Built>({
      shown: () => this.runtime?.profile.id,
      // this PC's performer appears as a TV: the studio's avatar loads wait until it stops being one
      divert: (avatarId) => { if (this.id !== 'self' || !tvPage.selfTv || avatarId === TV_SELF) return false; tvPage.selfPrev = avatarId; return true; },
      build: (avatarId, stale) => this.build(avatarId, stale),
      show: (b) => this.show(b),
      drop: (b) => { whenIdle(() => b.rt.dispose()); if (b.tv) tvPage.settle(this.id, this.tvShown ? this.runtime : null); },
      fail: (avatarId, e) => { if (!isCancelled(e)) console.error('output: load failed', avatarId, e); },
      trace: id === 'self' ? followTrace : undefined,
    });
  }
  /** The avatar being loaded (the newest request), '' = none. */
  get loadingId() { return this.loads.loadingId; }

  load(avatarId: string, force = false): Promise<void> { return this.loads.load(avatarId, force); }

  private async build(avatarId: string, stale: () => boolean = () => false): Promise<Built> {
    let sealed: Awaited<ReturnType<typeof partyView.open>> | null = null;
    // the incoming model is built off-stage in slices while the current one keeps rendering, and a newer request
    // (a costume hotkey pressed again) stops it at its next step (src/avatar/loadSlicer.ts)
    const sl = LOAD_SLICES ? new LoadSlicer({ budgetMs: 6, cancelled: stale }) : null;
    try {
      // TV performers (webcam / VTube Studio on a walking TV, src/scene/tv): a TV body showing their live video, no model
      const tvi = tvPage.infoFor(this.id);
      const party = this.id !== 'self' && !this.id.startsWith('lib:') && !tvi;
      // party members: decrypted in memory from this PC's RAM vault, parsed from the buffer, then wiped
      sealed = party ? await partyView.open(this.id) : null;
      let p = normalizeProfile(sealed ? sealed.profile : tvi ? { id: avatarId, modelFile: 'tv', name: this.name } as never : await api.avatar(avatarId));
      if ((testRig || sceneLocal) && this.id === 'self' && testOverride) {
        const o = testOverride as Record<string, unknown>, merged: Record<string, unknown> = { ...p };
        for (const [k, v] of Object.entries(o)) merged[k] = v && typeof v === 'object' && !Array.isArray(v) && typeof merged[k] === 'object' && merged[k] ? { ...(merged[k] as object), ...(v as object) } : v;
        p = normalizeProfile(merged as never);
      }
      let url = sealed ? sealed.model : api.modelUrl(p);
      // ?partyLod=1 (Multiplayer → Preview): this avatar's automatic party version, exactly what parties receive
      if (!sealed && !tvi && this.id === 'self' && q.get('partyLod') === '1') {
        const st = await api.get<PartyLodStatus>(`/api/avatars/${encodeURIComponent(p.id)}/party-lod?max=${encodeURIComponent(q.get('max') ?? '')}&costume=${encodeURIComponent(q.get('costume') ?? '')}`).catch(() => null);
        if (st?.ready && st.model) {
          url = api.pathUrl(p.id, st.model);
          p.costume = st.costumeId;
          if (st.costume) p.costumes = p.costumes.map((c) => (c.id === st.costumeId ? { ...c, file: st.costume! } : c));
          document.title = `Party version · ${st.tris.toLocaleString('en-US')} triangles`;
        } else document.title = 'Party version: none needed / not made yet (showing the original)';
      }
      const fresh = new THREE.Group();
      // this PC's own avatar (+ preview / test stand-ins) gets Avatar detail; party guests never (model custody)
      const own = !tvi && !sealed && (this.id === 'self' || this.id.startsWith('lib:')) && q.get('partyLod') !== '1';
      const rt = tvi ? await tvPage.load(tvi, fresh, this.name, () => scene?.actors.get(keyOf(this)) ?? null)
        : await AvatarRuntime.load(p, url, fresh, undefined, { ...(own ? { detail: detailChoice, pin: detailParam?.pin ?? null } : {}), slicer: sl });
      // measured at identity + its programs, textures and first draws done off-stage: the swap is one plain frame
      let staged = false;
      if (sl && !tvi) {
        try {
          await sl.step();
          measureRest(rt);
          await sl.step();
          staged = await stageModel(this, fresh, sl);
        } catch (e) { whenIdle(() => rt.dispose()); throw e; }
      }
      return { rt, fresh, name: p.name, tv: !!tvi, staged };
    } finally { sealed?.wipe(); }
  }

  /** The newest build landed: swap it in. */
  private show({ rt, fresh, name, tv, staged }: Built) {
    if (!staged) measureRest(rt); // while still at identity: height, hips, face, leg rest pose (scene placement)
    // (the outgoing model leaves the scene now and lets go of its GPU memory when the page is idle)
    const out = this.runtime;
    if (out) whenIdle(() => out.dispose());
    // swap the new avatar space in where the old one was
    const old = this.anchor, parent = old.parent ?? stage.anchor;
    fresh.position.copy(old.position); fresh.quaternion.copy(old.quaternion); fresh.scale.copy(old.scale);
    old.removeFromParent();
    parent.add(fresh);
    this.anchor = fresh;
    this.runtime = rt;
    if (!staged) compileGate.arm(4000);            // (its materials link off-thread before the first frame that draws them)
    this.tvShown = tv;
    if (!this.name) this.name = name;
    relayout();
    // (every patch the new model gets — graphics preset, show lights — on the next frame, while the gate above holds)
    gfx.actorsChanged();
    (scene?.lights as unknown as { performersChanged?: () => void } | undefined)?.performersChanged?.();
  }

  dispose() { this.runtime?.dispose(); this.anchor.removeFromParent(); }
}
const self = new Slot('self', 0);
const guests = new Map<string, Slot>();
/** Stand-in performers (library avatars) for previews / ?sceneTest=…&extra=… — never in a real OBS page. */
const extras = new Map<string, Slot>();
const slots = () => [self, ...[...guests.values()].sort((a, b) => a.slot - b.slot), ...extras.values()];
/** Avatar detail controllers of this PC's own avatars on this page. */
function ownDetails(): AvatarDetail[] {
  const out: AvatarDetail[] = [];
  for (const s of slots()) if ((s.id === 'self' || s.id.startsWith('lib:')) && s.runtime instanceof AvatarRuntime && s.runtime.detail) out.push(s.runtime.detail);
  return out;
}
/** Own avatars on Auto with levels ready (and over Auto's triangle gate, also after a live change from Lighter): Avatar
 *  detail is an OBS lever on this page (pressure, 4 s lever spacing). */
function detailActive(): AvatarDetail[] { return ownDetails().filter((d) => d.autoActive); }
/** Every avatar triangle this page draws now (own avatars at their drawn level, guests and stand-ins in full). */
function pageAvatarTris(): number {
  let n = 0;
  for (const s of slots()) if (s.runtime instanceof AvatarRuntime) n += s.runtime.detail ? s.runtime.detail.drawnTris : s.runtime.info.triangles;
  return n;
}
/** Would OBS pressure `p` (0..2) take a real share off the avatar triangles this page draws (AvatarDetail pressureHelps:
 *  >= DETAIL_LEVER_MIN_SHARE)? The governor only raises the pressure, and holds the render scale back, when it does. */
const pressureWorthIt = (autos: AvatarDetail[], p: number) => pressureHelps(autos, detailThreshold('auto', p), pageAvatarTris());
/** The page's choice. Every own runtime is reconciled to it each frame (renderFrame), so a runtime whose load was already
 *  running when the choice changed (a costume reload, a guest's own pick arriving after the load started) follows too. */
function setDetailChoice(c: AvatarDetailChoice) {
  if (detailParam || c === detailChoice) return;
  detailChoice = c;
  for (const d of ownDetails()) d.setChoice(c);   // geometry levels follow at once; texture caps at the next load
}
/** ?diag=1 line: avatar detail auto · L1 (0.5 px) · 151k/552k tris · face 21k exact · tex 1.1→0.3 GB */
function detailLine(): string | null {
  const d = (self.runtime instanceof AvatarRuntime ? self.runtime.detail : null) ?? ownDetails()[0];
  if (!d) return null;
  const i = d.info(), k = (n: number) => `${Math.round(n / 1000)}k`, gb = (mb: number) => (mb / 1024).toFixed(1);
  const st = i.state === 'ready' ? `L${i.level} (${i.T} px)` : i.state;
  return `avatar detail ${AVATAR_DETAIL_NAMES[i.choice].toLowerCase()} · ${st} · ${k(i.drawnTris)}/${k(i.l0Tris)} tris · face ${k(i.faceTris)} exact`
    + (i.tex?.capped ? ` · tex ${gb(i.tex.beforeMB)}→${gb(i.tex.afterMB)} GB` : '') + (i.pressure ? ` · pressure ${i.pressure}` : '');
}

// debugging handle (read-only use)
(window as unknown as { vtpOut: unknown }).vtpOut = {
  get runtime() { return self.runtime; }, get frame() { return self.frame; }, get slots() { return slots(); }, get settings() { return settings; },
  get scene() { return scene; }, get sceneState() { return sceneState; }, debugParty: (m: PartyMember[], tvSelf?: Parameters<typeof setParty>[1]) => setParty(m, tvSelf),
  /** In-scene capture: the host's shared window as received here (and its link stats). */
  get share() { return shareRx; },
  /** Which studio this page follows (src/outputFollow.ts SourceLock: .info()) + the self slot's recent loads and the
   *  announcements it ignored (.log()): why the page did / didn't follow an avatar switch (tools/obsfollow_e2e.ts). */
  follow: { info: () => lock.info(performance.now()), log: () => followLog.map(([t, ev, id]) => `${t} ${ev} ${id}`) },
  /** Test pages only (?sceneTest / ?preview): switch rooms / Classic by hand. */
  debugScene: (s: SceneState) => { if (sceneLocal) void applyScene(sanitizeSceneState(s), selfKey); },
  /** Test pages only: the stand-in guests (library avatar ids), e.g. a guest joining mid-show (tools/perf_show.mjs). */
  /** Test pages only: the host's profile with these fields changed (e.g. { costume: 'x' }: a costume change), reloaded. */
  debugProfile: (o: Record<string, unknown> | null) => { if (!sceneLocal) return; testOverride = o; const id = self.runtime?.profile.id ?? self.loadingId; if (id) void self.load(id, true); },
  debugExtras: (ids: string[]) => { if (sceneLocal) setExtras(ids.filter((x) => /^[A-Za-z0-9_-]{1,48}$/.test(x)).map((id) => ({ key: `lib:${id}`, avatarId: id, name: id }))); },
  /** Beat clock the lights follow (test pages: .demo(128) / .pose({beat, sinceKick…})); lights() = the show's levels. */
  get perf() { return perf.snapshot; }, get sync() { return self.sync.stats; },
  beat: beatClock, lights: () => (scene?.lights as unknown as { debug?: () => unknown } | undefined)?.debug?.(),
  /** Chat props: .feed, .inject(events, totals?) (test pages), .debug() = placements / buddy state. */
  /** The page's silence guard: counts + unmuted media right now (must be 0). */
  silence: silenceReport,
  chat: { feed: chatFeed, scene: chatScene, inject: (evs: unknown[], tot?: unknown) => chatFeed.push(evs, tot), debug: () => chatScene.debug() },
  /** Product showcase: where the card is ('hidden' | 'world' | 'docked' | 'layout'). */
  showcase: () => productOverlay.where,
  /** Goals + the subathon timer: .store (.set(view) on test pages), .debug() = where the card / board are. */
  goals: { store: goalsStore, debug: () => ({ where: goalsOverlay.where, world: goalsWorld.debug(), timer: timerDisplays.debug(), rev: goalsStore.rev, view: goalsStore.view }), timerDisplays, world: goalsWorld },
  /** Raid: .scene (manual clock: .scene.manual = true; .scene.clock = ms), .debug(). */
  raid: { scene: raidScene, debug: () => raidScene.debug() },
  /** Scene graphics quality: .info(), .setChoice('high') (test pages), .auto, .npc. */
  gfx,
  /** Avatar detail: .info() (this PC's own avatars), .governor (OBS pressure), .helps(p) / .saving(p) (the pressure share
   *  rule); .force(level | null), .choose(c). */
  detail: {
    info: () => ownDetails().map((d) => d.info()),
    get governor() { return detailGov; },
    get choice() { return detailChoice; },
    /** When each lever last acted (performance.now ms): avatar-detail pressure, render scale, graphics level. */
    levers: () => ({ detail: lastDetailAt, scale: perf.lastScaleChangeAt, gfx: lastGfxAt, now: performance.now() }),
    /** Would OBS pressure `p` (0..2) take a real share off this page's avatar triangles right now? (what the governor asks) */
    helps: (p: number) => pressureWorthIt(detailActive(), p),
    /** Triangles pressure `p` would take off each own Auto avatar, and the page's avatar triangles (the share rule). */
    saving: (p: number) => ({ saved: detailActive().map((d) => d.savingAt(detailThreshold('auto', p))), pageAvatarTris: pageAvatarTris() }),
    force: (k: number | null) => { for (const d of ownDetails()) d.force(k); },
    /** Change the page's choice as a scene message would (even over ?avatarDetail=); every own runtime
     *  follows (a runtime's own setChoice alone is put back to the page's choice on the next frame). */
    choose: (c: AvatarDetailChoice) => { detailChoice = c; for (const d of ownDetails()) d.setChoice(c); },
  },
  /** Quality benchmark (~10 s; test pages / tools/perf): renders High then Medium, returns the pick (shared/graphics.ts GfxBenchResult). */
  gfxBench: (targetFps = 60) => runGfxBench(gfx, () => perf.snapshot, { targetFps, room: scene?.info.id ?? null }),
  /** Town: .scene (manual clock: .scene.manual = true; .scene.clock = s; .scene.forceWeather = 'storm'), .debug(). */
  town: { scene: townScene, debug: () => townScene.debug() },
  /** Space: .scene (manual clock: .scene.manual = true; .scene.clock = ms), .debug(). */
  space: { scene: spaceScene, debug: () => spaceScene.debug() },
  /** Environment: .scene (manual clock: .scene.manual = true; .scene.clock = epoch ms; .scene.force = {hour, weather…}), .debug(). */
  env: { scene: envScene, debug: () => envScene.debug() },
  /** Sky traffic: .scene (manual clock: .scene.manual = true; .scene.clock = s; .scene.forceNight = 0…1), .debug(). */
  traffic: { scene: trafficScene, debug: () => trafficScene.debug() },
  /** AFK director + ship names: .scene (.freeze(ms) pins the AFK / traffic / room-clip clocks on test pages; .upcoming()), .debug(). */
  afk: { scene: afkScene, debug: () => afkScene.debug() },
  /** Epoch rooms (void + eras): .scene (manual clock: .scene.manual = true; .scene.clock = s), .debug(). */
  epoch: { scene: epochScene, debug: () => epochScene.debug() },
  /** Kitchen: .scene (manual clock: .scene.manual = true; .scene.clock = ms; .scene.testEpisode('riot', at)), .debug(). */
  kitchen: { scene: kitchenScene, debug: () => kitchenScene.debug() },
  /** Ambient crowd: .scene (manual clock: .scene.manual = true; .scene.clock = ms; .scene.force = {water:'hop'}; .scene.testSupport('name')), .debug(). */
  crowd: { scene: crowdScene, debug: () => crowdScene.debug() },
  /** Alert reactions: .scene (manual clock: .scene.manual = true; .scene.clock = ms), .debug(); &reactions=host test pages: .test({tier, usd, platform, fkind, amount, user}). */
  reactions: { scene: reactionScene, debug: () => reactionScene.debug(), test: (o: Record<string, unknown>) => reactTest(o), goalsView: (v: unknown) => reactGoalsView(v) },
  /** Chat audience: .info(), .scene (manual clock: .scene.manual = true; .scene.clock = ms; .testCheer(key, usd); .testChat(key, text)), .demo.at(s) (&audienceDemo=n), .shots (the director hook), test cameras: .look([x,y,z] | null, target, fov), .shot('asker' | 'reaction' | 'wide'). */
  audience: { ...audience.hooks, look: (p: [number, number, number] | null, t?: [number, number, number], f?: number) => audience.hooks.look(scene, p, t, f), shot: (k: 'asker' | 'reaction' | 'wide') => audience.hooks.shot(scene, k) },
  /** Club: .scene (.test('tip'|'sub'|'bits'|'raid'|'big', user?, usd?, inSec?), .testBit('conga', inSec?), manual clock), .debug(). */
  club: { scene: clubScene, debug: () => clubScene.debug() },
  /** DJ decks: .info(), .partWorld(id), .take(snapshot) (test pages), .forced = {on, look, …} (test pages: a local setting). */
  djdeck: deckScene,
  /** Slap!: .debug(), test pages: .test(memberKey, seed?, delayMs?, atEpochMs?) · manual clock: .manual = true; .clock = epoch ms. */
  slap: slapScene,
  /** Yacht life: .debug(), .test('fleet' | 'fireworks' | 'flyby' | 'champagne' | 'drink' | 'support:25' | 'raid', inSec), .debugConfig(cfg | 'demo' | null), manual clock: .manual = true; .clock = epoch ms. */
  yacht: yachtScene,
  /** Voyage: .info(), .digest(), .seek('battle' | 'approach' | 'salvo' | 'hit' | 'defeat' | 'boom' | 'storm' | 'treasure' | 'stop' | 'kneel' | 'city' | 'night' | 'day' | 'fork' | 'cruise'),
   *  .test(<stamp kind> | 'support:25' | 'raid' | 'reward:<title>' | 'chat:<n>', inSec, user) (page-local test stamps; .tests copies them),
   *  .debugConfig(cfg | 'demo' | null), .crewPlan(), manual clock: .manual = true; .clock = epoch ms. */
  voyage: voyageScene,
  showSky: showSkyScene,
  /** Festival stages: .info(), .catalogue(), .dropPlan(show), .force = 0…1, .forceTier = 'low'|'medium'|'high'|'ultra', .music (.manualAt = epoch ms). */
  festival: festivalScene,
  /** Ship crew (walking-ship rooms): .info(), .debug(), .test('battle' | 'flee' | 'treasure' | 'treasure:starboard' | 'treasure:quick', inSec),
   *  .debugConfig('demo' | cfg | null), .setFeed(feed), .stopDuration(stop), .repairProgress(hitId), manual clock: .manual = true; .clock = epoch ms. */
  crew: crewScene,
  /** Lounge events: .debug(), .test('t1'…'t5' | 'money:25' | 'gift' | 'train' | 'sub' | 'raid', inSec, user?, n?), .forceNight = 0…1, manual clock: .manual = true; .clock = epoch ms. */
  lounge: loungeScene,
  /** Raceway (Grim Hex): .scene (manual clock: .scene.manual = true; .scene.clock = ms; .scene.test('armada' | 'skirmish' | 'lap' | 'salute' | 'confetti' | 'tip' | 'sub' | 'gift' | 'raid', user?, inSec?)), .debug(). */
  raceway: { scene: racewayScene, debug: () => racewayScene.debug() },
  /** Frontline (hd_frontline): .scene (manual clock: .scene.manual = true; .scene.clock = ms; .scene.test('barrage' | 'laser' | 'mech' | … | 'tip' | 'sub' | 'gift' | 'raid' | 'reward:<title>' | 'chat:<n>', user?, inSec?, usd?)), .debug(). */
  frontline: { scene: frontlineScene, debug: () => frontlineScene.debug() },
  /** Warzone (warzone_compound): .scene (.test('airstrike' | 'armor' | 'assault' | 'technical' | 'mortar' | 'heli' | 'flare' | 'sniper', inSec?, user?, amount?),
   *  manual clock: .scene.manual = true; .scene.clock = ms; .forceNight = 0…1; .forceLevel), .debug(). */
  warzone: { scene: warzoneScene, debug: () => warzoneScene.debug() },
  /** 2D environments (scene.json `flat2d`): .debug(); manual clock: .manual = true, .force = sway phase 0..1. */
  flat2d: flat2dScene,
  /** Room forms (scene.json `forms` / `bigEntrance`): .scene (.lock(zone, formId | null), .force = Map(key -> occupant fields),
   *  manual clock: .scene.clock = epoch ms), .debug(), .big() = the big entrance's jobs, .mover (manual clock: .manual / .clock s,
   *  .forceStyle = 'walk' | 'lift' | 'drop'); test pages: .loadHost(avatarId) swaps this page's own avatar. */
  forms: { scene: formsScene, debug: () => formsScene.debug(), big: () => activeBigMover?.jobsInfo() ?? null, get mover() { return activeBigMover; },
    loadHost: (id: string) => (sceneLocal && /^[A-Za-z0-9_-]{1,48}$/.test(id) ? self.load(id, true) : Promise.resolve()) },
  /** Camera QA probe (test pages only, loaded on demand — tools/cam_eval.py): `const m = await vtpOut.camEval();
   *  new m.CamEval(vtpOut.scene, vtpOut.chat.scene).measure('talk')`. */
  camEval: () => (sceneLocal ? import('./scene/camEval.ts') : Promise.reject(new Error('camEval: test pages only'))),
  /** Room-change transition layer (.status, .phase, .state). */
  get curtain() { return curtain; },
  /** Off-thread shader linking before a new room / model is drawn (compileGate): .stats. */
  get compileGate() { return compileGate; },
  /** The studio preview's link: the studio origin when it is a separate-process preview (src/scene/previewBridge.ts),
   *  connected, and the shared window's track state as received here. */
  get previewLink() { return { bridge: bridgeFrom, connected: !!link, capture: capture?.getVideoTracks()[0]?.readyState ?? null }; },
  /** Stage layouts: .info() (plan, capture rect, cams, rail, docks, cost), .dom. */
  stage: stageComp,
  /** The state the room + layout show right now (a mode transition switches it under the cover). */
  get shownState() { return shownState; },
  /** Capture cover (src/scene/capcover): .info(); test pages: .set({on, style, text}) (null = follow the state again). */
  cover: { info: () => capCover.info(), layer: sceneLocal ? capCover : null, set: (p: Parameters<typeof capCover.setLocal>[0]) => { if (sceneLocal) capCover.setLocal(p); } },
  /** Test pages only: play a transition here without changing rooms (style id, default: the current one). */
  curtainTest: (style?: string, side?: 'in' | 'out') => { if (sceneLocal) curtain.test(curtainTarget(scene?.info.id ?? null), style, side); },
  /** Test pages only: walk a member ('@host' default) out of / into the room the way the host stamps it — in a room with
   *  a LIFT_xx and entrance / exit "lift" that is the captain's lift (src/scene/arrivals/liftMover.ts). */
  arrivalTest: (kind: 'enter' | 'exit', key = HOST_KEY, lead = 0.15) => {
    if (!sceneLocal || !scene) return;
    const s = structuredClone(sceneState);
    const spot = s.spots[key] ?? 0;
    const now = ((scene.mover as unknown as { now?: () => number }).now?.() ?? Date.now() / 1000) * 1000;
    if (kind === 'exit') { s.present[key] = false; s.moves = { ...s.moves, [key]: { from: spot, to: -1, at: now + lead * 1000 } }; }
    else { delete s.present[key]; s.moves = { ...s.moves, [key]: { from: -1, to: spot, at: now + lead * 1000 } }; }
    void applyScene(sanitizeSceneState(s), selfKey);
  },
  /** Cryo pods v2 (src/scene/space/spaceMover.ts): who is frozen in which pod, what each pod shows, the jobs. */
  cryo: () => (scene?.mover as unknown as { cryoDebug?: () => unknown } | undefined)?.cryoDebug?.() ?? null,
  /** The lift mover's plan (lifts, jobs, what each platform shows), when the room has one. */
  lift: () => (scene?.mover as unknown as { debug?: () => unknown } | undefined)?.debug?.() ?? null,
  /** Test pages only: the studio preview's pause / fps controls on this page (what PreviewGate drives on ?preview=1). */
  previewPage: sceneLocal ? { setActive: (on: boolean, note?: string | null) => previewActive(on, note ?? null), setFps: (fps: number | null) => { previewCap = typeof fps === 'number' && fps > 0 ? fps : null; }, view: window,
    /** A/B: true = the first version of the pause (no idle logic frames / paused reports; walks don't keep it running). */
    setLegacy: (on: boolean) => { previewLegacy = !!on; }, busy: () => previewBusy(performance.now()),
    /** A/B: the idle logic frames' step (null = one preview frame, the shipped choice). */
    setIdleStep: (s: number | null) => { previewIdleStepTest = typeof s === 'number' && s > 0 ? s : null; } } : null,
};

// test rig (&test=1&avatar=<id>): synthetic frames + an unsaved profile override, see `testRig`
if (testRig) (window as unknown as { vtpOut: Record<string, unknown> }).vtpOut.test = {
  /** Drive the performer: a partial TrackingFrame (face channels, gaze [yaw, pitch] radians, head…); tracked. */
  frame: (f: Partial<TrackingFrame>) => { testFrame = { ...emptyFrame(), tracked: true, ...f, mouth: { ...emptyFrame().mouth, ...f.mouth } }; },
  /** Reload the avatar with an in-memory override merged over its profile (per top-level key); null = none. */
  profile: async (o: Record<string, unknown> | null) => { testOverride = o; if (pinned) await self.load(pinned, true); },
  get runtime() { return self.runtime; },
  get stage() { return stage; },
};

// test pages: &cover=<style>[&coverText=…] starts covered (vtpOut.cover.set({on:false}) animates it away)
if (sceneLocal && q.get('cover')) capCover.setLocal({ on: true, style: q.get('cover') ?? undefined, text: q.get('coverText') ?? '' });

/** Place every avatar side by side (row, or 2 rows for 5+ in grid mode) and frame them all. */
function relayout() {
  if (scene) { scene.syncActors(actorSpecs()); return; }
  if (sceneLoading) return;
  const all = slots().filter((s) => s.runtime);
  if (!all.length) return;
  // spacing from the widest avatar
  let w = 0.6;
  for (const s of all) { s.anchor.position.set(0, 0, 0); s.anchor.updateMatrixWorld(true); w = Math.max(w, s.runtime!.bounds().getSize(new THREE.Vector3()).x); }
  const gap = w * 1.12;
  const n = all.length;
  const rows = settings.layout === 'grid' && n > 4 ? 2 : 1;
  const perRow = Math.ceil(n / rows);
  all.forEach((s, i) => {
    const r = Math.floor(i / perRow), c = i % perRow, inRow = r === rows - 1 ? n - perRow * r : perRow;
    s.anchor.position.set((c - (inRow - 1) / 2) * gap, 0, -r * gap * 0.9);
    s.anchor.updateMatrixWorld(true);
  });
  frameAll(all);
}

function frameAll(all: Slot[]) {
  const box = new THREE.Box3();
  for (const s of all) box.union(s.runtime!.bounds());
  // (a 2D card alone: its own shot, the bust's cut edge out of view unless zoomed out / shifted up; else it fades)
  const one = all.length === 1 && stage.frame(box, settings.focus, all[0].runtime!.faceInfo(), all[0].runtime!.cardBox());
  for (const s of all) { const fl = s.runtime!.flat; if (fl) fl.cutHidden = one && settings.scale >= 0.999 && Math.abs(settings.offset[1]) < 1e-3; }
  if (all.length !== 1) {
    // several performers: frame the union, wide enough for everyone
    const faces = all.map((s) => s.runtime!.faceInfo()).filter((f): f is NonNullable<typeof f> => !!f);
    const face = faces.length ? { center: faces.reduce((a, f) => a.add(f.center), new THREE.Vector3()).multiplyScalar(1 / faces.length), size: Math.max(...faces.map((f) => f.size)) } : undefined;
    stage.frame(box, settings.focus, face);
    const size = box.getSize(new THREE.Vector3()), center = box.getCenter(new THREE.Vector3());
    const cam = stage.camera;
    const hfov = 2 * Math.atan(Math.tan(THREE.MathUtils.degToRad(cam.fov) / 2) * cam.aspect);
    const need = (size.x * 0.58) / Math.tan(hfov / 2) + size.z * 0.5;
    const dz = cam.position.z - center.z;
    if (need > dz) cam.position.z = center.z + need;
    cam.position.x = center.x;
    cam.lookAt(center.x, cam.position.y - (face ? face.size * 0.05 : 0), center.z);
    cam.far = Math.max(cam.far, need * 20);
  }
  // size + position: zoom around the centre, then shift the view (fractions of the frame)
  const cam = stage.camera;
  cam.zoom = settings.scale;
  const W = canvas.clientWidth || 1920, H = canvas.clientHeight || 1080;
  if (settings.offset[0] || settings.offset[1]) cam.setViewOffset(W, H, -settings.offset[0] * W, settings.offset[1] * H, W, H);
  else cam.clearViewOffset();
  cam.updateProjectionMatrix();
}
window.addEventListener('resize', () => relayout());
// (a 2D avatar's art changed mid-stream: an outfit / its sliders — the classic camera eases to the new framing)
window.addEventListener(FLAT_CONTENT_EVENT, () => { const was = stage.cameraState(); relayout(); if (!scene) stage.blendFrom(was); });

// ---------------------------------------------------------------- 3D scene
let sceneState: SceneState = defaultSceneState();
/** What the room + stage layout show (= sceneState, except while a mode transition is covering the switch). */
let shownState: SceneState = sceneState;
/** A mode change covered by the transition curtain (Gaming <-> ...): the state to show once the cover is up. */
let modeCover: { pending: SceneState } | null = null;
/** Member key of this PC's performer ('@host' on the host / solo, the party id on a guest's PC). */
let selfKey = HOST_KEY;
let scene: SceneRuntime | null = null;
let sceneLoading = false;
/** Shader programs link in the driver's own threads (KHR_parallel_shader_compile): for a few seconds after a room attaches
 *  or a performer's model arrives, a frame whose programs are still linking is not drawn (the last picture, or the
 *  transition's cover, stays up; the room's logic keeps running; at most 4 s in a row). Drawing at once linked every new
 *  program synchronously on this thread (getProgramInfoLog in the first draw): 0.3-1.4 s in one task, measured — in the
 *  studio's room preview that is the face tracker's thread. renderer.compile() also builds the programs that engines'
 *  first updates need (lights they add change every lit program). Kill switch: ?asyncCompile=0. */
const compileGate = {
  on: q.get('asyncCompile') !== '0',
  until: 0, heldSince: 0, compiledAt: 0, clean: 0,
  /** The studio's room preview shares the graphics card with the face tracker's model: its textures go up a couple per
   *  frame before the first frame that draws them (one 300 MB burst kept the GPU busy and the face model waiting behind
   *  it, ~80 ms at a time — measured). OBS pages and test pages upload as before (their room changes are covered). */
  gentle: preview, uploads: null as THREE.Texture[] | null, shrinking: 0,
  /** Gentle pages: one warm-up draw per frame of every new (program x vertex layout), 1 px in the corner, before the first
   *  real frame. Direct3D (ANGLE) builds a draw-time variant of a program for each vertex layout it meets, synchronously
   *  in the graphics card's command queue (25-90 ms each, measured): one per frame instead of ~20 in the first frame. */
  warm: null as THREE.Object3D[] | null, warmCam: new THREE.PerspectiveCamera(), warmSeen: new Set<string>(),
  /** Frames not drawn / holds cut at the cap / programs still linking + textures left at the last check (vtpOut.compileGate). */
  stats: { held: 0, capped: 0, pending: 0, arms: 0, uploads: 0, warmed: 0, textures: 0, armedAt: 0, readyMs: 0 } as { held: number; capped: number; pending: number; arms: number; uploads: number; warmed?: number; textures: number; armedAt: number; readyMs: number },
  arm(ms: number) { if (this.on) { this.until = Math.max(this.until, performance.now() + (this.gentle ? Math.max(ms, 15000) : ms)); this.stats.arms++; this.stats.armedAt = performance.now(); this.uploads = null; this.warm = null; } },
  /** Drawables whose (program x vertex layout) has not been drawn yet. */
  warmList(): THREE.Object3D[] {
    const r = stage.renderer, out: THREE.Object3D[] = [];
    const vis = (o: THREE.Object3D) => { for (let p: THREE.Object3D | null = o; p; p = p.parent) if (!p.visible) return false; return true; };
    stage.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) || !m.material || !m.geometry || !vis(o)) return;
      const attrs = Object.entries(m.geometry.attributes).map(([k, a]) => `${k}:${a.itemSize}:${(a as THREE.BufferAttribute).array?.constructor?.name}:${a.normalized ? 1 : 0}`).sort().join(',');
      const progs = (Array.isArray(m.material) ? m.material : [m.material]).map((x) => (r.properties.get(x) as { currentProgram?: { id: number } }).currentProgram?.id ?? `m${x.uuid}`).join('+');
      const key = `${progs}|${attrs}|${!!m.geometry.index}|${(o as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0}|${(o as THREE.InstancedMesh).isInstancedMesh ? 1 : 0}`;
      if (this.warmSeen.has(key)) return;
      this.warmSeen.add(key);
      out.push(o);
    });
    return out;
  },
  /** Draw `o` alone into the canvas's corner pixel (its own layer; every light joins that layer for the draw so the
   *  program is the very one the frame will use). */
  warmOne(o: THREE.Object3D) { this.warmMany([o], null); },
  /** The same for several objects in one draw call list, into the canvas (`target` null: its corner pixel, cleared again
   *  when `clear`) or a render target (the post pipeline's programs: gfx.keeper.target). */
  warmMany(objs: THREE.Object3D[], target: THREE.WebGLRenderTarget | null, clear = false) {
    const r = stage.renderer, sc = stage.scene, L = 31;
    const lights: [THREE.Object3D, number][] = [];
    sc.traverse((x) => { if ((x as THREE.Light).isLight) { lights.push([x, x.layers.mask]); x.layers.enable(L); } });
    const back = objs.map((o) => [o, o.layers.mask, o.frustumCulled] as const);
    for (const o of objs) { o.layers.enable(L); o.frustumCulled = false; }
    this.warmCam.copy(stage.camera); this.warmCam.layers.set(L);
    const prev = r.getRenderTarget();
    const vp = r.getViewport(new THREE.Vector4()), sci = r.getScissor(new THREE.Vector4()), st = r.getScissorTest();
    const ac = r.autoClear;
    try {
      r.setRenderTarget(target);
      r.setViewport(0, 0, 1, 1); r.setScissor(0, 0, 1, 1); r.setScissorTest(true);
      r.autoClear = false;
      r.render(sc, this.warmCam);
      if (clear) r.clear(true, true, true);
    } catch { /* optional */ } finally {
      r.autoClear = ac;
      r.setRenderTarget(prev);
      r.setViewport(vp); r.setScissor(sci); r.setScissorTest(st);
      for (const [o, m, fc] of back) { o.layers.mask = m; o.frustumCulled = fc; }
      for (const [x, m] of lights) x.layers.mask = m;
    }
  },
  /** OBS pages with a post pipeline (High / Ultra): what the performer cams (canvas) have not drawn yet, a couple per
   *  frame before the frame (src/output.ts renderFrame) — their first draw built a draw-time variant on the graphics
   *  card in the middle of a mode switch (50-550 ms frames, measured: tools/perf_show.mjs). */
  canvasWarm: [] as THREE.Object3D[],
  /** Incoming models staged off-stage (stageModel): textures up, then each drawable's first draw, before the swap. */
  staged: [] as { draws: [THREE.Object3D, THREE.WebGLRenderTarget | null][]; tex: THREE.Texture[]; stale: () => boolean; done: () => void }[],
  /** (program x vertex layout) pairs already drawn once per target: a costume change re-uses most of the body's */
  drawnSeen: new Set<string>(),
  stageWarm(root: THREE.Object3D, stale: () => boolean): Promise<void> {
    const draws: [THREE.Object3D, THREE.WebGLRenderTarget | null][] = [], tex = new Set<THREE.Texture>();
    const r = stage.renderer, twin = gfx.keeper.twin ? gfx.keeper.target : null;
    root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!(m.isMesh || (o as THREE.Points).isPoints || (o as THREE.Line).isLine) || !m.material || !m.geometry) return;
      const mats = Array.isArray(m.material) ? m.material : [m.material];
      for (const mat of mats) for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if (v instanceof THREE.Texture && !(v instanceof THREE.VideoTexture) && v.image && (r.properties.get(v) as { __webglInit?: boolean }).__webglInit !== true) tex.add(v);
      }
      // (its programs for both targets x its vertex layout; a geometry with morph targets builds its own morph texture
      // on its first draw: always drawn)
      const g = m.geometry;
      const progs = mats.map((x) => [...((r.properties.get(x) as { programs?: Map<string, { id: number }> }).programs?.values() ?? [])].map((p) => p.id).sort().join('.')).join('+');
      const layout = Object.entries(g.attributes).map(([k, a]) => `${k}:${a.itemSize}:${(a as THREE.BufferAttribute).array?.constructor?.name}:${a.normalized ? 1 : 0}`).sort().join(',');
      const sig = `${progs}|${layout}|${g.index ? 1 : 0}|${(o as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0}|${(o as THREE.InstancedMesh).isInstancedMesh ? 1 : 0}${Object.keys(g.morphAttributes).length ? `|${g.uuid}` : ''}`;
      if (this.drawnSeen.has(sig)) return;
      this.drawnSeen.add(sig);
      if (twin) draws.push([o, twin]);
      draws.push([o, null]);
    });
    return new Promise((done) => this.staged.push({ draws: draws.reverse(), tex: [...tex], stale, done }));
  },
  /** Before a drawn frame: the staged model's next texture / first draws, a few ms of them. */
  warmStaged() {
    const s = this.staged[0];
    if (!s) return;
    if (s.stale()) { this.staged.shift(); s.done(); return; }
    const r = stage.renderer;
    // (one texture upload per frame: a big one can take a while on its own)
    if (s.tex.length) { try { r.initTexture(s.tex.pop()!); } catch { /* skip */ } }
    else {
      // (one first draw per frame, one target: the graphics card builds its draw-time variant meanwhile, ~10-20 ms of
      // its own time, without this thread waiting)
      const d = s.draws.pop();
      if (d) { this.warmMany([d[0]], d[1], !d[1]); this.stats.warmed = (this.stats.warmed ?? 0) + 1; }
    }
    if (!s.tex.length && !s.draws.length) { this.staged.shift(); s.done(); }
  },
  warmCanvas() {
    this.warmStaged();
    if (!this.canvasWarm.length) return;
    if (!gfx.keeper.twin) { this.canvasWarm = []; return; }
    const objs: THREE.Object3D[] = [];
    while (objs.length < 2 && this.canvasWarm.length) { const o = this.canvasWarm.pop()!; if (o.parent) objs.push(o); }
    if (objs.length) { this.warmMany(objs, null, true); this.stats.warmed = (this.stats.warmed ?? 0) + objs.length; }
  },
  /** Textures on the scene's materials that are not on the graphics card yet. */
  pendingTextures(): THREE.Texture[] {
    const r = stage.renderer, out: THREE.Texture[] = [], seen = new Set<THREE.Texture>();
    stage.scene.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | THREE.Material[] | undefined;
      if (!m) return;
      for (const mat of Array.isArray(m) ? m : [m]) for (const v of Object.values(mat as unknown as Record<string, unknown>)) {
        if (!(v instanceof THREE.Texture) || seen.has(v) || v instanceof THREE.VideoTexture || !v.image) continue;
        seen.add(v);
        if ((r.properties.get(v) as { __webglInit?: boolean }).__webglInit !== true) out.push(v);
      }
    });
    return out;
  },
  /** true = a program this frame needs is still linking: skip drawing it. */
  hold(): boolean {
    const now = performance.now();
    if (!this.until) return false;
    if (now > this.until) { this.until = 0; this.heldSince = 0; return false; }
    const r = stage.renderer;
    if (this.gentle) {
      if (!stage.envReady) { if (!this.heldSince) this.heldSince = now; this.stats.held++; return true; }   // (Stage asyncEnv)
      if (this.shrinking > 0) { if (!this.heldSince) this.heldSince = now; this.stats.held++; return true; }   // (capPreviewTextures still working)
      if (!this.uploads) floatSkinIndices(stage.scene);
      if (!this.uploads) { this.uploads = this.pendingTextures(); this.stats.textures += this.uploads.length; }
      const t0 = performance.now();
      for (let n = 0; this.uploads.length && n < 1 && performance.now() - t0 < 4; n++) { try { r.initTexture(this.uploads.pop()!); } catch { /* skip */ } }
      this.stats.uploads = this.uploads.length;
      if (this.uploads.length) {
        if (!this.heldSince) this.heldSince = now;
        if (now - this.heldSince > 12000) { this.uploads = []; this.heldSince = now; this.stats.capped++; return false; }
        this.stats.held++;
        return true;
      }
    }
    // (renderer.compile walks every material: a few ms in a big room — at most 4 times a second)
    if (now - this.compiledAt > 250) { this.compiledAt = now; try { r.compile(stage.scene, stage.camera); } catch { return false; } }
    // OBS / test pages: the room's textures go up a few ms of them per held frame (the programs link meanwhile) instead of
    // all in the first drawn frame: one burst of big uploads kept the card busy for 100+ ms. Every pixel stays (no size
    // cap); the gate's own time limit (arm) ends the staggering if a room has more than it can finish.
    if (!this.gentle) {
      if (!this.uploads) { this.uploads = this.pendingTextures(); this.stats.textures += this.uploads.length; }
      const t0 = performance.now();
      while (this.uploads.length && performance.now() - t0 < 4) { try { r.initTexture(this.uploads.pop()!); } catch { /* skip */ } }
      this.stats.uploads = this.uploads.length;
      if (this.uploads.length) { this.stats.held++; return true; }
    }
    // every program the renderer holds (a material shared by different objects has one variant per kind of object:
    // skinned, instanced, fog… — the material only remembers the last one)
    let pending = 0;
    for (const pr of (r.info.programs ?? []) as unknown as { isReady(): boolean }[]) if (!pr.isReady()) pending++;
    this.stats.pending = pending;
    if (!pending && this.gentle && (!this.heldSince || now - this.heldSince < 12000)) {
      // (every program linked: warm their draw-time variants, one object per frame)
      this.warm ??= this.warmList();
      const o = this.warm.pop();
      if (o) { this.warmOne(o); if (!this.heldSince) this.heldSince = now; this.stats.held++; this.stats.warmed = (this.stats.warmed ?? 0) + 1; return true; }
    }
    // OBS pages with a post pipeline: every program linked — their draw-time variants for the post target now, while the
    // last picture stays up (a new room / performer's first frames stalled on them, measured), a few ms of draws per held
    // frame; the canvas ones (performer cams) follow a couple per drawn frame (warmCanvas)
    if (!pending && !this.gentle && gfx.keeper.twin && (!this.heldSince || now - this.heldSince < 3000)) {
      if (!this.warm) { this.warm = this.warmList(); this.canvasWarm.push(...this.warm); }
      const t0 = performance.now();
      // (two at a time: a first draw waits for the card to build its variant, ~10-25 ms each — measured)
      while (this.warm.length && performance.now() - t0 < 6) { const b = this.warm.splice(-2); this.warmMany(b, gfx.keeper.target); this.stats.warmed = (this.stats.warmed ?? 0) + b.length; }
      if (this.warm.length) { if (!this.heldSince) this.heldSince = now; this.stats.held++; return true; }
    }
    if (!pending) { if (this.heldSince) this.stats.readyMs = Math.round(now - this.stats.armedAt); this.heldSince = 0; if (now - this.compiledAt < 1) this.clean++; if (this.clean >= 2) { this.until = 0; this.clean = 0; } return false; }
    this.clean = 0;
    if (!this.heldSince) this.heldSince = now;
    if (now - this.heldSince > 4000) { this.heldSince = 0; this.until = 0; this.stats.capped++; return false; }
    this.stats.held++;
    return true;
  },
};
let skinSweepAt = 0;
let sceneSeq = 0;
let sceneError = '';
let sceneList: SceneInfo[] | null = null;
let capture: MediaStream | null = null;
/** In-scene capture: OBS pages (not the studio's own preview, which gets the stream directly) receive the host studio's
 *  shared window over a local WebRTC link (src/scene/screenShare.ts). */
let shareRx: ScreenShareReceiver | null = null;
let pendingSceneId: string | null = null;
let busSceneSeen = false;
/** OBS automation can warp a passthrough capture onto an angled screen (corner-pin): GET /api/obs/hole. */
let passPin = false;
/** OBS automation places the capture under the hole (GET /api/obs/hole `enabled`): Auto may then use the exact native
 *  passthrough instead of the in-room feed (src/scene/screenFeed.ts nativePassFor). */
let obsAuto = false;
/** The mode each hole reporter's hole opened in (its close is sent with it — server/obs.ts hole()). */
const holeModes = { stage: 'react', room: 'react' };
/** Every report also says what this page shows now (v3 `shows`): on a party guest's PC that is the HOST's room, which
 *  that PC's helper never saw (its studio relays it here over the bus, it never saves it) — the helper acts on this
 *  instead of its own saved state (it used to drop every React open as "late" there, and put a closing capture back at
 *  the guest's own Gaming place in the middle of the host's React). */
const postHole = (body: Record<string, unknown>): Promise<unknown> => fetch('/api/obs/hole', { method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ ...body, v: 3, shows: { mode: shownState.mode, room: !!shownState.sceneId, hole: !!shownState.stage?.hole, party: selfKey !== HOST_KEY } }) })
  .then((r) => (r.ok ? r.json() : null)).catch(() => null);
/** The helper answered that OBS automation will NOT show a capture for this page's open React hole (shared/obsHole.ts):
 *  that shot draws the screen in the room instead of an empty see-through hole (SceneRuntime.refusePass). */
function heardRefusal(rt: SceneRuntime, j: unknown) {
  const why = refusalFromAnswer(j);
  // (the room's React screen, or a React Full / Medium capture rect: the stage layout's hole)
  if (why && scene === rt && (rt.composite ? stageComp.info().open : rt.holeState.open)) rt.refusePass(why);
}
/** Studio preview link (output.html?preview=1). */
let link: ReturnType<PreviewHost['connect']> | null = null;
/** The studio's shared preview loaded cross-site (its own process, src/scene/previewBridge.ts): the studio's origin, and
 *  what this page needs from the studio's storage (this origin has its own). */
const bridgeFrom = preview ? bridgeOrigin(q) : null;
let bridgeEnv: PreviewEnv = {};
let bridgeEnvReady: () => void = () => {};
const bridgeEnvWait = new Promise<void>((r) => { bridgeEnvReady = r; });
/** A studio setting this page reads: from the studio over the bridge, else this origin's storage (the studio's own). */
function studioGet(k: 'vtp.scene.obsW' | 'vtp.scene.obsH' | 'vtp.lastAvatar'): string | null {
  if (bridgeFrom) return (k === 'vtp.scene.obsW' ? bridgeEnv.obsW : k === 'vtp.scene.obsH' ? bridgeEnv.obsH : bridgeEnv.lastAvatar) ?? null;
  try { return localStorage.getItem(k); } catch { return null; }
}
let fpsNow = 0;
/** Studio preview pause (src/scene/previewLink.ts PreviewGate): nobody can see this preview → no frames (the last
 *  picture stays: preview pages keep their drawing buffer). `previewCap` = the studio's fps cap while tracking. */
let previewOn = true;
let previewCap: number | null = null;
/** Paused previews still run frames while something the studio waits for is in flight (see previewBusy).
 *  `previewWakeReason` = the end set by the wake reasons themselves (the camera-glide extension is capped from it). */
let previewWakeUntil = 0;
let previewWakeReason = 0;
function previewWakeTo(t: number) { previewWakeUntil = Math.max(previewWakeUntil, t); previewWakeReason = Math.max(previewWakeReason, t); }
let previewWasBusy = false;
let previewPaused = false;
/** Paused and idle: a LOGIC-ONLY frame (engines, camera, stage analysis — nothing drawn, no performer updates) every
 *  PREVIEW_IDLE_MS, and a report to the studio about once a second. The studio's room stats (time of day, weather,
 *  raid / kitchen / space status) and the React re-seat hints come from this page; they must not freeze while the
 *  preview is scrolled away — which is exactly when the host scrolls down to read them. Each idle frame advances the
 *  room by one ordinary preview frame (1 / its fps), not by the time that passed: the rooms' schedules run on the wall
 *  clock anyway, and the engines' frame-time governors (raid, space) must not read the gaps as a slow page and lower
 *  their own quality for when the preview is seen again. */
const PREVIEW_IDLE_MS = 500;
let previewIdleAt = 0;
let previewReportAt = 0;
/** Test pages (A/B only): the first version of the pause — no idle logic frames, no reports while paused, walks and
 *  camera glides don't keep it running. */
let previewLegacy = false;
/** Test pages (A/B only): another step for the idle logic frames (null = one preview frame, see above). */
let previewIdleStepTest: number | null = null;
/** The render loop's scheduling (src/scene/previewLink.ts PreviewLoop): requestAnimationFrame, or while paused a look
 *  10× a second; kickLoop resumes a waiting loop at once (and restarts one with nothing queued — never a second loop). */
const renderLoop = new PreviewLoop((ts) => loop(ts));
function kickLoop() { renderLoop.kick(); }
let previewNoteEl: HTMLDivElement | null = null;
function previewActive(on: boolean, note: string | null) {
  previewOn = on;
  if (on) kickLoop();
  if (note && !previewNoteEl) {
    previewNoteEl = document.createElement('div');
    previewNoteEl.style.cssText = 'position:fixed;left:8px;bottom:8px;z-index:20;padding:3px 9px;border-radius:7px;background:rgba(0,0,0,.66);color:#fff;font:600 12px/1.4 system-ui,sans-serif;pointer-events:none';
    document.body.append(previewNoteEl);
  }
  if (previewNoteEl) { previewNoteEl.textContent = note ?? ''; previewNoteEl.style.display = note && !on ? '' : 'none'; }
}
/** Scene-tab light preset preview (preview pages only), re-applied when a room (re)loads. */
let pendingLook: unknown = null;
/** Room-change transition (src/scene/transition/curtain.ts): covers the frame before a room is torn down. */
// live-tabs BRB: over everything on this page (the room, docks, the capture), under nothing — viewers see black + the card
const brbOverlay = new BrbOverlay(document.body, { fixed: true, z: 2147483000 });
const curtain = new Curtain({ renderer: stage.renderer, scene: stage.scene, camera: () => stage.camera, page: bus.id,
  busy: () => slots().some((s) => !!s.loadingId), targetFps: parseFloat(q.get('fps') || '60') || 60 });
// OBS pages tell the studio how the transition is going (Scene tab → Transitions status); the preview reports directly
curtain.onStatus = (st) => { if (!sceneLocal) bus.send({ type: 'curtain', status: st }); report(); };
/** A switch whose cover is still animating in (the old room is still up): its target. */
let covering: { seq: number; id: string | null } | null = null;
let firstScene = true;
function curtainTarget(id: string | null) {
  const info = id ? sceneList?.find((x) => x.id === id) ?? null : null;
  return { id, name: info?.name ?? id ?? '', thumb: info?.thumb ?? null };
}
/** A mode change the host numbered as a transition (curtain seq bumped) into / out of a mode that wants one. */
function wantsModeCurtain(a: SceneState, b: SceneState) {
  if (a.mode === b.mode || !(stageModeDef(a.mode)?.curtain || stageModeDef(b.mode)?.curtain)) return false;
  if ((b.curtain?.seq ?? 0) <= (a.curtain?.seq ?? 0)) return false;
  return resolveCurtainStyle({ ...DEFAULT_CURTAIN, ...b.curtain }, b.curtain?.seq ?? 0) !== null;
}
async function coverMode(s: SceneState) {
  modeCover = { pending: s };
  const def = stageModeDef(s.mode);
  const t = curtainTarget(scene?.info.id ?? null);
  await curtain.cover({ ...t, name: def ? `${def.label} · ${t.name}` : t.name }, s.curtain?.seq ?? 0);
  const st = modeCover?.pending ?? s;
  modeCover = null;
  // (a room change took over meanwhile: its own load reveals)
  if (!scene || sceneLoading || covering || st.sceneId !== scene.info.id) return;
  shownState = st;
  scene.setState(stageComp.runtimeState(st));
  scene.syncActors(actorSpecs());
  report();
  curtain.loadDone(true);
}

const keyOf = (s: Slot) => (s.id === 'self' ? selfKey : s.id === sceneState.hostId ? HOST_KEY : s.id);

/** The layer an incoming model sits on while staged: no camera of the page draws it. */
const STAGING_LAYER = 29;
/**
 * An incoming model (a costume / avatar change, a guest joining), built off-stage: it gets the patches it would get once
 * shown (graphics preset, one-pass sheets, show lights), joins the scene on a layer no camera draws, its programs are
 * compiled one object at a time and linked off-thread, its textures uploaded and every drawable drawn once into a
 * pixel, a few ms per frame (compileGate.warmStaged) — while the current model keeps rendering. Then it leaves the scene
 * again; the swap (Slot.show) is one ordinary frame. false = not staged (the compile gate is off: ?asyncCompile=0, or
 * the page draws in software).
 */
// Software 3D (SwiftShader / llvmpipe: src/stage/gfx/softwareGl.ts): no graphics card builds draw-time variants or
// uploads in the background, so the one-texture / one-draw-per-frame warm-up only spreads the same processor work over
// many slow frames: an avatar switch on such an OBS page took 4-7 s instead of 0.5 s (tools/obsfollow_e2e.ts). There the
// model is shown the beta.11 way (compile gate held while it links).
let softStage: boolean | null = null;
function softwareStage(): boolean {
  if (softStage !== null) return softStage;
  try {
    const gl = stage.renderer.getContext();
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    softStage = isSoftwareRenderer(String((ext && gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) || gl.getParameter(gl.RENDERER) || ''));
  } catch { softStage = false; }
  return softStage;
}
async function stageModel(slot: Slot, fresh: THREE.Group, sl: LoadSlicer): Promise<boolean> {
  if (!compileGate.on || softwareStage()) return false;
  gfx.prepareModel(fresh);
  (scene?.lights as unknown as { preparePerformer?: (root: THREE.Object3D, mount: THREE.Object3D | null) => void } | undefined)
    ?.preparePerformer?.(fresh, scene?.actors.get(keyOf(slot))?.mount ?? null);
  await sl.step();
  const masks: [THREE.Object3D, number][] = [];
  fresh.traverse((o) => { masks.push([o, o.layers.mask]); o.layers.set(STAGING_LAYER); });
  stage.scene.add(fresh);
  const r = stage.renderer;
  try {
    fresh.updateWorldMatrix(true, true);
    const objs: THREE.Object3D[] = [];
    fresh.traverse((o) => { if ((o as THREE.Mesh).material) objs.push(o); });
    for (const o of objs) { r.compile(o, stage.camera, stage.scene); await sl.step(); }
    // (linked off this thread: KHR_parallel_shader_compile — wait for it without asking)
    for (let k = 0; k < 600; k++) {
      let pending = 0;
      for (const p of (r.info.programs ?? []) as unknown as { isReady(): boolean }[]) if (!p.isReady()) pending++;
      if (!pending) break;
      await new Promise((res) => setTimeout(res, 16));
      sl.check();
    }
    // each new program's first use (its link log + uniform table: a round trip to the graphics process) now, one at a
    // time, before any warm-up draw is queued — a first use behind those draws waited for them (20-30 ms, measured)
    for (const p of [...(r.info.programs ?? [])] as unknown as { getUniforms(): unknown }[]) { p.getUniforms(); await sl.step(); }
    await compileGate.stageWarm(fresh, () => { try { sl.check(); return false; } catch { return true; } });
    sl.check();
  } finally {
    stage.scene.remove(fresh);
    for (const [o, m] of masks) o.layers.mask = m;
  }
  return true;
}
/** TTRPG table (src/ttrpg/scene): map, minis, dice, the GM, captions + the table's auto-director; idle unless a session runs. */
// (not on the guest browser source's sender page: installTtrpg keeps its OWN requestAnimationFrame loop running for the life of the page, which
//  alone cost an idle sender 7 to 13 percent of a core (AC15) with no room, no table and nothing drawn)
if (!gsSend) installTtrpg({ bus, testPage: sceneLocal, performers: () => slots().map((s) => ({ key: keyOf(s), frame: s.frame, at: s.lastFrameAt })) });
function actorSpecs(): ActorSpec[] {
  return slots().map((s) => ({ key: keyOf(s), name: s.name || s.id, anchor: s.anchor, runtime: s.runtime }));
}

async function sceneInfo(id: string): Promise<SceneInfo | null> {
  if (!sceneList) sceneList = await api.get<SceneInfo[]>('/api/scenes').catch(() => null);
  let info = sceneList?.find((s) => s.id === id) ?? null;
  if (!info) { sceneList = await api.get<SceneInfo[]>('/api/scenes').catch(() => sceneList); info = sceneList?.find((s) => s.id === id) ?? null; }
  return info;
}

function applyScene(s: SceneState, self: string) {
  return applySceneInner(s, self).catch((e) => { console.error('output: scene switch failed', e); sceneLoading = false; });
}
async function applySceneInner(s: SceneState, self: string) {
  const prevId = scene?.info.id ?? null;
  const wasLoading = sceneLoading;
  const boot = firstScene;
  firstScene = false;
  sceneState = s;
  if (self !== selfKey && self !== HOST_KEY) goalsStore.clear();   // a guest's page: its host's goals arrive over the party link
  selfKey = self;
  // (?autoLower=0 pins this page's preset: benchmarks / an OBS source that must never step down)
  gfx.setState(q.get('autoLower') === '0' ? { ...(s.gfx ?? DEFAULT_GFX), autoLower: false } : s.gfx);
  setDetailChoice(avatarDetailOf(s.gfx?.avatarDetail));
  curtain.setState(s.curtain);
  brbOverlay.setState(s);   // live-tabs: BRB = fade to black + the Be Right Back card (src/scene/brb/*)
  capCover.setState(s.capcover);
  if (covering && s.sceneId === covering.id) return;       // already switching there (its cover is animating in)
  if (s.sceneId === prevId && !wasLoading) {
    // picked the old room again before it was torn down: call the switch off, reveal it
    if (covering) { covering = null; ++sceneSeq; curtain.cancel(); }
    // a mode change that plays the transition (Gaming <-> Talk / React, src/scene/stage/registry.ts): the layout
    // switches under the cover, then the curtain waits for the new layout to be warm and reveals it
    if (scene && (modeCover || wantsModeCurtain(shownState, s))) { if (modeCover) modeCover.pending = s; else void coverMode(s); report(); return; }
    shownState = s;
    if (scene) { scene.setState(stageComp.runtimeState(s)); scene.syncActors(actorSpecs()); } report(); return;
  }
  if (s.sceneId === pendingSceneId && wasLoading) return;
  const seq = ++sceneSeq;
  // room-change transition: cover the frame FIRST, the old room goes only once a fully opaque frame is on screen
  // (a page (re)load with a room: covered at once, OBS pages only unless a test page asks with &curtain=boot)
  const bootCover = boot && !!s.sceneId && (sceneLocal ? q.get('curtain') === 'boot' : true) && curtain.wants(null, s.sceneId, true);
  if (curtain.active || bootCover || (!boot && curtain.wants(prevId, s.sceneId))) {
    covering = { seq, id: s.sceneId };
    if (s.sceneId) await sceneInfo(s.sceneId);
    await curtain.cover(curtainTarget(s.sceneId), bootCover ? -1 : s.curtain?.seq ?? 0, bootCover);
    if (seq !== sceneSeq) return;                          // a newer change took over (same cover)
    covering = null;
  }
  afkScene.detach();                                       // (the AFK director, ship names and title card leave with the room)
  // leave the current room (anchors back to the classic stage)
  if (scene) slapScene.detach();   // (first: the minion leaves the performer it hangs under, their pose hook is restored)
  if (scene) crewScene.detach();   // (before the room is disposed: the crew restores the wheel / turret nodes it turned)
  if (scene) voyageScene.detach();   // (before the room goes: it restores the camera's far plane + director hook)
  if (scene) showSkyScene.detach();
  if (scene) festivalScene.detach();
  if (scene) audience.scene.detach();   // (before the room goes: it restores the camera hook + the area boxes)
  if (scene) { gfx.bindRoom(null); chatScene.detach(); goalsWorld.detach(); timerDisplays.detach(); raidScene.detach(); townScene.detach(); spaceScene.detach(); envScene.detach(); trafficScene.detach(); epochScene.detach(); kitchenScene.detach(); clubScene.detach(); deckScene.detach(); crowdScene.detach(); reactionScene.detach(); formsScene.detach(); flat2dScene.detach(); for (const a of scene.releaseActors()) stage.anchor.add(a); scene.dispose(); scene = null; }
  if (scene) { yachtScene.detach(); loungeScene.detach(); }
  if (scene) { racewayScene.detach(); frontlineScene.detach(); warzoneScene.detach(); }
  if (!s.sceneId) { sceneLoading = false; pendingSceneId = null; sceneError = ''; relayout(); report(); curtain.loadDone(true); return; }
  sceneLoading = true;
  pendingSceneId = s.sceneId;
  report();
  try {
    const info = await sceneInfo(s.sceneId);
    if (!info || info.ready === false) throw new Error(`scene '${s.sceneId}' not found`);
    const rt = await SceneRuntime.load(stage, info, sceneState, { screen: preview || q.get('screen') === 'placeholder' ? 'preview' : 'hole', tier });
    if (seq !== sceneSeq) { rt.dispose(); return; }
    scene = rt;
    rt.cameraPin = camPin;
    stage.cancelBlend();   // (a classic-page ease of a 2D avatar's new framing never writes the room's camera)
    chatScene.attach(rt);
    goalsWorld.attach(rt);
    timerDisplays.attach(rt);
    raidScene.attach(rt);
    envScene.attach(rt);
    townScene.attach(rt);
    spaceScene.attach(rt);
    trafficScene.attach(rt);
    afkScene.attach(rt);                                   // (before the kitchen: its riot shots wrap — and win over — AFK's)
    epochScene.attach(rt);
    kitchenScene.attach(rt);
    crowdScene.attach(rt);
    audience.scene.attach(rt);   // the chat audience (seats / names over the crowd)
    clubScene.attach(rt);
    deckScene.attach(rt);
    yachtScene.attach(rt);
    voyageScene.attach(rt);
    showSkyScene.attach(rt, () => voyageScene.showSkyDefaults());   // (a walking ship gets the Preshow sky with no settings)
    festivalScene.attach(rt);
    crewScene.attach(rt);
    loungeScene.attach(rt);
    racewayScene.attach(rt);
    frontlineScene.attach(rt);
    warzoneScene.attach(rt);   // (after the raid: it wraps the raid director's camera hook)
    flat2dScene.attach(rt);    // 2D environments: the flat layers + ground (scene.json `flat2d`)
    formsScene.attach(rt);     // room forms: desks / docks / pads that change with who sits there (scene.json `forms`)
    reactionScene.attach(rt);  // room alert reactions: ALERT_* clips, the alert cue + light override, smashes (scene.json `reactions`)
    slapScene.attach(rt);   // (last: its camera cut wraps the other engines' directors)
    // OBS automation (server/obs.ts, off unless the user enabled it): tell the server when the passthrough hole has
    // opened / closed so it can line the Window Capture up. Test + preview pages never report. Each report carries the
    // mode its hole OPENED in (a close used to be tagged with the new mode — React → Gaming — and the server dropped
    // it, leaving the capture up) and `visible` (the page's own in-shot test: shared/quad.ts). A page pinned to its own
    // camera (?cam=) never reports: several pages would fight over the single Window Capture, the unpinned page owns it.
    if (!sceneLocal && !camPin) stageComp.onHole = (open, rect, label) => {
      if (open) holeModes.stage = shownState.mode;
      const quad = rect ? [[rect.x, rect.y], [rect.x + rect.w, rect.y], [rect.x + rect.w, rect.y + rect.h], [rect.x, rect.y + rect.h]] : null;
      void postHole({ open, rect, quad, layout: 'stage', label, mode: holeModes.stage, aspect: stage.camera.aspect, ...(rect ? { visible: true } : {}) })
        .then((j) => { if (open && holeModes.stage === 'react') heardRefusal(rt, j); });
    };
    // (an open is answered once OBS placed the capture: refused → this shot draws the screen in the room)
    if (!sceneLocal && !camPin) rt.onHole = (open, rect, layout, quad) => {
      if (open) holeModes.room = shownState.mode;
      void postHole({ open, rect, quad, layout, mode: holeModes.room, aspect: stage.camera.aspect, ...(rect ? { visible: rect.visible !== false } : {}) })
        .then((j) => { if (open) heardRefusal(rt, j); });
    };
    rt.setFeedWait(feedWaitNow());
    rt.setPassPin(passPin);
    rt.setObsAuto(obsAuto);
    sceneError = '';
    if (capture) scene.setCapture(capture);
    if (feedTex) scene.setFeed(feedTex, feedAspect);
    shownState = sceneState;
    scene.setState(stageComp.runtimeState(sceneState));
    scene.syncActors(actorSpecs());
    if (pendingLook) (scene.lights as unknown as { previewLook?: (l: unknown) => void }).previewLook?.(pendingLook);
    gfx.bindRoom(scene as unknown as GfxRoom);
    compileGate.arm(8000);
    // the studio's preview: the room's textures at most 1024 px before anything is uploaded (src/stage/gfx/previewTextures.ts)
    if (compileGate.gentle && compileGate.on && rt.root.children[0]) {
      compileGate.shrinking++; compileGate.uploads = null;
      void capPreviewTextures(rt.root.children[0], 1024).catch(() => 0).finally(() => { compileGate.shrinking--; compileGate.uploads = null; });
    }
  } catch (e) {
    console.error('output: scene failed', e);
    sceneError = (e as Error).message;
    if (seq !== sceneSeq) return;
  } finally {
    if (seq === sceneSeq) { sceneLoading = false; pendingSceneId = null; }
  }
  if (!scene) relayout(); // failed → keep the classic layout
  report();
  if (seq === sceneSeq) curtain.loadDone(!!scene);        // the transition now waits for the room to warm up
}

// ---- the Room editor (?roomEdit=<room>): loaded only on that page (OBS pages never load the editor code)
let roomEditFrame: ((dt: number) => void) | null = null;
if (roomEditId) {
  void import('./scene/roomEdit/editor.ts').then((m) => {
    roomEditFrame = m.installRoomEditor({ stage, room: roomEditId, scene: () => scene, reload: () => { sceneList = null; } });
  }).catch((e) => console.error('room editor failed to load', e));
}

// ---- where scene state comes from
if (roomEditId && !sceneTest) {
  // the Room editor without test hooks (the web build): the room from the URL, talk, the host at spot 1 — nothing else
  const st = defaultSceneState();
  st.sceneId = roomEditId; st.mode = 'talk'; st.camera = 'talk'; st.spots = { [HOST_KEY]: 0 };
  void applyScene(st, HOST_KEY);
} else if (sceneTest) {
  const st = defaultSceneState();
  st.sceneId = sceneTest;
  st.mode = /^[a-z][a-z0-9-]{1,23}$/.test(q.get('mode') || '') ? q.get('mode')! : 'talk';
  st.camera = q.get('cam') || (st.mode === 'react' ? 'react' : st.mode === 'gaming' ? 'group' : 'talk');
  // stage layouts (test pages): &react= &gaming= &strip= &corner= &camsize= &framing= &backdrop= &docks= &lineup=1 &content=
  st.stage = sanitizeStageState({ react: q.get('react') ?? undefined, gaming: q.get('gaming') ?? undefined, strip: q.get('strip') ?? undefined, corner: q.get('corner') ?? undefined, cam: q.get('camsize') ?? undefined,
    framing: q.get('framing') ?? undefined, backdrop: q.get('backdrop') ?? undefined, dock: { chat: q.get('docks') ?? undefined, support: q.get('docks') ?? undefined },
    ...(q.get('lineup') ? { test: Date.now() + 3600_000 } : {}), ...(q.get('content') ? { content: parseFloat(q.get('content')!) } : {}) });
  const hs = parseInt(q.get('spot') || '1', 10) - 1;
  st.spots = { [HOST_KEY]: Number.isFinite(hs) ? Math.max(0, Math.min(11, hs)) : 0 };
  if (q.get('raid')) { const r = (q.get('raid') || '').split(','); st.raid = sanitizeRaidState({ calm: r.includes('calm'), on: !r.includes('off'), intensity: r.find((x) => x === 'chill' || x === 'hot') ?? 'normal', seed: parseInt(q.get('raidSeed') || '7', 10), epoch: Date.now() - parseFloat(q.get('raidAt') || '0') * 1000, tagilla: true }); }
  // &kitchen=on|off,riot|fight|manager (plays that episode now) &kitchenAt=<s into it> &kitchenSeed=<n> &unrest=<$> — test pages only
  if (q.get('kitchen')) {
    const r = (q.get('kitchen') || '').split(','); const at = parseFloat(q.get('kitchenAt') || '0') * 1000; const now = Date.now();
    const ev = r.find((x) => x === 'riot' || x === 'fight' || x === 'manager');
    st.kitchen = sanitizeKitchenState({ on: !r.includes('off'), fights: !r.includes('nofights'), seed: parseInt(q.get('kitchenSeed') || '7', 10), epoch: now - 1000, unrest: parseFloat(q.get('unrest') || '0'), unrestAt: now,
      events: ev ? [{ k: ev === 'fight' ? 'foodfight' : ev, at: now - at, id: `test-${ev}`, user: 'TestViewer', amount: '$50.00' }] : [] });
  }
  // &crowd=support@<s> (a test support event in <s> seconds), &crowdForce=water:hop,rocks:juggle — test pages only
  // &club=tip@2,bits@6,conga@1 (a celebration / bit <s> seconds after load) — test pages only
  // &djdeck=on[,cdj|ctrl4][,tracked][,nostand|stand][,nohands] — test pages only: the DJ decks at the room's DJ spot
  if (q.get('djdeck')) { const r = (q.get('djdeck') || '').split(','); st.djdeck = sanitizeDjDeckState({ on: !r.includes('off'), look: r.includes('cdj') ? 'cdj' : r.includes('ctrl4') ? 'ctrl4' : 'auto', idle: r.includes('tracked') ? 'tracked' : 'groove', stand: r.includes('nostand') ? 'off' : r.includes('stand') ? 'on' : 'auto', hands: !r.includes('nohands') }); }
  if (q.get('club')) setTimeout(() => {
    for (const tok of (q.get('club') || '').split(',')) {
      const m = /^([a-z]+)@([\d.]+)$/.exec(tok); if (!m) continue;
      if (['tip', 'sub', 'bits', 'raid', 'big'].includes(m[1])) clubScene.test(m[1] as 'tip', 'NightOwl42', m[1] === 'big' ? 100 : 10, parseFloat(m[2])); else clubScene.testBit(m[1], parseFloat(m[2]));
    }
  }, 1500);
  if (q.get('crowd') || q.get('crowdForce')) setTimeout(() => {
    for (const f of (q.get('crowdForce') || '').split(',')) { const [g, k] = f.split(':'); if (g && k) crowdScene.force[g] = k; }
    const m = /support@([\d.]+)/.exec(q.get('crowd') || ''); if (m) crowdScene.testSupport('TestViewer', parseFloat(m[1]));
  }, 0);
  // &yacht=fleet@3,fireworks@6,support:25@2,raid@4 (events in <s> on this page) &yachtCfg=demo (fake anchors for a room without `yacht`) — test pages only
  if (q.get('yacht') || q.get('yachtCfg')) setTimeout(() => {
    if (q.get('yachtCfg') === 'demo') yachtScene.demo = true;
    for (const x of (q.get('yacht') || '').split(',')) { const m = /^([a-z]+(?::[\d.]+)?)@([\d.]+)$/.exec(x.trim()); if (m) yachtScene.test(m[1] as never, parseFloat(m[2])); }
  }, 0);
  // &voyage=battle|approach|defeat|storm|treasure|stop|city|night|day|fork|cruise (jump the manual clock there) &voyageAt=<s after it>
  // &voyageEv=fireworks@3,support:25@2,raid@4,battle@1 (page-local test stamps in <s>) &voyageCfg=demo (any room) &voyageSeed=<n> — test pages only
  if (q.get('voyage') || q.get('voyageEv') || q.get('voyageCfg') || q.get('voyageSeed')) setTimeout(() => {
    if (q.get('voyageCfg') === 'demo') voyageScene.demo = true;
    if (q.get('voyageWorld') === 'placeholder') VoyageScene.placeholderWorld = true;
    if (q.get('voyageSeed')) voyageScene.seedOverride = parseInt(q.get('voyageSeed')!, 10) || 1;
    const seek = q.get('voyage');
    if (seek) voyageScene.seek(seek as never, parseFloat(q.get('voyageAt') || '0') || 0);
    for (const x of (q.get('voyageEv') || '').split(',')) { const m = /^([a-z]+(?::[\w. ]+)?)@([\d.]+)$/.exec(x.trim()); if (m) voyageScene.test(m[1], parseFloat(m[2])); }
  }, 0);
  // &crew=battle@3,treasure@40,flee@5 (crew episodes in <s> on this page) &crewCfg=demo (the built-in preset deck for a room without `crew`) — test pages only
  if (q.get('crew') || q.get('crewCfg')) setTimeout(() => {
    if (q.get('crewCfg') === 'demo') crewScene.debugConfig('demo');
    for (const x of (q.get('crew') || '').split(',')) { const m = /^([a-z:]+)@([\d.]+)$/.exec(x.trim()); if (m) crewScene.test(m[1], parseFloat(m[2])); }
  }, 0);
  // &lounge=t3@2,gift:12@5,train:25@3,money:7.5@1,sub@4,raid@6 (celebrations in <s> on this page) &loungeNight=0…1 — test pages only
  if (q.get('lounge') || q.get('loungeNight')) setTimeout(() => {
    if (q.get('loungeNight')) loungeScene.forceNight = parseFloat(q.get('loungeNight')!) || 0;
    for (const x of (q.get('lounge') || '').split(',')) {
      const m = /^([a-z]+[1-5]?)(?::([\d.]+))?@([\d.]+)$/.exec(x.trim());
      if (m) loungeScene.test(m[1] === 'money' ? `money:${m[2] ?? 5}` : m[1], parseFloat(m[3]), 'TestViewer', m[2] ? parseFloat(m[2]) : 5);
    }
  }, 1500);
  // &raceway=armada@3,lap@5,salute@8,skirmish@2,confetti@4,tip@1,sub@2,gift@3,raid@4 (test events in <s> seconds) — test pages only
  // &frontline=barrage@3,chat:40,reward:Mech Drop@5,tip@2 (test events in <s> seconds) — test pages only
  // &warzone=airstrike@3,armor@5,flare@1 (set pieces in <s> seconds on this page) &wzNight=1 — test pages only
  if (q.get('warzone') || q.get('wzNight')) setTimeout(() => {
    if (q.get('wzNight')) warzoneScene.forceNight = parseFloat(q.get('wzNight')!) || 0;
    for (const f of (q.get('warzone') || '').split(',')) { const [k, s] = f.split('@'); if (k) warzoneScene.test(k, parseFloat(s || '1'), 'TestViewer', '$25.00'); }
  }, 2500);
  if (q.get('frontline')) setTimeout(() => { for (const f of (q.get('frontline') || '').split(',')) { const [k, s] = f.split('@'); if (k) frontlineScene.test(k, 'TestViewer', parseFloat(s || '0.5'), 25); } }, 0);
  if (q.get('raceway')) setTimeout(() => { for (const f of (q.get('raceway') || '').split(',')) { const [k, s] = f.split('@'); if (k) racewayScene.test(k, 'TestViewer', parseFloat(s || '0.5')); } }, 0);
  if (q.get('space')) { const r = (q.get('space') || '').split(','); st.space = sanitizeSpaceState({ on: !r.includes('off'), intensity: r.find((x) => x === 'chill' || x === 'hot') ?? 'normal', seed: parseInt(q.get('spaceSeed') || '7', 10), epoch: Date.now() - parseFloat(q.get('spaceAt') || '0') * 1000 }); }
  // &afk=on,brb|soon,always|nonames,calm|snappy,noevents &afkSeed=<n> &afkAt=<s into it> &crew=Name1,Name2 — test pages only
  if (q.get('afk') || q.get('crew')) st.afk = afkTestState(q);
  if (q.get('env')) {
    // &env=h18.5,storm,x60,cycle|real|fixed,auto (weather cycle),off — test pages only
    const e = (q.get('env') || '').split(',');
    const hh = e.find((x) => /^h[\d.]+$/.test(x)), xx = e.find((x) => /^x[\d.]+$/.test(x));
    st.env = sanitizeEnvState({ on: !e.includes('off'), clock: e.find((x) => x === 'cycle' || x === 'real' || x === 'fixed') ?? (xx ? 'cycle' : 'fixed'), hour: hh ? parseFloat(hh.slice(1)) : 12, speed: xx ? parseFloat(xx.slice(1)) : 24, epoch: Date.now(),
      tz: -new Date().getTimezoneOffset(), weather: e.find((x) => (ENV_WEATHERS as readonly string[]).includes(x)) ?? 'clear', weatherMode: e.includes('auto') ? 'cycle' : 'manual', seed: parseInt(q.get('envSeed') || '7', 10) });
  }
  if (q.get('era')) { const e = (q.get('era') || '').split(',').map(Number); st.era = sanitizeEraState({ on: true, index: Number.isFinite(e[0]) ? e[0] : 1, every: Number.isFinite(e[1]) && e[1] > 0 ? e[1] : 5, base: Date.now() + (Number.isFinite(e[2]) ? e[2] : 3) * 1000 }); }
  if (q.get('chat')) { const c = (q.get('chat') || '').split(','); st.chat = sanitizeChatState({ monitor: c.includes('monitor'), panel: c.includes('panel') ? 'panel' : c.includes('strip') ? 'monitor' : 'off', buddy: c.includes('buddy'), ...(q.get('buddyModel') ? { buddyModel: q.get('buddyModel') } : {}), ...(q.get('buddyMode') ? { buddyMode: q.get('buddyMode') } : {}), goal: { on: c.includes('goal'), target: 250, label: 'Stream goal' } }); }
  // &toggles=420:off,poster:on — room prop toggles (shared/roomToggles.ts) — test pages only
  if (q.get('toggles')) st.toggles = sanitizeToggles(Object.fromEntries((q.get('toggles') || '').split(',').map((x) => x.split(':')).map(([k, v]) => [k, v !== 'off' && v !== '0'])));
  const ex = (q.get('extra') || '').split(',').map((x) => x.trim()).filter((x) => /^[A-Za-z0-9_-]{1,48}$/.test(x));
  setExtras(ex.map((id) => ({ key: `lib:${id}`, avatarId: id, name: id })));
  void applyScene(st, HOST_KEY);
  if (q.get('beatDemo')) beatClock.demo(parseFloat(q.get('beatDemo')!) || 128);
} else if (!preview && !testRig && !gsSend) {
  // (retried while the helper doesn't answer: OBS started before the helper / during an update used to stay Classic
  //  until the studio's next change)
  const loadScene = (wait: number) => void api.get<SceneState>('/api/scene').then((s) => { if (!busSceneSeen) void applyScene(sanitizeSceneState(s), HOST_KEY); })
    .catch(() => { if (!busSceneSeen) setTimeout(() => loadScene(Math.min(8000, wait * 2)), wait); });
  loadScene(500);
}

// ---- &reactions=host (test pages only): the studio's part of the alert reactions (src/scene/controller.ts roomReactions),
// on this page's own scene state — the same matching + stamping code (shared/reactions.ts). Look / camera go back after `secs`.
const reactGate = new ReactionGate();
function reactLocal(e: ChatEvent, forced = false): boolean {
  const cfg = scene ? sanitizeRoomReactions(scene.info.reactions) : null;
  const hit = cfg ? matchReaction(cfg, e) : null;
  if (!hit || !(forced ? reactGate.force(hit) : reactGate.accept(e, hit))) return false;
  const s = structuredClone(sceneState);
  stampReaction(s, hit, e);
  void applyScene(sanitizeSceneState(s), selfKey);
  return true;
}
// goals reached / time added to the subathon (shared/reactions.ts GoalSignals): a goals view on the bus or fed by hand
const reactSignals = new GoalSignals();
const reactSigGates = { goal: new ReactionGate(), timerAdd: new ReactionGate() };
function reactSignal(sig: ReactionSignal, forced = false): boolean {
  const cfg = scene ? sanitizeRoomReactions(scene.info.reactions) : null;
  const hit = cfg ? matchSignal(cfg, sig) : null;
  const gate = reactSigGates[sig.on];
  if (!hit || !(forced ? gate.force(hit) : gate.accept({ id: `${sig.on}:${sig.id}` }, hit))) return false;
  const s = structuredClone(sceneState);
  stampReaction(s, hit, signalSource(sig));
  void applyScene(sanitizeSceneState(s), selfKey);
  return true;
}
function reactGoalsView(raw: unknown): number { let n = 0; if (reactHost) for (const sig of reactSignals.feed(sanitizeGoalsView(raw))) if (reactSignal(sig)) n++; return n; }
function reactTest(o: Record<string, unknown>): boolean {
  const sig = manualReactionSignal(o ?? {});
  return reactHost && (sig ? reactSignal(sig, true) : reactLocal(manualReactionEvent(o ?? {}), true));
}
if (reactHost) {
  bus.on((m) => { if (m.type === 'goals' && m.origin !== 'party') reactGoalsView(m.s); });
  chatFeed.on((fresh, snap) => { if (!snap) for (const raw of fresh) { const e = sanitizeChatEvent(raw); if (e) reactLocal(e); } });
  setInterval(() => { if (reactionsPending(sceneState) || reactionsStale(sceneState)) { const s = structuredClone(sceneState); revertReactions(s); pruneReactions(s); void applyScene(sanitizeSceneState(s), selfKey); } }, 250);
}

function setExtras(list: PreviewExtra[]) {
  const keep = new Set(list.map((x) => x.key));
  for (const [k, s] of extras) if (!keep.has(k)) { s.dispose(); extras.delete(k); }
  let i = 0;
  for (const x of list.slice(0, 11)) {
    let s = extras.get(x.key);
    if (!s) { s = new Slot(x.key, 100 + i); s.name = x.name; extras.set(x.key, s); void s.load(x.avatarId); }
    i++;
  }
  relayout();
}

// ---- studio preview link (output.html?preview=1 inside the studio's Scene tab)
function report() {
  if (!link) return;
  // paused by the studio and nothing in flight: about once a second (the studio re-renders its room stats on each; the
  // idle logic frames keep them current — see PREVIEW_IDLE_MS)
  const nowR = performance.now();
  if (!previewOn && !previewBusy(nowR) && (previewLegacy || nowR - previewReportAt < 950)) return;
  previewReportAt = nowR;
  // measured for the exact OBS canvas aspect the studio is set to (the preview box is only close to it)
  const w = parseInt(studioGet('vtp.scene.obsW') || '1920', 10), hh = parseInt(studioGet('vtp.scene.obsH') || '1080', 10);
  const aspect = w > 0 && hh > 0 ? w / hh : 16 / 9;
  const rects = scene ? { ...scene.screenRects(aspect), quads: scene.screenQuads(aspect) } : null;
  // (is the React screen in the shot the live camera is on? the Live panel says so plainly when it isn't)
  const sh = scene?.reactShot() ?? null;
  const shot = sh ? { ...sh, cam: shownState.camera ?? '', at: Date.now() } : null;
  const r: PreviewReport = { room: scene?.summary() ?? null, rect: scene?.screenRect('react', aspect) ?? null, rects, loading: sceneLoading, error: sceneError || undefined, fps: fpsNow, raid: scene ? raidScene.info() : null, space: scene ? spaceScene.info() : null, gfx: gfx.info(), env: scene ? envScene.info() : null, kitchen: scene ? kitchenScene.info() : null, curtain: curtain.status, stage: scene ? stageComp.info() : null, shot, afk: scene ? afkScene.info() : null };
  try { link.report(r); } catch { link = null; }
}
if (!preview && !gsSend) {
  shareRx = new ScreenShareReceiver((m) => bus.send(m), (h) => bus.on(h));
  shareRx.onStream = (s) => { capture = s; scene?.setCapture(s); };
  bus.onLink((up) => { if (up) shareRx?.resendWant(); });   // (what the receiver said while the bus was down never arrived)
  // the studio pauses THIS page's encode while nothing here can draw the window (Talk with the screens away); the last
  // picture stays, and it runs again at once when React (or any mode that draws it) comes back. Unknown = wanted.
  shareRx.setWantSource(() => !scene || sceneLoading || !!covering || scene.captureWanted);
  window.addEventListener('pagehide', () => shareRx?.dispose());
}
// TV performers' live video from this PC's studio (localhost WebRTC, src/net/tv/tvLocal.ts). Test pages inject fakes.
tvPage.setKeyOf((id) => { const s = id === 'self' ? self : guests.get(id); return s ? keyOf(s) : null; });
// (walking TV ↔ projector screen: the guest or the host switched it — reload that slot)
tvPage.setHooks({ scene: () => scene, reload: (id) => void (id === 'self' ? self.load(TV_SELF, true) : guests.get(id)?.load(`party-${id}`, true)) });
if ((!urlRoom || q.has('tvBus')) && !gsSend) tvPage.start((m) => bus.send(m), (h) => bus.on(h));
// Fast window feed (server/screenFeed.ts): the window the performer's OBS capture source shows, streamed by the server
// and decoded here (WebCodecs) straight onto the react screen — ≈ 31 ms vs ≈ 88 ms for the studio's WebRTC share.
// Fetched only while it can be seen: a room with a react screen, React mode, in-scene / auto (or a passthrough screen
// that can't line up exactly, drawn in the room instead), no window shared from the studio (that one wins). OBS pages only (not the studio's preview: decoding there would cost the tracking tab).
let feedTex: THREE.Texture | null = null, feedAspect: number | null = null;
const feedRx = !gsSend && (!sceneLocal || q.get('feed') === '1') ? (ScreenFeedReceiver.supported ? new ScreenFeedReceiver() : null) : null;
/** Auto keeps the React screen in the room while the helper's fast feed is connecting / starting / running (never a
 *  quiet fallback to an OBS box): false = no receiver here (no WebCodecs, a test page), not wanted, or a definite no. */
function feedWaitNow() { return !!feedRx && feedRx.isWanted && feedRx.verdict() === 'wait'; }
/** Whether this page fetches the fast feed + whether Auto waits for it: decided right before EVERY frame (renderFrame),
 *  and every 250 ms while no frames are drawn. React's very first frame must already know the feed is coming — on a
 *  250 ms timer alone that frame (and every frame until the timer ran: seconds on a busy page) still saw Talk's "no
 *  feed wanted" and drew the OBS hole, then the standby card, then the hole again (tools/react_obs_party_e2e.ts). */
function syncFeed() {
  if (!feedRx) return;
  // a room is loading: keep the feed (and its last picture) as it is — the new room gets it at once instead of a
  // cold start (dropping it here used to flip Auto to the OBS passthrough box on every room change)
  if (!scene && (sceneLoading || !!covering)) return;
  // (soloPending: the side screen is still being placed / built — keep the feed meanwhile. OBS passthrough wants it
  // too while the screen can't line up with an OBS box — angled, no corner-pin, or out of the shot: that screen is
  // drawn in the room, and it should show the window there, not NO SIGNAL)
  const react = shownState.mode === 'react';
  feedRx.setWanted(react && feedWanted({
    react, surface: !!scene && (scene.hasReactSurface || scene.soloPending || stageComp.info().view === 'composite'),
    shared: !!capture, screenMode: sceneState.screen?.mode ?? 'auto', passOk: !!scene?.passOk,
    fx: !!(sceneState.screen?.scanlines || sceneState.screen?.glass), obsAuto,
  }));
  scene?.setFeedWait(feedWaitNow());
}
if (feedRx) {
  feedRx.onTexture = (t, a) => { feedTex = t; feedAspect = a; scene?.setFeed(t, a); };
  setInterval(syncFeed, 250);
  window.addEventListener('pagehide', () => feedRx.dispose());
}
// OBS passthrough on an angled screen is only exact with OBS automation's corner-pin: asked every 5 s while React shows
// (OBS pages only; GET /api/obs/hole is local). The ask says what this page's React screen shows and why (in the shot?
// could a plain OBS box match it? how many px off?), so the helper's OBS panel can say in plain words why the capture
// isn't placed — e.g. NO SIGNAL on a screen seen at a slight angle.
if (!sceneLocal && !preview) {
  let again = 0;
  const ask = () => {
    clearTimeout(again); again = 0;
    const pi = scene && shownState.mode === 'react' ? scene.passInfo : null;
    // (React Full / Medium draw the window in a flat rect of the frame: no angle, never out of the shot)
    const qs = pi ? `?shows=${pi.shows}${pi.stage ? '&stage=1' : `&shot=${pi.inShot ? 1 : 0}&exact=${pi.exact ? 1 : 0}&err=${pi.err ?? ''}`}` : '';
    void fetch(`/api/obs/hole${qs}`, { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).then((j: unknown) => {
      if (scene) heardRefusal(scene, j);
      // (a ?cam= pinned page never reports or places a hole: the unpinned page owns the capture, docs/SCENES.md)
      if (j && !camPin) { obsAuto = (j as { native?: unknown }).native === true; scene?.setObsAuto(obsAuto); }
      // the corner-pin NOT KNOWN yet (a helper restart, a changed OBS address / password): keep what this page had —
      // dropping it flipped an angled screen's passthrough to the in-room picture and back — and ask again soon
      const pin = pinFromAnswer(j);
      if (pin === null) { if (j && !again) again = window.setTimeout(ask, PIN_REASK_MS); return; }
      passPin = pin; scene?.setPassPin(passPin);
    }).catch(() => {});
  };
  ask();
  setInterval(() => { if (scene && shownState.mode === 'react') ask(); }, 5000);
  // entering React asks at once: whether OBS automation can place the capture now decides Auto's native passthrough
  let wasReact = false;
  setInterval(() => { const r = shownState.mode === 'react'; if (r && !wasReact) ask(); wasReact = r; }, 250);
}
if (preview) {
  try {
    // (anything the studio sends wakes a paused preview for a few seconds: seats, size spots and reports stay current)
    const wake = (ms = 3000) => { previewWakeTo(performance.now() + ms); kickLoop(); };
    const page: PreviewPage = {
      apply: (s, self, ex) => { wake(); setExtras(ex); void applyScene(sanitizeSceneState(s), self); },
      setCapture: (stream) => { wake(); capture = stream; scene?.setCapture(stream); },
      beat: (b) => beatClock.push(b),
      lookPreview: (look) => { wake(); pendingLook = look; (scene?.lights as unknown as { previewLook?: (l: unknown) => void } | undefined)?.previewLook?.(look); },
      chat: (evs) => { wake(); chatFeed.push(evs); },
      curtainTest: (style) => { wake(8000); curtain.test(curtainTarget(scene?.info.id ?? null), style); },
      gfxBench: (o) => { wake(20000); return runGfxBench(gfx, () => perf.snapshot, { targetFps: o?.targetFps, room: scene?.info.id ?? null }); },
      setActive: (on, note) => previewActive(on, note ?? null),
      setFps: (fps) => { previewCap = typeof fps === 'number' && fps > 0 ? fps : null; },
      view: window,
    };
    if (bridgeFrom) {
      // the studio's shared preview, in its own process (src/scene/previewBridge.ts): the same calls over a private port
      void connectBridge(bridgeFrom, page, (env) => { bridgeEnv = env; bridgeEnvReady(); }).then((l) => { link = l; report(); });
    } else {
      const w = (window.parent !== window ? window.parent : window.opener) as (Window & { vtpScenePreview?: PreviewHost }) | null;
      link = w?.vtpScenePreview?.connect(page) ?? null;
    }
    window.addEventListener('pagehide', () => link?.disconnect());
  } catch (e) { console.warn('preview link unavailable', e); }
  setInterval(report, 500);
}

// ---------------------------------------------------------------- bus
// One publisher at a time: if two studios are open (a second tab, the studio window next to another one, a
// debug session) their frames and avatar announcements would interleave and the output would flicker between them.
// The lock (src/outputFollow.ts) follows the studio where the performer last switched avatar, holds while it talks, and
// gives a studio that was only stalled (a heavy avatar build) its lock back. Server-originated messages always pass.
const lock = new SourceLock();
function fromSource(m: { src?: string; type?: string; switchedAt?: unknown; avatarId?: unknown }): boolean {
  if (lock.accept(m, performance.now())) return true;
  if (m.type === 'load' && m.avatarId !== self.runtime?.profile.id) followTrace('ignored (another studio)', String(m.avatarId));
  return false;
}

let partySig = '';
function setParty(members: PartyMember[], tvSelf?: Extract<BusMessage, { type: 'party' }>['tvSelf']) {
  if (solo) return;
  // (the studio re-announces every 3 s: only act on real changes — who, slots, names, sealed avatar revisions)
  const changed = partyView.update(members.slice(0, 7));
  // TV performers: slots that became / stopped being a TV (or changed skin) reload; this PC's own performer too
  for (const id of tvPage.update(members.slice(0, 7), tvSelf)) {
    if (id !== 'self') changed.add(id);
    else if (tvPage.selfTv) { if (self.runtime && !self.runtime.profile.id.startsWith('tv-')) tvPage.selfPrev = self.runtime.profile.id; void self.load(TV_SELF, true); }
    else if (tvPage.selfPrev) void self.load(tvPage.selfPrev, true);
  }
  const sig = JSON.stringify(members.slice(0, 7).map((m) => [m.id, m.slot, m.name]));
  if (sig === partySig && !changed.size) return;
  partySig = sig;
  for (const id of changed) void guests.get(id)?.load(`party-${id}`, true);
  const keep = new Set(members.slice(0, 7).map((m) => m.id));
  for (const [id, s] of guests) if (!keep.has(id)) { s.dispose(); guests.delete(id); }
  for (const m of members.slice(0, 7)) {
    let s = guests.get(m.id);
    if (!s) { s = new Slot(m.id, m.slot); guests.set(m.id, s); void s.load(`party-${m.id}`); }
    s.slot = m.slot;
    s.name = m.name;
  }
  relayout();
}

// ---- chat: this PC's server (host / solo) or the host's, relayed by this guest's studio (origin 'party')
function acceptChat(m: { evs?: unknown; tot?: unknown; origin?: string; snap?: boolean }) {
  if (!chatFromBus) return;
  const party = m.origin === 'party';
  if (party !== (selfKey !== HOST_KEY)) return;
  chatFeed.push(Array.isArray(m.evs) ? m.evs : [], m.tot, !!m.snap);
}
function chatLive(s: ChatStatus) {
  const live: Record<string, boolean> = {};
  for (const [p, v] of Object.entries(s?.platforms ?? {})) live[p] = !!v?.enabled && v.state === 'live';
  chatScene.setLive(live);
  stageComp.dom.setLive(live);
  chatAnyLive = Object.values(live).some(Boolean);
}
if (chatFromBus) {
  void api.get<{ evs: unknown[]; tot: unknown }>('/api/chat/recent?n=60').then((r) => { if (selfKey === HOST_KEY) chatFeed.push(r.evs ?? [], r.tot, true); }).catch(() => {});
  void api.get<ChatStatus>('/api/chat/status').then(chatLive).catch(() => {});
}

// ---- party games (src/game/trail): while this PC's studio runs one, the game's spectator view covers this page
let gameFrame: HTMLIFrameElement | null = null;
let gameSeen = 0, gameSession = '';
// after 'off', late ctl / snap traffic of the ended session must not re-open the view (mount/unmount flicker)
let gameEnded = '';
// no game traffic for 10 s (the studio running it reloaded / crashed): back to the room
setInterval(() => { if (gameFrame && performance.now() - gameSeen > 10000) { gameMount(false); gameSession = ''; } }, 2000);
function gameMount(on: boolean) {
  if (on === !!gameFrame || sceneLocal || solo) return;
  if (on) {
    gameFrame = document.createElement('iframe');
    gameFrame.src = '/trail.html?view=obs';
    gameFrame.style.cssText = 'position:fixed;inset:0;width:100vw;height:100vh;border:0;background:transparent;z-index:10';
    gameFrame.setAttribute('allowtransparency', 'true');
    document.body.append(gameFrame);
  } else if (gameFrame) {
    // unload first so the game's WebGL context is released now (OBS's browser only allows a few live contexts)
    const f = gameFrame; gameFrame = null;
    try { f.src = 'about:blank'; } catch { /* ignore */ }
    setTimeout(() => f.remove(), 300);
  }
}
bus.on((m) => {
  if (m.type === 'trail') {
    gameSeen = performance.now();
    // a new game session (the host restarted / reloaded): start the spectator view fresh
    const sess = m.k === 'ctl' && (m.d as { k?: string; session?: string } | undefined)?.k === 'hello' ? String((m.d as { session?: string }).session ?? '') : '';
    if (sess && gameSession && sess !== gameSession && gameFrame) gameMount(false);
    if (sess) gameSession = sess;
    if (m.k === 'off') { gameEnded = gameSession || 'ended'; gameSession = ''; gameMount(false); return; }   // (the next game's hello must not look like a session switch)
    if (m.k === 'on') { gameEnded = ''; gameMount(true); return; }
    if (gameEnded && !(sess && sess !== gameEnded)) return;   // stray traffic of the game that just ended
    gameEnded = '';
    if (!gameFrame && (m.k === 'ctl' || m.k === 'snap')) gameMount(true);
    return;
  }
  if (m.type === 'health') { if (m.h && typeof m.h.inferMs === 'number') gfx.onHealth(m.h); return; }
  if (m.type === 'roomEdits') { void roomEditsSaved(m); return; }
  if (m.type === 'chat') { acceptChat(m); return; }
  if (m.type === 'chathub') return;   // (read-aloud plays in the studio)
  if (m.type === 'poll') { if (!sceneLocal && selfKey === HOST_KEY) pollStore.set(m.s); return; }
  if (m.type === 'djdeck') { if ((!sceneLocal || (preview && !sceneTest) || q.has('deckBus')) && (m.origin === 'party') === (selfKey !== HOST_KEY)) deckScene.onBus(m); return; }   // DJ decks (server/music/deckRig.ts): OBS pages, party guests and the studio's preview follow the controller; ?sceneTest pages opt in with &deckBus=1
  if (m.type === 'goals') { if (goalsFromBus && (m.origin === 'party') === (selfKey !== HOST_KEY)) goalsStore.set(m.s); return; }
  if (m.type === 'audience') { if (!sceneLocal) audience.scene.setView(m.s); return; }   // the chat audience (server/audience.ts)
  if (m.type === 'chatStatus') { if (chatFromBus && selfKey === HOST_KEY) chatLive(m.status); return; }
  if ((m.type === 'frame' || m.type === 'pvoice' || m.type === 'load' || m.type === 'party' || m.type === 'scene' || m.type === 'beat') && !fromSource(m as Parameters<typeof fromSource>[0])) return;
  if (m.type === 'musicclock' || m.type === 'musicdmx' || m.type === 'trackshow') { if (!sceneLocal || q.has('musicBus')) musicClock.onBus(m); return; } // DJ sync (src/scene/musicClockRx.ts); test pages opt in with &musicBus=1
  if (m.type === 'beat') { if (!sceneLocal && !musicClock.active()) beatClock.push(m.b); return; }   // (while VTube Pro publishes a DJ clock, it already carries the audio)
  if (m.type === 'frame') {
    if (testRig && !m.peer) return;
    const s = m.peer ? guests.get(m.peer) : self;
    if (s) { const now = performance.now(); s.frame = m.frame; s.lastFrameAt = now; if (m.peer) partyView.frame(m.peer, m.frame, m.net, now); else s.sync.push(m.frame, now, m.ts, m.seq); }
  } else if (m.type === 'pvoice') { const s = guests.get(m.peer); if (s) { s.lastFrameAt = performance.now(); partyView.voice(m.peer, m.v, s.lastFrameAt); } }
  else if (m.type === 'party') setParty(m.members, m.tvSelf);
  else if (m.type === 'output') applySettings(m.settings);
  else if (m.type === 'scene') {
    if (sceneLocal) return;
    busSceneSeen = true;
    const st = sanitizeSceneState(m.state);
    if (JSON.stringify(st) !== JSON.stringify(sceneState) || m.self !== selfKey || (st.sceneId && !scene && !sceneLoading)) void applyScene(st, typeof m.self === 'string' ? m.self : HOST_KEY);
  }
  else if (m.type === 'profile' && m.avatarId.startsWith('party-')) void guests.get(m.avatarId.slice(6))?.load(m.avatarId, true);
  else if ((m.type === 'load' || m.type === 'profile') && (!pinned || pinned === m.avatarId)) {
    // (a save of the avatar on show while ANOTHER one is loading: the switch wins, shared/profileBuild.ts reloadForSave)
    if (m.type === 'profile' && (self.runtime?.profile.id !== m.avatarId || (self.loadingId && self.loadingId !== m.avatarId))) return;
    // a Pro2D settings-only save (model sliders, outfit switches, gains, physics …) or a thumbnail-only save of any avatar
    // (shared/profileBuild.ts): applied in place, never a reload on stream
    if (m.type === 'profile' && self.runtime && !testOverride && !self.loadingId) { void flatSettingsOnly(m.avatarId); return; }
    void self.load(m.avatarId, m.type === 'profile');
  }
});

/** A 'profile' save of the avatar on show: in place when only a Pro2D avatar's live options changed (src/avatar/flat/rig2d/liveOpts.ts)
 *  or only thumbnails / model stats changed (shared/profileBuild.ts), else the usual reload. */
const flatSettingsGate = latestGate();
async function flatSettingsOnly(avatarId: string) {
  const rt = self.runtime, ticket = flatSettingsGate.begin();
  let next: ReturnType<typeof normalizeProfile> | null = null;
  try { next = normalizeProfile(await api.avatar(avatarId)); } catch { /* reload below */ }
  if (!flatSettingsGate.latest(ticket)) return;   // (a newer save's fetch is on its way: an older one never lands after it)
  if (next && rt && self.runtime === rt && !self.loadingId) {
    // (a 2D avatar: its live options first; any avatar: a save that differs only in thumbnails / model stats)
    if ((rt.flat && applyFlatProfileInPlace(rt, next)) || (sameAvatarBuild(rt.profile, next) && (adoptBuildFree(rt.profile, next), true))) return;
  }
  if (reloadForSave(avatarId, self.runtime?.profile.id, self.loadingId)) void self.load(avatarId, true);
}

/** The performer saved Room editor changes (server/routes/roomEdits.ts: ONE broadcast per Save): the cached room list is
 *  dropped (the next load of that room has them); `apply` + this page shows that room = applied in place, no reload
 *  (SceneRuntime.applyEdits: the camera eases to the new shot). Test pages (and the editor itself) keep their own. */
async function roomEditsSaved(m: { id: string; rev: number; apply: boolean }) {
  sceneList = null;
  if (!m.apply || urlRoom || !scene || scene.info.id !== m.id) return;
  const rt = scene;
  const info = await sceneInfo(m.id);
  if (scene !== rt || !info) return;
  rt.applyEdits(info.userEdits ?? null);
  report();
}

async function start() {
  if (pinned) return self.load(pinned);
  // follow the studio: last avatar it loaded (it re-announces on load), else first in library
  if (bridgeFrom) await Promise.race([bridgeEnvWait, new Promise((r) => setTimeout(r, 5000))]);
  const list = await api.avatars().catch(() => []);
  const last = studioGet('vtp.lastAvatar');
  const id = (last && list.find((a) => a.id === last)?.id) || list[0]?.id;
  if (id) await self.load(id);
}
void start();

// ---------------------------------------------------------------- render loop
const tune = normalizeProfile({ id: '_', modelFile: '' }).tracking;
let last = performance.now();
const maxFps = gsSend ? 30 : parseFloat(q.get('fps') || '60');
let fpsN = 0, fpsT = 0;
const fixedScale = q.has('dpr') ? Math.min(3, Math.max(0.25, parseFloat(q.get('dpr')!) || 1)) : null;
const perf = new OutputPerf(stage, () => self.sync, { diag: q.get('diag') === '1', adaptive: q.get('adaptive') !== '0' && !preview, fixedScale, targetFps: maxFps,
  scene: () => (scene ? scene.info.id : sceneLoading ? 'loading…' : 'classic'),
  // Avatar detail first: lighter levels of an own avatar on Auto before the render scale drops; one lever per 4 s.
  // The pressure only rises when it really takes a share off the page's avatar triangles (>= DETAIL_LEVER_MIN_SHARE,
  // AvatarDetail.savingAt at that pressure's allowed error); otherwise the render scale steps exactly as before, on the
  // same window.
  firstResponder: (snap, now, overloaded) => {
    if (!detailPressureOn) return false;
    const autos = detailActive();
    const w = { fps: snap.fps, late: snap.late, gpuP90: snap.gpuP90, targetFps: maxFps };
    if (!autos.length) { detailGov.onWindow(w, null, now, true, overloaded); return false; }   // light / Full models: the scale behaves as before
    const helps = (p: number) => pressureWorthIt(autos, p);
    // no pressure step (1..2, detailGovernor MAX_PRESSURE) would take a real share off: not a lever at all, so the render
    // scale steps exactly as on Full (no 4 s 'hold' after its own steps either)
    if (detailGov.pressure === 0 && !helps(1) && !helps(2)) { detailGov.onWindow(w, null, now, true, overloaded); return false; }
    // another lever acted < 4 s ago: the window still counts (here and in OutputPerf's streak), but nothing acts now
    const held = now - Math.max(lastDetailAt, perf.lastScaleChangeAt, lastGfxAt) < LEVER_HOLD_MS;
    const p0 = detailGov.pressure;
    const took = detailGov.onWindow(w, helps, now, !held, overloaded);
    // (a step DOWN is a lever change too: the render scale doesn't step back up on the same window)
    if (detailGov.pressure !== p0) { lastDetailAt = now; return took ? 'took' : 'hold'; }
    return took ? 'took' : held ? 'hold' : false;
  },
  avatarLine: detailLine });

const fpsGate = new FpsGate(maxFps);

// ---------------------------------------------------------------- a STARVED page (src/stage/gfx/starve.ts)
// OBS shows this page but a game holds the graphics card: frames seconds apart. Judged on the wall clock (a 500 ms timer),
// "not driven" (hidden page, OBS source hidden) told apart from "driven but starved". Starved: the lightest preset at
// once, render scale pinned at 0.6 (0.5 deeper), at most 30 (24) frames a second, unused post targets released; back
// one level at a time once the frames are healthy for a while. ?starve=0 (or ?autoLower=0) = never; with "Lower quality
// automatically" off the page only reports it. The studio says so in one sentence (src/ui/gameMode.ts).
const starveOn = !preview && !gsSend && q.get('starve') !== '0' && q.get('autoLower') !== '0';
const starve = new StarveGuard();
/** OBS's own source state (obs-browser fires obsSourceVisibleChanged / obsSourceActiveChanged on CHANGES only; null =
 *  not reported yet). A hidden or inactive source is not "driven"; becoming visible / active again drops the gap since
 *  (not scored: review round 1). */
let obsShown: boolean | null = null, obsActive: boolean | null = null;
const inObs = !!(window as unknown as { obsstudio?: unknown }).obsstudio;
const obsEvent = (e: Event, set: (v: boolean) => void) => {
  const d = (e as CustomEvent<{ visible?: boolean; active?: boolean }>).detail;
  const on = (d?.visible ?? d?.active) !== false;
  set(on);
  if (on) starve.resume(performance.now());
};
window.addEventListener('obsSourceVisibleChanged', (e) => obsEvent(e, (v) => { obsShown = v; }));
window.addEventListener('obsSourceActiveChanged', (e) => obsEvent(e, (v) => { obsActive = v; }));
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') starve.resume(performance.now()); });
/** In OBS with no visibility report yet: driven only once OBS has drawn this page properly at least once (a few seconds at
 *  8 frames a second or more) — a source OBS never shows must not read as starved. Outside OBS: the document's own. */
let obsDrawn = false, drawnT = 0, drawnFrames = 0;
const pageDriven = () => {
  if (document.visibilityState !== 'visible' || obsShown === false || obsActive === false) return false;
  return !inObs || obsShown === true || obsActive === true || obsDrawn;
};
const pageBusy = () => sceneLoading || !!covering || !!modeCover || curtain.active || !!gameFrame || slots().some((s) => !!s.loadingId);
let starveCap = Infinity;
let gpuNow: GpuStat | null = null;
/** Test hook: this many ms of busy main thread in every frame (a page that gets its frames seconds apart). */
let stallTestMs = 0;
// (the helper's reading describes the card of the PC that serves this page: a stream-PC page — served over the LAN —
//  must not judge its own card by the gaming PC's reading; the helper does not forward it there either)
const servedHere = /^(127\.0\.0\.1|localhost|\[::1\])$/.test(location.hostname);
if (!preview && servedHere) bus.on((m) => { if (m.type === 'gpustat') gpuNow = sanitizeGpuStat(m.s); });
/** The level whose effects are on now (0 = none). The way back to 0 always runs: "Lower quality automatically" turned off
 *  (or Undo on its toast) while starved gives the chosen preset, scale and frame rate back at once (review round 1). */
let appliedStarve: StarveLevel = 0;
function starveEffects(l: StarveLevel) {
  if (l === appliedStarve) return;
  appliedStarve = l;
  gfx.setStarved(l);
  perf.pin(l === 0 ? null : l === 1 ? 0.6 : 0.5);
  starveCap = l === 0 ? Infinity : l === 1 ? 30 : 24;
}
function applyStarve(l: StarveLevel) {
  const acted = gfx.lowersItself;
  starveEffects(acted ? l : 0);
  if (!sceneLocal) bus.send({ type: 'obsstarve', level: l, why: starve.reason, fps: +(starve.info().fps || 0).toFixed(1), acted });
  console.info(`[output] starved: level ${l}${l ? ` (${starve.reason})` : ''}${acted ? '' : ' (Lower quality automatically is off: nothing changed)'}`);
}
if (starveOn) setInterval(() => {
  const now = performance.now(), was = starve.level;
  // (has OBS drawn this page properly yet? see pageDriven)
  if (!obsDrawn) { if (now - drawnT >= 3000) { obsDrawn = (starve.totalFrames - drawnFrames) * 1000 / Math.max(1, now - drawnT) >= 8 && drawnT > 0; drawnT = now; drawnFrames = starve.totalFrames; } }
  const g = gpuNow && Date.now() - gpuNow.at < 20000 ? { usedMB: gpuNow.usedMB, totalMB: gpuNow.totalMB, util: gpuNow.util, at: gpuNow.at } : null;
  const l = starve.observe(now, pageDriven(), pageBusy(), g);
  if (l !== was) applyStarve(l);
  // the setting changed meanwhile (turned off: release now; on again while still starved: act now)
  else { const want = gfx.lowersItself ? starve.level : 0; if (want !== appliedStarve) starveEffects(want); }
}, 500);
/** What this page holds and how it runs, every 5 s to the studio / helper (bus 'obsperf'; test pages: vtpOut.starve). */
let canvasMsaa: number | null = null;
function obsPerfReport(): ObsPerfReport {
  const sn = perf.snapshot;
  let v: ReturnType<typeof estimateVram> | null = null;
  try {
    canvasMsaa ??= stage.renderer.getContextAttributes()?.antialias ? 4 : 0;
    v = estimateVram(stage.renderer, stage.scene, { targetBytes: gfx.targetBytes(), msaa: canvasMsaa });
  } catch { v = null; }
  const f = (x: number | undefined, d = 1) => (typeof x === 'number' && Number.isFinite(x) ? +x.toFixed(d) : null);
  return { at: Date.now(), page: bus.id, fps: f(sn?.fps) ?? 0, gapMax: f(sn?.intervalMax, 0) ?? 0, gapP95: f(sn?.intervalP95, 0) ?? 0, gpuP90: f(sn?.gpuP90, 2), cpuP95: f(sn?.frameP95, 2),
    level: gfx.level, starved: starve.level, scale: +stage.renderScale.toFixed(2), vramMB: v?.totalMB ?? null, texMB: v?.texturesMB ?? null, targetsMB: v?.targetsMB ?? null, driven: pageDriven() };
}
if (!preview && !sceneLocal) setInterval(() => bus.send({ type: 'obsperf', p: obsPerfReport() }), 5000);
(window as unknown as { vtpOut: Record<string, unknown> }).vtpOut.starve = { info: () => starve.info(), report: () => obsPerfReport(), stall: (ms: number) => { stallTestMs = Math.max(0, ms); } };
/** One world-matrix update per room frame (renderFrame). Kill switch: `output.html?oneMatrixPass=0` (the OBS Browser
 *  Source URL: the easy one to reach — OBS's browser profile has no console) or localStorage vtp.oneMatrixPass = '0'. */
let oneMatrixPass = q.get('oneMatrixPass') !== '0' && (() => { try { return localStorage.getItem('vtp.oneMatrixPass') !== '0'; } catch { return true; } })();
Object.defineProperty((window as unknown as { vtpOut: object }).vtpOut, 'oneMatrixPass', { get: () => oneMatrixPass, set: (v: boolean) => { oneMatrixPass = !!v; }, configurable: true });
/** Someone in the room is walking (an entrance / exit / seat change: SceneRuntime's mover owns them). */
function anyWalking() {
  const rt = scene;
  if (!rt) return false;
  for (const a of rt.actors.values()) if (rt.mover.busy(a)) return true;
  return false;
}
/** A paused preview keeps running frames while the studio waits on it: a room loading / switching / revealing, someone
 *  walking (React Big: the studio re-seats a big mascot from this page's analysis, which needs them arrived and the shot
 *  settled — compositor.ts reseatHints), automatic seats or size spots being searched (spread over frames), and a few
 *  seconds after any of that or anything the studio sent (longer while the camera is still gliding, capped: a camera that
 *  never settles must not keep it drawing — previewWakeEnd). */
function previewBusy(now: number) {
  if (sceneLoading || covering || modeCover || curtain.active || (!previewLegacy && anyWalking())) { previewWasBusy = true; return true; }
  if (previewWasBusy) { previewWasBusy = false; previewWakeTo(now + 3000); }
  if (now < previewWakeUntil) {
    // (the analysis waits for a settled shot: a glide that is still running gets seen through, then 1 s more — at most
    // PREVIEW_GLIDE_CAP_MS past the wake reason's own end)
    if (!previewLegacy) previewWakeUntil = previewWakeEnd(previewWakeUntil, previewWakeReason, now, !!scene?.rig.moving);
    return true;
  }
  // (SceneRuntime's incremental jobs — read-only peek, they finish a few ms per frame)
  const jobs = scene as unknown as { sizeJob?: unknown; soloJob?: unknown } | null;
  return !!jobs && (!!jobs.sizeJob || !!jobs.soloJob);
}
function loop(ts?: number) {
  // ?gsSend=1 (guest browser source): nothing is drawn unless a viewer is connected and visible (src/guestSend.ts sets gsPage.run). The loop
  // only looks once a second meanwhile (a timer, no display-rate callbacks) and is kicked awake at once by a viewer that shows up.
  if (gsSend && !gsPage.run) { renderLoop.later(GS_IDLE_LOOK_MS); fpsGate.reset(); last = performance.now(); previewPaused = true; return; }
  // the studio's preview, and nobody can see it (PreviewGate): no frames, like the game view below — and no display-rate
  // callbacks either: it looks again 10× a second, or at once when the studio un-pauses it / sends anything (kickLoop).
  // The next callback is queued FIRST, on both paths: an error in this frame (the busy check, an idle logic frame, a
  // draw) is reported as usual and the loop carries on with the next one.
  if (!previewOn) {
    renderLoop.later();
    if (!previewBusy(performance.now())) {
      const now = performance.now();
      fpsGate.reset(); previewPaused = true;
      const idleStep = previewIdleStepTest ?? 1 / Math.max(1, previewCap ? Math.min(maxFps, previewCap) : maxFps);
      // (idle logic frame: the room's clocks + the stage analysis move on, nothing is drawn — PREVIEW_IDLE_MS)
      last = now;
      if (!previewLegacy && now - previewIdleAt >= PREVIEW_IDLE_MS) { previewIdleAt = now; renderFrame(idleStep, now, false); }
      last = performance.now();
      return;
    }
  }
  renderLoop.frame();
  // a party game's spectator view covers the page: don't render the room underneath (two 3D renders = stutter)
  if (gameFrame) { last = performance.now(); fpsGate.reset(); return; }
  const cap = Math.min(previewCap ? Math.min(maxFps, previewCap) : maxFps, starveCap, gsSend ? gsPage.fps : Infinity);
  if (fpsGate.maxFps !== cap) fpsGate.maxFps = cap;
  const now = performance.now();
  // dt from the vsync-aligned rAF timestamp (callback start times jitter by a ms or so); fps cap keeps the remainder
  const t = typeof ts === 'number' && ts > 0 ? ts : now;
  let dt = Math.min(0.1, Math.max(0, (t - last) / 1000));
  last = t;
  // (back in view: draw on this very frame, not one fps interval later)
  if (previewPaused) { previewPaused = false; dt = Math.max(dt, 1 / Math.max(1, fpsGate.maxFps)); }
  const step = fpsGate.tick(dt);
  if (!step) return;
  if (stallTestMs > 0) { const t0 = performance.now(); while (performance.now() - t0 < stallTestMs) { /* test hook: a starved page */ } }
  brbSkipFrame = false;
  renderFrame(step, now);
  starve.frame(now);
  outputStamps.frame(bus, q, now, self);   // (pose age / duplicate frames for the broadcast health view; one boolean test while off)
  if (!brbSkipFrame) {
    perf.frame(now, performance.now() - now);
    if (gsSend) gsPage.frame?.(performance.now() - now);   // (guest browser source: pack + send this frame; never a skipped BRB frame)
  }
}
function hasKeys(o: object) { for (const _ in o) return true; return false; }
/** Stage layout name tags / speaking glow: member key -> display name, 0..1 talking now. */
function slotOf(key: string) { for (const s of slots()) if (keyOf(s) === key) return s; return null; }
function stageName(key: string) {
  // (the host's "My name on screen" / their override for a guest: SceneStageState.names, sanitised by the host)
  const o = shownState.stage?.names?.[key];
  if (typeof o === 'string' && o) return o.slice(0, 32);
  const s = slotOf(key); return s?.name || s?.runtime?.profile.name || (key.startsWith('lib:') ? key.slice(4) : key === HOST_KEY ? 'Host' : 'Guest'); }
function stageSpeak(key: string) {
  const s = slotOf(key);
  // (walking-TV guests: their runtime carries the voice level — S\tv\PERFORMER_API.md)
  const lv = (s?.runtime as unknown as { level?: unknown } | null)?.level;
  if (typeof lv === 'number') return lv;
  const m = s?.frame.mouth; return m ? Math.max(m.speak ?? 0, (m.open ?? 0) * 1.4) : 0;
}
let lastSnap: typeof perf.snapshot = null;
/** BRB is opaque over the page: this frame's 3D draw was skipped (the perf windows pause meanwhile: no GPU samples would
 *  read as headroom). `brbPerfDirty`: the first window after it spans the whole BRB, so Auto / the lowering never sees it. */
let brbSkipFrame = false, brbPerfDirty = false;
/** Debug: advance + draw frames by hand (hidden / headless tabs pause requestAnimationFrame). */
(window as unknown as { vtpOut: Record<string, unknown> }).vtpOut.step = (n = 1, dt = 1 / 60) => { for (let i = 0; i < n; i++) renderFrame(dt, performance.now()); };

/** `draw` false = an idle logic frame of a paused studio preview (PREVIEW_IDLE_MS): the room's engines, camera and stage
 *  analysis run; performers keep their last pose (nobody sees them) and nothing is drawn. */
function renderFrame(step: number, now: number, draw = true) {
  if (gameFrame) return; // a party game's spectator view is showing (it renders the performers itself)
  if (mechWalk) for (const s of slots()) if (s.runtime instanceof AvatarRuntime && s.runtime.mech) s.runtime.mech.treadmill = mechWalk;
  if (draw) { fpsN++; fpsT += step; }
  if (fpsT > 1) { fpsNow = Math.round(fpsN / fpsT); fpsN = 0; fpsT = 0; }
  if (draw) for (const s of slots()) {
    if (!s.runtime) continue;
    const key = scene ? keyOf(s) : '';
    if (scene && !scene.isShown(key) && !scene.mover.busy(scene.actors.get(key)!)) continue; // not in the room: skip the work
    // performer silent for >3 s (closed / throttled hard) → idle animation instead of freezing
    const live = now - s.lastFrameAt < 3000;
    let tuning = s.runtime.profile.tracking ?? tune;
    if (scene) tuning = scene.tuningFor(key, tuning);
    // every studio frame since the last render is integrated (sub-steps), the last one is displayed
    const net = s !== self && guests.has(s.id) ? partyView.sample(s.id, now) : null; // party member: network-smoothed
    const steps = net ? [{ frame: net.frame, dt: step }] : testRig && s === self ? [] : s.sync.steps(now, step);
    if (!steps.length) steps.push({ frame: s.frame, dt: step });
    if (testRig && s === self) { s.lastFrameAt = now; steps[0] = { frame: testFrame ?? { ...emptyFrame(), tracked: true }, dt: step }; }
    for (const st of steps) {
      const f = st.frame;
      if (live && f.bones && hasKeys(f.bones)) s.runtime.update(f, null, tuning, st.dt, stage.camera.aspect, f.bones);
      // (stalled: drop the studio's baked face life so this page animates its own idle life)
      else s.runtime.update(live ? f : { ...f, tracked: false, life: undefined }, null, tuning, st.dt, stage.camera.aspect);
    }
  }
  if (scene) envScene.pre(step);
  syncFeed();                                    // (before the room decides its React screen's look: see syncFeed)
  scene?.update(step);
  if (scene) afkScene.update(step);          // (the room clips are posed; sky traffic calls it back once its ships are)
  if (scene) envScene.post(step);
  feedRig2DWorld(stage, scene, gfx.level); // room light / wind / tier -> 2D rigs (live2d lane)
  if (scene) { raidScene.update(step); townScene.update(step); chatScene.hold = raidScene.stageBusy; chatScene.holdOnly = raidScene.liftProps; chatScene.update(step); spaceScene.update(step); trafficScene.update(step); epochScene.update(step); kitchenScene.update(step); clubScene.update(step); deckScene.update(step); crowdScene.update(step); reactionScene.update(step); }
  if (scene) audience.scene.update(step);
  if (scene) { yachtScene.update(step); loungeScene.update(step); }
  if (scene) voyageScene.update(step);
  if (scene) showSkyScene.update(step, voyageScene.manual ? voyageScene.clock : Date.now());
  if (scene) festivalScene.update(step);
  if (scene) {
    // the voyage feeds the crew (battles, treasure stops, the sand) while it runs in this room; the crew's sortie then
    // replaces the voyage's placeholder shore party
    const feed = voyageScene.crewFeedNow();
    if (crewScene.feedRef !== feed) crewScene.setFeed(feed);
    voyageScene.crewClaimed = !!feed && crewScene.ready;
  }
  if (scene) crewScene.update(step);              // (after any engine that turns the turrets: the gunners ride them)
  if (scene) { racewayScene.update(step); frontlineScene.update(step); warzoneScene.update(step); formsScene.update(step); flat2dScene.update(step); }
  if (scene) slapScene.pre(step, shownState);   // (after the chat buddy placed himself: the gag may borrow him)
  scene?.syncLiveCamera();                       // live camera presets: exactly on their (clip / engine moved) node this frame (after every engine)
  roomEditFrame?.(step);                         // the Room editor (?roomEdit=): its own camera + gizmos, after every engine
  const one = oneMatrixPass && !!scene;
  gfx.deferShadows = one || !draw;               // (idle logic frame: no shadow map either)
  gfx.frame(step);
  // stage layouts (after every engine's update): the plan, cams, docks, hole reports
  stageComp.update(step, { state: shownState, rt: scene, name: stageName, speak: stageSpeak, chatLive: chatAnyLive, curtain, ...(sceneLocal ? {} : { onBus: stageOnBus }) });
  if (scene) slapScene.post(step);
  pollOverlay.update(step, scene ? stageComp : null);
  productOverlay.update(step, scene ? stageComp : null);
  {
    const pal = (stageComp as unknown as { pal: import('../shared/stage.ts').StagePalette | null }).pal ?? null;
    goalsWorld.palette = pal;
    goalsWorld.update(step, (shownState?.chat?.panel ?? 'off') === 'panel', timerDisplays);   // (the hanging board keeps clear of a live timer display: boardShield.ts)
    timerDisplays.palette = pal;
    timerDisplays.update(step);
    goalsOverlay.update(step, scene ? { avoid: stagePollAvoid, palette: pal, hud: new Set(stageComp.hud.info().map((h) => h.type)), worldShown: goalsWorld.shown } : null);
  }
  // capture cover: its card at the capture area's size on this page (none in this shot: phases only, no drawing)
  if (capCover.visible) {
    const area = scene ? stageComp.coverArea() : null, cw = stage.renderer.domElement.width, ch = stage.renderer.domElement.height;
    const wPx = area ? area.rect.w * cw : 0;
    capCover.update(step, wPx, area ? (area.composite ? area.rect.h * ch : (wPx * 9) / 16) : 0, !!area);
  }
  if (perf.snapshot && perf.snapshot !== lastSnap) {
    lastSnap = perf.snapshot;
    // (one lever at a time: graphics Auto / auto-lower waits 4 s after an avatar-detail pressure change, and while Avatar
    //  detail is an active lever on this page also 4 s after a render-scale change; with no own Auto avatar ready the
    //  graphics level and the render scale behave exactly as before)
    const since = detailPressureOn && detailActive().length ? Math.max(lastDetailAt, perf.lastScaleChangeAt) : lastDetailAt;
    if (brbPerfDirty) brbPerfDirty = false;   // (the window that spans a skipped BRB: its fps / lateness say nothing about the GPU)
    else if (now - since >= LEVER_HOLD_MS) {
      const lv = gfx.level;
      gfx.onPerfWindow({ gpuP90: lastSnap.gpuP90, fps: lastSnap.fps, late: lastSnap.late, targetFps: maxFps, cpuP95: lastSnap.frameP95, driven: pageDriven() && !pageBusy() });
      if (gfx.level !== lv) lastGfxAt = now;
    }
  }
  // avatar detail: the page's choice (a runtime loaded while it changed catches up here), pressure in, level picked from
  // the cameras of the last 0.5 s, swapped between frames
  for (const d of ownDetails()) { if (d.choice !== detailChoice) d.setChoice(detailChoice); d.setPressure(detailGov.pressure); d.tick(now); }
  // a room is loading: don't flash the avatars at the classic origin meanwhile (in a room they live under it)
  stage.anchor.visible = !sceneLoading;
  if (!draw) return;
  // a transition fully covers the frame and the room is warm: nothing to draw until it reveals (saves the GPU)
  if (curtain.opaqueIdle) return;
  // (the studio's preview: NPCs an engine adds later get float skin indices before their first draw, once a second)
  if (compileGate.gentle && now - skinSweepAt > 1000) { skinSweepAt = now; floatSkinIndices(stage.scene); }
  // a room's shader programs are still linking off this thread (compileGate): keep the last picture
  if (compileGate.hold()) return;
  compileGate.warmCanvas();
  // BRB is fully black over the page (src/scene/brb/overlay.ts): nothing of the room can be seen, so it is not drawn. The
  // logic above (avatars, engines, fps count) and the compile gate / texture warm-up just ran as usual; a transition
  // curtain is left to its own readiness checks. The overlay reports "not opaque" on the very call that ends BRB, so the
  // fade-out shows a live frame.
  if (brbOverlay.opaque && !curtain.active) { brbSkipFrame = true; brbPerfDirty = true; return; }
  // collapsed (scale-0) room FX stay out of the draw list — again here, after every engine had its say this frame
  scene?.clips?.syncZeroScale();
  // rooms: ONE world-matrix update for the whole frame, after every engine and late mover — then every pass of the
  // frame (performer shadow map, main, glow, N8AO, the stage layout's performer cams) draws without re-traversing the
  // room (three.js re-runs scene.updateMatrixWorld() inside every render() otherwise). Kill switch: oneMatrixPass.
  const sc = stage.scene;
  if (one) { sc.updateMatrixWorld(); sc.matrixWorldAutoUpdate = false; }
  try {
    if (one) gfx.preRender();
    perf.gpuBegin();
    if (!stageComp.render()) stage.render();
    perf.gpuEnd();
  } finally { if (one) sc.matrixWorldAutoUpdate = true; }
  curtain.frame(performance.now());
}
loop();
