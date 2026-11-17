// The Trail — PRIVATE animation lab (trail.html?test=anim on a private vite only; no sim, no network, no bus):
// library avatars of several sizes side by side on a 1 m checker floor (foot sliding shows against the squares), driven
// by synthetic host samples exactly like the game's view drives PlayerAvatar.update, so every state can be judged and
// screenshotted: idle stroll run sprint carry strain push sit drive jump swim ragdoll emote tour.
// Params: &av=robot (library avatar ids, one row each) &h=0.4,1.7,3.2 (heights) &st=run &cam=34|side|front
//         &anim=0 (procedural walk instead of the clips, for comparisons) &meter=1 (weight meters on held crates)
// window.animLab: { set(state), avatars, perfReport(), debug() }
import * as THREE from 'three';
import { sizeStats } from '../../../../shared/trail/sizes.ts';
import { ANIM, F } from '../../../../shared/trail/wire.ts';
import type { GameState } from '../../../../shared/trail/types.ts';
import { PlayerAvatar } from './avatars.ts';
import { World3D } from './world3d.ts';
import { EntView } from './ents.ts';
import { WeightMeters, type WeightSource } from './weight.ts';
import { animConfig, loadTrailClips } from './anim.ts';
import { toon, unitBox } from './kit.ts';

const fa = new THREE.Vector3(), fb2 = new THREE.Vector3();
let tracing: { i: number; n: number; out: unknown[]; done: (o: unknown[]) => void } | null = null;
const EMOTES = ['wave', 'point', 'facepalm', 'cheer', 'laugh', 'soundbite', 'dance', 'sit'];
const TOUR = ['idle', 'stroll', 'run', 'sprint', 'carry', 'strain', 'push', 'sit', 'drive', 'jump', 'swim', 'ragdoll', 'emote'];

