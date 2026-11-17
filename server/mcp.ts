// VTube Pro MCP server (stdio). Lets Claude Desktop / Claude Code / Grok Build / Cursor / any MCP client drive VTube Pro
// and Blender by calling the running HTTP server at http://127.0.0.1:5191. Start the app first: `npm run dev`.
// Register with a client via the project's .mcp.json ("vtube-pro": npx tsx server/mcp.ts) or the AI connectors page
// (Settings -> AI connectors, docs/AI_CONNECT.md). The tools live in server/mcpTools.ts; scopes + approvals in
// server/mcpScopes.ts (live-changing tools and blender_run_python wait for a click in the studio).
//
// `--self-test` (lane toolsetup, beta.12): start the server in-process, list its tools, ask the helper for its status
// (read-only), print one line `VTP_MCP_SELFTEST {"ok":...}` and exit 0 / 1. For "it doesn't work in my AI app" support:
//   <the command + args from the app's settings> --self-test
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { buildMcpServer } from './mcpHost.ts';

if (process.argv.includes('--self-test')) {
  const [{ Client }, { InMemoryTransport }] = await Promise.all([import('@modelcontextprotocol/sdk/client/index.js'), import('@modelcontextprotocol/sdk/inMemory.js')]);
  const out: Record<string, unknown> = { ok: false };
  try {
    const server = buildMcpServer({ origin: 'local', client: 'VTube Pro self-test' });
    const [a, b] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: 'vtube-pro-self-test', version: '1' });
    await Promise.all([server.connect(a), client.connect(b)]);
    const tools = (await client.listTools()).tools.map((t) => t.name);
    out.tools = tools.length;
    const st = await client.callTool({ name: 'status', arguments: {} }) as { isError?: boolean; content?: { type: string; text?: string }[] };
    const text = st.content?.find((c) => c.type === 'text')?.text ?? '';
    out.helper = st.isError ? 'not reachable' : 'reached';
    if (!st.isError) { try { const j = JSON.parse(text) as { blender?: { available?: boolean; version?: string } | null }; out.blender = j.blender && j.blender.available !== false ? j.blender.version ?? 'found' : null; } catch { /* not JSON */ } }
    out.ok = tools.includes('get_docs') && tools.includes('status');
    await client.close();
  } catch (e) { out.error = (e as Error).message; }
  process.stdout.write(`VTP_MCP_SELFTEST ${JSON.stringify(out)}\n`);
  process.exit(out.ok ? 0 : 1);
}

const server = buildMcpServer({ origin: 'local', client: process.env.VTP_MCP_CLIENT ?? 'MCP client (stdio)' });
await server.connect(new StdioServerTransport());
