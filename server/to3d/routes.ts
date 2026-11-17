// Pro2D → 3D HTTP routes (lane to3d, docs/PRO2D_TO_3D.md). Three audiences:
//   the drawer (src/ui/to3dPanel.ts): readiness, start a job, its progress, stop, delete
//     GET  /api/to3d/readiness?app=          POST /api/to3d/jobs {avatarId, app, consent}   GET /api/to3d/jobs[/:id]
//     POST /api/to3d/jobs/:id/stop           DELETE /api/to3d/jobs/:id                      GET /api/to3d/jobs/:id/picture/:name
//     GET  /api/to3d/avatar/:id  (may this avatar be converted?)
//   this computer only (installs, configs, files, the AI's tools):
//     GET  /api/to3d/fix/plan?actions=       POST /api/to3d/fix {action, token}   POST /api/to3d/bases/user (a VRM) | {avatarId}
//     /api/to3d/ai/...  (server/to3d/mcpTools.ts)   GET /api/to3d/pack?jobId=
//   the render page (a one-time token): /api/to3d/render/:t/{plan,model,shot,done}
// Approvals (to3d_open_blender, to3d_submit) use the existing queue WITHOUT blocking: the call answers waiting_for_ok
// at once, the helper acts when the user clicks Approve, the AI sees the result on its next poll.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import express, { Router, type Request } from 'express';
import { buildPack, type PackJob } from '../../shared/to3d/pack.ts';
import { CHECKLIST, ANGLES, TO3D_LIMITS, bestRound, handInRound, lastRound, nextStep, publicJob, roundOf, submitProblem, type To3dJob } from '../../shared/to3d/job.ts';
import { validateOverrides } from '../../shared/to3d/overrides.ts';
import { blenderToolMap, COMMUNITY, OFFICIAL, type McpKind } from '../../shared/to3d/blenderMcp.ts';
import { claudeDeepLink, PAUSE_NOTE, resumePrompt, startPrompt, startSteps } from '../../shared/to3d/prompt.ts';
import type { AppId } from '../../shared/to3d/readiness.ts';
import { readVtp2 } from '../../shared/rig2d/container.ts';
import { RIG_NO_CHANGES, rigNoChanges, wasLive2D } from '../../shared/rig2d/rigEdit.ts';
import { requestApproval, POLL_APPROVAL_TIMEOUT_MS } from '../aiconnect.ts';
import { setupDesktop } from '../aiConnectors.ts';
import { blenderInfo, findBlenderAsync } from '../blender.ts';
import { createAvatar, getProfile, HttpError, resolveAvatarFile, userDir } from '../library.ts';
import { sendAbsolute } from '../routes/util.ts';
import { clearUserBase, setUserBase, userBase } from './bases.ts';
import { prefsGuard, cachedTools, installCommunity, installOfficial, listServerTools, openBlender, registerCommunity, unregisterOurs, appServers, saveTools } from './blenderMcp.ts';
import { helperCaller } from '../aiAddons.ts';
import { installKit, installUv, kitPlan, kitStatus, kitUvx, realKitDeps, UV_PINS, UV_VERSION } from './kit.ts';
import { liveNow } from './live.ts';
import { cleanupOrphans, doneShots, planOf, saveShot, sessionOf } from './render.ts';
import { getMcpChoice, readiness, resolveUvx, setMcpChoice, to3dEnabled } from './readiness.ts';
import { killJob, planRebuild, prepare, revertTo, startCheck, startRound } from './runner.ts';
import { HIDE_MAX_CHARS, PART_MAX_BYTES, checkDir, createJob, deleteJob, jobPaths, listJobs, loadJob, newJobId, roundDir, saveJob, TO3D_DIR, validJobId, withJob } from './store.ts';
import { codePng } from './visionPng.ts';
import { blenderEntries } from '../../shared/to3d/blenderMcp.ts';


const appOf = (v: unknown): AppId => (v === 'chatgpt' ? 'chatgpt' : 'claude');
const clientOf = (req: Request) => String(req.headers['x-vtp-mcp-client'] ?? 'AI app').slice(0, 80);
function need(cond: unknown, status: number, msg: string): asserts cond { if (!cond) throw new HttpError(status, msg); }
const enabledOr403 = () => need(to3dEnabled(), 403, '3D versions are switched off on this computer (settings: to3d.enabled).');
const jobOr404 = (id: string) => { const j = validJobId(id) ? loadJob(id) : null; need(j, 404, 'There is no such 3D job (it may have been deleted).'); return j!; };

// ---------------------------------------------------------------- may this avatar be converted?
export async function avatarEligibility(avatarId: string): Promise<{ ok: boolean; why: string | null; file: string | null; rights: unknown; sampleNote: boolean; name: string }> {
  const p = getProfile(avatarId);
  if (!p) return { ok: false, why: 'That avatar isn\'t in your library.', file: null, rights: null, sampleNote: false, name: '' };
  if (p.flat?.kind !== 'rig2d') return { ok: false, why: 'Only Pro2D avatars can be turned into 3D here.', file: null, rights: null, sampleNote: false, name: p.name };
  const file = resolveAvatarFile(avatarId, p.flat.main);
  if (!file || !fs.existsSync(file)) return { ok: false, why: 'This avatar\'s 2D model file is missing.', file: null, rights: null, sampleNote: false, name: p.name };
  const r = await readVtp2(new Uint8Array(await fsp.readFile(file)), (d) => new Uint8Array(zlib.inflateRawSync(d)));
  if (!r.ok) return { ok: false, why: `This 2D model can't be read (${r.error}).`, file: null, rights: null, sampleNote: false, name: p.name };
  const meta = r.pkg.doc.meta;
  if (rigNoChanges(meta)) return { ok: false, why: RIG_NO_CHANGES, file, rights: meta.rights, sampleNote: false, name: p.name };
  // (a Live2D sample model stays one after it was edited and saved in the 2D avatar maker: wasLive2D)
  const sampleNote = wasLive2D(meta) && /^(hiyori|mao|mark|natori|haru|rice|wanko|miara|ren|epsilon|shizuku|hibiki|koharu|haruto|tororo|hijiki|kei|chitose|izumi|simple)/i.test(`${meta.source?.file ?? ''} ${meta.name}`);
  return { ok: true, why: null, file, rights: meta.rights ?? null, sampleNote, name: p.name };
}

