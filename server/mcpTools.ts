// The ONE VTube Pro AI tool table. Every AI host uses it:
//   * server/mcp.ts          stdio MCP (Claude Desktop, Claude Code, Grok Build, Cursor, any local MCP client)
//   * /mcp on :5191          streamable-HTTP MCP on localhost (token + loopback guard) for agent frameworks
//   * server/mcpRemote.ts    optional HTTPS-tunnel MCP (ChatGPT / Grok connectors) - REMOTE_SAFE tools only
//   * server/aiAgent.ts      the built-in "Create with AI" chat (a model on this PC: Ollama, LM Studio, llama.cpp ...)
// Tools talk to the running app over its REST API (http://127.0.0.1:5191). Scopes + approvals: server/mcpScopes.ts.
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { LOCAL_AI_TOOLS } from './localAiTools.ts';
import { COMFY_INSTALL_TOOLS } from './comfyWorkflowTools.ts';
import { TO3D_TOOLS } from './to3d/mcpTools.ts';
import { AI_ADDONS_TOOLS } from './aiAddonsTool.ts';
import { z } from 'zod';
import type { AvatarProfile, GenerateRequest, Job } from '../shared/types.ts';
import type { Scope } from './mcpScopes.ts';
import { runCreationCheck } from './creationCheck.ts';
import { carryCreatorProfile, readCreatorProfile } from './avatarFolder.ts';
import { AI_DOC_KEYS, AI_DOCS, availableDocs, availableResources, docSection, DOC_POINTERS, HOUSE_RULES, HOUSE_RULES_SHORT, readAiDoc, type AiDocKey } from './aiKnowledge.ts';

export const BASE = process.env.VTP_URL ?? `http://127.0.0.1:${process.env.VTP_PORT ?? 5191}`; // in-server hosts call their own port
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };
export type ToolResult = { content: Content[]; isError?: boolean };
export class ApiError extends Error {}

// A fetch() that fails is one of two things. Nothing answers (refused, no such host, connect timeout): the app is not
// running. Or a connection that was made broke before the answer: the app IS running, typically a kept-alive socket it
// closed while a long synchronous step (a busy PC; before beta.10 the room checker's spawnSync) held the event loop past
// the keep-alive.
// The in-app hosts (/mcp on :5191, the built-in AI) call their own port, so they meet the second one: never say "start it".
const NOT_RUNNING = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EADDRNOTAVAIL', 'EHOSTUNREACH', 'ENETUNREACH', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT']);
/** The system / undici error code behind a fetch() failure ('' if there is none). */
export function fetchFailureCode(e: unknown): string {
  const c = (e as { cause?: { code?: unknown; errors?: { code?: unknown }[] } } | null)?.cause;
  return String(c?.code ?? c?.errors?.[0]?.code ?? (e as { code?: unknown } | null)?.code ?? '');
}
const isRead = (method: string) => /^(GET|HEAD)$/i.test(method);
/** What to tell the AI when fetch() itself failed. */
export function fetchFailureMessage(e: unknown, method = 'GET'): string {
  const code = fetchFailureCode(e);
  if (!code || NOT_RUNNING.has(code)) return `VTube Pro server is not reachable at ${BASE}. Start it with "npm run dev" (or START_HERE.bat) in the VTube Pro folder.`;
  return `VTube Pro at ${BASE} is running but dropped the connection (${code}) before it answered` + (isRead(method)
    ? ' (asked twice). It may be busy: wait a moment and try again.'
    : '. This request may or may not have been carried out: check (e.g. list it) before sending it again.');
}

/** The AI app this stdio server was registered for (VTP_MCP_CLIENT in its entry), on every call to the helper. */
const CLIENT_HEADER: Record<string, string> = process.env.VTP_MCP_CLIENT ? { 'X-VTP-MCP-Client': process.env.VTP_MCP_CLIENT.replace(/[^\x20-\x7e]/g, '').slice(0, 80) } : {};

export async function api<T = any>(method: string, p: string, body?: unknown, raw?: Buffer): Promise<T> {
  const init: RequestInit = {
    method,
    headers: { ...(raw ? { 'Content-Type': 'application/octet-stream' } : body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...CLIENT_HEADER },
    body: raw ? new Uint8Array(raw) : body !== undefined ? JSON.stringify(body) : undefined,
  };
  let res: Response;
  for (let attempt = 0; ; attempt++) {
    try { res = await fetch(BASE + p, init); break; } catch (e) {
      // a read whose connection broke is asked once more, a moment later (by then every socket the app dropped is gone
      // from the pool); anything else may already have been carried out, so it is never sent twice
      const code = fetchFailureCode(e);
      if (attempt === 0 && isRead(method) && code && !NOT_RUNNING.has(code)) { await new Promise((r) => setTimeout(r, 100)); continue; }
      throw new ApiError(fetchFailureMessage(e, method));
    }
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new ApiError(json?.error ?? `HTTP ${res.status}: ${text.slice(0, 300)}`);
  return json as T;
}

export async function fetchImage(url: string): Promise<Content> {
  const res = await fetch(BASE + url);
  if (!res.ok) throw new ApiError(`Could not fetch ${url}: HTTP ${res.status}`);
  return { type: 'image', data: Buffer.from(await res.arrayBuffer()).toString('base64'), mimeType: res.headers.get('content-type')?.split(';')[0] || 'image/png' };
}

export const text = (v: unknown): Content => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 2) });

