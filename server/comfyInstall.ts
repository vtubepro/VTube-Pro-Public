// "Set it up for me": put a VTube Pro ComfyUI workflow into the user's own ComfyUI, after their explicit OK.
//
//   find ComfyUI  -> the one saved in Settings is THE ComfyUI (never swapped for another install that answers on 8000 / 8188);
//                    to put files in it, it must be running on this computer; we ask it where its folders are
//   plan          -> every file we would download (name, size, official URL, licence, target folder), what is
//                    already there, the custom node (git + pinned commit), free disk space
//   install       -> only with a single-use consent token from the helper's own page; downloads ONLY the exact URLs
//                    in shared/comfyWorkflows/models.ts (Hugging Face, pinned revision), checks size + SHA-256 of
//                    every byte, never overwrites a different file of the same name, clones the custom node at its
//                    pinned commit and checks HEAD, then adds the workflow to ComfyUI's Workflows list (its own
//                    /api/userdata) and puts starter pictures in its input folder.
// Never: pip installs, gated / signed-in downloads, anything outside ComfyUI's model + custom_nodes folders, non-loopback
// ComfyUI, URLs from a request or an AI. Network + git + clock are injected (tests mock them; nothing real downloads).
// A stopped setup is never silent: every job error is a plain sentence with a `code` (what kind of problem), and the page
// keeps the reason on screen with a "Try again" button (server/comfyWorkflowsPage.ts).
// A model with a licence limit (models.ts `restricted`, the Hunyuan3D weights) puts its notice in `plan.notices`: the page
// shows it above the Yes button, the AI summary carries it, and the consent covers it (it is part of the plan hash).
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildWorkflow, tierFor, TIERS, uiFileName, workflowDef, type BuiltWorkflow, type TierId, type WorkflowDef } from '../shared/comfyWorkflows/catalog.ts';
import { NODE_SCHEMA, packBinaryFiles } from '../shared/comfyWorkflows/files.ts';
import { MODEL_FILES, modelUrl, type ComfyFolder } from '../shared/comfyWorkflows/models.ts';
import { CUSTOM_NODES } from '../shared/comfyWorkflows/nodes.ts';

/** What kind of problem stopped a setup (the page picks its button from it: "Check again" when ComfyUI closed, else "Try again"). */
export type SetupCode = 'offline' | 'dropped' | 'checksum' | 'comfy-closed' | 'disk' | 'git' | 'workflow-refused' | 'exists' | 'blocked' | 'stopped' | 'other';
export class SetupError extends Error {
  constructor(message: string, public code: SetupCode) { super(message); this.name = 'SetupError'; }
}

export interface RunResult { code: number; out: string }
export interface InstallDeps {
  fetch: typeof fetch;
  /** git (and only git): execFile, no shell. */
  run: (cmd: 'git', args: string[], cwd?: string) => Promise<RunResult>;
  now: () => number;
  /** Free bytes on the disk holding `dir` (null = unknown). */
  freeBytes: (dir: string) => Promise<number | null>;
  /** settings comfyUrl, if any */
  comfyUrl: () => string | undefined;
}

// ---------------------------------------------------------------- where downloads may come from
const HF = /^https:\/\/huggingface\.co\/[\w.-]+\/[\w.-]+\/resolve\/[0-9a-f]{40}\/[\w./%-]+$/;
/** Hosts Hugging Face redirects file downloads to (its CDN / storage): huggingface.co, hf.co and any of their subdomains,
 *  at any depth. 2026-10: downloads go to us.aws.cdn.hf.co (and other regions' *.cdn.hf.co); the old one-label rule refused
 *  every file, so "Set it up for me" stopped at the first download. The SHA-256 check still covers every byte. */
export const REDIRECT_HOSTS = [/^(?:[a-z0-9-]+\.)*huggingface\.co$/i, /^(?:[a-z0-9-]+\.)*hf\.co$/i];
export const isAllowedRedirect = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' && REDIRECT_HOSTS.some((r) => r.test(x.hostname)); } catch { return false; } };
const CATALOG_URLS = new Set(MODEL_FILES.map((m) => modelUrl(m)));
export const isCatalogUrl = (u: string) => HF.test(u) && CATALOG_URLS.has(u);
const GIT_REPOS = new Set(CUSTOM_NODES.map((n) => n.repo));
const FOLDERS: ComfyFolder[] = ['checkpoints', 'diffusion_models', 'text_encoders', 'vae', 'loras', 'controlnet', 'ipadapter', 'clip_vision', 'upscale_models', 'background_removal'];

