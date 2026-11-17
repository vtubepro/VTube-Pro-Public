// Wardrobe storage: costume GLBs live in <avatar folder>/costumes/. For builtin avatars that's the
// override folder library/<id>/costumes/ (resolveAvatarFile serves override files first).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AvatarProfile, CostumeDef } from '../shared/types.ts';
import { findBlender, runBlender } from './blender.ts';
import { HttpError, adoptStrayAvatar, modelPath, requireProfile, resolveAvatarFile, saveProfile, saveProfileAsync, slugify, userDir } from './library.ts';
import { costumeLocked } from '../shared/ownAvatar.ts';
import { TRASH_DIR } from './paths.ts';

export const costumesDir = (id: string) => path.join(userDir(id), 'costumes');
/** A costume id as part of a file / folder name. Ids come from the profile, and a profile can arrive from an imported
 *  avatar or a PUT, so `../` or a drive letter in one must never reach a path (made ids are slugs and stay the same). */
export const fileSafeId = (id: string) => String(id).replace(/[^A-Za-z0-9_.-]/g, '_').replace(/\.{2,}/g, '_').slice(0, 80) || 'costume';

const stampNow = () => new Date().toISOString().replace(/[:.]/g, '-');

/** A costume id (= file slug) not used by the profile or by any file in either avatar folder. */
export function uniqueCostumeId(p: AvatarProfile, name: string): string {
  const base = slugify(name) || 'costume';
  for (let i = 1; ; i++) {
    const id = i === 1 ? base : `${base}-${i}`;
    if (p.costumes.some((c) => c.id === id)) continue;
    if (resolveAvatarFile(p.id, `costumes/${id}.glb`)) continue;
    return id;
  }
}

export function isGlb(buf: Buffer) {
  return buf.length > 20 && buf.subarray(0, 4).toString('latin1') === 'glTF';
}

/** glTF JSON chunk of a .glb (null if unreadable). */
function glbJson(file: string): any {
  try {
    const b = fs.readFileSync(file);
    if (!isGlb(b)) return null;
    const len = b.readUInt32LE(12);
    return JSON.parse(b.subarray(20, 20 + len).toString('utf8'));
  } catch {
    return null;
  }
}

/** Sanity-check a costume against the base: skinned? joint names present in the base skeleton? */
export function checkCostume(p: AvatarProfile, costumeFile: string): string[] {
  const warnings: string[] = [];
  const c = glbJson(costumeFile);
  if (!c) return ['Could not read the costume GLB'];
  const skins: any[] = c.skins ?? [];
  if (!skins.length) warnings.push('The costume has no skinned meshes — it will not follow the body (only rigid attachments to named bones will).');
  let baseNames: Set<string> | null = null;
  try {
    const b = glbJson(modelPath(p));
    if (b) baseNames = new Set((b.nodes ?? []).map((n: any) => n.name).filter(Boolean));
  } catch { /* base missing / not glb */ }
  if (baseNames && skins.length) {
    const joints = new Set<string>();
    for (const s of skins) for (const j of s.joints ?? []) if (c.nodes?.[j]?.name) joints.add(c.nodes[j].name);
    const matched = [...joints].filter((n) => baseNames!.has(n));
    if (!matched.length) warnings.push("None of the costume's bones match the avatar's skeleton — build it with blender/costume_kit.py so bone names and rest pose match.");
    else if (matched.length < joints.size) warnings.push(`${joints.size - matched.length} costume-only bone(s) will be grafted onto the avatar skeleton.`);
  }
  return warnings;
}

export interface AddCostumeOptions {
  name: string;
  source: CostumeDef['source'];
  prompt?: string;
  /** Move instead of copy. */
  move?: boolean;
  thumbnailFrom?: string;
  /** Extra files next to the GLB: { suffix: sourcePath } → costumes/<id><suffix>. */
  keepFiles?: Record<string, string>;
  /** Also set profile.costume to it. */
  wear?: boolean;
  hides?: string[];
  /** Extra CostumeDef fields (labels, eyes…). */
  extra?: Partial<CostumeDef>;
}

/** Copy/move a GLB into the avatar's costumes folder and append a CostumeDef. */
export async function addCostume(avatarId: string, glbFrom: string, o: AddCostumeOptions): Promise<{ profile: AvatarProfile; costume: CostumeDef }> {
  const p = requireProfile(avatarId);
  const id = uniqueCostumeId(p, o.name);
  const dir = costumesDir(avatarId);
  await fsp.mkdir(dir, { recursive: true });
  const dest = path.join(dir, `${id}.glb`);
  if (o.move) {
    try { await fsp.rename(glbFrom, dest); } catch { await fsp.copyFile(glbFrom, dest); await fsp.rm(glbFrom, { force: true }); }
  } else await fsp.copyFile(glbFrom, dest);
  for (const [suffix, src] of Object.entries(o.keepFiles ?? {})) await fsp.copyFile(src, path.join(dir, `${id}${suffix}`)).catch(() => {});
  const def: CostumeDef = { ...o.extra, id, name: o.name.trim() || id, file: `costumes/${id}.glb`, hides: o.hides ?? [], source: o.source };
  if (o.prompt) def.prompt = o.prompt;
  if (o.thumbnailFrom && fs.existsSync(o.thumbnailFrom)) {
    await fsp.copyFile(o.thumbnailFrom, path.join(dir, `${id}_thumb.png`));
    def.thumbnail = `costumes/${id}_thumb.png`;
  }
  const latest = requireProfile(avatarId);
  const profile = await saveProfileAsync(avatarId, {
    costumes: [...latest.costumes.filter((c) => c.id !== id), def],
    ...(o.wear ? { costume: id } : {}),
  });
  return { profile, costume: def };
}

