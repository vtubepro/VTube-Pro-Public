// Everything in the shareable pack, as { path: contents } (text) and starter pictures (bytes). The build script writes
// it to public/comfy-workflows/, the helper serves / installs from it in memory, the unit test checks they agree.
// Uses only node:zlib for the starter PNGs (server + tools only; the studio never imports this file).
import zlib from 'node:zlib';
import { allKeys, buildIndex, buildWorkflow, TIERS, WORKFLOW_DEFS, WORKFLOW_PACK_VERSION, TESTED_COMFYUI } from './catalog.ts';
import type { NodeSchema } from './graph.ts';
import { CUSTOM_NODES } from './nodes.ts';
import SCHEMA_FILE from './nodeSchema.json' with { type: 'json' };

export const NODE_SCHEMA = (SCHEMA_FILE as unknown as { nodes: NodeSchema }).nodes;
export const SCHEMA_INFO = { captured: (SCHEMA_FILE as { captured: string }).captured, comfyui: (SCHEMA_FILE as { comfyui: string }).comfyui };

const json = (v: unknown) => JSON.stringify(v, null, 1) + '\n';

/** Starter pictures for the "Load Image" boxes, so a fresh workflow opens without red errors. */
export const STARTER_INPUTS: Record<string, { w: number; h: number; a: [number, number, number]; b: [number, number, number] }> = {
  'vtp_texture.png': { w: 512, h: 512, a: [200, 200, 205], b: [120, 120, 130] },
  'vtp_reference.png': { w: 512, h: 512, a: [205, 225, 150], b: [90, 120, 40] },
  'vtp_avatar.png': { w: 512, h: 768, a: [235, 235, 240], b: [180, 190, 210] },
  'vtp_character.png': { w: 512, h: 768, a: [240, 240, 236], b: [200, 205, 196] },
};

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(b: Uint8Array) { let c = 0xffffffff; for (const x of b) c = CRC[(c ^ x) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type: string, data: Uint8Array) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  Buffer.from(data).copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}
/** A plain checkerboard PNG (RGB, 8-bit). */
export function checkerPng(w: number, h: number, a: number[], b: number[], cell = 64): Buffer {
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x++) {
      const c = ((x / cell | 0) + (y / cell | 0)) % 2 ? b : a;
      raw.set(c, y * (w * 3 + 1) + 1 + x * 3);
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', new Uint8Array())]);
}
export const starterPng = (name: string) => { const s = STARTER_INPUTS[name]; return s ? checkerPng(s.w, s.h, s.a, s.b) : null; };

function readme(): string {
  const lines = [
    '# VTube Pro ComfyUI workflows',
    '',
    `Pack ${WORKFLOW_PACK_VERSION}. Tested with ComfyUI ${TESTED_COMFYUI}. Free to share.`,
    '',
    'Ready-made ComfyUI workflows for streamers: a 3D character maker (picture to 3D), textures, outfits, character sheets,',
    'room tiles, 360 skies, posters, stickers, thumbnails, overlays and emotes. Each comes in three sizes, by graphics-card memory:',
    '',
    ...Object.values(TIERS).map((t) => `- **${t.label}** (${t.id}): ${t.family}. ${t.note}`),
    '',
    'Every picture model allows commercial use. The 3D character maker uses Hunyuan3D, whose licence does not cover the EU, the UK',
    'or South Korea: it is never bundled, and VTube Pro shows that notice before you download it. Each workflow lists its models with the official link, size,',
    'SHA-256 and licence in `<name>/<size>.manifest.json`.',
    '',
    '## The easy way: ask your AI',
    '',
    'With the VTube Pro on your computer and your AI connected to it, say for example:',
    '',
    '> Set up the VTube Pro thumbnail workflow in ComfyUI',
    '',
    'VTube Pro shows every file it will download and its size. Nothing downloads until you press **Yes**. It downloads',
    'from the official pages only, checks every file, and adds the workflow to ComfyUI\'s Workflows list.',
    '',
    '## By hand',
    '',
    '1. Open ComfyUI.',
    '2. Drag the `<name>/<size>.workflow.json` file onto the ComfyUI window.',
    '3. If ComfyUI says models are missing, let it download them (or use the links in the "Start here" note).',
    '4. Change the green boxes, then press **Run**.',
    '',
    '`<name>/<size>.api.json` is the same workflow in API format, for scripts and apps.',
    '',
    '## Workflows',
    '',
    '| Workflow | What it makes | Sizes |',
    '|---|---|---|',
    ...WORKFLOW_DEFS.map((d) => `| \`${d.id}\` | ${d.forWhat} | ${Object.keys(d.tiers).join(', ')} |`),
    '',
    '## Custom nodes',
    '',
    ...CUSTOM_NODES.map((n) => `- ${n.name}: ${n.repo} at commit \`${n.commit}\` (${n.licence}).`),
    'Everything else, background removal included, is built into ComfyUI.',
    '',
  ];
  return lines.join('\n');
}

/** Every text file of the pack: relative path -> contents. */
export function packTextFiles(schema: NodeSchema = NODE_SCHEMA): Record<string, string> {
  const out: Record<string, string> = {};
  for (const { def, tier } of allKeys()) {
    const b = buildWorkflow(def, tier, schema);
    out[b.manifest.files.api] = json(b.api);
    out[b.manifest.files.ui] = json(b.ui);
    out[b.manifest.files.manifest] = json(b.manifest);
  }
  out['index.json'] = json(buildIndex(schema));
  out['README.md'] = readme();
  return out;
}
export const packBinaryFiles = (): Record<string, Buffer> =>
  Object.fromEntries(Object.keys(STARTER_INPUTS).map((n) => [`inputs/${n}`, starterPng(n)!]));
