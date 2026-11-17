"""
glTF-ready materials for the human: every MPFB material is rebuilt as one Principled BSDF fed by processed image
files (resized, JPEG where there is no alpha) so the GLB stays small and three.js reads it as MeshStandardMaterial.

  Skin       albedo (retouch blur, tint, lip/cheek makeup painted in UV space), roughness from a T-zone mask
  Hair/Brows recoloured strand textures (luminance-preserving), alpha-clip (glTF MASK) cards
  Lashes     alpha-clip, near black
  Eyes       MakeHuman eye texture, wet roughness
  Teeth      MakeHuman teeth texture, slightly dimmed (they sit in the mouth shadow)
  Clothes    diffuse x baked AO, tangent normal map, cloth roughness
"""
import os

import bpy
import numpy as np

from .params import hex_rgb


def parse_mhmat(path):
    d = {}
    if not path or not os.path.isfile(path):
        return d
    base = os.path.dirname(path)
    with open(path, encoding='utf-8', errors='ignore') as f:
        for line in f:
            parts = line.strip().split(None, 1)
            if len(parts) == 2 and parts[0].endswith('Texture'):
                t = parts[1].strip()
                full = t if os.path.isabs(t) else os.path.join(base, os.path.basename(t))
                if os.path.isfile(full):
                    d[parts[0]] = full
    return d


# ------------------------------------------------------------------ image helpers (sRGB-encoded floats)
def load_px(path, size=None):
    img = bpy.data.images.load(path, check_existing=False)
    if size and (img.size[0] != size or img.size[1] != size):
        img.scale(size, size)
    w, h = img.size
    a = np.array(img.pixels[:], dtype=np.float32).reshape(h, w, 4)
    bpy.data.images.remove(img)
    return a


def save_px(a, path, fmt='JPEG', quality=90):
    h, w = a.shape[:2]
    img = bpy.data.images.new(os.path.basename(path), w, h, alpha=(fmt == 'PNG'))
    img.pixels.foreach_set(np.clip(a, 0, 1).astype(np.float32).ravel())
    img.filepath_raw = path
    img.file_format = fmt
    sc = bpy.context.scene
    if fmt == 'JPEG':
        sc.render.image_settings.quality = quality
    img.save(quality=quality) if fmt == 'JPEG' else img.save()
    bpy.data.images.remove(img)
    return path


def to_lin(c):
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def to_srgb(c):
    c = np.clip(c, 0, None)
    return np.where(c <= 0.0031308, c * 12.92, 1.055 * np.power(c, 1 / 2.4) - 0.055)


def box_blur(a, r):
    """Separable box blur (r pixels) with edge clamp, applied twice ~ gaussian."""
    if r < 1:
        return a
    for _ in range(2):
        for ax in (0, 1):
            pad = [(0, 0)] * a.ndim
            pad[ax] = (r + 1, r)
            p = np.pad(a, pad, mode='edge')
            c = np.cumsum(p, axis=ax)
            hi = np.take(c, np.arange(2 * r + 1, c.shape[ax]), axis=ax)
            lo = np.take(c, np.arange(0, c.shape[ax] - 2 * r - 1), axis=ax)
            a = (hi - lo) / (2 * r + 1)
    return a


