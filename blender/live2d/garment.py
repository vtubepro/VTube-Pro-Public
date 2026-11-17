"""Outfit from the Live2D art onto the VRoid garments (numpy): the drawn front of the outfit is projected onto the FRONT
of the 3D garments (tops, bottoms, shoes, and the body skin where the art shows clothes: stockings, tights, sleeves),
the rest of each garment keeps its recoloured flat tone. docs/AI_CREATOR_GUIDE.md 8.1 allows projecting a clean
DRAWN view onto bodies / clothes (never faces); the Live2D art is exactly that, at 2-4K canvas resolution.

Registration (front view): Live2D model space (x right, y down) <-> VRM glTF space (x = character's right, y up,
front = -Z) through landmarks: chin, shoulder line, feet (vertical, piecewise linear) and the torso / hip widths
(horizontal scale per height band). Arms are posed differently (Live2D arms hang, VRoid is a T-pose), so arm texels
are never projected: long sleeves drawn in the art are painted onto the arm skin as a flat sleeve instead.
"""
import os

import numpy as np

from anime_creator.vroid import Model
from anime_creator import colors, imgio
from face_kit.raster import posmap, dilate

from .render import View, render_pose

GARMENT_CLS = {'top', 'bottom', 'legwear', 'shoes', 'accessory', 'skin', 'neck', 'other', 'leg'}
TEX = 2048


def _smooth(x, e0, e1):
    t = np.clip((x - e0) / (e1 - e0), 0, 1)
    return t * t * (3 - 2 * t)


class Register:
    """Live2D model coords <-> VRM coords (front view)"""

    def __init__(self, A, m, view):
        lm = A.lm
        self.A, self.view = A, view
        fb = lm['face_bbox']
        P = A.pose.positions if A.pose is not None else None
        arms = [a for a, c in enumerate(A.cls) if c in ('arm',)]
        chin2 = fb[3]
        feet2 = lm['figure_bbox'][3]
        head_h = fb[3] - lm.get('crown', fb[1])
        # shoulder line: where the drawn arms start (sleeve caps can reach up beside the neck: keep it in the anime
        # neck-length range, a third of a head under the chin)
        # (tuned on the samples: the VRoid shoulder joint matches the drawn line ~0.15-0.3 heads under the chin)
        sh2 = float(np.median([float(np.percentile(P[a][:, 1], 2)) for a in arms])) if arms else chin2 + 0.2 * head_h
        sh2 = float(np.clip(sh2, chin2 + 0.12 * head_h, chin2 + 0.3 * head_h))
        # VRM side
        fd = m.read_mesh(m.mesh_index('Face'))
        skin = [i for i, p in enumerate(fd.prims) if 'SKIN' in m.mat_name(p['material'])]
        Fp = fd.P[fd.verts_of(skin)]
        chin3 = float(Fp[Fp[:, 2] < np.percentile(Fp[:, 2], 40)][:, 1].min())
        bd = m.read_mesh(m.mesh_index('Body'))
        feet3 = float(bd.P[:, 1].min())
        sh3 = float(m.pos('J_Bip_L_UpperArm')[1])
        self.ys2 = np.array([chin2, sh2, feet2])
        self.ys3 = np.array([chin3, sh3, feet3])
        self.sh_x3 = abs(float(m.pos('J_Bip_L_UpperArm')[0]))
        self.hand_x3 = abs(float(m.pos('J_Bip_L_Hand')[0]))
        self.hip_y3 = float(m.pos('J_Bip_C_Hips')[1])
        self.knee_y3 = float(m.pos('J_Bip_L_LowerLeg')[1])
        self.ankle_y3 = float(m.pos('J_Bip_L_Foot')[1])
        # horizontal scale per height: torso half widths (arms excluded) at chest and hips, Live2D vs VRM
        tops = [bd] + [m.read_mesh(n['mesh']) for n in m.J['nodes'] if n.get('name', '').startswith('Outfit_') and 'mesh' in n]
        allP = np.concatenate([d.P for d in tops])
        self.band = []
        for f in (0.35, 0.7, 0.95):                      # chest, waist-ish, hips (fraction shoulder -> crotch)
            y3 = sh3 + (self.hip_y3 - 0.05 - sh3) * f
            sel = (np.abs(allP[:, 1] - y3) < 0.02) & (np.abs(allP[:, 0]) < self.sh_x3 * 1.05)
            w3 = float(np.percentile(np.abs(allP[sel, 0]), 97)) if sel.sum() > 10 else self.sh_x3
            y2 = self.y3_to_y2(y3)
            w2 = self._l2d_half_width(y2)
            if w2 > 1e-6:
                self.band.append((y3, w3 / w2))
        if not self.band:
            # a bust drawing (no torso rows in the picture): the chin -> shoulder scale, isotropic
            k = abs(self.ys3[0] - self.ys3[1]) / max(abs(self.ys2[1] - self.ys2[0]), 1e-9)
            self.band = [(sh3, float(k))]
        self.band.sort()

    def _l2d_half_width(self, y2):
        A, v = self.A, self.A.view                     # the analysis id picture has its own view
        r = int(round(v.px([[0, y2]])[0, 1]))
        if not (0 <= r < A.ids.shape[0]):
            return 0.0
        ids = A.ids[r]
        ok = np.array([i >= 0 and A.cls[i] in GARMENT_CLS for i in ids])
        xs = np.nonzero(ok)[0]
        if len(xs) < 3:
            return 0.0
        xm = v.model(np.stack([xs + 0.5, np.full(len(xs), r)], 1))[:, 0] - A.mid_x
        return float(np.percentile(np.abs(xm), 95))

    def y2_to_y3(self, y2):
        return -np.interp(np.asarray(y2, float), self.ys2, -self.ys3)

    def y3_to_y2(self, y3):
        # ys3 decreases (chin > shoulder > feet), ys2 increases
        return np.interp(-np.asarray(y3), -self.ys3, self.ys2)

    def scale_at(self, y3):
        ys = np.array([b[0] for b in self.band]); ss = np.array([b[1] for b in self.band])
        return np.interp(y3, ys, ss)

    def to_l2d(self, P3):
        y2 = self.y3_to_y2(P3[..., 1])
        s = self.scale_at(P3[..., 1])
        x2 = self.A.mid_x - P3[..., 0] / np.maximum(s, 1e-6)       # glTF +X = character's right = viewer's LEFT
        return np.stack([x2, y2], -1)


