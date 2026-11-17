// AI creation packages ("vtube-pro.creation/1", docs/AI_CONNECT.md): validate -> (inbox) -> build locally -> validate -> install.
// Any AI (with or without MCP) can return a package; the user pastes / drops it on the AI connectors page, or an MCP client
// calls install_creation_package (python scope = approval click). Rooms install into assets/scenes/<id>/ file by file
// (never folder renames - the live server watches assets/); a modified room is backed up to cache/aiconnect/backups first.
// The Python checker (validate_room, validate_creation_package, the inbox, an install's stage + final check) never runs on
// the helper's event loop: that loop also relays every tracking frame from the studio to the OBS page (src/bus.ts -> /ws),
// and the spawnSync it used to run under held the bus for 163-447 ms per call (b10). Not even its START runs there: on
// Windows spawn() itself holds the loop for the whole process start (60-250 ms on a busy PC, b10 review), so runPy starts
// it on server/spawnOffLoop.ts's worker thread. See runPy / py below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { findBlenderAsync, runBlender } from './blender.ts';
import { startJob } from './jobs.ts';
import { CACHE_DIR, ROOT, USER_SCENES_DIR } from './paths.ts';
import { deepMerge } from './mcpTools.ts';
import { installedRoomDir } from './roomList.ts';
import { runOffLoop } from './spawnOffLoop.ts';
import { ROOM_FOLDER, baseRoomId } from '../shared/roomId.ts';

export const SCENES_DIR = USER_SCENES_DIR; // user rooms: the per-user data folder in a release (server/paths.ts)
const WORK = path.join(CACHE_DIR, 'aiconnect');
const TOOL = path.join(ROOT, 'tools', 'aiconnect_package.py');
export const COMFY_WORKFLOW = path.join(ROOT, 'tools', 'comfy', 'vtp_texture_sdxl.json');
export interface Report { ok: boolean; errors: { msg: string; fix: string }[]; warnings: { msg: string; fix: string }[]; stats: Record<string, unknown> }

/** The Python inside a Blender install (<blender dir>/<x.y>/python/bin/python[.exe], macOS: Blender.app/Contents/
 *  Resources/<x.y>/…), newest version folder first; null = none. The validator is standard-library only, so it runs on
 *  that Python: rooms need Blender anyway, and most people have no Python of their own. */
export function blenderPython(blenderExe: string | null): string | null {
  if (!blenderExe) return null;
  const dir = path.dirname(blenderExe);
  for (const root of [dir, path.join(dir, '..', 'Resources')]) {
    let vers: string[];
    try { vers = fs.readdirSync(root).filter((d) => /^\d+\.\d+$/.test(d)); } catch { continue; }
    vers.sort((a, b) => { const [x1, y1] = a.split('.').map(Number), [x2, y2] = b.split('.').map(Number); return x2 - x1 || y2 - y1; });
    for (const v of vers) {
      const bin = path.join(root, v, 'python', 'bin');
      let names: string[];
      try { names = fs.readdirSync(bin); } catch { continue; }
      const pick = names.find((n) => /^python(\.exe)?$/i.test(n)) ?? names.find((n) => /^python3(\.\d+)?(\.exe)?$/i.test(n));
      if (pick) return path.join(bin, pick);
    }
  }
  return null;
}

/** How long one checker run may take before it is stopped (ms; the old spawnSync limit). */
export const PY_TIMEOUT_MS = 60_000;
/** One Python run: what it printed, or why it did not run. */
export interface PyRun { stdout: string; stderr: string; code: number | null; error?: string; timedOut: boolean }
/** Run `exe args` as its own process WITHOUT holding the event loop: started, watched and stopped on the off-loop worker
 *  thread (server/spawnOffLoop.ts runOffLoop; never spawnSync, and never spawn() on this thread either), at below-normal
 *  priority, stopped after `timeoutMs`. Never rejects: a Python that is missing (ENOENT), the Microsoft Store stub or a
 *  crash comes back as a run without JSON, like spawnSync's result did. */
export async function runPy(exe: string, args: string[], timeoutMs = PY_TIMEOUT_MS): Promise<PyRun> {
  const r = await runOffLoop(exe, args, { timeoutMs });
  return { stdout: r.stdout.toString('utf8'), stderr: r.stderr, code: r.code, error: r.error, timedOut: r.timedOut };
}

