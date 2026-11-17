// Scene state defaults + sanitiser, shared by the server (/api/scene), the studio and party guests
// (a host's scene state arrives over the network: only known fields / clamped numbers survive).
import type { SceneLightsState, SceneMode, SceneMove, SceneState } from './types.ts';
import { isModeId, sanitizeModeBags, sanitizeStageState } from './stage.ts';
import { isLightingState, sanitizeLightGroups, sanitizeLooks } from './lightShow.ts';
import { canonPresetKey } from './lightPresets.ts';
import { sanitizeChatState } from './chat.ts';
import { sanitizeRaidState } from './raid.ts';
import { sanitizeKitchenState } from './kitchen.ts';
import { sanitizeClubState } from './club.ts';
import { sanitizeFestivalState } from './festival.ts';
import { sanitizeLightStyleId, sanitizeStyleOpts, sanitizeUserStyles } from './lightStyles.ts';
import { sanitizeGfx } from './graphics.ts';
import { sanitizeSpaceState } from './space.ts';
import { sanitizeEnvState } from './environment.ts';
import { sanitizeEraState } from './era.ts';
import { sanitizeAfkState } from './afk.ts';
import { sanitizeCurtainState } from './curtain.ts';
import { sanitizeCaptureCover } from './capcover.ts';
import { sanitizeBrbState } from './brb.ts';
import { sanitizeTtrpgState } from './ttrpg/state.ts';
import { sanitizeVideoState } from './screenVideo.ts';
import { sanitizeAmbientCam } from './ambientCam.ts';
import { sanitizeDjDeckState } from './djDeck/state.ts';
import { sanitizeToggles } from './roomToggles.ts';
import { sanitizeReactionStamps } from './reactions.ts';

export const MAX_SPOTS = 12;
/** Size-class spots (table perches, the giants' back row: src/scene/sizeSpots.ts) come after SPOT_12: indices 12 … 19. */
export const SIZE_SPOTS = 8;
export const MAX_SPOT_INDEX = MAX_SPOTS + SIZE_SPOTS;
export const HOST_KEY = '@host';

// mood: new scenes start on the new Reactive lights ('room'); a setup saved without one keeps its old show until the
// host picks a look on the Reactive lights card (src/scene/lightShow.ts `modern`)
export const DEFAULT_LIGHTS: SceneLightsState = { program: 'show', reactive: false, intensity: 1, safe: true, delay: 0, state: 'show', stateFade: 2, mood: 'room' };

export function defaultSceneState(): SceneState {
  return {
    sceneId: null, mode: 'talk', camera: 'talk', focus: HOST_KEY, spots: { [HOST_KEY]: 0 }, present: {},
    lights: { ...DEFAULT_LIGHTS }, avatarScale: 1, transition: 1.2, rev: 0,
    moves: {}, follow: { host: true, guests: false },
  };
}

const ID = /^[a-z0-9][a-z0-9_-]{0,47}(?:~[a-z0-9][a-z0-9_-]{0,23})?$/;   // a room folder, optionally `~<area>` (shared/roomId.ts)
/** '@host' or a party member id (or 'lib:<avatarId>' test members in preview pages). */
const KEY = /^(@host|[a-z0-9]{6,32}|lib:[A-Za-z0-9_-]{1,48})$/;
const CAM = /^[A-Za-z0-9_]{1,48}$/;
const num = (v: unknown, lo: number, hi: number, d: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);

export const isSceneId = (v: unknown): v is string => typeof v === 'string' && ID.test(v);

/** React screen settings (default: auto mode, subtle scanlines off, glass sheen off). The sheen used to be on by
 *  default and washed the window out, so a saved `glass: true` without `glassV: 2` (never chosen since) reads as off. */
export function sanitizeScreen(o: unknown): { mode: 'auto' | 'inscene' | 'passthrough'; scanlines: boolean; glass: boolean; glassV: 2 } {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return { mode: x.mode === 'inscene' || x.mode === 'passthrough' ? x.mode : 'auto', scanlines: x.scanlines === true, glass: x.glassV === 2 && x.glass === true, glassV: 2 };
}

