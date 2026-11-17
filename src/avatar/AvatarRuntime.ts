// AvatarRuntime: loads a model + profile and assembles everything that makes it perform.
//
// Build order matters (each step depends on the previous):
//   load → rig (VRM | name-mapped humanoid | soft rig) → jiggle bone injection → generated face
//   morphs + patches (mouth/eyes) → toon + outlines → spring chains → retargeter.

import { JawRigDriver, detectJawRig } from './jawRig.ts';
import * as THREE from 'three';
import { GLTFLoader, type GLTF, type GLTFReference } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { VRMHumanoid, VRMLoaderPlugin, VRMUtils, type VRM, type VRMHumanBoneName, type VRMHumanBones } from '@pixiv/three-vrm';
import type { AvatarProfile, CostumeDef, SurfaceMarker, TrackingFrame, TrackingTuning, Vec3 } from '../../shared/types.ts';
import type { BodyTargets } from '../tracking/bodySolver.ts';
import { clamp01 } from '../tracking/filters.ts';
import { attachCostume, attachCostumeSteps, type AttachedCostume } from './costumes.ts';
import { isCancelled, LoadSlicer, runSteps, skinnedBoxes } from './loadSlicer.ts';
import type { FitOptions } from './costumeFit.ts';
import { ExpressionDriver, estimateEmotions } from './expressions.ts';
import { ProceduralEyes, eyeSpots } from './eyes.ts';
import { eyeBoneMarkers, prepareBakedEyeParts, replaceBakedEyes, whileHidden, type BakedEyesResult } from './bakedEyes.ts';
import { bakedWanted } from '../../shared/bakedEyes.ts';
import { guessFaceMarkers } from './faceGuess.ts';
import { setupEyeLayout, type EyeLayoutRig } from './eyePatch.ts';
import { bulbDepthRange, clampEyeDepth, modelDepthRange } from '../../shared/eyeDepth.ts';
import { isHumanoid, mapHumanoid } from './humanoid.ts';
import { EmoteLayer } from './emotes.ts';
import { ProceduralMouth } from './mouth.ts';
import { PhysicsSystem, autoJiggleBones } from './physics.ts';
import { Retargeter } from './retarget.ts';
import { LazyTorsoSurface, torsoSurfaceJob, type TorsoJob } from './torsoSurface.ts';
import { armSettings } from '../../shared/armPose.ts';
import { buildSoftRig, guessSoftRig } from './softRig.ts';
import { collectMeshes, faceFrame } from './surfacePatch.ts';
import { pruneZeroMorphs } from './morphPrune.ts';
import { readTexel, texelAt } from './texel.ts';
import { applyRealistic, applyToon, applyToonSteps, setToonLook } from './toon.ts';
import { FaceDecals } from './faceDecals.ts';
import type { LookConfig } from '../../shared/types.ts';
import { GestureEffects } from './effects.ts';
import { SnackFx, measureSnackRest, type SnackRest } from './snackFx.ts';
import { VisemeRig, type MouthCaps } from './visemeRig.ts';
import { SpeechMotion } from './speechMotion.ts';
import { MouthRulesDriver, effectiveMouthRules } from './mouthRules.ts';
import { PropFx, prepPropMarkers } from './propFx.ts';
import { VoiceLife } from './voiceLife.ts';
import { finishSurfaceStyles, prepareSurfaceStyles, surfaceStyleFor, type SurfaceStyles } from './surfaceStyles.ts';
import { NeckRig } from './neckRig.ts';
import { QuadrupedLife } from './quadruped.ts';
import { RigMapLife } from './rigMap.ts';
import { ClipPlayer } from './clips.ts';
import { bodyLayers } from '../../shared/bodyKind.ts';
import { MechRig } from './mech.ts';
import { FACE_SPHERE_K, type AvatarDetailChoice } from '../../shared/avatarDetail.ts';
import { AvatarDetail } from './lod/AvatarDetail.ts';
import { capTextures, type TexCapInfo } from './lod/textureCap.ts';
import { mergeEnabled, mergeSkinnedPrimitives, nameRefKey } from './mergePrimitives.ts';
import { disposeMeshes } from './gpuDispose.ts';
import { FlatAvatar } from './flat/FlatAvatar.ts';
import { runAvatarLate } from './b16Hooks.ts';

export interface RuntimeInfo {
  rig: 'vrm' | 'humanoid' | 'soft' | 'none';
  meshes: number;
  triangles: number;
  bones: number;
  expressions: ExpressionDriver['summary'];
  proceduralEyes: boolean;
  proceduralMouth: boolean;
  springJoints: number;
  warnings: string[];
  /** What the viseme rig found this model's mouth/face can do (per-model viseme mapping). */
  mouthCaps?: MouthCaps;
  /** Painted-eye replacement (profile.eyes.replaceBaked): what was done + how long it took. */
  bakedEyes?: BakedEyesResult['info'];
  /** Debug: VRM primitives that share a material, merged at load (src/avatar/mergePrimitives.ts): `primitives`
   *  became `meshes` (draw calls saved per pass = the difference), in `ms`. Absent = nothing merged, or off
   *  (localStorage vtp.mergePrims = '0'). */
  mergedPrimitives?: { primitives: number; meshes: number; ms: number };
}

const loader = new GLTFLoader();
loader.setMeshoptDecoder(MeshoptDecoder); // EXT_meshopt_compression (web starter pack, CONTRACT.md §7); no effect on uncompressed files
loader.register((p) => new VRMLoaderPlugin(p));

export class AvatarRuntime {
  readonly wrapper = new THREE.Group();
  readonly model: THREE.Object3D;
  readonly vrm: VRM | null;
  humanoid: VRMHumanoid | null = null;
  retarget: Retargeter | null = null;
  expressions!: ExpressionDriver;
  mouth: ProceduralMouth | null = null;
  /** Bone-driven physical mouth (jaw hinge / hand puppet), from the profile or auto-detected bones. */
  jawRig: JawRigDriver | null = null;
  /** Per-model viseme → control mapping (speech visemes read correctly on any mouth). */
  visemeRig: VisemeRig | null = null;
  /** speech-driven talking body language (profile.speechMotion; off unless enabled) */
  speechMotion: SpeechMotion | null = null;
  /** per-avatar mouth rules (profile.mouth.rules: resting corner bias, voice puff; src/avatar/mouthRules.ts); null = none */
  mouthRules: MouthRulesDriver | null = null;
  /** synthesised face life while the face isn't tracked (mic-only users, lost face); null = legacy idle life */
  voiceLife: VoiceLife | null = null;
  private voiceLifeOff = false;
  /** the last frame after voice life, marked `life` — the studio publishes THIS to the OBS output pages so they
   *  show its exact blinks / gaze / head (null when voice life is off) */
  lifeFrame: TrackingFrame | null = null;
  /** Robots: rigid parts, no squash & stretch / flesh jiggle. */
  mechanical = false;
  /** Materials named *VoiceGlow* (speaker grilles, chest lights) that pulse with the voice. */
  private voiceGlow: { mat: THREE.MeshStandardMaterial; base: number }[] = [];
  get hasVoiceGlow() { return this.voiceGlow.length > 0; }
  private glowLevel = 0;
  eyes: ProceduralEyes | null = null;
  /** Painted-eye replacement (shared/bakedEyes.ts): erased texture copies + hidden eye parts; null = off. */
  baked: BakedEyesResult | null = null;
  /** Painted-eye replacement: where the painted eyes were found, as profile markers (model space) + the matching eye
   *  size (profile units) + the painted iris colour — the Face tab's "Fit to the painted eyes" applies it. */
  bakedFit: { left?: [number, number, number]; right?: [number, number, number]; size: number; iris: string | null } | null = null;
  /** Eye depth (profile.eyes.depth) support for this model: procedural bulb / inset eyes or model eye bones, with the
   *  allowed range in profile (model) units; null = painted eyes / no eye bones (nothing to move). */
  eyeDepth: { kind: 'bulb' | 'bones'; range: [number, number] } | null = null;
  private eyeBones: { bone: THREE.Object3D; base: THREE.Vector3; dir: THREE.Vector3 }[] = [];
  /** Eye layout (profile.eyes.layout 'left' / 'right'): the hidden model eye + the optional eye patch; null = both eyes. */
  eyeLayout: EyeLayoutRig | null = null;
  private scaleW = 1;
  /** Cheek blush + nose highlight (non-VRM procedural faces). */
  faceDecals: FaceDecals | null = null;
  physics = new PhysicsSystem();
  outlines: THREE.Mesh[] = [];
  /** The worn costume (profile.costume), attached onto the base skeleton. */
  costume: AttachedCostume | null = null;
  info!: RuntimeInfo;
  private idle = { blinkT: 2, blink: 0, gazeT: 1, gaze: new THREE.Vector2(), gazeTarget: new THREE.Vector2() };
  private resting = false;
  private visemeWarned = false;
  private motion = new THREE.Vector3();
  /** Gesture emoji bursts (lives in avatar-anchor space so it can float free of the body). */
  fx: GestureEffects | null = null;
  /** Food & drink layer (drink props, food mess), created on the first frame that carries `snack`. */
  snacks: SnackFx | null = null;
  private snackRest: SnackRest | null = null;
  /** Accessory prop FX (cigar ember flicker, smoke emitters), found by name; null when the model has none. */
  propFx: PropFx | null = null;
  /** Extra pose layer UNDER the tracking (3D scenes: seated legs, entrance walk cycles). Runs after the
   *  tracked bones are written to the normalized humanoid, before it's copied to the rig. */
  poseHook: ((rt: AvatarRuntime, dt: number) => void) | null = null;
  /** VRMA emotes (frame.emote) blended over tracking + the pose hook (humanoid / VRM rigs only). */
  emotes: EmoteLayer | null = null;
  /** Procedural surface styles (felt, scales, clay, fur… — look.surface / costume.surface / material extras); null = none. */
  surfaces: SurfaceStyles | null = null;
  /** Neck length + calm head motion for long necks (profile.neck, src/avatar/neckRig.ts); null = no neck bone. */
  neck: NeckRig | null = null;
  /** Four-legged body layer (profile.body 'quadruped'): planted legs, idle life, walk gait; null = biped. */
  quadruped: QuadrupedLife | null = null;
  /** 3D auto-rig retarget map layer (profile.rig.retarget, src/avatar/rigMap.ts): wings, head-turn shares, idle sway; null = none. */
  rigMap: RigMapLife | null = null;
  /** A planted body without legs (profile.body 'object' / 'serpent'): the retarget runs planted, no QuadrupedLife, no sliding. */
  private plantedNoLegs = false;
  /** Clips played over the pose (CC0 / self-made clips fitted to a 3D auto-rig, src/avatar/clips.ts); null until one is added. */
  clips: ClipPlayer | null = null;
  /** Walking machine with a seated pilot (profile.body 'mech', src/avatar/mech.ts): mechanical legs while travelling,
   *  hands on the sticks; null = not a mech (or no machine bones found). */
  mech: MechRig | null = null;
  /** Avatar detail (src/avatar/lod/AvatarDetail.ts): lighter index-only levels of a very detailed own avatar; null =
   *  not asked for (every caller but the studio view / own OBS slots: exactly today's path). */
  detail: AvatarDetail | null = null;
  /** Avatar detail: what the load-time texture cap did (null = none ran). */
  detailTex: TexCapInfo | null = null;
  /** Avatar detail: time it added to this load (texture cap + starting the controller), ms. */
  detailLoadMs = 0;
  /** 2D avatar (profile.flat, src/avatar/flat/*): the picture shown as a card / overlay / TV / monitor; null = 3D. */
  flat: FlatAvatar | null = null;
  /** The profile build() used (a worn costume's face tweaks applied). */
  private buildProfile: AvatarProfile | null = null;

