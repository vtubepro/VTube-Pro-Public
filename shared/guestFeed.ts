// Guest browser source ("Guesting on someone else's show"): your avatar, on a see-through background, as ONE link the
// other streamer pastes into OBS as a Browser Source. Spec + acceptance criteria: docs/GUEST_BROWSER_SOURCE.md.
//
// This file is the pure contract every part speaks (no DOM, no three.js, no Node APIs; the viewer page, the headless sender
// page, the helper, the studio card and the Node tests all import it; tested in tools/guestfeed_unit.ts):
//   * constants: caps, quality / frame-rate tiers, governor thresholds, timeouts;
//   * the link: the viewer URL and its #fragment (build + parse + validation), the viewer's peer id (key + instance);
//   * the messages: the "side-band" status the sender whispers through the relay, and the data-channel messages (every
//     receiver re-sanitises them);
//   * rules as pure functions: who may connect (viewerDecision / allowKey), the performance governor (GsGovernor), the
//     lip-sync delay queue (GsDelayQueue), the alpha pack maths (reuses shared/spout.ts), which route a link takes;
//   * the helper API shapes (GsView, GsSettings, GsReport) and their sanitizers;
//   * every plain-words sentence the viewer page (in the other streamer's OBS) and the studio card show.
// The relay is unchanged: signalling rides the phone link (relay/src/phoneLink.ts, shared/phoneLink.ts). The sender is
// the relay's "studio" socket, a viewer is a "phone" socket whose peer id is `<key 16><instance 8>`.
import { ALPHA_HI, ALPHA_LO, PACK_GUTTER, alphaRemap, packLayout, premulClamp } from './spout.ts';
import { PHONE_LINK_ID_RX, cleanRelay, newPhoneLinkId } from './phoneLink.ts';

export { PACK_GUTTER, ALPHA_LO, ALPHA_HI, PHONE_LINK_ID_RX, cleanRelay };

// ---------------------------------------------------------------- constants

export const GS_VERSION = 1;
/** The viewer page every link opens: this app's own page (vite multi-page entry `view`), served at /view.html by the server
 *  of the PC that made the link. Everything that identifies the link is in the #fragment, so the other streamer can paste
 *  the fragment behind the address of the same page on THEIR VTube Pro (http://127.0.0.1:<port>/view.html). */
export const GS_VIEW_PATH = '/view.html';
/** Most viewers (OBS pages) one link serves at once. Each one is a separate encode on the gaming PC. */
export const GS_MAX_VIEWERS = 2;
/** The relay's phone route lets 4 "phone" sockets in per link (relay/src/phoneLink.ts MAX_PHONES); a viewer holds one. */
export const GS_RELAY_SOCKETS = 4;
export const GS_NAME_MAX = 24;
export const GS_URL_MAX = 700;
/** Viewer-side lip-sync delay (frame queue; NOT jitterBufferTarget, which old OBS browsers lack). */
export const GS_DELAY_MAX_MS = 600;
export const GS_DELAY_STEP_MS = 10;
/** Memory the viewer's delay queue may hold (unpacked output frames). Fewer frames are kept when the picture is big. */
export const GS_QUEUE_BYTES = 160 * 1024 * 1024;
export type GsQuality = 720 | 1080;
export const GS_QUALITIES: readonly GsQuality[] = [720, 1080];
/** "Turn off by itself" choices (minutes, 0 = never). The timer only runs while NO viewer is connected. */
export const GS_AUTO_OFF_MIN: readonly number[] = [0, 60, 120, 240, 480];
/** A link nobody has connected to for this long turns itself off (the card says so). */
export const GS_IDLE_OFF_MS = 24 * 3600_000;
/** A knock (an unknown OBS) waits this long for Allow, then it is blocked (like the phone link). */
export const GS_KNOCK_MS = 30_000;
/** A blocked OBS is refused for this long (its key). "New link" clears every block. */
export const GS_BLOCK_MS = 10 * 60_000;
/** A viewer that sent nothing (stats every 2 s) for this long is stale: its place can be taken by a reload of the same OBS. */
export const GS_VIEWER_STALE_MS = 6000;
export const GS_STATS_EVERY_MS = 2000;
export const GS_REPORT_EVERY_MS = 1000;
/** The handshake gives up after this (shared/phoneLink.ts HANDSHAKE_TIMEOUT_MS is 20 s too). */
export const GS_HANDSHAKE_MS = 20_000;
/** The viewer keeps showing the last picture this long after frames stop, then clears and says why. */
export const GS_HOLD_LAST_MS = 8000;
/** The viewer asks again (a fresh offer) this often while nobody answered, and after a failure (growing, then flat). */
export const GS_RETRY_MS: readonly number[] = [500, 1000, 2000, 4000, 8000, 15000];
/** After "turned off" / "blocked" the viewer only looks again this slowly. */
export const GS_SLOW_RETRY_MS = 30_000;
/** A sender browser that quits more than this often in GS_RESTART_WINDOW_MS is left alone (the card says so). */
export const GS_RESTARTS_MAX = 4;
export const GS_RESTART_WINDOW_MS = 120_000;
/** Data channel: one reliable ordered JSON channel made by the viewer. Messages are tiny. */
export const GS_CHANNEL = 'gs';
export const GS_MSG_MAX = 1024;
/** The sender page frames the avatar like the OBS page's ?focus=bust (head and shoulders, 16:9). */
export const GS_FOCUS = 'bust';
/** Test switch: the sender paints Date.now() % 2^24 as 24 blocks of 16 px along the bottom-left of the alpha half (like ?spStamp=1); the viewer (fragment &st=1) reads it back. */
export const GS_STAMP_BLOCKS = 24;