// ---------------------------------------------------------------- consent (the aiskills pattern, server/aiAddons.ts)
// Every install / config write / program start: from this PC's helper page or the local studio only (helperCaller: never
// another website), sent by a real click (x-vtp-user-action: 1), and installs + config
// writes also carry {consent: true} and a one-time token the consent sheet got right after the tick: bound to the
// actions on the sheet and the page's origin, 2 minutes, each action usable once.
const tokens = new Map<string, { actions: string[]; origin: string; until: number }>();
const USER_ACTION = 'x-vtp-user-action';
const CONSENT_TTL_MS = 120_000;
const FIX_ACTIONS = /^(install:kit|install:uv|install:blender|install:mcp:(community|official)|register:mcp:(community|official):(claude|chatgpt)|unregister:mcp:(claude|chatgpt)|connect:(claude|chatgpt)|open:blender|bases:clear-user|mcp:choose:(community|official)|recheck)$/;
export const NEEDS_TOKEN = /^(install:|register:|unregister:|connect:)/;
const userClick = (req: Request) => req.headers[USER_ACTION] === '1';
const originOf = (req: Request) => String(req.headers.origin ?? '');
const uvPlanItem = (action: string) => {
  const pin = UV_PINS[`${process.platform}-${process.arch}`];
  return { action, what: `uv ${UV_VERSION}, the small program that starts the Blender MCP (into VTube Pro's own folder; nothing else on your computer changes)`, from: 'github.com/astral-sh/uv', mb: pin ? Math.round(pin.bytes / 1e6) : 20 };
};
async function planFor(actions: string[]) {
  const items: { action: string; what: string; from: string; mb: number | null }[] = [];
  // the community Blender MCP needs uv: when none is found, it comes first (same consent sheet), about 20 MB
  const needUv = actions.includes('install:uv') || (actions.some((a) => a === 'install:mcp:community' || a === 'register:mcp:community:claude' || a === 'register:mcp:community:chatgpt')
    && !actions.includes('install:kit') && !(await resolveUvx()).path);
  if (needUv && !actions.includes('install:kit')) items.push(uvPlanItem('install:uv'));
  for (const a of [...new Set(actions)]) {
    if (a === 'install:uv') continue;
    if (a === 'install:kit') for (const k of kitPlan()) items.push({ action: a, what: k.what, from: k.from, mb: k.mb });
    else if (a === 'install:blender') items.push({ action: a, what: 'Blender (free, open source)', from: 'blender.org, through the Tools page installer', mb: 400 });
    else if (a === 'install:mcp:community') items.push({ action: a, what: `${COMMUNITY.label} ${COMMUNITY.version} (Blender add-on + its server; usage data switched off; safe mode on)`, from: `pypi.org + ${COMMUNITY.home.replace(/^https?:\/\//, '')}`, mb: 30 });
    else if (a === 'install:mcp:official') items.push({ action: a, what: `${OFFICIAL.label} ${OFFICIAL.version}. Blender's own words: "${OFFICIAL.warning}"`, from: 'projects.blender.org/lab/blender_mcp', mb: Math.round((OFFICIAL.zipBytes + OFFICIAL.mcpbBytes) / 1e6) });
    else if (a.startsWith('unregister:mcp')) items.push({ action: a, what: `Take the Blender MCP VTube Pro added out of ${a.endsWith('chatgpt') ? 'ChatGPT / Codex' : 'Claude'}'s settings, so only yours is left (a backup is kept)`, from: 'this computer', mb: null });
    else if (a.startsWith('register:mcp')) items.push({ action: a, what: `Add the Blender MCP to ${a.endsWith('chatgpt') ? 'ChatGPT / Codex' : 'Claude'}'s settings (a backup is kept). Blender will run Python your AI writes, on this computer.`, from: 'this computer', mb: null });
    else if (a.startsWith('connect:')) items.push({ action: a, what: `Add VTube Pro to ${a.endsWith('chatgpt') ? 'ChatGPT / Codex' : 'Claude'}'s settings (a backup is kept)`, from: 'this computer', mb: null });
  }
  return items;
}

// ---------------------------------------------------------------- the AI's view of a job
async function aiJob(j: To3dJob) {
  const P = jobPaths(j.id);
  const live = await liveNow();
  const kind = getMcpChoice();
  const listed = cachedTools();
  const map = blenderToolMap(listed?.kind ?? kind, listed?.kind === kind ? listed.tools : null);
  const ready = await readiness(j.client ?? undefined);
  return {
    job: { ...j, notes: j.notes.slice(-20) },
    nextStep: nextStep(j),
    paths: { work: P.work, parts: P.parts, blend: P.blend },
    readiness: { live: live.live, liveWhy: live.why, blenderMcp: { kind, running: ready.mcpRunning === kind, tools: map } },
    checklist: CHECKLIST, angles: ANGLES, limits: TO3D_LIMITS,
  };
}

