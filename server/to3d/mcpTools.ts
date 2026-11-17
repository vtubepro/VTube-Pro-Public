// Pro2D → 3D MCP tools (lane to3d): thin wrappers over /api/to3d/ai/* on the helper (server/to3d/routes.ts). Rules for
// every one (docs/PRO2D_TO_3D.md, finding 2 + the Claude Desktop facts):
//   * answers in under 45 s (long work = a helper job + to3d_wait, which waits ≤ 40 s);
//   * never blocks on an approval: to3d_open_blender / to3d_submit answer waiting_for_ok at once (scope create; the
//     helper puts the request on the existing approval page and acts when the user clicks);
//   * results: one text block first, then image blocks (JPEG / PNG, a few hundred KB each), never structuredContent
//     (Codex drops images next to it); every picture is also a file in the job folder;
//   * job-scoped, local only: none of these is in REMOTE_SAFE.
// No runtime import from ../mcpTools.ts (no import cycle): its own tiny HTTP helper.
import { z } from 'zod';
import type { ToolDef, ToolResult } from '../mcpTools.ts';
import { overridesInput } from '../../shared/to3d/overrides.ts';
import { CHECKLIST, ANGLES } from '../../shared/to3d/job.ts';

const BASE = process.env.VTP_URL ?? `http://127.0.0.1:${process.env.VTP_PORT ?? 5191}`;
const HDR: Record<string, string> = process.env.VTP_MCP_CLIENT ? { 'X-VTP-MCP-Client': process.env.VTP_MCP_CLIENT.replace(/[^\x20-\x7e]/g, '').slice(0, 80) } : {};
type Content = ToolResult['content'][number];
const text = (v: unknown): Content => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v, null, 1) });

