// Tutorials: where each person got to (this browser only). { [tutorialId]: { step, done, at } } + the one in progress.
// Observer pages (?observer=1) share storage with the live studio: they read, never write (`save` false).
export interface TutProgress { step: number; done: boolean; at?: number }

const KEY = 'vtp.tut.progress', ACTIVE = 'vtp.tut.active';
const ls = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string | null) => { try { if (v === null) localStorage.removeItem(k); else localStorage.setItem(k, v); } catch { /* storage off */ } },
};
function all(): Record<string, TutProgress> {
  try { const v = JSON.parse(ls.get(KEY) || '{}'); return v && typeof v === 'object' && !Array.isArray(v) ? v : {}; } catch { return {}; }
}
export function progressOf(id: string): TutProgress {
  const p = all()[id];
  return p && typeof p.step === 'number' ? { step: Math.max(0, Math.floor(p.step)), done: !!p.done, at: p.at } : { step: 0, done: false };
}
export function saveProgress(id: string, p: TutProgress, save: boolean) {
  if (!save) return;
  const a = all();
  const was = a[id];
  // finishing once stays finished (a re-run shows "Done" until it is finished again or started over)
  a[id] = { step: p.step, done: p.done || (!!was?.done && p.step === 0), at: Date.now() };
  ls.set(KEY, JSON.stringify(a));
}
export function forget(id: string, save: boolean) {
  if (!save) return;
  const a = all(); delete a[id]; ls.set(KEY, JSON.stringify(a));
}
export const activeTutorial = () => ls.get(ACTIVE);
export function setActive(id: string | null, save: boolean) { if (save) ls.set(ACTIVE, id); }
