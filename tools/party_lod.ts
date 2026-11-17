// Make a party version of a GLB / VRM (server/partyLod.ts). The server runs this as its low-priority worker (--json);
// by hand it prints the per-region report.
//   npx tsx tools/party_lod.ts <model.glb> <out.glb> [--max 200000] [--costume <costume.glb> <costume_out.glb>]
import fs from 'node:fs';
import { buildPartyLod } from '../server/partyLod.ts';
import { TRIS_MAX } from '../shared/modelStats.ts';

const a = process.argv.slice(2);
const take = (k: string, n: number) => { const i = a.indexOf(k); return i >= 0 ? a.splice(i, n + 1).slice(1) : null; };
const max = Number(take('--max', 1)?.[0] ?? TRIS_MAX) || TRIS_MAX;
const cos = take('--costume', 2);
const json = a.includes('--json'); if (json) a.splice(a.indexOf('--json'), 1);
const [src, out] = a;
if (!src || !out) { console.log('usage: npx tsx tools/party_lod.ts <model.glb> <out.glb> [--max 200000] [--costume <c.glb> <c_out.glb>]'); process.exit(2); }
const t0 = performance.now();
if (json) process.on('uncaughtException', (e) => { console.log(JSON.stringify({ error: e.message })); process.exit(3); });
const r = await buildPartyLod([new Uint8Array(fs.readFileSync(src)), ...(cos ? [new Uint8Array(fs.readFileSync(cos[0]))] : [])], max);
fs.writeFileSync(out, r.files[0]);
if (cos) fs.writeFileSync(cos[1], r.files[1]);
if (json) { console.log(JSON.stringify({ from: r.from, to: r.to, hidden: r.hidden, target: r.target, warnings: r.warnings })); process.exit(0); }
console.log(JSON.stringify({ from: r.from, to: r.to, hidden: r.hidden, target: r.target, ms: Math.round(performance.now() - t0), warnings: r.warnings, groups: r.groups.filter((g) => g.from > 0).map((g) => `${g.file}:${g.mesh}/${g.material} ${g.region} ${g.from}→${g.to} lock ${g.locked} err ${g.error}`) }, null, 1));
