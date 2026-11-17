// MCP / built-in-AI tools for the Local AI knowledge (spread into TOOLS in server/mcpTools.ts). Both are scope "read":
// they only return text. They never scan the PC: a scan needs the user's click on the helper's Local AI page. If the
// user also switched on "Let AI assistants see a short summary" there, the tools use that summary; otherwise they work
// from facts the AI got from the user in the conversation (or give the general tier table).
// Out-of-process hosts (stdio MCP) reach the app over REST, so the summary comes from GET /api/local-ai/shared.
// Kept free of runtime imports from mcpTools.ts (no import cycle).
import { z } from 'zod';
import { CATALOG_CHECKED, COMFY_NODES, IMAGE_MODELS } from '../shared/localAi/catalog.ts';
import { budgetOf, hwFromFacts, recommend, recommendationMarkdown, STUDIO_VRAM_GB, TIERS } from '../shared/localAi/recommend.ts';
import { matchWorkflows, TASK_IDS, workflowsMarkdown } from '../shared/localAi/workflows.ts';
import type { ToolDef } from './mcpTools.ts';

const BASE = process.env.VTP_URL ?? `http://127.0.0.1:${process.env.VTP_PORT ?? 5191}`;
type Facts = { os?: string; vramGB?: number; ramGB?: number; gpuVendor?: string; gpuName?: string; appleSilicon?: boolean };

/** The user-approved summary, or null (helper not running / sharing off). */
export interface SharedFacts { os: string; gpuVendor: string | null; gpuName: string | null; vramGB: number | null; appleSilicon: boolean; ramGB: number; tier: string }
const toFacts = (s: SharedFacts): Facts => ({ os: s.os, gpuVendor: s.gpuVendor ?? undefined, gpuName: s.gpuName ?? undefined, vramGB: s.vramGB ?? undefined, ramGB: s.ramGB, appleSilicon: s.appleSilicon });
export async function fetchSharedFacts(base = BASE): Promise<SharedFacts | null> {
  try {
    const r = await fetch(`${base}/api/local-ai/shared`, { signal: AbortSignal.timeout(2000) });
    const j = r.ok ? await r.json() : null;
    return j?.shared ? j.facts : null;
  } catch { return null; }
}

const modelName = (id: string) => IMAGE_MODELS.find((m) => m.id === id)?.name ?? id;
const nodeName = (id: string) => COMFY_NODES.find((n) => n.id === id)?.name ?? id;

