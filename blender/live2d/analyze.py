"""Understand a Live2D model: what every art mesh is (semantic class), where the face features are, the colours.

    A = analyze(model)            # model = model3.L2DModel
    A.cls[a]                       # 'face' 'eye_white' 'iris' 'eye_hl' 'lash' 'brow' 'mouth' 'nose' 'cheek' 'ear'
                                   # 'hair_front' 'hair_side' 'hair_back' 'ahoge' 'neck' 'skin' 'arm' 'hand' 'top'
                                   # 'bottom' 'legwear' 'shoes' 'hat' 'accessory' 'prop' 'effect' 'hidden' 'other'
    A.side[a]                      # 'L' (character's left = viewer's right) | 'R' | ''
    A.lm                           # landmarks in model units (y DOWN): eyes, mouth, chin, crown, face width ...
    A.colors                       # sRGB hex colours: skin, hair (base / shade / light / tip), iris (top/mid/bottom) ...

Signals, strongest first: the standard Cubism parameters that move a mesh (ParamEyeBallX = iris, ParamBrow* = brow,
ParamHairFront = fringe ...), part / mesh / deformer names in English + Japanese (cdi3 display names), then geometry
(where it sits relative to the face) and colour (skin-like or not). Works on the official samples' three naming
styles (Haru: D_PSD ids + Part01HairFront parts, Mao/Ren: ArtMeshNN + Japanese part names, Rice: skinning parts).
"""
import colorsys
import re

import numpy as np

from .render import View, render_pose, render_ids

# ------------------------------------------------------------------ keyword table (regex on names, lower-cased)
KW = [
    ('face_patch', r'髪影|生え際|hairline|影|shadow|kage'),
    ('effect', r'effect|エフェクト|煙|smoke|explosion|爆発|aura|オーラ|heart|ハート|光$|^light|涙|tear|汗|sweat|怒|漫符|ink|インク|color ?sample|乗算|スクリーン色|hitarea|hit_area|当たり'),
    ('ahoge', r'ahoge|アホ毛|あほ毛'),
    ('hair_front', r'前髪|hair_?front|front_?hair|bangs?|fringe|maegami|hairfront'),
    ('hair_side', r'横髪|サイド|hair_?side|side_?hair|もみあげ|sideburn|yokogami|hairside'),
    ('hair_back', r'後ろ?髪|後髪|うしろ髪|hair_?back|back_?hair|ponytail|ポニー|ツイン|twin|braid|三つ編|おさげ|お団子|団子|bun|drill|縦ロール|hairback'),
    ('hair', r'髪|hair'),
    ('eye_hl', r'ハイライト|highlight|hilight|光彩|キャッチ'),
    ('iris', r'瞳|目玉|黒目|iris|pupil|eye_?ball|eyeball|hitomi'),
    ('eye_white', r'白目|eye_?white|shirome|sclera'),
    ('lash', r'まつ毛|まつげ|睫|lash|アイライン|eyeline|eye_?line|上まぶた|下まぶた|まぶた|lid'),
    ('brow', r'眉|まゆ|brow|mayu'),
    ('mouth', r'口|mouth|lip|唇|歯|teeth|tooth|舌|tongue|kuchi'),
    ('nose', r'鼻|nose|hana'),
    ('cheek', r'頬|ほほ|ほお|cheek|hoho|照れ|tere|blush'),
    ('ear', r'耳|ear(?!ring)|mimi'),
    ('eye', r'目|eye'),
    ('face', r'顔|輪郭|face|kao|rinkaku|contour'),
    ('neck', r'首|neck|kubi'),
    ('hat', r'帽子|hat|cap|beret|ベレー|hood|フード|ヘルメット|helmet|crown|王冠'),
    ('accessory', r'リボン|ribbon|bow|ヘアピン|hairpin|pin|髪飾|clip|ネックレス|necklace|首飾|choker|チョーカー|earring|イヤリング|ピアス|眼鏡|めがね|メガネ|glasses|羽|wing|feather|tie|ネクタイ|スカーフ|scarf|badge|名札|bag|バッグ|belt|ベルト|glove|手袋|ボタン|button'),
    ('prop', r'杖|wand|staff|sword|剣|本|book|mic|マイク|umbrella|傘|うさぎ|rabbit|flag|旗|display|ディスプレイ|モノクロ|夜|ホログラム|holo'),
    ('shoes', r'靴|shoe|boot|ブーツ|sneaker|loafer|heel|ローファー|サンダル|sandal|足先'),
    ('legwear', r'靴下|ソックス|sock|stocking|ストッキング|tights|タイツ|ニーハイ'),
    ('hand', r'手(?!袋)|hand|finger|指'),
    ('arm', r'腕|arm|sleeve|袖|肩|shoulder'),
    ('bottom', r'スカート|skirt|pants|パンツ|ズボン|trouser|shorts|ショート|下半身|lower|腰|waist|hip|jeans'),
    ('leg', r'脚|足|leg|thigh|太もも|knee|膝'),
    ('top', r'服|シャツ|shirt|jacket|ジャケット|coat|コート|robe|ローブ|hoodie|パーカー|vest|ベスト|セーラー|sailor|blouse|ブラウス|dress|ドレス|ワンピ|uniform|制服|cloth|衣装|襟|collar|胸|bust|上半身|upper|chest|breast|torso|胴|body|体|core|コア'),
]
KW = [(c, re.compile(r, re.I)) for c, r in KW]