export type GsTierName = 'full' | 'light' | 'low' | 'hold';
/** Picture size (the colour half; the packed frame is 2x + gutter wide), frame rate and the encoder's bit-rate cap. */
export interface GsTier { name: GsTierName; w: number; h: number; fps: number; kbps: number }
export const GS_LADDER: readonly GsTierName[] = ['full', 'light', 'low', 'hold'];
const FULL: Record<GsQuality, GsTier> = {
  720: { name: 'full', w: 1280, h: 720, fps: 30, kbps: 3000 },
  1080: { name: 'full', w: 1920, h: 1080, fps: 30, kbps: 6000 },
};
const STEPS: Record<Exclude<GsTierName, 'full'>, GsTier> = {
  light: { name: 'light', w: 960, h: 540, fps: 30, kbps: 1800 },
  low: { name: 'low', w: 960, h: 540, fps: 15, kbps: 1000 },
  hold: { name: 'hold', w: 640, h: 360, fps: 5, kbps: 400 },
};
export const gsTier = (q: GsQuality, name: GsTierName): GsTier => (name === 'full' ? FULL[q] : STEPS[name]);
/** The packed frame (premultiplied colour | 16 px gutter | alpha grey) for a tier: shared/spout.ts packLayout. */
export const gsPackSize = (t: Pick<GsTier, 'w' | 'h'>) => { const l = packLayout(t.w, t.h); return { w: l.fw, h: l.fh, cw: l.cw, alphaX: l.ax, pack: l.pack }; };

/** Performance governor thresholds (docs/GUEST_BROWSER_SOURCE.md, "Perf governor"). */
export const GS_GOV = {
  /** the studio's health beacon older than this proves nothing (no step down from it, no "clean") */
  healthStaleMs: 5000,
  /** graphics-queue round trip (TrackingHealth.gpuSyncMs) above this = the card is busy with something else */
  gpuSyncMs: 25, gpuSyncCleanMs: 12,
  /** a face run in flight (TrackingHealth.inflightMs) longer than this = the tracker is waiting on the card */
  inflightMs: 120, inflightCleanMs: 60,
  /** face starvation (TrackingHealth.starve, 0..1) above this */
  starve: 0.5,
  /** our own render + pack time above this many frame budgets */
  renderBudgetX: 1.5,
  /** bad readings must last this long before one step down (stall mode is immediate) */
  enterMs: 2000,
  /** clean readings must last this long before one step up; doubles after a relapse, up to upMaxHoldMs */
  upHoldMs: 15_000, upMaxHoldMs: 120_000, relapseMs: 180_000,
  /** stall mode that lasts this long at the 'low' tier goes on to 'hold' */
  holdAfterMs: 30_000,
} as const;

