// 2D avatar import without telling us anything: which unnamed picture is quiet / talking / blinking, from how the
// pictures differ. Two pictures of one character that differ in ONE feature differ either in one spot (the mouth) or in
// a left / right pair of spots (the eyes); comparing every pair of pictures says which pictures share a mouth and which
// share eyes, wherever those features are and however close together they are drawn. Then: in a mouth difference the
// darker picture has the mouth open (talk); in an eye difference the lighter one has the eyes closed (no iris / pupil:
// skin and a line → blink). Pure: the studio computes small grey thumbnails (src/ui/flatPanel.ts pictureSamples) and
// sends the roles with the upload; tests in tools/flat_unit.ts.

export interface PictureSample {
  name: string;
  /** Same size for every sample: w × h, row 0 = top. Values 0..1 (lightness over a white background). */
  w: number; h: number;
  value: ArrayLike<number>;
}
export type PictureRole = 'idle' | 'talk' | 'blink' | 'talkBlink';

interface Spot { px: number[]; cx: number; cy: number; x0: number; x1: number; y0: number; y1: number }

function spotOf(px: number[], w: number, h: number): Spot {
  let sx = 0, sy = 0, x0 = w, x1 = 0, y0 = h, y1 = 0;
  for (const j of px) { const x = j % w, y = (j / w) | 0; sx += x; sy += y; x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
  return { px, cx: sx / px.length, cy: sy / px.length, x0, x1, y0, y1 };
}

/** Spots of a mask (8-neighbour after growing it by one pixel), specks dropped; spots stacked over each other (an open
 *  mouth cut by the closed mouth's line) merged. */
function spots(mask: Uint8Array, w: number, h: number): Spot[] {
  const on = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let hit = 0;
    for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1; dx++) { const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h && mask[ny * w + nx]) { hit = 1; break; } }
    on[y * w + x] = hit;
  }
  const seen = new Uint8Array(w * h);
  let out: Spot[] = [];
  for (let i = 0; i < on.length; i++) {
    if (!on[i] || seen[i]) continue;
    const px: number[] = [], st = [i];
    seen[i] = 1;
    while (st.length) {
      const j = st.pop()!; px.push(j);
      const x = j % w, y = (j / w) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const k = ny * w + nx;
        if (on[k] && !seen[k]) { seen[k] = 1; st.push(k); }
      }
    }
    out.push(spotOf(px, w, h));
  }
  out = out.filter((s) => s.px.length >= Math.max(3, w * h * 0.001));
  // merge spots whose column ranges overlap mostly (stacked parts of one feature)
  for (let again = true; again;) {
    again = false;
    for (let i = 0; i < out.length && !again; i++) for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      const ov = Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0) + 1;
      if (ov > 0.6 * Math.min(a.x1 - a.x0 + 1, b.x1 - b.x0 + 1)) { out[i] = spotOf([...a.px, ...b.px], w, h); out.splice(j, 1); again = true; break; }
    }
  }
  return out.sort((a, b) => b.px.length - a.px.length);
}

/** How two pictures differ: 'M' = in one spot (the mouth), 'E' = in a left / right pair (the eyes), 'B' = more / other,
 *  null = not at all; and which of the two has that feature OPEN: the mouth = darker there (the open mouth's inside),
 *  the eyes = more contrast around them (white + iris / pupil, where closed eyes are skin and a line). */