def _sample(img, view, xy):
    px = view.px(xy)
    x = np.clip(px[..., 0], 0, img.shape[1] - 1).astype(int)
    y = np.clip(px[..., 1], 0, img.shape[0] - 1).astype(int)
    return img[y, x]


def paint(A, vrm_in, vrm_out, log=print):
    model = A.model
    m = Model(vrm_in)
    if model is None:                                 # image-only route: the drawing itself is the art
        view = A.view
        art = A.garment_art
    else:
        view = View(model.moc.canvas, 3000)
        only = {a for a in A.pose.order if A.cls[a] in GARMENT_CLS}
        art, _ = render_pose(model, A.pose, view=view, only=only, ss=1)
    # colour classes at the same resolution (to tell skin from cloth in the art)
    R = Register(A, m, view)
    log(f'garment: chin/shoulder/feet L2D {np.round(R.ys2, 3).tolist()} -> VRM {np.round(R.ys3, 3).tolist()}, '
        f'x-scale {[(round(y, 2), round(s, 3)) for y, s in R.band]}')
    if A.model is not None:                           # (a bust drawing's shoulder line is a guess: no flare)
        _collar_flare(m, R, log)
    tx = colors.Textures(m)
    outfit = getattr(A, 'outfit', {}) or {}
    skin_rgb = np.asarray(A.skin_rgb, float)
    painted = []
    for ni, node in enumerate(m.J['nodes']):
        name = node.get('name', '')
        if 'mesh' not in node or not (name.startswith('Outfit_') or name == 'Body'):
            continue
        if name == 'Outfit_Accessory':
            _accessory(m, tx, node, A, outfit)
            if 'mesh' not in node:
                continue
            # kept: the drawn neck accessory's own pattern (Haru's striped scarf) is projected onto its front below
        d = m.read_mesh(node['mesh'])
        for pi, p in enumerate(d.prims):
            mat = p['material']
            if mat is None:
                continue
            ii = tx.own_image(mat)
            tex = tx.get(ii).copy()
            H, W = tex.shape[:2]
            mask, P3, N3 = posmap(d.P, d.N, d.UV, p['indices'], W, H)
            if not mask.any():
                continue
            front = _smooth(-N3[..., 2], 0.12, 0.5)
            # arm texels by skinning (T-posed arms can't take the hanging-arm art): share of UpperArm / LowerArm /
            # Hand weights, interpolated per texel through posmap's normal channel as a (arm, rest, 0) ratio vector
            aw = _arm_weight(m, node, d)
            _, _, AW = posmap(d.P, np.stack([aw + 1e-4, 1 - aw + 1e-4, np.zeros_like(aw)], 1), d.UV, p['indices'], W, H)
            arm = (AW[..., 0] / np.maximum(AW[..., 0] + AW[..., 1], 1e-6)) > 0.5
            xy = R.to_l2d(P3)
            c = _sample(art, view, xy)
            a = c[..., 3] * front * mask * (~arm)
            if model is None and name != 'Body':
                # a bust drawing can't register a garment front reliably (the shoulder line is a guess): paint only
                # the flat colour of the top, no projected detail
                a = a * 0.0
            is_body = name == 'Body'
            if name == 'Outfit_Accessory':
                # the accessory takes only the drawn accessory's cloth, never the skin drawn around it
                d_skin = np.linalg.norm(c[..., :3] - skin_rgb, axis=-1) + 1.6 * np.abs((c[..., 0] - c[..., 2]) - (skin_rgb[0] - skin_rgb[2]))
                a = a * _smooth(d_skin, 0.1, 0.2)
            if is_body:
                # on the body skin only where the art shows CLOTH (stockings, a bodysuit), never over drawn skin
                d_skin = np.linalg.norm(c[..., :3] - skin_rgb, axis=-1) + 1.6 * np.abs((c[..., 0] - c[..., 2]) - (skin_rgb[0] - skin_rgb[2]))
                a = a * _smooth(d_skin, 0.1, 0.2)
                below_neck = P3[..., 1] < R.ys3[1] - 0.02
                a = a * below_neck
            out = tex.copy()
            inner_c = ((outfit.get('top') or {}).get('inner') or [None])[0]
            if model is None and name == 'Outfit_Tops' and inner_c:
                # a bust drawing: the base top's light under-layer (shirt) takes the drawn inner layer's colour
                ic = _hex(inner_c)
                lum = out[..., :3].mean(-1)
                tcs = [t for t in ((outfit.get('top') or {}).get('colors') or []) if t != 'skin']
                # the light under-layer: bright texels unlike the (already tinted) jacket colour -- a white shirt
                # tinted with the jacket's hue is still far from it
                far = np.linalg.norm(out[..., :3] - _hex(tcs[0]), axis=-1) > 0.35 if tcs else True
                sel = mask & (lum > 0.5) & far
                box = getattr(A, 'inner_box', None)
                base_c = getattr(A, 'inner_base', None)
                if box is not None and base_c:
                    # the rest of the light under-layer (collar flaps, hem) in the inner layer's ground colour
                    out[sel, :3] = np.clip(_hex(base_c) * (lum[sel][:, None] / 0.85) ** 0.5, 0, 1)
                if box is not None:
                    # only the under-layer seen between the jacket fronts: texels facing front whose drawn position
                    # falls in the inner layer's column (from its top down)
                    pall = view.px(R.to_l2d(P3))
                    bw = box[2] - box[0]
                    sel &= (pall[..., 0] > box[0] - 0.1 * bw) & (pall[..., 0] < box[2] + 0.1 * bw)
                    sel &= (pall[..., 1] > box[1] - 0.15 * (box[3] - box[1])) & (N3[..., 2] < 0.2)
                    # an OPEN jacket: the drawing shows the inner layer in that column, whatever the base top's own
                    # neckline (a closed V) -- the front texels there take the inner layer too
                    sel |= mask & (N3[..., 2] < -0.3) & (pall[..., 0] > box[0] + 0.12 * bw) &                         (pall[..., 0] < box[2] - 0.12 * bw) & (pall[..., 1] > box[1])
                if box is not None and sel.any():
                    # a patterned inner layer: the drawn box mirror-tiled over the under-layer (pixels of the drawing
                    # at the texel's registered position, folded back into the box)
                    px = view.px(R.to_l2d(P3[sel]))
                    x0, y0, x1, y1 = box
                    def fold(v, a0, a1):
                        q = np.mod((v - a0) / max(a1 - a0, 1e-6), 2.0)
                        return a0 + np.where(q > 1, 2 - q, q) * (a1 - a0)
                    fx = np.clip(fold(px[:, 0], x0, x1), 0, art.shape[1] - 1).astype(int)
                    fy = np.clip(fold(px[:, 1], y0, y1), 0, art.shape[0] - 1).astype(int)
                    src = getattr(A, 'front', art)
                    out[sel, :3] = src[fy, fx, :3]
                else:
                    out[sel, :3] = np.clip(ic * (lum[sel][:, None] / 0.85), 0, 1)
                log(f'garment: inner layer {"pattern" if box is not None else inner_c} on {int(sel.sum())} texels of the top')
            k = a[..., None]
            out[..., :3] = out[..., :3] * (1 - k) + c[..., :3] * k
            if is_body:
                out = _sleeves_and_legwear(out, mask, P3, R, outfit, skin_rgb, arm)
            elif name == 'Outfit_Tops' and outfit.get('sleeves') == 'long' and outfit.get('sleeve_colors'):
                # the base top's own sleeves take the drawn sleeve colour (a VRoid short sleeve over a painted long one)
                c = _hex(outfit['sleeve_colors'][0])
                # the sleeve's shade of the jacket colour (drawn shading) -> the jacket's own lit colour
                tc = [t for t in ((outfit.get('top') or {}).get('colors') or []) if t != 'skin']
                if tc and np.linalg.norm(c - _hex(tc[0])) < 0.25 and _hex(tc[0]).mean() > c.mean():
                    c = _hex(tc[0])
                sl = mask & arm
                lum = out[..., :3].mean(-1, keepdims=True)
                ref = float(np.median(lum[sl])) if sl.any() else 0.5
                out[sl, :3] = np.clip(c * (lum[sl] / max(ref, 1e-3)) ** 0.6, 0, 1)
            out = dilate(out, mask | (a > 0), 6)
            tx.put(ii, out)
            painted.append(f'{name}:{m.mat_name(mat)}')
    tx.flush()
    _flat_cloth(m, tx, painted, log)
    _skirt_length(m, R, outfit, log)
    _skirt_shape(m, R, outfit, log)
    _generated_garments(m, A, R, art, view, os.path.join(os.path.dirname(os.path.abspath(vrm_out)), 'l2d'), log)
    m.save(vrm_out)
    log(f'garment: painted {", ".join(painted)}')


