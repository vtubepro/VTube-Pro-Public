"""PNG <-> float RGBA numpy (sRGB values 0..1). Uses Pillow if present, else OpenImageIO (Blender's python)."""
from __future__ import annotations

import io
import os
import tempfile

import numpy as np

try:
    from PIL import Image  # type: ignore
except Exception:  # pragma: no cover
    Image = None


def decode(data: bytes) -> np.ndarray:
    if Image is not None:
        im = Image.open(io.BytesIO(data)).convert('RGBA')
        return np.asarray(im, dtype=np.float32) / 255.0
    import OpenImageIO as oiio  # type: ignore
    fd, p = tempfile.mkstemp(suffix='.png'); os.write(fd, data); os.close(fd)
    try:
        inp = oiio.ImageInput.open(p)
        spec = inp.spec()
        a = inp.read_image(oiio.FLOAT)
        inp.close()
    finally:
        os.remove(p)
    a = np.asarray(a, np.float32).reshape(spec.height, spec.width, spec.nchannels)
    if spec.nchannels == 3:
        a = np.concatenate([a, np.ones_like(a[..., :1])], -1)
    return a


def encode(a: np.ndarray) -> bytes:
    a8 = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
    if Image is not None:
        b = io.BytesIO()
        Image.fromarray(a8, 'RGBA' if a8.shape[2] == 4 else 'RGB').save(b, 'PNG', optimize=False, compress_level=6)
        return b.getvalue()
    import OpenImageIO as oiio  # type: ignore
    fd, p = tempfile.mkstemp(suffix='.png'); os.close(fd)
    try:
        spec = oiio.ImageSpec(a8.shape[1], a8.shape[0], a8.shape[2], oiio.UINT8)
        out = oiio.ImageOutput.create(p); out.open(p, spec); out.write_image(a8); out.close()
        return open(p, 'rb').read()
    finally:
        os.remove(p)


def load(path: str) -> np.ndarray:
    return decode(open(path, 'rb').read())


def save(path: str, a: np.ndarray):
    open(path, 'wb').write(encode(a))


def resize(a: np.ndarray, w: int, h: int) -> np.ndarray:
    if Image is not None:
        a8 = (np.clip(a, 0, 1) * 255 + 0.5).astype(np.uint8)
        return np.asarray(Image.fromarray(a8).resize((w, h), Image.LANCZOS), np.float32) / 255
    ys = (np.arange(h) + 0.5) * a.shape[0] / h; xs = (np.arange(w) + 0.5) * a.shape[1] / w
    return a[np.clip(ys.astype(int), 0, a.shape[0] - 1)][:, np.clip(xs.astype(int), 0, a.shape[1] - 1)]