/** The general table when nothing is known about the PC. */
export function tierTable(): string {
  const lines = [`# Local AI by graphics-card memory (catalogue checked ${CATALOG_CHECKED})`,
    `VTube Pro keeps ~${STUDIO_VRAM_GB} GB while live, so "live" picks are one step smaller. Ask the user for their graphics card + memory, or ask them to open VTube Pro's Local AI page (http://127.0.0.1:5191/local-ai), click "Yes, scan my computer" and switch on sharing.`, '',
    '| Tier | Chat model (Ollama tag) | ComfyUI start models |', '|---|---|---|'];
  for (const t of TIERS) {
    const gb = t.id === 'cpu' ? 0 : t.minGB + 0.5;
    const r = recommend(t.id === 'cpu' ? hwFromFacts({ ramGB: 16 }) : hwFromFacts({ os: 'windows', gpuVendor: 'nvidia', vramGB: Math.round(gb), ramGB: 32 }));
    lines.push(`| ${t.label} (${t.example}) | ${r.llm.best ? `${r.llm.best.model.name} \`${r.llm.best.model.ollama}\`` : 'an AI app of your own'} | ${[...r.comfy.start, ...r.comfy.tight].slice(0, 3).map((m) => m.name).join(', ') || 'not recommended'} |`);
  }
  lines.push('', 'Licences: every pick above allows commercial use (Apache-2.0, Open RAIL++-M, Llama community licence). Restricted (warn, never default): FLUX.1/FLUX.2 [dev] and FLUX.2 klein 9B (non-commercial), RMBG-2.0 (CC BY-NC), Hunyuan3D (territory limits: not for the EU, UK or South Korea; only the Character 3D recipe uses it, never by default, for props, creatures, mascots and non-human characters, never for humans).');
  return lines.join('\n');
}

const factsInput = {
  vramGB: z.number().min(0).max(512).optional().describe('Graphics card memory in GB, if the user told you (0 = no graphics card)'),
  ramGB: z.number().min(0).max(4096).optional().describe('System RAM in GB, if known'),
  gpuVendor: z.enum(['nvidia', 'amd', 'intel', 'apple']).optional(),
  appleSilicon: z.boolean().optional().describe('An M-series Mac (unified memory)'),
  os: z.enum(['windows', 'macos', 'linux']).optional(),
};

export const LOCAL_AI_TOOLS: ToolDef[] = [
  {
    name: 'local_ai_recommend', scope: 'read',
    description:
      'Recommend the best LOCAL AI for the user\'s computer: a chat model (Ollama / LM Studio, with size + licence) and a ComfyUI ' +
      'setup + image models, with official links and plain install steps. Uses the hardware summary the user chose to share from ' +
      'VTube Pro\'s Local AI page; otherwise pass what the user told you (vramGB, ramGB, gpuVendor ...), or call with nothing for the tier ' +
      'table. Never scans: if you need a scan, ask the user to open http://127.0.0.1:5191/local-ai and click "Yes, scan my computer". ' +
      'Only suggest; never download or install for the user.',
    input: factsInput,
    run: async (args: Facts) => {
      const given = args && Object.values(args).some((v) => v !== undefined);
      if (given) return recommendationMarkdown(recommend(hwFromFacts(args)), { scanned: false, summary: JSON.stringify(args) });
      const shared = await fetchSharedFacts();
      if (shared) {
        const f = toFacts(shared);
        const summary = `${shared.gpuName ?? 'no graphics card'}${shared.vramGB ? ` ${shared.vramGB} GB` : ''}, ${shared.ramGB} GB RAM, ${shared.os}`;
        return recommendationMarkdown(recommend(hwFromFacts(f)), { scanned: true, summary });
      }
      return tierTable();
    },
  },
  {
    name: 'comfy_workflows', scope: 'read',
    description:
      'Curated ComfyUI workflows for VTube Pro jobs, matched to the graphics card: tasks ' + TASK_IDS.map((t) => `"${t}"`).join(', ') + '. ' +
      'Each gives the models (with licences), custom nodes, a step-by-step recipe, settings, the output size VTube Pro wants and how the ' +
      'result gets into VTube Pro (some are automated by tools/ai_texture/*). Use it to SUGGEST a workflow when the user wants pictures ' +
      '(avatar textures / skins, room tiles, skies, posters, decals, thumbnails, overlays, emotes). vramGB: the user\'s graphics memory ' +
      '(omit = use the shared scan summary, else show every variant). Every one is also a ready-made workflow file: to set it up in the ' +
      'user\'s ComfyUI, call install_comfy_workflow (the user presses Yes on VTube Pro’s page; you never can).',
    input: {
      task: z.string().optional().describe('A task id (or workflow id); omit for all'),
      vramGB: z.number().min(0).max(512).optional(),
    },
    run: async ({ task, vramGB }: { task?: string; vramGB?: number }) => {
      let gb = vramGB;
      if (gb === undefined) {
        const shared = await fetchSharedFacts();
        if (shared) gb = budgetOf(hwFromFacts(toFacts(shared))).effectiveGB;
      }
      const md = workflowsMarkdown({ task, vramGB: gb, modelName, nodeName });
      if (gb !== undefined && !matchWorkflows({ vramGB: gb, task }).length) return `${md}\n\nNothing fits ~${gb} GB well; suggest a smaller job.`;
      const used = new Set((task ? matchWorkflows({ vramGB: gb ?? 99, task }) : []).flatMap((p) => p.variant.models));
      const links = IMAGE_MODELS.filter((m) => used.has(m.id)).map((m) => `- ${m.name}: ${m.page} (${m.licence}; files: ${m.files.map((f) => `${f.file} -> ComfyUI/${f.folder}`).join('; ')})`);
      return links.length ? `${md}\n## Model downloads (official)\n${links.join('\n')}` : md;
    },
  },
];

/** For tests: the tool names this module adds. */
export const LOCAL_AI_TOOL_NAMES = LOCAL_AI_TOOLS.map((t) => t.name);
/** For the stage5 aiKnowledge DERIVED_RESOURCES hook (see the lane report). */
export const localAiKnowledge = async () => `${tierTable()}\n\n${workflowsMarkdown({ modelName, nodeName })}`;
