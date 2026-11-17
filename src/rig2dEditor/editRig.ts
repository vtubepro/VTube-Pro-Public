// "Edit rig": the 2D avatar maker opened on a library avatar's own saved rig (its layers, bones, sliders, limits, swing
// and expressions as they are), and "Save to my avatar" writing it back over the SAME avatar (PUT /api/avatars/:id/rig:
// server/rigEdit.ts). The avatar keeps its id and every
// studio setting; the old file stays as one backup ("Undo my last edit"). An imported model (converted, or made
// elsewhere) opens as an editable copy and its first save makes it a maker avatar; until the next save, "Undo my last
// edit" brings the imported model back (a model whose author doesn't allow changes never opens). Nothing reaches the stream while you edit:
// the maker draws its own preview; on save every page (studio, OBS) reloads the model once.
// Loaded only when someone presses Edit rig (src/ui/rig2dEditRig.ts).
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { normalizeProfile } from '../../shared/defaults.ts';
import { RIG2D } from '../../shared/rig2d/format.ts';
import { RIG_NO_CHANGES, RIG_UNREADABLE, rigEditGate, rigMainOf, storedRigKind, type RigStatus } from '../../shared/rig2d/rigEdit.ts';
import { browserInflateRaw } from '../../shared/rig2d/container.ts';
import { api } from '../api.ts';
import { toast } from '../ui/dom.ts';
import { openRig2DEditor, type Rig2DEditorHandle } from './editor.ts';

let open: Rig2DEditorHandle | null = null;

/** The helper's answer as one sentence (its own error, or a plain fallback). */
async function why(r: Response, fallback: string): Promise<string> {
  try { const j = await r.json() as { error?: string }; if (j?.error) return j.error; } catch { /* not json */ }
  return fallback;
}

/** A picture as a PNG (the thumbnail route takes only PNGs), or null when it can't be drawn. */
async function asPng(b: Blob): Promise<Blob | null> {
  const head = new Uint8Array(await b.slice(0, 4).arrayBuffer());
  if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47) return b;
  try {
    const bm = await createImageBitmap(b), c = new OffscreenCanvas(bm.width, bm.height);
    c.getContext('2d')?.drawImage(bm, 0, 0); bm.close();
    return await c.convertToBlob({ type: 'image/png' });
  } catch { return null; }
}

export type { RigStatus };
/** GET /api/avatars/:id/rig: what Edit rig can do (null = can't tell: offline, a network error). */
export async function rigStatusOf(id: string): Promise<RigStatus | { error: string } | null> {
  try {
    const r = await fetch(`/api/avatars/${encodeURIComponent(id)}/rig`);
    if (r.ok) return await r.json() as RigStatus;
    return { error: await why(r, 'The rig of this avatar can’t be read right now.') };
  } catch { return null; }
}

