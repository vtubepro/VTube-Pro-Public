// Scene tab → Show mode → "Layout look": the appearance of the screen-first layout on screen right now (React Full /
// Medium, every Gaming layout, the Full screen HUD layouts): the performers boxed or as cut-outs, their size + corner,
// frame, corner radius, opacities, backdrop dim / blur, a dark veil over the capture, the cut-out's shadow + outline,
// the safe margin. Saved per layout (shared/layoutLook.ts) in the `hud` mode bag: every change is one bag write, so the
// OBS pages (and party guests' pages) follow at once. Exact positions: the Layout editor (drag on the preview).
// Mounted by src/ui/stagePanel.ts (one line); returns null in 3D layouts (Talk, React Big / Side …).
import type { App } from '../../app.ts';
import type { Rect, StagePlan } from '../../../shared/stage.ts';
import { HUD_BAG, HUD_BAG_LIMIT, HUD_MODE, hudBagBytes, layoutBaseLook, lookFor, sanitizeHudBag, withLook, type HudBag } from '../../../shared/hud.ts';
import { DEFAULT_LOOK, LOOK_RANGES, camsOnCapture, resolveLook, type AvatarStyle, type ChatStyle, type FrameStyle, type LayoutLook, type LookAnchor } from '../../../shared/layoutLook.ts';
import { slotKey } from '../../../shared/stageLayout.ts';
import { button, h, section, slider, toast } from '../dom.ts';
import { steps } from './common.ts';

type BagApi = { modeBag(id: string): unknown; setModeBag(id: string, v: unknown): void };

const CSS = `
.lk .lk-grp { margin:8px 0 2px; font-size:11.5px; font-weight:700; letter-spacing:.04em; text-transform:uppercase; color:var(--faint); }
.lk .lk-corner { display:inline-grid; grid-template-columns: 22px 22px; gap:3px; vertical-align:middle; }
.lk .lk-corner button { width:22px; height:14px; border-radius:3px; border:1px solid var(--line2); background:var(--card2); cursor:pointer; padding:0; }
.lk .lk-corner button.on { background: var(--accent2); border-color: var(--accent2); }
.lk .lk-auto { margin-left:6px; }
.lk input[type=color] { width:44px; height:24px; padding:0; border:1px solid var(--line2); border-radius:6px; background:none; cursor:pointer; }
.lk .lk-foot { display:flex; gap:6px; flex-wrap:wrap; align-items:center; margin-top:8px; }
`;
let cssDone = false;

/** Pending writes (a slider drag writes once it pauses; the panel re-renders from the saved state). */
let pending: { slot: string; look: LayoutLook; base?: Partial<LayoutLook>; t: number } | null = null;