// ---------------------------------------------------------------- find ComfyUI
export interface ComfyTarget {
  url: string; version: string; folders: Record<string, string[]>;
  /** Graphics-card memory ComfyUI reports (GB, rounded), if it has a graphics card. */
  vramGB?: number;
}
const isComfyStats = (j: any) => !!j && typeof j === 'object' && !!j.system && Array.isArray(j.devices);
const DEFAULT_PORTS = ['http://127.0.0.1:8000', 'http://127.0.0.1:8188'];
/** Names and addresses that mean THIS computer: its own network addresses and its name. Someone who saved the address their
 *  ComfyUI printed (http://0.0.0.0:8188, or this PC's own 192.168.x.x) still has ComfyUI on this computer. */
function ownHosts(): Set<string> {
  const out = new Set<string>();
  try { out.add(os.hostname().toLowerCase()); } catch { /* ignore */ }
  try {
    for (const list of Object.values(os.networkInterfaces())) for (const a of list ?? []) { const x = a.address.toLowerCase(); out.add(x); out.add(`[${x}]`); }
  } catch { /* ignore */ }
  return out;
}
/** The ComfyUI address saved in Settings. `local` = it is on THIS computer (we can look into its folders and put files there);
 *  otherwise it is another computer's (home network), which we only ever ask to run a job. null = nothing usable saved. */