/** Entrances (SceneState.entrances): missing = walk in / out, new party members walk in. */
export function sanitizeEntrances(o: unknown): { walk: boolean; join: 'walk' | 'seated' | 'outside' } {
  const x = (o && typeof o === 'object' ? o : {}) as Record<string, unknown>;
  return { walk: x.walk !== false, join: x.join === 'seated' || x.join === 'outside' ? x.join : 'walk' };
}

export function sanitizeSceneState(o: unknown): SceneState {
  const d = defaultSceneState();
  if (!o || typeof o !== 'object') return d;
  const x = o as Record<string, unknown>;
  const spots: Record<string, number> = {};
  const used = new Set<number>();
  if (x.spots && typeof x.spots === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(x.spots as Record<string, unknown>)) {
      if (n >= 24 || !KEY.test(k) || typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v >= MAX_SPOT_INDEX || used.has(v)) continue;
      spots[k] = v; used.add(v); n++;
    }
  }
  const present: Record<string, boolean> = {};
  if (x.present && typeof x.present === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(x.present as Record<string, unknown>)) if (n++ < 24 && KEY.test(k) && typeof v === 'boolean') present[k] = v;
  }
  const moves: Record<string, SceneMove> = {};
  if (x.moves && typeof x.moves === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(x.moves as Record<string, unknown>)) {
      if (n >= 24 || !KEY.test(k) || !v || typeof v !== 'object') continue;
      const m = v as Record<string, unknown>;
      const from = m.from, to = m.to, at = m.at;
      if (!Number.isInteger(from) || !Number.isInteger(to) || typeof at !== 'number' || !Number.isFinite(at)) continue;
      if ((from as number) < -1 || (from as number) >= MAX_SPOT_INDEX || (to as number) < -1 || (to as number) >= MAX_SPOT_INDEX || at < 0 || at > 1e14) continue;
      moves[k] = { from: from as number, to: to as number, at }; n++;
    }
  }
  const fo = (x.follow && typeof x.follow === 'object' ? x.follow : {}) as Record<string, unknown>;
  const l = (x.lights && typeof x.lights === 'object' ? x.lights : {}) as Record<string, unknown>;
  // (any registered mode id is kept: src/scene/stage/registry.ts; a page that doesn't know it renders Talk)
  const mode: SceneMode = isModeId(x.mode) ? x.mode : 'talk';
  return {
    sceneId: isSceneId(x.sceneId) ? x.sceneId : null,
    mode,
    camera: typeof x.camera === 'string' && CAM.test(x.camera) ? x.camera : d.camera,
    ...(typeof x.camPick === 'number' && x.camPick > 0 && x.camPick < 1e14 ? { camPick: Math.floor(x.camPick) } : {}),   // (the host picked this camera by hand: shared/camPick.ts)
    focus: typeof x.focus === 'string' && KEY.test(x.focus) ? x.focus : HOST_KEY,
    spots,
    present,
    lights: {
      program: typeof l.program === 'string' && CAM.test(l.program) ? canonPresetKey(l.program) : DEFAULT_LIGHTS.program,
      reactive: l.reactive === true,
      intensity: num(l.intensity, 0, 2, 1),
      groups: sanitizeLightGroups(l.groups),
      safe: l.safe !== false,
      ...(l.warnOnStream === true ? { warnOnStream: true } : {}),   // (missing in old saves = off)
      delay: Math.round(num(l.delay, -500, 500, 0)),
      state: isLightingState(l.state) ? l.state : 'show',
      states: sanitizeLooks(l.states),
      stateFade: num(l.stateFade, 0, 8, 2),
      ...(sanitizeLightStyleId(l.style) ? { style: sanitizeLightStyleId(l.style) } : {}),
      ...(sanitizeUserStyles(l.userStyles) ? { userStyles: sanitizeUserStyles(l.userStyles) } : {}),
      ...(l.styleOpts && typeof l.styleOpts === 'object' ? { styleOpts: sanitizeStyleOpts(l.styleOpts) } : {}),
      ...(l.mood === 'room' || l.mood === 'calm' || l.mood === 'club' || l.mood === 'rave' ? { mood: l.mood } : {}),
    },
    hostId: typeof x.hostId === 'string' && /^[a-z0-9]{6,32}$/.test(x.hostId) ? x.hostId : undefined,
    avatarScale: num(x.avatarScale, 0.4, 2.5, 1),
    reactLayout: x.reactLayout === 'solo' || x.reactLayout === 'big' ? x.reactLayout : 'auto',
    screen: sanitizeScreen(x.screen),
    transition: num(x.transition, 0, 5, 1.2),
    rev: Math.round(num(x.rev, 0, 1e12, 0)),
    moves,
    follow: { host: typeof fo.host === 'boolean' ? fo.host : d.follow.host, guests: typeof fo.guests === 'boolean' ? fo.guests : d.follow.guests },
    ...(x.entrances && typeof x.entrances === 'object' ? { entrances: sanitizeEntrances(x.entrances) } : {}),
    ...(typeof x.sentAt === 'number' && Number.isFinite(x.sentAt) && x.sentAt > 0 && x.sentAt < 1e14 ? { sentAt: x.sentAt } : {}),
    ...(x.stage && typeof x.stage === 'object' ? { stage: sanitizeStageState(x.stage) } : {}),
    ...((): { modes?: Record<string, unknown> } => { const m = sanitizeModeBags(x.modes); return m ? { modes: m } : {}; })(),
    ...(x.chat && typeof x.chat === 'object' ? { chat: sanitizeChatState(x.chat) } : {}),
    ...(x.raid && typeof x.raid === 'object' ? { raid: sanitizeRaidState(x.raid) } : {}),
    ...(x.kitchen && typeof x.kitchen === 'object' ? { kitchen: sanitizeKitchenState(x.kitchen) } : {}),
    ...(x.club && typeof x.club === 'object' ? { club: sanitizeClubState(x.club) } : {}),
    ...(x.festival && typeof x.festival === 'object' ? { festival: sanitizeFestivalState(x.festival) } : {}),
    ...(x.afk && typeof x.afk === 'object' ? { afk: sanitizeAfkState(x.afk) } : {}),
    ...(x.gfx && typeof x.gfx === 'object' ? { gfx: sanitizeGfx(x.gfx) } : {}),
    ...(x.space && typeof x.space === 'object' ? { space: sanitizeSpaceState(x.space) } : {}),
    ...(x.env && typeof x.env === 'object' ? { env: sanitizeEnvState(x.env) } : {}),
    ...(x.era && typeof x.era === 'object' ? { era: sanitizeEraState(x.era) } : {}),
    ...(x.curtain && typeof x.curtain === 'object' ? { curtain: sanitizeCurtainState(x.curtain) } : {}),
    ...(x.capcover && typeof x.capcover === 'object' ? { capcover: sanitizeCaptureCover(x.capcover) } : {}),
    ...(x.brb && typeof x.brb === 'object' ? { brb: sanitizeBrbState(x.brb) } : {}),
    ...(x.ttrpg && typeof x.ttrpg === 'object' ? { ttrpg: sanitizeTtrpgState(x.ttrpg) } : {}),
    ...(x.video && typeof x.video === 'object' ? { video: sanitizeVideoState(x.video) } : {}),
    ...(x.ambcam && typeof x.ambcam === 'object' ? { ambcam: sanitizeAmbientCam(x.ambcam) } : {}),
    ...(x.djdeck && typeof x.djdeck === 'object' ? { djdeck: sanitizeDjDeckState(x.djdeck) } : {}),
    ...((): { toggles?: Record<string, boolean> } => { const t = sanitizeToggles(x.toggles); return t ? { toggles: t } : {}; })(),
    ...((): { reactions?: ReturnType<typeof sanitizeReactionStamps> } => { const r = sanitizeReactionStamps(x.reactions); return r.length ? { reactions: r } : {}; })(),
  };
}
