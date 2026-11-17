"""NVIDIA Audio2Face-3D (v2.3.x regression, 'Claire') on the GPU: 16 kHz audio -> ARKit-52 blendshapes.

Pure inference + blendshape solve, no I/O (the sidecar a2f_sidecar.py and the offline tools share it).

  network.onnx   input  [B,1,8320] float32 audio (0.52 s window CENTRED on the frame), emotion [B,1,26]
                 output [B,1,169]  = 140 skin PCA coefs + 10 tongue PCA + 15 jaw (5 pts x 3) + 4 eyes
  model_data.npz shapes_mean_skin + shapes_matrix_skin (orthonormal PCA of the 61,520-vertex face, cm)
  bs_skin.npz    52 ARKit delta shapes on the same mesh + neutral + frontalMask (10,085 face vertices)

The blendshape solve reproduces the SDK's objective (bs_skin_config.json: L2 / L1 / temporal / symmetry
regularisation, active poses, multipliers / offsets) as a small bounded QP over the frontal-mask vertices. Every
matrix the solve needs is precomputed against the PCA basis (52 x 140), so a frame costs ~0.1 ms of numpy.

Licence: the model files are NVIDIA Open Model License (tools/vendor/audio2face3d_claire/, see THIRD_PARTY_NOTICES.md).
"""
from __future__ import annotations

import json
import os
import time

import numpy as np

SR = 16000
WIN = 8320          # 0.52 s
HALF = WIN // 2     # the frame sits at the window centre -> 260 ms of future audio for full quality

ARKIT = ['eyeBlinkLeft', 'eyeLookDownLeft', 'eyeLookInLeft', 'eyeLookOutLeft', 'eyeLookUpLeft', 'eyeSquintLeft', 'eyeWideLeft',
         'eyeBlinkRight', 'eyeLookDownRight', 'eyeLookInRight', 'eyeLookOutRight', 'eyeLookUpRight', 'eyeSquintRight', 'eyeWideRight',
         'jawForward', 'jawLeft', 'jawRight', 'jawOpen', 'mouthClose', 'mouthFunnel', 'mouthPucker', 'mouthLeft', 'mouthRight',
         'mouthSmileLeft', 'mouthSmileRight', 'mouthFrownLeft', 'mouthFrownRight', 'mouthDimpleLeft', 'mouthDimpleRight',
         'mouthStretchLeft', 'mouthStretchRight', 'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper',
         'mouthPressLeft', 'mouthPressRight', 'mouthLowerDownLeft', 'mouthLowerDownRight', 'mouthUpperUpLeft', 'mouthUpperUpRight',
         'browDownLeft', 'browDownRight', 'browInnerUp', 'browOuterUpLeft', 'browOuterUpRight', 'cheekPuff', 'cheekSquintLeft',
         'cheekSquintRight', 'noseSneerLeft', 'noseSneerRight', 'tongueOut']

# The tongue poses the stream carries after the 52 ARKit names (A2F's own 16-pose tongue rig; the other 8 -- roll / left /
# right -- do not map to anything an avatar has). ARKit's single `tongueOut` is derived from the forward ones.
TONGUE_EXTRA = ['tongueTipUp', 'tongueTipDown', 'tongueUp', 'tongueDown', 'tongueStretch', 'tongueWide', 'tongueNarrow', 'tongueIn']
NAMES = ARKIT + TONGUE_EXTRA
# network output layout [140 skin | 10 tongue | 15 jaw | 4 eyes]
I_TONGUE, I_JAW, I_EYES = 140, 150, 165
# eye micro-motion: the network's eye rotation (rad) minus its running rest, per ARKit look range
EYE_LOOK_RANGE = 0.7


