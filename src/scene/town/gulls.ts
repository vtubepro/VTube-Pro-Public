// Town engine — gulls. One InstancedMesh (a ~12-triangle gull built in code, wings flapped in the vertex shader from a
// per-instance phase / flap amount). Deterministic from the town clock: most circle the harbour on banked loops
// (flap bursts, then glide), a few cycle "fly in → land on a PERCH_xx post → preen → take off". Cost: one draw,
// ~14 matrix writes per frame.
import * as THREE from 'three';

interface Loop { c: THREE.Vector3; r: number; w: number; ph: number; bob: number; tilt: number }
interface Lander { perch: THREE.Vector3; loop: Loop; period: number; off: number }

function gullGeometry(): THREE.BufferGeometry {
  // body along +Z (forward), wings along ±X; attribute `wing` = 0 body, 0..1 across the span (flap weight)
  const P: number[] = [], W: number[] = [], C: number[] = [];
  const tri = (a: number[], b: number[], c: number[], wa: number, wb: number, wc: number, col: number[]) => {
    P.push(...a, ...b, ...c); W.push(wa, wb, wc); for (let i = 0; i < 3; i++) C.push(...col);
  };
  const white = [0.93, 0.93, 0.9], grey = [0.62, 0.64, 0.66], dark = [0.14, 0.14, 0.16], beak = [0.9, 0.66, 0.2];
  // body (a flattened diamond)
  tri([0, 0, 0.22], [0.06, 0, 0], [0, 0.05, 0], 0, 0, 0, white); tri([0, 0, 0.22], [0, 0.05, 0], [-0.06, 0, 0], 0, 0, 0, white);
  tri([0, 0, 0.22], [-0.06, 0, 0], [0, -0.04, 0], 0, 0, 0, white); tri([0, 0, 0.22], [0, -0.04, 0], [0.06, 0, 0], 0, 0, 0, white);
  tri([0, 0, -0.2], [0, 0.05, 0], [0.06, 0, 0], 0, 0, 0, white); tri([0, 0, -0.2], [-0.06, 0, 0], [0, 0.05, 0], 0, 0, 0, white);
  tri([0, 0, -0.2], [0, -0.04, 0], [-0.06, 0, 0], 0, 0, 0, grey); tri([0, 0, -0.2], [0.06, 0, 0], [0, -0.04, 0], 0, 0, 0, grey);
  tri([0, 0.005, 0.22], [0.012, 0, 0.3], [-0.012, 0, 0.3], 0, 0, 0, beak);
  for (const s of [1, -1]) {
    // inner wing + outer wing (black tip)
    tri([0.05 * s, 0.01, 0.06], [0.05 * s, 0.01, -0.05], [0.32 * s, 0.01, 0.0], 0.05, 0.05, 0.6, grey);
    tri([0.32 * s, 0.01, 0.0], [0.05 * s, 0.01, -0.05], [0.3 * s, 0.01, -0.08], 0.6, 0.05, 0.6, grey);
    tri([0.32 * s, 0.01, 0.0], [0.3 * s, 0.01, -0.08], [0.55 * s, 0.01, -0.1], 0.6, 0.6, 1.0, dark);
  }
  // tail
  tri([0, 0.01, -0.18], [0.07, 0.01, -0.3], [-0.07, 0.01, -0.3], 0, 0, 0, white);
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  g.setAttribute('wing', new THREE.Float32BufferAttribute(W, 1));
  g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3));
  g.computeVertexNormals();
  return g;
}

function hash(n: number) { const x = Math.sin(n * 127.1 + 311.7) * 43758.5453; return x - Math.floor(x); }

export class Gulls {
  readonly mesh: THREE.InstancedMesh;
  private loops: Loop[] = [];
  private landers: Lander[] = [];
  private phase: THREE.InstancedBufferAttribute;
  private flap: THREE.InstancedBufferAttribute;
  private uTime = { value: 0 };
  private m = new THREE.Matrix4(); private q = new THREE.Quaternion(); private e = new THREE.Euler(0, 0, 0, 'YXZ');
  private p = new THREE.Vector3(); private s = new THREE.Vector3(1, 1, 1);