  /** `url`: the model's URL, or its bytes (party members' sealed avatars, decrypted in memory: parsed straight
   *  from the buffer — no URL, no HTTP / THREE.Cache entry; the caller wipes the buffer afterwards).
   *  `opts.detail`: Avatar detail for THIS PC's own avatar (studio view, own OBS slots); leave it out everywhere else
   *  (= Full, today's path). `opts.pin`: a test page's pinned level (?avatarDetail=L0..L3). */
  static async load(profile: AvatarProfile, url: string | ArrayBuffer, anchor: THREE.Object3D, onStatus?: (s: string) => void, opts?: { detail?: AvatarDetailChoice; pin?: number | null; slicer?: LoadSlicer | null }): Promise<AvatarRuntime> {
    // `opts.slicer`: build in frame-sized slices, cancellable (src/avatar/loadSlicer.ts: a live page's model loads)
    const sl = opts?.slicer ?? null;
    if (profile.flat) return AvatarRuntime.loadFlat(profile, url, anchor, onStatus, sl);
    onStatus?.('Downloading model…');
    // costume downloads in parallel (THREE.Cache keeps both, so switching back and forth is instant)
    const def = profile.costume ? profile.costumes.find((c) => c.id === profile.costume) ?? null : null;
    const accDefs = (profile.accessories ?? []).map((id) => profile.costumes.find((c) => c.id === id)).filter((c): c is CostumeDef => !!c && c.id !== def?.id);
    const base = typeof url === 'string' ? loader.loadAsync(url) : loader.parseAsync(url, '');
    const [gltf, costume, ...accs] = await Promise.all([base, def ? loadCostume(profile, def) : null, ...accDefs.map((d) => loadCostume(profile, d))]);
    await sl?.yield();
    const rt = new AvatarRuntime(profile, gltf, anchor);
    try { await rt.build(onStatus, costume, accs, sl); }
    catch (e) { rt.dispose(); throw e; }   // (a cancelled or failed build: nothing of it stays)
    if (opts?.detail) {
      const td = performance.now();
      // non-face texture cap (load only; hidden meanwhile: the studio's wrapper already hangs under the live anchor)
      const choice = opts.detail;
      if (choice !== 'full') {
        rt.wrapper.visible = false;
        try { await sl?.step(); const f = rt.faceInfo(); rt.detailTex = await capTextures(rt.model, choice, f ? { center: f.center, radius: f.size * FACE_SPHERE_K } : null); }
        catch (e) { if (isCancelled(e)) { rt.dispose(); throw e; } console.warn('avatar detail: texture cap', e); }
        finally { rt.wrapper.visible = true; }
      }
      // levels are prepared in the background (never blocks the load): the avatar shows at Full meanwhile
      try { rt.detail = new AvatarDetail(rt, choice, { pin: opts.pin ?? null }); } catch (e) { console.warn('avatar detail', e); rt.detail = null; }
      rt.detailLoadMs = performance.now() - td;
    }
    return rt;
  }

  /** A 2D avatar (profile.flat): the FlatAvatar's group is the model; none of the 3D build steps run. */
  private static async loadFlat(profile: AvatarProfile, url: string | ArrayBuffer, anchor: THREE.Object3D, onStatus?: (s: string) => void, sl: LoadSlicer | null = null): Promise<AvatarRuntime> {
    onStatus?.('Loading 2D avatar…');
    const fa = await FlatAvatar.load(profile, url, onStatus);
    try { await sl?.yield(); } catch (e) { fa.dispose(); throw e; }
    const rt = new AvatarRuntime(profile, { scene: fa.root, userData: {}, animations: [] } as unknown as GLTF, anchor);
    rt.flat = fa;
    rt.buildProfile = profile;
    rt.expressions = new ExpressionDriver(new THREE.Group(), null);
    let tris = 0, meshes = 0;
    fa.root.traverse((o) => { const m = o as THREE.Mesh; if (m.isMesh && m.geometry) { meshes++; const g = m.geometry; tris += (g.index ? g.index.count : g.attributes.position?.count ?? 0) / 3; } });
    rt.info = { rig: 'none', meshes, triangles: Math.round(tris), bones: 0, expressions: rt.expressions.summary, proceduralEyes: false, proceduralMouth: false, springJoints: 0, warnings: [...fa.warnings] };
    rt.wrapper.updateWorldMatrix(true, true);
    return rt;
  }

  /** Avatar detail: world-space protection spheres at rest (the face sphere + the procedural mouth / eye keep spheres,
   *  the same radii as the costume fit's). */
  detailSpheres(): { center: THREE.Vector3; radius: number }[] {
    const out = (this.fitContext(this.buildProfile ?? this.profile, this.scaleW).keepVisible ?? []).map((s) => ({ center: s.center.clone(), radius: s.radius }));
    const f = this.faceInfo();
    if (f) out.push({ center: f.center.clone(), radius: f.size * FACE_SPHERE_K });
    return out;
  }

  /** Avatar detail: bones that move part of the face without a shape key (the jaw rig's jaw / puppet upper head, the
   *  humanoid jaw and eyes). Every vertex they (or a bone under them) weigh is drawn exactly as made at every level. */
  detailFaceBones(): THREE.Object3D[] {
    const out: THREE.Object3D[] = [...(this.jawRig?.bones ?? [])];
    for (const n of ['jaw', 'leftEye', 'rightEye'] as const) { const b = this.humanoid?.getRawBoneNode(n); if (b && !out.includes(b)) out.push(b); }
    return out;
  }
  /** glTF object -> source element map, kept for build() only (the primitive merge reads which glTF mesh each
   *  primitive came from); null afterwards. */
  private srcAssoc: Map<object, GLTFReference> | null;

  private constructor(readonly profile: AvatarProfile, gltf: GLTF, readonly anchor: THREE.Object3D) {
    this.vrm = (gltf.userData.vrm as VRM | undefined) ?? null;
    this.model = this.vrm?.scene ?? gltf.scene;
    this.srcAssoc = gltf.parser?.associations ?? null;
    const t = profile.transform;
    this.wrapper.name = 'avatar';
    this.wrapper.scale.setScalar(t.scale);
    this.wrapper.position.set(...t.offset);
    this.wrapper.rotation.y = THREE.MathUtils.degToRad(t.yaw);
    this.wrapper.add(this.model);
    anchor.add(this.wrapper);
    this.wrapper.updateWorldMatrix(true, true);
  }

  /** Accessories worn on top of the outfit (glasses, hats, props, face paint). */
  accessories: AttachedCostume[] = [];

