// "How do you want to create?" (lane create-gating). The studio's Create area asks this BEFORE any "describe it" box:
// nobody is prompted to create until at least one way really works. Pure logic (no DOM, no fetch) so
// tools/create_gate_unit.ts can prove the gating with made-up states. The UI is src/ui/createGate.ts.
//
// The three ways:
//   app    an AI app you already have (Claude Desktop, Claude Code, ChatGPT Desktop, Codex, Grok Build, LM Studio; Grok Bot
//          through the internet bridge). These do the making themselves by talking to VTube Pro through the helper's MCP server.
//   local  your own computer: ComfyUI for 3D (ai-local) and/or a chat model (Ollama, LM Studio ...) via ai-connect.
//   hand   by hand in Blender with our guides, then "Add my model". Always possible, but it is not AI making.
// VTube Pro holds no AI account and no API key: nothing here talks to a cloud AI service.
// Status comes from the helper: GET /api/ai/connectors (ai-connect) and
// GET /api/status (Blender found, ComfyUI reachable, and whether ComfyUI has the 3D model:
// status.comfy.character, which a helper older than 2026-10 does not send).
import type { ComfyCharacterStatus } from './types.ts';

export type CreateWay = 'app' | 'local' | 'hand';
export type ConnectorKind = 'desktop' | 'remote' | 'local';

/** The part of an ai-connect connector the gate reads (GET /api/ai/connectors). */
export interface GateConnector {
  id: string; name: string; kind: ConnectorKind; supported: boolean; ready: boolean;
  lastTest?: { ok: boolean; at?: number; title?: string } | null;
  /** Claude Desktop: when it last started VTube Pro's connection (ms). */
  seenAt?: number | null;
  model?: string;
}
export interface GateInput {
  /** null = still loading; 'offline' = the helper didn't answer. */
  connectors: GateConnector[] | null | 'offline';
  /** GET /api/status (null = unknown). Used for Blender + ComfyUI. */
  status?: { blender?: { available: boolean }; comfy?: { reachable: boolean; character?: ComfyCharacterStatus } } | null;
  /** The user picked "Do it by hand" (remembered on this computer). */
  handChosen?: boolean;
}

export interface WayState {
  way: CreateWay;
  /** At least one thing in this way works now. */
  ready: boolean;
  /** Names of what works ("Claude Desktop", "ComfyUI" ...). */
  working: string[];
  /** Ready AND a Test passed (or the app has used it): shown as "Connected" rather than "Set up". */
  tested: boolean;
}
export interface InPageCreate {
  /** The studio's own "Create my character" can run. */
  ok: boolean;
  provider: 'comfy' | null;
  /** When !ok: one friendly sentence (what is missing). */
  why: string;
  /** When !ok and one click fixes it: 'setup' = open the ComfyUI page on Character 3D (`url`, a page path). */
  fix?: GateFix;
  /** ComfyUI is the builder and VTube Pro's own Character 3D will run (not the user's own workflow file): it turns a PICTURE
   *  into 3D, so words alone are refused. Not set when the helper is older (it cannot say which will run: let it try) or the
   *  user's own workflow runs (it may work from words). Also set while the 3D model is missing (the fix is "Set it up"). */
  needsPicture?: boolean;
}
export interface GateFix { action: 'setup'; label: string; url?: string }
export interface Gate {
  phase: 'loading' | 'offline' | 'ready' | 'choose';
  ways: Record<CreateWay, WayState>;
  /** At least one AI way works: the Create prompts may be shown. */
  canCreate: boolean;
  /** The AI apps that can make things for you (shown as "Your AI is ready: ask it in ..."). */
  apps: GateConnector[];
  /** Built-in chat (Ask your AI) works: a model on this computer. */
  chat: boolean;
  inPage: InPageCreate;
}

/** Which connector belongs to which way. */
export function wayOf(c: Pick<GateConnector, 'kind'>): CreateWay {
  return c.kind === 'desktop' || c.kind === 'remote' ? 'app' : 'local';
}

/** Plain words for ComfyUI being open but unable to make a character yet (it blocks). */
export const COMFY_NEEDS_MODEL = 'ComfyUI needs its 3D model first (one time, 5 to 8 GB). We set it up for you.';
/** The button that fixes a ComfyUI that cannot make a character yet (same words on the Create card and in the Advanced builder). */
export const SETUP_FIX_LABEL = 'Set it up for me';
/** The helper page the "Set it up for me" button opens when the helper gave no address of its own (Character 3D, size by the helper's guess). */
export const CHARACTER_SETUP_PAGE = '/comfyui?workflow=character-3d';

