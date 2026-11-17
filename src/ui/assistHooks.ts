// Zero-effort mount points (beta.12 UX, owner: "the program handles it for people"). Two things other workstreams plug
// into with ONE call from their own file; until they do, the studio's existing pieces answer, so no button is ever dead:
//   * registerFixIt({ open, issues?, label? })  — the global "Something wrong? Fix it" button in the top bar (and the
//     show dock's air light when something is wrong). Default: the studio's own "Check my setup" (src/ui/guide/helpCheck.ts).
//     `issues()` = how many problems it can fix right now: the button shows a count and turns amber.
//   * registerFirstRun({ open, due? })           — the first-run flow. The shell opens it for a brand-new user (instead of
//     the old first-time wizard) when due() says so, and the Tools menu offers it as "First-time setup" any time.
// Nothing here runs a check by itself or sends anything anywhere.
import { h } from './dom.ts';
import { icon } from './icons.ts';

export interface FixItProvider {
  open(from?: HTMLElement | null): void;
  /** REAL problems now (0 = nothing broken): blocked / busy camera, helper unreachable, a load that failed … (owner rule:
   *  "not set up yet" is never a problem) */
  issues?(): number;
  /** The first thing not set up yet (camera off, not in OBS …): a calm "Next step", never amber, never a count */
  next?(): { says: string; short: string } | null;
  label?: string;
}
export interface FirstRunProvider { open(): void; /** A brand-new user should get it now (default: true). */ due?(): boolean; label?: string }

let fix: FixItProvider | null = null;
let first: FirstRunProvider | null = null;
const subs = new Set<() => void>();
const changed = () => { for (const f of subs) try { f(); } catch (e) { console.warn('[assist]', e); } };

export function registerFixIt(p: FixItProvider): () => void { fix = p; changed(); return () => { if (fix === p) { fix = null; changed(); } }; }
export function registerFirstRun(p: FirstRunProvider): () => void { first = p; changed(); return () => { if (first === p) { first = null; changed(); } }; }
export const hasFirstRun = (): boolean => !!first;
export const firstRunLabel = (): string => first?.label ?? 'First-time setup';
/** The registered first-run flow, if it wants a brand-new user now. Returns whether it opened. */
export function openFirstRunIfDue(): boolean { if (!first || (first.due && !first.due())) return false; try { first.open(); return true; } catch (e) { console.warn('[first-run]', e); return false; } }
export function openFirstRun(): boolean { if (!first) return false; try { first.open(); return true; } catch (e) { console.warn('[first-run]', e); return false; } }
/** Called when a provider registers or goes away. */
export function onAssist(f: () => void): () => void { subs.add(f); return () => subs.delete(f); }

/** Open the doctor: the registered one, else the studio's "Check my setup". */
export function openFixIt(from?: HTMLElement | null) {
  if (fix) { try { fix.open(from); return; } catch (e) { console.warn('[fix-it]', e); } }
  void import('./guide/helpCheck.ts').then((m) => m.openHelpCheck());
}
export const fixItIssues = (): number => { try { return Math.max(0, Math.round(fix?.issues?.() ?? 0)); } catch { return 0; } };
/** The calm next set-up step, when nothing is broken (null = none / no doctor). */
export const fixItNext = (): { says: string; short: string } | null => { try { return fix?.next?.() ?? null; } catch { return null; } };

/** The top bar's "Fix it" button (the shell mounts it once; it repaints itself every 2 s and on registration). */
export function fixItButton(): HTMLButtonElement {
  const b = h('button', { type: 'button', class: 'icon-btn fixit-btn', 'data-ui': 'fix-it', onClick: (e: MouseEvent) => openFixIt(e.currentTarget as HTMLElement) }) as HTMLButtonElement;
  if (!document.getElementById('vtp-fixit-css')) document.head.append(h('style', { id: 'vtp-fixit-css' }, CSS));
  let sig = '';
  const paint = () => {
    const n = fixItIssues(), label = fix?.label ?? 'Something wrong? Fix it', nx = n ? null : fixItNext();
    const s = `${n}|${label}|${nx?.says ?? ''}`; if (s === sig) return; sig = s;
    b.title = n ? `${label}: ${n} thing${n === 1 ? '' : 's'} to fix` : nx ? `Next step: ${nx.says}` : `${label}: checks your camera, mic and OBS, and fixes what it can`;
    b.setAttribute('aria-label', b.title);
    b.classList.toggle('warn', n > 0);
    b.replaceChildren(icon('fix', 18));
    if (n) b.append(h('span', { class: 'n', 'aria-hidden': 'true' }, String(Math.min(n, 9))));
  };
  paint(); onAssist(() => { sig = ''; paint(); }); window.setInterval(paint, 2000);
  return b;
}

const CSS = `
.fixit-btn { position: relative; }
.fixit-btn.warn { color: var(--warn); border-color: color-mix(in srgb, var(--warn) 55%, var(--line)); background: var(--warn-soft); }
.fixit-btn .n { position: absolute; top: -5px; right: -5px; min-width: 16px; height: 16px; padding: 0 4px; border-radius: 99px; background: var(--warn); color: #1a1205; font-size: 10.5px; font-weight: 700; display: grid; place-items: center; }
body.clean .fixit-btn { display: none; }
#topbar .logo { white-space: nowrap; flex: none; }
`;
