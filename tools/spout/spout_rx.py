"""VTube Pro Spout2 receiver (Windows): reads a Spout2 sender's shared DirectX 11 texture and streams its pixels.

Standard library only (ctypes + Windows' own d3d11.dll / kernel32.dll): nothing to install. Started by server/spout.ts.
Interop follows the Spout2 SDK's documented shared-memory protocol (https://github.com/leadedge/Spout2, BSD-2-Clause);
no SDK code is copied or bundled:
  * "SpoutSenderNames" file mapping: MaxSenders (default 64) x 256-byte ASCII name slots; the list ends at an empty slot.
    Guarded by the named mutex "SpoutSenderNames_mutex".
  * one file mapping per sender, named by the sender name: SharedTextureInfo (280 bytes)
      uint32 shareHandle, width, height, format (DXGI), usage; uint8 description[256]; uint32 partnerId
  * the texture: a legacy DXGI shared handle (32 bit, sign-extended) -> ID3D11Device::OpenSharedResource
  * "<sender>_SpoutAccessMutex": held by the sender while it writes (receivers wait <= 67 ms)
  * "<sender>_Count_Semaphore": the sender's frame counter (read: Wait(0) then Release(1, &previous))
  * IDXGIKeyedMutex on the texture when the sender made it with D3D11_RESOURCE_MISC_SHARED_KEYEDMUTEX (key 0)

Usage
  spout_rx.py --list                         -> one JSON line: {"senders": [...]}
  spout_rx.py --recv NAME [--fps 30] [--parent-pid N] [--registry NAME]
      stdout: frames, each = 'VSP1' header (32 bytes, little endian: magic, w, h, fmt 0 RGBA / 1 BGRA / 2 BGRX, seq,
              sender frame, sender fps x100, flags) + w*h*4 pixel bytes, rows top first  (shared/spout.ts)
      stderr: one JSON status line per state change {"state": "waiting"|"live"|"lost"|"error", ...}
  --registry: a different sender list name (tests use a private one so the real list is never touched)
Exit codes: 0 parent gone / stdout closed, 2 not Windows / no D3D11.
"""
import argparse
import ctypes
import json
import os
import struct
import sys
import time
from ctypes import wintypes as W

if os.name != 'nt':
    print(json.dumps({'state': 'error', 'error': 'Spout2 needs Windows'}), file=sys.stderr)
    sys.exit(2)

k32 = ctypes.WinDLL('kernel32', use_last_error=True)
FILE_MAP_READ = 0x0004
SYNCHRONIZE = 0x00100000
SEMAPHORE_MODIFY_STATE = 0x0002
WAIT_OBJECT_0, WAIT_ABANDONED, WAIT_TIMEOUT = 0, 0x80, 0x102
PROCESS_QUERY_LIMITED_INFORMATION = 0x1000

k32.OpenFileMappingA.restype = W.HANDLE; k32.OpenFileMappingA.argtypes = [W.DWORD, W.BOOL, ctypes.c_char_p]
k32.MapViewOfFile.restype = ctypes.c_void_p; k32.MapViewOfFile.argtypes = [W.HANDLE, W.DWORD, W.DWORD, W.DWORD, ctypes.c_size_t]
k32.UnmapViewOfFile.argtypes = [ctypes.c_void_p]
k32.CloseHandle.argtypes = [W.HANDLE]
k32.OpenMutexA.restype = W.HANDLE; k32.OpenMutexA.argtypes = [W.DWORD, W.BOOL, ctypes.c_char_p]
k32.OpenSemaphoreA.restype = W.HANDLE; k32.OpenSemaphoreA.argtypes = [W.DWORD, W.BOOL, ctypes.c_char_p]
k32.WaitForSingleObject.restype = W.DWORD; k32.WaitForSingleObject.argtypes = [W.HANDLE, W.DWORD]
k32.ReleaseMutex.argtypes = [W.HANDLE]
k32.ReleaseSemaphore.argtypes = [W.HANDLE, W.LONG, ctypes.POINTER(W.LONG)]
k32.OpenProcess.restype = W.HANDLE; k32.OpenProcess.argtypes = [W.DWORD, W.BOOL, W.DWORD]


