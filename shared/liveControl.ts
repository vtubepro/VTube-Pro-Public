// Live Control (livedash): the one-screen "on air" surface. Pure data + helpers shared by the studio's Live area
// (src/ui/live/*), the pop-out window (live.html) and tools/live_unit.ts. Every button runs a Stream Deck action
// (shared/deck.ts DECK_ACTIONS via /ws/deck), so the in-app buttons and a physical deck share one registry.
//
// What the studio knows and the server does not (party members, knocks, outfits, emotes, tracking health) travels on
// the local bus as {type:'command', command:'liveStatus', args: LiveStatus} (~1 Hz, studio → pop-outs on this PC).

import { sanitizeShot, type ReactShotReport } from './reactShot.ts';

export const LIVE_STATUS_CMD = 'liveStatus';

export interface LiveMember { id: string; name: string; host: boolean; me: boolean; speaking: boolean; tv: boolean; verified: boolean; /** docked: a guest whose voice arrives here (link guest or app guest; can be muted). */ voice?: boolean; muted?: boolean;
  /** partyvoice: an APP guest's in-app voice — 'app' talking in VTube Pro, 'wait' connecting, 'discord' / 'off' their choice,
   *  'old' their app is too old for in-app voice (use Discord). Absent = the host / a link guest. */ vox?: 'app' | 'wait' | 'discord' | 'off' | 'old'; /** a Spout2 performer (shared/spout.ts) + its health */ spout?: LiveSpout;
  /** greenroom: waiting / on-air state, READY + messages, their mic mute, tech-check media (shared/greenroom.ts) */ gr?: LiveGreen;
  /** moderation (shared/moderation.ts): the host hid their camera / muted them; vol = their volume 0..1 (host view). */ mod?: LiveMod; vol?: number;
  /** moderation: a small live JPEG of an on-air guest's camera (host only; the real picture, even while it's hidden from the show). */ cam?: string }
/** moderation: one guest as the host decided (absent = untouched). `at` = when it last changed (epoch ms). */
export interface LiveMod { cam: boolean; mic: boolean; vol: number; at: number }
function liveMod(v: any): LiveMod | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const vol = Number(v.vol), at = Number(v.at);
  return { cam: !!v.cam, mic: !!v.mic, vol: Number.isFinite(vol) ? Math.min(1, Math.max(0, vol)) : 1, at: Number.isFinite(at) ? at : 0 };
}
const jpeg = (x: unknown) => (typeof x === 'string' && x.length < 60_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(x) ? x : '');
/** moderation: the panel's Undo strip + settings. */
export interface LiveModParty { hold: boolean; undo: number; last?: { label: string; at: number; kind: string } }
/** greenroom: one member as the host's green room sees them. Times are epoch ms (the panel shows "2 min ago"). */
export interface LiveGreen {
  /** In the green room (not in the scene); false = on air. */
  wait: boolean; since: number;
  /** Their page / app shows messages (else: an older page). */
  caps: boolean;
  /** Joined with the no-sign-in link. */
  link?: boolean;
  ready?: { text: string; at: number };
  note?: { text: string; at: number };
  /** Their mic is muted on their page (absent = unknown). */
  micOff?: boolean;
  /** Backstage voice with the host is on. */
  talk?: boolean;
  /** The last message the host sent them. */
  last?: { text: string; at: number };
  /** Tech check (waiting guests): a small JPEG of their camera, mic level 0..1, connection. */
  thumb?: string; level?: number;
  conn?: { st: 'good' | 'fair' | 'poor' | 'connecting'; rtt: number; video: string };
}
function liveGreen(v: any): LiveGreen | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const t = (x: any, n: number) => (typeof x === 'string' ? x.replace(/[\u0000-\u001f<>]/g, ' ').slice(0, n) : '');
  const at = (x: any) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const msg = (x: any, n: number) => (x && typeof x === 'object' && (typeof x.text === 'string') ? { text: t(x.text, n), at: at(x.at) } : undefined);
  const c = v.conn && typeof v.conn === 'object' ? v.conn : null;
  const thumb = typeof v.thumb === 'string' && v.thumb.length < 60_000 && /^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(v.thumb) ? v.thumb : '';
  const lv = Number(v.level);
  const r = msg(v.ready, 100), n = msg(v.note, 100), l = msg(v.last, 140);
  return {
    wait: !!v.wait, since: at(v.since), caps: !!v.caps, ...(v.link ? { link: true } : {}),
    ...(r ? { ready: r } : {}), ...(n ? { note: n } : {}), ...(typeof v.micOff === 'boolean' ? { micOff: v.micOff } : {}), ...(v.talk ? { talk: true } : {}), ...(l ? { last: l } : {}),
    ...(thumb ? { thumb } : {}), ...(Number.isFinite(lv) ? { level: Math.min(1, Math.max(0, lv)) } : {}),
    ...(c ? { conn: { st: c.st === 'good' || c.st === 'fair' || c.st === 'poor' ? c.st : 'connecting', rtt: Math.max(0, Math.min(99999, Math.round(at(c.rtt)))), video: t(c.video, 48) } } : {}),
  };
}
/** greenroom: the host's green room settings (Live panel → People). */
export interface LiveGreenSettings {
  /** Who waits when they join: 'link' (default) | 'all' | 'off'. */
  mode: 'link' | 'all' | 'off';
  /** Backstage voice output: this PC's speakers / headphones (id '' = the default device) and whether the browser can pick one. */
  sinks: { id: string; label: string }[]; sink: string; sinkOk: boolean;
  /** Backstage voice error (mic / output). */
  error?: string;
}
/** Spout2 performer health: real alpha (else keyed), VTube Pro's own receiver (else a webcam bridge), frames per second
 *  arriving (0 = unknown), live = frames are arriving. */
