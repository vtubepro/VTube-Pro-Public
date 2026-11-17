// Pro2D → 3D: what we know about the two Blender MCPs (lane to3d, docs/PRO2D_TO_3D.md). Pure: no node / DOM imports, so
// the helper, the studio drawer and tools/to3d_unit.ts share it. Versions, pins, hosts, launch, cautions and detection
// come from the ONE add-on catalog (shared/aiAddons.ts); this file adds the wire protocols and the pack's tool rules. Facts checked 2026-10-06 against the sources (PyPI
// mcp-for-blender 2.1.9 + its bundled add-on; projects.blender.org/lab/blender_mcp v1.0.3):
//   * BOTH listen on 127.0.0.1:9876, so a listening port is not an identity: the probe speaks each protocol in turn.
//   * community "MCP for Blender" (MIT): add-on module blender_mcp ("Interface: MCP for Blender"), auto-starts its server
//     (scene.blendermcp_auto_start_server, default on). Wire: one JSON object {"type","params"} with NO delimiter; answer
//     {"status":"success"|"error", ...}; a `ping` command exists. Server: the catalog's pinned `uvx --from mcp-for-blender==2.1.9`, env
//     DISABLE_TELEMETRY (anonymous usage telemetry otherwise) and BLENDER_MCP_SAFE_MODE (deny-by-default code check:
//     no file / process / network access, no add-on installs; import / export still work). BLENDER_HOST / BLENDER_PORT.
//   * official Blender Lab MCP (GPL-3.0-or-later, Blender 5.1+): extension id `mcp`, operators blmcp.server_start /
//     blmcp.server_stop, autostart preference (default on). Wire: {"type":"execute","code","strict_json"} + "\0", answer
//     {"status":"ok"|"error", ...} + "\0". Server from the .mcpb bundle (Claude Desktop) or git. BLENDER_MCP_HOST / _PORT.
//     Blender's own page: it runs AI-written code "without any guards" (quoted on the consent sheet). No safe mode.

import { BLENDER_MCP_PORT, getAddon, type AddonEntry } from '../aiAddons.ts';

export type McpKind = 'community' | 'official';
/** The catalog ids (shared/aiAddons.ts: the ONE list of AI add-ons; pins, hosts, launch, cautions live there). */
export const ADDON_ID: Record<McpKind, string> = { community: 'mcp-for-blender', official: 'blender-lab-mcp' };
const entry = (k: McpKind): AddonEntry => {
  const e = getAddon(ADDON_ID[k]);
  if (!e) throw new Error(`shared/aiAddons.ts has no ${ADDON_ID[k]} entry`);
  return e;
};
const C = entry('community'), O = entry('official');
const pinned = (e: AddonEntry, ext: string) => e.pin?.files?.find((f) => f.name.endsWith(ext));
const pinUrl = (e: AddonEntry, ext: string) => `${e.pin?.baseUrl ?? ''}${pinned(e, ext)?.name ?? ''}`;

export const MCP_PORT = BLENDER_MCP_PORT;

/** What to3d needs beyond the catalog entry: the add-on's module + wire protocol + which of its tools the pack allows. */
export const COMMUNITY = {
  kind: 'community' as const,
  id: C.id,
  label: 'MCP for Blender',
  version: C.pin!.ref,
  /** the catalog's launch (uvx --from mcp-for-blender==<pin> mcp-for-blender), its env (telemetry off, safe mode on) */
  launch: C.mcp!.launch,
  env: { ...(C.mcp!.launch.env ?? {}) } as Record<string, string>,
  serverName: C.mcp!.serverName,
  /** the add-on file install-addon writes into <Blender user>/scripts/addons, and its module name */
  addonFile: 'blender_mcp.py',
  module: 'blender_mcp',
  home: C.homepage,
  licence: C.licence.name,
  cautions: C.cautions ?? [],
  detect: C.detect?.mcpEntry ?? 'mcp-for-blender',
  tools: { run: 'execute_blender_code', look: 'look', scene: 'get_scene_info' },
  /** tools of this server the pack never allows (cloud generators, asset downloads, telemetry feedback) */
  forbidden: ['generate_3d', 'search_assets', 'import_asset', 'record_trajectory_feedback'],
};