  private async build(onStatus?: (s: string) => void, costume: WornCostume | Error | null = null, accs: (WornCostume | Error)[] = [], sl: LoadSlicer | null = null) {
    // (a live page's model load: the page gets the thread back between steps — src/avatar/loadSlicer.ts)
    const st = async () => { if (sl) await sl.step(); };
    const worn = costume && !(costume instanceof Error) ? costume : null;
    // the costume's face tweaks apply while worn, without touching the saved profile
    const p = worn?.def.eyes ? { ...this.profile, eyes: { ...this.profile.eyes, ...worn.def.eyes } } : this.profile;
    this.buildProfile = p;
    const warnings: string[] = [];
    let rig: RuntimeInfo['rig'] = 'none';
    let merged: RuntimeInfo['mergedPrimitives'];

    if (this.vrm) {
      onStatus?.('Preparing VRM…');
      VRMUtils.removeUnnecessaryVertices(this.model);
      await st();
      VRMUtils.combineSkeletons(this.model);
      await st();
      if (this.vrm.meta?.metaVersion === '0') VRMUtils.rotateVRM0(this.vrm);
      this.model.traverse((o) => { o.frustumCulled = false; });
      // MToon (VRoid & co.) is authored for dimmer scenes than the studio's toon lights: scale its lit + shade
      // colours per model (not the shared lights) so VRMs and toon avatars sit side by side in a party
      const k = p.look?.vrmExposure ?? 0.6;
      this.model.traverse((o) => {
        const mats = (o as THREE.Mesh).material;
        for (const m of Array.isArray(mats) ? mats : mats ? [mats] : []) {
          const mt = m as THREE.Material & { isMToonMaterial?: boolean; color?: THREE.Color; shadeColorFactor?: THREE.Color };
          if (!mt.isMToonMaterial || mt.userData.vtpExposed) continue;
          mt.color?.multiplyScalar(k); mt.shadeColorFactor?.multiplyScalar(k); mt.userData.vtpExposed = true;
        }
      });
      this.humanoid = this.vrm.humanoid;
      rig = 'vrm';
    } else {
      // ground the model: feet at y=0, centred
      this.model.updateWorldMatrix(true, true);
      // (skinned parts' boxes skin every vertex on the CPU: in slices on a live page — then setFromObject reads them)
      if (sl) await skinnedBoxes(this.model, sl);
      const box = new THREE.Box3().setFromObject(this.model);
      if (!box.isEmpty() && p.transform.offset.every((v) => v === 0)) {
        const c = box.getCenter(new THREE.Vector3());
        this.model.position.x -= c.x; this.model.position.z -= c.z; this.model.position.y -= box.min.y;
        this.model.updateWorldMatrix(true, true);
      }
      const hasSkin = collectMeshes(this.model).some((m) => (m as THREE.SkinnedMesh).isSkinnedMesh);
      let map = hasSkin ? mapHumanoid(this.model, p.rig.boneMap) : {};
      if (hasSkin && !isHumanoid(map)) {
        warnings.push('Skeleton has no recognizable humanoid bones — rebuilt with a soft rig.');
        stripSkinning(this.model);
      }
      if (!isHumanoid(map)) {
        onStatus?.('Generating soft rig…');
        const cfg = p.rig.soft ?? guessSoftRig(this.model);
        this.profile.rig = { kind: 'soft', soft: cfg };
        buildSoftRig(this.model, cfg);
        map = mapHumanoid(this.model);
        rig = 'soft';
      } else rig = 'humanoid';
      await st();
      if (isHumanoid(map)) {
        const bones: Record<string, { node: THREE.Object3D }> = {};
        for (const [k, node] of Object.entries(map)) if (node) bones[k] = { node };
        this.humanoid = new VRMHumanoid(bones as unknown as VRMHumanBones, { autoUpdateHumanBones: true });
        this.model.add(this.humanoid.normalizedHumanBonesRoot);
      }
    }
    this.model.updateWorldMatrix(true, true);
    // neck chain (measured at rest) + its length multiplier, before costumes / colliders / springs see the skeleton
    if (this.humanoid) {
      try { this.neck = NeckRig.create(this.model, this.humanoid, this.anchor, p.neck); } catch (e) { console.warn('neck rig', e); this.neck = null; }
      this.model.updateWorldMatrix(true, true);
    }
    const scaleW = this.model.getWorldScale(new THREE.Vector3()).x;
    await st();

    // --- costume: after the rig exists, before jiggle/face/toon/physics (they all include it) ---
    if (costume instanceof Error) warnings.push(`Costume failed to load: ${costume.message}`);
    else if (worn) this.costume = sl ? await runSteps(attachCostumeSteps(this.model, worn.gltf, worn.def, this.fitContext(p, scaleW)), sl) : attachCostume(this.model, worn.gltf, worn.def, this.fitContext(p, scaleW));
    // accessories: rigid add-ons layered over the outfit — no body push-out (they sit ON the surface). A def with
    // fit.hideBody (masks over a beard) runs the covered-body hide pass only, so hair / skin under it can't poke out.
    for (const a of accs) {
      if (a instanceof Error) { warnings.push(`Accessory failed to load: ${a.message}`); continue; }
      try {
        const hideInsideBind = (a.def.fit?.hideInside ?? []).map((s) => ({ center: new THREE.Vector3(...s.center), radius: s.radius * scaleW, bone: s.bone ?? this.humanoid?.getRawBoneNode('head')?.name ?? 'head' }));
        const hide = a.def.fit?.hideBody === true ? { ...this.fitContext(p, scaleW), margin: 0, hideInsideBind } : false;
        const att = sl ? await runSteps(attachCostumeSteps(this.model, a.gltf, a.def, hide), sl) : attachCostume(this.model, a.gltf, a.def, hide);
        prepPropMarkers(att.meshes);
        this.accessories.push(att);
      }
      catch (e) { if (isCancelled(e)) throw e; warnings.push(`Accessory '${a.def.name}' failed: ${(e as Error).message}`); }
    }
    await st();
    // skinned parts are culled by their REST-pose bounds: a small separate mesh (a hand, an eye, a sleeve) that the
    // pose moves away from its rest place would vanish from a close frame. The avatar is always framed: never cull.
    this.model.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) o.frustumCulled = false; });
    // VRoid's 100+ hair primitives become one mesh: AFTER the costume / accessory fit (it judges every body mesh on its
    // own, see mergeVrmPrimitives), before jiggle / face / eyes / surfaces / springs see the meshes
    if (this.vrm) merged = this.mergeVrmPrimitives(p);
    await st();
    const meshes = collectMeshes(this.model); // face-safe: excludes costume meshes
    // morph targets that move nothing on a mesh are dropped once, here, before the outline hulls / fur shells / patches
    // copy them (each of those builds its own morph texture). VRMs bind their expressions by morph index: left alone.
    if (!this.vrm) {
      try { await pruneZeroMorphs(meshes, st); } catch (e) { if (isCancelled(e)) throw e; console.warn('morph prune', e); }
    }

    // --- jiggle (must precede patches/outlines: it swaps skeletons) ---
    if (p.physics.enabled) {
      if (p.physics.jiggle.length) this.physics.buildJiggles(this.model, p.physics.jiggle, collectMeshes(this.model, { costumes: true }));
      if (p.physics.autoChains) for (const b of autoJiggleBones(this.model)) this.physics.addBoneJiggle(b);
    }
    await st();

    // --- face ---
    onStatus?.('Building face…');
    const worldCfg = <T extends object>(c: T, keys: (keyof T)[]) => {
      const o = { ...c };
      for (const k of keys) (o[k] as unknown as number) = (c[k] as unknown as number) * scaleW;
      return o;
    };
    if (p.mouth.mode === 'procedural' && p.mouth.center) {
      const frame = faceFrame(p.mouth.center, this.model, this.anchor);
      this.mouth = new ProceduralMouth(meshes, frame, worldCfg(p.mouth, ['width', 'openHeight', 'influence', 'lineWidth']));
      await st();
    }
    // painted-eye replacement with no eye markers yet: this build uses the automatic first guess (the Face tab saves it)
    let eyesCfg = p.eyes;
    // VRM eyes are real eye geometry that already follows gaze + blinks (nothing painted to replace): left alone
    const replacePainted = bakedWanted(p.eyes) && !this.vrm;
    if (bakedWanted(p.eyes) && this.vrm) warnings.push('This VRM’s eyes are real eye parts that already track — “Replace the painted eyes” is for eyes painted into a texture, so it’s off here.');
    // (the model's own eye bones when it has them — humanoid eyes — else the proportions guess)
    if (replacePainted && !p.eyes.left && !p.eyes.right) {
      try {
        const g = eyeBoneMarkers(this.model, meshes, this.anchor, { left: this.humanoid?.getRawBoneNode('leftEye') ?? null, right: this.humanoid?.getRawBoneNode('rightEye') ?? null })
          ?? guessFaceMarkers(this.model, meshes, this.humanoid?.getRawBoneNode('head') ?? null, p.transform.yaw)?.eyes;
        if (g) eyesCfg = { ...p.eyes, left: g.left, right: g.right, size: g.size };
      } catch (e) { console.warn('face guess', e); }
    }
    if (eyesCfg.mode === 'procedural' && (eyesCfg.left || eyesCfg.right)) {
      const wc = worldCfg({ ...eyesCfg, depth: eyesCfg.depth ?? 0 }, ['size', 'depth']);
      let eyeMeshes = meshes, bakedSkin: (THREE.Color | null)[] | undefined;
      if (replacePainted) {
        try {
          // 1. the model's own eye parts (hidden, or turned into skin where they fill a hole in the face), 2. the eye
          // frames snapped onto what's left, 3. the painted eyes erased from texture copies (src/avatar/bakedEyes.ts)
          const raw = eyeSpots(meshes, this.model, this.anchor, wc);
          const bone = (s: 'leftEye' | 'rightEye') => this.humanoid?.getRawBoneNode(s) ?? null;
          const parts = prepareBakedEyeParts(this.model, meshes, raw.spots.map((s) => ({ frame: s.frame, size: raw.cfg.size })),
            raw.spots.flatMap((s) => (s.isCenter ? [bone('leftEye'), bone('rightEye')] : [bone(s.isLeft ? 'leftEye' : 'rightEye')])).filter((b): b is THREE.Object3D => !!b));
          eyeMeshes = meshes.filter((m) => !m.userData.vtpBakedHidden);
          const placed = eyeSpots(eyeMeshes, this.model, this.anchor, wc, true);
          // (without a slicer the page keeps drawing while the readbacks wait: the wrapper, already under the live anchor, stays
          // hidden until the painted eyes are done. Slicer loads are unchanged: OBS slots build under a detached anchor.)
          this.baked = await whileHidden(this.wrapper, !sl, () => replaceBakedEyes({
            meshes: eyeMeshes, model: this.model, cfg: eyesCfg.replaceBaked!, parts,
            spots: placed.spots.map((s) => ({ frame: s.frame, size: placed.cfg.size, outward: s.isCenter ? 0 : s.isLeft ? 1 : -1 })),
            cacheKey: `${p.id}|${p.modelFile}`, exposure: this.vrm ? (p.look?.vrmExposure ?? 0.6) : 1,
          }));
          warnings.push(...this.baked.info.warnings);
          bakedSkin = this.baked.skin;
          // the fits in profile terms (model space markers, profile-unit size)
          const fit: NonNullable<AvatarRuntime['bakedFit']> = { size: 0, iris: null };
          const sizes: number[] = [];
          placed.spots.forEach((s, k) => {
            const f = this.baked!.fits[k];
            if (!f || s.isCenter) return;
            const m = this.model.worldToLocal(f.center.clone());
            fit[s.isLeft ? 'left' : 'right'] = [+m.x.toFixed(4), +m.y.toFixed(4), +m.z.toFixed(4)];
            sizes.push(f.size / scaleW);
            fit.iris ??= f.iris;
          });
          if (sizes.length) { fit.size = +(sizes.reduce((a, b) => a + b, 0) / sizes.length).toFixed(4); this.bakedFit = fit; }
        } catch (e) { console.warn('painted eyes', e); warnings.push(`Replacing the painted eyes failed: ${(e as Error).message}`); this.baked?.dispose(); this.baked = null; eyeMeshes = meshes.filter((m) => !m.userData.vtpBakedHidden); }
      }
      await st();
      const skin = sampleSkinColor(eyeMeshes, eyesCfg.left ?? eyesCfg.right!, this.model);
      await st();
      this.eyes = new ProceduralEyes(eyeMeshes, this.model, this.anchor, wc, skin, p.brows, { bakedSkin });
      await st();
    }
    this.scaleW = scaleW;
    if (this.eyes && (p.eyes.style === 'bulb' || p.eyes.style === 'inset')) this.eyeDepth = { kind: 'bulb', range: bulbDepthRange(p.eyes.size, p.eyes.protrusion, p.eyes.style) };
    else if (p.eyes.mode === 'model') this.setupEyeBones(p.eyes.depth ?? 0);
    // blush + nose highlight (non-VRM): placed from the procedural eye + mouth markers
    if (!this.vrm && p.eyes.mode === 'procedural' && (p.eyes.left || p.eyes.right)) {
      const nose = p.look?.noseHighlight ?? p.eyes.style === 'anime';
      if (p.blush?.enabled || nose) {
        const fd = new FaceDecals(meshes, this.model, this.anchor, {
          eyeL: p.eyes.left, eyeR: p.eyes.right, mouth: p.mouth.mode === 'procedural' ? p.mouth.center : null,
          eyeSize: p.eyes.size * scaleW, blush: p.blush ?? null, nose,
        });
        if (fd.patches.length) this.faceDecals = fd;
      }
    }

    await st();
    // --- look ---
    // surface styles: resolve + precondition the source materials first (the toon conversion reads their roughness)
    let surf: ReturnType<typeof prepareSurfaceStyles> = null;
    try {
      const worn = [this.costume, ...this.accessories].filter((c): c is AttachedCostume => !!c).map((c) => ({ meshes: c.meshes, surface: c.def.surface }));
      surf = prepareSurfaceStyles(this.model, this.wrapper, p.look, worn);
    } catch (e) { console.warn('surface styles', e); warnings.push(`Surface style failed: ${(e as Error).message}`); }
    await st();
    const toonOpts = { outline: true, outlineColor: '#141414', outlineWidth: 0.0028, look: p.look };
    if (!this.vrm && p.look?.shading === 'realistic') applyRealistic(this.model, p.look);
    else if (!this.vrm) this.outlines = sl ? await runSteps(applyToonSteps(this.model, toonOpts), sl) : applyToon(this.model, toonOpts);
    await st();
    try {
      // drawn face features stay clear of shell fur (radii in wrapper-local metres)
      const face: { p: THREE.Vector3; r: number }[] = [];
      const ws = Math.max(this.wrapper.getWorldScale(new THREE.Vector3()).x, 1e-6);
      if (p.mouth.mode === 'procedural' && p.mouth.center) face.push({ p: this.toWorld(p.mouth.center.position), r: (p.mouth.width * 1.5 + p.mouth.openHeight) * scaleW / ws });
      if (p.eyes.mode === 'procedural') for (const e of [p.eyes.left, p.eyes.right]) if (e) face.push({ p: this.toWorld(e.position), r: p.eyes.size * 1.8 * scaleW / ws });
      this.surfaces = finishSurfaceStyles(surf, this.model, this.outlines, p.look, face);
      if (this.surfaces) warnings.push(...this.surfaces.warnings);
    }
    catch (e) { console.warn('surface styles', e); warnings.push(`Surface style failed: ${(e as Error).message}`); this.surfaces = null; }
    await st();

    // --- eye layout: hide the unused model eye (lids shut, eye bone scaled away, per-side eye meshes) + eye patch
    try {
      this.eyeLayout = setupEyeLayout({
        eyes: p.eyes, model: this.model, anchor: this.anchor, meshes, scaleW,
        eyeBone: (s) => this.humanoid?.getRawBoneNode(s === 'left' ? 'leftEye' : 'rightEye') ?? null,
        headBone: this.humanoid?.getRawBoneNode('head') ?? null,
      });
      if (this.eyeLayout?.info.warning) warnings.push(this.eyeLayout.info.warning);
    } catch (e) { console.warn('eye layout', e); warnings.push(`Eye layout failed: ${(e as Error).message}`); this.eyeLayout = null; }

    await st();
    // --- physics chains ---
    if (p.physics.enabled && !this.vrm) {
      if (sl) await skinnedBoxes(this.model, sl);
      const height = new THREE.Box3().setFromObject(this.model).getSize(new THREE.Vector3()).y || 1.6;
      const colliders = this.physics.buildColliders(this.humanoid, height / 1.6);
      this.physics.buildChains(this.model, this.humanoid, p.physics.chains, p.physics.autoChains, colliders, 0.02 * height);
    }
    this.physics.wind = p.physics.wind;
    await st();

    this.expressions = new ExpressionDriver(this.model, this.vrm, this.profile.faceMap);
    if (this.humanoid) this.retarget = new Retargeter(this.humanoid, this.anchor);
    // the torso's real surface (for the "In front" arm pose) is measured only when that pose is wanted, a couple of ms a frame
    // (update() below): nothing happens here, so no avatar load pays for it
    this.torsoLazy = this.retarget && p.body !== 'quadruped' && p.body !== 'mech' ? new LazyTorsoSurface(() => this.startTorsoJob()) : null;
    if (this.retarget && p.body === 'mech') this.retarget.mech = true; // (the machine places the pilot's arms: no Arms choice)
    // held props close their hand (bat, knuckles, cane): CostumeDef.grip
    if (this.retarget) for (const c of [this.costume, ...this.accessories]) {
      const g = c?.def.grip;
      if (g === 'left' || g === 'both') this.retarget.grip.left = 1;
      if (g === 'right' || g === 'both') this.retarget.grip.right = 1;
    }
    const layers = bodyLayers(p.body);
    if (layers.planted && this.humanoid && this.retarget) {
      this.retarget.quadruped = true;
      if (layers.quadrupedLife) {
        try { this.quadruped = new QuadrupedLife(this.model, this.humanoid.getRawBoneNode('hips')); } catch (e) { console.warn('quadruped', e); this.quadruped = null; }
      } else this.plantedNoLegs = true;     // a thing / a snake: no gait, no weight shift at the hips (the hips stay at rest)
    }
    if (p.rig.retarget) {
      try { this.rigMap = RigMapLife.create(this.model, p.rig.retarget); } catch (e) { console.warn('rig map', e); this.rigMap = null; }
    }
    if (p.body === 'mech') {
      try { this.mech = MechRig.create(this.model, this.humanoid, this.anchor, p.mech, this.retarget); } catch (e) { console.warn('mech', e); this.mech = null; }
      if (!this.mech) warnings.push('Body is set to a walking machine, but the model has no machine bones (mpelvis / mleg_* / mstick_*: shared/mech.ts).');
    }

    if (p.eyes.mode === 'model' && !this.expressions.hasBlink && !this.vrm?.lookAt)
      warnings.push('This model has no eye shapes — place procedural eyes in the Face tab.');
    // --- physical mouth: profile rig, else jaw / upper-head bones found on the model (uploads work as-is)
    const rigCfg = p.mouth.rig ?? (p.mouth.mode !== 'procedural' && !this.expressions.hasArkit && !this.expressions.hasVisemes ? detectJawRig(this.model) : null);
    if (rigCfg) {
      const d = new JawRigDriver(this.model, this.anchor, rigCfg);
      if (d.ok) this.jawRig = d;
      else warnings.push(`Mouth rig: bone '${rigCfg.jawBone}' not found on the model.`);
    }
    this.mechanical = !!p.rig.mechanical;
    this.model.traverse((o) => {
      const mats = (o as THREE.Mesh).isMesh ? ([] as THREE.Material[]).concat((o as THREE.Mesh).material) : [];
      for (const m of mats) {
        const sm = m as THREE.MeshStandardMaterial;
        // glass over the eyes (gas-mask lenses, goggles, glasses, visors): see-through, drawn AFTER the
        // procedural eyes so they always show through it
        if (/lens|glass|visor|goggle/i.test(m.name)) {
          m.transparent = true;
          m.depthWrite = false;
          if (m.opacity >= 0.99) m.opacity = 0.3;
          (o as THREE.Mesh).renderOrder = 10;
        }
        if (/voice_?glow/i.test(m.name) && sm.emissive && !this.voiceGlow.some((g) => g.mat === sm)) {
          if (sm.emissive.getHex() === 0) sm.emissive.copy(sm.color ?? new THREE.Color(1, 1, 1));
          this.voiceGlow.push({ mat: sm, base: sm.emissiveIntensity || 1 });
        }
      }
    });

    if (p.mouth.mode === 'model' && !this.jawRig && !this.expressions.hasArkit && !this.expressions.hasVisemes)
      warnings.push('This model has no mouth shapes — place a procedural mouth in the Face tab.');
    await st();

    // --- viseme rig: detect mouth capabilities, measure shape strength, build the per-model mapping
    try {
      this.visemeRig = new VisemeRig({
        profile: p, model: this.model, vrm: this.vrm, expressions: this.expressions, hasProceduralMouth: !!this.mouth,
        jaw: this.jawRig ? { kind: this.jawRig.cfg.kind, drive: p.mouth.rig?.drive ?? 'motion' } : null,
        mechanical: this.mechanical, voiceGlow: this.voiceGlow.length > 0,
      });
    } catch (e) {
      console.warn('viseme rig', e);
      this.visemeRig = null;
    }

    // (the profile's rules + automatic ones: a throat / vocal sac morph puffs on loud speech with no setup)
    try { const r = effectiveMouthRules(p.mouth.rules, this.model); const d = r ? new MouthRulesDriver(r, this.model) : null; this.mouthRules = d?.active ? d : null; } catch (e) { console.warn('mouth rules', e); this.mouthRules = null; }

    await st();
    try { this.propFx = PropFx.create(this.model, this.anchor, this.wrapper.scale.x); } catch (e) { console.warn('prop fx', e); this.propFx = null; }
    await st();

    let triangles = 0;
    for (const m of collectMeshes(this.model, { costumes: true })) triangles += (m.geometry.index?.count ?? m.geometry.attributes.position.count) / 3;
    let bones = 0;
    this.model.traverse((o) => { if ((o as THREE.Bone).isBone) bones++; });
    this.info = {
      rig, meshes: meshes.length, triangles: Math.round(triangles), bones,
      expressions: this.expressions.summary,
      proceduralEyes: !!this.eyes, proceduralMouth: !!this.mouth,
      springJoints: this.vrm?.springBoneManager?.joints.size ?? this.physics.springs.joints.size,
      warnings,
      mouthCaps: this.visemeRig?.caps,
      ...(this.baked ? { bakedEyes: this.baked.info } : {}),
      ...(merged ? { mergedPrimitives: merged } : {}),
    };
    this.srcAssoc = null;
    // food & drink: rest-pose hand / mouth measurements (vector math only; the layer itself is lazy)
    try { this.snackRest = measureSnackRest(this); } catch (e) { console.warn('snack rest', e); this.snackRest = null; }
    // (every skinned part's box now, in slices: the page's placement measures the model right after — Box3.setFromObject)
    if (sl) await skinnedBoxes(this.model, sl);
  }

  /** VRoid splits a mesh into many primitives that share one material (hair: 100+): merge each such set into one
   *  SkinnedMesh on the same skeleton + bindMatrix, so it costs one draw call per pass instead of 100+ (and one matrix
   *  update instead of 100+). Same triangles, shader and skinning, but not bit-exact on screen at any AA setting:
   *  where two hair cards sit at exactly the same depth, draw order now decides the winner, so a few isolated hair
   *  pixels can differ by camera angle (src/avatar/mergePrimitives.ts header). Transparent / depthWrite-off parts,
   *  morph-target meshes (the face) and surface-styled parts are never merged. Off with localStorage vtp.mergePrims = '0'.
   *
   *  Runs AFTER the costume + accessory fit, never before it: costumeFit.ts judges every body mesh on its own (the
   *  "inverted normals" centroid test that flips a whole mesh's normals, the per-mesh vertex weld of the hide pass), so
   *  merging first changed its answers. On kairo + kairo_formal 4 small nape hair primitives stopped being flipped
   *  and 163 collar vertices moved by up to 32 mm. Merging afterwards leaves the fit exactly as it was. Primitives the
   *  fit changed are left alone: the ones the costume hides (invisible, no draw call) and the ones whose covered
   *  triangles it dropped (their restore() keeps a reference to the original geometry). */
  private mergeVrmPrimitives(p: AvatarProfile): RuntimeInfo['mergedPrimitives'] {
    const assoc = this.srcAssoc;
    if (!this.vrm || !assoc || !mergeEnabled()) return undefined;
    try {
      // names the profile finds meshes by (costume hides, hair / surface overrides): a primitive only merges with
      // primitives that match the same names, so those lookups behave exactly as before
      const refs = [...(p.costumes ?? []).flatMap((c) => c.hides ?? []), ...(p.look?.hairMeshes ?? []), ...Object.keys(p.look?.surfaces ?? {})];
      // surface styles (felt stitches, keratin, fur shells...) work per geometry (welds, borders): a styled part
      // keeps its own primitives so the style looks exactly as before
      const styled = (m: THREE.Mesh) => ([] as THREE.Material[]).concat(m.material).some((x) => !!x && surfaceStyleFor(m, x, p.look, undefined) !== null);
      // touched by the costume fit: hidden by a costume's `hides`, or covered triangles dropped (costumeFit hide pass)
      const fitted = (m: THREE.Mesh) => !!m.userData.vtpHidden || !!m.geometry.userData.vtpFullIndex;
      const r = mergeSkinnedPrimitives(this.model, {
        // only primitives of one multi-primitive glTF mesh (never a glTF node itself: named nodes stay put)
        sourceOf: (m) => { const a = assoc.get(m); return a && a.nodes === undefined && a.primitives !== undefined && !fitted(m) && !styled(m) ? a.meshes : null; },
        extraKey: nameRefKey(refs),
      });
      if (!r.groups.length) return undefined;
      // three-vrm's first-person annotations list primitives: point them at the merged meshes
      const into = new Map<THREE.Object3D, THREE.SkinnedMesh>();
      for (const g of r.groups) for (const m of g.from) into.set(m, g.into);
      for (const a of this.vrm.firstPerson?.meshAnnotations ?? []) {
        const out: THREE.Mesh[] = [];
        for (const m of a.meshes) { const x = into.get(m) ?? m; if (!out.includes(x)) out.push(x); }
        a.meshes = out;
      }
      const info = { primitives: r.primitives, meshes: r.meshes, ms: +r.ms.toFixed(2) };
      console.debug(`[avatar] merged ${info.primitives} primitives into ${info.meshes} mesh(es) in ${info.ms} ms`);
      return info;
    } catch (e) { console.warn('merge primitives', e); return undefined; }
  }

  /** Costume fit pass context: face keep-out spheres (mouth patch area, eyes) + humanoid body parts. */
  private fitContext(p: AvatarProfile, scaleW: number): FitOptions {
    const keepVisible: FitOptions['keepVisible'] = [];
    const at = (m: SurfaceMarker) => new THREE.Vector3(...m.position).applyMatrix4(this.model.matrixWorld);
    if (p.mouth.mode === 'procedural' && p.mouth.center) {
      // the area the mouth actually draws + deforms (its patch radius is much larger, but the patch
      // discards everywhere else, so fully covered triangles out there are never missed)
      const w = p.mouth.width * scaleW, h = p.mouth.openHeight * scaleW;
      keepVisible.push({ center: at(p.mouth.center), radius: Math.min(w * 1.7 + h * 1.4, Math.max(p.mouth.influence * scaleW, w + h)) });
    }
    if (p.eyes.mode === 'procedural') for (const e of [p.eyes.left, p.eyes.right]) if (e) keepVisible.push({ center: at(e), radius: p.eyes.size * scaleW * 2.4 });
    const anchors = new Map<THREE.Object3D, string>();
    if (this.humanoid) for (const role of Object.keys(this.humanoid.humanBones)) {
      const node = this.humanoid.getRawBoneNode(role as VRMHumanBoneName);
      if (node) anchors.set(node, role);
    }
    return { keepVisible, anchors };
  }

  /** What the torso measurement found (diagnostics): the vertices used, the work it took (ms, over all its slices), how many slices had data; null = not measured (yet). */
  torsoInfo: { verts: number; ms: number; measured: number } | null = null;
  /** The torso measurement, started the first time the "In front" arm pose is wanted; null = this avatar never gets one. */
  torsoLazy: LazyTorsoSurface | null = null;
  /** The torso's real surface from the mesh (clothes included), once per avatar + model, cached: the "In front" arm pose keeps the
   *  hands off it (src/avatar/torsoSurface.ts, armPose.ts). The measurement runs in slices of ~2 ms a frame (the pose uses the
   *  skeleton's prism until it is ready) and is independent of the pose the skeleton is in (bind-pose vertices). */
  private startTorsoJob(): TorsoJob {
    const hum = this.humanoid, rt = this.retarget;
    if (!hum || !rt) return { surface: null, step: () => true };
    const roleOf = new Map<THREE.Object3D, string>();
    for (const role of Object.keys(hum.humanBones)) { const n = hum.getRawBoneNode(role as VRMHumanBoneName); if (n) roleOf.set(n, role); }
    this.model.updateWorldMatrix(true, true);
    const hips = rt.restAvatar('hips'), la = rt.restAvatar('leftUpperArm'), ra = rt.restAvatar('rightUpperArm');
    if (!hips || !la || !ra) return { surface: null, step: () => true };
    return torsoSurfaceJob(this.profile.id, collectMeshes(this.model, { costumes: true }), (b) => roleOf.get(b),
      { toAv: rt.worldToAvatar().multiply(this.model.matrixWorld), root: this.model, hips, leftArm: la, rightArm: ra, leftElbow: rt.restAvatar('leftLowerArm'), leftWrist: rt.restAvatar('leftHand'), rightElbow: rt.restAvatar('rightLowerArm'), rightWrist: rt.restAvatar('rightHand') });
  }
  private tickTorso() {
    const lazy = this.torsoLazy;
    if (!lazy || !this.retarget) return;
    try {
      if (!lazy.tick(true, 2)) return;
      const s = lazy.surface;
      this.retarget.setTorsoSurface(s);
      this.torsoInfo = s ? { verts: s.verts, ms: s.ms, measured: s.measured } : null;
    } catch (e) { console.warn('torso surface', e); this.torsoLazy = null; this.retarget.setTorsoSurface(null); }
  }

  /** Live-update the anime surface look (rim / shadow tint / softness / hair shine) without a rebuild. */
  setLook(look: LookConfig) { if (!this.vrm) setToonLook(this.model, look); this.surfaces?.setLook(look); }

  /** Pose the avatar at rest (for placing markers precisely). */
  setResting(on: boolean) {
    this.resting = on;
    this.detail?.pin('rest', on);   // markers are placed on the full model
    if (on && this.humanoid) {
      this.humanoid.resetNormalizedPose();
      this.humanoid.update();
    }
  }

  update(frame: TrackingFrame, body: BodyTargets | null, tune: TrackingTuning, dt: number, aspect: number, bonesIn?: TrackingFrame['bones']) {
    if (this.flat) { this.updateFlat(frame, tune, dt); runAvatarLate(this, dt); return undefined; }   // (beta.16 late hook: the throw lane's flinch, src/avatar/b16Hooks.ts)
    let f = frame;
    // face life when the camera can't see the face: voice-driven (blinks, gaze, head, brows from the voice's
    // rhythm + pitch) with a smooth hand-over; legacy random idle life if disabled or on any failure
    // (a frame marked `life` already carries the studio's — OBS output pages show exactly that)
    this.lifeFrame = null;
    if (frame.life !== undefined) { /* applied upstream */ }
    else if (this.useVoiceLife()) {
      try { this.voiceLife ??= new VoiceLife(this.profile.speechMotion); f = this.voiceLife.apply(frame, dt); this.lifeFrame = { ...f, life: Math.round(this.voiceLife.weight * 1000) / 1000 }; }
      catch (e) { console.warn('voice life', e); this.voiceLifeOff = true; this.voiceLife = null; if ((!frame.tracked || (frame.starve ?? 0) > 0.3) && (frame.lifeGain ?? 1) > 0) f = this.idleLife(frame, dt); }
    } else if ((!frame.tracked || (frame.starve ?? 0) > 0.3) && (frame.lifeGain ?? 1) > 0) f = this.idleLife(frame, dt);   // (a starved face: idle life too)
    // speech visemes → this model's controls (+ emotive layer); any failure falls back to the plain frame
    let vr: ReturnType<VisemeRig['apply']> | null = null;
    if (this.visemeRig && !this.resting) {
      try { vr = this.visemeRig.apply(f, dt); f = vr.frame; } catch (e) { vr = null; if (!this.visemeWarned) { this.visemeWarned = true; console.warn('viseme rig', e); } }
    }
    // (untracked frames get their talking body language from voice life above)
    if (this.profile.speechMotion?.enabled && !this.resting && (frame.tracked || (!this.voiceLife && frame.life === undefined))) {
      this.speechMotion ??= new SpeechMotion(this.profile.speechMotion);
      try { f = this.speechMotion.apply(f, dt); } catch (e) { console.warn('speech motion', e); this.speechMotion = null; }
    }
    if (this.mouthRules && !this.resting) {
      try { f = this.mouthRules.apply(f, dt); } catch (e) { console.warn('mouth rules', e); this.mouthRules = null; }
    }
    let bones: TrackingFrame['bones'] | undefined;
    if (this.resting) {
      // hold rest pose
    } else if (bonesIn && this.retarget) {
      this.retarget.applyBones(bonesIn);
    } else if (this.retarget) {
      if (this.torsoLazy && !this.torsoLazy.done && armSettings(tune).mode === 'front') this.tickTorso();
      bones = this.retarget.update(f, body, tune, dt);
    }
    if (this.poseHook && !this.resting && this.humanoid) {
      try { this.poseHook(this, dt); } catch (e) { console.warn('pose hook', e); this.poseHook = null; }
    }
    if (this.humanoid && !this.resting && !this.quadruped && (frame.emote || this.emotes?.playing)) {
      try {
        this.emotes ??= new EmoteLayer(this.humanoid, this.vrm?.meta?.metaVersion === '0');
        this.emotes.apply(frame.emote, dt, !!this.poseHook);
      } catch (e) { console.warn('emote', e); this.emotes = null; }
    }
    // walking machine: body bones to rest (the humanoid places the pilot against them) + hands onto the sticks while
    // travelling (after the emotes: the grips win while it walks)
    if (this.mech) this.applyMech(dt, true);
    // modelled eyeballs (eyes mode 'model' + leftEye/rightEye bones, e.g. the human creator): gaze turns the
    // eye bones, same convention as VRM lookAt (yaw = gaze x, pitch = gaze y)
    if (!this.vrm && this.humanoid && this.profile.eyes.mode === 'model') {
      const r = THREE.MathUtils.degToRad(this.profile.eyes.gazeRange || 20);
      const [gx, gy] = this.resting ? [0, 0] : f.gaze;
      for (const e of ['leftEye', 'rightEye'] as const) this.humanoid.getNormalizedBoneNode(e)?.rotation.set(gy * r * 0.7, gx * r, 0);
    }
    if (!this.vrm) this.humanoid?.update();
    if (!this.vrm) this.applyQuadruped(dt);
    if (!this.vrm) this.applyRigMap(f, dt);
    if (!this.vrm && this.clips?.active) { try { this.clips.update(dt, this.resting); } catch (e) { console.warn('clips', e); this.clips = null; } }
    if (!this.vrm) this.applyMech(dt, false);
    if (!this.vrm) this.applyNeck(dt);
    // cartoon squash & stretch: the head stretches as the jaw drops, widens with a grin
    const cartoon = tune.cartoon ?? 1;
    const headBone = this.humanoid?.getRawBoneNode('head');
    if (headBone && !this.vrm && !this.mechanical) {
      headBone.userData.baseScale ??= headBone.scale.clone();
      const b = headBone.userData.baseScale as THREE.Vector3;
      const open = f.mouth.open, grin = f.mouth.smile;
      const sy = 1 + cartoon * (0.05 * open - 0.025 * grin), sx = 1 + cartoon * (-0.02 * open + 0.035 * grin);
      headBone.scale.set(b.x * sx, b.y * sy, b.z * sx);
    }
    if (this.eyes) this.eyes.cartoon = this.mechanical ? 0 : cartoon;
    // gesture effects: spawn new events at the avatar's hand
    if (!this.fx) {
      const hgt = this.bounds().getSize(new THREE.Vector3()).y || 1.6;
      this.fx = new GestureEffects(hgt / 1.6);
      this.anchor.add(this.fx.group);
    }
    this.fx.consume(f.fx, (side) => {
      const b = this.humanoid?.getRawBoneNode(side === 'left' ? 'leftHand' : 'rightHand') ?? this.humanoid?.getRawBoneNode('head');
      if (!b) return null;
      const w = b.getWorldPosition(new THREE.Vector3());
      return this.anchor.worldToLocal(w).add(new THREE.Vector3(0, 0.05, 0.12));
    });
    this.fx.update(dt);
    // --- full-body motion: follow the head through space (lateral, vertical, depth) ---
    // (a quadruped stays planted on its four legs: head lean goes to the chest / neck, never slides the body)
    // (a walking machine stays on its feet too: the pilot leans through the torso only)
    const tr = this.quadruped || this.plantedNoLegs || this.mech ? [0, 0, 0] : tune.translate ?? [1, 0.7, 1.2];
    const [hx, hy, hz] = this.resting ? [0, 0, 0] : f.headPos;
    const tgt = new THREE.Vector3(
      THREE.MathUtils.clamp(hx * tr[0], -0.7, 0.7),
      THREE.MathUtils.clamp(hy * tr[1], -0.3, 0.3),
      THREE.MathUtils.clamp(hz * tr[2], -0.9, 0.7),
    );
    this.motion.lerp(tgt, 1 - Math.exp(-30 * dt)); // head position is already filtered + predicted
    const o = this.profile.transform.offset;
    this.wrapper.position.set(o[0] + this.motion.x, o[1] + this.motion.y, o[2] + this.motion.z);
    // one-eyed model eyes: the hidden eye stays shut whatever the tracking says
    if (this.eyeLayout) f = { ...f, face: this.eyeLayout.closeHidden(f.face, estimateEmotions(f.face).happy, this.expressions.hasArkit) };
    // painted-eye replacement: the model's own eye shapes stay still (its lids / painted eye would squash under the
    // generated eyes); the generated eyes below still read every eye channel
    this.expressions.apply(this.baked ? { ...f, face: holdModelEyes(f.face) } : f, tune.expressiveness, vr ? { vowels: vr.vowels, emotionCap: vr.emotionCap } : undefined);
    this.expressions.applySpeechExtras(vr?.extras);
    this.mouthRules?.applyMorphs(this.resting);
    const face = f.face;
    const g = (k: string) => face[k] ?? 0;
    if (this.mouth) {
      this.mouth.update({
        open: f.mouth.open, wide: f.mouth.wide,
        smileL: g('mouthSmileLeft'), smileR: g('mouthSmileRight'),
        frownL: g('mouthFrownLeft'), frownR: g('mouthFrownRight'),
        pucker: clamp01(f.mouth.pucker), funnel: clamp01(f.mouth.funnel), tongue: clamp01(f.mouth.tongue),
        shift: THREE.MathUtils.clamp((g('mouthLeft') - g('mouthRight')) * 0.25, -0.22, 0.22),
        upperUp: (g('mouthUpperUpLeft') + g('mouthUpperUpRight')) / 2,
        lowerDown: (g('mouthLowerDownLeft') + g('mouthLowerDownRight')) / 2,
        press: (g('mouthPressLeft') + g('mouthPressRight')) / 2 + (g('mouthRollLower') + g('mouthRollUpper')) / 4,
        cheekPuff: g('cheekPuff'),
        jaw: g('jawLeft') - g('jawRight') + (g('mouthLeft') - g('mouthRight')) * 0.3,
        stretchL: g('mouthStretchLeft'), stretchR: g('mouthStretchRight'),
        // camera lip capture lags speech by ~90 ms — while talking, the voice leads the shape instead
        lips: f.lips, capture: f.tracked ? 0.65 * (1 - 0.7 * (f.mouth.speak ?? 0)) : 0,
        fv: f.mouth.fv ?? 0, sib: f.mouth.sib ?? 0,
        tongueUp: vr?.extras.tongueUp ?? 0, tongueTip: vr?.extras.tongueTip ?? 0,
      });
    }
    if (this.eyes) {
      const emo = estimateEmotions(face);
      this.eyes.update({
        blinkL: g('eyeBlinkLeft'), blinkR: g('eyeBlinkRight'),
        squintL: Math.max(g('eyeSquintLeft'), g('cheekSquintLeft') * 0.8), squintR: Math.max(g('eyeSquintRight'), g('cheekSquintRight') * 0.8),
        wideL: g('eyeWideLeft'), wideR: g('eyeWideRight'),
        gazeYaw: f.gaze[0], gazePitch: f.gaze[1],
        // small dead zones: faint brow tension shouldn't read as a scowl
        angryL: clamp01((g('browDownLeft') - 0.15) * 1.3), angryR: clamp01((g('browDownRight') - 0.15) * 1.3),
        sadL: clamp01((g('browInnerUp') * 0.9 - g('browDownLeft') - 0.12) * 1.3), sadR: clamp01((g('browInnerUp') * 0.9 - g('browDownRight') - 0.12) * 1.3),
        surprise: emo.surprised,
        happy: emo.happy,
        browInnerUp: clamp01(g('browInnerUp') - 0.08), browDownL: clamp01(g('browDownLeft') - 0.1), browDownR: clamp01(g('browDownRight') - 0.1),
        browOuterUpL: g('browOuterUpLeft'), browOuterUpR: g('browOuterUpRight'),
      });
      this.eyes.setAspect(aspect);
    }
    if (this.faceDecals) {
      const cheek = (g('cheekSquintLeft') + g('cheekSquintRight')) / 2;
      this.faceDecals.update({ smile: (g('mouthSmileLeft') + g('mouthSmileRight')) / 2, happy: estimateEmotions(face).happy, cheekSquint: cheek });
    }
    if (this.vrm) {
      if (this.vrm.lookAt) {
        this.vrm.lookAt.autoUpdate = false;
        this.vrm.lookAt.yaw = this.baked ? 0 : f.gaze[0] * 20;
        this.vrm.lookAt.pitch = this.baked ? 0 : -f.gaze[1] * 15;
      }
      this.neck?.configure(this.profile.neck);
      if (this.neck?.needsStep || this.quadruped || this.mech) {
        // the neck rig must run between the humanoid pose and the spring bones: pose, neck, then the rest of vrm.update
        const hm = this.vrm.humanoid;
        hm.update();
        this.applyQuadruped(dt);
        this.applyMech(dt, false);
        this.applyNeck(dt);
        hm.update = () => {};
        try { this.vrm.update(dt); } finally { delete (hm as { update?: unknown }).update; }
      } else this.vrm.update(dt);
    } else if (this.profile.physics.enabled) {
      this.model.updateWorldMatrix(true, true);
      this.physics.update(dt);
    }
    // physical mouth last: the humanoid / VRM update above re-poses mapped bones (a humanoid 'jaw' too)
    // speech shows as jaw MOTION or as LIGHT (one or the other), per the profile's mouth rig
    const lightDrive = this.profile.mouth.rig?.drive === 'light' || !this.jawRig;
    if (this.jawRig && !this.resting) {
      if (lightDrive) this.jawRig.update(0, 0, dt, this.mechanical);
      else this.jawRig.update(f.mouth.open, THREE.MathUtils.clamp(g('jawLeft') - g('jawRight'), -1, 1), dt, this.mechanical, (this.visemeRig?.last.engage ?? 0) > 0.5);
      this.model.updateWorldMatrix(true, true);
    }
    if (this.voiceGlow.length) {
      if (lightDrive) {
        // accentuate the audio: snappy attack so syllables read, quick release so words separate
        const target = Math.min(1.6, (f.mouth.speak ?? 0) * 0.35 + f.mouth.open * 1.5 + (f.mouth.sib ?? 0) * 0.3);
        const k = target > this.glowLevel ? 1 - Math.exp(-70 * dt) : 1 - Math.exp(-18 * dt);
        this.glowLevel += (target - this.glowLevel) * k;
        for (const g2 of this.voiceGlow) g2.mat.emissiveIntensity = g2.base * (0.15 + 2.4 * this.glowLevel);
      } else {
        this.glowLevel = 0.5;
        for (const g2 of this.voiceGlow) g2.mat.emissiveIntensity = g2.base; // steady: the jaw does the talking
      }
    }
    for (const o of this.outlines) ((o.material as THREE.ShaderMaterial).uniforms.uAspect.value = aspect);
    if (this.surfaces) { try { this.surfaces.update(dt, this.humanoid?.getRawBoneNode('hips') ?? this.wrapper); } catch (e) { console.warn('surface styles', e); this.surfaces = null; } }
    if (this.propFx) {
      // a draw on the cigar = puckered / pressed lips; opening afterwards puffs smoke
      const draw = Math.max(clamp01(f.mouth.pucker), (g('mouthPressLeft') + g('mouthPressRight')) * 0.5, g('mouthRollLower') * 0.6);
      try { this.propFx.update(dt, this.resting ? 0 : draw, this.resting ? 0 : f.mouth.open); } catch (e) { console.warn('prop fx', e); this.propFx.dispose(); this.propFx = null; }
    }
    // food & drink: props in the hands, mess on the face (after every bone is posed)
    if ((f.snack || this.snacks) && !this.resting) {
      if (!this.snacks && this.snackRest) this.snacks = new SnackFx(this, this.snackRest);
      try { this.snacks?.update(f.snack, dt, aspect); } catch (e) { console.warn('snacks', e); this.snacks?.dispose(); this.snacks = null; this.snackRest = null; }
    }
    runAvatarLate(this, dt);   // beta.16: additive offsets on the solved pose (head flinch, model nudge), src/avatar/b16Hooks.ts
    return bones;
  }

  /** Quadruped step (after the humanoid pose, before the neck rig): planted legs, idle life, gait. */
  private applyQuadruped(dt: number) {
    if (!this.quadruped) return;
    try { this.quadruped.apply(dt, this.resting); }
    catch (e) { console.warn('quadruped', e); this.quadruped = null; }
  }

  /** Add a clip already fitted to this model (clipFromRoleJson / retargetClip) and, with `play`, start it. */
  addClip(clip: import('three').AnimationClip, play = false, loop = true) {
    this.clips ??= new ClipPlayer(this.model);
    this.clips.add(clip);
    if (play) this.clips.play(clip.name, { loop });
  }
  playClip(name: string, loop = true) { return this.clips?.play(name, { loop }) ?? false; }
  stopClip() { this.clips?.stop(); }

  /** Auto-rig retarget map (wings, idle sway, head-turn shares): after the humanoid pose and the quadruped layer. */
  private applyRigMap(f: TrackingFrame, dt: number) {
    if (!this.rigMap) return;
    try { this.rigMap.apply(dt, { resting: this.resting, tracked: !!f.tracked, head: f.head }); }
    catch (e) { console.warn('rig map', e); this.rigMap = null; }
  }

  /** Walking machine (src/avatar/mech.ts): `pre` = before humanoid.update (body bones to rest, grips), else after it (body
   *  bob, legs, sticks, pistons; before the neck rig and the springs). */
  private applyMech(dt: number, pre: boolean) {
    if (!this.mech) return;
    try { if (pre) this.mech.preHumanoid(dt, this.resting); else this.mech.postHumanoid(dt, this.resting); }
    catch (e) { console.warn('mech', e); this.mech = null; }
  }

  /** Neck rig step (after the humanoid pose): length + tilt / sway / stiffness / turn limit / smoothing. */
  private applyNeck(dt: number) {
    if (!this.neck) return;
    try { this.neck.apply(dt, this.profile.neck, this.resting); }
    catch (e) { console.warn('neck rig', e); this.neck.reset(); this.neck = null; }
  }

  /** Voice life on? (profile speechMotion.voiceLife !== false, localStorage vtp.voiceLife !== '0', no earlier failure)
   *  The storage switch is re-read at most once a second (this runs every frame, in every view). */
  private useVoiceLife() {
    if (this.voiceLifeOff || this.profile.speechMotion?.voiceLife === false) return false;
    const now = performance.now();
    if (!(now - this.voiceLifeLs.at < 1000)) {
      let off = false;
      try { off = globalThis.localStorage?.getItem('vtp.voiceLife') === '0'; } catch { /* no storage */ }
      this.voiceLifeLs = { at: now, off };
    }
    return !this.voiceLifeLs.off;
  }
  private voiceLifeLs = { at: Number.NEGATIVE_INFINITY, off: false };

  /** When the face isn't tracked: natural blinks, wandering gaze, breathing (from the retargeter). */
  private idleLife(frame: TrackingFrame, dt: number): TrackingFrame {
    const s = this.idle;
    s.blinkT -= dt;
    if (s.blinkT <= 0) { s.blink = 1; s.blinkT = 2 + Math.random() * 4; }
    const blink = s.blink > 0 ? Math.sin((1 - s.blink) * Math.PI) : 0;
    s.blink = Math.max(0, s.blink - dt / 0.16);
    s.gazeT -= dt;
    if (s.gazeT <= 0) { s.gazeTarget.set((Math.random() - 0.5) * 0.5, (Math.random() - 0.5) * 0.3); s.gazeT = 1 + Math.random() * 2.5; }
    s.gaze.lerp(s.gazeTarget, 1 - Math.exp(-12 * dt));
    return {
      ...frame,
      face: { ...frame.face, eyeBlinkLeft: Math.max(blink, frame.face.eyeBlinkLeft ?? 0), eyeBlinkRight: Math.max(blink, frame.face.eyeBlinkRight ?? 0) },
      gaze: [s.gaze.x, s.gaze.y],
    };
  }

  /** Raycast the model (NDC coords) → marker in model space. */
  /** 2D avatars: the picture follows the head through space (a little), the FlatAvatar does the rest. */
  private updateFlat(frame: TrackingFrame, tune: TrackingTuning, dt: number) {
    const fl = this.flat!;
    if (fl.mode === 'card' || fl.mode === 'overlay') {
      const tr = tune.translate ?? [1, 0.7, 1.2];
      const [hx, hy] = this.resting || !frame.tracked ? [0, 0] : frame.headPos;
      this.motion.lerp(new THREE.Vector3(THREE.MathUtils.clamp(hx * tr[0] * 0.5, -0.35, 0.35), THREE.MathUtils.clamp(hy * tr[1] * 0.5, -0.15, 0.15), 0), 1 - Math.exp(-20 * dt));
      const o = this.profile.transform.offset;
      this.wrapper.position.set(o[0] + this.motion.x, o[1] + this.motion.y, o[2]);
    }
    fl.update(this.resting ? { ...frame, tracked: false, head: [0, 0, 0], mouth: { ...frame.mouth, open: 0, speak: 0 } } : frame, dt);
  }

  pick(ndc: THREE.Vector2, camera: THREE.Camera): SurfaceMarker | null {
    if (this.flat) return null;
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, camera);
    const targets = collectMeshes(this.model);
    const hit = ray.intersectObjects(targets, false)[0];
    if (!hit || !hit.face) return null;
    this.model.updateWorldMatrix(true, false);
    const inv = this.model.matrixWorld.clone().invert();
    const p = hit.point.clone().applyMatrix4(inv);
    const nW = hit.face.normal.clone().transformDirection(hit.object.matrixWorld);
    const nM = nW.transformDirection(inv);
    return { position: p.toArray() as Vec3, normal: nM.toArray() as Vec3 };
  }

  /** Model eye bones (VRM / humanoid leftEye + rightEye) at rest: remember where they sit and which way is "out" (the
   *  character's forward, in each bone's parent space), then apply the profile depth. */
  private setupEyeBones(depth: number) {
    const bones = (['leftEye', 'rightEye'] as const).map((b) => this.humanoid?.getRawBoneNode(b) ?? null).filter((b): b is THREE.Object3D => !!b?.parent);
    if (!bones.length) return;
    this.model.updateWorldMatrix(true, true);
    const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(this.anchor.getWorldQuaternion(new THREE.Quaternion()));
    const pos = bones.map((b) => b.getWorldPosition(new THREE.Vector3()));
    bones.forEach((b, i) => {
      const at = b.parent!.worldToLocal(pos[i].clone());
      this.eyeBones.push({ bone: b, base: b.position.clone(), dir: b.parent!.worldToLocal(pos[i].clone().add(fwd)).sub(at) });
    });
    const ipd = pos.length === 2 ? pos[0].distanceTo(pos[1]) / Math.max(this.scaleW, 1e-6) : NaN;
    this.eyeDepth = { kind: 'bones', range: modelDepthRange(ipd) };
    this.setEyeDepth(depth);
  }

  /** Eye depth, live (no rebuild): profile units, in (−) / out (+) along the face normal, clamped to eyeDepth.range. */
  setEyeDepth(d: number) {
    if (!this.eyeDepth) return;
    const v = clampEyeDepth(d, this.eyeDepth.range) * this.scaleW;
    if (this.eyeDepth.kind === 'bulb') this.eyes?.setDepth(v);
    else for (const e of this.eyeBones) e.bone.position.copy(e.base).addScaledVector(e.dir, v);
  }

  /** Model-space → world (for drawing marker gizmos). */
  toWorld(p: Vec3) { return new THREE.Vector3(...p).applyMatrix4(this.model.matrixWorld); }

  /** World bounds. A 2D card: what it draws (its picture's opaque bounds, a bust from its virtual person's feet), never
   *  the padded picture plane, halo margin or floor shadow — those made rooms shrink padded art and framing miss it. */
  bounds() { return this.flat?.contentBox(true) ?? new THREE.Box3().setFromObject(this.model); }
  /** A 2D card's drawn art alone (world), for framing it; null for 3D avatars (and walking TVs / monitors). */
  cardBox(): { box: THREE.Box3; bust: boolean } | null { const b = this.flat?.contentBox(false); return b ? { box: b, bust: this.flat!.framing === 'bust' } : null; }

  /** Face centre + size in world space, from markers (best) or the head bone. */
  faceInfo(): { center: THREE.Vector3; size: number } | undefined {
    if (this.flat) return this.flat.faceWorld();
    const p = this.profile;
    const pts = [p.eyes.mode === 'procedural' ? p.eyes.left : null, p.eyes.mode === 'procedural' ? p.eyes.right : null, p.mouth.mode === 'procedural' ? p.mouth.center : null]
      .filter((m): m is SurfaceMarker => !!m).map((m) => this.toWorld(m.position));
    const box = this.bounds();
    const H = box.max.y - box.min.y;
    if (pts.length >= 2) {
      const c = pts.reduce((a, b) => a.add(b), new THREE.Vector3()).multiplyScalar(1 / pts.length);
      let spread = 0;
      for (const a of pts) for (const b of pts) spread = Math.max(spread, a.distanceTo(b));
      return { center: c, size: Math.max(spread * 0.9, H * 0.12) };
    }
    // VRM / humanoid eye bones (VRoid has them): a far tighter face anchor than the head bone
    const le = this.humanoid?.getRawBoneNode('leftEye'), re = this.humanoid?.getRawBoneNode('rightEye');
    if (le && re) {
      const a = le.getWorldPosition(new THREE.Vector3()), b = re.getWorldPosition(new THREE.Vector3());
      const c = a.clone().add(b).multiplyScalar(0.5).add(new THREE.Vector3(0, -H * 0.006, 0));
      return { center: c, size: Math.max(a.distanceTo(b) * 3.2, H * 0.06) };
    }
    const head = this.humanoid?.getRawBoneNode('head');
    if (!head) return undefined;
    const c = head.getWorldPosition(new THREE.Vector3());
    return { center: c.add(new THREE.Vector3(0, H * 0.05, 0)), size: H * 0.16 };
  }

  dispose() {
    this.flat?.dispose();   // (a 2D avatar: its card / TV / monitor + the source's canvas, bitmaps and files)
    this.detail?.dispose();   // first: the original triangle lists go back before anything restores its own
    this.surfaces?.dispose();
    this.costume?.dispose();
    for (const a of this.accessories) a.dispose();
    this.mouth?.dispose();
    this.eyes?.dispose();
    this.baked?.dispose();
    this.eyeLayout?.dispose();
    this.faceDecals?.dispose();
    this.fx?.dispose();
    this.snacks?.dispose();
    this.propFx?.dispose();
    this.mech?.dispose();
    this.wrapper.removeFromParent();
    // geometry + materials, and what material.dispose() leaves: their textures (glTF maps, outline hull maps; bitmaps
    // closed) and the skeletons' bone textures (src/avatar/gpuDispose.ts)
    disposeMeshes(this.model);
  }
}

