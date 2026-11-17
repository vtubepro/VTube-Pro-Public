// No shader program is compiled twice in one room (docs/PERFORMANCE.md "Mid-show compiles").
//
// 1. Keep: three.js destroys a program the moment the last material using it is disposed, and compiles it again for the
//    next material with the same key. Engines that build a fresh material per event (a banner per announcement, an FX
//    burst, a prop) paid a full compile + link on the stream every time (measured: the voyage banner, 12 compiles in two
//    minutes of show). Every program now gets one extra reference while the room is up; leaving the room releases the
//    ones no live material uses any more (exactly what three.js would have done, later).
// 2. Twin: a page with the High / Ultra post pipeline draws the room into a linear-light target, but performer cams,
//    frame passes and some engines draw to the canvas (sRGB output): the output colour space is part of a program's
//    key, so a material warmed for one target compiled again, mid-show, the first time it met the other (React screens,
//    rain, the NPCs in a Gaming cam — measured). Every renderer.compile / compileAsync (room load, engines' own warm-ups)
//    now also compiles the other target's variant while a post pipeline is in use.
// 3. Variants: a material can declare the states it will be drawn in (material.userData.vtpVariants: `fade` = it turns
//    transparent while fading — the OPAQUE define — and `unskinned` = it is also put on plain meshes, e.g. a crowd NPC's
//    held prop). Every compile also builds those variants, once per kind of material and target.
// 4. Hidden too: three.js compiles only what is visible, but engines warm (and keep) things hidden until their moment
//    (a show sky and its beams until Preshow, a banner, an effect): every compile also covers the hidden meshes — lights
//    under hidden groups stay out, so the light count (part of every key) is the one drawn.
// 5. Sweep: about every 2 s the room is checked for meshes no compile has covered (engines that build their objects on
//    their first updates, NPCs that spawn over time, props they pick up); those are compiled (both targets, all
//    variants; programs already built are only looked up) — before they are drawn mid-show.
import * as THREE from 'three';

type Prog = { usedTimes: number; cacheKey: string; destroy(): void };

export interface ProgramKeeper {
  /** Leaving a room: the programs kept until now are the ones the next releaseUnused() may let go (the next room's
   *  engines warm up before it is bound: their programs are kept). */
  mark(): void;
  /** Release the marked programs no live material uses any more (the next room is bound), keep the rest. Returns how many went. */
  releaseUnused(): number;
  /** Compile the other output target's variants too (true while a post pipeline renders into a linear target). */
  twin: boolean;
  /** Keep programs only: no twins, hidden meshes, variants or sweeps (the studio's preview: fewer programs at load). */
  lean: boolean;
  /** A 1x1 render target: draws into it use the post target's programs (warm-up draws, src/output.ts compileGate). */
  readonly target: THREE.WebGLRenderTarget;
  stats: { kept: number; released: number; twins: number; sweeps: number; variants: number; scanMs: number; sweepMs: number; pinned: number; recent: { at: number; ms: number; n: number }[] };
  /** Compile what no compile has seen yet: meshes added since (src/stage/gfx/Graphics.ts calls it ~every 2 s). */
  sweep(scene: THREE.Object3D, camera: THREE.Camera): boolean;
  /** (diagnostics, tools/perf_show.mjs) 0 = no compile covered this object, 1 = one target, 2 = both, -1 = covered, but its material changed since */
  covered(o: THREE.Object3D): number;
}

