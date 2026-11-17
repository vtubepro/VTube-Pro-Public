// The 2D avatar maker inside the studio: the entry points other lanes call (one line each, the UX lane decides where
// the buttons sit; the import lane routes dropped files).
//   openAvatarMaker(app, files?)        "Create a 2D avatar": the full-window maker. Its preview follows the studio's own
//                                        tracking ("My camera"); "Use this avatar" imports the .vtp2 into the library
//                                        (the 2D-avatar kind 'rig2d', the same path as a dropped .vtp2) and puts it on.
//   routeLayeredArt(files, otherwise)   for the import lane's 2D drop route (dropImport.ts setTwoDImporter): a layered
//                                        PSD opens the maker, anything else goes to `otherwise` (PNG sets, Live2D …).
import type { App } from '../app.ts';
import type { AvatarProfile } from '../../shared/types.ts';
import { toast } from '../ui/dom.ts';
import { openRig2DEditor, type Rig2DEditorHandle } from './editor.ts';
import { RIG2D } from '../../shared/rig2d/format.ts';

let open: Rig2DEditorHandle | null = null;

export function openAvatarMaker(app: App, files?: File[]): Rig2DEditorHandle {
  if (open) { if (files?.length) void open.open(files); return open; }
  open = openRig2DEditor({
    files,
    // the studio's live tracking frame (null until the camera / external tracking runs)
    getFrame: () => (app.frame && app.frame.t ? app.frame : null),
    onUse: async (bytes, name) => {
      if (app.observer) { open?.notify('Observer sandbox: imports are off here.', true); return; }
      const fileName = `${name.replace(/[\\/:*?"<>|]+/g, '_') || 'avatar'}${RIG2D.ext}`;
      const r = await fetch(`/api/avatars/import-flat?filename=${encodeURIComponent(fileName)}&name=${encodeURIComponent(name)}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: new Blob([bytes as BlobPart]) });
      const j = (await r.json().catch(() => ({}))) as { profile?: AvatarProfile; error?: string; warnings?: string[] };
      if (!r.ok || !j.profile) { open?.notify(`Could not add it to your library: ${j.error ?? `VTube Pro answered ${r.status}`}. Press "Save" to keep the file, then add it under Avatars.`, true); return; }
      await app.loadAvatar(j.profile.id);
      app.emit('library');
      toast(`${j.profile.name} is in your library and on. Open the maker again any time to change it.`, 'ok');
      open?.dispose(); // closes the overlay (its onClose clears `open`)
    },
    onClose: () => { open = null; },
  });
  return open;
}

/** For the 2D drop route: layered PSDs open the maker; everything else goes on to `otherwise`. */
export function routeLayeredArt(app: App, otherwise: ((files: File[]) => void) | null): (files: File[]) => void {
  return (files: File[]) => {
    if (files.some((f) => /\.(psd|psb)$/i.test(f.name))) { openAvatarMaker(app, files); return; }
    if (otherwise) otherwise(files);
    else toast('2D avatars: drop a layered PSD to make one, or add pictures under Avatars.', 'warn');
  };
}