export interface LiveSpout { alpha: boolean; native: boolean; fps: number; live: boolean; app?: string }
function liveSpout(v: any): LiveSpout | undefined {
  if (!v || typeof v !== 'object') return undefined;
  const f = Number(v.fps);
  return { alpha: !!v.alpha, native: !!v.native, fps: Number.isFinite(f) ? Math.max(0, Math.min(240, Math.round(f))) : 0, live: !!v.live, ...(typeof v.app === 'string' && v.app ? { app: v.app.slice(0, 24) } : {}) };
}
/** guestlink: someone the host let in whose link is still coming up (`connecting`) or never came up / broke (`failed`). */
export interface LiveJoin { peer: string; name: string; link: boolean; state: 'connecting' | 'failed'; secs: number; lost: boolean }
/** One line the host can act on. Owner setup for TURN: TURN_SETUP. */
export const TURN_SETUP = 'Fix it once: open Set up my invite server and press Turn it on. Help: Set up your invite server, Step 4.';
/** The Help guide section TURN_SETUP points at. */
export const TURN_SETUP_HELP = 'HOSTING_SETUP.md#step-4-let-every-guest-connect';
export function joinText(j: Pick<LiveJoin, 'state' | 'secs' | 'lost'>, turn: boolean | null | undefined): string {
  if (j.state === 'connecting') return j.secs < 15 ? 'connecting…' : turn === false ? `still connecting (${j.secs} s) — no TURN on your relay, their network may block it` : `still connecting (${j.secs} s)…`;
  if (j.lost) return turn === false ? 'connection lost — if it keeps happening their network needs TURN' : 'connection lost — they can rejoin from their page';
  return turn === false ? 'couldn’t connect — their network needs TURN (mobile data / strict NAT). Set up TURN on your relay'
    : 'couldn’t connect even through TURN — ask them to try another network (home Wi-Fi, no VPN)';
}
/** Spout2 tag text (People tile): `SPOUT2 α 60`. */
export function spoutLabel(sp: LiveSpout): string { return `SPOUT2${sp.alpha ? ' α' : ''}${sp.live && sp.fps ? ` ${sp.fps}` : ''}`; }

/** What the Live panel's full rebuild depends on: the status with everything that changes all the time blanked out.
 *  Those values are painted in place instead (liveControl.ts paintHealth): tracking rate, mic and talk-back levels, who
 *  is speaking, camera / tech-check pictures, a waiting guest's connection dot, Spout2 fps, the graphics level that
 *  auto-lower picked, and how long a join has been connecting. Before, any of them changing rebuilt the whole panel —
 *  every second during a party — and each rebuild could nudge the PROGRAM frame the studio view sits on (owner
 *  2026-10-02: "things keep refreshing on the studio screen when I'm in a party"). */
export function paintKey(st: LiveStatus): unknown {
  const sp = (s: LiveSpout) => ({ ...s, fps: 0 });
  return {
    ...st, trackFps: 0, fps: 0, micLevel: 0,
    ...(st.voice ? { voice: { ...st.voice, level: 0, mix: st.voice.mix ? { state: st.voice.mix.state, routes: st.voice.mix.routes } : undefined } } : {}),
    ...(st.gfx ? { gfx: { ...st.gfx, now: '' } } : {}),
    me: { ...st.me, ...(st.me.spout ? { spout: sp(st.me.spout) } : {}) },
    party: {
      ...st.party,
      ...(st.party.joins ? { joins: st.party.joins.map((j) => ({ ...j, secs: 0 })) } : {}),
      members: st.party.members.map((m) => ({ ...m, speaking: false, cam: !!m.cam, ...(m.spout ? { spout: sp(m.spout) } : {}),
        ...(m.gr ? { gr: { ...m.gr, thumb: !!m.gr.thumb, level: m.gr.level !== undefined, conn: !!m.gr.conn } } : {}) })),
    },
  };
}

export interface LiveStatus {
  v: 1;
  tracking: boolean; face: boolean; trackFps: number; fps: number;
  mic: boolean; micLevel: number;
  obs: number;
  party: { role: 'none' | 'host' | 'guest'; members: LiveMember[]; knocks: { peer: string; name: string; link: boolean }[]; /** guestlink */ joins?: LiveJoin[]; /** guestlink: the relay hands out TURN (null = no relay) */ turn?: boolean | null; /** greenroom */ green?: LiveGreenSettings; /** moderation */ mod?: LiveModParty };
  me: { avatar: string; size: string; height: number; outfit: string | null; outfits: { id: string; name: string; /** livepremium: same-origin thumbnail URL (/library/...), when the costume has one. */ thumb?: string }[]; accessories: { id: string; name: string; on: boolean }[]; /** I appear as a Spout2 model (shared/spout.ts) */ spout?: LiveSpout };
  emotes: { id: string; label: string }[];
  /** Graphics quality presets (shared/graphics.ts): OBS / preview preset names, preview level in effect, auto-lower. */
  gfx?: { obs: string; preview: string; now: string; lower: boolean; scale: number };
  /** The room's own camera presets (CAM_* names; the built-in shots are always offered). */
  cams?: string[];
  /** The room on air is a Tabletop game room (its scene.json has `ttrpg`): only there can a game's table cut the camera. */
  table?: boolean;
  /** Link guests' voices: heard in the studio (host's headphones) / my voice sent back to them. */
  voice?: { hear: boolean; talkback: boolean; error: string; /** talk-back mic label + its level 0..1 */ mic?: string; level?: number;
    /** talk-back mic picker: this PC's mics + the chosen id ('' = same as lip sync) */ mics?: { id: string; label: string }[]; micSel?: string; /** also on the OBS page */ obs?: boolean;
    /** Party voice mixer (guest ↔ guest): state + per-listener outgoing level (diagnostics). */ mix?: { state: string; routes: Record<string, string[]>; levels: Record<string, number> } };
  /** React mode: is the React screen in the live camera's shot (the studio preview's fresh measurement; absent =
   *  unknown)? The Camera tile says plainly when it isn't (shared/reactShot.ts reactShotNote). */
  reactShot?: ReactShotReport;
}
export const EMPTY_STATUS: LiveStatus = {
  v: 1, tracking: false, face: false, trackFps: 0, fps: 0, mic: false, micLevel: 0, obs: 0,
  party: { role: 'none', members: [], knocks: [] }, me: { avatar: '', size: 'normal', height: 1.7, outfit: null, outfits: [], accessories: [] }, emotes: [],
};

