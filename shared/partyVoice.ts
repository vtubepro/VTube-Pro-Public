// Party voice ('vox1'): in-app voice for VTube Pro APP guests (the party), without Discord. The rules + wire format;
// the studio side is src/net/voice/partyVoice.ts (links) + voiceMixer.ts (the host's mix-minus).
//
//   app guest ──'vox' PeerConnection (ONE audio transceiver, sendrecv)──► host
//      up:   the guest's echo-cancelled mic
//      down: the host's mix for THAT guest = the host's talk-back mic + every other on-air voice, never their own
//
// Like the TV links (src/net/tv/tvLink.ts) it is a separate media PeerConnection signalled over the party's 'ctl'
// channel ({t:'vsig'}), only between peers that both announced VOX_CAP — the party link itself is never renegotiated
// (it may be an invite-code link with no other signalling path). The guest always offers (one offerer: no glare).
// Turning voice on later = a fresh offer; off = 'bye' + close; a new mic / mute = replaceTrack / enabled (no SDP).
//
// Pure: no DOM, no WebRTC (tools/partyvoice_unit.ts tests all of it).

export const VOX_CAP = 'vox1';

// ---------------------------------------------------------------- wire ('ctl' {t:'vsig'})
/** How a guest talks: 'app' = over this link, 'discord' = in the Discord call (so no in-app audio), 'off' = not at all. */
export type VoxMode = 'app' | 'discord' | 'off';
export type VoxSig =
  | { t: 'vsig'; k: 'offer' | 'answer'; sdp: string }
  | { t: 'vsig'; k: 'ice'; cand: unknown }
  | { t: 'vsig'; k: 'bye' }
  /** guest → host: what I use and whether my mic is muted / missing (the host's People tile). */
  | { t: 'vsig'; k: 'state'; mode: VoxMode; muted: boolean; mic: boolean };

const isMode = (v: unknown): v is VoxMode => v === 'app' || v === 'discord' || v === 'off';
export function sanitizeVoxSig(m: unknown): VoxSig | null {
  if (!m || typeof m !== 'object') return null;
  const o = m as Record<string, unknown>;
  if (o.t !== 'vsig') return null;
  switch (o.k) {
    case 'offer': case 'answer':
      if (typeof o.sdp !== 'string' || !o.sdp || o.sdp.length > 30_000) return null;
      return { t: 'vsig', k: o.k, sdp: o.sdp };
    case 'ice': {
      if (o.cand === null || o.cand === undefined) return { t: 'vsig', k: 'ice', cand: null };
      if (typeof o.cand !== 'object') return null;
      const c = o.cand as Record<string, unknown>;
      if (typeof c.candidate !== 'string' || c.candidate.length > 1000) return null;
      return { t: 'vsig', k: 'ice', cand: { candidate: c.candidate, sdpMid: typeof c.sdpMid === 'string' ? c.sdpMid.slice(0, 16) : null, sdpMLineIndex: typeof c.sdpMLineIndex === 'number' ? c.sdpMLineIndex : null } };
    }
    case 'bye': return { t: 'vsig', k: 'bye' };
    case 'state': return { t: 'vsig', k: 'state', mode: isMode(o.mode) ? o.mode : 'off', muted: o.muted === true, mic: o.mic === true };
    default: return null;
  }
}

// ---------------------------------------------------------------- the mix-minus routing plan (host)
/** The host's own voices as mix sources: the talk-back mic (on air) and the backstage voice (one waiting guest ↔ me). */
export const HOST_MAIN = '@host';
export const HOST_BACK = '@back';
export type VoxGate = 'air' | 'back' | 'off';
export interface MixPerson {
  id: string;
  /** 'app' = a VTube Pro app guest on a vox link, 'link' = a browser link guest (TV link voice). */
  kind: 'app' | 'link';
  /** Green room: 'air' (on the show), 'back' (waiting, backstage talk with the host), 'off' (waiting: no voice). */
  gate: VoxGate;
  /** A live voice arrives from them. */
  sends: boolean;
  /** They can receive a return mix (their link has a return path). */
  listens: boolean;
  /** Muted — by the host (volume 0 in People) or by themselves: out of every mix (they'd send silence anyway). */
  muted: boolean;
}
export interface MixInput {
  /** The host's talk-back mic is on (guests hear the host). */
  talkback: boolean;
  /** A backstage voice exists (the talk-back mic, or its own backstage capture). */
  back: boolean;
  people: MixPerson[];
}
/** listener id → the sources they hear (sorted: HOST_* first, then guest ids). Never their own voice; a waiting guest
 *  hears nothing of the show (only the host, while "Talk backstage" is on) and is in nobody's mix. */
