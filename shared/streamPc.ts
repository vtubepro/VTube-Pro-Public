// Stream PC mode (two-PC streaming): the pure policy. A streamer's STREAM PC (OBS) reaches the helper on their GAMING PC
// over the home network; only what an OBS output page needs, only from a paired stream PC, only from the same subnet.
// Pure (no node:, no DOM): the helper side is server/streamPc.ts, unit tests tools/streampc_unit.ts, the design note
// docs/TWO_PC_STREAMING.md ("How it stays safe").
//
//   * ipv4 / private / same-subnet checks for the remote address;
//   * the Host (DNS-rebinding) and Origin rules;
//   * the ALLOW-LIST of method + path a stream PC may use (every form Express may route a path as must be allowed);
//   * which bus messages a stream PC page may send, and the mDNS -> real IP rewrite of its WebRTC candidates;
//   * the Windows firewall rule "VTube Pro (stream PC)" (Private profile, local subnet, one TCP port, the helper program).

// ---------------------------------------------------------------- addresses

const V4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;
/** a.b.c.d -> 32-bit number, else null. */
export function v4num(a: string): number | null {
  const m = V4.exec(a);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  if (p.some((x) => x > 255) || m.slice(1).some((x) => x.length > 1 && x.startsWith('0'))) return null;
  return ((p[0] << 24) | (p[1] << 16) | (p[2] << 8) | p[3]) >>> 0;
}
/** Socket address as Node reports it ("::ffff:192.168.1.5", "192.168.1.5", "::1") -> plain form (v4-mapped unwrapped). */
export function normIp(a: string | undefined | null): string {
  const s = String(a ?? '').trim().toLowerCase();
  const m = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  return m ? m[1] : s;
}
export function isLoopbackIp(a: string | undefined | null): boolean {
  const s = normIp(a);
  if (s === '::1' || s === '0:0:0:0:0:0:0:1') return true;
  const n = v4num(s);
  return n !== null && n >>> 24 === 127;
}
/** RFC 1918 home / office ranges + IPv4 link-local (two PCs on a cable with no router). */
export function isPrivateV4(a: string): boolean {
  const n = v4num(normIp(a));
  if (n === null) return false;
  const b0 = n >>> 24, b1 = (n >>> 16) & 255;
  return b0 === 10 || (b0 === 192 && b1 === 168) || (b0 === 172 && b1 >= 16 && b1 <= 31) || (b0 === 169 && b1 === 254);
}
/** Are a and b on the same subnet (netmask of the adapter we listen on)? */
export function sameSubnet(a: string, b: string, netmask: string | null | undefined): boolean {
  const x = v4num(normIp(a)), y = v4num(normIp(b)), m = netmask ? v4num(netmask) : null;
  if (x === null || y === null || m === null || m === 0) return false;
  return (x & m) >>> 0 === (y & m) >>> 0;
}

// ---------------------------------------------------------------- Host + Origin

/** "name:port" / "[v6]:port" -> { name (lower case), port | null }. */
export function splitHost(host: string): { name: string; port: number | null } {
  const h = host.trim().toLowerCase();
  if (h.startsWith('[')) {
    const end = h.indexOf(']');
    const rest = end > 0 ? h.slice(end + 1) : '';
    return { name: end > 0 ? h.slice(0, end + 1) : h, port: /^:\d{1,5}$/.test(rest) ? Number(rest.slice(1)) : null };
  }
  const i = h.lastIndexOf(':');
  if (i >= 0 && /^\d{1,5}$/.test(h.slice(i + 1))) return { name: h.slice(0, i), port: Number(h.slice(i + 1)) };
  return { name: h, port: null };
}
export interface ServeCtx {
  /** The private IPv4 the LAN listener is bound to. */
  address: string;
  netmask: string | null;
  port: number;
  /** This PC's own names the stream PC may type instead of the IP (lower case, no port): hostname, hostname.local … */
  names: string[];
}
/** The names a stream PC may use for this PC: its computer name (+ .local / .lan / .home, what home routers add). */
export function pcNames(hostname: string): string[] {
  const h = String(hostname ?? '').trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(h)) return [];
  return [h, `${h}.local`, `${h}.lan`, `${h}.home`];
}
/** DNS-rebinding defence: the Host a browser sends must name THIS PC (its LAN IP or its own name) on OUR port. */
export function lanHostOk(host: string | undefined, ctx: ServeCtx): boolean {
  if (typeof host !== 'string' || !host) return false;
  const { name, port } = splitHost(host);
  if ((port ?? 80) !== ctx.port) return false;
  return name === ctx.address || ctx.names.includes(name);
}
/** A browser Origin on a LAN request must be exactly the page's own origin (http://<Host>). */
export function lanOriginOk(origin: string | undefined, host: string | undefined): boolean {
  if (origin === undefined) return true;
  if (!host || origin === 'null') return false;
  return origin.toLowerCase().replace(/\/$/, '') === `http://${host.toLowerCase()}`;
}

