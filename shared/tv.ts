// TV performers: people without a 3D VTube Pro avatar — a plain webcam, or a VTube Studio / Live2D model — join a party
// as a WALKING TELEVISION whose screen shows their live video (docs/MULTIPLAYER_DISCORD.md → "TV guests", S\tv\CONTRACT.md).
//
// This file is the pure data contract (studio, OBS pages, the party wire, the browser-only guest page, Node tests):
//  * TvInfo — what a TV performer announces (kind, TV skin, real height, picture aspect, mirror, chroma key, backdrop).
//    It travels in the party 'hello' / 'profile' / 'roster' messages (field `tv`) and in the local bus 'party' message;
//    every receiver re-sanitises it (sanitizeTvInfo). The VIDEO itself is a WebRTC track (src/net/tv/*), RAM only.
//  * skins (the tvart asset's skin ids + the engine's grey-box fallback look), capture presets (bandwidth), chroma presets.
// No DOM / three.js here.
import { sanitizePack, type TvPack } from './spout.ts';
import { sanitizeFaceBox, type FaceBox } from './framing.ts';

export type TvKind = 'webcam' | 'vts';
export const TV_KINDS: readonly TvKind[] = ['webcam', 'vts'];

/** Chroma key (VTube Studio's coloured background → cut out). Colour in sRGB 0..1. */
export interface TvChroma {
  color: [number, number, number];
  /** 0..1: how far from the key colour still counts as background (distance in chroma space). */
  similarity: number;
  /** 0..1: soft edge width above `similarity`. */
  smoothness: number;
  /** 0..1: remove the key colour's tint from the kept edges (green fringe). */
  spill: number;
}

export interface TvInfo {
  v: 1;
  kind: TvKind;
  /** TV body skin id (TV_SKINS; unknown ids fall back to the first). */
  skin: string;
  /** Real height of the TV performer (m) → size class, like AvatarProfile.size (shared/avatarSize.ts). */
  height: number;
  /** Width / height of the transmitted picture (after the sender's crop). */
  aspect: number;
  /** Show the picture mirrored (selfie view). The sender never flips the pixels. */
  mirror: boolean;
  /** Chroma key applied by every renderer (null = none). */
  chroma: TvChroma | null;
  /** Backdrop drawn behind a keyed-out picture (TV_BACKDROPS id). */
  bg: string;
  /** How the picture fills the TV screen: 'cover' (crop to fill, default) or 'contain' (letterbox). */
  fit: 'cover' | 'contain';
  /** How they appear: a walking TV (default) or a pull-down PROJECTOR SCREEN (src/scene/tv/tvProjector.ts). The host
   *  can override it per member (TV_BAG `looks`). Older apps: missing = 'tv'. */
  look?: TvLook;
  /** Body motion of a walking TV: 'calm' (default — subtle idle, gestures only on real speech) or 'lively'. The host
   *  can override it for everyone (TV_BAG `motion`). */
  motion?: TvMotion;
  /** Spout2 (shared/spout.ts): the frame carries the alpha side by side with the colour (colour left, alpha right).
   *  Receivers that don't know it (older apps) would show both halves: senders only pack for hosts with TV_ALPHA_CAP. */
  pack?: TvPack;
  /** Spout2 source: `native` = VTube Pro's own receiver (real alpha), else a webcam bridge (SpoutCam / OBS Virtual
   *  Camera, keyed); `alpha` = the picture really carries alpha now; `app` = VSeeFace / Warudo … when known. */
  spout?: TvSpoutInfo;
  /** Where the face is in the transmitted picture ([x, y, w, h] fractions, top-left; shared/framing.ts FaceBox), from the
   *  sender's own tracker, smoothed + quantised (re-announced only when it moves). Receivers keep it inside the
   *  screen's safe area (the cover crop follows it) and frame projector guests on it. Older apps: missing = centre. */
  face?: FaceBox;
}
export interface TvSpoutInfo { native: boolean; alpha: boolean; app: string }
/** 'standee' (Spout2 with real alpha): the model itself stands in the room — a cut-out that always faces the camera,
 *  no TV body and no backdrop. Older apps show it as a walking TV. */
