// A minimal layered PSD writer (8-bit RGB, RLE channels, folders, Unicode names): the procedural test character is
// saved as a real PSD so the importer is tested end to end, and the editor can hand a user's layers back to their
// paint program ("Export layers as PSD"). Pure (no DOM).
import type { ArtLayer } from './layers.ts';

class W {
  parts: Uint8Array[] = [];
  len = 0;
  u8(v: number) { this.raw(Uint8Array.of(v & 255)); }
  u16(v: number) { this.raw(Uint8Array.of((v >> 8) & 255, v & 255)); }
  i16(v: number) { this.u16(v & 0xffff); }
  u32(v: number) { this.raw(Uint8Array.of((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255)); }
  i32(v: number) { this.u32(v >>> 0); }
  str(s: string) { this.raw(Uint8Array.from(s, (c) => c.charCodeAt(0) & 255)); }
  raw(b: Uint8Array) { this.parts.push(b); this.len += b.length; }
  out() { const o = new Uint8Array(this.len); let p = 0; for (const b of this.parts) { o.set(b, p); p += b.length; } return o; }
}

/** PackBits-encode one row. */
export function packBits(row: Uint8Array): Uint8Array {
  const out: number[] = [];
  let i = 0;
  while (i < row.length) {
    let run = 1;
    while (i + run < row.length && run < 128 && row[i + run] === row[i]) run++;
    if (run >= 3) { out.push(257 - run, row[i]); i += run; continue; }
    const start = i;
    let lit = 0;
    while (i < row.length && lit < 128) {
      if (i + 2 < row.length && row[i] === row[i + 1] && row[i] === row[i + 2]) break;
      i++; lit++;
    }
    out.push(lit - 1);
    for (let k = start; k < start + lit; k++) out.push(row[k]);
  }
  return Uint8Array.from(out);
}

type Node = { kind: 'layer'; layer: ArtLayer } | { kind: 'open'; name: string } | { kind: 'close'; name: string; path: string };

/** Layers (bottom → top, `path` = folders) → PSD bytes. */
/** `hiddenFolders`: folder paths ("Outfits/Formal") written hidden (the eye off). */
export function writePsd(width: number, height: number, layers: ArtLayer[], opts: { rle?: boolean; hiddenFolders?: string[] } = {}): Uint8Array {
  const rle = opts.rle !== false, hiddenFolders = new Set(opts.hiddenFolders ?? []);
  // Records bottom → top: when a folder starts (going up) emit its end marker first, when it ends emit the folder.
  const recs: Node[] = [];
  let cur: string[] = [];
  const common = (a: string[], b: string[]) => { let i = 0; while (i < a.length && i < b.length && a[i] === b[i]) i++; return i; };
  for (const l of layers) {
    const k = common(cur, l.path);
    for (let d = cur.length - 1; d >= k; d--) recs.push({ kind: 'close', name: cur[d], path: cur.slice(0, d + 1).join('/') });
    for (let d = k; d < l.path.length; d++) recs.push({ kind: 'open', name: l.path[d] });
    cur = l.path.slice();
    recs.push({ kind: 'layer', layer: l });
  }
  for (let d = cur.length - 1; d >= 0; d--) recs.push({ kind: 'close', name: cur[d], path: cur.slice(0, d + 1).join('/') });
  // Note: in PSD the bottom-most record of a group is the END marker (lsct 3) and the group folder (lsct 1) is above
  // its children. Our 'open' (entering a folder going up) = the end marker; 'close' = the folder record.

  const chanData: Uint8Array[][] = [];
  const w = new W();
  w.str('8BPS'); w.u16(1); w.raw(new Uint8Array(6)); w.u16(4); w.u32(height); w.u32(width); w.u16(8); w.u16(3);
  w.u32(0); w.u32(0);
  const li = new W();
  li.i16(-recs.length);
  for (const r of recs) {
    const isLayer = r.kind === 'layer';
    const l = isLayer ? r.layer : null;
    const top = l ? l.y : 0, left = l ? l.x : 0, bottom = l ? l.y + l.h : 0, right = l ? l.x + l.w : 0;
    const lw = right - left, lh = bottom - top;
    const chans: Uint8Array[] = [];
    for (const id of [-1, 0, 1, 2]) {
      const k = id === -1 ? 3 : id;
      const cw = new W();
      if (!lw || !lh) { cw.u16(0); chans.push(cw.out()); continue; }
      const plane = new Uint8Array(lw * lh);
      for (let i = 0; i < lw * lh; i++) plane[i] = l!.rgba[i * 4 + k];
      if (rle) {
        cw.u16(1);
        const rows: Uint8Array[] = [];
        for (let y = 0; y < lh; y++) rows.push(packBits(plane.subarray(y * lw, (y + 1) * lw)));
        for (const rr of rows) cw.u16(rr.length);
        for (const rr of rows) cw.raw(rr);
      } else { cw.u16(0); cw.raw(plane); }
      chans.push(cw.out());
    }
    chanData.push(chans);
    li.i32(top); li.i32(left); li.i32(bottom); li.i32(right);
    li.u16(4);
    [-1, 0, 1, 2].forEach((id, j) => { li.i16(id); li.u32(chans[j].length); });
    li.str('8BIM');
    const blend = l ? ({ normal: 'norm', multiply: 'mul ', screen: 'scrn', add: 'lddg', overlay: 'over' } as const)[l.blend] : r.kind === 'close' ? 'pass' : 'norm';
    li.str(blend);
    li.u8(Math.round((l ? l.opacity : 1) * 255));
    li.u8(l?.clipped ? 1 : 0);
    li.u8((l && !l.visible) || (r.kind === 'close' && hiddenFolders.has(r.path)) ? 2 : 0);
    li.u8(0);
    const ex = new W();
    ex.u32(0); ex.u32(0);
    const name = l ? l.name : r.kind === 'close' ? r.name : '</Layer group>';
    const ascii = Array.from(name, (c) => (c.charCodeAt(0) < 128 ? c : '?')).join('').slice(0, 255);
    ex.u8(ascii.length); ex.str(ascii);
    const padN = (4 - ((ascii.length + 1) % 4)) % 4;
    ex.raw(new Uint8Array(padN));
    // luni
    const lu = new W(); lu.u32(name.length); for (let i = 0; i < name.length; i++) lu.u16(name.charCodeAt(i));
    let luB = lu.out(); if (luB.length % 4) { const t = new Uint8Array(luB.length + 4 - (luB.length % 4)); t.set(luB); luB = t; }
    ex.str('8BIM'); ex.str('luni'); ex.u32(luB.length); ex.raw(luB);
    if (!isLayer) { ex.str('8BIM'); ex.str('lsct'); ex.u32(4); ex.u32(r.kind === 'close' ? 1 : 3); }
    const exB = ex.out();
    li.u32(exB.length); li.raw(exB);
  }
  for (const chans of chanData) for (const c of chans) li.raw(c);
  let liB = li.out();
  if (liB.length % 2) { const t = new Uint8Array(liB.length + 1); t.set(liB); liB = t; }
  w.u32(liB.length + 4 + 4); w.u32(liB.length); w.raw(liB); w.u32(0);
  // merged image: raw, transparent white (readers that ignore layers see a blank page)
  w.u16(0);
  const plane = new Uint8Array(width * height);
  plane.fill(255); w.raw(plane); w.raw(plane); w.raw(plane); plane.fill(0); w.raw(plane);
  return w.out();
}