const packJobOf = async (j: To3dJob): Promise<PackJob> => {
  const kind = getMcpChoice();
  const listed = cachedTools();
  const map = blenderToolMap(kind, listed?.kind === kind ? listed.tools : null);
  const running = (await readiness(j.client ?? undefined)).mcpRunning;
  const reg = blenderEntries(appServers(j.client ?? 'claude')).length;
  const P = jobPaths(j.id);
  return { id: j.id, avatarName: j.avatarName, route: j.route, phase: j.phase, best: j.best, rounds: j.rounds.length, base: { kind: j.base.kind, key: j.base.key },
    blenderMcp: reg || running ? { kind, ...map } : null, paths: { work: P.work, parts: P.parts, blend: P.blend } };
};

function vrmOf(id: string, n: number): string {
  const rd = roundDir(id, n);
  const prof = JSON.parse(fs.readFileSync(path.join(rd, 'profile.json'), 'utf8')) as { modelFile: string };
  return path.join(rd, prof.modelFile);
}

/** The approved round becomes a NEW library avatar (never worn). */
async function importRound(id: string, n: number): Promise<string> {
  const j = jobOr404(id);
  const rd = roundDir(id, n);
  const prof = JSON.parse(await fsp.readFile(path.join(rd, 'profile.json'), 'utf8')) as Record<string, unknown> & { modelFile: string; creator?: Record<string, unknown> };
  const { id: _i, name: _n, modelFile: _m, ...extra } = prof;
  void _i; void _n; void _m;
  const p = await createAvatar({ name: `${j.avatarName} (3D)`.slice(0, 80), source: 'import', modelFrom: path.join(rd, prof.modelFile), modelFile: 'model.vrm',
    extra: { ...extra, rig: { ...((extra.rig as object) ?? {}), kind: 'vrm' }, creator: { ...(prof.creator ?? {}), to3dJob: id, from2d: j.avatarId } } as never });
  const ref = path.join(userDir(p.id), 'live2d_ref');
  await fsp.mkdir(ref, { recursive: true });
  for (const f of ['front.png', 'head.png', 'head_turnL.png', 'head_turnR.png']) {
    const s = path.join(jobPaths(id).refs, f);
    if (fs.existsSync(s)) await fsp.copyFile(s, path.join(ref, f));
  }
  const an = path.join(rd, 'l2d', 'analysis.json');
  if (fs.existsSync(an)) await fsp.copyFile(an, path.join(ref, 'analysis.json'));
  return p.id;
}

/** The uvx to install / register the community Blender MCP with: the one found anywhere (absolute path: apps started
 *  from a menu don't see PATH), else uv alone is fetched now (it was on the consent sheet: planFor). */
async function uvxOrGet(): Promise<string> {
  const found = (await resolveUvx()).path;
  if (found) return found;
  const r = await installUv(realKitDeps());
  const uvx = kitUvx();
  need(r.ok && uvx, 409, r.error ?? 'uv could not be installed. Press Try again.');
  return uvx!;
}