export interface SavedComfy { origin: string; local: boolean }
export function savedComfy(settingsUrl?: string): SavedComfy | null {
  if (!settingsUrl?.trim()) return null;
  let u: URL;
  try { u = new URL(settingsUrl.trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const port = u.port ? `:${u.port}` : '';
  if (host === '127.0.0.1' || host === 'localhost' || host === '0.0.0.0') return { origin: `${u.protocol}//127.0.0.1${port}`, local: true };
  if (host === '[::1]') return { origin: `${u.protocol}//[::1]${port}`, local: true };
  return { origin: `${u.protocol}//${u.host}`, local: ownHosts().has(host) };
}
/** Where to look for ComfyUI on this computer: the Settings address (if it is on this computer), then 8000 (ComfyUI Desktop), then
 *  8188 (the classic). A Settings address on ANOTHER computer is the person's ComfyUI: nothing on this computer is a candidate.
 *  VTP_COMFY_NO_DEFAULT_PORTS=1 (tests, private helpers) looks at the Settings address only, so a ComfyUI the owner has open
 *  on 8000 / 8188 is never touched. */
export function comfyCandidates(settingsUrl?: string): string[] {
  const s = savedComfy(settingsUrl);
  if (s && !s.local) return [];
  const out: string[] = s ? [s.origin] : [];
  if (process.env.VTP_COMFY_NO_DEFAULT_PORTS === '1') return out;
  for (const d of DEFAULT_PORTS) if (!out.includes(d)) out.push(d);
  return out;
}
async function getJson(d: InstallDeps, url: string, ms = 2500): Promise<any | null> {
  try { const r = await d.fetch(url, { signal: AbortSignal.timeout(ms) }); return r.ok ? await r.json() : null; } catch { return null; }
}
/** A time-out is not "closed": the ComfyUI is there but did not answer in time (busy loading a model, or a computer that is off the network). */
const isTimeout = (e: any) => ['TimeoutError', 'AbortError'].includes(e?.name) || ['UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'ETIMEDOUT'].includes(e?.cause?.code ?? e?.code);
type Probe = { state: 'comfy'; stats: any } | { state: 'answered' } | { state: 'slow' } | { state: 'closed' };
async function probeStats(d: InstallDeps, url: string, ms: number): Promise<Probe> {
  try {
    const r = await d.fetch(`${url}/system_stats`, { signal: AbortSignal.timeout(ms) });
    if (!r.ok) return { state: 'answered' };
    const j = await r.json().catch((e) => { if (isTimeout(e)) throw e; return null; });
    return isComfyStats(j) ? { state: 'comfy', stats: j } : { state: 'answered' };
  } catch (e) { return { state: isTimeout(e) ? 'slow' : 'closed' }; }
}
const hasFolders = (f: any) => !!f && typeof f === 'object' && Array.isArray(f.checkpoints);
const targetOf = (url: string, stats: any, folders: Record<string, string[]>): ComfyTarget => ({ url, version: String(stats.system.comfyui_version ?? 'unknown'), folders, ...vramOf(stats) });

/** What looking for ComfyUI found.
 *  local : on this computer, and it told us its folders (we can plan and put files there)
 *  blind : it answers but we cannot look into it: another computer's ComfyUI, or an old build that cannot list its folders
 *  slow  : the ComfyUI in Settings is there but did not answer in time (never replaced by another one)
 *  none  : nothing answered */
export type ComfyLookup =
  | { kind: 'local'; target: ComfyTarget }
  | { kind: 'blind'; url: string; local: boolean }
  | { kind: 'slow'; url: string }
  | { kind: 'none' };
/** Find the person's ComfyUI. The address saved in Settings is THE ComfyUI: if it answers (on this computer or another) it is the
 *  one, and no other install on this computer is looked at instead (the studio used to talk to whatever answered on 8000 / 8188,
 *  and "Set it up for me" could download several GB into a ComfyUI they do not use). A slow answer is not "not there": it is
 *  `slow` (with `waitMs` the saved address gets a second, patient look first). Only a Settings address on THIS computer that is
 *  closed moves on to the usual places (ComfyUI Desktop on 8000, then 8188). */
export async function lookupComfy(d: InstallDeps, o: { waitMs?: number } = {}): Promise<ComfyLookup> {
  const saved = savedComfy(d.comfyUrl());
  if (saved) {
    let p = await probeStats(d, saved.origin, 2500);
    if (p.state === 'slow' && o.waitMs) p = await probeStats(d, saved.origin, o.waitMs);
    if (p.state === 'slow') return { kind: 'slow', url: saved.origin };
    if (!saved.local) return p.state === 'closed' ? { kind: 'none' } : { kind: 'blind', url: saved.origin, local: false };
    if (p.state === 'comfy') {
      const folders = await getJson(d, `${saved.origin}/internal/folder_paths`);
      return hasFolders(folders) ? { kind: 'local', target: targetOf(saved.origin, p.stats, folders) } : { kind: 'blind', url: saved.origin, local: true };
    }
    // closed (or not ComfyUI at all): the usual places on this computer
  }
  if (process.env.VTP_COMFY_NO_DEFAULT_PORTS === '1') return { kind: 'none' };
  for (const url of DEFAULT_PORTS) {
    if (url === saved?.origin) continue; // just asked
    const p = await probeStats(d, url, 2500);
    if (p.state !== 'comfy') continue;
    const folders = await getJson(d, `${url}/internal/folder_paths`);
    if (!hasFolders(folders)) continue;
    return { kind: 'local', target: targetOf(url, p.stats, folders) };
  }
  return { kind: 'none' };
}
/** The ComfyUI on this computer we can put files in (null: none, or the one in Settings is on another computer / cannot be looked into). */
export async function findComfy(d: InstallDeps): Promise<ComfyTarget | null> {
  const l = await lookupComfy(d);
  return l.kind === 'local' ? l.target : null;
}
/** Why there is no ComfyUI to set up, in plain words (null = simply not open). The Workflows page, the AI and the routes show it as it is. */
export function whyNoSetup(l: ComfyLookup): string | null {
  if (l.kind === 'blind' && !l.local) return `Your ComfyUI is on another computer (${new URL(l.url).host}). "Set it up for me" can only put files in a ComfyUI on this computer, so we left it alone. Press "Download the file" and add it in ComfyUI by hand, or change the ComfyUI address in Settings to one on this computer.`;
  if (l.kind === 'blind') return 'We can\'t look inside your ComfyUI\'s folders (it may be an old version), so we can\'t put files in it. Update ComfyUI, then press Check again.';
  if (l.kind === 'slow') return 'ComfyUI is open but is not answering right now. It may be busy loading a model. Wait a minute, then press Check again.';
  return null;
}
/** The biggest graphics card ComfyUI sees, in GB (a "8 GB" card reports 7.99 GiB: rounded). */
function vramOf(stats: any): { vramGB?: number } {
  const bytes = (Array.isArray(stats?.devices) ? stats.devices : []).filter((x: any) => x && x.type !== 'cpu' && Number(x.vram_total) > 0).map((x: any) => Number(x.vram_total));
  return bytes.length ? { vramGB: Math.round(Math.max(...bytes) / 2 ** 30) } : {};
}
/** The size to start from for this ComfyUI's graphics card (undefined = ComfyUI shows none, or less than 8 GB). */
export const suggestedTier = (t: ComfyTarget | null): TierId | undefined => (t?.vramGB ? tierFor(t.vramGB) : undefined);
/** ComfyUI's own Workflows folder (what its Workflow > Open lists), when it can be worked out and exists: <ComfyUI>/user/default/workflows,
 *  next to its models folder. The helper runs on the same computer, so this is a plain look at the disk. */
export function workflowsFolder(t: ComfyTarget): string | null {
  const ck = t.folders.checkpoints?.[0];
  if (!ck) return null;
  const user = path.join(path.dirname(path.dirname(ck)), 'user', 'default');
  try { return fs.statSync(user).isDirectory() ? path.join(user, 'workflows') : null; } catch { return null; }
}
/** The folder a model goes in: ComfyUI's first path for that type, or <models>/<type> for a type ComfyUI does not know yet (ipadapter before its node is added). */
export function folderFor(t: ComfyTarget, folder: string): string | null {
  if (!FOLDERS.includes(folder as ComfyFolder)) return null;
  const known = t.folders[folder]?.[0];
  if (known) return known;
  const ck = t.folders.checkpoints?.[0];
  return ck ? path.join(path.dirname(ck), folder) : null;
}

// ---------------------------------------------------------------- plan
export interface PlanFile { id: string; file: string; folder: string; dest: string; bytes: number; sha256: string; url: string; licence: string; page: string; state: 'download' | 'present' | 'conflict' | 'partial';
  /** Bytes still to download: all of it, what a stopped download still needs ('partial'), or 0. */
  left: number }
export interface PlanNode { id: string; name: string; repo: string; commit: string; dest: string; licence: string; state: 'install' | 'present' | 'needs-git' | 'needs-manager' }
export interface InstallPlan {
  key: string; id: string; tier: TierId; title: string; tierLabel: string;
  comfy: { url: string; version: string };
  files: PlanFile[]; nodes: PlanNode[];
  downloadBytes: number; freeBytes: number | null; enoughSpace: boolean;
  workflowName: string; restartNeeded: boolean;
  /** Plain words for the consent dialog / the AI. */
  summary: string[];
  /** Licence notices the user must see above the Yes button (a model that is not "commercial use OK"; empty for most). */
  notices: string[];
  /** Hash of everything above that matters: a consent covers exactly this plan. */
  hash: string;
  blockers: string[];
}
const gb = (n: number) => `${(n / 1e9).toFixed(n < 1e9 ? 2 : 1)} GB`;

async function statSize(p: string): Promise<number | null> { try { return (await fsp.stat(p)).size; } catch { return null; } }
function findFolderCI(parent: string, name: string): string | null {
  try { const hit = fs.readdirSync(parent).find((n) => n.toLowerCase() === name.toLowerCase()); return hit ? path.join(parent, hit) : null; } catch { return null; }
}

export async function makePlan(d: InstallDeps, t: ComfyTarget, id: string, tier: TierId, built?: BuiltWorkflow): Promise<InstallPlan> {
  const def = workflowDef(id);
  if (!def || !def.tiers[tier]) throw Object.assign(new Error(`No workflow "${id}" for ${tier}.`), { status: 404 });
  const b = built ?? buildWorkflow(def, tier, NODE_SCHEMA);
  const files: PlanFile[] = [];
  const blockers: string[] = [];
  for (const m of b.manifest.models) {
    const dir = folderFor(t, m.folder);
    if (!dir) { blockers.push(`ComfyUI has no "${m.folder}" folder.`); continue; }
    const dest = path.join(dir, m.file);
    const size = await statSize(dest);
    const part = await statSize(`${dest}.part`);
    const state: PlanFile['state'] = size === null ? (part ? 'partial' : 'download') : size === m.bytes ? 'present' : 'conflict';
    if (state === 'conflict') blockers.push(`A different file called ${m.file} is already in ComfyUI's ${m.folder} folder. Rename or move it, then try again.`);
    const left = state === 'present' || state === 'conflict' ? 0 : state === 'partial' && part! <= m.bytes ? m.bytes - part! : m.bytes;
    files.push({ id: m.id, file: m.file, folder: m.folder, dest, bytes: m.bytes, sha256: m.sha256, url: m.url, licence: m.licence, page: m.page, state, left });
  }
  const nodes: PlanNode[] = [];
  const cn = t.folders.custom_nodes?.[0];
  let gitOk: boolean | null = null;
  for (const n of b.manifest.customNodes) {
    if (!cn) { blockers.push('ComfyUI did not tell us its custom_nodes folder.'); continue; }
    const existing = findFolderCI(cn, n.folder);
    let state: PlanNode['state'] = existing ? 'present' : 'install';
    if (state === 'install' && n.pip.length) state = 'needs-manager';
    if (state === 'install') {
      gitOk ??= (await d.run('git', ['--version']).catch(() => ({ code: 1, out: '' }))).code === 0;
      if (!gitOk) state = 'needs-git';
    }
    nodes.push({ id: n.id, name: n.name, repo: n.repo, commit: n.commit, dest: existing ?? path.join(cn, n.folder), licence: n.licence, state });
  }
  const downloadBytes = files.reduce((s, f) => s + f.left, 0);
  const firstDir = files[0] ? path.dirname(files[0].dest) : t.folders.checkpoints?.[0] ?? '';
  const freeBytes = await d.freeBytes(firstDir).catch(() => null);
  const enoughSpace = freeBytes === null || freeBytes > downloadBytes + 2e9;
  if (!enoughSpace) blockers.push(`Not enough free space: this needs ${gb(downloadBytes + 2e9)} and the drive has ${gb(freeBytes!)} free.`);
  const restartNeeded = nodes.some((n) => n.state === 'install');
  const workflowName = uiFileName(def, tier);
  const summary = [
    ...files.map((f) => f.state === 'present'
      ? `Already there: ${f.file} (${gb(f.bytes)}), we check it is the right file.`
      : `${f.state === 'partial' ? 'Finish downloading' : 'Download'} ${f.file} (${f.state === 'partial' ? `${gb(f.left)} left of ${gb(f.bytes)}` : gb(f.bytes)}) from ${new URL(f.url).hostname}/${f.url.split('/').slice(3, 5).join('/')} into ComfyUI's ${f.folder} folder. Licence: ${f.licence}.`),
    ...nodes.map((n) => n.state === 'present' ? `Already there: the ${n.name} add-on.`
      : n.state === 'install' ? `Add the ${n.name} add-on from ${n.repo} (version ${n.commit.slice(0, 10)}; ${n.licence.split(' (')[0]}). Restart ComfyUI afterwards.`
        : n.state === 'needs-git' ? `The ${n.name} add-on needs Git, which isn't on this computer: add it in ComfyUI Manager instead (search "${n.name}").`
          : `Add the ${n.name} add-on yourself in ComfyUI Manager.`),
    `Add "${workflowName.replace(/\.json$/, '')}" to ComfyUI's Workflows list. If you already have one with that name, we leave yours as it is.`,
  ];
  const plan: Omit<InstallPlan, 'hash'> = {
    key: `${id}/${tier}`, id: def.id, tier, title: def.title, tierLabel: TIERS[tier].label, comfy: { url: t.url, version: t.version },
    files, nodes, downloadBytes, freeBytes, enoughSpace, workflowName, restartNeeded, summary, blockers,
    notices: b.manifest.notices ?? [],
  };
  const hash = crypto.createHash('sha256').update(JSON.stringify([plan.key, plan.comfy.url, files.map((f) => [f.dest, f.url, f.sha256, f.state]), nodes.map((n) => [n.dest, n.commit, n.state]), plan.notices])).digest('hex');
  return { ...plan, hash };
}

// ---------------------------------------------------------------- consent (single use, 2 minutes, bound to the plan)
export class InstallConsent {
  private grants = new Map<string, { hash: string; key: string; exp: number }>();
  constructor(private now: () => number, private ttlMs = 120_000) {}
  issue(plan: InstallPlan) {
    for (const [k, g] of this.grants) if (g.exp <= this.now()) this.grants.delete(k);
    if (this.grants.size > 20) this.grants.clear();
    const token = crypto.randomBytes(24).toString('base64url');
    this.grants.set(token, { hash: plan.hash, key: plan.key, exp: this.now() + this.ttlMs });
    return { token, expiresIn: Math.round(this.ttlMs / 1000) };
  }
  take(token: unknown, plan: InstallPlan): boolean {
    if (typeof token !== 'string') return false;
    const g = this.grants.get(token);
    if (!g) return false;
    this.grants.delete(token);
    return g.exp > this.now() && g.hash === plan.hash && g.key === plan.key;
  }
}

// ---------------------------------------------------------------- the job
export interface JobState {
  id: string; key: string; state: 'running' | 'done' | 'error' | 'cancelled';
  phase: string; file?: string; fileDone: number; fileTotal: number; done: number; total: number;
  log: string[]; error?: string; restartNeeded?: boolean; workflowName?: string; comfyUrl?: string; startedAt: number; endedAt?: number;
  /** The person already had a workflow of that name in ComfyUI (maybe with their own changes): it was left as it is. */
  workflowKept?: boolean;
  /** What kind of problem stopped it (set with `error`). */
  code?: SetupCode;
}

/** Stream `url` (following only Hugging Face redirects) into `dest`.part with resume, hashing every byte; rename when the hash matches. */
export async function downloadVerified(d: InstallDeps, f: { url: string; dest: string; bytes: number; sha256: string }, onBytes: (n: number) => void, signal: AbortSignal): Promise<void> {
  if (!isCatalogUrl(f.url)) throw new Error('refused: not a catalogue download');
  const part = `${f.dest}.part`;
  await fsp.mkdir(path.dirname(f.dest), { recursive: true });
  const hash = crypto.createHash('sha256');
  let have = (await statSize(part)) ?? 0;
  if (have > f.bytes) { await fsp.rm(part, { force: true }); have = 0; }
  if (have) { // hash what we already have
    for await (const chunk of fs.createReadStream(part)) { hash.update(chunk as Buffer); }
    onBytes(have);
  }
  // Every message below is shown to the user as is (the helper page's error box): plain words, what to do next.
  const name = path.basename(f.dest);
  const again = 'Check your internet, then press Try again to continue where it left off.';
  let url = f.url;
  let res: Response | null = null;
  for (let hop = 0; hop < 6; hop++) {
    res = await d.fetch(url, { redirect: 'manual', signal, headers: have ? { range: `bytes=${have}-` } : {} })
      .catch((e: Error) => { if (signal.aborted) throw e; throw new SetupError(`Couldn't reach Hugging Face for ${name} (${e.message}). ${again}`, 'offline'); });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('location');
      await res.body?.cancel().catch(() => {});
      if (!loc) throw new SetupError(`Hugging Face sent ${name} without an address. ${again}`, 'dropped');
      const next = new URL(loc, url).toString();
      if (!isAllowedRedirect(next)) throw new SetupError(`Hugging Face sent ${name} from an address we don't know (${new URL(next).hostname}), so we stopped. Try again later.`, 'other');
      url = next;
      continue;
    }
    break;
  }
  if (!res || !(res.status === 200 || res.status === 206)) throw new SetupError(`Couldn't download ${name} (Hugging Face answered ${res?.status ?? 'nothing'}). ${again}`, 'dropped');
  if (have && res.status === 200) { // server ignored the range: start over
    await res.body?.cancel().catch(() => {});
    await fsp.rm(part, { force: true });
    onBytes(-have);
    return downloadVerified(d, f, onBytes, signal);
  }
  const out = fs.createWriteStream(part, { flags: have ? 'a' : 'w' });
  let got = have;
  let tooBig = false;
  let failed: Error | null = null;
  try {
    const reader = res.body!.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > f.bytes) { tooBig = true; throw new SetupError(`${name} came out bigger than it should be, so we stopped. Try again later.`, 'checksum'); }
      hash.update(value);
      if (!out.write(value)) await new Promise<void>((r) => out.once('drain', () => r()));
      onBytes(value.byteLength);
    }
  } catch (e) {
    failed = e as Error;
  } finally {
    await new Promise<void>((r) => out.end(() => r()));
  }
  if (failed) { // the .part file is closed now: keep it to resume, unless it is wrong
    if (tooBig) { await fsp.rm(part, { force: true }); throw failed; }
    if (signal.aborted) throw failed;
    throw new SetupError(`${name} stopped downloading part way (${failed.message}). ${again}`, 'dropped');
  }
  if (got !== f.bytes) throw new SetupError(`${name} stopped downloading part way (${gb(got)} of ${gb(f.bytes)}). ${again}`, 'dropped');
  const sum = hash.digest('hex');
  if (sum !== f.sha256) { await fsp.rm(part, { force: true }); throw new SetupError(`${name} did not match its checksum, so we deleted it. Press Try again to download it again.`, 'checksum'); }
  await fsp.rename(part, f.dest);
}
export async function sha256File(p: string, onBytes: (n: number) => void, signal: AbortSignal): Promise<string> {
  const h = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(p, { highWaterMark: 4 << 20 })) {
    if (signal.aborted) throw new Error('cancelled');
    h.update(chunk as Buffer); onBytes((chunk as Buffer).length);
  }
  return h.digest('hex');
}