// ---------------------------------------------------------------- plain strings
export const clean = (v: unknown, n: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u001f\u007f<>"`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, n) : '');
export const sanitizeName = (v: unknown): string => clean(v, GS_NAME_MAX);
const who = (name: string) => (name ? name : 'your guest');
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

export type GsViewerState = 'badLink' | 'oldLink' | 'tooOld' | 'noGl' | 'connecting' | 'noServer' | 'waiting' | 'asking' | 'blocked' | 'full' | 'off' | 'live' | 'lost' | 'failed';
/** The sentences the viewer page shows in the other streamer's OBS ('' = none: the picture is the message). */
export function viewerText(state: GsViewerState, name = ''): string {
  const w = who(sanitizeName(name));
  switch (state) {
    case 'badLink': return 'This link isn’t complete. Copy it again from VTube Pro.';
    case 'oldLink': return 'This link is from an older version of VTube Pro. Ask for a new one.';
    case 'tooOld': return 'Your OBS is too old to show this. Update OBS, then reload this source.';
    case 'noGl': return 'Your OBS can’t draw this picture. In OBS open Settings → Advanced, turn on “Enable browser source hardware acceleration”, then restart OBS.';
    case 'connecting': return 'Connecting…';
    case 'noServer': return 'Can’t reach the connection server. Check this PC’s internet. It keeps trying.';
    case 'waiting': return `Waiting for ${w}’s PC…`;
    case 'asking': return `Waiting for ${w} to say yes…`;
    case 'blocked': return `${cap(w)} didn’t let this OBS in. Ask for a new link.`;
    case 'full': return 'This link is already showing in two places. Ask for a new link, or remove an old copy of this source.';
    case 'off': return `${cap(w)} turned this link off. Ask for a new one.`;
    case 'lost': return 'The picture stopped. It comes back by itself.';
    case 'failed': return 'Couldn’t connect. Your network may block it. It keeps trying.';
    case 'live': return '';
  }
}

export type GsCardState = 'off' | 'starting' | 'waiting' | 'live' | 'paused' | 'asking' | 'busy' | 'noBrowser' | 'crashed' | 'noServer' | 'inUse' | 'idleOff';
/** The sentence the studio card shows for each state. `viewers` = connected OBS pages. */
export function cardText(state: GsCardState, viewers = 0): string {
  switch (state) {
    case 'off': return 'Off. Nobody can use the link.';
    case 'starting': return 'Getting ready…';
    case 'waiting': return 'Ready. Paste the link into OBS on the other person’s PC.';
    case 'live': return viewers > 1 ? `Live: ${viewers} OBS sources are watching.` : 'Live: their OBS is watching.';
    case 'paused': return 'Their OBS isn’t showing this source right now, so nothing is being drawn.';
    case 'asking': return 'A new OBS opened your link. Let it in?';
    case 'busy': return 'Your game needs the graphics card, so the picture is simpler for now.';
    case 'noBrowser': return 'This needs Google Chrome or Microsoft Edge on this PC. Install one and try again.';
    case 'crashed': return 'The picture maker keeps closing. Turn this off and on again, or restart VTube Pro.';
    case 'noServer': return 'Can’t reach the connection server. Check this PC’s internet. It keeps trying.';
    case 'inUse': return 'This link is open in another VTube Pro window. Press “New link”.';
    case 'idleOff': return 'Turned off because nobody used the link for a day.';
  }
}
export type GsPrivacy = 'relay' | 'direct' | 'unknown';
export function privacyText(p: GsPrivacy): string {
  if (p === 'relay') return 'Your home internet address stays hidden: the picture goes through a relay.';
  if (p === 'direct') return 'Only a basic connection server is available, so the other person’s OBS can see your home internet address while it is connected. For more privacy you need an invite server with relay support.';
  return 'Checking the connection…';
}
/** The "how to paste it into OBS" steps the card and the docs show (same words). Voice is NOT in the link. */
export function obsSteps(q: GsQuality): string[] {
  const t = gsTier(q, 'full');
  return [
    'In OBS, press + under Sources and choose Browser.',
    `Paste the link as the URL. Set Width to ${t.w} and Height to ${t.h}.`,
    'Leave “Shutdown source when not visible” off, then press OK.',
  ];
}
export const GS_SILENT_NOTE = 'This link is silent. Talk to them on Discord as usual.';

// ---------------------------------------------------------------- the link

/** A viewer's long-lived id inside one OBS (kept in the page's storage): 16 chars. The sender locks on it. */
export const GS_KEY_RX = /^[a-z0-9]{16}$/;
export const GS_INST_RX = /^[a-z0-9]{8}$/;
const ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const randId = (n: number, rand: (n: number) => Uint8Array) => Array.from(rand(n), (b) => ALPHABET[b % 36]).join('');
const defRand = (n: number) => crypto.getRandomValues(new Uint8Array(n));
export const newGuestLinkId = newPhoneLinkId;
export const newViewerKey = (rand: (n: number) => Uint8Array = defRand) => randId(16, rand);
export const newViewerInst = (rand: (n: number) => Uint8Array = defRand) => randId(8, rand);
export const newKnockId = (rand: (n: number) => Uint8Array = defRand) => randId(6, rand);
/** The relay's peer id for a viewer page: `<key><instance>` (24 chars; relay/src/phoneLink.ts PEER_ID allows 8..32). */
export const viewerPeerId = (key: string, inst: string) => `${key}${inst}`;
export function parseViewerPeer(peer: unknown): { key: string; inst: string } | null {
  if (typeof peer !== 'string' || peer.length !== 24) return null;
  const key = peer.slice(0, 16), inst = peer.slice(16);
  return GS_KEY_RX.test(key) && GS_INST_RX.test(inst) ? { key, inst } : null;
}

export interface GsLink {
  relay: string; id: string; /** viewer key override (tests, OBS builds that wipe their storage); the card never adds it */ key: string | null; delayMs: number; q: GsQuality; name: string;
  /** the guest's public signing key (ECDSA P-256, raw point, base64url): the viewer only believes an answer signed with it. null = a link from before keys existed */
  pub: string | null;
}
export const clampDelay = (v: unknown): number => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  return Number.isFinite(n) ? Math.min(GS_DELAY_MAX_MS, Math.max(0, Math.round(n / GS_DELAY_STEP_MS) * GS_DELAY_STEP_MS)) : 0;
};
export const asQuality = (v: unknown): GsQuality => (Number(v) === 1080 ? 1080 : 720);
/** The viewer URL: page + #r=<relay>&i=<id>[&p=<public key>][&k=<key>]&d=<ms>&q=<720|1080>[&n=<name>]. The fragment is never sent to any server. */
export function buildViewUrl(pageBase: string, link: Partial<GsLink> & { relay: string; id: string }): string {
  const r = cleanRelay(link.relay);
  if (!r || !PHONE_LINK_ID_RX.test(link.id)) throw new Error('guest link: bad relay or id');
  const k = link.key && GS_KEY_RX.test(link.key) ? `&k=${link.key}` : '';
  const p = link.pub && GS_PUB_RX.test(link.pub) ? `&p=${link.pub}` : '';
  const n = sanitizeName(link.name);
  return `${pageBase.replace(/#.*$/, '')}#r=${encodeURIComponent(r)}&i=${link.id}${p}${k}&d=${clampDelay(link.delayMs)}&q=${asQuality(link.q)}${n ? `&n=${encodeURIComponent(n)}` : ''}`;
}
/** The fragment (with or without '#') → a link, or null when relay / id are missing or invalid. Everything else falls back to defaults. */
export function parseViewHash(hash: unknown): GsLink | null {
  if (typeof hash !== 'string' || hash.length > GS_URL_MAX) return null;
  let p: URLSearchParams;
  try { p = new URLSearchParams(hash.replace(/^#/, '')); } catch { return null; }
  const relay = cleanRelay(p.get('r')), id = p.get('i') ?? '';
  if (!relay || !PHONE_LINK_ID_RX.test(id)) return null;
  const k = p.get('k') ?? '';
  const pub = p.get('p') ?? '';
  return { relay, id, key: GS_KEY_RX.test(k) ? k : null, delayMs: clampDelay(p.get('d')), q: asQuality(p.get('q')), name: sanitizeName(p.get('n')), pub: GS_PUB_RX.test(pub) ? pub : null };
}

// ---------------------------------------------------------------- who is on the other end (sender authentication)
// The relay is the same for everybody who has the link id, and it lets the "studio" slot be taken by whoever gets there first. So the
// viewer does not believe an answer because it arrived: the helper makes an ECDSA P-256 key pair per link (server/guestFeed.ts), the
// public half rides in the link's #fragment (`p=`), and the sender signs its answer with the private half (fetched over the
// sender-only API). The signature covers the answer's DTLS fingerprint(s) + the link id + the viewer's peer id + a nonce the viewer chose
// for THIS offer, so an answer can be neither forged, nor replayed to another viewer, link or offer, nor can its media endpoint be swapped.
// The relay passes only {type, sdp} for an offer / answer, so both extras ride inside the SDP text as session attributes (a=vtp-gs-nonce
// in the viewer's offer, a=vtp-gs-sig in the sender's answer): browsers ignore attributes they do not know.
/** A public key: the 65-byte uncompressed P-256 point (04 | X | Y) in base64url = 87 characters. */
export const GS_PUB_RX = /^[A-Za-z0-9_-]{87}$/;
/** A private key: the 32-byte scalar `d` in base64url = 43 characters. */
export const GS_PRIV_RX = /^[A-Za-z0-9_-]{43}$/;
export const GS_NONCE_ATTR = 'vtp-gs-nonce';
export const GS_SIG_ATTR = 'vtp-gs-sig';
export const GS_NONCE_RX = /^[A-Za-z0-9_-]{22,43}$/;
const te8 = new TextEncoder();
export const gsB64u = (b: Uint8Array): string => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); };
export const gsUnb64u = (s: string): Uint8Array => { const t = s.replace(/-/g, '+').replace(/_/g, '/'); return Uint8Array.from(atob(t + '='.repeat((4 - (t.length % 4)) % 4)), (c) => c.charCodeAt(0)); };
const subtle = (): SubtleCrypto => { const s = globalThis.crypto?.subtle; if (!s) throw new Error('no WebCrypto'); return s; };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' } as const;
/** A fresh nonce for one offer (16 random bytes). */
export const newGsNonce = (rand: (n: number) => Uint8Array = defRand): string => gsB64u(rand(16));
/** The SDP with one extra session-level attribute line (before the first m= line). */
export function sdpWithAttr(sdp: string, name: string, value: string): string {
  const eol = sdp.includes('\r\n') ? '\r\n' : '\n';
  const line = `a=${name}:${value}`;
  const i = sdp.search(/^m=/m);
  if (i < 0) return sdp.endsWith(eol) ? `${sdp}${line}${eol}` : `${sdp}${eol}${line}${eol}`;
  return `${sdp.slice(0, i)}${line}${eol}${sdp.slice(i)}`;
}
export const sdpAttr = (sdp: string, name: string): string | null => new RegExp(`^a=${name}:([A-Za-z0-9_-]{1,200})\\r?$`, 'm').exec(sdp)?.[1] ?? null;
export const sdpWithoutAttr = (sdp: string, name: string): string => sdp.replace(new RegExp(`^a=${name}:[^\\r\\n]*\\r?\\n`, 'gm'), '');
/** Every DTLS fingerprint line of an SDP as "<hash> <hex>", lower-case, sorted, without repeats (Chrome repeats it per media section). */
export function sdpFingerprints(sdp: string): string[] {
  const out = new Set<string>();
  for (const m of sdp.matchAll(/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\r?$/gm)) out.add(`${m[1].toLowerCase()} ${m[2].toLowerCase()}`);
  return [...out].sort();
}
/** True when EVERY line that looks like a fingerprint line (a=fingerprint:, any case, leading space or tab allowed) is one the strict pattern of
 *  sdpFingerprints parses (so the count of loose lines equals the count of parsed lines). A browser may still read a sloppy line (extra spaces,
 *  a tab, A=FINGERPRINT) that the signature then does not cover, so the viewer refuses such an answer. */
export function sdpFingerprintLinesStrict(sdp: string): boolean {
  let loose = 0, strict = 0;
  for (const l of sdp.split('\n')) {
    if (/^a=fingerprint:/i.test(l.trimStart())) loose++;
    if (/^a=fingerprint:(\S+) ([0-9A-Fa-f:]+)\r?$/.test(l)) strict++;
  }
  return loose === strict;
}
/** The exact string the sender signs and the viewer checks. */
export const gsAnswerCanon = (o: { id: string; peer: string; nonce: string; fp: readonly string[] }): string => `vtp-gs-answer-v1\n${o.id}\n${o.peer}\n${o.nonce}\n${o.fp.join(',')}`;
/** The private key as a JWK (the public half comes from the raw point). */
export function gsPrivateJwk(pk: string, sk: string): JsonWebKey {
  const raw = gsUnb64u(pk);
  if (raw.length !== 65 || raw[0] !== 4 || !GS_PRIV_RX.test(sk)) throw new Error('bad guest key');
  return { kty: 'EC', crv: 'P-256', x: gsB64u(raw.subarray(1, 33)), y: gsB64u(raw.subarray(33, 65)), d: sk, ext: true };
}
/** Sender: the answer with its signature attached, or null when it cannot be signed (no nonce in the offer, no fingerprint in the answer, bad key). */
export async function gsSignAnswer(keys: { pk: string; sk: string }, o: { id: string; peer: string; offerSdp: string; answerSdp: string }): Promise<string | null> {
  try {
    const nonce = sdpAttr(o.offerSdp, GS_NONCE_ATTR);
    const fp = sdpFingerprints(o.answerSdp);
    if (!nonce || !GS_NONCE_RX.test(nonce) || !fp.length) return null;
    const key = await subtle().importKey('jwk', gsPrivateJwk(keys.pk, keys.sk), ECDSA, false, ['sign']);
    const sig = new Uint8Array(await subtle().sign({ name: 'ECDSA', hash: 'SHA-256' }, key, te8.encode(gsAnswerCanon({ id: o.id, peer: o.peer, nonce, fp }))));
    return sdpWithAttr(sdpWithoutAttr(o.answerSdp, GS_SIG_ATTR), GS_SIG_ATTR, gsB64u(sig));
  } catch { return null; }
}
/** Viewer: the answer without its signature line when it is signed by the link's key for THIS offer (nonce) and THIS viewer (peer), else null. Never throws. */
export async function gsVerifyAnswer(pub: string, o: { id: string; peer: string; nonce: string; answerSdp: string }): Promise<string | null> {
  try {
    if (!GS_PUB_RX.test(pub) || !GS_NONCE_RX.test(o.nonce)) return null;
    const raw = gsUnb64u(pub);
    const sig = sdpAttr(o.answerSdp, GS_SIG_ATTR);
    const fp = sdpFingerprints(o.answerSdp);
    if (raw.length !== 65 || raw[0] !== 4 || !sig || sig.length !== 86 || !fp.length) return null;
    // a fingerprint line the strict pattern did not parse (spaces, tabs, A=FINGERPRINT, junk) is not covered by the signature: refuse
    if (!sdpFingerprintLinesStrict(o.answerSdp)) return null;
    const key = await subtle().importKey('raw', raw as Uint8Array<ArrayBuffer>, ECDSA, false, ['verify']);
    const good = await subtle().verify({ name: 'ECDSA', hash: 'SHA-256' }, key, gsUnb64u(sig) as Uint8Array<ArrayBuffer>, te8.encode(gsAnswerCanon({ id: o.id, peer: o.peer, nonce: o.nonce, fp })));
    return good ? sdpWithoutAttr(o.answerSdp, GS_SIG_ATTR) : null;
  } catch { return null; }
}
/** The key a viewer shows the sender (and the relay) for ONE link: HMAC-SHA256(its stored key, link id) mapped to 16 characters. The stored key never
 *  leaves the page, and the same OBS has a different identity on every link (nobody can match it across shows). */
export async function derivePeerKey(viewerKey: string, linkId: string): Promise<string> {
  const k = await subtle().importKey('raw', te8.encode(viewerKey), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await subtle().sign('HMAC', k, te8.encode(`vtp-gs-peer-v1|${linkId}`)));
  return Array.from(mac.subarray(0, 16), (b) => ALPHABET[b % 36]).join('');
}

// ---------------------------------------------------------------- the signalling "side-band"
// The relay passes only {sdp | candidate} inside {t:'signal'}; a `candidate` object goes through unchanged. The sender
// uses that to tell a viewer where it stands BEFORE any connection exists (nothing else could reach it). A viewer that
// never sees one (an older relay that filtered it) falls back to timers: see docs/GUEST_BROWSER_SOURCE.md.
export type GsSideState = 'wait' | 'ask' | 'blocked' | 'full' | 'off';
export interface GsSide { vtp: 1; s: GsSideState }
export const makeSide = (s: GsSideState): { candidate: GsSide } => ({ candidate: { vtp: 1, s } });
export function sideBandOf(candidate: unknown): GsSide | null {
  if (!candidate || typeof candidate !== 'object') return null;
  const o = candidate as Record<string, unknown>;
  return o.vtp === 1 && (o.s === 'wait' || o.s === 'ask' || o.s === 'blocked' || o.s === 'full' || o.s === 'off') ? { vtp: 1, s: o.s } : null;
}
/** The viewer page state for a side-band status (what text it shows). */
export const stateOfSide = (s: GsSideState): GsViewerState => (s === 'ask' ? 'asking' : s === 'wait' ? 'waiting' : s);

// ---------------------------------------------------------------- data-channel messages
export type GsToViewer =
  | { t: 'cfg'; d: number; q: GsQuality; w: number; h: number; fps: number; n: string; tier: GsTierName }
  | { t: 'off' };                      // the link was turned off / replaced: stop, show the "turned off" sentence
export type GsToSender =
  | { t: 'vis'; on: boolean }          // the OBS source is shown / hidden
  | { t: 'stats'; fps: number; w: number; h: number; codec: string; dec: string; lost: number; dropped: number; rttMs: number; obs: boolean; route: GsRoute }
  | { t: 'slow' }                      // the viewer cannot decode fast enough: one tier down
  | { t: 'bye' };
export type GsRoute = 'relay' | 'direct' | 'unknown';
const num = (v: unknown, lo: number, hi: number, dflt = 0) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : dflt);
const parseMsg = (raw: unknown): Record<string, unknown> | null => {
  let m: unknown = raw;
  if (typeof raw === 'string') { if (raw.length > GS_MSG_MAX) return null; try { m = JSON.parse(raw); } catch { return null; } }
  return m && typeof m === 'object' && !Array.isArray(m) ? m as Record<string, unknown> : null;
};
export function sanitizeToViewer(raw: unknown): GsToViewer | null {
  const m = parseMsg(raw);
  if (!m) return null;
  if (m.t === 'off') return { t: 'off' };
  if (m.t !== 'cfg') return null;
  const tier = GS_LADDER.includes(m.tier as GsTierName) ? m.tier as GsTierName : 'full';
  return { t: 'cfg', d: clampDelay(m.d), q: asQuality(m.q), w: Math.round(num(m.w, 2, 3840, 1280)), h: Math.round(num(m.h, 2, 2160, 720)), fps: Math.round(num(m.fps, 1, 60, 30)), n: sanitizeName(m.n), tier };
}
export const routeOf = (candidateType: unknown): GsRoute => (candidateType === 'relay' ? 'relay' : candidateType === 'host' || candidateType === 'srflx' || candidateType === 'prflx' ? 'direct' : 'unknown');
export function sanitizeToSender(raw: unknown): GsToSender | null {
  const m = parseMsg(raw);
  if (!m) return null;
  if (m.t === 'vis') return typeof m.on === 'boolean' ? { t: 'vis', on: m.on } : null;
  if (m.t === 'slow') return { t: 'slow' };
  if (m.t === 'bye') return { t: 'bye' };
  if (m.t !== 'stats') return null;
  return {
    t: 'stats', fps: Math.round(num(m.fps, 0, 240)), w: Math.round(num(m.w, 0, 8192)), h: Math.round(num(m.h, 0, 8192)), codec: clean(m.codec, 40), dec: clean(m.dec, 60),
    lost: Math.round(num(m.lost, 0, 1e9)), dropped: Math.round(num(m.dropped, 0, 1e9)), rttMs: Math.round(num(m.rttMs, 0, 60_000)), obs: m.obs === true, route: routeOf(m.route),
  };
}
export const encodeMsg = (m: GsToViewer | GsToSender): string => JSON.stringify(m);

