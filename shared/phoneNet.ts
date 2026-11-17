// Phone connection helpers (ZERO-EFFORT RULE): which ONE address of this PC a phone app should send to, where to send a
// discovery broadcast, the Windows firewall rule "VTube Pro" (what it must cover, how to read it back, the one elevated
// command that adds it), a Public Windows network, and the one plain sentence that says why nothing arrives.
// Pure (no node:, no DOM): the helper side is server/tracking/phoneNet.ts, the studio side src/ui/phonePanel.ts.
// Tested in tools/phonecap_unit.ts.

// ---------------------------------------------------------------- this PC's address

export interface NetIface { name: string; address: string; family: 'IPv4' | 'IPv6' | string | number; internal: boolean; netmask?: string; mac?: string }
export interface LanPick {
  /** The ONE IPv4 a phone should use, or null (no usable network). */
  address: string | null;
  /** Its adapter name (Windows: the InterfaceAlias, e.g. "Wi-Fi"). */
  iface: string | null;
  netmask: string | null;
  /** Subnet broadcast address of that adapter (e.g. 192.168.1.255), null if unknown. */
  broadcast: string | null;
  /** Everything we skipped, for the "Show other addresses" fold (name + address + why). */
  hidden: { iface: string; address: string; why: string }[];
}

/** Adapters a phone can't (or shouldn't) reach this PC through: VPNs, virtual switches, VMs, containers, tunnels. */
export const VIRTUAL_ADAPTER = new RegExp([
  'vethernet', 'hyper-?v', '\\bwsl', 'default switch', 'virtualbox', 'vbox', 'vmware', 'vmnet', 'parallels', 'docker', '^br-', '^veth', '^virbr',
  '^lxc', '^lxd', '^cni', '^flannel', '^podman', 'tailscale', 'zerotier', 'hamachi', 'radmin', 'wireguard', '^wg\\d', 'nordlynx', 'proton',
  'mullvad', 'openvpn', '\\btap\\b', 'tap-windows', '\\btun\\d*\\b', '^utun', 'vpn', 'npcap', 'loopback', 'bluetooth', '^awdl', '^llw',
  '^bridge\\d', '^ap\\d', 'local area connection\\*', 'teredo', 'isatap', 'cloudflare', 'warp', 'fortinet', 'cisco anyconnect', 'globalprotect',
  'pangp', 'juniper', 'sonicwall', 'expressvpn', 'surfshark', 'windscribe', 'pia\\b', 'hotspot shield', 'softether',
].join('|'), 'i');

const v4 = (s: string) => {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((x) => x <= 255) ? p : null;
};
export const isIPv4 = (s: string) => !!v4(s);
/** RFC 1918 home / office ranges (what a phone on the same Wi-Fi has). */
export function isPrivateLan(a: string): boolean {
  const p = v4(a);
  if (!p) return false;
  return p[0] === 10 || (p[0] === 192 && p[1] === 168) || (p[0] === 172 && p[1] >= 16 && p[1] <= 31);
}
/** Why an IPv4 is no good for a phone on the LAN, or null. */
function badAddress(a: string): string | null {
  const p = v4(a);
  if (!p) return 'not IPv4';
  if (p[0] === 127) return 'this PC only';
  if (p[0] === 169 && p[1] === 254) return 'no network (self-assigned)';
  if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return 'VPN / carrier address';
  if (p[0] >= 224) return 'not a device address';
  return null;
}
/** a.b.c.d / mask → the subnet broadcast (null for odd input or a /31–/32). */
export function broadcastOf(address: string, netmask: string | null | undefined): string | null {
  const a = v4(address), m = netmask ? v4(netmask) : null;
  if (!a || !m) return null;
  const n = (x: number[]) => ((x[0] << 24) | (x[1] << 16) | (x[2] << 8) | x[3]) >>> 0;
  const mask = n(m);
  if (mask === 0 || mask >= 0xfffffffe) return null;
  const b = (n(a) & mask) | (~mask >>> 0);
  return [(b >>> 24) & 255, (b >>> 16) & 255, (b >>> 8) & 255, b & 255].join('.');
}

const WIRED_OR_WIFI = /wi-?fi|wlan|wireless|ethernet|^en\d|^eth\d|^wlp|^enp|^eno|^ens/i;
/**
 * Choose the ONE address. `routeHint` = the local address the OS uses for its default route (the helper finds it with a
 * connected UDP socket, which sends nothing). Order: the default-route address if it is a real LAN adapter, else a
 * private address on a Wi-Fi / Ethernet adapter (192.168 first), else any private address, else any routable one.
 */