HAIR = ('hair_front', 'hair_side', 'hair_back', 'ahoge')
FACE_FEATURES = ('eye_white', 'iris', 'eye_hl', 'lash', 'brow', 'mouth', 'nose', 'cheek', 'eye')


def _kw_class(names):
    """first keyword class matching the most specific name (list ordered specific -> general)"""
    for n in names:
        if not n:
            continue
        n = re.sub(r'[\s\-]+', '_', n)       # "Back hair" (PSD layer / Pro2D mesh names) reads like back_hair
        for c, rx in KW:
            if rx.search(n):
                return c
    return None


def _side_of(names):
    for n in names:
        if not n:
            continue
        if re.search(r'左|(^|[^a-z])l([^a-z]|$)|_l\d|left|[a-z]L(\d|$|_)', n):
            return 'L'
        if re.search(r'右|(^|[^a-z])r([^a-z]|$)|_r\d|right|[a-z]R(\d|$|_)', n):
            return 'R'
    return ''


def hexc(rgb):
    rgb = np.clip(np.asarray(rgb, float), 0, 1)
    return '#%02x%02x%02x' % tuple(int(round(v * 255)) for v in rgb[:3])


def lum(rgb):
    rgb = np.asarray(rgb, float)
    return rgb[..., 0] * 0.299 + rgb[..., 1] * 0.587 + rgb[..., 2] * 0.114


def robust_color(px, lo=35, hi=85):
    """median colour of pixels whose luminance lies in the lo..hi percentile band (drops ink lines + highlights)"""
    px = np.asarray(px, float).reshape(-1, 3)
    if len(px) == 0:
        return None
    L = lum(px)
    a, b = np.percentile(L, lo), np.percentile(L, hi)
    sel = px[(L >= a) & (L <= b)]
    if len(sel) == 0:
        sel = px
    return np.median(sel, 0)


class Analysis:
    pass