export type TvLook = 'tv' | 'projector' | 'standee';
export const TV_LOOKS: readonly TvLook[] = ['tv', 'projector', 'standee'];
const lookOf = (v: unknown): TvLook => (v === 'projector' || v === 'standee' ? v : 'tv');
export type TvMotion = 'calm' | 'lively';

// ---------------------------------------------------------------- skins
export interface TvSkin {
  id: string;
  name: string;
  /** Picture area aspect (w/h) of this skin's screen. */
  screenAspect: number;
  /** Real height of the set + legs, antennas excluded (m) — the default TvInfo.height, so the size class follows the
   *  skin (the handheld is a micro performer, the arcade cabinet a macro one). */
  height: number;
  /** Engine grey-box stand-in colours (sRGB hex) — used until / unless the tvart GLB is installed. */
  body: string; bezel: string; accent: string;
  /** Screen look: scanlines 0..1, barrel curvature 0..1, glow 0..1, vignette 0..1, glass reflection 0..1. */
  scan: number; curve: number; glow: number; vignette: number; glass: number;
  /** Grey-box shape: 'crt' (deep box, rabbit ears), 'portable' (boxy, handle, short antenna), 'flat' (thin panel on a stand body). */
  shape: 'crt' | 'portable' | 'flat';
}
/** Skin ids = the tvart asset's (assets/builtin/tv_performer/tv_profile.json, S	v\CONTRACT.md). */
export const TV_SKINS: readonly TvSkin[] = [
  { id: 'retro80', name: '80s wood-grain console', screenAspect: 4 / 3, height: 1.3, body: '#8a5a35', bezel: '#2b2622', accent: '#d9b36c', scan: 0.55, curve: 0.55, glow: 0.35, vignette: 0.5, glass: 0.25, shape: 'crt' },
  { id: 'portable90', name: '90s grey portable', screenAspect: 4 / 3, height: 1.22, body: '#b9b7b0', bezel: '#3a3b3f', accent: '#e0473c', scan: 0.45, curve: 0.4, glow: 0.25, vignette: 0.4, glass: 0.2, shape: 'portable' },
  { id: 'flat_modern', name: 'Modern flat panel', screenAspect: 16 / 9, height: 1.43, body: '#23262d', bezel: '#0d0e11', accent: '#4fb3ff', scan: 0.0, curve: 0.0, glow: 0.12, vignette: 0.12, glass: 0.12, shape: 'flat' },
  { id: 'handheld', name: 'Pocket handheld (tiny)', screenAspect: 4 / 3, height: 0.43, body: '#f2c230', bezel: '#2a2a2e', accent: '#ff5a1f', scan: 0.35, curve: 0.3, glow: 0.25, vignette: 0.35, glass: 0.2, shape: 'portable' },
  { id: 'arcade', name: 'Giant arcade cabinet', screenAspect: 4 / 3, height: 2.82, body: '#5b2a86', bezel: '#141018', accent: '#ff2d55', scan: 0.5, curve: 0.35, glow: 0.35, vignette: 0.45, glass: 0.2, shape: 'crt' },
];
/** Older ids (contract v2) → the asset's ids. */
const SKIN_ALIAS: Record<string, string> = { woodgrain: 'retro80', portable: 'portable90', flat: 'flat_modern' };
export const tvSkin = (id: string | undefined): TvSkin => TV_SKINS.find((s) => s.id === (SKIN_ALIAS[id ?? ''] ?? id)) ?? TV_SKINS[0];

/** Backdrops behind a chroma-keyed picture (drawn procedurally by the screen shader). */
export const TV_BACKDROPS: readonly { id: string; name: string }[] = [
  { id: 'studio', name: 'Studio glow' },
  { id: 'sunset', name: 'Sunset' },
  { id: 'grid', name: 'Retro grid' },
  { id: 'stars', name: 'Night sky' },
  { id: 'plain', name: 'Plain dark' },
];

