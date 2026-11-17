// invite-experience: the branded QR code on the "Invite someone" sheet (phone guests scan it instead of typing a link).
// Pure (no DOM): text → module matrix → one crisp SVG. Error correction H (30 %), dark modules in brand ink on white,
// and the V tile in the centre ONLY when the hole it needs stays small: ≤ LOGO_MAX_FRACTION of the symbol's area and
// clear of the three finder patterns. Verified with a real decoder (OpenCV QRCodeDetector) in tools/invite_qr_check.py.
// Library: vendored qrcode-generator 2.0.4 (MIT, Kazuhiko Arase): src/vendor/, THIRD_PARTY_NOTICES.md.
import qrcode from '../vendor/qrcode-generator.js';

/** The logo hole may cover at most this share of the symbol (H corrects ~30 % of codewords; a centred square of 4 %
 *  of the modules damages ~6-9 % of the codewords, spread evenly over the interleaved blocks). */
export const LOGO_MAX_FRACTION = 0.045;
const INK = '#06080a';
/** On-screen size: 4 CSS px per module (incl. the quiet zone). OpenCV's decoder needs ≥ ~3.5 image px per module, and a
 *  phone camera filming a screen loses some: 4 keeps every invite length scannable (tools/invite_qr_unit.ts). */
export const QR_PX_PER_MODULE = 4;
const V_PATH = 'M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z';

export interface QrModel { n: number; dark: boolean[][]; version: number; logo: { at: number; size: number } | null }

/** Encode `text` at level H. `logo`: try to reserve a centred hole for the V tile (dropped when it would be too big). */
export function qrModel(text: string, logo = true): QrModel {
  const qr = qrcode(0, 'H');
  qr.addData(text, 'Byte');
  qr.make();
  const n = qr.getModuleCount();
  const version = (n - 17) / 4;
  const dark = Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => qr.isDark(r, c)));
  let hole: QrModel['logo'] = null;
  if (logo) {
    // an odd-sized centred square, ~19 % of the width (≈ 3.6 % of the area) incl. a 1-module white ring
    let size = Math.max(7, Math.round(n * 0.19));
    if (size % 2 === 0) size += 1;
    const at = (n - size) / 2;
    const clearOfFinders = at > 8 && at + size < n - 8;
    if ((size * size) / (n * n) <= LOGO_MAX_FRACTION && clearOfFinders && version >= 2) hole = { at, size };
  }
  return { n, dark, version, logo: hole };
}

/** The QR as an SVG string (viewBox in modules; scales crisply). `margin` = quiet zone in modules. */
export function qrSvg(text: string, o: { logo?: boolean; margin?: number; label?: string } = {}): { svg: string; model: QrModel; px: number } {
  const m = qrModel(text, o.logo !== false);
  const q = o.margin ?? 3, W = m.n + q * 2;
  const inHole = (r: number, c: number) => !!m.logo && r >= m.logo.at && r < m.logo.at + m.logo.size && c >= m.logo.at && c < m.logo.at + m.logo.size;
  let d = '';
  for (let r = 0; r < m.n; r++) {
    for (let c = 0; c < m.n; c++) {
      if (!m.dark[r][c] || inHole(r, c)) continue;
      let run = 1;                                       // merge horizontal runs: a smaller, cleaner path
      while (c + run < m.n && m.dark[r][c + run] && !inHole(r, c + run)) run++;
      d += `M${c + q} ${r + q}h${run}v1h-${run}z`;
      c += run - 1;
    }
  }
  let tile = '';
  if (m.logo) {
    // the V tile inside the hole, leaving a 1-module white ring around it
    const s = m.logo.size - 2, x = m.logo.at + 1 + q;
    tile = `<g shape-rendering="geometricPrecision" transform="translate(${x} ${x}) scale(${s / 100})"><defs><linearGradient id="qv" gradientUnits="userSpaceOnUse" x1="22" y1="66" x2="80" y2="34"><stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/></linearGradient><linearGradient id="qb" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161c21"/><stop offset="1" stop-color="#07090c"/></linearGradient></defs><rect width="100" height="100" rx="23" fill="url(#qb)"/><path d="${V_PATH}" fill="url(#qv)" transform="translate(50 52) scale(.7) translate(-50 -52)"/></g>`;
  }
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${W}" shape-rendering="crispEdges" role="img" aria-label="${o.label ?? 'QR code for the invite link'}"><rect width="${W}" height="${W}" fill="#fff"/><path d="${d}" fill="${INK}"/>${tile}</svg>`;
  return { svg, model: m, px: Math.max(176, W * QR_PX_PER_MODULE) };
}