export function computeGate(i: GateInput): Gate {
  const empty = (way: CreateWay): WayState => ({ way, ready: false, working: [], tested: false });
  const ways: Record<CreateWay, WayState> = { app: empty('app'), local: empty('local'), hand: empty('hand') };
  const blender = !!i.status?.blender?.available;
  const comfy = !!i.status?.comfy?.reachable;
  const list = Array.isArray(i.connectors) ? i.connectors : [];
  for (const c of list) {
    if (!c.ready || !c.supported) continue;
    const w = ways[wayOf(c)];
    w.ready = true; w.working.push(c.name);
    if (c.lastTest?.ok || (c.seenAt ?? 0) > 0) w.tested = true;
  }
  if (comfy) { ways.local.ready = true; ways.local.working.push('ComfyUI'); ways.local.tested = true; }
  if (blender || i.handChosen) { ways.hand.ready = blender; if (blender) ways.hand.working.push('Blender'); }

  const canCreate = ways.app.ready || ways.local.ready;
  const apps = list.filter((c) => wayOf(c) === 'app' && c.ready && c.supported);
  const chat = list.some((c) => c.kind === 'local' && c.ready);

  // ComfyUI makes a character when the server says it is ready (status.comfy.character): the Hunyuan3D model files are in its
  // folders, or the user's own workflow file will run (`own`: no model files needed). When the server cannot say, a ComfyUI that
  // is reachable still gets the Create button (it is what worked before), never a block.
  const char = i.status?.comfy?.character;
  let inPage: InPageCreate;
  if (comfy && (!char || char.ready)) inPage = { ok: true, provider: 'comfy', why: '', needsPicture: !!char && !char.own };
  else if (comfy) inPage = { ok: false, provider: null, why: COMFY_NEEDS_MODEL, needsPicture: true, fix: { action: 'setup', label: SETUP_FIX_LABEL, url: char!.setupUrl } };
  else if (apps.length) inPage = { ok: false, provider: null, why: `Ask ${apps[0].name} instead: it makes things in VTube Pro for you.` };
  else if (ways.local.ready) inPage = { ok: false, provider: null, why: 'Your model can build rooms in Ask your AI. 3D characters need ComfyUI on this computer.' };
  else inPage = { ok: false, provider: null, why: 'Pick how you want to create first.' };

  const phase: Gate['phase'] = i.connectors === null ? 'loading' : i.connectors === 'offline' && !canCreate ? 'offline' : canCreate ? 'ready' : 'choose';
  return { phase, ways, canCreate, apps, chat, inPage };
}

// ---------------------------------------------------------------- what each way needs (plain words, VOICE.md)
export interface WayCopy { title: string; sub: string; needs: string; cost: string; free: boolean; time: string }
export const WAY_COPY: Record<CreateWay, WayCopy> = {
  app: { title: 'Use an AI app I already have', sub: 'Claude, ChatGPT, Codex or Grok makes things for you by talking to VTube Pro.',
    needs: 'The app on this computer, then one click to link it.', cost: 'VTube Pro asks for no account or key', free: true, time: 'About 2 minutes' },
  local: { title: 'Use my own computer', sub: 'Free and private. Runs on your graphics card, nothing goes online.',
    needs: 'A strong graphics card, plus ComfyUI or Ollama (free).', cost: 'Free', free: true, time: 'About 20 minutes' },
  hand: { title: 'Do it by hand', sub: 'Make it yourself in Blender with our step-by-step guides, then add it.',
    needs: 'Blender (free) and some patience.', cost: 'Free', free: true, time: 'An evening or two' },
};
/** Which connectors each AI way offers, in the order shown. */
export const WAY_CONNECTORS: Record<Exclude<CreateWay, 'hand'>, string[]> = {
  app: ['claude-desktop', 'claude-code', 'chatgpt-desktop', 'codex-cli', 'grok-build', 'lm-studio', 'cursor', 'vscode', 'gemini-cli', 'antigravity', 'grok-bot'],
  local: ['local'],
};

