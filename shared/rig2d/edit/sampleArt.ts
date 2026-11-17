// The sample character: a procedural, layered anime-style bust ("Try the sample" in the 2D avatar maker, and the tests).
// Every pixel is computed here from signed distance fields (no third-party art, nothing downloaded). The layers are named
// and grouped the way artists typically split a character for rigging (English names plus a few Japanese ones, one
// unnamed layer, one accessory), so the auto-rig classifier, mesher and keyforms are exercised end to end (tests:
// tools/rig2d_editor_unit.ts, tools/rig2d_editor_e2e.mjs, which saves it as a real .psd). Pure (no DOM).
import type { ArtLayer, ArtSet } from './layers.ts';
import { trimLayer } from './layers.ts';

type V = [number, number];
type Sdf = (x: number, y: number) => number;
type Rgb = [number, number, number];

const len = (x: number, y: number) => Math.hypot(x, y);
export const ellipse = (cx: number, cy: number, rx: number, ry: number): Sdf => (x, y) => {
  const k = len((x - cx) / rx, (y - cy) / ry);
  return (k - 1) * Math.min(rx, ry) * (k > 0 ? Math.max(0.6, Math.min(1.4, 1 / Math.max(0.3, k))) : 1);
};
const segment = (ax: number, ay: number, bx: number, by: number, r: number): Sdf => (x, y) => {
  const px = x - ax, py = y - ay, dx = bx - ax, dy = by - ay;
  const t = Math.max(0, Math.min(1, (px * dx + py * dy) / (dx * dx + dy * dy)));
  return len(px - dx * t, py - dy * t) - r;
};
const polygon = (pts: V[]): Sdf => (x, y) => {
  let d = Infinity, inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [ax, ay] = pts[j], [bx, by] = pts[i];
    const dx = bx - ax, dy = by - ay;
    const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy)));
    d = Math.min(d, len(x - ax - dx * t, y - ay - dy * t));
    if ((ay > y) !== (by > y) && x < ((bx - ax) * (y - ay)) / (by - ay) + ax) inside = !inside;
  }
  return inside ? -d : d;
};
/** A thick arc of the circle (cx, cy, R) between angles a0..a1 (radians, canvas: +y down), tapered at the ends. */
const arc = (cx: number, cy: number, R: number, a0: number, a1: number, th: number, taper = true): Sdf => (x, y) => {
  let a = Math.atan2(y - cy, x - cx);
  const mid = (a0 + a1) / 2, half = (a1 - a0) / 2;
  let da = a - mid; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
  a = Math.abs(da);
  const t = taper ? Math.max(0.15, 1 - Math.pow(a / half, 4)) : 1;
  const radial = Math.abs(len(x - cx, y - cy) - R) - th * t;
  if (a <= half) return radial;
  const ex = cx + R * Math.cos(mid + Math.sign(da) * half), ey = cy + R * Math.sin(mid + Math.sign(da) * half);
  return len(x - ex, y - ey) - th * 0.15;
};
const union = (...s: Sdf[]): Sdf => (x, y) => Math.min(...s.map((f) => f(x, y)));
const smoothUnion = (k: number, ...s: Sdf[]): Sdf => (x, y) => {
  let d = s[0](x, y);
  for (let i = 1; i < s.length; i++) { const e = s[i](x, y); const h = Math.max(0, Math.min(1, 0.5 + (0.5 * (e - d)) / k)); d = e * (1 - h) + d * h - k * h * (1 - h); }
  return d;
};
const minus = (a: Sdf, b: Sdf): Sdf => (x, y) => Math.max(a(x, y), -b(x, y));

interface PaintOpts { line?: Rgb; lineW?: number; shade?: (x: number, y: number, d: number) => Rgb; soft?: number; alpha?: number }