// ---------------------------------------------------------------- who may connect
export interface GsViewerRef { peer: string; key: string; at: number }
export type GsAct = 'accept' | 'replace' | 'knock' | 'knockWait' | 'blocked' | 'full';
/**
 * What the sender does with a viewer's offer.
 *   blocked    its key is blocked (Block, or a knock that timed out): bye + side-band 'blocked'
 *   accept     its key holds the lock, or nobody holds it yet (`lock`: add the key to the lock, "first OBS wins")
 *   replace    the link is full but this key's own older (stale or not) page is there: close that one, accept this one
 *   full       the link is full (GS_MAX_VIEWERS) and this key is not already there: bye + side-band 'full'
 *   knock      a key that does not hold the lock: ask the user (Allow / Block), side-band 'ask'
 *   knockWait  another key is being asked right now: side-band 'ask', no second question
 */
export function viewerDecision(o: { peer: string; lock: readonly string[]; viewers: readonly GsViewerRef[]; blocked: ReadonlyMap<string, number>; knocking: string | null; now: number; max?: number }): { act: GsAct; lock: boolean } {
  const p = parseViewerPeer(o.peer);
  if (!p) return { act: 'blocked', lock: false };
  const max = o.max ?? GS_MAX_VIEWERS;
  if ((o.blocked.get(p.key) ?? 0) > o.now) return { act: 'blocked', lock: false };
  const held = o.lock.includes(p.key);
  if (!held && o.lock.length) return { act: o.knocking && o.knocking !== p.key ? 'knockWait' : 'knock', lock: false };
  // (the lock is empty: the first OBS to connect gets it)
  const others = o.viewers.filter((v) => v.peer !== o.peer);
  if (others.length >= max) return others.some((v) => v.key === p.key) ? { act: 'replace', lock: !held } : { act: 'full', lock: false };
  return { act: 'accept', lock: !held };
}
/** Which of this key's pages 'replace' closes: the quietest one. */
export const pickReplaced = (viewers: readonly GsViewerRef[], key: string): GsViewerRef | null => viewers.filter((v) => v.key === key).sort((a, b) => a.at - b.at)[0] ?? null;
/** After Allow: the key joins the lock; the lock never holds more than GS_MAX_VIEWERS keys (the oldest one NOT connected goes). */
export function allowKey(lock: readonly string[], key: string, connected: readonly string[], max = GS_MAX_VIEWERS): string[] {
  const out = lock.filter((k) => k !== key);
  out.push(key);
  while (out.length > max) {
    const i = out.findIndex((k) => k !== key && !connected.includes(k));
    out.splice(i >= 0 ? i : 0, 1);
  }
  return out;
}
/** The label the card shows for a viewer (no names are known): "OBS" or "A web browser", plus the last 4 of its key. */
export const viewerLabel = (obs: boolean, key: string) => `${obs ? 'OBS' : 'A web browser'} …${key.slice(-4)}`;