export function pickLanAddress(ifaces: NetIface[], routeHint?: string | null): LanPick {
  const hidden: LanPick['hidden'] = [];
  const ok: NetIface[] = [];
  for (const i of ifaces) {
    const fam = i.family === 4 ? 'IPv4' : i.family === 6 ? 'IPv6' : i.family;
    if (fam !== 'IPv4') { if (!i.internal) hidden.push({ iface: i.name, address: i.address, why: 'IPv6' }); continue; }
    if (i.internal) continue;
    const bad = badAddress(i.address);
    if (bad) { hidden.push({ iface: i.name, address: i.address, why: bad }); continue; }
    if (VIRTUAL_ADAPTER.test(i.name)) { hidden.push({ iface: i.name, address: i.address, why: 'virtual adapter / VPN' }); continue; }
    ok.push(i);
  }
  // a private (home / office) address always beats a non-private one, even when that one holds the default route: the
  // phone is on the Wi-Fi, not on the internet side; among private ones the default route wins
  const rank = (i: NetIface) => (isPrivateLan(i.address) ? 0 : 100) + (routeHint && i.address === routeHint ? 0 : 10)
    + (WIRED_OR_WIFI.test(i.name) ? 0 : 2) + (i.address.startsWith('192.168.') ? 0 : 1);
  const best = ok.slice().sort((a, b) => rank(a) - rank(b))[0];
  for (const i of ok) if (i !== best) hidden.push({ iface: i.name, address: i.address, why: 'another adapter' });
  if (!best) return { address: null, iface: null, netmask: null, broadcast: null, hidden };
  return { address: best.address, iface: best.name, netmask: best.netmask ?? null, broadcast: broadcastOf(best.address, best.netmask), hidden };
}

/** Where a discovery packet goes: the adapter's subnet broadcast first, then the limited broadcast. */
export function discoveryTargets(pick: Pick<LanPick, 'broadcast'>): string[] {
  const out: string[] = [];
  if (pick.broadcast) out.push(pick.broadcast);
  out.push('255.255.255.255');
  return out;
}

// ---------------------------------------------------------------- Windows firewall: the "VTube Pro" rule

export const FIREWALL_RULE_NAME = 'VTube Pro';
export interface FirewallPorts { udp: number[]; tcp: number[] }
export interface FirewallRuleInfo { enabled: boolean; action: string; direction: string; profile: string; protocol: string; ports: number[] }
export interface FirewallState {
  /** false on macOS / Linux (nothing to do there) or when Windows' firewall tools didn't answer. */
  supported: boolean;
  /** Our rule exists, is enabled, allows inbound on the Private profile and covers every needed port. */
  ok: boolean;
  /** Some "VTube Pro" rule exists (maybe for old ports). */
  exists: boolean;
  /** Ports the rule doesn't cover yet. */
  missing: FirewallPorts;
  why?: string;
}
const validPorts = (ps: number[]) => [...new Set(ps.filter((p) => Number.isInteger(p) && p >= 1 && p <= 65535))].sort((a, b) => a - b);

/** Expand a firewall LocalPort value ("21413", "39539-39540", ["11111","49983"], "Any") to port numbers ('any' = everything). */
export function expandPorts(v: unknown): number[] | 'any' {
  const parts: string[] = Array.isArray(v) ? v.map(String) : typeof v === 'string' || typeof v === 'number' ? String(v).split(',') : [];
  const out: number[] = [];
  for (const raw of parts) {
    const s = raw.trim();
    if (/^any$/i.test(s)) return 'any';
    const r = /^(\d+)-(\d+)$/.exec(s);
    if (r) { const a = +r[1], b = +r[2]; if (b - a <= 65535) for (let p = a; p <= b; p++) out.push(p); continue; }
    if (/^\d+$/.test(s)) out.push(+s);
  }
  return validPorts(out);
}