def _skirt_length(m, R, outfit, log=print):
    """a drawn skirt / dress longer or shorter than the base's: stretch the skirt below the hips to the drawn hem"""
    bot = outfit.get('bottom') or {}
    if bot.get('kind') != 'skirt' or outfit.get('split_y') is None:
        return
    ni = m.byname.get('Outfit_Bottoms')
    if ni is None or 'mesh' not in m.J['nodes'][ni]:
        return
    d = m.read_mesh(m.J['nodes'][ni]['mesh'])
    top = R.hip_y3 + 0.02
    hem0 = float(d.P[:, 1].min())
    if hem0 < R.knee_y3:                               # the base garment is trousers / long: leave it
        return
    hem1 = float(R.ys3[1] + (outfit['split_y'] - R.ys2[1]) / (R.ys2[2] - R.ys2[1]) * (R.ys3[2] - R.ys3[1]))
    hem1 = float(np.clip(hem1, R.knee_y3 - 0.12, top - 0.1))
    if abs(hem1 - hem0) < 0.015:
        return
    k = (top - hem1) / max(top - hem0, 1e-3)
    sel = d.P[:, 1] < top
    d.P[sel, 1] = top - (top - d.P[sel, 1]) * k
    m.write_mesh(m.J['nodes'][ni]['mesh'], d)
    log(f'garment: skirt hem {hem0:.3f} -> {hem1:.3f} m (the drawn length)')