interface WornCostume { def: CostumeDef; gltf: GLTF }

/** Party members' worn costumes, decrypted in memory by the OBS page (src/net/partyView.ts); taken once by the load. */
const sealedCostumes = new Map<string, ArrayBuffer>();
export function sealCostumeBytes(profileId: string, costumeId: string, bytes: ArrayBuffer) { sealedCostumes.set(`${profileId}\n${costumeId}`, bytes); }

/** Costume GLB from the avatar's folder (/library/<id>/<file>). Failure → Error (the avatar still loads). */
async function loadCostume(profile: AvatarProfile, def: CostumeDef): Promise<WornCostume | Error> {
  // party members' costumes never touch disk or a URL: partyView hands over the decrypted bytes (sealed vault)
  if (/^party-[a-z0-9]{6,32}$/.test(profile.id)) {
    const k = `${profile.id}\n${def.id}`;
    const bytes = sealedCostumes.get(k);
    sealedCostumes.delete(k);
    if (!bytes) return new Error('costume not available');
    try { return { def, gltf: await loader.parseAsync(bytes, '') }; } catch (e) { return e instanceof Error ? e : new Error(String(e)); }
  }
  const url = `/library/${encodeURIComponent(profile.id)}/${def.file.split(/[\\/]/).map(encodeURIComponent).join('/')}`;
  try { return { def, gltf: await loader.loadAsync(url) }; }
  catch (e) { console.warn('costume load failed', url, e); return e instanceof Error ? e : new Error(String(e)); }
}

