// Checks an API-format workflow against a ComfyUI node schema (the pinned nodeSchema.json, or a live /object_info):
// every class exists, every required input is there, nothing unknown, links point at a real output of the right type,
// numbers are in range, choices are valid, and model / picture names are files the manifest provides (model lists are
// empty in a schema captured without models, so those are checked against the manifest instead).
// Mirrors ComfyUI's own server-side validate_prompt; tools/comfy/validate_live.ts also asks a real ComfyUI.
import { inputsOf, type ApiPrompt, type NodeSchema } from './graph.ts';

/** Which ComfyUI folder a loader's file-name input reads from. */
export const FILE_INPUTS: Record<string, Record<string, string>> = {
  CheckpointLoaderSimple: { ckpt_name: 'checkpoints' },
  ImageOnlyCheckpointLoader: { ckpt_name: 'checkpoints' },
  UNETLoader: { unet_name: 'diffusion_models' },
  CLIPLoader: { clip_name: 'text_encoders' },
  VAELoader: { vae_name: 'vae' },
  LoraLoaderModelOnly: { lora_name: 'loras' },
  ControlNetLoader: { control_net_name: 'controlnet' },
  CLIPVisionLoader: { clip_name: 'clip_vision' },
  IPAdapterModelLoader: { ipadapter_file: 'ipadapter' },
  UpscaleModelLoader: { model_name: 'upscale_models' },
  LoadBackgroundRemovalModel: { bg_removal_name: 'background_removal' },
  LoadImage: { image: 'input' },
};

export interface ValidateCtx {
  /** folder -> file names that will exist (from the manifest) */
  files: Record<string, Set<string>>;
}
export interface Problem { node: string; input?: string; msg: string }

export function validateApi(p: ApiPrompt, schema: NodeSchema, ctx: ValidateCtx): Problem[] {
  const out: Problem[] = [];
  const ids = Object.keys(p);
  let outputs = 0;
  for (const id of ids) {
    const n = p[id];
    const def = schema[n.class_type];
    if (!def) { out.push({ node: id, msg: `unknown node class ${n.class_type}` }); continue; }
    if (def.output_node) outputs++;
    const infos = inputsOf(def);
    const known = new Set(infos.map((i) => i.name));
    for (const k of Object.keys(n.inputs)) if (!known.has(k)) out.push({ node: id, input: k, msg: `unknown input "${k}" on ${n.class_type}` });
    for (const i of infos) {
      const v = n.inputs[i.name];
      if (v === undefined) { if (i.required) out.push({ node: id, input: i.name, msg: `required input "${i.name}" missing` }); continue; }
      if (Array.isArray(v)) {
        const [src, slot] = v as [string, number];
        const s = p[src];
        if (!s) { out.push({ node: id, input: i.name, msg: `link to missing node ${src}` }); continue; }
        const sdef = schema[s.class_type];
        if (!sdef) continue;
        const t = sdef.output[slot];
        if (t === undefined) { out.push({ node: id, input: i.name, msg: `link to missing output ${slot} of ${s.class_type}` }); continue; }
        const want = i.type === 'COMBO' ? 'COMBO' : i.type;
        if (t !== want && want !== '*' && t !== '*') out.push({ node: id, input: i.name, msg: `type mismatch: ${s.class_type} gives ${t}, ${n.class_type}.${i.name} wants ${want}` });
        continue;
      }
      if (!i.widget) { out.push({ node: id, input: i.name, msg: `socket input "${i.name}" (${i.type}) must be a link` }); continue; }
      const o = i.opts;
      if (i.type === 'INT' || i.type === 'FLOAT') {
        if (typeof v !== 'number' || !Number.isFinite(v)) { out.push({ node: id, input: i.name, msg: `${i.name} must be a number` }); continue; }
        if (i.type === 'INT' && !Number.isInteger(v)) out.push({ node: id, input: i.name, msg: `${i.name} must be a whole number` });
        if (typeof o.min === 'number' && v < o.min) out.push({ node: id, input: i.name, msg: `${i.name}=${v} below min ${o.min}` });
        if (typeof o.max === 'number' && v > o.max) out.push({ node: id, input: i.name, msg: `${i.name}=${v} above max ${o.max}` });
      } else if (i.type === 'STRING') {
        if (typeof v !== 'string') out.push({ node: id, input: i.name, msg: `${i.name} must be text` });
      } else if (i.type === 'BOOLEAN') {
        if (typeof v !== 'boolean') out.push({ node: id, input: i.name, msg: `${i.name} must be true/false` });
      } else if (i.type === 'COMBO') {
        const folder = FILE_INPUTS[n.class_type]?.[i.name];
        if (folder) {
          if (!ctx.files[folder]?.has(String(v))) out.push({ node: id, input: i.name, msg: `${n.class_type}.${i.name}="${v}" is not a file the manifest provides in ${folder}` });
        } else if (i.options && i.options.length && !i.options.includes(v)) {
          out.push({ node: id, input: i.name, msg: `${i.name}="${String(v)}" not one of ${i.options.slice(0, 12).join(', ')}` });
        }
      }
    }
  }
  if (!outputs) out.push({ node: '-', msg: 'no output node (nothing would be saved)' });
  // cycles
  const state = new Map<string, number>();
  const visit = (id: string): boolean => {
    if (state.get(id) === 1) return false;
    if (state.get(id) === 2) return true;
    state.set(id, 1);
    for (const v of Object.values(p[id]?.inputs ?? {})) if (Array.isArray(v) && p[v[0] as string] && !visit(v[0] as string)) return false;
    state.set(id, 2);
    return true;
  };
  for (const id of ids) if (!visit(id)) { out.push({ node: id, msg: 'cycle in the graph' }); break; }
  return out;
}
