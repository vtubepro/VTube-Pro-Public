// The light show on the performers — without any extra real lights (every real light costs every lit pixel and a
// count change recompiles every shader). Each avatar's lit materials (MToon, the studio toon / toy / realistic
// materials, plain standard) get a small patch once — additive, clamped "show light" on top of their own shading:
//   3 directional colour terms (toon-banded, so anime avatars stay anime), an ambient colour, a colour rim, and an
//   optional screen-space sparkle for the mirror ball.
// CPU side (lightShow.ts → update()), per performer per frame: every beam cone is tested against the performer's
// head + chest points; the three strongest become the directional terms (direction = towards the fixture), the rest
// + the palette wash + drop hits go to the ambient. All uniforms are zero in SHOW → avatars render exactly as today.
// The patch is installed the first time a performer is seen in a room (one shader compile per material, whatever
// the lighting state), so switching states never recompiles.
import * as THREE from 'three';

export interface PerformerLightInput {
  obj: THREE.Object3D;
  /** World points: head (face centre) and chest. */
  head: THREE.Vector3;
  chest: THREE.Vector3;
}
export interface BeamLight { apex: THREE.Vector3; dir: THREE.Vector3; L: number; r: number; light: THREE.Color }

interface ShowUniforms {
  uVtpShowDir: { value: THREE.Vector3[] };
  uVtpShowCol: { value: THREE.Vector3[] };
  uVtpShowAmb: { value: THREE.Vector3 };
  uVtpShowRim: { value: THREE.Vector3 };
  uVtpShowSpark: { value: number };
  uVtpShowT: { value: number };
}

const PARS = /* glsl */ `
uniform vec3 uVtpShowDir[3];
uniform vec3 uVtpShowCol[3];
uniform vec3 uVtpShowAmb;
uniform vec3 uVtpShowRim;
uniform float uVtpShowSpark;
uniform float uVtpShowT;
vec3 vtpShowLight(vec3 n, vec3 alb, vec3 v) {
  vec3 a = alb * uVtpShowAmb;
  for (int i = 0; i < 3; i++) a += alb * uVtpShowCol[i] * smoothstep(0.0, 0.2, dot(n, uVtpShowDir[i]));   // toon band
  float f = 1.0 - clamp(dot(n, v), 0.0, 1.0);
  a += uVtpShowRim * smoothstep(0.55, 0.8, f);
  if (uVtpShowSpark > 0.0) {
    vec2 c = floor(gl_FragCoord.xy / 5.0);
    float h = fract(sin(dot(c, vec2(12.9898, 78.233)) + floor(uVtpShowT * 7.0) * 3.17) * 43758.5453);
    a += vec3(step(0.992, h)) * uVtpShowSpark;
  }
  // never blow the face out: at most ~the surface's own colour on top
  return min(a, max(alb, vec3(0.12)) * 0.85 + 0.08);
}
`;
const HOOK = '#include <tonemapping_fragment>';
const MTOON_OUT = 'gl_FragColor = vec4( col, diffuseColor.a );';

/** Patch one material (once). Works on anything whose fragment shader has a view normal and a diffuse colour. */
function patch(m: THREE.Material, U: ShowUniforms): boolean {
  const mm = m as THREE.Material & { isShaderMaterial?: boolean };
  if (m.userData.vtpShow === U) return true;
  if (m.userData.vtpShow) return true;               // shared with another performer: keep the first
  if (/^EMIT_/.test(m.name) || (m as THREE.MeshBasicMaterial).isMeshBasicMaterial || (m as THREE.PointsMaterial).isPointsMaterial || (m as THREE.LineBasicMaterial).isLineBasicMaterial) return false;
  m.userData.vtpShow = U;
  const prev = m.onBeforeCompile;
  const prevKey = m.customProgramCacheKey;
  m.onBeforeCompile = function (sh, r) {
    prev.call(this, sh, r);
    const fs = sh.fragmentShader;
    const add = 'gl_FragColor.rgb += vtpShowLight(normalize(normal), diffuseColor.rgb, normalize(vViewPosition));';
    let out: string | null = null;
    if (fs.includes('void postCorrection') && fs.includes(MTOON_OUT)) {
      // MToon (three-vrm): tone mapping lives in postCorrection(); add where the final colour is written — the LAST
      // occurrence in main (the earlier one is a debug branch) — and not on the outline pass
      const at = fs.lastIndexOf(MTOON_OUT) + MTOON_OUT.length;
      out = `${fs.slice(0, at)}\n  #ifndef OUTLINE\n  ${add}\n  #endif${fs.slice(at)}`;
    } else if (/^[ \t]*#include <normal_fragment_begin>/m.test(fs) && fs.includes(HOOK) && fs.includes('vViewPosition') && /vec4 diffuseColor/.test(fs)) {
      out = fs.replace(HOOK, `${add}\n${HOOK}`);
    }
    if (!out) return;
    Object.assign(sh.uniforms, U);
    sh.fragmentShader = out.replace('void main(', `${PARS}\nvoid main(`);
  };
  m.customProgramCacheKey = function () { return `${prevKey.call(this)}|vtpshow2`; };
  m.needsUpdate = true;
  void mm;
  return true;
}

