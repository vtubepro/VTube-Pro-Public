// Building blocks shared by the Simple views and the setup wizards: cards, status rows, segmented pickers, the
// "more under Advanced" link, live updaters, and the quick room controls (time / weather / background action).
import type { App } from '../app.ts';
import { WEATHER_ICON, WEATHER_LABEL, type EnvWeather } from '../../shared/environment.ts';
import { h } from './dom.ts';
import { icon } from './icons.ts';

type Kid = Node | string | null | false | undefined;
/** Element.append that skips null / false (like h()). */
export const add = (el: Element, ...kids: (Node | string | null | false | undefined)[]) => el.append(...kids.filter((k): k is Node | string => k !== null && k !== undefined && k !== false));

/** Registered live updaters (each returns false once its element is gone). One 350 ms timer for all of them. */
const liveFns = new Set<() => boolean>();
let liveT = 0;
export function live(fn: () => boolean) {
  liveFns.add(fn);
  if (!liveT) liveT = window.setInterval(() => {
    for (const f of liveFns) { try { if (!f()) liveFns.delete(f); } catch { liveFns.delete(f); } }
    if (!liveFns.size) { clearInterval(liveT); liveT = 0; }
  }, 350);
}

// (UX redesign: in the new layout a panel's cards fold: the chevron (or the title) folds one, remembered per panel by its
// title, src/ui/dom.ts foldCard; the shell wires the clicks. Classic layout and set-up wizards hide the chevron.)
const cardKey = (title: string | Node) => (typeof title === 'string' ? title : title.textContent ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'card';
export const card = (title: string | Node, lead: string | Node | null, ...kids: Kid[]) =>
  h('section', { class: 's-card', 'data-key': cardKey(title) }, h('h3', null, title, h('button', { type: 'button', class: 's-fold', 'aria-expanded': 'true', 'aria-label': 'Fold or unfold', title: 'Fold / unfold' }, icon('chev', 16))), lead ? h('p', { class: 'lead' }, lead) : null, ...kids);
export const heroCard = (tone: '' | 'blue' | 'violet', ...kids: Kid[]) => h('section', { class: `s-card hero ${tone}` }, ...kids);
export const more = (text: string, detail: string, onClick: () => void) =>
  h('button', { class: 's-more', onClick }, h('span', { 'aria-hidden': 'true' }, '⚙'), h('span', null, h('b', null, text), ' — ', detail), h('span', { style: 'margin-left:auto', 'aria-hidden': 'true' }, '→'));
export function item(state: 'ok' | 'warn' | 'err' | '', ic: string, t: string | Node, d: string | Node, action?: Node | null) {
  return h('div', { class: `s-item ${state}` }, h('span', { class: 'ic', 'aria-hidden': 'true' }, ic), h('div', null, h('div', { class: 't' }, t), h('div', { class: 'd' }, d)), action ?? h('span'));
}
export function seg<T extends string>(opts: [T, string, string?][], cur: T | null, onPick: (v: T) => void, disabled = false) {
  return h('div', { class: 's-seg', role: 'radiogroup' }, ...opts.map(([v, label, small]) =>
    h('button', { class: v === cur ? 'on' : '', disabled, role: 'radio', 'aria-checked': String(v === cur), onClick: () => onPick(v) }, label, small ? h('small', null, small) : null)));
}
export function pill(on: boolean, label: string | Node, onClick: () => void, title = '', disabled = false) {
  return h('button', { class: `s-pill ${on ? 'on' : ''}`, 'aria-pressed': String(on), title, disabled, onClick }, label);
}
export function observerNote(app: App) {
  // (the shell's observer line shows in every area header now: src/ui/shell.ts; this note only where there is no header)
  return app.observer && !document.getElementById('vtp-observer-bar') ? h('div', { class: 's-banner' }, h('span', null, '🧪'), h('span', null, h('b', null, 'Observer sandbox. '), 'Nothing you change here is saved or sent to OBS, and the camera and mic stay off.')) : null;
}

// ---------------------------------------------------------------- quick room controls
export function envQuick(app: App) {
  const S = app.scene, env = S.envState, cfg = S.scenes.find((x) => x.id === S.effective.sceneId)?.environment ?? {};
  const edit = S.canEdit;
  const wx: EnvWeather[] = ['clear', 'cloudy', 'rain', 'storm', 'fog'];
  const hr = (hour: number) => () => S.setEnv({ on: true, hour, ...(env.clock === 'real' ? { clock: 'cycle' as const } : {}) });
  return h('div', null,
    h('div', { class: 's-field' }, h('span', null, 'Time of day'), h('div', { class: 's-pills' },
      pill(false, '🌅 Dawn', hr((cfg.sunrise ?? 6) + 0.25), '', !edit), pill(false, '☀️ Day', hr(12.5), '', !edit),
      pill(false, '🌇 Sunset', hr((cfg.sunset ?? 18.5) - 0.3), '', !edit), pill(false, '🌙 Night', hr(23), '', !edit),
      pill(env.clock === 'real', '⏱ Real time', () => S.setEnv({ on: true, clock: 'real' }), 'Follow your PC clock', !edit))),
    h('div', { class: 's-field' }, h('span', null, 'Weather'), h('div', { class: 's-pills' },
      ...wx.map((w) => pill(env.weatherMode === 'manual' && env.weather === w, `${WEATHER_ICON[w]} ${WEATHER_LABEL[w]}`, () => S.setEnv({ on: true, weather: w, weatherMode: 'manual' }), '', !edit)),
      pill(env.weatherMode === 'cycle', '🔄 Changing', () => S.setEnv({ on: true, weatherMode: 'cycle' }), 'Changes by itself now and then, like in games', !edit))));
}
export function actionQuick(app: App, space: boolean) {
  const S = app.scene;
  const st = space ? S.effective.space : S.effective.raid;
  const cur = !st?.on ? 'off' : st.intensity;
  return h('div', { class: 's-field' }, h('span', null, space ? 'Space battle outside' : 'Background action'),
    seg([['off', 'Off'], ['chill', 'Now & then'], ['normal', 'Regular'], ['hot', 'Non-stop']], cur, (v) => {
      const p = v === 'off' ? { on: false } : { on: true, intensity: v as 'chill' | 'normal' | 'hot' };
      if (space) S.setSpace(p); else S.setRaid(p);
    }, !S.canEdit),
    h('span', { class: 'hint' }, space ? 'Fighters, warps and explosions outside the window.' : 'Soldiers skirmish far behind you — never in front of your face.'));
}
