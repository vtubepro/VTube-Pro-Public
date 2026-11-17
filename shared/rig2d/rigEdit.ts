// "Edit rig": open a 2D avatar from the library in the 2D avatar maker and save it back over the SAME library avatar.
// The rules both the helper (server/rigEdit.ts: PUT /api/avatars/:id/rig, POST …/rig/undo, GET …/rig) and the web
// studio without a server follow:
//   * a rig made in the maker opens with its project (editor/project.json); an imported model (converted, or made
//     elsewhere) opens as an editable copy (shared/rig2d/edit/adopt.ts), and its first save makes it a maker rig; one
//     whose author doesn't allow changes (meta.rights.modification false) is never opened or saved over;
//   * the saved file is checked like an import (a valid .vtp2 with the maker's project, honest pictures); a stored
//     rig whose rig.json can't be read is never overwritten;
//   * the previous file is kept as ONE backup (<avatar>/.backup/<main>, a dot folder: never in party bundles, never
//     served), so "Undo my last edit" swaps it back (pressed again, it swaps forward) — after the first save of an
//     imported model that backup IS the imported model, so undo brings it back exactly as it was;
//   * the profile keeps every studio setting (flat.opts: gains, part strengths, key bindings, expression keys, sliders);
//     only flat.opts.rigRev goes up, which makes every page (studio, OBS) reload the model ONCE (it is not a live option).
import type { AvatarProfile } from '../types.ts';
import { RIG2D, RIG2D_LIMITS, rig2dForStorage, validateRig2D, type BufferView, type Rig2DDoc } from './format.ts';
import { BufferBuilder, readVtp2, viewArray, zipEntries, zipRead, zipStore, type InflateRaw, type ZipEntryIn } from './container.ts';
import { rigRevOf } from './rigRev.ts';
import { IMPORT_LIMITS } from './limits.ts';

export const RIG_BACKUP_DIR = '.backup';
/** Where the one backup of an avatar's rig lives, relative to its folder. */
export const rigBackupRel = (main: string) => `${RIG_BACKUP_DIR}/${main.split('/').pop() || `model${RIG2D.ext}`}`;
/** meta.source.converter of rigs the 2D avatar maker writes (shared/rig2d/edit/vtp2.ts buildRig). */
export const MAKER_CONVERTER = 'VTube Pro rig editor';
/** The maker's project inside its rigs (= shared/rig2d/edit/vtp2.ts PROJECT_ENTRY; not imported: that module is big). */
export const MAKER_PROJECT = 'editor/project.json';

export type RigEditKind = 'maker' | 'converted' | 'other';
/** What the maker can do with a rig, from its manifest's meta. */
export function rigEditKind(doc: { meta?: { source?: { kind?: string; converter?: string } } } | null | undefined): RigEditKind {
  const s = doc?.meta?.source;
  if (s?.kind === 'live2d' || s?.kind === 'inochi2d') return 'converted';
  return s?.kind === 'native' && s.converter === MAKER_CONVERTER ? 'maker' : 'other';
}
/** One plain sentence about editing an imported model (one not made in the 2D avatar maker) in the maker. */
export function rigEditWhy(kind: RigEditKind, _from?: string): string {
  void _from;
  if (kind === 'maker') return '';
  return 'This is an imported model. The 2D avatar maker opens an editable copy of it, and saving makes it a maker avatar. Until you save a second time, "Undo my last edit" brings the imported model back.';
}
type RigMeta = { source?: { kind?: string; file?: string; converter?: string }; rights?: { modification?: boolean } } | null | undefined;
/** The sentence for a model whose author doesn't allow changes (meta.rights.modification false): the maker never opens
 *  it and Edit rig never saves over it (the same rule and words as "Make a 3D version": server/to3d/routes.ts). */
