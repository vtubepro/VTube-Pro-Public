// Provider registry + request validation for POST /api/generate.
// The only provider is the local one: ComfyUI on this PC (server/providers/comfy.ts). Nothing here calls a cloud service.
import type { GenerateProvider, GenerateRequest } from '../../shared/types.ts';
import { runComfy } from './comfy.ts';
import type { ProviderRun } from './util.ts';

export const PROVIDERS: Record<GenerateProvider, ProviderRun> = {
  comfy: runComfy,
};

/** Cheap up-front checks so obvious problems return a 400 instead of a failed job. */
export function validateGenerate(req: GenerateRequest): string | null {
  if (!req || typeof req !== 'object' || Array.isArray(req) || typeof req.provider !== 'string' || !Object.hasOwn(PROVIDERS, req.provider)) return `provider must be one of ${Object.keys(PROVIDERS).join(', ')}`;
  if (req.prompt != null && typeof req.prompt !== 'string') return 'prompt must be a string';
  if (req.name != null && typeof req.name !== 'string') return 'name must be a string';
  if (req.images != null && (!Array.isArray(req.images) || req.images.some((i) => typeof i !== 'string' || !i.startsWith('data:image/')))) {
    return 'images must be data:image/... URLs';
  }
  if (!req.prompt?.trim() && !req.images?.length) return 'Provide a prompt or at least one reference image';
  return null;
}
