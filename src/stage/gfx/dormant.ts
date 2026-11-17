// A post pipeline that is no longer drawn keeps its full-size render targets (HalfFloat MSAA scene, glow, bloom, AO...:
// 150-500 MB at 1080p-4K). This timer says when to hand them back: DORMANT_S seconds after the LAST pipeline switch (a
// quick step back up finds the targets still there, no re-allocation). Pure: tools/dormant_unit.ts.
export const DORMANT_S = 30;

export class DormantTimer {
  private left = 0;
  /** The drawn pipeline changed (or a room was bound): start counting again. */
  arm() { this.left = DORMANT_S; }
  /** Once per frame; true exactly once, when the time is up. */
  tick(dt: number): boolean {
    if (this.left <= 0) return false;
    this.left -= Math.max(0, Math.min(dt, 1));   // (a stalled frame counts for at most a second)
    if (this.left > 0) return false;
    this.left = 0;
    return true;
  }
  get armed() { return this.left > 0; }
}
