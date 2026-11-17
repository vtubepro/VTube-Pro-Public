// DMX in (Art-Net 4 / sACN E1.31): lets the DJ's existing light show — SoundSwitch, Engine Lighting on Denon players,
// QLC+, Lightjams, MaestroDMX — drive VTube Pro's 3D rig as if it were real fixtures. RECEIVE ONLY (no DMX output).
//   packet parsers (helper: server/music/artnet.ts) → bus {type:'musicdmx', u, d} → pages → readFixtures(patch, universes)
// The fixture profiles below are what a lighting app patches to (docs/DJ_SYNC.md "Light shows"): simple, documented
// channel layouts. The djstage lane maps FixtureState onto its 3D fixtures. Pure module; tests: tools/djsync_unit.ts.

// ---------------------------------------------------------------- packets
const ARTNET_ID = 'Art-Net\0';
export const ARTNET_PORT = 6454, SACN_PORT = 5568;
export interface DmxFrame { proto: 'artnet' | 'sacn'; /** 1-based universe (Art-Net port-address 0 = universe 1, like QLC+). */ universe: number; seq: number; data: Uint8Array; priority: number; source: string; terminated?: boolean }

/** Art-Net ArtDmx (OpCode 0x5000). */
export function parseArtDmx(b: Uint8Array): DmxFrame | null {
  if (b.length < 18 + 2 || String.fromCharCode(...b.subarray(0, 8)) !== ARTNET_ID) return null;
  const op = b[8] | (b[9] << 8);
  if (op !== 0x5000) return null;
  const len = (b[16] << 8) | b[17];
  if (len < 1 || len > 512 || 18 + len > b.length) return null;
  const portAddr = ((b[15] & 0x7f) << 8) | b[14];
  return { proto: 'artnet', universe: portAddr + 1, seq: b[12], data: b.slice(18, 18 + len), priority: 100, source: 'Art-Net' };
}
export const isArtPoll = (b: Uint8Array) => b.length >= 12 && String.fromCharCode(...b.subarray(0, 8)) === ARTNET_ID && (b[8] | (b[9] << 8)) === 0x2000;
export function buildArtDmx(universe: number, data: Uint8Array, seq = 0): Uint8Array {
  const len = Math.min(512, data.length + (data.length % 2));
  const b = new Uint8Array(18 + len);
  for (let i = 0; i < 8; i++) b[i] = ARTNET_ID.charCodeAt(i);
  b[8] = 0x00; b[9] = 0x50; b[10] = 0; b[11] = 14; b[12] = seq;
  const pa = universe - 1; b[14] = pa & 0xff; b[15] = (pa >> 8) & 0x7f;
  b[16] = len >> 8; b[17] = len & 0xff; b.set(data.subarray(0, 512), 18);
  return b;
}
/** ArtPollReply (OpCode 0x2100), 239 bytes, receive-only: only sent when the user turns on "answer Art-Net polls" (opt-in). */
export function buildArtPollReply(o: { ip: number[]; mac: number[]; universes: number[]; name?: string }): Uint8Array {
  const b = new Uint8Array(239);
  for (let i = 0; i < 8; i++) b[i] = ARTNET_ID.charCodeAt(i);
  b[8] = 0x00; b[9] = 0x21;
  o.ip.slice(0, 4).forEach((v, i) => { b[10 + i] = v; });
  b[14] = 0x36; b[15] = 0x19;                                   // port 6454, little-endian
  const u0 = Math.max(0, (o.universes[0] ?? 1) - 1);
  b[18] = (u0 >> 8) & 0x7f; b[19] = (u0 >> 4) & 0x0f;           // Net / SubNet
  b[20] = 0xff; b[21] = 0xff;                                   // OEM: unregistered
  const short = (o.name ?? 'VTube Pro').slice(0, 17), long = `${o.name ?? 'VTube Pro'} 3D stage (receive only)`.slice(0, 63);
  for (let i = 0; i < short.length; i++) b[26 + i] = short.charCodeAt(i);
  for (let i = 0; i < long.length; i++) b[44 + i] = long.charCodeAt(i);
  const ports = o.universes.slice(0, 4);
  b[173] = ports.length;
  // receive-only: PortTypes bit 7 = "takes data from the Art-Net network" (a visualiser); GoodOutput stays 0 (we never claim
  // to be outputting DMX), GoodInput 0 (we send nothing); SwOut = the universes we listen to
  ports.forEach((u, i) => { b[174 + i] = 0x80; b[190 + i] = (u - 1) & 0x0f; });
  b[200] = 0x00;                                                // StNode
  o.mac.slice(0, 6).forEach((v, i) => { b[201 + i] = v; });
  o.ip.slice(0, 4).forEach((v, i) => { b[207 + i] = v; });
  b[212] = 0x08;                                                // 15-bit port addresses
  return b;
}

