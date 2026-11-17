// Avatar detail: the "Loaded model" readout line (src/ui/panels.ts, Me -> Avatars) for the studio view's avatar. Pure
// (tools/lod_switch_unit.ts). Texture caps run at LOAD only, so they outlive a live choice change: every state says when
// the textures are still the smaller ones, Full included (the triangles are all drawn, the textures stay smaller until
// the avatar loads again). Keep this file ASCII-only (non-ASCII text as \u escapes).
import type { DetailInfo } from './AvatarDetail.ts';

type ReadoutInfo = Pick<DetailInfo, 'state' | 'choice' | 'drawnTris' | 'l0Tris' | 'tex'>;

const NAMES = { auto: 'Auto', full: 'Full', lighter: 'Lighter', lightest: 'Lightest' } as const;

export function detailReadout(d: ReadoutInfo | null | undefined): string {
  if (!d) return 'Avatar detail: Full';
  const n = (x: number) => x.toLocaleString('en-US');
  const capped = !!d.tex?.capped;
  const mb = capped ? `${Math.round(d.tex!.beforeMB)} \u2192 ${Math.round(d.tex!.afterMB)} MB` : '';
  // (a texture cap can run on a light model too: Lighter / Lightest, or Auto with over 1 GB of textures)
  const tex = capped ? ` \u00b7 textures made smaller at load: ${mb} (never the face)` : '';
  if (d.state === 'full') {
    return capped
      ? `Avatar detail: Full \u00b7 every triangle drawn \u00b7 textures still the smaller ones from this load: ${mb} (full size the next time your avatar loads)`
      : 'Avatar detail: Full \u00b7 your model exactly as made';
  }
  if (d.state === 'light-model') return `Avatar detail: every triangle kept (light model)${tex}`;
  if (d.state === 'preparing') return `Avatar detail: preparing lighter versions\u2026${tex}`;
  if (d.state === 'failed') return `Avatar detail: could not make lighter versions \u2014 drawn at Full${tex}`;
  return `Avatar detail: ${NAMES[d.choice]} \u00b7 this studio view draws ${n(d.drawnTris)} of ${n(d.l0Tris)} triangles (each OBS source picks its own level for its camera) \u00b7 face unchanged${tex}`;
}
