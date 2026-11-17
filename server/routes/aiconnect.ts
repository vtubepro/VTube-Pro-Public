// AI connectors (docs/AI_CONNECT.md). Everything sits behind server/localGuard.ts like the rest of :5191.
//   GET  /aiconnect                         the AI connectors page (setup per client, local setup, approvals, inbox, Create with AI)
//   GET  /api/aiconnect/status              clients, tools + scopes, Blender, Claude Desktop, Ollama / LM Studio / ComfyUI
//   GET|PUT /api/aiconnect/scopes           scope policy (live + python can never be "allow")
//   POST /api/aiconnect/remote              {enabled} remote connector on/off (creates the token)
//   POST /api/aiconnect/claude-desktop      add the vtube-pro entry to Claude Desktop's config (backup first) - page button only
//   GET|POST /api/aiconnect/approvals       pending approvals / MCP hosts long-poll here; POST /:id {decision}
//   GET  /api/aiconnect/pack                the AI instruction pack (text/markdown)
//   POST /api/aiconnect/package/validate|install, /room/validate, GET|POST /api/aiconnect/inbox, POST /inbox/:id/build
//   POST /api/aiconnect/provider            {id, baseUrl?, model?} built-in AI host settings (a model on this PC: loopback addresses only)
//   POST /api/aiconnect/agent/chat, GET /api/aiconnect/agent/:id    the built-in "Create with AI" chat
//   POST /mcp                               streamable-HTTP MCP for local agent frameworks (Bearer <localToken>)
//   POST /api/aiconnect/install-blender     opens a VISIBLE winget window for Blender (user click only)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.ts';
import { Router } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { blenderInfo } from '../blender.ts';
import { HttpError } from '../library.ts';
import { loadSettings } from '../settings.ts';
import { decidePending, detectClaudeDesktop, detectLocal, listPending, loadConf, publicConf, POLL_WAIT_MAX_MS, requestApproval, requestApprovalPolled, saveConf, setRemote, snippets, writeClaudeDesktopEntry } from '../aiconnect.ts';
import { getSession, PROVIDERS, startTurn } from '../aiAgent.ts';
import { addToInbox, installPackage, listInbox, readInbox, validatePackage, validateRoom } from '../aiPackage.ts';
import { buildMcpServer, exposedTools } from '../mcpHost.ts';
import { normalizeScopes, REMOTE_SAFE, SCOPE_LABELS } from '../mcpScopes.ts';
import { guideSection, readDoc } from '../mcpTools.ts';
import { docSection, HOUSE_RULES, readAiDoc } from '../aiKnowledge.ts';
import { AICONNECT_PAGE } from '../aiconnectPage.ts';
import { localBaseOk } from '../aiConnectors.ts';
import { pendingFromApprovals, pendingFromInbox, type PendingAnswer } from '../../shared/createConnect.ts';
import { installedRoomIds } from '../roomList.ts'; // not ./scenes.ts: that one starts the OBS watcher

export const aiconnectRoutes = Router();
const noStore = (res: any) => res.setHeader('Cache-Control', 'no-store');

// docked: the studio shows this page in a drawer (a frame): only the studio's own loopback pages may frame it
const FRAME_ANCESTORS = "frame-ancestors 'self' http://localhost:5190 http://127.0.0.1:5190 http://localhost:5191 http://127.0.0.1:5191";
aiconnectRoutes.get('/aiconnect', (_req, res) => { noStore(res); res.setHeader('Content-Security-Policy', FRAME_ANCESTORS); res.type('html').send(AICONNECT_PAGE); });

aiconnectRoutes.get('/api/aiconnect/status', async (_req, res) => {
  noStore(res);
  const c = loadConf();
  const [blender, local] = await Promise.all([blenderInfo(), detectLocal({ ollama: 'http://127.0.0.1:11434', lmstudio: 'http://127.0.0.1:1234', comfy: loadSettings().comfyUrl || 'http://127.0.0.1:8188' })]);
  res.json({
    conf: publicConf(c),
    tools: exposedTools('local').map((t) => ({ name: t.name, scope: t.scope, remote: REMOTE_SAFE.has(t.name) })),
    scopeLabels: SCOPE_LABELS,
    blender: blender ? { available: true, path: blender.path, version: blender.version } : { available: false },
    claudeDesktop: detectClaudeDesktop(),
    local,
    snippets: snippets(c.localToken),
    providers: PROVIDERS.map((p) => ({ ...p, configured: !!(c.providers[p.id]?.baseUrl || p.baseUrl) })),
    pending: listPending().length,
  });
});

aiconnectRoutes.get('/api/aiconnect/scopes', (_req, res) => { noStore(res); res.json({ scopes: loadConf().scopes }); });
aiconnectRoutes.put('/api/aiconnect/scopes', (req, res) => {
  const c = loadConf();
  c.scopes = normalizeScopes({ ...c.scopes, ...(req.body?.scopes ?? req.body ?? {}) });
  saveConf(c);
  res.json({ scopes: c.scopes });
});
aiconnectRoutes.post('/api/aiconnect/remote', (req, res) => { res.json(publicConf(setRemote(!!req.body?.enabled))); });