const ACN_ID = [0x41, 0x53, 0x43, 0x2d, 0x45, 0x31, 0x2e, 0x31, 0x37, 0x00, 0x00, 0x00];
/** sACN / E1.31 data packet. Non-zero start codes (e.g. per-channel priority) are ignored. */
export function parseSacn(b: Uint8Array): DmxFrame | null {
  if (b.length < 126) return null;
  for (let i = 0; i < 12; i++) if (b[4 + i] !== ACN_ID[i]) return null;
  const u32 = (o: number) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
  if (u32(18) !== 4 || u32(40) !== 2 || b[117] !== 0x02 || b[118] !== 0xa1) return null;
  const count = (b[123] << 8) | b[124];
  if (count < 1 || count > 513 || 125 + count > b.length) return null;
  if (b[125] !== 0x00) return null;                              // start code 0 only
  let name = ''; for (let i = 44; i < 108 && b[i]; i++) name += String.fromCharCode(b[i]);
  const options = b[112];
  return { proto: 'sacn', universe: (b[113] << 8) | b[114], seq: b[111], data: b.slice(126, 125 + count), priority: b[108], source: name.slice(0, 63) || 'sACN', terminated: (options & 0x40) !== 0 };
}
export function buildSacn(universe: number, data: Uint8Array, o: { seq?: number; priority?: number; name?: string } = {}): Uint8Array {
  const n = Math.min(512, data.length), len = 126 + n;
  const b = new Uint8Array(len);
  const w16 = (off: number, v: number) => { b[off] = v >> 8; b[off + 1] = v & 0xff; };
  const w32 = (off: number, v: number) => { b[off] = v >>> 24; b[off + 1] = (v >> 16) & 0xff; b[off + 2] = (v >> 8) & 0xff; b[off + 3] = v & 0xff; };
  w16(0, 0x10); w16(2, 0); ACN_ID.forEach((v, i) => { b[4 + i] = v; });
  w16(16, 0x7000 | (len - 16)); w32(18, 4);
  w16(38, 0x7000 | (len - 38)); w32(40, 2);
  const nm = (o.name ?? 'test').slice(0, 63); for (let i = 0; i < nm.length; i++) b[44 + i] = nm.charCodeAt(i);
  b[108] = o.priority ?? 100; b[111] = o.seq ?? 0; w16(113, universe);
  w16(115, 0x7000 | (len - 115)); b[117] = 0x02; b[118] = 0xa1; w16(119, 0); w16(121, 1); w16(123, n + 1);
  b[125] = 0; b.set(data.subarray(0, n), 126);
  return b;
}