// ---------------------------------------------------------------- the allow-list

export type LanMethod = 'GET' | 'POST';
interface Rule { re: RegExp; methods: readonly LanMethod[]; why: string }
const G: readonly LanMethod[] = ['GET'];
/** What a paired stream PC may call. GET also covers HEAD. Patterns are tested against EVERY form of the path
 *  (server/pathCanon.ts pathForms): all of them must match one rule. Keep this list short and specific. */
export const LAN_RULES: readonly Rule[] = [
  { re: /^\/output\.html$/i, methods: G, why: 'the OBS output page' },
  { re: /^\/streampc\/(obs|view|state)$/i, methods: G, why: 'stream PC entry / receiver / state' },
  { re: /^\/assets\/[a-z0-9._-]+$/i, methods: G, why: 'the app build (hashed files)' },
  { re: /^\/vendor\/basis\/[a-z0-9._-]+$/i, methods: G, why: '2D texture decoder' },
  { re: /^\/favicon\.ico$/i, methods: G, why: 'icon' },
  { re: /^\/library\/[^/]+\/[^?#]+$/i, methods: G, why: 'avatar files (read-only)' },
  { re: /^\/api\/avatars$/i, methods: G, why: 'avatar list' },
  { re: /^\/api\/avatars\/[^/]+$/i, methods: G, why: 'one avatar profile' },
  { re: /^\/api\/avatars\/[^/]+\/(gpu|party-lod)$/i, methods: G, why: 'avatar texture tiers / party version status (read)' },
  { re: /^\/api\/scene$/i, methods: G, why: 'the show state' },
  { re: /^\/api\/scenes$/i, methods: G, why: 'room list' },
  { re: /^\/api\/scenes\/[^/]+\/file\/[^?#]+$/i, methods: G, why: 'room files (read-only)' },
  { re: /^\/api\/rooms\/[^/]+\/edits$/i, methods: G, why: 'the room editor layer (read)' },
  { re: /^\/api\/rooms\/prefs$/i, methods: G, why: 'room prefs (read)' },
  { re: /^\/api\/props$/i, methods: G, why: 'placeable props list' },
  { re: /^\/api\/props\/file\/[^/]+\/[^/]+\/[^?#]+$/i, methods: G, why: 'placeable prop files' },
  { re: /^\/api\/overlays\/[^/]+$/i, methods: G, why: '2.5D overlay around a 2D avatar (read; the list stays local)' },
  { re: /^\/api\/overlays\/[^/]+\/file\/[^?#]+$/i, methods: G, why: '2.5D overlay layer files (read-only, media only)' },
  { re: /^\/api\/output$/i, methods: G, why: 'output size / position' },
  { re: /^\/api\/poll\/state$/i, methods: G, why: 'poll card' },
  { re: /^\/api\/support\/showcase$/i, methods: G, why: 'product card (featured merch, purchases)' },
  { re: /^\/api\/support\/img\/[A-Za-z0-9_-]{8,1200}$/i, methods: G, why: 'product pictures (cached on this PC only)' },
  { re: /^\/api\/goals\/view$/i, methods: G, why: 'goal bars + subathon timer' },
  { re: /^\/api\/chat\/(status|recent|img)$/i, methods: G, why: 'chat props (allow-listed emote CDNs only)' },
  { re: /^\/api\/brb\/background$/i, methods: G, why: 'BRB screen picture' },
  { re: /^\/api\/videos\/(proxy|hls\.js)$/i, methods: G, why: 'room video screens (public internet only)' },
  { re: /^\/api\/videos\/file\/[^/]+$/i, methods: G, why: 'room video files' },
  { re: /^\/api\/party\/vault\/[^/]+$/i, methods: G, why: 'party guests: sealed blobs (RAM, no-store)' },
  { re: /^\/api\/obs\/hole$/i, methods: ['GET', 'POST'], why: 'the React hole report output pages send' },
  { re: /^\/api\/audience\/seats$/i, methods: ['POST'], why: 'the OBS page reports how many audience seats its room has (a number 1-200)' },
  { re: /^\/api\/audience\/view$/i, methods: G, why: 'chat audience view (seated names + on-screen questions; pending ones never)' },
  // beta.16 pictures the OBS page draws: the files only. The lists (/api/throwables, /api/items/library, /api/user-emotes), uploads and deletes stay on this PC;
  // sounds are not here either (the sound plays on this PC, a stream PC page is display-only)
  { re: /^\/api\/throwables\/starter\/[a-z0-9][a-z0-9_-]{0,40}\.svg$/i, methods: G, why: 'Throw & Bonk starter props (read-only pictures)' },
  { re: /^\/api\/throwables\/file\/u-[a-f0-9]{16}$/i, methods: G, why: 'your own throw pictures (read-only)' },
  { re: /^\/api\/items\/file\/(stickers|mine)\/[a-z0-9][a-z0-9_-]{0,40}\.(png|gif|webp|jpg|glb)$/i, methods: G, why: 'stickers and items on the avatar (read-only files)' },
  { re: /^\/api\/user-emotes\/[a-z0-9][a-z0-9-]{0,47}$/i, methods: G, why: 'one recorded emote clip by id (the list stays on this PC)' },
];
/** WebSocket paths a paired stream PC may open (the bus + the read-only feeds). */
export const LAN_WS = new Set(['/ws', '/ws/screen', '/ws/spout']);
/** Paths that work WITHOUT a token (the pairing page and its one call). */
export const LAN_PUBLIC: readonly Rule[] = [
  { re: /^\/streampc$/i, methods: G, why: 'pairing page' },
  { re: /^\/streampc\/pair$/i, methods: ['POST'], why: 'pairing code -> token' },
];

/** Raw request paths a real page never sends and a bypass attempt would: encoded slash / backslash / dot / NUL, a
 *  backslash, a "." or ".." segment, an empty segment. */
export function rawPathSuspicious(raw: string): boolean {
  let p = String(raw ?? '');
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(p)) return true; // absolute-form target: browsers never send it
  p = p.split('?')[0].split('#')[0];
  if (!p.startsWith('/')) return true;
  if (/%(2f|5c|2e|00)/i.test(p) || p.includes('\\') || p.includes('\0')) return true;
  if (/\/\//.test(p)) return true;
  return p.split('/').some((s) => s === '.' || s === '..');
}

/** The forms of a path a rule must hold for (mirrors server/pathCanon.ts pathForms; kept pure here). */
export function lanPathForms(raw: string): string[] {
  const r = String(raw ?? '').split('?')[0].split('#')[0];
  let c = r;
  try { c = decodeURIComponent(c); } catch { /* keep raw */ }
  c = c.replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLowerCase();
  const stack: string[] = [];
  for (const s of c.split('/')) { if (s === '' || s === '.') continue; if (s === '..') stack.pop(); else stack.push(s); }
  c = `/${stack.join('/')}`;
  return [...new Set([r, r.toLowerCase(), c, c === '/' ? c : `${c}/`].map((f) => (f.length > 1 ? f.replace(/\/+$/, '') : f)))];
}
function ruleFor(method: string, rawPath: string, rules: readonly Rule[]): Rule | null {
  const m = method.toUpperCase() === 'HEAD' ? 'GET' : method.toUpperCase();
  const forms = lanPathForms(rawPath);
  for (const r of rules) {
    if (!r.methods.includes(m as LanMethod)) continue;
    if (forms.every((f) => { r.re.lastIndex = 0; return r.re.test(f); })) return r;
  }
  return null;
}
export const lanAllowed = (method: string, rawPath: string) => !rawPathSuspicious(rawPath) && !!ruleFor(method, rawPath, LAN_RULES);
export const lanPublic = (method: string, rawPath: string) => !rawPathSuspicious(rawPath) && !!ruleFor(method, rawPath, LAN_PUBLIC);
export function lanWsAllowed(rawPath: string): boolean {
  if (rawPathSuspicious(rawPath)) return false;
  const p = String(rawPath).split('?')[0];
  return LAN_WS.has(p); // exact (a WebSocket path is matched exactly by the upgrade router)
}

// ---------------------------------------------------------------- the verdict for one LAN request

export type LanVerdict =
  | { ok: true; public: boolean }
  | { ok: false; status: 401 | 403 | 421; code: 'subnet' | 'host' | 'origin' | 'pair' | 'local-only' | 'off'; reason: string };
export interface LanReq {
  method: string;
  /** Raw path + query as received (req.url). */
  url: string;
  remote: string;
  host?: string;
  origin?: string;
  secFetchSite?: string;
  upgrade?: boolean;
  /** A valid stream PC token came with the request (checked by the caller: hash + constant-time compare). */
  paired: boolean;
}
/** The whole LAN policy (order matters: who you are, where you are, then what you may do). */
export function lanVerdict(r: LanReq, ctx: ServeCtx | null): LanVerdict {
  if (!ctx) return { ok: false, status: 403, code: 'off', reason: 'Stream PC mode is off on this PC' };
  const ip = normIp(r.remote);
  if (!isPrivateV4(ip) || !sameSubnet(ip, ctx.address, ctx.netmask)) return { ok: false, status: 403, code: 'subnet', reason: 'Only a PC on the same home network may connect' };
  if (!lanHostOk(r.host, ctx)) return { ok: false, status: 421, code: 'host', reason: `Open this PC by its address (http://${ctx.address}:${ctx.port}/streampc)` };
  if (!lanOriginOk(r.origin, r.host)) return { ok: false, status: 403, code: 'origin', reason: 'Another website may not use this PC' };
  if (r.secFetchSite === 'cross-site' || r.secFetchSite === 'same-site') return { ok: false, status: 403, code: 'origin', reason: 'Another website may not use this PC' };
  const path = r.url.split('?')[0];
  if (r.upgrade) {
    if (!lanWsAllowed(path)) return { ok: false, status: 403, code: 'local-only', reason: 'Not for a stream PC' };
    return r.paired ? { ok: true, public: false } : { ok: false, status: 401, code: 'pair', reason: 'Connect this stream PC first' };
  }
  if (lanPublic(r.method, path)) return { ok: true, public: true };
  if (!lanAllowed(r.method, path)) return { ok: false, status: 403, code: 'local-only', reason: 'This part of VTube Pro only works on the gaming PC itself' };
  return r.paired ? { ok: true, public: false } : { ok: false, status: 401, code: 'pair', reason: 'Connect this stream PC first' };
}

// ---------------------------------------------------------------- credentials

export const SP_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export const spCookieName = (port: number) => `vtp_sp${port}`;
/** Token candidates of a request, in this order: the cookie, Authorization: Bearer, ?vtp_sp= (GET / HEAD / upgrade). */
export function spTokens(method: string, url: string, headers: { authorization?: string; cookie?: string }, port: number, upgrade = false): string[] {
  const out: string[] = [];
  const m = method.toUpperCase();
  // the cookie first: after the first visit a page proves itself with it, not with a token in a URL
  const name = spCookieName(port);
  for (const part of String(headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) out.push(part.slice(i + 1).trim());
  }
  const a = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization ?? '').trim());
  if (a) out.push(a[1]);
  const q = url.indexOf('?');
  if (q >= 0 && (upgrade || m === 'GET' || m === 'HEAD')) { const t = new URLSearchParams(url.slice(q + 1)).get('vtp_sp'); if (t) out.push(t); }
  return [...new Set(out.filter((t) => SP_TOKEN_RE.test(t)))];
}
/** req.url without vtp_sp (no handler ever sees, logs or echoes the token). */
export function stripSpToken(url: string): string {
  const q = url.indexOf('?');
  if (q < 0) return url;
  const sp = new URLSearchParams(url.slice(q + 1));
  if (!sp.has('vtp_sp')) return url;
  sp.delete('vtp_sp');
  const rest = sp.toString();
  return url.slice(0, q) + (rest ? `?${rest}` : '');
}
export const SP_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const normSpCode = (c: unknown) => (typeof c === 'string' ? c.toUpperCase().replace(/[\s-]/g, '').slice(0, 16) : '');
/** "ABCDEF" -> "ABC-DEF" (how the studio shows it). */
export const showSpCode = (c: string) => (c.length === 6 ? `${c.slice(0, 3)}-${c.slice(3)}` : c);

// ---------------------------------------------------------------- the bus: what a stream PC page may send

/** Bus message kinds a stream PC page may send: DISPLAY-ONLY traffic (it says it is there and what it shows, and the
 *  receive side of a WebRTC link). Everything else from a LAN socket is dropped: no tracking, scene, commands, sound grant,
 *  and no show sounds (showsound) or live-video clock (liveclock) either: those change what the studio plays (security
 *  review 2026-10-08). The output pages on THIS PC still send their own showsound / liveclock. */
const BUS_TYPES: Record<string, ((m: Record<string, unknown>) => boolean)> = {
  hello: (m) => m.role === 'output',
  gfxlower: () => true,
  curtain: () => true,
  screen: (m) => ['hello', 'answer', 'ice', 'stats', 'bye'].includes(String(m.k)),
  tvfeed: (m) => ['hello', 'answer', 'ice', 'stats', 'bye'].includes(String(m.k)),
  spv: (m) => ['want', 'answer', 'ice', 'stats', 'bye'].includes(String(m.k)),
  // a stream PC's OBS page saying it switched to a lighter look / how it runs (display-only diagnostics, beta.13.5)
  obsstarve: (m) => [0, 1, 2].includes(m.level as number) && typeof m.acted === 'boolean' && (m.why === undefined || (typeof m.why === 'string' && m.why.length <= 200))
    && (m.fps === undefined || (typeof m.fps === 'number' && Number.isFinite(m.fps))),
  obsperf: (m) => {
    const p = m.p as Record<string, unknown> | null;
    return !!p && typeof p === 'object' && !Array.isArray(p) && typeof p.page === 'string' && p.page.length <= 80 && Number.isFinite(p.at as number)
      && Number.isFinite(p.fps as number) && [0, 1, 2].includes(p.starved as number) && typeof p.level === 'string' && p.level.length <= 24;
  },
};
export const LAN_BUS_MAX = 64 * 1024;
/** Parse + check one message a LAN socket sent. null = drop it. */
export function lanBusMessage(text: string): Record<string, unknown> | null {
  if (typeof text !== 'string' || text.length > LAN_BUS_MAX || text[0] !== '{') return null;
  let m: unknown;
  try { m = JSON.parse(text); } catch { return null; }
  if (!m || typeof m !== 'object' || Array.isArray(m)) return null;
  const o = m as Record<string, unknown>;
  const ok = typeof o.type === 'string' && Object.prototype.hasOwnProperty.call(BUS_TYPES, o.type) ? BUS_TYPES[o.type](o) : false;
  return ok ? o : null;
}
const MDNS = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.local\b/gi;
/** WebRTC from an insecure page (OBS on the stream PC) hides its address behind an mDNS name, which many home networks
 *  can't resolve: put the address the helper SAW (the socket's own) in its place, in the candidate and in the SDP. */
export function rewriteMdns<T extends Record<string, unknown>>(m: T, ip: string): T {
  if (!v4num(ip)) return m;
  const fix = (s: unknown) => (typeof s === 'string' ? s.replace(MDNS, ip) : s);
  const out: Record<string, unknown> = { ...m };
  if (typeof out.sdp === 'string') out.sdp = fix(out.sdp);
  if (out.cand && typeof out.cand === 'object') { const c = { ...(out.cand as Record<string, unknown>) }; c.candidate = fix(c.candidate); c.address = fix(c.address); out.cand = c; }
  return out as T;
}
/** A stream PC socket's WebRTC id, set by the HELPER: exactly "L<conn>" (one per socket, nothing the page chose). Every
 *  `from` a stream PC page sends is replaced, so it can never speak as another page (the real OBS page, this PC's studio,
 *  another stream PC), and one socket is ONE peer per feed: no flood of window / TV / mode B encodes (review r2). */
export const lanFrom = (conn: string) => `L${conn}`;
/** The page's own id for one feed (what it calls itself in `screen` / `tvfeed` / `spv`): kept by the helper per socket,
 *  the FIRST one wins; a message of that feed with another `from` is dropped. Ids are short, plain. */
export const lanClientId = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9_-]{1,40}$/.test(v) ? v : null);
/** The address of an ICE candidate line ("candidate:<foundation> <component> <proto> <priority> <ADDRESS> <port> typ …"). */
export function candidateAddress(c: string): string | null {
  const m = /^(?:a=)?candidate:\S+\s+\d+\s+\S+\s+\d+\s+(\S+)\s+\d+\s+typ\s/i.exec(String(c ?? '').trim());
  return m ? m[1].toLowerCase() : null;
}
/** Signalling FROM a stream PC socket, made safe: `from` stamped by the helper; mDNS names -> the socket's own address
 *  (rewriteMdns, a convenience only); then every candidate must BE the socket's address: a trickled candidate that is not
 *  -> the message is dropped (null), SDP candidate lines that are not -> removed. */
export function pinLanSignal(m: Record<string, unknown>, ip: string, conn: string): Record<string, unknown> | null {
  const out = rewriteMdns({ ...m, from: lanFrom(conn) }, ip) as Record<string, unknown>;
  const mine = (a: string | null) => a !== null && a === ip;
  if (out.cand !== undefined && out.cand !== null) {
    if (typeof out.cand !== 'object') return null;
    const c = String((out.cand as { candidate?: unknown }).candidate ?? '');
    if (/[\r\n]/.test(c)) return null; // one candidate per message, never smuggled lines
    if (c && !mine(candidateAddress(c))) return null;
    const ad = (out.cand as { address?: unknown }).address;
    if (ad !== undefined && ad !== null && ad !== ip) return null;
  }
  if (out.sdp !== undefined) {
    if (typeof out.sdp !== 'string') return null;
    // any line break form; a candidate anywhere on a line (leading space, mid-line) must be the socket's own address
    out.sdp = out.sdp.split(/\r\n|\r|\n/).filter((l) => { const i = l.search(/a=candidate:/i); return i < 0 || mine(candidateAddress(l.slice(i))); })
      .map((l) => sdpAddressLine(l, ip)).join('\r\n');
  }
  return out;
}
/** `c=` / `a=rtcp:` lines of SDP from a stream PC: kept when their address is the socket's own or 0.0.0.0, otherwise
 *  set to 0.0.0.0 (the SDP stays valid; ICE decides the real path, from the checked candidates). */
export function sdpAddressLine(l: string, ip: string): string {
  const c = /^(\s*)c=IN\s+IP[46]\s+(\S+)(.*)$/i.exec(l);
  if (c) return c[2] === ip || c[2] === '0.0.0.0' ? l : `${c[1]}c=IN IP4 0.0.0.0`;
  const r = /^(\s*)a=rtcp:(\d+)\s+IN\s+IP[46]\s+(\S+)(.*)$/i.exec(l);
  if (r) return r[3] === ip || r[3] === '0.0.0.0' ? l : `${r[1]}a=rtcp:${r[2]} IN IP4 0.0.0.0`;
  return l;
}
/** Signalling TO a stream PC socket (`conn`): addressed to it -> its own id back (the page only knows what it called
 *  itself); addressed to ANOTHER stream PC socket -> not delivered (null). */
export function unstampTo(m: Record<string, unknown>, conn: string, ownId: string | undefined): Record<string, unknown> | null {
  const to = typeof m.to === 'string' ? m.to : '';
  if (!/^L[0-9a-f]{8}/i.test(to)) return m; // (anything shaped like a stream PC id: only its own socket gets it)
  return to === lanFrom(conn) && ownId ? { ...m, to: ownId } : null;
}
/** Messages the helper must look at on their way TO a stream PC page (signalling with candidates). Prefix test only:
 *  the ~60 Hz tracking relay stays parse-free. */
export const SIGNAL_PREFIXES = ['{"type":"screen"', '{"type":"tvfeed"', '{"type":"spv"'];

// ---------------------------------------------------------------- Windows firewall: "VTube Pro (stream PC)"

export const SP_RULE_NAME = 'VTube Pro (stream PC)';
/** The inputs of the ONE elevated script (after the user's UAC "Yes"): tools/helper/win/ps/firewall_streampc.ps1 replaces OUR
 *  rule with an inbound allow for this program, TCP <port>, Private profile only, from the local subnet only. Port is a
 *  validated integer, the name a constant in the script, the program path comes from the running process: no user text
 *  reaches the command line. (The launch is server/psLaunch.ts: it needs the filesystem, this file also runs in the browser.) */
export function spFirewallParams(port: number, program: string): Array<[name: string, value: string | number]> {
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('bad port');
  return [['Port', port], ['Program', program]];
}
// The read-only query (our rule + the network profiles) is the static script tools/helper/win/ps/streampc_net_query.ps1 (server/streamPc.ts).
export interface SpRule { enabled: boolean; allow: boolean; inbound: boolean; profile: string; protocol: string; ports: string[]; remote: string[]; program: string }
export function normaliseSpRule(o: unknown): SpRule | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const arr = (v: unknown) => (Array.isArray(v) ? v.map(String) : v === undefined || v === null ? [] : [String(v)]);
  return {
    enabled: r.Enabled === true || /^true$/i.test(String(r.Enabled)),
    allow: /allow|^2$/i.test(String(r.Action)),
    inbound: /inbound|^1$/i.test(String(r.Direction)),
    profile: String(r.Profile ?? ''),
    protocol: String(r.Protocol ?? '').toUpperCase(),
    ports: arr(r.LocalPort),
    remote: arr(r.RemoteAddress),
    program: String(r.Program ?? ''),
  };
}
/** Is OUR rule in place, exactly as our script makes it: inbound allow, profile Private (only), TCP, this port (only),
 *  RemoteAddress LocalSubnet (only), this program. A wider rule with the same name ("Any" anything) does not count. */
export function spRuleOk(rules: SpRule[], port: number, program: string): boolean {
  return rules.some((r) => r.enabled && r.allow && r.inbound && /^private$/i.test(r.profile.trim()) && r.protocol === 'TCP'
    && r.ports.length === 1 && r.ports[0] === String(port)
    && r.remote.length === 1 && /^localsubnet$/i.test(r.remote[0])
    && !!r.program && r.program.toLowerCase() === program.toLowerCase());
}

// ---------------------------------------------------------------- what the studio card shows

export type SpMode = 'A' | 'B';
export interface SpPc { id: string; name: string; ip: string; created: string; lastSeen: string; online: boolean; kind: 'output' | 'view' | 'obs' | null; via: 'code' | 'obs' }
export interface SpView {
  enabled: boolean;
  mode: SpMode;
  /** 'listening' | why not: off / no network / Public network / waiting for the firewall rule / bind error. */
  state: 'off' | 'listening' | 'no-network' | 'public' | 'firewall' | 'error';
  says: string;
  address: string | null;
  iface: string | null;
  port: number;
  /** What the user types on the stream PC (pairing page). */
  pairUrl: string | null;
  code: { code: string; expiresIn: number } | null;
  pcs: SpPc[];
  firewall: { supported: boolean; ok: boolean; skipped: boolean };
  profile: 'Public' | 'Private' | 'Domain' | 'Unknown' | null;
  sender: { running: boolean; says: string; stats: Record<string, unknown> | null } | null;
}