function layer(W: number, H: number, name: string, path: string[], box: [number, number, number, number], sdf: Sdf, color: Rgb, o: PaintOpts = {}): ArtLayer {
  const [bx0, by0, bx1, by1] = box;
  const x0 = Math.max(0, Math.floor(bx0)), y0 = Math.max(0, Math.floor(by0)), x1 = Math.min(W, Math.ceil(bx1)), y1 = Math.min(H, Math.ceil(by1));
  const w = x1 - x0, h = y1 - y0, rgba = new Uint8ClampedArray(w * h * 4);
  const soft = o.soft ?? 0.75, lw = o.lineW ?? 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + x0 + 0.5, py = y + y0 + 0.5;
    const d = sdf(px, py);
    let a = Math.max(0, Math.min(1, 0.5 - d / (2 * soft)));
    if (a <= 0) continue;
    let c = o.shade ? o.shade(px, py, d) : color;
    if (o.line && lw > 0) { const t = Math.max(0, Math.min(1, (d + lw) / 1.2 + 0.5)); c = [c[0] + (o.line[0] - c[0]) * t, c[1] + (o.line[1] - c[1]) * t, c[2] + (o.line[2] - c[2]) * t]; }
    a *= o.alpha ?? 1;
    const i = (y * w + x) * 4;
    rgba[i] = c[0]; rgba[i + 1] = c[1]; rgba[i + 2] = c[2]; rgba[i + 3] = a * 255;
  }
  return { name, path, x: x0, y: y0, w, h, rgba, opacity: 1, visible: true, blend: 'normal', clipped: false };
}

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/** The test character: 900 x 1300 px, about 30 layers in 9 folders. */
export function makeSampleCharacter(opts: { width?: number; height?: number } = {}): ArtSet {
  const W = opts.width ?? 900, H = opts.height ?? 1300;
  const s = W / 900;
  const S = (v: number) => v * s;
  const cx = S(450), cy = S(470);
  const L: ArtLayer[] = [];
  const add = (l: ArtLayer) => { const t = trimLayer(l, 2); if (t) L.push(t); };
  const skin: Rgb = [253, 228, 212], skinLine: Rgb = [176, 112, 98], skinShade: Rgb = [242, 196, 182];
  const hair: Rgb = [92, 78, 150], hairDark: Rgb = [58, 46, 104], hairLine: Rgb = [40, 30, 74];
  const shirt: Rgb = [236, 238, 246], shirtLine: Rgb = [120, 124, 150], ribbon: Rgb = [220, 70, 96];

  // ---- back hair (behind everything)
  const backHair = union(ellipse(cx, cy - S(20), S(250), S(270)), polygon([[cx - S(255), cy], [cx + S(255), cy], [cx + S(270), cy + S(420)], [cx + S(150), cy + S(470)], [cx, cy + S(430)], [cx - S(150), cy + S(470)], [cx - S(270), cy + S(420)]]));
  add(layer(W, H, 'hair back', ['Back Hair'], [cx - S(290), cy - S(310), cx + S(290), cy + S(490)], backHair, hairDark, { line: hairLine, lineW: S(2.5), shade: (x, y) => mix(hairDark, hair, Math.max(0, Math.min(1, (y - cy + S(250)) / S(700)))) }));

  // ---- body
  const torso = smoothUnion(S(30), polygon([[cx - S(110), S(760)], [cx + S(110), S(760)], [cx + S(250), S(900)], [cx + S(290), H + S(20)], [cx - S(290), H + S(20)], [cx - S(250), S(900)]]));
  add(layer(W, H, 'arm R', ['Body'], [cx - S(360), S(840), cx - S(180), H], segment(cx - S(265), S(900), cx - S(300), H + S(40), S(55)), shirt, { line: shirtLine, lineW: S(2.5), shade: (x) => mix(shirt, [206, 210, 228], Math.max(0, Math.min(1, (cx - S(250) - x) / S(80)))) }));
  add(layer(W, H, 'arm L', ['Body'], [cx + S(180), S(840), cx + S(360), H], segment(cx + S(265), S(900), cx + S(300), H + S(40), S(55)), shirt, { line: shirtLine, lineW: S(2.5), shade: (x) => mix(shirt, [206, 210, 228], Math.max(0, Math.min(1, (x - cx - S(250)) / S(80)))) }));
  add(layer(W, H, 'neck', ['Body'], [cx - S(90), S(600), cx + S(90), S(820)], segment(cx, S(620), cx, S(800), S(55)), skin, { line: skinLine, lineW: S(2), shade: (x, y) => mix(skin, skinShade, Math.max(0, Math.min(1, 1 - (y - S(660)) / S(60)))) }));
  add(layer(W, H, 'body', ['Body'], [cx - S(310), S(740), cx + S(310), H], torso, shirt, { line: shirtLine, lineW: S(2.5), shade: (x, y) => mix(shirt, [214, 218, 234], Math.max(0, Math.min(1, Math.abs(x - cx) / S(300)))) }));
  add(layer(W, H, 'collar ribbon', ['Body'], [cx - S(70), S(770), cx + S(70), S(880)], union(polygon([[cx, S(805)], [cx - S(60), S(780)], [cx - S(55), S(840)]]), polygon([[cx, S(805)], [cx + S(60), S(780)], [cx + S(55), S(840)]]), ellipse(cx, S(808), S(14), S(14))), ribbon, { line: [130, 30, 50], lineW: S(2) }));

  // ---- head
  const faceSdf = smoothUnion(S(60), ellipse(cx, cy - S(10), S(190), S(200)), polygon([[cx - S(160), cy + S(40)], [cx + S(160), cy + S(40)], [cx + S(40), cy + S(220)], [cx - S(40), cy + S(220)]]));
  add(layer(W, H, 'ear L', ['Head'], [cx + S(150), cy - S(60), cx + S(240), cy + S(90)], ellipse(cx + S(190), cy + S(10), S(34), S(60)), skin, { line: skinLine, lineW: S(2) }));
  add(layer(W, H, 'ear R', ['Head'], [cx - S(240), cy - S(60), cx - S(150), cy + S(90)], ellipse(cx - S(190), cy + S(10), S(34), S(60)), skin, { line: skinLine, lineW: S(2) }));
  add(layer(W, H, '顔', ['Head'], [cx - S(220), cy - S(230), cx + S(220), cy + S(240)], faceSdf, skin, { line: skinLine, lineW: S(2.2), shade: (x, y) => mix(skin, skinShade, Math.max(0, Math.min(1, (Math.abs(x - cx) - S(130)) / S(80)))) }));
  add(layer(W, H, 'blush', ['Head'], [cx - S(170), cy + S(40), cx + S(170), cy + S(110)], union(ellipse(cx - S(110), cy + S(75), S(44), S(20)), ellipse(cx + S(110), cy + S(75), S(44), S(20))), [246, 150, 160], { soft: S(9), alpha: 0.65 }));
  add(layer(W, H, 'nose', ['Head'], [cx - S(14), cy + S(50), cx + S(14), cy + S(80)], segment(cx + S(2), cy + S(56), cx - S(3), cy + S(70), S(2.6)), skinLine));

  // ---- eyes: "Eye L" sits on the VIEWER's right (the character's own left)
  for (const side of ['L', 'R'] as const) {
    const sx = side === 'L' ? 1 : -1;
    const ex = cx + sx * S(82), ey = cy + S(5);
    const g = ['Head', 'Eyes', `Eye ${side}`];
    const white = ellipse(ex, ey, S(52), S(46));
    add(layer(W, H, 'eye white', g, [ex - S(60), ey - S(55), ex + S(60), ey + S(55)], white, [255, 255, 255], { line: [210, 200, 214], lineW: S(1.5) }));
    add(layer(W, H, 'iris', g, [ex - S(40), ey - S(46), ex + S(40), ey + S(48)], ellipse(ex - sx * S(2), ey + S(4), S(31), S(39)), [70, 120, 200], {
      line: [30, 40, 90], lineW: S(2.2),
      shade: (x, y) => { const t = Math.max(0, Math.min(1, (y - ey + S(36)) / S(76))); const c = mix([36, 52, 120], [120, 190, 240], t); const pd = len(x - ex + sx * S(2), (y - ey - S(4)) * 0.8); return pd < S(13) ? mix([20, 24, 60], c, pd / S(13) * 0.5) : c; },
    }));
    add(layer(W, H, 'highlight', g, [ex - S(30), ey - S(30), ex + S(10), ey + S(10)], union(ellipse(ex - sx * S(12) - S(4), ey - S(14), S(10), S(12)), ellipse(ex + sx * S(10), ey + S(18), S(5), S(5))), [255, 255, 255]));
    add(layer(W, H, 'upper lash', g, [ex - S(70), ey - S(80), ex + S(70), ey - S(10)], union(arc(ex, ey + S(30), S(78), -Math.PI * 0.82, -Math.PI * 0.18, S(7)), segment(ex + sx * S(58), ey - S(30), ex + sx * S(70), ey - S(40), S(4))), [52, 36, 60]));
    add(layer(W, H, 'lower lash', g, [ex - S(50), ey + S(30), ex + S(50), ey + S(60)], arc(ex, ey - S(40), S(88), Math.PI * 0.38, Math.PI * 0.62, S(2.5)), [120, 80, 90]));
    add(layer(W, H, `brow ${side}`, ['Head', 'Brows'], [ex - S(60), ey - S(110), ex + S(60), ey - S(65)], arc(ex + sx * S(5), ey + S(20), S(110), -Math.PI * 0.68, -Math.PI * 0.32, S(5.5)), [70, 52, 96]));
  }

  // ---- mouth (drawn OPEN: the rig closes it)
  const my = cy + S(130);
  const innerSdf = minus(ellipse(cx, my + S(14), S(36), S(26)), ellipse(cx, my - S(30), S(60), S(34)));
  add(layer(W, H, 'mouth inner', ['Head', 'Mouth'], [cx - S(40), my - S(10), cx + S(40), my + S(44)], innerSdf, [120, 40, 56], { line: [80, 24, 36], lineW: S(2) }));
  add(layer(W, H, 'teeth', ['Head', 'Mouth'], [cx - S(34), my - S(6), cx + S(34), my + S(12)], polygon([[cx - S(28), my], [cx + S(28), my], [cx + S(24), my + S(8)], [cx - S(24), my + S(8)]]), [255, 255, 255]));
  add(layer(W, H, 'tongue', ['Head', 'Mouth'], [cx - S(30), my + S(16), cx + S(30), my + S(44)], ellipse(cx, my + S(34), S(24), S(13)), [232, 112, 122]));
  add(layer(W, H, 'mouth upper', ['Head', 'Mouth'], [cx - S(50), my - S(12), cx + S(50), my + S(12)], arc(cx, my + S(70), S(74), -Math.PI * 0.74, -Math.PI * 0.26, S(3)), [120, 50, 60]));
  add(layer(W, H, 'mouth lower', ['Head', 'Mouth'], [cx - S(30), my + S(36), cx + S(30), my + S(52)], arc(cx, my - S(20), S(64), Math.PI * 0.4, Math.PI * 0.6, S(2.2)), [150, 70, 80]));

  // ---- hair in front of the face
  const bangs: V[] = [[cx - S(215), cy - S(40)], [cx - S(230), cy - S(150)], [cx - S(160), cy - S(250)], [cx, cy - S(285)], [cx + S(160), cy - S(250)], [cx + S(230), cy - S(150)], [cx + S(215), cy - S(40)],
    [cx + S(170), cy - S(140)], [cx + S(125), cy - S(70)], [cx + S(80), cy - S(140)], [cx + S(25), cy - S(80)], [cx - S(10), cy - S(150)], [cx - S(70), cy - S(75)], [cx - S(105), cy - S(145)], [cx - S(160), cy - S(60)], [cx - S(178), cy - S(130)]];
  add(layer(W, H, 'side hair L', ['Hair'], [cx + S(150), cy - S(160), cx + S(270), cy + S(330)], polygon([[cx + S(175), cy - S(150)], [cx + S(250), cy - S(110)], [cx + S(262), cy + S(150)], [cx + S(235), cy + S(320)], [cx + S(195), cy + S(180)], [cx + S(170), cy + S(20)]]), hair, { line: hairLine, lineW: S(2.5) }));
  add(layer(W, H, 'side hair R', ['Hair'], [cx - S(270), cy - S(160), cx - S(150), cy + S(330)], polygon([[cx - S(175), cy - S(150)], [cx - S(250), cy - S(110)], [cx - S(262), cy + S(150)], [cx - S(235), cy + S(320)], [cx - S(195), cy + S(180)], [cx - S(170), cy + S(20)]]), hair, { line: hairLine, lineW: S(2.5) }));
  add(layer(W, H, '前髪', ['Hair'], [cx - S(240), cy - S(300), cx + S(240), cy - S(10)], polygon(bangs), hair, { line: hairLine, lineW: S(2.5), shade: (x, y) => { const ring = Math.abs(y - (cy - S(190)) - Math.pow((x - cx) / S(200), 2) * S(30)) < S(9) ? 0.55 : 0; return mix(mix(hair, hairDark, Math.max(0, (y - cy + S(160)) / S(170))), [180, 170, 230], ring); } }));
  add(layer(W, H, 'ahoge', ['Hair'], [cx - S(10), cy - S(360), cx + S(80), cy - S(270)], arc(cx + S(60), cy - S(290), S(55), -Math.PI * 1.0, -Math.PI * 0.45, S(7)), hair, { line: hairLine, lineW: S(2) }));
  add(layer(W, H, 'hairclip', ['Hair'], [cx + S(120), cy - S(230), cx + S(200), cy - S(170)], union(ellipse(cx + S(160), cy - S(200), S(26), S(12)), ellipse(cx + S(160), cy - S(200), S(10), S(22))), [250, 210, 90], { line: [170, 120, 40], lineW: S(2) }));
  // an unnamed layer (a little star sticker) the auto-rig cannot name
  const star: V[] = []; for (let i = 0; i < 10; i++) { const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? S(9) : S(22); star.push([cx - S(150) + Math.cos(a) * r, cy - S(220) + Math.sin(a) * r]); }
  add(layer(W, H, 'Layer 23', [], [cx - S(180), cy - S(250), cx - S(120), cy - S(190)], polygon(star), [255, 240, 120], { line: [200, 150, 40], lineW: S(1.5) }));
  return { width: W, height: H, layers: L, warnings: [] };
}
