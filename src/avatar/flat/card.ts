// Display mode 'card': the 2D avatar's picture as a standee at the performer's spot, sized and grounded from what the
// picture shows (shared/flatFraming.ts: its opaque bounds, whole body or head-and-shoulders):
//   * a whole body stands on the floor (its feet = the content's bottom edge, not the picture's), with a soft contact
//     shadow;
//   * a bust ("head and shoulders") is the top 40 % of a virtual person: at a standing spot it rests on a pedestal at
//     chest height (its cut edge inside the pedestal's cap), at a seat it sits on the seat a little larger with its cut
//     edge softened into the cushion, on the classic stage (no room) it is shown as is. An invisible foot point keeps
//     the measured height a whole person's, so rooms size, frame and seat it like any performer.
// Options (FlatCardDisplay): face each camera (turns about its upright axis per render pass, so spot cameras, the talk
// camera and every stage-layout performer cam see it front-on) or face the spot's front; outline + drop shadow (one halo
// pass behind the picture); how much room light tints it. Everything here is freed by dispose() (the floor-shadow
// texture is markShared and stays).
import * as THREE from 'three';
import type { FlatAvatarConfig } from '../../../shared/flatAvatar.ts';
import { BUST_PLAN, type ContentInfo } from '../../../shared/flatFraming.ts';
import { markShared } from '../gpuDispose.ts';
import type { TalkEffect } from '../../../shared/flatTalk.ts';
import type { FlatPose, FlatSource } from './types.ts';
import { liveCanvasTexture } from './liveTexture.ts';

const UP = new THREE.Vector3(0, 1, 0);
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _m = new THREE.Matrix4(), _l = new THREE.Matrix4();
/** Content = the whole picture (no alpha read yet / unreadable). */
export const FULL_CONTENT: ContentInfo = { x0: 0, x1: 1, y0: 0, y1: 1, aspect: 1, bottomCover: 1, bottomRuns: 1, bottomGap: 0, touchesBottom: true, framing: 'full', confidence: 0 };

let starTex: THREE.Texture | null = null;
/** A soft four-point sparkle (shared by every card: never disposed with one). */
function starTexture(): THREE.Texture {
  if (starTex) return starTex;
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  r.addColorStop(0, 'rgba(255,255,255,1)'); r.addColorStop(0.25, 'rgba(255,246,200,0.7)'); r.addColorStop(1, 'rgba(255,240,180,0)');
  g.fillStyle = r; g.fillRect(0, 0, 64, 64);
  g.fillStyle = 'rgba(255,255,255,0.95)';
  g.beginPath(); g.moveTo(32, 0); g.lineTo(36, 28); g.lineTo(64, 32); g.lineTo(36, 36); g.lineTo(32, 64); g.lineTo(28, 36); g.lineTo(0, 32); g.lineTo(28, 28); g.closePath(); g.fill();
  starTex = markShared(new THREE.CanvasTexture(c));
  starTex.colorSpace = THREE.SRGBColorSpace;
  return starTex;
}
const SPARKS = 24;

let groundTex: THREE.Texture | null = null;
/** Soft elliptical contact shadow (shared by every card: never disposed with one). */
function groundTexture(): THREE.Texture {
  if (groundTex) return groundTex;
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(64, 64, 0, 64, 64, 64);
  r.addColorStop(0, 'rgba(0,0,0,0.62)'); r.addColorStop(0.45, 'rgba(0,0,0,0.38)'); r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r; g.fillRect(0, 0, 128, 128);
  groundTex = markShared(new THREE.CanvasTexture(c));
  return groundTex;
}