def _generated_garments(m, A, R, art, view, out_dir, log=print):
    """garment parts the base doesn't have, generated from the drawing (live2d/overlay.py): an open collar / hood
    with a contrasting lining, the drawn neck accessory as a conforming shell"""
    from . import overlay, assemble
    tpl = next((i for i, mt in enumerate(m.J['materials']) if 'CLOTH' in mt.get('name', '')), 0)

    def make_mat(png, name, cutout=False, shade=(0.78, 0.76, 0.84)):
        mi = assemble._mat(m, tpl, name, png, shade, extra={'_ShadeShift': -0.3})
        J = m.J['materials'][mi]
        J.setdefault('extras', {})['vtpRim'] = 0.25
        if cutout:
            J['alphaMode'] = 'MASK'; J['alphaCutoff'] = 0.5
            mt = m.mtoon(mi)
            mt['floatProperties'].update({'_BlendMode': 1, '_Cutoff': 0.5})
            mt['keywordMap'] = {'_ALPHATEST_ON': True}
            mt['tagMap'] = {'RenderType': 'TransparentCutout'}
            mt['renderQueue'] = 2450
        return mi
    changed = False
    fur = False
    try:
        fur = overlay.fur_puffs(m, A, R, art, view, out_dir, assemble._add_part, make_mat, log)
        changed |= fur
    except Exception as e:
        log(f'fur: skipped ({type(e).__name__}: {e})')
    try:
        if not fur:
            changed |= overlay.hood_collar(m, A, R, art, view, out_dir, assemble._add_part, make_mat, log)
    except Exception as e:
        log(f'collar: skipped ({type(e).__name__}: {e})')
    try:
        changed |= overlay.choker(m, A, R, view, out_dir, assemble._add_part, make_mat, log)
    except Exception as e:
        log(f'choker: skipped ({type(e).__name__}: {e})')
    try:
        changed |= overlay.head_accessory(m, A, out_dir, assemble._add_part, make_mat, log)
    except Exception as e:
        log(f'head accessory: skipped ({type(e).__name__}: {e})')
    try:
        if overlay.drawn_accessory(m, A, R, out_dir, assemble._add_part, make_mat, log):
            ni = m.byname.get('Outfit_Accessory')
            if ni is not None:
                m.J['nodes'][ni].pop('mesh', None); m.J['nodes'][ni].pop('skin', None)
            changed = True
    except Exception as e:
        log(f'accessory: skipped ({type(e).__name__}: {e})')
    if changed:
        from anime_creator import structure
        structure.drop_empty_meshes(m)
        m.refresh()
        m.rebuild_ibms()


