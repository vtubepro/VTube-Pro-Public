"""NVIDIA Maxine AR SDK (Windows, v0.8.x) Face Expression Estimation through ctypes: BGR frame -> 53 expression
coefficients (ARKit-style, *_L / *_R = the subject's left / right) + head pose + 126 landmarks.

The SDK is NOT shipped with VTube Pro (NVIDIA Maxine licence). The user installs NVIDIA's own runtime, one per GPU
generation, from https://www.nvidia.com/broadcast-sdk-resources  (AR SDK 0.8.7: nvidia_ar_sdk_installer_v0.8.7_blackwell.exe
for RTX 50, _ada / _ampere / _turing for older RTX). It installs to C:\\Program Files\\NVIDIA Corporation\\NVIDIA AR SDK
and sets NVAR_MODEL_DIR. API names from NVIDIA's official headers (github.com/NVIDIA-Maxine/Maxine-AR-SDK, nvAR.h /
nvAR_defs.h / nvCVImage.h) and the ExpressionApp sample (github.com/NVIDIA-Maxine/AR-SDK-Samples).
"""
from __future__ import annotations

import ctypes as C
import os
import time

import numpy as np

# order of NvAR_Parameter_Output(ExpressionCoefficients) with face_model2/3 (ExpressionApp.cpp), mapped to ARKit names
MAXINE_NAMES = ['browDown_L', 'browDown_R', 'browInnerUp_L', 'browInnerUp_R', 'browOuterUp_L', 'browOuterUp_R', 'cheekPuff_L',
                'cheekPuff_R', 'cheekSquint_L', 'cheekSquint_R', 'eyeBlink_L', 'eyeBlink_R', 'eyeLookDown_L', 'eyeLookDown_R',
                'eyeLookIn_L', 'eyeLookIn_R', 'eyeLookOut_L', 'eyeLookOut_R', 'eyeLookUp_L', 'eyeLookUp_R', 'eyeSquint_L',
                'eyeSquint_R', 'eyeWide_L', 'eyeWide_R', 'jawForward', 'jawLeft', 'jawOpen', 'jawRight', 'mouthClose',
                'mouthDimple_L', 'mouthDimple_R', 'mouthFrown_L', 'mouthFrown_R', 'mouthFunnel', 'mouthLeft',
                'mouthLowerDown_L', 'mouthLowerDown_R', 'mouthPress_L', 'mouthPress_R', 'mouthPucker', 'mouthRight',
                'mouthRollLower', 'mouthRollUpper', 'mouthShrugLower', 'mouthShrugUpper', 'mouthSmile_L', 'mouthSmile_R',
                'mouthStretch_L', 'mouthStretch_R', 'mouthUpperUp_L', 'mouthUpperUp_R', 'noseSneer_L', 'noseSneer_R']


def arkit_name(n: str) -> str:
    if n.endswith('_L'):
        return n[:-2] + 'Left'
    if n.endswith('_R'):
        return n[:-2] + 'Right'
    return n


ARKIT_OUT = [arkit_name(n) for n in MAXINE_NAMES]   # cheekPuff_L/_R -> cheekPuffLeft/Right (merged to cheekPuff by the client)

NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_CPU, NVCV_GPU = 5, 1, 0, 0, 1
TEMPORAL_FACE_BOX, TEMPORAL_LANDMARKS, TEMPORAL_POSE, TEMPORAL_EXPR, TEMPORAL_GAZE, TEMPORAL_CLOSURE = 0x1, 0x2, 0x4, 0x10, 0x20, 0x100


class NvCVImage(C.Structure):
    _fields_ = [('width', C.c_uint), ('height', C.c_uint), ('pitch', C.c_int), ('pixelFormat', C.c_int), ('componentType', C.c_int),
                ('pixelBytes', C.c_ubyte), ('componentBytes', C.c_ubyte), ('numComponents', C.c_ubyte), ('planar', C.c_ubyte),
                ('gpuMem', C.c_ubyte), ('colorspace', C.c_ubyte), ('reserved', C.c_ubyte * 2), ('pixels', C.c_void_p),
                ('deletePtr', C.c_void_p), ('deleteProc', C.c_void_p), ('bufferBytes', C.c_ulonglong)]


class Point2f(C.Structure):
    _fields_ = [('x', C.c_float), ('y', C.c_float)]


class Quat(C.Structure):
    _fields_ = [('x', C.c_float), ('y', C.c_float), ('z', C.c_float), ('w', C.c_float)]


