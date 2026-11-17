// Multiplayer ("party"): up to 8 performers on one screen, each running VTube Pro on their own PC.
// Full design + honest limits: docs/MULTIPLAYER_DISCORD.md.
//
// Connecting
//  * Discord (default): the host signs in with Discord and posts an invite; a guest clicks Join in Discord, signs in
//    on the host's relay Worker (guild / role allow-list), lands on their own VTube Pro (/join) and agrees on a
//    consent screen. The relay (relay/, one Durable Object per room) only carries the WebRTC handshake (SDP + ICE)
//    and knock / approve / kick; short-lived TURN credentials make connections work behind strict NATs.
//  * Advanced: the original copy/paste INVITE + REPLY codes (public STUN only, no relay at all).
//  * Star topology: guests only talk to the host; the host relays everyone to everyone.
//
// What travels (all inside WebRTC DTLS; TURN / the relay never see it in the clear)
//  * 'ctl'  reliable JSON: hello / roster / scene / beats / kick / pings.
//  * 'rt'   UNRELIABLE unordered: binary tracking frames (20 Hz) and voice-mouth samples (50 Hz, redundant) —
//           a lost packet costs one frame, never a stall. Receivers smooth them (src/net/remoteSmoother.ts).
//  * 'bin'  reliable: the avatar model + worn costume (GLB/VRM ≤ 256 MB) — only with the owner's consent, and the
//           host re-shares a member's avatar only as that owner allows (everyone / verified server members / nobody).
//           Transfers carry an id + size + CRC-32 and the receiver acks or reports the exact failure; the sender
//           resumes / resends with backoff, and a receiver that sees "sharing" but no model asks for it (the resolver,
//           shared/partyXfer.ts, 'xf1'; older peers keep the legacy format and show as outdated).
//  * Polycount limit (shared/modelStats.ts): the host sets its party's maximum triangles per avatar (model + worn
//    costume, default 200,000; 'limits' message). Owners check their own model before sending (over = not sent, reason
//    'tris:<count>' shown to everyone); receivers count again before sealing and refuse an over-limit model.
//    Over the limit, the studio shares an automatic PARTY VERSION instead (server/partyLod.ts: region-weighted,
//    index-only reduction in the avatar's own folder; the original is never touched) — 'vtp.mp.autoLod' (default on).
//
// Green room (shared/greenroom.ts, src/net/greenRoom.ts, 'gr1'): the host can hold an approved guest out of the scene
// (fully connected: camera, mic level, connection for a tech check; not in the roster other members / this PC's OBS
// pages get, no TV forwards, no voice on stream) until they are brought on; host ↔ guest messages ride 'ctl' {t:'gr'}.
//
// Host moderation (shared/moderation.ts, src/net/moderation.ts, 'mod1'): the host hides a guest's camera (a "Camera off"
// card goes to every output instead), mutes them (no voice on stream or in anyone's mix), sets their volume, or cuts
// one / everyone at once, with Undo. Enforced HERE, on the host, by a stable identity; the guest is told ({t:'mod'} on
// 'ctl' + the relay) and their page locks its own unmute until the host lifts it.
//
// TV performers (webcam / VTube Studio on a walking TV, shared/tv.ts, src/net/tv/*): 'tv1' peers announce a `tv` field
// in hello / profile / roster and carry the live video on SEPARATE media PeerConnections signalled over 'ctl'
// ({t:'tvsig'}, src/net/tv/tvLink.ts) — the party link itself is never renegotiated. A TV member shares no model.
//
// Party voice ('vox1', shared/partyVoice.ts, src/net/voice/*): app guests talk in VTube Pro without Discord — one audio
// PeerConnection per guest (guest offers; {t:'vsig'} over 'ctl'; mic up, the host's mix-minus back), same pattern as the
// TV links. Older peers never see a 'vsig' and the UI says "too old for in-app voice — use Discord".
//
// Model custody: a received model is checked, sealed with a per-member AES-GCM key, zeroed, and parked as
// ciphertext in the local server's RAM vault for this PC's OBS pages (src/net/custody.ts, server/partyVault.ts).
// Never written to disk, never exportable, purged when the member leaves / the party ends / the app stops. Not DRM:
// a PC that renders a model necessarily has its geometry + textures in (GPU) memory.
import type { AvatarProfile, CostumeDef, DiscordIdentity, MessStyle, PartyMember, SceneState, SharePolicy, SnackFrame, SnackHand, TrackingFrame, VaultRef, VoiceSample } from '../shared/types.ts';
import { sanitizeSceneState } from '../shared/scene.ts';
import { sanitizeBeatPacket, type BeatPacket } from '../shared/lightShow.ts';
import { sanitizeCue, type InterviewCue } from '../shared/talkshow.ts';
import { PKT_FRAME, PKT_RELAY, PKT_VOICE, decodeFrame, decodeVoice, encodeFrame, encodeVoice, glbProblem, sanitizeGuestProfile, topVisemes, unwrapRelay, wrapRelay } from '../shared/partyWire.ts';
import { quietFrame, quietVoice } from '../shared/audioMix.ts';
import { api } from './api.ts';
import type { Bus } from './bus.ts';
import { SealKey, vault, wipe } from './net/custody.ts';
import { TRIS_MAX, TRIS_WARN, clampTrisLimit, fmtTris, glbStats, trisOfWhy, trisWhy, type PartyLodStatus } from '../shared/modelStats.ts';
import { ACC_CAP, PARTY_MAX_MODEL, SET_MAX_PIECES, XF_BEGIN, XF_CAP, XF_DATA, XF_END, XF_LATE_MS, XF_MISSING_MS, XF_STALL_MS, XF_TRIES, binHeader, checksum, crc32, decBegin, decData, decEnd, encBegin, encData, encEnd, fmtMB, isCostumeSet, newXferId, packSet, sumHex, unpackSet, xfBackoff, xfFinal, xfWhyText, type SetPiece, type XfState, type XfView } from '../shared/partyXfer.ts';
import { RelayClient, peekTicket, toIdentity, type Knock, type SignalData, type Welcome } from './net/relayClient.ts';
import { discord } from './net/discordClient.ts';
import { RemoteSmoother, type LinkStats } from './net/remoteSmoother.ts';
import { TV_ALPHA_CAP, TV_CAP, sanitizeTvInfo, tvSizeProfile, type TvInfo, type TvSig } from '../shared/tv.ts';
import { TvLinks } from './net/tv/tvLink.ts';
import { TvStudio } from './net/tv/tvStudio.ts';
import { GR_CAP, GreenRoom } from './net/greenRoom.ts';
import { VOX_CAP, memberVoxState, type VoxMemberState, type VoxSig } from '../shared/partyVoice.ts';
import { PartyVoice } from './net/voice/partyVoice.ts';
import { MOD_CAP, Moderation } from './net/moderation.ts';
import { isObserverTab } from './ui/observerMode.ts';
import { sanitizeFlatCue } from '../shared/flatAvatar.ts';
import { packOwnFlatAvatar } from './avatar/flat/pack.ts';

const MAX_GUESTS = 7;
/** How long OBS keeps a member's last look while the outfit / costume set they announced is on its way (sealProfile). */
const SEAL_WAIT_MS = 15_000;
const MAX_MODEL = PARTY_MAX_MODEL;   // 256 MB: custom VRMs with 4K textures are often 70–150 MB (the vault takes the same)
const CHUNK = 16 * 1024;
const FRAME_HZ = 20;
const VOICE_MS = 20;
const ICE_PUBLIC: RTCIceServer[] = [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }];
const CAPS = ['rt1', XF_CAP, TV_CAP, 'trail1', TV_ALPHA_CAP, GR_CAP, VOX_CAP, MOD_CAP, ACC_CAP];   // ACC_CAP 'acc1': costume sets — outfit + accessories in one 'c' transfer (shared/partyXfer.ts); apps before it keep only the first 8 caps, so new caps go LAST and they simply never see them; this app keeps 16   // MOD_CAP 'mod1': host moderation notices (shared/moderation.ts)   // VOX_CAP 'vox1': in-app voice for app guests (shared/partyVoice.ts) — peers keep ≤ 8 caps   // GR_CAP 'gr1': green room + messages (shared/greenroom.ts)   // TV_ALPHA_CAP 'tva1': unpacks Spout2 alpha (shared/spout.ts)   // 'trail1': party games (src/game/trail — the Trail's 'game' ctl + 0x54 / 0x49 rt packets)
/** Shown in the diagnostics dump (which party code a studio runs). */
const PARTY_BUILD = 'mpfix-2026-09-26';
const rid = (n = 12) => Array.from(crypto.getRandomValues(new Uint8Array(n)), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
const PID = /^[a-z0-9]{6,32}$/;
/** Hosted Discord room, kept per tab so a studio reload (HMR, F5, crash-reload) rejoins the SAME room and the
 *  join link people already have keeps working (the relay keeps a room 3 min after the host's socket drops). */
const HOST_ROOM_KEY = 'vtp.mp.hostRoom';
/** WebRTC 'disconnected' is often transient (wifi blip, NAT rebinding): wait this long before giving up on a link. */
const DISCONNECT_GRACE_MS = 10_000;
const TURN_HELP = 'open Set up my invite server and press Turn it on (Help: Set up your invite server, Step 4)';
const isPolicy = (v: unknown): v is SharePolicy => v === 'party' || v === 'guild' || v === 'host';

// ---------------------------------------------------------------- invite codes (deflate + base64url)
async function pack(o: unknown): Promise<string> {
  const raw = new Blob([JSON.stringify(o)]).stream().pipeThrough(new CompressionStream('deflate-raw'));
  const bytes = new Uint8Array(await new Response(raw).arrayBuffer());
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return 'VTP1.' + btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function unpack<T>(code: string): Promise<T> {
  const c = code.trim();
  if (!c.startsWith('VTP1.') || c.length > 20000) throw new Error('Not a VTube Pro party code');
  const b64 = c.slice(5).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  const out = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  return JSON.parse(await new Response(out).text()) as T;
}
async function gathered(pc: RTCPeerConnection) {
  if (pc.iceGatheringState === 'complete') return;
  await new Promise<void>((res) => {
    const t = setTimeout(res, 4000);
    pc.addEventListener('icegatheringstatechange', () => { if (pc.iceGatheringState === 'complete') { clearTimeout(t); res(); } });
  });
}

// ---------------------------------------------------------------- frame sanitising / compaction
const KEY = /^[A-Za-z0-9_]{1,48}$/;
const fin = (v: unknown, lo = -1e3, hi = 1e3) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : 0);
const r3 = (v: number) => Math.round(v * 1000) / 1000;
function numMap(o: unknown, max = 160, lo = -10, hi = 10, dropZero = false): Record<string, number> {
  const out: Record<string, number> = {};
  if (!o || typeof o !== 'object') return out;
  let n = 0;
  for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
    if (n >= max || !KEY.test(k)) continue;
    const x = r3(fin(v, lo, hi));
    if (dropZero && x === 0) continue;
    out[k] = x; n++;
  }
  return out;
}
function vec(o: unknown, n: number, lo = -100, hi = 100): number[] {
  const a = Array.isArray(o) ? o : [];
  return Array.from({ length: n }, (_, i) => r3(fin(a[i], lo, hi)));
}
/** Keep only what an avatar needs, as plain rounded numbers (also used to CLEAN received frames). */
export function sanitizeFrame(f: unknown): TrackingFrame {
  const x = (f ?? {}) as Record<string, unknown>;
  const bones: Record<string, [number, number, number, number]> = {};
  if (x.bones && typeof x.bones === 'object') {
    let n = 0;
    for (const [k, v] of Object.entries(x.bones as Record<string, unknown>)) {
      if (n++ >= 80 || !KEY.test(k)) continue;
      const q = vec(v, 4, -1, 1);
      bones[k] = [q[0], q[1], q[2], q[3]];
    }
  }
  const lips = x.lips as { u?: unknown; l?: unknown } | undefined;
  return {
    t: fin(x.t, 0, 1e9),
    face: numMap(x.face, 160, -2, 2, true),
    head: vec(x.head, 3, -4, 4) as TrackingFrame['head'],
    headPos: vec(x.headPos, 3, -5, 5) as TrackingFrame['headPos'],
    gaze: vec(x.gaze, 2, -2, 2) as TrackingFrame['gaze'],
    mouth: numMap(x.mouth, 24, -2, 2) as unknown as TrackingFrame['mouth'],
    visemes: x.visemes && typeof x.visemes === 'object' ? numMap(x.visemes, 24, 0, 1) : undefined,
    tracked: x.tracked === true,
    lips: lips && Array.isArray(lips.u) && Array.isArray(lips.l) ? { u: vec(lips.u, 7, -2, 2), l: vec(lips.l, 7, -2, 2) } : undefined,
    bones: Object.keys(bones).length ? bones : undefined,
    snack: sanitizeSnack(x.snack),
    emote: wireEmote((x.snack as { e?: unknown } | undefined)?.e),
    // 2D avatars: the expression / motion hotkey cue (rides in the snack JSON as `fl`, like emotes: old peers ignore it)
    flat: sanitizeFlatCue((x.snack as { fl?: unknown } | undefined)?.fl ?? x.flat),
  } as TrackingFrame;
}

/** A playing VRMA emote rides in the frame's snack JSON as `e` = {i: id, n: clip name, g: ms since it started,
 *  l: loop} (old peers' sanitizeSnack ignores the key). `g` instead of a wall-clock start: the peers' clocks differ. */
export function emoteToWire(e: TrackingFrame['emote'], now = Date.now()): { i: number; n: string; g: number; l?: 1 } | undefined {
  if (!e || typeof e.name !== 'string' || !EMOTE_RE.test(e.name)) return undefined;
  return { i: Math.round(fin(e.id, 0, 1e9)), n: e.name, g: Math.round(fin(now - e.at, 0, 36e5)), ...(e.loop ? { l: 1 as const } : {}) };
}
const EMOTE_RE = /^[\w.-]{1,48}$/;
function wireEmote(v: unknown, now = Date.now()): TrackingFrame['emote'] {
  const e = v as Record<string, unknown> | null | undefined;
  if (!e || typeof e !== 'object' || typeof e.n !== 'string' || !EMOTE_RE.test(e.n)) return undefined;
  return { id: Math.round(fin(e.i, 0, 1e9)), name: e.n, at: now - fin(e.g, 0, 36e5), ...(e.l ? { loop: true } : {}) };
}

const PROPS = new Set<string>(['coffee', 'mug', 'can', 'bottle', 'glass']);
const MESS = new Set<string>(['crumbs', 'spaghetti', 'cheeto', 'chocolate', 'sugar']);
/** Food & drink layer: whitelisted kinds + clamped numbers only. */
function sanitizeSnack(o: unknown): SnackFrame | undefined {
  if (!o || typeof o !== 'object') return undefined;
  const x = o as Record<string, unknown>;
  const hand = (v: unknown): SnackHand | undefined => {
    const hd = v as Record<string, unknown> | null;
    if (!hd || typeof hd !== 'object' || typeof hd.k !== 'string' || !PROPS.has(hd.k)) return undefined;
    return { k: hd.k as SnackHand['k'], a: r3(fin(hd.a, 0, 1)), sip: r3(fin(hd.sip, 0, 1)) };
  };
  const m = x.m as Record<string, unknown> | null | undefined;
  const out: SnackFrame = {
    l: hand(x.l), r: hand(x.r),
    m: m && typeof m === 'object' && typeof m.s === 'string' && MESS.has(m.s) ? { s: m.s as MessStyle, f: r3(fin(m.f, 0, 1)), hl: r3(fin(m.hl, 0, 1)), hr: r3(fin(m.hr, 0, 1)) } : undefined,
    b: typeof x.b === 'number' ? Math.round(fin(x.b, 0, 1e6)) : undefined,
  };
  return out.l || out.r || out.m || out.b !== undefined ? out : undefined;
}

// ---------------------------------------------------------------- wire protocol ('ctl' channel, JSON)
type Wire =
  | { t: 'hello'; id: string; name: string; secret: string; profile: unknown; bytes: number; caps?: string[]; share?: SharePolicy; avatar?: boolean; why?: string; tv?: unknown; lite?: boolean }
  | { t: 'welcome'; id: string; caps: string[] }                     // host → guest as soon as ctl opens
  | { t: 'roster'; members: PartyMember[] }
  | { t: 'profile'; owner: string; name: string; profile: unknown; bytes: number; share?: SharePolicy; avatar?: boolean; why?: string; tv?: unknown }
  | TvSig                               // TV media links' SDP / ICE (src/net/tv/tvLink.ts; 'tv1' peers only)
  | VoxSig                              // party voice link: SDP / ICE / mode + mute (src/net/voice/partyVoice.ts; 'vox1' peers only)
  | { t: 'frame'; owner: string; f: unknown }                         // legacy JSON frames (peers without 'rt1')
  | { t: 'bye'; owner: string }
  | { t: 'scene'; state: unknown }      // host → guests: the 3D room everyone's OBS shows (src/scene/controller.ts)
  | { t: 'beat'; b: unknown }           // host → guests: beat packets for the room lights (shared/lightShow.ts)
  | { t: 'ivcue'; c: unknown }          // host → guests: the interview director's cue (shared/talkshow.ts InterviewCue)
  | { t: 'chat'; evs: unknown; tot?: unknown; snap?: boolean } // host → guests: live chat + support events (src/chat/studioChat.ts)
  | { t: 'djdeck'; s: unknown }         // host → guests: the DJ decks' controller state (src/scene/djdeck/deckRelay.ts; older peers ignore it)
  | { t: 'goals'; s: unknown }         // host → guests: goals + the subathon timer view (src/goals/goalsRelay.ts; older peers ignore it)
  | { t: 'kick' }
  | { t: 'limits'; maxTris: number }   // host → guests: this party's maximum triangles per avatar (model + costume)
  | { t: 'unshare' }                    // guest → host: stop sharing my avatar (everyone drops it)
  | { t: 'drop'; owner: string }        // host → guests: forget this member's avatar now
  | { t: 'game'; d: unknown }           // party games (src/game/trail/session.ts): reliable JSON, only to peers with cap 'trail1'
  | { t: 'ping'; n: number } | { t: 'pong'; n: number }
  // the resolver (shared/partyXfer.ts; only between 'xf1' peers): receiver → sender progress / receipt, anyone → the
  // peer that should send: "I don't have it" (+ what it has, to resume), sender → asker: why it isn't coming
  | { t: 'xprog'; owner: string; k: Kind; x: number; got: number }
  | { t: 'xack'; owner: string; k: Kind; x: number; ok: boolean; why?: string; retry?: boolean; got?: number }
  | { t: 'xneed'; owner: string; k: Kind; have?: { h: string; got: number } }
  | { t: 'xwhy'; owner: string; k: Kind; why: string }
  | { t: 'xstat'; owner: string; to: Delivery[] };                   // host → owner: where their avatar got to

/** Binary transfers: 'm' = avatar model, 'c' = worn costume. */
type Kind = 'm' | 'c';
/** Where one owner's avatar got to on one member's PC (Multiplayer panel, xstat). */
export interface Delivery { name: string; st: XfState; why: string; got: number; n: number }
/** One outgoing transfer on a link (the resolver's sender side). */
interface OutXfer {
  owner: string; kind: Kind; x: number; n: number; h: string;
  st: XfState; why: string; tries: number;
  /** Bytes handed to the channel / confirmed by the receiver; when it last moved. */
  sent: number; got: number; at: number;
  legacy: boolean; retryAt: number; resume: number;
  /** A newer transfer of the same owner + kind supersedes this one (checked between chunks). */
  gen: number; abort: (() => void) | null;
}
/** One incoming 'xf1' transfer: preallocated, filled strictly in order. */
interface InXfer { x: number; k: Kind; n: number; h: string; c: string; buf: Uint8Array; got: number; crc: number; at: number; prog: number; link: Link; nak: boolean }
type XRes = { ok: boolean; why?: string; retry?: boolean };

interface Link {
  id: string;                        // the remote's party id (for a guest: the host's)
  pc: RTCPeerConnection;
  ctl: RTCDataChannel | null;        // JSON messages
  bin: RTCDataChannel | null;        // model bytes (prefixed with owner id)
  rt: RTCDataChannel | null;         // unreliable binary tracking + voice
  ready: boolean;
  caps: Set<string>;
  via: 'code' | 'discord';
  relayPeer?: string;
  /** Identity the relay verified for this peer (host side) / for the host (guest side). */
  who: { discord: DiscordIdentity | null; verified: boolean; guildOk: boolean };
  remoteSet: boolean;
  iceQ: RTCIceCandidateInit[];
  /** Transfers waiting for the binary channel to open (resolved with null if the link dies first). */
  binWait?: ((bin: RTCDataChannel | null) => void)[];
  /** Host: 'bin' packets that arrived before this guest's hello said who it is — another channel, so no ordering. They
   *  used to be dropped (a model missing its first chunks = refused as corrupt = "waiting for avatar" forever). */
  early?: ArrayBuffer[]; earlyBytes?: number;
  /** Outgoing transfers (resolver), by `${owner}:${kind}`. */
  out: Map<string, OutXfer>;
  /** Guest: the host's welcome (its caps) arrived / we introduced ourselves (the hello waits ≤ 3 s for the caps). */
  welcomed?: boolean; introduced?: boolean; introT?: number;
  /** Binary transfers to this peer, one after another. */
  blobQ?: Promise<void>;
  /** The id of my own 'c' (outfit or costume set) last handed to this peer: a label edit resends only the profile. */
  sentC?: string;
  rtt: number;
  pings: Map<number, number>;
  /** Pending give-up timer while the connection is 'disconnected'. */
  dropT?: number;
}