export async function runInstall(d: InstallDeps, plan: InstallPlan, job: JobState, signal: AbortSignal, built?: BuiltWorkflow): Promise<void> {
  const say = (s: string) => { job.log.push(s); if (job.log.length > 200) job.log.shift(); };
  if (plan.blockers.length) throw new SetupError(plan.blockers[0], /^Not enough free space/.test(plan.blockers[0]) ? 'disk' : 'blocked');
  job.total = plan.files.reduce((s, f) => s + f.bytes, 0);
  for (const f of plan.files) {
    if (signal.aborted) throw new Error('cancelled');
    job.file = f.file; job.fileDone = 0; job.fileTotal = f.bytes;
    const tick = (n: number) => { job.fileDone += n; job.done += n; };
    if (f.state === 'present') {
      job.phase = 'checking';
      say(`Checking ${f.file}`);
      const sum = await sha256File(f.dest, tick, signal);
      if (sum !== f.sha256) throw new SetupError(`The ${f.file} already in ComfyUI is a different file. Rename or move it, then try again.`, 'blocked');
      continue;
    }
    if (await statSize(f.dest) !== null) throw new SetupError(`${f.file} appeared while we were working. Try again.`, 'blocked');
    job.phase = 'downloading';
    say(`Downloading ${f.file}`);
    await downloadVerified(d, f, tick, signal);
    say(`Checked ${f.file}`);
  }
  for (const n of plan.nodes) {
    if (n.state !== 'install') continue;
    if (!GIT_REPOS.has(n.repo) || !/^[0-9a-f]{40}$/.test(n.commit)) throw new Error('refused: unknown add-on');
    job.phase = 'add-on'; job.file = n.name;
    say(`Adding ${n.name}`);
    const tmp = `${n.dest}.vtp-tmp`;
    await fsp.rm(tmp, { recursive: true, force: true });
    const clone = await d.run('git', ['clone', '--quiet', '--no-checkout', n.repo, tmp]);
    if (clone.code !== 0) throw new SetupError(`Couldn't get ${n.name} (git clone failed). Check your internet, then try again.`, 'git');
    const co = await d.run('git', ['-c', 'advice.detachedHead=false', 'checkout', '--quiet', n.commit], tmp);
    const head = await d.run('git', ['rev-parse', 'HEAD'], tmp);
    if (co.code !== 0 || head.out.trim() !== n.commit) { await fsp.rm(tmp, { recursive: true, force: true }); throw new SetupError(`${n.name} is not at the checked version, so we removed it.`, 'git'); }
    await fsp.rename(tmp, n.dest);
    job.restartNeeded = true;
  }
  // the workflow, into ComfyUI's own Workflows list. Never over a file of that name: people save their own changes over it in
  // ComfyUI (Ctrl+S), and a Yes that covers "add" does not cover "replace". Then it is theirs: say so and carry on (the models
  // are already in place, so the setup is complete).
  job.phase = 'workflow'; job.file = plan.workflowName;
  try {
    await addWorkflowToComfy(d, plan.comfy.url, workflowDef(plan.id)!, plan.tier, built, signal, { overwrite: false });
    say(`Added "${plan.workflowName}" to ComfyUI's Workflows`);
  } catch (e) {
    if (!(e instanceof SetupError && e.code === 'exists')) throw e;
    job.workflowKept = true;
    say(`"${plan.workflowName.replace(/\.json$/, '')}" was already in your ComfyUI Workflows, so we left your copy as it is.`);
  }
  job.workflowName = plan.workflowName; job.comfyUrl = plan.comfy.url;
  job.phase = 'done';
}