export const RIG_NO_CHANGES = 'This model\'s terms don\'t allow changes. Ask its artist.';
/** Does the author of this model forbid changes? */
export const rigNoChanges = (meta: RigMeta): boolean => meta?.rights?.modification === false;
/** Was this model converted from Live2D, also after it was saved in the maker? A save makes meta.source.kind 'native'
 *  but keeps the .model3.json name it came from (carryRigFields, buildRig). Live2D's sample-model notes depend on it. */
export const wasLive2D = (meta: RigMeta): boolean => meta?.source?.kind === 'live2d' || /\.model3\.json$/i.test(meta?.source?.file ?? '');

/** The avatar's rig file (profile.flat.main), or an error sentence. */
export function rigMainOf(p: Partial<AvatarProfile> | null | undefined): { main: string } | { error: string } {
  const f = p?.flat;
  if (!f || f.kind !== 'rig2d') return { error: 'This avatar is not a 2D rig, so there is no rig to edit.' };
  if (typeof f.main !== 'string' || !f.main.toLowerCase().endsWith(RIG2D.ext) || f.main.includes('..')) return { error: 'This 2D avatar has no rig file to edit.' };
  return { main: f.main };
}

/** The kind of a stored rig from its bytes (reads only rig.json; null = not a readable rig). `locked` = its author
 *  doesn't allow changes (rigNoChanges). */
export async function storedRigKind(bytes: Uint8Array, inflate?: InflateRaw): Promise<{ kind: RigEditKind; from?: string; locked?: true } | null> {
  try {
    const e = zipEntries(bytes).find((x) => x.name === RIG2D.manifest);
    if (!e) return null;
    const doc = JSON.parse(new TextDecoder().decode(await zipRead(bytes, e, inflate, 64 << 20))) as { meta?: NonNullable<RigMeta> };
    return { kind: rigEditKind(doc), from: doc?.meta?.source?.kind, ...(rigNoChanges(doc?.meta) ? { locked: true as const } : {}) };
  } catch { return null; }
}

export interface RigSaveCheck { ok: true }
export interface RigSaveFail { ok: false; status: number; error: string }
/** The sentence for a stored rig that can't be read at all: it is never overwritten (it may be a converted model). */
export const RIG_UNREADABLE = 'The rig file of this avatar can’t be read, so it isn’t changed here. Your avatar is as it was.';
/** The sentence for a save of an avatar while another save of it is still running. */
export const RIG_BUSY = 'This avatar is being saved right now. Wait a moment, then press Save again.';

// ---------------------------------------------------------------- GET …/rig, and what the studio makes of it
/** GET /api/avatars/:id/rig's answer. `adopt` = an edited imported model may be saved over it; `locked` = its author
 *  doesn't allow changes (`why`). */
export interface RigStatus { kind: RigEditKind; backup: boolean; adopt?: boolean; locked?: boolean; why?: string }
/** The answer for a stored rig (storedRigKind's; null = unreadable) with or without a backup. */
export function rigEditStatus(k: Awaited<ReturnType<typeof storedRigKind>>, backup: boolean): RigStatus {
  const kind = k?.kind ?? 'other';
  if (k?.locked) return { kind, backup, adopt: true, locked: true, why: RIG_NO_CHANGES };
  return { kind, backup, adopt: true, ...(kind !== 'maker' ? { why: rigEditWhy(kind, k?.from) } : {}) };
}
/** Before the maker opens on a library avatar, from GET …/rig's answer (null = none: offline, a network error):
 *  `stop` = don't open, show this sentence. */
export function rigEditGate(st: RigStatus | { error: string } | null): { stop: string } | { blocked: string | null } {
  if (st && 'error' in st) return { stop: st.error };
  if (st?.locked) return { stop: st.why || RIG_NO_CHANGES };
  return { blocked: null };
}