def _flat_cloth(m, tx, painted, log=print):
    """drawn anime clothes are flat cel colour: the base's MToon sphere-add matcap (and the toon path's fresnel rim)
    glare gold / white along every edge of a garment, worst on DARK ones (Haru's blazer). Dark painted garments get a low rim (glTF material extras vtpRim, read by the app's
    toon shader) and lose the base's fold normal map (VRoid cloth normal maps add the painted-over folds a second time)"""
    done = []
    for ni, node in enumerate(m.J['nodes']):
        if 'mesh' not in node or not node.get('name', '').startswith('Outfit_'):
            continue
        for p in m.J['meshes'][node['mesh']]['primitives']:
            mi = p.get('material')
            if mi is None:
                continue
            mat = m.J['materials'][mi]
            try:
                img = tx.get(tx.own_image(mi))
                a = img[..., 3] > 0.5 if img.shape[-1] == 4 else np.ones(img.shape[:2], bool)
                lum = float(np.median((img[..., :3][a] @ np.array([0.3, 0.59, 0.11])))) if a.any() else 1.0
            except Exception:
                continue
            ex = mat.setdefault('extras', {})
            ex['vtpRim'] = 0.15 if lum < 0.3 else (0.35 if lum < 0.55 else 0.6)
            # the VRoid cloth matcap (MToon sphere-add) is what glares gold / white along every garment edge in the
            # app (the MToon path ignores vtpRim): drawn clothes have no such sheen
            try:
                m.mtoon(mi).get('textureProperties', {}).pop('_SphereAdd', None)
            except Exception:
                pass
            if lum < 0.3:
                mat.pop('normalTexture', None)
            done.append(f"{mat.get('name', mi)} rim {ex['vtpRim']}")
    if done:
        log('garment: flat cloth ' + ', '.join(done))


