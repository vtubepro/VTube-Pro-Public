// The onboarding wizard shell, shared by "Add my model" (src/ui/modelWizard.ts) and "Add my room" (room-onboarding):
//   1 Pick a file → 2 the check (a plain-words report card) → 3 "Set it up for me" (automatic, with progress and a
//   before / after) or "Walk me through it" (one thing per step, live preview, test buttons, Back / Skip / Undo,
//   "Why?" notes, ending with the 8-angle check) → 4 Save → "Ready in VTube Pro!".
// The shell draws every screen; a kind (OnboardKind) brings the preview, the checks, the tasks, the steps and the save.
// Contract: T\portal\CONTRACT.md "onboarding-shell". Look: the studio's .wiz classes + BRAND.md (one primary button
// per screen, plain words, never a dead end). Nothing here changes the stream: only the kind's useNow() does.
import { button, h, toast } from '../dom.ts';
import { icon } from '../icons.ts';
import { helperNote, openGuide } from './links.ts';

export type Level = 'ok' | 'warn' | 'bad';
export interface ReportLine { id: string; level: Level; text: string; detail?: string; needsHelper?: boolean }
export interface TestButton { label: string; run(): void }
export interface ShellUi {
  /** Re-render the current screen (after a change). */
  refresh(): void;
  /** A busy line on the current screen ("Rebuilding the preview…"); null clears it. */
  busy(text: string | null): void;
  /** The helper notice element (one sentence + Open Helper). */
  helperNote(why: string): HTMLElement;
}
export interface OnboardStep {
  id: string;
  title: string;
  /** The "Why?" note: why this step matters, in one or two sentences. */
  why?: string;
  render(el: HTMLElement, ui: ShellUi): void;
  /** Big test buttons under the preview while this step shows. */
  tests?(): TestButton[];
  /** A sentence when this step needs the helper and it isn't here (the step still shows, with the notice). */
  needsHelper?(): string | null;
}
export type AutoState = 'done' | 'kept' | 'skipped' | 'needs-helper' | 'failed';
export interface AutoTask { id: string; label: string; detail: string; run(ui: ShellUi): Promise<{ state: AutoState; detail?: string }> }
export interface OpenResult {
  name: string;
  summary: string;
  report: ReportLine[];
  /** false = can't go on with this file here (e.g. an FBX without the helper): only "choose another file". */
  ready?: boolean;
  /** true = nothing needs fixing: the check offers "Looks good: save it" straight away (room-onboarding). */
  allGood?: boolean;
  /** The kind's own words for step 3 (room-onboarding: "Place seats for me" / "Let me place them"). Aliases
   *  text / autoNote / manualNote are accepted for lead / autoText / manualText. */
  choose?: { headline: string; lead?: string; text?: string; auto: string; autoText?: string; autoNote?: string; manual: string; manualText?: string; manualNote?: string };
}
export interface SaveResult { id: string; where: 'helper' | 'browser' | 'sandbox'; name: string; note?: string }
export interface OnboardKind {
  kind: 'model' | 'room';
  /** "model" / "room". */
  noun: string;
  /** "Add my model". */
  title: string;
  /** <input accept>. */
  accept: string;
  /** The formats in plain words. */
  formats: string;
  /** The guide for "Get help" (F1 viewer target, e.g. 'AVATARS_SIMPLE.md#add-my-model'). */
  guide: string;
  open(file: File, ui: ShellUi): Promise<OpenResult>;
  /** The live 3D preview (one element, kept across screens). */
  preview(): HTMLElement;
  /** A picture of the preview right now (data: URL), for the before / after. */
  snapshot(): Promise<string>;
  /** Test buttons on the check screen (e.g. Smile / Say "Ahh" / Look ←). */
  tests?(): TestButton[];
  autoTasks(): AutoTask[];
  manualSteps(): OnboardStep[];
  /** The 8-angle check pictures. */
  angles(): Promise<{ label: string; url: string }[]>;
  canUndo(): boolean;
  undo(): Promise<void> | void;
  save(ui: ShellUi): Promise<SaveResult>;
  useNow(id: string): Promise<void>;
  dispose(): void;
  /** The ending's title (default "Ready in VTube Pro!"; room-onboarding: "Your room is ready in VTube Pro"). */
  readyTitle?: string;
  /** The ending's sentence about the saved item (default "<name> is in your avatars."). */
  doneText?(saved: SaveResult): string;
}
export interface ShellOpts {
  /** Start with this file (dropped elsewhere) instead of the pick screen. */
  file?: File;
  onClose?(saved: SaveResult | null): void;
}

