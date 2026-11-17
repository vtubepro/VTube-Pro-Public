// Can this ComfyUI make a 3D character right now? The Character 3D workflow (shared/comfyWorkflows/catalog.ts 'character-3d')
// needs its model files in ComfyUI's own folders. "Set it up for me" (server/comfyInstall.ts) puts them there after the
// user's Yes; this file only LOOKS (a stat per file), so the studio's status poll and the comfy provider can use it freely.
import fs from 'node:fs';
import path from 'node:path';
import { buildWorkflow, workflowDef, type TierId } from '../shared/comfyWorkflows/catalog.ts';
import { NODE_SCHEMA } from '../shared/comfyWorkflows/files.ts';
import { folderFor, suggestedTier, type ComfyTarget } from './comfyInstall.ts';

export const CHARACTER_WORKFLOW = 'character-3d';

/** The Character 3D workflow for one size. The graph is code (nothing to ship or lose); built once per size. */
const builds = new Map<TierId, ReturnType<typeof buildWorkflow>>();
export function characterBuild(tier: TierId) {
  let b = builds.get(tier);
  if (!b) {
    const def = workflowDef(CHARACTER_WORKFLOW);
    if (!def?.tiers[tier]) throw new Error(`No ${CHARACTER_WORKFLOW} workflow for ${tier}.`);
    b = buildWorkflow(def, tier, NODE_SCHEMA);
    builds.set(tier, b);
  }
  return b;
}

/** Every model file of this size is in ComfyUI's folders with exactly the catalogue size (a half download is still `.part`). */
export function modelsThere(t: ComfyTarget, tier: TierId): boolean {
  return characterBuild(tier).manifest.models.every((m) => {
    const dir = folderFor(t, m.folder);
    if (!dir) return false;
    try { return fs.statSync(path.join(dir, m.file)).size === m.bytes; } catch { return false; }
  });
}

/** Which size to run: the one that fits this graphics card if its files are there, else the next best that is. */
const ORDER: Record<TierId, TierId[]> = { large: ['large', 'medium', 'small'], medium: ['medium', 'small', 'large'], small: ['small', 'medium', 'large'] };
export const readyTier = (t: ComfyTarget): TierId | null => ORDER[suggestedTier(t) ?? 'medium'].find((x) => modelsThere(t, x)) ?? null;

/** The size to offer in "Set it up for me" (from the graphics card; medium when unknown). */
export const setupTier = (t: ComfyTarget | null): TierId => suggestedTier(t) ?? 'medium';
/** The helper page that sets Character 3D up (relative: the studio puts the helper's address in front). */
export const setupUrl = (t: ComfyTarget | null): string => `/comfyui?workflow=${CHARACTER_WORKFLOW}&tier=${setupTier(t)}`;
/** Roughly how much "Set it up for me" downloads for this size, for a sentence ("about 8 GB"). */
export const setupGB = (tier: TierId): number => Math.round(characterBuild(tier).manifest.downloadBytes / 1e9);
