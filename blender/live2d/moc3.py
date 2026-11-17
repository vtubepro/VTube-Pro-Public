"""Clean-room .moc3 reader + puppet evaluator (numpy, no Live2D code).

Format knowledge: the OpenL2D "MOC3 Format Specification 2.1b" ImHex pattern (moc3ingbird, FDPL-1.0-US) for the
layout and MahouTechnologies/moc3-rs (MIT/Apache-2.0, a ground-up reimplementation from that spec) for the deformer
math. No Live2D Cubism Core / SDK code was used or decompiled. See docs/LIVE2D_TO_3D.md for the licence discussion:
this reader exists so a performer can convert THEIR OWN model; it is not a Live2D runtime.

    m = Moc3(open('Model.moc3', 'rb').read())
    pose = m.evaluate({'ParamAngleX': 30})          # dict of parameter id -> value (others = default)
    pose.positions[i]   # (V,2) float32 model-space vertices of art mesh i (after every deformer)
    pose.opacity[i], pose.order (render order list), pose.enabled[i]

Model space: x right, y DOWN (Cubism units: canvas pixels / pixelsPerUnit, origin at canvasInfo origin).
Versions 1..5 per the spec; newer files (v6 = Cubism 5.3) are read through the same prefix (new sections are
appended after the v5 ones).
"""
import struct
import numpy as np

ID = 'id'          # 64-byte zero-terminated string
F4, I4, U4, U1, I2 = '<f4', '<i4', '<u4', 'u1', '<i2'

COUNT_NAMES = ['parts', 'deformers', 'warps', 'rots', 'arts', 'params', 'partKF', 'warpKF', 'rotKF', 'artKF',
               'kfPos', 'pbIdx', 'kfBind', 'pBind', 'keys', 'uvs', 'posIdx', 'masks', 'dog', 'dogObj',
               'glue', 'glueInfo', 'glueKF',
               # v4.2
               'mulCol', 'scrCol', 'bsPBind', 'bsKBind', 'bsWarp', 'bsArt', 'bsConIdx', 'bsCon', 'bsConVal',
               # v5
               'bsPart', 'bsRot', 'bsGlue']

RT = None  # runtime-space pointer (skipped)
import os as _os
ROT_SIGN = float(_os.environ.get("L2D_ROT_SIGN", "1"))