class Rect(C.Structure):
    _fields_ = [('x', C.c_float), ('y', C.c_float), ('width', C.c_float), ('height', C.c_float)]


class BBoxes(C.Structure):
    _fields_ = [('boxes', C.POINTER(Rect)), ('num_boxes', C.c_uint8), ('max_boxes', C.c_uint8)]


def sdk_dir() -> str | None:
    for d in [os.environ.get('VTP_MAXINE_DIR'), os.environ.get('NV_AR_SDK_PATH'),
              os.path.join(os.environ.get('ProgramFiles', r'C:\Program Files'), 'NVIDIA Corporation', 'NVIDIA AR SDK')]:
        if d and os.path.isfile(os.path.join(d, 'nvARPose.dll')):
            return d
    return None


def sdk_version(d: str) -> str:
    try:
        for line in open(os.path.join(d, 'version.h')):
            if 'NVIDIA_AR_SDK_VERSION' in line.upper() or 'VERSION' in line and '"' in line:
                return line.split('"')[1]
    except Exception:
        pass
    return '?'


class MaxineError(RuntimeError):
    pass


class MaxineFace:
    """Face Expression Estimation on one camera stream (CPU BGR frames in; the SDK uploads to the GPU)."""

    def __init__(self, width: int, height: int, temporal: int = TEMPORAL_FACE_BOX | TEMPORAL_LANDMARKS | TEMPORAL_POSE | TEMPORAL_EXPR | TEMPORAL_CLOSURE,
                 cheek_puff: bool = True):
        d = sdk_dir()
        if not d:
            raise MaxineError('NVIDIA AR SDK not installed (https://www.nvidia.com/broadcast-sdk-resources)')
        self.dir = d
        os.add_dll_directory(d)
        self.cv = C.CDLL(os.path.join(d, 'NVCVImage.dll'))
        self.ar = C.CDLL(os.path.join(d, 'nvARPose.dll'))
        ar, cv = self.ar, self.cv
        for f in ('NvAR_SetString', 'NvAR_SetU32', 'NvAR_SetObject', 'NvAR_SetF32Array', 'NvAR_GetU32', 'NvAR_Create', 'NvAR_Load', 'NvAR_Run', 'NvAR_Destroy', 'NvAR_CudaStreamCreate', 'NvAR_SetCudaStream'):
            getattr(ar, f).restype = C.c_int
        ar.NvAR_SetString.argtypes = [C.c_void_p, C.c_char_p, C.c_char_p]
        ar.NvAR_SetU32.argtypes = [C.c_void_p, C.c_char_p, C.c_uint]
        ar.NvAR_SetObject.argtypes = [C.c_void_p, C.c_char_p, C.c_void_p, C.c_ulong]
        ar.NvAR_SetF32Array.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(C.c_float), C.c_int]
        ar.NvAR_GetU32.argtypes = [C.c_void_p, C.c_char_p, C.POINTER(C.c_uint)]
        ar.NvAR_Create.argtypes = [C.c_char_p, C.POINTER(C.c_void_p)]
        ar.NvAR_SetCudaStream.argtypes = [C.c_void_p, C.c_char_p, C.c_void_p]
        ar.NvAR_CudaStreamCreate.argtypes = [C.POINTER(C.c_void_p)]
        cv.NvCVImage_Alloc.restype = C.c_int
        cv.NvCVImage_Alloc.argtypes = [C.POINTER(NvCVImage), C.c_uint, C.c_uint, C.c_int, C.c_int, C.c_uint, C.c_uint, C.c_uint]
        cv.NvCVImage_Init.restype = C.c_int
        cv.NvCVImage_Init.argtypes = [C.POINTER(NvCVImage), C.c_uint, C.c_uint, C.c_int, C.c_void_p, C.c_int, C.c_int, C.c_uint, C.c_uint]
        cv.NvCVImage_Transfer.restype = C.c_int
        cv.NvCVImage_Transfer.argtypes = [C.POINTER(NvCVImage), C.POINTER(NvCVImage), C.c_float, C.c_void_p, C.c_void_p]

        def ok(e, what):
            if e != 0:
                raise MaxineError(f'{what} failed (NvCV status {e})')
        self.ok = ok
        P = lambda k, n: f'NvAR_Parameter_{k}_{n}'.encode()  # noqa: E731
        self.w, self.h = width, height
        self.stream = C.c_void_p()
        ok(ar.NvAR_CudaStreamCreate(C.byref(self.stream)), 'CudaStreamCreate')
        self.gpu = NvCVImage()
        ok(cv.NvCVImage_Alloc(C.byref(self.gpu), width, height, NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_GPU, 1), 'NvCVImage_Alloc')
        self.cpu = NvCVImage()
        self.h_ = C.c_void_p()
        ok(ar.NvAR_Create(b'FaceExpressions', C.byref(self.h_)), 'NvAR_Create(FaceExpressions)')
        hd = self.h_
        md = os.environ.get('NVAR_MODEL_DIR') or os.path.join(d, 'models')
        ok(ar.NvAR_SetString(hd, P('Config', 'ModelDir'), md.encode()), 'ModelDir')
        ok(ar.NvAR_SetCudaStream(hd, P('Config', 'CUDAStream'), self.stream), 'CUDAStream')
        ok(ar.NvAR_SetU32(hd, P('Config', 'Temporal'), temporal), 'Temporal')
        ar.NvAR_SetU32(hd, P('Config', 'PoseMode'), 1)
        ar.NvAR_SetU32(hd, P('Config', 'EnableCheekPuff'), 1 if cheek_puff else 0)
        t = time.perf_counter()
        ok(ar.NvAR_Load(hd), 'NvAR_Load')
        self.load_s = time.perf_counter() - t
        n = C.c_uint()
        ok(ar.NvAR_GetU32(hd, P('Config', 'ExpressionCount'), C.byref(n)), 'ExpressionCount')
        self.count = n.value
        self.expr = (C.c_float * self.count)()
        ok(ar.NvAR_SetF32Array(hd, P('Output', 'ExpressionCoefficients'), self.expr, self.count), 'ExpressionCoefficients')
        self.lm = (Point2f * 126)()
        ar.NvAR_SetObject(hd, P('Output', 'Landmarks'), self.lm, C.sizeof(Point2f))
        self.lmc = (C.c_float * 126)()
        ar.NvAR_SetF32Array(hd, P('Output', 'LandmarksConfidence'), self.lmc, 126)
        self.boxdata = (Rect * 4)()
        self.boxes = BBoxes(C.cast(self.boxdata, C.POINTER(Rect)), 0, 4)
        ar.NvAR_SetObject(hd, P('Output', 'BoundingBoxes'), C.byref(self.boxes), C.sizeof(BBoxes))
        self.lm3 = (C.c_float * (126 * 3))()
        ar.NvAR_SetObject(hd, P('Output', 'Landmarks3d'), self.lm3, 12)
        self.pose = Quat()
        ar.NvAR_SetObject(hd, P('Output', 'Pose'), C.byref(self.pose), C.sizeof(Quat))
        self.trans = (C.c_float * 3)()
        ar.NvAR_SetObject(hd, P('Output', 'PoseTranslation'), self.trans, 12)
        ok(ar.NvAR_SetObject(hd, P('Input', 'Image'), C.byref(self.gpu), C.sizeof(NvCVImage)), 'Input Image')
        intr = (C.c_float * 3)(float(height), width / 2.0, height / 2.0)
        self.intr = intr
        ar.NvAR_SetF32Array(hd, P('Input', 'CameraIntrinsicParams'), intr, 3)
        self.last_ms = 0.0

    def run(self, bgr: np.ndarray) -> dict | None:
        """bgr: HxWx3 uint8 (the size given at construction). -> {w: 53 floats, pose: quat xyzw, conf} or None (no face)."""
        assert bgr.shape[0] == self.h and bgr.shape[1] == self.w
        a = np.ascontiguousarray(bgr)
        t = time.perf_counter()
        self.ok(self.cv.NvCVImage_Init(C.byref(self.cpu), self.w, self.h, a.strides[0], a.ctypes.data_as(C.c_void_p), NVCV_BGR, NVCV_U8, NVCV_CHUNKY, NVCV_CPU), 'Init')
        self.ok(self.cv.NvCVImage_Transfer(C.byref(self.cpu), C.byref(self.gpu), 1.0, self.stream, None), 'Transfer')
        self.boxes.num_boxes = 0
        e = self.ar.NvAR_Run(self.h_)
        self.last_ms = (time.perf_counter() - t) * 1000
        if e != 0:
            raise MaxineError(f'NvAR_Run failed ({e})')
        conf = float(np.mean(np.frombuffer(self.lmc, np.float32)))
        if self.boxes.num_boxes == 0 and conf < 0.1:
            return None
        return {'w': np.frombuffer(self.expr, np.float32).copy(), 'pose': [self.pose.x, self.pose.y, self.pose.z, self.pose.w], 'conf': conf}

    def close(self):
        try:
            self.ar.NvAR_Destroy(self.h_)
        except Exception:
            pass
