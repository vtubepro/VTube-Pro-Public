// beta.12 wiring: where the lanes' extension points meet (one hook in src/main.ts: mountLaneWiring(app)). Each lane
// shipped its piece behind ONE open / mount function; this file decides where users find it, so no lane had to edit
// another lane's files:
//   * 2D hand-off (dropImport.ts setTwoDImporter): a layered PSD opens the 2D avatar maker (rig2dEditor/studio.ts
//     routeLayeredArt); pictures / GIFs / a Live2D or Inochi2D zip, folder or puppet go to the 2D importer
//     (flatPanel.ts openFlatImport → POST /api/avatars/import-flat, which converts Live2D / Inochi2D to .vtp2).
//   * Show dock, Room menu (showDock.ts registerDockEntry): "Edit this room" (roomEditor.ts openRoomEditor), "Adjust
//     this camera" (cameraTweaks.ts mountCameraTweaks) and "Seating chart" (seatingChart.ts mountSeatingChart).
//   * Show dock, Me menu: "2D avatar options" while a 2D avatar is on (flatPanel.ts flatPanel) and "Create a 2D avatar".
//   * Tools menu (toolsMenu.ts registerTool): "Create a 2D avatar" (rig2dEditor/studio.ts openAvatarMaker).
// The 2D avatar maker is a big module: it loads only when opened.
import type { App } from '../app.ts';
import { button, h, toast } from './dom.ts';
import { icon } from './icons.ts';
import { registerDockEntry } from './showDock.ts';
import { registerTool } from './toolsMenu.ts';
import { openRoomEditor } from './roomEditor.ts';
import { flatPanel, openFlatImport } from './flatPanel.ts';
import { registerSupportTool } from './supportTool.ts';

/** Open the 2D avatar maker (optionally with dropped files: a layered PSD). */
export function openAvatarMakerLazy(app: App, files?: File[]) {
  void import('../rig2dEditor/studio.ts').then((m) => m.openAvatarMaker(app, files))
    .catch(() => toast('The 2D avatar maker didn’t open. Reload the page and try again.', 'warn', 6000));
}
/** A "Create a 2D avatar" button for any panel. */
export function avatarMakerButton(app: App, label = 'Create a 2D avatar…', cls = ''): HTMLButtonElement {
  const b = button(label, () => openAvatarMakerLazy(app), cls) as HTMLButtonElement;
  b.title = 'Turn your drawing (a layered PSD) into a 2D avatar that moves with your face. Pictures work too.';
  return b;
}

/** dropImport.ts importModelButton, loading the importer only when pressed (it is a big module): any model file, its
 *  folder or a zip → the plain-words report + automatic fixes; 2D art goes on to the 2D importer / maker. */
export function importModelButtonLazy(app: App, label = 'Import a model…', onDone?: (id: string) => void, cls = 'primary'): HTMLButtonElement {
  const b = button(label, () => void import('./dropImport.ts').then((m) => m.openModelImport(app, null, { onDone })), cls) as HTMLButtonElement;
  b.dataset.ui = 'import-model';
  b.title = 'Any 3D model (VRM, GLB, FBX, PMX, OBJ, .blend…), a Pro2D avatar, 2D pictures or a 2D model from another app. You can also drop it anywhere in the studio.';
  return b;
}

/** Where a dropped 2D model goes: PSD → the maker, everything else (pictures, GIFs, Live2D, Inochi2D) → the 2D importer. */
export function twoDImporter(app: App): (files: File[]) => void {
  return (files) => {
    if (!files.some((f) => /\.(psd|psb)$/i.test(f.name))) { openFlatImport(app, files); return; }
    void import('../rig2dEditor/studio.ts').then((m) => m.routeLayeredArt(app, (fs) => openFlatImport(app, fs))(files))
      .catch(() => toast('The 2D avatar maker didn’t open. Reload the page and try again.', 'warn', 6000));
  };
}

