// The helper's side of "Let phones connect" (shared/phoneNet.ts has the pure parts):
//   * this PC's ONE LAN address (default-route probe: a connected UDP socket, which sends nothing) + its broadcast;
//   * the Windows firewall rule "VTube Pro" and the network's Public / Private profile (one read-only PowerShell query:
//     the static script tools/helper/win/ps/phone_net_query.ps1, never elevated; cached for minutes, see netQuery);
//   * the user-initiated rule add: ONE elevated PowerShell (Windows shows its UAC prompt; the user says yes or no);
//   * opening Windows' network settings page (we never change the profile ourselves).
// Test switches: VTP_TOOLS_DRYRUN=1 (nothing runs, the plan is returned), VTP_PHONE_FAKE_NET=<json> (the query's answer).
import dgram from 'node:dgram';
import os from 'node:os';
import { execFile, spawn } from 'node:child_process';
import {
  firewallAddParams, firewallState, networkSettingsUrl, normaliseProfiles, normaliseRule, pickLanAddress, profileFor,
  type FirewallPorts, type FirewallRuleInfo, type FirewallState, type LanPick, type NetProfile,
} from '../../shared/phoneNet.ts';
import { elevatedFileCommand, psFileCommand, psScriptExists, psScriptPath } from '../psLaunch.ts';

/** The elevated launch: tools/helper/win/ps/firewall_phone.ps1 with the validated port lists (server/psLaunch.ts). */
export const firewallAddCommand = (need: FirewallPorts) => elevatedFileCommand(psScriptPath('firewall_phone.ps1'), firewallAddParams(need));
/** The read-only check: tools/helper/win/ps/phone_net_query.ps1, no parameters (beta.14.1; an inline -Command before). */
export const netQueryCommand = () => psFileCommand(psScriptPath('phone_net_query.ps1'));

/** Local address of the default route (no packet is sent: connect() on UDP only picks a route). null when offline. */
export function routeHint(timeoutMs = 400): Promise<string | null> {
  return new Promise((resolve) => {
    let done = false;
    const s = dgram.createSocket('udp4');
    const end = (v: string | null) => { if (done) return; done = true; try { s.close(); } catch { /* */ } resolve(v); };
    s.on('error', () => end(null));
    const t = setTimeout(() => end(null), timeoutMs);
    try {
      s.connect(53, '8.8.8.8', () => { clearTimeout(t); try { end(s.address().address); } catch { end(null); } });
    } catch { clearTimeout(t); end(null); }
  });
}

let hintCache: { at: number; v: string | null } | null = null;
/** The ONE address (+ broadcast, + what was hidden). */
export async function lanPick(): Promise<LanPick> {
  if (!hintCache || Date.now() - hintCache.at > 30_000) hintCache = { at: Date.now(), v: await routeHint() };
  const list: Parameters<typeof pickLanAddress>[0] = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) for (const a of addrs ?? []) list.push({ name, address: a.address, family: a.family, internal: a.internal, netmask: a.netmask });
  return pickLanAddress(list, hintCache.v);
}

interface NetQuery { rules: FirewallRuleInfo[] | null; profiles: NetProfile[] }
let queryCache: { at: number; lan: string; v: NetQuery } | null = null;
let queryRunning: Promise<NetQuery> | null = null;
/** Checks run since the helper started (tests / diagnostics). */
export const netQueryStats = { runs: 0 };

function runQuery(): Promise<NetQuery> {
  netQueryStats.runs++;
  if (process.env.VTP_PHONE_FAKE_NET) {
    try { const j = JSON.parse(process.env.VTP_PHONE_FAKE_NET) as { rules?: unknown; profiles?: unknown }; return Promise.resolve(parseQuery(j)); } catch { return Promise.resolve({ rules: null, profiles: [] }); }
  }
  if (process.platform !== 'win32') return Promise.resolve({ rules: [], profiles: [] });
  if (!psScriptExists(psScriptPath('phone_net_query.ps1'))) return Promise.resolve({ rules: null, profiles: [] });   // (unknown, as a failed check)
  const cmd = netQueryCommand();
  return new Promise((resolve) => {
    execFile(cmd.command, cmd.args, { windowsHide: true, timeout: 15_000, maxBuffer: 1 << 20 }, (err, out) => {
      if (err && !out) { resolve({ rules: null, profiles: [] }); return; }
      try { resolve(parseQuery(JSON.parse(String(out).trim() || '{}'))); } catch { resolve({ rules: null, profiles: [] }); }
    });
  });
}
function parseQuery(j: { rules?: unknown; profiles?: unknown }): NetQuery {
  const rl = Array.isArray(j.rules) ? j.rules : j.rules && typeof j.rules === 'object' ? [j.rules] : [];
  return { rules: rl.map(normaliseRule).filter((r): r is FirewallRuleInfo => !!r), profiles: normaliseProfiles(j.profiles) };
}
/** How long one check is used (beta.14.1). Each check is a PowerShell the helper starts by itself, and the studio's phone
 *  card asks every 6 s: once every 20 s while the card showed was the kind of repeated background launch antivirus
 *  behaviour blockers watch (Emsisoft blocked the GPU counters loop as an "exploit attempt"). The rule and the profile only
 *  change when the person changes them, so: QUERY_TTL_MS normally; QUERY_TTL_SETTINGS_MS for SETTINGS_WINDOW_MS after the
 *  person opened Windows' network settings from the card (they are switching the profile right now); at once when this
 *  PC's network (the adapter / address shown to the phone) changes; `fresh` (after "Let phones connect") re-asks. */