/** Tolerant reader for a bus liveStatus (junk in → a valid status out). */
export function sanitizeStatus(v: unknown): LiveStatus {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, any>;
  const s = (x: unknown, n = 48) => (typeof x === 'string' ? x.slice(0, n) : '');
  const num = (x: unknown) => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
  const arr = (x: unknown, n: number) => (Array.isArray(x) ? x.slice(0, n) : []);
  const p = o.party ?? {}, me = o.me ?? {};
  return {
    v: 1, tracking: !!o.tracking, face: !!o.face, trackFps: num(o.trackFps), fps: num(o.fps), mic: !!o.mic, micLevel: Math.min(1, Math.max(0, num(o.micLevel))), obs: num(o.obs),
    party: {
      role: p.role === 'host' || p.role === 'guest' ? p.role : 'none',
      members: arr(p.members, 12).map((m: any) => ({ id: s(m?.id, 64), name: s(m?.name, 40) || 'Guest', host: !!m?.host, me: !!m?.me, speaking: !!m?.speaking, tv: !!m?.tv, verified: !!m?.verified, ...(m?.voice ? { voice: true, muted: !!m?.muted } : {}), ...(['app', 'wait', 'discord', 'off', 'old'].includes(m?.vox) ? { vox: m.vox } : {}), ...(liveSpout(m?.spout) ? { spout: liveSpout(m?.spout) } : {}), ...(liveGreen(m?.gr) ? { gr: liveGreen(m?.gr) } : {}), ...(liveMod(m?.mod) ? { mod: liveMod(m?.mod) } : {}), ...(Number.isFinite(Number(m?.vol)) && m?.vol !== undefined && m?.vol !== null ? { vol: Math.min(1, Math.max(0, Number(m.vol))) } : {}), ...(jpeg(m?.cam) ? { cam: jpeg(m?.cam) } : {}) })),
      knocks: arr(p.knocks, 8).map((k: any) => ({ peer: s(k?.peer, 64), name: s(k?.name, 40) || 'Someone', link: !!k?.link })),
      ...(Array.isArray(p.joins) ? { joins: arr(p.joins, 8).map((j: any) => ({ peer: s(j?.peer, 64), name: s(j?.name, 40) || 'Guest', link: !!j?.link, state: j?.state === 'failed' ? 'failed' as const : 'connecting' as const, secs: Math.max(0, Math.min(99999, Math.round(num(j?.secs)))), lost: !!j?.lost })) } : {}),
      ...(typeof p.turn === 'boolean' ? { turn: p.turn } : {}),
      ...(p.green && typeof p.green === 'object' ? { green: {
        mode: p.green.mode === 'all' || p.green.mode === 'off' ? p.green.mode : 'link' as const,
        sinks: arr(p.green.sinks, 16).map((d: any) => ({ id: s(d?.id, 128), label: s(d?.label, 80) || 'Speakers' })).filter((d: { id: string }) => d.id),
        sink: s(p.green.sink, 128), sinkOk: !!p.green.sinkOk, ...(p.green.error ? { error: s(p.green.error, 160) } : {}) } } : {}),
      ...(p.mod && typeof p.mod === 'object' ? { mod: { hold: !!p.mod.hold, undo: Math.max(0, Math.min(99, Math.round(num(p.mod.undo)))),
        ...(p.mod.last && typeof p.mod.last === 'object' ? { last: { label: s(p.mod.last.label, 80), at: num(p.mod.last.at), kind: s(p.mod.last.kind, 12) } } : {}) } } : {}),
    },
    me: {
      avatar: s(me.avatar, 60), size: s(me.size, 12) || 'normal', height: num(me.height) || 1.7, outfit: typeof me.outfit === 'string' ? me.outfit.slice(0, 64) : null,
      outfits: arr(me.outfits, 40).map((c: any) => { const t = s(c?.thumb, 300); return { id: s(c?.id, 64), name: s(c?.name, 40), ...(/^\/library\/[^"'<>\\\s]+$/.test(t) ? { thumb: t } : {}) }; }),
      accessories: arr(me.accessories, 40).map((c: any) => ({ id: s(c?.id, 64), name: s(c?.name, 40), on: !!c?.on })),
      ...(liveSpout(me.spout) ? { spout: liveSpout(me.spout) } : {}),
    },
    emotes: arr(o.emotes, 80).map((e: any) => ({ id: s(e?.id, 48), label: s(e?.label, 40) })),
    ...(o.table === true ? { table: true } : {}),
    ...(Array.isArray(o.cams) ? { cams: arr(o.cams, 24).filter((c: unknown): c is string => typeof c === 'string' && /^CAM_[A-Z0-9_]{1,40}$/.test(c)) } : {}),
    ...(o.voice && typeof o.voice === 'object' ? { voice: { hear: !!o.voice.hear, talkback: !!o.voice.talkback, error: s(o.voice.error, 120), mic: s(o.voice.mic, 80), level: Math.min(1, Math.max(0, num(o.voice.level))),
      mics: arr(o.voice.mics, 24).map((m: any) => ({ id: s(m?.id, 128), label: s(m?.label, 80) || 'Microphone' })).filter((m: { id: string }) => m.id), micSel: s(o.voice.micSel, 128), obs: !!o.voice.obs,
      ...(o.voice.mix && typeof o.voice.mix === 'object' ? { mix: { state: s(o.voice.mix.state, 12), routes: Object.fromEntries(Object.entries(o.voice.mix.routes ?? {}).slice(0, 12).map(([k, v]) => [s(k, 64), arr(v, 12).map((x: unknown) => s(x, 64))])), levels: Object.fromEntries(Object.entries(o.voice.mix.levels ?? {}).slice(0, 12).map(([k, v]) => [s(k, 64), Math.min(1, Math.max(0, num(v)))])) } } : {}) } } : {}),
    ...(o.gfx && typeof o.gfx === 'object' ? { gfx: { obs: s(o.gfx.obs, 12), preview: s(o.gfx.preview, 12), now: s(o.gfx.now, 12), lower: !!o.gfx.lower, scale: Math.min(1, Math.max(0.5, num(o.gfx.scale) || 1)) } } : {}),
    ...(sanitizeShot(o.reactShot) ? { reactShot: sanitizeShot(o.reactShot)! } : {}),
  };
}

// ---------------------------------------------------------------- tiles + customisation
export type TileId = 'scene' | 'camera' | 'guests' | 'chat' | 'me' | 'health';
export const TILES: { id: TileId; label: string }[] = [
  { id: 'scene', label: 'Scene' }, { id: 'camera', label: 'Camera' }, { id: 'guests', label: 'Guests' },
  { id: 'chat', label: 'Chat & polls' }, { id: 'me', label: 'Me' }, { id: 'health', label: 'Health' },
];
const TILE_IDS = new Set<string>(TILES.map((t) => t.id));

/** A pinned quick action (mini-bar / pinned row): a deck action + params + a short label. */
export interface LiveQuick { action: string; params?: Record<string, string | number>; label: string }
export interface LiveLayout { order: TileId[]; hidden: TileId[]; quick: LiveQuick[] }
export interface LivePreset { name: string; layout: LiveLayout; /** Optional show mode applied with the preset. */ mode?: string }

export const DEFAULT_QUICK: LiveQuick[] = [
  { action: 'lighting', params: { state: 'show' }, label: 'Show' },
  { action: 'lighting', params: { state: 'brb' }, label: 'BRB' },
  { action: 'cover', params: { on: 'toggle' }, label: 'Cover' },
  { action: 'interview', params: { shot: 'auto' }, label: 'Auto cam' },
  { action: 'hub-tts', label: 'Read-aloud' },
  { action: 'hub-ack-next', label: 'Ack next' },
  { action: 'poll-start', params: { template: 'Yes / No' }, label: 'Poll Y/N' },
  { action: 'recalibrate', label: 'Recalibrate' },
];
export const defaultLayout = (): LiveLayout => ({ order: TILES.map((t) => t.id), hidden: [], quick: DEFAULT_QUICK.map((q) => ({ ...q })) });

export const DEFAULT_PRESETS: LivePreset[] = [
  { name: 'Just chatting', mode: 'talk', layout: { order: ['scene', 'chat', 'me', 'health', 'camera', 'guests'], hidden: ['camera', 'guests'], quick: DEFAULT_QUICK.filter((q) => q.action !== 'interview') } },
  { name: 'Interview night', mode: 'interview', layout: { order: ['camera', 'guests', 'chat', 'scene', 'me', 'health'], hidden: [], quick: [
    { action: 'interview', params: { shot: 'auto' }, label: 'Auto cam' }, { action: 'interview', params: { shot: 'host' }, label: 'Host' },
    { action: 'interview', params: { shot: 'guest1' }, label: 'Guest 1' }, { action: 'interview', params: { shot: 'two' }, label: 'Two-shot' },
    { action: 'knock-approve', label: 'Let in' }, { action: 'hub-ack-next', label: 'Ack next' }, { action: 'lighting', params: { state: 'brb' }, label: 'BRB' }] } },
  { name: 'Gaming', mode: 'gaming', layout: { order: ['scene', 'chat', 'health', 'me', 'camera', 'guests'], hidden: ['camera'], quick: [
    { action: 'cover', params: { on: 'toggle' }, label: 'Cover' }, { action: 'lighting', params: { state: 'brb' }, label: 'BRB' },
    { action: 'hub-tts', label: 'Read-aloud' }, { action: 'hub-ack-next', label: 'Ack next' }, { action: 'poll-start', params: { template: '1–4' }, label: 'Poll 1–4' }, { action: 'poll-end', label: 'End poll' }] } },
];

const txt = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, n) : '');
function sanitizeQuick(v: unknown): LiveQuick | null {
  const o = (v && typeof v === 'object' ? v : null) as Record<string, unknown> | null;
  if (!o || typeof o.action !== 'string' || !/^[a-z][a-z0-9-]{1,31}$/.test(o.action)) return null;
  const q: LiveQuick = { action: o.action, label: txt(o.label, 24) || o.action };
  if (o.params && typeof o.params === 'object') {
    const p: Record<string, string | number> = {};
    for (const [k, x] of Object.entries(o.params as Record<string, unknown>).slice(0, 6)) if (/^[a-zA-Z]{1,16}$/.test(k) && (typeof x === 'string' || (typeof x === 'number' && Number.isFinite(x)))) p[k] = typeof x === 'string' ? x.slice(0, 64) : x;
    if (Object.keys(p).length) q.params = p;
  }
  return q;
}
export function sanitizeLayout(v: unknown): LiveLayout {
  const o = (v && typeof v === 'object' ? v : {}) as Record<string, unknown>;
  const order = (Array.isArray(o.order) ? o.order : []).filter((x): x is TileId => typeof x === 'string' && TILE_IDS.has(x));
  const uniq = [...new Set(order)];
  for (const t of TILES) if (!uniq.includes(t.id)) uniq.push(t.id); // a new tile shows up at the end
  const hidden = [...new Set((Array.isArray(o.hidden) ? o.hidden : []).filter((x): x is TileId => typeof x === 'string' && TILE_IDS.has(x)))];
  const quick = Array.isArray(o.quick) ? o.quick.slice(0, 12).map(sanitizeQuick).filter((x): x is LiveQuick => !!x) : DEFAULT_QUICK.map((q) => ({ ...q }));
  return { order: uniq, hidden, quick };
}
export function sanitizePresets(v: unknown): LivePreset[] {
  if (!Array.isArray(v)) return DEFAULT_PRESETS.map((p) => structuredClone(p));
  return v.slice(0, 12).map((x) => {
    const o = (x && typeof x === 'object' ? x : {}) as Record<string, unknown>;
    const name = txt(o.name, 32);
    if (!name) return null;
    const mode = txt(o.mode, 24);
    return { name, layout: sanitizeLayout(o.layout), ...(/^[a-z][a-z0-9-]{1,23}$/.test(mode) ? { mode } : {}) };
  }).filter((x): x is LivePreset => !!x);
}
export const quickKey = (q: Pick<LiveQuick, 'action' | 'params'>) => `${q.action}${q.params ? `:${Object.values(q.params).join(',')}` : ''}`;

// ---------------------------------------------------------------- Ctrl+K: run actions by typing
export interface CmdHit { label: string; action: string; params?: Record<string, string | number>; danger?: boolean }
export interface CmdContext { rooms: { id: string; name: string }[]; templates: string[]; outfits: { id: string; name: string }[]; emotes: { id: string; label: string }[]; /** Show mode now: outside Interview the scene camera hits rank above the Interview cuts. */ mode?: string }

const norm = (s: string) => s.toLowerCase().replace(/[’']/g, '').replace(/[^a-z0-9/ ]+/g, ' ').replace(/\s+/g, ' ').trim();
const NUM: Record<string, number> = { one: 1, two: 2, three: 3, four: 4, first: 1, second: 2, third: 3 };

/** Every action a typed line could mean, best first. Pure: the caller runs the one picked. */
export function parseCommand(input: string, ctx: CmdContext): CmdHit[] {
  const q = norm(input);
  if (q.length < 2) return [];
  const out: CmdHit[] = [];
  const add = (h: CmdHit) => { if (!out.some((x) => x.label === h.label)) out.push(h); };
  const has = (...w: string[]) => w.some((x) => q.includes(x));
  const n = (() => { const m = /\b([1-8])\b/.exec(q) ?? new RegExp(`\\b(${Object.keys(NUM).join('|')})\\b`).exec(q); return m ? (NUM[m[1]] ?? Number(m[1])) : 0; })();
  const off = /\b(off|stop|hide|end)\b/.test(q), on = /\b(on|start|show)\b/.test(q);

  // co-hosts: roles first ("make guest 2 co-host", "co-host 1 back to guest"), then the cuts
  const coWord = has('cohost', 'co host');
  if (coWord && n >= 1 && n <= 4 && has('make', 'promote', 'set') && has('guest') && !/\b(a guest|to guest|back)\b/.test(q)) add({ label: `Make guest ${n} a co-host`, action: 'interview-role', params: { who: `guest${n}`, role: 'cohost' } });
  if (coWord && n >= 1 && n <= 2 && (has('demote', 'a guest', 'to guest', 'back to guest'))) add({ label: `Co-host ${n} back to a guest`, action: 'interview-role', params: { who: `cohost${n}`, role: 'guest' } });
  if (coWord && n >= 1 && n <= 2 && !has('make', 'promote', 'demote', 'guest')) add({ label: `Cut to co-host ${n}`, action: 'interview', params: { shot: `cohost${n}` } });
  if (has('hosts', 'both hosts', 'host and cohost', 'host and co host')) add({ label: 'Cut to the hosts (you + a co-host)', action: 'interview', params: { shot: 'hosts' } });
  if (has('panel')) add({ label: 'Cut to the panel (everyone at the desk)', action: 'interview', params: { shot: 'panel' } });
  // camera cuts
  if (has('cut', 'cam', 'shot', 'camera', 'director')) {
    if (has('auto')) add({ label: 'Camera: auto director', action: 'interview', params: { shot: 'auto' } });
    if (has('manual')) add({ label: 'Camera: manual director', action: 'interview', params: { shot: 'manual' } });
  }
  // (moderation words — mute / hide / volume / ban / panic / “cut off” — never mean a camera cut)
  const modWord = /\b(mute|unmute|hide|volume|ban|block|panic|kill)\b/.test(q) || has('cut off', 'cut both', 'camera off', 'cam off');
  if (has('guest') && n >= 1 && n <= 4 && !has('kick', 'remove', 'studio', 'monitor', 'seat') && !coWord && !modWord) add({ label: `Cut to guest ${n}`, action: 'interview', params: { shot: `guest${n}` } });
  if (/\b(host|me)\b/.test(q) && has('cut', 'shot', 'cam') && !coWord) add({ label: 'Cut to host', action: 'interview', params: { shot: 'host' } });
  if (has('two shot', 'twoshot', '2 shot', 'two-shot')) add({ label: 'Cut to two-shot', action: 'interview', params: { shot: 'two' } });
  if (has('wide') && !has('house')) add({ label: 'Cut to wide', action: 'interview', params: { shot: 'wide' } });
  // (Interview: the room's house camera / the chat audience - a page whose room lacks them shows the room wide)
  if (has('house') && has('wide', 'cam', 'shot', 'cut')) add({ label: 'Cut to the house wide', action: 'interview', params: { shot: 'house' } });
  if (has('audience', 'crowd') && has('cut', 'cam', 'shot', 'camera', 'show')) add({ label: 'Cut to the audience', action: 'interview', params: { shot: 'audience' } });
  if (has('establish')) add({ label: 'Cut to establishing', action: 'interview', params: { shot: 'establishing' } });
  if (has('show open', 'bumper')) add({ label: 'Play show open', action: 'interview', params: { shot: 'bumper' } });
  if (has('pin') && has('shot', 'cam', 'camera', 'this')) add({ label: 'Pin the shot on air (again: back to auto)', action: 'interview', params: { shot: 'pin' } });
  if (has('guest') && has('turn', 'floor', 'talking')) add({ label: 'The guest’s turn (cut to them, keep them as the speaker)', action: 'interview', params: { shot: 'turn-guest' } });
  if (has('my turn')) add({ label: 'My turn (cut to me, keep me as the speaker)', action: 'interview', params: { shot: 'turn-host' } });
  for (const p of ['calm', 'normal', 'snappy']) if (has('pace') && has(p)) add({ label: `Interview pace: ${p}`, action: 'interview', params: { shot: `pace-${p}` } });
  // guests
  if (has('guest') && n >= 1 && n <= 4 && has('studio', 'seat')) add({ label: `Guest ${n}: in studio`, action: 'guest-place', params: { guest: n, where: 'studio' } });
  if (has('guest') && n >= 1 && n <= 4 && has('monitor', 'screen')) add({ label: `Guest ${n}: on monitor`, action: 'guest-place', params: { guest: n, where: 'monitor' } });
  // moderation: instant (no confirm) — the panel keeps an Undo
  if (has('cut all', 'cut everyone', 'panic', 'emergency', 'kill all', 'everyone off')) add({ label: 'Cut all guests (camera + mic, everyone)', action: 'guests-cut-all', params: { on: 'true' } });
  if (has('bring everyone back', 'everyone back', 'uncut all', 'restore all', 'all back on')) add({ label: 'Bring all guests back on', action: 'guests-cut-all', params: { on: 'false' } });
  if (/\bundo\b/.test(q)) add({ label: 'Undo the last guest camera / mic change', action: 'guest-undo' });
  const camWord = has('camera', 'cam', 'video', 'picture');
  if (n >= 1 && camWord && /\b(hide|off|kill|block)\b/.test(q) && !has('cut to')) add({ label: `Hide party member ${n}’s camera`, action: 'guest-cam', params: { guest: n, on: 'true' } });
  if (n >= 1 && camWord && /\b(show|unhide|back|on)\b/.test(q) && !has('cut to')) add({ label: `Show party member ${n}’s camera again`, action: 'guest-cam', params: { guest: n, on: 'false' } });
  if (n >= 1 && /\bunmute\b/.test(q)) add({ label: `Unmute party member ${n}`, action: 'guest-mute', params: { guest: n, on: 'false' } });
  else if (n >= 1 && /\bmute\b/.test(q)) add({ label: `Mute party member ${n}`, action: 'guest-mute', params: { guest: n, on: 'true' } });
  if (n >= 1 && (has('cut off', 'cut both', 'panic', 'kill') || (/\bcut\b/.test(q) && !/\bcut to\b/.test(q) && has('mic', 'both')))) add({ label: `Cut party member ${n} (camera + mic)`, action: 'guest-cut', params: { guest: n, on: 'true' } });
  if (n >= 1 && has('volume', 'vol ')) { const pct = /\b(\d{1,3})\s*%?\s*$/.exec(q)?.[1]; if (pct && +pct !== n) add({ label: `Party member ${n}: volume ${Math.min(100, +pct)}%`, action: 'guest-volume', params: { guest: n, vol: Math.min(100, +pct) } }); }
  if (has('ban', 'block') && !camWord && n >= 1) add({ label: `Kick + block party member ${n}`, action: 'guest-kick', params: { guest: n, ban: 'true' }, danger: true });
  if (has('kick', 'remove')) add({ label: n ? `Kick party member ${n}` : 'Kick party member 1', action: 'guest-kick', params: { guest: n || 1 }, danger: true });
  if (has('let in', 'approve', 'knock', 'admit')) add({ label: 'Let in (knock)', action: 'knock-approve' });
  if (has('deny')) add({ label: 'Deny (knock)', action: 'knock-deny' });
  if (has('end party', 'close party')) add({ label: 'End party', action: 'party-end', danger: true });
  if (has('link', 'invite')) add({ label: 'Copy guest link', action: 'guest-link' });
  // greenroom: bring guests on / back, the next guest, messages to them
  if (has('next guest', 'bring on', 'bring in', 'bring up')) add({ label: n ? `Bring on party member ${n}` : 'Bring on the next guest', action: 'greenroom-on', params: n ? { guest: n } : {} });
  if (has('next guest')) add({ label: 'Next guest (swap: last one back, next one on)', action: 'greenroom-next' });
  if (has('green room', 'greenroom', 'backstage', 'waiting room') && !has('talk')) add({ label: 'Back to the green room (last guest brought on)', action: 'greenroom-back' });
  if (has('up next')) add({ label: 'Message the next guest: “You’re up next”', action: 'greenroom-msg', params: { preset: 'next' } });
  if (has('1 minute', 'one minute', 'in a minute', '1 min')) add({ label: 'Message the next guest: “Going on in 1 minute”', action: 'greenroom-msg', params: { preset: 'minute' } });
  if (has('youre live', 'you are live', 'live now')) add({ label: 'Message the last guest on: “You’re live now!”', action: 'greenroom-msg', params: { preset: 'live', to: 'last' } });
  if (has('hang tight', 'hold on', 'one moment', 'a moment')) add({ label: 'Message the green room: “Hang tight a moment”', action: 'greenroom-msg', params: { preset: 'hold', to: 'all' } });
  // live-tabs: privacy (hide my screen / hide chat) and transitions (camera cut / glide, room transition style)
  const chatW = /\bchat\b/.test(q) && !has('poll', 'hub', 'read'), screenW = has('screen', 'privacy') && !has('camera', 'cam ', 'frame');
  if (chatW && (has('hide', 'off') || /\bstop\b/.test(q))) add({ label: 'Hide chat on stream', action: 'chat-hide', params: { on: 'true' } });
  if (chatW && has('show', 'unhide', 'bring back', 'back on')) add({ label: 'Show chat on stream again', action: 'chat-hide', params: { on: 'false' } });
  if (screenW && has('hide', 'privacy', 'cover')) add({ label: 'Hide my screen (capture cover on)', action: 'cover', params: { on: 'true' } });
  if (screenW && has('show', 'unhide', 'uncover')) add({ label: 'Show my screen again (capture cover off)', action: 'cover', params: { on: 'false' } });
  if (has('hard cut', 'camera cut', 'cut cameras', 'no glide', 'cuts only')) add({ label: 'Camera changes: cut', action: 'camera-move', params: { secs: 0 } });
  if (has('glide', 'smooth camera', 'camera move')) add({ label: 'Camera changes: smooth glide', action: 'camera-move', params: { secs: 1.2 } });
  if (has('transition')) {
    if (has('no transition', 'none')) add({ label: 'Room transition: none (cut)', action: 'transition', params: { style: 'cut' } });
    if (has('dark')) add({ label: 'Room transition: VTube Pro Dark', action: 'transition', params: { style: 'vtp-dark' } });
    if (has('light')) add({ label: 'Room transition: VTube Pro Light', action: 'transition', params: { style: 'vtp-light' } });
    if (has('shuffle', 'random')) add({ label: 'Room transition: shuffle', action: 'transition', params: { style: 'shuffle' } });
    if (has('wait', 'hold')) add({ label: 'Room transition: wait for me (on / off)', action: 'transition', params: { style: 'keep', hold: 'toggle' } });
  }
  // live-tabs BRB card look ("brb light", "brb dark", "brb dots" …); "brb" itself = the BRB lighting below
  if (/\bbrb\b/.test(q) || has('be right back')) {
    if (/\blight\b/.test(q)) add({ label: 'BRB card: Light theme', action: 'brb-card', params: { theme: 'light' } });
    if (/\bdark\b/.test(q)) add({ label: 'BRB card: Dark theme', action: 'brb-card', params: { theme: 'dark' } });
    for (const [w, id, l] of [['breathe', 'breathe', 'Breathe'], ['sweep', 'sweep', 'Light sweep'], ['dots', 'dots', 'Bouncing dots']] as const) if (has(w)) add({ label: `BRB card: ${l}`, action: 'brb-card', params: { style: id, theme: 'keep' } });
  }
  // lighting / scene
  for (const st of ['preshow', 'show', 'react', 'brb', 'outro']) if (new RegExp(`\\b${st}\\b`).test(q) && !has('poll', 'card') && !(st === 'show' && (chatW || screenW))) add({ label: `Lighting: ${st === 'brb' ? 'BRB' : st[0].toUpperCase() + st.slice(1)}${st === 'brb' && off ? ' (back: Show)' : ''}`, action: 'lighting', params: { state: st === 'brb' && off ? 'show' : st } });
  if (has('be right back')) add({ label: 'Lighting: BRB', action: 'lighting', params: { state: 'brb' } });
  for (const m of ['talk', 'react', 'gaming', 'interview', 'ttrpg']) if (new RegExp(`\\b${m}\\b`).test(q) && has('mode', m === 'gaming' || m === 'interview' || m === 'ttrpg' ? m : '\u0000')) add({ label: `Show mode: ${m}`, action: 'mode', params: { mode: m } });
  if (has('cover')) add({ label: `Capture cover ${on ? 'on' : off ? 'off' : 'on / off'}`, action: 'cover', params: { on: on ? 'true' : off ? 'false' : 'toggle' } });
  if (has('curtain', 'reveal')) add({ label: 'Reveal room (curtain)', action: 'curtain' });
  if (has('video')) add({ label: `Background video ${off ? 'off' : on ? 'on' : 'play / stop'}`, action: 'video', params: { action: off ? 'off' : on ? 'on' : 'toggle' } });
  if (has('camera', 'cam', 'shot') && !has('interview', 'guest', 'host')) {
    for (const [w, cam, l] of [['wide', 'wide', 'Wide'], ['group', 'group', 'Group'], ['screen', 'screen', 'Screen (centred)'], ['close', 'talk', 'Close-up'], ['auto', 'auto', 'Auto']] as const) if (has(w)) add({ label: `Camera: ${l}`, action: 'camera', params: { cam } });
  }
  if (has('walk in', 'walk-in', 'walkin', 'entrance')) add({ label: `Walk-ins ${off ? 'off' : on ? 'on' : 'on / off'}`, action: 'entrances', params: { walk: off ? 'false' : on ? 'true' : 'toggle' } });
  if (has('area', 'next area')) add({ label: 'Next room area', action: 'area', params: { area: 'next' } });
  // hangout lounge celebrations (tests: "lounge tier 4", "gift train 20", "test donation", "calm lounge")
  if (has('lounge', 'donation', 'celebrat', 'gift', 'firework', 'balloon', 'champagne')) {
    const t = /\b(?:tier|t)\s*([1-5])\b/.exec(q)?.[1];
    const cnt = /\b(\d{1,3})\b/.exec(q)?.[1];
    if (has('calm')) add({ label: 'Lounge: calm on / off', action: 'lounge', params: { event: 'calm' } });
    if (has('gift train', 'train')) add({ label: `Lounge test: gift train ×${cnt && +cnt >= 2 ? cnt : 20}`, action: 'lounge', params: { event: 'train', count: cnt && +cnt >= 2 ? +cnt : 20 } });
    else if (has('gift')) add({ label: `Lounge test: ${cnt ? cnt : 5} gifted subs`, action: 'lounge', params: { event: 'gift', count: cnt ? +cnt : 5 } });
    if (t) add({ label: `Lounge test: tier ${t}`, action: 'lounge', params: { event: `t${t}` } });
    else if (!has('calm', 'gift', 'train')) for (const k of [3, 1, 4]) add({ label: `Lounge test: tier ${k}${k === 4 ? ' (room-wide)' : ''}`, action: 'lounge', params: { event: `t${k}` } });
    if (/\b(off|on)\b/.test(q) && has('lounge')) add({ label: 'Lounge events on / off', action: 'lounge', params: { event: 'toggle' } });
  }
  if (has('room', 'go to')) for (const r of ctx.rooms) if (norm(r.name).split(' ').some((w) => w.length > 2 && q.includes(w))) add({ label: `Go to room: ${r.name}`, action: 'room', params: { sceneId: r.id } });
  // chat + polls
  if (has('tts', 'read aloud', 'readaloud', 'read-aloud')) add({ label: 'Read-aloud on / off', action: 'hub-tts' });
  // (a whole word: "tracking", "back", "feedback" are not "ack")
  if (/\back(nowledge|s)?\b/.test(q)) add({ label: /\ball\b/.test(q) ? 'Acknowledge all' : 'Acknowledge next', action: /\ball\b/.test(q) ? 'hub-ack-all' : 'hub-ack-next' });
  if (has('thank')) add({ label: 'Thank next', action: 'hub-thank-next' });
  if (has('poll', 'vote')) {
    if (off) add({ label: 'End poll', action: 'poll-end' });
    if (has('yes', 'y/n', 'yes/no', 'yn')) add({ label: 'Start poll: Yes / No', action: 'poll-start', params: { template: 'Yes / No' } });
    if (has('1 4', '1-4', '1–4', 'four', 'options')) add({ label: 'Start poll: 1–4', action: 'poll-start', params: { template: '1–4' } });
    for (const t of ctx.templates) if (q.includes(norm(t)) || norm(t).split(' ').some((w) => w.length > 3 && q.includes(w))) add({ label: `Start poll: ${t}`, action: 'poll-start', params: { template: t } });
    if (!off) add({ label: 'Start poll (last saved / Yes-No)', action: 'poll-start', params: { template: '' } });
  }
  // me
  if (has('recalib', 'calibrate', 'recenter', 're centre', 'recentre')) add({ label: 'Recalibrate face', action: 'recalibrate' });
  if (has('outfit', 'costume', 'wear')) for (const c of ctx.outfits) if (norm(c.name).split(' ').some((w) => w.length > 2 && q.includes(w))) add({ label: `Outfit: ${c.name}`, action: 'costume', params: { id: c.id } });
  if (has('emote', 'wave', 'dance')) for (const e of ctx.emotes) if (norm(e.label).split(' ').some((w) => w.length > 2 && q.includes(w)) || q.includes(e.id)) add({ label: `Emote: ${e.label}`, action: 'emote', params: { name: e.id } });
  if (has('stop emote')) add({ label: 'Stop emote', action: 'emote', params: { name: 'stop' } });
  // beta.12: face expressions for a few seconds (the studio's presets; the 1-9 keys show the same ones)
  for (const [w, name] of [['smile', 'Smile'], ['grin', 'Big grin'], ['surprise', 'Surprised'], ['wow', 'Surprised'], ['angry', 'Angry'], ['mad face', 'Angry'], ['sad', 'Sad'], ['wink', 'Wink']] as const) {
    if (new RegExp(`(^| )${w}`).test(q) && !out.some((x) => x.action === 'expression' && x.params?.name === name)) add({ label: `Expression: ${name}`, action: 'expression', params: { name, seconds: 3 } });
  }
  // (Talk / React / Gaming …: "camera wide" means the scene camera — the Interview cuts do nothing outside Interview)
  if (ctx.mode && ctx.mode !== 'interview') out.sort((a, b) => (a.action === 'camera' ? 0 : a.action === 'interview' ? 2 : 1) - (b.action === 'camera' ? 0 : b.action === 'interview' ? 2 : 1));
  return out.slice(0, 8);
}
