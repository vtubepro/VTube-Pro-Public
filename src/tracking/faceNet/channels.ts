// "My face model": which ARKit channels the two nets drive. A tiny module of its own so the studio's main thread (fold-in, panel,
// controller) can know the channel list without pulling the network, the trainer or the teach routine into its startup path.
import { ARKIT } from '../../core/arkit.ts';

/** ARKit channels each net predicts, as indices into ARKIT. */
const ix = (n: string) => { const i = (ARKIT as readonly string[]).indexOf(n); if (i < 0) throw new Error('faceNet: unknown ARKit channel ' + n); return i; };
export const EYE_OUT = ['eyeBlink', 'eyeSquint', 'eyeWide', 'browDown', 'browOuterUp'] as const;
/** eye net outputs per side: [eyeBlink, eyeSquint, eyeWide, browDown, browOuterUp, browInnerUp (shared: the two sides are averaged)] */
export const EYE_IDX = {
  Left: [...EYE_OUT.map((n) => ix(n + 'Left')), ix('browInnerUp')],
  Right: [...EYE_OUT.map((n) => ix(n + 'Right')), ix('browInnerUp')],
};
export const MOUTH_IDX = ARKIT.map((n, i) => (/^(jaw|mouth|cheek)/.test(n) ? i : -1)).filter((i) => i >= 0);
/** every ARKit channel the two nets drive (sorted) */
export const FACENET_CHANNELS = [...new Set([...EYE_IDX.Left, ...EYE_IDX.Right, ...MOUTH_IDX])].sort((a, b) => a - b);
