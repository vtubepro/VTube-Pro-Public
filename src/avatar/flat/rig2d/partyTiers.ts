// Party guests get a rigged 2D model's compressed texture tiers with it (HQ decision #10): the small tiers (every page
// ≤ PARTY_TIER_MAX px: what a guest's tile / card / phone draws), so each guest's device picks what fits it
// (src/avatar/flat/rig2d/textureTier.ts reads them from the bundle, in RAM only: model custody,
// docs/MULTIPLAYER_DISCORD.md). Bigger tiers stay home; a guest that needs more draws from the original pictures inside
// the .vtp2. Used by src/avatar/flat/pack.ts (one line).
import type { AvatarProfile } from '../../../../shared/types.ts';
import type { CacheManifest } from '../../../../shared/rig2d/gpu/cache.ts';

export const PARTY_TIER_MAX = 2048;
const enc = new TextEncoder();

/** The cache files to send with the model: [archive path, bytes] (none when there is no finished cache). */
export async function partyTierFiles(p: AvatarProfile, get: (rel: string) => Promise<Uint8Array | null>): Promise<[string, Uint8Array][]> {
  if (p.flat?.kind !== 'rig2d') return [];
  try {
    const st = await (await fetch(`/api/avatars/${encodeURIComponent(p.id)}/gpu`)).json() as { state?: string; key?: string };
    if (st.state !== 'done' || !st.key || !/^[0-9a-f]{16}$/.test(st.key)) return [];
    const dir = `gpu/${st.key}`;
    const mb = await get(`${dir}/manifest.json`);
    if (!mb) return [];
    const man = JSON.parse(new TextDecoder().decode(mb)) as CacheManifest;
    const tiers = man.tiers.filter((t) => t.done && t.pages.every((pg) => Math.max(pg.w, pg.h) <= PARTY_TIER_MAX));
    if (!tiers.length) return [];
    const out: [string, Uint8Array][] = [[`${dir}/manifest.json`, enc.encode(JSON.stringify({ ...man, tiers }))]];
    for (const t of tiers) {
      const l = await get(`${dir}/${t.layout}`);
      if (!l) return [];
      out.push([`${dir}/${t.layout}`, l]);
      for (const pg of t.pages) { const b = await get(`${dir}/${pg.file}`); if (!b) return []; out.push([`${dir}/${pg.file}`, b]); }
    }
    return out;
  } catch { return []; }
}