/** Is `bytes` a rig the maker made, fit to replace this avatar's rig (`current` = the stored file's bytes, if any)?
 *  The stored rig must itself be readable (a file whose rig.json can't be read is never overwritten); it may be the
 *  maker's or an imported model (the save turns that into a maker rig, and the imported one becomes the backup), but
 *  never one whose author doesn't allow changes. `restore` = "Undo my last edit" putting the backup back: the backup
 *  may be the imported model itself, so it only has to be a valid rig. `pictures` = a picture check (throws a sentence). */
export async function checkRigSave(bytes: Uint8Array, current: Uint8Array | null, o: { inflate?: InflateRaw; pictures?: (entries: { name: string; data: Uint8Array }[]) => void | Promise<void>; restore?: boolean } = {}): Promise<RigSaveCheck | RigSaveFail> {
  if (!bytes.length) return { ok: false, status: 400, error: 'Nothing arrived to save. Press Save again.' };
  if (bytes.length > IMPORT_LIMITS.uploadBytes) return { ok: false, status: 413, error: 'This 2D avatar is too big to save.' };
  if (current) {
    const k = await storedRigKind(current, o.inflate);
    if (!k) return { ok: false, status: 409, error: RIG_UNREADABLE };
    if (k.locked && !o.restore) return { ok: false, status: 409, error: RIG_NO_CHANGES };
  }
  const r = await readVtp2(bytes, o.inflate);
  if (!r.ok) return { ok: false, status: 422, error: `The edited avatar could not be saved: ${r.error}` };
  if (o.restore) return { ok: true };
  if (rigEditKind(r.pkg.doc) !== 'maker') return { ok: false, status: 422, error: 'Only a 2D avatar from the 2D avatar maker can be saved here.' };
  try {
    if (!zipEntries(bytes).some((e) => e.name === MAKER_PROJECT)) return { ok: false, status: 422, error: 'The edited avatar is missing its maker project. Press Save again.' };
    await o.pictures?.([{ name: RIG2D.manifest, data: new TextEncoder().encode(JSON.stringify(rig2dForStorage(r.pkg.doc))) }, ...[...r.pkg.files].map(([name, data]) => ({ name, data }))]);
  } catch (e) { return { ok: false, status: 422, error: (e as Error).message || 'A picture in the edited avatar is damaged.' }; }
  return { ok: true };
}

/** The profile change a saved / undone rig makes, built from the profile as it is RIGHT NOW (read it with no await
 *  between the read and the save): everything kept, flat.opts.rigRev + 1, so every page reloads the model once. Profile
 *  saves never lower rigRev (shared/rig2d/rigRev.ts), so a save that raced this one can't undo the bump. */
export function rigSavedProfile(p: AvatarProfile): Partial<AvatarProfile> {
  const f = p.flat!;
  return { flat: { ...f, opts: { ...(f.opts ?? {}), rigRev: rigRevOf(p) + 1 } } };
}

// ---------------------------------------------------------------- what the maker does not keep
/** Carry over what a save from the maker would drop: the maker's project does not store motion clips (and their
 *  hotkeys), extra meta (meta.source keys, licence URL, rights), a state's motion, expression fade times or hit areas,
 *  so a rig that had them keeps them. `old` = the stored rig, `next` = the maker's new file. Each carried field must
 *  still fit the new rig (validated; one that doesn't is left out). Returns `next` itself when nothing is carried. */
