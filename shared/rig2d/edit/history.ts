// Undo / redo for the rig editor: whole-document snapshots (the document holds no pixels, so a snapshot is a few
// hundred KB at most), deduplicated, capped. A drag records ONE step: call begin() on pointer-down and commit() on
// pointer-up. Textures are append-only beside the document, so undo never needs to restore pixels. Pure (no DOM).
import type { EdDoc } from './doc.ts';

export class History {
  private undoStack: string[] = [];
  private redoStack: string[] = [];
  private pending: string | null = null;
  /** At most `max` steps and about `maxChars` characters of snapshots (big rigs keep fewer steps). */
  constructor(private max = 80, private maxChars = 40e6) {}

  private snap(d: EdDoc) { return JSON.stringify(d); }

  /** Remember the state before a change (call before mutating). */
  begin(d: EdDoc) { if (this.pending === null) this.pending = this.snap(d); }
  /** The change is done: keep the remembered state as one undo step (dropped if nothing changed). */
  commit(d: EdDoc) {
    if (this.pending === null) return;
    const before = this.pending;
    this.pending = null;
    if (before === this.snap(d)) return;
    this.undoStack.push(before);
    let total = this.undoStack.reduce((n, x) => n + x.length, 0);
    while (this.undoStack.length > 1 && (this.undoStack.length > this.max || total > this.maxChars)) total -= this.undoStack.shift()!.length;
    this.redoStack.length = 0;
  }
  /** begin + mutate + commit in one call. */
  change(d: EdDoc, fn: () => void) { this.begin(d); try { fn(); } finally { this.commit(d); } }
  cancel() { this.pending = null; }

  get canUndo() { return this.undoStack.length > 0; }
  get canRedo() { return this.redoStack.length > 0; }

  /** The previous document (a fresh object), or null. */
  undo(cur: EdDoc): EdDoc | null {
    const s = this.undoStack.pop();
    if (s === undefined) return null;
    this.redoStack.push(this.snap(cur));
    return JSON.parse(s) as EdDoc;
  }
  redo(cur: EdDoc): EdDoc | null {
    const s = this.redoStack.pop();
    if (s === undefined) return null;
    this.undoStack.push(this.snap(cur));
    return JSON.parse(s) as EdDoc;
  }
  clear() { this.undoStack.length = 0; this.redoStack.length = 0; this.pending = null; }
}
