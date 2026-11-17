// beta.16 "items" lane entry (docs/b16/LANES.md): stickers, hats and held props on the avatar, and item scenes (docs/b16/ITEMS.md).
//
// studio  → the StudioEngine (store, drop zone on the preview, selection frame, rule actions `sticker` + `item-scene`) and the
//           "Stickers & items" panel under Live > Stream extras.
// output  → the OutputEngine: replays what the studio sends onto the host's avatar.
//
// Nothing here runs per frame or per timer while no item is on: a mount only subscribes and registers; the panel and the drop
// zone's listeners do nothing until a file is dragged or the panel is opened.
import type { B16Ctx } from '../../b16/mount.ts';
import { registerB16Panel } from '../../b16/panels.ts';

export async function mount(ctx: B16Ctx): Promise<() => void> {
  if (ctx.role === 'output') {
    const { OutputEngine } = await import('./engine.ts');
    const eng = new OutputEngine(ctx.bus);
    (window as unknown as { vtpItemsOut?: unknown }).vtpItemsOut = eng;
    return () => eng.dispose();
  }
  if (!ctx.app) return () => {};
  const { StudioEngine } = await import('./engine.ts');
  const { mountItemsPanel, releaseThumbs } = await import('../../ui/itemsPanel.ts');
  const eng = new StudioEngine({ ...ctx, app: ctx.app });
  (window as unknown as { vtpItems?: unknown }).vtpItems = eng;
  const off = registerB16Panel({
    id: 'items', title: 'Stickers & items', lane: 'items', simple: true, order: 20,
    blurb: 'Put a picture or a small 3D model on your avatar. It follows you. Save sets and switch them on from a key or a redeem.',
    mount: (host) => mountItemsPanel(host, eng),
  });
  return () => { off(); eng.dispose(); releaseThumbs(); };
}
