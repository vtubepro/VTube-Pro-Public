// Pro2D → 3D: the message the drawer hands to the AI app (lane to3d). Short on purpose: the instruction pack carries
// the detail. Claude Desktop opens prefilled from claude://claude.ai/new?q=<url-encoded> (NOT sent: the user presses
// Enter; cut at ~14,000 characters). ChatGPT's desktop app has no documented link, so its message goes to the clipboard
// and the steps say Codex mode (where its local MCP servers run; Work mode likely shares them, Chat mode doesn't).
import type { AppId } from './readiness.ts';

export const DEEPLINK_MAX = 14_000;

export function startPrompt(jobId: string, avatarName: string): string {
  return [
    `Make a 3D version of my VTube Pro avatar "${avatarName}". VTube Pro job: ${jobId}.`,
    `1. Call the vtube-pro tool get_instruction_pack with {"pack":"pro2d_to_3d","jobId":"${jobId}"} and follow it exactly, step by step.`,
    '2. Do your Blender work through my Blender MCP so I can watch.',
    'Keep going until the pack says the job is done or that you need me.',
  ].join('\n');
}

export function resumePrompt(jobId: string, avatarName: string): string {
  return [
    `Continue the 3D version of my VTube Pro avatar "${avatarName}". VTube Pro job: ${jobId}.`,
    `Call the vtube-pro tool get_instruction_pack with {"pack":"pro2d_to_3d","jobId":"${jobId}"}, then to3d_job {"jobId":"${jobId}"}, read the notes and do its nextStep. Don't start over.`,
  ].join('\n');
}

/** Claude Desktop's own link (prefilled, not sent). null when the message is too long for it. */
export function claudeDeepLink(text: string): string | null {
  const q = encodeURIComponent(text);
  return q.length <= DEEPLINK_MAX ? `claude://claude.ai/new?q=${q}` : null;
}

/** What the drawer says after Start, per app. */
export function startSteps(app: AppId, linked: boolean): string[] {
  if (app === 'claude') return linked
    ? ['Claude opens with the message filled in.', 'Press Enter in Claude to start.', 'If Claude asks to use a tool, allow it.']
    : ['The message is copied.', 'Open Claude, start a new chat, paste it and press Enter.', 'If Claude asks to use a tool, allow it.'];
  return ['The message is copied.', 'Open the ChatGPT app and pick Codex (Work mode may work too; plain Chat can\'t use VTube Pro).', 'Paste it and press Enter. Allow the tools when ChatGPT asks.'];
}

/** The pause / cost facts the drawer states up front (finding 9). */
export const PAUSE_NOTE: Record<AppId, string> = {
  claude: 'Claude stops after about 20 steps and shows "Continue". Click it each time; VTube Pro reminds you. A long run uses a lot of your Claude plan.',
  chatgpt: 'If ChatGPT stops before it says it is done, type "continue". A long run uses a lot of your ChatGPT plan.',
};