def recolor(a, rgb, keep=0.15):
    """Luminance-preserving recolour of a strand texture: the mean lit strand becomes `rgb`."""
    lin = to_lin(a[..., :3])
    lum = lin @ np.array([0.2126, 0.7152, 0.0722])
    m = a[..., 3] > 0.5
    ref = float(np.median(lum[m])) if m.any() else float(lum.mean())
    t = np.clip(lum / max(ref, 1e-4), 0, 4)[..., None]
    # strand contrast: normalise the texture's own spread so flat MakeHuman textures still read as strands
    sd = float(np.std(np.log(np.clip(lum[m], 1e-4, None)))) if m.any() else 0.5
    gamma = float(np.clip(0.55 / max(sd, 1e-3), 1.0, 2.6))
    target = to_lin(np.array(rgb))
    # shadows go deeper + slightly warmer, highlights toward a desaturated sheen
    out = target * t ** gamma
    hi = np.clip(t - 1.0, 0, 3) * 0.25
    out = out + hi * (np.array([1.0, 0.97, 0.92]) * target.mean() * 1.2)
    out = out * (1 - keep) + lin * keep * (target.mean() / max(ref, 1e-4))
    # re-anchor: the median strand lands exactly on the requested colour (gamma would otherwise brighten it)
    ol = out @ np.array([0.2126, 0.7152, 0.0722])
    tl = float(target @ np.array([0.2126, 0.7152, 0.0722]))
    med = float(np.median(ol[m])) if m.any() else float(ol.mean())
    out = out * (tl / max(med, 1e-5))
    res = a.copy()
    res[..., :3] = to_srgb(out)
    return res


def raster_mask(ob, vert_weights, size, grow_px=6):
    """Paint per-vertex weights into UV space (barycentric fill of every triangle) -> (size,size) mask."""
    me = ob.data
    me.calc_loop_triangles()
    uv = me.uv_layers.active.data
    M = np.zeros((size, size), dtype=np.float32)
    for tri in me.loop_triangles:
        w = [vert_weights[me.loops[li].vertex_index] for li in tri.loops]
        if max(w) <= 1e-3:
            continue
        P = np.array([uv[li].uv[:] for li in tri.loops]) * (size - 1)
        x0, y0 = np.floor(P.min(0)).astype(int)
        x1, y1 = np.ceil(P.max(0)).astype(int)
        x0, y0 = max(x0, 0), max(y0, 0)
        x1, y1 = min(x1, size - 1), min(y1, size - 1)
        if x1 < x0 or y1 < y0:
            continue
        xs, ys = np.meshgrid(np.arange(x0, x1 + 1), np.arange(y0, y1 + 1))
        (ax, ay), (bx, by), (cx, cy) = P
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-9:
            continue
        l1 = ((by - cy) * (xs - cx) + (cx - bx) * (ys - cy)) / den
        l2 = ((cy - ay) * (xs - cx) + (ax - cx) * (ys - cy)) / den
        l3 = 1 - l1 - l2
        inside = (l1 >= -0.02) & (l2 >= -0.02) & (l3 >= -0.02)
        val = l1 * w[0] + l2 * w[1] + l3 * w[2]
        sub = M[y0:y1 + 1, x0:x1 + 1]
        np.maximum(sub, np.where(inside, val, 0), out=sub)
    if grow_px:
        M = np.clip(box_blur(M, grow_px) * 1.6, 0, 1)
    return M


def cavity_weights(bm):
    """Per-vertex 0..1 'inside the mouth' weight of the basemesh (inward-facing surface behind the lips)."""
    from .face import coords, group_weights, smoothstep
    B = coords(bm)
    lips = group_weights(bm, 'lips')
    body = group_weights(bm, 'body')
    if lips.sum() <= 0:
        return np.zeros(len(B))
    P = B[lips > 0.3]
    front = np.array([0.0, P[:, 1].min(), float(np.median(P[:, 2]))])
    N = np.array([v.normal[:] for v in bm.data.vertices])
    axis = front + np.array([0, 0.03, 0])
    rel = B - axis
    inward = (N * rel).sum(1) / (np.linalg.norm(rel, axis=1) + 1e-6)
    depth = B[:, 1] - front[1]
    box = (np.abs(B[:, 0]) < 0.03) & (np.abs(B[:, 2] - front[2]) < 0.03) & (depth > 0.004) & (depth < 0.08)
    w = box * smoothstep(0.05, -0.3, inward) * smoothstep(0.004, 0.02, depth) * (body > 0) * (lips < 0.5)
    return w


