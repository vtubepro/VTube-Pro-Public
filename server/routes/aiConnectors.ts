// "Connect an AI in 3 steps" + the narrow AI API (lane ai-connect; docs/AI_CONNECT.md section 0;
// contract: T\portal\CONTRACT.md "ai-connect"). Logic lives in server/aiConnectors.ts.
//
// LOCAL ONLY (this PC's own pages; any other origin gets 403 {code:'local-only'} from server/localGuard.ts):
//   GET    /aiconnect/connect[#<id>]            the wizard page (one page per AI, 3 steps, a Test button)
//   POST   /api/ai/setup/:id {consent:true}     write the vtube-pro entry into Claude Desktop / ChatGPT / Grok Build config
//   DELETE /api/ai/setup/:id                    remove it (backup first, like the add)
//   POST   /api/ai/local/use {baseUrl,model,kind}  pick the model on this PC (loopback addresses only)
//   GET    /api/ai/bridge, POST /api/ai/bridge {on}, POST /api/ai/bridge/tunnel {on}
//                                               the internet bridge for Grok Bot / grok.com (its address holds a secret)
// OK FOR THIS PC'S PAGES:
//   GET  /api/ai/connectors                     every AI + its status
//   POST /api/ai/connectors/:id/test            run the Test with what is SAVED (the body is ignored)
//   PUT  /api/ai/model/:id {model}              which model the chat uses (the model on this PC)
//   GET  /api/ai/local/scan                     which model apps are running on this PC
//   GET  /api/ai/capabilities                   what a connected AI can do (tools, check tools, guides)
//   POST /api/ai/chat {connector,message,sessionId?}, GET /api/ai/chat/:id?since=   the built-in AI host (a model on this PC)
// Approvals (Blender Python, live changes) are never answered from the web: the chat says "approve in the helper".
import http from 'node:http';
import type { ChildProcess } from 'node:child_process';
import { Router, type Request } from 'express';
import { HttpError } from '../library.ts';
import { loadConf, saveConf, setRemote, stdioLaunch } from '../aiconnect.ts';
import { checkTools, getSession, startTurn } from '../aiAgent.ts';
import { availableDocs, availableResources } from '../aiKnowledge.ts';
import { TOOLS } from '../mcpTools.ts';
import { createRemoteListener } from '../mcpRemote.ts';
import {
  appInstalled, claudeDesktopLog, configTarget, CONNECTORS, connectorById, localBaseOk, LOCAL_KINDS, manualSnippet, readDesktopEntry, realEnv,
  scanLocal, setupDesktop, testLocal, testRemoteUrl, testStdioLaunch, unsetupDesktop, whichPath,
  type ConnectorDef, type ConnectorId, type Env, type TestResult,
} from '../aiConnectors.ts';
import { AI_WIZARD_PAGE } from '../aiconnectWizard.ts';
import { CONNECT_HOME_JS } from '../connectHome.ts';
import { LLM_MODELS } from '../../shared/localAi/catalog.ts';

/** A safe first model when the user hasn't run the Local AI check yet (ai-local's dated catalog; never hard-coded here). */
const starterModel = () => { const m = LLM_MODELS.find((x) => x.id === 'qwen3-8b') ?? LLM_MODELS.find((x) => x.tools && x.sizeGB >= 3 && x.sizeGB <= 6); return m ? { name: m.name, ollama: m.ollama, sizeGB: m.sizeGB } : null; };

/** What to do after "Add VTube Pro" (apps that read their settings only when they start). */
export const SETUP_NEXT: Partial<Record<ConnectorId, string>> = {
  'grok-build': 'Start a new Grok Build session: VTube Pro is in its tool list (/mcps).',
  'claude-code': 'Start a new Claude Code session (or type /mcp in a running one): VTube Pro is in its list.',
  'codex-cli': 'Start a new Codex session: VTube Pro is in its tool list (/mcp). ChatGPT Desktop sees it too.',
  // LM Studio loads mcp.json by itself when it is saved (CITES.lmstudioMcp): no restart
  cursor: 'Open Cursor Settings > MCP (or restart Cursor): VTube Pro is in the list. Switch it on if Cursor shows it off.',
  vscode: 'In VS Code open the Chat view in Agent mode and press the tools button: VTube Pro is in the list (VS Code asks you to trust it once).',
  'gemini-cli': 'Start a new Gemini CLI session: type /mcp to see VTube Pro in the list.',
  antigravity: 'In Antigravity open MCP Servers > Manage MCP Servers and press Refresh (or restart Antigravity): VTube Pro is in the list.',
  'lm-studio': 'Nothing to restart: LM Studio loads it by itself. Start a chat with a model that can use tools and ask it to make something. LM Studio asks before each tool call: allow it once, or always.',
};
/** Which built-in-host provider (server/aiAgent.ts) a chat connector uses. The AI apps (desktop / remote) chat in their own app. */
export const CHAT_PROVIDER: Partial<Record<ConnectorId, string>> = { local: 'local' };