// ---------------------------------------------------------------- relay / privacy
/** The ICE servers hold a TURN relay (turn: / turns:). */
export function iceHasTurn(ice: unknown): boolean {
  if (!Array.isArray(ice)) return false;
  return ice.some((s) => s && typeof s === 'object' && [(s as { urls?: unknown }).urls].flat().some((u) => typeof u === 'string' && /^turns?:/i.test(u)));
}
/** Both ends: 'relay' (iceTransportPolicy) whenever TURN is available, else 'all' and the card says so in plain words. */
export const icePolicy = (ice: unknown): 'relay' | 'all' => (iceHasTurn(ice) ? 'relay' : 'all');
export const privacyOf = (ice: unknown): GsPrivacy => (iceHasTurn(ice) ? 'relay' : 'direct');
/** The WebSocket address a sender (role=studio) or a viewer (role=phone, peer = key+instance) opens. */
export const gsSocketUrl = (relay: string, id: string, role: 'sender' | 'viewer', peer = ''): string => `${relay.replace(/^http/, 'ws')}/phone/${id}/ws?role=${role === 'sender' ? 'studio' : 'phone'}${role === 'viewer' && peer ? `&peer=${peer}` : ''}`;

// ---------------------------------------------------------------- alpha pack (viewer side + tests)
/** What the sender writes for a pixel of its (premultiplied) page canvas: colour can never exceed alpha. Encoded (gamma) values:
 *  a browser composites a canvas in encoded space, so the whole chain stays in encoded space (spout.ts does the TV in linear). */