def paint_face(bm, F, p, rgb, size):
    """Painted skin variation a raw MakeHuman texture lacks: warm cheeks / nose tip / ears / chin, a soft darker
    lid crease + lash line, faint cool under-eye, all in linear light, driven by 3D landmarks (FaceRig)."""
    from .face import group_weights
    body = group_weights(bm, 'body') > 0
    k = F.k
    fem = 1.0 - p['body']['gender']
    mk = p['skin'].get('makeup') or {}
    lin = to_lin(rgb)

    def layer(w, color, amount, blur=6):
        nonlocal lin
        if amount <= 0:
            return
        m = raster_mask(bm, w * body, size, 0)
        m = box_blur(m, blur)[..., None] * amount
        c = to_lin(np.array(hex_rgb(color) if isinstance(color, str) else color))
        # multiply-style tint normalised to keep brightness roughly constant
        tint = c / max(float(c.max()), 1e-3)     # pigment-like multiply: reddens without brightening
        lin = lin * (1 - m) + lin * tint * m

    blush = 0.16 + 0.12 * fem + float(mk.get('blush', 0)) * 0.4
    for eye, s in ((F.eyeL, 1), (F.eyeR, -1)):
        cheek = eye + np.array([s * 0.008, -0.012, -0.034]) * k
        layer(F.radial(cheek, 0.034 * k, 1.2), mk.get('blushColor', '#d9706a'), blush, 10)
        # upper-lid crease / socket shading and lash line
        lid = eye + np.array([0, -0.004, 0.009]) * k
        layer(F.radial(lid, 0.016 * k, 1.5), '#8a5e58', 0.18 + 0.12 * fem + float(mk.get('liner', 0)) * 0.3, 4)
        under = eye + np.array([0, -0.006, -0.013]) * k
        layer(F.radial(under, 0.013 * k, 1.5), '#8f8aa0', 0.08, 5)
    nose_tip = F.nose_tip()
    layer(F.radial(nose_tip, 0.02 * k, 1.3), '#d97a6e', 0.18, 6)
    layer(group_weights(bm, 'ears'), '#d77a6c', 0.22, 6)
    layer(F.radial(F.mouth + np.array([0, -0.004, -0.035]) * k, 0.02 * k, 1.3), '#d98a7e', 0.08, 6)
    # lips: a touch more colour + definition even without lipstick
    layer(group_weights(bm, 'lips') ** 1.5, '#c0606a', 0.25 + 0.1 * fem, 1)
    return to_srgb(lin)


def depth_mask(ob, size):
    """0 at the front of the mouth .. 1 at the back (teeth / tongue proxies), painted into UV space."""
    from .face import coords, smoothstep
    y = coords(ob)[:, 1]
    w = smoothstep(y.min() + 0.004, y.min() + 0.035, y)
    return raster_mask(ob, w + 1e-3, size, 0)


def bake_ao(H, work, log=print):
    # (the teeth proxy is a closed double shell that occludes itself completely -> depth_mask instead of AO)
    for ob, name, k in ((H.basemesh, 'skin.jpg', 0.6), (H.parts.get('tongue'), 'tongue.jpg', 0.8)):
        if ob is not None:
            bake_ao_obj(ob, os.path.join(work, name), k, log=log)


