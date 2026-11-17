#!/usr/bin/env node
// Headless smoke test of a running VTube Pro server (no browser, no GPU):
//   node tools/setup/smoke.mjs [--port 5191] [--host 127.0.0.1]
// Checks the studio + OBS pages, /api/status, every builtin avatar's model + costume files (glTF/VRM header),
// every room's scene files, and that no an earlier internal build content is present. Read-only: it never saves or broadcasts.
const argv = process.argv.slice(2);
const arg = (k, d) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] ? argv[i + 1] : d; };
const PORT = Number(arg('--port', process.env.VTP_PORT ?? 5191));
const BASE = `http://${arg('--host', '127.0.0.1')}:${PORT}`;

let fails = 0, checks = 0;
const ok = (m) => { checks++; console.log(`  ok   ${m}`); };
const bad = (m) => { checks++; fails++; console.log(`  FAIL ${m}`); };

async function get(p) {
  const r = await fetch(BASE + p, { headers: { 'cache-control': 'no-cache' } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, type: r.headers.get('content-type') ?? '', buf };
}
async function page(p, needle) {
  try {
    const r = await get(p);
    const t = r.buf.toString('utf8');
    if (r.status === 200 && t.includes(needle)) ok(`${p} (${r.buf.length} B)`); else bad(`${p} -> ${r.status}`);
    // every script / stylesheet the page references must load too
    for (const m of t.matchAll(/(?:src|href)="(\/assets\/[^"]+)"/g)) {
      const a = await get(m[1]);
      if (a.status === 200 && a.buf.length > 0) ok(`  ${m[1]}`); else bad(`  ${m[1]} -> ${a.status}`);
    }
  } catch (e) { bad(`${p}: ${e.message}`); }
}
async function model(p, label) {
  try {
    const r = await get(p);
    const magic = r.buf.subarray(0, 4).toString('latin1');
    if (r.status === 200 && magic === 'glTF') ok(`${label} ${(r.buf.length / 1048576).toFixed(1)} MB`);
    else bad(`${label} ${p} -> ${r.status} magic=${JSON.stringify(magic)}`);
  } catch (e) { bad(`${label}: ${e.message}`); }
}
const enc = (f) => f.split(/[\\/]/).map(encodeURIComponent).join('/');

console.log(`VTube Pro smoke test against ${BASE}`);
try {
  // /api/settings is instant (/api/status also probes Blender + ComfyUI, pass --status to include it)
  const s = await get('/api/settings');
  if (s.status === 200 && s.buf.toString().includes('comfyUrl')) ok('/api/settings'); else bad(`/api/settings -> ${s.status}`);
  if (argv.includes('--status')) {
    const st = await get('/api/status');
    if (st.status === 200) ok(`/api/status blender=${JSON.parse(st.buf.toString()).blender?.available ? 'yes' : 'no (optional)'}`);
    else bad(`/api/status -> ${st.status}`);
  }
} catch (e) {
  console.log(`  FAIL server not reachable at ${BASE}: ${e.message}`);
  process.exit(2);
}
await page('/', '<html');
await page('/output.html', '<html');

console.log('avatars:');
const avatars = JSON.parse((await get('/api/avatars')).buf.toString());
if (!avatars.length) bad('no avatars listed');
for (const a of avatars) {
  if (/nux/i.test(a.id) || /nux/i.test(a.name ?? '')) bad(`Nux content present: ${a.id}`);
  await model(`/library/${encodeURIComponent(a.id)}/${enc(a.modelFile)}`, `${a.id} (${a.name})`);
  for (const t of [a.thumbnail, ...(a.costumes ?? []).map((c) => c.thumbnail)].filter((x) => typeof x === 'string')) {
    const r = await get(`/library/${encodeURIComponent(a.id)}/${enc(t)}`);
    if (r.status !== 200) bad(`  ${a.id} thumbnail ${t} -> ${r.status}`);
  }
  for (const c of a.costumes ?? []) {
    const f = c.file ?? c.modelFile;
    if (typeof f === 'string' && /\.(glb|vrm)$/i.test(f)) await model(`/library/${encodeURIComponent(a.id)}/${enc(f)}`, `  costume ${c.id}`);
  }
}

console.log('rooms:');
const scenes = JSON.parse((await get('/api/scenes')).buf.toString());
for (const s of scenes) {
  if (!s.ready) { bad(`${s.id} not ready (model missing)`); continue; }
  await model(`/api/scenes/${encodeURIComponent(s.id)}/file/${enc(s.model)}`, `${s.id}`);
  const extras = [s.town ? (s.town.units ?? 'town/town_units.glb') : null, s.traffic ? (s.traffic.ships ?? 'traffic/ships.glb') : null];
  for (const extra of extras.filter((x) => typeof x === 'string')) {
    await model(`/api/scenes/${encodeURIComponent(s.id)}/file/${enc(extra)}`, `  ${s.id} ${extra}`);
  }
}
console.log(`\n${checks - fails}/${checks} checks passed · ${avatars.length} avatars · ${scenes.length} rooms`);
process.exit(fails ? 1 : 0);