export const packEncoded = (r: number, g: number, b: number, a: number): [number, number, number, number] => [premulClamp(r, a), premulClamp(g, a), premulClamp(b, a), a];
/** The viewer's low-alpha cutoff (AC14): after the 6..249 remap, an alpha below GS_ALPHA_CUT_LO is exactly 0 and one above GS_ALPHA_CUT_HI is
 *  untouched; in between it fades in smoothly (smoothstep), colour with it. Codec ringing next to the silhouette leaves a few stray
 *  pixels of alpha 2..8/255 in the transparent area (measured at 3 Mbit/s, 720p: about 40 of 668000 pixels, all but one at 8/255 or less); this removes them.
 *  Real soft edges are far above it (hair tips and anti-aliased rims are 20/255 and up), so the edge difference stays where it was (3.4 to 3.6
 *  of the 6/255 allowed, with and without the cutoff, over six snapshots). A fixed 8..16 of 255 band, not a setting. */
export const GS_ALPHA_CUT_LO = 8 / 255;
export const GS_ALPHA_CUT_HI = 16 / 255;
/** The multiplier the cutoff applies to a remapped alpha `a` (0..1): 0 below LO, 1 above HI (GLSL smoothstep). */
export function alphaCutMask(a: number, lo = GS_ALPHA_CUT_LO, hi = GS_ALPHA_CUT_HI): number {
  const t = Math.min(1, Math.max(0, (a - lo) / (hi - lo)));
  return t * t * (3 - 2 * t);
}
/** The viewer's pixel from packed colour (premultiplied by the RAW alpha) + the raw grey alpha: alpha remapped 6..249 → 0..1, then the
 *  low-alpha cutoff above; colour rescaled by the same factor and clamped ≤ alpha. The result goes to a premultipliedAlpha canvas as it is. */
export function unpackEncoded(rgb: readonly [number, number, number], aRaw: number): { c: [number, number, number]; a: number } {
  const a0 = alphaRemap(aRaw), a = a0 * alphaCutMask(a0), k = aRaw > 1e-4 ? a / aRaw : 0;
  return { c: [premulClamp(rgb[0] * k, a), premulClamp(rgb[1] * k, a), premulClamp(rgb[2] * k, a)], a };
}
/** The picture size inside a received packed frame, or null when it is not one of ours (width must be 2 * colour + gutter). */
export function pictureOfFrame(videoW: number, videoH: number): { w: number; h: number; alphaX: number } | null {
  if (!Number.isFinite(videoW) || !Number.isFinite(videoH) || videoH < 2 || videoW < 2 * 2 + PACK_GUTTER) return null;
  const cw = (videoW - PACK_GUTTER) / 2;
  return Number.isInteger(cw) && cw >= 2 ? { w: cw, h: videoH, alphaX: cw + PACK_GUTTER } : null;
}