def bake_ao_obj(ob, skin_path, strength=0.6, size=1024, samples=24, log=print):
    """Cycles ambient-occlusion bake of the body (hair / clothes / eyes occlude) multiplied into the skin albedo:
    eye sockets, nostrils, lip corners, ears and the hairline get the contact shadow the realtime stage lacks."""
    bm = ob
    mat = bm.data.materials[0] if bm.data.materials else None
    if mat is None or not os.path.isfile(skin_path):
        return
    sc = bpy.context.scene
    prev = sc.render.engine
    sc.render.engine = 'CYCLES'
    sc.cycles.samples = samples
    sc.cycles.device = 'CPU'
    img = bpy.data.images.new('vtp_ao', size, size, alpha=False)
    nt = mat.node_tree
    node = nt.nodes.new('ShaderNodeTexImage')
    node.image = img
    nt.nodes.active = node
    from .convert import select_only
    select_only([bm], bm)
    sc.render.bake.margin = 8
    if sc.world is None:
        sc.world = bpy.data.worlds.new('W')
    sc.world.light_settings.distance = 0.05   # contact occlusion only (the chest must not darken the chin)
    try:
        bpy.ops.object.bake(type='AO', use_selected_to_active=False)
    except Exception as e:  # noqa: BLE001
        log('AO bake failed:', e)
        nt.nodes.remove(node)
        sc.render.engine = prev
        return
    ao = np.array(img.pixels[:], dtype=np.float32).reshape(size, size, 4)[..., :1]
    nt.nodes.remove(node)
    bpy.data.images.remove(img)
    sc.render.engine = prev
    a = load_px(skin_path)
    if a.shape[0] != size:
        rep = a.shape[0] // size
        ao = np.repeat(np.repeat(ao, rep, 0), rep, 1)
        ao = box_blur(ao, 2)
    k = 1 - strength * (1 - np.clip(ao, 0, 1))
    a[..., :3] = to_srgb(to_lin(a[..., :3]) * k)
    save_px(a, skin_path, 'JPEG', 90)
    for im in bpy.data.images:
        if im.filepath and os.path.normcase(bpy.path.abspath(im.filepath)) == os.path.normcase(skin_path):
            im.reload()
    log('AO baked into', os.path.basename(skin_path))