/** Put one workflow into ComfyUI's own Workflows list (its /api/userdata) and its starter pictures into the input folder.
 *  The last step of a setup, and "Add it to ComfyUI for me" on its own (no downloads). Returns the name it shows in ComfyUI.
 *  `overwrite: false` never replaces a file of that name: people save their own changes over it (Ctrl+S in ComfyUI), so ComfyUI
 *  is asked to refuse (409) and this throws a SetupError 'exists'. Both callers pass it: the setup keeps their file and goes on;
 *  the stand-alone button offers "Replace it with the original" (the only caller that passes `overwrite: true`). */
export async function addWorkflowToComfy(d: InstallDeps, comfyUrl: string, def: WorkflowDef, tier: TierId, built?: BuiltWorkflow, signal?: AbortSignal, o: { overwrite?: boolean } = {}): Promise<string> {
  const b = built ?? buildWorkflow(def, tier, NODE_SCHEMA);
  const fileName = uiFileName(def, tier);
  const name = encodeURIComponent(`workflows/${fileName}`);
  const r = await d.fetch(`${comfyUrl}/api/userdata/${name}?overwrite=${o.overwrite === false ? 'false' : 'true'}&full_info=true`, { method: 'POST', body: JSON.stringify(b.ui), headers: { 'content-type': 'application/json' }, signal })
    .catch((e: Error) => { if (signal?.aborted) throw e; throw new SetupError('ComfyUI closed while we were adding the workflow. Open it again, then press Check again.', 'comfy-closed'); });
  if (r.status === 409 && o.overwrite === false) throw new SetupError(`"${fileName.replace(/\.json$/, '')}" is already in your ComfyUI list. We left it as it is, so your changes are safe.`, 'exists');
  if (!r.ok) throw new SetupError(`ComfyUI did not accept the workflow (HTTP ${r.status}). Update ComfyUI, then try again.`, 'workflow-refused');
  // starter pictures for the Load Image boxes (only if missing)
  const wanted = new Set(b.manifest.inputs.filter((i) => i.kind === 'image').map((i) => i.default));
  for (const [rel, buf] of Object.entries(packBinaryFiles())) {
    const fname = path.basename(rel);
    if (!wanted.has(fname)) continue;
    const have = await d.fetch(`${comfyUrl}/api/view?filename=${encodeURIComponent(fname)}&type=input`, { signal }).then((x) => x.ok).catch(() => false);
    if (have) continue;
    const fd = new FormData();
    fd.append('image', new Blob([new Uint8Array(buf)], { type: 'image/png' }), fname);
    fd.append('type', 'input');
    fd.append('overwrite', 'false');
    await d.fetch(`${comfyUrl}/api/upload/image`, { method: 'POST', body: fd, signal }).catch(() => null);
  }
  return fileName;
}

