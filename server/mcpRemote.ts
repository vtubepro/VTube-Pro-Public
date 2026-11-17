// OPTIONAL remote MCP endpoint for clients that only take an HTTPS URL (ChatGPT developer-mode connectors, grok.com custom
// connectors). OFF by default. The user must (1) switch "Remote connector" on in the AI
// connectors page (that creates a long random token), (2) start this listener: `npx tsx server/mcpRemote.ts`, and
// (3) start their own tunnel to it (cloudflared tunnel --url http://127.0.0.1:5193 / ngrok http 5193).
//
// Safety: it is its own small listener (127.0.0.1:5193), NOT the app server - server/localGuard.ts stays in place on
// :5191. It serves only REMOTE_SAFE tools (read / render / validate / submit to the inbox); blender_run_python, live,
// library and diagnostics tools are never exposed. Every request needs the token: in the URL path
// (https://<tunnel>/t/<token>/mcp - for ChatGPT / Grok "no auth" connectors) or `Authorization: Bearer <token>`.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { buildMcpServer } from './mcpHost.ts';

import { CONFIG_DIR } from './paths.ts';
const CONF = process.env.VTP_AICONNECT_CONFIG ?? path.join(CONFIG_DIR, 'aiconnect.json');
const PORT = Number(process.env.VTP_REMOTE_MCP_PORT ?? 5193);

function remoteConf(): { enabled: boolean; token: string } {
  try {
    const c = JSON.parse(fs.readFileSync(CONF, 'utf8'));
    return { enabled: !!c?.remote?.enabled, token: String(c?.remote?.token ?? '') };
  } catch { return { enabled: false, token: '' }; }
}

const same = (a: string, b: string) => a.length === b.length && crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

/** The token from /t/<token>/mcp or a Bearer header; null if missing. */
export function tokenOf(req: http.IncomingMessage): string | null {
  const m = /^\/t\/([A-Za-z0-9_-]{32,})\/mcp\/?(\?.*)?$/.exec(req.url ?? '');
  if (m) return m[1];
  const h = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization ?? ''));
  return h && /^\/mcp\/?(\?.*)?$/.test(req.url ?? '') ? h[1] : null;
}

export function createRemoteListener(conf = remoteConf) {
  return http.createServer(async (req, res) => {
    const c = conf();
    const deny = (status: number, msg: string) => { res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: msg })); };
    if (!c.enabled || c.token.length < 32) return deny(403, 'Remote connector is switched off in VTube Pro (Settings -> AI connectors).');
    const t = tokenOf(req);
    if (!t || !same(t, c.token)) return deny(401, 'Missing or wrong token.');
    // stateless: a fresh server + transport per request (tools are cheap to register)
    const server = buildMcpServer({ origin: 'remote', client: 'Remote connector (tunnel)' });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => { void transport.close(); void server.close(); });
    try {
      await server.connect(transport);
      let body: unknown;
      if (req.method === 'POST') {
        const chunks: Buffer[] = [];
        for await (const ch of req) chunks.push(ch as Buffer);
        const raw = Buffer.concat(chunks).toString('utf8');
        if (raw.length > 2_000_000) return deny(413, 'Request too large');
        body = raw ? JSON.parse(raw) : undefined;
      }
      await transport.handleRequest(req, res, body);
    } catch (e) {
      if (!res.headersSent) deny(400, (e as Error).message);
    }
  });
}

// Run directly only. The basename check matters in the bundled helper (dist-helper/index.mjs, helper-hardening): there
// every module shares the bundle's import.meta.url, so the path test alone would start this CLI inside the server.
if (process.argv[1] && /mcpRemote\.[cm]?[jt]s$/.test(process.argv[1]) && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const c = remoteConf();
  if (!c.enabled) {
    console.error('[vtube-pro remote MCP] The remote connector is OFF. Switch it on in Settings -> AI connectors first.');
    process.exit(1);
  }
  createRemoteListener().listen(PORT, '127.0.0.1', () => {
    console.log(`[vtube-pro remote MCP] listening on http://127.0.0.1:${PORT}  (safe tools only)`);
    console.log(`Now start a tunnel:  cloudflared tunnel --url http://127.0.0.1:${PORT}   (or: ngrok http ${PORT})`);
    console.log('Connector URL = https://<tunnel-host>/t/<token>/mcp   (copy the full URL from the AI connectors page)');
  });
}