class MBI(ctypes.Structure):
    _fields_ = [('BaseAddress', ctypes.c_void_p), ('AllocationBase', ctypes.c_void_p), ('AllocationProtect', W.DWORD),
                ('PartitionId', W.WORD), ('RegionSize', ctypes.c_size_t), ('State', W.DWORD), ('Protect', W.DWORD), ('Type', W.DWORD)]


k32.VirtualQuery.restype = ctypes.c_size_t
k32.VirtualQuery.argtypes = [ctypes.c_void_p, ctypes.POINTER(MBI), ctypes.c_size_t]


def enc(s):
    return s.encode('mbcs', 'replace') if isinstance(s, str) else s


def read_mapping(name, size=None):
    """Bytes of a named file mapping (None = it doesn't exist). size None = the whole mapped region."""
    h = k32.OpenFileMappingA(FILE_MAP_READ, False, enc(name))
    if not h:
        return None
    try:
        p = k32.MapViewOfFile(h, FILE_MAP_READ, 0, 0, 0)
        if not p:
            return None
        try:
            if size is None:
                mbi = MBI()
                k32.VirtualQuery(p, ctypes.byref(mbi), ctypes.sizeof(mbi))
                size = mbi.RegionSize
            return ctypes.string_at(p, size)
        finally:
            k32.UnmapViewOfFile(p)
    finally:
        k32.CloseHandle(h)


class Named:
    """A named mutex we only wait on (never own beyond the copy)."""
    def __init__(self, name):
        self.h = k32.OpenMutexA(SYNCHRONIZE, False, enc(name))

    def acquire(self, ms=67):
        if not self.h:
            return True
        r = k32.WaitForSingleObject(self.h, ms)
        return r in (WAIT_OBJECT_0, WAIT_ABANDONED)

    def release(self):
        if self.h:
            k32.ReleaseMutex(self.h)

    def close(self):
        if self.h:
            k32.CloseHandle(self.h)
            self.h = None


def list_senders(registry='SpoutSenderNames'):
    mx = Named(registry + '_mutex')
    got = mx.acquire(67)
    try:
        raw = read_mapping(registry)
    finally:
        if got:
            mx.release()
        mx.close()
    names = []
    if raw:
        for i in range(0, min(len(raw), 64 * 256), 256):
            slot = raw[i:i + 256]
            if not slot or slot[0] == 0:
                break
            names.append(slot.split(b'\0', 1)[0].decode('mbcs', 'replace'))
    return names


def sender_info(name):
    raw = read_mapping(name, 280)
    if not raw or len(raw) < 280:
        return None
    handle, w, h, fmt, usage = struct.unpack_from('<IIIII', raw, 0)
    desc = raw[20:276].split(b'\0', 1)[0].decode('mbcs', 'replace')
    partner, = struct.unpack_from('<I', raw, 276)
    return {'handle': handle, 'w': w, 'h': h, 'format': fmt, 'usage': usage, 'desc': desc, 'partner': partner}


# ---------------------------------------------------------------- Direct3D 11 through COM vtables
class GUID(ctypes.Structure):
    _fields_ = [('a', ctypes.c_uint32), ('b', ctypes.c_uint16), ('c', ctypes.c_uint16), ('d', ctypes.c_ubyte * 8)]


def guid(s):
    s = s.strip('{}').replace('-', '')
    g = GUID(int(s[0:8], 16), int(s[8:12], 16), int(s[12:16], 16))
    for i in range(8):
        g.d[i] = int(s[16 + i * 2:18 + i * 2], 16)
    return g


IID_Texture2D = guid('6f15aaf2-d208-4e89-9ab4-489535d34f9c')
IID_KeyedMutex = guid('9d8e1289-d7b3-465f-8126-250e349af85d')