export type MixPlan = Record<string, string[]>;

export function mixPlan(inp: MixInput): MixPlan {
  const out: MixPlan = {};
  const onAir = inp.people.filter((p) => p.gate === 'air' && p.sends && !p.muted).map((p) => p.id);
  for (const L of inp.people) {
    if (!L.listens) continue;
    if (L.gate === 'off') { out[L.id] = []; continue; }
    if (L.gate === 'back') { out[L.id] = inp.back ? [HOST_BACK] : []; continue; }
    const src = onAir.filter((id) => id !== L.id).sort();
    out[L.id] = inp.talkback ? [HOST_MAIN, ...src] : src;
  }
  return out;
}

/** How a listener's plan is delivered: nothing, the host's mic track as is (no mixing needed: a 1-to-1 call adds no
 *  WebAudio latency and keeps the old link-guest path byte for byte), or a WebAudio mix. */
export type Delivery = { k: 'none' } | { k: 'direct'; src: typeof HOST_MAIN | typeof HOST_BACK } | { k: 'mix'; srcs: string[] };
export function deliveryOf(srcs: string[] | undefined): Delivery {
  if (!srcs || !srcs.length) return { k: 'none' };
  if (srcs.length === 1 && (srcs[0] === HOST_MAIN || srcs[0] === HOST_BACK)) return { k: 'direct', src: srcs[0] };
  return { k: 'mix', srcs: [...srcs] };
}
/** Check a plan against the rules (tests + a debug assert): nobody hears themselves, waiting voices reach nobody. */
export function planProblems(inp: MixInput, plan: MixPlan): string[] {
  const bad: string[] = [];
  const by = new Map(inp.people.map((p) => [p.id, p]));
  for (const [L, srcs] of Object.entries(plan)) {
    if (srcs.includes(L)) bad.push(`${L} hears themselves`);
    for (const s of srcs) {
      if (s === HOST_MAIN || s === HOST_BACK) continue;
      const p = by.get(s);
      if (!p) bad.push(`${L} hears unknown ${s}`);
      else if (p.gate !== 'air') bad.push(`${L} hears waiting ${s}`);
      else if (p.muted) bad.push(`${L} hears muted ${s}`);
    }
    const me = by.get(L);
    if (me && me.gate !== 'air' && srcs.some((s) => s !== HOST_BACK)) bad.push(`waiting ${L} hears the show`);
  }
  return bad;
}

// ---------------------------------------------------------------- capability / fallback (what each side shows)
/** Guest side: why in-app voice is (not) running. */
export type VoxGuestState = 'on' | 'old-host' | 'off' | 'discord' | 'none';
export function guestVoxState(o: { role: string; hostCaps: readonly string[] | null; mode: VoxMode }): VoxGuestState {
  if (o.role !== 'guest') return 'none';
  if (o.mode === 'discord') return 'discord';
  if (o.mode === 'off') return 'off';
  // (no welcome yet = we don't know: a very old host never sends one — after it, an empty list = old)
  if (!o.hostCaps || !o.hostCaps.includes(VOX_CAP)) return 'old-host';
  return 'on';
}
/** Host side, per member: 'vox' = an app guest talking over the link, 'discord' / 'off' = their choice, 'old' = their
 *  app can't (too old), 'link' = a browser link guest (their own voice path), 'none' = me / not a guest. */
export type VoxMemberState = 'vox' | 'wait' | 'discord' | 'off' | 'old' | 'link' | 'none';
export function memberVoxState(o: { me: boolean; lite: boolean; linkVoice: boolean; caps: readonly string[]; mode: VoxMode | null; voice: boolean }): VoxMemberState {
  if (o.me) return 'none';
  if (o.lite || o.linkVoice) return 'link';
  if (!o.caps.includes(VOX_CAP)) return 'old';
  if (o.mode === 'discord') return 'discord';
  if (o.mode === 'off') return 'off';
  return o.voice ? 'vox' : 'wait';
}
export const VOX_OLD_GUEST = 'This guest’s app is too old for in-app voice — use Discord';
export const VOX_OLD_HOST = 'The host’s app is too old for in-app voice — use Discord';

// ---------------------------------------------------------------- numbers (docs + the report)
/** Opus at ~32 kbit/s per direction per guest (speech, DTX on): a host with 6 app guests sends/receives ≈ 6 × 32. */
export const VOX_KBPS = 32;
