// Which PNGTuber / VTube Studio file is this? Tiny and dependency-free on purpose: shared/modelImport/files.ts runs it for
// every dropped file, so the readers (png, godot, layers) are only loaded when one of these files is really there.
export type PngTuberKind = 'plus' | 'remix' | 'veadotube' | 'vts';

const extOf = (p: string) => (/\.([a-z0-9]+)$/i.exec(p)?.[1] ?? '').toLowerCase();
export const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

/** First non-blank character of a text file (after a BOM). */
export function firstChar(b: Uint8Array): string {
  let i = 0;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) i = 3;
  while (i < b.length && i < 64 && (b[i] === 0x20 || b[i] === 0x0a || b[i] === 0x0d || b[i] === 0x09)) i++;
  return String.fromCharCode(b[i] ?? 0);
}

/** What a file is, by name first (cheap) and then a glance at its start. null = not ours. A `.save` that starts with `{` is
 *  PNGTuber Plus's text save; one that starts with a small binary type id is a Godot variant (PNGTuber Remix). */
export function sniffPngTuber(path: string, b: Uint8Array): PngTuberKind | null {
  const n = baseName(path).toLowerCase(), e = extOf(n);
  if (/\.vtube\.json$/.test(n)) return firstChar(b) === '{' ? 'vts' : null;
  if (e === 'save') { const c = firstChar(b); return c === '{' || c === '[' ? 'plus' : b.length >= 8 && b[0] < 40 && b[1] === 0 ? 'remix' : null; }
  if (e === 'pngtp' || e === 'pngremix') return 'remix';
  if (e === 'veadomini' || e === 'veado' || e === 'veadotube') { const c = firstChar(b); return c === '{' || c === '[' ? 'veadotube' : null; }
  return null;
}