/** Replace skinned meshes with static ones in their bind pose (for rebuilding with a soft rig). */
function stripSkinning(root: THREE.Object3D) {
  const skinned: THREE.SkinnedMesh[] = [];
  root.traverse((o) => { if ((o as THREE.SkinnedMesh).isSkinnedMesh) skinned.push(o as THREE.SkinnedMesh); });
  for (const sm of skinned) {
    const g = sm.geometry.clone();
    g.deleteAttribute('skinIndex'); g.deleteAttribute('skinWeight');
    const m = new THREE.Mesh(g, sm.material);
    m.name = sm.name;
    // bake the bind transform so the static mesh sits where the skinned one rendered
    sm.updateWorldMatrix(true, false);
    const parent = sm.parent!;
    const toParent = parent.matrixWorld.clone().invert().multiply(sm.matrixWorld);
    toParent.decompose(m.position, m.quaternion, m.scale);
    parent.add(m); parent.remove(sm);
  }
  const bones: THREE.Object3D[] = [];
  root.traverse((o) => { if ((o as THREE.Bone).isBone) bones.push(o); });
  for (const b of bones) if (!(b.parent as THREE.Bone)?.isBone) b.removeFromParent();
}

/** The face channels with the model's own eye shapes held open and still (painted-eye replacement). */
const EYE_CH = /^eye(Blink|Squint|Wide|LookIn|LookOut|LookUp|LookDown)(Left|Right)$/;
function holdModelEyes(face: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const k in face) out[k] = EYE_CH.test(k) ? 0 : face[k];
  return out;
}

