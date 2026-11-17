// MCP / built-in-AI tool for "Make your AI better" (lane aiskills, beta.12; spread into TOOLS in server/mcpTools.ts).
// Scope "read": plain text only, no file paths, no config details. Not in REMOTE_SAFE (which programs are installed on
// this PC is nobody's business on the internet bridge). Out-of-process hosts (stdio MCP) reach the helper over REST.
// Kept free of runtime imports from mcpTools.ts (no import cycle).
import type { ToolDef } from './mcpTools.ts';

const BASE = process.env.VTP_URL ?? `http://127.0.0.1:${process.env.VTP_PORT ?? 5191}`;

export const AI_ADDONS_TOOLS: ToolDef[] = [
  {
    name: 'ai_addons_status', scope: 'read',
    description:
      'Which helpers for building are ready on this computer: the Blender MCP (and whether Blender is open and connected), ' +
      'GIMP and the GIMP MCP (for layered Pro2D art), Photoshop, ComfyUI, uv, and the VTube Pro Creator skill. For anything ' +
      'missing it gives the ONE step to tell the user. Read-only; call it before you rely on Blender, GIMP or ComfyUI.',
    input: {},
    run: async () => {
      try {
        const r = await fetch(`${BASE}/api/ai-addons/summary`, { signal: AbortSignal.timeout(20_000) });
        if (!r.ok) return `VTube Pro could not check its add-ons (error ${r.status}).`;
        return await r.text();
      } catch {
        return 'VTube Pro is not running. Ask the user to start VTube Pro, then try again.';
      }
    },
  },
];
