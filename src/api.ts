// REST client for the local VTube Pro server.
import type { AvatarProfile, CostumeDef, GenerateRequest, Job, OutputSettings, ServerStatus, SoftRigConfig } from '../shared/types.ts';
import type { BodyType, RigTaps } from '../shared/rigTaps.ts';

export interface RigMlStatus {
  gpu: { name: string; vramGB: number };
  notice: { version: number; lines: string[] };
  models: { id: string; label: string; summary: string; minVramGB: number; stagedFloorGB: number; tier: 'normal' | 'staged' | 'templates'; fits: boolean; usable: boolean; minutes: number | null; why: string; installed: boolean; notes: string[]; downloadGB: number }[];
  recommended: string | null;
  /** How a rig job runs on this card: full speed, the low-memory staged mode, or the Blender templates (no AI). */
  plan: { mode: 'normal' | 'staged' | 'templates'; model: string | null; minutes: number | null; message: string };
}

async function j<T>(res: Response): Promise<T> {
  if (!res.ok) {
    let msg = `${res.status} ${res.statusText}`;
    try { const b = await res.json(); msg = b.error ?? msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json() as Promise<T>;
}

export const api = {
  get: <T = unknown>(url: string) => fetch(url).then((r) => j<T>(r)),
  output: () => fetch('/api/output').then((r) => j<OutputSettings>(r)),
  saveOutput: (s: Partial<OutputSettings>) =>
    fetch('/api/output', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).then((r) => j<OutputSettings>(r)),
  // (party members' avatars: never stored — sealed RAM vault, see src/net/custody.ts)
  status: () => fetch('/api/status').then((r) => j<ServerStatus>(r)),
  avatars: () => fetch('/api/avatars').then((r) => j<AvatarProfile[]>(r)),
  avatar: (id: string) => fetch(`/api/avatars/${encodeURIComponent(id)}`).then((r) => j<AvatarProfile>(r)),
  save: (p: AvatarProfile) =>
    fetch(`/api/avatars/${encodeURIComponent(p.id)}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(p) }).then((r) => j<AvatarProfile>(r)),
  remove: (id: string) => fetch(`/api/avatars/${encodeURIComponent(id)}`, { method: 'DELETE' }).then((r) => j<unknown>(r)),
  import: (file: File, name?: string) =>
    fetch(`/api/avatars/import?filename=${encodeURIComponent(file.name)}&name=${encodeURIComponent(name ?? file.name.replace(/\.[^.]+$/, ''))}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    }).then((r) => j<AvatarProfile>(r)),
  thumbnail: (id: string, png: Blob) =>
    fetch(`/api/avatars/${encodeURIComponent(id)}/thumbnail`, { method: 'POST', headers: { 'content-type': 'image/png' }, body: png }).then((r) => j<unknown>(r)),
  generate: (req: GenerateRequest) =>
    fetch('/api/generate', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(req) }).then((r) => j<{ jobId: string }>(r)),
  job: (id: string) => fetch(`/api/jobs/${id}`).then((r) => j<Job>(r)),
  autorig: (id: string, soft: SoftRigConfig | undefined, guided?: { bodyType: BodyType; taps: RigTaps }) =>
    fetch(`/api/avatars/${encodeURIComponent(id)}/autorig`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ soft, ...guided }) }).then((r) => j<{ jobId: string }>(r)),
  /** The optional ML rigging pack (server/rigMl.ts): installed on the person's click. */
  rigMlStatus: () => fetch('/api/rigml/status').then((r) => j<RigMlStatus>(r)),
  rigMlInstall: (model: string) =>
    fetch('/api/rigml/install', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, accept: true }) }).then((r) => j<{ jobId: string }>(r)),
  autorigMl: (id: string, guided: { bodyType: BodyType; taps: RigTaps }) =>
    fetch(`/api/avatars/${encodeURIComponent(id)}/autorig-ml`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(guided) }).then((r) => j<{ jobId: string }>(r)),
  /** Switch on a finished smart skeleton that the helper held back because OBS was live (confirmLive = the person said yes to the reload). */
  rigMlApply: (id: string, confirmLive = false) =>
    fetch(`/api/avatars/${encodeURIComponent(id)}/autorig-ml/apply`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirmLive }) }).then((r) => j<{ ok: boolean }>(r)),
  settings: () => fetch('/api/settings').then((r) => j<Record<string, unknown>>(r)),
  saveSettings: (s: unknown) =>
    fetch('/api/settings', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(s) }).then((r) => j<Record<string, unknown>>(r)),
  importCostume: (avatarId: string, file: File, name?: string) =>
    fetch(`/api/avatars/${encodeURIComponent(avatarId)}/costumes/import?filename=${encodeURIComponent(file.name)}&name=${encodeURIComponent(name ?? file.name.replace(/\.[^.]+$/, ''))}`, {
      method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: file,
    }).then((r) => j<{ profile: AvatarProfile; costume: CostumeDef; warnings: string[] }>(r)),
  removeCostume: (avatarId: string, costumeId: string) =>
    fetch(`/api/avatars/${encodeURIComponent(avatarId)}/costumes/${encodeURIComponent(costumeId)}`, { method: 'DELETE' }).then((r) => j<{ profile: AvatarProfile; movedTo: string }>(r)),
  renderCostumeThumb: (avatarId: string, costumeId: string) =>
    fetch(`/api/avatars/${encodeURIComponent(avatarId)}/costumes/${encodeURIComponent(costumeId)}/thumbnail`, { method: 'POST' }).then((r) => j<{ started: boolean }>(r)),
  /** URL for a file inside an avatar folder; keeps sub-folder slashes (e.g. costumes/x.png). */
  pathUrl: (avatarId: string, rel: string) => `/library/${encodeURIComponent(avatarId)}/${rel.split(/[\\/]/).map(encodeURIComponent).join('/')}`,
  modelUrl: (p: AvatarProfile) => `/library/${encodeURIComponent(p.id)}/${encodeURIComponent(p.modelFile)}`,
  fileUrl: (p: AvatarProfile, f: string) => `/library/${encodeURIComponent(p.id)}/${encodeURIComponent(f)}`,
};

export async function waitJob(id: string, onUpdate: (j: Job) => void): Promise<Job> {
  for (;;) {
    const job = await api.job(id);
    onUpdate(job);
    if (job.status === 'succeeded' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 1500));
  }
}
