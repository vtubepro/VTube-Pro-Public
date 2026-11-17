// OBS-page side of party members: opens their SEALED avatars from the local RAM vault (src/net/custody.ts) and
// smooths their network frames (src/net/remoteSmoother.ts). Used by src/output.ts with a few one-line hooks so it
// stays independent of the output page's own frame sync (src/outputSync.ts, the local performer).
import type { AvatarProfile, PartyMember, PartyNetStamp, SealedAvatarRef, TrackingFrame } from '../../shared/types.ts';
import { glbProblem, sanitizeGuestProfile, sanitizeVoice } from '../../shared/partyWire.ts';
import { isCostumeSet, unpackSet, type SetPiece } from '../../shared/partyXfer.ts';
import { openSealedAvatar, wipe } from './custody.ts';
import { RemoteSmoother } from './remoteSmoother.ts';
import { sealCostumeBytes } from '../avatar/AvatarRuntime.ts';

const refs = new Map<string, SealedAvatarRef>();
const smoothers = new Map<string, RemoteSmoother>();

export const partyView = {
  /** A 'party' bus message: remember how to open each member; returns the ids whose sealed avatar changed. */
  update(members: PartyMember[]): Set<string> {
    const changed = new Set<string>();
    const keep = new Set<string>();
    for (const m of members) {
      keep.add(m.id);
      const s = m.sealed;
      if (s && typeof s.key === 'string' && s.model && s.profile) {
        const old = refs.get(m.id);
        if (old && old.rev !== s.rev) changed.add(m.id);
        refs.set(m.id, s);
      }
      this.rx(m.id).opt.lipDelay = Math.max(-100, Math.min(400, Number(m.lipDelay) || 0));
    }
    for (const id of [...refs.keys()]) if (!keep.has(id)) this.forget(id);
    return changed;
  },
  rx(id: string): RemoteSmoother {
    let s = smoothers.get(id);
    if (!s) { s = new RemoteSmoother(); smoothers.set(id, s); }
    return s;
  },
  has(id: string) { return smoothers.has(id); },
  forget(id: string) { refs.delete(id); smoothers.delete(id); },
  frame(id: string, f: TrackingFrame, net: PartyNetStamp | undefined, now: number) { this.rx(id).pushFrame(f, net, now); },
  voice(id: string, v: unknown, now: number) { this.rx(id).pushVoice(sanitizeVoice(v), now); },
  /** Frame to render now (smoothed), and when the member last sent anything. */
  sample(id: string, now: number): { frame: TrackingFrame; lastAt: number } | null {
    const s = smoothers.get(id);
    return s ? { frame: s.sample(now), lastAt: Math.max(s.lastArrival, s.lastVoiceArrival) } : null;
  },
  /** Decrypt a member's avatar in memory: sanitised profile + the model bytes (wipe() after AvatarRuntime.load). */
  async open(id: string): Promise<{ profile: AvatarProfile; model: ArrayBuffer; wipe(): void }> {
    const ref = refs.get(id);
    if (!ref) throw new Error('no sealed avatar for this member yet');
    const o = await openSealedAvatar(ref, id);
    // their costume: a plain outfit GLB, or (between 'acc1' apps) a costume set — outfit + accessories (shared/partyXfer.ts)
    const cu8 = o.costume ? new Uint8Array(o.costume) : null;
    const set = cu8 && isCostumeSet(cu8) ? unpackSet(cu8) : null;
    if (typeof set === 'string') { o.wipe(); throw new Error(set); }
    const bad = glbProblem(new Uint8Array(o.model)) ?? (set ? set.map((p) => glbProblem(p.bytes)).find((x) => !!x) ?? null : cu8 ? glbProblem(cu8) : null);
    if (bad) { o.wipe(); throw new Error(bad); }
    const outfit = set ? set.find((p) => p.kind === 'outfit') ?? null : null;
    const profile = sanitizeGuestProfile(o.profile, id, set ? !!outfit : !!cu8, !!set?.some((p) => p.kind === 'accessory'));
    const def = profile.costume ? profile.costumes.find((c) => c.id === profile.costume) : null;
    const copies: ArrayBuffer[] = [];
    if (set) {
      // every worn piece in its own buffer for the loader (AvatarRuntime.loadCostume takes it once; wiped after the load)
      const give = (p: SetPiece) => { const b = p.bytes.slice().buffer; copies.push(b); sealCostumeBytes(profile.id, p.id, b); };
      if (def && outfit?.id === def.id) give(outfit); else profile.costume = null;
      profile.accessories = (profile.accessories ?? []).filter((a) => { const p = set.find((x) => x.kind === 'accessory' && x.id === a); if (p) give(p); return !!p; });
    } else if (def && o.costume) sealCostumeBytes(profile.id, def.id, o.costume);
    return { profile, model: o.model, wipe: () => { o.wipe(); for (const b of copies) wipe(b); if (def && !set) wipe(o.costume); } };
  },
};