def pad_future(heard: np.ndarray, n: int, mode: str = 'reflect') -> np.ndarray:
    """Fill the n samples of the window the model can't hear yet (live: they haven't been spoken). Zeros make the
    model expect silence and close the mouth early (jaw -52 % at 60 ms); a mirror of the last heard audio keeps the
    current sound going (docs/GPU_TRACKING.md)."""
    if n <= 0:
        return np.zeros(0, np.float32)
    if mode == 'zero' or len(heard) < 2:
        return np.zeros(n, np.float32)
    out = np.empty(n, np.float32)
    seg = heard[::-1]
    k = 0
    while k < n:
        m = min(n - k, len(seg))
        out[k:k + m] = seg[:m]
        seg = seg[::-1]
        k += m
    # fade the continuation out over its length (a guess, not a promise)
    out *= np.linspace(1.0, 0.3, n, dtype=np.float32)
    return out


def default_model_dir() -> str:
    """VTP_A2F_MODEL_DIR (set by the server) / tools/vendor (developer pack) / <repo>/.gpu/models (in-app setup) / LOCALAPPDATA"""
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.normpath(os.path.join(here, '..', '..'))
    for d in [os.environ.get('VTP_A2F_MODEL_DIR'), os.path.join(root, 'tools', 'vendor', 'audio2face3d_claire'),
              os.path.join(os.environ.get('VTP_GPU_DIR') or os.path.join(root, '.gpu'), 'models', 'audio2face3d_claire'),
              os.path.join(os.environ.get('LOCALAPPDATA', ''), 'VTubePro', 'gpu', 'models', 'audio2face3d_claire')]:
        if d and os.path.isfile(os.path.join(d, 'network.onnx')):
            return d
    raise FileNotFoundError('Audio2Face-3D model missing: use "Set up GPU tracking" (or npx tsx tools/gpu/gpu_setup.ts --parts a2f)')


def make_session(path: str, device: str = 'cuda'):
    import onnxruntime as ort
    if device != 'cpu':
        try:
            ort.preload_dlls()          # CUDA / cuDNN from the nvidia-* pip wheels
        except Exception:
            pass
    so = ort.SessionOptions()
    so.log_severity_level = 3
    so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
    prov = ['CPUExecutionProvider']
    if device == 'cuda':
        prov = [('CUDAExecutionProvider', {'device_id': 0, 'arena_extend_strategy': 'kSameAsRequested',
                                           'cudnn_conv_algo_search': 'HEURISTIC'}), 'CPUExecutionProvider']
    elif device == 'dml':
        prov = ['DmlExecutionProvider', 'CPUExecutionProvider']
    sess = ort.InferenceSession(path, so, providers=prov)
    return sess, sess.get_providers()[0]


def bounded_qp(H: np.ndarray, b: np.ndarray, iters: int = 12) -> np.ndarray:
    """min 1/2 w'Hw - b'w with 0 <= w <= 1, by active sets: solve on the free variables, pin the ones that leave
    [0, 1], repeat (shared by the skin and the tongue solve)."""
    lo = np.zeros(len(b), bool); hi = np.zeros(len(b), bool)
    w = np.zeros(len(b))
    for _ in range(iters):
        f = ~(lo | hi)
        w[:] = 0; w[hi] = 1
        if f.any():
            w[f] = np.linalg.solve(H[np.ix_(f, f)], b[f] - H[np.ix_(f, hi)] @ w[hi])
        nlo = f & (w < 0); nhi = f & (w > 1)
        # release pinned variables whose gradient says they want back in
        g = b - H @ np.clip(w, 0, 1)
        rel = (lo & (g > 1e-9)) | (hi & (g < -1e-9))
        if not nlo.any() and not nhi.any() and not rel.any():
            break
        lo = (lo | nlo) & ~rel; hi = (hi | nhi) & ~rel
    return w