def analyze(model, params=None, height=2048, log=print):
    m, s = model, model.moc.s
    base = {'ParamMouthOpenY': 0, 'ParamEyeLOpen': 1, 'ParamEyeROpen': 1}
    base.update(params or {})
    pose = m.pose(base)
    A = Analysis()
    A.model, A.pose = m, pose
    n = m.moc.counts['arts']
    visible = set(pose.order)
    names_of = []
    for a in range(n):
        pp = int(s.arts.parentPart[a])
        path = m.part_path(pp) if pp >= 0 else []
        names = [m.moc.art_ids[a]]
        an = getattr(m, 'art_names', None)    # a Pro2D rig (live2d/vtp2.py): its mesh names say what each mesh is
        if an and an[a] and an[a] != names[0]:
            names.insert(0, an[a])
        for pid in reversed(path):              # most specific part first
            names += [m.part_names.get(pid, ''), pid]
        names += m.deformer_chain(a)[:3]
        names_of.append(names)
    A.names = names_of
    # ---------------------------------------------------------------- pass 1: keywords + parameters
    cls = ['other'] * n
    side = [''] * n
    for a in range(n):
        if a not in visible:
            cls[a] = 'hidden'
            continue
        ps = m.art_own_params(a)
        pl = {p.lower() for p in ps}
        kc = _kw_class(names_of[a][:1] + names_of[a][1:5]) or _kw_class(names_of[a])
        pc = None
        if any('eyeball' in p for p in pl):
            pc = 'iris'
        elif any(re.search(r'eye[lr]?open|eye[lr]?smile|eyeopen', p) for p in pl):
            pc = 'eye'
        elif any(p.startswith('parambrow') for p in pl):
            pc = 'brow'
        elif any(re.search(r'hairfront', p) for p in pl):
            pc = 'hair_front'
        elif any(re.search(r'hairside', p) for p in pl):
            pc = 'hair_side'
        elif any(re.search(r'hairback', p) for p in pl):
            pc = 'hair_back'
        elif any(re.search(r'mouthopen|mouthform', p) for p in pl):
            pc = 'mouth'
        c = kc
        if pc == 'iris' and kc not in ('eye_hl', 'iris'):
            c = 'iris'
        elif pc in ('eye',) and kc in (None, 'eye', 'face', 'top', 'other'):
            c = 'eye'
        elif pc == 'brow' and kc in (None, 'eye', 'face', 'top', 'hair', 'brow'):
            c = 'brow'
        elif pc and pc.startswith('hair') and kc in (None, 'hair', 'top', 'face', 'other'):
            c = pc
        elif pc == 'mouth' and kc in (None, 'top', 'other'):
            c = 'mouth'
        if c == 'hair':
            c = pc if pc and pc.startswith('hair') else 'hair_front'
        cls[a] = c or 'other'
        side[a] = _side_of(names_of[a][:5])
        if not side[a]:
            for p in ps:
                mm = re.search(r'(Eye|Brow|Arm|Hand|Leg|Shoulder)(L|R)', p)
                if mm and not re.search(r'EyeBall', p):
                    side[a] = mm.group(2); break
    A.cls, A.side = cls, side
    # ---------------------------------------------------------------- geometry frame from the face mesh
    P = pose.positions
    area = np.array([_area(P[a], m.moc.art_tri[a]) for a in range(n)])
    A.area = area
    face = [a for a in range(n) if cls[a] == 'face']
    if not face:
        raise ValueError('no face mesh found (no part named face / 顔)')
    # render ids for the front picture (used for colours / masks)
    A.view = View(m.moc.canvas, height)
    img, _ = render_pose(m, pose, view=A.view, ss=2)
    A.front = img
    ids = render_ids(m, pose, A.view)
    A.ids = ids
    fa = max(face, key=lambda a: area[a])                     # the face skin = the biggest face-part mesh
    A.face_mesh = fa
    fb = _bbox(P[fa])
    head_h = fb[3] - fb[1]
    # ---------------------------------------------------------------- pass 2: refine eye parts by colour / shape
    for a in range(n):
        if cls[a] in ('eye', 'lash', 'eye_white', 'iris', 'eye_hl'):
            col, alpha_mean = _mesh_color(m, pose, a, A.view, ids)
            if col is None:
                continue
            L = float(lum(col)); sat = _sat(col)
            if cls[a] == 'iris':
                if L > 0.8 and sat < 0.25:
                    big = area[a] >= 0.5 * max(area[b] for b in range(n) if cls[b] == 'iris')
                    cls[a] = 'eye_white' if big else 'eye_hl'
            elif cls[a] == 'eye':
                if L > 0.8 and sat < 0.2:
                    cls[a] = 'eye_white'
                elif L < 0.45:
                    cls[a] = 'lash'
                else:
                    cls[a] = 'eye_other'
    # sides of face features from position when names don't say (character's left = +x in model space)
    cx = (fb[0] + fb[2]) / 2
    for a in range(n):
        if cls[a] in ('eye_white', 'iris', 'eye_hl', 'lash', 'brow', 'eye_other', 'ear', 'cheek') and not side[a]:
            side[a] = 'L' if P[a][:, 0].mean() > cx else 'R'
    # ---------------------------------------------------------------- body parts by colour + position
    skin, _ = _mesh_color(m, pose, fa, A.view, ids)          # its own art (overlays like hair shadows excluded)
    A.skin_rgb = skin
    for a in range(n):
        if cls[a] in ('top', 'bottom', 'arm', 'hand', 'leg', 'legwear', 'other', 'neck', 'mouth', 'shoes'):
            col, _ = _mesh_color(m, pose, a, A.view, ids)
            if col is None:
                continue
            d = skin_dist(col, skin)
            if cls[a] == 'mouth':
                if d < 0.1:
                    cls[a] = 'face_patch'          # skin-coloured jaw / lower-lip patch that moves with the mouth
                continue
            if cls[a] == 'neck':
                if d > 0.18:
                    cls[a] = 'accessory'           # scarf / collar living in the neck part
                continue
            if d < 0.12:
                cls[a] = 'hand' if cls[a] in ('arm', 'hand') else ('leg' if cls[a] in ('leg', 'legwear') else 'skin')
            elif cls[a] == 'other':
                yc = P[a][:, 1].mean()
                cls[a] = 'top' if yc < fb[3] + 3 * head_h else 'bottom'
            elif cls[a] == 'leg':
                cls[a] = 'legwear'
    A.cls = cls
    _landmarks(A)
    _colors(A)
    _garments(A)
    return A