const haloVert = /* glsl */`
varying vec2 vUv;
void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`;
const haloFrag = /* glsl */`
uniform sampler2D uMap;
uniform float uOutline;      // radius, fractions of the picture height
uniform vec3 uColor;         // outline colour (linear)
uniform float uGlow;         // 0..1 talk glow (a wider, warm halo)
uniform float uShadow;       // drop shadow opacity
uniform vec2 uShadowOff;     // offset (uv)
uniform float uAspect;       // picture width / height
uniform float uCutY;         // no halo below this v (the content's bottom: a bust's cut, a body's feet)
uniform vec2 uFade;          // the picture's bottom fade: v where it starts, its length (0 = none)
varying vec2 vUv;
float A(vec2 uv) {
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) return 0.0;
  return texture2D(uMap, uv).a;
}
void main() {
  if (vUv.y < uCutY) discard;
  float o = 0.0;
  float rad = uOutline + uGlow * 0.016;
  if (rad > 0.0) {
    vec2 r = vec2(rad / uAspect, rad);
    for (int i = 0; i < 16; i++) {
      float a = float(i) * 0.3926991;
      vec2 d = vec2(cos(a), sin(a));
      o = max(o, A(vUv + d * r));
      o = max(o, A(vUv + d * r * 0.5));
    }
    o = smoothstep(0.2, 0.6, o);
  }
  float s = 0.0;
  if (uShadow > 0.0) {
    vec2 b = vec2(0.012 / uAspect, 0.012);
    vec2 c = vUv - uShadowOff;
    for (int x = -1; x <= 1; x++) for (int y = -1; y <= 1; y++) s += A(c + vec2(float(x), float(y)) * b);
    s = s / 9.0 * uShadow;
  }
  vec3 col = mix(uColor, vec3(1.0, 0.93, 0.62), uGlow);
  float oa = uOutline > 0.0 ? o : o * uGlow * 0.85;
  float outA = oa + s * (1.0 - oa);
  if (uFade.y > 0.0) outA *= smoothstep(uFade.x, uFade.x + uFade.y, vUv.y);
  if (outA < 0.002) discard;
  gl_FragColor = vec4(col * oa, outA);   // premultiplied
}`;

/** Where a card stands (FlatAvatar decides per frame): sit = 0 standing … 1 seated, seatY = the seat's height (model
 *  units), room = in a room (false: the classic stage, no pedestal). */
export interface CardPlace { sit: number; seatY: number; room: boolean;
  /** Classic stage: the shot puts a bust's cut edge on (past) the frame's bottom edge (Stage.frame's card shot), so it
   *  is shown as is; otherwise (several performers, the head focus, zoomed out / shifted) the edge fades out. */
  cutHidden?: boolean;
  /** A cam had to stay close and crop (tileCams cropNote): a bust's cut edge it shows fades out instead of a raw line. */
  cutFade?: boolean }

export class FlatCard {
  readonly group = new THREE.Group();
  /** The picture's pose pivot (bottom centre of the CONTENT): placement + the source's FlatPose move this. */
  readonly pivot = new THREE.Group();
  readonly mesh: THREE.Mesh;
  readonly halo: THREE.Mesh | null = null;
  readonly ground: THREE.Mesh | null = null;
  readonly pedestal: THREE.Group | null = null;
  readonly tex: THREE.CanvasTexture;
  readonly bust: boolean;
  /** Picture size (m) at scale 1, and the content's size in it. */
  readonly W: number;
  readonly H: number;
  readonly contentW: number;
  readonly contentH: number;
  /** The virtual person's height (m) the card stands for. */
  readonly bodyH: number;
  /** The art's own size on the card (m, at scale 1). */
  readonly drawnW: number;
  readonly drawnH: number;
  private depthMat: THREE.MeshDepthMaterial;
  private fadeU: { value: THREE.Vector2 } = { value: new THREE.Vector2(0, 0) };
  private haloFade: { value: THREE.Vector2 } | null = null;
  private version = -1;
  private texW = 0;
  private texH = 0;
  private place: CardPlace = { sit: 0, seatY: 0, room: false };
  private base = { y: 0, k: 1 };
  private pedH = 0;
  private owned: { dispose(): void }[] = [];
  private mat!: THREE.MeshLambertMaterial;
  private tint = 0;
  private sparks: { pts: THREE.Points; life: Float32Array; vel: Float32Array; acc: number } | null = null;