class TEX2D_DESC(ctypes.Structure):
    _fields_ = [(n, ctypes.c_uint) for n in ('Width', 'Height', 'MipLevels', 'ArraySize', 'Format', 'SampleCount',
                                             'SampleQuality', 'Usage', 'BindFlags', 'CPUAccessFlags', 'MiscFlags')]


class MAPPED(ctypes.Structure):
    _fields_ = [('pData', ctypes.c_void_p), ('RowPitch', ctypes.c_uint), ('DepthPitch', ctypes.c_uint)]


def vcall(obj, index, restype, *args):
    """Call method #index of the COM object `obj` (a c_void_p)."""
    vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
    return ctypes.WINFUNCTYPE(restype, ctypes.c_void_p, *[ctypes.c_void_p] * len(args))(vtbl[index])(obj, *args)


def release(obj):
    if obj:
        vtbl = ctypes.cast(obj, ctypes.POINTER(ctypes.POINTER(ctypes.c_void_p))).contents
        ctypes.WINFUNCTYPE(ctypes.c_ulong, ctypes.c_void_p)(vtbl[2])(obj)


def ptr(x):
    return ctypes.cast(ctypes.byref(x), ctypes.c_void_p)


# vtable slots (d3d11.h order)
DEV_CreateTexture2D, DEV_OpenSharedResource = 5, 28
CTX_Map, CTX_Unmap, CTX_CopyResource, CTX_Flush = 14, 15, 47, 111
TEX_GetDesc = 10
KM_AcquireSync, KM_ReleaseSync = 8, 9
QI = 0


class D3D:
    def __init__(self):
        d3d11 = ctypes.WinDLL('d3d11')
        self.dev, self.ctx = ctypes.c_void_p(), ctypes.c_void_p()
        fl = ctypes.c_uint()
        levels = (ctypes.c_uint * 3)(0xb100, 0xb000, 0xa100)
        # hardware device, BGRA support (0x20): the adapter the senders use on almost every PC (hybrid laptops: see docs)
        hr = d3d11.D3D11CreateDevice(None, 1, None, 0x20, levels, 3, 7, ctypes.byref(self.dev), ctypes.byref(fl), ctypes.byref(self.ctx))
        if hr != 0:
            raise OSError('D3D11CreateDevice failed 0x%08x' % (hr & 0xffffffff))

    def open_shared(self, handle32):
        h = ctypes.c_void_p(ctypes.c_int32(handle32).value)   # LongToPtr: sign-extend the 32-bit handle
        tex = ctypes.c_void_p()
        hr = vcall(self.dev, DEV_OpenSharedResource, ctypes.c_long, h, ptr(IID_Texture2D), ptr(tex))
        if hr != 0 or not tex:
            raise OSError('OpenSharedResource failed 0x%08x' % (hr & 0xffffffff))
        d = TEX2D_DESC()
        vcall(tex, TEX_GetDesc, None, ptr(d))
        km = ctypes.c_void_p()
        if vcall(tex, QI, ctypes.c_long, ptr(IID_KeyedMutex), ptr(km)) != 0:
            km = ctypes.c_void_p()
        return tex, d, km

    def staging(self, d):
        s = TEX2D_DESC(d.Width, d.Height, 1, 1, d.Format, 1, 0, 3, 0, 0x20000, 0)   # USAGE_STAGING, CPU_ACCESS_READ
        tex = ctypes.c_void_p()
        hr = vcall(self.dev, DEV_CreateTexture2D, ctypes.c_long, ptr(s), None, ptr(tex))
        if hr != 0:
            raise OSError('CreateTexture2D(staging) failed 0x%08x' % (hr & 0xffffffff))
        return tex

    def copy(self, dst, src):
        vcall(self.ctx, CTX_CopyResource, None, dst, src)

    def read(self, tex, w, h, out, off=0):
        """Copy the mapped staging texture into bytearray `out` at byte offset `off` (rows packed, top first)."""
        m = MAPPED()
        hr = vcall(self.ctx, CTX_Map, ctypes.c_long, tex, ctypes.c_void_p(0), ctypes.c_void_p(1), ctypes.c_void_p(0), ptr(m))
        if hr != 0:
            raise OSError('Map failed 0x%08x' % (hr & 0xffffffff))
        try:
            row = w * 4
            base = ctypes.addressof((ctypes.c_char * len(out)).from_buffer(out)) + off
            if m.RowPitch == row:
                ctypes.memmove(base, m.pData, row * h)
            else:
                for y in range(h):
                    ctypes.memmove(base + y * row, m.pData + y * m.RowPitch, row)
        finally:
            vcall(self.ctx, CTX_Unmap, None, tex, ctypes.c_void_p(0))