// ---------------------------------------------------------------- capture / bandwidth presets
export interface TvPreset { id: string; name: string; width: number; height: number; fps: number; kbps: number }
/** Sender presets (guest → host). The host forwards to other guests at ≤ TV_FORWARD (downscaled by the browser encoder). */
export const TV_PRESETS: readonly TvPreset[] = [
  { id: 'low', name: 'Low — 360p 20 fps (~350 kbit/s)', width: 640, height: 360, fps: 20, kbps: 350 },
  { id: 'medium', name: 'Medium — 480p 24 fps (~700 kbit/s)', width: 854, height: 480, fps: 24, kbps: 700 },
  { id: 'high', name: 'High — 720p 30 fps (~1.5 Mbit/s)', width: 1280, height: 720, fps: 30, kbps: 1500 },
];
export const tvPreset = (id: string | undefined): TvPreset => TV_PRESETS.find((p) => p.id === id) ?? TV_PRESETS[1];
/** Host → other guests: the forwarded copy of each feed (a TV screen is small in the room). */
export const TV_FORWARD = { kbps: 450, maxHeight: 360, fps: 24 };
/** Host forwards scale down as the party fills up: every forwarded feed is one more software encode on the host
 *  (7 TV guests = 49 encodes). A TV screen is a small part of the OBS frame, so this is barely visible. The host also
 *  drops a tier while its encoders report being CPU-limited. Index = tier. */
export const TV_FORWARD_TIERS: readonly { kbps: number; maxHeight: number; fps: number }[] = [
  { kbps: 450, maxHeight: 360, fps: 24 },   // ≤ 3 feeds per guest
  { kbps: 300, maxHeight: 270, fps: 20 },   // 4–5
  { kbps: 200, maxHeight: 216, fps: 15 },   // 6–7
  { kbps: 130, maxHeight: 180, fps: 12 },   // CPU-limited
];
export const forwardTier = (feeds: number, cpuLimited: boolean) => Math.min(TV_FORWARD_TIERS.length - 1, (feeds <= 3 ? 0 : feeds <= 5 ? 1 : 2) + (cpuLimited ? 1 : 0));
/** Studio → this PC's OBS pages (loopback, never leaves the PC): keep the source quality. */
export const TV_LOCAL = { kbps: 6000, fps: 30 };
/** At most this many TV feeds in one party (8 performers). */
export const TV_MAX_FEEDS = 8;

// ---------------------------------------------------------------- chroma presets (VTube Studio background colours)
export const CHROMA_PRESETS: Record<'green' | 'blue' | 'magenta', TvChroma> = {
  // VTube Studio's "Color" backgrounds: pure green (0,255,0) / blue (0,0,255) are the usual picks for keying
  green: { color: [0, 1, 0], similarity: 0.34, smoothness: 0.08, spill: 0.6 },
  blue: { color: [0, 0, 1], similarity: 0.34, smoothness: 0.08, spill: 0.6 },
  magenta: { color: [1, 0, 1], similarity: 0.3, smoothness: 0.08, spill: 0.5 },
};

export const TV_HEIGHT = { min: 0.6, max: 2.6, def: 1.45 };

// ---------------------------------------------------------------- sanitising (everything that arrives from the network)
const num = (v: unknown, lo: number, hi: number, def: number) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : def);
const ID = /^[a-z0-9_-]{1,24}$/;

export function sanitizeChroma(v: unknown): TvChroma | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const c = Array.isArray(o.color) && o.color.length === 3 ? o.color.map((x) => num(x, 0, 1, 0)) as [number, number, number] : null;
  if (!c) return null;
  return { color: c, similarity: num(o.similarity, 0.01, 0.9, 0.34), smoothness: num(o.smoothness, 0, 0.5, 0.08), spill: num(o.spill, 0, 1, 0.5) };
}