const smooth = (e0: number, e1: number, v: number) => { const t = Math.min(1, Math.max(0, (v - e0) / (e1 - e0))); return t * t * (3 - 2 * t); };

export class PerformerLights {
  private per = new Map<THREE.Object3D, { U: ShowUniforms; mats: Set<THREE.Material>; checked: number }>();
  private tmp = new THREE.Vector3();
  private cand: { d: THREE.Vector3; c: THREE.Color; w: number }[] = [];
  /** candidate objects reused frame to frame (a candidate never outlives the performer's loop iteration) + the live set */
  private candPool: { d: THREE.Vector3; c: THREE.Color; w: number }[] = [];
  private liveSet = new Set<THREE.Object3D>();
  /** how much of a beam (apex, axis b.dir, length L, radius b.r at the far end) covers the point q: 0..1 */
  private beamCover(q: THREE.Vector3, b: BeamLight): number {
    const s = this.tmp.copy(q).sub(b.apex).dot(b.dir);
    if (s <= 0 || s > b.L + 0.3) return 0;
    const r = 0.035 + (b.r - 0.035) * Math.min(1, s / b.L);
    const d = this.tmp.copy(q).sub(b.apex).addScaledVector(b.dir, -s).length();
    return smooth(r * 1.35, r * 0.55, d);
  }
  /** ms spent in update() (EMA). */
  cost = 0;
  /** A performer's model changed: look for new materials on the next frame (not up to a second later — their programs
   *  are then built while the page's compile gate still holds for the new model, src/output.ts). */
  touch() { for (const e of this.per.values()) e.checked = -1e9; }
  /** An incoming model, still off-stage (src/output.ts stageModel): patched now with the uniforms of the performer it
   *  will be (`mount`: the actor it joins), or its own ones a new performer adopts once shown (ensure()). */
  prepare(root: THREE.Object3D, mount: THREE.Object3D | null) {
    const e = mount ? this.per.get(mount) : undefined;
    const U: ShowUniforms = e?.U ?? {
      uVtpShowDir: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uVtpShowCol: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
      uVtpShowAmb: { value: new THREE.Vector3() }, uVtpShowRim: { value: new THREE.Vector3() },
      uVtpShowSpark: { value: 0 }, uVtpShowT: { value: 0 },
    };
    root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh || !mesh.material) return;
      for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (patch(m, U)) e?.mats.add(m);
    });
  }

  /** Install on every lit material of this performer (new materials — costume changes — are picked up later). */
  private ensure(obj: THREE.Object3D, now: number) {
    let e = this.per.get(obj);
    if (!e) {
      // materials patched by an earlier room keep their uniforms: adopt them
      let old: ShowUniforms | null = null;
      obj.traverse((o) => { const mesh = o as THREE.Mesh; if (!old && mesh.isMesh && mesh.material) for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) if (m.userData.vtpShow) { old = m.userData.vtpShow as ShowUniforms; break; } });
      const U: ShowUniforms = old ?? {
        uVtpShowDir: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uVtpShowCol: { value: [new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()] },
        uVtpShowAmb: { value: new THREE.Vector3() }, uVtpShowRim: { value: new THREE.Vector3() },
        uVtpShowSpark: { value: 0 }, uVtpShowT: { value: 0 },
      };
      e = { U, mats: new Set(), checked: -1e9 };
      this.per.set(obj, e);
    }
    if (now - e.checked > 1000) {
      e.checked = now;
      const seen = new Set<THREE.Material>();
      obj.traverse((o) => {
        const mesh = o as THREE.Mesh;
        if (!mesh.isMesh || !mesh.material) return;
        for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) { seen.add(m); if (!e!.mats.has(m) && patch(m, e!.U)) e!.mats.add(m); }
      });
      // materials of an avatar this performer no longer wears (a reload, a switch, a costume) are let go: holding them
      // kept every earlier avatar alive (its textures' pictures, a 2D model's whole rig) for the whole stream
      for (const m of e.mats) if (!seen.has(m)) e.mats.delete(m);
    }
    return e;
  }

  /**
   * One frame. `wash` = ambient palette colour × strength, `rim` = rim colour × strength, `flash` = white drop hit,
   * `spark` = mirror-ball sparkle 0..1; all zero in SHOW.
   */
  update(performers: PerformerLightInput[], beams: readonly BeamLight[], camera: THREE.Camera, o: { wash: THREE.Color; rim: THREE.Color; flash: number; spark: number; t: number; now: number }) {
    const t0 = performance.now();
    const view = camera.matrixWorldInverse;
    const live = this.liveSet; live.clear();
    for (const p of performers) {
      const e = this.ensure(p.obj, o.now);
      live.add(p.obj);
      const U = e.U;
      // beams → candidate lights at this performer
      this.cand.length = 0;
      for (const b of beams) {
        const lum = b.light.r + b.light.g + b.light.b;
        if (lum < 0.01) continue;
        const best = Math.max(0, this.beamCover(p.head, b), this.beamCover(p.chest, b));
        if (best <= 0.01) continue;
        const cd = (this.candPool[this.cand.length] ??= { d: new THREE.Vector3(), c: new THREE.Color(), w: 0 });
        cd.d.copy(b.dir).negate(); cd.c.copy(b.light).multiplyScalar(best * 0.9); cd.w = lum * best;
        this.cand.push(cd);
      }
      this.cand.sort((a, b) => b.w - a.w);
      const amb = U.uVtpShowAmb.value.set(o.wash.r + o.flash, o.wash.g + o.flash, o.wash.b + o.flash);
      for (let i = 0; i < 3; i++) {
        const c = this.cand[i];
        if (c) {
          U.uVtpShowDir.value[i].copy(c.d).transformDirection(view);
          U.uVtpShowCol.value[i].set(Math.min(1.2, c.c.r), Math.min(1.2, c.c.g), Math.min(1.2, c.c.b));
        } else { U.uVtpShowCol.value[i].set(0, 0, 0); }
      }
      for (let i = 3; i < this.cand.length; i++) { const c = this.cand[i].c; amb.x += c.r * 0.35; amb.y += c.g * 0.35; amb.z += c.b * 0.35; }
      U.uVtpShowRim.value.set(o.rim.r, o.rim.g, o.rim.b);
      U.uVtpShowSpark.value = o.spark;
      U.uVtpShowT.value = o.t;
    }
    // performers who left: zero them (they may come back); one whose object left the scene is forgotten (it held the
    // avatar's whole object graph)
    for (const [obj, e] of this.per) if (!live.has(obj)) { this.zero(e.U); if (!obj.parent) this.per.delete(obj); }
    this.cost += (performance.now() - t0 - this.cost) * 0.05;
  }

  private zero(U: ShowUniforms) {
    for (let i = 0; i < 3; i++) U.uVtpShowCol.value[i].set(0, 0, 0);
    U.uVtpShowAmb.value.set(0, 0, 0); U.uVtpShowRim.value.set(0, 0, 0); U.uVtpShowSpark.value = 0;
  }

  /** Room unloaded: zero (the patched shaders stay — with zero uniforms they add nothing). */
  dispose() { for (const e of this.per.values()) this.zero(e.U); this.per.clear(); }

  count() { return { performers: this.per.size, materials: [...this.per.values()].reduce((n, e) => n + e.mats.size, 0), cost: +this.cost.toFixed(4) }; }
}