// ---------------------------------------------------------------- the lip-sync delay queue
/** Frames the viewer keeps for a delay of `delayMs` at `fps` (+2 spare), within a memory budget. */
export function queueFrames(delayMs: number, fps: number, bytesPerFrame: number, budget = GS_QUEUE_BYTES): number {
  const want = Math.ceil((clampDelay(delayMs) / 1000) * Math.max(1, fps)) + 2;
  return Math.max(2, Math.min(want, Math.floor(budget / Math.max(1, bytesPerFrame))));
}
/** Frames waiting to be shown `delay` ms after they arrived. `pick` returns the frame to show now and the frames to free. */
export class GsDelayQueue<T> {
  private q: { t: number; v: T }[] = [];
  constructor(public cap: number) {}
  get size() { return this.q.length; }
  /** Add a frame; returns frames dropped because the queue is over capacity (free them). */
  push(t: number, v: T): T[] {
    this.q.push({ t, v });
    const out: T[] = [];
    while (this.q.length > Math.max(1, this.cap)) out.push(this.q.shift()!.v);
    return out;
  }
  /** The newest frame that is at least `delayMs` old at `now` (null = none yet: keep showing the last one), and the older frames to free. */
  pick(now: number, delayMs: number): { show: T | null; free: T[] } {
    let last = -1;
    for (let i = 0; i < this.q.length; i++) if (now - this.q[i].t >= delayMs) last = i; else break;
    if (last < 0) return { show: null, free: [] };
    const gone = this.q.splice(0, last + 1);
    // (the shown frame stays out of the queue: the caller owns it until the next pick returns it in `free`)
    return { show: gone[gone.length - 1].v, free: gone.slice(0, -1).map((x) => x.v) };
  }
  clear(): T[] { const out = this.q.map((x) => x.v); this.q = []; return out; }
}

// ---------------------------------------------------------------- the performance governor
export interface GsHealth { at: number; stall?: boolean; inflightMs?: number; gpuSyncMs?: number; tracking?: boolean; starve?: number }
export interface GsGovInput { now: number; health: GsHealth | null; renderMs: number; viewerSlow?: boolean }
export type GsWhy = '' | 'stall' | 'gpu' | 'inflight' | 'starve' | 'render' | 'viewer' | 'clean';
/**
 * Never fight the tracker. Reads the studio's health beacon (TrackingHealth) and our own render time; steps the tier
 * full → light (540p30) → low (540p15) → hold (360p5). Stall mode drops straight to 'low'. Down needs GS_GOV.enterMs of bad
 * readings, up needs a long clean stretch (doubling after a relapse). No evidence (a stale beacon) never steps anything down.
 */
export class GsGovernor {
  idx = 0;
  holdMs: number = GS_GOV.upHoldMs;
  private badSince = -1; private cleanSince = -1; private stallSince = -1; private lastUp = -1e12; private lastDown = -1e12;
  constructor(public q: GsQuality) {}
  get tier(): GsTier { return gsTier(this.q, GS_LADDER[this.idx]); }
  reset() { this.idx = 0; this.holdMs = GS_GOV.upHoldMs; this.badSince = this.cleanSince = this.stallSince = -1; }
  step(i: GsGovInput): { tier: GsTier; changed: boolean; why: GsWhy } {
    const g = GS_GOV, h = i.health && i.now - i.health.at <= g.healthStaleMs ? i.health : null;
    const budget = 1000 / this.tier.fps;
    let why: GsWhy = '';
    if (h?.stall) why = 'stall';
    else if (h && (h.gpuSyncMs ?? -1) > g.gpuSyncMs) why = 'gpu';
    else if (h && (h.inflightMs ?? 0) > g.inflightMs) why = 'inflight';
    else if (h && h.tracking && (h.starve ?? 0) > g.starve) why = 'starve';
    else if (i.renderMs > budget * g.renderBudgetX) why = 'render';
    else if (i.viewerSlow) why = 'viewer';
    const clean = !why && i.renderMs <= budget && (!h || ((h.gpuSyncMs ?? -1) <= g.gpuSyncCleanMs && (h.inflightMs ?? 0) <= g.inflightCleanMs));
    const before = this.idx;
    if (why === 'stall') {
      this.cleanSince = -1;
      if (this.stallSince < 0) this.stallSince = i.now;
      if (this.idx < 2) this.down(i.now, 2);
      else if (this.idx === 2 && i.now - this.stallSince >= g.holdAfterMs) this.down(i.now, 3);
    } else {
      this.stallSince = -1;
      if (why) {
        this.cleanSince = -1;
        if (this.badSince < 0) this.badSince = i.now;
        if (i.now - this.badSince >= g.enterMs && this.idx < 3) { this.down(i.now, this.idx + 1); this.badSince = i.now; }
      } else {
        this.badSince = -1;
        if (clean) {
          if (this.cleanSince < 0) this.cleanSince = i.now;
          if (this.idx > 0 && i.now - this.cleanSince >= this.holdMs) { this.idx--; this.lastUp = i.now; this.cleanSince = i.now; }
          else if (this.idx === 0 && i.now - this.cleanSince >= g.relapseMs) this.holdMs = g.upHoldMs;
        } else this.cleanSince = -1;
      }
    }
    return { tier: this.tier, changed: this.idx !== before, why: this.idx !== before ? (this.idx > before ? why : 'clean') : '' };
  }
  private down(now: number, to: number) {
    if (now - this.lastUp < GS_GOV.relapseMs) this.holdMs = Math.min(this.holdMs * 2, GS_GOV.upMaxHoldMs);
    this.idx = Math.max(this.idx, to);
    this.lastDown = now;
    this.cleanSince = -1;
  }
}