// One checker at a time (an AI looping over validate_room, an install's final check): the next one waits its turn.
let pyQueue: Promise<unknown> = Promise.resolve();
let pyRunning = 0;
/** Checker runs started or waiting right now (for tools/aipackage_offloop_unit.ts). */
export const pyInFlight = () => pyRunning;

/** Run the package / room validator: VTP_PYTHON, else the PC's own Python, else the Python inside Blender. (A release used
 *  to need a Python of the user's own, and didn't even ship the validator: every room package failed — owner 2026-10-02.)
 *  Off the event loop (runPy), one run at a time; Blender's Python is only looked for (findBlenderAsync) when the others
 *  gave no answer. */
async function py(args: string[], timeoutMs = PY_TIMEOUT_MS): Promise<Report> {
  const fail = (msg: string, fix: string): Report => ({ ok: false, errors: [{ msg, fix }], warnings: [], stats: {} });
  if (!fs.existsSync(TOOL)) return fail('the room package checker is missing from this install', 'Check that the VTube Pro folder is complete, then try again.');
  pyRunning++;
  const go = async (): Promise<Report> => {
    let last = '';
    const tried = new Set<string>();
    const attempt = async (exe: string | null | undefined): Promise<Report | null> => {
      if (!exe || tried.has(exe)) return null;
      tried.add(exe);
      const r = await runPy(exe, [TOOL, ...args], timeoutMs);
      try { return JSON.parse(r.stdout) as Report; } catch { /* not this one: missing, the Microsoft Store stub, too old ... */ }
      last = (r.stderr || r.error || (r.timedOut ? `stopped after ${Math.round(timeoutMs / 1000)} s` : '')).slice(0, 300);
      return null;
    };
    for (const exe of [process.env.VTP_PYTHON, 'python', process.platform === 'win32' ? null : 'python3']) {
      const rep = await attempt(exe);
      if (rep) return rep;
    }
    const rep = await attempt(blenderPython(await findBlenderAsync()));
    return rep ?? fail(`the room package checker couldn't run (${last || 'no Python found'})`, 'Install Blender (free): VTube Pro runs the checker with the Python inside it.');
  };
  const p = pyQueue.then(go, go);
  pyQueue = p.catch(() => {});
  try { return await p; } finally { pyRunning--; }
}
async function tmpJson(v: unknown): Promise<string> {
  await fs.promises.mkdir(path.join(WORK, 'tmp'), { recursive: true });
  const f = path.join(WORK, 'tmp', `${crypto.randomUUID()}.json`);
  await fs.promises.writeFile(f, JSON.stringify(v));
  return f;
}

export async function validatePackage(pkg: unknown): Promise<Report> {
  const f = await tmpJson(pkg);
  try {
    const r = await py(['package', f]);
    const p = pkg as { id?: string; action?: string };
    if (r.ok && p?.id) {
      const exists = fs.existsSync(path.join(SCENES_DIR, p.id, 'scene.json'));
      if ((p.action ?? 'create') === 'create' && exists) r.errors.push({ msg: `a room "${p.id}" is already installed`, fix: 'Pick a new id, or use "action": "modify" to change that room.' });
      if (p.action === 'modify' && !exists) r.errors.push({ msg: `no installed room "${p.id}" to modify`, fix: 'Use list_rooms for the ids, or "action": "create".' });
      r.ok = !r.errors.length;
    }
    return r;
  } finally { await fs.promises.rm(f, { force: true }); }
}
/** validate_room: any installed room (the user's, a shipped one, a linked one: server/roomList.ts installedRoomDir). An
 *  area id from list_rooms (`<room>~<area>`) checks its room; the validator checks every area of a room with areas. */
export const validateRoom = async (roomId: string): Promise<Report> => {
  const fail = (msg: string, fix: string): Report => ({ ok: false, errors: [{ msg, fix }], warnings: [], stats: {} });
  const id = baseRoomId(String(roomId ?? ''));
  if (!ROOM_FOLDER.test(id)) return fail('bad room id', 'Use an id from list_rooms.');
  const dir = installedRoomDir(id);
  if (!dir) return fail(`no installed room "${id}"`, 'Use an id from list_rooms (the part before "~" for an area).');
  return py(['room', dir]);
};