class A2F:
    """Audio window -> 169-d network output -> ARKit weights (+ tongue poses, eye look)."""

    def __init__(self, model_dir: str | None = None, device: str = 'cuda', lower_face_strength: float | None = None,
                 reg_scale: float = 1.0):
        d = model_dir or default_model_dir()
        cfg = json.load(open(os.path.join(d, 'a2f_ms_config.json')))
        self.face = cfg['face_params']
        self.sess, self.provider = make_session(os.path.join(d, 'network.onnx'), device)
        self._path = os.path.join(d, 'network.onnx')
        self._so = None
        self.use_graph = device == 'cuda' and os.environ.get('VTP_A2F_GRAPH', '1') != '0'
        if self.use_graph:
            import onnxruntime as ort
            self._so = ort.SessionOptions(); self._so.log_severity_level = 3
        md = np.load(os.path.join(d, 'model_data.npz'))
        bs = np.load(os.path.join(d, 'bs_skin.npz'))
        emo = np.load(os.path.join(d, 'implicit_emo_db.npz'))
        # implicit emotion of the configured source shot/frame (cp1_neutral #212) + 10 explicit emotions (neutral = 0)
        names = [x.decode() for x in emo['emo_spec_names']]
        k = names.index(self.face.get('source_shot', 'cp1_neutral'))
        imp = emo['emo_db'][emo['emo_spec_start'][k] + int(self.face.get('source_frame', 0))]
        self.emotion = np.concatenate([np.zeros(10, np.float32), imp.astype(np.float32)]).reshape(1, 1, 26)
        mask = bs['frontalMask']
        neutral = bs['neutral'][mask]                                   # (V,3)
        mean = md['shapes_mean_skin'][mask]
        S = md['shapes_matrix_skin'][:, mask, :]                        # (140,V,3)
        # upper / lower face strength (SDK face mask: soft split at face_mask_level of the face height)
        y = bs['neutral'][:, 1]
        y0, y1 = float(y[mask].min()), float(y[mask].max())
        lvl = y0 + (y1 - y0) * float(self.face.get('face_mask_level', 0.6))
        soft = max(1e-3, (y1 - y0) * 0.06)
        yl = neutral[:, 1]
        upper_k = 1.0 / (1.0 + np.exp(-(yl - lvl) / soft))              # 1 = upper face
        lf = float(self.face.get('lower_face_strength', 1.25) if lower_face_strength is None else lower_face_strength)
        uf = float(self.face.get('upper_face_strength', 1.0))
        strength = (uf * upper_k + lf * (1 - upper_k)).astype(np.float32)[:, None]
        poses = [x.decode() for x in bs['poseNames']][1:]
        assert poses == ARKIT, poses
        B = np.stack([bs[p][mask] for p in ARKIT], -1).reshape(-1, 52).astype(np.float64)   # (3V,52)
        bcfg = json.load(open(os.path.join(d, 'bs_skin_config.json')))['blendshape_params']
        self.active = np.array(bcfg['bsSolveActivePoses'], bool)
        self.mult = np.array(bcfg['bsWeightMultipliers'], np.float64)
        self.offs = np.array(bcfg['bsWeightOffsets'], np.float64)
        # data term against the PCA basis: B^T (strength * (mean + S c - neutral)) = G c + g0
        Sm = (S * strength[None]).reshape(140, -1).astype(np.float64)   # (140,3V)
        self.G = B.T @ Sm.T                                             # (52,140)
        self.g0 = B.T @ ((mean - neutral) * strength).reshape(-1).astype(np.float64)
        BtB = B.T @ B
        # regularisers, scaled to the data term (the SDK's strengths are relative to the template's size)
        sc = float(np.mean(np.diag(BtB)[self.active])) * 0.01 * reg_scale
        self.l2 = bcfg['strengthL2regularization'] * sc
        self.l1 = bcfg['strengthL1regularization'] * sc * 0.1
        self.lt = bcfg['strengthTemporalSmoothing'] * sc
        ls = bcfg['strengthSymmetry'] * sc * 0.01
        sym = np.array(bcfg['bsSolveSymmetryPoses'])
        Lsym = np.zeros((52, 52))
        for g in set(sym[sym >= 0].tolist()):
            idx = np.where(sym == g)[0]
            if len(idx) == 2:
                i, j = idx
                Lsym[i, i] += 1; Lsym[j, j] += 1; Lsym[i, j] -= 1; Lsym[j, i] -= 1
        a = np.where(self.active)[0]
        self.a = a
        H = BtB + ls * Lsym + (self.l2 + self.lt) * np.eye(52)
        self.H = H[np.ix_(a, a)]
        self.Hd = np.diag(self.H).copy()
        self.prev = np.zeros(len(a))
        self.last_ms = 0.0
        # rest face = the network's own output for silence (the PCA mean is not the blendshape neutral: solving
        # against bs neutral leaves a constant ~0.1-0.2 of shrug / frown / brow on every frame)
        rest_out = self.infer(np.zeros((1, WIN), np.float32))[0]
        self.c_rest = rest_out[:140].astype(np.float64)
        self.g0 = -(self.G @ self.c_rest)
        self._init_tongue(d, md, rest_out)

    def _init_tongue(self, d, md, rest_out):
        """A2F's tongue: 10 PCA coefficients of the tongue mesh -> its 16 blendshape poses (same bounded QP as the skin,
        against the network's own silence as the rest tongue), + the eye rotation's running rest for the look channels."""
        tb = np.load(os.path.join(d, 'bs_tongue.npz'))
        tcfg = json.load(open(os.path.join(d, 'bs_tongue_config.json')))['blendshape_params']
        poses = [x.decode() for x in tb['poseNames']]
        names = poses[1:]
        Bt = np.stack([tb[p].reshape(-1) for p in names], -1).astype(np.float64)      # (3V, 16)  (the pose arrays are deltas already, like the skin's)
        St = md['shapes_matrix_tongue'].reshape(10, -1).astype(np.float64)                               # (10, 3V)
        self.t_names = names
        self.t_G = Bt.T @ St.T                                                                           # (16, 10)
        BtB = Bt.T @ Bt
        sc = float(np.mean(np.diag(BtB))) * 0.01
        self.t_H = BtB + (tcfg['strengthL2regularization'] + tcfg['strengthTemporalSmoothing']) * sc * np.eye(len(names))
        self.t_l1 = tcfg['strengthL1regularization'] * sc * 0.1
        self.t_lt = tcfg['strengthTemporalSmoothing'] * sc
        self.t_mult = np.array(tcfg['bsWeightMultipliers'], np.float64)
        self.t_rest = rest_out[I_TONGUE:I_JAW].astype(np.float64)
        self.t_prev = np.zeros(len(names))
        self.t_idx = [names.index(n) for n in TONGUE_EXTRA]
        self.eye_rest = rest_out[I_EYES:I_EYES + 4].astype(np.float64)
        self.eye_ema = self.eye_rest.copy()

    def solve_tongue(self, out169: np.ndarray) -> np.ndarray:
        """one frame's network output -> the 8 TONGUE_EXTRA weights (0..1) + ARKit tongueOut as a 9th value."""
        c = out169[I_TONGUE:I_JAW].astype(np.float64) - self.t_rest
        b = self.t_G @ c + self.t_lt * self.t_prev - self.t_l1
        w = np.clip(bounded_qp(self.t_H, b), 0, 1)
        self.t_prev = w
        full = np.clip(w * self.t_mult, 0, 1)
        extra = full[self.t_idx]
        # ARKit tongueOut = the tongue pushed forward past the teeth: the stretch pose, helped by the tip pointing down/out
        out = float(np.clip(full[self.t_names.index('tongueStretch')] + 0.3 * full[self.t_names.index('tongueTipDown')], 0, 1))
        return np.concatenate([extra, [out]])

    def eye_look(self, out169: np.ndarray, dt: float = 1 / 60) -> np.ndarray:
        """The network's eye rotation (4 values: right x / y, left x / y, radians) against its running rest -> ARKit
        eyeLook Up / Down / In / Out weights per eye. Only the micro-motion of speech (about +-1-2 degrees): the
        camera owns the real gaze. The sign of x (up / down) is the network's convention and is NOT verified against a
        reference; the amplitude is small enough that it only reads as life when the camera has lost the performer."""
        e = out169[I_EYES:I_EYES + 4].astype(np.float64)
        self.eye_ema += (e - self.eye_ema) * (1 - np.exp(-dt / 3.0))
        d = (e - self.eye_ema) / EYE_LOOK_RANGE
        res = {}
        for side, (ix, iy) in (('Right', (0, 1)), ('Left', (2, 3))):
            res['eyeLookUp' + side] = max(0.0, -d[ix]); res['eyeLookDown' + side] = max(0.0, d[ix])
            res['eyeLookIn' + side] = max(0.0, d[iy] if side == 'Right' else -d[iy]); res['eyeLookOut' + side] = max(0.0, -d[iy] if side == 'Right' else d[iy])
        return res

    def reset(self):
        self.prev[:] = 0

    # ---- network
    def _graph(self):
        """CUDA-graph single-window runner (2.7 ms vs 7 ms per call on an RTX 5090: launch overhead dominates)."""
        import onnxruntime as ort
        if getattr(self, '_g', None) is None:
            s = ort.InferenceSession(self._path, self._so, providers=[('CUDAExecutionProvider', {'device_id': 0, 'enable_cuda_graph': '1'})])
            xi = ort.OrtValue.ortvalue_from_numpy(np.zeros((1, 1, WIN), np.float32), 'cuda', 0)
            ei = ort.OrtValue.ortvalue_from_numpy(self.emotion, 'cuda', 0)
            yo = ort.OrtValue.ortvalue_from_shape_and_type([1, 1, 169], np.float32, 'cuda', 0)
            b = s.io_binding()
            b.bind_ortvalue_input('input', xi); b.bind_ortvalue_input('emotion', ei); b.bind_ortvalue_output('result', yo)
            self._g = (s, b, xi, yo)
        return self._g

    def infer(self, windows: np.ndarray) -> np.ndarray:
        """windows (B, 8320) float32 16 kHz -> (B, 169)."""
        x = np.ascontiguousarray(windows, np.float32).reshape(-1, 1, WIN)
        t = time.perf_counter()
        if self.provider == 'CUDAExecutionProvider' and x.shape[0] <= 4 and self.use_graph:
            try:
                s, b, xi, yo = self._graph()
                out = []
                for i in range(x.shape[0]):
                    xi.update_inplace(x[i:i + 1])
                    s.run_with_iobinding(b)
                    out.append(yo.numpy().reshape(-1).copy())
                self.last_ms = (time.perf_counter() - t) * 1000
                return np.stack(out)
            except Exception as err:  # graph capture unsupported on this driver: plain runs
                print('[a2f] cuda graph off:', err, flush=True)
                self.use_graph = False
        e = np.repeat(self.emotion, x.shape[0], 0)
        y = self.sess.run(None, {'input': x, 'emotion': e})[0].reshape(x.shape[0], -1)
        self.last_ms = (time.perf_counter() - t) * 1000
        return y

    # ---- blendshape solve
    def solve(self, out169: np.ndarray, temporal: bool = True, iters: int = 12) -> np.ndarray:
        """one frame's network output -> 52 ARKit weights (0..1)."""
        c = out169[:140].astype(np.float64)
        b = (self.G @ c + self.g0)[self.a]
        b = b + (self.lt * self.prev if temporal else 0.0) - self.l1
        if not temporal:
            b = b - self.lt * 0  # (kept for symmetry with the SDK's first frame)
        w = bounded_qp(self.H, b, iters)
        w = np.clip(w, 0, 1)
        self.prev = w
        full = np.zeros(52)
        full[self.a] = w
        return np.clip(full * self.mult + self.offs, 0, 1)

    def frame(self, out169: np.ndarray, dt: float = 1 / 60) -> np.ndarray:
        """One network output -> the whole stream row: 52 ARKit weights (skin solve; tongueOut and eyeLook* filled from
        the tongue solve and the eye rotation) + TONGUE_EXTRA."""
        w = self.solve(out169)
        t = self.solve_tongue(out169)
        row = np.concatenate([w, t[:len(TONGUE_EXTRA)]])
        row[ARKIT.index('tongueOut')] = t[-1]
        for k, v in self.eye_look(out169, dt).items():
            row[ARKIT.index(k)] = min(1.0, v)
        return row