const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
/** Deep merge: objects merge recursively, arrays and scalars replace, null clears to null. */
export function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isPlainObject(base) || !isPlainObject(patch)) return patch;
  const out: Record<string, unknown> = { ...base };
  for (const [k, v] of Object.entries(patch)) out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  return out;
}

const MIME: Record<string, string> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' };
async function toDataUrl(img: string): Promise<string> {
  if (img.startsWith('data:')) return img;
  const mime = MIME[path.extname(img).toLowerCase()];
  if (!mime) throw new ApiError(`Unsupported image type for ${img} (use PNG/JPEG/WebP)`);
  return `data:${mime};base64,${(await fs.readFile(img)).toString('base64')}`;
}
const summarize = (p: AvatarProfile) => ({ id: p.id, name: p.name, source: p.source, shipped: p.shipped, modelFile: p.modelFile, rig: p.rig.kind, eyes: p.eyes.mode, mouth: p.mouth.mode, thumbnail: p.thumbnail, prompt: p.prompt });
const jobSummary = (j: Job, logLines = 40) => ({ ...j, log: j.log.slice(-logLines) });

// ---------------------------------------------------------------- docs (any AI can read them without file access)
// The catalog (keys, files, titles) and the house rules live in server/aiKnowledge.ts, shared with the built-in AI host,
// the instruction pack and the generation prompts.
export const DOCS = Object.fromEntries(AI_DOCS.map((d) => [d.key, d.file])) as Record<AiDocKey, string>;
export type DocKey = AiDocKey;

export async function readDoc(doc: DocKey = 'creator'): Promise<string> {
  try { return await readAiDoc(doc, ROOT); } catch (e) { throw new ApiError((e as Error).message); }
}

/** get_docs with no topic: what to read, the house rules and the resource URIs. */
export function docsIndex(root = ROOT): string {
  const have = new Set<string>(availableDocs(root).map((d) => d.key));
  return [
    '# VTube Pro guides for AIs',
    'Call get_docs {topic, section?}. `section` = a word from a "## " or "### " heading (omit it for the whole guide).',
    '',
    ...AI_DOCS.map((d) => `- **${d.key}**: ${d.title} (\`${d.file}\`, resource vtube-pro://${d.file})${have.has(d.key) ? '' : ' [not in this install]'}. ${d.about}`),
    '',
    'Short resources: ' + availableResources(root).map((r) => `${r.uri} (${r.title})`).join(', ') + '.',
    'topic "rules" = the house rules below.',
    '',
    HOUSE_RULES,
  ].join('\n');
}

/** For the get_docs / get_creator_guide descriptions: the guides this copy lacks, so an AI is not promised a guide it
 *  can't get. '' when every guide is here. */
export function guideAvailabilityNote(root = ROOT): string {
  const have = new Set<string>(availableDocs(root).map((d) => d.key));
  const missing = AI_DOCS.filter((d) => !have.has(d.key)).map((d) => `"${d.key}"`);
  if (!missing.length) return '';
  return ` Not in this install: ${missing.join(', ')} (asking for one returns the guides it has).` +
    (have.has('environments') ? ' The room contract is in "environments".' : '');
}

/** get_creator_guide: a guide (default "creator"); an install without the AI creator guide answers a call with no `doc`
 *  with the index of the guides it has, instead of an error. */
export async function creatorGuide(doc?: DocKey, section?: string, root = ROOT): Promise<string> {
  if (!doc && !availableDocs(root).some((d) => d.key === 'creator')) {
    return `The AI creator guide (docs/AI_CREATOR_GUIDE.md) is not in this install. Pick one of the guides it has (get_creator_guide {doc} or get_docs {topic}):\n\n${docsIndex(root)}`;
  }
  let md: string;
  try { md = await readAiDoc(doc ?? 'creator', root); } catch (e) { throw new ApiError((e as Error).message); }
  return section && section.trim() ? guideSection(md, section) : md;
}