// ---------------------------------------------------------------- inbox (packages waiting for the user's Build click)
const INBOX = path.join(WORK, 'inbox');
export async function addToInbox(pkg: any, from: string) {
  const v = await validatePackage(pkg);
  fs.mkdirSync(INBOX, { recursive: true });
  const id = `${Date.now()}_${String(pkg?.id ?? 'package').replace(/[^a-z0-9_]/g, '')}`;
  fs.writeFileSync(path.join(INBOX, `${id}.json`), JSON.stringify({ from, receivedAt: new Date().toISOString(), validation: v, package: pkg }, null, 2));
  return { inboxId: id, validation: v, next: 'The user clicks Build on the AI connectors page (Settings -> AI connectors).' };
}
export function listInbox() {
  if (!fs.existsSync(INBOX)) return [];
  return fs.readdirSync(INBOX).filter((f) => f.endsWith('.json')).sort().reverse().slice(0, 30).map((f) => {
    const j = JSON.parse(fs.readFileSync(path.join(INBOX, f), 'utf8'));
    return { inboxId: f.replace(/\.json$/, ''), from: j.from, receivedAt: j.receivedAt, id: j.package?.id, name: j.package?.scene?.name, action: j.package?.action ?? 'create', ok: j.validation?.ok };
  });
}
export function readInbox(inboxId: string) {
  if (!/^[\w-]+$/.test(inboxId)) throw new Error('bad inbox id');
  return JSON.parse(fs.readFileSync(path.join(INBOX, `${inboxId}.json`), 'utf8')).package;
}

// ---------------------------------------------------------------- ComfyUI (local textures)
export async function comfyTexture(prompt: string, comfyUrl: string, out: string, fetchImpl: typeof fetch = fetch, pollMs = 1500) {
  const wf = JSON.parse(fs.readFileSync(COMFY_WORKFLOW, 'utf8'));
  for (const node of Object.values<any>(wf)) {
    if (node.class_type === 'CLIPTextEncode' && node._meta?.title === 'positive') node.inputs.text = `${prompt}, seamless tileable texture, flat even lighting, top-down, stylized`;
    if (node.class_type === 'KSampler') node.inputs.seed = Math.floor(Math.random() * 2 ** 31);
  }
  const base = comfyUrl.replace(/\/+$/, '');
  const r = await fetchImpl(`${base}/prompt`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ prompt: wf, client_id: 'vtube-pro' }) });
  if (!r.ok) throw new Error(`ComfyUI refused the workflow (HTTP ${r.status}): ${(await r.text()).slice(0, 300)} - are the models from docs/AI_CONNECT.md "Local setup" installed?`);
  const { prompt_id } = (await r.json()) as { prompt_id: string };
  for (let i = 0; i < 400; i++) {
    const h = (await (await fetchImpl(`${base}/history/${prompt_id}`)).json()) as Record<string, any>;
    const outs = h?.[prompt_id]?.outputs;
    const img = outs && (Object.values<any>(outs).find((o) => o.images?.length)?.images?.[0] as { filename: string; subfolder: string; type: string } | undefined);
    if (img) {
      const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
      const v = await fetchImpl(`${base}/view?${q}`);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      fs.writeFileSync(out, Buffer.from(await v.arrayBuffer()));
      return out;
    }
    await new Promise((res) => setTimeout(res, pollMs));
  }
  throw new Error('ComfyUI did not finish in time');
}

// ---------------------------------------------------------------- build + install
function copyFileAtomic(src: string, dst: string) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  const tmp = `${dst}.vtp_tmp`;
  fs.copyFileSync(src, tmp);
  fs.renameSync(tmp, dst);
}
const walk = (d: string): string[] => (fs.existsSync(d) ? fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])) : []);