/** Anything → a clean TvInfo (or null = not a TV performer). */
export function sanitizeTvInfo(v: unknown): TvInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (!TV_KINDS.includes(o.kind as TvKind)) return null;
  const skin = typeof o.skin === 'string' && ID.test(o.skin) ? tvSkin(o.skin).id : TV_SKINS[0].id;
  const bg = typeof o.bg === 'string' && TV_BACKDROPS.some((b) => b.id === o.bg) ? o.bg : 'studio';
  const pack = sanitizePack(o.pack), spout = sanitizeSpout(o.spout);
  return {
    v: 1, kind: o.kind as TvKind, skin,
    height: Math.round(num(o.height, TV_HEIGHT.min, TV_HEIGHT.max, TV_HEIGHT.def) * 1000) / 1000,
    aspect: Math.round(num(o.aspect, 0.4, 3, 4 / 3) * 1000) / 1000,
    mirror: o.mirror === true,
    chroma: sanitizeChroma(o.chroma),
    bg, fit: o.fit === 'contain' ? 'contain' : 'cover',
    look: lookOf(o.look),
    motion: o.motion === 'lively' ? 'lively' : 'calm',
    ...(pack ? { pack } : {}),
    ...(spout ? { spout } : {}),
    ...(sanitizeFaceBox(o.face) ? { face: sanitizeFaceBox(o.face)! } : {}),
  };
}
function sanitizeSpout(v: unknown): TvSpoutInfo | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  return { native: o.native === true, alpha: o.alpha === true, app: typeof o.app === 'string' ? o.app.replace(/[^\w .+-]/g, '').slice(0, 24) : '' };
}

// ---------------------------------------------------------------- host settings (SceneState.modes[TV_BAG], every page)
/** The host's TV settings travel in the scene state's generic settings bag (shared/stage.ts sanitizeModeBags), so every
 *  OBS page (host + guests) and the Scene preview apply the same: `looks` = per member key: show them as a walking TV
 *  or a projector screen (overrides their own choice); `motion` = 'auto' (each performer's own) | 'calm' | 'lively';
 *  `cut` = Talk camera cuts to a projector guest while they speak. */
export const TV_BAG = 'tvguests';
export interface TvBag { looks: Record<string, TvLook>; motion: 'auto' | TvMotion; cut: boolean }
export function sanitizeTvBag(v: unknown): TvBag {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const looks: Record<string, TvLook> = {};
  if (o.looks && typeof o.looks === 'object') {
    for (const [k, l] of Object.entries(o.looks as Record<string, unknown>).slice(0, 16)) if (/^(@host|[a-z0-9]{6,32})$/.test(k) && TV_LOOKS.includes(l as TvLook)) looks[k] = l as TvLook;
  }
  return { looks, motion: o.motion === 'calm' || o.motion === 'lively' ? o.motion : 'auto', cut: o.cut !== false };
}
/** What a member really shows as on this page (host override first). */
export const effectiveLook = (t: TvInfo, bag: TvBag, key: string): TvLook => bag.looks[key] ?? t.look ?? 'tv';
export const effectiveMotion = (t: TvInfo, bag: TvBag): TvMotion => (bag.motion === 'auto' ? t.motion ?? 'calm' : bag.motion);

/** The profile-like object the scene's size code reads ({size:{height}}, shared/avatarSize.ts). */
export const tvSizeProfile = (t: TvInfo) => ({ size: { height: t.height } });

/** Party capability: peers that understand TV performers + their media link. */
export const TV_CAP = 'tv1';
/** Party capability: this app unpacks side-by-side alpha (TvInfo.pack) and knows the 'standee' look. */
export const TV_ALPHA_CAP = 'tva1';

/** Short line for member lists: "📺 webcam on a 80s wood-grain CRT". */
export function tvLabel(t: TvInfo, look: TvLook = t.look ?? 'tv'): string {
  const what = t.spout ? `Spout2${t.spout.app ? ` (${t.spout.app})` : ''}${t.spout.alpha ? ' with real alpha' : t.spout.native ? '' : ' via webcam bridge'}` : t.kind === 'vts' ? 'VTube Studio' : 'webcam';
  return look === 'projector' ? `📽 ${what} on a projector screen` : look === 'standee' ? `🧍 ${what} standing in the room` : `📺 ${what} on a ${tvSkin(t.skin).name}`;
}