// ---------------------------------------------------------------- helper API shapes (GET/PUT/POST/DELETE /api/guestfeed)
export interface GsViewerInfo { id: string; label: string; since: number; fps: number; kbps: number; codec: string; route: GsRoute; rttMs: number | null; visible: boolean }
/** GET /api/guestfeed (this PC only). `url` is null while off (the link does not exist then). */
export interface GsView {
  v: 1;
  enabled: boolean;
  state: GsCardState;
  says: string;
  url: string | null;
  name: string; q: GsQuality; delayMs: number; autoOffMin: number;
  privacy: GsPrivacy; privacySays: string;
  tier: GsTierName;
  /** always 'own' (the streamer's own invite server) when a link is on; 'official' is no longer produced (kept for old saved state) */
  relayKind: 'own' | 'official' | null;
  viewers: GsViewerInfo[];
  knock: { kid: string; label: string; at: number } | null;
  browser: boolean;
  /** epoch ms when the auto-off timer will fire (null = never / a viewer is connected) */
  offAt: number | null;
}
export interface GsSettings { enabled?: boolean; name?: string; q?: GsQuality; delayMs?: number; autoOffMin?: number }
/** PUT body → only the fields that are valid (anything else is dropped; never throws). */
export function sanitizeSettings(raw: unknown): GsSettings {
  const o = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
  const out: GsSettings = {};
  if (typeof o.enabled === 'boolean') out.enabled = o.enabled;
  if (typeof o.name === 'string') out.name = sanitizeName(o.name);
  if (o.q === 720 || o.q === 1080) out.q = o.q;
  if (o.delayMs !== undefined && o.delayMs !== null && o.delayMs !== '') out.delayMs = clampDelay(o.delayMs);
  if (typeof o.autoOffMin === 'number' && GS_AUTO_OFF_MIN.includes(o.autoOffMin)) out.autoOffMin = o.autoOffMin;
  return out;
}
/** What the sender page tells the helper once a second (POST /api/guestfeed/report). */
export interface GsReport {
  gen: number;
  state: 'boot' | 'signalling' | 'idle' | 'live' | 'paused' | 'error';
  err: '' | 'server' | 'busy' | 'gl';
  tier: GsTierName;
  privacy: GsPrivacy;
  lock: string[];
  knock: { kid: string; label: string } | null;
  viewers: GsViewerInfo[];
  renderMs: number; packMs: number;
}
const STATES = ['boot', 'signalling', 'idle', 'live', 'paused', 'error'] as const;
export function sanitizeReport(raw: unknown): GsReport | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (!STATES.includes(o.state as never)) return null;
  const viewers: GsViewerInfo[] = [];
  for (const v of (Array.isArray(o.viewers) ? o.viewers : []).slice(0, GS_MAX_VIEWERS)) {
    if (!v || typeof v !== 'object') continue;
    const x = v as Record<string, unknown>;
    viewers.push({ id: clean(x.id, 24), label: clean(x.label, 40), since: Math.round(num(x.since, 0, 4e12)), fps: Math.round(num(x.fps, 0, 240)), kbps: Math.round(num(x.kbps, 0, 200_000)), codec: clean(x.codec, 40), route: routeOf(x.route), rttMs: typeof x.rttMs === 'number' && Number.isFinite(x.rttMs) ? Math.round(num(x.rttMs, 0, 60_000)) : null, visible: x.visible === true });
  }
  const k = o.knock && typeof o.knock === 'object' ? o.knock as Record<string, unknown> : null;
  return {
    gen: Math.round(num(o.gen, 0, 1e9)), state: o.state as GsReport['state'], err: o.err === 'server' || o.err === 'busy' || o.err === 'gl' ? o.err : '',
    tier: GS_LADDER.includes(o.tier as GsTierName) ? o.tier as GsTierName : 'full', privacy: o.privacy === 'relay' || o.privacy === 'direct' ? o.privacy : 'unknown',
    lock: (Array.isArray(o.lock) ? o.lock : []).filter((x): x is string => typeof x === 'string' && GS_KEY_RX.test(x)).slice(0, GS_MAX_VIEWERS),
    knock: k && /^[a-z0-9]{6}$/.test(String(k.kid)) ? { kid: String(k.kid), label: clean(k.label, 40) } : null,
    viewers, renderMs: num(o.renderMs, 0, 10_000), packMs: num(o.packMs, 0, 10_000),
  };
}
/** POST /api/guestfeed/knock body. */
export function sanitizeKnockReply(raw: unknown): { kid: string; allow: boolean } | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  return typeof o.kid === 'string' && /^[a-z0-9]{6}$/.test(o.kid) && typeof o.allow === 'boolean' ? { kid: o.kid, allow: o.allow } : null;
}
/** Helper → sender page, on the local bus ({type:'gs', ...}); carries NO secret (no link id, relay, key or credentials).
 *  The bus relays every client's messages to every other client, so a control message is only obeyed with `sig`: HMAC-SHA256
 *  (hex) of gsBusCanon(m), keyed by the sender page's own per-run token (gst). The token itself never goes on the bus. */
export type GsBusMsg = ({ type: 'gs'; k: 'cfg'; gen: number } | { type: 'gs'; k: 'decide'; kid: string; allow: boolean } | { type: 'gs'; k: 'off'; gen: number }) & { sig?: string };
export function sanitizeBusMsg(raw: unknown): GsBusMsg | null {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  if (o.type !== 'gs') return null;
  const gen = Math.round(num(o.gen, 0, 1e9));
  const sig = typeof o.sig === 'string' && /^[a-f0-9]{64}$/.test(o.sig) ? { sig: o.sig } : {};
  if (o.k === 'cfg' || o.k === 'off') return { type: 'gs', k: o.k, gen, ...sig };
  if (o.k === 'decide' && typeof o.kid === 'string' && /^[a-z0-9]{6}$/.test(o.kid) && typeof o.allow === 'boolean') return { type: 'gs', k: 'decide', kid: o.kid, allow: o.allow, ...sig };
  return null;
}
/** What the signature covers (the message without `sig`). */
export function gsBusCanon(m: GsBusMsg): string {
  return m.k === 'decide' ? `gs.decide.${m.kid}.${m.allow ? 1 : 0}` : `gs.${m.k}.${m.gen}`;
}
/** HMAC-SHA256 (hex) with WebCrypto: the browser's check, and the tests' signer. (The helper signs with node:crypto, same bytes.) */
export async function gsBusSign(token: string, m: GsBusMsg): Promise<string> {
  const enc = new TextEncoder(), subtle = globalThis.crypto.subtle;
  const key = await subtle.importKey('raw', enc.encode(token), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return [...new Uint8Array(await subtle.sign('HMAC', key, enc.encode(gsBusCanon(m))))].map((b) => b.toString(16).padStart(2, '0')).join('');
}
/** Does `m` carry a signature made with `token`? (false without a token or without a signature) */
export async function gsBusVerify(token: string, m: GsBusMsg): Promise<boolean> {
  if (!/^[a-f0-9]{32}$/.test(token) || !m.sig) return false;
  try { return (await gsBusSign(token, m)) === m.sig; } catch { return false; }
}
/** GET /api/guestfeed/sender (sender page only, header x-vtp-gs: token): what the page needs to open the link. */
export interface GsSenderConfig { gen: number; relay: string; id: string; q: GsQuality; delayMs: number; name: string; lock: string[]; /** the link's signing key pair (GS_PUB_RX / GS_PRIV_RX); sender page only */ pk?: string; sk?: string }