export async function installPackage(pkg: any, comfyUrl: string) {
  const v = await validatePackage(pkg);
  if (!v.ok) throw Object.assign(new Error(`Package is not valid: ${v.errors.map((e) => e.msg).join('; ')}`), { status: 400 });
  return startJob('aiconnect-room', async (ctx) => {
    const id: string = pkg.id;
    const modify = pkg.action === 'modify';
    const work = path.join(WORK, 'builds', `${id}_${Date.now()}`);
    const out = path.join(work, 'out');
    fs.mkdirSync(out, { recursive: true });
    // (the stage step runs on the same off-loop checker: the Python that answers, Blender's too; never spawnSync)
    const f = await tmpJson(pkg);
    try { const s = await py(['stage', f, work]); if (!s.ok) throw new Error(s.errors.map((e) => e.msg).join('; ') || 'staging the package failed'); } finally { await fs.promises.rm(f, { force: true }); }
    ctx.log(`Staged "${id}" (${modify ? 'modify' : 'new room'}) in ${work}`);
    const assets = (pkg.assets ?? []) as { path: string; source: string; prompt?: string }[];
    for (const [i, a] of assets.entries()) {
      if (a.source !== 'comfy') continue;
      ctx.log(`ComfyUI texture ${i + 1}: ${a.path} - "${a.prompt}"`);
      await comfyTexture(a.prompt!, comfyUrl, path.join(work, 'assets', a.path));
      ctx.progress(0.1 + (0.3 * (i + 1)) / assets.length);
    }
    const room = path.join(SCENES_DIR, id);
    ctx.log('Building in Blender (headless)...');
    const r = await runBlender(path.join(work, 'build.py'), [], {
      env: { VTP_OUT: out, VTP_ASSETS: path.join(work, 'assets'), VTP_ROOM_ID: id, VTP_BASE_GLB: modify ? path.join(room, 'scene.glb') : '' },
      onLine: (l: string) => { if (/^(STEP|ROOM_OK|VTP_)/.test(l)) ctx.log(l); },
    } as any);
    if (!fs.existsSync(path.join(out, 'scene.glb'))) throw new Error(`The build did not write scene.glb.${r.traceback ? `\n${r.traceback}` : r.error ? ` ${r.error}` : ''}\n${(r.stdout ?? '').slice(-1500)}`);
    ctx.progress(0.7);
    // scene.json: create = package scene; modify = existing deep-merged with the patch (hand-added keys survive)
    const existing = modify && fs.existsSync(path.join(room, 'scene.json')) ? JSON.parse(fs.readFileSync(path.join(room, 'scene.json'), 'utf8')) : {};
    const scene = { model: 'scene.glb', modes: ['talk', 'react'], defaultCamera: 'CAM_WIDE', ...(deepMerge(existing, pkg.scene ?? {}) as object), id };
    fs.writeFileSync(path.join(out, 'scene.json'), JSON.stringify(scene, null, 2));
    for (const a of walk(path.join(work, 'assets'))) copyFileAtomic(a, path.join(out, path.relative(path.join(work, 'assets'), a)));
    fs.mkdirSync(path.join(out, 'blender'), { recursive: true });
    fs.copyFileSync(path.join(work, 'build.py'), path.join(out, 'blender', `build_${id}.py`));
    const report = await py(['room', out]);
    fs.writeFileSync(path.join(ctx.dir, 'validation.json'), JSON.stringify(report, null, 2));
    for (const e of report.errors) ctx.log(`ERROR: ${e.msg} -> fix: ${e.fix}`);
    for (const w of report.warnings) ctx.log(`warning: ${w.msg} -> ${w.fix}`);
    if (!report.ok) throw new Error('The built room failed validation (see the log / validation.json); nothing was installed.');
    if (modify) {
      const bak = path.join(WORK, 'backups', `${id}_${new Date().toISOString().replace(/[:.]/g, '-')}`);
      for (const fl of walk(room)) copyFileAtomic(fl, path.join(bak, path.relative(room, fl)));
      ctx.log(`Backed up the old room to ${bak}`);
    }
    for (const fl of walk(out)) copyFileAtomic(fl, path.join(room, path.relative(out, fl)));
    ctx.progress(1);
    ctx.log(`Installed assets/scenes/${id}. Scene tab -> Room (Rescan scenes if it is not listed).`);
    return { roomId: id, validation: report, installedTo: room } as any;
  }, { kind: 'room', prompt: pkg.scene?.name ?? pkg.id });
}