/** What a material declares about the states it is drawn in (see 3. above). */
export interface MaterialVariants { fade?: boolean; unskinned?: boolean }
const matsOf = (o: THREE.Object3D) => { const m = (o as THREE.Mesh).material; return m ? (Array.isArray(m) ? m : [m]) : []; };
// what of a material decides its program besides the object + target: which material, its shader patches (the graphics
// presets' and engines' onBeforeCompile tags), defines, the sides it is drawn with (src/stage/gfx/singlePass.ts turns
// double-sided sheets into one pass after the room compile: the double-sided program) and, unless it declares its fade,
// transparency — any of them changed after a compile = compile again
const matSig = (m: THREE.Material) => {
  let s = `${m.uuid}:${m.customProgramCacheKey()}|${m.side}${m.forceSinglePass ? 1 : 0}${(m.userData?.vtpVariants as MaterialVariants | undefined)?.fade ? '' : m.transparent ? 't' : 'o'}`;
  const d = (m as THREE.ShaderMaterial).defines;
  if (d) for (const k in d) s += `|${k}=${d[k]}`;
  return s;
};
const objSig = (o: THREE.Object3D) => { let s = ''; for (const m of matsOf(o)) s += matSig(m) + ';'; return s; };

const installed = new WeakMap<THREE.WebGLRenderer, ProgramKeeper>();