# ------------------------------------------------------------------ material builders
def principled(name, base_img=None, alpha_clip=None, normal_img=None, rough=0.5, rough_img=None, spec=0.5,
               color=None, sss=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new('ShaderNodeOutputMaterial')
    bsdf = nt.nodes.new('ShaderNodeBsdfPrincipled')
    nt.links.new(bsdf.outputs[0], out.inputs[0])
    bsdf.inputs['Roughness'].default_value = rough
    if 'Specular IOR Level' in bsdf.inputs:
        bsdf.inputs['Specular IOR Level'].default_value = spec
    if color is not None:
        bsdf.inputs['Base Color'].default_value = (*color, 1)
    if base_img:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(base_img, check_existing=True)
        nt.links.new(t.outputs['Color'], bsdf.inputs['Base Color'])
        if alpha_clip == 'blend':
            nt.links.new(t.outputs['Alpha'], bsdf.inputs['Alpha'])
            try:
                m.surface_render_method = 'BLENDED'
            except Exception:
                m.blend_method = 'BLEND'
            m.use_backface_culling = False
        elif alpha_clip is not None:
            gt = nt.nodes.new('ShaderNodeMath')
            gt.operation = 'GREATER_THAN'
            gt.inputs[1].default_value = alpha_clip
            nt.links.new(t.outputs['Alpha'], gt.inputs[0])
            nt.links.new(gt.outputs[0], bsdf.inputs['Alpha'])
            try:
                m.surface_render_method = 'DITHERED'
            except Exception:
                pass
            m.use_backface_culling = False
    if rough_img:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(rough_img, check_existing=True)
        t.image.colorspace_settings.name = 'Non-Color'
        sep = nt.nodes.new('ShaderNodeSeparateColor')
        nt.links.new(t.outputs['Color'], sep.inputs[0])
        nt.links.new(sep.outputs[1], bsdf.inputs['Roughness'])   # glTF packs roughness in G
    if normal_img:
        t = nt.nodes.new('ShaderNodeTexImage')
        t.image = bpy.data.images.load(normal_img, check_existing=True)
        t.image.colorspace_settings.name = 'Non-Color'
        nm = nt.nodes.new('ShaderNodeNormalMap')
        nm.inputs['Strength'].default_value = 1.0
        nt.links.new(t.outputs['Color'], nm.inputs['Color'])
        nt.links.new(nm.outputs[0], bsdf.inputs['Normal'])
    return m


def assign(ob, mat):
    ob.data.materials.clear()
    ob.data.materials.append(mat)


def build(H, p, work, log=print):
    """Rebuild every material. `work` = directory for the processed texture files."""
    os.makedirs(work, exist_ok=True)
    from .face import group_weights
    s = p['stylization']
    hair_rgb = hex_rgb(p['hair']['color']) if p['hair'].get('color') else None
    # ---------------- skin
    skin_tone = np.array([0.78, 0.6, 0.5])
    sk = parse_mhmat(H.skin_path)
    bm = H.basemesh
    if 'diffuseTexture' in sk:
        a = load_px(sk['diffuseTexture'], 2048)
        rgb = a[..., :3]
        sm = p['skin']['smooth']
        if sm > 0:
            # frequency-separation retouch: blur the mid frequencies (blotches) more than the fine grain
            low = box_blur(rgb, 10)
            mid = box_blur(rgb, 2)
            rgb = rgb * (1 - sm) + (mid * (1 - 0.5 * sm) + low * 0.5 * sm) * sm
        if p['skin'].get('tint'):
            t = np.array(hex_rgb(p['skin']['tint']))
            rgb = to_srgb(to_lin(rgb) * to_lin(t) / max(to_lin(t).mean(), 1e-3) * 0.5 + to_lin(rgb) * 0.5)
        mk = p['skin'].get('makeup') or {}
        size = rgb.shape[0]
        if mk.get('lips', 0) > 0:
            lips = box_blur(raster_mask(bm, group_weights(bm, 'lips') ** 2, size, 0), 1)
            col = np.array(hex_rgb(mk.get('lipColor', '#b04a55')))
            k = (lips * mk['lips'])[..., None]
            lin = to_lin(rgb)
            cl = to_lin(col)
            lum = (lin @ np.array([0.2126, 0.7152, 0.0722]))[..., None]
            tinted = cl / max(float(cl @ np.array([0.2126, 0.7152, 0.0722])), 1e-3) * lum * 0.9   # hue shift, keep brightness
            rgb = to_srgb(lin * (1 - k) + tinted * k)
        # mouth cavity: the inner-mouth skin is textured like lips (bright red) — darken with depth so an open
        # mouth reads as a real interior instead of a red box
        cav = cavity_weights(bm)
        if cav.any():
            cm = raster_mask(bm, cav, size, 2)[..., None]
            rgb = rgb * (1 - cm) + rgb * np.array([0.42, 0.24, 0.25]) * cm
        # scalp under the hair takes the hair colour (soft hairline: no bare-skin gaps between hair cards)
        if H.parts.get('hair') is not None and hair_rgb is not None:
            sc = raster_mask(bm, group_weights(bm, 'scalp'), size, 10)[..., None]
            hc = to_lin(np.array(hair_rgb)) * 0.55
            lin = to_lin(rgb)
            rgb = to_srgb(lin * (1 - 0.85 * sc) + hc * (0.6 + 0.4 * lin / max(lin.mean(), 1e-3)) * 0.85 * sc)
        F = getattr(H, 'face', None)
        if F is not None:
            rgb = paint_face(bm, F, p, rgb, size)
        a[..., :3] = rgb
        skin_img = save_px(a, os.path.join(work, 'skin.jpg'), 'JPEG', 90)
        # micro detail normal map from the albedo's high frequencies (pores / fine creases catch the key light)
        lum = to_lin(rgb) @ np.array([0.2126, 0.7152, 0.0722])
        hp = lum - box_blur(lum, 2)
        hp = np.clip(hp / (np.abs(hp).std() * 3 + 1e-6), -1, 1) * (0.55 * (1 - p['skin']['smooth'] * 0.7))
        gy, gx = np.gradient(hp)
        nmap = np.stack([0.5 - gx * 0.22, 0.5 - gy * 0.22, np.ones_like(gx), np.ones_like(gx)], -1)
        normal_img = save_px(nmap.astype(np.float32), os.path.join(work, 'skin_n.jpg'), 'JPEG', 92)
        # roughness: glossy lips, slightly shiny T-zone (nose / forehead), matte cheeks and body
        base_r = p['skin']['roughness'] + 0.08 * s
        rough = np.full((size // 2, size // 2), base_r, np.float32)
        if F is not None:
            rough = rough - 0.12 * raster_mask(bm, group_weights(bm, 'lips'), size // 2, 1) \
                - 0.08 * raster_mask(bm, F.tzone(), size // 2, 4)
        rgba = np.stack([rough, rough, rough, np.ones_like(rough)], -1)
        rough_img = save_px(rgba, os.path.join(work, 'skin_rough.jpg'), 'JPEG', 92)
        # representative skin tone: texel median under the body's UVs (clothes cut-outs are filled with it)
        uv = np.array([d.uv[:] for d in bm.data.uv_layers.active.data])
        body_w = group_weights(bm, 'body')
        vi = np.array([l.vertex_index for l in bm.data.loops])
        uv = uv[body_w[vi] > 0]
        px = np.clip((uv * (size - 1)).astype(int), 0, size - 1)
        skin_tone = np.median(a[px[:, 1], px[:, 0], :3], axis=0) * 0.92
        m = principled('Skin', skin_img, rough=base_r, rough_img=rough_img, normal_img=normal_img, spec=0.5)
        m['vtpSkin'] = 1.0
        assign(bm, m)
    # ---------------- hair
    hair = H.parts.get('hair')
    if hair is not None:
        mt = parse_mhmat(H.mhclo_mat(hair))
        if 'diffuseTexture' in mt:
            a = load_px(mt['diffuseTexture'], 2048)     # full res: strand detail is what sells the hair
            if hair_rgb:
                a = recolor(a, hair_rgb)
            img = save_px(a, os.path.join(work, 'hair.png'), 'PNG')
            nimg = None
            if 'normalmapTexture' in mt:
                nimg = save_px(load_px(mt['normalmapTexture'], 1024), os.path.join(work, 'hair_n.jpg'), 'JPEG', 92)
            assign(hair, principled('Hair', img, alpha_clip=0.35, normal_img=nimg, rough=0.72, spec=0.25))
    # ---------------- eyebrows / lashes
    for role, name, clip in (('eyebrows', 'Brows', 0.3), ('eyelashes', 'Lashes', 0.3)):
        ob = H.parts.get(role)
        if ob is None:
            continue
        mt = parse_mhmat(H.mhclo_mat(ob))
        if 'diffuseTexture' not in mt:
            continue
        a = load_px(mt['diffuseTexture'], 512)
        if role == 'eyebrows':
            bc = p.get('eyebrowColor', 'hair')
            rgb = hair_rgb if bc == 'hair' else (hex_rgb(bc) if isinstance(bc, str) and bc.startswith('#') else None)
            if rgb:
                a = recolor(a, tuple(c * 0.85 for c in rgb), keep=0.1)
            # soft brows: hairs fade out instead of a hard cut (glTF BLEND, drawn after the skin)
            a[..., 3] = np.clip(a[..., 3] * 0.9, 0, 1)
        else:
            a[..., :3] = a[..., :3] * 0.3
        img = save_px(a, os.path.join(work, role + '.png'), 'PNG')
        mat = principled(name, img, alpha_clip='blend', rough=0.6, spec=0.3)
        mat['vtpRim'] = 0.0
        assign(ob, mat)
    # ---------------- eyes
    eyes = H.parts.get('eyes')
    if eyes is not None:
        tex = None
        for mm in eyes.data.materials:
            for n in mm.node_tree.nodes:
                if n.type == 'TEX_IMAGE' and n.image and 'alpha' not in n.name.lower():
                    tex = bpy.path.abspath(n.image.filepath)
                    break
        if tex and os.path.isfile(tex):
            a = load_px(tex, 1024)
            rgb = a[..., :3]
            mx, mn = rgb.max(-1), rgb.min(-1)
            sat = ((mx - mn) / np.maximum(mx, 1e-3))[..., None]
            # sclera: cleaner, brighter white (MakeHuman's is grey-pink); iris: a little more saturation + depth
            white = np.clip(mx[..., None] * 1.18, 0, 0.93) * np.array([1.0, 0.985, 0.97])
            is_sclera = ((sat < 0.22) & (mx[..., None] > 0.45)).astype(np.float32)
            is_sclera = box_blur(is_sclera, 2)
            lum = rgb.mean(-1, keepdims=True)
            iris = np.clip(lum + (rgb - lum) * 1.25, 0, 1)
            a[..., :3] = white * is_sclera + iris * (1 - is_sclera)
            img = save_px(a, os.path.join(work, 'eyes.jpg'), 'JPEG', 92)
            mat = principled('Eyes', img, rough=0.07, spec=0.9)
            mat['vtpRim'] = 0.0
            assign(eyes, mat)
            # the MakeHuman eye is an eyeball + a cornea shell UV'd onto the texture's blue disc; a transparent
            # shell only causes sorting trouble in realtime, so it goes and the eyeball itself is glossy
            from .convert import delete_faces
            uv = eyes.data.uv_layers.active.data
            cornea = [poly.index for poly in eyes.data.polygons
                      if sum(uv[li].uv[0] for li in poly.loop_indices) / poly.loop_total > 0.85
                      and sum(uv[li].uv[1] for li in poly.loop_indices) / poly.loop_total < 0.14]
            delete_faces(eyes, cornea)
    # ---------------- teeth / tongue
    for role, name, rough, dim in (('teeth', 'Teeth', 0.3, 0.86), ('tongue', 'Tongue', 0.45, 0.85)):
        ob = H.parts.get(role)
        if ob is None:
            continue
        mt = parse_mhmat(H.mhclo_mat(ob))
        if 'diffuseTexture' in mt:
            a = load_px(mt['diffuseTexture'], 1024)
            if role == 'teeth':
                # MakeHuman teeth are grey: clean ivory enamel (keep the texture's shading), pinker gums
                rgb = a[..., :3]
                mx, mn = rgb.max(-1), rgb.min(-1)
                sat = (mx - mn) / np.maximum(mx, 1e-3)
                enamel = (sat < 0.25)[..., None] * (mx > 0.08)[..., None]
                shade = np.clip(mx / 0.85, 0, 1)[..., None] ** 0.7
                ivory = np.array([0.93, 0.9, 0.84]) * (0.55 + 0.45 * shade)
                gum = rgb * np.array([0.55, 0.32, 0.34])
                a[..., :3] = np.where(enamel > 0, ivory, gum)
            a[..., :3] *= dim
            if role == 'teeth':   # back teeth sit in the mouth's shadow
                a[..., :3] *= (1 - 0.7 * depth_mask(ob, a.shape[0]))[..., None]
            img = save_px(a, os.path.join(work, role + '.jpg'), 'JPEG', 90)
            mat = principled(name, img, rough=rough, spec=0.4)
            mat['vtpRim'] = 0.0
            assign(ob, mat)
    # ---------------- clothes
    done = set()
    for ob in H.clothes + [o for objs in H.costumes.values() for o in objs]:
        mt = parse_mhmat(H.mhclo_mat(ob))
        key = os.path.basename(os.path.dirname(ob.get('vtp_mhclo', '') or 'x'))
        if 'diffuseTexture' not in mt:
            continue
        diff = os.path.join(work, key + '_d.jpg')
        nrm = os.path.join(work, key + '_n.jpg') if 'normalmapTexture' in mt else None
        if key not in done:
            a = load_px(mt['diffuseTexture'], 1024)
            if 'aomapTexture' in mt:
                ao = load_px(mt['aomapTexture'], 1024)[..., :1]
                a[..., :3] *= 0.35 + 0.65 * ao
            # cut-outs (ripped jeans, lace) would show through to deleted / hidden body: make the cloth opaque and
            # paint the holes in the character's own skin tone, so a rip still reads as skin
            holes = (a[..., 3] < 0.5)[..., None]
            if holes.any():
                a[..., :3] = np.where(holes, skin_tone, a[..., :3])
                a[..., 3] = 1.0
            save_px(a, diff, 'JPEG', 90)
            if nrm:
                save_px(load_px(mt['normalmapTexture'], 1024), nrm, 'JPEG', 92)
            done.add(key)
        assign(ob, principled('Cloth_' + key, diff, normal_img=nrm, rough=0.82, spec=0.3))
    log('materials rebuilt')
