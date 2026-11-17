// Pro2D → 3D base bodies (lane to3d). Owner: "Just use the ones that are bundled with the helper, we already provide
// those." So:
//   * VTube Pro's own bundled bases, Mirelle (female) and Kairo (male): the sample avatars that ship with the helper
//     (assets/builtin/mirelle, assets/builtin/kairo), measured into blender/to3d/builtin_bases.json by a pipeline step
//     (user_base.py builtins --write). Picked automatically by the drawing's sex; always ready, nothing to download.
//   * "Use my own base": any VRoid-made VRM 0.x the user owns (their own VRoid Studio export), from the library or a file;
//     checked by the pipeline's own rules (humanoid bones, a Face mesh with VRoid expressions, VRoid eyes) and measured.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from '../paths.ts';
import { kitPaths, kitPython, realKitDeps, realRun } from './kit.ts';

export const BUILTIN_BASES: Record<string, { file: string; gender: 'female' | 'male'; name: string }> = {
  mirelle: { file: path.join(ROOT, 'assets', 'builtin', 'mirelle', 'mirelle.vrm'), gender: 'female', name: 'Mirelle' },
  kairo: { file: path.join(ROOT, 'assets', 'builtin', 'kairo', 'kairo.vrm'), gender: 'male', name: 'Kairo' },
};

/** The bundled bases present in this install (and measured: builtin_bases.json lists them). */
export function haveBases(): string[] {
  let measured: string[] = [];
  try { measured = Object.keys((JSON.parse(fs.readFileSync(path.join(ROOT, 'blender', 'to3d', 'builtin_bases.json'), 'utf8')) as { bases: Record<string, unknown> }).bases); } catch { /* none */ }
  return Object.entries(BUILTIN_BASES).filter(([k, b]) => measured.includes(k) && fs.existsSync(b.file)).map(([k]) => k);
}

export interface BaseCheck { ok: boolean; kind: 'builtin' | 'user' | null; base: string | null; problems: string[]; title: string | null; sha256?: string }

/** Check a VRM with the pipeline's own rules (the toolkit's Python). */
export async function checkBase(file: string): Promise<BaseCheck> {
  const py = kitPython();
  if (!py) return { ok: false, kind: null, base: null, problems: ['Get the 3D toolkit first (it checks the file).'], title: null };
  const r = await realRun(py.python, [path.join(ROOT, 'blender', 'to3d', 'user_base.py'), 'check', file], { timeoutMs: 120_000 });
  const line = r.out.trim().split(/\r?\n/).reverse().find((l) => l.startsWith('{'));
  try { return JSON.parse(line ?? '') as BaseCheck; } catch { return { ok: false, kind: null, base: null, problems: ['This file could not be checked.'], title: null }; }
}

// ---------------------------------------------------------------- the user's own base
interface UserBase { file: string; name: string; sha256: string; at: number }
const userBaseFile = () => path.join(kitPaths(realKitDeps()).dir, 'user_base.json');
export function userBase(): UserBase | null {
  try { const u = JSON.parse(fs.readFileSync(userBaseFile(), 'utf8')) as UserBase; return fs.existsSync(u.file) ? u : null; } catch { return null; }
}
export function clearUserBase() { fs.rmSync(userBaseFile(), { force: true }); }

/** Check + keep the user's own base (copied into the toolkit folder by its hash). One of the bundled bases = nothing to keep. */
export async function setUserBase(srcFile: string, name: string): Promise<{ ok: boolean; problems: string[]; base?: UserBase; builtin?: string | null }> {
  const c = await checkBase(srcFile);
  if (!c.ok) return { ok: false, problems: c.problems };
  if (c.kind === 'builtin') { clearUserBase(); return { ok: true, problems: [], builtin: c.base }; }
  const sha = crypto.createHash('sha256').update(fs.readFileSync(srcFile)).digest('hex');
  const dir = kitPaths(realKitDeps()).userBases;
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sha.slice(0, 16)}.vrm`);
  fs.copyFileSync(srcFile, file);
  const base: UserBase = { file, name: name.slice(0, 80) || 'My base', sha256: sha, at: Date.now() };
  fs.writeFileSync(userBaseFile(), JSON.stringify(base));
  return { ok: true, problems: [], base, builtin: null };
}