export const QUERY_TTL_MS = 300_000, QUERY_TTL_SETTINGS_MS = 20_000, SETTINGS_WINDOW_MS = 180_000;
let settingsOpenedAt = -1e12;
/** The person opened Windows' network settings from the studio: check sooner for a while. */
export function noteSettingsOpened(now = Date.now()) { settingsOpenedAt = now; }
/** The network a check was made on (the adapter + address shown to the phone). */
export const queryLanKey = (lan: Pick<LanPick, 'iface' | 'address'>) => `${lan.iface ?? ''}|${lan.address ?? ''}`;
/** `lan` = queryLanKey() of the network in use (a change re-asks). */
export async function netQuery(fresh = false, lan = '', now = Date.now()): Promise<NetQuery> {
  const ttl = now - settingsOpenedAt < SETTINGS_WINDOW_MS ? QUERY_TTL_SETTINGS_MS : QUERY_TTL_MS;
  if (!fresh && queryCache && queryCache.lan === lan && now - queryCache.at < ttl) return queryCache.v;
  if (!queryRunning) queryRunning = runQuery().then((v) => { queryCache = { at: now, lan, v }; return v; }).finally(() => { queryRunning = null; });
  return queryRunning;
}

export interface PhoneNetView {
  platform: string;
  lan: LanPick;
  firewall: FirewallState;
  profile: NetProfile | null;
  /** The receive ports the rule must cover. */
  ports: FirewallPorts;
}
export async function phoneNetView(ports: FirewallPorts, fresh = false): Promise<PhoneNetView> {
  const lan = await lanPick();
  const q = await netQuery(fresh, queryLanKey(lan));
  return { platform: process.platform, lan, firewall: firewallState(q.rules, ports, process.platform), profile: process.platform === 'win32' || process.env.VTP_PHONE_FAKE_NET ? profileFor(q.profiles, lan.iface) : null, ports };
}

let adding = false;
/** The user pressed "Let phones connect": ONE elevated run (UAC). Resolves with a plain-words result. */
export async function addFirewallRule(ports: FirewallPorts): Promise<{ ok: boolean; says: string; dryRun?: boolean; plan?: { command: string; args: string[] } }> {
  if (process.platform !== 'win32' && !process.env.VTP_PHONE_FAKE_NET) return { ok: true, says: 'Nothing to do: only Windows needs this.' };
  if (!ports.udp.length && !ports.tcp.length) return { ok: false, says: 'Turn on a phone app first, then try again.' };
  const plan = firewallAddCommand(ports);
  if (process.env.VTP_TOOLS_DRYRUN === '1') { console.log('[phone-net] (dry run) would ask Windows to add the "VTube Pro" firewall rule'); return { ok: true, dryRun: true, says: 'Dry run: nothing changed.', plan }; }
  if (adding) return { ok: false, says: 'Windows is already asking. Look for its prompt (it may be behind this window).' };
  adding = true;
  try {
    const code = await new Promise<number>((resolve) => {
      if (!psScriptExists(psScriptPath('firewall_phone.ps1'))) { resolve(-1); return; } // (script missing: fails like PowerShell failing, nothing runs)
      const c = spawn(plan.command, plan.args, { windowsHide: true, stdio: 'ignore' });
      c.on('error', () => resolve(-1));
      c.on('exit', (n) => resolve(n ?? -1));
    });
    queryCache = null;
    const after = await netQuery(true, queryLanKey(await lanPick()));
    const st = firewallState(after.rules, ports, process.platform);
    if (st.ok) return { ok: true, says: 'Done: phones on your home Wi-Fi can reach VTube Pro now.' };
    return { ok: false, says: code === 0 ? 'Windows didn’t add it. Try once more, or allow VTube Pro in Windows Security → Firewall.' : 'Windows didn’t get a “Yes”, so nothing changed. Press the button again and choose Yes.' };
  } finally { adding = false; }
}

/** Open the page where the user switches the network to Private (we never change it ourselves). */
export function openNetworkSettings(iface: string | null): { ok: boolean; says: string; url: string; dryRun?: boolean } {
  const url = networkSettingsUrl(iface);
  const says = 'Windows Settings opens: click your network, then choose “Private network”.';
  if (process.platform !== 'win32' && !process.env.VTP_PHONE_FAKE_NET) return { ok: false, says: 'Only Windows has this setting.', url };
  noteSettingsOpened();
  if (process.env.VTP_TOOLS_DRYRUN === '1' || process.platform !== 'win32') return { ok: true, says, url, dryRun: true };
  try {
    const c = spawn('explorer.exe', [url], { detached: true, stdio: 'ignore', windowsHide: true });
    c.on('error', () => {});
    c.unref();
    return { ok: true, says, url };
  } catch { return { ok: false, says: 'We couldn’t open Settings. Open Settings → Network & internet yourself.', url }; }
}