def _collar_flare(m, R, log=print):
    """a drawn collar / hood that stands wide around the neck (Ren's big open hood collar): between the shoulder line
    and the chin, the top garment is widened to the drawn garment silhouette at each height (never narrowed; the
    body scale of the chest band converts drawn widths to metres). Arms (T-pose) are excluded by skin weights."""
    ni = m.byname.get('Outfit_Tops')
    if ni is None or 'mesh' not in m.J['nodes'][ni]:
        return
    d = m.read_mesh(m.J['nodes'][ni]['mesh'])
    aw = _arm_weight(m, m.J['nodes'][ni], d)
    chin3, sh3 = R.ys3[0], R.ys3[1]
    s_body = float(R.scale_at(sh3 - 0.05))
    P = d.P
    changed = 0
    info = []
    for y3 in np.linspace(sh3 + 0.005, chin3 - 0.01, 8):
        band = (np.abs(P[:, 1] - y3) < 0.012) & (aw < 0.3)
        if band.sum() < 6:
            continue
        w3 = float(np.percentile(np.abs(P[band, 0]), 97))
        w2 = R._l2d_half_width(float(R.y3_to_y2(y3)))
        if w2 <= 0 or w3 <= 1e-3:
            continue
        ratio = float(np.clip(w2 * s_body / w3, 1.0, 1.8))
        info.append((round(float(y3), 3), round(ratio, 2)))
    if not info or max(r for _, r in info) < 1.05:
        return
    ys = np.array([y for y, _ in info]); rs = np.array([r for _, r in info])
    order = np.argsort(ys); ys, rs = ys[order], rs[order]
    sel = (P[:, 1] > sh3 - 0.02) & (P[:, 1] < chin3 + 0.02) & (aw < 0.3)
    k = np.interp(P[sel, 1], ys, rs)
    # fade in over the 2 cm under the shoulder line (the jacket body keeps its width)
    fade = np.clip((P[sel, 1] - (sh3 - 0.02)) / 0.03, 0, 1)
    k = 1 + (k - 1) * fade
    P2 = P.copy()
    P2[sel, 0] = P[sel, 0] * k
    changed = int((k > 1.01).sum())
    d.P = P2
    Nn = _vertex_normals(P2, d.prims)
    N = d.N.copy()
    N[sel] = Nn[sel]                                  # only the moved part gets new normals
    d.N = N
    m.write_mesh(m.J['nodes'][ni]['mesh'], d)
    log(f'garment: collar widened to the drawn silhouette {info} ({changed} verts)')


