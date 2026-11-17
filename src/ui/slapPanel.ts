// Scene tab → 🖐 Slap! — the host sends the minion (the chat buddy's model by default, or any avatar of this PC's
// library) to slap a performer on screen: they get knocked over, the minion bows and runs off (shared/slap.ts,
// src/scene/slap/*). Everything the pages need is the host's stage-mode bag SceneState.modes.slap, so every OBS page —
// the host's and every party guest's — plays the same gag.
//
// Triggers: the 🖐 Slap! button (with a target picker: Random / anyone in the room), Shift+S (the picked target),
// Stream Deck / scripts: POST http://127.0.0.1:5191/api/command {"command":"slap","args":{"target":"random"}}
// (target: 'random' | 'host' | a member key | a name, optional "model": avatar id | "" = same as the chat buddy).
import type { App } from '../app.ts';
import type { SceneController } from '../scene/controller.ts';
import { HOST_KEY } from '../../shared/scene.ts';
import { SLAP_BAG, SLAP_T, pickSlapTarget, sanitizeSlap, type SlapBag } from '../../shared/slap.ts';
import { api } from '../api.ts';
import { button, h, rerender, section, select, toast, toggle } from './dom.ts';
import { forScripts } from './forScripts.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
const bagOf = (S: SceneController): SlapBag => sanitizeSlap((S as unknown as BagApi).modeBag(SLAP_BAG));
function setBag(S: SceneController, fn: (b: SlapBag) => void) {
  const b = structuredClone(bagOf(S));
  fn(b);
  (S as unknown as BagApi).setModeBag(SLAP_BAG, sanitizeSlap(b));
}

const PICK_KEY = 'vtp.slap.target';
const readPick = () => { try { return localStorage.getItem(PICK_KEY) || 'random'; } catch { return 'random'; } };
const writePick = (v: string) => { try { localStorage.setItem(PICK_KEY, v); } catch { /* private mode */ } };

/** Performers in the room right now (the host first). */
export function slapTargets(S: SceneController): { key: string; name: string }[] {
  const st = S.effective;
  return S.members().filter((m) => st.present[m.key] !== false).map((m) => ({ key: m.key, name: m.name.replace(/ \((host|you|test)\)$/, '') }));
}

/** Resolve a target request ('random' | 'host' | 'me' | member key | a name) against who is in the room. */
function resolve(S: SceneController, want: string, seed: number): { key: string; name: string } | null {
  const list = slapTargets(S);
  const w = want.trim();
  if (!w || w === 'random') { const k = pickSlapTarget(list.map((x) => x.key), seed, HOST_KEY); return list.find((x) => x.key === k) ?? null; }
  if (w === 'host' || w === 'me' || w === HOST_KEY) return list.find((x) => x.key === HOST_KEY) ?? null;
  const lw = w.toLowerCase();
  return list.find((x) => x.key === w) ?? list.find((x) => x.name.toLowerCase() === lw) ?? list.find((x) => x.name.toLowerCase().includes(lw)) ?? null;
}

/** Send the minion. Returns the target's name (or null + a toast saying why not). */
export function slap(S: SceneController, want = readPick(), model?: string): string | null {
  if (!S.canEdit) { toast('Only the host can send the slapper', 'warn'); return null; }
  const st = S.effective;
  if (!st.sceneId) { toast('Slap! needs a room (pick one in Room)', 'warn'); return null; }
  const bag = bagOf(S);
  const now = Date.now();
  // a short cooldown: the next slap starts after this one is over
  if (bag.ev && now < bag.ev.at + SLAP_T.cooldown && now > bag.ev.at - 60_000) {
    toast(`Slap! cooling down (${Math.ceil((bag.ev.at + SLAP_T.cooldown - now) / 1000)} s)`, 'warn', 1500);
    return null;
  }
  const seed = (Math.random() * 2147483646 | 0) + 1;
  const t = resolve(S, want, seed);
  if (!t) { toast(want === 'random' ? 'Nobody in the room to slap' : `Slap!: nobody called “${want}” in the room`, 'warn'); return null; }
  setBag(S, (b) => {
    if (typeof model === 'string' && /^[A-Za-z0-9_-]{0,48}$/.test(model)) b.model = model;
    b.ev = { seq: (b.ev?.seq ?? 0) + 1, at: now + SLAP_T.lead, target: t.key, seed };
  });
  toast(`🖐 Slap! → ${t.name}`, 'ok', 1400);
  return t.name;
}