// ---------------------------------------------------------------- "Your AI is ready: ask it ..."
export interface ExamplePrompt { what: string; text: string }
/** Copyable prompts for an AI app (it has VTube Pro's tools, so plain requests work). */
export function examplePrompts(): ExamplePrompt[] {
  return [
    { what: 'A room', text: 'Make me a cozy cafe room for VTube Pro, with warm evening lights and two seats.' },
    { what: 'A character', text: 'Use VTube Pro to make me a sleepy purple cat wizard avatar with a big star hat.' },
    { what: 'An outfit', text: 'Make an outfit for my current VTube Pro avatar: a black hoodie with a lime green stripe.' },
    { what: 'A poster', text: 'Make a "Starting soon" poster for my VTube Pro room, pixel-art style.' },
    { what: 'A check', text: 'Check my VTube Pro room and fix anything that looks wrong.' },
  ];
}
/** The one-line hint under "Your AI is ready". */
export function askLine(apps: Pick<GateConnector, 'name'>[]): string {
  if (!apps.length) return '';
  const names = apps.map((a) => a.name);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} or ${names[names.length - 1]}`;
  return `Ask it in ${list}: "${examplePrompts()[0].text.replace(/\.$/, '')}"`;
}

// ---------------------------------------------------------------- jobs your AI started (GET /api/jobs)
export interface JobLite { id: string; kind: string; status: string; progress: number; log: string[]; createdAt: string; error?: string; result?: { avatarId?: string } }
const JOB_NAME: [RegExp, string][] = [[/costume/i, 'Outfit'], [/room|scene|package/i, 'Room'], [/autorig/i, 'Rigging'], [/generate|avatar/i, 'Character'], [/texture|image|poster/i, 'Picture']];
export const jobLabel = (kind: string) => JOB_NAME.find(([r]) => r.test(kind))?.[1] ?? 'Making something';
/** Making jobs only (not installs, builds ...). */
export const isMakingJob = (kind: string) => !/dlc|install|build|pack|release/i.test(kind) && JOB_NAME.some(([r]) => r.test(kind));
/** The jobs worth showing on Create: running ones, plus anything that finished in the last 30 minutes, newest first. */
export function recentJobs(jobs: JobLite[], now: number, max = 4): JobLite[] {
  return jobs
    .filter((j) => isMakingJob(j.kind))
    .filter((j) => j.status === 'running' || j.status === 'queued' || now - Date.parse(j.createdAt) < 30 * 60_000)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, max);
}
/** The last log line in plain words (no [hh:mm:ss] stamp). */
export const jobLine = (j: JobLite) => j.status === 'failed' ? (j.error ?? 'That didn\'t work.') : j.status === 'succeeded' ? 'Done.' : (j.log[j.log.length - 1] ?? 'Working…').replace(/^\[[\d:]+\]\s*/, '');

// ---------------------------------------------------------------- Advanced → Create (the builder picker)
/** The one button that fixes what `providerBlocker` says (null = nothing a button can do). ComfyUI open but without its
 *  3D model: "Set it up for me" (the page for Character 3D, size chosen from the graphics card). The same button as the simple Create card. */
export function providerFix(provider: 'comfy', status: GateInput['status']): GateFix | null {
  if (provider !== 'comfy' || !status?.comfy?.reachable) return null;
  const c = status.comfy.character;
  if (!c) return null;
  return c.ready ? null : { action: 'setup', label: SETUP_FIX_LABEL, url: c.setupUrl || CHARACTER_SETUP_PAGE };
}
/** Everything the Advanced builder says under "Run" for the picked builder, in one place (pure, so a unit test can hold it): the plain
 *  sentence, whether it blocks Generate (a soft note never does), and the button that fixes it. */
export interface BuilderNote { text: string; blocks: boolean; fix: GateFix | null; needsPicture: boolean }
export function builderNote(provider: 'comfy', status: GateInput['status']): BuilderNote {
  const why = providerBlocker(provider, status);
  return { text: why ?? '', blocks: !!why, fix: providerFix(provider, status), needsPicture: provider === 'comfy' && comfyNeedsPicture(status) };
}
/** ComfyUI will run VTube Pro's own Character 3D, which turns a PICTURE into 3D (words alone are refused). False when the user's
 *  own workflow file will run, and when the helper is older (it cannot say: let the server decide). */
export function comfyNeedsPicture(status: GateInput['status']): boolean {
  const c = status?.comfy?.character;
  return !!c && !c.own;
}

/** Can this builder run with what is set up? Mirrors server/providers/index.ts validateGenerate (null = yes). */
export function providerBlocker(provider: 'comfy', status: GateInput['status']): string | null {
  if (!status) return null; // unknown: let the server say
  if (provider === 'comfy') {
    if (!status.comfy?.reachable) return 'Start ComfyUI on this computer first.';
    const c = status.comfy.character;
    if (!c) return null; // cannot say: let it try
    return c.ready ? null : COMFY_NEEDS_MODEL;
  }
  return null;
}