/** Normalise one rule from the helper's PowerShell query (Get-NetFirewallRule + port filter → JSON; enums may come as numbers). */
export function normaliseRule(o: unknown): FirewallRuleInfo | null {
  if (!o || typeof o !== 'object') return null;
  const r = o as Record<string, unknown>;
  const str = (v: unknown, map: Record<number, string>) => (typeof v === 'number' ? map[v] ?? String(v) : String(v ?? ''));
  const enabled = r.Enabled === true || r.Enabled === 1 || /^true$/i.test(String(r.Enabled));
  const action = str(r.Action, { 2: 'Allow', 4: 'Block' });
  const direction = str(r.Direction, { 1: 'Inbound', 2: 'Outbound' });
  // Profile flags: 1 Domain, 2 Private, 4 Public; 0 / "Any" = all
  const profile = typeof r.Profile === 'number' ? (r.Profile === 0 ? 'Any' : [r.Profile & 1 ? 'Domain' : '', r.Profile & 2 ? 'Private' : '', r.Profile & 4 ? 'Public' : ''].filter(Boolean).join(', ')) : String(r.Profile ?? '');
  const protocol = String(r.Protocol ?? '').toUpperCase();
  const ports = expandPorts(r.LocalPort);
  return { enabled, action, direction, profile, protocol, ports: ports === 'any' ? [0] : ports };
}

/** Is the rule set good for these ports? (Rules named "VTube Pro" only; any extra rules are ignored.) */
export function firewallState(rules: FirewallRuleInfo[] | null, need: FirewallPorts, platform: string): FirewallState {
  const empty = { udp: [], tcp: [] };
  if (platform !== 'win32') return { supported: false, ok: true, exists: false, missing: empty, why: 'Only Windows asks about this.' };
  if (!rules) return { supported: false, ok: false, exists: false, missing: { udp: validPorts(need.udp), tcp: validPorts(need.tcp) }, why: 'Windows didn’t tell us about its firewall.' };
  const good = rules.filter((r) => r.enabled && /allow/i.test(r.action) && /in/i.test(r.direction) && /private|any/i.test(r.profile));
  const covered = (proto: 'UDP' | 'TCP') => {
    const s = new Set<number>();
    for (const r of good) if (r.protocol === proto || r.protocol === 'ANY' || r.protocol === '') for (const p of r.ports) s.add(p);
    return s;
  };
  const u = covered('UDP'), t = covered('TCP');
  const missing = { udp: validPorts(need.udp).filter((p) => !u.has(p) && !u.has(0)), tcp: validPorts(need.tcp).filter((p) => !t.has(p) && !t.has(0)) };
  return { supported: true, ok: !missing.udp.length && !missing.tcp.length, exists: rules.length > 0, missing };
}

/**
 * The inputs of the ONE script that runs elevated (after the user's own UAC "Yes"): tools/helper/win/ps/firewall_phone.ps1
 * replaces the rules named "VTube Pro" with an inbound allow on the Private profile for exactly these ports. Nothing else
 * is touched. Ports are validated integers (comma lists, empty ones left out), the rule name is a constant in the script:
 * no user text reaches the command line. The launch itself is server/psLaunch.ts (it needs the filesystem; this file also
 * runs in the browser).
 */
export function firewallAddParams(need: FirewallPorts): Array<[name: string, value: string]> {
  const udp = validPorts(need.udp), tcp = validPorts(need.tcp);
  return [...(udp.length ? [['Udp', udp.join(',')] as [string, string]] : []), ...(tcp.length ? [['Tcp', tcp.join(',')] as [string, string]] : [])];
}
// The read-only query (no elevation needed: our rules + the network profiles, one JSON object) is a static script file
// since 14.1, tools/helper/win/ps/phone_net_query.ps1 (server/tracking/phoneNet.ts): no script built on the fly.

// ---------------------------------------------------------------- network profile (Public / Private)

export interface NetProfile { iface: string; category: 'Public' | 'Private' | 'Domain' | 'Unknown'; name: string }
export function normaliseProfiles(v: unknown): NetProfile[] {
  const list = Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : [];
  const cat = (c: unknown): NetProfile['category'] => {
    const s = String(c ?? '');
    if (s === '0' || /^public$/i.test(s)) return 'Public';
    if (s === '1' || /^private$/i.test(s)) return 'Private';
    if (s === '2' || /^domain/i.test(s)) return 'Domain';
    return 'Unknown';
  };
  return list.filter((p) => p && typeof p === 'object').map((p) => { const o = p as Record<string, unknown>; return { iface: String(o.InterfaceAlias ?? ''), category: cat(o.NetworkCategory), name: String(o.Name ?? '') }; });
}
/** The profile of the adapter we show the phone (or, if unmatched, the only connected one). */
export function profileFor(profiles: NetProfile[], iface: string | null): NetProfile | null {
  if (iface) { const m = profiles.find((p) => p.iface.toLowerCase() === iface.toLowerCase()); if (m) return m; }
  // the adapter's name didn't match: any connected Public network may be the one blocking the phone, so say so
  return profiles.find((p) => p.category === 'Public') ?? (profiles.length === 1 ? profiles[0] : null);
}
/** ms-settings page where the user switches the network to Private. */
export const networkSettingsUrl = (iface: string | null) => (iface && /ethernet|^eth/i.test(iface) ? 'ms-settings:network-ethernet' : 'ms-settings:network-wifi');

