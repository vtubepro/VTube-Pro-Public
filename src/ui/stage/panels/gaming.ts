// Scene tab → Gaming → layout presets (shared/stage.ts): Auto · Corner cam · Strip bottom · Strip top · Side column,
// strip size, the solo cam's corner / size / framing, what's behind the cams, and the Gaming Lounge for 3+ players.
import { GAMING_LABEL, planGaming, resolveGaming, type GamingLayout, type Corner } from '../../../../shared/stage.ts';
import { h, toggle } from '../../dom.ts';
import { HUD_BAG, layoutBaseLook, lookFor, sanitizeHudBag, withLook } from '../../../../shared/hud.ts';
import type { CamBackdrop } from '../../../../shared/stage.ts';
import { registerModePanel } from '../panelCore.ts';
import { canvasAspect, card, presentKeys, steps, thumb } from '../common.ts';

const SUB: Record<GamingLayout, string> = { auto: 'by group size', corner: 'solo facecam', 'strip-bottom': 'cams under the game', 'strip-top': 'cams above the game', column: 'cams down the side' };
const TIP: Record<GamingLayout, string> = {
  auto: 'Alone: a corner cam · 2+: a strip along the bottom (3+ move to the Gaming Lounge)',
  corner: 'Your game big, you as a live cam in a corner of it',
  'strip-bottom': 'The game on top, everyone as live cams along the bottom — host on the left, then guests in join order',
  'strip-top': 'The same strip above the game',
  column: 'Cams stacked down the left side, the game in the middle, chat on the right',
};

registerModePanel('gaming', (_app, S) => {
  const st = S.stage, edit = S.canEdit;
  const keys = presentKeys(S), n = Math.max(1, keys.length);
  const aspect = canvasAspect();
  const eff = resolveGaming(st.gaming, n);
  const base = { aspect, keys: keys.length ? keys : ['@host'], content: st.content, chat: st.dock.chat !== 'off', support: st.dock.support !== 'off', strip: st.strip, corner: st.corner, cam: st.cam, framing: st.framing, backdrop: st.backdrop };
  const pic = (l: GamingLayout) => thumb(planGaming({ ...base, layout: l === 'auto' ? eff : l }), aspect);
  const layouts: GamingLayout[] = ['auto', 'corner', 'strip-bottom', 'strip-top', 'column'];
  const corner = (c: Corner) => h('button', { class: st.corner === c ? 'on' : '', disabled: !edit, title: { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' }[c], onClick: () => S.setStage({ corner: c }) });
  // the corner cam is a cut-out by default (shared/hud.ts layoutBaseLook): show what is really drawn, and a pick here
  // sets that layout's own look (the `hud` bag); the other layouts keep the shared "Behind the cams" setting
  const B = S as unknown as { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };
  const bag = sanitizeHudBag(B.modeBag(HUD_BAG)), slot = 'gaming.corner-cam';
  const lookBase = layoutBaseLook(bag, 'gaming', 'Corner cam', st.backdrop);
  const cornerLook = lookFor(bag, slot, lookBase);
  const shown: CamBackdrop = eff === 'corner' && cornerLook.avatar !== 'auto' ? cornerLook.avatar : st.backdrop;
  const pickBackdrop = (v: CamBackdrop) => {
    if (eff !== 'corner') { S.setStage({ backdrop: v }); return; }
    B.setModeBag(HUD_BAG, withLook(bag, slot, { ...cornerLook, avatar: v }, lookBase));
  };
  const lounge = S.scenes.find((x) => x.id === st.loungeRoom);
  const inLounge = S.effective.sceneId === st.loungeRoom;
  return h('div', null,
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Layout'), h('span', { class: 'note', style: 'margin:0' }, `${n} ${n === 1 ? 'player' : 'players'}${inLounge ? ' · in the Gaming Lounge' : ''}`)),
    h('div', { class: 'stg-cards' }, ...layouts.map((l) => card(GAMING_LABEL[l], l === 'auto' ? `→ ${GAMING_LABEL[eff]}` : SUB[l], pic(l), st.gaming === l, st.gaming === 'auto' && l === eff, !edit, () => S.setStage({ gaming: l }), TIP[l]))),
    eff === 'corner'
      ? h('div', null,
        h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Cam corner'), h('span', { class: 'stg-corner' }, corner('tl'), corner('tr'), corner('bl'), corner('br')),
          h('span', { class: 'lbl', style: 'min-width:auto;margin-left:10px' }, 'Size'), steps(st.cam, [['s', 'S'], ['m', 'M'], ['l', 'L']], (v) => S.setStage({ cam: v }), !edit)),
        h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Framing'), steps(st.framing, [['bust', 'Bust'], ['full', 'Full body']], (v) => S.setStage({ framing: v }), !edit)))
      : h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, eff === 'column' ? 'Column width' : 'Strip height'), steps(st.strip, [['s', 'S'], ['m', 'M'], ['l', 'L']], (v) => S.setStage({ strip: v }), !edit)),
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Behind the cams'), steps(shown, [['room', 'The room'], ['clean', 'Studio'], ['cutout', 'Cut-out']], pickBackdrop, !edit)),
    shown === 'cutout' ? h('p', { class: 'note' }, 'Cut-out: just the avatars, standing in front of your game (nothing behind them).') : null,
    toggle('Webcam / VTube Studio guests: show their picture', !!st.tvFeed, (v) => S.setStage({ tvFeed: v }), 'Guests who join as a walking TV: their cam shows their live picture (framed like a TV) instead of the 3D TV at their seat'),
    toggle('Gaming Lounge for 3+ players', st.lounge, (v) => S.setStage({ lounge: v }), 'With more than two in the room, Gaming moves everyone to the Gaming Lounge (a row of gaming chairs, host on the left). Leaving Gaming goes back to your room.'),
    st.lounge && !lounge ? h('p', { class: 'note', style: 'color:var(--warn,#e0a030)' }, `The Gaming Lounge room (${st.loungeRoom}) isn’t installed — the strip uses your current room.`) : null,
  );
});