/** Open the maker on avatar `id`'s rig. Resolves once it is open (or a sentence was shown instead). */
export async function openEditRig(app: App, id: string): Promise<Rig2DEditorHandle | null> {
  if (open) return open;
  let p: AvatarProfile;
  try { p = normalizeProfile(await api.avatar(id)); } catch { toast('This avatar can’t be found any more.', 'warn'); return null; }
  const mm = rigMainOf(p);
  if ('error' in mm) { toast(mm.error, 'warn'); return null; }
  // an older version (no rig routes yet, or a beta.14 one that refuses to save over an imported model): the maker still
  // opens the file it serves; saving into the library waits for the helper's update ("Save .vtp2" keeps the changes as a
  // file meanwhile). Decided BEFORE anyone edits, never after a refused save
  const gate = rigEditGate(await rigStatusOf(id));
  if ('stop' in gate) { toast(gate.stop, 'warn', 7000); return null; }
  let bytes: Uint8Array;
  try {
    const r = await fetch(api.pathUrl(id, mm.main), { cache: 'no-cache' });
    if (!r.ok) throw new Error(String(r.status));
    bytes = new Uint8Array(await r.arrayBuffer());
  } catch { toast('The rig file of this avatar can’t be read right now. Try again in a moment.', 'warn'); return null; }
  // (the file itself says what it is: also when the helper could not. One whose rig.json can't be read is left alone,
  // so is one whose author doesn't allow changes; an imported model opens as an editable copy)
  const k = await storedRigKind(bytes, browserInflateRaw);
  if (!k) { toast(RIG_UNREADABLE, 'info', 8000); return null; }
  if (k.locked) { toast(RIG_NO_CHANGES, 'warn', 7000); return null; }
  const file = new File([bytes as BlobPart], `${p.name.replace(/[\\/:*?"<>|]+/g, '_') || 'avatar'}${RIG2D.ext}`);
  bytes = new Uint8Array(0);
  open = openRig2DEditor({
    files: [file],
    getFrame: () => (app.frame && app.frame.t ? app.frame : null),
    useLabel: 'Save to my avatar',
    ...(gate.blocked ? { useBlocked: gate.blocked } : {}),
    onUse: async (rig, _name, thumb) => {
      if (app.observer) { open?.notify('Observer sandbox: saving is off here. Use "Save .vtp2" to keep a copy.', true); return false; }
      open?.notify('Saving…');
      // the new look for the library goes BEFORE the rig (as in beta.14): a picture-only save is applied in place on the
      // OBS page, then the rig's save reloads it once. After the rig, its 'profile' broadcast landed mid-build and OBS
      // built the avatar twice (14.1 release review). A refused save puts the old picture back (as a PNG: the thumbnail
      // route takes only PNGs; an avatar that had no picture keeps the new one)
      let oldThumb: Blob | null = null;
      if (thumb.length) {
        if (p.thumbnail) oldThumb = await fetch(api.pathUrl(id, p.thumbnail), { cache: 'no-cache' }).then((x) => (x.ok ? x.blob() : null)).then((b) => (b ? asPng(b) : null)).catch(() => null);
        await api.thumbnail(id, new Blob([thumb as BlobPart], { type: 'image/png' })).catch(() => undefined);
      }
      const putBack = async () => { if (oldThumb) await api.thumbnail(id, oldThumb).catch(() => undefined); };
      let r: Response;
      try { r = await fetch(`/api/avatars/${encodeURIComponent(id)}/rig`, { method: 'PUT', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([rig as BlobPart]) }); }
      catch { await putBack(); open?.notify('Could not save: VTube Pro is not answering. Your changes are still here: try again, or press "Save .vtp2" to keep a copy.', true); return false; }
      if (!r.ok) {
        await putBack();
        const msg = await why(r, 'Could not save.');
        open?.notify(`${msg} Your changes are still here; "Save .vtp2" keeps a copy.`, true);
        return false;
      }
      const j = await r.json().catch(() => ({})) as { profile?: AvatarProfile };
      // the studio shows the new rig now (OBS reloads once from the helper's 'profile' broadcast)
      if (app.profile?.id === id) await showSaved(app, id, (j.profile?.flat?.opts as { rigRev?: unknown } | undefined)?.rigRev);
      app.emit('library');
      toast(`${j.profile?.name ?? p.name} is saved. "Undo my last edit" in the 2D model settings brings the old rig back.`, 'ok', 6000);
      open?.dispose();
      return true;
    },
    onClose: () => { open = null; },
  });
  return open;
}

/** Reload the avatar on show until it is the saved rig (rigRev): a load that was already running (another save's
 *  broadcast) may have read the profile before the rig landed, and loadAvatar skips a request while one runs. */
async function showSaved(app: App, id: string, rev: unknown) {
  const cur = () => (app.profile?.flat?.opts as { rigRev?: unknown } | undefined)?.rigRev;
  for (let i = 0; i < 40 && app.profile?.id === id; i++) {
    await app.loadAvatar(id, true);
    if (rev === undefined || cur() === rev) return;
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** "Undo my last edit": the backup and the current rig swap places (pressed again, the edit comes back). */
export async function undoRigEdit(app: App, id: string): Promise<boolean> {
  try {
    const r = await fetch(`/api/avatars/${encodeURIComponent(id)}/rig/undo`, { method: 'POST' });
    if (!r.ok) { toast(await why(r, 'The earlier rig could not be brought back.'), 'warn', 7000); return false; }
    const j = await r.json().catch(() => ({})) as { profile?: AvatarProfile };
    if (app.profile?.id === id) await showSaved(app, id, (j.profile?.flat?.opts as { rigRev?: unknown } | undefined)?.rigRev);
  } catch { toast('VTube Pro is not answering. Try again in a moment.', 'warn'); return false; }
  app.emit('library');
  toast('Back to the rig before your last edit. Press "Undo my last edit" again to bring the edit back.', 'ok', 6000);
  return true;
}
