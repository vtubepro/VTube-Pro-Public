"""RTMW whole-body pose (OpenMMLab, Apache-2.0) on the GPU: one person, 133 COCO-WholeBody keypoints incl. both hands.

Model: rtmw-dw-x-l_simcc-cocktail14_270e-384x288 (official ONNX from download.openmmlab.com, see setup_gpu.py),
input 1x3x384x288 RGB normalised, output SimCC x (576 bins) / y (768 bins), split ratio 2.
No person detector: a VTuber sits in front of the camera, so the crop follows the previous frame's own keypoints
(whole frame to start / after a loss).

Keypoints (COCO-WholeBody): 0-16 body (5/6 shoulders, 7/8 elbows, 9/10 wrists, 11/12 hips), 17-22 feet,
23-90 face (68), 91-111 left hand (21), 112-132 right hand (21) — hands in MediaPipe's own 21-point order.
"Left" = the person's left.
"""
from __future__ import annotations

import os
import time

import cv2
import numpy as np

IN_W, IN_H = 288, 384
RAW_LO, RAW_HI = 1.8, 3.5   # SimCC max -> confidence 0..1
MEAN = np.array([123.675, 116.28, 103.53], np.float32)
STD = np.array([58.395, 57.12, 57.375], np.float32)


def default_model() -> str:
    root = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
    for p in [os.environ.get('VTP_RTMW_MODEL'),
              os.path.join(os.environ.get('VTP_GPU_DIR') or os.path.join(root, '.gpu'), 'models', 'rtmw', 'end2end.onnx'),
              os.path.join(os.environ.get('LOCALAPPDATA', ''), 'VTubePro', 'gpu', 'models', 'rtmw', 'end2end.onnx')]:
        if p and os.path.isfile(p):
            return p
    raise FileNotFoundError('RTMW model missing: use "Set up GPU tracking" (or npx tsx tools/gpu/gpu_setup.ts --parts rtmw)')


class RTMW:
    def __init__(self, model: str | None = None, device: str = 'cuda'):
        import onnxruntime as ort
        try:
            ort.preload_dlls()
        except Exception:
            pass
        so = ort.SessionOptions(); so.log_severity_level = 3
        prov = [('CUDAExecutionProvider', {'device_id': 0, 'cudnn_conv_algo_search': 'HEURISTIC'}), 'CPUExecutionProvider'] if device == 'cuda' else ['CPUExecutionProvider']
        self.sess = ort.InferenceSession(model or default_model(), so, providers=prov)
        self.provider = self.sess.get_providers()[0]
        self.box = None          # (cx, cy, w, h) in pixels of the last good crop
        self.last_ms = 0.0

    def _crop(self, W, H):
        if self.box is None:
            cx, cy, w, h = W / 2, H / 2, W, H
        else:
            cx, cy, w, h = self.box
        # pad 1.25 and fix the aspect to the network's 288:384
        w, h = w * 1.25, h * 1.25
        if w / h > IN_W / IN_H:
            h = w * IN_H / IN_W
        else:
            w = h * IN_W / IN_H
        return cx, cy, w, h

    def run(self, bgr: np.ndarray) -> np.ndarray:
        """-> (133, 3): x, y in pixels of the input frame, score 0..1."""
        H, W = bgr.shape[:2]
        cx, cy, w, h = self._crop(W, H)
        s = IN_W / w
        M = np.array([[s, 0, IN_W / 2 - s * cx], [0, s, IN_H / 2 - s * cy]], np.float32)
        img = cv2.warpAffine(bgr, M, (IN_W, IN_H), flags=cv2.INTER_LINEAR)
        x = ((img[:, :, ::-1].astype(np.float32) - MEAN) / STD).transpose(2, 0, 1)[None]
        t = time.perf_counter()
        sx, sy = self.sess.run(None, {'input': np.ascontiguousarray(x)})
        self.last_ms = (time.perf_counter() - t) * 1000
        sx, sy = sx[0], sy[0]
        ix, iy = sx.argmax(1), sy.argmax(1)
        score = np.minimum(sx.max(1), sy.max(1))
        px = ix / 2.0; py = iy / 2.0
        k = np.stack([(px - M[0, 2]) / s, (py - M[1, 2]) / s, score], 1).astype(np.float32)
        # SimCC maxima are not probabilities (measured on the test clip: visible face 6-8, shoulders ~4, joints far
        # outside the frame 0.7-1.8): map to 0..1 and zero anything that isn't inside the picture
        inside = (k[:, 0] > -0.02 * W) & (k[:, 0] < 1.02 * W) & (k[:, 1] > -0.02 * H) & (k[:, 1] < 1.02 * H)
        k[:, 2] = np.clip((k[:, 2] - RAW_LO) / (RAW_HI - RAW_LO), 0, 1) * inside
        # next crop: around the confident, in-frame body + hand points
        good = k[:, 2] > 0.3
        body = good.copy(); body[23:91] = False
        if body.sum() >= 4:
            p = k[body, :2]
            x0, y0 = p.min(0); x1, y1 = p.max(0)
            bw, bh = max(x1 - x0, W * 0.25), max(y1 - y0, H * 0.25)
            nb = ((x0 + x1) / 2, (y0 + y1) / 2, bw, bh)
            # smooth the crop (a jumping crop is jitter on every point)
            self.box = nb if self.box is None else tuple(0.8 * a + 0.2 * b for a, b in zip(self.box, nb))
        else:
            self.box = None
        return k
