// PRIVATE preview page for generated stops (stops.html on a private vite only; trailstops' contact sheets): renders a
// stop straight from the generator with the real World3D (+ stopview.ts) and the theme's wagon / NPCs / animals as
// static props, from the level's spectator cameras. Params: kind, theme, seed, node, bi, cam (WIDE | HERO | photo | top)
import * as THREE from 'three';
import { genStop, type GenKind } from '../../../../shared/trail/stopgen.ts';
import { viewDesc } from '../../../../shared/trail/glbLevel.ts';
import { World3D } from './world3d.ts';
import { loadThemeGlb } from './assets.ts';
import { buildNpc, buildAnimal, buildWagon } from './art.ts';

const q = new URLSearchParams(location.search);
const ANIMALS: Record<string, Record<string, { count: number; kg: number; danger: number; grabs?: string }>> = {
  bayou: { hog: { count: 4, kg: 60, danger: 0.1 }, snail: { count: 5, kg: 15, danger: 0 }, gator: { count: 1, kg: 150, danger: 0.9 }, duck: { count: 4, kg: 4, danger: 0 }, shroom_cow: { count: 1, kg: 120, danger: 0.05 }, bird_grabber: { count: 1, kg: 6, danger: 0.6, grabs: 'micro' } },
  skyisles: { slime: { count: 6, kg: 20, danger: 0 }, sky_boar: { count: 3, kg: 60, danger: 0.1 }, wyvern: { count: 1, kg: 400, danger: 0.9, grabs: 'micro' }, cloud_sheep: { count: 3, kg: 35, danger: 0 }, bird_grabber: { count: 1, kg: 6, danger: 0.6, grabs: 'micro' } },
  frontier: { deer: { count: 4, kg: 50, danger: 0 }, rabbit: { count: 5, kg: 4, danger: 0 }, bear: { count: 1, kg: 200, danger: 0.8 } },
};
const NAMES: Record<string, Record<string, string>> = {
  bayou: { store: 'Bayou General Store', river: 'Soggy Bottom River', landmark: 'Chimney Rock', finish: 'Studio Bay' },
  skyisles: { store: "Sister Plume's Sky Provisions", river: 'The Cloudwash', landmark: 'The Broken Halo', finish: 'The Sky Sanctuary' },
  frontier: { store: 'General Store', river: 'Kansas River', landmark: 'Chimney Rock', finish: 'Oregon City' },
};
const canvas = document.getElementById('c') as HTMLCanvasElement;
const world = new World3D(canvas, { shadows: true });
const resize = () => world.resize(innerWidth, innerHeight, 1);
resize(); addEventListener('resize', resize);
let frames = 0;
const tick = () => { world.update(1 / 60); world.render(); frames++; requestAnimationFrame(tick); };
tick();
const extras: THREE.Object3D[] = [];
(window as unknown as { stopsPreview: unknown }).stopsPreview = { frames: () => frames };
const log: Record<string, unknown>[] = [];
async function show(kind: GenKind, theme: string, seed: string, bi: number, camName: string, save = '') {
  const node = q.get('node') ?? (kind === 'river' ? 'river_1' : kind === 'landmark' ? 'landmark_1' : kind === 'finish' ? 'end' : kind === 'hunt' ? 'hunt:1:120' : 'start');
  for (const o of extras.splice(0)) world.scene.remove(o);
  const t0 = performance.now();
  const desc = genStop(kind, { seed, node, theme, biomeIdx: bi, biome: '', river: { depth: Number(q.get('depth') ?? 2.4 + (seed.charCodeAt(seed.length - 1) % 4) * 0.7), width: Number(q.get('width') ?? 420 + (seed.charCodeAt(seed.length - 2) % 5) * 110), swift: q.get('swift') === '1' }, animals: ANIMALS[theme], name: NAMES[theme]?.[kind], storeName: NAMES[theme]?.store, fort: q.get('fort') === '1' });
  const genMs = performance.now() - t0;
  const t1 = performance.now();
  await world.setLevel(`${kind}:${theme}:${seed}:${bi}`, viewDesc(desc));
  const viewMs = performance.now() - t1;
  const add = (o: THREE.Object3D) => { world.scene.add(o); extras.push(o); };
  const wg = (await loadThemeGlb(theme, 'wagon.glb').catch(() => null)) ?? buildWagon(theme).root;
  wg.position.set(...desc.wagon.p); wg.rotation.y = desc.wagon.yaw; add(wg);
  for (const n of desc.npcs) { const o = (await loadThemeGlb(theme, `npcs/${n.id}.glb`).catch(() => null)) ?? buildNpc(n.id, theme, n.id); o.position.set(...n.p); o.rotation.y = n.yaw; add(o); }
  for (const a of desc.animals.slice(0, 12)) { const k = a.kinds[0] ?? 'deer'; const o = (await loadThemeGlb(theme, `animals/${k}.glb`).catch(() => null)) ?? buildAnimal(k, 1.2); o.position.set(...a.p); add(o); }
  const props = await loadThemeGlb(theme, 'props.glb').catch(() => null);
  for (const it of desc.items) { const src = props?.getObjectByName(`PROP_${it.item}`); if (!src) continue; const o = src.clone(); o.position.set(it.p[0], it.p[1] - 0.2, it.p[2]); o.rotation.y = it.yaw ?? 0; add(o); }
  const A = desc.size[0];
  const cams: Record<string, { p: number[]; look: number[]; fov: number }> = { ...Object.fromEntries(Object.entries(desc.cams).map(([k, v]) => [k.replace('CAM_SPECT_', ''), v])),
    top: { p: [A * 0.5, A * 0.75, A * 0.62], look: [0, 0, 0], fov: 55 } };
  const c = cams[camName] ?? cams.WIDE;
  world.camera.position.set(c.p[0], c.p[1], c.p[2]); world.camera.fov = c.fov; world.camera.updateProjectionMatrix();
  world.camera.lookAt(new THREE.Vector3(c.look[0], c.look[1], c.look[2]));
  world.focus(new THREE.Vector3(c.look[0], c.look[1], c.look[2]));
  let tris = 0; world.levelRoot.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.visible && m.geometry && !m.userData.isOutline) { const n = (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3; tris += (m as THREE.InstancedMesh).isInstancedMesh ? n * (m as THREE.InstancedMesh).count : n; } });
  document.getElementById('tag')!.textContent = `${theme} · ${kind} · ${seed} · biome ${bi} · ${camName}`;
  const f0 = frames, tw = performance.now(); await new Promise<void>((res) => { const w = () => (frames - f0 > 45 || performance.now() - tw > 1500 ? res() : setTimeout(w, 30)); w(); });
  if (save) {
    world.render();
    const url = canvas.toDataURL('image/jpeg', 0.86);
    await fetch(`http://127.0.0.1:5527/save?name=${encodeURIComponent(save)}`, { method: 'POST', body: url, mode: 'no-cors' }).catch((e) => console.warn('save failed', e));
  }
  const rec = { theme, kind, seed, bi, cam: camName, genMs: +genMs.toFixed(1), viewMs: +viewMs.toFixed(0), levelTris: Math.round(tris), viewTris: world.stopStats?.tris, sliceMs: world.stopStats?.sliceMs, draws: world.renderer.info.render.calls, msgKB: +(JSON.stringify(viewDesc(desc)).length / 1024).toFixed(1) };
  log.push(rec);
  return rec;
}

