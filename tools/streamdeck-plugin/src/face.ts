// Pure helpers of the VTube Pro Stream Deck plugin (no SDK imports, so tools/deck_unit.ts can test them).
// The server sends every key already resolved (shared/deck.ts DeckFace); the plugin only draws + maps coordinates.

export interface Face { a: string | null; title: string; icon: string; color: string; on: boolean | null; go?: number }

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Split a title into ≤ 2 lines of ~9 characters (Stream Deck keys are tiny). */
function lines(t: string): string[] {
  const words = t.trim().split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= 10) cur += ' ' + w;
    else { out.push(cur); cur = w; }
  }
  if (cur) out.push(cur);
  if (out.length > 2) { out.length = 2; out[1] = out[1].slice(0, 9) + '…'; }
  return out.map((l) => (l.length > 11 ? l.slice(0, 10) + '…' : l));
}

/** One key face as an SVG string (size = 72 or 144 px). Lit keys get a bright ring + dot; offline keys are dimmed. */
export function faceSvg(f: Face | null, size = 144, opts: { offline?: boolean } = {}): string {
  const s = size, u = s / 144;
  if (!f || !f.a) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" fill="#000"/>${opts.offline ? `<text x="${s / 2}" y="${s / 2 + 8 * u}" font-family="Segoe UI, Arial, sans-serif" font-size="${22 * u}" fill="#555" text-anchor="middle">offline</text>` : ''}</svg>`;
  }
  const t = lines(f.title);
  const hasText = t.length > 0;
  const iconY = hasText ? 62 * u : 84 * u;
  const img = /^data:image\//.test(f.icon);
  const icon = !f.icon ? '' : img
    ? `<image href="${esc(f.icon)}" x="${36 * u}" y="${(hasText ? 14 : 30) * u}" width="${72 * u}" height="${72 * u}" preserveAspectRatio="xMidYMid meet"/>`
    : `<text x="${s / 2}" y="${iconY}" font-family="Segoe UI Emoji, Apple Color Emoji, Noto Color Emoji, sans-serif" font-size="${(hasText ? 50 : 64) * u}" text-anchor="middle">${esc(f.icon)}</text>`;
  const text = t.map((l, i) => `<text x="${s / 2}" y="${(t.length === 1 ? 118 : 104 + i * 26) * u}" font-family="Segoe UI, Arial, sans-serif" font-weight="700" font-size="${22 * u}" fill="#fff" text-anchor="middle">${esc(l)}</text>`).join('');
  const ring = f.on ? `<rect x="${4 * u}" y="${4 * u}" width="${136 * u}" height="${136 * u}" rx="${18 * u}" fill="none" stroke="#5dff9b" stroke-width="${8 * u}"/><circle cx="${124 * u}" cy="${20 * u}" r="${9 * u}" fill="#5dff9b"/>` : '';
  const dim = opts.offline || f.on === false ? `<rect width="${s}" height="${s}" fill="#000" opacity="${opts.offline ? 0.6 : 0.25}"/>` : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${s}" height="${s}" viewBox="0 0 ${s} ${s}"><rect width="${s}" height="${s}" fill="${/^#[0-9a-f]{6}$/i.test(f.color) ? f.color : '#1d2230'}"/>${icon}${text}${dim}${ring}</svg>`;
}

export const svgDataUrl = (svg: string) => 'data:image/svg+xml;charset=utf8,' + encodeURIComponent(svg);

/** Layout key index a physical key shows (anchored top-left). -1 = outside the layout / no coordinates (multi-action). */
export function mapCoordinates(l: { cols: number; rows: number }, c: { column: number; row: number } | undefined): number {
  if (!c) return -1;
  if (c.column < 0 || c.row < 0 || c.column >= l.cols || c.row >= l.rows) return -1;
  return c.row * l.cols + c.column;
}