// ---------------------------------------------------------------- wire: TV media signalling (party 'ctl' channel)
/** ctl messages of the TV media link (src/net/tv/tvLink.ts). `pc`: 'up' = guest → host (its own feed), 'down' = host →
 *  guest (everyone else's feeds, forwarded). Max 60 kB like every ctl message. */
export type TvSig =
  | { t: 'tvsig'; pc: 'up' | 'down'; k: 'offer' | 'answer'; sdp: string; map?: Record<string, string> }
  | { t: 'tvsig'; pc: 'up' | 'down'; k: 'ice'; cand: unknown }
  | { t: 'tvsig'; pc: 'up' | 'down'; k: 'bye' }
  | { t: 'tvsig'; pc: 'down'; k: 'need' };     // guest → host: (re)offer me the down link (after a failure / reload)

const MID = /^[A-Za-z0-9_-]{1,16}$/;
const PID = /^[a-z0-9@]{2,32}$/;
export function sanitizeTvSig(m: unknown): TvSig | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.t !== 'tvsig' || (o.pc !== 'up' && o.pc !== 'down')) return null;
  const pc = o.pc;
  switch (o.k) {
    case 'offer': case 'answer': {
      if (typeof o.sdp !== 'string' || o.sdp.length > 60_000) return null;
      let map: Record<string, string> | undefined;
      if (o.map && typeof o.map === 'object') {
        map = {};
        for (const [k, v] of Object.entries(o.map as Record<string, unknown>).slice(0, 16)) if (MID.test(k) && typeof v === 'string' && PID.test(v)) map[k] = v;
      }
      return { t: 'tvsig', pc, k: o.k, sdp: o.sdp, ...(map ? { map } : {}) };
    }
    case 'ice': {
      const c = o.cand;
      if (c !== null && (typeof c !== 'object' || JSON.stringify(c).length > 2000)) return null;
      return { t: 'tvsig', pc, k: 'ice', cand: c };
    }
    case 'bye': return { t: 'tvsig', pc, k: 'bye' };
    case 'need': return pc === 'down' ? { t: 'tvsig', pc: 'down', k: 'need' } : null;
  }
  return null;
}

// ---------------------------------------------------------------- speaking level (media link data channel 'lvl', ~15 Hz)
/** One byte per member: level 0..1 quantised to 0..250, 251+ reserved. Packet: [0x4c, n, (idLen, id bytes, level)×n]. */
export function encodeLevels(levels: [string, number][]): Uint8Array {
  const enc = new TextEncoder();
  const parts: number[] = [0x4c, Math.min(8, levels.length)];
  for (const [id, lv] of levels.slice(0, 8)) {
    const b = enc.encode(id.slice(0, 32));
    parts.push(b.length, ...b, Math.round(Math.min(1, Math.max(0, lv)) * 250));
  }
  return new Uint8Array(parts);
}
export function decodeLevels(u8: Uint8Array): [string, number][] {
  if (u8.length < 2 || u8[0] !== 0x4c) return [];
  const dec = new TextDecoder();
  const out: [string, number][] = [];
  let i = 2;
  for (let n = 0; n < Math.min(8, u8[1]) && i < u8.length; n++) {
    const len = u8[i++];
    if (len > 32 || i + len + 1 > u8.length) break;
    const id = dec.decode(u8.subarray(i, i + len)); i += len;
    const lv = u8[i++];
    if (PID.test(id)) out.push([id, Math.min(250, lv) / 250]);
  }
  return out;
}

// ---------------------------------------------------------------- feed health (receivers)
export type TvFeedState = 'none' | 'connecting' | 'live' | 'stalled' | 'lost';
/** No new frame for this long → 'stalled' (frozen picture, bad-signal look). */
export const TV_STALL_MS = 1200;
/** … and this long (or the track ended / link failed) → 'lost' (NO SIGNAL + static). */
export const TV_LOST_MS = 6000;