const CSS = `
.ob .wiz-main{display:flex;flex-direction:column}
.ob .wiz-main>h2{padding-right:44px}
.ob .ob-eyebrow{font:600 11px/1 ui-monospace,SFMono-Regular,Menlo,monospace;letter-spacing:.2em;text-transform:uppercase;color:var(--accent);display:flex;align-items:center;gap:8px;margin:0 0 8px}
.ob .ob-eyebrow::before{content:'';width:24px;height:1px;background:var(--accent)}
.ob .ob-drop{border:2px dashed var(--line2);border-radius:18px;padding:34px 20px;text-align:center;background:var(--card);cursor:pointer;display:grid;gap:10px;place-items:center;transition:border-color .15s,background .15s}
.ob .ob-drop:hover,.ob .ob-drop.over{border-color:var(--accent);background:var(--accent-soft)}
.ob .ob-drop .big{font-size:40px;line-height:1}
.ob .ob-drop b{font-size:17px}
.ob .btn.primary.ob-big{min-height:52px;font-size:16px;font-weight:700;padding:0 26px;border-radius:12px}
.ob .ob-cols{display:grid;grid-template-columns:minmax(260px,1fr) 1.1fr;gap:18px;align-items:start;flex:1;min-height:0}
.ob .ob-prev-wrap{position:sticky;top:0;display:grid;gap:8px}
.ob .ob-prev{position:relative;width:100%;aspect-ratio:4/5;max-height:calc(100vh - 290px);min-height:220px;background:var(--stage);border-radius:14px;overflow:hidden;border:1px solid var(--line2)}
.ob .ob-prev canvas{position:absolute;inset:0;width:100%;height:100%;display:block;touch-action:none}
.ob .ob-prev .ob-prev-tag{position:absolute;left:8px;top:8px;font-size:11px;padding:2px 8px;border-radius:99px;background:#0009;color:#fff;pointer-events:none}
.ob .ob-prev .ob-prev-hint{position:absolute;left:8px;right:8px;bottom:8px;font-size:12px;padding:6px 10px;border-radius:10px;background:#000b;color:#fff;text-align:center}
.ob .ob-tests{display:flex;flex-wrap:wrap;gap:6px}
.ob .ob-tests .btn{min-height:36px}
.ob .ob-report{display:grid;gap:6px;margin:4px 0 12px}
.ob .ob-report .wiz-check.bad .ic{background:var(--err);color:#fff}
.ob .ob-report .wiz-check .d{display:block;color:var(--dim);font-size:12px;margin-top:2px}
.ob .ob-choice{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-top:6px}
.ob .ob-choice .wiz-opt{padding:16px;gap:8px;min-height:150px}
.ob .ob-choice .wiz-opt .em{font-size:30px;line-height:1}
.ob .ob-choice .wiz-opt.rec{border-color:var(--accent)}
.ob .ob-choice .wiz-opt .tag{align-self:flex-start;font-size:10.5px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;padding:2px 8px;border-radius:99px;background:var(--accent-soft);color:var(--accent)}
.ob .ob-tasks{display:grid;gap:6px;margin:8px 0}
.ob .ob-task{display:grid;grid-template-columns:26px 1fr;gap:10px;align-items:start;padding:8px 10px;border-radius:10px;background:var(--card);border:1px solid var(--line)}
.ob .ob-task .ic{width:24px;height:24px;border-radius:50%;display:grid;place-items:center;font-size:12px;font-weight:800;background:var(--card3);color:var(--dim)}
.ob .ob-task.done .ic,.ob .ob-task.kept .ic{background:var(--accent);color:var(--accent-ink)}
.ob .ob-task.needs-helper .ic,.ob .ob-task.skipped .ic{background:var(--warn);color:#1a1000}
.ob .ob-task.failed .ic{background:var(--err);color:#fff}
.ob .ob-task b{display:block;font-size:13px}.ob .ob-task span{color:var(--dim);font-size:12px}
.ob .ob-spin{display:inline-block;width:14px;height:14px;border:2px solid currentColor;border-right-color:transparent;border-radius:50%;animation:obspin .8s linear infinite}
@keyframes obspin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion: reduce){.ob .ob-spin{animation-duration:3s}}
.ob .ob-ba{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:10px 0}
.ob .ob-ba figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:12px;overflow:hidden}
.ob .ob-ba img{display:block;width:100%;aspect-ratio:4/5;object-fit:cover;background:var(--stage)}
.ob .ob-ba figcaption{font-size:12px;font-weight:700;padding:6px 10px;color:var(--dim)}
.ob .ob-angles{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:8px 0}
.ob .ob-angles figure{margin:0;background:var(--card);border:1px solid var(--line);border-radius:10px;overflow:hidden}
.ob .ob-angles img{display:block;width:100%;aspect-ratio:3/4;object-fit:cover;background:var(--stage)}
.ob .ob-angles figcaption{font-size:11px;padding:4px 8px;color:var(--dim);text-align:center}
.ob .ob-why{margin:10px 0 0;font-size:12.5px;color:var(--dim)}
.ob .ob-why summary{cursor:pointer;color:var(--accent2);font-weight:600;width:max-content}
.ob .ob-why p{margin:6px 0 0;line-height:1.5}
.ob .ob-helper{border:1px dashed var(--warn);background:var(--warn-soft);border-radius:12px;padding:10px 12px;margin:10px 0;display:grid;gap:8px;font-size:13px}
.ob .ob-helper-t span{color:var(--dim)}
.ob .ob-row{display:flex;flex-wrap:wrap;gap:8px;align-items:center}
.ob .ob-busy{color:var(--dim);font-size:12.5px;display:flex;gap:8px;align-items:center;min-height:18px}
.ob .ob-done{display:grid;place-items:center;text-align:center;gap:10px;padding:10px 0}
.ob .ob-done .ok{width:64px;height:64px;border-radius:50%;background:var(--accent);color:var(--accent-ink);display:grid;place-items:center;font-size:34px;font-weight:800}
.ob .ob-done img{width:180px;aspect-ratio:4/5;object-fit:cover;border-radius:14px;border:1px solid var(--line2);background:var(--stage)}
.ob .ob-sub{margin-left:14px;border-left:2px solid var(--line2);padding-left:6px;display:grid;gap:2px}
.ob .ob-sub .wiz-step{font-size:12.5px;padding:5px 8px}
.ob .ob-confirm{position:absolute;inset:0;background:#05070bcc;display:grid;place-items:center;z-index:5;border-radius:18px}
.ob .ob-confirm>div{background:var(--panel);border:1px solid var(--line2);border-radius:16px;padding:20px 22px;max-width:380px;display:grid;gap:12px}
.ob .ob-role{padding:10px 12px;border:1px solid var(--line);border-radius:12px;background:var(--card);margin:6px 0;display:grid;gap:6px}
.ob .ob-role-q{font-size:13px;font-weight:650}
.ob .ob-chip{display:inline-flex;align-items:center;min-height:32px;padding:0 12px;border-radius:99px;border:1px solid var(--line2);color:var(--dim);font-size:13px;font-weight:600}
.ob .ob-chip.on{border-color:var(--accent);color:var(--text);background:var(--accent-soft)}
.ob .ob-picker{display:flex;flex-wrap:wrap;gap:6px;max-height:180px;overflow:auto;padding:4px 0}
.ob .ob-pick{min-height:32px;padding:0 12px;border-radius:99px;border:1px solid var(--line2);background:var(--card2);color:var(--text);font:inherit;font-size:12.5px;cursor:pointer;transition:border-color .18s cubic-bezier(.16,1,.3,1),background .18s cubic-bezier(.16,1,.3,1)}
.ob .ob-pick:hover{border-color:var(--accent)}.ob .ob-pick.on{background:var(--accent);color:var(--accent-ink);border-color:var(--accent)}
.ob .ob-pick.none{color:var(--dim)}
.ob .ob-choice .wiz-opt .em svg{width:30px;height:30px;color:var(--accent)}
.ob .ob-drop .big svg{width:44px;height:44px;color:var(--accent)}
.ob .ob-field{display:grid;gap:6px;margin:8px 0}.ob .ob-field>span{font-size:12.5px;font-weight:650}
.ob .ob-field input[type=text],.ob .ob-field select{min-height:40px;border-radius:10px;border:1px solid var(--line2);background:var(--input);color:var(--text);padding:0 12px;font:inherit}
@media (max-width: 760px){.ob.wiz{grid-template-columns:1fr;height:calc(100vh - 24px)}.ob .wiz-side{display:none}.ob .ob-cols{grid-template-columns:1fr}.ob .ob-prev{aspect-ratio:1/1;max-height:42vh}.ob .ob-choice,.ob .ob-ba{grid-template-columns:1fr}.ob .ob-angles{grid-template-columns:repeat(2,1fr)}.ob .wiz-main{padding:16px}.ob .wiz-foot{padding:10px 16px;flex-wrap:wrap}}
`;