if (q.get('batch')) {
  const themes = (q.get('themes') ?? 'frontier').split(','), kinds = (q.get('kinds') ?? 'store,river,hunt,landmark,finish').split(',') as GenKind[];
  const seeds = (q.get('seeds') ?? 'SWAMP-0420,RUN-7351,DAILY-2026-09-27').split(','), camsL = (q.get('cams') ?? 'WIDE,top').split(',');
  for (const th of themes) for (const k of kinds) for (let si = 0; si < seeds.length; si++) for (const cm of camsL) await show(k, th, seeds[si], si % 3, cm, `${th}_${k}_${si}_${cm}.jpg`);
  await fetch('http://127.0.0.1:5527/save?name=batch_log.json', { method: 'POST', body: 'data:application/json;base64,' + btoa(JSON.stringify(log)), mode: 'no-cors' });
  (window as unknown as { batchDone: boolean }).batchDone = true;
} else await show((q.get('kind') ?? 'store') as GenKind, q.get('theme') ?? 'frontier', q.get('seed') ?? 'SWAMP-0420', Number(q.get('bi') ?? 0), q.get('cam') ?? 'WIDE', q.get('save') ?? '');
(window as unknown as { stopsPreview: unknown }).stopsPreview = { log, frames: () => frames, info: world.renderer.info.render };
