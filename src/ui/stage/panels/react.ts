// Scene tab → React → window size presets (shared/stage.ts): Auto · Full · Big · Medium · Side, each card drawn for
// the people in the room right now; the one Auto picks is outlined.
import { REACT_LABEL, planReactFull, planReactMedium, resolveReact, type ReactPreset } from '../../../../shared/stage.ts';
import { h } from '../../dom.ts';
import { registerModePanel } from '../panelCore.ts';
import { canvasAspect, card, presentKeys, thumb } from '../common.ts';

const SUB: Record<ReactPreset, string> = {
  auto: 'by group size', full: 'window fills the frame', big: 'the room’s big screen', medium: 'window + everyone', side: 'screen beside you',
};
const TIP: Record<ReactPreset, string> = {
  auto: 'Alone: Side · 2–4 people: Big · 5+: Medium',
  full: 'The window as big as it gets; performers as cams in front of its bottom corners, chat + support docked beside it',
  big: 'The room’s big centre screen (today’s React). Anyone the camera can’t see well gets a cam in the free space',
  medium: 'The window ~⅔ wide, everyone clearly visible under it (host first, bigger), chat + support on the right',
  side: 'The solo side screen beside the host (a two-shot). Guests get cams in the free space',
};

registerModePanel('react', (_app, S) => {
  const st = S.stage, edit = S.canEdit;
  const keys = presentKeys(S), n = Math.max(1, keys.length);
  const aspect = canvasAspect();
  const room = S.effective.sceneId ? S.rooms.get(S.effective.sceneId) : null;
  const eff = resolveReact(st.react, n, room ? room.screen : true);
  const inp = { aspect, keys: keys.length ? keys : ['@host'], content: st.content, chat: st.dock.chat !== 'off', support: st.dock.support !== 'off' };
  const pic = (p: ReactPreset) => {
    const k = p === 'auto' ? eff : p;
    return k === 'full' ? thumb(planReactFull(inp), aspect) : k === 'medium' ? thumb(planReactMedium(inp), aspect) : thumb(null, aspect, { kind: k === 'big' ? 'big' : 'side', keys: inp.keys });
  };
  const presets: ReactPreset[] = ['auto', 'full', 'big', 'medium', 'side'];
  return h('div', null,
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Window size'), h('span', { class: 'note', style: 'margin:0' }, `${n} ${n === 1 ? 'person' : 'people'} in the room`)),
    h('div', { class: 'stg-cards' }, ...presets.map((p) => card(REACT_LABEL[p], p === 'auto' ? `→ ${REACT_LABEL[eff]}` : SUB[p], pic(p), st.react === p, st.react === 'auto' && p === eff, !edit, () => S.setStage({ react: p }), TIP[p]))),
    room && !room.screen && (eff === 'big') ? h('p', { class: 'note' }, 'This room has no big screen: Big shows Medium.') : null,
  );
});