/** Every job list the routes made. The updater asks before it restarts the helper: a restart mid-download loses the job
 *  (the .part files stay, so Yes continues, but the page would be left waiting). */
const RUNNERS = new Set<InstallJobs>();
export const comfySetupRunning = () => [...RUNNERS].some((j) => !!j.running());

export class InstallJobs {
  private jobs = new Map<string, { s: JobState; ac: AbortController }>();
  constructor(private d: () => InstallDeps) { RUNNERS.add(this); }
  running() { return [...this.jobs.values()].find((j) => j.s.state === 'running')?.s ?? null; }
  get(id: string) { return this.jobs.get(id)?.s ?? null; }
  start(plan: InstallPlan): JobState {
    if (this.running()) throw Object.assign(new Error('Another setup is still running. Wait for it to finish.'), { status: 409 });
    const deps = this.d();
    const s: JobState = { id: crypto.randomBytes(8).toString('hex'), key: plan.key, state: 'running', phase: 'starting', fileDone: 0, fileTotal: 0, done: 0, total: 0, log: [], startedAt: deps.now() };
    const ac = new AbortController();
    this.jobs.set(s.id, { s, ac });
    if (this.jobs.size > 20) { const old = [...this.jobs.entries()].find(([, j]) => j.s.state !== 'running'); if (old) this.jobs.delete(old[0]); }
    runInstall(deps, plan, s, ac.signal)
      .then(() => { s.state = 'done'; })
      .catch((e: Error) => {
        s.state = ac.signal.aborted ? 'cancelled' : 'error';
        s.error = ac.signal.aborted ? 'Stopped. Press Try again to continue where it left off.' : e.message;
        s.code = ac.signal.aborted ? 'stopped' : e instanceof SetupError ? e.code : 'other';
      })
      .finally(() => { s.endedAt = deps.now(); });
    return s;
  }
  cancel(id: string) { const j = this.jobs.get(id); if (j && j.s.state === 'running') j.ac.abort(); return !!j; }
}

// ---------------------------------------------------------------- real deps
export function realInstallDeps(comfyUrl: () => string | undefined): InstallDeps {
  return {
    fetch: (...a) => fetch(...a),
    run: (cmd, args, cwd) => new Promise((res) => {
      if (cmd !== 'git') { res({ code: 1, out: 'refused' }); return; }
      execFile('git', args, { cwd, timeout: 10 * 60_000, windowsHide: true, shell: false, maxBuffer: 1 << 20, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } },
        (err, stdout, stderr) => res({ code: err ? (typeof (err as { code?: unknown }).code === 'number' ? (err as { code: number }).code : 1) : 0, out: `${stdout}${stderr}` }));
    }),
    now: () => Date.now(),
    freeBytes: async (dir) => {
      let p = dir;
      while (p && !fs.existsSync(p)) { const up = path.dirname(p); if (up === p) break; p = up; }
      try { const s = await fsp.statfs(p); return s.bavail * s.bsize; } catch { return null; }
    },
    comfyUrl,
  };
}
