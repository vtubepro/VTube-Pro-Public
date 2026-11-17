// Create → "How do you use AI?" (lane create-gating, redone by lane create-connect 2026-10-02 after the owner:
// "Fix the create section so people know how to use the Desktop … right now people are crazy confused" and "people
// don't know the difference between API and using the Desktop apps").
//
//  1. ONE plain question with two big answers: "I use an AI app" (Recommended: owner 2026-10-02 "steer people to using the
//     desktop applications of Claude, Grok, and GPT") / "I don't have an AI app", plus "What's the difference?". The answer
//     is remembered and can be changed any time. VTube Pro holds no AI key: an AI app talks to VTube Pro's tools, or a free
//     model on this computer answers.
//  2. The path:
//     app  → each AI app with a 1-2-3 (get it → Connect → restart → ask; LM Studio has nothing to restart), status Found /
//            Not found / Connected / Needs restart, Check again, a Test; "What do I say?"; "Check what Claude made".
//     none → get the Claude / ChatGPT / Grok app (recommended) or a free AI on this computer (the Local AI page), with a chat
//            right here that runs through the helper (src/ui/aiChat.ts chatPanel).
//     (hand → Blender + our guides, as before.)
// Status comes from the server: GET /api/ai/connectors, /api/status, /api/jobs, and for "Check what Claude made"
// GET /api/ai/pending. Pure logic + words: shared/createConnect.ts.
// The in-page "Describe your character" form below (src/ui/simple.ts) still opens once a way really works
// (shared/createGate.ts computeGate). No sound.
import type { App } from '../app.ts';
import { aiApi, helperOrigin, type AiConnectorInfo } from '../net/aiHelper.ts';
import { computeGate, examplePrompts, jobLabel, jobLine, recentJobs, wayOf, type Gate, type GateConnector, type GateInput, type JobLite } from '../../shared/createGate.ts';
import {
  APP_HELP, CONNECT_ASK, DESKTOP_APPS, DIFFERENCE, FIRST_ASK, IMPORTS_COPY, PATHS, PATH_KEY, PATH_ORDER, RECOMMENDED_PATH, SELF_RELOADING,
  STATUS_COPY, appStatus, focusApp, isPath, isPendingAnswer, landingPath, nextStep, pendingFromApprovals, pendingFromInbox,
  type AppConnector, type CreatePath, type PendingItem,
} from '../../shared/createConnect.ts';
import { button, h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { openTool } from './dockTools.ts';
import { chatPanel, fillChat, openAiChat } from './aiChat.ts';
import { openHelp } from './help/helpViewer.ts';
import { helperPage } from './gateFix.ts';
import type { Nav } from './simple.ts';

const CSS = `
.cg-eyebrow{display:flex;align-items:center;gap:8px;font:600 10.5px/1 var(--font-mono,ui-monospace,monospace);letter-spacing:.16em;text-transform:uppercase;color:var(--accent);margin:0 0 8px}
.cg-eyebrow::before{content:"";width:18px;height:1px;background:currentColor}
.cg-h{margin:0 0 4px;font:700 20px/1.25 var(--font-display,inherit);letter-spacing:-.015em}
.cg-lead{margin:0 0 14px;color:var(--dim);font-size:13.5px;line-height:1.5}
.cg-btns{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.cg-big{font:600 14.5px/1.2 inherit;padding:12px 18px;border-radius:12px}
.cg-chip{display:inline-flex;align-items:center;gap:6px;border-radius:999px;border:1px solid var(--line);padding:2px 9px;font-size:11.5px;color:var(--dim);white-space:nowrap}
.cg-chip.ok{color:var(--accent);border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:var(--accent-soft)}
.cg-chip.warn{color:#ffcf6a;border-color:#ffcf6a55}
.cg-chip.info{color:var(--accent2);border-color:color-mix(in srgb,var(--accent2) 40%,transparent)}
.cg-chip .d{width:7px;height:7px;border-radius:50%;background:currentColor}
.cg-helper{position:relative;overflow:hidden}
.cg-helper::after{content:"";position:absolute;inset:auto -60px -80px auto;width:220px;height:220px;border-radius:50%;background:radial-gradient(closest-side,var(--accent-soft),transparent);pointer-events:none}
.cg-helper-row{display:flex;gap:16px;align-items:flex-start}
.cg-helper-ic{width:46px;height:46px;border-radius:14px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent);flex:none}
.cg-helper.blocked .cg-helper-ic,.cg-helper.start .cg-helper-ic{background:rgb(255 207 106/.12);color:#ffcf6a}
.cg-helper-tx{flex:1;min-width:0}
.cg-helper ol{margin:0 0 12px;padding-left:20px;display:grid;gap:5px;font-size:13.5px;line-height:1.45}
.cg-spin{width:18px;height:18px;border-radius:50%;border:2px solid color-mix(in srgb,var(--accent) 30%,transparent);border-top-color:var(--accent);animation:cg-sp .8s linear infinite;display:inline-block;vertical-align:-4px;margin-right:8px}
@keyframes cg-sp{to{transform:rotate(360deg)}}
.cg-paths{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}
@media (max-width:860px){.cg-paths{grid-template-columns:1fr}}
.cg-path{position:relative;display:flex;flex-direction:column;gap:8px;text-align:left;padding:16px;border-radius:16px;border:1px solid var(--line);min-height:132px;
  background:linear-gradient(180deg,rgb(255 255 255/.045),rgb(255 255 255/.012)),var(--card);color:inherit;font:inherit;cursor:pointer;
  transition:border-color .18s cubic-bezier(.16,1,.3,1),transform .18s cubic-bezier(.16,1,.3,1),box-shadow .18s}
.cg-path:hover{border-color:var(--line2,rgb(255 255 255/.18));transform:translateY(-1px)}
.cg-path:focus-visible{outline:2px solid var(--focus,#8ab4ff);outline-offset:2px}
.cg-path[aria-pressed=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent) inset,0 18px 40px -28px var(--accent)}
.cg-path .ic{width:40px;height:40px;border-radius:12px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.cg-path.none .ic{background:var(--card2);color:var(--dim)}
.cg-path b{font:650 16px/1.25 var(--font-display,inherit);letter-spacing:-.005em}
.cg-path span.s{color:var(--dim);font-size:12.5px;line-height:1.45}
.cg-rec{display:inline-flex;align-items:center;align-self:flex-start;padding:3px 9px;border-radius:999px;font:700 10.5px/1.4 var(--font-mono,ui-monospace,monospace);letter-spacing:.1em;text-transform:uppercase;color:var(--accent);background:var(--accent-soft);border:1px solid color-mix(in srgb,var(--accent) 45%,transparent);white-space:nowrap}
.cg-path .cg-rec{position:absolute;top:14px;right:14px}
.cg-path.rec{border-color:color-mix(in srgb,var(--accent) 55%,var(--line))}
.cg-recbox{display:flex;flex-wrap:wrap;align-items:center;gap:10px 14px;margin:0 0 14px;padding:12px 14px;border-radius:12px;border:1px solid color-mix(in srgb,var(--accent) 40%,var(--line));background:var(--accent-soft)}
.cg-recbox p{flex:1 1 260px;margin:0;font-size:14px;line-height:1.5}
.cg-under{display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:12px;font-size:13px}
.cg-link{background:none;border:0;padding:0;font:inherit;color:var(--accent2);cursor:pointer;text-decoration:underline;text-underline-offset:3px}
.cg-diff{margin-top:12px;padding:12px 14px;border-radius:14px;border:1px solid var(--line);background:var(--bg,#0e1015)}
.cg-diff p{margin:0 0 6px;font-size:13px;line-height:1.5;color:var(--dim)}
.cg-tablewrap{overflow-x:auto;margin-top:8px}
.cg-table{border-collapse:collapse;width:100%;min-width:480px;font-size:12.5px}
.cg-table th,.cg-table td{padding:7px 9px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
.cg-table thead th{color:var(--text);font-weight:650}
.cg-table tbody th{color:var(--dim);font-weight:500;white-space:nowrap}
.cg-strip{display:flex;flex-wrap:wrap;align-items:center;gap:8px 12px;padding:12px 14px;border-radius:14px;border:1px solid color-mix(in srgb,var(--accent) 30%,var(--line));background:var(--accent-soft);font-size:13.5px}
.cg-strip .sp{flex:1}
.cg-means{margin:0 0 14px;padding:12px 14px;border-radius:12px;background:var(--bg,#0e1015);border:1px solid var(--line);font-size:14px;line-height:1.5}
.cg-panel-head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:10px}
.cg-panel-head h3{margin:0;flex:1;font:700 18px/1.25 var(--font-display,inherit)}
.cg-overview{margin:0 0 12px;padding:0;list-style:none;display:grid;gap:8px;counter-reset:s}
.cg-overview li{display:flex;gap:10px;align-items:center;font-size:13.5px}
.cg-overview li::before{counter-increment:s;content:counter(s);width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:600 12px/1 var(--font-mono,monospace);background:var(--card2);color:var(--dim);flex:none}
.cg-overview li.now::before{background:var(--accent);color:var(--accent-ink,#08130b)}
.cg-apps{display:flex;flex-direction:column;gap:8px}
.cg-app{border-radius:14px;border:1px solid var(--line);background:var(--card)}
.cg-app.open{border-color:color-mix(in srgb,var(--accent) 35%,var(--line))}
.cg-app-head{display:flex;align-items:center;gap:10px;width:100%;padding:11px 12px;border:0;background:transparent;color:inherit;font:inherit;text-align:left;cursor:pointer;border-radius:14px}
.cg-app-head:focus-visible{outline:2px solid var(--focus,#8ab4ff);outline-offset:-2px}
.cg-app-name{flex:1;min-width:0}.cg-app-name b{display:block;font-size:14px}.cg-app-name span{display:block;color:var(--dim);font-size:12px;line-height:1.35}
.cg-app-head .chev{transition:transform .18s;color:var(--dim)}.cg-app.open .cg-app-head .chev{transform:rotate(90deg)}
.cg-steps{list-style:none;margin:0;padding:2px 12px 12px;display:grid;gap:8px}
.cg-step{display:flex;gap:10px;align-items:flex-start;padding:9px 10px;border-radius:12px;background:var(--bg,#0e1015);border:1px solid transparent;flex-wrap:wrap}
.cg-step.now{border-color:color-mix(in srgb,var(--accent) 40%,transparent)}
.cg-step .n{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font:600 12px/1 var(--font-mono,monospace);background:var(--card2);color:var(--dim);flex:none}
.cg-step.now .n{background:var(--accent);color:var(--accent-ink,#08130b)}
.cg-step.done .n{background:var(--accent-soft);color:var(--accent)}
.cg-step .tx{flex:1 1 220px;min-width:0}.cg-step .tx b{display:block;font-size:13.5px}.cg-step .tx span{display:block;color:var(--dim);font-size:12.5px;line-height:1.45}
.cg-test{margin:0 12px 12px;padding:9px 12px;border-radius:10px;font-size:12.5px;line-height:1.45;background:var(--accent-soft)}
.cg-test.bad{background:rgb(255 207 106/.1)}
.cg-rows{display:flex;flex-direction:column;gap:8px}
.cg-row{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card)}
.cg-row .nm{flex:1 1 180px;min-width:0}.cg-row .nm b{display:block;font-size:13.5px}.cg-row .nm span{display:block;color:var(--dim);font-size:12px;line-height:1.35}
.cg-ask{display:flex;gap:10px;align-items:center;margin:4px 0 10px;padding:12px 12px 12px 14px;border-radius:12px;background:var(--bg,#0e1015);border:1px solid color-mix(in srgb,var(--accent) 35%,var(--line));font-size:14.5px;line-height:1.45}
.cg-ask span{flex:1}
.cg-prompts{display:flex;flex-direction:column;gap:6px}
.cg-prompt{display:flex;gap:10px;align-items:center;padding:8px 10px;border-radius:10px;border:1px solid var(--line);background:var(--card)}
.cg-prompt small{flex:none;width:76px;color:var(--dim);font-size:11.5px}
.cg-prompt span{flex:1;font-size:12.5px;line-height:1.4}
.cg-prompt button{flex:none;width:32px;height:32px;border-radius:8px;border:1px solid var(--line);background:transparent;color:var(--dim);display:grid;place-items:center;cursor:pointer}
.cg-prompt button:hover{color:var(--accent);border-color:var(--accent)}
.cg-two{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}
@media (max-width:760px){.cg-two{grid-template-columns:1fr}}
.cg-opt{display:flex;flex-direction:column;gap:8px;padding:14px;border-radius:14px;border:1px solid var(--line);background:var(--card)}
.cg-opt .ic{width:36px;height:36px;border-radius:10px;display:grid;place-items:center;background:var(--accent-soft);color:var(--accent)}
.cg-opt b{font:650 15px/1.25 var(--font-display,inherit)}.cg-opt p{margin:0;color:var(--dim);font-size:12.5px;line-height:1.5}
.cg-found{display:flex;flex-direction:column;gap:6px;margin-top:10px}
.cg-item{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card)}
.cg-item .nm{flex:1 1 200px;min-width:0}.cg-item .nm b{display:block;font-size:13.5px}.cg-item .nm span{display:block;color:var(--dim);font-size:12px}
.cg-result{margin-top:10px;padding:10px 12px;border-radius:12px;font-size:13.5px;line-height:1.45;background:var(--bg,#0e1015);border:1px solid var(--line)}
.cg-result.ok{border-color:color-mix(in srgb,var(--accent) 40%,transparent);background:var(--accent-soft)}
.cg-jobs{margin-top:12px;display:flex;flex-direction:column;gap:8px}
.cg-job{padding:10px 12px;border-radius:12px;border:1px solid var(--line);background:var(--card)}
.cg-job .top{display:flex;justify-content:space-between;gap:8px;font-size:13px}.cg-job .top b{font-weight:650}
.cg-job .progress{margin:6px 0 4px}.cg-job .note{margin:0}
.cg-job.failed{border-color:#ff6b6b66}.cg-job.succeeded{border-color:color-mix(in srgb,var(--accent) 45%,transparent)}
.cg-guide{display:inline-flex;align-items:center;gap:6px}
.cg-root{grid-column:1/-1}.cg-root>.cg-strip{margin-bottom:12px}
.area-head:has(~ .area-body [data-cg-helper]) .vw-hbar{display:none}
@media (prefers-reduced-motion:reduce){.cg-path{transition:none}.cg-path:hover{transform:none}.cg-spin{animation:none}.cg-app-head .chev{transition:none}}
`;

// ---------------------------------------------------------------- state (module-level: survives re-renders)
type Conn = GateConnector & AppConnector & AiConnectorInfo & { getUrl?: string; getLabel?: string };
type View = CreatePath | 'hand';
interface State {
  connectors: Conn[] | null | 'offline';
  status: GateInput['status'];
  jobs: JobLite[];
  at: number; jobsAt: number;
  view: View | null;
  /** The chooser is open again ("Change") although an answer is remembered. */
  choosing: boolean;
  diff: boolean;
  openApp: string | null;
  tests: Record<string, { busy?: boolean; ok?: boolean; title?: string; fix?: string }>;
  imports: { state: 'idle' | 'checking' | 'done' | 'error'; items: PendingItem[]; via: 'helper' | 'local' | ''; at: number; building: Record<string, string> };
  /** Observer test hook: fixed data, no polling. */
  frozen: boolean;
}
const isView = (v: unknown): v is View => isPath(v) || v === 'hand';
const sget = (k: string) => { try { return localStorage.getItem(k); } catch { return null; } };
const sset = (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } };
const remembered = sget(PATH_KEY);
const S: State = {
  connectors: null, status: null, jobs: [], at: 0, jobsAt: 0, view: isView(remembered) ? remembered : sget('vtp.create.hand') === '1' ? 'hand' : null,
  choosing: false, diff: false, openApp: null, tests: {}, imports: { state: 'idle', items: [], via: '', at: 0, building: {} }, frozen: false,
};
const HAND_KEY = 'vtp.create.hand';
const handChosen = () => sget(HAND_KEY) === '1';
function setView(v: View | null) {
  S.view = v; S.choosing = false;
  sset(PATH_KEY, v);
  sset(HAND_KEY, v === 'hand' ? '1' : null);
  // a focused text box in Create (the chat) would hold the redraw back (dom.ts rerender waits while you type), and the
  // new path replaces it anyway
  const a = document.activeElement as HTMLElement | null;
  if (a && a.closest('[data-cg-root]') && /^(TEXTAREA|INPUT)$/.test(a.tagName)) a.blur();
  refresh();
}