interface Remote {
  id: string; name: string; slot: number;
  profile: Record<string, unknown> | null; bytes: number;
  rx: Record<Kind, { chunks: Uint8Array[]; got: number }>;
  discord: DiscordIdentity | null; verified: boolean; guildOk: boolean;
  share: SharePolicy; avatar: boolean; why: string;
  /** Triangles of the received model / costume (receiver-side polycount check). */
  tris: { m: number; c: number };
  /** Per-member sealing key (this session only). */
  key: SealKey | null;
  /** Host: sealed copies kept to relay to members who join later (never plaintext at rest). */
  sealedModel: Uint8Array | null; sealedCostume: Uint8Array | null;
  costumeId: string | null;
  /** Host, when their 'c' is a costume set: its outfit sealed on its own for members whose app can't open a set (null
   *  sealed = the set has no outfit: those members get no costume). */
  setOutfit: { sealed: Uint8Array | null; id: string; hash: string } | null;
  /** Items in this PC's RAM vault (what the OBS pages open); `set` = what the held costume set contains. */
  refs: { profile: VaultRef | null; model: VaultRef | null; costume: VaultRef | null; costumeId: string | null; set: { outfit: string | null; acc: string[] } | null };
  /** Requests for a costume they announce that never came (like `ask` for the model). */
  askC: { tries: number; next: number };
  /** Since when OBS keeps their last look while the announced outfit / set is on its way (0 = not waiting). */
  sealWait: number;
  rev: number;
  /** Host: members this owner's avatar went to (their frames are only relayed to those). */
  sentTo: Set<string>;
  lastFrame: number; lastVoice: number;
  /** Token buckets (rate limits that tolerate jitter bursts): frames ~30/s, voice ~60/s. */
  fTok: number; vTok: number; tokAt: number;
  /** Link quality as seen by this studio (never renders — stats only). */
  net: RemoteSmoother;
  chain: Promise<void>;
  /** Resolver (receiver side): incoming 'xf1' transfers, the state the panel shows, hashes of what we hold, a finished
   *  model that beat the owner's "sharing" message, when they said they share + our requests since, and whether the
   *  refusal was ours (polycount) — see resolverTick(). */
  inx: Record<Kind, InXfer | null>;
  xin: Record<Kind, XfView | null>;
  hash: Record<Kind, string>;
  late: { kind: Kind; buf: Uint8Array; meta: string | null; x: number; h: string; at: number; link: Link } | null;
  shareAt: number; ask: { tries: number; next: number };
  refused: boolean;
  /** Host: last delivery report sent to this owner (xstat). */
  outSeen: string; outAt: number;
  /** A TV performer (shared/tv.ts): no model; their video comes over the TV media links. */
  tv?: TvInfo | null;
  /** A browser-only TV guest (relay /tv page, src/net/tv/tvLiteGuest.ts): never send it avatars or tracking. */
  lite?: boolean;
}

export type PartyRole = 'none' | 'host' | 'guest';
/** guestlink — host: someone I let in whose connection is still coming up, or never came up (the Live panel shows it:
 *  without this a guest you approved just vanished until they connected — or forever, when their network needs TURN). */
export interface JoinState { peer: string; uid: string; name: string; link: boolean; state: 'connecting' | 'failed'; at: number; /** it was connected, then failed */ lost: boolean }
export interface PendingKnock { peer: string; user: DiscordIdentity | null; guildOk: boolean; at: number; /** guestlink: came in with the no-sign-in link — the name is typed by them, NOT verified */ link?: boolean }
export interface JoinRequest { relay: string; ticket: string; hostName: string; you: string; trusted: boolean }
export interface MemberView {
  id: string; name: string; slot: number; me: boolean; host: boolean;
  discord: DiscordIdentity | null; verified: boolean; share: SharePolicy; avatar: boolean;
  /** Why their avatar isn't coming: '' | 'off' (share unticked) | 'none' (not loaded) | 'big:<MB>' | 'load' (file unreadable)
   *  | 'tris:<thousands>' (over the party's polycount limit). */
  why: string;
  ready: boolean; receiving: boolean; speaking: boolean; stats: (LinkStats & { rtt: number }) | null;
  /** Resolver: this member's avatar on its way to me (me: mine on its way to the host), where it went (deliveries), and
   *  whether their app is too old to confirm / resend. */
  xfer: XfView | null; deliveries: Delivery[]; outdated: boolean;
  /** Appears as a TV (webcam / VTube Studio), null = a normal avatar. */
  tv: TvInfo | null;
}
/** Test / diagnostics hook: simulate a bad network on the realtime channel (party.debugNet = {loss: 0.05, delay: 80, jitter: 40});
 *  the optional bin* fields affect avatar transfers this studio SENDS: a bandwidth cap (kB/s), a chance to drop / corrupt
 *  a chunk, and a stall (the pump stops at that fraction, like a channel that never drains). */
export interface NetSim { loss: number; delay: number; jitter: number; binKBps?: number; binDrop?: number; binCorrupt?: number; binStallAt?: number }

export class Party {
  role: PartyRole = 'none';
  readonly myId = rid();
  name = localStorage.getItem('vtp.partyName') || 'Me';
  private secret = '';
  private links = new Map<string, Link>();   // host: one per guest; guest: just the host
  private pending: Link | null = null;       // host: invite waiting for its reply code
  readonly remotes = new Map<string, Remote>();
  private roster: PartyMember[] = [];
  private lastSent = 0;
  private seq = 0; private vseq = 0; private lastVoice = 0; private vhist: VoiceSample[] = [];
  private extVoiceAt = -1e9;
  private lastMouth = { open: 0, closure: 0 };
  private myModel: ArrayBuffer | null = null;
  private myProfile: AvatarProfile | null = null;
  private myCostume: { id: string; buf: ArrayBuffer } | null = null;
  /** My worn accessories' GLBs (fetched lazily in a party, per avatar + file) and the costume set made of them + the
   *  outfit: what 'acc1' peers get as my 'c' (older apps get the plain outfit) — see ensureSet(). */
  private myAcc = new Map<string, { buf: ArrayBuffer; tris: number }>();
  private mySet: { id: string; buf: ArrayBuffer; tris: number; acc: string[] } | null = null;
  private setKey = '';
  /** Why my accessories don't travel ('' = they do, or none are worn): 'tris:…' over the party's limit, 'load'. */
  accWhy = '';
  /** Triangles of my model / worn costume (counted from the GLB JSON when they are fetched for sharing). */
  myTris = { m: 0, c: 0 };
  /** Host: this party's maximum triangles per avatar (Multiplayer → "Max triangles per avatar"). */
  maxTris = clampTrisLimit(Number(localStorage.getItem('vtp.mp.maxTris') || TRIS_MAX));
  /** Guest: the host's maximum (null until the host said; older hosts never do → the default). */
  hostMaxTris: number | null = null;
  /** Triangles of my ORIGINAL model / costume (myTris = what is actually shared: the party version when one is used). */
  srcTris = { m: 0, c: 0 };
  /** Over the limit: share an automatic party version (server/partyLod.ts) instead of nothing. */
  autoLod = localStorage.getItem('vtp.mp.autoLod') !== '0';
  /** The party version in use (null = the original is shared), its state for the UI, and why it failed. */
  lod: PartyLodStatus | null = null;
  lodState: 'idle' | 'working' | 'ready' | 'failed' | 'off' = 'idle';
  lodError = '';
  private lodKey = '';
  private origModel: ArrayBuffer | null = null;
  private origCostume: { id: string; buf: ArrayBuffer } | null = null;
  /** The model bytes last announced (a new party version must be re-sent). */
  private sentModel: ArrayBuffer | null = null;
  private sharedJson = '';
  /** Vault session: everything this studio parks in the local RAM vault (purged on leave / page close). */
  private vsid = rid(24);
  private observer = isObserverTab();
  // ---- Discord relay
  private relay: RelayClient | null = null;
  private ice: RTCIceServer[] | null = null;
  private relayLinks = new Map<string, Link>();      // relay peer id → link (host)
  private hostRoom: { relay: string; roomId: string; joinUrl: string; refresh: () => Promise<string>; retries: number } | null = null;
  /** How this studio is in the party. */
  via: 'none' | 'code' | 'discord' = 'none';
  myDiscord: DiscordIdentity | null = null;
  /** Guest: the host as the relay verified them. */
  hostInfo: { name: string; avatar: string | null; uid: string } | null = null;
  joinUrl = '';
  /** guestlink: link guests (no-sign-in ids) I approved this party — let back in after a reconnect. */
  private linkOk = new Set<string>();
  /** Relay room id of the party I host ('' = none). */
  get roomId(): string { return this.hostRoom?.roomId ?? ''; }
  knocks: PendingKnock[] = [];
  private joins = new Map<string, JoinState>();
  /** Host: approved guests still connecting (with seconds so far) + failures of the last 3 minutes. */
  joinStates(): (JoinState & { secs: number })[] {
    const now = Date.now();
    for (const [k, j] of this.joins) if (j.state === 'failed' && now - j.at > 180_000) this.joins.delete(k);
    return [...this.joins.values()].map((j) => ({ ...j, secs: Math.round((now - j.at) / 1000) }));
  }
  /** Does my relay hand out TURN? (null = not connected to a relay yet). No TURN: guests on mobile data / strict NATs fail. */
  get turnReady(): boolean | null { return this.ice ? this.hasTurn() : null; }
  autoApprove = false;
  /** Never reveal my IP to peers: only TURN relay candidates (needs TURN on the relay). */
  relayOnly = false;
  /** Consent: share my avatar this session, and who else may see it. */
  shareMine = localStorage.getItem('vtp.mp.share') !== '0';
  sharePolicy: SharePolicy = isPolicy(localStorage.getItem('vtp.mp.policy')) ? localStorage.getItem('vtp.mp.policy') as SharePolicy : 'party';
  debugNet: NetSim | null = null;
  status = '';
  onChange: () => void = () => {};
  /** Extra change listeners (roster / status), e.g. the scene controller and the Multiplayer panel. */
  readonly listeners = new Set<() => void>();
  /** Guest: the host's scene state arrived. */
  onScene: (s: SceneState) => void = () => {};
  /** Guest: a host beat packet arrived (already relayed to this PC's OBS pages). */
  onBeat: (b: BeatPacket) => void = () => {};
  /** Guest: the host's chat / support events arrived (sanitised + relayed by src/chat/studioChat.ts). */
  onChat: (evs: unknown, tot: unknown, snap?: boolean) => void = () => {};
  /** Guest: the host's goals / subathon view arrived (sanitised + relayed to this PC's OBS pages by src/goals/goalsRelay.ts). */
  onGoals: (s: unknown) => void = () => {};
  onDjDeck: (s: unknown) => void = () => {};
  /** TTRPG table channel (src/ttrpg/studio): a message `d` from the host (from = null) or from guest `from` (host side).
   *  Raw JSON: shared/ttrpg/wire.ts sanitises it on arrival. */
  onTtrpg: (d: unknown, from: string | null) => void = () => {};
  /** A Discord join link arrived (/join) — the UI asks for consent (default: the join-consent dialog). */
  onJoinRequest: ((j: JoinRequest) => void) | null = null;
  /** Host: last scene state, for guests who join later. */
  private sceneState: SceneState | null = null;
  // ---- party games (src/game/trail): a reliable JSON lane ('ctl' {t:'game'}) + a realtime binary lane ('rt' packets
  //      starting 0x54 host→guest snapshot / 0x49 guest→host input). Cap-gated: older peers never see either.
  /** A game message from a peer (host: from a guest id; guest: from the host's id). Unset → the Trail's guest
   *  listener is loaded on the first message (so a guest needs nothing open to be invited into a game). */
  onGame: ((from: string, d: unknown) => void) | null = null;
  onGameRt: ((from: string, pkt: Uint8Array) => void) | null = null;
  /** Peers that speak the party-game protocol (host: ready guests with 'trail1'; guest: the host). */
  gamePeers(): string[] { return [...this.links.values()].filter((l) => l.ready && l.id && l.caps.has('trail1')).map((l) => l.id); }
  sendGame(d: unknown, to?: string) { for (const l of this.links.values()) if (l.ready && l.caps.has('trail1') && (!to || l.id === to)) this.send(l, { t: 'game', d }); }
  sendGameRt(pkt: Uint8Array, to?: string) { for (const l of this.links.values()) if (l.ready && l.caps.has('trail1') && (!to || l.id === to)) this.sendRt(l, pkt); }
  /** The local bus (party games relay their state to this PC's OBS pages). */
  gameBus(): Bus { return this.bus; }
  /** Resolver: where MY avatar got to (host: from its own links; guest: the host's xstat reports). */
  private myDeliveries: Delivery[] = [];
  /** Guest: 'bin' packets for a member whose 'profile' (ctl) hasn't been processed yet — held ≤ 30 s, then wiped. */
  private orphans = new Map<string, { at: number; bytes: number; q: [Link, ArrayBuffer][] }>();
  /** Host: at most this many relayed plaintexts (decrypted for sending) in memory at once. */
  private relaySlots = 2; private relayWait: (() => void)[] = [];
  /** Checksums of my own model / costume buffers (250 MB ≈ 0.3–0.5 s in slices: once per buffer). */
  private hashes = new WeakMap<ArrayBufferLike, Promise<string>>();
  /** Transfer + status log for the diagnostics dump (RAM only, never sent anywhere by the app). */
  private xlogs: { t: number; s: string }[] = [];
  /** Me as a TV performer (null = my avatar). Set by `tv` (the Multiplayer panel's "How do I appear"). */
  myTv: TvInfo | null = null;
  /** TV media links (my feed up to the host / everyone's feeds forwarded by the host) and the studio side of TVs. */
  readonly tvLinks: TvLinks = ((p: Party) => new TvLinks({
    get role() { return p.role; }, get myId() { return p.myId; },
    sendTv: (to, m) => p.sendTv(to, m), rtcConfig: () => (p.via === 'code' ? { iceServers: ICE_PUBLIC } : p.rtcConfig()),
    mayForward: (owner, to) => p.mayForwardTv(owner, to), tvPeers: () => p.tvPeers(),
  }))(this);
  readonly tv: TvStudio;
  /** Green room (host: who waits, messages, backstage voice; guest: the host's messages to me). */
  readonly green: GreenRoom;
  /** Party voice: app guests talking in VTube Pro (host: their voices + everyone's mix-minus; guest: my link). */
  readonly voice: PartyVoice;
  /** Host moderation (host: who is hidden / muted / their volume + Undo; guest: the host's decision about me). */
  readonly mod: Moderation;
  /** Link guests' voices: 'air' (normal), 'back' (backstage talk with me only), 'off' (waiting: nobody hears them). */
  voiceGate(id: string): 'air' | 'back' | 'off' { return !this.green.backstage(id) ? 'air' : this.green.talking(id) ? 'back' : 'off'; }
  /** Audio mixer (src/audio/mixer/wireMixer.ts): an app guest whose noise gate is shut sends no speaking signal (their
   *  voice samples go out silent and their frames' mouth closed, to this PC's OBS pages and every other guest). */
  voiceGated: ((id: string) => boolean) | null = null;

  constructor(private bus: Bus) {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.green = new GreenRoom({
      role: () => this.role,
      send: (id, m) => { const l = this.role === 'guest' ? this.hostLink() : this.links.get(id); if (!l?.ready) return false; this.send(l, m as Wire); return true; },
      caps: (id) => !!(this.role === 'guest' ? this.hostLink() : this.links.get(id))?.caps.has(GR_CAP),
      changed: () => { this.rebuildRoster(); this.tvLinks.membersChanged(); this.tv.gateChanged(); this.voice.replan(); },
      notify: () => this.notify(),
      room: () => this.hostRoom?.roomId ?? '',
    });
    this.mod = new Moderation({
      role: () => this.role,
      guests: () => [...this.remotes.values()].map((r) => ({ id: r.id, name: r.name, uid: r.discord?.id ?? null })),
      tvOf: (id) => this.tvOf(id),
      send: (id, m) => { const l = this.links.get(id); if (this.role !== 'host' || !l?.ready || !l.caps.has(MOD_CAP) || l.ctl?.readyState !== 'open') return false; this.send(l, m as unknown as Wire); return true; },
      relay: (id, m) => { const l = this.links.get(id); if (this.role === 'host' && l?.relayPeer) this.relay?.mod(l.relayPeer, m.cam, m.mic); },
      changed: (ids) => {
        this.tvLinks.membersChanged(); this.tv.modChanged(); this.voice.replan();
        // a 3D-avatar guest hidden / back: they leave / rejoin the room (TV guests keep their place: the card shows)
        if (ids.some((id) => !this.tvOf(id))) this.rebuildRoster();
        for (const id of ids) this.xlog(`moderation: ${this.nameOf(id)} → ${JSON.stringify(this.mod.state(id))}`);
      },
      notify: () => this.notify(),
      room: () => this.hostRoom?.roomId ?? '',
    });
    this.tvLinks.mod = { cover: (o) => this.mod.cover(o), quiet: (o) => this.mod.micOff(o) };
    // guest (app): the host muted me → my mic stays muted (and locked) until the host lifts it
    this.mod.onMine = (_t, st) => { this.voice.hostLock = st.mic; if (st.mic) this.voice.setMuted(true); };
    // (my voice back to a waiting guest only while I talk with them backstage — never my show audio)
    this.tvLinks.returnFor = (g) => { const v = this.voiceGate(g); return v === 'air' ? 'main' : v === 'back' ? 'back' : 'none'; };
    this.tv = new TvStudio(this, bus, this.observer);
    this.tv.onCams = () => this.publishLocal();
    this.tvLinks.log = (s) => this.xlog(`tv: ${s}`);
    this.voice = new PartyVoice({
      get role() { return self.role; }, get myId() { return self.myId; },
      sendVox: (to, m) => this.sendVox(to, m),
      rtcConfig: () => (this.via === 'code' ? { iceServers: ICE_PUBLIC } : this.rtcConfig()),
      voxPeers: () => this.voxPeers(),
      hostCaps: () => { const l = this.hostLink(); return l?.welcomed ? [...l.caps] : null; },
      gate: (id) => this.voiceGate(id),
      volume: (id) => this.tv.voiceVol(id),
      linkVoices: () => new Map([...this.tvLinks.voices].map(([id, v]) => [id, v.track])),
      linkListeners: () => [...this.tvLinks.listeners],
      hostTracks: () => this.tvLinks.hostTracks,
      setLinkReturns: (m) => this.tvLinks.setMixes(m),
      muteChanged: (on) => { const l = this.hostLink(); if (this.role === 'guest' && l?.ready && l.caps.has(GR_CAP)) this.send(l, { t: 'gr', k: 'mute', on } as unknown as Wire); },
    }, this.observer);
    this.voice.log = (s) => this.xlog(s);
    this.voice.listeners.add(() => { this.tv.voiceLinksChanged(); this.notify(); });
    // voices / listeners / my talk-back changed on the TV links: re-plan the mixes (link guests are in them too)
    { const was = this.tvLinks.onChange; this.tvLinks.onChange = () => { was(); this.voice.replan(); }; }
    this.tvLinks.onReturn = () => this.voice.replan();
    // this PC's OBS pages (which may open later) keep hearing who is here (+ how to open their sealed avatars)
    setInterval(() => { if (this.role !== 'none' || this.tv.cams.list.length || this.tv.soloShow || this.soloWas) { this.soloWas = this.tv.soloShow; this.publishLocal(false); } }, 3000);
    setInterval(() => { if (this.hasVault()) void vault.alive(this.vsid); this.pingAll(); this.mod.retell(); }, 5000);
    setInterval(() => { if (this.role !== 'none') this.resolverTick(); }, 1000);
    window.addEventListener('pagehide', () => { if (this.hasVault()) vault.purge(this.vsid, true); });
    if (!this.observer) {
      bus.on((m) => { if (m.type === 'command' && m.command === 'party-join-pending') void this.takePendingJoin(); });
      setTimeout(() => void this.takePendingJoin(), 1500);
      setTimeout(() => void this.resumeHost(), 2000);
    }
  }

  get members(): PartyMember[] { return this.roster; }
  /** The performer's own avatar profile (size class for the scene seats), null before one loads. */
  get myAvatar(): AvatarProfile | null { return this.myProfile; }
  /** The polycount limit in effect for this studio (host: its own setting; guest: the host's). */
  get trisLimit(): number { return this.role === 'guest' ? this.hostMaxTris ?? TRIS_MAX : this.maxTris; }
  get myTrisTotal(): number { return this.myTris.m + (this.myCostume ? this.myTris.c : 0); }
  /** My model (+ costume) is over the party's limit: it isn't sent. */
  overLimit(): boolean { return !!this.myModel && this.myTrisTotal > this.trisLimit; }

  /** Host: change this party's polycount limit (members over it are dropped; the guests hear the new limit). */
  setMaxTris(v: number) {
    const n = clampTrisLimit(v);
    if (n === this.maxTris) return;
    const was = this.overLimit();
    this.maxTris = n;
    try { localStorage.setItem('vtp.mp.maxTris', String(n)); } catch { /* storage off */ }
    if (this.role === 'host') {
      for (const l of this.links.values()) if (l.ready) this.send(l, { t: 'limits', maxTris: n });
      for (const r of this.remotes.values()) {
        const tot = r.tris.m + (r.refs.costume ? r.tris.c : 0);
        if ((r.refs.model || r.sealedModel) && tot > n) this.refuseTris(r, tot);
      }
      this.reaskRefused(n);
      void (async () => {
        await this.ensureLod();
        const now = this.overLimit();
        if (!was && now) { for (const l of this.links.values()) { this.send(l, { t: 'drop', owner: this.myId }); this.send(l, this.myProfileMsg()); } this.warnTris(); }
        else if (this.myModel !== this.sentModel || (was && !now)) this.announceSelf();
        else this.resendChanged();                                       // (my accessories may fit now, or no longer)
        this.rebuildRoster();
      })();
    } else void this.ensureLod();
    this.notify();
  }
  /** The limit went up: members this studio refused for their polycount (and that now fit) are asked again. */
  private reaskRefused(limit: number) {
    for (const r of this.remotes.values()) {
      if (!r.refused || !r.why.startsWith('tris:') || trisOfWhy(r.why) > limit) continue;
      const l = this.role === 'host' ? this.links.get(r.id) : this.hostLink();
      if (!l?.caps.has(XF_CAP)) continue;
      r.refused = false; r.avatar = true; r.why = ''; r.shareAt = performance.now(); r.ask = { tries: 0, next: 0 };
      this.send(l, { t: 'xneed', owner: r.id, k: 'm' });
      this.xlog(`limit now ${limit}: asked for ${r.name}’s avatar again`);
    }
    this.rebuildRoster();
  }