/** The "## " sections whose heading contains `q` (case-insensitive); the list of headings if none match. */
export function guideSection(md: string, q: string): string {
  const parts = md.split(/\r?\n(?=## )/);
  const needle = q.trim().toLowerCase();
  const head = (s: string) => s.split(/\r?\n/, 1)[0];
  const hits = parts.slice(1).filter((s) => head(s).toLowerCase().includes(needle));
  if (hits.length) return hits.join('\n\n');
  return `No section heading contains "${q}". Sections:\n- ${parts.slice(1).map((s) => head(s).replace(/^##\s*/, '')).join('\n- ')}`;
}

export const INSTRUCTIONS =
  'VTube Pro is a live VTuber studio: the user may be streaming right now. Before building avatars, costumes or rooms, ' +
  'call get_docs (no arguments = the index + house rules; topic "avatars" before an avatar or costume, "environments" before a ' +
  'room, "connect" for the end-to-end room recipe and creation packages) and follow it. Tools are grouped in scopes: read and ' +
  'render run freely; create makes new library items; library writes, anything that changes the live stream, and ' +
  'blender_run_python / install_creation_package wait up to 5 minutes for the user\'s OK: VTube Pro opens its approval page on ' +
  `their computer (http://127.0.0.1:${process.env.VTP_PORT ?? 5191}/aiconnect) and the studio shows "Your AI is waiting for your OK" - ` +
  'tell the user to press Approve there when a call is waiting. ' + HOUSE_RULES_SHORT + ' ' + DOC_POINTERS;

// ---------------------------------------------------------------- the table
/** Who is calling (mcpHost passes it): the origin decides what a tool may hand out (a job-filled pack: local only). */
export interface ToolCtx { origin: 'local' | 'remote'; client: string }
export interface ToolDef {
  name: string;
  scope: Scope;
  description: string;
  input: z.ZodRawShape;
  run: (args: any, ctx?: ToolCtx) => Promise<ToolResult | unknown>;
}

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const softRig = z.object({
  neck: z.number().describe('Neck height, normalized over the model bbox (0 = feet, 1 = top)'),
  chest: z.number().describe('Chest height (normalized)'),
  hips: z.number().describe('Hips height (normalized)'),
  leftShoulder: vec3.nullable().describe('[u,v,w] in glTF bbox space (u=x, v=y up, w=z), character left = +X; null = no arms'),
  rightShoulder: vec3.nullable(),
  leftHand: vec3.nullable(),
  rightHand: vec3.nullable(),
  blend: z.number().default(0.08).describe('Weight blend width around joints (normalized height)'),
});
const VIEWS = ['front', 'left', 'right', 'back', 'three_quarter', 'top'] as const;

/** Which stage picture to return: the NEWER of stage.jpg (the studio's 3-second picture, 960 px wide) and stage.png
 *  (the full-resolution one the 'diag' command writes, or an older studio's 3-second picture), by mtime, never a stale
 *  one: a stage.jpg left from when the camera was on must not hide a later request_diagnostics stage.png, nor the live
 *  stage.png an older studio keeps uploading (the drop box only ever deletes a stale stage.png). Same mtime: stage.png
 *  (full resolution). `freshSince` (ISO time: request_diagnostics asked the studio for a full-resolution stage.png
 *  then): a stage.png written since then wins, however new the stage.jpg is (the automatic 3-second cycles keep writing
 *  stage.jpg meanwhile). mtimes are the drop box's toISOString() values, so they compare as text. */
export function pickStage(byName: Map<string, { mtime: string }>, freshSince?: string): string | null {
  const jpg = byName.get('stage.jpg'), png = byName.get('stage.png');
  if (freshSince !== undefined && png && png.mtime >= freshSince) return 'stage.png';
  if (jpg && png) return jpg.mtime > png.mtime ? 'stage.jpg' : 'stage.png';
  return jpg ? 'stage.jpg' : png ? 'stage.png' : null;
}

type DiagListing = { dir: string; files: { name: string; mtime: string; bytes: number }[] };

/** request_diagnostics: the studio's answer to a 'diag' command is in (a stage.png written since `since`, and a
 *  state.json at least as new: the studio writes it right after the picture). */
export function freshDiag(files: DiagListing['files'], since: string): boolean {
  const png = files.find((f) => f.name === 'stage.png'), st = files.find((f) => f.name === 'state.json');
  return !!png && png.mtime >= since && !!st && st.mtime >= png.mtime;
}

async function diagnostics(freshSince?: string): Promise<ToolResult> {
  const listing = await api<DiagListing>('GET', '/api/diag');
  const byName = new Map(listing.files.map((f) => [f.name, f]));
  const content: Content[] = [text({ dir: listing.dir, files: listing.files })];
  for (const name of ['camera.jpg', pickStage(byName, freshSince) ?? 'stage.jpg']) {
    if (byName.has(name)) content.push(text(`${name} (updated ${byName.get(name)!.mtime}):`), await fetchImage(`/api/diag/${name}`));
    else content.push(text(`${name}: not uploaded yet`));
  }
  if (byName.has('state.json')) {
    const res = await fetch(`${BASE}/api/diag/state.json`);
    content.push(text(`state.json (updated ${byName.get('state.json')!.mtime}):\n${(await res.text()).slice(0, 20000)}`));
  } else content.push(text('state.json: not uploaded yet'));
  return { content };
}

const packageArg = z.union([z.string(), z.record(z.string(), z.unknown())]).describe('The creation package (JSON object or JSON text), format "vtube-pro.creation/1" - see get_instruction_pack');
const pkgBody = (p: unknown) => ({ package: typeof p === 'string' ? JSON.parse(p) : p });

export const TOOLS: ToolDef[] = [
  {
    name: 'get_docs', scope: 'read',
    description:
      'The VTube Pro guides for AIs. No topic = the index (every guide, what it covers, the resource URIs) + the house rules. ' +
      'topic: ' + AI_DOCS.map((d) => `"${d.key}" (${d.title})`).join(', ') + ', or "rules" (the house rules). ' +
      'Optional `section`: a word from a "## " or "### " heading to get only that part (e.g. topic "avatars" section "visemes", ' +
      'topic "environments" section "contract", topic "creator" section "recipes"). Read "avatars" before building an avatar or ' +
      'costume and "environments" before a room.' + guideAvailabilityNote(),
    input: {
      topic: z.enum([...AI_DOC_KEYS, 'rules']).optional(),
      section: z.string().optional().describe('Word from a "## " / "### " heading; omit for the whole guide'),
    },
    run: async ({ topic, section }: { topic?: DocKey | 'rules'; section?: string }) => {
      if (!topic) return docsIndex();
      if (topic === 'rules') return HOUSE_RULES;
      const md = await readDoc(topic);
      return section && section.trim() ? docSection(md, section) : md;
    },
  },
  {
    name: 'get_creator_guide', scope: 'read',
    description:
      'Return a VTube Pro guide (the same guides as get_docs). doc: ' + AI_DOCS.map((d) => `"${d.key}" (${d.file}: ${d.title})`).join(', ') +
      '. Default "creator"; without it in this install, a call with no doc returns the index of the guides it has. ' +
      'Optional `section`: a word from a "## " heading to get only that part.' + guideAvailabilityNote(),
    input: { doc: z.enum(AI_DOC_KEYS).optional(), section: z.string().optional().describe('Word from a "## " heading; omit for the whole doc') },
    run: async ({ doc, section }: { doc?: DocKey; section?: string }) => creatorGuide(doc, section),
  },
  {
    name: 'get_instruction_pack', scope: 'read',
    description: 'An instruction pack. pack "room" (default): the copy-paste room pack (room contract, budgets, the creation-package JSON schema, a worked example). pack "pro2d_to_3d" (+ jobId): the exact recipe for turning the user\'s Pro2D (2D) avatar into a 3D VRM with the to3d_* tools and their Blender MCP.',
    input: { pack: z.enum(['room', 'pro2d_to_3d']).optional(), jobId: z.string().optional().describe('pro2d_to_3d: the job id from the user\'s message (fills in this job)') },
    run: async ({ pack, jobId }: { pack?: 'room' | 'pro2d_to_3d'; jobId?: string }, ctx?: ToolCtx) => {
      // a job-filled pack (paths, the avatar's name) only for this computer's own AI apps, never the internet bridge
      if (pack === 'pro2d_to_3d') return (await fetch(`${BASE}/api/to3d/pack${jobId && ctx?.origin !== 'remote' ? `?jobId=${encodeURIComponent(jobId)}` : ''}`, { headers: CLIENT_HEADER }).then((r) => (r.ok ? r.text() : Promise.reject(new ApiError(`HTTP ${r.status}`))))) as string;
      return (await fetch(`${BASE}/api/aiconnect/pack`).then((r) => (r.ok ? r.text() : Promise.reject(new ApiError(`HTTP ${r.status}`))))) as string;
    },
  },
  { name: 'status', scope: 'read', description: 'VTube Pro server status: Blender availability/version, ComfyUI reachability.', input: {}, run: () => api('GET', '/api/status') },
  { name: 'list_avatars', scope: 'read', description: 'List avatars in the library (builtins first) with id, name, source, model file and rig kind.', input: {}, run: async () => (await api<AvatarProfile[]>('GET', '/api/avatars')).map(summarize) },
  { name: 'get_avatar', scope: 'read', description: 'Get the full AvatarProfile JSON (eyes, mouth, rig, physics, tracking tuning...) for an avatar id.', input: { id: z.string() }, run: ({ id }: { id: string }) => api('GET', `/api/avatars/${encodeURIComponent(id)}`) },
  { name: 'list_costumes', scope: 'read', description: "List an avatar's costumes (id, name, file, labels, source) and which one is worn.", input: { avatarId: z.string() }, run: ({ avatarId }: { avatarId: string }) => api('GET', `/api/avatars/${encodeURIComponent(avatarId)}/costumes`) },
  {
    name: 'list_rooms', scope: 'read',
    description: 'List the rooms the studio can load (the shipped ones, the user\'s own and any folder the owner linked), as the studio ' +
      'lists them: each entry is the room\'s scene.json plus id, name, model, ready (its GLB is there) and thumb. A room with areas is ' +
      'listed once per area (id "<room>~<area>"). It does not open the GLBs, so it neither counts places or cameras nor checks ' +
      'anything: use check_room {roomId} (seats, cameras, scale, floor, budget) or validate_room {roomId} (the room contract).',
    input: {},
    run: () => api('GET', '/api/scenes'),
  },
  { name: 'get_job', scope: 'read', description: 'Get a background job (generation, autorig, package install): status, progress, log tail, result.', input: { id: z.string() }, run: async ({ id }: { id: string }) => jobSummary(await api<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`)) },
  {
    name: 'wait_for_job', scope: 'read',
    description: 'Wait until a job succeeds or fails, at most ~40 s per call (AI apps cancel a tool call after ~60 s), then return it. Still running = call wait_for_job again. Includes the latest preview image if any.',
    input: { id: z.string(), timeout: z.number().default(40).describe('Seconds to wait (default 40, at most 45; call again while it runs)') },
    run: async ({ id, timeout }: { id: string; timeout?: number }) => {
      const deadline = Date.now() + Math.min(Math.max(timeout ?? 40, 0), 45) * 1000;
      let job: Job;
      for (;;) {
        job = await api<Job>('GET', `/api/jobs/${encodeURIComponent(id)}`);
        if (job.status === 'succeeded' || job.status === 'failed' || Date.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 2000));
      }
      const content: Content[] = [text(jobSummary(job))];
      if (job.status !== 'succeeded' && job.status !== 'failed') content.push(text('Still running: call wait_for_job again with the same id.'));
      if (job.preview) content.push(await fetchImage(job.preview).catch(() => text(`(preview unavailable: ${job.preview})`)));
      return { content, isError: job.status === 'failed' };
    },
  },
  {
    name: 'validate_room', scope: 'read',
    description: 'Check an installed room (any id from list_rooms: the user\'s, a shipped or a linked one; an area id "<room>~<area>" ' +
      'checks its room) against the room contract: SPOT_xx places (heights in world space: parent transforms count), the default ' +
      'camera, SCREEN / CAM_REACT for React, door + path, lights, budgets (triangles, draw calls, MB, textures), preview / thumb. A ' +
      'room with areas is checked area by area (budgets per area). Returns errors, warnings (each with its fix) and stats ' +
      '(spotHeights = each SPOT\'s world height in metres). Runs on the PC\'s Python or the one inside Blender.',
    input: { roomId: z.string().describe('A room id from list_rooms') },
    run: ({ roomId }: { roomId: string }) => api('POST', '/api/aiconnect/room/validate', { roomId }),
  },
  {
    name: 'check_room', scope: 'read',
    description: 'The "Add my room" check, for a room you are building or fixing: plain-language report lines (seats found, cameras, ' +
      'scale, up axis, floor, lights, budget) each with the fix, the facts (every SPOT_xx with its problems: "inside" furniture / ' +
      '"floating"), and a suggested fix as data: SPOT_xx empties on sofa / chair cushions and open floor + SPOT_xx_CAM / CAM_WIDE ' +
      'cameras with clear sightlines (glTF space), plus a units / up-axis correction matrix when needed. A room needs at least 1 usable ' +
      'seat, 2+ recommended. Give roomId (an installed room) OR path (a .glb / .gltf / .fbx / .blend / .obj file on this PC; non-GLB files ' +
      'are converted by Blender first). Rules as data: room_checklist.',
    input: { roomId: z.string().optional().describe('An installed room id (list_rooms)'), path: z.string().optional().describe('Absolute path to a room file') },
    run: async ({ roomId, path: file }: { roomId?: string; path?: string }) => {
      if (roomId) return api('GET', `/api/rooms/check/${encodeURIComponent(roomId)}`);
      if (!file) throw new ApiError('Give roomId (an installed room) or path (a room file on this PC).');
      if (!/\.(glb|gltf|fbx|blend|obj)$/i.test(file)) throw new ApiError('path must be a room file: .glb, .gltf, .fbx, .blend or .obj');
      const buf = await fs.readFile(file);
      return api('POST', `/api/rooms/check?${new URLSearchParams({ filename: path.basename(file) })}`, undefined, buf);
    },
  },
  {
    name: 'room_checklist', scope: 'read',
    description: 'The room checklist as data (id, required, rule, how it is checked, the fix, what the studio fixes automatically, the guide section): ' +
      'what a VTube Pro room needs. The same rules check_room and the studio’s "Add my room" wizard run.',
    input: {},
    run: () => api('GET', '/api/rooms/checklist'),
  },
  {
    // The agent file check (docs/AGENT_GUIDE.md §9, tools/vtp_check.ts): any creation kind, before handing it over.
    // Runs in its own process (server/creationCheck.ts), never on the helper's event loop. Local paths only (not remote).
    name: 'check_creation', scope: 'read',
    description: 'Check an avatar or room you made BEFORE handing it to the user: will VTube Pro take it as it is? Give the absolute ' +
      'path of a file, a folder or a .zip on this PC (a .vrm / .glb / .gltf, a layered .psd, a folder of part PNGs, a Live2D model ' +
      'folder, an Inochi2D .inp, a .vtp2, PNGTuber pictures, a room folder with scene.glb + scene.json, or a 2D room). Returns ' +
      'vtube-pro.check/1: verdict pass | warn | fail, a summary, items [{id, level ok|info|warn|error, what, fix, doc}] and measured ' +
      'facts. It runs the studio\'s own importers (the 3D drop importer, the PSD reader + 2D avatar maker, the Live2D converter + ' +
      'auto-mapping, the room check) plus the stricter agent bar of docs/AGENT_GUIDE.md. Fix every error and warning, then check ' +
      'again. The rules as data: creation_spec.',
    input: {
      path: z.string().describe('Absolute path to the file, folder or .zip'),
      kind: z.enum(['avatar3d', 'room3d', 'pro2d-psd', 'pro2d-pictures', 'live2d', 'inochi2d', 'vtp2', 'pngtuber', 'flat2d-room']).optional().describe('What it is (detected when left out)'),
    },
    run: async ({ path: file, kind }: { path: string; kind?: string }) => {
      try { return await runCreationCheck(ROOT, file, kind); } catch (e) { throw new ApiError((e as Error).message); }
    },
  },
  {
    name: 'creation_spec', scope: 'read',
    description: 'What VTube Pro accepts, as data (docs/agent-spec.json, vtube-pro.agent-spec/1): VRM bone names, the 52 ARKit names, ' +
      'VRM 0.x / 1.0 expression names, budgets, export settings, Pro2D PSD rules + layer words, Live2D standard parameter ids + ranges, ' +
      'PNGTuber picture names, room nodes + budgets, 2D room layers. section = one top-level key (avatar3d, pro2d, live2d, inochi2d, ' +
      'pngtuber, room3d, flat2dRoom, overlay2_5d, checker); none = the whole spec. Prose and reasons: get_docs {topic: "agents"}.',
    input: { section: z.string().optional().describe('A top-level key, e.g. "avatar3d" or "live2d"') },
    run: async ({ section }: { section?: string }) => {
      let spec: Record<string, unknown>;
      try { spec = JSON.parse(await fs.readFile(path.join(ROOT, 'docs', 'agent-spec.json'), 'utf8')); } catch { throw new ApiError('docs/agent-spec.json is not in this install.'); }
      if (!section) return spec;
      if (!(section in spec)) throw new ApiError(`No section "${section}". Sections: ${Object.keys(spec).filter((k) => typeof spec[k] === 'object').join(', ')}`);
      return { format: spec.format, guide: spec.guide, [section]: spec[section] };
    },
  },
  {
    // The studio's "Add my room" (POST /api/rooms/import, server/routes/roomImport.ts): the same check, conversion,
    // automatic places and install as when the user adds a room themselves. Library scope: it writes a new room into
    // the user's rooms folder (in a release the per-user data folder, like AI creation packages), so it waits for the OK.
    name: 'import_room', scope: 'library',
    description: 'Add a finished room FILE from this PC to the user\'s rooms, the way the studio\'s "Add my room" does (the user ' +
      'approves it first). A .glb is used as it is and a .gltf with everything embedded is packed into one .glb (a .gltf that needs ' +
      'a .bin or textures next to it is refused); .fbx / .blend / .obj (and Draco / KTX2 files) ' +
      'are converted by Blender. The room is checked like check_room; with autoSeats (default true) a room with fewer than 2 usable ' +
      'places gets SPOT_xx places + cameras added (the fix check_room suggests); a room with no usable place is refused. It is ' +
      'installed as a NEW room "<name>_<random>" in the user\'s own rooms folder: it never replaces an installed room and never ' +
      'changes the live scene. Its scene.json is written for you (name, modes, cameras): to ship your own scene.json or to change an ' +
      'installed room, use a creation package instead. Returns {id, name, report}. Run check_room {path} first to see what will happen.',
    input: {
      path: z.string().describe('Absolute path to the room file (.glb / .gltf / .fbx / .blend / .obj)'),
      name: z.string().optional().describe('Display name (default: from the file name)'),
      autoSeats: z.boolean().default(true).describe('Add SPOT_xx places + cameras when the room has fewer than 2 (default true)'),
    },
    run: async ({ path: file, name, autoSeats }: { path: string; name?: string; autoSeats?: boolean }) => {
      if (!/\.(glb|gltf|fbx|blend|obj)$/i.test(file ?? '')) throw new ApiError('path must be a room file: .glb, .gltf, .fbx, .blend or .obj');
      const buf = await fs.readFile(file);
      const q = new URLSearchParams({ filename: path.basename(file), ...(name ? { name } : {}), ...(autoSeats === false ? {} : { autoSeats: '1' }) });
      return api('POST', `/api/rooms/import?${q}`, undefined, buf);
    },
  },
  {
    name: 'validate_creation_package', scope: 'read',
    description: 'Validate a creation package (schema, ids, scene.json, build-script safety policy) WITHOUT building it. Fix everything it reports before submitting.',
    input: { package: packageArg },
    run: ({ package: p }: { package: unknown }) => api('POST', '/api/aiconnect/package/validate', pkgBody(p)),
  },
  {
    name: 'submit_creation_package', scope: 'create',
    description: 'Put a validated creation package into the studio inbox. Nothing runs yet: the user clicks Build in the AI connectors page, which runs the Blender script locally, validates the room and installs it. Returns the inbox id.',
    input: { package: packageArg },
    run: ({ package: p }: { package: unknown }) => api('POST', '/api/aiconnect/inbox', pkgBody(p)),
  },
  {
    name: 'install_creation_package', scope: 'python',
    description: 'Build a creation package now: runs its Blender script headless (after the user approves it in the studio), validates the result and installs the room into assets/scenes (a modified room is backed up first). Returns {jobId}; use wait_for_job.',
    input: { package: packageArg },
    run: ({ package: p }: { package: unknown }) => api('POST', '/api/aiconnect/package/install', { ...pkgBody(p), approved: true }),
  },
  {
    name: 'generate_room', scope: 'create',
    description: 'Record a "generate a room" request (POST /api/rooms/generate: prompt, styles, basedOn). For a room built NOW, write a creation package instead.',
    input: { prompt: z.string(), styles: z.array(z.string()).optional(), basedOn: z.string().optional() },
    run: (args: unknown) => api('POST', '/api/rooms/generate', args),
  },
  {
    name: 'render_avatar', scope: 'render',
    description: 'Render an avatar with Blender (transparent background, soft 3-point light) and return the PNGs so you can SEE the model.',
    input: { id: z.string(), views: z.array(z.enum(VIEWS)).default(['front', 'three_quarter']), size: z.number().int().min(64).max(2048).default(512), camera: z.enum(['ortho', 'persp']).default('ortho') },
    run: async ({ id, views, size, camera }: { id: string; views?: string[]; size?: number; camera?: string }) => {
      const r = await api<{ images: string[]; views: string[]; bbox: unknown }>('POST', `/api/avatars/${encodeURIComponent(id)}/render`, { views: views ?? ['front', 'three_quarter'], size: size ?? 512, camera: camera ?? 'ortho' });
      return { content: [text({ views: r.views, bbox_gltf_yup: r.bbox }), ...(await Promise.all(r.images.map(fetchImage)))] };
    },
  },
  {
    name: 'generate_avatar', scope: 'create',
    description:
      'Start local AI generation of a new avatar model with ComfyUI on this PC (provider "comfy": needs ONE reference picture in `images`, ' +
      'makes a plain grey 3D model, and needs the Character 3D model set up in ComfyUI first: install_comfy_workflow "character-3d"; if it is missing the job fails ' +
      'with a plain sentence and the user presses "Set it up for me"). Nothing is sent to a cloud service. For anything else build the model yourself with ' +
      'blender_run_python. Returns {jobId}; use wait_for_job. Best for creatures, ' +
      'mascots, robots and props; humans / anime humans come from a proper base instead (get_docs topic "avatars"). ' +
      'Review the result from 8+ angles before calling it done.',
    input: {
      provider: z.enum(['comfy']).default('comfy'),
      prompt: z.string().optional(),
      images: z.array(z.string()).optional().describe('Reference images: local file paths or data: URLs'),
      name: z.string().optional(),
      faceless: z.boolean().optional().describe('No eyes/mouth in the model (VTube Pro adds procedural ones)'),
    },
    run: async (args: GenerateRequest) => {
      const images = args.images ? await Promise.all(args.images.map(toDataUrl)) : undefined;
      return api('POST', '/api/generate', { ...args, provider: 'comfy', images });
    },
  },
  {
    name: 'update_avatar', scope: 'library',
    description: 'Deep-merge a partial AvatarProfile into an avatar and save it (the live studio reloads it). Objects merge recursively; arrays/scalars replace. E.g. {"eyes":{"irisColor":"#3366ff","size":0.07}}.',
    input: { id: z.string(), patch: z.record(z.string(), z.unknown()) },
    run: async ({ id, patch }: { id: string; patch: Record<string, unknown> }) => {
      const cur = await api('GET', `/api/avatars/${encodeURIComponent(id)}`);
      const { id: _ignored, ...rest } = patch;
      return api('PUT', `/api/avatars/${encodeURIComponent(id)}`, deepMerge(cur, rest));
    },
  },
  {
    name: 'import_model', scope: 'library',
    description: 'Import a 3D model file from disk as a new avatar (.vrm/.glb/.gltf kept; .fbx/.obj/.stl/.ply/.blend converted to GLB with Blender). ' +
      'A model a creator script built (blender/human_creator, anime_creator) has its profile.json (eye and mouth anchors, hair chains, tracking) and costumes/*.glb next to it: ' +
      'those come along, and the `carried` field of the answer says what did (anything that did not is in `carried.warnings`).',
    input: { path: z.string().describe('Absolute path to the model file'), name: z.string().optional() },
    run: async ({ path: file, name }: { path: string; name?: string }) => {
      const buf = await fs.readFile(file);
      const creator = await readCreatorProfile(file);                 // (null: a plain model file)
      const given = name ?? (creator && typeof creator.name === 'string' ? creator.name : undefined);
      const q = new URLSearchParams({ filename: path.basename(file), ...(given ? { name: given } : {}) });
      const made = await api<AvatarProfile>('POST', `/api/avatars/import?${q}`, undefined, buf);
      if (!creator) return summarize(made);
      const carried = await carryCreatorProfile(api, made.id, path.dirname(file), creator);
      const now = carried.profile ? await api<AvatarProfile>('GET', `/api/avatars/${encodeURIComponent(made.id)}`).catch(() => made) : made;
      return { ...summarize(now), carried };
    },
  },
  {
    name: 'import_costume', scope: 'library',
    description: 'Add a costume GLB from disk to an avatar (skinned to the same bone names/rest pose - build it with blender/costume_kit.py through blender_run_python, then import it here).',
    input: { avatarId: z.string(), path: z.string().describe('Absolute path to the .glb'), name: z.string().optional() },
    run: async ({ avatarId, path: file, name }: { avatarId: string; path: string; name?: string }) => {
      const buf = await fs.readFile(file);
      const q = new URLSearchParams({ filename: path.basename(file), ...(name ? { name } : {}) });
      const r = await api<{ costume: unknown; warnings: string[] }>('POST', `/api/avatars/${encodeURIComponent(avatarId)}/costumes/import?${q}`, undefined, buf);
      return { costume: r.costume, warnings: r.warnings };
    },
  },
  {
    name: 'autorig', scope: 'library',
    description: 'Auto-rig an avatar with a skeleton (bone heat weights, envelope + distance fallbacks). People: a VRM-named humanoid from a soft-rig config normalized over the model bounding box (optional taps: chin, elbows, knees, ankles). Animals and things: bodyType fourLegs | bird | tail | thing plus taps ([u,v,w] over the glTF bbox, shared/rigTaps.ts: fourLegs nose, tailRoot, pawFR, pawHR (+ tailTip, pawFL, pawHL); bird nose, tailTip (+ wingTipR, footR); tail nose, tailTip; thing objStill, objBendEnd (+ objBendStart)). Writes a retarget map so live tracking drives head / neck / back. Returns {jobId}; use wait_for_job.',
    input: { id: z.string(), soft: softRig.optional(), bodyType: z.enum(['person', 'fourLegs', 'bird', 'tail', 'thing']).optional(), taps: z.record(z.string(), vec3).optional() },
    run: ({ id, soft, bodyType, taps }: { id: string; soft?: unknown; bodyType?: string; taps?: Record<string, number[]> }) => api('POST', `/api/avatars/${encodeURIComponent(id)}/autorig`, { soft, bodyType, taps }),
  },
  {
    name: 'set_costume', scope: 'live',
    description: 'Put a costume on an avatar (costumeId from list_costumes), or null/"none" to take it off. The live studio and OBS output switch immediately.',
    input: { avatarId: z.string(), costumeId: z.string().nullable() },
    run: async ({ avatarId, costumeId }: { avatarId: string; costumeId: string | null }) => {
      const cur = await api<AvatarProfile>('GET', `/api/avatars/${encodeURIComponent(avatarId)}`);
      const id = costumeId === null || costumeId === '' || costumeId === 'none' ? null : costumeId;
      if (id && !cur.costumes.some((c) => c.id === id)) throw new ApiError(`No costume '${id}' - available: ${cur.costumes.map((c) => c.id).join(', ') || '(none)'}`);
      const p = await api<AvatarProfile>('PUT', `/api/avatars/${encodeURIComponent(avatarId)}`, { ...cur, costume: id });
      return { avatarId, costume: p.costume };
    },
  },
  {
    name: 'send_command', scope: 'live',
    description: "Broadcast a remote-control command to the open studio/output pages over the live bus ({type:'command'}). Commands include 'load' {avatarId}, 'expression' {name, value}, 'screenshot'.",
    input: { command: z.string(), args: z.unknown().optional() },
    run: ({ command, args }: { command: string; args?: unknown }) => api('POST', '/api/command', { command, args }),
  },
  {
    name: 'blender_run_python', scope: 'python',
    description:
      'Run a bpy Python script in headless Blender 5.1 (after the user approves it in the studio). If avatarId is given its model is pre-imported ' +
      '(Blender Z-up; the model faces -Y). Write outputs into os.environ["VTP_OUT"]; export VTP_OUT/model.glb and pass saveAs to create a ' +
      'new avatar from it. PNGs written to VTP_OUT are returned as images. Principled BSDF / glTF colour values are LINEAR (convert ' +
      'sRGB hex first); rooms and avatars follow get_docs "environments" / "avatars".',
    input: { script: z.string(), avatarId: z.string().optional(), saveAs: z.string().optional().describe('Name for a new avatar created from VTP_OUT/model.glb'), timeoutSec: z.number().optional() },
    run: async ({ script, avatarId, saveAs, timeoutSec }: { script: string; avatarId?: string; saveAs?: string; timeoutSec?: number }) => {
      const r = await api<{ ok: boolean; error?: string; traceback?: string; stdout: string; files: string[]; avatar?: AvatarProfile }>('POST', '/api/blender/run', {
        script, avatarId, saveAs: saveAs ? { name: saveAs } : undefined, timeoutMs: timeoutSec ? timeoutSec * 1000 : undefined,
      });
      const content: Content[] = [text({ ok: r.ok, error: r.error, traceback: r.traceback, files: r.files, avatar: r.avatar && summarize(r.avatar), stdout: r.stdout.slice(-6000) })];
      for (const f of r.files.filter((f) => /\.png$/i.test(f)).slice(0, 4)) content.push(await fetchImage(f));
      return { content, isError: !r.ok };
    },
  },
  { name: 'get_diagnostics', scope: 'diag', description: 'Return the latest studio diagnostics (uploaded every 3 s while the camera tracks): live camera frame (camera.jpg, 640 px), stage picture (the newer of stage.jpg, 960 px wide, and stage.png: the full-resolution one from request_diagnostics, or from an older studio) and tracking/app state (state.json).', input: {}, run: () => diagnostics() },
  {
    name: 'request_diagnostics', scope: 'diag',
    description: "Ask the open studio to upload fresh diagnostics (broadcasts {type:'command', command:'diag'}), wait until they are in (usually ~1 s, at most ~4 s), then return them like get_diagnostics, with a full-resolution stage.png instead of the 960 px stage.jpg.",
    input: {},
    run: async () => {
      const sleep = (ms: number) => new Promise((res) => setTimeout(res, ms));
      // (250 ms of slack: the helper stamps the files, this process stamps the request)
      const since = new Date(Date.now() - 250).toISOString();
      const r = await api<{ clients: number }>('POST', '/api/command', { command: 'diag' });
      let fresh = false;
      if (r.clients) {
        // the studio answers within ~1 s (a cycle already running finishes first); poll for its stage.png + state.json
        for (let waited = 0; waited < 4000 && !fresh; ) {
          const step = waited ? 250 : 750;
          await sleep(step); waited += step;
          fresh = freshDiag((await api<DiagListing>('GET', '/api/diag')).files, since);
        }
      } else await sleep(1500);
      const d = await diagnostics(since);
      if (!r.clients) d.content.unshift(text('Warning: no studio page is connected to the bus, so nothing fresh was uploaded.'));
      else if (!fresh) d.content.unshift(text('Note: the studio did not upload a fresh full-resolution stage.png within 4 s, so these are the latest uploads (the newer of the automatic stage.jpg, every 3 s while the camera tracks, and a stage.png from before this request).'));
      return d;
    },
  },
  ...LOCAL_AI_TOOLS, // local_ai_recommend, comfy_workflows (server/localAiTools.ts): local model + ComfyUI knowledge
  ...COMFY_INSTALL_TOOLS, // install_comfy_workflow (user presses Yes on VTube Pro’s page), comfy_workflow_status (server/comfyWorkflowTools.ts)
  ...TO3D_TOOLS, // Pro2D -> 3D with the user's own AI + Blender MCP: to3d_* (server/to3d/mcpTools.ts, docs/PRO2D_TO_3D.md)
  ...AI_ADDONS_TOOLS, // ai_addons_status (server/aiAddonsTool.ts): Blender / GIMP MCP, ComfyUI, our skill: ready or the ONE step
];

export const toolByName = (name: string) => TOOLS.find((t) => t.name === name);

/** Run a tool's handler; API errors come back as tool errors instead of throwing. */
export async function runTool(def: ToolDef, args: unknown, ctx?: ToolCtx): Promise<ToolResult> {
  try {
    const r = await def.run(args ?? {}, ctx);
    if (r && typeof r === 'object' && 'content' in (r as object)) return r as ToolResult;
    return { content: [text(r)] };
  } catch (e) {
    return { content: [text(e instanceof Error ? e.message : String(e))], isError: true };
  }
}

/** JSON Schema of a tool's input (for OpenAI-style function calling in the built-in AI host). */
export function toolJsonSchema(def: ToolDef): Record<string, unknown> {
  const s = z.toJSONSchema(z.object(def.input), { io: 'input', unrepresentable: 'any' }) as Record<string, unknown>;
  delete s.$schema;
  return s;
}
