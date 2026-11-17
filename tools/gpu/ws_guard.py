"""Who may talk to a GPU sidecar (a2f_sidecar.py, vision_sidecar.py): the same loopback Origin guard as the voice sidecars
(tools/voice/sidecar_common.py origin_ok / guard), without importing that module (it sets offline environment flags).

The sidecars bind 127.0.0.1 only, but a web page in the streamer's browser can still open ws://127.0.0.1:<port>: a browser sends
its page's Origin, so a website is refused here, and a page that is not a studio can neither kick the studio off (`replaced by a
newer studio`) nor feed it audio / frames. A program (no Origin header: the VTube Pro server, a test) may connect, but it may
not replace a studio connection that is still open.
"""
from __future__ import annotations

from http import HTTPStatus

LOOPBACK_ORIGINS = ('http://localhost', 'http://127.0.0.1', 'http://[::1]', 'https://localhost', 'https://127.0.0.1')


def origin_ok(origin: str | None) -> bool:
    """No Origin = a program. A browser page must be on this PC, not a website."""
    if not origin:
        return True
    return any(origin == o or origin.startswith(o + ':') for o in LOOPBACK_ORIGINS)


def guard(path: str):
    """websockets `process_request` that only lets `path` in, from a loopback page or a program."""
    def check(connection, request):
        if request.path.split('?')[0] != path:
            return connection.respond(HTTPStatus.NOT_FOUND, 'not found\n')
        if not origin_ok(request.headers.get('Origin')):
            return connection.respond(HTTPStatus.FORBIDDEN, 'this page may not use the local GPU service\n')
        return None
    return check


def origin_of(ws) -> str | None:
    try:
        return ws.request.headers.get('Origin')
    except Exception:  # noqa: BLE001
        return None


def may_replace(ws) -> bool:
    """May this new connection take over from the studio that is connected? Only a page (it sent a loopback Origin): a bare program
    (no Origin) must wait until the studio's connection is closed."""
    return bool(origin_of(ws))


def pcm_from_message(msg):
    """A binary audio message -> float32 samples with NaN / inf zeroed, or None when it is empty or not whole float32 samples."""
    import numpy as np
    n = len(msg)
    if n == 0 or n % 4:
        return None
    return np.nan_to_num(np.frombuffer(msg, dtype='<f4').astype(np.float32), nan=0.0, posinf=0.0, neginf=0.0)