/** Patch one CostumeDef on the latest profile. */
export function updateCostumeDef(avatarId: string, costumeId: string, patch: Partial<CostumeDef>): AvatarProfile {
  const p = requireProfile(avatarId);
  if (!p.costumes.some((c) => c.id === costumeId)) throw new HttpError(404, `No costume '${costumeId}' on '${avatarId}'`);
  return saveProfile(avatarId, { costumes: p.costumes.map((c) => (c.id === costumeId ? { ...c, ...patch, id: c.id } : c)) });
}

/**
 * Render the costume ON the base avatar (front view) with Blender → costumes/<id>_thumb.png.
 * Returns null without throwing if Blender is missing or the render fails.
 */
export async function renderCostumeThumbnail(avatarId: string, costumeId: string, log?: (s: string) => void): Promise<string | null> {
  if (!findBlender()) return null;
  const p = requireProfile(avatarId);
  const def = p.costumes.find((c) => c.id === costumeId);
  if (!def) return null;
  const costumeFile = resolveAvatarFile(avatarId, def.file);
  if (!costumeFile) return null;
  const dir = costumesDir(avatarId);
  await fsp.mkdir(dir, { recursive: true });
  const r = await runBlender<{ images: { path: string }[] }>(
    'render_costume.py',
    { base: modelPath(p), costume: costumeFile, hides: def.hides ?? [], out_dir: dir, views: ['front'], size: 384, prefix: `_${fileSafeId(costumeId)}_thumb` },
    { timeoutMs: 180_000 },
  );
  const img = r.result?.images?.[0]?.path;
  if (!r.ok || !img) {
    log?.(`Costume thumbnail render failed: ${r.error}`);
    return null;
  }
  const rel = `costumes/${fileSafeId(costumeId)}_thumb.png`;
  fs.renameSync(img, path.join(userDir(avatarId), rel));
  updateCostumeDef(avatarId, costumeId, { thumbnail: rel });
  return rel;
}

/** Move a user costume's files to library/.trash and drop its def (builtin costumes are refused). */
export async function trashCostume(avatarId: string, costumeId: string): Promise<{ profile: AvatarProfile; movedTo: string }> {
  let p = requireProfile(avatarId);
  let def = p.costumes.find((c) => c.id === costumeId);
  if (!def) throw new HttpError(404, `No costume '${costumeId}' on '${avatarId}'`);
  // locked only when VTube Pro ships the avatar: a costume a creator script marked 'builtin' on the user's own avatar is theirs
  // (the profile already lists it as 'import'; this keeps the rule in one place for an older profile read)
  if (costumeLocked(p, def)) throw new HttpError(403, `'${def.name}' is a builtin costume and can't be deleted`);
  // the user's avatar still in the program folder (it could not be moved at start): its files move to the library first
  if (p.shipped === false) { await adoptStrayAvatar(avatarId); p = requireProfile(avatarId); def = p.costumes.find((c) => c.id === costumeId) ?? def; }
  const dest = path.join(TRASH_DIR, `${fileSafeId(avatarId)}-costume-${fileSafeId(costumeId)}-${stampNow()}`);
  await fsp.mkdir(dest, { recursive: true });
  // only files inside the writable avatar folder are moved; never touch assets/builtin
  const base = userDir(avatarId);
  const files = [def.file, def.thumbnail, `costumes/${fileSafeId(costumeId)}_build.py`].filter((f): f is string => !!f);
  for (const rel of files) {
    const full = resolveAvatarFile(avatarId, rel);
    if (!full || !full.startsWith(base + path.sep)) continue;
    await fsp.rename(full, path.join(dest, path.basename(full))).catch(async () => {
      await fsp.copyFile(full, path.join(dest, path.basename(full)));
      await fsp.rm(full, { force: true });
    });
  }
  fs.writeFileSync(path.join(dest, 'costume.json'), JSON.stringify(def, null, 2));
  const latest = requireProfile(avatarId);
  const profile = await saveProfileAsync(avatarId, {
    costumes: latest.costumes.filter((c) => c.id !== costumeId),
    costume: latest.costume === costumeId ? null : latest.costume,
  });
  return { profile, movedTo: dest };
}