def skin_dist(col, skin):
    """colour distance that also compares warmth (r - b): white cloth is close to pale skin in RGB but not in hue"""
    col, skin = np.asarray(col, float), np.asarray(skin, float)
    return float(np.linalg.norm(col - skin) + 1.6 * abs((col[0] - col[2]) - (skin[0] - skin[2])))


def skin_dist_px(px, skin):
    px, skin = np.asarray(px, float), np.asarray(skin, float)
    return np.linalg.norm(px - skin, axis=1) + 1.6 * np.abs((px[:, 0] - px[:, 2]) - (skin[0] - skin[2]))


def _area(P, tri):
    if len(tri) == 0:
        return 0.0
    a, b, c = P[tri[:, 0]], P[tri[:, 1]], P[tri[:, 2]]
    return float(np.abs(np.cross(b - a, c - a)).sum() / 2)


def _bbox(P):
    return np.array([P[:, 0].min(), P[:, 1].min(), P[:, 0].max(), P[:, 1].max()])


def _sat(c):
    return colorsys.rgb_to_hsv(*[float(x) for x in c])[1]


def _pixels(img, ids, arts):
    sel = np.isin(ids, list(arts))
    return img[..., :3][sel]


def _mesh_color(model, pose, a, view, ids):
    """representative colour of one mesh: its visible pixels in the front render, else its own texture pixels"""
    from .render import drawable_layer
    L = drawable_layer(model, pose, a, view, 1, opacity=False)
    al = L[..., 3]
    if al.max() < 0.3:
        return None, 0
    sel = al > 0.5
    rgb = L[..., :3][sel] / np.maximum(al[sel][:, None], 1e-4)
    if len(rgb) < 5:
        return None, 0
    return robust_color(rgb, 20, 90), float(al[sel].mean())