/** Merge rule per universe: the highest sACN priority wins; equal priority → the newest sender (no HTP mixing). */
export class UniverseStore {
  private u = new Map<number, { data: Uint8Array; priority: number; source: string; at: number }>();
  /** Returns true when the universe's values changed. */
  put(f: DmxFrame, now: number): boolean {
    const cur = this.u.get(f.universe);
    if (f.terminated) { if (cur?.source === f.source) this.u.delete(f.universe); return !!cur; }
    if (cur && cur.source !== f.source && cur.priority > f.priority && now - cur.at < 2500) return false;
    const data = new Uint8Array(512); data.set(f.data.subarray(0, 512));
    const changed = !cur || !sameBytes(cur.data, data);
    this.u.set(f.universe, { data, priority: f.priority, source: f.source, at: now });
    return changed;
  }
  get(universe: number): Uint8Array | null { return this.u.get(universe)?.data ?? null; }
  list(now: number) { return [...this.u.entries()].filter(([, v]) => now - v.at < 10000).map(([k, v]) => ({ universe: k, source: v.source, ageMs: Math.round(now - v.at) })); }
  /** Forget universes silent for 2.5 s+ (E1.31 data-loss timeout ×4). */
  sweep(now: number) { for (const [k, v] of this.u) if (now - v.at > 10000) this.u.delete(k); }
}
const sameBytes = (a: Uint8Array, b: Uint8Array) => { if (a.length !== b.length) return false; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false; return true; };

// ---------------------------------------------------------------- the mapping layer: fixture profiles + patch
export type FixtureProfileId = 'par-rgbw' | 'par-rgb' | 'moving-head' | 'pixel-bar-8' | 'strobe' | 'blinder' | 'laser' | 'sfx';
export interface FixtureProfile { id: FixtureProfileId; label: string; channels: string[] }
/** VTube Pro's virtual fixtures, as a lighting app sees them (1 channel = 1 byte; "fine" = the low byte of a 16-bit pair). */
export const FIXTURE_PROFILES: Record<FixtureProfileId, FixtureProfile> = {
  'par-rgbw': { id: 'par-rgbw', label: 'PAR / wash RGBW (5 ch)', channels: ['dimmer', 'red', 'green', 'blue', 'white'] },
  'par-rgb': { id: 'par-rgb', label: 'PAR RGB (3 ch)', channels: ['red', 'green', 'blue'] },
  'moving-head': { id: 'moving-head', label: 'Moving head / beam (16 ch)', channels: ['pan', 'pan fine', 'tilt', 'tilt fine', 'dimmer', 'strobe', 'red', 'green', 'blue', 'white', 'zoom', 'prism', 'gobo', 'beam fx', 'speed', 'reserved'] },
  'pixel-bar-8': { id: 'pixel-bar-8', label: 'Pixel bar, 8 × RGB (25 ch)', channels: ['dimmer', ...Array.from({ length: 8 }, (_, i) => [`p${i + 1} red`, `p${i + 1} green`, `p${i + 1} blue`]).flat()] },
  strobe: { id: 'strobe', label: 'Strobe (2 ch)', channels: ['intensity', 'rate'] },
  blinder: { id: 'blinder', label: 'Blinder (1 ch)', channels: ['intensity'] },
  laser: { id: 'laser', label: 'Laser (8 ch)', channels: ['on', 'pattern', 'red', 'green', 'blue', 'size', 'speed', 'rotation'] },
  sfx: { id: 'sfx', label: 'Effect trigger: flame / CO2 / confetti (1 ch, ≥ 128 = fire; shown on screen only)', channels: ['fire'] },
};
export interface PatchEntry { id: string; profile: FixtureProfileId; universe: number; /** 1-based DMX address. */ address: number }
export interface FixtureState {
  id: string; profile: FixtureProfileId;
  dim: number; rgb: [number, number, number]; white: number;
  /** −1..1 (centre 0) for pan / tilt; zoom 0..1; strobe rate Hz (0 = off); prism / gobo / pattern = raw 0..255. */
  pan?: number; tilt?: number; zoom?: number; strobe?: number; prism?: number; gobo?: number; pattern?: number;
  pixels?: [number, number, number][];
  fire?: boolean;
}

/** Give a list of fixtures sequential addresses (a new universe when one is full). */
export function autoPatch(fixtures: { id: string; profile: FixtureProfileId }[], firstUniverse = 1): PatchEntry[] {
  const out: PatchEntry[] = [];
  let u = firstUniverse, a = 1;
  for (const f of fixtures) {
    const n = FIXTURE_PROFILES[f.profile].channels.length;
    if (a + n - 1 > 512) { u++; a = 1; }
    out.push({ id: f.id, profile: f.profile, universe: u, address: a });
    a += n;
  }
  return out;
}

