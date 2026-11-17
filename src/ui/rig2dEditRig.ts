// "Edit rig" buttons in the studio (the maker side is src/rig2dEditor/editRig.ts, loaded only when pressed):
//   editRigBlock(app, doc)        the 2D model block (src/ui/rig2dPanel.ts, one line): "Edit rig in the 2D avatar maker"
//                                 + "Undo my last edit" once there is a backup; an imported model (converted, or a rig
//                                 from elsewhere) also gets one plain sentence: the maker edits a copy, saving makes it
//                                 a maker avatar, and undo brings the imported model back. A model whose author
//                                 doesn't allow changes says so instead, and its Edit button stays off.
//   editRigCardButton(app, p)     a small "Edit rig" on 2D-rig entries of the Avatars grid (src/ui/panels.ts, one line).
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import type { Rig2DDoc } from '../../shared/rig2d/format.ts';
import { RIG_NO_CHANGES, rigEditKind, rigEditWhy, rigNoChanges } from '../../shared/rig2d/rigEdit.ts';
import { h, toast } from './dom.ts';

const editRig = () => import('../rig2dEditor/editRig.ts');
const failed = () => toast('The 2D avatar maker didn’t open. Reload the page and try again.', 'warn', 6000);

/** For the 2D model block of the avatar on now. */
export function editRigBlock(app: App, doc: Rig2DDoc): HTMLElement {
  const id = app.profile?.id ?? '';
  const kind = rigEditKind(doc), locked = rigNoChanges(doc.meta);
  // (a saved edit leaves a backup and bumps flat.opts.rigRev: no request on render, an older version is never asked)
  const edited = Number((app.profile?.flat?.opts as { rigRev?: unknown } | undefined)?.rigRev) > 0;
  const undo = h('button', { class: 'btn', 'data-ui': 'rig2d-undo', hidden: !edited, title: 'Swap back to the rig you had before your last save in the maker (press again to redo)',
    onClick: async () => { undo.disabled = true; try { await (await editRig()).undoRigEdit(app, id); } catch { failed(); } finally { undo.disabled = false; } } }, 'Undo my last edit');
  const edit = h('button', { class: 'btn', 'data-ui': 'rig2d-edit', disabled: locked, title: locked ? RIG_NO_CHANGES : 'Open this avatar in the 2D avatar maker: change its parts, bones, sliders, limits and swing, then save it back',
    onClick: async () => { edit.disabled = true; try { await (await editRig()).openEditRig(app, id); } catch { failed(); } finally { edit.disabled = false; } } }, 'Edit rig in the 2D avatar maker');
  const btns = h('div', { class: 'btns', 'data-ui': 'rig2d-editrig' }, edit, undo);
  if (kind === 'maker' && !locked) return btns;
  return h('div', null, h('p', { class: 'note', 'data-ui': 'rig2d-edit-why' }, locked ? RIG_NO_CHANGES : rigEditWhy(kind, doc.meta.source?.kind)), btns);
}

/** A small "Edit rig" for a 2D rig's card in the Avatars grid (null for everything else). */
export function editRigCardButton(app: App, p: AvatarProfile): HTMLElement | null {
  if (p.flat?.kind !== 'rig2d' || p.source === 'builtin-test') return null;
  return h('button', { class: 'x', 'data-ui': 'rig2d-card-edit', title: 'Edit rig in the 2D avatar maker', 'aria-label': `Edit the rig of ${p.name}`, style: 'display:block;right:auto;left:4px',
    onClick: (e: Event) => { e.stopPropagation(); void editRig().then((m) => m.openEditRig(app, p.id)).catch(failed); } }, '✎');
}