// ---------------------------------------------------------------- one plain sentence

/** The ONE honest line about MeowFace (the wizard, the Tracking panel and the docs all say this). */
export const MEOWFACE_NOTE = 'MeowFace is an older free Android app (itch.io). It is no longer updated, so it may not work on newer Android phones. If it will not connect, use “No app: this phone’s browser” instead: it works on any phone.';

/** One app-specific next step per listener (the setting's real name in that app), shown when nothing has arrived yet. */
export const PHONE_APP_HINT: Record<string, string> = {
  vtsPhone: 'In VTube Studio (or MeowFace) turn on “3rd Party PC Clients”, and keep the app open.',
  ifacialmocap: 'In iFacialMocap / FaceMotion3D tap Start, or type this PC’s address into its destination box.',
  liveLinkFace: 'In Live Link Face pick “Live Link (ARKit)”, then ⚙ → Live Link → Add Target with this PC’s address and port.',
  vmc: 'In Waidayo (or your VMC app) set the destination to this PC’s address and the port shown here, with sending on.',
};
export interface SourceSeen { enabled: boolean; running: boolean; lastSeen: number | null; faceFound: boolean; lastError?: string | null; port?: number; packetsPerSec?: number }
export interface Diagnosis { state: '' | 'ok' | 'warn' | 'err'; text: string; fix?: 'firewall' | 'network' | null }
/**
 * Why the avatar isn't moving from the phone, in one sentence + at most one fix. `everReceived`: the phone sent before
 * in this session (so a silence now means it locked / closed the app). Mirrors receiving() in phonePanel.
 */
export function diagnose(s: SourceSeen | undefined, ctx: { now: number; firewall?: FirewallState | null; profile?: NetProfile | null; everReceived?: boolean; /** the app-specific next step (PHONE_APP_HINT), appended to the "isn’t sending yet" sentences */ hint?: string }): Diagnosis {
  if (!s || !s.enabled) return { state: '', text: 'Off' };
  if (!s.running) return { state: 'err', text: /EADDRINUSE|in use|address already/i.test(String(s.lastError ?? '')) ? `Another program on this PC is already using port ${s.port ?? ''}. Close the other VTuber app, then try again.` : `VTube Pro couldn’t start listening${s.lastError ? `: ${s.lastError}` : '.'}` };
  const live = s.lastSeen !== null && ctx.now - s.lastSeen < 1200;
  if (live) return s.faceFound ? { state: 'ok', text: `Your phone is sending your face (${s.packetsPerSec ?? 0} frame${s.packetsPerSec === 1 ? '' : 's'} a second).` } : { state: 'warn', text: 'Your phone is connected, but it can’t see your face. Look at the phone.' };
  if (s.lastSeen !== null || ctx.everReceived) return { state: 'warn', text: 'Your phone stopped sending. Its screen may have locked, or the app went to the background: open it again.' };
  if (ctx.profile?.category === 'Public') return { state: 'warn', text: 'Windows treats this network as Public, so it blocks phones. Switch it to Private (one setting).', fix: 'network' };
  if (ctx.firewall && ctx.firewall.supported && !ctx.firewall.ok) return { state: 'warn', text: `Your phone isn’t sending yet: open the app, keep it on screen, same Wi-Fi as this PC.${ctx.hint ? ` ${ctx.hint}` : ''} If it still doesn’t arrive, let phones through Windows’ firewall.`, fix: 'firewall' };
  return { state: 'warn', text: `Your phone isn’t sending yet: open the app, keep it on screen, same Wi-Fi as this PC.${ctx.hint ? ` ${ctx.hint}` : ''}` };
}