export interface Deps {
  env: () => Env;
  launch: () => { command: string; args: string[] };
  remotePort: number;
}
export const defaultDeps = (): Deps => ({
  env: realEnv,
  launch: stdioLaunch,
  remotePort: Number(process.env.VTP_REMOTE_MCP_PORT ?? 5193),
});

// ---------------------------------------------------------------- the internet bridge (Grok Bot / grok.com / ChatGPT web)
interface Bridge { server: http.Server | null; tunnel: ChildProcess | null; url: string; note: string }

export function aiConnectorRoutes(d: Deps = defaultDeps()) {
  const r = Router();
  const lastTest = new Map<string, { ok: boolean; at: number; title: string }>();
  const owners = new Set<string>(); // chat sessions started through this router
  const bridge: Bridge = { server: null, tunnel: null, url: '', note: '' };
  const conn = (id: string): ConnectorDef => { const c = connectorById(id); if (!c) throw new HttpError(404, 'We don\'t know that AI.'); return c; };

  function status(c: ConnectorDef) {
    const e = d.env();
    const base = { id: c.id, name: c.name, kind: c.kind, blurb: c.blurb, getUrl: c.getUrl, getLabel: c.getLabel, cites: c.cites, lastTest: lastTest.get(c.id) ?? null };
    const supported = c.os[e.platform as 'win32' | 'darwin' | 'linux'] ?? true;
    if (c.kind === 'desktop') {
      const t = configTarget(c.id, e);
      const entry = t.supported ? readDesktopEntry(c.id, e) : null;
      const want = d.launch();
      const current = !!entry && entry.command === want.command && JSON.stringify(entry.args) === JSON.stringify(want.args);
      const log = c.id === 'claude-desktop' ? claudeDesktopLog(e) : null;
      return { ...base, supported: supported && t.supported, why: t.why ?? null, installed: appInstalled(c.id, e), added: !!entry, current, configPath: t.path,
        seenAt: log ? log.mtimeMs : null, manual: manualSnippet(c.id, want), ready: !!entry && current };
    }
    if (c.kind === 'local') {
      const p = loadConf().providers.local ?? {};
      return { ...base, supported: true, baseUrl: p.baseUrl ?? '', model: p.model ?? '', kinds: LOCAL_KINDS, starter: starterModel(), ready: !!p.baseUrl };
    }
    const conf = loadConf();
    return { ...base, supported: true, bridgeOn: !!bridge.server && conf.remote.enabled, tunnelOn: !!bridge.url, cloudflared: !!whichPath('cloudflared', e), ready: !!bridge.url && conf.remote.enabled };
  }

  r.get('/aiconnect/connect', (_req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    // the studio on THIS PC may dock it; nobody else may frame it (it opens as its own tab)
    res.setHeader('Content-Security-Policy', "frame-ancestors 'self' http://localhost:5190 http://127.0.0.1:5190 http://localhost:5191 http://127.0.0.1:5191");
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.type('html').send(AI_WIZARD_PAGE);
  });

  // the page's home view (Connect your AI: model advice, apps found here, add-ons): server/connectHome.ts
  r.get('/aiconnect/connect-home.js', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.type('application/javascript').send(CONNECT_HOME_JS); });

  r.get('/api/ai/connectors', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ connectors: CONNECTORS.map(status), platform: d.env().platform }); });

  r.put('/api/ai/model/:id', (req, res) => {
    const c = conn(String(req.params.id));
    const m = String(req.body?.model ?? '').trim();
    if (!/^[\w.:/@+-]{1,120}$/.test(m)) throw new HttpError(400, 'Pick a model from the list.');
    if (c.kind === 'local') { const conf = loadConf(); conf.providers.local = { ...(conf.providers.local ?? {}), model: m }; saveConf(conf); }
    else throw new HttpError(400, 'This AI picks its model in its own app.');
    res.json({ model: m });
  });

  r.post('/api/ai/setup/:id', async (req, res) => {
    const c = conn(String(req.params.id));
    if (c.kind !== 'desktop') throw new HttpError(400, 'This AI is not set up with a settings file.');
    if (req.body?.consent !== true) throw new HttpError(400, 'Tick "Yes, add VTube Pro" first.');
    try {
      const w = await setupDesktop(c.id, d.env(), d.launch());
      lastTest.delete(c.id);
      res.json({ ...w, next: SETUP_NEXT[c.id] ?? `Fully quit ${c.name} (also from the tray / menu bar) and open it again.` });
    } catch (e) { throw new HttpError(409, (e as Error).message); }
  });
  r.delete('/api/ai/setup/:id', async (req, res) => {
    const c = conn(String(req.params.id));
    if (c.kind !== 'desktop') throw new HttpError(400, 'This AI is not set up with a settings file.');
    try { res.json(await unsetupDesktop(c.id, d.env())); } catch (e) { throw new HttpError(409, (e as Error).message); }
  });

  r.get('/api/ai/local/scan', async (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ found: await scanLocal(d.env()), kinds: LOCAL_KINDS }); });
  r.post('/api/ai/local/use', (req, res) => {
    const baseUrl = String(req.body?.baseUrl ?? '').trim().replace(/\/+$/, '');
    if (!localBaseOk(baseUrl)) throw new HttpError(400, 'Use the address your model app shows on this PC (it starts with http://127.0.0.1).');
    const model = String(req.body?.model ?? '').trim().slice(0, 120);
    const kind = LOCAL_KINDS.some((k) => k.kind === req.body?.kind) ? String(req.body.kind) : 'custom';
    const conf = loadConf();
    conf.providers.local = { baseUrl, model, ...(kind ? { kind } : {}) } as typeof conf.providers.local;
    saveConf(conf);
    lastTest.delete('local');
    res.json({ baseUrl, model, kind });
  });

  r.post('/api/ai/connectors/:id/test', async (req, res) => {
    const c = conn(String(req.params.id));
    const e = d.env();
    let t: TestResult;
    if (c.kind === 'desktop') {
      const entry = readDesktopEntry(c.id, e);
      if (!entry) t = { ok: false, title: 'VTube Pro is not added yet', fix: 'Do step 2 first ("Add VTube Pro").' };
      else {
        t = await testStdioLaunch(entry, e);
        const log = c.id === 'claude-desktop' ? claudeDesktopLog(e) : null;
        if (t.ok) t.detail = log ? `${t.detail} Claude Desktop last started it ${new Date(log.mtimeMs).toLocaleString()}.` : `${t.detail} Now fully quit ${c.name} and open it again.`;
      }
    } else if (c.kind === 'local') {
      const p = loadConf().providers.local ?? {};
      t = p.baseUrl ? await testLocal(p.baseUrl, p.model, e) : { ok: false, title: 'No model picked yet', fix: 'Do step 2: start your model app, then press "Find my model".' };
    } else {
      const conf = loadConf();
      t = bridge.url && conf.remote.enabled ? await testRemoteUrl(`${bridge.url}/t/${conf.remote.token}/mcp`, e) : { ok: false, title: 'The internet bridge is off', fix: 'Do steps 1 and 2 first.' };
    }
    lastTest.set(c.id, { ok: t.ok, at: Date.now(), title: t.title });
    res.json(t);
  });

  r.get('/api/ai/capabilities', async (_req, res) => {
    res.json({
      tools: TOOLS.map((t) => ({ name: t.name, scope: t.scope })),
      checks: checkTools(),
      guides: availableDocs().map((g) => ({ key: g.key, title: g.title })),
      // (only the ones whose guide ships: a helper release keeps a few guides, and recipes_* would not read there)
      resources: availableResources().map((x) => ({ uri: x.uri, title: x.title })),
    });
  });

  // ---- chat through VTube Pro (the studio's way to talk to an AI)
  r.post('/api/ai/chat', async (req, res) => {
    const c = conn(String(req.body?.connector ?? ''));
    const provider = CHAT_PROVIDER[c.id];
    if (!provider) throw new HttpError(400, `Chat with ${c.name} in its own app: it uses VTube Pro's tools from there.`);
    const message = String(req.body?.message ?? '').trim();
    if (!message) throw new HttpError(400, 'Type what you want first.');
    if (message.length > 8000) throw new HttpError(400, 'That message is too long (8000 characters at most).');
    const sid = typeof req.body?.sessionId === 'string' ? req.body.sessionId : undefined;
    if (sid && !owners.has(sid)) throw new HttpError(404, 'That chat is gone. Start a new one.');
    // one running answer at a time
    for (const id of owners) if (id !== sid && getSession(id)?.busy) throw new HttpError(429, 'Your AI is still answering. Wait for it to finish, then send again.');
    try {
      const s = await startTurn({ sessionId: sid, provider, message, model: typeof req.body?.model === 'string' ? req.body.model.slice(0, 120) : undefined }, d.env().fetch);
      owners.add(s.id);
      res.json({ sessionId: s.id, model: s.model, mode: s.mode });
    } catch (e) { throw new HttpError(400, (e as Error).message); }
  });
  r.get('/api/ai/chat/:id', (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    const id = String(req.params.id);
    const s = getSession(id);
    if (!s || !owners.has(id)) throw new HttpError(404, 'That chat is gone. Start a new one.');
    const since = Math.max(0, Number(req.query.since ?? 0) || 0);
    const events = s.events.slice(since);
    res.json({ busy: s.busy, model: s.model, mode: s.mode, usage: s.usage, events, next: s.events.length });
  });

  // ---- the internet bridge (local only: its address contains the secret)
  const bridgeState = () => {
    const conf = loadConf();
    return { on: !!bridge.server && conf.remote.enabled, tunnel: bridge.url || null, connectorUrl: bridge.url && conf.remote.enabled ? `${bridge.url}/t/${conf.remote.token}/mcp` : null,
      cloudflared: !!whichPath('cloudflared', d.env()), note: bridge.note, port: d.remotePort };
  };
  const stopTunnel = () => { try { bridge.tunnel?.kill(); } catch { /* gone */ } bridge.tunnel = null; bridge.url = ''; };
  const stopBridge = () => { stopTunnel(); bridge.server?.close(); bridge.server = null; };
  r.get('/api/ai/bridge', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json(bridgeState()); });
  r.post('/api/ai/bridge', async (req, res) => {
    if (req.body?.on === true) {
      setRemote(true);
      if (!bridge.server) {
        const srv = createRemoteListener();
        await new Promise<void>((ok) => {
          srv.once('error', (err: NodeJS.ErrnoException) => { bridge.note = err.code === 'EADDRINUSE' ? `Port ${d.remotePort} is busy (is the bridge already running in a window?).` : err.message; ok(); });
          srv.listen(d.remotePort, '127.0.0.1', () => { bridge.server = srv; bridge.note = ''; ok(); });
        });
      }
    } else { stopBridge(); setRemote(false); }
    res.json(bridgeState());
  });
  r.post('/api/ai/bridge/tunnel', async (req, res) => {
    if (req.body?.on !== true) { stopTunnel(); res.json(bridgeState()); return; }
    if (!bridge.server) throw new HttpError(409, 'Switch the bridge on first (step 1).');
    const exe = whichPath('cloudflared', d.env());
    if (!exe) throw new HttpError(409, 'Cloudflare\'s free "cloudflared" tool is not installed yet. Get it from the link in step 2, then press this again.');
    if (!bridge.url) {
      stopTunnel();
      const child = d.env().spawn(exe, ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${d.remotePort}`], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      bridge.tunnel = child;
      bridge.url = await new Promise<string>((ok) => {
        let buf = '';
        const t = setTimeout(() => ok(''), 30_000);
        const seen = (b: Buffer) => { buf += b.toString('utf8'); const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(buf); if (m) { clearTimeout(t); ok(m[0]); } };
        child.stdout?.on('data', seen); child.stderr?.on('data', seen);
        child.on('exit', () => { clearTimeout(t); bridge.tunnel = null; bridge.url = ''; ok(''); });
      });
      if (!bridge.url) { stopTunnel(); throw new HttpError(502, 'Cloudflare did not give us an address. Check that this PC is online, then try again.'); }
    }
    res.json(bridgeState());
  });

  return r;
}