  private waterY = 0;
  constructor(count: number, perches: THREE.Vector3[], centre: THREE.Vector3) {
    this.waterY = centre.y;
    const geo = gullGeometry();
    const nLand = Math.min(perches.length, Math.max(0, Math.round(count * 0.3)));
    const n = count;
    this.phase = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    this.flap = new THREE.InstancedBufferAttribute(new Float32Array(n), 1);
    geo.setAttribute('aPhase', this.phase);
    geo.setAttribute('aFlap', this.flap);
    const mat = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
    mat.name = 'vtp:town:gulls';
    const uTime = this.uTime;
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uTime = uTime;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nattribute float wing; attribute float aPhase; attribute float aFlap; uniform float uTime;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          float fl = sin(uTime * 11.0 + aPhase) * aFlap;
          float glideDip = (1.0 - aFlap) * 0.12;
          transformed.y += wing * (fl * 0.28 + glideDip * wing) ;
          transformed.x *= 1.0 - wing * abs(fl) * 0.12;`);
    };
    this.mesh = new THREE.InstancedMesh(geo, mat, n);
    this.mesh.name = 'vtp:town:gulls';
    this.mesh.frustumCulled = false;
    for (let i = 0; i < n; i++) {
      const r = 8 + hash(i + 1) * 26;
      const loop: Loop = {
        c: new THREE.Vector3(centre.x + (hash(i + 11) - 0.5) * 60, centre.y + 9 + hash(i + 21) * 16, centre.z - 12 - hash(i + 31) * 50),
        r, w: (0.18 + hash(i + 41) * 0.14) * (hash(i + 51) < 0.5 ? 1 : -1) * (14 / r), ph: hash(i + 61) * Math.PI * 2, bob: 1 + hash(i + 71) * 2, tilt: 0.1 + hash(i + 81) * 0.25,
      };
      this.loops.push(loop);
      this.phase.setX(i, hash(i + 91) * 6.28);
    }
    for (let k = 0; k < nLand; k++) {
      const pi = Math.floor(hash(k + 101) * perches.length) % perches.length;
      this.landers.push({ perch: perches[(pi + k * 3) % perches.length], loop: this.loops[k], period: 46 + hash(k + 111) * 30, off: hash(k + 121) * 100 });
    }
    this.phase.needsUpdate = true;
  }

  private loopPos(l: Loop, t: number, out: THREE.Vector3) {
    const a = l.ph + t * l.w;
    out.set(l.c.x + Math.cos(a) * l.r, l.c.y + Math.sin(t * 0.37 + l.ph) * l.bob, l.c.z + Math.sin(a) * l.r * 0.7);
    return out;
  }

  update(t: number, storm: number) {
    this.uTime.value = t % 3600;
    const n = this.loops.length;
    const a = new THREE.Vector3(), b = new THREE.Vector3();
    for (let i = 0; i < n; i++) {
      const l = this.loops[i];
      const land = i < this.landers.length ? this.landers[i] : null;
      let flap = 0; let yaw = 0, roll = 0, pitch = 0;
      let placed = false;
      if (land) {
        // 0..0.45 circling, 0.45..0.55 glide in, 0.55..0.9 perched, 0.9..1 take off
        const u = ((t + land.off) % land.period) / land.period;
        const tIn = land.period * 0.45, tOut = land.period * 0.9;
        if (u >= 0.45 && u < 0.9) {
          const perchT = t;
          if (u < 0.55) {
            const k = (u - 0.45) / 0.1;
            const start = this.loopPos(l, (t + land.off) - ((u - 0.45) * land.period) + 0 * tIn, a);
            const e = k * k * (3 - 2 * k);
            this.p.lerpVectors(start, land.perch, e);
            this.p.y += Math.sin(Math.PI * k) * 1.5 + (land.perch.y - this.p.y) * 0 ;
            b.subVectors(land.perch, start);
            yaw = Math.atan2(b.x, b.z);
            flap = k > 0.7 ? 1 : 0.2;
            pitch = -0.2 * (1 - k);
          } else {
            this.p.copy(land.perch);
            this.p.y += 0.02;
            // perched: slow head-turn yaw, the odd wing stretch
            yaw = Math.sin(perchT * 0.3 + i) * 1.2;
            flap = Math.max(0, Math.sin(perchT * 0.5 + i * 2) - 0.92) * 6;
            this.flap.setX(i, 0);
          }
          placed = true;
          void tOut;
        } else if (u >= 0.9) {
          const k = (u - 0.9) / 0.1;
          const end = this.loopPos(l, t + land.off, a);
          const e = k * k;
          this.p.lerpVectors(land.perch, end, e);
          b.subVectors(end, land.perch);
          yaw = Math.atan2(b.x, b.z);
          flap = 1; pitch = 0.3 * (1 - k);
          placed = true;
        }
      }
      if (!placed) {
        const tt = t + (land ? land.off : 0);
        this.loopPos(l, tt, this.p);
        this.loopPos(l, tt + 0.2, b);
        b.sub(this.p);
        yaw = Math.atan2(b.x, b.z);
        roll = -Math.sign(l.w) * l.tilt * (1 + storm);
        pitch = -b.y * 1.2;
        // flap in bursts, glide between (storm: flap harder)
        flap = Math.sin(tt * 0.45 + l.ph * 3) > 0.35 - storm * 0.6 ? 1 : 0;
        // now and then a fishing dive: wings tucked, straight down to the water, a flapping climb back to the loop
        const slot = Math.floor(tt / 27), du = tt - slot * 27;
        if (hash(slot * 7.3 + i * 1.9) < 0.42 && du < 3.4 && storm < 0.6) {
          const k = du / 3.4;
          const drop = Math.max(0, this.p.y - this.waterY - 0.25);
          const dk = k < 0.42 ? Math.sin((k / 0.42) * Math.PI / 2) ** 2 : 1 - ((k - 0.42) / 0.58) ** 1.6;
          this.p.y -= drop * dk;
          pitch = k < 0.42 ? 1.05 : -0.55 * (1 - k);
          roll *= 0.2;
          flap = k < 0.42 ? 0 : 1;
        }
        // storm gusts push them around
        if (storm > 0) { this.p.x += Math.sin(tt * 1.7 + i) * storm * 1.5; this.p.y += Math.sin(tt * 2.3 + i) * storm; }
      }
      this.flap.setX(i, flap);
      this.e.set(pitch, yaw, roll);
      this.q.setFromEuler(this.e);
      const sc = 0.95 + hash(i + 131) * 0.25;
      this.s.set(sc, sc, sc);
      this.m.compose(this.p, this.q, this.s);
      this.mesh.setMatrixAt(i, this.m);
    }
    this.mesh.instanceMatrix.needsUpdate = true;
    this.flap.needsUpdate = true;
  }

  dispose() { this.mesh.removeFromParent(); this.mesh.geometry.dispose(); (this.mesh.material as THREE.Material).dispose(); }
}
