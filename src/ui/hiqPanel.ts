// "Picture quality" for a rigged 2D model (HQ decision #10), in the 2D avatar panel (src/ui/flatPanel.ts, one line).
// Zero effort: nothing to set. The model draws at once; the studio makes lighter, compressed versions of its textures in
// the background and switches to them by itself. This only says what is happening in one plain sentence, and offers
// the one choice that is the user's: keep the original pictures (uncompressed) for art that shows damage, for the
// whole model or only the face.
import type { App } from '../app.ts';
import type { Rig2DDoc } from '../../shared/rig2d/format.ts';
import type { TierInfo } from '../avatar/flat/rig2d/textureTier.ts';
import { HIQ_STATUS } from '../avatar/flat/rig2d/source.ts';
import { h, section, toggle } from './dom.ts';

interface RigLike { doc: Rig2DDoc; textures?: TierInfo | null }

/** The textures holding the face (eyes, brows, mouth, face skin): "keep the face uncompressed". */
export function faceTextures(doc: Rig2DDoc): number[] {
  const s = new Set<number>();
  for (const m of doc.meshes) if (/eye|brow|mouth|lash|iris|face|目|口|眉/i.test(`${m.id} ${m.name ?? ''}`)) s.add(m.texture);
  return [...s].sort((a, b) => a - b);
}

/** One plain sentence about the textures of the model on screen. */
export function hiqStatusText(t: TierInfo | null | undefined): string {
  if (!t) return '';
  const mb = Math.max(1, Math.round(t.vram / 1048576));
  if (t.building) return HIQ_STATUS;
  if (t.status === 'compressed') return `Sharp and light: its textures are compressed for this device (${mb} MB of graphics memory).${t.note ? ` ${t.note}` : ''}`;
  if (t.status === 'mixed') return `Kept at full quality where you asked; the rest is compressed (${mb} MB of graphics memory).`;
  return `Drawn from its original pictures (${mb} MB of graphics memory).`;
}

export function hiqTextureSection(app: App): HTMLElement | null {
  const p = app.profile, src = app.runtime?.flat?.source as unknown as RigLike | undefined;
  if (!p?.flat || p.flat.kind !== 'rig2d' || !src?.doc) return null;
  const fq = (p.flat.opts as { fullQuality?: unknown } | undefined)?.fullQuality;
  const face = faceTextures(src.doc);
  const set = (v: boolean | number[] | undefined) => app.edit((q) => { if (q.flat) { const o = { ...(q.flat.opts ?? {}) } as Record<string, unknown>; if (v === undefined) delete o.fullQuality; else o.fullQuality = v; q.flat.opts = o; } }, true);
  const line = h('p', { class: 'note', role: 'status' }, hiqStatusText(src.textures));
  const tick = () => { if (!line.isConnected) return; line.textContent = hiqStatusText((app.runtime?.flat?.source as unknown as RigLike | undefined)?.textures); setTimeout(tick, 2000); };
  setTimeout(tick, 2000);
  const items: Node[] = [line,
    toggle('Keep full quality', fq === true, (v) => set(v ? true : undefined), 'Use the original pictures, uncompressed (more graphics memory). Turn it on if fine lines look damaged.')];
  if (face.length && face.length < src.doc.textures.length) items.push(toggle('Keep the face at full quality', Array.isArray(fq) && face.every((t) => fq.includes(t)), (v) => set(v ? face : undefined), 'Only the face’s texture page stays uncompressed: the eyes and mouth exactly as drawn, the rest light.'));
  return section('Picture quality', ...items);
}