// ---------------------------------------------------------------- a small card above the dock (one at a time)
const CSS = `
.lw-card { position: fixed; left: 50%; transform: translateX(-50%); z-index: 70; width: min(460px, calc(100vw - 16px)); max-height: min(72vh, calc(100vh - 140px));
  display: grid; grid-template-rows: auto minmax(0, 1fr); background: var(--panel); color: var(--text); border: 1px solid var(--line2); border-radius: 14px;
  box-shadow: 0 24px 60px -20px #000c; overflow: hidden; font-size: 13.5px; }
.lw-card > header { display: flex; align-items: center; gap: 10px; padding: 10px 10px 10px 16px; border-bottom: 1px solid var(--line); }
.lw-card > header > span { flex: 1; min-width: 0; display: grid; }
.lw-card > header b { font-size: 15px; }
.lw-card > header small { color: var(--dim); font-size: 12px; }
.lw-card .lw-x { flex: none; width: 34px; height: 34px; display: grid; place-items: center; border-radius: 9px; border: 1px solid var(--line2); background: var(--card2); color: var(--text); cursor: pointer; }
.lw-card .lw-body { overflow: auto; overscroll-behavior: contain; padding: 12px 16px 16px; }
body.clean .lw-card { display: none; }
`;
let closeCard: (() => void) | null = null;
function dockCard(title: string, sub: string, mount: (el: HTMLElement) => (() => void) | void, ui: string, width = 460) {
  closeCard?.();
  if (!document.getElementById('vtp-lw-css')) document.head.append(h('style', { id: 'vtp-lw-css' }, CSS));
  const body = h('div', { class: 'lw-body' });
  const card = h('div', { class: 'lw-card', role: 'dialog', 'aria-label': title, 'data-ui': ui, style: `width:min(${width}px, calc(100vw - 16px))` },
    h('header', null, h('span', null, h('b', null, title), sub ? h('small', null, sub) : null),
      h('button', { type: 'button', class: 'lw-x', 'aria-label': 'Close', title: 'Close (Esc)', onClick: () => close() }, icon('x', 16))),
    body);
  const place = () => {
    const d = document.getElementById('showdock'), r = d && d.offsetParent ? d.getBoundingClientRect() : null;
    card.style.bottom = `${Math.round(r ? innerHeight - r.top + 8 : 16)}px`;
  };
  const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); } };
  let unmount: (() => void) | void;
  const close = () => {
    if (closeCard !== close) return;
    closeCard = null;
    window.removeEventListener('keydown', onKey, true); window.removeEventListener('resize', place);
    try { unmount?.(); } catch { /* already gone */ }
    card.remove();
  };
  closeCard = close;
  document.body.append(card);
  place();
  window.addEventListener('keydown', onKey, true); window.addEventListener('resize', place);
  unmount = mount(body);
  return close;
}

const inRoom = (app: App) => !!app.scene.state.sceneId;

let mounted = false;
export function mountLaneWiring(app: App) {
  if (mounted) return;
  mounted = true;
  void import('./mouthStyle.ts').then((m) => m.installMouthStyle(app)).catch(() => { /* optional */ }); // lip sync lane: cartoon mouth suggestion + Me → Mouth style

  // ---- 2D hand-off from "drop a model anywhere"
  void import('./dropImport.ts').then((m) => m.setTwoDImporter(twoDImporter(app)));
  // ---- DJ sync (beta.13): once MIDI was allowed, the controller keeps reaching the helper from studio start (src/ui/djSyncPanel.ts)
  void import('./djSyncPanel.ts').then((m) => m.djSyncBoot(app)).catch(() => {});

  // ---- show dock: Room
  registerDockEntry({
    id: 'room-edit', menu: 'room', icon: 'edit', order: 10, label: 'Edit this room',
    hint: 'Move cameras, places, the React screen and chat, and add props. Nothing changes on stream until you Save.',
    when: (a) => inRoom(a) && a.scene.canEdit,
    run: (a) => { const id = a.scene.state.sceneId; if (id) openRoomEditor(id, { onClose: (saved) => { if (saved) void a.scene.refreshScenes(); } }); },
  });
  registerDockEntry({
    id: 'room-camera', menu: 'room', icon: 'camera', order: 20, label: 'Adjust this camera',
    hint: 'Nudge the angle on air now: direction, tilt, distance, height, zoom. Remembered for this shot.',
    when: (a) => inRoom(a) && a.scene.canEdit,
    run: (a) => { void import('./cameraTweaks.ts').then((m) => dockCard('Adjust this camera', 'Moves the camera that is on air now. Remembered for this shot.', (el) => m.mountCameraTweaks(el, a), 'dock-camera-tweaks')); },
  });
  registerDockEntry({
    id: 'room-seats', menu: 'room', icon: 'seat', order: 30, label: 'Seating chart',
    hint: 'Who sits where: drag a person onto a place.',
    when: (a) => inRoom(a) && a.scene.canEdit,
    run: (a) => { void import('./seatingChart.ts').then((m) => dockCard('Seating chart', 'Drag a person onto a place, or tap the person, then the place.', (el) => m.mountSeatingChart(el, a), 'dock-seating', 760)); },
  });

  // ---- show dock: Me
  registerDockEntry({
    id: 'me-2d', menu: 'me', icon: 'me', order: 10, label: '2D avatar options',
    hint: 'How your 2D avatar shows, when it talks, its expressions.',
    when: (a) => !!a.runtime?.flat,
    run: (a) => {
      dockCard('2D avatar', a.profile?.name ?? '', (el) => {
        const fill = () => { if (!a.runtime?.flat) { closeCard?.(); return; } el.replaceChildren(flatPanel(a)); };
        fill();
        // the options depend on the avatar (and on its display mode): rebuild after each change
        return a.on((w) => { if (w === 'avatar') fill(); });
      }, 'dock-2d-avatar');
    },
  });
  registerDockEntry({
    id: 'me-make-2d', menu: 'me', icon: 'wand', order: 20, label: 'Create a 2D avatar',
    hint: 'From your drawing (a layered PSD) or pictures: it moves with your face.',
    run: (a) => openAvatarMakerLazy(a),
  });

  // ---- Tools menu
  registerTool({
    id: 'avatar-maker', icon: 'wand', title: 'Create a 2D avatar', short: 'From your drawing',
    line: 'Turn a layered drawing (PSD) or pictures into a 2D avatar that moves with your face.',
    run: () => openAvatarMakerLazy(app),
  });
  registerSupportTool(app); // beta.13: Support & store (tips, merch, patrons, wishlists: src/ui/supportPanel.ts)
}