  /** Tell the owner about their model's polycount (over the limit: not shared; heavy: a gentle warning). */
  private warnTris() {
    const t = this.myTrisTotal, lim = this.trisLimit;
    if (t > lim) this.say(`Your model has ${fmtTris(t)} triangles — the party limit is ${fmtTris(lim)}; decimate it or pick a lighter model${this.autoLod ? '' : ' (or turn on the automatic party version)'}.`);
    else if (t > TRIS_WARN) this.say(`Heads-up: your model has ${fmtTris(t)} triangles (party limit ${fmtTris(lim)}) — guests with weaker PCs may drop frames.`);
  }

  /** Receiver: a model over the party's polycount limit is refused (nothing kept) and everyone hears why. */
  private refuseTris(r: Remote, tris: number) {
    r.avatar = false;
    r.why = trisWhy(tris);
    r.refused = true;
    this.forgetAvatar(r);
    if (this.role === 'host') for (const [id, l] of this.links) if (id !== r.id) { this.send(l, { t: 'drop', owner: r.id }); this.send(l, { t: 'profile', owner: r.id, name: r.name, profile: null, bytes: 0, share: r.share, avatar: false, why: r.why }); }
    this.rebuildRoster();
    this.say(`Refused ${r.name}’s avatar: ${fmtTris(tris)} triangles — the party limit is ${fmtTris(this.trisLimit)} (they need this update for the automatic party version, or a lighter model)`);
  }

  /** Performer's avatar to share (call when the studio's avatar changes). */
  async setAvatar(p: AvatarProfile) {
    const newAvatar = this.myProfile?.id !== p.id || this.myProfile?.modelFile !== p.modelFile;
    if (newAvatar) { this.myModel = null; this.modelWhy = ''; this.myAcc.clear(); this.mySet = null; this.setKey = ''; }
    this.myProfile = p;
    if (this.role === 'none') return;
    await this.ensureModel();
    await this.ensureCostume();
    await this.ensureLod();
    // a new body / party version, or a costume that took it over / back under the polycount limit: announce it all again
    if (newAvatar || this.overLimit() !== this.sentOver || this.myModel !== this.sentModel) { this.announceSelf(); return; }
    this.resendChanged();
  }
  /** Same avatar: resend only what changed — the profile (labels, size …) and, when my outfit or accessories changed for
   *  that peer, my costume bytes (the plain outfit, or the costume set for 'acc1' peers). */
  private resendChanged() {
    const json = JSON.stringify(this.shareProfile());
    if (json === this.sharedJson) return;
    this.sharedJson = json;
    for (const l of this.links.values()) {
      if (!l.ready || !this.mayShareMine(l)) continue;
      this.send(l, this.role === 'guest' ? this.helloMsg() : this.myProfileMsg());
      const c = this.costumeFor(l);
      if (!c) l.sentC = undefined;
      else if (!this.overLimit() && c.id !== l.sentC) { l.sentC = c.id; void this.sendBlob(l, this.myId, 'c', new Uint8Array(c.buf), { meta: c.id }); }
    }
  }
  /** What my 'c' transfer is for this peer: the costume set ('acc1' peers: outfit + accessories), else the plain outfit. */
  private costumeFor(link: Link): { id: string; buf: ArrayBuffer } | null {
    return this.mySet && link.caps.has(ACC_CAP) ? this.mySet : this.myCostume;
  }
  /** Whether my avatar was over the polycount limit when it was last announced. */
  private sentOver = false;

  /** Consent toggle (guest or host): stop / resume sharing MY avatar. Stopping makes everyone drop it now. */
  setSharing(on: boolean, policy: SharePolicy = this.sharePolicy) {
    const was = this.shareMine;
    this.shareMine = on; this.sharePolicy = policy;
    localStorage.setItem('vtp.mp.share', on ? '1' : '0');
    localStorage.setItem('vtp.mp.policy', policy);
    if (this.role === 'none') { this.notify(); return; }
    if (was && !on) {
      for (const l of this.links.values()) {
        this.send(l, this.role === 'guest' ? { t: 'unshare' } : { t: 'drop', owner: this.myId });
        // (a legacy receiver can't tell a cut-off transfer from the next one: let those finish — it wipes them)
        for (const ox of l.out.values()) if (ox.owner === this.myId) { ox.gen++; if (!ox.legacy) { ox.abort?.(); ox.st = 'idle'; } }
      }
      this.say('You stopped sharing your avatar — everyone dropped it');
    } else if (on) {
      void (async () => { await this.ensureModel(); await this.ensureCostume(); await this.ensureLod(); this.announceSelf(); this.rebuildRoster(); })();
    }
    this.rebuildRoster();
  }