export const OFFICIAL = {
  kind: 'official' as const,
  id: O.id,
  label: 'Blender Lab MCP (official)',
  version: O.pin!.ref.replace(/^v/, ''),
  extensionId: 'mcp',
  minBlender: O.when?.tool?.minVersion ?? '5.1',
  zipUrl: pinUrl(O, '.zip'),
  zipBytes: pinned(O, '.zip')?.bytes ?? 0,
  zipSha256: pinned(O, '.zip')?.sha256 ?? '',
  mcpbUrl: pinUrl(O, '.mcpb'),
  mcpbBytes: pinned(O, '.mcpb')?.bytes ?? 0,
  home: O.homepage,
  licence: O.licence.name,
  /** Blender's own words (the catalog's first caution: quoted on the consent sheet) */
  warning: (O.cautions ?? [])[0] ?? '',
  cautions: O.cautions ?? [],
  detect: O.detect?.mcpEntry ?? 'blmcp',
  tools: { run: 'execute_blender_code', look: 'get_screenshot_of_window_as_image', scene: 'get_objects_summary' },
  /** runs a SECOND Blender outside VTube Pro's Blender lock */
  forbidden: ['execute_blender_code_for_cli', 'render_thumbnail_to_path', 'render_viewport_to_path'],
};

export const MCP_INFO = { community: COMMUNITY, official: OFFICIAL } as const;

// ---------------------------------------------------------------- the port probe (two framed protocols, 2 s each)
export const PROBE_TIMEOUT_MS = 2000;
/** community first: an official bridge never answers it (it waits for "\0"), so its 2 s run out and the next one goes */
export const COMMUNITY_PROBE = JSON.stringify({ type: 'ping', params: {} });
/** a no-op for the official bridge (it only knows `execute`) */
export const OFFICIAL_PROBE = JSON.stringify({ type: 'execute', code: 'pass', strict_json: true }) + '\0';

export type ProbeAnswer = 'community' | 'official' | 'other' | null;

/** What the bytes that came back say. `sent` = which probe they answer. */
export function readProbeAnswer(sent: McpKind, bytes: string): ProbeAnswer {
  const t = bytes.replace(/\0+$/, '').trim();
  if (!t) return null;
  let j: unknown;
  try { j = JSON.parse(t); } catch { return 'other'; }
  const st = (j as { status?: unknown })?.status;
  if (sent === 'community' && (st === 'success' || st === 'error') && bytes.indexOf('\0') < 0) return 'community';
  if (sent === 'official' && (st === 'ok' || st === 'error')) return 'official';
  return 'other';
}

// ---------------------------------------------------------------- add-ons on disk (no Blender started to look)
/** Blender's per-user config folder for a version ("5.1"): where scripts/addons, extensions and config/userpref.blend live. */
export function blenderUserDir(os: 'windows' | 'mac' | 'linux', version: string, env: { APPDATA?: string; HOME?: string; XDG_CONFIG_HOME?: string }): string | null {
  const v = version.split('.').slice(0, 2).join('.');
  if (os === 'windows') return env.APPDATA ? `${env.APPDATA}\\Blender Foundation\\Blender\\${v}` : null;
  if (os === 'mac') return env.HOME ? `${env.HOME}/Library/Application Support/Blender/${v}` : null;
  const base = env.XDG_CONFIG_HOME || (env.HOME ? `${env.HOME}/.config` : null);
  return base ? `${base}/blender/${v}` : null;
}

export interface AddonFacts { installed: boolean; enabled: boolean | null; where?: string }

/**
 * The add-on modules userpref.blend lists as ENABLED (only enabled add-ons are stored: one bAddon each). Parsed by
 * blocks, not by searching bytes: a bAddon is a DATA block of 152 bytes on 64-bit Blender ({ next, prev,
 * char module[128], prop }), the name at offset 16. Both .blend layouts:
 *   * up to Blender 4.x: "BLENDER" + "-"|"_" (pointer size 8|4) + "v"|"V" (endian) + 3 version digits = 12 bytes;
 *     block head = code(4) len(4) old pointer(8|4) sdna(4) nr(4)
 *   * Blender 5 ("BLENDER17-01v0501"): 17 bytes; block head = code(4) sdna(4) old(8) len(8) nr(8)
 * null = can't tell (no file, a compressed file: zstd 28 B5 2F FD, gzip 1F 8B, an unknown layout).
 */