export function installProgramKeeper(r: THREE.WebGLRenderer): ProgramKeeper {
  const had = installed.get(r);
  if (had) return had;
  const arr = r.info.programs as unknown as Prog[];
  const kept = new Set<Prog>();
  const keep = (p: Prog) => { if (!kept.has(p)) { kept.add(p); p.usedTimes++; } };
  for (const p of arr) keep(p);
  // three.js's key -> program map (private to its program cache): releasing a program must take it out of there too,
  // or the next material with that key would be handed the destroyed program. It is caught on the first new program:
  // three.js puts it in the map right after the list. Not caught (another three.js) = nothing is ever released.
  let progMap: Map<string, Prog> | null = null;
  const catchMap = (p: Prog) => {
    const set = Map.prototype.set;
    Map.prototype.set = function (this: Map<unknown, unknown>, k: unknown, v: unknown) {
      Map.prototype.set = set;
      if (v === p && k === p.cacheKey) progMap = this as Map<string, Prog>;
      return set.call(this, k, v);
    } as typeof set;
  };
  const push = arr.push;
  arr.push = function (this: Prog[], ...ps: Prog[]) {
    const n = push.apply(this, ps);
    for (const p of ps) keep(p);
    if (!progMap && ps.length === 1) catchMap(ps[0]);
    K.stats.kept = kept.size;
    return n;
  };
  const twinRT = new THREE.WebGLRenderTarget(1, 1, { depthBuffer: true });
  let inTwin = false;
  const compile = r.compile.bind(r);
  const variantSeen = new Set<string>();
  // the declared variants of the materials under `scene`, for the current target (once per kind of material + target)
  const variants = (scene: THREE.Object3D, camera: THREE.Camera, target: THREE.Scene | null) => {
    const root = target ?? ((): THREE.Scene | null => { let p: THREE.Object3D | null = scene; while (p?.parent) p = p.parent; return (p as THREE.Scene)?.isScene ? p as THREE.Scene : null; })();
    const tgt = r.getRenderTarget() ? 'rt' : 'canvas';
    scene.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      for (const mat of matsOf(o)) {
        const v = mat.userData?.vtpVariants as MaterialVariants | undefined;
        if (!v) continue;
        const sig = `${tgt}|${mat.type}|${mat.name}|${mat.customProgramCacheKey()}|${(o as THREE.SkinnedMesh).isSkinnedMesh ? 1 : 0}|${Object.keys(mesh.geometry.attributes).sort().join(',')}`;
        if (variantSeen.has(sig)) continue;
        variantSeen.add(sig);
        // (every combination but the one just compiled: faded or not — whichever it is now —, skinned or plain)
        const was = mat.transparent;
        const forms: THREE.Object3D[] = [o];
        if (v.unskinned && (o as THREE.SkinnedMesh).isSkinnedMesh) forms.push(new THREE.Mesh(mesh.geometry, mat));
        try {
          for (const f of forms) for (const tr of v.fade ? [was, !was] : [was]) {
            if (f === o && tr === was) continue;
            mat.transparent = tr;
            if (tr !== was) mat.needsUpdate = true;
            compile(f, camera, root ?? undefined);
            K.stats.variants++;
          }
        } catch { /* optional */ } finally { if (mat.transparent !== was) { mat.transparent = was; mat.needsUpdate = true; } }
      }
    });
  };
  // (hidden meshes shown for the length of a synchronous compile; lights that would come into view with them hidden)
  const unhide = (scene: THREE.Object3D) => {
    const back: [THREE.Object3D, boolean][] = [];
    const walk = (o: THREE.Object3D, hiddenUp: boolean) => {
      const light = (o as THREE.Light).isLight;
      if (light) { if (hiddenUp && o.visible) { back.push([o, true]); o.visible = false; } return; }
      const hid = !o.visible;
      if (hid) { back.push([o, false]); o.visible = true; }
      for (const c of o.children) walk(c, hiddenUp || hid);
    };
    walk(scene, false);
    return () => { for (const [o, v] of back) o.visible = v; };
  };
  r.compile = function (scene: THREE.Object3D, camera: THREE.Camera, target: THREE.Scene | null = null) {
    if (inTwin || K.lean) return compile(scene, camera, target);
    // (the scene the lights come from must not change: only `scene`'s own subtree is unhidden, and only below a target)
    const restore = target && target !== scene ? unhide(scene) : unhideMeshesOnly(scene);
    try { return compileAll(scene, camera, target); } finally { restore(); }
  } as typeof r.compile;
  // (compiling the whole lit scene: hidden meshes yes, but no hidden light or group holding a light is shown)
  const unhideMeshesOnly = (scene: THREE.Object3D) => {
    const back: THREE.Object3D[] = [];
    const holdsLight = (o: THREE.Object3D) => { let l = false; o.traverse((c) => { if ((c as THREE.Light).isLight) l = true; }); return l; };
    const walk = (o: THREE.Object3D) => {
      if (!o.visible) { if ((o as THREE.Light).isLight || holdsLight(o)) return; back.push(o); o.visible = true; }
      for (const c of o.children) walk(c);
    };
    walk(scene);
    return () => { for (const o of back) o.visible = false; };
  };
  const compileAll = (scene: THREE.Object3D, camera: THREE.Camera, target: THREE.Scene | null) => {
    const mats = compile(scene, camera, target);
    inTwin = true;
    try {
      variants(scene, camera, target);
      if (K.twin) {
        const prev = r.getRenderTarget();
        try {
          r.setRenderTarget(prev ? null : twinRT);
          for (const m of compile(scene, camera, target)) mats.add(m);
          variants(scene, camera, target);
          K.stats.twins++;
        } catch { /* optional */ } finally { r.setRenderTarget(prev); }
      }
      pinShaders(scene, camera, target);
    } finally { inTwin = false; }
    const S = K.twin ? seenTwin : seen;
    scene.traverseVisible((o) => { if ((o as THREE.Mesh).material) { const s = objSig(o); S.set(o, s); seen.set(o, s); } });
    return mats;
  };
  // 6. Shader sources: a ShaderMaterial's program key holds the ids three.js gives its shader SOURCES, and those ids
  //    go with the last material using them — an engine that rebuilds the same ShaderMaterial (the React screen's
  //    housing on every spot / size change, measured) got new ids and compiled the same program again. One holder
  //    material per source (a clone, never drawn) keeps the ids while the room is up.
  let pinnedMats = new WeakSet<THREE.Material>();
  const pinned = new Map<string, THREE.Material>();
  let pinnedMarked: Set<THREE.Material> | null = null;
  const pinShaders = (scene: THREE.Object3D, camera: THREE.Camera, target: THREE.Scene | null) => {
    const root = target ?? undefined;
    scene.traverseVisible((o) => {
      const mesh = o as THREE.Mesh, sm = mesh.material as THREE.ShaderMaterial | undefined;
      if (!sm || Array.isArray(sm) || !sm.isShaderMaterial || pinnedMats.has(sm)) return;
      pinnedMats.add(sm);
      const key = `${sm.vertexShader}\u0000${sm.fragmentShader}`;
      if (pinned.has(key)) return;
      const holder = sm.clone();
      holder.name = `${sm.name}:vtp-pin`;
      // (compiled on the same object: the same program key, so the program is only looked up)
      mesh.material = holder;
      try { compile(o, camera, root); pinned.set(key, holder); } catch { holder.dispose(); } finally { mesh.material = sm; }
      K.stats.pinned = pinned.size;
    });
  };
  // (meshes some compile has covered; seenTwin = for both targets)
  const seen = new WeakMap<THREE.Object3D, string>(), seenTwin = new WeakMap<THREE.Object3D, string>();
  let marked: Set<Prog> | null = null;
  const K: ProgramKeeper = {
    twin: false,
    lean: false,
    target: twinRT,
    stats: { kept: kept.size, released: 0, twins: 0, sweeps: 0, variants: 0, scanMs: 0, sweepMs: 0, pinned: 0, recent: [] },
    sweep(scene, camera) {
      if (K.lean) return false;
      // (unseen, or seen only by a compile that did not build the other target's variant)
      const S = K.twin ? seenTwin : seen;
      const fresh: THREE.Object3D[] = [];
      const t0 = performance.now();
      scene.traverse((o) => { if (fresh.length <= 64 && (o as THREE.Mesh).material && S.get(o) !== objSig(o)) fresh.push(o); });
      if (!fresh.length) { K.stats.scanMs = Math.max(K.stats.scanMs, performance.now() - t0); return false; }
      K.stats.sweeps++;
      const root = scene as THREE.Scene;
      try {
        // (a few new meshes: just those, lit by the room; many: the room once — programs already built are only looked up)
        if (fresh.length > 64 || !root.isScene) r.compile(scene, camera);
        else for (const o of fresh) if (S.get(o) !== objSig(o)) r.compile(o, camera, root);
      } catch { /* optional */ }
      const ms = performance.now() - t0;
      K.stats.sweepMs = Math.max(K.stats.sweepMs, ms);
      K.stats.recent.push({ at: Math.round(t0), ms: Math.round(ms * 10) / 10, n: fresh.length });
      if (K.stats.recent.length > 20) K.stats.recent.shift();
      return true;
    },
    mark() { marked = new Set(kept); pinnedMarked = new Set(pinned.values()); },
    covered(o) { const s = objSig(o); return seenTwin.get(o) === s ? 2 : seen.get(o) === s ? 1 : seenTwin.has(o) || seen.has(o) ? -1 : 0; },
    releaseUnused() {
      let n = 0;
      const old = progMap ? marked ?? new Set<Prog>() : new Set<Prog>();
      marked = null;
      variantSeen.clear();
      // (the old room's shader holders go first: their programs may then be the ones released below)
      if (pinnedMarked) for (const [k, h] of [...pinned]) if (pinnedMarked.has(h)) { pinned.delete(k); h.dispose(); }
      pinnedMarked = null; pinnedMats = new WeakSet(); K.stats.pinned = pinned.size;
      for (const p of old) {
        if (!kept.has(p)) continue;
        kept.delete(p);
        // (three.js's own release: the last user gone -> out of the cache, destroyed)
        if (--p.usedTimes === 0) {
          const i = arr.indexOf(p);
          if (i >= 0) { arr[i] = arr[arr.length - 1]; arr.pop(); }
          if (progMap!.get(p.cacheKey) === p) progMap!.delete(p.cacheKey);
          try { p.destroy(); } catch { /* lost context */ }
          n++;
        } else keep(p);
      }
      K.stats.released += n; K.stats.kept = kept.size;
      return n;
    },
  };
  installed.set(r, K);
  return K;
}