  /** The costume we're wearing (fetched lazily, only in a party). */
  private async ensureCostume() {
    const p = this.myProfile;
    const def = p?.costume ? p.costumes.find((c) => c.id === p.costume) : null;
    if (!p || !def) { this.myCostume = null; return; }
    if (this.myCostume?.id === def.id) return;
    try {
      const buf = await fetch(api.pathUrl(p.id, def.file)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))));
      this.myCostume = buf.byteLength <= MAX_MODEL ? { id: def.id, buf } : null;
      this.myTris.c = this.srcTris.c = this.myCostume ? glbStats(new Uint8Array(buf))?.tris ?? 0 : 0;
      this.origCostume = null;
      if (!this.myCostume) this.say(`Your costume is over ${MAX_MODEL >> 20} MB — party guests can't receive it`);
    } catch { this.myCostume = null; }
  }

  /** Fetch our own avatar file lazily — only once we're actually in a party. */
  private modelWhy = '';
  private modelLoad: { p: AvatarProfile; run: Promise<void> } | null = null;
  private ensureModel(): Promise<void> {
    const p = this.myProfile;
    if (this.myModel || !p) return Promise.resolve();
    if (this.modelLoad?.p.id !== p.id || this.modelLoad.p.modelFile !== p.modelFile) {
      const run: Promise<void> = this.loadModel(p).finally(() => { if (this.modelLoad?.run === run) this.modelLoad = null; });
      this.modelLoad = { p, run };
    }
    return this.modelLoad.run;
  }
  private async loadModel(p: AvatarProfile) {
    try {
      // (a 2D avatar: its pictures / model files packed into one bundle, sealed like any model: src/avatar/flat/pack.ts)
      const flat = p.flat ? await packOwnFlatAvatar(p, MAX_MODEL) : null;
      if (p.flat && !flat) throw new Error('2D avatar over the party size limit');
      const r = flat ? null : await fetch(api.modelUrl(p));
      if (r && !r.ok) throw new Error(String(r.status));
      const buf = flat ?? await r!.arrayBuffer();
      if (this.myProfile?.id !== p.id || this.myProfile.modelFile !== p.modelFile) return;   // switched avatars meanwhile
      this.myModel = buf.byteLength <= MAX_MODEL ? buf : null;
      this.myTris.m = this.srcTris.m = glbStats(new Uint8Array(buf))?.tris ?? 0;
      this.origModel = null; this.lodKey = ''; this.lod = null;
      this.modelWhy = this.myModel ? '' : `big:${Math.round(buf.byteLength / 1048576)}`;
      if (!this.myModel) this.say(`Your avatar is ${Math.round(buf.byteLength / 1048576)} MB — over the ${MAX_MODEL >> 20} MB party limit, so nobody can receive it`);
    } catch { this.myModel = null; this.modelWhy = 'load'; this.say('Couldn’t read your avatar file to share it — try re-selecting your avatar'); }
  }
  /** Over the party's limit: fetch (making it on the server when needed) the automatic party version and share that;
   *  back under it: share the original again. `force` = make it again (Regenerate). */
  async ensureLod(force = false) {
    // one at a time: joining + the host's 'limits' used to start two builds of the same party version, which raced on the
    // server's temp file, and the loser's restore() could put the over-limit original back under the winner
    while (this.lodRun) await this.lodRun;
    const run = this.ensureLodNow(force);
    this.lodRun = run;
    try { await run; } finally { if (this.lodRun === run) this.lodRun = null; }
    await this.ensureSet();                                              // (the set holds the outfit the party uses)
  }
  private lodRun: Promise<void> | null = null;

  /** The costume set 'acc1' peers get as my 'c': my outfit (the party version when one is used) + my worn accessories,
   *  fetched lazily in a party. Left out (accWhy) when they would take my avatar over the party's triangle limit. */
  private ensureSet(): Promise<void> {
    const run = this.setRun.then(() => this.ensureSetNow());
    this.setRun = run.catch(() => {});
    return run;
  }
  private setRun: Promise<void> = Promise.resolve();
  private async ensureSetNow() {
    const p = this.myProfile, outfit = this.myCostume;
    const key = (d: CostumeDef) => `${p!.id}\n${d.id}\n${d.file}`;
    const defs = p ? [...new Set(p.accessories ?? [])].map((id) => p.costumes.find((c) => c.id === id))
      .filter((d): d is CostumeDef => !!d && d.id !== outfit?.id && d.id !== p.costume && /^[A-Za-z0-9_-]{1,40}$/.test(d.id)).slice(0, SET_MAX_PIECES - 1) : [];
    const was = this.accWhy;
    if (!p || !defs.length) { this.mySet = null; this.setKey = ''; this.accWhy = ''; return; }
    for (const d of defs) {
      if (this.myAcc.has(key(d))) continue;
      try {
        const buf = await fetch(api.pathUrl(p.id, d.file)).then((r) => (r.ok ? r.arrayBuffer() : Promise.reject(new Error(String(r.status)))));
        if (buf.byteLength <= MAX_MODEL) this.myAcc.set(key(d), { buf, tris: glbStats(new Uint8Array(buf))?.tris ?? 0 });
      } catch { /* left out: accWhy 'load' when none of them could be read */ }
      if (this.myProfile !== p) return;                                  // switched avatars meanwhile
    }
    const have = defs.filter((d) => this.myAcc.has(key(d)));
    const accTris = have.reduce((s, d) => s + this.myAcc.get(key(d))!.tris, 0);
    const total = this.myTrisTotal + accTris;
    if (!have.length || total > this.trisLimit) {
      this.mySet = null; this.setKey = '';
      this.accWhy = have.length ? trisWhy(total) : 'load';
      if (this.accWhy !== was) this.say(have.length
        ? `Your accessories bring your avatar to ${fmtTris(total)} triangles (party limit ${fmtTris(this.trisLimit)}), so guests see you without them`
        : 'Couldn’t read your accessories to share them — guests see you without them');
      return;
    }
    this.accWhy = '';
    const sk = `${outfit?.id ?? '-'}|${outfit ? await this.hashOf(new Uint8Array(outfit.buf)) : ''}|${have.map(key).join('|')}`;
    if (sk === this.setKey && this.mySet) return;
    const set = packSet([
      ...(outfit ? [{ id: outfit.id, kind: 'outfit' as const, bytes: new Uint8Array(outfit.buf) }] : []),
      ...have.map((d): SetPiece => ({ id: d.id, kind: 'accessory', bytes: new Uint8Array(this.myAcc.get(key(d))!.buf) })),
    ]);
    if (this.myProfile !== p || this.myCostume !== outfit) return;       // changed meanwhile: the next call builds it
    this.mySet = { id: `s-${await this.hashOf(set)}`, buf: set.buffer as ArrayBuffer, tris: accTris + (outfit ? this.myTris.c : 0), acc: have.map((d) => d.id) };
    this.setKey = sk;
  }
  private async ensureLodNow(force: boolean) {
    const p = this.myProfile;
    if (!p || (!this.myModel && !this.origModel)) return;
    const costumeId = this.myCostume?.id ?? this.origCostume?.id ?? null;
    const src = this.srcTris.m + (costumeId ? this.srcTris.c : 0);
    const restore = () => {
      if (this.origModel) { this.myModel = this.origModel; this.myTris.m = this.srcTris.m; this.origModel = null; }
      if (this.origCostume) { this.myCostume = this.origCostume; this.myTris.c = this.srcTris.c; this.origCostume = null; }
      this.lod = null; this.lodKey = '';
    };
    if (src <= this.trisLimit) { restore(); this.lodState = 'idle'; this.lodError = ''; return; }
    if (!this.autoLod) { restore(); this.lodState = 'off'; this.warnTris(); return; }
    const key = `${p.id}|${p.modelFile}|${costumeId ?? '-'}|${this.trisLimit}`;
    if (!force && key === this.lodKey && this.lodState === 'ready') return;
    this.lodState = 'working'; this.lodError = ''; this.notify();
    try {
      const r = await fetch(`/api/avatars/${encodeURIComponent(p.id)}/party-lod`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ max: this.trisLimit, costume: costumeId ?? '', force }) });
      const st = await r.json() as PartyLodStatus & { error?: string };
      if (!r.ok || !st.ready || !st.model) throw new Error(st.error ?? `${r.status}`);
      const get = (f: string) => fetch(`${api.pathUrl(p.id, f)}?v=${Date.now()}`, { cache: 'no-store' }).then((x) => (x.ok ? x.arrayBuffer() : Promise.reject(new Error(String(x.status)))));
      const mbuf = await get(st.model);
      const cbuf = st.costume ? await get(st.costume) : null;
      if (this.myProfile !== p) return;                                  // switched avatars meanwhile
      this.origModel ??= this.myModel;
      this.myModel = mbuf; this.myTris.m = glbStats(new Uint8Array(mbuf))?.tris ?? 0;
      if (cbuf && this.myCostume) { this.origCostume ??= this.myCostume; this.myCostume = { id: this.myCostume.id, buf: cbuf }; this.myTris.c = glbStats(new Uint8Array(cbuf))?.tris ?? 0; }
      this.lod = st; this.lodKey = key; this.lodState = 'ready';
      this.say(`Your model has ${fmtTris(src)} triangles — parties use an automatic ${fmtTris(this.myTrisTotal)}-triangle version (limit ${fmtTris(this.trisLimit)}).`);
    } catch (e) {
      restore();
      this.lodState = 'failed'; this.lodError = (e as Error).message;
      this.say(`Couldn’t make a party version (${this.lodError}) — your ${fmtTris(src)}-triangle model is over the ${fmtTris(this.trisLimit)} limit, so nobody receives it.`);
    }
    this.notify();
  }
  /** After ensureLod: re-send what changed (a new party version / the original again). */
  private async relod(force = false) {
    await this.ensureLod(force);
    if (this.role !== 'none' && (this.myModel !== this.sentModel || this.overLimit() !== this.sentOver)) this.announceSelf();
    else if (this.role !== 'none') this.resendChanged();                // (my accessories may fit now, or no longer)
    this.rebuildRoster();
  }
  /** UI: make the party version again / switch the automatic party version on or off. */
  regenerateLod() { void this.relod(true); }
  setAutoLod(on: boolean) {
    this.autoLod = on;
    try { localStorage.setItem('vtp.mp.autoLod', on ? '1' : '0'); } catch { /* storage off */ }
    void this.relod();
  }
  /** Why my avatar isn't going out right now ('' = it is). */
  shareWhy(): string {
    if (!this.shareMine) return 'off';
    if (!this.myProfile) return 'none';
    if (!this.myModel) return this.modelWhy || 'none';
    if (this.overLimit()) return trisWhy(this.myTrisTotal);
    return '';
  }

  // ---------------------------------------------------------------- host (manual codes)
  async createInvite(): Promise<string> {
    if (this.role === 'guest') throw new Error('Leave the party you joined first');
    if (this.links.size >= MAX_GUESTS) throw new Error('Party is full (8 performers)');
    this.role = 'host';
    if (this.via === 'none') this.via = 'code';
    this.secret ||= rid(16);
    await this.ensureModel();
    await this.ensureCostume();
    await this.ensureLod();
    this.pending?.pc.close();
    const link = this.newLink('', 'code', new RTCPeerConnection({ iceServers: ICE_PUBLIC }));
    this.hostChannels(link);
    await link.pc.setLocalDescription(await link.pc.createOffer());
    await gathered(link.pc);
    this.pending = link;
    this.rebuildRoster();
    return pack({ v: 1, host: this.myId, secret: this.secret, sdp: link.pc.localDescription!.sdp });
  }

  async acceptReply(code: string) {
    const link = this.pending;
    if (!link) throw new Error('Create an invite first');
    const r = await unpack<{ v: number; sdp: string; secret: string }>(code);
    if (r.secret !== this.secret) throw new Error('That reply is for a different party');
    await link.pc.setRemoteDescription({ type: 'answer', sdp: String(r.sdp) });
    this.pending = null;
    this.say('Connecting…');
  }

  // ---------------------------------------------------------------- host (Discord relay)
  /** Host through the relay: `ticket` from POST /api/discord/room; `refresh` gets a new one for reconnects. */
  async hostDiscord(o: { relay: string; roomId: string; ticket: string; joinUrl: string; refresh: () => Promise<string> }) {
    if (this.role === 'guest') throw new Error('Leave the party you joined first');
    if (this.observer) throw new Error('Observer tabs never go live');
    this.role = 'host';
    this.via = 'discord';
    this.secret ||= rid(16);
    this.joinUrl = o.joinUrl;
    await this.ensureModel();
    await this.ensureCostume();
    await this.ensureLod();
    this.hostRoom = { ...o, retries: 0 };
    await this.connectHostRelay(o.ticket);
    try { sessionStorage.setItem(HOST_ROOM_KEY, JSON.stringify({ relay: o.relay, roomId: o.roomId, joinUrl: o.joinUrl, at: Date.now() })); } catch { /* storage off */ }
    this.rebuildRoster();
    const noTurn = !this.hasTurn();
    this.say(`Live — share the join link. Guests appear here when they click Join.${noTurn ? ' (No TURN on your relay: friends behind strict NAT / mobile / CGNAT can’t connect — ' + TURN_HELP + '.)' : ''}${this.relayOnly && noTurn ? ' “Hide my IP” is ignored until TURN is set up.' : ''}`);
  }

  /** After a studio reload: go back into the Discord room this tab was hosting (same join link), if it's still open. */
  private async resumeHost() {
    type Saved = { relay?: string; roomId?: string; joinUrl?: string; at?: number } | null;
    let saved: Saved = null;
    try { saved = JSON.parse(sessionStorage.getItem(HOST_ROOM_KEY) ?? 'null') as Saved; } catch { saved = null; }
    if (!saved?.relay || !saved.roomId || !saved.joinUrl || this.role !== 'none' || this.observer) return;
    const forget = () => { try { sessionStorage.removeItem(HOST_ROOM_KEY); } catch { /* storage off */ } };
    if (Date.now() - Number(saved.at ?? 0) > 12 * 3600_000) { forget(); return; }
    const { relay, roomId, joinUrl } = saved;
    try {
      const st = await discord.status();
      if (!st.signedIn) { forget(); return; }
      const ticket = await discord.hostTicket(roomId);   // fails once the room ended (host away > 3 min / expired)
      if ((this.role as PartyRole) !== 'none') return;
      this.autoApprove = st.autoApprove;
      this.relayOnly = st.relayOnly;
      await this.hostDiscord({ relay, roomId, ticket, joinUrl, refresh: () => discord.hostTicket(roomId) });
      this.say('Back in your party room after a reload — the same join link still works (guests who were in click Join again).');
    } catch {
      forget();
      if ((this.role as PartyRole) === 'host' && this.via === 'discord' && !this.relay?.open && this.remotes.size === 0) this.leave();
    }
  }

  private async connectHostRelay(ticket: string) {
    const room = this.hostRoom!;
    this.relay?.close();
    const rc = new RelayClient(room.relay, room.roomId, {
      welcome: (w) => this.onWelcome(w),
      knock: (k) => this.onKnock(k),
      left: (peer) => { this.knocks = this.knocks.filter((k) => k.peer !== peer); this.notify(); },
      signal: (from, d) => void this.onSignal(from, d),
      ended: (why) => { this.say(`Discord room closed (${why}) — connected guests stay`); this.relay = null; this.hostRoom = null; try { sessionStorage.removeItem(HOST_ROOM_KEY); } catch { /* storage off */ } this.notify(); },
      error: (msg) => this.say(`Relay: ${msg}`),
      closed: () => void this.reconnectHost(),
    });
    this.relay = rc;
    await rc.connect(ticket);
  }
  private async reconnectHost() {
    const room = this.hostRoom;
    if (!room || this.role !== 'host') return;
    if (room.retries++ > 6) { this.say('Lost the relay — guests already here stay connected; post a new invite for more.'); this.relay = null; return; }
    await new Promise((r) => setTimeout(r, 1500 * room.retries));
    try { await this.connectHostRelay(await room.refresh()); room.retries = 0; this.pushRosterToRelay(); } catch { void this.reconnectHost(); }
  }

  private onWelcome(w: Welcome) {
    this.ice = Array.isArray(w.ice) ? w.ice.slice(0, 6) : null;
    this.myDiscord = toIdentity(w.user);
    if (w.role === 'guest') this.hostInfo = w.host ?? null;
  }

  private onKnock(k: Knock) {
    if (this.role !== 'host') return;
    if (this.relayLinks.has(k.peer)) return; // already connecting / connected
    const knock: PendingKnock = { peer: k.peer, user: toIdentity(k.user), guildOk: !!k.guildOk && !k.link, at: Date.now(), ...(k.link ? { link: true } : {}) };
    if (this.remotes.size + this.relayLinks.size >= MAX_GUESTS) { this.relay?.deny(k.peer); return; }
    // a link guest I already let in, back after a dropped connection (same browser → same id): straight back in
    if (this.autoApprove || (knock.link && knock.user && this.linkOk.has(knock.user.id))) { void this.approve(knock); return; }
    this.knocks = [...this.knocks.filter((x) => x.peer !== k.peer), knock];
    this.say(`${knock.user?.name ?? 'Someone'} wants to join`);
  }

  /** Host: let a knocking Discord guest in (creates the WebRTC offer). */
  async approve(k: PendingKnock) {
    this.knocks = this.knocks.filter((x) => x.peer !== k.peer);
    if (!this.relay) return;
    this.relay.approve(k.peer);
    const link = this.newLink('', 'discord', new RTCPeerConnection(this.rtcConfig()));
    link.relayPeer = k.peer;
    link.who = { discord: k.user, verified: !k.link, guildOk: k.guildOk && !k.link };
    if (k.link && k.user) this.linkOk.add(k.user.id);
    this.relayLinks.set(k.peer, link);
    const uid = k.user?.id ?? k.peer;
    for (const [p, j] of this.joins) if (j.uid === uid) this.joins.delete(p);
    this.joins.set(k.peer, { peer: k.peer, uid, name: k.user?.name ?? 'Guest', link: !!k.link, state: 'connecting', at: Date.now(), lost: false });
    this.hostChannels(link);
    link.pc.onicecandidate = (e) => this.relay?.signal(k.peer, { candidate: e.candidate ? e.candidate.toJSON() : null });
    await link.pc.setLocalDescription(await link.pc.createOffer());
    this.relay.signal(k.peer, { sdp: { type: 'offer', sdp: link.pc.localDescription!.sdp } });
    this.notify();
  }
  deny(k: PendingKnock) { this.knocks = this.knocks.filter((x) => x.peer !== k.peer); this.relay?.deny(k.peer); this.notify(); }

  private hasTurn(): boolean {
    return (this.ice ?? []).some((s) => [s.urls].flat().some((u) => /^turns?:/.test(String(u))));
  }
  private rtcConfig(): RTCConfiguration {
    const ice = this.ice?.length ? this.ice : ICE_PUBLIC;
    return { iceServers: ice, iceTransportPolicy: this.relayOnly && this.hasTurn() ? 'relay' : 'all' };
  }

  private async onSignal(from: string, d: SignalData) {
    let link: Link | undefined;
    if (this.role === 'host') link = this.relayLinks.get(from);
    else if (this.role === 'guest') {
      link = [...this.links.values()][0];
      if (!link) { if (d.sdp?.type === 'offer') await this.guestOffer(d.sdp).catch((e) => this.say(`Connection setup failed: ${(e as Error).message}`)); return; }
    }
    if (!link) return;
    try {
      if (d.sdp) {
        if (this.role === 'host' && d.sdp.type === 'answer' && !link.remoteSet) { await link.pc.setRemoteDescription(d.sdp); link.remoteSet = true; }
        for (const c of link.iceQ.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
      } else if ('candidate' in d) {
        const c = d.candidate ?? undefined;
        if (!link.remoteSet) { if (c) link.iceQ.push(c); } else await link.pc.addIceCandidate(c).catch(() => {});
      }
    } catch (e) { this.say(`Connection setup failed: ${(e as Error).message}`); }
  }

  // ---------------------------------------------------------------- guest (Discord relay)
  /** Guest: join from a Discord invite ticket (after the consent screen). */
  async joinDiscord(o: { relay: string; ticket: string; share: boolean; policy: SharePolicy }) {
    if (this.role === 'host') throw new Error('You are hosting — leave first to join someone else');
    if (this.observer) throw new Error('Observer tabs never join');
    const room = peekTicket(o.ticket).r;
    if (!room) throw new Error('Not a VTube Pro join ticket');
    this.leave();
    this.role = 'guest';
    this.via = 'discord';
    this.setSharing(o.share, o.policy);
    this.secret = '';
    if (this.shareMine) { await this.ensureModel(); await this.ensureCostume(); await this.ensureLod(); }
    const rc = new RelayClient(o.relay, room, {
      welcome: (w) => this.onWelcome(w),
      approved: () => this.say(`${this.hostInfo?.name ?? 'The host'} let you in — connecting…`),
      denied: () => this.leave('The host declined'),
      kicked: (ban) => { this.leave(ban ? 'The host removed you (banned from this party)' : 'The host removed you from the party'); },
      mod: (m) => this.mod.onCtl({ t: 'mod', ...m }, this.hostInfo?.name),
      ended: () => { if (!this.links.size) { this.leave('The party has ended'); } else this.relay = null; },
      hostAway: (away) => this.say(away ? 'Host lost the relay (you stay connected)' : 'Host is back'),
      signal: (from, d) => void this.onSignal(from, d),
      error: (m) => this.say(`Relay: ${m}`),
      closed: () => { this.relay = null; },
    });
    this.relay = rc;
    try { await rc.connect(o.ticket); } catch (e) { this.leave(); throw e; }
    this.say(`Waiting for ${this.hostInfo?.name ?? 'the host'} to let you in…`);
    this.rebuildRoster();
  }

  /** Guest: the host's offer arrived through the relay → answer it (ICE trickles both ways). */
  private async guestOffer(sdp: { type: 'offer' | 'answer'; sdp: string }) {
    const link = this.newLink('@host', 'discord', new RTCPeerConnection(this.rtcConfig()));
    link.who = { discord: this.hostInfo ? { id: this.hostInfo.uid, name: this.hostInfo.name, avatar: this.hostInfo.avatar } : null, verified: true, guildOk: true };
    this.guestChannels(link);
    link.pc.onicecandidate = (e) => this.relay?.signal('host', { candidate: e.candidate ? e.candidate.toJSON() : null });
    this.links.set('@host', link);
    await link.pc.setRemoteDescription(sdp);
    link.remoteSet = true;
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    this.relay?.signal('host', { sdp: { type: 'answer', sdp: link.pc.localDescription!.sdp } });
    for (const c of link.iceQ.splice(0)) await link.pc.addIceCandidate(c).catch(() => {});
  }

  // ---------------------------------------------------------------- guest (manual codes)
  async join(invite: string, share = this.shareMine, policy = this.sharePolicy): Promise<string> {
    if (this.role === 'host') throw new Error('You are hosting — leave first to join someone else');
    const inv = await unpack<{ v: number; host: string; secret: string; sdp: string }>(invite);
    if (!PID.test(inv.host)) throw new Error('Bad invite');
    this.leave();
    this.role = 'guest';
    this.via = 'code';
    this.setSharing(share, policy);
    if (this.shareMine) { await this.ensureModel(); await this.ensureCostume(); await this.ensureLod(); }
    this.secret = String(inv.secret);
    const link = this.newLink(inv.host, 'code', new RTCPeerConnection({ iceServers: ICE_PUBLIC }));
    this.guestChannels(link);
    this.links.set(inv.host, link);
    await link.pc.setRemoteDescription({ type: 'offer', sdp: String(inv.sdp) });
    link.remoteSet = true;
    await link.pc.setLocalDescription(await link.pc.createAnswer());
    await gathered(link.pc);
    this.say('Send the reply code back to the host');
    return pack({ v: 1, secret: this.secret, sdp: link.pc.localDescription!.sdp });
  }

  /** A Discord join link reached this PC (/join) — hand it to the consent screen. */
  async takePendingJoin() {
    try {
      const r = await fetch('/api/discord/pending-join/take', { method: 'POST', cache: 'no-store' });
      if (!r.ok) return;
      const j = (await r.json()) as { relay?: string; ticket?: string; trusted?: boolean };
      if (!j.relay || !j.ticket) return;
      const t = peekTicket(j.ticket);
      const req: JoinRequest = { relay: j.relay, ticket: j.ticket, hostName: String(t.hn ?? 'the host').slice(0, 40), you: String(t.n ?? '').slice(0, 40), trusted: !!j.trusted };
      if (this.onJoinRequest) this.onJoinRequest(req);
      else void import('./ui/joinConsent.ts').then((m) => m.askJoinConsent(this, req));
    } catch { /* server offline */ }
  }

  // ---------------------------------------------------------------- leaving / kicking
  kick(id: string, ban = false) {
    this.green.forget(id);
    const l = this.links.get(id);
    if (l) { this.send(l, { t: 'kick' }); setTimeout(() => l.pc.close(), 200); if (l.relayPeer) this.relay?.kick(l.relayPeer, ban); }
    const uid = this.remotes.get(id)?.discord?.id;
    if (ban && uid) this.relay?.ban(uid);
    this.dropRemote(id);
  }

  /** Leave / end the party (`why` stays visible as the status). */
  leave(why = '') {
    for (const l of this.links.values()) { this.send(l, { t: 'bye', owner: this.myId }); this.endLink(l); l.pc.close(); }
    for (const o of this.orphans.values()) for (const [, d] of o.q) wipe(d);
    this.orphans.clear();
    this.myDeliveries = [];
    for (const l of this.relayLinks.values()) l.pc.close();
    this.pending?.pc.close();
    this.pending = null;
    this.links.clear();
    this.relayLinks.clear();
    if (this.relay) { if (this.role === 'host') this.relay.end(); else this.relay.close(); }
    this.relay = null;
    this.hostRoom = null;
    try { sessionStorage.removeItem(HOST_ROOM_KEY); } catch { /* storage off */ }
    this.knocks = [];
    this.joins.clear();
    for (const id of [...this.remotes.keys()]) this.dropRemote(id, false);
    this.green.reset();
    this.mod.reset(); this.voice.hostLock = false;
    this.tvLinks.reset();
    this.voice.reset();
    if (this.hasVault()) vault.purge(this.vsid);
    this.vsid = rid(24);
    this.role = 'none';
    this.via = 'none';
    this.secret = '';
    this.joinUrl = '';
    this.hostInfo = null;
    this.rebuildRoster();
    this.say(why);
  }

  /** Host → every guest: the scene state (room, mode, camera, spots, presence). */
  sendScene(s: SceneState) {
    if (this.role !== 'host') return;
    this.sceneState = s;
    for (const l of this.links.values()) if (l.ready) this.send(l, { t: 'scene', state: { ...s, sentAt: Date.now() } });   // guests derive a clock offset (walk sync)
  }

  /** Host → every guest: live chat / support events (src/chat/studioChat.ts sanitises + caps them; never test events). */
  sendChat(evs: unknown[], tot?: unknown, snap = false) {
    if (this.role !== 'host') return;
    const msg: Wire = { t: 'chat', evs, ...(tot ? { tot } : {}), ...(snap ? { snap: true } : {}) };
    for (const l of this.links.values()) if (l.ready) this.send(l, msg);
  }

  /** Host → every guest: the goals / subathon view (src/goals/goalsRelay.ts; a few KB, ≤ 2 a second). */
  sendGoals(s: unknown) {
    if (this.role !== 'host') return;
    const msg: Wire = { t: 'goals', s };
    for (const l of this.links.values()) if (l.ready) this.send(l, msg);
  }

  /** Host → every guest: the DJ decks' controller snapshot (src/scene/djdeck/deckRelay.ts; ≤ 10 a second). */
  sendDjDeck(s: unknown) {
    if (this.role !== 'host') return;
    const msg: Wire = { t: 'djdeck', s };
    for (const l of this.links.values()) if (l.ready) this.send(l, msg);
  }

  /** Host → every guest: one beat packet (the lights; ~30 Hz). */
  sendBeat(b: BeatPacket) {
    if (this.role !== 'host') return;
    const msg: Wire = { t: 'beat', b };
    for (const l of this.links.values()) if (l.ready) this.send(l, msg);
  }

  /** Host → every guest: the interview director's cue (shared/talkshow.ts InterviewCue: each cut + a heartbeat a second),
   *  relayed to their OBS pages so every page in the party shows the same shot (older peers ignore the unknown type). */
  sendInterviewCue(c: InterviewCue) {
    if (this.role !== 'host') return;
    const msg: Wire = { t: 'ivcue', c };
    for (const l of this.links.values()) if (l.ready) this.send(l, msg);
  }

  /** TTRPG table channel (src/ttrpg/studio, shared/ttrpg/wire.ts): host → every guest (or one: `to`), guest → the host.
   *  Rides the reliable 'ctl' channel (≤ 64 kB per message; older peers ignore the unknown type). */
  sendTtrpg(d: unknown, to?: string) {
    if (this.role === 'none') return;
    const msg = { t: 'ttrpg', d } as unknown as Wire;
    for (const [id, l] of this.links) if (l.ready && (!to || id === to)) this.send(l, msg);
  }

  // ---------------------------------------------------------------- frames + voice out (from the app loop)
  sendFrame(f: TrackingFrame) {
    if (this.role === 'none' || this.myTv) return;
    const now = performance.now();
    this.lastMouth = { open: f.mouth?.open ?? 0, closure: f.mouth?.closure ?? 0 };
    // voice-mouth samples at 50 Hz from the fused frame, unless a voice front-end feeds voiceFrame() directly
    // (a 60 Hz app loop sends every tick; the gate only stops faster loops from flooding)
    if (now - this.extVoiceAt > 500 && now - this.lastVoice >= VOICE_MS * 0.75) {
      const vis = f.visemes;
      this.pushVoice({ t: now, vad: f.mouth?.speak ?? (vis ? 1 - (vis.sil ?? 0) : 0), level: f.mouth?.open ?? 0, open: f.mouth?.open ?? 0, closure: f.mouth?.closure ?? 0, vis: topVisemes(vis) });
    }
    if (now - this.lastSent < 1000 / FRAME_HZ - 6) return; // half a 60 Hz tick of slack → a steady 20 Hz
    this.lastSent = now;
    const clean = sanitizeFrame(f);
    // (a playing emote travels in the snack JSON: guests' OBS pages play the same clip)
    const ew = emoteToWire(f.emote);
    if (ew) clean.snack = { ...(clean.snack ?? {}), e: ew } as SnackFrame;
    if (clean.flat) clean.snack = { ...(clean.snack ?? {}), fl: clean.flat } as SnackFrame;
    const pkt = encodeFrame(clean, this.seq++ & 0xffff, now);
    for (const l of this.links.values()) {
      if (!l.ready || !this.mayShareMine(l)) continue;
      if (!this.sendRt(l, pkt)) this.send(l, { t: 'frame', owner: this.myId, f: clean });
    }
  }

  /** Voice front-end hook (src/audio): call with every analysis frame, e.g. voice.onFrame((v) => party.voiceFrame(v)).
   *  Uses this PC's clock; jaw open / lip closure come from the latest tracking frame. */
  voiceFrame(v: { t?: number; vad: number; level: number; visemes?: Record<string, number> | null }) {
    const now = performance.now();
    this.extVoiceAt = now;
    if (this.role === 'none' || now - this.lastVoice < VOICE_MS * 0.75) return;
    this.pushVoice({ t: now, vad: v.vad, level: v.level, open: this.lastMouth.open, closure: this.lastMouth.closure, vis: topVisemes(v.visemes ?? undefined) });
  }
  /** Subscribe to a voice front-end exposing onFrame(cb). */
  attachVoice(src: { onFrame(cb: (v: { t?: number; vad: number; level: number; visemes?: Record<string, number> | null }) => void): unknown }) {
    return src.onFrame((v) => this.voiceFrame(v));
  }
  private pushVoice(s: VoiceSample) {
    this.lastVoice = s.t;
    this.vhist.push(s);
    if (this.vhist.length > 3) this.vhist.shift();
    const pkt = encodeVoice(this.vhist, this.vseq++ & 0xffff);
    for (const l of this.links.values()) if (l.ready && this.mayShareMine(l)) this.sendRt(l, pkt);
  }

  private sendRt(l: Link, pkt: Uint8Array): boolean {
    const rt = l.rt;
    if (!rt || rt.readyState !== 'open' || !l.caps.has('rt1')) return false;
    if (rt.bufferedAmount > 256 << 10) return true; // congested: drop (the receiver extrapolates)
    const sim = this.debugNet;
    if (sim) {
      if (Math.random() < sim.loss) return true;
      const d = sim.delay + Math.random() * sim.jitter;
      setTimeout(() => { if (rt.readyState === 'open') rt.send(pkt as Uint8Array<ArrayBuffer>); }, d);
      return true;
    }
    rt.send(pkt as Uint8Array<ArrayBuffer>);
    return true;
  }

  // ---------------------------------------------------------------- consent / custody rules
  /** May my avatar (and so my frames) go over this link? Guests: only to the host, only if I agreed. The host:
   *  guests allowed by my policy. */
  private mayShareMine(l: Link): boolean {
    if (!this.shareMine) return false;
    if (this.remotes.get(l.id)?.lite) return false;          // a browser-only TV guest can't show avatars
    if (this.role === 'guest') return true;
    if (this.sharePolicy === 'guild') return l.who.verified && l.who.guildOk;
    return true; // 'party' ('host' means nobody-but-the-host, which for the host itself is everyone it hosts)
  }
  /** Host: may owner `r`'s avatar be re-shared with member `to`? */
  private mayRelay(r: Remote, to: string): boolean {
    if (!r.avatar) return false;
    if (this.remotes.get(to)?.lite) return false;
    const rec = this.links.get(to);
    if (!rec) return false;
    if (r.share === 'host') return false;
    if (r.share === 'guild') return rec.who.verified && rec.who.guildOk;
    return true;
  }

  // ---------------------------------------------------------------- plumbing
  private newLink(id: string, via: 'code' | 'discord', pc: RTCPeerConnection): Link {
    return { id, pc, ctl: null, bin: null, rt: null, ready: false, caps: new Set(), via, who: { discord: null, verified: false, guildOk: false }, remoteSet: false, iceQ: [], rtt: 0, pings: new Map(), out: new Map() };
  }
  private hostChannels(link: Link) {
    link.ctl = link.pc.createDataChannel('ctl', { ordered: true });
    link.bin = link.pc.createDataChannel('bin', { ordered: true });
    link.rt = link.pc.createDataChannel('rt', { ordered: false, maxRetransmits: 0 });
    link.bin.binaryType = 'arraybuffer';
    link.rt.binaryType = 'arraybuffer';
    this.wire(link);
  }
  private guestChannels(link: Link) {
    link.pc.ondatachannel = (e) => {
      if (e.channel.label === 'ctl') link.ctl = e.channel;
      if (e.channel.label === 'bin') { link.bin = e.channel; link.bin.binaryType = 'arraybuffer'; }
      if (e.channel.label === 'rt') { link.rt = e.channel; link.rt.binaryType = 'arraybuffer'; }
      this.wire(link);
    };
    link.pc.onconnectionstatechange = () => this.onState(link);
  }
  private wire(link: Link) {
    const ctl = link.ctl, bin = link.bin, rt = link.rt;
    if (ctl && !ctl.onmessage) {
      ctl.onopen = () => this.onOpen(link);
      ctl.onmessage = (e) => this.onCtl(link, e.data);
      if (ctl.readyState === 'open') this.onOpen(link);
    }
    if (bin && !bin.onmessage) {
      bin.onmessage = (e) => this.onBin(link, e.data as ArrayBuffer);
      const flush = () => { const q = link.binWait ?? []; link.binWait = []; for (const w of q) w(bin); };
      if (bin.readyState === 'open') flush(); else bin.addEventListener('open', flush, { once: true });
    }
    if (rt && !rt.onmessage) rt.onmessage = (e) => this.onRt(link, e.data);
    link.pc.onconnectionstatechange = () => this.onState(link);
  }

  private onOpen(link: Link) {
    if (link.ready) return;
    link.ready = true;
    // the host says who it is; guests introduce themselves; the host answers with the roster + everyone's avatar
    if (this.role === 'host') { this.send(link, { t: 'welcome', id: this.myId, caps: CAPS }); this.send(link, { t: 'limits', maxTris: this.maxTris }); }
    // guests: introduce once the host's welcome said which transfer format it speaks (old hosts: after 3 s anyway)
    if (this.role === 'guest') { if (link.welcomed) this.introduce(link); else link.introT = window.setTimeout(() => { if (!link.introduced) this.introduce(link); }, 3000); }
  }

  /** My avatar really goes out: sharing on, the model loaded, under the party's polycount limit. */
  private sharingNow(): boolean { return this.shareMine && !!this.myModel && !this.overLimit() && !this.myTv; }
  /** Host → guests: my own profile (+ whether my model follows, and why not). */
  private myProfileMsg(): Wire {
    if (this.myTv) return { t: 'profile', owner: this.myId, name: this.myDiscord?.name ?? this.name, profile: null, bytes: 0, share: this.sharePolicy, avatar: false, why: 'tv', tv: this.myTv };
    return { t: 'profile', owner: this.myId, name: this.myDiscord?.name ?? this.name, profile: this.shareProfile(), bytes: this.myModel?.byteLength ?? 0, share: this.sharePolicy, avatar: this.sharingNow(), why: this.shareWhy() };
  }
  private hostLink(): Link | undefined { return this.role === 'guest' ? this.links.values().next().value : undefined; }

  private helloMsg(): Wire {
    if (this.myTv) return { t: 'hello', id: this.myId, name: (this.myDiscord?.name ?? this.name).slice(0, 40), secret: this.secret, profile: null, bytes: 0, caps: CAPS, share: this.sharePolicy, avatar: false, why: 'tv', tv: this.myTv };
    return { t: 'hello', id: this.myId, name: (this.myDiscord?.name ?? this.name).slice(0, 40), secret: this.secret, profile: this.shareMine ? this.shareProfile() : null, bytes: this.shareMine ? this.myModel?.byteLength ?? 0 : 0, caps: CAPS, share: this.sharePolicy, avatar: this.shareMine && !!this.myModel && !this.overLimit(), why: this.shareWhy() };
  }
  private introduce(link: Link) {
    link.introduced = true;
    if (link.introT) { clearTimeout(link.introT); link.introT = 0; }
    // what went out counts as announced (a 'limits' message that changes nothing must not send the model twice)
    this.sharedJson = JSON.stringify(this.shareProfile()); this.sentOver = this.overLimit(); this.sentModel = this.myModel;
    this.send(link, this.helloMsg());
    if (this.shareMine) this.sendMine(link);
  }

  private sendMine(link: Link) {
    if (!this.mayShareMine(link) || this.overLimit() || this.myTv) return;
    if (this.myModel) void this.sendBlob(link, this.myId, 'm', new Uint8Array(this.myModel), { fresh: true });
    const c = this.costumeFor(link);
    link.sentC = c?.id;
    if (c) void this.sendBlob(link, this.myId, 'c', new Uint8Array(c.buf), { fresh: true, meta: c.id });
  }

  private shareProfile() {
    const p = this.myProfile;
    if (!p) return null;
    // only what's needed to animate + dress it; paths, prompts and your other costumes stay home
    const { eyes, mouth, brows, look, blush, rig, physics, tracking, transform, size, neck, body } = p;
    const dress = (d: CostumeDef) => ({ id: d.id, name: d.name, hides: d.hides, labels: d.labels, eyes: d.eyes, fit: d.fit,
      ...(d.kind ? { kind: d.kind } : {}), ...(d.grip ? { grip: d.grip } : {}), ...(d.surface ? { surface: d.surface } : {}) });
    const def = p.costume ? p.costumes.find((c) => c.id === p.costume) : null;
    const costume = def && this.myCostume?.id === def.id ? dress(def) : null;
    // the costume set 'acc1' peers get (its id, so they know which 'c' to wait for) + the accessories in it
    const set = this.mySet;
    const accessories = set ? set.acc.flatMap((id) => { const d = p.costumes.find((c) => c.id === id); return d ? [dress(d)] : []; }) : [];
    return { name: this.myDiscord?.name ?? this.name, eyes, mouth, brows, look, blush, rig, physics, tracking, transform, costume,
      ...(set ? { set: set.id, accessories } : {}), ...(size ? { size } : {}), ...(neck ? { neck } : {}), ...(body ? { body } : {}), ...(p.flat ? { flat: p.flat } : {}) };
  }

  private announceSelf() {
    this.sharedJson = JSON.stringify(this.shareProfile());
    this.sentOver = this.overLimit();
    this.sentModel = this.myModel;
    for (const l of this.links.values()) {
      if (!l.ready) continue;
      if (this.role === 'guest') this.introduce(l);
      else if (this.mayShareMine(l)) {
        this.send(l, this.myProfileMsg());
        this.sendMine(l);
      }
    }
  }

  private onState(link: Link) {
    const s = link.pc.connectionState;
    if (s === 'connected') { if (link.relayPeer && this.joins.delete(link.relayPeer)) this.notify(); if (link.dropT) { clearTimeout(link.dropT); link.dropT = 0; } this.say('Connected ✔'); return; }
    if (s === 'disconnected') {
      // usually recovers by itself within a few seconds: don't tear the party down on a blip
      if (!link.dropT) link.dropT = window.setTimeout(() => { link.dropT = 0; if (link.pc.connectionState === 'disconnected') this.linkLost(link, 'disconnected'); }, DISCONNECT_GRACE_MS);
      return;
    }
    if (s === 'failed' || s === 'closed') this.linkLost(link, s);
  }
  /** A link is gone: transfers waiting for its binary channel give up, the ones in flight stop. */
  private endLink(l: Link) {
    if (l.id) this.tvLinks.peerDown(l.id);
    if (l.id) this.voice.peerDown(l.id);
    for (const w of l.binWait ?? []) w(null);
    l.binWait = [];
    for (const ox of l.out.values()) { ox.gen++; ox.abort?.(); }
    for (const d of l.early ?? []) wipe(d);
    l.early = []; l.earlyBytes = 0;
    if (l.introT) { clearTimeout(l.introT); l.introT = 0; }
  }
  private retireLink(old: Link) {
    this.endLink(old);
    if (old.dropT) { clearTimeout(old.dropT); old.dropT = 0; }
    if (old.relayPeer && this.relayLinks.get(old.relayPeer) === old) this.relayLinks.delete(old.relayPeer);
    old.id = '';               // (its close → linkLost must not drop the member that now lives on the new link)
    try { old.pc.close(); } catch { /* already closed */ }
  }
  private linkLost(link: Link, s: RTCPeerConnectionState) {
    this.endLink(link);
    if (link.dropT) { clearTimeout(link.dropT); link.dropT = 0; }
    if (this.role === 'guest') { this.leave(s === 'failed' ? `Connection failed (a strict firewall / NAT blocked it — the host needs to ${TURN_HELP})` : 'Disconnected from host'); return; }
    if (this.role !== 'host') return;
    const current = !link.relayPeer || this.relayLinks.get(link.relayPeer) === link;
    if (link.relayPeer && current) this.relayLinks.delete(link.relayPeer);
    const who = (link.id && this.remotes.get(link.id)?.name) || link.who.discord?.name || 'A guest';
    if (link.relayPeer && current) {
      const j = this.joins.get(link.relayPeer);
      if (s === 'failed') this.joins.set(link.relayPeer, { peer: link.relayPeer, uid: j?.uid ?? link.who.discord?.id ?? link.relayPeer, name: who, link: j?.link ?? !link.who.verified, state: 'failed', at: Date.now(), lost: link.ready });
      else this.joins.delete(link.relayPeer);
    }
    if (link.id) this.dropRemote(link.id);
    if (s === 'failed' && current) this.say(`${who} couldn’t connect${link.ready ? ' (connection lost)' : ''} — a firewall / NAT blocked the direct connection. ${this.hasTurn() ? 'Ask them to try another network.' : `To fix it for everyone, ${TURN_HELP}.`}`);
    else this.notify();
  }

  private send(link: Link, m: Wire) {
    if (link.ctl?.readyState === 'open' && link.ctl.bufferedAmount < 4 << 20) link.ctl.send(JSON.stringify(m));
  }

  private pingAll() {
    const now = performance.now();
    for (const l of this.links.values()) {
      if (!l.ready) continue;
      const n = Math.floor(Math.random() * 1e9);
      l.pings.set(n, now);
      if (l.pings.size > 8) l.pings.delete(l.pings.keys().next().value!);
      this.send(l, { t: 'ping', n });
    }
  }

  /** Stream one binary asset to one peer (the model 'm' or the worn costume 'c'). Transfers to one peer run ONE AT A
   *  TIME (two pumps on a channel would interleave chunks and fight over its single onbufferedamountlow handler).
   *  'xf1' peers: X begin {transfer id, kind, size, CRC-32, costume id, resume offset} → D chunks (id + offset) → E end;
   *  the receiver acks or says exactly why not (onCtl 'xack'), resolverTick() resends / resumes. Older peers: the legacy
   *  packets (32-byte owner id + kind byte + data; the upper-case kind ends it and carries the costume id).
   *  `src` = my own buffer (never wiped) or a producer of a fresh plaintext copy (a relay: wiped right after sending).
   *  A newer transfer of the same owner + kind supersedes a queued / running one. Resolves true once all is handed over. */
  private sendBlob(link: Link, owner: string, kind: Kind, src: Uint8Array | (() => Promise<Uint8Array>), o: { meta?: string; hash?: string; from?: number; fresh?: boolean } = {}): Promise<boolean> {
    const key = `${owner}:${kind}`;
    let ox = link.out.get(key);
    if (!ox) {
      ox = { owner, kind, x: 0, n: 0, h: '', st: 'queued', why: '', tries: 0, sent: 0, got: 0, at: performance.now(), legacy: false, retryAt: Infinity, resume: 0, gen: 0, abort: null };
      link.out.set(key, ox);
    }
    const gen = ++ox.gen;
    if (o.fresh) ox.tries = 0;
    if (ox.st !== 'sending') { ox.st = 'queued'; ox.why = ''; ox.retryAt = Infinity; ox.at = performance.now(); }
    const x = ox;
    const run = (link.blobQ ?? Promise.resolve()).then(() => this.pumpBlob(link, x, gen, src, o));
    link.blobQ = run.then(() => {}, () => {});
    return run.catch(() => false);
  }
  private async pumpBlob(link: Link, ox: OutXfer, gen: number, src: Uint8Array | (() => Promise<Uint8Array>), o: { meta?: string; hash?: string; from?: number }): Promise<boolean> {
    if (ox.gen !== gen) return false;                                    // superseded while queued
    const bin = link.bin?.readyState === 'open' ? link.bin : await new Promise<RTCDataChannel | null>((res) => (link.binWait ??= []).push(res));
    if (!bin || bin.readyState !== 'open' || ox.gen !== gen) { if (ox.gen === gen) { ox.st = 'failed'; ox.why = 'closed'; } return false; }
    const produced = typeof src === 'function';
    let buf: Uint8Array | null = null;
    if (produced) {
      await this.relaySlot();
      try { buf = await src(); } catch { this.relayDone(); if (ox.gen === gen) { ox.st = 'failed'; ox.why = 'gone'; } return false; }
    } else buf = src;
    try {
      const { owner, kind } = ox;
      const legacy = !link.caps.has(XF_CAP);
      let meta = o.meta ?? '';
      if (kind === 'c' && !meta) meta = owner === this.myId ? this.costumeFor(link)?.id ?? '' : this.relayCostume(this.remotes.get(owner), link)?.id ?? '';
      const n = buf.byteLength;
      let from = 0;
      if (!legacy) {
        const h = o.hash || await this.hashOf(buf);
        if (ox.gen !== gen) return false;
        from = o.from && o.from > 0 && o.from < n ? o.from : 0;          // resume (the caller checked the receiver's hash)
        ox.h = h; ox.x = newXferId();
        bin.send(encBegin(owner, { x: ox.x, k: kind, n, h, c: meta.slice(0, 40), o: from }) as Uint8Array<ArrayBuffer>);
      }
      Object.assign(ox, { n, legacy, st: 'sending', why: '', sent: from, got: from, at: performance.now(), retryAt: Infinity });
      const te = new TextEncoder();
      const ok = await this.pumpBytes(bin, ox, gen, buf, from, legacy ? te.encode(owner.padEnd(32, ' ') + kind) : null);
      if (!ok) { if (ox.gen === gen && ox.st === 'sending') { ox.st = 'failed'; ox.why = 'closed'; } return false; }
      bin.send((legacy ? te.encode(owner.padEnd(32, ' ') + kind.toUpperCase() + meta.slice(0, 40)) : encEnd(owner, ox.x)) as Uint8Array<ArrayBuffer>);
      ox.st = 'sent'; ox.at = performance.now();
      this.xlog(`sent ${kind === 'm' ? 'model' : 'costume'} of ${this.nameOf(owner)} ${fmtMB(n)}${from ? ` (resumed at ${fmtMB(from)})` : ''} → ${this.nameOf(link.id)}${legacy ? ' (older app: no receipt)' : ''}`);
      return true;
    } catch { if (ox.gen === gen) { ox.st = 'failed'; ox.why = 'closed'; } return false; }
    finally { if (produced) { wipe(buf); this.relayDone(); } }
  }
  /** The chunk loop: backpressure on bufferedAmount (2 MB high / 512 kB low); ends false on close / abort / superseded. */
  private pumpBytes(bin: RTCDataChannel, ox: OutXfer, gen: number, buf: Uint8Array, from: number, legacyHead: Uint8Array | null): Promise<boolean> {
    const n = buf.byteLength, sim = this.debugNet, t0 = performance.now();
    let off = from;
    return new Promise((res) => {
      let over = false;
      const end = (ok: boolean) => {
        if (over) return;
        over = true;
        bin.removeEventListener('close', onClose);
        if (bin.onbufferedamountlow === pump) bin.onbufferedamountlow = null;
        if (ox.abort === abort) ox.abort = null;
        res(ok);
      };
      const onClose = () => end(false);
      const abort = () => end(false);
      bin.addEventListener('close', onClose);
      ox.abort = abort;
      const pump = () => {
        if (over) return;
        try {
          while (off < n) {
            // (a legacy receiver can't tell a cut-off transfer from the next one: those always run to the end)
            if (bin.readyState !== 'open' || (!legacyHead && ox.gen !== gen)) { end(false); return; }
            if (bin.bufferedAmount > 2 << 20) { bin.bufferedAmountLowThreshold = 512 << 10; bin.onbufferedamountlow = pump; return; }
            if (sim?.binStallAt && off >= n * sim.binStallAt) return;                                     // test: never drains
            if (sim?.binKBps && off - from > (performance.now() - t0) * sim.binKBps * 1.024) { setTimeout(pump, 20); return; }
            const part = buf.subarray(off, Math.min(n, off + CHUNK));
            let pkt: Uint8Array;
            if (legacyHead) { pkt = new Uint8Array(33 + part.length); pkt.set(legacyHead, 0); pkt.set(part, 33); }
            else pkt = encData(ox.owner, ox.x, off, part);
            if (sim?.binCorrupt && Math.random() < sim.binCorrupt) pkt[pkt.length - 1] ^= 0x5a;
            if (!(sim?.binDrop && Math.random() < sim.binDrop)) bin.send(pkt as Uint8Array<ArrayBuffer>);
            off += part.length;
            ox.sent = off;
            if (legacyHead) ox.at = performance.now();
          }
          end(true);
        } catch { end(false); }                                           // send() throws once the channel is closing
      };
      pump();
    });
  }
  private relaySlot(): Promise<void> {
    if (this.relaySlots > 0) { this.relaySlots--; return Promise.resolve(); }
    return new Promise((r) => this.relayWait.push(r));
  }
  private relayDone() { const w = this.relayWait.shift(); if (w) w(); else this.relaySlots++; }
  private hashOf(b: Uint8Array): Promise<string> {
    if (b.byteOffset !== 0 || b.byteLength !== b.buffer.byteLength) return checksum(b);
    let p = this.hashes.get(b.buffer);
    if (!p) { p = checksum(b); this.hashes.set(b.buffer, p); }
    return p;
  }
  private nameOf(id: string): string { return id === this.myId ? 'me' : this.remotes.get(id)?.name ?? (id ? id.slice(0, 6) : 'a new link'); }

  private onCtl(link: Link, data: unknown) {
    if (typeof data !== 'string' || data.length > 64 * 1024) return;
    let m: Wire;
    try { m = JSON.parse(data) as Wire; } catch { return; }
    // from a guest, only its own identity is accepted (no spoofing other members)
    const fromGuest = this.role === 'host';
    if ((m as { t?: string }).t === 'ttrpg') { if (!fromGuest || this.remotes.has(link.id)) this.onTtrpg((m as { d?: unknown }).d, fromGuest ? link.id : null); return; }
    // green room: READY / notes / mute (guest → host), where you are + messages (host → guest)
    if ((m as { t?: string }).t === 'gr') { if (fromGuest ? this.remotes.has(link.id) : link.caps.has(GR_CAP)) this.green.onCtl(link.id, fromGuest, m); return; }
    // moderation: host → me only (a guest never moderates anyone)
    if ((m as { t?: string }).t === 'mod') { if (!fromGuest) this.mod.onCtl(m, this.hostInfo?.name); return; }
    switch (m.t) {
      case 'ping': this.send(link, { t: 'pong', n: Number(m.n) || 0 }); return;
      case 'tvsig': if (link.id && link.ready && link.caps.has(TV_CAP)) this.tvLinks.onSig(link.id, m); return;
      case 'vsig': if (link.id && link.ready && link.caps.has(VOX_CAP) && (!fromGuest || this.remotes.has(link.id))) this.voice.onSig(link.id, m); return;
      case 'pong': { const t0 = link.pings.get(Number(m.n)); if (t0 !== undefined) { link.pings.delete(Number(m.n)); link.rtt = Math.round(performance.now() - t0); } return; }
      case 'welcome': {
        if (fromGuest || !PID.test(String(m.id))) return;
        link.caps = new Set((Array.isArray(m.caps) ? m.caps : []).map(String).slice(0, 16));
        if (link.id !== m.id) { if (this.links.get(link.id) === link) this.links.delete(link.id); link.id = m.id; this.links.set(m.id, link); }
        link.welcomed = true;
        if (this.role === 'guest' && link.ready && !link.introduced) this.introduce(link);
        if (this.role === 'guest') queueMicrotask(() => this.green.hello());
        if (this.role === 'guest' && link.caps.has(TV_CAP)) this.tvLinks.peerUp(link.id);
        if (this.role === 'guest') this.voice.peerUp(link.id);      // (an old host: the panel says "too old — use Discord")
        return;
      }
      case 'hello': {
        if (!fromGuest || !PID.test(String(m.id))) return;
        if (link.via === 'code' && m.secret !== this.secret) return;
        link.caps = new Set((Array.isArray(m.caps) ? m.caps : []).map(String).slice(0, 16));
        const share = isPolicy(m.share) ? m.share : 'party';
        const avatar = m.avatar !== false && !!m.profile;
        const why = avatar ? '' : typeof m.why === 'string' ? m.why : !m.profile ? 'none' : 'off';
        if (link.id) { // an update from a guest we already know (costume switch, label edit, sharing toggled)
          if (m.id !== link.id) return;
          this.addRemote(m.id, m.name, m.profile, m.bytes, link, share, avatar, why);
          this.applyTv(m.id, m.tv, m.lite);
          for (const [id, l] of this.links) if (id !== m.id) this.send(l, this.relayProfile(this.remotes.get(m.id)!, id));
          this.tvLinks.membersChanged();
          break;
        }
        const rejoin = this.remotes.has(m.id);
        if (rejoin) {
          const old = this.links.get(m.id);
          if (old === link) return;
          if (old) this.retireLink(old);
          this.resetRx(this.remotes.get(m.id)!);
        } else if (this.remotes.size >= MAX_GUESTS) { this.send(link, { t: 'kick' }); return; }
        link.id = m.id;
        this.links.set(m.id, link);
        this.addRemote(m.id, m.name, m.profile, m.bytes, link, share, avatar, why);
        this.applyTv(m.id, m.tv, m.lite);
        const r = this.remotes.get(m.id)!;
        // packets that beat this hello on the other channel (held in onBin), now that we know who sent them
        const early = link.early ?? [];
        link.early = []; link.earlyBytes = 0;
        for (const d of early) this.onBin(link, d);
        // the newcomer gets the host + everyone already here (as each owner allows)
        if (this.mayShareMine(link)) {
          this.send(link, this.myProfileMsg());
          this.sendMine(link);
        } else this.send(link, { ...this.myProfileMsg(), profile: null, avatar: false, why: this.shareMine ? 'policy:guild' : 'off' } as Wire);
        for (const o of this.remotes.values()) {
          if (o.id === m.id) continue;
          // (a model still on its way to the host is relayed by accept() once it's here — the newcomer must already
          //  know the owner shares it, or it would throw the model away as unannounced)
          this.send(link, this.relayProfile(o, m.id));
          if (this.mayRelay(o, m.id) && o.sealedModel) void this.relaySealed(o, link);
        }
        // …and everyone else hears about the newcomer (its model is relayed once it arrives)
        for (const [id, l] of this.links) if (id !== m.id) this.send(l, this.relayProfile(r, id));
        this.rebuildRoster();
        if (this.sceneState) this.send(link, { t: 'scene', state: { ...this.sceneState, sentAt: Date.now() } });
        if (link.caps.has(TV_CAP)) this.tvLinks.peerUp(m.id);
        this.voice.peerUp(m.id);
        this.say(rejoin ? `${r.name} reconnected` : `${r.name} joined`);
        break;
      }
      case 'profile': {
        if (fromGuest) return; // guests re-announce with 'hello'
        if (m.owner === this.myId || !PID.test(String(m.owner))) return;
        const host = m.owner === link.id;
        this.addRemote(m.owner, m.name, m.profile, m.bytes, host ? link : null, isPolicy(m.share) ? m.share : 'party', m.avatar !== false && !!m.profile, typeof m.why === 'string' ? m.why : '');
        this.applyTv(m.owner, m.tv);
        break;
      }
      case 'frame': { // legacy JSON frames
        const owner = fromGuest ? link.id : m.owner;
        const r = this.remotes.get(owner);
        if (!r) return;
        const now = performance.now();
        if (now - r.lastFrame < 1000 / (FRAME_HZ * 2)) return; // rate limit
        r.lastFrame = now;
        const f = sanitizeFrame(m.f);
        r.net.pushFrame(f, undefined, now);
        if (r.refs.model) this.bus.send({ type: 'frame', frame: f, peer: owner });
        if (this.role === 'host') for (const [id, l] of this.links) if (id !== owner && r.sentTo.has(id)) this.send(l, { t: 'frame', owner, f });
        break;
      }
      case 'roster': {
        if (fromGuest || !Array.isArray(m.members)) return;
        this.roster = m.members.slice(0, 8).filter((x) => PID.test(String(x.id))).map((x, i) => ({
          id: String(x.id), name: String(x.name).slice(0, 40), slot: Number(x.slot) || i,
          discord: toIdentity(x.discord as never), verified: x.verified === true, share: isPolicy(x.share) ? x.share : 'party', avatar: x.avatar !== false,
          tv: sanitizeTvInfo(x.tv),
        }));
        // the host vouches for who everyone is (it saw their relay-verified Discord identity)
        for (const x of this.roster) { const r = this.remotes.get(x.id); if (r) { r.discord = x.discord ?? null; r.verified = !!x.verified; r.name = x.name; } }
        this.publishLocal();
        break;
      }
      case 'bye': {
        const owner = fromGuest ? link.id : m.owner;
        if (fromGuest) { link.pc.close(); this.dropRemote(owner); }
        else if (owner === link.id) { this.leave('The host ended the party'); }
        else this.dropRemote(owner, false);
        break;
      }
      case 'unshare': {
        if (!fromGuest) return;
        const r = this.remotes.get(link.id);
        if (!r) return;
        r.avatar = false;
        this.forgetAvatar(r);
        for (const [id, l] of this.links) if (id !== r.id) this.send(l, { t: 'drop', owner: r.id });
        this.rebuildRoster();
        this.say(`${r.name} stopped sharing their avatar`);
        break;
      }
      case 'drop': {
        if (fromGuest) return;
        const r = this.remotes.get(String(m.owner));
        if (r) { r.avatar = false; r.why ||= 'off'; this.forgetAvatar(r); this.publishLocal(); }
        break;
      }
      case 'kick': if (!fromGuest) { this.leave('The host removed you from the party'); } break;
      case 'limits': {
        if (fromGuest) return;
        const v = clampTrisLimit(m.maxTris);
        if (v === this.hostMaxTris) return;
        this.hostMaxTris = v;
        // a party version for the host's limit (or the original again), then re-announce what changed
        void this.relod();
        this.reaskRefused(v);
        this.notify();
        break;
      }
      case 'xprog': case 'xack': {                                        // receiver → me about something I sent
        const k: Kind = m.k === 'c' ? 'c' : 'm';
        const ox = link.out.get(`${String(m.owner)}:${k}`);
        if (!ox || ox.x !== Number(m.x) || !['sending', 'sent'].includes(ox.st)) return;   // an older / replaced transfer
        const now = performance.now();
        if (m.t === 'xprog') { ox.got = Math.max(ox.got, Math.min(ox.n, Number(m.got) || 0)); ox.at = now; return; }
        if (m.ok) { Object.assign(ox, { st: 'done', got: ox.n, why: '', tries: 0, at: now }); this.xlog(`${this.nameOf(link.id)} confirmed the ${k === 'm' ? 'model' : 'costume'} of ${this.nameOf(ox.owner)} ✔`); }
        else {
          const why = String(m.why ?? 'error').slice(0, 80);
          if (m.retry && !xfFinal(why)) this.retryOut(link, ox, why, Math.max(0, Math.min(ox.n, Number(m.got) || 0)));
          else {
            Object.assign(ox, { st: 'failed', why, at: now });
            this.xlog(`${this.nameOf(link.id)} refused the ${k === 'm' ? 'model' : 'costume'} of ${this.nameOf(ox.owner)}: ${why}`);
            if (ox.owner === this.myId) this.say(`${this.nameOf(link.id)} couldn’t take your ${k === 'm' ? 'avatar' : 'costume'}: ${xfWhyText(why, this.trisLimit)}`);
          }
        }
        this.notify();
        return;
      }
      case 'xneed': {                                                    // "I don't have it — send it (again)"
        const owner = String(m.owner), k: Kind = m.k === 'c' ? 'c' : 'm';
        if (!fromGuest && owner !== this.myId) return;                     // the host only asks a guest for its own avatar
        if (fromGuest && !this.remotes.has(link.id)) return;
        const have = m.have && typeof m.have === 'object' && /^[0-9a-f]{8}$/.test(String(m.have.h)) ? { h: String(m.have.h), got: Math.max(0, Number(m.have.got) || 0) } : null;
        const ox = link.out.get(`${owner}:${k}`);
        const moving = ox && (ox.st === 'queued' || ((ox.st === 'sending' || ox.st === 'sent') && performance.now() - ox.at < XF_STALL_MS));
        this.xlog(`${this.nameOf(link.id)} asked for the ${k === 'm' ? 'model' : 'costume'} of ${this.nameOf(owner)}${have ? ` (has ${fmtMB(have.got)})` : ''}${moving ? ' — already on its way' : ''}`);
        if (moving) { this.send(link, { t: 'xwhy', owner, k, why: 'queued' }); return; }
        if (ox) { ox.gen++; ox.abort?.(); ox.tries = 0; }
        void this.resendTo(link, owner, k, have).then((why) => { if (why) this.send(link, { t: 'xwhy', owner, k, why }); });
        return;
      }
      case 'xwhy': {                                                     // the answer to my xneed: why it isn't coming
        const r = this.remotes.get(String(m.owner));
        if (!r || (fromGuest && r.id !== link.id)) return;
        const k: Kind = m.k === 'c' ? 'c' : 'm';
        const why = String(m.why ?? '').slice(0, 80);
        if (why === 'queued' || why === 'pending') { r.ask.tries = Math.max(0, r.ask.tries - 1); this.setXin(r, k, 'waiting', r.xin[k]?.got ?? 0, r.xin[k]?.n ?? r.bytes, why); }
        else { if (xfFinal(why)) r.ask.tries = XF_TRIES; this.setXin(r, k, xfFinal(why) ? 'failed' : 'waiting', 0, r.bytes, why); }
        this.xlog(`${r.name}’s ${k === 'm' ? 'model' : 'costume'} isn’t coming yet: ${why}`);
        this.notify();
        return;
      }
      case 'xstat': {                                                    // host → me: where my avatar got to
        if (fromGuest || m.owner !== this.myId || !Array.isArray(m.to)) return;
        const st = new Set<XfState>(['idle', 'queued', 'sending', 'sent', 'receiving', 'checking', 'waiting', 'retrying', 'done', 'failed', 'outdated']);
        this.myDeliveries = m.to.slice(0, 8).map((d) => ({ name: String(d?.name ?? '?').slice(0, 40), st: st.has(d?.st) ? d.st : 'idle', why: String(d?.why ?? '').slice(0, 80), got: Math.max(0, Number(d?.got) || 0), n: Math.max(0, Number(d?.n) || 0) }));
        this.notify();
        return;
      }
      case 'scene': if (!fromGuest && m.state && typeof m.state === 'object') this.onScene(sanitizeSceneState(m.state)); break;
      case 'beat': { if (fromGuest) return; const b = sanitizeBeatPacket(m.b); if (b) { this.bus.send({ type: 'beat', b }); this.onBeat(b); } break; }
      // (the host's interview director → this PC's OBS pages, src/ui/stage/interviewHost.ts)
      case 'ivcue': { if (fromGuest) return; const c = sanitizeCue(m.c); if (c) this.bus.send({ type: 'command', command: 'interview', args: { cue: c } }); break; }
      case 'chat': if (!fromGuest) this.onChat(m.evs, m.tot, m.snap === true); break;
      case 'goals': if (!fromGuest) this.onGoals(m.s); break;
      case 'djdeck': if (!fromGuest) this.onDjDeck(m.s); break;
      case 'game': {
        if (!link.id || !link.caps.has('trail1')) return;
        if (this.onGame) this.onGame(link.id, m.d);
        else if (!fromGuest) void import('./game/trail/session.ts').then((g) => g.guestReceive(this, link.id, m.d)).catch((e) => console.warn('trail', e));
        break;
      }
    }
  }

  /** Realtime packets: binary frames / voice (the host re-wraps them with the owner id for everyone else). */
  private onRt(link: Link, data: unknown) {
    if (!(data instanceof ArrayBuffer) || data.byteLength > 4096 || data.byteLength < 4) return;
    let owner: string | null, inner: Uint8Array;
    const u8 = new Uint8Array(data);
    // party games: realtime lane (snapshots / inputs), never mixed with tracking frames
    if (u8[0] === 0x54 || u8[0] === 0x49) { if (link.id && link.caps.has('trail1')) this.onGameRt?.(link.id, u8); return; }
    if (this.role === 'host') { if (u8[0] === PKT_RELAY) return; owner = link.id; inner = u8; }
    else { try { ({ owner, inner } = unwrapRelay(u8)); } catch { return; } owner ??= link.id; }
    const r = owner ? this.remotes.get(owner) : undefined;
    if (!r) return;
    const now = performance.now();
    // rate limits as token buckets: network jitter delivers packets in bursts, which are fine; floods are not
    const dt = Math.min(1, (now - r.tokAt) / 1000);
    r.tokAt = now;
    r.fTok = Math.min(15, r.fTok + dt * FRAME_HZ * 1.5);
    r.vTok = Math.min(25, r.vTok + dt * (1000 / VOICE_MS) * 1.2);
    try {
      if (inner[0] === PKT_FRAME) {
        if (r.fTok < 1) return;
        r.fTok -= 1;
        r.lastFrame = now;
        const d = decodeFrame(inner);
        let f = sanitizeFrame({ ...d.frame, snack: d.snackJson });
        // audio mixer: their noise gate is shut → the camera's mouth doesn't count as talking (here and for everyone)
        if (this.role === 'host' && this.voiceGated?.(r.id)) { f = quietFrame(f); inner = encodeFrame(f, d.seq, d.sent); }
        const net = { s: d.sent, q: d.seq };
        r.net.pushFrame(f, net, now);
        if (r.refs.model) this.bus.send({ type: 'frame', frame: f, peer: r.id, net });
      } else if (inner[0] === PKT_VOICE) {
        if (this.role === 'host' && this.mod.micOff(r.id)) return;      // moderation: muted = no mouth / speaking from them
        if (r.vTok < 1) return;
        r.vTok -= 1;
        r.lastVoice = now;
        const v = decodeVoice(inner);
        // audio mixer: their noise gate is shut (background noise, not talking) → silent samples, still flowing, so no
        // page falls back to the camera's mouth after 1.5 s
        if (this.role === 'host' && this.voiceGated?.(r.id)) { v.samples = quietVoice(v.samples); inner = encodeVoice(v.samples, v.seq); }
        r.net.pushVoice(v.samples, now);
        if (r.refs.model) this.bus.send({ type: 'pvoice', peer: r.id, v: v.samples });
      } else return;
    } catch { return; }
    if (this.role === 'host') {
      const out = wrapRelay(r.id, inner);
      for (const [id, l] of this.links) if (id !== r.id && r.sentTo.has(id)) this.sendRt(l, out);
    }
  }

  private onBin(link: Link, data: ArrayBuffer) {
    if (!(data instanceof ArrayBuffer) || data.byteLength < 33) return;
    const u8 = new Uint8Array(data);
    // host: this guest's hello (ctl) isn't processed yet — the channels aren't ordered against each other, so hold the
    // packets and replay them right after it (dropping them corrupted the model: "waiting for avatar" forever)
    if (this.role === 'host' && !link.id) {
      if ((link.earlyBytes ?? 0) + data.byteLength <= MAX_MODEL + (8 << 20)) { (link.early ??= []).push(data); link.earlyBytes = (link.earlyBytes ?? 0) + data.byteLength; }
      return;
    }
    const hd = binHeader(u8)!;
    const owner = this.role === 'host' ? link.id : hd.owner;
    const r = this.remotes.get(owner);
    if (!r) { if (this.role === 'guest') this.holdOrphan(owner, link, data); return; }
    if (hd.type === XF_BEGIN || hd.type === XF_DATA || hd.type === XF_END) { this.onXf(link, r, hd.type, u8); return; }
    const k = String.fromCharCode(hd.type);
    const kind: Kind | null = k === 'c' || k === 'C' ? 'c' : k === 'm' || k === 'M' ? 'm' : null;
    if (!kind) return;
    const rx = r.rx[kind];
    if (k === 'M' || k === 'C') { // legacy end marker (costume: carries its id)
      const meta = new TextDecoder().decode(new Uint8Array(data, 33)).slice(0, 40);
      if (!rx.chunks.length) return;
      const buf = new Uint8Array(rx.got);
      let off = 0;
      for (const c of rx.chunks) { buf.set(c, off); off += c.length; c.fill(0); }
      rx.chunks = []; rx.got = 0;
      const cid = /^[A-Za-z0-9_-]{1,40}$/.test(meta) ? meta : null;
      if (!r.avatar) { this.park(r, kind, buf, cid, 0, '', link); return; }   // their "sharing" message may still be on its way
      this.setXin(r, kind, 'checking', buf.byteLength, buf.byteLength);
      r.chain = r.chain.then(() => this.accept(r, kind, buf, cid)).then((res) => this.finish(r, link, kind, 0, buf.byteLength, res), (e) => this.finish(r, link, kind, 0, 0, { ok: false, why: `vault:${(e as Error).message}`.slice(0, 60), retry: true }));
      return;
    }
    if (rx.got + data.byteLength - 33 > MAX_MODEL) { for (const c of rx.chunks) c.fill(0); rx.chunks = []; rx.got = 0; this.setXin(r, kind, 'failed', 0, 0, 'big:256'); return; }
    rx.chunks.push(new Uint8Array(data.slice(33)));
    rx.got += data.byteLength - 33;
    const v = r.xin[kind];
    if (v && v.st === 'receiving') { v.got = rx.got; v.at = performance.now(); } else this.setXin(r, kind, 'receiving', rx.got, r.bytes);
  }

  /** 'xf1' transfers: X begin → D chunks strictly in order (a gap / overrun is reported at once) → E end → size +
   *  CRC-32 → accept → receipt. A resumed transfer (X with an offset) continues the kept partial if the hash matches. */
  private onXf(link: Link, r: Remote, type: number, u8: Uint8Array) {
    const now = performance.now();
    if (type === XF_BEGIN) {
      const b = decBegin(u8, MAX_MODEL);
      if (!b) return;
      const cur = r.inx[b.k];
      if (b.o > 0) {
        if (!cur || cur.h !== b.h || cur.got !== b.o) { this.xack(link, r.id, b.k, b.x, { ok: false, why: 'resume', retry: true }, 0); return; }
        Object.assign(cur, { x: b.x, at: now, link, nak: false });
        this.setXin(r, b.k, 'receiving', cur.got, cur.n);
        this.xlog(`${r.name}: ${b.k === 'm' ? 'model' : 'costume'} resumed at ${fmtMB(b.o)} / ${fmtMB(b.n)}`);
        return;
      }
      if (cur) wipe(cur.buf);
      r.inx[b.k] = null;
      let buf: Uint8Array;
      try { buf = new Uint8Array(b.n); } catch { this.xack(link, r.id, b.k, b.x, { ok: false, why: 'nomem', retry: true }, 0); this.setXin(r, b.k, 'failed', 0, b.n, 'nomem'); return; }
      r.inx[b.k] = { x: b.x, k: b.k, n: b.n, h: b.h, c: b.c, buf, got: 0, crc: 0, at: now, prog: now, link, nak: false };
      this.setXin(r, b.k, 'receiving', 0, b.n);
      return;
    }
    if (type === XF_DATA) {
      const d = decData(u8);
      const cur = d ? (r.inx.m?.x === d.x ? r.inx.m : r.inx.c?.x === d.x ? r.inx.c : null) : null;
      if (!d || !cur || cur.nak) return;                                  // stale packets of a replaced transfer
      if (d.off !== cur.got || cur.got + d.data.length > cur.n) {
        cur.nak = true;
        const why = d.off !== cur.got ? 'gap' : 'size';
        this.xack(link, r.id, cur.k, cur.x, { ok: false, why, retry: true }, cur.got);
        this.xlog(`${r.name}: ${why} at ${fmtMB(cur.got)} (chunk at ${fmtMB(d.off)}) — asked to resume`);
        return;
      }
      cur.buf.set(d.data, cur.got);
      cur.got += d.data.length;
      cur.crc = crc32(d.data, cur.crc);                                   // checked as it arrives: no second pass at the end
      cur.at = now;
      const v = r.xin[cur.k];
      if (v) { v.got = cur.got; v.at = now; }
      if (now - cur.prog >= 1000) { cur.prog = now; this.send(link, { t: 'xprog', owner: r.id, k: cur.k, x: cur.x, got: cur.got }); }
      return;
    }
    const x = decEnd(u8);
    const cur = x === null ? null : r.inx.m?.x === x ? r.inx.m : r.inx.c?.x === x ? r.inx.c : null;
    if (!cur || cur.nak) return;
    r.inx[cur.k] = null;
    if (cur.got !== cur.n) { wipe(cur.buf); this.xack(link, r.id, cur.k, cur.x, { ok: false, why: 'size', retry: true }, 0); this.setXin(r, cur.k, 'waiting', 0, cur.n, 'size'); return; }
    this.setXin(r, cur.k, 'checking', cur.n, cur.n);
    r.chain = r.chain.then(async (): Promise<XRes | null> => {
      if (sumHex(cur.crc) !== cur.h) { wipe(cur.buf); return { ok: false, why: 'hash', retry: true }; }
      if (!r.avatar) { this.park(r, cur.k, cur.buf, cur.c || null, cur.x, cur.h, link); return null; }
      return this.accept(r, cur.k, cur.buf, cur.c || null, cur.h);
    }).then((res) => { if (res) this.finish(r, link, cur.k, cur.x, cur.n, res); },
      (e) => this.finish(r, link, cur.k, cur.x, cur.n, { ok: false, why: `vault:${(e as Error).message}`.slice(0, 60), retry: true }));
  }

  /** Receipt to the sender ('xf1' only; legacy transfers have no id → nothing to say). */
  private xack(link: Link, owner: string, k: Kind, x: number, res: XRes, got = 0) {
    if (!x || !link.caps.has(XF_CAP)) return;
    this.send(link, { t: 'xack', owner, k, x, ok: res.ok, ...(res.ok ? {} : { why: res.why ?? 'error', retry: !!res.retry, got }) });
  }
  /** A transfer finished (accepted or not): receipt, panel state, log. */
  private finish(r: Remote, link: Link, kind: Kind, x: number, n: number, res: XRes) {
    this.xack(link, r.id, kind, x, res);
    if (res.ok) { this.setXin(r, kind, 'done', n, n); if (kind === 'm') r.ask = { tries: 0, next: 0 }; else r.askC = { tries: 0, next: 0 }; }
    else {
      this.setXin(r, kind, xfFinal(res.why ?? '') ? 'failed' : 'waiting', 0, n, res.why ?? 'error');
      // a costume refused for a rule never comes: show them without it now (OBS kept their last look while it was due)
      if (kind === 'c' && r.sealWait && xfFinal(res.why ?? '')) r.chain = r.chain.then(() => this.sealProfile(r, true)).catch(() => {});
    }
    this.xlog(`${r.name}: ${kind === 'm' ? 'model' : 'costume'} ${fmtMB(n)} ${res.ok ? 'received ✔' : `refused (${res.why})`}${x ? '' : ' [legacy]'}`);
    this.notify();
  }
  private setXin(r: Remote, kind: Kind, st: XfState, got: number, n: number, why = '') {
    const prev = r.xin[kind];
    r.xin[kind] = { st, kind, got, n, why, tries: st === 'retrying' ? prev?.tries ?? 0 : r.ask.tries, at: performance.now() };
  }
  /** A finished model / costume arrived before the owner's "sharing" message: held ≤ XF_LATE_MS for it (then wiped). */
  private park(r: Remote, kind: Kind, buf: Uint8Array, meta: string | null, x: number, h: string, link: Link) {
    if (r.late) wipe(r.late.buf);
    r.late = { kind, buf, meta, x, h, at: performance.now(), link };
    this.setXin(r, kind, 'waiting', buf.byteLength, buf.byteLength, 'late');
  }
  private takeLate(r: Remote) {
    const L = r.late;
    if (!L) return;
    r.late = null;
    this.setXin(r, L.kind, 'checking', L.buf.byteLength, L.buf.byteLength);
    r.chain = r.chain.then(() => this.accept(r, L.kind, L.buf, L.meta, L.h)).then((res) => this.finish(r, L.link, L.kind, L.x, L.buf.byteLength, res),
      (e) => this.finish(r, L.link, L.kind, L.x, L.buf.byteLength, { ok: false, why: `vault:${(e as Error).message}`.slice(0, 60), retry: true }));
  }
  /** Guest: packets for a member the host hasn't introduced yet (its 'profile' is still on the ctl channel). */
  private holdOrphan(owner: string, link: Link, data: ArrayBuffer) {
    if (!PID.test(owner) || owner === this.myId) return;
    const o = this.orphans.get(owner) ?? { at: performance.now(), bytes: 0, q: [] };
    if (o.bytes + data.byteLength > MAX_MODEL + (8 << 20) || this.orphans.size > 8) return;
    o.q.push([link, data]); o.bytes += data.byteLength;
    this.orphans.set(owner, o);
  }
  /** Forget partial transfers from / for this member (a reconnect starts them again; stale halves must not be glued on). */
  private resetRx(r: Remote) {
    for (const k of ['m', 'c'] as const) {
      for (const c of r.rx[k].chunks) c.fill(0);
      r.rx[k].chunks = []; r.rx[k].got = 0;
      if (r.inx[k]) { wipe(r.inx[k]!.buf); r.inx[k] = null; }
    }
    if (r.late) { wipe(r.late.buf); r.late = null; }
  }

  /** A complete model / costume arrived: check → seal → (host) relay → wipe plaintext → vault → OBS. Resolves with the
   *  receipt (ok, or the exact reason + whether sending again could help). */
  private async accept(r: Remote, kind: Kind, plain: Uint8Array, costumeId: string | null, hash = ''): Promise<XRes> {
    // a costume set ('acc1': outfit + accessories in one transfer, shared/partyXfer.ts): every piece is checked like a model
    const set = kind === 'c' && isCostumeSet(plain) ? unpackSet(plain) : null;
    const pieces = Array.isArray(set) ? set : null;
    const bad = typeof set === 'string' ? set : pieces ? pieces.map((p) => glbProblem(p.bytes)).find((x) => !!x) ?? null : glbProblem(plain);
    if (bad) { wipe(plain); this.say(`Refused ${r.name}'s ${kind === 'm' ? 'avatar' : 'costume'}: ${bad}`); return { ok: false, why: `glb:${bad}`.slice(0, 80), retry: false }; }
    // polycount limit (the owner checks before sending; an older or modified client may not)
    const tris = pieces ? pieces.reduce((s, p) => s + (glbStats(p.bytes)?.tris ?? 0), 0) : glbStats(plain)?.tris ?? 0;
    const total = kind === 'm' ? tris : r.tris.m + tris;
    if (total > this.trisLimit) { wipe(plain); this.refuseTris(r, total); return { ok: false, why: trisWhy(total), retry: false }; }
    r.tris[kind] = tris;
    r.key ??= await SealKey.create();
    const key = r.key;
    const aad = `${kind === 'm' ? 'model' : 'costume'}:${r.id}`;
    const sealed = await key.seal(plain, aad);
    const outfit = pieces?.find((p) => p.kind === 'outfit') ?? null;
    if (this.role === 'host') {
      // keep the sealed copy FIRST (a guest who joins while this is being relayed gets it too — it used to get nothing),
      // then relay in the background: this PC's own OBS no longer waits for the slowest guest, and a guest whose
      // connection closes mid-relay can't hang everything behind it any more
      if (kind === 'm') { r.sealedModel = sealed; r.sealedCostume = null; r.hash.c = ''; r.setOutfit = null; }
      else {
        r.sealedCostume = sealed; r.costumeId = costumeId;
        // members whose app can't open a costume set get its outfit on its own (sealed separately, same key + label)
        r.setOutfit = pieces ? { sealed: outfit ? await key.seal(outfit.bytes, aad) : null, id: outfit?.id ?? '', hash: outfit ? await checksum(outfit.bytes) : '' } : null;
      }
      r.hash[kind] = hash || await checksum(plain);
      for (const [id, l] of this.links) if (id !== r.id && this.mayRelay(r, id)) void this.relaySealed(r, l, kind, false);
    }
    const contents = pieces ? { outfit: outfit?.id ?? null, acc: pieces.filter((p) => p.kind === 'accessory').map((p) => p.id) } : null;
    wipe(plain);
    let ref: VaultRef;
    try { ref = await vault.put(this.vsid, sealed); }
    catch (e) {
      if (this.role !== 'host') wipe(sealed);
      const msg = (e as Error).message;
      this.say(`Couldn’t keep ${r.name}’s ${kind === 'm' ? 'avatar' : 'costume'} in this PC’s memory (${msg}) — OBS can’t show it`);
      return { ok: false, why: `vault:${msg}`.slice(0, 60), retry: true };
    }
    if (r.key !== key || !this.remotes.has(r.id)) { vault.drop(ref); return { ok: false, why: 'gone', retry: false }; }   // they left / stopped meanwhile
    if (kind === 'm') {
      vault.drop(r.refs.model); vault.drop(r.refs.costume);
      r.refs.model = ref; r.refs.costume = null; r.refs.costumeId = null; r.refs.set = null; // a new body clears its old costume; the costume (if any) follows
    } else {
      vault.drop(r.refs.costume);
      r.refs.costume = ref; r.refs.costumeId = costumeId; r.refs.set = contents;
      r.costumeId = costumeId;
    }
    if (this.role !== 'host') wipe(sealed); // guests don't relay: the vault copy is the only one
    await this.sealProfile(r);
    return { ok: true };
  }

  /** Host: send an owner's sealed avatar to one member (decrypt a fresh copy → stream → wipe). `kind` 'm' also sends the
   *  worn costume after the model (unless `withCostume` is false); `from` resumes a transfer the member half has. */
  private async relaySealed(r: Remote, link: Link, kind: Kind = 'm', withCostume = kind === 'm', from = 0) {
    const key = r.key;
    const item = kind === 'm' ? (r.sealedModel ? { sealed: r.sealedModel, id: '', hash: r.hash.m } : null) : this.relayCostume(r, link);
    const cos = kind === 'm' && withCostume ? this.relayCostume(r, link) : null;
    if (!key || !item || !link.id) return;
    r.sentTo.add(link.id);
    await this.sendBlob(link, r.id, kind, () => key.open(item.sealed, `${kind === 'm' ? 'model' : 'costume'}:${r.id}`), { hash: item.hash, meta: item.id, from });
    if (cos) await this.sendBlob(link, r.id, 'c', () => key.open(cos.sealed, `costume:${r.id}`), { hash: cos.hash, meta: cos.id });
  }
  /** Host: which of an owner's sealed costumes goes to this member — their costume set ('acc1' members), else the plain
   *  outfit (taken out of the set when it arrived; nothing when the set has no outfit). */
  private relayCostume(r: Remote | undefined, link: Link): { sealed: Uint8Array; id: string; hash: string } | null {
    if (!r) return null;
    if (r.setOutfit && !link.caps.has(ACC_CAP)) return r.setOutfit.sealed ? { sealed: r.setOutfit.sealed, id: r.setOutfit.id, hash: r.setOutfit.hash } : null;
    return r.sealedCostume ? { sealed: r.sealedCostume, id: r.costumeId ?? '', hash: r.hash.c } : null;
  }

  /** Seal the (sanitised) profile this PC's OBS uses for `r` and bump its revision → OBS reloads that member. While the
   *  outfit / costume set they announce is still on its way, OBS keeps their last look — one reload per change, not one
   *  for the profile and another for the bytes; the arrival seals it, and `force` (a refusal, or SEAL_WAIT_MS without
   *  it: resolverTick) shows them without it. */
  private async sealProfile(r: Remote, force = false) {
    if (!r.refs.model || !r.key) return;
    const p = r.profile ?? {};
    const outfitId = (p.costume as { id?: string } | null)?.id ?? null;
    const setId = typeof p.set === 'string' ? p.set : null;
    // (the set's id, or the plain outfit's: a host whose app can't relay sets sends the outfit alone)
    const held = r.refs.costume ? r.refs.costumeId : null;
    if (!force && r.avatar && (setId ?? outfitId) && held !== setId && held !== outfitId) { r.sealWait ||= performance.now(); return; }
    r.sealWait = 0;
    const set = held && held === setId ? r.refs.set : null;
    const withCostume = !!outfitId && (held === outfitId || set?.outfit === outfitId);
    const accDefs = set ? (Array.isArray(p.accessories) ? p.accessories : []).filter((a) => set.acc.includes(String((a as { id?: unknown } | null)?.id))) : [];
    const prof = sanitizeGuestProfile({ ...p, name: r.name, costumeDef: withCostume ? p.costume : null, accessoryDefs: accDefs }, r.id, withCostume, accDefs.length > 0);
    const bytes = new TextEncoder().encode(JSON.stringify(prof));
    const ref = await vault.put(this.vsid, await r.key.seal(bytes, `profile:${r.id}`));
    vault.drop(r.refs.profile);
    r.refs.profile = ref;
    r.rev++;
    this.publishLocal();
  }

  private forgetAvatar(r: Remote) {
    vault.drop(r.refs.model); vault.drop(r.refs.costume); vault.drop(r.refs.profile);
    r.refs = { profile: null, model: null, costume: null, costumeId: null, set: null };
    wipe(r.sealedModel); wipe(r.sealedCostume); wipe(r.setOutfit?.sealed);
    r.sealedModel = null; r.sealedCostume = null; r.setOutfit = null; r.key = null; r.sealWait = 0;
    r.tris = { m: 0, c: 0 };
    r.hash = { m: '', c: '' };
    for (const k of ['m', 'c'] as const) if (r.inx[k]) { wipe(r.inx[k]!.buf); r.inx[k] = null; }
    if (r.late) { wipe(r.late.buf); r.late = null; }
    r.sentTo.clear();
    r.rev++;
  }

  private addRemote(id: string, name: unknown, profile: unknown, bytes: unknown, link: Link | null, share: SharePolicy, avatar: boolean, why = '') {
    if (!PID.test(id) || id === this.myId) return;
    const r: Remote = this.remotes.get(id) ?? {
      id, name: '', slot: 0, profile: null, bytes: 0, rx: { m: { chunks: [], got: 0 }, c: { chunks: [], got: 0 } },
      discord: null, verified: false, guildOk: false, share: 'party', avatar: true, why: '', tris: { m: 0, c: 0 }, key: null, sealedModel: null, sealedCostume: null, costumeId: null,
      setOutfit: null, refs: { profile: null, model: null, costume: null, costumeId: null, set: null }, askC: { tries: 0, next: 0 }, sealWait: 0, rev: 0, sentTo: new Set(), lastFrame: 0, lastVoice: 0, fTok: 15, vTok: 25, tokAt: 0, net: new RemoteSmoother(), chain: Promise.resolve(),
      inx: { m: null, c: null }, xin: { m: null, c: null }, hash: { m: '', c: '' }, late: null, shareAt: performance.now(), ask: { tries: 0, next: 0 }, refused: false, outSeen: '', outAt: 0,
    };
    const known = this.remotes.has(id);
    if (link) { r.discord = link.who.discord; r.verified = link.who.verified; r.guildOk = link.who.guildOk; }
    else { const m = this.roster.find((x) => x.id === id); if (m) { r.discord = m.discord ?? null; r.verified = !!m.verified; } }
    // a verified Discord identity wins over whatever name the peer claims
    r.name = (r.discord?.name ?? String(name ?? 'Guest')).slice(0, 40);
    r.profile = profile && typeof profile === 'object' ? (profile as Record<string, unknown>) : null;
    r.bytes = Math.min(MAX_MODEL, Number(bytes) || 0);
    r.share = share;
    const wasSharing = r.avatar;
    r.avatar = avatar;
    r.why = avatar ? '' : (typeof why === 'string' ? why.slice(0, 24) : '');
    if (avatar && (!known || !wasSharing || r.refused)) { r.shareAt = performance.now(); r.ask = { tries: 0, next: 0 }; r.askC = { tries: 0, next: 0 }; if (r.xin.m?.st === 'failed' || r.xin.m?.st === 'outdated') r.xin.m = null; }
    r.refused = false;
    this.remotes.set(id, r);
    // green room: decided BEFORE they reach the roster / scene (a guest who waits never flashes into the room)
    if (!known && link && this.role === 'host') this.green.admit({ id, name: r.name, uid: r.discord?.id, link: !link.who.verified && /^link/.test(r.discord?.id ?? '') });
    // moderation: a guest who comes back is still cut (stable identity) — and is told so
    if (!known && link && this.role === 'host') { this.mod.resume(); this.mod.admitted(id); }
    if (known && wasSharing && !avatar) this.forgetAvatar(r);
    if (avatar && r.late) this.takeLate(r);                                // it beat this message: use it now
    const orphan = this.orphans.get(id);
    if (orphan) { this.orphans.delete(id); for (const [l, d] of orphan.q) this.onBin(l, d); }
    this.rebuildRoster();
    // a known member changed something (costume off / label text): refresh what OBS shows
    if (known && r.refs.model) r.chain = r.chain.then(() => this.sealProfile(r)).catch(() => {});
  }

  private dropRemote(id: string, announce = true) {
    const r = this.remotes.get(id);
    if (!r) return;
    this.remotes.delete(id);
    if (this.role === 'host') this.green.left(id);
    this.forgetAvatar(r);
    this.resetRx(r);
    const l = this.links.get(id);
    if (l) { this.endLink(l); l.pc.close(); }
    for (const x of this.links.values()) for (const ox of x.out.values()) if (ox.owner === id) { ox.gen++; ox.abort?.(); ox.st = 'idle'; }
    if (l?.relayPeer) this.relayLinks.delete(l.relayPeer);
    this.links.delete(id);
    for (const o of this.remotes.values()) o.sentTo.delete(id);
    if (announce && this.role === 'host') for (const x of this.links.values()) this.send(x, { t: 'bye', owner: id });
    this.rebuildRoster();
  }

  /** Held out of the show: waiting in the green room, or a 3D-avatar guest the host hid (moderation). */
  private offShow(id: string): boolean { return this.green.hidden(id) || (this.role === 'host' && this.mod.avatarHidden(id)); }
  private rebuildRoster() {
    if (this.role === 'host') {
      const me: PartyMember = { id: this.myId, name: this.myDiscord?.name ?? this.name, slot: 0, discord: this.myDiscord, verified: this.via === 'discord', share: this.sharePolicy, avatar: this.sharingNow(), tv: this.myTv };
      this.roster = [me, ...[...this.remotes.values()].map((r, i) => ({ id: r.id, name: r.name, slot: i + 1, discord: r.discord, verified: r.verified, share: r.share, avatar: r.avatar, tv: r.tv ?? null }))];
      this.tvLinks.membersChanged();
      // (green room: a waiting member is only in their OWN copy — nobody else's room / OBS shows them)
      // (moderation: a 3D-avatar guest whose "camera" the host turned off is held out of the room the same way)
      for (const l of this.links.values()) this.send(l, { t: 'roster', members: this.roster.filter((m) => m.id === l.id || !this.offShow(m.id)) });
      this.pushRosterToRelay();
    } else if (this.role === 'none') this.roster = [];
    this.publishLocal();
  }
  private rosterT = 0;
  private pushRosterToRelay() {
    if (!this.relay || this.role !== 'host') return;
    clearTimeout(this.rosterT);
    this.rosterT = window.setTimeout(() => this.relay?.roster(this.roster.map((m) => m.name)), 500);
  }

  private hasVault() { for (const r of this.remotes.values()) if (r.refs.model || r.refs.profile) return true; return false; }

  /** Tell this PC's OBS outputs who to show next to the local performer, with the keys to their sealed avatars. */
  private publishLocal(notify = true) {
    const lip = (id: string) => Number(localStorage.getItem(`vtp.mp.lip.${this.remotes.get(id)?.discord?.id ?? id}`)) || 0;
    const sealedOf = (id: string) => {
      const r = this.remotes.get(id);
      return r && r.key && r.refs.model && r.refs.profile ? { key: r.key.raw, profile: r.refs.profile, model: r.refs.model, costume: r.refs.costume, rev: r.rev } : null;
    };
    const base = (this.roster.length
      ? this.roster.filter((m) => m.id !== this.myId)
      : [...this.remotes.values()].map((r, i) => ({ id: r.id, name: r.name, slot: i + 1 } as PartyMember))).filter((m) => !this.offShow(m.id));
    const tvOf = (id: string) => this.tvOf(id) ?? undefined;
    const others = base.map((m) => ({ ...m, sealed: sealedOf(m.id), lipDelay: lip(m.id), tv: tvOf(m.id) })).filter((m) => m.sealed || m.tv);
    // guestlink: the host's Discord-camera guests (cropped from the call window) are local TV guests on this PC's pages
    this.tv.cams.list.forEach((c, i) => others.push({ id: c.id, name: c.name, slot: 20 + i, sealed: null, lipDelay: 0, tv: this.tv.cams.info(c) } as (typeof others)[number]));
    // (solo: a Spout2 performer's own model in my own rooms — TvStudio.soloShow)
    this.bus.send({ type: 'party', members: others, tvSelf: this.myTv && (this.role !== 'none' || this.tv.soloShow) ? { ...this.myTv, id: this.myId, name: this.myDiscord?.name ?? this.name } : null });
    if (notify) this.notify();
  }

  /** Everyone in the party as the UI shows them (with link stats). */
  view(): MemberView[] {
    const now = performance.now();
    const hostId = this.role === 'host' ? this.myId : this.roster[0]?.id;
    const list: MemberView[] = [];
    for (const m of this.roster.length ? this.roster : [{ id: this.myId, name: this.name, slot: 0 } as PartyMember]) {
      const r = this.remotes.get(m.id);
      const me = m.id === this.myId;
      const l = r ? this.links.get(r.id) ?? (this.role === 'guest' && m.id === hostId ? this.links.values().next().value : undefined) : undefined;
      const st = r ? r.net.stats(now) : null;
      list.push({
        id: m.id, name: me ? (this.myDiscord?.name ?? this.name) : r?.name ?? m.name, slot: m.slot, me, host: m.id === hostId,
        discord: me ? this.myDiscord : r?.discord ?? m.discord ?? null, verified: me ? this.via === 'discord' : r?.verified ?? !!m.verified,
        share: me ? this.sharePolicy : r?.share ?? m.share ?? 'party', avatar: me ? this.shareMine && !!this.myModel && !this.overLimit() : r?.avatar ?? m.avatar !== false,
        why: me ? this.shareWhy() : r?.why ?? '',
        ready: me || !!r?.refs.model, receiving: !!r && (r.rx.m.got > 0 || r.rx.c.got > 0 || !!r.inx.m || !!r.inx.c), speaking: !!st?.speaking && (st.age < 400),
        stats: st ? { ...st, rtt: l?.rtt ?? 0 } : null,
        xfer: me ? this.myUpload() : r ? this.pickXin(r) : null,
        deliveries: me ? this.myDeliveries : r && this.role === 'host' ? this.deliveriesOf(r.id) : [],
        outdated: !me && !!l && l.ready && !l.caps.has(XF_CAP),
        tv: me ? this.myTv : this.tvOf(m.id),
      });
    }
    return list;
  }

  // ---------------------------------------------------------------- the resolver (shared/partyXfer.ts)
  /** (Re)send `owner`'s model / costume over `link`: mine (after a fresh hello / profile, so the receiver knows I share
   *  it), or — host — a member's sealed copy. `have` = what the receiver already holds (resume when the hash matches).
   *  Resolves '' when it went out, else the reason it can't (sent back to the asker as 'xwhy'). */
  private async resendTo(link: Link, owner: string, kind: Kind, have: { h: string; got: number } | null = null): Promise<string> {
    if (!link.ready) return 'closed';
    if (owner === this.myId) {
      if (!this.shareMine) return 'off';
      if (!this.mayShareMine(link)) return 'policy:guild';
      if (!this.myModel) return this.shareWhy() || 'none';
      if (this.overLimit()) return trisWhy(this.myTrisTotal);
      const c = this.costumeFor(link);
      const buf = kind === 'm' ? this.myModel : c?.buf;
      if (!buf) return 'none';
      const u8 = new Uint8Array(buf);
      const from = have && have.got > 0 && have.h === await this.hashOf(u8) ? have.got : 0;
      this.send(link, this.role === 'guest' ? this.helloMsg() : this.myProfileMsg());
      if (kind === 'c') link.sentC = c?.id;
      void this.sendBlob(link, this.myId, kind, u8, { from, ...(kind === 'c' ? { meta: c?.id ?? '' } : {}) });
      // a new body clears the receiver's costume: the costume always follows the model
      if (kind === 'm' && c) { link.sentC = c.id; void this.sendBlob(link, this.myId, 'c', new Uint8Array(c.buf), { meta: c.id }); }
      return '';
    }
    if (this.role !== 'host') return 'gone';
    const r = this.remotes.get(owner);
    if (!r) return 'gone';
    if (!r.avatar) return r.why || 'off';
    if (!this.mayRelay(r, link.id)) return `policy:${r.share}`;
    const item = kind === 'm' ? (r.sealedModel ? { hash: r.hash.m } : null) : this.relayCostume(r, link);
    // (a costume set without an outfit has nothing for a member whose app can't open sets)
    if (!item) return r.inx[kind] || r.rx[kind].got ? 'pending' : kind === 'c' && r.setOutfit && !r.setOutfit.sealed ? 'none' : 'missing';
    const from = have && have.got > 0 && have.h === item.hash ? have.got : 0;
    void this.relaySealed(r, link, kind, kind === 'm', from);
    return '';
  }
  /** The sender side of a stall / a NAK worth retrying: stop what's running, try again after the backoff. */
  private retryOut(link: Link, ox: OutXfer, why: string, resume: number) {
    ox.gen++; ox.abort?.();
    if (ox.tries >= XF_TRIES) {
      ox.st = 'failed'; ox.why = why || 'stalled';
      this.xlog(`gave up sending ${ox.kind === 'm' ? 'model' : 'costume'} of ${this.nameOf(ox.owner)} → ${this.nameOf(link.id)} after ${XF_TRIES} tries (${ox.why})`);
      if (ox.owner === this.myId) this.say(`Your avatar didn’t reach ${this.nameOf(link.id)} after ${XF_TRIES} tries (${xfWhyText(ox.why, this.trisLimit)}) — press “Resend my avatar”, or copy the diagnostics for help`);
      return;
    }
    ox.tries++;
    ox.st = 'retrying'; ox.why = why; ox.resume = resume; ox.retryAt = performance.now() + xfBackoff(ox.tries);
    this.xlog(`${ox.kind === 'm' ? 'model' : 'costume'} of ${this.nameOf(ox.owner)} → ${this.nameOf(link.id)}: ${why}${resume ? ` at ${fmtMB(resume)}` : ''} — retry ${ox.tries}/${XF_TRIES} in ${xfBackoff(ox.tries) / 1000} s`);
  }
  /** Receiver side: ask `link` (a guest for their own avatar / the host for anyone's) for a model we should have. */
  private askFor(r: Remote, link: Link, kind: Kind, why: string) {
    const cur = r.inx[kind];
    const have = cur && cur.got > 0 ? { h: cur.h, got: cur.got } : undefined;
    if (cur) cur.nak = true;                                              // its remaining chunks are stale now
    this.send(link, { t: 'xneed', owner: r.id, k: kind, ...(have ? { have } : {}) });
    this.xlog(`asked for ${r.name}’s ${kind === 'm' ? 'model' : 'costume'} (${why}${have ? `, have ${fmtMB(have.got)}` : ''}) ${r.ask.tries}/${XF_TRIES}`);
  }

  /** Every second while in a party: retries that are due, stalls, "sharing but no model", late models, orphans, and
   *  (host) delivery reports to owners. */
  private resolverTick() {
    const now = performance.now();
    let changed = false;
    for (const l of this.links.values()) {
      for (const ox of l.out.values()) {
        if (ox.st === 'retrying' && now >= ox.retryAt) {
          ox.retryAt = Infinity;
          void this.resendTo(l, ox.owner, ox.kind, ox.resume ? { h: ox.h, got: ox.resume } : null).then((why) => {
            if (why && ox.st === 'retrying') { ox.st = xfFinal(why) ? 'failed' : 'waiting'; ox.why = why; }
          });
          changed = true;
        } else if ((ox.st === 'sending' || ox.st === 'sent') && !ox.legacy && now - ox.at > XF_STALL_MS) {
          this.retryOut(l, ox, 'stalled', ox.got); changed = true;
        }
      }
    }
    for (const r of this.remotes.values()) {
      const l = this.role === 'host' ? this.links.get(r.id) : this.hostLink();
      if (r.late && now - r.late.at > XF_LATE_MS) {                      // they never said they share it: nothing kept
        const L = r.late; r.late = null;
        wipe(L.buf);
        this.xack(L.link, r.id, L.kind, L.x, { ok: false, why: 'late', retry: true });
        this.setXin(r, L.kind, 'idle', 0, 0);
        changed = true;
      }
      // OBS kept their last look for the outfit / costume set they announced: show them without it after a while
      if (r.sealWait && now - r.sealWait > SEAL_WAIT_MS) { r.sealWait = 0; r.chain = r.chain.then(() => this.sealProfile(r, true)).catch(() => {}); changed = true; }
      if (!l?.ready) continue;
      const xf = l.caps.has(XF_CAP);
      // a transfer that stopped moving: ask again, resuming from what we have
      for (const k of ['m', 'c'] as const) {
        const cur = r.inx[k];
        if (cur && !cur.nak && now - cur.at > XF_STALL_MS && xf) {
          changed = true;
          if (r.ask.tries >= XF_TRIES) {
            cur.nak = true;
            this.setXin(r, k, 'failed', cur.got, cur.n, 'stalled');
            this.say(`${r.name}’s ${k === 'm' ? 'avatar' : 'costume'} keeps stalling at ${fmtMB(cur.got)} / ${fmtMB(cur.n)} — press “${this.role === 'host' ? 'Ask them to resend' : 'Ask again'}”, or copy the diagnostics`);
            continue;
          }
          r.ask.tries++;
          this.setXin(r, k, 'retrying', cur.got, cur.n, 'stalled');
          this.askFor(r, l, k, 'stalled');
        }
      }
      // the outfit / costume set they announce never came (or a new body cleared it): ask for it too ('c' used to be
      // asked for only when it stalled midway, so a costume lost on the way never showed up)
      if (xf && r.avatar && r.refs.model && !r.refused) {
        const p = r.profile ?? {};
        const outfitId = (p.costume as { id?: string } | null)?.id ?? null, want = typeof p.set === 'string' ? p.set : outfitId;
        const held = r.refs.costume ? r.refs.costumeId : null;
        const busyC = !!r.inx.c || r.xin.c?.st === 'checking' || r.xin.c?.st === 'receiving';
        if (want && held !== want && held !== outfitId && !busyC && now >= r.askC.next && r.askC.tries < XF_TRIES && !(r.xin.c?.st === 'failed' && xfFinal(r.xin.c.why))
          && now - Math.max(r.shareAt, r.xin.c?.at ?? 0, r.xin.m?.at ?? 0) > XF_MISSING_MS) {
          r.askC.tries++;
          r.askC.next = now + XF_MISSING_MS + xfBackoff(r.askC.tries);
          this.setXin(r, 'c', 'retrying', 0, 0, 'missing');
          this.askFor(r, l, 'c', 'missing');
          changed = true;
        }
      }
      // they say they share it, the link is up, nothing is arriving and nothing is being checked
      const wants = r.avatar && !!r.profile && !r.refs.model;
      const legacyMoving = r.rx.m.got > 0 && now - (r.xin.m?.at ?? 0) < XF_STALL_MS;   // (an old sender's chunks: can't ask, only wait)
      const busy = !!r.inx.m || legacyMoving || !!r.late || r.xin.m?.st === 'checking' || (r.xin.m?.st === 'receiving' && !r.rx.m.got);
      if (!wants) { if (r.ask.tries && r.refs.model) r.ask = { tries: 0, next: 0 }; continue; }
      if (busy || now - Math.max(r.shareAt, r.xin.m?.at ?? 0) < XF_MISSING_MS || now < r.ask.next) continue;
      if (r.xin.m?.st === 'failed' && xfFinal(r.xin.m.why)) continue;           // refused for a rule: asking again won't help
      if (!xf) { if (r.xin.m?.st !== 'outdated') { this.setXin(r, 'm', 'outdated', 0, r.bytes, 'outdated'); this.xlog(`${r.name}: no model after ${XF_MISSING_MS / 1000} s and their app can’t resend (outdated)`); changed = true; } continue; }
      if (r.ask.tries >= XF_TRIES) {
        if (r.xin.m?.st !== 'failed') { this.setXin(r, 'm', 'failed', 0, r.bytes, r.xin.m?.why || 'missing'); this.say(`${r.name}’s avatar never arrived after ${XF_TRIES} requests — press “Ask them to resend”, or copy the diagnostics`); changed = true; }
        continue;
      }
      r.ask.tries++;
      r.ask.next = now + XF_MISSING_MS + xfBackoff(r.ask.tries);
      this.setXin(r, 'm', 'retrying', 0, r.bytes, r.xin.m?.why && r.xin.m.st !== 'retrying' ? r.xin.m.why : 'missing');
      this.askFor(r, l, 'm', 'missing');
      changed = true;
    }
    for (const [id, o] of this.orphans) if (now - o.at > 30_000) { for (const [, d] of o.q) wipe(d); this.orphans.delete(id); }
    if (this.role === 'host') this.reportDeliveries(now);
    if (changed) this.notify();
  }
  /** Host: where `owner`'s avatar got to on each other member's PC. */
  private deliveriesOf(owner: string): Delivery[] {
    const out: Delivery[] = [];
    if (owner === this.myId && !this.sharingNow()) return out;          // not going out at all: my own row says why
    for (const [id, l] of this.links) {
      if (id === owner || !l.ready) continue;
      const name = this.remotes.get(id)?.name ?? id.slice(0, 6);
      const ox = l.out.get(`${owner}:m`);
      const r = owner === this.myId ? null : this.remotes.get(owner);
      const allowed = owner === this.myId ? this.mayShareMine(l) : !!r && this.mayRelay(r, id);
      if (owner !== this.myId && r && !r.avatar) continue;                // they aren't sharing it at all: their own row says why
      if (!allowed) { out.push({ name, st: 'idle', why: owner === this.myId ? (this.shareMine ? 'policy:guild' : 'off') : `policy:${r?.share ?? 'host'}`, got: 0, n: 0 }); continue; }
      if (ox) out.push({ name, st: ox.legacy && ox.st === 'sent' ? 'outdated' : ox.st, why: ox.legacy && ox.st === 'sent' ? 'outdated' : ox.why, got: ox.st === 'sending' ? ox.sent : ox.got, n: ox.n });
    }
    return out;
  }
  private reportDeliveries(now: number) {
    this.myDeliveries = this.deliveriesOf(this.myId);
    for (const r of this.remotes.values()) {
      const l = this.links.get(r.id);
      if (!l?.ready || !l.caps.has(XF_CAP) || now - r.outAt < 2000) continue;
      const to = this.deliveriesOf(r.id);
      const j = JSON.stringify(to.map((d) => [d.name, d.st, d.why, d.st === 'sending' ? Math.round(d.got / 1048576) : 0]));
      if (j === r.outSeen) continue;
      r.outSeen = j; r.outAt = now;
      this.send(l, { t: 'xstat', owner: r.id, to });
    }
  }

  /** "Resend my avatar" (Multiplayer panel): announce + send it again to the host (guest) / everyone (host), tries reset. */
  resendMine() {
    if (this.role === 'none') return;
    void (async () => {
      await this.ensureModel(); await this.ensureCostume(); await this.ensureLod();
      const why = this.shareWhy();
      if (why) { this.say(`Can’t resend: ${xfWhyText(why, this.trisLimit)}`); return; }
      for (const l of this.links.values()) {
        if (!l.ready || !this.mayShareMine(l)) continue;
        for (const ox of l.out.values()) if (ox.owner === this.myId) ox.tries = 0;
        void this.resendTo(l, this.myId, 'm');
      }
      this.xlog('resend my avatar (button)');
      this.say('Sending your avatar again…');
    })();
  }
  /** Host: "Ask them to resend" (a guest's avatar) — guest: ask the host for a member's avatar again. */
  askResend(id: string) {
    const r = this.remotes.get(id);
    if (!r) return;
    const l = this.role === 'host' ? this.links.get(id) : this.hostLink();
    if (!l?.ready) { this.say(`${r.name} isn’t connected right now`); return; }
    if (!l.caps.has(XF_CAP)) {
      this.say(this.role === 'host' || r.id === l.id ? `${r.name}’s app is outdated — ask them to update VTube Pro (until then: switch “Share my avatar” off and on again)` : 'The host’s app is outdated — ask them to update VTube Pro');
      return;
    }
    r.ask = { tries: 1, next: performance.now() + XF_MISSING_MS };
    if (r.refused) { r.refused = false; r.avatar = true; r.why = ''; }
    this.setXin(r, 'm', 'retrying', 0, r.bytes, 'missing');
    this.askFor(r, l, 'm', 'button');
    this.say(`Asked for ${r.name}’s avatar again…`);
  }

  /** Everything needed to tell why an avatar didn't arrive — no keys, capabilities, tickets, links or model bytes. */
  // ---------------------------------------------------------------- TV performers (shared/tv.ts, src/net/tv/*)
  /** Appear as a TV performer (info) or as my avatar again (null): re-announce to the party. */
  setTv(info: TvInfo | null) {
    const was = this.myTv;
    this.myTv = info ? sanitizeTvInfo(info) : null;
    if (JSON.stringify(was) === JSON.stringify(this.myTv)) return;
    if (this.role === 'guest') { for (const l of this.links.values()) if (l.ready && l.introduced) { this.send(l, this.helloMsg()); if (!this.myTv && was && this.shareMine) this.sendMine(l); } }
    else if (this.role === 'host') {
      for (const l of this.links.values()) if (l.ready) {
        if (this.myTv || !this.mayShareMine(l)) this.send(l, { ...this.myProfileMsg(), ...(this.myTv ? {} : { profile: null, avatar: false, why: this.shareMine ? 'policy:guild' : 'off' }) } as Wire);
        else { this.send(l, this.myProfileMsg()); this.sendMine(l); }
      }
      // (a TV host's avatar leaves everyone's OBS: they drop it)
      if (this.myTv && !was) for (const l of this.links.values()) this.send(l, { t: 'drop', owner: this.myId });
    }
    this.rebuildRoster();
  }
  /** greenroom: a member's party link state + round trip (the Live panel's tech check). */
  linkInfo(id: string): { pc: RTCPeerConnectionState; rtt: number } | null { const l = this.links.get(id); return l ? { pc: l.pc.connectionState, rtt: l.rtt } : null; }
  /** A member's TV info (null = a normal avatar). */
  tvOf(id: string): TvInfo | null {
    if (id === this.myId) return this.myTv;
    const cam = this.tv?.cams.list.find((c) => c.id === id);
    if (cam) return this.tv.cams.info(cam);
    const r = this.remotes.get(id);
    if (r?.tv) return r.tv;
    return this.roster.find((m) => m.id === id)?.tv ?? null;
  }
  private applyTv(id: string, v: unknown, lite?: unknown) {
    const r = this.remotes.get(id);
    if (!r) return;
    if (lite !== undefined) r.lite = lite === true;
    const tv = sanitizeTvInfo(v);
    const was = JSON.stringify(r.tv ?? null);
    r.tv = tv;
    // no model: the scene sizes them from the TV's real height (controller → avatarSize(r.profile))
    if (tv && !r.avatar) r.profile = tvSizeProfile(tv);
    if (JSON.stringify(tv) !== was) { if (tv) r.why = 'tv'; this.rebuildRoster(); }
  }
  /** ctl → a guest (host) / the host (guest), only when that peer speaks 'tv1'. */
  private sendTv(to: string, m: TvSig): boolean {
    const l = this.role === 'guest' ? this.hostLink() : this.links.get(to);
    if (!l || !l.ready || !l.caps.has(TV_CAP) || l.ctl?.readyState !== 'open') return false;
    this.send(l, m);
    return true;
  }
  /** ctl → a guest (host) / the host (guest), only when that peer speaks 'vox1'. */
  private sendVox(to: string, m: VoxSig): boolean {
    const l = this.role === 'guest' ? this.hostLink() : this.links.get(to);
    if (!l || !l.ready || !l.caps.has(VOX_CAP) || l.ctl?.readyState !== 'open') return false;
    this.send(l, m);
    return true;
  }
  private voxPeers(): string[] {
    if (this.role === 'guest') { const l = this.hostLink(); return l && l.ready && l.id && l.caps.has(VOX_CAP) ? [l.id] : []; }
    if (this.role !== 'host') return [];
    return [...this.links.values()].filter((l) => l.ready && l.id && this.remotes.has(l.id) && l.caps.has(VOX_CAP)).map((l) => l.id);
  }
  /** Host: how member `id` talks (Live → People: the voice controls, "too old — use Discord"). */
  voxOf(id: string): VoxMemberState {
    if (this.role !== 'host' || id === this.myId) return 'none';
    const r = this.remotes.get(id), l = this.links.get(id);
    if (!r || !l?.ready) return 'none';
    return memberVoxState({ me: false, lite: !!r.lite, linkVoice: this.tvLinks.voices.has(id) || this.tvLinks.listeners.has(id), caps: [...l.caps], mode: this.voice.peers.get(id)?.mode ?? null, voice: this.voice.voices.has(id) });
  }

  /** Spout2 alpha (shared/spout.ts): may my packed picture go out? Host / solo: my own pages + guests that unpack
   *  (older guests see both halves: see docs); guest: only when the host speaks TV_ALPHA_CAP. */
  alphaOk(): boolean {
    if (this.role !== 'guest') return true;
    const l = this.hostLink();
    return !!l && l.ready && l.caps.has(TV_ALPHA_CAP);
  }
  /** TvStudio: my solo Spout2 performer came / went — tell this PC's OBS pages now (not at the next 3 s beat). */
  private soloWas = false;
  tvSoloChanged() { this.soloWas = this.tv.soloShow; this.publishLocal(); }
  private tvPeers(): string[] {
    if (this.role === 'guest') { const l = this.hostLink(); return l && l.ready && l.id && l.caps.has(TV_CAP) ? [l.id] : []; }
    if (this.role !== 'host') return [];
    return [...this.links.values()].filter((l) => l.ready && l.id && this.remotes.has(l.id) && l.caps.has(TV_CAP)).map((l) => l.id);
  }
  /** Host: may `owner`'s TV feed go to member `to`? Same rule as avatars (the owner's policy), minus the "sharing" flag:
   *  appearing as a TV IS the consent. */
  private mayForwardTv(owner: string, to: string): boolean {
    const rec = this.links.get(to);
    if (!rec) return false;
    const policy = owner === this.myId ? this.sharePolicy : this.remotes.get(owner)?.share ?? 'host';
    if (owner !== this.myId && !this.remotes.get(owner)?.tv) return false;
    if (this.green.hidden(owner)) return false;                        // a waiting guest's camera reaches only me
    if (policy === 'host' && owner !== this.myId) return false;
    if (policy === 'guild') return rec.who.verified && rec.who.guildOk;
    return true;
  }

  diagnostics(): string {
    const now = performance.now();
    const ago = (t: number) => (t ? `${Math.round((now - t) / 1000)} s ago` : '-');
    const ch = (c: RTCDataChannel | null) => (c ? `${c.readyState}${c.bufferedAmount ? ` (${fmtMB(c.bufferedAmount)} queued)` : ''}` : 'none');
    const outs = (l: Link) => [...l.out.values()].map((o) => ({ of: this.nameOf(o.owner), kind: o.kind, st: o.st, why: o.why, tries: o.tries, size: fmtMB(o.n), sent: fmtMB(o.sent), confirmed: fmtMB(o.got), legacy: o.legacy, moved: ago(o.at) }));
    const xv = (v: XfView | null) => (v ? { st: v.st, why: v.why, got: fmtMB(v.got), size: fmtMB(v.n), tries: v.tries, at: ago(v.at) } : null);
    return JSON.stringify({
      app: 'VTube Pro party diagnostics', build: PARTY_BUILD, caps: CAPS, at: new Date().toISOString(), ua: navigator.userAgent,
      role: this.role, via: this.via, status: this.status,
      me: {
        name: this.myDiscord?.name ?? this.name, share: this.shareMine, policy: this.sharePolicy, why: this.shareWhy(), sharingNow: this.sharingNow(),
        avatar: this.myProfile?.id ?? null, model: this.myModel ? fmtMB(this.myModel.byteLength) : null, costume: this.myCostume ? `${this.myCostume.id} ${fmtMB(this.myCostume.buf.byteLength)}` : null,
        set: this.mySet ? `${this.mySet.id} (${this.mySet.acc.length} accessories, ${fmtMB(this.mySet.buf.byteLength)})` : null, accWhy: this.accWhy,
        tris: this.myTrisTotal, srcTris: this.srcTris.m + this.srcTris.c, limit: this.trisLimit, hostLimit: this.hostMaxTris, lod: { state: this.lodState, error: this.lodError }, deliveries: this.myDeliveries,
      },
      links: [...this.links.values()].map((l) => ({
        to: this.nameOf(l.id), via: l.via, caps: [...l.caps], ready: l.ready, pc: l.pc.connectionState, ice: l.pc.iceConnectionState, rtt: l.rtt,
        ctl: ch(l.ctl), bin: ch(l.bin), rt: ch(l.rt), welcomed: l.welcomed ?? null, early: l.early?.length ?? 0, out: outs(l),
      })),
      members: [...this.remotes.values()].map((r) => ({
        name: r.name, verified: r.verified, share: r.share, avatar: r.avatar, why: r.why, refused: r.refused, announced: fmtMB(r.bytes),
        onObs: !!r.refs.model, costume: r.refs.costumeId, tris: r.tris, legacyRx: { m: fmtMB(r.rx.m.got), c: fmtMB(r.rx.c.got) },
        inx: (['m', 'c'] as const).map((k) => r.inx[k] ? `${k} ${fmtMB(r.inx[k]!.got)}/${fmtMB(r.inx[k]!.n)} moved ${ago(r.inx[k]!.at)}` : null).filter(Boolean),
        xin: { m: xv(r.xin.m), c: xv(r.xin.c) }, ask: r.ask.tries, late: !!r.late, sharing: ago(r.shareAt), sentTo: [...r.sentTo].map((id) => this.nameOf(id)),
      })),
      orphans: [...this.orphans.values()].map((o) => `${o.q.length} packets ${fmtMB(o.bytes)} ${ago(o.at)}`),
      tv: { me: this.myTv, members: [...this.remotes.values()].filter((r) => r.tv).map((r) => ({ name: r.name, tv: r.tv })), links: this.tvLinks.debug() },
      voice: this.voice.debug(),
      log: this.xlogs.slice(-120).map((e) => `${((e.t - now) / 1000).toFixed(1)}s ${e.s}`),
    }, null, 1);
  }
  private xlog(s: string) {
    this.xlogs.push({ t: performance.now(), s });
    if (this.xlogs.length > 300) this.xlogs.splice(0, this.xlogs.length - 300);
  }

  /** Host: owner `r` as member `to` may see them — their profile only where their sharing rule allows, else why not. */
  private relayProfile(r: Remote, to: string): Wire {
    const ok = this.mayRelay(r, to);
    if (r.tv) return { t: 'profile', owner: r.id, name: r.name, profile: null, bytes: 0, share: r.share, avatar: false, why: this.mayForwardTv(r.id, to) ? 'tv' : `policy:${r.share}`, tv: r.tv };
    return { t: 'profile', owner: r.id, name: r.name, profile: ok ? r.profile : null, bytes: r.bytes, share: r.share, avatar: r.avatar, why: r.avatar && !ok ? `policy:${r.share}` : r.why };
  }
  /** Guest: my avatar on its way to the host (what the panel shows on my own row). */
  private myUpload(): XfView | null {
    const l = this.hostLink();
    if (!l) return null;
    const m = l.out.get(`${this.myId}:m`), c = l.out.get(`${this.myId}:c`);
    const ox = c && c.st !== 'done' && c.st !== 'idle' && (!m || m.st === 'done') ? c : m;
    if (!ox) return null;
    return { st: ox.legacy && ox.st === 'sent' ? 'outdated' : ox.st, kind: ox.kind, got: ox.st === 'sending' ? Math.max(ox.got, ox.sent) : ox.got, n: ox.n, why: ox.legacy && ox.st === 'sent' ? 'outdated' : ox.why, tries: ox.tries, at: ox.at };
  }
  /** The transfer worth showing for a member: whatever is moving / failing, else the model's last state. */
  private pickXin(r: Remote): XfView | null {
    const c = r.xin.c, m = r.xin.m;
    return c && c.st !== 'done' && c.st !== 'idle' && (!m || m.st === 'done') ? c : m;
  }

  private notify() {
    this.onChange();
    for (const l of this.listeners) try { l(); } catch (e) { console.warn('party listener', e); }
  }

  private say(s: string) { this.status = s; if (s) this.xlog(`status: ${s}`); this.notify(); }
}
