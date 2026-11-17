from __future__ import annotations

import numpy as np


def mat_to_quat(R: np.ndarray):
    t = np.trace(R)
    if t > 0:
        s = np.sqrt(t + 1.0) * 2
        w = 0.25 * s; x = (R[2, 1] - R[1, 2]) / s; y = (R[0, 2] - R[2, 0]) / s; z = (R[1, 0] - R[0, 1]) / s
    elif R[0, 0] > R[1, 1] and R[0, 0] > R[2, 2]:
        s = np.sqrt(1.0 + R[0, 0] - R[1, 1] - R[2, 2]) * 2
        w = (R[2, 1] - R[1, 2]) / s; x = 0.25 * s; y = (R[0, 1] + R[1, 0]) / s; z = (R[0, 2] + R[2, 0]) / s
    elif R[1, 1] > R[2, 2]:
        s = np.sqrt(1.0 + R[1, 1] - R[0, 0] - R[2, 2]) * 2
        w = (R[0, 2] - R[2, 0]) / s; x = (R[0, 1] + R[1, 0]) / s; y = 0.25 * s; z = (R[1, 2] + R[2, 1]) / s
    else:
        s = np.sqrt(1.0 + R[2, 2] - R[0, 0] - R[1, 1]) * 2
        w = (R[1, 0] - R[0, 1]) / s; x = (R[0, 2] + R[2, 0]) / s; y = (R[1, 2] + R[2, 1]) / s; z = 0.25 * s
    q = np.array([x, y, z, w]); return q / np.linalg.norm(q)


def T(v) -> np.ndarray:
    M = np.eye(4); M[:3, 3] = v; return M


def scale_about(p, s) -> np.ndarray:
    """Scale (scalar, 3-vector or 3x3) about point p."""
    S = np.eye(4)
    if np.ndim(s) == 2:
        S[:3, :3] = s
    else:
        S[:3, :3] = np.diag(np.broadcast_to(np.asarray(s, float), 3))
    return T(p) @ S @ T(-np.asarray(p))


def axis_scale(axis, along: float, perp: float) -> np.ndarray:
    a = np.asarray(axis, float); a = a / (np.linalg.norm(a) + 1e-12)
    A = np.outer(a, a)
    return along * A + perp * (np.eye(3) - A)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)
