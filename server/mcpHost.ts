// Build an MCP server from the shared tool table (server/mcpTools.ts) with the scope gate (server/mcpScopes.ts).
// Used by server/mcp.ts (stdio), the /mcp route on :5191 (localhost streamable HTTP) and server/mcpRemote.ts (tunnel).
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { api, INSTRUCTIONS, readDoc, runTool, TOOLS, type DocKey, type ToolResult } from './mcpTools.ts';
import { availableDocs, availableResources } from './aiKnowledge.ts';
import { DEFAULT_SCOPES, gate, normalizeScopes, POLL_WAIT_MS, REMOTE_SAFE, WAITING_PREFIX, type ApprovalRequest, type Decision, type ScopeSettings } from './mcpScopes.ts';

export interface HostOptions {
  origin: 'local' | 'remote';
  client: string;
  settings?: () => Promise<ScopeSettings>;
  requestApproval?: (r: ApprovalRequest) => Promise<Decision>;
}

/** Out-of-process hosts ask the running app (GET scopes / long-poll POST approvals); no answer = defaults. */
export const httpSettings = async (): Promise<ScopeSettings> => {
  try { return normalizeScopes((await api<{ scopes: unknown }>('GET', '/api/aiconnect/scopes')).scopes); } catch { return DEFAULT_SCOPES; }
};
export const httpApproval = async (r: ApprovalRequest): Promise<Decision> => {
  // waitMs: the app answers within ~40 s (pending = still waiting: the AI calls again), so no call outlives Claude
  // Desktop's ~60 s tool limit
  try { return await api<Decision>('POST', '/api/aiconnect/approvals', { ...r, waitMs: POLL_WAIT_MS }); } catch (e) { return { approved: false, reason: (e as Error).message }; }
};

/** Tool names a host exposes (remote = REMOTE_SAFE only). */
export const exposedTools = (origin: 'local' | 'remote') => TOOLS.filter((t) => origin === 'local' || REMOTE_SAFE.has(t.name));

export function buildMcpServer(o: HostOptions): McpServer {
  const server = new McpServer({ name: 'vtube-pro', version: '1.1.0' }, { instructions: INSTRUCTIONS });
  const settings = o.settings ?? httpSettings;
  const requestApproval = o.requestApproval ?? httpApproval;
  for (const def of exposedTools(o.origin)) {
    server.registerTool(def.name, { description: def.description, inputSchema: def.input }, async (args: unknown): Promise<ToolResult> => {
      const refusal = await gate(def, args, { settings: await settings(), origin: o.origin, client: o.client, requestApproval });
      if (refusal?.startsWith(WAITING_PREFIX)) return { content: [{ type: 'text', text: refusal.slice(WAITING_PREFIX.length) }] };
      if (refusal) return { content: [{ type: 'text', text: refusal }], isError: true };
      return runTool(def, args, { origin: o.origin, client: o.client });
    });
  }
  // every guide in this install (server/aiKnowledge.ts AI_DOCS) as vtube-pro://docs/<FILE>.md ...
  for (const d of availableDocs()) {
    server.registerResource(`doc_${d.key}`, `vtube-pro://${d.file}`, { title: `${d.title} (${d.file.replace(/^docs\//, '')})`, description: d.about, mimeType: 'text/markdown' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await readDoc(d.key as DocKey) }],
    }));
  }
  // ... plus the short ones cut from them at read time: house rules, room contract, avatar checklist, recipes (only
  // those whose guide this install has: a listed resource that can't be read is worse than none)
  for (const r of availableResources()) {
    server.registerResource(r.name, r.uri, { title: r.title, description: r.description, mimeType: 'text/markdown' }, async (uri) => ({
      contents: [{ uri: uri.href, mimeType: 'text/markdown', text: await r.read() }],
    }));
  }
  return server;
}
