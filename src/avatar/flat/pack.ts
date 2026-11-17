// Party sharing of THIS PC's 2D avatar (src/party.ts): the files of its library folder packed into one bundle
// (files.ts packFlatBundle: a mesh-less GLB) — the "model" the party sends, sealed and RAM-only on every receiver.
import { flatPngFiles } from '../../../shared/flatAvatar.ts';
import type { AvatarProfile } from '../../../shared/types.ts';
import { packFlatBundle } from './files.ts';
import { partyTierFiles } from './rig2d/partyTiers.ts';

const libUrl = (id: string, rel: string) => `/library/${encodeURIComponent(id)}/${rel.split('/').map(encodeURIComponent).join('/')}`;

/** Every file the avatar needs: an image set's pictures, or (other kinds) the whole folder minus the profile + thumbnail. */
export async function flatFileList(p: AvatarProfile): Promise<string[]> {
  if (!p.flat) return [];
  if (p.flat.kind === 'png') return flatPngFiles(p.flat);
  const r = await fetch(`/api/avatars/${encodeURIComponent(p.id)}/files`);
  if (!r.ok) throw new Error(`file list: ${r.status}`);
  const list = (await r.json()) as unknown;
  return Array.isArray(list) ? list.filter((f): f is string => typeof f === 'string' && f !== 'profile.json' && f !== p.thumbnail) : [];
}

/** The avatar as a party bundle (ArrayBuffer), or null when it is over `max` bytes. */
export async function packOwnFlatAvatar(p: AvatarProfile, max: number): Promise<ArrayBuffer | null> {
  const files: [string, Uint8Array][] = [];
  let total = 0;
  for (const f of await flatFileList(p)) {
    const r = await fetch(libUrl(p.id, f));
    if (!r.ok) { if (f === p.flat?.main) throw new Error(`${f}: ${r.status}`); continue; }
    const b = new Uint8Array(await r.arrayBuffer());
    total += b.byteLength;
    if (total > max) return null;
    files.push([f, b]);
  }
  // a rigged model's small compressed texture tiers ride along (src/avatar/flat/rig2d/partyTiers.ts)
  // (all of them or none: the bundle stays under the party's limit)
  const tiers = await partyTierFiles(p, async (rel) => { const r = await fetch(libUrl(p.id, rel)); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; });
  const tb = tiers.reduce((s, [, b]) => s + b.byteLength, 0);
  if (tiers.length && total + tb <= max) { files.push(...tiers); total += tb; }
  const out = packFlatBundle(files);
  return out.buffer.byteLength === out.byteLength ? out.buffer as ArrayBuffer : out.slice().buffer as ArrayBuffer;
}