  /** `pictureH`: keep this picture scale (m) — a card rebuilt for new content (an outfit measured again) keeps the
   *  art the size it was, only its box changes. */
  constructor(private src: FlatSource, private cfg: FlatAvatarConfig, readonly content: ContentInfo = FULL_CONTENT, framing: 'full' | 'bust' = content.framing, pictureH?: number) {
    const c = cfg.display.card;
    this.bust = framing === 'bust';
    this.bodyH = c.height;
    const cf = Math.max(0.01, content.y1 - content.y0);
    const pictureAspect = src.width / Math.max(1, src.height);
    this.contentH = pictureH ? pictureH * cf : this.bust ? this.bodyH * BUST_PLAN.standContent : this.bodyH;
    this.H = pictureH ?? this.contentH / cf;
    this.W = this.H * pictureAspect;
    this.contentW = this.W * Math.max(0.01, content.x1 - content.x0);
    // (what is really drawn: the same as contentW / contentH unless the art is under 1 % of its picture)
    this.drawnW = this.W * (content.x1 - content.x0);
    this.drawnH = this.H * (content.y1 - content.y0);
    this.group.name = 'flat:card';
    this.group.add(this.pivot);

    const tex = liveCanvasTexture(src.canvas);   // (redrawn every frame: the fast upload path, src/avatar/flat/liveTexture.ts)
    tex.premultiplyAlpha = !src.premultiplied;   // (a 2D canvas: premultiply on upload; a premultiplied WebGL canvas already is)
    tex.generateMipmaps = !src.pixelated;
    tex.minFilter = src.pixelated ? THREE.NearestFilter : THREE.LinearMipmapLinearFilter;
    tex.magFilter = src.pixelated ? THREE.NearestFilter : THREE.LinearFilter;
    tex.anisotropy = 4;
    this.tex = tex;

    // the plane: the whole picture, placed so the content's bottom centre is the pivot
    const cx = (content.x0 + content.x1) / 2, cy = content.y0;
    const geo = new THREE.PlaneGeometry(this.W, this.H);
    geo.translate((0.5 - cx) * this.W, (0.5 - cy) * this.H, 0);
    // picture colours exact (emissive) + `tint` of them lit by the room (diffuse); premultiplied blending (clean edges)
    const k = c.tint;
    const mat = new THREE.MeshLambertMaterial({
      map: tex, emissiveMap: tex, color: new THREE.Color(k, k, k), emissive: new THREE.Color(1 - k, 1 - k, 1 - k),
      transparent: true, alphaTest: 0.03, side: THREE.DoubleSide, toneMapped: false,
      blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
      blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
    });
    mat.name = 'vtp:flatCard';
    this.mat = mat; this.tint = k;
    // the bottom fade (premultiplied: colour and alpha together)
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uFade = this.fadeU;
      sh.fragmentShader = sh.fragmentShader.replace('#include <common>', '#include <common>\nuniform vec2 uFade;')
        .replace('#include <dithering_fragment>', '#include <dithering_fragment>\n#ifdef USE_MAP\n  if (uFade.y > 0.0) gl_FragColor *= smoothstep(uFade.x, uFade.x + uFade.y, vMapUv.y);\n#endif');
    };
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.name = 'flat:picture';
    this.mesh.castShadow = true;
    this.depthMat = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, map: tex, alphaTest: 0.5 });
    this.mesh.customDepthMaterial = this.depthMat;
    this.mesh.frustumCulled = false;
    this.pivot.add(this.mesh);

    {   // (always: the outline / drop shadow, and the talk glow)
      const m = 0.05;                                   // halo margin, fractions of the picture height
      const x0 = -this.W * cx - m * this.H, x1 = this.W * (1 - cx) + m * this.H, y0 = -this.H * cy - m * this.H, y1 = this.H * (1 - cy) + m * this.H;
      const hg = new THREE.BufferGeometry();
      hg.setAttribute('position', new THREE.Float32BufferAttribute([x0, y0, 0, x1, y0, 0, x1, y1, 0, x0, y1, 0], 3));
      const u0 = x0 / this.W + cx, u1 = x1 / this.W + cx, v0 = y0 / this.H + cy, v1 = y1 / this.H + cy;
      hg.setAttribute('uv', new THREE.Float32BufferAttribute([u0, v0, u1, v0, u1, v1, u0, v1], 2));
      hg.setIndex([0, 1, 2, 0, 2, 3]);
      this.haloFade = { value: new THREE.Vector2(0, 0) };
      const hm = new THREE.ShaderMaterial({
        name: 'vtp:flatHalo', vertexShader: haloVert, fragmentShader: haloFrag, transparent: true, depthWrite: false, side: THREE.DoubleSide,
        blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor, blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneMinusSrcAlphaFactor,
        uniforms: {
          uMap: { value: tex }, uOutline: { value: c.outline * 0.018 }, uColor: { value: new THREE.Color(c.outlineColor) },
          uShadow: { value: c.shadow * 0.75 }, uShadowOff: { value: new THREE.Vector2(0.018 * this.H / this.W, -0.022) },
          uAspect: { value: this.W / this.H }, uCutY: { value: cy }, uFade: this.haloFade, uGlow: { value: 0 },
        },
      });
      const halo = new THREE.Mesh(hg, hm);
      halo.name = 'flat:halo';
      halo.position.z = -Math.max(0.004, this.H * 0.004);
      halo.frustumCulled = false;
      this.pivot.add(halo);
      this.halo = halo;
    }
    // the floor shadow: under the feet, or under the pedestal
    if (c.ground || this.bust) {
      const gw = Math.max(0.35, (this.bust ? this.contentW * 1.25 : this.contentW * 0.9));
      const gm = new THREE.Mesh(new THREE.PlaneGeometry(gw, gw * 0.5), new THREE.MeshBasicMaterial({ map: groundTexture(), transparent: true, depthWrite: false, color: 0x000000, opacity: 0.85, toneMapped: false }));
      gm.name = 'flat:ground';
      gm.rotation.x = -Math.PI / 2;
      gm.position.y = 0.004;
      gm.renderOrder = -1;
      this.group.add(gm);
      this.ground = gm;
    }
    if (this.bust) {
      this.pedestal = this.buildPedestal(c.pedestalColor);
      this.group.add(this.pedestal);
      // the virtual person's feet: rooms measure a person's height, framing and seating treat the bust like one
      const fg = new THREE.BufferGeometry();
      fg.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0], 3));
      const fm = new THREE.PointsMaterial({ size: 0 });
      const foot = new THREE.Points(fg, fm);
      foot.name = 'flat:foot'; foot.visible = false;
      this.group.add(foot);
      // (the measured top: the standing layout's head)
      this.layout(true);
    } else this.layout(true);
    if (c.facing === 'camera') for (const m of [this.mesh, this.halo]) if (m) m.onBeforeRender = (_r, _sc, cam) => this.faceCamera(m, cam);
  }

  /** A round plinth (base ring, slightly tapered column, cap) — round, so it needs no turning toward the camera; its
   *  radius covers the bust's cut edge from every side. Height 1 (scaled to the chest height per frame). */
  private buildPedestal(color: string): THREE.Group {
    const g = new THREE.Group();
    g.name = 'flat:pedestal';
    const R = Math.max(0.16, this.contentW * Math.max(0.35, this.content.bottomCover) * 0.5 * 1.08 + 0.02);
    const col = new THREE.Color(color);
    const body = new THREE.MeshStandardMaterial({ color: col, roughness: 0.55, metalness: 0.08 });
    const trim = new THREE.MeshStandardMaterial({ color: col.clone().lerp(new THREE.Color('#ffffff'), 0.28), roughness: 0.4, metalness: 0.12 });
    body.name = 'vtp:flatPedestal'; trim.name = 'vtp:flatPedestalTrim';
    const parts: [THREE.BufferGeometry, THREE.Material, number][] = [
      [new THREE.CylinderGeometry(R * 1.22, R * 1.3, 0.05, 40), trim, 0.025],
      [new THREE.CylinderGeometry(R * 0.86, R * 0.96, 0.86, 40), body, 0.05 + 0.43],
      [new THREE.CylinderGeometry(R * 1.04, R * 0.96, 0.05, 40), trim, 0.91 + 0.025],
      [new THREE.CylinderGeometry(R * 1.1, R * 1.1, 0.04, 40), trim, 0.96 + 0.02],
    ];
    for (const [geo, mat, y] of parts) {
      const m = new THREE.Mesh(geo, mat);
      m.position.y = y; m.castShadow = true; m.receiveShadow = true;
      g.add(m);
      this.owned.push(geo);
    }
    this.owned.push(body, trim);
    g.userData.radius = R;
    return g;
  }

  /** Per render pass: this mesh turns (about the upright axis) to face the camera that draws it. */
  private faceCamera(m: THREE.Object3D, cam: THREE.Camera) {
    this.group.matrixWorld.decompose(_p, _q, _s);
    const e = cam.matrixWorld.elements;
    _q.setFromAxisAngle(UP, Math.atan2(e[12] - _p.x, e[14] - _p.z));
    _m.compose(_p, _q, _s);
    _l.multiplyMatrices(this.pivot.matrix, m.matrix);
    m.matrixWorld.multiplyMatrices(_m, _l);
  }

  /** Where the card stands now (FlatAvatar, every frame). */
  setPlace(p: CardPlace) { this.place = p; this.layout(false); }

  private layout(first: boolean) {
    const P = this.place, g = this.cfg.display.card.grounding;
    if (!this.bust) { this.base = { y: 0, k: 1 }; this.fadeU.value.set(0, 0); if (this.haloFade) this.haloFade.value.set(0, 0); return; }
    const B = BUST_PLAN, H = this.bodyH;
    const usePed = P.room && (g === 'auto' || g === 'pedestal');
    const pedestalSit = g === 'pedestal' ? 0 : P.sit;     // ('pedestal': always on it, also at a seat)
    const standY = first || P.room ? B.standBottom * H : B.standBottom * H;
    const seatY = P.seatY + B.seatLift * H;
    const k = 1 + (B.seatContent / B.standContent - 1) * pedestalSit;
    this.base = { y: standY + (seatY - standY) * pedestalSit, k };
    // pedestal: up to the chest (the cut edge 3 % of a person inside its cap), sinking away while seated
    const ped = this.pedestal;
    if (ped) {
      const on = usePed && pedestalSit < 0.98;
      ped.visible = on;
      this.pedH = standY + 0.03 * H;
      ped.scale.set(1, Math.max(1e-3, this.pedH * (1 - pedestalSit)), 1);
      if (this.ground) this.ground.visible = on || !P.room;
    }
    // the cut edge: softened into the cushion when seated, faded when asked to (no pedestal); hidden by the cap otherwise
    const v0 = this.content.y0, cf = this.content.y1 - this.content.y0;
    // (the classic stage: as is when its shot puts the cut edge past the frame's bottom edge, like a 3D body's; faded
    // whenever the edge can be in view)
    const fade = g === 'fade' || P.cutFade || (!P.room && g === 'auto' && !P.cutHidden) ? 0.16 : pedestalSit > 0.02 ? 0.08 * pedestalSit : 0;
    this.fadeU.value.set(v0, fade * cf);
    if (this.haloFade) this.haloFade.value.set(v0, fade * cf);
    if (first) { this.pivot.position.set(0, this.base.y, 0); this.pivot.scale.setScalar(this.base.k); }
  }

  /** After the source's update: new picture → re-upload; placement + the composed pose (the kind's + the talk motions)
   *  → the pivot; the talk effects (glow, brighten, sparkles). */
  sync(p: FlatPose | undefined = this.src.pose, fx?: TalkEffect, dt = 0) {
    if (this.src.version !== this.version) {
      this.version = this.src.version;
      // (a picture that changed size — a rigged 2D model drawn bigger for a close-up: rig2d/source.ts setDetail — needs a
      //  new GPU texture: three.js keeps the storage it allocated first and would upload only part of the bigger picture)
      const cw = this.src.canvas.width, ch = this.src.canvas.height;
      if (cw !== this.texW || ch !== this.texH) { if (this.texW) this.tex.dispose(); this.texW = cw; this.texH = ch; }
      this.tex.needsUpdate = true;
    }
    const k = this.base.k;
    let y = 0, x = 0, rot = 0, sx = 1, sy = 1;
    if (p) {
      x = p.x * this.contentW; sx = p.sx; sy = p.sy;
      // a bust keeps its cut edge inside the pedestal / on the seat: small hops, small tilts
      y = (this.bust ? 0.25 : 1) * p.y * this.contentH;
      rot = this.bust ? THREE.MathUtils.clamp(p.rot, -0.07, 0.07) : p.rot;
    }
    this.pivot.position.set(x * k, this.base.y + y * k, 0);
    this.pivot.rotation.set(p?.lean ?? 0, 0, rot);
    this.pivot.scale.set(sx * k, sy * k, k);
    if (fx) this.effects(fx, dt);
  }

  private effects(fx: TalkEffect, dt: number) {
    const b = 1 + fx.bright, t = this.tint;
    this.mat.color.setScalar(t * b); this.mat.emissive.setScalar((1 - t) * b);
    if (this.halo) (this.halo.material as THREE.ShaderMaterial).uniforms.uGlow.value = fx.glow;
    if (fx.sparkle > 0.01 || this.sparks) this.sparkle(fx.sparkle, dt);
  }

  /** Little stars drifting up around the head while talking (sparkle). */
  private sparkle(rate: number, dt: number) {
    if (!this.sparks) {
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(SPARKS * 3), 3));
      geo.setAttribute('size', new THREE.BufferAttribute(new Float32Array(SPARKS), 1));
      const mat = new THREE.PointsMaterial({ map: starTexture(), size: 0.07 * this.bodyH, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, toneMapped: false, color: 0xfff1c0 });
      const pts = new THREE.Points(geo, mat);
      pts.name = 'flat:sparkles'; pts.frustumCulled = false;
      this.group.add(pts);
      this.sparks = { pts, life: new Float32Array(SPARKS), vel: new Float32Array(SPARKS * 3), acc: 0 };
    }
    const S = this.sparks, pos = S.pts.geometry.attributes.position as THREE.BufferAttribute;
    const top = this.base.y + this.contentH * this.base.k, w = this.contentW * this.base.k;
    S.acc += rate * dt * 14;
    let alive = 0;
    for (let i = 0; i < SPARKS; i++) {
      if (S.life[i] <= 0 && S.acc >= 1) {
        S.acc -= 1; S.life[i] = 0.9;
        const a = Math.random() * Math.PI * 2;
        pos.setXYZ(i, Math.cos(a) * w * 0.55, top - this.contentH * this.base.k * (0.15 + Math.random() * 0.45), 0.05 + Math.sin(a) * 0.08);
        S.vel[i * 3] = Math.cos(a) * 0.12; S.vel[i * 3 + 1] = 0.25 + Math.random() * 0.2; S.vel[i * 3 + 2] = 0;
      }
      if (S.life[i] > 0) {
        S.life[i] -= dt; alive++;
        pos.setXYZ(i, pos.getX(i) + S.vel[i * 3] * dt, pos.getY(i) + S.vel[i * 3 + 1] * dt, pos.getZ(i));
        if (S.life[i] <= 0) pos.setXYZ(i, 0, -1000, 0);
      } else pos.setXYZ(i, 0, -1000, 0);
    }
    S.acc = Math.min(S.acc, 3);
    pos.needsUpdate = true;
    (S.pts.material as THREE.PointsMaterial).opacity = 0.9;
    S.pts.visible = alive > 0;
  }

  /** The picture's current scale on the card (seated busts grow a little: BUST_PLAN). */
  get scaleK() { return this.base.k; }
  /** Where the content's bottom centre rests in the group (y) and its scale STANDING (no seat, no talk motion): a bust
   *  on its chest-high pivot, a whole body on the floor — what framing and the room's measures read. */
  get rest(): { y: number; k: number } { return { y: this.bust ? BUST_PLAN.standBottom * this.bodyH : 0, k: 1 }; }
  /** A bust seated at a seat of height `seatY` (card space): its scale and the pivot height — what layout() does
   *  when fully seated; null when it never sits down (a whole body, or grounding 'pedestal'). */
  seatedPlan(seatY: number): { k: number; y: number; standY: number } | null {
    if (!this.bust || this.cfg.display.card.grounding === 'pedestal') return null;
    const B = BUST_PLAN, H = this.bodyH;
    return { k: B.seatContent / B.standContent, y: seatY + B.seatLift * H, standY: B.standBottom * H };
  }
  /** Face in group space from picture fractions (x from the left, y from the bottom, size of the picture height). */
  faceAt(f: { x: number; y: number; size: number }): { center: THREE.Vector3; size: number } {
    const k = this.base.k, cx = (this.content.x0 + this.content.x1) / 2;
    return { center: new THREE.Vector3((f.x - cx) * this.W * k, this.base.y + (f.y - this.content.y0) * this.H * k, 0.02 * this.H), size: f.size * this.H * k };
  }

  setVisible(on: boolean) { this.pivot.visible = on; if (this.ground) this.ground.visible = on; if (this.pedestal) this.pedestal.visible = on && this.pedestal.visible; }

  dispose() {
    this.group.removeFromParent();
    this.group.traverse((o) => {
      const m = o as THREE.Mesh;
      if (!m.geometry) return;
      m.geometry.dispose();
      for (const mat of ([] as THREE.Material[]).concat(m.material as THREE.Material)) mat?.dispose();
    });
    for (const o of this.owned) o.dispose();
    this.depthMat.dispose();
    this.tex.dispose();
  }
}