/** Skin colour near a marker (material colour × texture texel), for eyelids. */
function sampleSkinColor(meshes: THREE.Mesh[], marker: SurfaceMarker, root: THREE.Object3D): THREE.Color {
  const p = new THREE.Vector3(...marker.position).applyMatrix4(root.matrixWorld);
  let best: { d: number; m: THREE.Mesh; i: number } | null = null;
  const v = new THREE.Vector3();
  for (const m of meshes) {
    const pos = m.geometry.attributes.position;
    for (let i = 0; i < pos.count; i++) {
      v.fromBufferAttribute(pos, i).applyMatrix4(m.matrixWorld);
      const d = v.distanceToSquared(p);
      if (!best || d < best.d) best = { d, m, i };
    }
  }
  const fallback = new THREE.Color('#7fb05a');
  if (!best) return fallback;
  const mat = (Array.isArray(best.m.material) ? best.m.material[0] : best.m.material) as THREE.MeshStandardMaterial;
  const c = mat.color?.clone() ?? fallback;
  const uv = best.m.geometry.attributes.uv;
  const img = mat.map?.image as (HTMLImageElement | ImageBitmap | HTMLCanvasElement) | undefined;
  if (uv && img && 'width' in img && img.width) {
    try {
      // one texel through a 1x1 canvas (not the whole albedo painted into a full-size canvas)
      const { x, y } = texelAt(uv.getX(best.i), uv.getY(best.i), mat.map!.flipY, img.width, img.height);
      const px = readTexel(img, x, y);
      const tex = new THREE.Color().setRGB(px[0] / 255, px[1] / 255, px[2] / 255, THREE.SRGBColorSpace);
      c.multiply(tex);
    } catch { /* tainted canvas etc. */ }
  }
  return c;
}