def _layout(ver):
    L = [('parts', [('rt', RT), ('ids', ID), ('kbSrc', I4), ('kfBegin', I4), ('kfCount', I4), ('visible', U4),
                    ('enabled', U4), ('parentPart', I4)]),
         ('deformers', [('rt', RT), ('ids', ID), ('kbSrc', I4), ('visible', U4), ('enabled', U4), ('parentPart', I4),
                        ('parentDeformer', I4), ('types', U4), ('specific', I4)]),
         ('warps', [('kbSrc', I4), ('kfBegin', I4), ('kfCount', I4), ('vertexCounts', I4), ('rows', U4), ('cols', U4)]),
         ('rots', [('kbSrc', I4), ('kfBegin', I4), ('kfCount', I4), ('baseAngles', F4)]),
         ('arts', [('rt', RT), ('rt1', RT), ('rt2', RT), ('rt3', RT), ('ids', ID), ('kbSrc', I4), ('kfBegin', I4),
                   ('kfCount', I4), ('visible', U4), ('enabled', U4), ('parentPart', I4), ('parentDeformer', I4),
                   ('textureNo', U4), ('flags', U1), ('vertexCounts', I4), ('uvBegin', I4), ('posIdxBegin', I4),
                   ('posIdxCount', I4), ('maskBegin', I4), ('maskCount', I4)]),
         ('params', [('rt', RT), ('ids', ID), ('max', F4), ('min', F4), ('default', F4), ('repeat', U4),
                     ('decimals', U4), ('pbBegin', I4), ('pbCount', I4)]),
         ('partKF', [('drawOrders', F4)]),
         ('warpKF', [('opacities', F4), ('posBegin', I4)]),
         ('rotKF', [('opacities', F4), ('angles', F4), ('ox', F4), ('oy', F4), ('scales', F4), ('reflectX', U4),
                    ('reflectY', U4)]),
         ('artKF', [('opacities', F4), ('drawOrders', F4), ('posBegin', I4)]),
         ('kfPos', [('xys', F4)]),
         ('pbIdx', [('src', I4)]),
         ('kfBind', [('pbiBegin', I4), ('pbiCount', I4)]),
         ('pBind', [('keysBegin', I4), ('keysCount', I4)]),
         ('keys', [('values', F4)]),
         ('uvs', [('xys', F4)]),
         ('posIdx', [('indices', I2)]),
         ('masks', [('art', I4)]),
         ('dog', [('objBegin', I4), ('objCount', I4), ('objTotal', I4), ('maxOrder', U4), ('minOrder', U4)]),
         ('dogObj', [('types', U4), ('indices', I4), ('self', I4)]),
         ('glue', [('rt', RT), ('ids', ID), ('kbSrc', I4), ('kfBegin', I4), ('kfCount', I4), ('artA', I4),
                   ('artB', I4), ('infoBegin', I4), ('infoCount', I4)]),
         ('glueInfo', [('weights', F4), ('posIdx', I2)]),
         ('glueKF', [('intensities', F4)])]
    if ver >= 2:
        L.append(('warps', [('isQuad', U4)]))
    if ver >= 4:
        L += [('params', [('rtx', RT), ('extKeysBegin', I4), ('extKeysCount', I4)]),
              ('warps', [('colBegin', I4)]), ('rots', [('colBegin', I4)]), ('arts', [('colBegin', I4)]),
              ('mulCol', [('r', F4), ('g', F4), ('b', F4)]), ('scrCol', [('r', F4), ('g', F4), ('b', F4)]),
              ('params', [('ptype', U4), ('bsPbBegin', I4), ('bsPbCount', I4)]),
              ('bsPBind', [('keysBegin', I4), ('keysCount', I4), ('baseKey', I4)]),
              ('bsKBind', [('pbSrc', I4), ('kfBegin', I4), ('kfCount', I4), ('conBegin', I4), ('conCount', I4)]),
              ('bsWarp', [('target', I4), ('kbBegin', I4), ('kbCount', I4)]),
              ('bsArt', [('target', I4), ('kbBegin', I4), ('kbCount', I4)]),
              ('bsConIdx', [('src', I4)]),
              ('bsCon', [('param', I4), ('valBegin', I4), ('valCount', I4)]),
              ('bsConVal', [('keys', F4), ('weights', F4)])]
    if ver >= 5:
        L += [('warpKF', [('mulBegin', I4), ('scrBegin', I4)]), ('rotKF', [('mulBegin', I4), ('scrBegin', I4)]),
              ('artKF', [('mulBegin', I4), ('scrBegin', I4)]),
              ('bsPart', [('target', I4), ('kbBegin', I4), ('kbCount', I4)]),
              ('bsRot', [('target', I4), ('kbBegin', I4), ('kbCount', I4)]),
              ('bsGlue', [('target', I4), ('kbBegin', I4), ('kbCount', I4)])]
    return L


class Sec:
    """attribute access to a section's arrays (also s['name'])"""
    def __init__(self, d=None):
        self.__dict__.update(d or {})

    def __getitem__(self, k):
        return self.__dict__[k]

    def __setitem__(self, k, v):
        self.__dict__[k] = v

    def __contains__(self, k):
        return k in self.__dict__


def _cstr(b):
    return b.split(b'\0', 1)[0].decode('utf-8', 'replace')