def _vertex_normals(P, prims):
    N = np.zeros_like(P)
    for p in prims:
        t = p['indices'].reshape(-1, 3)
        fn = np.cross(P[t[:, 1]] - P[t[:, 0]], P[t[:, 2]] - P[t[:, 0]])
        for k in range(3):
            np.add.at(N, t[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def _skirt_shape(m, R, outfit, log=print):
    """the drawn skirt silhouette: a straight / pencil skirt (hem about as wide as the hips) turns the base's
    pleated or flared skirt into a fitted tube: every ring below the hips is re-seated on a smooth ellipse around the
    legs (a hint of the old pleat depth kept so layered folds don't z-fight), widening / narrowing to the drawn hem"""
    bot = outfit.get('bottom') or {}
    taper = bot.get('taper')
    if bot.get('kind') != 'skirt' or taper is None or taper > 1.12:
        return
    ni = m.byname.get('Outfit_Bottoms'); bi = m.byname.get('Body')
    if ni is None or bi is None or 'mesh' not in m.J['nodes'][ni]:
        return
    d = m.read_mesh(m.J['nodes'][ni]['mesh'])
    B = m.read_mesh(m.J['nodes'][bi]['mesh']).P
    P = d.P
    hem = float(P[:, 1].min())
    top = float(R.hip_y3 + 0.02)
    if hem > top - 0.08:
        return
    legs = B[(B[:, 1] < top) & (B[:, 1] > hem - 0.02) & (np.abs(B[:, 0]) < 0.3)]
    if len(legs) < 50:
        return

    def body_at(y, h=0.012):
        q = legs[np.abs(legs[:, 1] - y) < h]
        if len(q) < 8:
            return None
        return np.abs(q[:, 0]).max(), float(q[:, 2].min()), float(q[:, 2].max())
    # hips: the widest body ring in the upper part of the skirt
    ys = np.linspace(top - 0.02, top - 0.45 * (top - hem), 10)
    rings = [(y, body_at(y)) for y in ys]
    rings = [(y, r) for y, r in rings if r is not None]
    if not rings:
        return
    y_hip, (ax_hip, z0h, z1h) = max(rings, key=lambda t: t[1][0])
    a_hip = ax_hip + 0.014
    b_hip = (z1h - z0h) / 2 + 0.014
    cz_hip = (z0h + z1h) / 2
    t_ = float(np.clip(taper, 0.85, 1.12))
    a_hem, b_hem = a_hip * t_, b_hip * (0.5 + 0.5 * t_)
    sel = P[:, 1] < top
    # the base garment's own envelope per height (to keep a trace of the fold depth)
    env = {}
    for y in np.unique(np.round(P[sel, 1], 3)):
        q = P[sel & (np.abs(P[:, 1] - y) < 0.006)]
        env[float(y)] = (np.abs(q[:, 0]).max(), float(q[:, 2].min()), float(q[:, 2].max()))
    out = P.copy()
    tube_n = {}
    for i in np.nonzero(sel)[0]:
        x, y, z = P[i]
        e = env[float(np.round(y, 3))]
        cz_o = (e[1] + e[2]) / 2
        th = np.arctan2((z - cz_o) / max((e[2] - e[1]) / 2, 1e-4), x / max(e[0], 1e-4))
        r_rel = np.hypot(x / max(e[0], 1e-4), (z - cz_o) / max((e[2] - e[1]) / 2, 1e-4))  # 1 = on the envelope
        k = float(np.clip((y_hip - y) / max(y_hip - hem, 1e-3), 0, 1))
        a = a_hip + (a_hem - a_hip) * k; b = b_hip + (b_hem - b_hip) * k
        br = body_at(y)
        if br is not None:                                   # never inside the legs
            a = max(a, br[0] + 0.01); b = max(b, (br[2] - br[1]) / 2 + 0.01)
        cz = cz_hip if br is None else (br[1] + br[2]) / 2
        rr = 1 + 0.12 * (min(r_rel, 1.2) - 1)
        nx, nz = a * np.cos(th) * rr, cz + b * np.sin(th) * rr
        # the ellipse can still cut the body on the diagonals (buttocks, the two legs): per direction, stay outside
        # every body point of this height band within +-12 deg
        q = legs[np.abs(legs[:, 1] - y) < 0.015]
        if len(q):
            ang = np.arctan2(nz - cz, nx)
            qa = np.arctan2(q[:, 2] - cz, q[:, 0])
            near = np.abs(np.angle(np.exp(1j * (qa - ang)))) < np.radians(12)
            if near.any():
                need = float(np.hypot(q[near, 0], q[near, 2] - cz).max()) + 0.012
                have = float(np.hypot(nx, nz - cz))
                if have < need:
                    nx, nz = nx * need / have, cz + (nz - cz) * need / have
        w = float(np.clip((top - y) / max(top - y_hip, 1e-3), 0, 1))    # blend in from the waistband to the hips
        w = w * w * (3 - 2 * w)
        out[i, 0] = x + (nx - x) * w
        out[i, 2] = z + (nz - z) * w
        tube_n[i] = (w, np.array([nx / a ** 2, 0.0, (nz - cz) / b ** 2]))
    d.P = out
    N = _vertex_normals(out, d.prims)
    # smooth tube shading: the leftover pleat folds would read as glossy streaks with their own face normals
    for i, (w, n) in tube_n.items():
        n = n / max(np.linalg.norm(n), 1e-9)
        if np.dot(n, N[i]) < 0 and w < 0.5:
            continue
        N[i] = N[i] * (1 - w) + n * w
    d.N = N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    # a fitted skirt doesn't swing: the base's skirt spring bones sit on the old flare and would swing the tube into
    # the legs, so their weights move to the hips
    sk = m.J['nodes'][ni].get('skin')
    if sk is not None:
        jn = [m.J['nodes'][j].get('name', '') for j in m.J['skins'][sk]['joints']]
        hips = next((i for i, n in enumerate(jn) if n == 'J_Bip_C_Hips'), None)
        skirt = [i for i, n in enumerate(jn) if 'Skirt' in n]
        if hips is not None and skirt:
            moved = np.isin(d.J, skirt) & (d.W > 0)
            d.J = np.where(moved, hips, d.J)
            # merge duplicate joint slots per vertex (hips may now appear twice)
            for v in np.nonzero(moved.any(1))[0]:
                acc = {}
                for j, w in zip(d.J[v], d.W[v]):
                    acc[int(j)] = acc.get(int(j), 0.0) + float(w)
                items = sorted(acc.items(), key=lambda t: -t[1])[:4]
                used = [j for j, _ in items]
                pad = [i for i in range(len(jn)) if i not in used][:4 - len(items)]
                d.J[v] = used + pad
                d.W[v] = [w for _, w in items] + [0.0] * len(pad)
            d.W = d.W / np.maximum(d.W.sum(1, keepdims=True), 1e-9)
    m.write_mesh(m.J['nodes'][ni]['mesh'], d)
    log(f'garment: pencil / straight skirt (drawn hem/hip {taper:.2f}): hips {2 * a_hip:.3f} x {2 * b_hip:.3f} m -> '
        f'hem {2 * a_hem:.3f} x {2 * b_hem:.3f} m')


def _arm_weight(m, node, d):
    joints = m.skin_joints(node['skin'])
    is_arm = np.array([any(k in m.J['nodes'][j].get('name', '') for k in ('UpperArm', 'LowerArm', 'Hand', 'Thumb', 'Index',
                                                                             'Middle', 'Ring', 'Little')) for j in joints])
    W = d.W / np.maximum(d.W.sum(1, keepdims=True), 1e-9)
    return (W * is_arm[d.J]).sum(1)


def _accessory(m, tx, node, A, outfit):
    """the base's neck accessory (bow / tie): take the colour of the drawn neck accessory (scarf, ribbon), or hide it
    when the art has none"""
    acc = (A.colors.get('accessory') or [None])[0]
    if A.pose is None:
        node.pop('mesh', None); node.pop('skin', None)
        return
    P = A.pose.positions
    fb = A.lm['face_bbox']
    head_h = fb[3] - A.lm.get('crown', fb[1])
    neck = [a for a, c in enumerate(A.cls) if c == 'accessory' and fb[3] - 0.1 * head_h < P[a][:, 1].mean() < fb[3] + 0.8 * head_h]
    if not neck or not acc:
        node.pop('mesh', None); node.pop('skin', None)
        return
    d = m.read_mesh(node['mesh'])
    base = _hex(acc)
    for p in d.prims:
        if p['material'] is None:
            continue
        ii = tx.own_image(p['material'])
        tx.put(ii, colors.ramp_recolor(tx.get(ii), base.astype(np.float32), None))


def _hex(h):
    h = h.lstrip('#')
    return np.array([int(h[i:i + 2], 16) / 255 for i in (0, 2, 4)])


def _sleeves_and_legwear(out, mask, P3, R, outfit, skin_rgb, armw):
    """long sleeves drawn in the art -> flat sleeve colour on the arm skin down to the wrist (+ a darker cuff);
    stockings / tights -> the legwear colour on the leg skin from the hem down to the ankle"""
    sl = outfit.get('sleeves')
    cols = outfit.get('sleeve_colors') or []
    if sl == 'long' and cols:
        c = _hex(cols[0])
        ax = np.abs(P3[..., 0])
        arm = mask & armw & (ax < R.hand_x3 - 0.015)
        cuff = arm & (ax > R.hand_x3 - 0.045)
        out[arm, :3] = c
        out[cuff, :3] = c * 0.72
    lw = outfit.get('legwear') or {}
    if lw.get('kind') in ('stockings', 'same') and lw.get('colors'):
        c = _hex(lw['colors'][0])
        top = R.hip_y3 - 0.12 if lw.get('kind') == 'stockings' else R.hip_y3
        legs = mask & (P3[..., 1] < top) & (P3[..., 1] > R.ankle_y3 - 0.05) & ~armw
        # sheer stockings: a little of the skin shows through on the lit side
        out[legs, :3] = c * 0.92 + skin_rgb * 0.08
    return out