type Phase = 'pick' | 'loading' | 'report' | 'choose' | 'auto' | 'manual' | 'saving' | 'done' | 'error';
const PHASES: { id: string; title: string }[] = [{ id: 'pick', title: 'Choose a file' }, { id: 'check', title: 'Check it' }, { id: 'setup', title: 'Set it up' }, { id: 'save', title: 'Save' }];
const phaseIndex = (p: Phase) => (p === 'pick' ? 0 : p === 'loading' || p === 'report' ? 1 : p === 'choose' || p === 'auto' || p === 'manual' ? 2 : 3);
const ICON: Record<Level, string> = { ok: '✓', warn: '!', bad: '✕' };

let openShell: { close(): void } | null = null;
export const onboardingOpen = () => !!openShell;

export function openOnboarding(kind: OnboardKind, opts: ShellOpts = {}) {
  openShell?.close();
  if (!document.getElementById('vtp-onboard')) document.head.append(h('style', { id: 'vtp-onboard' }, CSS));
  let phase: Phase = 'pick';
  let file: File | null = null;
  let opened: OpenResult | null = null;
  let steps: OnboardStep[] = [];
  let cur = 0;
  const doneSteps = new Set<string>(), skipped = new Set<string>();
  let tasks: { t: AutoTask; state: AutoState | 'wait' | 'run'; detail: string }[] = [];
  let before: string | null = null, after: string | null = null;
  let saved: SaveResult | null = null;
  let errMsg = '', errBack: Phase = 'pick', errAt: Phase = 'pick';
  let busyText: string | null = null;
  let dirty = false;
  let previewEl: HTMLElement | null = null;

  const side = h('div', { class: 'wiz-side' });
  const main = h('div', { class: 'wiz-main', 'data-ui': `onboard-${kind.kind}` } as never);
  const foot = h('div', { class: 'wiz-foot' });
  const closeBtn = h('button', { class: 'icon-btn wiz-close', title: 'Close (Esc)', 'aria-label': 'Close', onClick: () => askClose() }, icon('x', 18));
  const card = h('div', { class: 'wiz ob', role: 'dialog', 'aria-modal': 'true', 'aria-label': kind.title, style: 'position:relative' }, side, main, foot);
  const back = h('div', { class: 'wiz-back' }, card);

  const ui: ShellUi = {
    refresh: () => draw(),
    busy: (t) => { busyText = t; const b = main.querySelector('.ob-busy'); if (b) paintBusy(b as HTMLElement); },
    // "Try again" re-checks: a file that needed the helper is opened again (the helper may be running now)
    helperNote: (why) => helperNote(why, () => { if (phase === 'report' && opened?.ready === false && file) void start(file); else draw(); }),
  };
  const paintBusy = (b: HTMLElement) => b.replaceChildren(...(busyText ? [h('span', { class: 'ob-spin' }), h('span', null, busyText)] : []));
  const busyLine = () => { const b = h('div', { class: 'ob-busy', 'aria-live': 'polite' }); paintBusy(b); return b; };

  const eyebrow = () => h('div', { class: 'ob-eyebrow' }, `Step ${phaseIndex(phase === 'error' ? errAt : phase) + 1} of 4`);
  const why = (text?: string) => (text ? h('details', { class: 'ob-why' }, h('summary', null, 'Why?'), h('p', null, text)) : null);
  const report = (lines: ReportLine[]) => h('div', { class: 'ob-report', role: 'list', 'data-tut': 'ob-report' }, ...lines.map((l) => h('div', { class: `wiz-check ${l.level === 'ok' ? 'ok' : l.level === 'warn' ? 'warn' : 'bad'}`, role: 'listitem' },
    h('span', { class: 'ic', 'aria-label': l.level === 'ok' ? 'good' : l.level === 'warn' ? 'could be better' : 'needs fixing' }, ICON[l.level]),
    h('div', null, h('b', null, l.text.replace(/\s*✔$/, '')), l.detail ? h('span', { class: 'd' }, l.detail) : null))));
  const previewCol = (tests: TestButton[] | undefined) => {
    previewEl ??= kind.preview();
    return h('div', { class: 'ob-prev-wrap' }, previewEl,
      tests?.length ? h('div', { class: 'ob-tests', 'aria-label': 'Try it' }, ...tests.map((t) => button(t.label, () => t.run()))) : null);
  };

  // ---------------------------------------------------------------- side: the 4 phases (+ walkthrough steps)
  function drawSide() {
    side.replaceChildren(h('div', { class: 'wt' }, kind.title), h('div', { class: 'ws' }, `Bring your own ${kind.noun} into VTube Pro. About 2 minutes.`));
    const pi = phaseIndex(phase === 'error' ? errAt : phase);
    PHASES.forEach((p, i) => {
      side.append(h('div', { class: `wiz-step ${i === pi && phase !== 'done' ? 'cur' : ''} ${i < pi || phase === 'done' ? 'done' : ''}`, 'aria-current': i === pi ? 'step' : undefined },
        h('span', { class: 'n' }, i < pi || phase === 'done' ? '✓' : String(i + 1)), h('span', null, p.title)));
      if (p.id === 'setup' && phase === 'manual') {
        side.append(h('div', { class: 'ob-sub' }, ...steps.map((s, j) => h('button', { class: `wiz-step ${j === cur ? 'cur' : doneSteps.has(s.id) ? 'done' : ''} ${skipped.has(s.id) && !doneSteps.has(s.id) ? 'skipped' : ''}`, onClick: () => { cur = j; draw(); } },
          h('span', { class: 'n' }, doneSteps.has(s.id) && j !== cur ? '✓' : String(j + 1)), h('span', null, s.title)))));
      }
    });
    side.append(h('div', { class: 'prog' }, h('button', { class: 'btn ghost', onClick: () => void openGuide(kind.guide) }, 'Get help')));
  }

  // ---------------------------------------------------------------- screens
  function draw() {
    drawSide();
    main.replaceChildren(closeBtn);
    foot.replaceChildren();
    const F = (...kids: (Node | null)[]) => foot.append(...kids.filter((k): k is Node => !!k));
    const grow = (t: string) => h('span', { class: 'grow' }, t);
    switch (phase) {
      case 'pick': {
        const input = h('input', { type: 'file', accept: kind.accept, style: 'display:none' }) as HTMLInputElement;
        input.onchange = () => { const f = input.files?.[0]; input.value = ''; if (f) void start(f); };
        const drop = h('div', { class: 'ob-drop', role: 'button', tabindex: 0, 'data-tut': 'ob-drop', 'aria-label': `Choose your ${kind.noun} file`, onClick: () => input.click(),
          onKeydown: (e: KeyboardEvent) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); input.click(); } } },
          h('div', { class: 'big', 'aria-hidden': 'true' }, icon('me', 44)), h('b', null, `Drop your ${kind.noun} file here`), h('span', { class: 'note' }, kind.formats));
        drop.ondragover = (e) => { e.preventDefault(); drop.classList.add('over'); };
        drop.ondragleave = () => drop.classList.remove('over');
        drop.ondrop = (e) => { e.preventDefault(); drop.classList.remove('over'); const f = e.dataTransfer?.files?.[0]; if (f) void start(f); };
        main.append(eyebrow(), h('h2', null, kind.title), h('p', { class: 'lead' }, `We’ll check your ${kind.noun}, then set it up for you, or walk you through it step by step. Nothing shows on your stream until you say so.`),
          drop, input, h('p', { class: 'note', style: 'margin-top:12px' }, 'Your file stays with you, on this PC. It is never uploaded anywhere.'));
        F(button('Cancel', () => close(), 'ghost'), grow('Next: we check your model'.replace('model', kind.noun)), h('button', { class: 'btn primary ob-big', onClick: () => input.click() }, 'Choose a file'));
        break;
      }
      case 'loading':
        main.append(eyebrow(), h('h2', null, `Checking your ${kind.noun}…`), h('p', { class: 'lead' }, file ? `${file.name} · ${(file.size / 1048576).toFixed(1)} MB` : ''),
          h('div', { class: 'ob-cols' }, previewCol(undefined), h('div', null, busyLine())));
        F(button('Cancel', () => askClose(), 'ghost'), grow('This takes a few seconds'));
        break;
      case 'report': {
        const o = opened!;
        const ok = o.ready !== false;
        const needs = o.report.find((l) => l.needsHelper);
        const right = h('div', null, report(o.report), needs ? ui.helperNote(ok ? 'One part needs VTube Pro.' : 'Open VTube Pro, then press “Try again”.') : null, busyLine());
        main.append(eyebrow(), h('h2', null, `Here’s your ${kind.noun}`), h('p', { class: 'lead' }, o.summary),
          ok ? h('div', { class: 'ob-cols' }, previewCol(kind.tests?.()), right) : h('div', { style: 'max-width:620px' }, right));
        F(button('Choose another file', () => { phase = 'pick'; draw(); }), grow(ok ? (o.allGood ? 'Next: save it' : 'Next: choose how to set it up') : 'Next: open VTube Pro, or pick another file'),
          ok && o.allGood ? button('Fine-tune it', () => { phase = 'choose'; draw(); }) : null,
          ok ? h('button', { class: 'btn primary ob-big', 'data-tut': 'ob-next', onClick: () => { if (o.allGood) void doSave(); else { phase = 'choose'; draw(); } } }, o.allGood ? 'Looks good: save it' : 'Next: set it up') : null);
        break;
      }
      case 'choose': {
        const opt = (em: Node, title: string, text: string, tag: string | null, onClick: () => void, rec = false) =>
          h('button', { class: `wiz-opt ${rec ? 'rec' : ''}`, 'data-tut': rec ? 'ob-auto' : 'ob-manual', onClick }, h('span', { class: 'em', 'aria-hidden': 'true' }, em), tag ? h('span', { class: 'tag' }, tag) : null, h('b', null, title), h('span', null, text));
        const c = opened?.choose;
        main.append(eyebrow(), h('h2', null, c?.headline ?? 'How do you want to set it up?'), h('p', { class: 'lead' }, c?.lead ?? c?.text ?? 'Either way you can change anything later.'),
          h('div', { class: 'ob-cols' }, previewCol(kind.tests?.()),
            h('div', null, h('div', { class: 'ob-choice' },
              opt(icon('wand', 30), c?.auto ?? 'Set it up for me', c?.autoText ?? c?.autoNote ?? `VTube Pro configures everything it can: face shapes, mouth, eyes, materials, size, camera and hair physics. You see a before / after.`, 'Recommended', () => void runAuto(), true),
              opt(icon('target', 30), c?.manual ?? 'Walk me through it', c?.manualText ?? c?.manualNote ?? 'One thing per step with a live preview and test buttons. Undo, skip or go back any time.', null, () => { phase = 'manual'; steps = kind.manualSteps(); cur = 0; draw(); })))));
        F(button('Back', () => { phase = 'report'; draw(); }), grow('Next: watch it set itself up'), h('button', { class: 'btn primary ob-big', 'data-tut': 'ob-auto', onClick: () => void runAuto() }, c?.auto ?? 'Set it up for me'));
        break;
      }
      case 'auto': {
        const running = tasks.some((t) => t.state === 'run' || t.state === 'wait');
        const iconOf = (s: string) => (s === 'run' ? h('span', { class: 'ob-spin' }) : s === 'wait' ? '·' : s === 'done' || s === 'kept' ? '✓' : s === 'failed' ? '✕' : '!');
        const word: Record<string, string> = { done: 'Done', kept: 'Already good', skipped: 'Skipped', 'needs-helper': 'Needs VTube Pro', failed: 'Didn’t work' };
        main.append(eyebrow(), h('h2', null, running ? 'Setting it up…' : 'All set up!'), h('p', { class: 'lead' }, running ? 'Watch the preview: each change shows as it happens.' : 'Here’s what changed. You can still fine-tune it, or save it now.'),
          h('div', { class: 'ob-cols' }, previewCol(running ? undefined : kind.tests?.()),
            h('div', null,
              !running && before && after && tasks.some((t) => t.state === 'done' && t.t.id !== 'camera')
                ? h('div', { class: 'ob-ba' }, h('figure', null, h('img', { src: before, alt: 'Before' }), h('figcaption', null, 'Before')), h('figure', null, h('img', { src: after, alt: 'After' }), h('figcaption', null, 'After'))) : null,
              h('div', { class: 'ob-tasks', 'aria-live': 'polite' }, ...tasks.map((t) => h('div', { class: `ob-task ${t.state}` }, h('span', { class: 'ic' }, iconOf(t.state)),
                h('div', null, h('b', null, t.t.label, t.state in word ? h('span', null, ` · ${word[t.state]}`) : null), h('span', null, t.detail))))),
              tasks.some((t) => t.state === 'needs-helper') ? ui.helperNote('One step needs VTube Pro.') : null,
              busyLine())));
        F(button('Back', () => { if (!running) { phase = 'choose'; draw(); } }), grow(running ? 'Working on it…' : 'Next: save it'),
          running ? null : button('Fine-tune it myself', () => { phase = 'manual'; steps = kind.manualSteps(); cur = 0; draw(); }),
          running ? null : h('button', { class: 'btn primary ob-big', 'data-tut': 'ob-save', onClick: () => void doSave() }, 'Save it'));
        break;
      }
      case 'manual': {
        const s = steps[cur];
        const body = h('div');
        try { s.render(body, ui); } catch (e) { body.append(h('p', { class: 'note' }, `This step couldn’t load: ${(e as Error).message}`)); }
        const need = s.needsHelper?.() ?? null;
        main.append(h('div', { class: 'ob-eyebrow' }, `Set it up · ${cur + 1} of ${steps.length}`), h('h2', null, s.title),
          h('div', { class: 'ob-cols' }, previewCol(s.tests?.()),
            h('div', null, body, need ? ui.helperNote(need) : null, why(s.why), busyLine())));
        const last = cur === steps.length - 1;
        const undoB = button('Undo', () => void Promise.resolve(kind.undo()).then(() => draw()));
        undoB.disabled = !kind.canUndo();
        undoB.title = 'Undo the last change';
        F(button('Back', () => { if (cur > 0) { cur--; draw(); } else { phase = 'choose'; draw(); } }), undoB, grow(last ? 'Next: save it' : `Next: ${steps[cur + 1].title}`),
          last ? null : button('Skip', () => { skipped.add(s.id); cur++; draw(); }, 'ghost'),
          h('button', { class: 'btn primary ob-big', onClick: () => { doneSteps.add(s.id); dirty = true; if (last) void doSave(); else { cur++; draw(); } } }, last ? 'Looks good: save it' : 'Next'));
        break;
      }
      case 'saving':
        main.append(eyebrow(), h('h2', null, `Saving your ${kind.noun}…`), h('div', { class: 'ob-cols' }, previewCol(undefined), h('div', null, busyLine())));
        F(grow('Almost done'));
        break;
      case 'done': {
        const sv = saved!;
        const where = sv.where === 'helper' ? 'Saved on your PC with VTube Pro.' : sv.where === 'browser'
          ? 'Saved in this browser only. Get VTube Pro to keep it on your PC: clearing this browser’s data would remove it.' : 'Test sandbox: nothing was saved.';
        main.append(h('div', { class: 'ob-done' }, h('div', { class: 'ok', 'aria-hidden': 'true' }, '✓'), h('h2', null, kind.readyTitle ?? 'Ready in VTube Pro!'),
          after ? h('img', { src: after, alt: sv.name }) : null,
          h('p', { class: 'lead', style: 'margin:0' }, `${kind.doneText?.(sv) ?? `${sv.name} is in your avatars.`} ${where}`), sv.note ? h('p', { class: 'note' }, sv.note) : null,
          h('p', { class: 'note' }, '“Use it now” puts it on screen (and on your stream if you are live).')));
        F(button('Add another', () => { reset(); draw(); }, 'ghost'), grow('You’re done!'), button('Done', () => close()),
          sv.where === 'sandbox' ? null : h('button', { class: 'btn primary ob-big', 'data-tut': 'ob-use', onClick: () => void kind.useNow(sv.id).then(() => close()) }, 'Use it now'));
        break;
      }
      case 'error':
        main.append(eyebrow(), h('h2', null, 'That didn’t work'), h('p', { class: 'lead' }, errMsg));
        F(button('Back', () => { phase = errBack; draw(); }), grow(''), button('Get help', () => void openGuide(kind.guide)), h('button', { class: 'btn primary ob-big', onClick: () => { if (file && errBack !== 'pick' && !opened) void start(file); else { phase = errBack; draw(); } } }, 'Try again'));
        break;
    }
  }

  // ---------------------------------------------------------------- actions
  async function start(f: File) {
    file = f; opened = null; phase = 'loading'; busyText = 'Opening the file…'; draw();
    try {
      opened = await kind.open(f, ui);
      busyText = null; phase = 'report'; dirty = true; draw();
    } catch (e) { fail((e as Error).message, 'pick'); }
  }
  async function runAuto() {
    phase = 'auto';
    tasks = kind.autoTasks().map((t) => ({ t, state: 'wait' as const, detail: t.detail }));
    before = await kind.snapshot().catch(() => null);
    draw();
    for (const row of tasks) {
      if (!back.isConnected) return;
      row.state = 'run'; draw();
      try {
        const r = await row.t.run(ui);
        row.state = r.state; if (r.detail) row.detail = r.detail;
      } catch (e) { row.state = 'failed'; row.detail = (e as Error).message; }
      draw();
      await new Promise((r) => setTimeout(r, 250));
    }
    after = await kind.snapshot().catch(() => null);
    busyText = null; dirty = true; draw();
  }
  async function doSave() {
    const from: Phase = phase;
    phase = 'saving'; busyText = 'Saving…'; draw();
    try {
      after ??= await kind.snapshot().catch(() => null);
      saved = await kind.save(ui);
      busyText = null; dirty = false; phase = 'done'; draw();
      toast(`${saved.name} saved ✓`, 'ok', 3500);
    } catch (e) { fail((e as Error).message, from); }
  }
  function fail(msg: string, backTo: Phase) {
    busyText = null; errMsg = msg || 'Something went wrong.'; errBack = backTo;
    // integration: an error that sends the user back to pick a file (e.g. the file can't be opened) is a Step 1 error
    errAt = backTo === 'pick' ? 'pick' : phase === 'error' ? errAt : phase; phase = 'error'; draw();
  }
  function reset() {
    kind.dispose(); previewEl = null; file = null; opened = null; steps = []; cur = 0; doneSteps.clear(); skipped.clear(); tasks = []; before = after = null; saved = null; dirty = false; phase = 'pick';
  }

  function askClose() {
    if (!dirty || phase === 'done' || phase === 'pick') { close(); return; }
    const box = h('div', { class: 'ob-confirm' }, h('div', null, h('b', { style: 'font-size:16px' }, 'Leave without saving?'),
      h('span', { class: 'note' }, `Your ${kind.noun} isn’t saved yet. Your file is still on your computer.`),
      h('div', { class: 'ob-row' }, button('Keep setting up', () => box.remove(), 'primary'), button('Leave', () => close()))));
    card.append(box);
    (box.querySelector('.btn.primary') as HTMLElement | null)?.focus();
  }
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopPropagation(); const c = card.querySelector('.ob-confirm'); if (c) c.remove(); else askClose(); } };
  function close() {
    window.removeEventListener('keydown', onKey, true);
    back.remove();
    openShell = null;
    kind.dispose();
    opts.onClose?.(saved);
    document.dispatchEvent(new CustomEvent('vtp-onboard', { detail: { kind: kind.kind, saved } }));
  }
  window.addEventListener('keydown', onKey, true);
  openShell = { close };
  document.body.append(back);
  if (opts.file) void start(opts.file); else draw();
  (card.querySelector('.btn.primary') as HTMLElement | null)?.focus({ preventScroll: true });
  return { close, get phase() { return phase; } };
}

/** The 8-angle check grid (a manual step uses it; the kind supplies the pictures). */
export function anglesGrid(shots: { label: string; url: string }[]): HTMLElement {
  return h('div', { class: 'ob-angles' }, ...shots.map((s) => h('figure', null, h('img', { src: s.url, alt: s.label }), h('figcaption', null, s.label))));
}
/** A "Why?" note (for kinds that render their own sub-notes). */
export const whyNote = (text: string) => h('details', { class: 'ob-why' }, h('summary', null, 'Why?'), h('p', null, text));