aiconnectRoutes.post('/api/aiconnect/claude-desktop', (req, res) => {
  if (req.body?.confirm !== true) throw new HttpError(400, 'Only the "Add to Claude Desktop" button may do this (confirm: true).');
  const d = detectClaudeDesktop();
  if (!d.configPath) throw new HttpError(404, 'Claude Desktop config location not found on this PC.');
  try { res.json({ ...writeClaudeDesktopEntry(d.configPath), next: 'Fully quit Claude Desktop (tray icon -> Quit) and open it again; "vtube-pro" appears under the tools / connectors menu.' }); }
  catch (e) { throw new HttpError(409, (e as Error).message); }
});

aiconnectRoutes.get('/api/aiconnect/approvals', (_req, res) => { noStore(res); res.json(listPending(true)); });
aiconnectRoutes.post('/api/aiconnect/approvals', async (req, res) => {
  const b = req.body ?? {};
  if (typeof b.tool !== 'string' || typeof b.scope !== 'string') throw new HttpError(400, 'Expected {tool, scope, client, args}');
  const r = { tool: b.tool, scope: b.scope, client: String(b.client ?? 'MCP client').slice(0, 80), args: b.args };
  // waitMs (stdio MCP since beta.12): a polled approval that answers within ~40 s ({pending:true} = call again); without it
  // the old long-poll (an older stdio server talking to this helper)
  if (typeof b.waitMs === 'number') res.json(await requestApprovalPolled(r, Math.min(Math.max(b.waitMs, 0), POLL_WAIT_MAX_MS)));
  else res.json(await requestApproval(r));
});
aiconnectRoutes.post('/api/aiconnect/approvals/:id', (req, res) => {
  const d = req.body?.decision;
  if (d !== 'approve' && d !== 'session' && d !== 'deny') throw new HttpError(400, 'decision: approve | session | deny');
  if (!decidePending(String(req.params.id), d)) throw new HttpError(404, 'That request is gone (answered or timed out).');
  res.json({ ok: true });
});

// "Check what Claude made" (src/ui/createGate.ts) and the studio's "Your AI is waiting for your OK" notice. Unlike
// /api/aiconnect/*, the studio may read this: what, from which app and when. Never a script or a package.
// Approving stays on the helper's own page (/aiconnect, local only). Studios since 1.0.0-beta.4.1 already ask for it.
aiconnectRoutes.get('/api/ai/pending', (_req, res) => {
  noStore(res);
  const now = Date.now();
  const approvals = listPending(false).map((p) => ({ id: p.id, tool: p.tool, client: p.client, createdAt: p.createdAt, expiresAt: p.expiresAt }));
  let inbox: ReturnType<typeof listInbox> = [];
  try { inbox = listInbox(); } catch { /* a damaged inbox file: the approvals still show */ }
  const items = [...pendingFromApprovals(approvals, now), ...pendingFromInbox(inbox, new Set(installedRoomIds()), now)].slice(0, 20);
  const answer: PendingAnswer = { v: 1, items, checked: { inbox: inbox.length, approvals: approvals.length } };
  res.json(answer);
});

aiconnectRoutes.get('/api/aiconnect/pack', async (_req, res) => {
  res.type('text/markdown').send(await instructionPack());
});

/** The copy-paste pack for any chat AI (no tools, no file access): house rules + the room contract + the package format. */
export async function instructionPack(root = ROOT): Promise<string> {
  const md = await readDoc('connect');
  const pack = ['Instruction pack', 'Creation package', 'Build or modify a room'].map((s) => guideSection(md, s)).join('\n\n');
  let contract = '';
  try { contract = docSection(await readAiDoc('environments', root), 'The room contract'); } catch { /* guide not in this install */ }
  const ex = ['build_ramen_bar.py', 'modify_add_plant.py'].map((f) => {
    try { return `### Example script: ${f}\n\`\`\`python\n${fs.readFileSync(path.join(root, 'tools', 'aiconnect_examples', f), 'utf8')}\`\`\`\n`; } catch { return ''; }
  }).join('\n');
  return `# VTube Pro - AI instruction pack\nYou are creating content for VTube Pro, a VTuber studio. Read all of this, then reply with ONE creation package (JSON).\n\n` +
    `${HOUSE_RULES}\n${pack}\n\n${contract ? `# Reference: the room contract (docs/ARTIST_ENVIRONMENTS.md)\n${contract}\n\n` : ''}${ex}`;
}