export async function carryRigFields(old: Uint8Array, next: Uint8Array, inflate?: InflateRaw): Promise<Uint8Array> {
  const a = await readVtp2(old, inflate), b = await readVtp2(next, inflate);
  if (!a.ok || !b.ok) return next;
  const O = a.pkg.doc, base = b.pkg.doc;
  const doc = structuredClone(base) as Rig2DDoc;
  let carried = false;
  // meta: the old keys the new one lacks (the new name / authors / licence / notes win), meta.source the same way
  const meta = { ...O.meta, ...doc.meta, source: { ...(O.meta.source ?? {}), ...(doc.meta.source ?? {}) } } as Rig2DDoc['meta'];
  if (JSON.stringify(meta) !== JSON.stringify(doc.meta)) { doc.meta = meta; carried = true; }
  // expression fades (the maker writes its default) for expressions that are still there
  for (const e of doc.expressions ?? []) {
    const p = O.expressions?.find((x) => x.id === e.id);
    if (p && (p.fadeIn !== e.fadeIn || p.fadeOut !== e.fadeOut)) { e.fadeIn = p.fadeIn; e.fadeOut = p.fadeOut; carried = true; }
  }
  // motion clips (+ their keys): the maker has none of its own, so the old ones come along, their binary curves in a
  // buffer of their own
  let extra: Uint8Array | null = null;
  if (O.motions?.length && !doc.motions?.length) {
    const bb = new BufferBuilder(doc.buffers.length);
    const view = <T>(v: T): T => (v && typeof v === 'object' && !Array.isArray(v) ? bb.add(viewArray(a.pkg.buffers, v as unknown as BufferView), (v as unknown as BufferView).type) as unknown as T : v);
    doc.motions = O.motions.map((m) => ({ ...m, curves: m.curves.map((c) => ({ ...c, times: view(c.times), values: view(c.values), segments: view(c.segments), ...(c.controls !== undefined ? { controls: view(c.controls) } : {}) })) }));
    const bytes = bb.bytes();
    if (bytes.length) { extra = bytes; doc.buffers = [...doc.buffers, { file: `buffers/carried_${doc.buffers.length}.bin`, byteLength: bytes.length }]; }
    carried = true;
  }
  // a state's motion, and hit areas, when the new rig still has what they name
  for (const L of doc.states?.layers ?? []) {
    const OL = O.states?.layers.find((x) => x.id === L.id);
    for (const st of L.states) {
      const os = OL?.states.find((x) => x.id === st.id);
      if (os?.motion && !st.motion && doc.motions?.some((m) => m.id === os.motion)) { st.motion = os.motion; carried = true; }
    }
  }
  if (O.hitAreas?.length && !doc.hitAreas?.length) {
    const keep = O.hitAreas.filter((x) => doc.meshes.some((m) => m.id === x.mesh));
    if (keep.length) { doc.hitAreas = keep; carried = true; }
  }
  if (!carried) return next;
  const sizes = () => [...b.pkg.buffers, ...(extra ? [extra] : [])].map((x) => x.length);
  if (!validateRig2D(doc, sizes()).ok) {
    // something no longer fits: drop what names things (hit areas, then motions + state motions); keep plain values
    delete doc.hitAreas;
    if (!validateRig2D(doc, sizes()).ok && doc.motions && !base.motions) {
      delete doc.motions;
      if (extra) { doc.buffers = doc.buffers.slice(0, -1); extra = null; }
      for (const L of doc.states?.layers ?? []) for (const st of L.states) {
        const bs = base.states?.layers.find((x) => x.id === L.id)?.states.find((x) => x.id === st.id);
        if (!bs?.motion) delete st.motion;
      }
    }
    if (!validateRig2D(doc, sizes()).ok) return next;
  }
  // the new archive entry for entry (the maker's project too), with the merged rig.json (+ the carried buffer)
  const entries: ZipEntryIn[] = [];
  let head: ZipEntryIn | null = null;
  for (const e of zipEntries(next)) {
    if (e.name === RIG2D.manifest) continue;
    const data = await zipRead(next, e, inflate, RIG2D_LIMITS.totalBytes);
    if (e.name === 'mimetype') head = { name: e.name, data }; else entries.push({ name: e.name, data });
  }
  if (!head) return next;
  if (extra) entries.push({ name: doc.buffers[doc.buffers.length - 1].file, data: extra });
  return zipStore([head, { name: RIG2D.manifest, data: new TextEncoder().encode(JSON.stringify(rig2dForStorage(doc))) }, ...entries]);
}
