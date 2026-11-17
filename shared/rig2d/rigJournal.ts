// "Edit rig": how a save or an undo replaces an avatar's rig file, as a small journal, so every crash point is known and
// the next operation finishes what a crash left. One engine for the helper (server/rigEdit.ts, files + renames) and the
// a browser-only store (the browser's own storage). It can be crashed at
// every step of save, undo and recovery.
//
// Files (relative to the avatar's folder): the rig `main`, its one backup `.backup/<main>`, and while an operation runs
// `.backup/.next` (the rig to show), `.backup/.prev` (the rig on show, to become the backup) and `.backup/.journal`
// ({ op, rev0, rotate }: written once both are staged; it is the commit point).
//
//   publish:  1. stage .next (the new rig; undo: the backup)      ─┐ before the journal: nothing shown changed; a crash
//             2. stage .prev = a copy of main (when rotating)     ─┘ leaves only staging copies, which are dropped
//             3. write .journal                                   ← commit
//             4. .next → main      5. .prev → backup             ─┐ after the journal: the next operation rolls these
//             6. rigRev + 1 (only if still rev0)                  │ forward (each step is a no-op once done)
//             7. remove .journal                                 ─┘
//
// At every point both the rig on show before the operation and the one it shows after it exist as a whole file (main,
// backup, .next or .prev): renames and writes replace a file whole (the helper: temp + rename; the browser stores: a
// file written whole on close). Undo is a publish of the backup with rotation: main and backup swap.
//
// Retries (the studio got an error and the performer presses the same button again):
//   * undo, after recovery finished an undo: that WAS this undo (no second swap);
//   * save of the very rig on show already: nothing more to do (it had gone through);
//   * save, after recovery finished a save the profile had not announced yet (its rigRev bump was still missing): the
//     performer was told it failed, so the backup stays the rig from before it. Otherwise (it was announced, and this
//     is a different rig) the usual one-step rotation: the announced rig becomes the backup.

/** The folder as the engine sees it. A READ THAT FAILS MUST THROW: null / false mean "the file is not there", and the
 *  engine acts on that (a locked or unreadable file taken for a missing one could drop the only copy of a rig). */
export interface RigFs {
  /** the file's bytes; null only when it does not exist; throws when it can't be read */
  read(rel: string): Promise<Uint8Array | null>;
  /** replace `rel` whole with `data` */
  write(rel: string, data: Uint8Array): Promise<void>;
  /** `to` replaced whole by `from`; `from` is gone afterwards */
  move(from: string, to: string): Promise<void>;
  remove(rel: string): Promise<void>;
  /** false only when it does not exist; throws when that can't be told */
  exists(rel: string): Promise<boolean>;
  /** drop temp files of writes a crash cut off (optional) */
  clean?(): Promise<void>;
}
export interface RigRev {
  /** the profile's flat.opts.rigRev now (throws when the profile can't be read: never a guessed 0) */
  rev(): number | Promise<number>;
  /** rigRev + 1 on the profile as it is now (every page reloads the model) */
  bump(): Promise<unknown>;
}
export interface RigPaths { main: string; bak: string; next: string; prev: string; journal: string }
export const rigPaths = (main: string, bak: string): RigPaths => ({ main, bak, next: '.backup/.next', prev: '.backup/.prev', journal: '.backup/.journal' });

/** `main` / `bak`: the files it was for (a later change of the avatar's main file name never redirects a roll-forward) */
interface Journal { op: 'save' | 'undo'; rev0: number; rotate: boolean; main?: string; bak?: string }
export interface Recovered { op: 'save' | 'undo'; /** the rigRev bump was still missing (the studio was told it failed) */ unannounced: boolean }

const same = (a: Uint8Array | null, b: Uint8Array | null) => !!a && !!b && a.length === b.length && a.every((v, i) => v === b[i]);

/** Finish (or drop) what a crash left. Returns what it finished, or null when there was nothing committed. */
export async function recoverRig(fs: RigFs, P: RigPaths, rv: RigRev): Promise<Recovered | null> {
  let j: Journal | null = null;
  const raw = await fs.read(P.journal);
  if (raw) { try { j = JSON.parse(new TextDecoder().decode(raw)) as Journal; } catch { j = null; } }
  if (!j || (j.op !== 'save' && j.op !== 'undo') || !Number.isFinite(j.rev0)) {
    // not committed: main and backup were never touched; the staged copies go
    if (await fs.exists(P.next)) await fs.remove(P.next);
    if (await fs.exists(P.prev)) await fs.remove(P.prev);
    if (raw) await fs.remove(P.journal);
    await fs.clean?.();
    return null;
  }
  const main = typeof j.main === 'string' && j.main ? j.main : P.main, bak = typeof j.bak === 'string' && j.bak ? j.bak : P.bak;
  if (await fs.exists(P.next)) await fs.move(P.next, main);
  if (await fs.exists(P.prev)) await fs.move(P.prev, bak);
  const unannounced = (await rv.rev()) === j.rev0;
  if (unannounced) await rv.bump();
  await fs.remove(P.journal);
  await fs.clean?.();
  return { op: j.op, unannounced };
}

/** Show `next` (stage it with `stage` when the caller already has it as a file, else it is written) and, with `rotate`,
 *  make the rig on show the backup. Run recoverRig first (under the same per-avatar lock). */
export async function publishRig(fs: RigFs, P: RigPaths, rv: RigRev, op: 'save' | 'undo', next: Uint8Array | ((nextRel: string) => Promise<void>), rotate: boolean): Promise<void> {
  if (typeof next === 'function') await next(P.next); else await fs.write(P.next, next);
  let rot = false;
  // (read null = the main file really is not there; a failed read throws before the commit, nothing shown changed)
  if (rotate) { const cur = await fs.read(P.main); if (cur) { await fs.write(P.prev, cur); rot = true; } else if (await fs.exists(P.main)) throw new Error('The rig on show could not be read.'); }
  const j: Journal = { op, rev0: await rv.rev(), rotate: rot, main: P.main, bak: P.bak };
  await fs.write(P.journal, new TextEncoder().encode(JSON.stringify(j)));
  await fs.move(P.next, P.main);
  if (rot) await fs.move(P.prev, P.bak);
  if ((await rv.rev()) === j.rev0) await rv.bump();
  await fs.remove(P.journal);
}

/** Save: is there anything left to do? (No when this very rig is on show already: the retry of a save that had in fact
 *  gone through — finished by the recovery, or finished with only its answer lost. Rotating then would make the rig on
 *  show its own backup and drop the one before.) */
export async function saveNeeded(fs: RigFs, P: RigPaths, _rec: Recovered | null, next: Uint8Array): Promise<boolean> {
  return !same(await fs.read(P.main), next);
}

/** Save: should the rig on show become the backup? (No after an unannounced recovered save, or an identical retry.) */
export async function saveRotates(fs: RigFs, P: RigPaths, rec: Recovered | null, next: Uint8Array): Promise<boolean> {
  if (rec?.op !== 'save') return true;
  if (rec.unannounced) return false;
  return !same(await fs.read(P.main), next);
}