export function lookSection(app: App): HTMLElement | null {
  const S = app.scene;
  const rep = S.report?.stage;
  const eff = S.effective;
  if (!rep || rep.view !== 'composite' || !eff.sceneId) return null;
  if (!cssDone) { document.head.append(h('style', null, CSS)); cssDone = true; }
  const B = S as unknown as BagApi;
  const edit = S.canEdit;
  const bag = (): HudBag => sanitizeHudBag(B.modeBag(HUD_BAG));
  const b0 = bag();
  const slot = slotKey(eff.mode, rep.label);
  const base = layoutBaseLook(b0, eff.mode, rep.label, S.stage.backdrop);
  const look: LayoutLook = pending && pending.slot === slot ? pending.look : lookFor(b0, slot, base);
  // the report's plan shape (cams on the capture → size + corner apply)
  const plan: StagePlan = { key: rep.key, view: 'composite', label: rep.label, capture: rep.capture as Rect | null, tiles: rep.tiles.map((t) => ({ key: t.key, rect: t.rect, framing: 'bust', backdrop: 'room', tag: 'inside' })), docks: { chat: null, support: null } };
  const onCap = camsOnCapture(plan) || eff.mode === HUD_MODE;

  const write = (patch: Partial<LayoutLook>) => {
    if (!edit) { toast('The host runs the layout', 'warn'); return; }
    const next = { ...look, ...patch };
    Object.assign(look, patch);
    pending = { slot, look: next, base, t: Date.now() };
    clearTimeout(timer);
    timer = window.setTimeout(flush, 220);
  };
  const flush = () => {
    const p = pending; if (!p) return;
    const nb = withLook(bag(), p.slot, p.look, p.base);
    if (hudBagBytes(nb) > HUD_BAG_LIMIT) { toast('Too many layout settings saved — reset the look of a layout you no longer use', 'warn', 5000); pending = null; return; }
    B.setModeBag(HUD_BAG, nb);
    // (keep the draft a moment: the saved state comes back through the scene controller)
    setTimeout(() => { if (pending === p) pending = null; }, 1200);
  };
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const px = (v: number) => `${Math.round(v)} px`;
  const sl = (label: string, k: keyof typeof LOOK_RANGES, step: number, fmt: (v: number) => string, hint: string) => {
    const [mn, mx] = LOOK_RANGES[k];
    const v = (look[k] as number | undefined) ?? 0;
    const el = slider(label, v, mn, mx, step, (x) => write({ [k]: x } as Partial<LayoutLook>), hint, fmt, { def: (resolveLook(base)[k] as number | undefined) ?? (DEFAULT_LOOK[k] as number | undefined) ?? 0 });
    if (!edit) el.querySelectorAll('input').forEach((i) => { (i as HTMLInputElement).disabled = true; });
    return el;
  };
  const corner = (c: Exclude<LookAnchor, 'auto'>) => h('button', { class: look.anchor === c ? 'on' : '', disabled: !edit, title: { tl: 'top left', tr: 'top right', bl: 'bottom left', br: 'bottom right' }[c], onClick: () => { write({ anchor: c }); rerenderSoon(); } });
  const cut = rep.tiles.length > 0 && (look.avatar === 'cutout' || (look.avatar === 'auto' && (eff.mode === HUD_MODE || S.stage.backdrop === 'cutout')));
  let el: HTMLElement;
  const rerenderSoon = () => { const n = lookSection(app); if (n && el.isConnected) el.replaceWith(n); };

  el = section('🎨 Look',
    h('p', { class: 'note', style: 'margin:2px 0 6px' }, `${rep.label} looks right as it is. Everything below is optional — saved for this layout only, OBS follows as you change it, “Reset to default” puts it back.`),
    rep.tiles.length ? [
      h('div', { class: 'lk-grp' }, 'Performers'),
      h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Avatar'), steps<AvatarStyle>(look.avatar, [['auto', eff.mode === 'gaming' ? 'Gaming’s' : 'Layout'], ['room', 'Box: room'], ['clean', 'Box: studio'], ['cutout', 'Cut-out']], (v) => { write({ avatar: v }); rerenderSoon(); }, !edit)),
      h('p', { class: 'note', style: 'margin:0 0 4px' }, eff.mode === 'gaming' ? 'Cut-out: just the character, no box — it stands on your game. Gaming’s = “Behind the cams” above (all Gaming layouts); pick here to give this layout its own.' : 'Cut-out: just the character, no box — it stands on your game / window.'),
      onCap ? [
        sl('Size', 'scale', 0.01, pct, 'The performers’ cams, bigger or smaller (they keep their corner)'),
        h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Corner'), h('span', { class: 'lk-corner' }, corner('tl'), corner('tr'), corner('bl'), corner('br')),
          h('button', { class: `btn tight lk-auto ${look.anchor === 'auto' ? 'on' : ''}`, disabled: !edit, onClick: () => { write({ anchor: 'auto' }); rerenderSoon(); } }, 'Layout’s')),
      ] : h('p', { class: 'note', style: 'margin:2px 0' }, 'This layout keeps its cams in their own strip — move or resize them one by one in the Layout editor.'),
      sl('Cam opacity', 'camOpacity', 0.01, pct, 'See-through cams (the capture shows through)'),
      sl('Name tags', 'tags', 0.01, (v) => (v <= 0.01 ? 'off' : pct(v)), 'Name tag opacity (0 = no name tags)'),
      cut ? [
        h('div', { class: 'lk-grp' }, 'Cut-out'),
        sl('Drop shadow', 'shadow', 0.01, pct, 'A soft shadow behind the character'),
        sl('Outline', 'outline', 0.5, px, 'A solid outline around the character (px at 1080p; 0 = none)'),
        look.outline > 0 ? h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Outline colour'), h('input', { type: 'color', value: look.outlineColor, disabled: !edit, onInput: (e: Event) => write({ outlineColor: (e.target as HTMLInputElement).value }) })) : null,
      ] : null,
    ] : null,
    h('div', { class: 'lk-grp' }, 'Chat'),
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Chat box'), steps<ChatStyle>(look.chat, [['auto', 'Chat box’s'], ['panel', 'Panel'], ['text', 'Text only']], (v) => { write({ chat: v }); rerenderSoon(); }, !edit)),
    h('p', { class: 'note', style: 'margin:0 0 4px' }, 'Text only: chat as outlined text on the stream, no panel (its options: Chat & events → Chat box on stream). When it shows and where it sits: the chat box settings.'),
    h('div', { class: 'lk-grp' }, 'Frame'),
    h('div', { class: 'stg-row' }, h('span', { class: 'lbl' }, 'Borders'), steps<FrameStyle>(look.frame, [['none', 'None'], ['thin', 'Thin'], ['bezel', 'Bezel'], ['glow', 'Glow']], (v) => { write({ frame: v }); rerenderSoon(); }, !edit)),
    sl('Cam corners', 'radius', 1, px, 'Corner radius of boxed cams'),
    sl('Screen corners', 'screenRadius', 1, px, 'Corner radius of the game / window area (0 = square, best when it fills the frame)'),
    h('div', { class: 'lk-grp' }, 'Background'),
    eff.mode !== HUD_MODE ? [
      sl('Backdrop', 'backdrop', 0.01, pct, 'Opacity of the styled backdrop around the capture (0 = see-through: OBS shows what is under the browser source)'),
      sl('Backdrop dim', 'dim', 0.01, pct, 'Darker backdrop'),
      sl('Backdrop blur', 'blur', 0.01, pct, 'A softer, plainer backdrop (its pattern and light sweep fade)'),
      sl('Panels', 'panels', 0.01, pct, 'Opacity of the docked chat / support panels'),
    ] : null,
    sl('Screen dim', 'screenDim', 0.01, pct, 'A dark veil over the game / window (OBS shows it through the page) — makes text and the avatar pop. Blur needs an OBS filter on the capture source.'),
    sl('Safe margin', 'safe', 0.001, (v) => `${(v * 100).toFixed(1)}%`, 'Keeps everything this far from the frame edges (for platforms that crop)'),
    h('div', { class: 'lk-foot' },
      button('Reset to default', () => {
        if (!edit) return;
        pending = null; clearTimeout(timer);
        const nb = { ...bag(), looks: { ...bag().looks } }; delete nb.looks[slot];
        B.setModeBag(HUD_BAG, nb); toast('Look reset to the layout’s defaults', 'ok', 1500);
      }),
      h('span', { class: 'note', style: 'margin:0' }, `${(hudBagBytes(b0) / 1024).toFixed(1)} / ${(HUD_BAG_LIMIT / 1024).toFixed(1)} KB used`)),
  );
  el.classList.add('lk');
  // the controls are optional extras: folded away until opened (remembered while the studio is open)
  const det = h('details', { class: 'lk-more', open: lookOpen, onToggle: (e: Event) => { lookOpen = (e.target as HTMLDetailsElement).open; } } as never, h('summary', { class: 'btn tight', style: 'display:inline-block;margin:2px 0 6px;cursor:pointer' }, 'Adjust the look (optional)'));
  const kids = [...el.children].slice(2);
  det.append(...kids);
  el.append(det);
  return el;
}
let timer = 0;
let lookOpen = false;