let navRef: Nav | null = null;
let timer = 0;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
/** Re-render Create, but only while Create is on screen. */
function refresh() { if (document.querySelector('[data-cg-root]')) navRef?.refresh(); }

async function poll(force = false) {
  if (S.frozen) return;
  const now = Date.now();
  let changed = false;
  if (force || now - S.at > 4000) {
    S.at = now;
    const [c, s] = await Promise.all([
      aiApi.connectors().then((l) => l as Conn[]).catch(() => 'offline' as const),
      fetch('/api/status', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    if (!same(c, S.connectors) || !same(s, S.status)) { S.connectors = c; S.status = s; changed = true; }
  }
  const running = S.jobs.some((j) => j.status === 'running' || j.status === 'queued');
  if (force || now - S.jobsAt > (running ? 2000 : 6000)) {
    S.jobsAt = now;
    const j = await fetch('/api/jobs', { cache: 'no-store' }).then((r) => (r.ok ? r.json() : [])).catch(() => []) as JobLite[];
    const lite = Array.isArray(j) ? j.map((x) => ({ id: x.id, kind: x.kind, status: x.status, progress: x.progress, log: (x.log ?? []).slice(-1), createdAt: x.createdAt, error: x.error, result: x.result })) : [];
    if (!same(lite, S.jobs)) { S.jobs = lite; changed = true; }
  }
  if (changed) refresh();
}
/** Keep polling while the Create area is on screen (one 1 s timer; stops by itself when the view is gone). */
function watch(root: HTMLElement) {
  if (timer) return;
  timer = window.setInterval(() => {
    if (!document.body.contains(root) && !document.querySelector('[data-cg-root]')) { clearInterval(timer); timer = 0; return; }
    if (document.visibilityState === 'visible') void poll();
  }, 1000);
}
export function currentGate(): Gate { return computeGate({ connectors: S.connectors, status: S.status, handChosen: handChosen() }); }

// ---------------------------------------------------------------- small parts
const chip = (tone: string, text: string, dot = false) => h('span', { class: `cg-chip ${tone}` }, dot ? h('span', { class: 'd' }) : null, text);
const big = (label: string, onClick: () => void, cls = 'primary') => { const b = button(label, onClick, `${cls} cg-big`); return b; };
const external = (label: string, url: string) => button(`${label} ↗`, () => window.open(url, '_blank', 'noopener,noreferrer'), 'ghost');
function copy(text: string) {
  void navigator.clipboard?.writeText(text).then(() => toast('Copied. Paste it into your AI app.', 'ok', 2600), () => toast('Copy didn’t work here. Select the words and copy them yourself.', 'warn'));
}
const docUrl = (name: string) => `/api/docs/${name}`;
// (helperPage lives in ./gateFix.ts with the click behind the Create fix buttons; re-exported for the callers that import it from here)
export { helperPage };
/** The Create guide (bundled in Help). */
const openCreateGuide = () => openHelp('SIMPLE_MODE.md#create');
// The step-by-step guides on the Create page (owner 2026-10-02: "write a guide for people on creating a model in Codex or
// Claude ... and have it on the create page", plus the artist guides). All three are bundled in Help on this computer
// (shared/helpCatalog.ts HELP_DOCS) and open in the studio's Help viewer.
export const openAiGuide = () => openHelp('MAKE_WITH_CLAUDE_OR_CODEX.md');
export const openArtistAvatars = () => openHelp('ARTIST_AVATARS.md');
export const openArtistRooms = () => openHelp('ARTIST_ENVIRONMENTS.md');
export const AI_GUIDE_LINK = 'Step by step: make a model with Claude or Codex';
/** A plain text link with the book icon that opens one guide in Help. */
export const guideLink = (label: string, open: () => void) =>
  h('button', { class: 'cg-link cg-guide', type: 'button', onClick: open }, icon('book', 15), label);
function connect(id: string) {
  // the AI setup wizard in the side drawer
  openTool('aiwizard', `#${id}`);
  S.at = 0; // look again soon
}
async function runTest(id: string) {
  S.tests[id] = { busy: true }; refresh();
  try { const r = await aiApi.test(id); S.tests[id] = { ok: r.ok, title: r.title, fix: r.fix }; }
  catch (e) { S.tests[id] = { ok: false, title: (e as Error).message }; }
  S.at = 0; void poll(true); refresh();
}
const list = () => (Array.isArray(S.connectors) ? S.connectors : []);
const ROW_HINT: Record<string, string> = {
  'claude-desktop': 'The Claude app for Windows and Mac.', 'claude-code': 'Claude in your terminal or code editor.',
  'chatgpt-desktop': 'The ChatGPT app (not the website).', 'codex-cli': 'OpenAI’s Codex in your terminal or editor.',
  'grok-build': 'xAI’s Grok in your terminal.', 'grok-bot': 'The Grok app. It reaches VTube Pro through a private address you switch on.',
  'lm-studio': 'A free AI on your own computer, in the LM Studio app.',
};
/** Row order on the app path: the apps people chat in first (Claude, ChatGPT, Grok, LM Studio), then the terminal ones. */
const APP_ROWS = ['claude-desktop', 'chatgpt-desktop', 'grok-bot', 'lm-studio', 'claude-code', 'codex-cli', 'grok-build'];

// ---------------------------------------------------------------- 1. "How do you use AI?"
function diffEl() {
  return h('div', { class: 'cg-diff', 'data-cg-diff': '1' },
    ...DIFFERENCE.lines.map((l) => h('p', null, l)),
    h('div', { class: 'cg-tablewrap' }, h('table', { class: 'cg-table' },
      h('thead', null, h('tr', null, ...DIFFERENCE.head.map((c) => h('th', { scope: 'col' }, c)))),
      h('tbody', null, ...DIFFERENCE.rows.map((r) => h('tr', null, h('th', { scope: 'row' }, r[0]), ...r.slice(1).map((c) => h('td', null, c))))))));
}
function chooserEl(step: string | null): HTMLElement {
  if (S.view && !S.choosing) {
    const title = S.view === 'hand' ? 'I’ll make it myself in Blender' : PATHS[S.view].title;
    return h('div', { class: 'cg-strip', 'data-cg-chosen': S.view },
      h('span', null, 'You picked: ', h('b', null, title)), h('span', { class: 'sp' }),
      S.view === 'hand' ? null : guideLink(AI_GUIDE_LINK, openAiGuide),
      h('button', { class: 'cg-link', type: 'button', onClick: () => { S.diff = !S.diff; refresh(); } }, 'What’s the difference?'),
      button('Change', () => { S.choosing = true; refresh(); }, 'ghost'),
      S.diff ? diffEl() : null);
  }
  return h('section', { class: 's-card hero cg-choose' },
    h('p', { class: 'cg-eyebrow' }, step ?? 'Create with AI'),
    h('div', { class: 'cg-panel-head' }, h('h3', { class: 'cg-h', style: 'flex:1' }, 'How do you use AI?'),
      h('button', { class: 'cg-link cg-guide', type: 'button', onClick: openCreateGuide }, icon('book', 15), 'Read the guide')),
    h('p', { class: 'cg-lead' }, 'Pick the one that fits you. You can change it any time.'),
    h('div', { class: 'cg-paths', role: 'group', 'aria-label': 'How do you use AI?', 'data-tut': 'cg-paths' }, ...PATH_ORDER.map((p) => {
      const c = PATHS[p];
      const rec = p === RECOMMENDED_PATH;
      return h('button', { class: `cg-path ${p}${rec ? ' rec' : ''}`, type: 'button', 'data-path': p, 'aria-pressed': String(S.view === p), onClick: () => setView(p) },
        rec ? h('span', { class: 'cg-rec' }, 'Recommended') : null,
        h('span', { class: 'ic' }, icon(c.icon, 21)), h('b', null, c.title), h('span', { class: 's' }, c.sub));
    })),
    h('div', { class: 'cg-under' },
      h('button', { class: 'cg-link', type: 'button', 'aria-expanded': String(S.diff), onClick: () => { S.diff = !S.diff; refresh(); } }, 'What’s the difference?'),
      guideLink(AI_GUIDE_LINK, openAiGuide),
      h('button', { class: 'cg-link', type: 'button', onClick: () => setView('hand') }, 'Or make it yourself in Blender'),
      S.view ? h('button', { class: 'cg-link', type: 'button', onClick: () => { S.choosing = false; refresh(); } }, 'Keep my answer') : null),
    S.diff ? diffEl() : null);
}

// ---------------------------------------------------------------- 3a. the AI app path
function stepLi(n: number, next: number, known: boolean, title: string, text: string, ...actions: (HTMLElement | null)[]) {
  const cls = n < next && known ? 'done' : n === next ? 'now' : '';
  return h('li', { class: `cg-step ${cls}`, 'data-step': String(n) },
    h('span', { class: 'n', 'aria-hidden': 'true' }, cls === 'done' ? icon('check', 14) : String(n)),
    h('div', { class: 'tx' }, h('b', null, title), h('span', null, text)),
    ...actions.filter((a): a is HTMLElement => !!a));
}
function appRow(c: Conn): HTMLElement {
  const st = appStatus(c);
  const sc = STATUS_COPY[st];
  const help = APP_HELP[c.id] ?? { short: c.name, where: `${c.name}’s tools list`, restart: `Restart ${c.name}.` };
  const open = S.openApp === c.id;
  const head = h('button', { class: 'cg-app-head', type: 'button', 'aria-expanded': String(open), onClick: () => { S.openApp = open ? '' : c.id; refresh(); } },
    h('span', { class: 'cg-app-name' }, h('b', null, c.name), h('span', null, ROW_HINT[c.id] ?? c.blurb ?? '')),
    chip(sc.tone, sc.chip, sc.tone === 'ok'), h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('next', 16)));
  const row = h('div', { class: `cg-app ${open ? 'open' : ''}`, 'data-app': c.id, 'data-status': st }, head);
  if (!open) return row;
  const next = nextStep(st);
  const t = S.tests[c.id];
  const selfLoads = SELF_RELOADING.includes(c.id);
  row.append(h('ol', { class: 'cg-steps' },
    stepLi(1, next, st !== 'unknown', st === 'missing' ? `Get ${c.name}` : `Have ${c.name}`,
      st === 'missing' ? help.get ?? 'It’s free to download. Log in with your account.' : st === 'unknown' ? 'Already have it? Go to step 2.' : 'Found on this computer.',
      c.getUrl ? external(c.getLabel ?? `Get ${c.name}`, c.getUrl) : null),
    stepLi(2, next, true, st === 'update' ? 'Connect it again' : 'Press Connect',
      `Adds VTube Pro to ${help.where} on your computer. A backup is made first.`,
      button(st === 'connected' || st === 'restart' ? 'Connect again' : 'Connect', () => connect(c.id), next === 2 ? 'primary' : 'ghost')),
    stepLi(3, next, true, selfLoads ? 'Nothing to restart' : `Restart ${help.short}`, help.restart, st === 'restart' ? button('Check again', () => { S.at = 0; void poll(true); }, 'ghost') : null),
    // (a new chat starts with "find it and connect": the app checks the link and says what it can make)
    stepLi(4, next, true, 'Start a new chat', `In ${help.short}, paste: “${CONNECT_ASK}” Then ask for anything, like: “${FIRST_ASK}”`,
      button('Copy', () => copy(CONNECT_ASK), 'ghost'),
      button(t?.busy ? 'Testing…' : 'Test the connection', () => void runTest(c.id), 'ghost'))));
  if (t && !t.busy) row.append(h('p', { class: `cg-test ${t.ok ? '' : 'bad'}`, role: 'status' }, t.ok ? '✓ ' : '', t.title ?? '', t.fix ? ` ${t.fix}` : ''));
  return row;
}
/**
 * Grok Bot, the Grok app (desktop or phone): its AI runs on a Grok computer in the cloud, so no settings file on this PC
 * can reach it. It talks to the helper through the internet bridge (a private address you switch on), it sees the
 * bridge's safe tools only, and what it makes arrives in "Check what Claude made" (submit_creation_package: the Blender
 * build runs here, after your OK). Steps as docs/AI_CONNECT.md: Make my address → Copy the address → Grok Connectors.
 */
function botRow(c: Conn): HTMLElement {
  const open = S.openApp === c.id;
  const ok = !!c.ready;
  const head = h('button', { class: 'cg-app-head', type: 'button', 'aria-expanded': String(open), onClick: () => { S.openApp = open ? '' : c.id; refresh(); } },
    h('span', { class: 'cg-app-name' }, h('b', null, 'Grok Bot'), h('span', null, ROW_HINT[c.id] ?? '')),
    chip(ok ? 'ok' : '', ok ? 'Connected' : 'Not connected', ok), h('span', { class: 'chev', 'aria-hidden': 'true' }, icon('next', 16)));
  const row = h('div', { class: `cg-app ${open ? 'open' : ''}`, 'data-app': c.id, 'data-status': ok ? 'connected' : 'unknown' }, head);
  if (!open) return row;
  const next = ok ? 4 : 2;
  row.append(h('ol', { class: 'cg-steps' },
    stepLi(1, next, true, 'Have the Grok app', 'Grok Bot, on your computer or phone. Log in with your account.',
      c.getUrl ? external(c.getLabel ?? 'About Grok Bot', c.getUrl) : null),
    stepLi(2, next, ok, 'Switch on the internet bridge', 'Grok runs in the cloud, so it reaches VTube Pro through a private address. In VTube Pro, press Make my address, then Copy the address.',
      button('Set it up in VTube Pro', () => connect(c.id), next === 2 ? 'primary' : 'ghost')),
    stepLi(3, next, ok, 'Add it in Grok', 'In Grok: Connectors → New Connector → Custom. Paste the address, then press Test.'),
    stepLi(4, next, ok, 'Ask it to make something', `Say: “${FIRST_ASK}” Grok sends what it makes to VTube Pro: press Check what Claude made, then Build.`,
      button('Copy', () => copy(FIRST_ASK), 'ghost'))));
  return row;
}
function askCard(): HTMLElement {
  const ex = examplePrompts();
  return h('section', { class: 's-card cg-whatsay' },
    h('h3', null, 'What do I say?'),
    h('p', { class: 'lead' }, 'Open a new chat in your AI app and paste this first. It finds VTube Pro and connects:'),
    h('div', { class: 'cg-ask', 'data-cg-ask': 'connect', 'data-tut': 'cg-ask' }, h('span', null, `“${CONNECT_ASK}”`), button('Copy', () => copy(CONNECT_ASK), 'primary')),
    h('p', { class: 'lead' }, 'Then ask in plain words. It builds it in your studio:'),
    h('div', { class: 'cg-ask' }, h('span', null, `“${FIRST_ASK}”`), button('Copy', () => copy(FIRST_ASK), 'ghost')),
    h('p', { class: 'note', style: 'margin:0 0 6px' }, 'More ideas'),
    h('div', { class: 'cg-prompts' }, ...ex.map((p) => h('div', { class: 'cg-prompt' }, h('small', null, p.what), h('span', null, p.text),
      h('button', { title: 'Copy', 'aria-label': `Copy: ${p.text}`, onClick: () => copy(p.text) }, icon('copy', 16))))),
    h('p', { class: 'note', style: 'margin:10px 0 0' }, 'Big changes, like running Blender or changing your live stream, wait for your OK in VTube Pro.'),
    h('p', { class: 'note', style: 'margin:8px 0 0' }, 'More prompts for Opus 5.5 and GPT-6.1, and what to approve: ', guideLink(AI_GUIDE_LINK, openAiGuide)));
}
function overview(items: string[], now: number) {
  return h('ol', { class: 'cg-overview' }, ...items.map((t, i) => h('li', { class: i === now ? 'now' : '' }, t)));
}
function appPanel(): HTMLElement[] {
  const intro = h('p', { class: 'cg-means' }, PATHS.app.means);
  const apps = list().filter((c) => (DESKTOP_APPS as readonly string[]).includes(c.id) && c.supported);
  if (S.openApp === null) S.openApp = focusApp(apps);
  const bot = list().find((c) => c.id === 'grok-bot' && c.supported);
  const rows = APP_ROWS.flatMap((id) => (id === 'grok-bot' ? (bot ? [botRow(bot)] : []) : apps.filter((c) => c.id === id).map(appRow)));
  const loading = S.connectors === null;
  const offline = S.connectors === 'offline';
  return [h('section', { class: 's-card cg-path-panel', 'data-cg-panel': 'app' },
    h('div', { class: 'cg-panel-head' }, h('h3', null, 'Connect your AI app'), button('Check again', () => { S.at = 0; S.jobsAt = 0; void poll(true); toast('Checking your apps…', 'info', 1600); }, 'ghost')),
    intro,
    loading ? h('p', { class: 'note' }, h('span', { class: 'cg-spin', 'aria-hidden': 'true' }), 'Checking which apps you have…')
      : offline ? h('p', { class: 'note' }, 'VTube Pro didn’t answer just now. Press Check again.')
        : h('div', { class: 'cg-apps', 'data-tut': 'cg-apps' }, ...rows),
    jobsBox()),
  askCard()];
}

// ---------------------------------------------------------------- 3b. the chat right here (a model on this computer)
/** The chat element is kept across re-renders: put it back into whichever slot is on screen now. */
function attachChat() {
  const slot = document.querySelector('[data-chat-slot]');
  if (!slot) return;
  const el = chatPanel(list() as AiConnectorInfo[]);
  if (el && el.parentElement !== slot) slot.replaceChildren(el);
}
// ---------------------------------------------------------------- 3c. "I don't have either"
function nonePanel(): HTMLElement[] {
  const local = list().find((c) => c.id === 'local');
  const comfy = !!S.status?.comfy?.reachable;
  const ready = !!local?.ready;
  if (ready) { queueMicrotask(attachChat); setTimeout(attachChat, 0); }
  return [h('section', { class: 's-card cg-path-panel', 'data-cg-panel': 'none' },
    h('div', { class: 'cg-panel-head' }, h('h3', null, 'Two ways to start')),
    h('p', { class: 'cg-means' }, PATHS.none.means),
    h('div', { class: 'cg-two' },
      // the app first: it's what we recommend (owner 2026-10-02)
      h('div', { class: 'cg-opt', 'data-opt': 'app' }, h('span', { class: 'cg-rec' }, 'Recommended'), h('span', { class: 'ic' }, icon('aiapp', 19)), h('b', null, 'Get an AI app: Claude, ChatGPT or Grok'),
        h('p', null, 'It takes about 5 minutes. You log in to the app yourself: VTube Pro never asks for an account or a key.'),
        h('div', { class: 'cg-btns' }, external('Get Claude', 'https://claude.ai/download'), external('Get ChatGPT', 'https://chatgpt.com/download'),
          external('Get Grok', list().find((c) => c.id === 'grok-bot')?.getUrl ?? 'https://docs.x.ai/grok-bot')),
        h('button', { class: 'cg-link', type: 'button', onClick: () => setView('app') }, 'I have the app now')),
      h('div', { class: 'cg-opt', 'data-opt': 'local' }, h('span', { class: 'ic' }, icon('chip', 19)), h('b', null, 'Free AI on my computer'),
        h('p', null, 'Free and private. It needs a strong graphics card. Setting it up takes about 20 minutes.'),
        h('div', { class: 'cg-btns' }, ready ? chip('ok', 'Chat AI ready', true) : null, comfy ? chip('ok', 'ComfyUI running', true) : null),
        h('div', { class: 'cg-btns' },
          button(ready ? 'Change it' : 'Set up free AI', () => window.open(helperPage('/local-ai'), '_blank', 'noopener'), ready ? 'ghost' : 'primary'),
          button('Read the guide', () => openHelp('LOCAL_AI.md'), 'ghost')))),
    h('p', { class: 'note', style: 'margin:12px 0 0' }, 'Or make it yourself: ', h('button', { class: 'cg-link', type: 'button', onClick: () => setView('hand') }, 'Blender with our guides'), '.')),
  ...(ready ? [h('section', { class: 's-card cg-chat', 'data-cg-panel': 'chat' }, h('div', { class: 'cg-panel-head' }, h('h3', null, 'Ask your AI')), h('div', { 'data-chat-slot': '1' }), jobsBox())] : [])];
}

// ---------------------------------------------------------------- 3d. by hand (Blender + guides)
function handPanel(): HTMLElement[] {
  const blender = !!S.status?.blender?.available;
  return [h('section', { class: 's-card cg-path-panel', 'data-cg-panel': 'hand' },
    h('div', { class: 'cg-panel-head' }, h('h3', null, 'Make it yourself')),
    h('p', { class: 'cg-means' }, 'Make it in Blender, the free 3D program, with our step-by-step guides. Then add it below.'),
    h('div', { class: 'cg-rows' },
      h('div', { class: 'cg-row' }, h('div', { class: 'nm' }, h('b', null, 'Blender'), h('span', null, 'The free 3D program. Our guides use it.')),
        blender ? chip('ok', 'Found', true) : chip('', 'Not found'),
        blender ? null : button('Get Blender', () => openTool('tools', 'tool=blender'), 'primary')),
      ...([['Make a character', 'AVATARS_SIMPLE.md'], ['Make a room', 'ENVIRONMENTS_SIMPLE.md'], ['Blender, step by step', 'BLENDER_PLAYBOOK.md']] as const).map(([t, f]) =>
        h('div', { class: 'cg-row' }, h('div', { class: 'nm' }, h('b', null, t), h('span', null, 'A short guide.')), button('Open guide', () => window.open(docUrl(f), '_blank', 'noopener'), 'ghost'))),
      h('div', { class: 'cg-row', 'data-guide': 'artist-avatars' }, h('div', { class: 'nm' }, h('b', null, 'Artist guide: models, outfits and accessories'), h('span', null, 'Every step in VRoid Studio or Blender, with the exact settings.')), button('Open guide', openArtistAvatars, 'ghost')),
      h('div', { class: 'cg-row', 'data-guide': 'artist-rooms' }, h('div', { class: 'nm' }, h('b', null, 'Artist guide: rooms'), h('span', null, 'Build a room in Blender step by step: places, cameras, light.')), button('Open guide', openArtistRooms, 'ghost'))),
    h('div', { class: 'cg-btns', style: 'margin-top:12px' }, button('Add my finished model', () => document.getElementById('cg-byo')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 'primary')))];
}

// ---------------------------------------------------------------- "Check what Claude made"
async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { cache: 'no-store' });
  if (!r.ok || !/json/i.test(r.headers.get('content-type') ?? '')) return null;
  return r.json().catch(() => null);
}
async function checkImports() {
  S.imports = { ...S.imports, state: 'checking', items: [], via: '' }; refresh();
  const now = Date.now();
  // 1. the server's own answer
  try {
    const j = await getJson('/api/ai/pending');
    if (isPendingAnswer(j)) { S.imports = { ...S.imports, state: 'done', items: j.items.slice(0, 20), via: 'helper', at: Date.now() }; refresh(); return; }
  } catch { /* not answered: read the inbox itself */ }
  // 2. read the inbox + approvals directly
  try {
    const [inbox, scenes, appr] = await Promise.all([getJson('/api/aiconnect/inbox'), getJson('/api/scenes'), getJson('/api/aiconnect/approvals')]);
    if (Array.isArray(inbox)) {
      const installed = new Set((Array.isArray(scenes) ? scenes : []).map((s: { id?: string }) => String(s?.id ?? '')));
      const items = [...pendingFromApprovals(Array.isArray(appr) ? appr : [], now), ...pendingFromInbox(inbox, installed, now)];
      S.imports = { ...S.imports, state: 'done', items, via: 'local', at: Date.now() }; refresh(); return;
    }
  } catch { /* fall through */ }
  S.imports = { ...S.imports, state: 'error', items: [], via: '' }; refresh();
}
async function importItem(it: PendingItem) {
  const page = it.kind === 'approval' ? '/aiconnect#apprBox' : '/aiconnect#inbox';
  if (it.kind === 'approval' || !it.inboxId) { window.open(`${helperOrigin()}${page}`, '_blank', 'noopener'); return; }
  // this computer: build it right here (the same Build as the helper's AI page; it runs the package's Blender script)
  if (!confirm(`Build “${it.name}” now? It runs its Blender script on this computer.`)) return;
  S.imports.building[it.key] = 'Starting…'; refresh();
  try {
    const r = await fetch(`/api/aiconnect/inbox/${encodeURIComponent(it.inboxId)}/build`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    const j = await r.json().catch(() => ({})) as { jobId?: string; error?: string };
    if (!r.ok || !j.jobId) throw new Error(j.error ?? `VTube Pro answered ${r.status}`);
    S.imports.building[it.key] = 'Building… It shows under “Your AI is making”.';
    S.jobsAt = 0; void poll(true);
  } catch (e) { S.imports.building[it.key] = `That didn’t work: ${(e as Error).message}`; }
  refresh();
}
function importsCard(): HTMLElement {
  const st = S.imports;
  const body: (HTMLElement | null)[] = [];
  if (st.state === 'checking') body.push(h('p', { class: 'note', role: 'status' }, h('span', { class: 'cg-spin', 'aria-hidden': 'true' }), IMPORTS_COPY.checking));
  if (st.state === 'done' && !st.items.length) body.push(h('p', { class: 'cg-result ok', role: 'status', 'data-imports': 'none' }, IMPORTS_COPY.nothing));
  if (st.state === 'done' && st.items.length) {
    body.push(h('p', { class: 'cg-result', role: 'status', 'data-imports': String(st.items.length) }, IMPORTS_COPY.found(st.items.length)));
    body.push(h('div', { class: 'cg-found' }, ...st.items.map((it) => h('div', { class: 'cg-item', 'data-item': it.key },
      h('span', { class: 'cg-helper-ic', style: 'width:34px;height:34px;border-radius:10px' }, icon(it.kind === 'approval' ? 'shield' : 'room', 17)),
      h('div', { class: 'nm' }, h('b', null, it.name), h('span', null, it.kind === 'approval' ? `${IMPORTS_COPY.approval} From ${it.from}.` : !it.ok ? IMPORTS_COPY.problem : `${it.action === 'modify' ? 'A change to a room' : 'A new room'} from ${it.from}.`),
        st.building[it.key] ? h('span', null, st.building[it.key]) : null),
      it.kind === 'approval' ? button('Review', () => void importItem(it), 'primary')
        : it.ok ? button('Import', () => void importItem(it), 'primary') : button('See it', () => void importItem(it), 'ghost')))));
  }
  if (st.state === 'error') body.push(h('p', { class: 'cg-result' }, 'VTube Pro didn’t answer. Try again in a moment.'));
  const running = recentJobs(S.jobs, Date.now()).filter((j) => j.status === 'running' || j.status === 'queued');
  if (st.state !== 'idle' && st.state !== 'checking' && running.length) body.push(h('p', { class: 'note', style: 'margin:8px 0 0' }, `Still making: ${running.map((j) => jobLabel(j.kind)).join(', ')}.`));
  return h('section', { class: 's-card cg-imports', 'data-cg-panel': 'imports' },
    h('div', { class: 'cg-panel-head' }, h('h3', null, IMPORTS_COPY.title)),
    h('p', { class: 'lead', style: 'margin:0 0 10px' }, IMPORTS_COPY.lead),
    h('div', { class: 'cg-btns' }, button(st.state === 'checking' ? 'Checking…' : IMPORTS_COPY.button, () => void checkImports(), st.state === 'idle' ? 'primary' : 'ghost')),
    ...body,
    st.state === 'done' ? h('p', { class: 'note', style: 'margin:8px 0 0' }, IMPORTS_COPY.scanned) : null);
}

function jobsBox() {
  const jobs = recentJobs(S.jobs, Date.now());
  if (!jobs.length) return h('p', { class: 'note', style: 'margin:10px 0 0' }, 'What your AI makes shows up here while it works.');
  return h('div', { class: 'cg-jobs', 'aria-live': 'polite' }, h('b', { style: 'font-size:13px' }, 'Your AI is making'),
    ...jobs.map((j) => h('div', { class: `cg-job ${j.status}` },
      h('div', { class: 'top' }, h('b', null, jobLabel(j.kind)), h('span', { class: 'note', style: 'margin:0' }, j.status === 'succeeded' ? 'Ready' : j.status === 'failed' ? 'Stopped' : `${Math.round((j.progress || 0) * 100)}%`)),
      j.status === 'running' || j.status === 'queued' ? h('div', { class: 'progress' }, h('i', { style: `width:${Math.round((j.progress || 0) * 100)}%` })) : null,
      h('p', { class: 'note' }, jobLine(j)))));
}

// ---------------------------------------------------------------- the entry point for simple.ts createView
export interface GateView { gate: Gate; showCreate: boolean }
/**
 * Draws Create's top part into `el` and says whether the in-page Create form may follow. Call at the top of Create.
 */
export function createGate(app: App, el: HTMLElement, nav: Nav): GateView {
  navRef = nav;
  if (!document.getElementById('vtp-cg-css')) document.head.append(h('style', { id: 'vtp-cg-css' }, CSS));
  installCreateGateTestHook(app);
  if (!S.frozen && (S.connectors === null || Date.now() - S.at > 4000)) void poll(S.connectors === null);
  const g = currentGate();
  const root = h('div', { class: 'cg-root', 'data-cg-root': '1' });
  el.append(root);
  watch(root);
  // someone who already connected an AI app lands on the app path; anyone else sees the question with the app answer
  // Recommended (shared/createConnect.ts landingPath)
  if (S.view === null && !S.choosing && Array.isArray(S.connectors)) {
    const ready = (k: (c: Conn) => boolean) => list().some((c) => c.ready && c.supported && k(c));
    S.view = landingPath({ desktop: ready((c) => c.kind === 'desktop' || c.kind === 'remote'), local: ready((c) => c.kind === 'local') });
  }
  root.append(chooserEl(null));
  const v = S.choosing ? null : S.view;
  if (v === 'app') root.append(...appPanel());
  else if (v === 'none') root.append(...nonePanel());
  else if (v === 'hand') root.append(...handPanel());
  if (v === 'app') root.append(importsCard());
  return { gate: g, showCreate: g.canCreate && v !== 'hand' && v !== null };
}

/** For a connector's way (the wizard's id → which choice card). */
export const wayForConnector = (id: string) => { const c = list().find((x) => x.id === id); return c ? wayOf(c) : null; };

// ---------------------------------------------------------------- observer test hook (screenshots; fixed data, no network)
function installCreateGateTestHook(app: App) {
  if (!app.observer) return;
  const w = window as unknown as Record<string, unknown>;
  if (w.vtpCreateGateTest) return;
  w.vtpCreateGateTest = (o: { connectors?: Conn[] | 'offline' | null; status?: GateInput['status']; jobs?: JobLite[]; view?: View | null; live?: boolean }) => {
    if (o.live) { S.frozen = false; S.at = 0; S.jobsAt = 0; void poll(true); return; }
    S.frozen = true;
    if (o.connectors !== undefined) S.connectors = o.connectors;
    if (o.status !== undefined) S.status = o.status;
    if (o.jobs) S.jobs = o.jobs;
    if (o.view !== undefined) { S.view = o.view; S.choosing = false; }
    navRef?.refresh();
    return currentGate();
  };
}