export function pairDiff(a: PictureSample, b: PictureSample): { kind: 'M' | 'E' | 'B'; open: 0 | 1 } | null {
  const { w, h } = a, N = w * h;
  const d = new Float32Array(N);
  let max = 0;
  for (let i = 0; i < N; i++) { d[i] = Math.abs(a.value[i] - b.value[i]); max = Math.max(max, d[i]); }
  if (max < 0.12) return null;
  const mask = new Uint8Array(N);
  for (let i = 0; i < N; i++) mask[i] = d[i] > max * 0.3 ? 1 : 0;
  const S = spots(mask, w, h).slice(0, 4);
  if (!S.length) return null;
  let kind: 'M' | 'E' | 'B' = 'B';
  if (S.length === 1) {
    // one spot can still be both eyes (+ the mouth) drawn close together: rows where the difference is two separate runs
    // either side of the middle are eyes
    const sp = S[0], rows = sp.y1 - sp.y0 + 1;
    let twin = 0, lastTwin = -1, firstTwin = -1;
    for (let y = sp.y0; y <= sp.y1; y++) {
      let runs = 0, inRun = false, gap = 0, maxGap = 0, left = -1, right = -1;
      for (let x = sp.x0; x <= sp.x1; x++) {
        if (mask[y * w + x]) { if (!inRun) { runs++; if (runs > 1) maxGap = Math.max(maxGap, gap); } inRun = true; gap = 0; if (left < 0) left = x; right = x; }
        else { if (inRun) inRun = false; gap++; }
      }
      if (runs >= 2 && maxGap >= 2 && left < sp.cx && right > sp.cx) { twin++; if (firstTwin < 0) firstTwin = y; lastTwin = y; }
    }
    if (twin >= Math.max(2, rows * 0.25)) kind = lastTwin < sp.y1 - rows * 0.2 ? 'B' : 'E';   // (single rows below the pair = a mouth too)
    else kind = 'M';
  }
  else if (S.length === 2) {
    const [p, q] = S;
    const sameRow = Math.abs(p.cy - q.cy) < Math.max(2, (p.y1 - p.y0 + q.y1 - q.y0) * 0.5);
    const similar = Math.min(p.px.length, q.px.length) / Math.max(p.px.length, q.px.length) > 0.35;
    kind = sameRow && similar ? 'E' : 'B';
  }
  if (kind === 'B') return { kind, open: 0 };
  if (kind === 'M') {
    let sa = 0, sb = 0;
    for (const j of S[0].px) { sa += a.value[j]; sb += b.value[j]; }
    return { kind, open: sa < sb ? 0 : 1 };
  }
  const std = (p: PictureSample) => {
    let s = 0, s2 = 0, k = 0;
    for (const sp of S) for (let y = Math.max(0, sp.y0 - 1); y <= Math.min(h - 1, sp.y1 + 1); y++) for (let x = Math.max(0, sp.x0 - 1); x <= Math.min(w - 1, sp.x1 + 1); x++) { const v = p.value[y * w + x]; s += v; s2 += v * v; k++; }
    const mean = s / k; return Math.sqrt(Math.max(0, s2 / k - mean * mean));
  };
  return { kind, open: std(a) > std(b) ? 0 : 1 };
}

/** Roles for 2–4 unnamed pictures of one character, or {} when it can't tell (the import falls back to name order). */
export function guessRoles(pics: PictureSample[]): Record<string, PictureRole> {
  if (pics.length < 2 || pics.length > 4) return {};
  const { w, h } = pics[0];
  if (pics.some((p) => p.w !== w || p.h !== h || p.value.length < w * h)) return {};
  const n = pics.length;
  const edges: { i: number; j: number; kind: 'M' | 'E'; dk: number }[] = [];   // dk = the one with the feature open
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    const r = pairDiff(pics[i], pics[j]);
    if (r && r.kind !== 'B') edges.push({ i, j, kind: r.kind, dk: r.open === 0 ? i : j });
  }
  if (!edges.length) return {};
  // the roles that agree best with every comparison (a pair that differs in more than one feature can be misread: the
  // majority wins), every role at most once; ties: fewer open mouths / closed eyes
  const ROLE: PictureRole[] = ['idle', 'talk', 'blink', 'talkBlink'];
  let best = -1e9, pick: number[] = [];
  const asg = new Array(n).fill(0);
  const rec = (k: number) => {
    if (k === n) {
      if (new Set(asg).size < n) return;
      const mo = (i: number) => asg[i] & 1, ec = (i: number) => (asg[i] >> 1) & 1;
      let sc = 0;
      for (const ed of edges) {
        const o = ed.dk === ed.i ? ed.j : ed.i;
        if (ed.kind === 'M') sc += (mo(ed.dk) === 1 && mo(o) === 0 ? 2 : 0) + (ec(ed.dk) === ec(o) ? 1 : 0);
        else sc += (ec(o) === 1 && ec(ed.dk) === 0 ? 2 : 0) + (mo(ed.dk) === mo(o) ? 1 : 0);
      }
      sc -= asg.reduce((t: number, r: number) => t + (r ? 0.01 * r : 0), 0);
      if (!asg.includes(0)) sc -= 3;                                   // someone is the quiet picture
      if (sc > best) { best = sc; pick = [...asg]; }
      return;
    }
    for (let r = 0; r < 4; r++) { asg[k] = r; rec(k + 1); }
  };
  rec(0);
  const out: Record<string, PictureRole> = {};
  pics.forEach((p, i) => { out[p.name] = ROLE[pick[i]]; });
  return Object.values(out).includes('idle') ? out : {};
}
