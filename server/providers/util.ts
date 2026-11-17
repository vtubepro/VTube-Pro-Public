// Helpers shared by the generation providers (the local ComfyUI one).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { AvatarProfile, GenerateRequest, Job } from '../../shared/types.ts';
import type { JobContext } from '../jobs.ts';
import { createAvatar, libraryUrl, renderThumbnail, saveProfileAsync, userDir } from '../library.ts';

export type ProviderRun = (job: Job, req: GenerateRequest, ctx: JobContext) => Promise<Job['result']>;

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export const FACELESS_GUIDANCE =
  'no eyes, no mouth, no nose, blank smooth featureless face, full body, T-pose / A-pose with arms away from the body, ' +
  'symmetrical, clean topology, single character, no base or pedestal';

/** Prompt text with the faceless/rig-friendly guidance appended when requested. */
export function buildPrompt(req: GenerateRequest, maxLen = 1024): string {
  let p = (req.prompt ?? '').trim();
  if (req.faceless) p = p ? `${p}. ${FACELESS_GUIDANCE}` : FACELESS_GUIDANCE;
  return p.slice(0, maxLen);
}

export function avatarName(req: GenerateRequest): string {
  if (req.name?.trim()) return req.name.trim();
  const words = (req.prompt ?? '').trim().split(/\s+/).slice(0, 5).join(' ');
  return words || `${req.provider} avatar`;
}

export interface DataUrl {
  mime: string;
  buffer: Buffer;
  base64: string;
}

export function parseDataUrl(url: string): DataUrl {
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(url);
  if (!m) throw new Error('Reference images must be data: URLs (PNG/JPEG)');
  const buffer = m[2] ? Buffer.from(m[3], 'base64') : Buffer.from(decodeURIComponent(m[3]), 'utf8');
  return { mime: m[1], buffer, base64: m[2] ? m[3] : buffer.toString('base64') };
}

export const extForMime = (mime: string) => (mime.includes('png') ? '.png' : mime.includes('webp') ? '.webp' : '.jpg');

/**
 * Poll `check` until it returns a value (not undefined). Delay grows 2s → 5s; overall 20 min timeout.
 */
export async function poll<T>(check: () => Promise<T | undefined>, opts: { timeoutMs?: number; what?: string } = {}): Promise<T> {
  const deadline = Date.now() + (opts.timeoutMs ?? 20 * 60_000);
  let delay = 2000;
  for (;;) {
    const v = await check();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${opts.what ?? 'Task'} timed out after ${Math.round((opts.timeoutMs ?? 1_200_000) / 60000)} min`);
    await sleep(delay);
    delay = Math.min(5000, Math.round(delay * 1.3));
  }
}

/** Move a finished GLB into the library as a new avatar, render its thumbnail, return the job result. */
export async function finishAvatar(
  ctx: JobContext,
  glbPath: string,
  o: {
    req: GenerateRequest;
    source: AvatarProfile['source'];
    extra?: Partial<AvatarProfile>;
    /** Use this PNG as the thumbnail instead of rendering one. */
    thumbnailFrom?: string;
    /** Extra files copied into the avatar folder: { targetName: sourcePath }. */
    keepFiles?: Record<string, string>;
  },
): Promise<Job['result']> {
  const profile = await createAvatar({
    name: avatarName(o.req),
    source: o.source,
    prompt: o.req.prompt,
    modelFrom: glbPath,
    modelFile: 'model.glb',
    move: true,
    extra: o.extra,
  });
  ctx.log(`Created avatar ${profile.id}`);
  const dir = userDir(profile.id);
  for (const [name, src] of Object.entries(o.keepFiles ?? {})) {
    await fsp.copyFile(src, path.join(dir, name)).catch(() => {});
  }
  let thumb: string | null = null;
  if (o.thumbnailFrom && fs.existsSync(o.thumbnailFrom)) {
    await fsp.copyFile(o.thumbnailFrom, path.join(dir, 'thumb.png'));
    await saveProfileAsync(profile.id, { thumbnail: 'thumb.png' });
    thumb = 'thumb.png';
  } else {
    ctx.log('Rendering thumbnail…');
    thumb = await renderThumbnail(profile.id, ctx.log);
  }
  if (thumb) ctx.preview(libraryUrl(profile.id, thumb));
  return { avatarId: profile.id };
}
