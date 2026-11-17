// The VTube Pro logo: the geometric "V" with the step-notch (tools/launcher/vtubepro-tile.svg,
// spec in the portal BRAND kit). Inline SVG, no download. Never recolour it, never put the gradient V on lime / sky.
//   'mark' = the V alone (gradient), 'tile' = the V on the rounded near-black app tile.
const V = 'M12 20H30L46.6 48V61L60.5 50.5L54.3 41.3L67 20H88L50 84Z';
const STOPS = '<stop offset="0" stop-color="#8be39b"/><stop offset=".3" stop-color="#7bd88f"/><stop offset=".7" stop-color="#6cc7f5"/><stop offset="1" stop-color="#7fd2ff"/>';
let seq = 0;

/** SVG markup of the mark / tile. Gradient ids are unique per call so several logos on one page never clash. */
export function brandSvg(kind: 'mark' | 'tile' = 'tile', size = 30, label = ''): string {
  const n = ++seq, g = `vtp-g${n}`, t = `vtp-t${n}`, e = `vtp-e${n}`;
  const a11y = label ? `role="img" aria-label="${label.replace(/[<>&"]/g, '')}"` : 'aria-hidden="true" focusable="false"';
  const grad = `<linearGradient id="${g}" x1="22" y1="66" x2="80" y2="34" gradientUnits="userSpaceOnUse">${STOPS}</linearGradient>`;
  if (kind === 'mark') {
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="8 16 84 72" width="${Math.round(size * 84 / 72)}" height="${size}" ${a11y} style="display:block"><defs>${grad}</defs><path d="${V}" fill="url(#${g})"/></svg>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" width="${size}" height="${size}" ${a11y} style="display:block"><defs>${grad}`
    + `<linearGradient id="${t}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#161c21"/><stop offset="1" stop-color="#07090c"/></linearGradient>`
    + `<linearGradient id="${e}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".22"/><stop offset=".35" stop-color="#fff" stop-opacity=".05"/><stop offset="1" stop-color="#fff" stop-opacity=".02"/></linearGradient></defs>`
    + `<rect width="100" height="100" rx="23" fill="url(#${t})"/><rect x=".5" y=".5" width="99" height="99" rx="22.5" fill="none" stroke="url(#${e})"/>`
    + `<g transform="translate(50 52.5) scale(.7) translate(-50 -52)"><path d="${V}" fill="url(#${g})"/></g></svg>`;
}

/** The logo as a DOM element (decorative unless a label is given). */
export function brandMark(kind: 'mark' | 'tile' = 'tile', size = 30, label = ''): SVGSVGElement {
  const tpl = document.createElement('template');
  tpl.innerHTML = brandSvg(kind, size, label);
  return tpl.content.firstElementChild as SVGSVGElement;
}