# ------------------------------------------------------------------ landmarks
def _landmarks(A):
    m, P, cls, side = A.model, A.pose.positions, A.cls, A.side
    n = len(cls)
    fb = _bbox(P[A.face_mesh])
    lm = {}
    lm['face_bbox'] = fb.tolist()

    def pts(c, sd=None):
        sel = [a for a in range(n) if cls[a] == c and (sd is None or side[a] == sd)]
        return (np.concatenate([P[a] for a in sel]) if sel else None), sel

    for sd in ('L', 'R'):
        wp, _ = pts('eye_white', sd)
        ip, isel = pts('iris', sd)
        lp, _ = pts('lash', sd)
        box_src = wp if wp is not None else (lp if lp is not None else ip)
        if box_src is None:
            continue
        eb = _bbox(box_src)
        if ip is not None:
            # iris = the biggest iris mesh (others are pupils / reflections)
            big = max(isel, key=lambda a: A.area[a])
            ib = _bbox(P[big])
        else:
            ib = eb
        lm['eye_' + sd] = dict(bbox=eb.tolist(), center=[(ib[0] + ib[2]) / 2, (ib[1] + ib[3]) / 2],
                               iris_bbox=ib.tolist(), width=float(eb[2] - eb[0]), height=float(eb[3] - eb[1]))
        if lp is not None:
            lb = _bbox(lp)
            lm['eye_' + sd]['lash_bbox'] = lb.tolist()
        bp, _ = pts('brow', sd)
        if bp is not None:
            lm['brow_' + sd] = _bbox(bp).tolist()
    mp, _ = pts('mouth')
    if mp is not None:
        mb = _bbox(mp)
        lm['mouth'] = dict(bbox=mb.tolist(), center=[(mb[0] + mb[2]) / 2, (mb[1] + mb[3]) / 2])
    npnt, _ = pts('nose')
    if npnt is not None:
        nb = _bbox(npnt)
        lm['nose'] = [(nb[0] + nb[2]) / 2, (nb[1] + nb[3]) / 2]
    # face contour: width per height row of the face skin mesh
    F = P[A.face_mesh]
    lm['chin'] = [float(F[np.argmax(F[:, 1]), 0]), float(fb[3])]
    ey = np.mean([lm[k]['center'][1] for k in ('eye_L', 'eye_R') if k in lm]) if ('eye_L' in lm or 'eye_R' in lm) else fb[1] + 0.5 * (fb[3] - fb[1])
    lm['eye_y'] = float(ey)
    # face width at the eye line and below (from the rendered id image: the face mesh's row extents)
    ids, view = A.ids, A.view
    from .render import drawable_layer
    fmask = drawable_layer(m, A.pose, A.face_mesh, view, 1, opacity=False)[..., 3] > 0.5
    rows = {}
    for key, yy in (('eye', ey), ('mid', ey + 0.5 * (fb[3] - ey)), ('low', ey + 0.8 * (fb[3] - ey))):
        r = int(round(view.px([[0, yy]])[0, 1]))
        r = min(max(r, 0), fmask.shape[0] - 1)
        xs = np.nonzero(fmask[r])[0]
        if len(xs):
            x0, x1 = view.model([[xs.min(), r], [xs.max() + 1, r]])[:, 0]
            rows[key] = float(x1 - x0)
    lm['face_width'] = rows
    # hair extents + crown
    hair = [a for a in range(n) if cls[a] in HAIR]
    if hair:
        hp = np.concatenate([P[a] for a in hair])
        hb = _bbox(hp)
        lm['hair_bbox'] = hb.tolist()
        lm['crown'] = float(hb[1])
        # bottom of the back hair (length) and of the side locks
        for c in ('hair_back', 'hair_side', 'hair_front'):
            q, _ = pts(c)
            if q is not None:
                lm[c + '_bbox'] = _bbox(q).tolist()
    # body extents (visible, non-effect)
    body = [a for a in A.pose.order if cls[a] not in ('effect', 'hidden', 'prop')]
    bp = np.concatenate([P[a] for a in body])
    lm['figure_bbox'] = _bbox(bp).tolist()
    nk, _ = pts('neck')
    if nk is not None:
        lm['neck_bbox'] = _bbox(nk).tolist()
    A.lm = lm
    # scale: the eye-to-eye distance (iris centres) is the unit of the face frame
    if 'eye_L' in lm and 'eye_R' in lm:
        A.ipd = float(abs(lm['eye_L']['center'][0] - lm['eye_R']['center'][0]))
    else:
        A.ipd = float((fb[2] - fb[0]) * 0.45)
    A.mid_x = float(np.mean([lm[k]['center'][0] for k in ('eye_L', 'eye_R') if k in lm])) if 'eye_L' in lm else float((fb[0] + fb[2]) / 2)