/** Bus / Stream Deck: {command:'slap', args:{target?, model?}} (the studio applies it; guests ignore it). */
export function slapCommand(S: SceneController, a: Record<string, unknown>) {
  if (!S.canEdit) return;
  slap(S, typeof a.target === 'string' ? a.target : readPick(), typeof a.model === 'string' ? a.model : undefined);
}

/** Studio hotkey: Shift+S = slap the picked target. */
export function slapKey(e: KeyboardEvent, app: App): boolean {
  if (!e.shiftKey || e.ctrlKey || e.altKey || e.metaKey || e.code !== 'KeyS') return false;
  if (!app.scene.canEdit || !app.scene.effective.sceneId) return false;
  e.preventDefault();
  slap(app.scene);
  return true;
}

/** Scene tab section (keeps itself up to date: re-renders on scene changes). */
export function slapSection(app: App): HTMLElement {
  const S = app.scene;
  const box = h('div');
  let lib: { id: string; name: string }[] | null = null;
  const loadLib = () => api.avatars().then((l) => { lib = l.map((a) => ({ id: a.id, name: a.name || a.id })); if (box.isConnected) render(); }).catch(() => { lib = []; });
  const render = () => rerender(box, () => {
    const edit = S.canEdit, st = S.effective;
    if (!edit) { box.append(h('p', { class: 'note' }, 'The host sends the slapper — your OBS shows the same gag.')); return; }
    if (!st.sceneId) { box.append(h('p', { class: 'note' }, 'Pick a room first: the slapper runs in to someone in it.')); return; }
    const bag = bagOf(S);
    const people = slapTargets(S);
    let pick = readPick();
    if (pick !== 'random' && !people.some((p) => p.key === pick)) pick = 'random';
    const targetSel = select('Who', pick, [['random', people.length > 1 ? 'Random (a guest)' : 'Random'], ...people.map((p): [string, string] => [p.key, p.key === HOST_KEY ? `${p.name} (you)` : p.name])],
      (v) => { writePick(v); }, 'Who gets slapped when you press the button or Shift+S');
    const list = (lib ?? []).filter((a) => a.id !== 'robot');
    const dup = (a: { id: string; name: string }) => a.name === 'Sprocket' || list.filter((x) => x.name === a.name).length > 1;
    const opts: [string, string][] = [['', 'Same as the chat buddy'], ['robot', 'Sprocket'], ...list.map((a): [string, string] => [a.id, dup(a) ? `${a.name} (${a.id})` : a.name])];
    if (bag.model && !opts.some(([v]) => v === bag.model)) opts.push([bag.model, `${bag.model} (not on this PC)`]);
    box.append(
      h('div', { class: 'btns tight' },
        button('🖐 Slap! (Shift+S)', () => { slap(S); }, 'primary'),
        h('span', { class: 'note', style: 'margin-left:8px' }, 'Runs in, slaps, knocks them over, bows, runs off (~5 s).')),
      targetSel,
      select('Slapper', bag.model, opts, (v) => setBag(S, (b) => { b.model = v; }), 'Any avatar from your library (no costume; never saved, not a party member). Party guests’ OBS pages show Sprocket unless they have it too.'),
      toggle('Slap sounds', bag.sound, (v) => setBag(S, (b) => { b.sound = v; }), 'A punch + a thud, played in this studio (Audio mixer → Room sounds; CC0 Kenney impact sounds)'),
      h('p', { class: 'note' }, 'In Interview mode the camera cuts to the action (guests on the monitor get slapped in their own studio); in React / Gaming layouts the minion shows up in their cam.'),
      forScripts('Stream Deck: POST http://127.0.0.1:5191/api/command {"command":"slap","args":{"target":"random"}} — target: random, host, a name.'),
    );
  });
  S.on((what) => { if (box.isConnected && what === 'state') render(); });
  void loadLib();
  render();
  return section('🖐 Slap!', box);
}