export function enabledAddons(prefs: Uint8Array | null): string[] | null {
  if (!prefs || prefs.length < 17) return null;
  if ((prefs[0] === 0x28 && prefs[1] === 0xb5) || (prefs[0] === 0x1f && prefs[1] === 0x8b)) return null;
  const txt = (a: number, b: number) => String.fromCharCode(...prefs.subarray(a, b));
  if (txt(0, 7) !== 'BLENDER') return null;
  const dv = new DataView(prefs.buffer, prefs.byteOffset, prefs.byteLength);
  let layout: { off: number; head: number; len: (i: number) => number };
  if (/^\d\d$/.test(txt(7, 9)) && prefs[9] === 0x2d) {          // "BLENDER17-01…": the new large block heads
    const hl = Number(txt(7, 9));
    layout = { off: hl, head: 32, len: (i) => Number(dv.getBigInt64(i + 16, true)) };
  } else if ((prefs[7] === 0x2d || prefs[7] === 0x5f) && (prefs[8] === 0x76 || prefs[8] === 0x56)) {
    const ptr = prefs[7] === 0x2d ? 8 : 4, le = prefs[8] === 0x76;
    layout = { off: 12, head: 16 + ptr, len: (i) => dv.getInt32(i + 4, le) };
  } else return null;
  const out: string[] = [];
  for (let i = layout.off, n = 0; i + layout.head <= prefs.length && n < 100000; n++) {
    const code = txt(i, i + 4);
    if (code === 'ENDB') return out;
    const len = layout.len(i);
    if (!(len >= 0) || i + layout.head + len > prefs.length) return out.length ? out : null;
    const d = i + layout.head;
    if (code === 'DATA' && len >= 144 && len <= 200) {
      let e = d + 16;
      while (e < d + 16 + 128 && prefs[e] !== 0) e++;
      const name = txt(d + 16, e);
      if (e > d + 16 && e < d + 16 + 128 && /^[A-Za-z_][A-Za-z0-9_.]{0,126}$/.test(name)) out.push(name);
    }
    i = d + len;
  }
  return out;
}

/** Is an add-on module enabled in userpref.blend? null = can't tell. */
export function addonEnabledInPrefs(prefs: Uint8Array | null, module: string): boolean | null {
  const list = enabledAddons(prefs);
  return list === null ? null : list.includes(module);
}

/** The module name an extension gets once installed from a local zip ("user_default" repo). */
export const extensionModule = (id: string, repo = 'user_default') => `bl_ext.${repo}.${id}`;

// ---------------------------------------------------------------- the AI apps' configs
export interface McpEntry { command?: string; args?: string[]; env?: Record<string, string>; url?: string }

/** Which Blender MCP an AI app's server entry starts (null = not a Blender MCP): the catalog's detect patterns, matched
 *  like server/aiAddons.ts does ("<command file name without .exe> <args...>"), plus a .mcpb / git-run official server. */
export function entryKind(name: string, e: McpEntry): McpKind | null {
  const cmd = (e.command ?? '').replace(/\\/g, '/').split('/').pop()!.replace(/\.exe$/i, '');
  const line = [cmd, ...(e.args ?? [])].join(' ');
  const words = [name, line, e.url ?? ''].join(' ');
  if (new RegExp(OFFICIAL.detect, 'i').test(line) || /projects\.blender\.org|blender-\d+\.\d+\.\d+\.mcpb/i.test(words)) return 'official';
  if (new RegExp(COMMUNITY.detect, 'i').test(line) || /\bblender[-_]mcp\b/i.test(line)) return 'community';
  return null;
}

/** Every Blender MCP entry in an app's server table; more than one on the same port breaks the one they had. */
export function blenderEntries(servers: Record<string, McpEntry> | undefined): { name: string; kind: McpKind; port: number }[] {
  const out: { name: string; kind: McpKind; port: number }[] = [];
  for (const [name, e] of Object.entries(servers ?? {})) {
    const kind = entryKind(name, e);
    if (!kind) continue;
    const p = Number(e.env?.BLENDER_PORT ?? e.env?.BLENDER_MCP_PORT ?? (e.args ?? []).find((_a, i, l) => l[i - 1] === '--port') ?? MCP_PORT);
    out.push({ name, kind, port: Number.isFinite(p) ? p : MCP_PORT });
  }
  return out;
}

export function duplicatePorts(entries: readonly { port: number }[]): boolean {
  const seen = new Set<number>();
  for (const e of entries) { if (seen.has(e.port)) return true; seen.add(e.port); }
  return false;
}

/**
 * The entry we write for the community server: the catalog's launch with the helper's own uvx by ABSOLUTE path (apps
 * started from the Start menu or the Dock don't see PATH), the version pinned, telemetry off, safe mode on.
 */
export function communityEntry(uvx: string): McpEntry {
  return { command: uvx, args: [...COMMUNITY.launch.args], env: { ...COMMUNITY.env, VTP_ADDON: COMMUNITY.id } };
}

/** The tool names the pack allows from a Blender MCP, given the names `tools/list` returned (or the known defaults). */
export function blenderToolMap(kind: McpKind, listed?: readonly string[] | null) {
  const want = MCP_INFO[kind].tools;
  const has = (n: string) => !listed || listed.includes(n);
  return {
    run: has(want.run) ? want.run : listed?.find((n) => /execute.*code/i.test(n) && !/cli/i.test(n)) ?? null,
    look: has(want.look) ? want.look : listed?.find((n) => /screenshot|look/i.test(n)) ?? null,
    scene: has(want.scene) ? want.scene : listed?.find((n) => /scene|objects_summary/i.test(n)) ?? null,
    forbidden: [...MCP_INFO[kind].forbidden],
  };
}