# ------------------------------------------------------------------ colours
def _colors(A):
    m, cls, ids, img = A.model, A.cls, A.ids, A.front
    n = len(cls)
    C = {}
    C['skin'] = hexc(A.skin_rgb)
    hair = [a for a in range(n) if cls[a] in HAIR]
    if hair:
        px = _pixels(img, ids, hair)
        if len(px):
            L = lum(px)
            C['hair'] = hexc(robust_color(px, 40, 75))
            C['hair_shade'] = hexc(np.median(px[(L >= np.percentile(L, 8)) & (L <= np.percentile(L, 25))], 0))
            C['hair_light'] = hexc(np.median(px[L >= np.percentile(L, 92)], 0))
            # root -> tip gradient: colour of the top 25 % vs the bottom 25 % of all hair pixels (by image row)
            ys = np.nonzero(np.isin(ids, hair))[0]
            y0, y1 = np.percentile(ys, 20), np.percentile(ys, 85)
            sel = np.isin(ids, hair)
            yy = np.nonzero(sel)[0]
            top = img[..., :3][sel][yy <= y0]
            bot = img[..., :3][sel][yy >= y1]
            C['hair_root'] = hexc(robust_color(top, 30, 80))
            C['hair_tip'] = hexc(robust_color(bot, 30, 80))
            # distinct streak colours (e.g. dyed tips / inner colour): k-means on hue/sat
            C['hair_accents'] = [hexc(c) for c in _accents(px, C['hair'])]
    # iris: sample the iris mesh texture rows (top / middle / bottom)
    for sd in ('L', 'R'):
        ir = [a for a in range(n) if cls[a] == 'iris' and A.side[a] == sd]
        if not ir:
            continue
        big = max(ir, key=lambda a: A.area[a])
        C['iris_' + sd] = _iris_colors(A, big)
    wh = [a for a in range(n) if cls[a] == 'eye_white']
    if wh:
        C['sclera'] = hexc(robust_color(_pixels(img, ids, wh), 50, 95)) if np.isin(ids, wh).any() else '#ffffff'
    lash = [a for a in range(n) if cls[a] == 'lash']
    if lash:
        px = _pixels(img, ids, lash)
        if len(px):
            C['lash'] = hexc(np.median(px[lum(px) <= np.percentile(lum(px), 30)], 0))
    brow = [a for a in range(n) if cls[a] == 'brow']
    if brow:
        px = _pixels(img, ids, brow)
        if len(px):
            C['brow'] = hexc(robust_color(px, 10, 60))
    mouth = [a for a in range(n) if cls[a] == 'mouth']
    if mouth:
        # open the mouth to see the interior colour
        p2 = m.pose({'ParamMouthOpenY': 1, 'ParamEyeLOpen': 1, 'ParamEyeROpen': 1})
        img2, _ = render_pose(m, p2, view=A.view, ss=1, only=set(mouth))
        a2 = img2[..., 3] > 0.9
        if a2.any():
            px = img2[..., :3][a2]
            sat = np.array([_sat(c) for c in px[::max(1, len(px) // 4000)]])
            px2 = px[::max(1, len(px) // 4000)]
            red = px2[(sat > 0.35) & (lum(px2) > 0.2) & (lum(px2) < 0.7)]
            C['mouth_interior'] = hexc(np.median(red, 0)) if len(red) else '#8a3040'
            C['mouth_line'] = hexc(np.median(px2[lum(px2) <= np.percentile(lum(px2), 15)], 0))
    cheek = [a for a in range(n) if cls[a] == 'cheek']
    if cheek:
        from .render import drawable_layer
        cols = []
        for a in cheek:
            L = drawable_layer(m, A.pose, a, A.view, 1, opacity=False)
            al = L[..., 3]
            if al.max() > 0.05:
                sel = al > al.max() * 0.5
                cols.append((L[..., :3][sel] / np.maximum(al[sel][:, None], 1e-4)).mean(0))
        if cols:
            C['blush'] = hexc(np.mean(cols, 0))
    # garments
    for c in ('top', 'bottom', 'legwear', 'shoes', 'hat', 'accessory'):
        sel = [a for a in range(n) if cls[a] == c]
        if sel:
            px = _pixels(img, ids, sel)
            if len(px) > 50:
                C[c] = [hexc(x) for x in _palette(px, 3)]
    A.colors = C


def _iris_colors(A, a):
    """top / middle / bottom / ring colours of the iris drawn in the atlas (vertical profile of the mesh's own art)"""
    from .render import drawable_layer
    view = A.view
    L = drawable_layer(A.model, A.pose, a, view, 1, opacity=False)
    al = L[..., 3]
    sel = al > 0.6
    if sel.sum() < 20:
        return {}
    rgb = L[..., :3] / np.maximum(al[..., None], 1e-4)
    ys, xs = np.nonzero(sel)
    y0, y1 = ys.min(), ys.max()
    out = {}
    for key, (f0, f1) in (('top', (0.12, 0.3)), ('mid', (0.4, 0.6)), ('bottom', (0.72, 0.9))):
        rr = (ys >= y0 + f0 * (y1 - y0)) & (ys <= y0 + f1 * (y1 - y0))
        cx = (xs.min() + xs.max()) / 2
        w = xs.max() - xs.min()
        rr &= np.abs(xs - cx) > 0.18 * w          # avoid the pupil column
        if rr.any():
            px = rgb[ys[rr], xs[rr]]
            out[key] = hexc(robust_color(px, 20, 80))
    px = rgb[sel]
    out['dark'] = hexc(np.median(px[lum(px) <= np.percentile(lum(px), 8)], 0))
    out['light'] = hexc(np.median(px[lum(px) >= np.percentile(lum(px), 94)], 0))
    return out


def _palette(px, k=3, iters=12):
    px = np.asarray(px, float)[:: max(1, len(px) // 20000)]
    L = lum(px)
    keep = L > np.percentile(L, 5)
    if keep.sum() >= k:                  # flat-coloured art (one tone, a PSD-made rig): nothing is darker than the 5 %
        px = px[keep]
    cent = np.percentile(px, [20, 50, 80], axis=0)[:k] if k == 3 else px[np.random.default_rng(0).choice(len(px), k)]
    for _ in range(iters):
        d = ((px[:, None] - cent[None]) ** 2).sum(-1)
        lab = d.argmin(1)
        for j in range(k):
            if (lab == j).any():
                cent[j] = np.median(px[lab == j], 0)
    cnt = np.bincount(lab, minlength=k)
    return [cent[j] for j in np.argsort(-cnt) if cnt[j] > 0.03 * len(px)]


def _accents(px, base_hex, max_n=3):
    """colours in the hair that differ a lot in hue/saturation from the base (dyed streaks, gradients)"""
    base = np.array([int(base_hex[i:i + 2], 16) / 255 for i in (1, 3, 5)])
    px = np.asarray(px, float)[:: max(1, len(px) // 30000)]
    hsv = np.array([colorsys.rgb_to_hsv(*c) for c in px])
    bh = colorsys.rgb_to_hsv(*base)
    dh = np.minimum(np.abs(hsv[:, 0] - bh[0]), 1 - np.abs(hsv[:, 0] - bh[0]))
    far = (hsv[:, 1] > 0.3) & (hsv[:, 2] > 0.25) & ((dh > 0.08) | (np.abs(hsv[:, 1] - bh[1]) > 0.35))
    if far.sum() < 0.02 * len(px):
        return []
    sub = px[far]
    # bin by hue
    hh = hsv[far, 0]
    out = []
    for lo in np.linspace(0, 1, 13)[:-1]:
        sel = (hh >= lo) & (hh < lo + 1 / 12)
        if sel.sum() > 0.01 * len(px):
            out.append((sel.sum(), np.median(sub[sel], 0)))
    out.sort(key=lambda t: -t[0])
    return [c for _, c in out[:max_n]]


# ------------------------------------------------------------------ garments (pixel bands of the front picture)
def _garments(A):
    """Split the figure below the chin into bands: top (to the waist), bottom (skirt / pants), legwear, shoes;
    decide skirt vs pants from where the legs separate and what colour continues below that point."""
    ids, img, view, cls = A.ids, A.front, A.view, A.cls
    n = len(cls)
    lm = A.lm
    fb = lm['face_bbox']
    head_h = fb[3] - (lm.get('crown', fb[1]))
    body_cls = {'top', 'bottom', 'legwear', 'leg', 'skin', 'shoes', 'arm', 'hand', 'accessory', 'other'}
    lab = np.full(ids.shape, -1, np.int32)
    valid = ids >= 0
    code = {c: i for i, c in enumerate(sorted(body_cls))}
    cls_arr = np.array([code.get(c, -1) for c in cls] + [-1])
    lab[valid] = cls_arr[ids[valid]]
    fig = lab >= 0
    chin_px = int(view.px([[0, fb[3]]])[0, 1])
    rows = np.nonzero(fig.any(1))[0]
    if len(rows) == 0:
        A.outfit = {}
        return
    bottom_px = rows.max()
    cx = int(view.px([[A.mid_x, 0]])[0, 0])
    out = {'full_body': bool((bottom_px - chin_px) > 3.5 * head_h * view.scale)}
    # legs split: first row below the chest where the central column is empty while both sides are figure
    split = None
    arm_like = np.isin(lab, [code['arm'], code['hand']])
    core = fig & ~arm_like
    hw = max(3, int(0.25 * head_h * view.scale))
    for r in range(chin_px + int(2.0 * head_h * view.scale), bottom_px):
        row = core[r]
        if not row[max(cx - 2, 0):cx + 3].any() and row[max(cx - 4 * hw, 0):cx].any() and row[cx:cx + 4 * hw].any():
            split = r
            break
    out['split_y'] = float(view.model([[0, split]])[0, 1]) if split else None
    skin = A.skin_rgb

    def band(r0, r1, xs=None):
        r0, r1 = max(int(r0), 0), min(int(r1), ids.shape[0])
        if r1 <= r0:
            return np.zeros((0, 3))
        sub = core[r0:r1]
        if xs is not None:
            m = np.zeros_like(sub); m[:, max(xs[0], 0):xs[1]] = True; sub = sub & m
        return img[r0:r1, :, :3][sub]

    def colors(px):
        if len(px) < 30:
            return []
        px = px[skin_dist_px(px, skin) > 0.12]
        if len(px) < 30:
            return ['skin']
        return [hexc(c) for c in _palette(px, 3)]

    waist = chin_px + int(1.7 * head_h * view.scale)
    # the outer garment dominates the silhouette (jacket over a shirt): colours over the whole torso band incl. sleeves,
    # the centre column separately ('inner': the shirt seen through an open jacket)
    r0, r1 = int(chin_px + 0.4 * head_h * view.scale), int(waist)
    whole = img[r0:r1, :, :3][fig[r0:r1] & (lab[r0:r1] != code['skin'])]
    out['top'] = {'colors': colors(whole),
                  'inner': colors(band(chin_px + 0.4 * head_h * view.scale, waist, (cx - hw, cx + hw)))}
    if split:
        above = band(split - 0.25 * head_h * view.scale, split, (cx - 2 * hw, cx + 2 * hw))
        below = band(split + 2, split + 0.25 * head_h * view.scale, (cx - 3 * hw, cx + 3 * hw))
        ca = np.median(above, 0) if len(above) else None
        cb = np.median(below, 0) if len(below) else None
        same = ca is not None and cb is not None and np.linalg.norm(ca - cb) < 0.1
        # a skirt hem flares out past the legs: silhouette extent just above the split vs the two legs just below
        def extent(r):
            xs = np.nonzero(core[min(max(int(r), 0), ids.shape[0] - 1), max(cx - 6 * hw, 0):cx + 6 * hw])[0]
            return (xs.max() - xs.min()) if len(xs) else 0
        ab, be = extent(split - 0.06 * head_h * view.scale), extent(split + 0.15 * head_h * view.scale)
        out['hem_flare'] = float(ab / max(be, 1))
        if out['hem_flare'] > 1.12:
            same = False
        # pants: the garment colour continues down both legs; skirt / dress: the legs below differ
        if same:
            out['bottom'] = {'kind': 'pants', 'colors': colors(band(waist, split + 0.8 * head_h * view.scale, (cx - 3 * hw, cx + 3 * hw)))}
        else:
            out['bottom'] = {'kind': 'skirt', 'length': float((split - waist) / (head_h * view.scale)),
                             'colors': colors(band(waist, split, (cx - 3 * hw, cx + 3 * hw)))}
            # silhouette: hem width vs the widest point of the upper skirt (hips). Pencil ~0.85-1.0, A-line /
            # pleated flare > 1.1 (the hands hang beside the hips, so only the central garment run counts)
            def run(r):
                row = core[min(max(int(r), 0), ids.shape[0] - 1)]
                x = cx
                if not row[x]:
                    return 0
                x0 = x
                while x0 > 0 and row[x0 - 1]:
                    x0 -= 1
                x1 = x
                while x1 < row.shape[0] - 1 and row[x1 + 1]:
                    x1 += 1
                return x1 - x0 + 1
            rows = np.linspace(waist + 0.1 * (split - waist), waist + 0.45 * (split - waist), 8)
            hip = max(run(r) for r in rows)
            hem = run(split - 0.06 * head_h * view.scale)
            if hip > 0 and hem > 0:
                out['bottom']['taper'] = float(hem / hip)
                out['bottom']['hip_w'] = float(hip / (head_h * view.scale))
        legs = band(split + 0.3 * head_h * view.scale, bottom_px - 0.45 * head_h * view.scale)
        if len(legs) > 30:
            med = np.median(legs, 0)
            out['legwear'] = {'kind': 'bare' if skin_dist(med, skin) < 0.12 else ('same' if same else 'stockings'),
                              'colors': [hexc(med)]}
    # meshes named as lower-body garments decide pants vs skirt when they exist: pants reach the ankles
    bot = [a for a in range(n) if cls[a] == 'bottom']
    if bot:
        P = A.pose.positions
        bb = _bbox(np.concatenate([P[a] for a in bot]))
        fig_bottom = view.model([[0, bottom_px]])[0, 1]
        if bb[3] > fig_bottom - 1.1 * head_h:
            out['bottom'] = {'kind': 'pants', 'colors': colors(_pixels(img, ids, bot))}
            if 'legwear' in out:
                out['legwear']['kind'] = 'same'
    shoes = band(bottom_px - 0.35 * head_h * view.scale, bottom_px + 1)
    if len(shoes) > 30:
        out['shoes'] = {'colors': [hexc(c) for c in _palette(shoes, 2)]}
    arms = img[..., :3][arm_like]
    if len(arms) > 30:
        sk = skin_dist_px(arms, skin) < 0.12
        out['sleeves'] = 'long' if sk.mean() < 0.35 else ('short' if sk.mean() < 0.8 else 'none')
        cl = arms[~sk]
        out['sleeve_colors'] = [hexc(c) for c in _palette(cl, 2)] if len(cl) > 30 else []
    A.outfit = out