class Moc3:
    def __init__(self, data):
        if data[:4] != b'MOC3':
            raise ValueError('not a MOC3 file')
        self.version = data[4]
        if data[5]:
            raise ValueError('big-endian MOC3 is not supported')
        self.data, size = data, len(data)
        ver = min(self.version, 5)
        ptr = struct.unpack_from('<%dI' % (0x280 // 4), data, 0x40)
        cnt_off, canvas_off = ptr[0], ptr[1]
        ncount = 23 + (9 if ver >= 4 else 0) + (3 if ver >= 5 else 0)
        counts = struct.unpack_from('<%dI' % ncount, data, cnt_off)
        self.counts = {k: 0 for k in COUNT_NAMES}
        self.counts.update(zip(COUNT_NAMES, counts))
        ppu, ox, oy, cw, ch = struct.unpack_from('<5f', data, canvas_off)
        self.canvas = dict(ppu=ppu, ox=ox, oy=oy, w=cw, h=ch, flags=data[canvas_off + 20])
        self.s = Sec({k: Sec() for k in COUNT_NAMES})
        pi = 2
        for sec, fields in _layout(ver):
            n = self.counts[sec]
            for name, dt in fields:
                off = ptr[pi]; pi += 1
                if dt is RT:
                    continue
                if dt == ID:
                    if n and off + 64 * n <= size:
                        self.s[sec][name] = [_cstr(data[off + 64 * i: off + 64 * i + 64]) for i in range(n)]
                    else:
                        self.s[sec][name] = []
                    continue
                if n == 0 or off >= size:
                    self.s[sec][name] = np.zeros(0, dt)
                    continue
                self.s[sec][name] = np.frombuffer(data, dt, n, off).copy()
        s = self.s
        # parameter binding -> parameter
        self.pb_param = np.zeros(self.counts['pBind'], int)
        for p in range(self.counts['params']):
            b, c = s.params.pbBegin[p], s.params.pbCount[p]
            self.pb_param[b:b + c] = p
        self.bs_pb_param = np.zeros(self.counts['bsPBind'], int)
        if ver >= 4:
            for p in range(self.counts['params']):
                if s.params.ptype[p] == 1:
                    b, c = s.params.bsPbBegin[p], s.params.bsPbCount[p]
                    self.bs_pb_param[b:b + c] = p
        self.param_ids = s.params.ids
        self.param_index = {k: i for i, k in enumerate(self.param_ids)}
        self.art_ids = s.arts.ids
        self.part_ids = s.parts.ids
        self.deformer_ids = s.deformers.ids
        self._prep()

    # ------------------------------------------------------------------ structure
    def binding_tables(self, kb):
        """keyform binding -> [(keys ndarray, param index)] (first entry varies fastest)"""
        s = self.s
        out = []
        b, c = s.kfBind.pbiBegin[kb], s.kfBind.pbiCount[kb]
        for a in range(b, b + c):
            pb = s.pbIdx.src[a]
            kb0, kc = s.pBind.keysBegin[pb], s.pBind.keysCount[pb]
            out.append((s.keys.values[kb0:kb0 + kc], int(self.pb_param[pb])))
        return out

    def _prep(self):
        s, C = self.s, self.counts
        self.art_uv, self.art_tri, self.art_kf = [], [], []
        for i in range(C['arts']):
            n = s.arts.vertexCounts[i]
            ub = s.arts.uvBegin[i]
            self.art_uv.append(s.uvs.xys[ub:ub + 2 * n].reshape(n, 2))
            ib, ic = s.arts.posIdxBegin[i], s.arts.posIdxCount[i]
            self.art_tri.append(s.posIdx.indices[ib:ib + ic].astype(int).reshape(-1, 3))
            kb, kc = s.arts.kfBegin[i], s.arts.kfCount[i]
            pos = np.stack([s.kfPos.xys[s.artKF.posBegin[k]:s.artKF.posBegin[k] + 2 * n].reshape(n, 2)
                            for k in range(kb, kb + kc)])
            self.art_kf.append(dict(pos=pos, op=s.artKF.opacities[kb:kb + kc], do=s.artKF.drawOrders[kb:kb + kc],
                                    tab=self.binding_tables(s.arts.kbSrc[i])))
        self.warp_kf, self.rot_kf = [], []
        for w in range(C['warps']):
            n = s.warps.vertexCounts[w]
            kb, kc = s.warps.kfBegin[w], s.warps.kfCount[w]
            pos = np.stack([s.kfPos.xys[s.warpKF.posBegin[k]:s.warpKF.posBegin[k] + 2 * n].reshape(n, 2)
                            for k in range(kb, kb + kc)])
            self.warp_kf.append(dict(pos=pos, op=s.warpKF.opacities[kb:kb + kc],
                                     tab=self.binding_tables(s.warps.kbSrc[w])))
        for r in range(C['rots']):
            kb, kc = s.rots.kfBegin[r], s.rots.kfCount[r]
            sl = slice(kb, kb + kc)
            tr = np.stack([s.rotKF.ox[sl], s.rotKF.oy[sl], s.rotKF.scales[sl], s.rotKF.angles[sl]], 1)
            self.rot_kf.append(dict(tr=tr, op=s.rotKF.opacities[sl], rx=s.rotKF.reflectX[sl], ry=s.rotKF.reflectY[sl],
                                    tab=self.binding_tables(s.rots.kbSrc[r])))
        self.part_kf = []
        for p in range(C['parts']):
            kb, kc = s.parts.kfBegin[p], s.parts.kfCount[p]
            self.part_kf.append(dict(do=s.partKF.drawOrders[kb:kb + kc], tab=self.binding_tables(s.parts.kbSrc[p])))
        self.glue_kf = []
        for g in range(C['glue']):
            kb, kc = s.glue.kfBegin[g], s.glue.kfCount[g]
            ib, ic = s.glue.infoBegin[g], s.glue.infoCount[g]
            self.glue_kf.append(dict(it=s.glueKF.intensities[kb:kb + kc], tab=self.binding_tables(s.glue.kbSrc[g]),
                                     w=s.glueInfo.weights[ib:ib + ic], idx=s.glueInfo.posIdx[ib:ib + ic].astype(int)))
        # blend shapes (v4.2+): additive keyforms on art meshes / warp deformers
        self.bs = {'arts': [], 'warps': []}
        if self.version >= 4:
            for kind, sec, vc in (('arts', 'bsArt', s.arts.vertexCounts), ('warps', 'bsWarp', s.warps.vertexCounts)):
                for j in range(C[sec]):
                    t = int(s[sec].target[j]); n = vc[t]
                    for a in range(s[sec].kbBegin[j], s[sec].kbBegin[j] + s[sec].kbCount[j]):
                        pb = s.bsKBind.pbSrc[a]
                        k0, kc = s.bsKBind.kfBegin[a], s.bsKBind.kfCount[a]
                        posb = s.artKF.posBegin if kind == 'arts' else s.warpKF.posBegin
                        pos = np.stack([s.kfPos.xys[posb[k]:posb[k] + 2 * n].reshape(n, 2) for k in range(k0, k0 + kc)])
                        kb0, kn = s.bsPBind.keysBegin[pb], s.bsPBind.keysCount[pb]
                        cons = []
                        for ci in range(s.bsKBind.conBegin[a], s.bsKBind.conBegin[a] + s.bsKBind.conCount[a]):
                            c = s.bsConIdx.src[ci]
                            vb, vn = s.bsCon.valBegin[c], s.bsCon.valCount[c]
                            cons.append((int(s.bsCon.param[c]), s.bsConVal.keys[vb:vb + vn], s.bsConVal.weights[vb:vb + vn]))
                        self.bs[kind].append(dict(target=t, pos=pos, keys=s.keys.values[kb0:kb0 + kn],
                                                  param=int(self.bs_pb_param[pb]), base=int(s.bsPBind.baseKey[pb]), cons=cons))
        # evaluation order: deformers + art meshes in a parent-first walk
        nd = C['deformers']
        children = {i: [] for i in range(-1, nd)}
        for d in range(nd):
            children[int(s.deformers.parentDeformer[d])].append(('d', d))
        for a in range(C['arts']):
            children[int(s.arts.parentDeformer[a])].append(('a', a))
        order, stack = [], list(reversed(children[-1]))
        while stack:
            k, i = stack.pop()
            order.append((k, i))
            if k == 'd':
                stack.extend(reversed(children[i]))
        self.walk = order

    # ------------------------------------------------------------------ evaluation
    @staticmethod
    def _segment(keys, v):
        n = len(keys)
        if n <= 1:
            return 0, 0.0
        if v <= keys[0]:
            return 0, 0.0
        if v >= keys[-1]:
            return n - 2, 1.0
        u = int(np.searchsorted(keys, v, side='right'))
        u = min(max(u, 1), n - 1)
        return u - 1, float((v - keys[u - 1]) / (keys[u] - keys[u - 1]))

    def _interp(self, tab, params, values):
        """multilinear keyform blend; values: array with the keyform axis first"""
        if not tab:
            return values[0]
        base, size, ts = 0, 1, []
        for keys, p in tab:
            lo, t = self._segment(keys, params[p])
            base += lo * size; ts.append(t); size *= len(keys)
        out = np.zeros_like(values[0], dtype=np.float64)
        for num in range(1 << len(tab)):
            w, idx, size = 1.0, base, 1
            for i, (keys, _) in enumerate(tab):
                if num >> i & 1:
                    idx += size; w *= ts[i]
                else:
                    w *= 1 - ts[i]
                size *= len(keys)
            if w:
                out = out + values[idx] * w
        return out

    @staticmethod
    def _outside(tab, params, eps=1e-3):
        for keys, p in tab:
            v = params[p]
            if len(keys) == 1:
                if abs(v - keys[0]) >= eps:
                    return True
            elif len(keys) and (v < keys[0] - eps or v >= keys[-1] + eps):
                return True
        return False

    def default_params(self):
        return self.s.params.default.astype(np.float64).copy()

    def evaluate(self, params=None, part_opacity=None):
        s, C = self.s, self.counts
        P = self.default_params()
        for k, v in (params or {}).items():
            if k in self.param_index:
                P[self.param_index[k]] = v
        P = np.clip(P, s.params.min, s.params.max)
        # enabled (key tables out of range disable the object, like switched arm variants)
        part_en = np.zeros(C['parts'], bool)
        for p in range(C['parts']):
            pp = s.parts.parentPart[p]
            part_en[p] = bool(s.parts.enabled[p]) and not self._outside(self.part_kf[p]['tab'], P) and (pp < 0 or part_en[pp])
        dcount = C['deformers']
        def_en = np.zeros(dcount, bool)
        for k, i in self.walk:
            if k != 'd':
                continue
            spec = s.deformers.specific[i]
            tab = self.warp_kf[spec]['tab'] if s.deformers.types[i] == 0 else self.rot_kf[spec]['tab']
            pp, pd = s.deformers.parentPart[i], s.deformers.parentDeformer[i]
            def_en[i] = bool(s.deformers.enabled[i]) and not self._outside(tab, P) and (pp < 0 or part_en[pp]) and (pd < 0 or def_en[pd])
        # part opacity (pose3 / user)
        popac = np.ones(C['parts'])
        if part_opacity:
            for pid, v in part_opacity.items():
                if pid in self.part_ids:
                    popac[self.part_ids.index(pid)] = v
        cpo = np.ones(C['parts'])
        for p in range(C['parts']):
            pp = s.parts.parentPart[p]
            cpo[p] = popac[p] * (cpo[pp] if pp >= 0 else 1)
        part_do = np.array([self._interp(self.part_kf[p]['tab'], P, self.part_kf[p]['do'][:, None])[0] if len(self.part_kf[p]['do']) else 500
                            for p in range(C['parts'])])
        # keyform blend
        warp_grid, warp_op = [], []
        for w in range(C['warps']):
            kf = self.warp_kf[w]
            warp_grid.append(self._interp(kf['tab'], P, kf['pos']))
            warp_op.append(float(self._interp(kf['tab'], P, kf['op'][:, None])[0]))
        rot_tr, rot_op = [], []
        for r in range(C['rots']):
            kf = self.rot_kf[r]
            rot_tr.append(self._interp(kf['tab'], P, kf['tr']))
            rot_op.append(float(self._interp(kf['tab'], P, kf['op'][:, None])[0]))
        art_pos, art_op, art_do = [], np.zeros(C['arts']), np.zeros(C['arts'])
        for a in range(C['arts']):
            kf = self.art_kf[a]
            art_pos.append(self._interp(kf['tab'], P, kf['pos']))
            art_op[a] = self._interp(kf['tab'], P, kf['op'][:, None])[0]
            art_do[a] = self._interp(kf['tab'], P, kf['do'][:, None])[0]
        for kind, store in (('arts', art_pos), ('warps', warp_grid)):
            for b in self.bs[kind]:
                keys = b['keys']
                w = 1.0
                for pi_, ck, cw in b['cons']:
                    lo, t = self._segment(ck, P[pi_])
                    hi = min(lo + 1, len(cw) - 1)
                    w = min(w, (1 - t) * cw[lo] + t * cw[hi])
                lo, t = self._segment(keys, P[b['param']])
                d = b['pos'][lo] * (1 - t) + b['pos'][min(lo + 1, len(keys) - 1)] * t
                store[b['target']] = store[b['target']] + d * w
        # deformer chain (parent-first walk)
        dscale = np.ones(dcount)
        dop = np.ones(dcount)
        rot_ang = {}
        for k, i in self.walk:
            if k == 'd':
                pd = s.deformers.parentDeformer[i]
                spec = s.deformers.specific[i]
                if s.deformers.types[i] == 0:
                    own_op = warp_op[spec]
                    if pd >= 0:
                        warp_grid[spec] = self._through(pd, warp_grid[spec], warp_grid, rot_tr, dscale)
                        dscale[i] = dscale[pd]
                    else:
                        dscale[i] = 1.0
                else:
                    own_op = rot_op[spec]
                    tr = rot_tr[spec]
                    dscale[i] = tr[2]
                    if pd >= 0:
                        o = tr[:2].copy()
                        base = 0.1 if s.deformers.types[pd] == 0 else 10.0
                        tr[3] += self._angle_diff(pd, o, base, warp_grid, rot_tr, dscale)
                        tr[:2] = self._through(pd, o[None], warp_grid, rot_tr, dscale)[0]
                        dscale[i] *= dscale[pd]
                dop[i] = own_op * (dop[pd] if pd >= 0 else 1.0)
            else:
                pd = s.arts.parentDeformer[i]
                if pd >= 0:
                    art_pos[i] = self._through(pd, art_pos[i], warp_grid, rot_tr, dscale)
                    art_op[i] *= dop[pd]
        # enabled art meshes + part opacity
        art_en = np.zeros(C['arts'], bool)
        for a in range(C['arts']):
            pp, pd = s.arts.parentPart[a], s.arts.parentDeformer[a]
            art_en[a] = bool(s.arts.enabled[a]) and bool(s.arts.visible[a]) and not self._outside(self.art_kf[a]['tab'], P) and (pp < 0 or part_en[pp]) and (pd < 0 or def_en[pd])
            if pp >= 0:
                art_op[a] *= cpo[pp]
        # glue
        for g in range(C['glue']):
            gk = self.glue_kf[g]
            it = float(self._interp(gk['tab'], P, gk['it'][:, None])[0])
            A, B = int(s.glue.artA[g]), int(s.glue.artB[g])
            idx, w = gk['idx'].reshape(-1, 2), gk['w'].reshape(-1, 2)
            pa, pb = art_pos[A], art_pos[B]
            da = pb[idx[:, 1]] - pa[idx[:, 0]]
            pa2, pb2 = pa.copy(), pb.copy()
            pa2[idx[:, 0]] += da * w[:, :1] * it
            pb2[idx[:, 1]] -= da * w[:, 1:] * it
            art_pos[A], art_pos[B] = pa2, pb2
        order = self._render_order(part_en, art_en, part_do, art_do, art_op)
        return Pose(self, P, [p.astype(np.float32) for p in art_pos], art_op, art_do, art_en, order)

    def _warp(self, w, pts, grid):
        rows, cols = int(self.s.warps.rows[w]), int(self.s.warps.cols[w])
        quad = bool(self.s.warps.isQuad[w]) if 'isQuad' in self.s.warps and len(self.s.warps.isQuad) else False
        return warp_points(grid, quad, rows, cols, pts)

    def _through(self, d, pts, warp_grid, rot_tr, dscale):
        spec = self.s.deformers.specific[d]
        if self.s.deformers.types[d] == 0:
            return self._warp(spec, np.asarray(pts, np.float64), warp_grid[spec])
        ox, oy, _, ang = rot_tr[spec]
        sc = dscale[d]
        a = np.radians(self.s.rots.baseAngles[spec] + ang) * ROT_SIGN
        c, s_ = np.cos(a), np.sin(a)
        p = np.asarray(pts, np.float64)
        rk = self.rot_kf[spec]
        return np.stack([sc * (c * p[:, 0] - s_ * p[:, 1]) + ox, sc * (s_ * p[:, 0] + c * p[:, 1]) + oy], 1)

    def _angle_diff(self, d, origin, base, warp_grid, rot_tr, dscale):
        direction = np.array([0.0, -1.0]) * base
        t0 = self._through(d, origin[None], warp_grid, rot_tr, dscale)[0]
        for i in range(10):
            t1 = self._through(d, (origin + direction * 0.1 ** i)[None], warp_grid, rot_tr, dscale)[0]
            r = t1 - t0
            if np.all(np.isfinite(r)) and np.any(r != 0):
                return float(np.degrees(np.arctan2(direction[0] * r[1] - direction[1] * r[0], direction @ r)))
        return 0.0

    def _render_order(self, part_en, art_en, part_do, art_do, art_op):
        s, C = self.s, self.counts
        if C['dog'] == 0:
            return [int(a) for a in np.argsort(art_do, kind='stable') if art_en[a] and art_op[a] > 0]
        seq = [-1] * C['arts']
        cursor = [0] * C['dog']
        for g in range(C['dog']):
            b, n = int(s.dog.objBegin[g]), int(s.dog.objCount[g])
            if n == 0:
                continue
            lo, hi = int(s.dog.minOrder[g]), int(s.dog.maxOrder[g])
            items = []
            for j in range(n):
                t, idx = int(s.dogObj.types[b + j]), int(s.dogObj.indices[b + j])
                if t == 1:
                    o = int(round(part_do[idx])) if part_en[idx] else lo
                else:
                    o = int(round(art_do[idx])) if art_en[idx] else lo
                items.append((min(max(o, lo), hi), j))
            items.sort()
            pos = cursor[g]
            for _, j in items:
                t, idx, own = int(s.dogObj.types[b + j]), int(s.dogObj.indices[b + j]), int(s.dogObj.self[b + j])
                if t == 1:
                    if own >= 0:
                        cursor[own] = pos
                        pos += int(s.dog.objTotal[own])
                else:
                    if pos < len(seq):
                        seq[pos] = idx
                    pos += 1
        return [a for a in seq if a >= 0 and art_en[a] and art_op[a] > 0]


class Pose:
    def __init__(self, moc, params, positions, opacity, draw_order, enabled, order):
        self.moc, self.params, self.positions = moc, params, positions
        self.opacity, self.draw_order, self.enabled, self.order = opacity, draw_order, enabled, order


def _bilinear(t, bl, br, tl, tr):
    n = 1 - t
    return bl * (n[:, :1] * n[:, 1:]) + br * (t[:, :1] * n[:, 1:]) + tl * (n[:, :1] * t[:, 1:]) + tr * (t[:, :1] * t[:, 1:])


def _triangular(t, bl, br, tl, tr):
    n = 1 - t
    up = (t[:, 0] + t[:, 1]) > 1
    a = tr + (tl - tr) * n[:, :1] + (br - tr) * n[:, 1:]
    b = bl + (br - bl) * t[:, :1] + (tl - bl) * t[:, 1:]
    return np.where(up[:, None], a, b)


def warp_points(grid, quad, rows, cols, pts):
    """Map points given in a warp deformer's normalised space ([0,1]^2 spans the grid) through the grid."""
    grid = np.asarray(grid, np.float64)
    p = np.asarray(pts, np.float64)
    out = np.empty_like(p)
    cp = cols + 1
    g = p * np.array([cols, rows])
    gx = np.clip(np.floor(g[:, 0]).astype(int), 0, cols - 1)
    gy = np.clip(np.floor(g[:, 1]).astype(int), 0, rows - 1)
    inside = (p[:, 0] >= 0) & (p[:, 0] < 1) & (p[:, 1] >= 0) & (p[:, 1] < 1)
    if inside.any():
        gi = gx[inside] + gy[inside] * cp
        t = g[inside] - np.stack([gx[inside], gy[inside]], 1)
        f = _bilinear if quad else _triangular
        out[inside] = f(t, grid[gi], grid[gi + 1], grid[gi + cp], grid[gi + cp + 1])
    if (~inside).any():
        c00, c10, c01, c11 = grid[0], grid[cols], grid[rows * cp], grid[cols + rows * cp]
        centroid = (c00 + c10 + c01 + c11) / 4
        d1, d2 = c11 - c00, c10 - c01
        vx, vy = (d1 + d2) / 2, (d1 - d2) / 2
        origin = centroid - d1 * 0.5
        O = lambda a, b: origin + vx * a + vy * b
        for k in np.nonzero(~inside)[0]:
            x, y = p[k]
            if not (-2 <= x <= 3 and -2 <= y <= 3):
                out[k] = origin + x * vx + y * vy
                continue
            xi = 2 if x >= 1 else 1 if x >= 0 else 0
            yi = 2 if y >= 1 else 1 if y >= 0 else 0
            case = xi + yi * 3
            px, py = g[k]
            rs = lambda v, a, b: (v - a) / (b - a)
            T = lambda a, b: np.array([[a, b]])
            if case in (7, 1):
                ax = min(int(px), cols - 1) if px >= 0 else 0
                f0, f1 = ax / cols, (ax + 1) / cols
                if case == 7:
                    r = _triangular(T(px - ax, rs(y, 1, 3)), grid[ax + rows * cp], grid[ax + 1 + rows * cp], O(f0, 3), O(f1, 3))
                else:
                    r = _triangular(T(px - ax, rs(y, -2, 0)), O(f0, -2), O(f1, -2), grid[ax], grid[ax + 1])
            elif case in (3, 5):
                ay = min(int(py), rows - 1) if py >= 0 else 0
                f0, f1 = ay / rows, (ay + 1) / rows
                if case == 3:
                    r = _triangular(T(rs(x, -2, 0), py - ay), O(-2, f0), grid[ay * cp], O(-2, f1), grid[(ay + 1) * cp])
                else:
                    r = _triangular(T(rs(x, 1, 3), py - ay), grid[cols + ay * cp], O(3, f0), grid[cols + (ay + 1) * cp], O(3, f1))
            elif case == 6:
                r = _triangular(T(rs(x, -2, 0), rs(y, 1, 3)), O(-2, 1), grid[rows * cp], O(-2, 3), O(0, 3))
            elif case == 8:
                r = _triangular(T(rs(x, 1, 3), rs(y, 1, 3)), grid[cols + rows * cp], O(3, 1), O(1, 3), O(3, 3))
            elif case == 0:
                r = _triangular(T(rs(x, -2, 0), rs(y, -2, 0)), O(-2, -2), O(0, -2), O(-2, 0), grid[0])
            else:  # 2
                r = _triangular(T(rs(x, 1, 3), rs(y, -2, 0)), O(1, -2), O(3, -2), grid[cols], O(3, 0))
            out[k] = r[0]
    return out


def load(path):
    with open(path, 'rb') as fh:
        return Moc3(fh.read())


if __name__ == '__main__':
    import sys
    m = load(sys.argv[1])
    print('version', m.version, 'canvas', m.canvas)
    print({k: v for k, v in m.counts.items() if v})
    p = m.evaluate()
    print('rendered', len(p.order), 'of', m.counts['arts'])