async function call<T = any>(method: 'GET' | 'POST', p: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(BASE + p, { method, headers: { ...HDR, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  } catch { throw new Error('VTube Pro isn\'t running (or not reachable): ask the user to start VTube Pro.'); }
  const t = await res.text();
  let j: any = null;
  try { j = t ? JSON.parse(t) : null; } catch { /* not JSON */ }
  if (!res.ok) throw new Error(j?.error ?? `HTTP ${res.status}: ${t.slice(0, 300)}`);
  return j as T;
}

async function image(p: string): Promise<Content | null> {
  try {
    const r = await fetch(BASE + p, { headers: HDR });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    if (b.length > 900_000) return text(`(picture ${p} is too big to send: ${Math.round(b.length / 1000)} KB)`);
    return { type: 'image', data: b.toString('base64'), mimeType: r.headers.get('content-type')?.split(';')[0] || 'image/png' } as Content;
  } catch { return null; }
}
const file = (jobId: string, rel: string) => `/api/to3d/ai/jobs/${encodeURIComponent(jobId)}/file?path=${encodeURIComponent(rel)}`;
const J = (jobId: string) => `/api/to3d/ai/jobs/${encodeURIComponent(jobId)}`;
const jobId = z.string().describe('The VTube Pro 3D job id (t3d-…), from the user\'s message or to3d_jobs');

export const TO3D_TOOLS: ToolDef[] = [
  {
    name: 'to3d_jobs', scope: 'read',
    description: 'Pro2D → 3D: the open 3D-version jobs (id, avatar, phase, round, next step). Use it to resume without an id.',
    input: {},
    run: () => call('GET', '/api/to3d/ai/jobs'),
  },
  {
    name: 'to3d_job', scope: 'read',
    description: 'Pro2D → 3D: one job: its state, rounds, notes, known gaps, the paths your Blender MCP may use, readiness (live?, which Blender MCP and its tool names) and nextStep = the ONE thing to do next. Start and resume here.',
    input: { jobId },
    run: ({ jobId: id }: { jobId: string }) => call('GET', J(id)),
  },
  {
    name: 'to3d_bundle', scope: 'read',
    description: 'Pro2D → 3D: the 2D model as structured data, one section per call: summary | parts | params | deformers | physics | expressions | layers | bones | measure | colours | design. Measurements are in IPD units (eye-to-eye), 2D y points DOWN; colours come as sRGB hex AND linear.',
    input: { jobId, section: z.enum(['summary', 'parts', 'params', 'deformers', 'physics', 'expressions', 'layers', 'bones', 'measure', 'colours', 'design']).default('summary') },
    run: ({ jobId: id, section }: { jobId: string; section?: string }) => call('GET', `${J(id)}/bundle?section=${section ?? 'summary'}`),
  },
  {
    name: 'to3d_references', scope: 'render',
    description: 'Pro2D → 3D: the 2D model as drawn, as ONE sheet: front, head, the rig\'s own ±30 head turns, blink, mouth open and each expression (sheet), or single pictures by name (head, head_turnL, head_turnR, blink, mouth_open, front, expr_<id>, layer_<id>).',
    input: { jobId, names: z.array(z.string().regex(/^[A-Za-z0-9_-]{1,60}$/)).max(4).optional().describe('Single pictures instead of the sheet') },
    run: async ({ jobId: id, names }: { jobId: string; names?: string[] }) => {
      const list = names?.length ? names : ['sheet'];
      const imgs = await Promise.all(list.map((n) => image(file(id, `refs/${n}.png`))));
      return { content: [text(`2D references (${list.join(', ')}): the eye-to-eye distance is the unit for every measurement.`), ...imgs.filter((x): x is Content => !!x)] };
    },
  },
  {
    name: 'to3d_parts', scope: 'render',
    description: 'Pro2D → 3D: cut-outs of the 2D model\'s meshes (≤ 12) with role, side, box in IPD units and main colour. names: words to match mesh names or roles (hair_front, ahoge, accessory …); empty = the first 12.',
    input: { jobId, names: z.array(z.string()).max(12).optional() },
    run: async ({ jobId: id, names }: { jobId: string; names?: string[] }) => {
      const parts = await call<{ file: string; name: string; role: string; side: string; boxIpd: number[]; colour: string | null }[]>('GET', `${J(id)}/parts?names=${encodeURIComponent((names ?? []).join(','))}`);
      const imgs = await Promise.all(parts.slice(0, 6).map((p) => image(file(id, `refs/${p.file}`))));
      return { content: [text(parts.map((p, i) => `${i < 6 ? `[picture ${i + 1}] ` : ''}${p.name}: ${p.role}${p.side ? ` (${p.side})` : ''}, box ${p.boxIpd.join(' ')} IPD, ${p.colour ?? '-'}`).join('\n') || 'no parts matched'), ...imgs.filter((x): x is Content => !!x)] };
    },
  },
  {
    name: 'to3d_baseline', scope: 'create',
    description: 'Pro2D → 3D: start round 0, the deterministic first pass (the 2D → 3D pipeline on VTube Pro\'s own bundled base body, Mirelle or Kairo, already included, or the user\'s own base; nothing to download; headless Blender, low priority). Returns at once: call to3d_wait. route "image" only when nextStep says so.',
    input: { jobId, route: z.enum(['vtp2', 'image']).optional(), overrides: overridesInput.optional() },
    run: ({ jobId: id, route, overrides }: { jobId: string; route?: string; overrides?: Record<string, unknown> }) => call('POST', `${J(id)}/baseline`, { route, overrides }),
  },
  {
    name: 'to3d_wait', scope: 'read',
    description: 'Pro2D → 3D: wait (≤ 40 s) for the running step, then return phase, progress, the newest round, its check (scores, worst region, review) WITH its pictures (compare, 8 angles, expressions), and nextStep. Still running = call it again.',
    input: { jobId },
    run: async ({ jobId: id }: { jobId: string }) => {
      const w = await call<{ check: { pictures: string[] } | null } & Record<string, unknown>>('GET', `${J(id)}/wait`);
      const pics = w.check ? await Promise.all(w.check.pictures.map((p) => image(file(id, p)))) : [];
      return { content: [text(w), ...pics.filter((x): x is Content => !!x)] };
    },
  },
  {
    name: 'to3d_rebuild', scope: 'create',
    description: 'Pro2D → 3D: the main lever. A new round from round `from` (default: the best) with design overrides (validated; unknown keys are refused with the nearest real key). VTube Pro rebuilds only what the change needs (everything / the hair / the springs / the profile). Returns at once: call to3d_wait.',
    input: { jobId, overrides: overridesInput, from: z.number().int().min(0).optional() },
    run: ({ jobId: id, overrides, from }: { jobId: string; overrides: Record<string, unknown>; from?: number }) => call('POST', `${J(id)}/rebuild`, { overrides, from }),
  },
  {
    name: 'to3d_graft', scope: 'create',
    description: 'Pro2D → 3D: bring parts you built in the user\'s Blender (through their Blender MCP) into a new round. parts = GLB file names you exported into the job\'s work/parts folder (skinned to the avatar\'s bones, or parented to one bone). hide = base mesh names a part replaces (never Face / Body). Returns at once: call to3d_wait.',
    input: { jobId, parts: z.array(z.string()).min(1).max(8), hide: z.array(z.string()).max(8).optional(), from: z.number().int().min(0).optional() },
    run: ({ jobId: id, parts, hide, from }: { jobId: string; parts: string[]; hide?: string[]; from?: number }) => call('POST', `${J(id)}/graft`, { parts, hide, from }),
  },
  {
    name: 'to3d_check', scope: 'render',
    description: `Pro2D → 3D: ONE call that renders a round in the app renderer (${ANGLES.join(', ')}° + an expression / viseme sheet), compares it with the 2D at identical framing (scores per region + the worst region) and runs the automatic review (PASS / WARN / FAIL). Returns at once: call to3d_wait for the result and the pictures.`,
    input: { jobId, round: z.number().int().min(0).optional() },
    run: ({ jobId: id, round }: { jobId: string; round?: number }) => call('POST', `${J(id)}/check`, { round }),
  },
  {
    name: 'to3d_note', scope: 'create',
    description: `Pro2D → 3D: your note for a round (stored on VTube Pro: a new chat resumes from it): text = what you changed and why; checklist = exactly ${CHECKLIST.length} true / false answers in the pack's order; angles = pass / fail for each of ${ANGLES.join(', ')}; gaps = what you could not match, in plain words.`,
    input: { jobId, round: z.number().int().min(0).optional(), text: z.string().max(4000), checklist: z.array(z.boolean()).length(CHECKLIST.length).optional(),
      angles: z.record(z.string(), z.boolean()).optional(), gaps: z.array(z.string()).max(12).optional() },
    run: ({ jobId: id, ...b }: { jobId: string } & Record<string, unknown>) => call('POST', `${J(id)}/note`, b),
  },
  {
    name: 'to3d_revert', scope: 'create',
    description: 'Pro2D → 3D: go back to an earlier round (default: the best). A new round copies it; try a different lever next.',
    input: { jobId, round: z.number().int().min(0).optional() },
    run: ({ jobId: id, round }: { jobId: string; round?: number }) => call('POST', `${J(id)}/revert`, { round }),
  },
  {
    name: 'to3d_open_blender', scope: 'create',
    description: 'Pro2D → 3D: ask VTube Pro to open the user\'s Blender (visible, with their Blender MCP) on the current best round. Answers waiting_for_ok at once; Blender opens when the user approves, never while they are live. Poll to3d_job.',
    input: { jobId },
    run: ({ jobId: id }: { jobId: string }) => call('POST', `${J(id)}/open-blender`, {}),
  },
  {
    name: 'to3d_vision', scope: 'read',
    description: 'Pro2D → 3D: can you see tool pictures? Call without answer: you get a picture with a code word. Call again with answer = that code (or "cannot-see"). Without pictures the job runs in numbers-only mode.',
    input: { jobId, answer: z.string().max(20).optional() },
    run: async ({ jobId: id, answer }: { jobId: string; answer?: string }) => {
      const r = await call<{ ok: boolean | null; picture: string | null }>('POST', `${J(id)}/vision`, { answer });
      if (r.picture) { const im = await image(r.picture); return { content: [text('Read the code word in this picture and call to3d_vision again with answer = the code. If no picture came through, answer "cannot-see".'), ...(im ? [im] : [])] }; }
      return { content: [text(r.ok ? 'Pictures come through: work with the full recipe.' : 'No pictures: numbers-only mode (parametric levers only, at most 4 rounds; the user judges the pictures at Approve).')] };
    },
  },
  {
    name: 'to3d_submit', scope: 'create',
    description: 'Pro2D → 3D: hand a round (default: the best) in. Checks it can be submitted (checked in the app renderer, review not FAIL, the checklist + 8 angles in its note), then puts "add it as a NEW avatar" on the user\'s approval page and answers waiting_for_ok at once. It is added when they approve; never worn. Poll to3d_job.',
    input: { jobId, round: z.number().int().min(0).optional() },
    run: ({ jobId: id, round }: { jobId: string; round?: number }) => call('POST', `${J(id)}/submit`, { round }),
  },
];