const pkgOf = (b: any) => { const p = b?.package ?? b; return typeof p === 'string' ? JSON.parse(p) : p; };
// (the Python checker runs off the event loop, which also relays tracking to OBS: server/aiPackage.ts runPy. Async
// handlers: Express 5 hands a rejection to the error handler, same status and words as the old synchronous throw.)
aiconnectRoutes.post('/api/aiconnect/package/validate', async (req, res) => { res.json(await validatePackage(pkgOf(req.body))); });
aiconnectRoutes.post('/api/aiconnect/room/validate', async (req, res) => { res.json(await validateRoom(String(req.body?.roomId ?? ''))); });
aiconnectRoutes.post('/api/aiconnect/package/install', async (req, res) => {
  // Reached from the page's Build button (a click) or from an MCP host AFTER the python-scope approval click.
  if (req.body?.approved !== true) throw new HttpError(400, 'Installing runs a Blender script: it needs the Build button or an approval.');
  res.json({ jobId: (await installPackage(pkgOf(req.body), loadSettings().comfyUrl || 'http://127.0.0.1:8188')).id });
});
aiconnectRoutes.get('/api/aiconnect/inbox', (_req, res) => { noStore(res); res.json(listInbox()); });
aiconnectRoutes.post('/api/aiconnect/inbox', async (req, res) => { res.json(await addToInbox(pkgOf(req.body), String(req.body?.from ?? 'AI client'))); });
aiconnectRoutes.get('/api/aiconnect/inbox/:id', (req, res) => { res.json(readInbox(String(req.params.id))); });
aiconnectRoutes.post('/api/aiconnect/inbox/:id/build', async (req, res) => {
  res.json({ jobId: (await installPackage(readInbox(String(req.params.id)), loadSettings().comfyUrl || 'http://127.0.0.1:8188')).id });
});

aiconnectRoutes.post('/api/aiconnect/provider', (req, res) => {
  const b = req.body ?? {};
  if (!PROVIDERS.some((p) => p.id === b.id)) throw new HttpError(400, 'Unknown provider');
  const c = loadConf();
  const cur = c.providers[b.id] ?? {};
  const baseUrl = typeof b.baseUrl === 'string' ? b.baseUrl.trim().replace(/\/+$/, '') : cur.baseUrl;
  if (baseUrl && !localBaseOk(baseUrl)) throw new HttpError(400, 'Use the address your model app shows on this PC (it starts with http://127.0.0.1).');
  c.providers[b.id] = {
    ...cur,
    baseUrl,
    model: typeof b.model === 'string' ? b.model.trim() : cur.model,
  };
  saveConf(c);
  res.json(publicConf(c).providers[b.id]);
});
aiconnectRoutes.post('/api/aiconnect/agent/chat', async (req, res) => {
  const b = req.body ?? {};
  if (!b.message) throw new HttpError(400, 'Say something first');
  try { const s = await startTurn({ sessionId: b.sessionId, provider: String(b.provider), model: b.model, message: String(b.message), mode: b.mode }); res.json({ sessionId: s.id, mode: s.mode, model: s.model }); }
  catch (e) { throw new HttpError(400, (e as Error).message); }
});
aiconnectRoutes.get('/api/aiconnect/agent/:id', (req, res) => {
  noStore(res);
  const s = getSession(String(req.params.id));
  if (!s) throw new HttpError(404, 'No such chat');
  const since = Number(req.query.since ?? 0);
  res.json({ busy: s.busy, mode: s.mode, model: s.model, usage: s.usage, events: s.events.slice(since), next: s.events.length });
});

// Local streamable-HTTP MCP: loopback guard (index.ts) + a token, so other local programs / web pages can't use it blind.
aiconnectRoutes.all('/mcp', async (req, res) => {
  const tok = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''))?.[1];
  if (!tok || tok !== loadConf().localToken) { res.status(401).json({ error: 'Bearer token required (AI connectors page -> Local HTTP MCP).' }); return; }
  const server = buildMcpServer({ origin: 'local', client: `HTTP MCP (${String(req.headers['user-agent'] ?? 'client').slice(0, 40)})`, settings: async () => loadConf().scopes, requestApproval: (r) => requestApprovalPolled(r) });
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  res.on('close', () => { void transport.close(); void server.close(); });
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

aiconnectRoutes.post('/api/aiconnect/install-blender', (req, res) => {
  if (req.body?.confirm !== true || process.platform !== 'win32') throw new HttpError(400, 'Use the button on the AI connectors page (Windows), or download Blender from https://www.blender.org/download/');
  // A visible console: winget shows the Blender licence / agreement prompts to the user; nothing is accepted for them.
  spawn('cmd.exe', ['/c', 'start', '"Install Blender"', 'cmd', '/k', 'winget install -e --id BlenderFoundation.Blender'], { detached: true, stdio: 'ignore', windowsHide: false }).unref();
  res.json({ ok: true, next: 'Follow the window that opened. When it finishes, press "Re-check" on the AI connectors page.' });
});
