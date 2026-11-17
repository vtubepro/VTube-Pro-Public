// MCP / built-in-AI tools for the shareable ComfyUI workflows (spread into TOOLS in server/mcpTools.ts).
//   install_comfy_workflow {workflow, tier?, vramGB?}  scope "create": asks the helper to set a workflow up. The helper
//       opens its ComfyUI page on the user's computer with the full download list; ONLY the user's "Yes" there starts
//       anything. The AI can never consent for the user, and passes no URLs or paths (the helper uses its own catalogue).
//   comfy_workflow_status {request}                    scope "read": how that setup is going.
// Talks to the running helper over REST (stdio MCP hosts are a separate process). No runtime import from mcpTools.ts.
import { z } from 'zod';
import { tierFor, TIER_IDS, TIERS, WORKFLOW_DEFS, type TierId } from '../shared/comfyWorkflows/catalog.ts';
import { HUNYUAN_AI_FOR, HUNYUAN_PLACES } from '../shared/comfyWorkflows/models.ts';
import { fetchSharedFacts } from './localAiTools.ts';
import type { ToolDef } from './mcpTools.ts';

const BASE = process.env.VTP_URL ?? `http://127.0.0.1:${process.env.VTP_PORT ?? 5191}`;
const gb = (n: number) => `${(n / 1e9).toFixed(n < 1e9 ? 2 : 1)} GB`;
async function call(method: string, p: string, body?: unknown): Promise<any> {
  const r = await fetch(`${BASE}${p}`, { method, headers: body ? { 'content-type': 'application/json' } : {}, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(15_000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j;
}

const ids = WORKFLOW_DEFS.map((d) => d.id);

/** The guide every connected AI gets (docs/COMFYUI.md "For AIs"; resource vtube-pro://knowledge/comfy-workflows). */
export { COMFY_AI_GUIDE } from '../shared/comfyWorkflows/guide.ts';

export const COMFY_INSTALL_TOOLS: ToolDef[] = [
  {
    name: 'install_comfy_workflow', scope: 'create',
    description:
      'Set up a ready-made VTube Pro ComfyUI workflow in the user\'s own ComfyUI: models, add-on and the workflow itself. ' +
      `workflow: the exact id, the one the user names (${WORKFLOW_DEFS.map((d) => `"${d.id}" = ${d.short}`).join('; ')}). ` +
      '"avatar-texture-repaint" needs the texture AND a reference picture; "avatar-skin-variant" changes a texture from words only; ' +
      `"character-3d" turns one picture of the character into a grey 3D model. It uses Hunyuan3D, never bundled: the user's own download after their own Yes, and its licence does not cover ${HUNYUAN_PLACES} (tell the user first, and do not offer it to someone who lives there). ` +
      `Use it for ${HUNYUAN_AI_FOR}; humans and anime humans start from a proper base instead. ` +
      'tier: "small" (8 GB graphics card), "medium" (16 GB, works from 12) or "large" (24 GB); ' +
      'or pass vramGB and the tool picks. VTube Pro opens a page ON THE USER\'S COMPUTER that lists every download (file, size, official source, licence); ' +
      'it only starts when the USER presses Yes there. Tell the user to look at that page and press Yes. Then use comfy_workflow_status. ComfyUI must be open.',
    input: {
      workflow: z.string().describe('Workflow id, e.g. "stream-thumbnail" (or its task: thumbnail, emote, skybox ...)'),
      tier: z.enum(['small', 'medium', 'large']).optional().describe('small = 8 GB, medium = 16 GB, large = 24 GB graphics card'),
      vramGB: z.number().min(0).max(512).optional().describe('The user\'s graphics-card memory in GB, if you know it and not the tier'),
    },
    run: async ({ workflow, tier, vramGB }: { workflow: string; tier?: TierId; vramGB?: number }) => {
      const def = WORKFLOW_DEFS.find((d) => d.id === workflow || d.task === workflow);
      if (!def) return `No workflow "${workflow}". Pick one of: ${ids.join(', ')}.`;
      let t: TierId | undefined = tier;
      if (!t && vramGB !== undefined) t = tierFor(vramGB);
      if (!t && vramGB === undefined) {
        const shared = await fetchSharedFacts(BASE);
        if (shared?.vramGB) t = tierFor(shared.vramGB);
      }
      if (!t) return vramGB !== undefined
        ? `About ${vramGB} GB of graphics memory is below the smallest version (8 GB). Suggest a cloud image service, or the Local AI page for options.`
        : `Ask the user how much graphics-card memory they have, then call again with tier: ${TIER_IDS.map((x) => `"${x}" (${TIERS[x].label})`).join(', ')}.`;
      if (!def.tiers[t]) return `"${def.id}" has no ${t} version. Sizes: ${Object.keys(def.tiers).join(', ')}.`;
      const j = await call('POST', '/api/comfy-workflows/requests', { workflow: def.id, tier: t, open: true });
      const lines = [
        `# Setting up "${def.short}" (${TIERS[t].label}) — waiting for the user's OK`,
        j.opened ? 'I opened a page on the user\'s computer.' : `Ask the user to open this page on their computer: ${j.pageUrl}`,
        'Tell them: "Check the list on the VTube Pro page and press Yes to start. Nothing downloads before that."',
        '',
      ];
      if (!j.comfy) lines.push(j.why ? `Nothing can be set up yet. Tell the user, in your own words: ${j.why}` : 'ComfyUI is not open right now: ask them to open ComfyUI first, then press "Check again" on that page.');
      else if (j.plan) {
        lines.push(`What the page lists (${gb(j.plan.downloadBytes)} to download):`, ...j.plan.summary.map((s: string) => `- ${s}`));
        if (j.plan.notices?.length) lines.push('', 'Licence notice (tell the user, in your own words, before they press Yes):', ...j.plan.notices.map((s: string) => `- ${s}`));
        if (j.plan.blockers?.length) lines.push('', `Problem to fix first: ${j.plan.blockers[0]}`);
      }
      lines.push('', `Follow progress with comfy_workflow_status {request: "${j.request.id}"}.`);
      return lines.join('\n');
    },
  },
  {
    name: 'comfy_workflow_status', scope: 'read',
    description: 'How a ComfyUI workflow setup started with install_comfy_workflow is going (waiting for the user\'s Yes, downloading, done, or what went wrong).',
    input: { request: z.string().describe('The request id install_comfy_workflow returned') },
    run: async ({ request }: { request: string }) => {
      const q = await call('GET', `/api/comfy-workflows/requests/${encodeURIComponent(request)}`);
      const j = q.job;
      if (!j) return 'Waiting for the user to press Yes on the VTube Pro page (it lists every download). Nothing has started.';
      if (j.state === 'running') return `Working: ${j.phase}${j.file ? ` ${j.file}` : ''}. ${j.total ? `${gb(j.done)} of ${gb(j.total)} (${Math.round(j.done / j.total * 100)}%).` : ''}`;
      if (j.state === 'done') return `Done. "${j.workflowName.replace(/\.json$/, '')}" is in ComfyUI's Workflows list${j.workflowKept ? ' (it was already there, so the user\'s own copy was left as it is)' : ''}.${j.restartNeeded ? ' First close ComfyUI and open it again (new add-on).' : ''} Then: press W in ComfyUI, open it, change the green boxes, press Run.`;
      return `${j.state === 'cancelled' ? 'Stopped by the user.' : 'It did not finish:'} ${j.error ?? ''} They can press Try again on the page to continue where it left off.`;
    },
  },
];
export const COMFY_INSTALL_TOOL_NAMES = COMFY_INSTALL_TOOLS.map((t) => t.name);
