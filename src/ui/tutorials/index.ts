// Tutorials (owner: "I need tutorials to more easily walk people through setting up various things like costumes"):
// guided, step-by-step walkthroughs inside the studio. Each one points at the real button, says one plain sentence and
// waits until you did it. The tutorials themselves are data, one file each in ./defs (listed in ./catalog.ts); the same
// steps are the written guide docs/TUTORIALS.md (tools/tutorials_docs.ts), checked by tools/tutorials_unit.ts.
//
// Wiring: the shell calls mountTutorials(app, nav) once (src/ui/shell.ts). Openers: Help → Tutorials
// (src/ui/guide/guide.ts), the Tools menu + Home's Tools row (src/ui/toolsMenu.ts), `?tut=<id>` on a studio link.
// The spotlight targets are `data-tut="…"` hooks in the studio's UI files (list: tools/tutorials_unit.ts prints them).
import type { App } from '../../app.ts';
import { h } from '../dom.ts';
import { icon } from '../icons.ts';
import { openGuides } from '../help/guidesPage.ts';
import { TUTORIALS } from './catalog.ts';
import { injectCss, runningStep, runningTutorial, setTutHost, startTutorial, stepsFor, stopTutorial } from './engine.ts';
import { openHub } from './hub.ts';
import { registerTutorials } from '../tutorialsHook.ts';
import { activeTutorial, progressOf, setActive } from './progress.ts';
import { tutState } from './state.ts';
import type { TutState } from './types.ts';

export interface TutNav { go(area: string): void; advanced(area: string, sub?: string): void; wizard(id: string, at?: string): void }

let mounted: { app: App } | null = null;
const guide = (target: string) => openGuides(target);

/** The list of tutorials (Help → Tutorials, Tools → Tutorials). */
export function openTutorials() { if (mounted) openHub({ guide }); }

/** Called once by the shell. */
export function mountTutorials(app: App, nav: TutNav) {
  if (mounted) return;
  mounted = { app };
  // the studio's Help buttons (Live header, show dock, Tools; src/ui/tutorialsHook.ts) open the matching tutorial, else the hub
  const TOPIC: Record<string, string> = { live: 'go-live', 'show-dock': 'go-live', privacy: 'brb', rooms: 'room', me: 'costumes' };
  registerTutorials({ label: 'Tutorials', open: (topic) => {
    const id = topic ? TOPIC[topic] : undefined;
    if (id && TUTORIALS.some((t) => t.id === id)) startTutorial(id); else openTutorials();
  } });
  const save = !app.observer;
  setTutHost({
    go: (a) => nav.go(a),
    advanced: (a, s) => nav.advanced(a, s),
    state: (s: TutState) => { try { return tutState(app, s); } catch { return false; } },
    hub: () => openTutorials(),
    guide,
    wizard: (id, at) => nav.wizard(id, at),
  }, save);
  injectCss();
  const q = new URLSearchParams(location.search);
  const want = q.get('tut');
  if (want && TUTORIALS.some((t) => t.id === want)) window.setTimeout(() => startTutorial(want), 1500);
  else if (q.get('tutHub') === '1') window.setTimeout(() => openTutorials(), 1500);
  else window.setTimeout(() => resumeChip(save), 2500);
  // test handle (private test stacks and observer pages): start / stop / where am I
  (window as unknown as { vtpTutorials?: unknown }).vtpTutorials = {
    list: () => TUTORIALS.map((t) => ({ id: t.id, steps: stepsFor(t).map((s) => s.id) })),
    start: (id: string, restart = false) => startTutorial(id, { restart }),
    stop: () => stopTutorial(),
    hub: () => openTutorials(),
    where: () => runningStep(),
  };
}

/** A tutorial was left half way (closed, or the page reloaded): offer to carry on, once per load. */
function resumeChip(save: boolean) {
  const id = activeTutorial();
  const t = id ? TUTORIALS.find((x) => x.id === id) : null;
  if (!t || runningTutorial() || document.querySelector('.gd-back, .wiz-back')) return;
  const p = progressOf(t.id);
  const n = stepsFor(t).length;
  if (p.done || p.step >= n) { setActive(null, save); return; }
  const chip = h('div', { class: 'tu-resume', role: 'status' },
    h('button', { class: 'tu-resume-go', type: 'button', onClick: () => { chip.remove(); startTutorial(t.id); } }, icon('play', 14),
      h('span', null, h('b', null, 'Continue: '), t.title, h('small', null, ` · Step ${p.step + 1} of ${n}`))),
    h('button', { class: 'tu-x', type: 'button', 'aria-label': 'Not now', title: 'Not now', onClick: () => { chip.remove(); setActive(null, save); } }, icon('x', 14)));
  document.body.append(chip);
}