// ---------------------------------------------------------------- the router
export function createTo3dRoutes(): Router {
  const r = Router();
  const json = express.json({ limit: '2mb' });

  // ---- the drawer
  r.get('/api/to3d/readiness', async (req, res) => {
    // ?fresh=1 ("Check again"): read the Windows PATH again right now
    const out = await readiness(req.query.app === 'chatgpt' || req.query.app === 'claude' ? req.query.app : null, req.query.fresh === '1');
    res.setHeader('Cache-Control', 'no-store');
    res.json({ ...out, pause: PAUSE_NOTE, privacy: 'Pictures of your model and its rig details go to Anthropic (Claude) or OpenAI (ChatGPT) as part of your chat with them. VTube Pro doesn\'t upload anything itself.' });
  });
  r.get('/api/to3d/avatar/:id', async (req, res) => {
    const e = await avatarEligibility(String(req.params.id));
    res.json({ ok: e.ok && to3dEnabled(), why: !to3dEnabled() ? '3D versions are switched off on this computer.' : e.why, sampleNote: e.sampleNote, name: e.name, jobs: listJobs().filter((j) => j.avatarId === req.params.id).map(publicJob) });
  });
  r.post('/api/to3d/jobs', json, async (req, res) => {
    enabledOr403();
    need(userClick(req), 400, 'Press Start on the page.');
    const b = (req.body ?? {}) as { avatarId?: string; app?: string; consent?: { ownership?: boolean } };
    need(b.consent?.ownership === true, 400, 'Tick "This is my model, or its artist allows me to make a 3D version of it." first.');
    const e = await avatarEligibility(String(b.avatarId ?? ''));
    need(e.ok && e.file, 409, e.why ?? 'This avatar can\'t be converted.');
    const app = appOf(b.app);
    const id = newJobId();
    const ub = userBase();
    const sha = crypto.createHash('sha256').update(await fsp.readFile(e.file!)).digest('hex');
    const now = Date.now();
    const j: To3dJob = {
      id, version: 1, avatarId: String(b.avatarId), avatarName: e.name, vtp2Sha256: sha, createdAt: now, updatedAt: now, client: app,
      consent: { ownership: true, at: now, rightsNote: e.rights ? JSON.stringify(e.rights) : null, sampleNote: e.sampleNote },
      base: ub ? { kind: 'user', key: 'user', file: ub.file } : { kind: 'auto', key: null, file: null },
      route: 'vtp2', phase: 'created', step: null, error: null, rounds: [], best: null, current: null, notes: [], knownGaps: [],
      lastToolCallAt: null, lastClient: null, baselineDoneAt: null, approval: null, submitted: null, vision: null,
      ...(Number(process.env.VTP_TO3D_MAX_ROUNDS) > 0 ? { maxRounds: Number(process.env.VTP_TO3D_MAX_ROUNDS) } : {}),
    };
    createJob(j);
    await fsp.copyFile(e.file!, jobPaths(id).src);
    void prepare(id);
    void discoverBlenderTools(app);
    const prompt = startPrompt(id, e.name);
    const link = app === 'claude' ? claudeDeepLink(prompt) : null;
    res.json({ job: publicJob(j), prompt, deepLink: link, steps: startSteps(app, !!link), pause: PAUSE_NOTE[app] });
  });
  r.get('/api/to3d/jobs', (req, res) => { res.json(listJobs().filter((j) => !req.query.avatarId || j.avatarId === req.query.avatarId).map(publicJob)); });
  r.get('/api/to3d/jobs/:id', (req, res) => {
    const j = jobOr404(String(req.params.id));
    res.json({ job: publicJob(j), resumePrompt: resumePrompt(j.id, j.avatarName), resumeLink: j.client === 'claude' ? claudeDeepLink(resumePrompt(j.id, j.avatarName)) : null,
      stale: !!j.lastToolCallAt && Date.now() - j.lastToolCallAt > TO3D_LIMITS.staleCallMs && !['done', 'stopped', 'failed', 'waiting_for_ok'].includes(j.phase) && j.phase !== 'running' });
  });
  r.post('/api/to3d/jobs/:id/stop', async (req, res) => {
    need(userClick(req), 400, 'Press Stop on the page.');
    const id = String(req.params.id);
    killJob(id);
    const j = await withJob(id, (x) => { if (x.phase !== 'done') { x.phase = 'stopped'; x.step = null; } return x; });
    res.json({ job: publicJob(j) });
  });
  r.delete('/api/to3d/jobs/:id', async (req, res) => { need(userClick(req), 400, 'Press Delete on the page.'); const id = String(req.params.id); killJob(id); res.json({ deleted: await deleteJob(id) }); });
  r.get('/api/to3d/jobs/:id/picture/:name', async (req, res) => {
    const j = jobOr404(String(req.params.id));
    const name = String(req.params.name);
    need(/^(compare_sheet|angles_sheet|expressions_sheet|refs_sheet)$/.test(name), 404, 'No such picture.');
    const n = Number(req.query.round ?? (j.best ?? lastRound(j)?.n ?? -1));
    const f = name === 'refs_sheet' ? path.join(jobPaths(j.id).refs, 'sheet.png') : path.join(checkDir(j.id, n), `${name}.png`);
    need(fs.existsSync(f), 404, 'Not made yet.');
    res.setHeader('Cache-Control', 'no-store');
    sendAbsolute(res, f);
  });

  // ---- installs + settings (this computer only; consent token)
  /** What the consent sheet shows (read only: no token here). */
  r.get('/api/to3d/fix/plan', async (req, res) => {
    need(helperCaller(req), 403, 'This only works from VTube Pro on this computer.');
    const actions = String(req.query.actions ?? '').split(',').filter((a) => FIX_ACTIONS.test(a)).slice(0, 12);
    res.setHeader('Cache-Control', 'no-store');
    res.json({ items: await planFor(actions) });
  });
  r.post('/api/to3d/fix/consent', json, async (req, res) => {
    need(helperCaller(req), 403, 'This only works from VTube Pro on this computer.');
    need(userClick(req), 400, 'Press the button on the page.');
    const actions = [...new Set((Array.isArray(req.body?.actions) ? req.body.actions : []).map(String).filter((a: string) => FIX_ACTIONS.test(a)).slice(0, 12))] as string[];
    for (const [k, t] of tokens) if (t.until <= Date.now()) tokens.delete(k);
    const token = crypto.randomBytes(24).toString('base64url');
    tokens.set(token, { actions, origin: originOf(req), until: Date.now() + CONSENT_TTL_MS });
    res.setHeader('Cache-Control', 'no-store');
    res.json({ token, expiresIn: CONSENT_TTL_MS / 1000, items: await planFor(actions) });
  });
  r.post('/api/to3d/fix', json, async (req, res) => {
    const { action, token, consent } = (req.body ?? {}) as { action?: string; token?: string; consent?: boolean };
    need(helperCaller(req), 403, 'This only works from VTube Pro on this computer.');
    need(userClick(req), 400, 'Press the button on the page.');
    need(typeof action === 'string' && FIX_ACTIONS.test(action), 400, 'Unknown action.');
    if (NEEDS_TOKEN.test(action)) {
      need(consent === true, 400, 'Tick “Yes” first.');
      const t = token ? tokens.get(token) : undefined;
      need(t && t.until > Date.now() && t.origin === originOf(req) && t.actions.includes(action), 403, 'That confirmation expired. Press the button again.');
      // used up NOW, before any work (and before the first await): a second post of the same action is refused
      t!.actions = t!.actions.filter((a) => a !== action);
      if (!t!.actions.length) tokens.delete(token!);
    }
    if (action.startsWith('install:mcp:')) await prefsGuard();   // again right before Blender starts (server/to3d/blenderMcp.ts)
    const blender = await findBlenderAsync();
    const info = await blenderInfo().catch(() => null);
    if (action === 'recheck') return res.json({ ok: true });
    if (action.startsWith('mcp:choose:')) { setMcpChoice(action.slice(11) as McpKind); return res.json({ ok: true }); }
    if (action === 'install:kit') { void installKit(realKitDeps()); return res.json({ ok: true, started: true, kit: kitStatus() }); }
    if (action === 'install:uv') { void installUv(realKitDeps()); return res.json({ ok: true, started: true, say: 'Getting uv (about 20 MB). This list refreshes by itself.' }); }
    if (action === 'install:blender') return res.json({ ok: true, open: '/tools.html?view=ai-setup#blender', say: 'The Blender installer opens on the Set up AI creation page.' });
    if (action.startsWith('connect:')) {
      const a = action.endsWith('chatgpt') ? 'chatgpt-desktop' : 'claude-desktop';
      const w = await setupDesktop(a, { env: process.env, platform: process.platform, home: (await import('node:os')).homedir(), now: Date.now, spawn: (await import('node:child_process')).spawn });
      return res.json({ ok: true, say: `Added. Quit ${a === 'claude-desktop' ? 'Claude' : 'ChatGPT'} fully and open it again.`, backup: w.backup ? path.basename(w.backup) : null });
    }
    if (action === 'install:mcp:community') {
      need(blender && info?.version, 409, 'Install Blender first.');
      const uvx = await uvxOrGet();
      await installCommunity(blender!, info!.version!, uvx);
      return res.json({ ok: true, say: 'MCP for Blender is installed and switched on in Blender.' });
    }
    if (action === 'install:mcp:official') {
      need(blender, 409, 'Install Blender first.');
      await installOfficial(blender!);
      return res.json({ ok: true, open: OFFICIAL.mcpbUrl, say: 'The add-on is installed. Open the .mcpb file we downloaded with Claude to add the server (Claude asks you to confirm).' });
    }
    if (action.startsWith('register:mcp:')) {
      const [, , kind, app] = action.split(':') as [string, string, McpKind, AppId];
      if (kind === 'official') return res.json({ ok: true, open: OFFICIAL.mcpbUrl, say: app === 'claude' ? 'Open the official .mcpb with Claude Desktop to add it.' : 'The official Blender MCP is added to ChatGPT from its source; use MCP for Blender with ChatGPT instead.' });
      const uvx = await uvxOrGet();
      const w = registerCommunity(app, uvx);
      if (w.action === 'skipped') return res.json({ ok: true, say: w.note ?? 'Your AI app already has a Blender MCP: we left it as it is.' });
      return res.json({ ok: true, say: `Added to ${app === 'claude' ? 'Claude' : 'ChatGPT'}. Quit the app fully and open it again.` });
    }
    if (action.startsWith('unregister:mcp:')) {
      const app = action.split(':')[2] as AppId;
      const w = unregisterOurs(app);
      return res.json({ ok: true, say: w.action === 'skipped' ? (w.note ?? 'Nothing to take out.') : 'Took ours out: your own Blender MCP is the one left. Quit the app fully and open it again.' });
    }
    if (action === 'open:blender') {
      const live = await liveNow();
      need(!live.live, 409, `You're live (${live.why}). Blender opens after your stream.`);
      need(blender, 409, 'Install Blender first.');
      const pid = openBlender(blender!, null, getMcpChoice());
      return res.json({ ok: !!pid, say: 'Blender is opening.' });
    }
    if (action === 'bases:clear-user') { clearUserBase(); return res.json({ ok: true }); }
    throw new HttpError(400, 'Unknown action.');
  });
  r.post('/api/to3d/bases/user', express.raw({ type: () => true, limit: '300mb' }), async (req, res) => {
    need(helperCaller(req), 403, 'This only works from VTube Pro on this computer.');
    need(userClick(req), 400, 'Pick the file on the page.');
    let file: string, name: string;
    if (Buffer.isBuffer(req.body) && req.body.length > 12) {
      const tmp = path.join(TO3D_DIR, 'tmp', `user-base-${Date.now()}.vrm`);
      await fsp.mkdir(path.dirname(tmp), { recursive: true });
      await fsp.writeFile(tmp, req.body);
      file = tmp; name = String(req.query.name ?? 'My base');
    } else {
      const avatarId = String(req.query.avatarId ?? '');
      const p = getProfile(avatarId);
      need(p && /\.vrm$/i.test(p.modelFile), 400, 'Pick a VRM avatar from your library (made in VRoid Studio).');
      file = resolveAvatarFile(avatarId, p!.modelFile)!; name = p!.name;
    }
    const out = await setUserBase(file, name);
    if (file.includes('user-base-')) fs.rmSync(file, { force: true });
    need(out.ok, 422, out.problems[0] ?? 'This base can\'t be used.');
    res.json({ ok: true, builtin: out.builtin ?? null, name: out.base?.name ?? null });
  });

  // ---- the instruction pack (generic, or filled with a job: this computer only)
  r.get('/api/to3d/pack', async (req, res) => {
    const id = String(req.query.jobId ?? '');
    const j = id && validJobId(id) ? loadJob(id) : null;
    res.type('text/markdown').send(buildPack(j ? await packJobOf(j) : null));
  });

  // ---- the AI's tools (server/to3d/mcpTools.ts calls these; this computer only)
  const touch = async (req: Request, id: string) => {
    const j = jobOr404(id);
    j.lastToolCallAt = Date.now(); j.lastClient = clientOf(req);
    saveJob(j);
    return j;
  };
  const stopped = (j: To3dJob) => need(!['stopped', 'done'].includes(j.phase), 409, j.phase === 'stopped' ? 'The user stopped this job. Stop and tell them.' : 'This job is done.');
  r.get('/api/to3d/ai/jobs', (_req, res) => res.json(listJobs().filter((j) => !['done'].includes(j.phase)).map((j) => ({ ...publicJob(j), nextStep: nextStep(j) }))));
  r.get('/api/to3d/ai/jobs/:id', async (req, res) => res.json(await aiJob(await touch(req, String(req.params.id)))));
  r.get('/api/to3d/ai/jobs/:id/bundle', async (req, res) => {
    const j = await touch(req, String(req.params.id));
    need(['bundled', 'running', 'iterating', 'waiting_for_ok', 'importing', 'done'].includes(j.phase), 409, 'The 2D model is still being read: call to3d_wait.');
    const s = JSON.parse(await fsp.readFile(path.join(jobPaths(j.id).refs, 'sections.json'), 'utf8')) as Record<string, unknown>;
    const sec = String(req.query.section ?? 'summary');
    need(sec in s, 400, `section is one of ${Object.keys(s).join(', ')}`);
    res.json({ section: sec, data: s[sec] });
  });
  r.get('/api/to3d/ai/jobs/:id/file', async (req, res) => {
    const j = jobOr404(String(req.params.id));
    const rel = String(req.query.path ?? '');
    need(/^(refs\/[A-Za-z0-9_./-]+\.png|rounds\/\d+\/check\/[A-Za-z0-9_./-]+\.png)$/.test(rel) && !rel.includes('..'), 400, 'bad path');
    const f = path.join(jobPaths(j.id).dir, rel);
    need(fs.existsSync(f), 404, 'not made yet');
    sendAbsolute(res, f, {}, jobPaths(j.id).dir);
  });
  r.get('/api/to3d/ai/jobs/:id/parts', async (req, res) => {
    const j = await touch(req, String(req.params.id));
    const parts = JSON.parse(await fsp.readFile(path.join(jobPaths(j.id).refs, 'parts.json'), 'utf8').catch(() => '[]')) as { file: string; name: string; role: string }[];
    const want = String(req.query.names ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
    const pick = parts.filter((p) => !want.length || want.some((w) => p.name.toLowerCase().includes(w) || p.role === w)).slice(0, 12);
    res.json(pick);
  });
  r.post('/api/to3d/ai/jobs/:id/baseline', json, async (req, res) => {
    const j = await touch(req, String(req.params.id));
    stopped(j);
    need(j.phase !== 'created' && j.phase !== 'bundling', 409, 'The 2D model is still being read: call to3d_wait first.');
    const ov = validateOverrides((req.body ?? {}).overrides);
    need(ov.ok, 400, ov.ok ? '' : ov.errors.join(' '));
    const route = (req.body ?? {}).route === 'image' ? 'image' : undefined;
    const n = await startRound(j.id, { lever: 'baseline', from: null, mode: 'full', overrides: ov.ok ? ov.flat : {}, route });
    res.json({ status: 'running', round: n, say: 'Building the first 3D version (2–8 min). Call to3d_wait.' });
  });
  r.post('/api/to3d/ai/jobs/:id/rebuild', json, async (req, res) => {
    const j = await touch(req, String(req.params.id));
    stopped(j);
    const b = req.body ?? {};
    const ov = validateOverrides(b.overrides);
    need(ov.ok, 400, ov.ok ? '' : `Not changed: ${ov.errors.join(' ')}`);
    const from = Number.isInteger(b.from) ? b.from : (j.best ?? lastRound(j)?.n);
    need(from !== undefined && roundOf(j, from)?.status === 'ready', 409, 'There is no finished round to start from: make the baseline first.');
    if (j.base.kind === 'user' && ov.ok && ov.flat['creator.base'] && ov.flat['creator.base'] !== 'user') throw new HttpError(400, 'This job uses the user\'s own base: keep creator.base "user".');
    const plan = planRebuild(j, from, ov.ok ? ov.flat : {});
    const n = await startRound(j.id, { lever: 'rebuild', from, mode: plan.mode, overrides: plan.overrides });
    res.json({ status: 'running', round: n, scope: plan.mode, say: `Round ${n} is building (${plan.mode === 'full' ? 'everything, 2–8 min' : plan.mode === 'hair' ? 'the hair, 1–3 min' : 'quick'}). Call to3d_wait.` });
  });
  r.post('/api/to3d/ai/jobs/:id/graft', json, async (req, res) => {
    const j = await touch(req, String(req.params.id));
    stopped(j);
    const b = req.body ?? {};
    const parts = (Array.isArray(b.parts) ? b.parts : []).map(String).filter((p: string) => /^[A-Za-z0-9_-]{1,60}\.glb$/.test(p));
    need(parts.length, 400, 'parts: the GLB file names you exported into the job\'s work/parts folder, e.g. ["hair_ahoge.glb"].');
    for (const p of parts) {
      const f = path.join(jobPaths(j.id).parts, p);
      need(fs.existsSync(f), 404, `${p} isn't in ${jobPaths(j.id).parts}: export it there first.`);
      // the size before anything parses it (a part is a small accessory: 20,000 triangles at most)
      const size = fs.statSync(f).size;
      need(size <= PART_MAX_BYTES, 413, `${p} is ${Math.round(size / 2 ** 20)} MB: a part must be under ${PART_MAX_BYTES / 2 ** 20} MB. Lower its polygon count and textures (1024 px is plenty) and export it again.`);
    }
    const from = Number.isInteger(b.from) ? b.from : (j.best ?? lastRound(j)?.n);
    need(from !== undefined && roundOf(j, from)?.status === 'ready', 409, 'There is no finished round to add parts to.');
    const hide = (Array.isArray(b.hide) ? b.hide : []).map(String).slice(0, 8);
    need(hide.every((h: string) => h.length >= 1 && h.length <= HIDE_MAX_CHARS), 400, `hide: mesh names of 1-${HIDE_MAX_CHARS} characters.`);
    const n = await startRound(j.id, { lever: 'graft', from, mode: 'graft', overrides: roundOf(j, from)!.overrides, parts, hide });
    res.json({ status: 'running', round: n, say: `Adding ${parts.length} part(s) as round ${n}. Call to3d_wait.` });
  });
  r.post('/api/to3d/ai/jobs/:id/check', json, async (req, res) => {
    const j = await touch(req, String(req.params.id));
    stopped(j);
    const n = Number.isInteger((req.body ?? {}).round) ? (req.body ?? {}).round : lastRound(j)?.n;
    need(n !== undefined, 409, 'Nothing to check yet.');
    await startCheck(j.id, n);
    res.json({ status: 'running', round: n, say: 'Rendering, comparing and reviewing (2–5 min). Call to3d_wait.' });
  });
  r.get('/api/to3d/ai/jobs/:id/wait', async (req, res) => {
    const id = String(req.params.id);
    await touch(req, id);
    const until = Date.now() + Math.min(Number(req.query.ms ?? 40_000) || 40_000, 45_000);
    let j = jobOr404(id);
    while (Date.now() < until && (j.phase === 'running' || j.phase === 'bundling' || j.phase === 'created' || j.phase === 'importing' || (j.phase === 'waiting_for_ok' && j.approval?.state === 'waiting'))) {
      await new Promise((r2) => setTimeout(r2, 1500));
      j = jobOr404(id);
    }
    const last = lastRound(j);
    const n = last?.check ? last.n : null;
    res.json({ phase: j.phase, step: j.step, round: last ? { n: last.n, status: last.status, error: last.error ?? null, scope: last.mode } : null,
      check: last?.check ? { round: n, review: last.check.review, approximate: last.check.approximate, total: last.check.scores?.total ?? null, worst: last.check.scores?.worst ?? null,
        views: last.check.scores?.views ?? null, reviewNotes: last.check.reviewNotes, pictures: last.check.sheets.filter((s) => /^(compare_sheet|angles_sheet|expressions_sheet)\.png$/.test(s)).map((s) => `rounds/${n}/check/${s}`) } : null,
      best: j.best, approval: j.approval, submitted: j.submitted, error: j.error, nextStep: nextStep(j) });
  });
  r.post('/api/to3d/ai/jobs/:id/note', json, async (req, res) => {
    const id = String(req.params.id);
    await touch(req, id);
    const b = req.body ?? {};
    const out = await withJob(id, (j) => {
      const n = Number.isInteger(b.round) ? b.round : lastRound(j)?.n;
      const r2 = roundOf(j, n);
      need(r2, 404, `There is no round ${n}.`);
      const cl = Array.isArray(b.checklist) ? b.checklist.map((x: unknown) => x === true) : null;
      need(!cl || cl.length === CHECKLIST.length, 400, `checklist: exactly ${CHECKLIST.length} true / false answers, in the pack's order.`);
      const angles = b.angles && typeof b.angles === 'object' ? Object.fromEntries(Object.entries(b.angles as Record<string, unknown>).filter(([k, v]) => ANGLES.map(String).includes(k) && typeof v === 'boolean')) as Record<string, boolean> : null;
      const gaps = (Array.isArray(b.gaps) ? b.gaps : []).map((g: unknown) => String(g).slice(0, 300)).slice(0, 12);
      r2!.note = { at: Date.now(), text: String(b.text ?? '').slice(0, 4000), checklist: cl, angles, gaps };
      j.knownGaps = [...new Set([...j.knownGaps, ...gaps])].slice(-20);
      j.notes.push({ at: Date.now(), text: `round ${n}: ${String(b.text ?? '').slice(0, 300)}` });
      j.best = bestRound(j);
      return { round: n, best: j.best, nextStep: nextStep(j) };
    });
    res.json(out);
  });
  r.post('/api/to3d/ai/jobs/:id/revert', json, async (req, res) => {
    const id = String(req.params.id);
    const j = await touch(req, id);
    stopped(j);
    const to = Number.isInteger((req.body ?? {}).round) ? (req.body ?? {}).round : j.best;
    need(to !== null && to !== undefined, 409, 'There is no best round to go back to.');
    const n = await revertTo(id, to);
    res.json({ round: n, from: to, say: `Round ${n} is a copy of round ${to}. Try a different lever.`, nextStep: nextStep(jobOr404(id)) });
  });
  r.post('/api/to3d/ai/jobs/:id/vision', json, async (req, res) => {
    const id = String(req.params.id);
    await touch(req, id);
    const ans = (req.body ?? {}).answer;
    const out = await withJob(id, (j) => {
      if (typeof ans === 'string' && j.vision) j.vision.ok = ans.trim().toUpperCase() === j.vision.code;
      else if (ans === 'cannot-see' && j.vision) j.vision.ok = false;
      else j.vision = { code: Array.from(crypto.randomBytes(3), (b) => 'ABCDEFGHJKLMNPQRSTUVWXYZ'[b % 24]).join('') + String(crypto.randomInt(10, 99)), ok: null };
      return j.vision;
    });
    res.json({ ok: out!.ok, picture: out!.ok === null ? `/api/to3d/ai/jobs/${id}/vision.png` : null });
  });
  r.get('/api/to3d/ai/jobs/:id/vision.png', (req, res) => {
    const j = jobOr404(String(req.params.id));
    need(j.vision && j.vision.ok === null, 404, 'no check running');
    res.type('image/png').send(codePng(j.vision!.code));
  });
  r.post('/api/to3d/ai/jobs/:id/open-blender', json, async (req, res) => {
    const id = String(req.params.id);
    const j = await touch(req, id);
    stopped(j);
    const live = await liveNow();
    if (live.live) return res.json({ status: 'later', say: `The user is live (${live.why}): Blender opens after the stream. Keep working with to3d_rebuild meanwhile.` });
    const blender = await findBlenderAsync();
    need(blender, 409, 'Blender isn\'t installed.');
    const n = j.best ?? lastRound(j)?.n;
    need(n !== undefined && n !== null, 409, 'Make the baseline first: Blender opens on it.');
    if (pendingOpen.has(id)) return res.json({ status: 'waiting_for_ok', say: 'Waiting for the user to press Approve in VTube Pro.' });
    pendingOpen.add(id);
    void requestApproval({ tool: 'to3d_open_blender', scope: 'library', client: clientOf(req), args: { job: j.avatarName, round: n, what: 'Open Blender on this computer with the 3D version (a window opens)' } }, POLL_APPROVAL_TIMEOUT_MS)
      .then(async (d) => {
        pendingOpen.delete(id);
        if (!d.approved || (await liveNow()).live) return;
        const { makeBlend } = await import('./blend.ts');
        const blend = await makeBlend(id, vrmOf(id, n!)).catch(() => null);
        openBlender(blender!, blend, getMcpChoice());
      });
    res.json({ status: 'waiting_for_ok', say: 'Ask the user to press Approve in VTube Pro; Blender opens on the current round. Poll to3d_job.' });
  });
  r.post('/api/to3d/ai/jobs/:id/submit', json, async (req, res) => {
    const id = String(req.params.id);
    const j = await touch(req, id);
    stopped(j);
    if (j.approval?.state === 'waiting') return res.json({ status: 'waiting_for_ok', round: j.approval.round, say: 'Still waiting for the user to press Approve.' });
    const n = Number.isInteger((req.body ?? {}).round) ? (req.body ?? {}).round : handInRound(j);
    need(n !== null && n !== undefined, 409, 'There is no checked round yet.');
    const why = submitProblem(j, n);
    need(!why, 409, why ?? '');
    const rr = roundOf(j, n)!;
    await withJob(id, (x) => { x.phase = 'waiting_for_ok'; x.approval = { state: 'waiting', at: Date.now(), round: n }; x.step = { name: 'approve', text: 'Waiting for your OK to add it to your library', progress: 1, at: Date.now() }; });
    void requestApproval({ tool: 'to3d_submit', scope: 'library', client: clientOf(req),
      args: { add: `"${j.avatarName} (3D)" as a NEW avatar (not worn)`, round: n, review: rr.check?.review, score: rr.check?.scores?.total, gaps: j.knownGaps,
        ...(rr.check?.review === 'FAIL' ? { warning: 'The automatic review still finds problems (below). Look at the pictures: add it only if you like it.', problems: rr.check.reviewNotes.slice(0, 6) } : {}),
        pictures: `http://127.0.0.1:${process.env.VTP_PORT ?? 5191}/api/to3d/jobs/${id}/picture/compare_sheet?round=${n}` } }, POLL_APPROVAL_TIMEOUT_MS)
      .then(async (d) => {
        if (!d.approved) { await withJob(id, (x) => { x.phase = 'iterating'; x.approval = { state: 'denied', at: Date.now(), round: n, reason: d.reason }; x.step = null; }); return; }
        await withJob(id, (x) => { x.phase = 'importing'; x.approval = { state: 'approved', at: Date.now(), round: n }; });
        try {
          const avatarId = await importRound(id, n);
          await withJob(id, (x) => { x.phase = 'done'; x.submitted = { avatarId, at: Date.now() }; x.step = { name: 'done', text: `"${x.avatarName} (3D)" is in your library`, progress: 1, at: Date.now() }; });
        } catch (e) { await withJob(id, (x) => { x.phase = 'iterating'; x.error = `Adding it to the library failed: ${(e as Error).message}`; }); }
      });
    res.json({ status: 'waiting_for_ok', round: n, say: `Tell the user: "It's ready: press Approve in VTube Pro to add '${j.avatarName} (3D)' to your library." Then poll to3d_job every 30 s.` });
  });

  // ---- the render page
  r.get('/api/to3d/render/:t/plan', (req, res) => { const p = planOf(String(req.params.t)); need(p, 404, 'gone'); res.json(p); });
  r.get('/api/to3d/render/:t/model', (req, res) => { const s = sessionOf(String(req.params.t)); need(s, 404, 'gone'); sendAbsolute(res, s!.model); });
  r.post('/api/to3d/render/:t/shot', express.raw({ type: () => true, limit: '20mb' }), (req, res) => {
    need(saveShot(String(req.params.t), String(req.query.name ?? ''), req.body as Buffer), 400, 'not taken');
    res.json({ ok: true });
  });
  r.post('/api/to3d/render/:t/done', json, (req, res) => { need(doneShots(String(req.params.t), req.body ?? {}), 404, 'gone'); res.json({ ok: true }); });
  return r;
}

const pendingOpen = new Set<string>();

/** The Blender MCP's real tool names (tools/list on the entry the AI app starts): the pack names them, so the AI never
 *  guesses. Once per job start, in the background; a cold uvx start can take a while (60 s cap). */
async function discoverBlenderTools(app: AppId) {
  try {
    const list = blenderEntries(appServers(app));
    const pick = list.find((x) => x.kind === getMcpChoice()) ?? list[0];
    if (!pick) return;
    const entry = appServers(app)[pick.name];
    const tools = await listServerTools(entry, 60_000);
    if (tools?.length) saveTools(pick.kind, tools);
  } catch { /* the pack falls back to the known names */ }
}
export const to3dRoutes = createTo3dRoutes();
if (!process.env.VTP_TO3D_NO_CLEANUP) setTimeout(() => cleanupOrphans(), 5000).unref?.();