export async function startAnimLab(root: HTMLElement, q: URLSearchParams) {
  animConfig.enabled = q.get('anim') !== '0';
  const ids = (q.get('av') ?? 'robot').split(',').filter(Boolean);
  const hs = (q.get('h') ?? '0.4,1.7,3.2').split(',').map(Number).filter((x) => x > 0);
  const canvas = document.createElement('canvas');
  canvas.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block';
  root.style.position = 'fixed'; root.style.inset = '0';
  root.append(canvas);
  const world = new World3D(canvas, { shadows: q.get('shadows') !== '0' });
  world.scene.fog = null;
  const resize = () => world.resize(Math.max(1, root.clientWidth), Math.max(1, root.clientHeight));
  new ResizeObserver(resize).observe(root); resize();
  // 1 m checker floor
  const c = document.createElement('canvas'); c.width = c.height = 128;
  const g = c.getContext('2d')!;
  g.fillStyle = '#b9ae8c'; g.fillRect(0, 0, 128, 128); g.fillStyle = '#a2966f'; g.fillRect(0, 0, 64, 64); g.fillRect(64, 64, 64, 64);
  g.strokeStyle = 'rgba(60,50,30,.35)'; g.lineWidth = 2; g.strokeRect(0, 0, 128, 128);
  const tex = new THREE.CanvasTexture(c); tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.repeat.set(200, 200); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 8;
  tex.magFilter = THREE.NearestFilter;
  const floor = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshLambertMaterial({ map: tex }));
  floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
  world.levelRoot.add(floor);
  await loadTrailClips();
  // bodies: one row per avatar id, one lane per height
  type Body = { a: PlayerAvatar; h: number; x: number; z: number; crate: THREE.Mesh; bench: THREE.Mesh; y: number; ent: EntView; pent: EntView; slide: { lastSide: number; last: THREE.Vector3; sum: number; n: number; body: number; minY: number } };
  const bodies: Body[] = [];
  let x0 = 0;
  const colors = ['#ff7a59', '#59b6ff', '#a4e05a', '#ffd059', '#d38cff', '#59ffd0'];
  ids.forEach((id, r) => {
    hs.forEach((h, k) => {
      const a = new PlayerAvatar(`lab${r}_${k}`, `${id} · ${h} m`, colors[(r * hs.length + k) % colors.length]);
      a.setHeight(h);
      if (q.get('g')) a.anim.forceGait = Number(q.get('g'));
      if (q.get('warp')) a.anim.forceWarp = Number(q.get('warp'));
      if (q.get('lock') === '0') a.anim.footLock = false;
      void a.load({ kind: 'lib', avatarId: id });
      world.entRoot.add(a.pivot);
      const crate = new THREE.Mesh(unitBox(), toon('#8a6a44')); crate.castShadow = true; crate.visible = false; world.entRoot.add(crate);
      const bench = new THREE.Mesh(unitBox(), toon('#6b4a2e')); bench.castShadow = bench.receiveShadow = true; bench.visible = false; world.entRoot.add(bench);
      const x = x0 + h * 0.6; x0 += Math.max(0.9, h * 1.25);
      const ent = new EntView({ id: 1000 + bodies.length, kind: 'prop', sub: 'crate', size: [0.2, 0.2, 0.2], shape: 'box', mass: 20 });
      const pent = new EntView({ id: 2000 + bodies.length, kind: 'player', sub: `lab${r}_${k}`, size: [0.2, h / 2 - 0.2, 0], shape: 'capsule' });
      bodies.push({ a, h, x, z: 0, crate, bench, y: 0, ent, pent, slide: { lastSide: -1, last: new THREE.Vector3(), sum: 0, n: 0, body: 0, minY: 1e9 } });
    });
  });
  const cx = x0 / 2;
  // weight meters on the held crates (a fake view: players + crates as entities)
  const meters = new WeightMeters(world.entRoot);
  const players = new Map<string, EntView>();
  const entMap = new Map<number, EntView>();
  for (const b of bodies) { players.set(b.pent.info.sub, b.pent); entMap.set(b.ent.info.id, b.ent); }
  const avMap = new Map(bodies.map((b) => [b.a.id, b.a] as const));
  const labState = { players: bodies.map((b) => ({ id: b.a.id, name: b.a.name, role: 'banker', height: b.h, cls: 'normal', color: '#fff', ready: true, connected: true, host: false })), stop: null } as unknown as GameState;
  const src: WeightSource = { ents: { map: entMap, players: () => players }, avatars: avMap, state: labState, o: { link: { myId: '' }, spectator: true } };
  const showMeters = q.get('meter') !== '0';

  let state = q.get('st') ?? 'tour';
  let stT = 0, tourI = 0, emoteI = 0, dist = 0;
  const set = (s: string) => { state = s; stT = 0; dist = 0; for (const b of bodies) b.z = 0; if (s === 'emote') emoteI = 0; };
  const ft: number[] = [];
  let cam = q.get('cam') ?? '34';
  let focus = Number(q.get('focus') ?? -1);
  let natK = Number(q.get('natk') ?? 1);
  let last = performance.now();
  const smp = { p: new THREE.Vector3(), q: new THREE.Quaternion(), yaw: 0, flags: 0, anim: 0, speed: 0, hold: 0 };
  const loop = () => {
    requestAnimationFrame(loop);
    const now = performance.now();
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    ft.push(dt * 1000); if (ft.length > 1200) ft.shift();
    stT += dt;
    let st = state;
    if (state === 'tour') { if (stT > 5) { stT = 0; tourI = (tourI + 1) % TOUR.length; for (const b of bodies) b.z = 0; } st = TOUR[tourI]; }
    if (st === 'emote' && stT > emoteI * 3.4) { const id = EMOTES[emoteI % EMOTES.length]; for (const b of bodies) b.a.playEmote(id); emoteI++; }
    const center = new THREE.Vector3();
    for (const b of bodies) {
      const ss = sizeStats(b.h);
      let speed = 0, anim: number = ANIM.idle, flags = 0, hold = 0, y = 0, strain = 0;
      const cyc = stT % 2.2;
      switch (st) {
        case 'stroll': speed = ss.walk * 0.35; anim = ANIM.walk; break;
        case 'natS': speed = 8.25 * Math.sqrt(b.a.anim.debug.kS || 1) * natK; anim = ANIM.sprint; break;
        case 'natJ': speed = 5.357 * Math.sqrt(b.a.anim.debug.kS || 1) * natK * 0.6; anim = ANIM.run; break;
        case 'nat': speed = 0.975 * Math.sqrt(b.a.anim.debug.kS || 1) * natK; anim = ANIM.walk; break;
        case 'run': speed = ss.walk; anim = ANIM.walk; break;
        case 'sprint': speed = ss.sprint; anim = ANIM.sprint; break;
        case 'carry': speed = ss.walk * 0.8; anim = ANIM.carry; hold = b.ent.info.id; strain = 0.45; break;
        case 'strain': speed = ss.walk * 0.4; anim = ANIM.strain; hold = b.ent.info.id; strain = 1.8; break;
        case 'push': speed = 0.5 * Math.sqrt(b.h / 1.7); anim = ANIM.push; break;
        case 'sit': anim = ANIM.sit; flags = F.seated; y = b.h * 0.27; break;
        case 'drive': anim = ANIM.drive; flags = F.seated; y = b.h * 0.27; break;
        case 'swim': speed = ss.walk * 0.35; anim = ANIM.swim; flags = F.water; break;
        case 'jump': {
          const T = 0.95 * Math.sqrt(ss.jump / 0.9);
          const t = cyc - 0.6;
          if (t > 0 && t < T) { const v0 = 9.81 * T / 2; y = v0 * t - 4.9 * t * t; anim = t < T / 2 ? ANIM.jump : ANIM.fall; }
          speed = ss.walk * 0.3;
          break;
        }
        case 'ragdoll': if (cyc < 1.2) { anim = ANIM.ragdoll; flags = F.ragdoll; } break;
      }
      b.z -= speed * dt;
      if (b.z < -40) b.z = 0;
      const e = b.ent;
      e.info.mass = st === 'strain' ? sizeStats(b.h).lift * 1.8 : sizeStats(b.h).lift * 0.45;
      smp.yaw = 0; smp.anim = anim; smp.flags = flags; smp.speed = speed; smp.hold = hold;
      smp.p.set(b.x, y + b.h / 2, b.z);
      if (flags & F.ragdoll) smp.q.setFromEuler(new THREE.Euler(-Math.min(1.45, cyc * 4), 0, Math.sin(cyc * 5) * 0.3)); else smp.q.identity();
      if (flags & F.ragdoll) smp.p.y = b.h * 0.25;
      b.pent.cur.p.copy(smp.p); b.pent.cur.hold = focus >= 0 && bodies[focus] !== b ? 0 : hold; b.pent.cur.flags = flags;
      b.a.strain = strain;
      b.a.update(dt, now, smp, world.camera.aspect);
      // props: the held crate in front of the chest; the bench under a sitter
      const cs = Math.min(0.9, Math.max(0.12, Math.cbrt(e.info.mass / 250)));
      b.crate.visible = hold !== 0;
      b.crate.scale.setScalar(cs * (st === 'strain' ? 0.7 : 0.6));
      b.crate.position.set(b.x, (st === 'strain' ? b.h * 0.42 : b.h * 0.55), b.z - b.h * 0.22 - cs * 0.3);
      e.cur.p.copy(b.crate.position); e.info.size = [cs * 0.4, cs * 0.4, cs * 0.4];
      b.bench.visible = st === 'sit' || st === 'drive';
      b.bench.scale.set(b.h * 0.5, y, b.h * 0.35); b.bench.position.set(b.x, y / 2, b.z + b.h * 0.03);
      const hide = focus >= 0 && bodies[focus] !== b;
      if (hide) { b.a.pivot.visible = false; b.crate.visible = false; b.bench.visible = false; } else b.a.pivot.visible = true;
      center.add(b.a.pivot.position);
      if (tracing && tracing.i === bodies.indexOf(b) && b.a.runtime?.humanoid) {
        const hm = b.a.runtime.humanoid; hm.getRawBoneNode('leftFoot')?.getWorldPosition(fa); hm.getRawBoneNode('rightFoot')?.getWorldPosition(fb2);
        tracing.out.push({ t: +stT.toFixed(3), z: +b.z.toFixed(4), l: [+fa.x.toFixed(4), +fa.y.toFixed(4), +fa.z.toFixed(4)], r: [+fb2.x.toFixed(4), +fb2.y.toFixed(4), +fb2.z.toFixed(4)], ph: +b.a.anim.phase.toFixed(3), lk: (b.a.anim as unknown as { lockSt: { on: boolean; w: number }[] }).lockSt.map((x) => +(x.on ? x.w : -x.w).toFixed(2)) });
        if (tracing.out.length >= tracing.n) { tracing.done(tracing.out); tracing = null; }
      }
      // foot slide meter: horizontal speed of the planted (lower) foot vs the body's speed
      const hum = b.a.runtime?.humanoid;
      if (hum && speed > 0.05 && !(flags & (F.ragdoll | F.seated)) && anim !== ANIM.jump && anim !== ANIM.fall) {
        const lf = hum.getRawBoneNode('leftFoot'), rf = hum.getRawBoneNode('rightFoot');
        if (lf && rf) {
          b.a.pivot.updateWorldMatrix(true, true);
          lf.getWorldPosition(fa); rf.getWorldPosition(fb2);
          const side = fa.y < fb2.y ? 0 : 1, f = side ? fb2 : fa;
          b.slide.minY = Math.min(b.slide.minY, f.y);
          if (side === b.slide.lastSide && f.y < b.slide.minY + 0.02 * b.h) { b.slide.sum += Math.hypot(f.x - b.slide.last.x, f.z - b.slide.last.z) / dt; b.slide.body += speed; b.slide.n++; }
          b.slide.lastSide = side; b.slide.last.copy(f);
        }
      } else b.slide.lastSide = -1;
    }
    if (showMeters) meters.update(src, dt);
    center.divideScalar(Math.max(1, bodies.length));
    const H = Math.max(...hs);
    const tgt = new THREE.Vector3(cx, H * 0.42, center.z);
    let d = Math.max(3, x0 * 0.72 + H * 0.5);
    // &focus=<i> frames one body
    let Hc = H;
    const fb = focus >= 0 ? bodies[focus] : null;
    if (fb) { tgt.set(fb.x, fb.h * 0.5, fb.a.pivot.position.z); d = fb.h * 1.35 + 0.15; Hc = fb.h; }
    if (cam === 'side') world.camera.position.set(tgt.x + d * 1.1, tgt.y + Hc * 0.1, tgt.z);
    else if (cam === 'front') world.camera.position.set(tgt.x, tgt.y + Hc * 0.15, tgt.z - d);
    else world.camera.position.set(tgt.x + d * 0.62, tgt.y + Hc * 0.35, tgt.z - d * 0.78);
    world.camera.fov = 42; world.camera.lookAt(tgt); world.camera.updateProjectionMatrix();
    world.focus(tgt);
    world.update(dt);
    world.render();
  };
  requestAnimationFrame(loop);
  const perfReport = () => {
    const a = [...ft].sort((x, y) => x - y), n = a.length;
    const p = (k: number) => (n ? Math.round(a[Math.min(n - 1, Math.floor(n * k))] * 10) / 10 : 0);
    return { frames: n, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: n ? Math.round(a[n - 1]) : 0 };
  };
  (window as unknown as { animLab: unknown }).animLab = {
    set, bodies, get state() { return state; }, view: (c: string, f = -1) => { cam = c; focus = f; }, natK: (k: number) => { natK = k; }, perfReport, anim: animConfig,
    trace: (i: number, n = 120) => new Promise((done) => { tracing = { i, n, out: [], done }; }),
    slideReset: () => { for (const b of bodies) { b.slide.sum = b.slide.body = b.slide.n = 0; b.slide.minY = 1e9; } },
    debug: () => bodies.map((b) => ({ slide: b.slide.n ? +(b.slide.sum / b.slide.body).toFixed(3) : null, id: b.a.id, h: b.h, loaded: !!b.a.runtime, standIn: b.a.isStandIn, status: b.a.status, active: b.a.anim.active, why: b.a.anim.why, st: b.a.anim.state, ...b.a.anim.debug })),
    /** time one call of every avatar's update (ms per frame for all bodies) */
    bench: (n = 200) => { const t0 = performance.now(); for (let i = 0; i < n; i++) for (const b of bodies) b.a.update(1 / 60, performance.now(), smp, 1.7); return (performance.now() - t0) / n; },
  };
}