FMT = {27: 0, 28: 0, 29: 0, 87: 1, 90: 1, 91: 1, 88: 2, 92: 2, 93: 2, 0: 1}
FMT_NAME = {10: '16-bit float (HDR)', 2: '32-bit float', 24: '10-bit', 11: '16-bit'}


def status(**o):
    sys.stderr.write(json.dumps(o) + '\n')
    sys.stderr.flush()


def parent_alive(pid):
    if not pid:
        return True
    h = k32.OpenProcess(SYNCHRONIZE | PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
    if not h:
        return False
    try:
        return k32.WaitForSingleObject(h, 0) == WAIT_TIMEOUT
    finally:
        k32.CloseHandle(h)


def receive(name, fps, parent, registry):
    try:
        d3d = D3D()
    except OSError as e:
        status(state='error', error=f'Direct3D 11 is not available: {e}')
        sys.exit(2)
    out = sys.stdout.buffer
    period = 1.0 / max(1, min(60, fps))
    cur = None           # {'info', 'tex', 'desc', 'km', 'stage', 'buf', 'fmt'}
    access = None
    sem = None
    last_count = None
    seq = 0
    state = ''
    rate_n, rate_t, sender_fps = 0, time.perf_counter(), 0.0
    next_t = time.perf_counter()
    check_t = 0.0
    last_parent = 0.0

    def set_state(s, **extra):
        nonlocal state
        if s != state or extra.get('error'):
            state = s
            status(state=s, sender=name, **extra)

    def drop():
        nonlocal cur, access, sem, last_count
        if cur:
            release(cur['stage']); release(cur['km']); release(cur['tex'])
        if access:
            access.close()
        if sem:
            k32.CloseHandle(sem)
        cur, access, sem, last_count = None, None, None, None

    while True:
        now = time.perf_counter()
        if now - last_parent > 1.0:
            last_parent = now
            if not parent_alive(parent):
                drop(); return
        # (re)open the sender when it appears / changes its texture (size, handle, format)
        if now - check_t > 0.5 or cur is None:
            check_t = now
            info = sender_info(name)
            if info is None:
                if cur is not None:
                    drop()
                set_state('waiting', error='')
                time.sleep(0.25)
                continue
            if cur is None or (info['handle'], info['w'], info['h'], info['format']) != (cur['info']['handle'], cur['info']['w'], cur['info']['h'], cur['info']['format']):
                drop()
                if info['format'] not in FMT:
                    set_state('error', error='This sender shares %s pixels (DXGI format %d): VTube Pro reads 8-bit RGBA / BGRA. Set the app to 8-bit / SDR output.' % (FMT_NAME.get(info['format'], 'unsupported'), info['format']), format=info['format'])
                    time.sleep(1.0)
                    continue
                try:
                    tex, desc, km = d3d.open_shared(info['handle'])
                    stage = d3d.staging(desc)
                except OSError as e:
                    set_state('error', error=f'Couldn’t open the sender’s texture ({e}). If this PC has two GPUs, run the app and VTube Pro on the same one.')
                    time.sleep(1.0)
                    continue
                w, h = desc.Width, desc.Height
                if desc.Format not in FMT or desc.SampleCount != 1:
                    release(stage); release(km); release(tex)
                    set_state('error', error='This sender shares %s pixels (DXGI format %d): VTube Pro reads 8-bit RGBA / BGRA.' % (FMT_NAME.get(desc.Format, 'unsupported'), desc.Format), format=desc.Format)
                    time.sleep(1.0)
                    continue
                cur = {'info': info, 'tex': tex, 'desc': desc, 'km': km, 'stage': stage, 'w': w, 'h': h,
                       'fmt': FMT.get(desc.Format, FMT[info['format']]), 'buf': bytearray(32 + w * h * 4)}
                access = Named(name + '_SpoutAccessMutex')
                s = k32.OpenSemaphoreA(SYNCHRONIZE | SEMAPHORE_MODIFY_STATE, False, enc(name + '_Count_Semaphore'))
                sem = s if s else None
                set_state('live', w=w, h=h, format=desc.Format)
        # new frame? (the frame counter when the sender has one; otherwise every tick)
        count = 0
        fresh = True
        if sem:
            k32.WaitForSingleObject(sem, 0)
            prev = W.LONG(0)
            k32.ReleaseSemaphore(sem, 1, ctypes.byref(prev))
            count = prev.value
            fresh = count != last_count
        if fresh:
            if last_count is not None and sem:
                rate_n += (count - last_count) if count > last_count else 1
            last_count = count
            ok = access.acquire(67) if access else True
            try:
                if cur['km'] and vcall(cur['km'], KM_AcquireSync, ctypes.c_long, ctypes.c_void_p(0), ctypes.c_void_p(67)) != 0:
                    ok = False
                if ok:
                    d3d.copy(cur['stage'], cur['tex'])
                    if cur['km']:
                        vcall(cur['km'], KM_ReleaseSync, ctypes.c_long, ctypes.c_void_p(0))
            finally:
                if access and ok:
                    access.release()
            if ok:
                try:
                    buf = cur['buf']
                    d3d.read(cur['stage'], cur['w'], cur['h'], buf, 32)
                except OSError as e:
                    set_state('error', error=str(e))
                    drop()
                    time.sleep(0.5)
                    continue
                seq += 1
                if not sem:
                    rate_n += 1
                t = time.perf_counter()
                if t - rate_t >= 1.0:
                    sender_fps = rate_n / (t - rate_t)
                    rate_n, rate_t = 0, t
                struct.pack_into('<IIIIIIII', buf, 0, 0x31505356, cur['w'], cur['h'], cur['fmt'], seq & 0xffffffff,
                                 count & 0xffffffff, int(sender_fps * 100), 0)
                try:
                    out.write(buf)
                    out.flush()
                except (BrokenPipeError, OSError):
                    drop(); return
                if state != 'live':
                    set_state('live', w=cur['w'], h=cur['h'])
        next_t += period
        wait = next_t - time.perf_counter()
        if wait > 0:
            time.sleep(wait)
        else:
            next_t = time.perf_counter()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--list', action='store_true')
    ap.add_argument('--recv')
    ap.add_argument('--fps', type=int, default=30)
    ap.add_argument('--parent-pid', type=int, default=0)
    ap.add_argument('--registry', default='SpoutSenderNames')
    a = ap.parse_args()
    if a.list:
        out = []
        for n in list_senders(a.registry):
            i = sender_info(n)
            if i:
                out.append({'name': n, 'w': i['w'], 'h': i['h'], 'format': i['format'], 'ok': i['format'] in FMT,
                            **({} if i['format'] in FMT else {'why': 'DXGI format %d is not 8-bit RGBA / BGRA' % i['format']})})
        d3d_ok = True
        try:
            D3D()
        except OSError:
            d3d_ok = False
        print(json.dumps({'senders': out, 'd3d11': d3d_ok}))
        return
    if a.recv:
        receive(a.recv, a.fps, a.parent_pid, a.registry)
        return
    ap.print_help()


if __name__ == '__main__':
    main()