const u8 = (v: number) => v / 255;
/** Decode every patched fixture from the current universes (fixtures on a silent universe are left out). */
export function readFixtures(patch: PatchEntry[], universe: (u: number) => Uint8Array | null): FixtureState[] {
  const out: FixtureState[] = [];
  for (const p of patch) {
    const d = universe(p.universe);
    if (!d) continue;
    const c = (i: number) => d[p.address - 1 + i] ?? 0;
    switch (p.profile) {
      case 'par-rgbw': out.push({ id: p.id, profile: p.profile, dim: u8(c(0)), rgb: [u8(c(1)), u8(c(2)), u8(c(3))], white: u8(c(4)) }); break;
      case 'par-rgb': { const rgb: [number, number, number] = [u8(c(0)), u8(c(1)), u8(c(2))]; out.push({ id: p.id, profile: p.profile, dim: Math.max(...rgb) > 0 ? 1 : 0, rgb, white: 0 }); break; }
      case 'moving-head': {
        const pan = ((c(0) << 8) | c(1)) / 65535 * 2 - 1, tilt = ((c(2) << 8) | c(3)) / 65535 * 2 - 1;
        out.push({ id: p.id, profile: p.profile, dim: u8(c(4)), strobe: c(5) < 8 ? 0 : 1 + (c(5) - 8) / 247 * 24, rgb: [u8(c(6)), u8(c(7)), u8(c(8))], white: u8(c(9)), pan, tilt, zoom: u8(c(10)), prism: c(11), gobo: c(12) });
        break;
      }
      case 'pixel-bar-8': {
        const px: [number, number, number][] = [];
        for (let i = 0; i < 8; i++) px.push([u8(c(1 + i * 3)), u8(c(2 + i * 3)), u8(c(3 + i * 3))]);
        out.push({ id: p.id, profile: p.profile, dim: u8(c(0)), rgb: [0, 0, 0], white: 0, pixels: px });
        break;
      }
      case 'strobe': out.push({ id: p.id, profile: p.profile, dim: u8(c(0)), rgb: [1, 1, 1], white: 1, strobe: c(1) < 8 ? 0 : 1 + (c(1) - 8) / 247 * 24 }); break;
      case 'blinder': out.push({ id: p.id, profile: p.profile, dim: u8(c(0)), rgb: [1, 0.78, 0.5], white: 0 }); break;
      case 'laser': out.push({ id: p.id, profile: p.profile, dim: c(0) >= 128 ? 1 : 0, rgb: [u8(c(2)), u8(c(3)), u8(c(4))], white: 0, pattern: c(1), zoom: u8(c(5)) }); break;
      case 'sfx': out.push({ id: p.id, profile: p.profile, dim: 0, rgb: [0, 0, 0], white: 0, fire: c(0) >= 128 }); break;
    }
  }
  return out;
}

/** Bus payload helpers: 512 bytes ↔ base64 (pages decode with atob). */
export function dmxToB64(d: Uint8Array): string {
  let s = ''; for (let i = 0; i < d.length; i++) s += String.fromCharCode(d[i]);
  return typeof btoa === 'function' ? btoa(s) : (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } }).Buffer.from(s, 'latin1').toString('base64');
}
export function dmxFromB64(s: string): Uint8Array {
  const bin = typeof atob === 'function' ? atob(s) : (globalThis as unknown as { Buffer: { from(s: string, e: string): { toString(e: string): string } } }).Buffer.from(s, 'base64').toString('latin1');
  const out = new Uint8Array(512);
  for (let i = 0; i < Math.min(512, bin.length); i++) out[i] = bin.charCodeAt(i);
  return out;
}
export interface MusicDmxMsg { type: 'musicdmx'; u: number; d: string; src: string }
