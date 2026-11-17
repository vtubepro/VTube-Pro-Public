// Licence gate for animation clips a person fetches themselves (src/avatar/clips.ts): CC0 or self-made only.
//
// The starter source is Mesh2Motion (https://github.com/Mesh2Motion/mesh2motion-assets, checked 2026-10-23 at commit
// c5b0b6c821dbf2fa1dfe49590a6f431fd9f707ce): LICENSE = CC0-1.0, and its README says "the code and platform are all licensed
// under the very permissive MIT license. The art assets (3d models, rigs, animations) are all licensed under CC0".
// Two folders of that repository are NOT used:
//   3d-models/CC-SA/        models marked share-alike
//   motion-capture/         human clips retargeted from raw BVH captures whose source the repository does not state
// Nothing is bundled from it: the person downloads the clip pack they want (e.g. rigs/horse/horse-animations.glb, 1 MB) and
// loads it; the loader checks the licence line they give and the file itself before it uses anything.
// House rule: no Mixamo animations ship or load (a Mixamo skeleton or credit inside a file is refused).

export interface ClipSource {
  /** Short id for the pack, e.g. "mesh2motion-horse". */
  id: string;
  name?: string;
  /** SPDX-style licence of the clips. Only the entries of ALLOWED_CLIP_LICENSES pass. */
  license: string;
  author?: string;
  /** Where it came from (shown to the person). */
  source?: string;
}

/** The licences a clip may carry. "VTP-self-made" = made for VTube Pro by its own scripts/hand, released as CC0. */
export const ALLOWED_CLIP_LICENSES: readonly string[] = ['CC0-1.0', 'CC0', 'Public-Domain', 'VTP-self-made'];

/** Words in a licence line that always stop a clip (checked before the allow-list so "CC0 ... NC" can never sneak through). */
const DENY = /\b(nc|non-?commercial|nd|no-?derivs?|gpl|agpl|lgpl|sa|share-?alike|research|proprietary|all rights reserved|mixamo|adobe)\b/i;
const MIXAMO = /mixamo/i;

export interface LicenseVerdict { ok: boolean; why: string }

/**
 * Places a clip may not come from, whatever its licence line says (enforced here, not only in the docs):
 *   motion-capture/   Mesh2Motion's human clips retargeted from raw captures whose source the repository does not state
 *   3d-models/CC-SA/  Mesh2Motion's share-alike models; any CC-SA / CC-BY-SA / share-alike mention
 * Matched on the pack's `source` (a URL or path, any slash style, any case, percent-encoding undone) AND on text found inside
 * the file (asset.generator / copyright / extras, node and animation names).
 */
const DENY_SOURCE = /(^|[^a-z0-9])motion[\s_-]*capture([^a-z0-9]|$)|(^|[^a-z0-9])mocap([^a-z0-9]|$)|(^|[^a-z0-9])cc[\s_-]*(by[\s_-]*)?sa([^a-z0-9]|$)|share[\s_-]*alike|by-sa/i;

/** The text with backslashes turned to slashes and percent-encoding (also double-encoded) undone, so ..%2Fmotion-capture%2F.. is still seen. */
export function normalizeSource(s: string): string {
  let t = s.replace(/\\/g, '/');
  for (let i = 0; i < 3; i++) { try { const d = decodeURIComponent(t); if (d === t) break; t = d; } catch { break; } }
  return t.replace(/\\/g, '/');
}

export function sourceVerdict(texts: readonly (string | undefined)[]): LicenseVerdict {
  for (const raw of texts) {
    if (!raw) continue;
    const t = normalizeSource(raw);
    if (DENY_SOURCE.test(t)) return { ok: false, why: `This clip comes from a place that is not allowed (${t.slice(0, 80)}): motion-capture and share-alike (CC-SA) material never load here.` };
  }
  return { ok: true, why: '' };
}

/**
 * `hints` = text found inside the file itself (asset.generator / copyright, bone and animation names): a Mixamo skeleton or
 * credit stops the load whatever the licence line says.
 */
export function clipLicenseVerdict(src: Partial<ClipSource> | null | undefined, hints: readonly string[] = []): LicenseVerdict {
  const lic = (src?.license ?? '').trim();
  if (!lic) return { ok: false, why: 'This clip pack has no licence line. Only CC0 or self-made clips load.' };
  if (DENY.test(lic)) return { ok: false, why: `The licence "${lic.slice(0, 60)}" is not allowed here: only CC0 or self-made clips load.` };
  if (!ALLOWED_CLIP_LICENSES.some((a) => a.toLowerCase() === lic.toLowerCase())) return { ok: false, why: `The licence "${lic.slice(0, 60)}" is not one of: ${ALLOWED_CLIP_LICENSES.join(', ')}.` };
  if (hints.some((h) => MIXAMO.test(h))) return { ok: false, why: 'The file looks like a Mixamo animation. Mixamo clips never load here.' };
  return sourceVerdict([src?.source, src?.name, src?.id, ...hints]);
}

/** Clean a manifest entry that came from a file (strings only, bounded). */
export function sanitizeClipSource(raw: unknown): ClipSource | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const s = (v: unknown, n: number) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').slice(0, n) : undefined);
  const id = s(r.id, 64), license = s(r.license, 80);
  if (!id || !/^[a-z0-9._-]+$/i.test(id) || !license) return null;
  return { id, license, ...(s(r.name, 80) ? { name: s(r.name, 80) } : {}), ...(s(r.author, 80) ? { author: s(r.author, 80) } : {}), ...(s(r.source, 200) ? { source: s(r.source, 200) } : {}) };
}
