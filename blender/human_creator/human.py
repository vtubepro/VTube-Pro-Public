"""
Build the MakeHuman character with MPFB's services: macros (gender/age/muscle/weight/height/proportions/race),
detail targets, skin, game-engine rig, and the proxy assets (eyes, brows, lashes, teeth, tongue, hair, clothes).
Everything lands in MPFB's native form (Z-up, -Y front, MakeHuman bone names); convert.py turns it into
VTube Pro conventions afterwards.
"""
import glob
import os

import bpy

from . import mpfb_env as ME
from .params import age_to_macro, base_face, stylized_face


class Human:
    """Handles to the generated objects."""
    def __init__(self):
        self.basemesh = None
        self.rig = None
        self.parts = {}          # role -> object (eyes, eyebrows, eyelashes, teeth, tongue, hair)
        self.clothes = []        # base outfit objects
        self.costumes = {}       # costume id -> [objects]
        self.mhclo = {}          # object name -> mhclo path (also stored as ob['vtp_mhclo'])
        self.skin_path = None
        self.eye_centers = {}

    def mhclo_mat(self, ob):
        """The .mhmat referenced by a proxy's .mhclo ('material' line), absolute."""
        path = ob.get('vtp_mhclo')
        if not path:
            return None
        with open(path, encoding='utf-8', errors='ignore') as f:
            for line in f:
                if line.startswith('material '):
                    return os.path.join(os.path.dirname(path), line.split(None, 1)[1].strip())
        return None


def _all_targets():
    """name -> path for every bundled detail target (except macros / expressions)."""
    root = ME.target_dir()
    out = {}
    for p in glob.glob(os.path.join(root, '*', '*.target.gz')):
        sub = os.path.basename(os.path.dirname(p))
        if sub in ('macrodetails', 'expression', 'breast') and 'breast-' not in os.path.basename(p) and 'nipple' not in os.path.basename(p):
            continue
        out[os.path.basename(p)[:-len('.target.gz')]] = p
    return out


def resolve_targets(spec):
    """{'nose-volume': -0.3, 'eye-scale': 0.2, 'head-oval': 0.5} -> [(path, weight)].

    Bipolar keys pick <key>-incr / -decr (or -up/-down, -in/-out, -forward/-backward ...) by sign; symmetric
    l-/r- targets are driven by the bare key; exact file names work too."""
    T = _all_targets()
    pairs = [('-incr', '-decr'), ('-up', '-down'), ('-out', '-in'), ('-forward', '-backward'), ('-convex', '-concave'),
             ('-uncompress', '-compress')]
    res = []
    for key, val in (spec or {}).items():
        v = float(val)
        if abs(v) < 1e-4:
            continue
        key = key.strip()
        found = False
        for pre in ('', 'l-', 'r-'):
            k = pre + key
            if k in T and v > 0:
                res.append((T[k], v)); found = True; continue
            for pos, neg in pairs:
                if (k + pos) in T or (k + neg) in T:
                    name = k + (pos if v > 0 else neg)
                    if name in T:
                        res.append((T[name], abs(v))); found = True
                    break
        if not found:
            print('[human_creator] WARN unknown target', key)
    return res


def create(p, log=print):
    ns = ME.enable()
    HS, TS = ns.HumanService, ns.TargetService
    H = Human()
    for o in list(bpy.data.objects):
        bpy.data.objects.remove(o, do_unlink=True)
    b = p['body']
    macro = TS.get_default_macro_info_dict()
    macro.update(gender=b['gender'], age=age_to_macro(b['age']), muscle=b['muscle'], weight=b['weight'],
                 height=b['height'], proportions=b['proportions'], cupsize=b['cupsize'], firmness=b['firmness'])
    macro['race'] = dict(b['race'])
    bm = HS.create_human(macro_detail_dict=macro)
    H.basemesh = bm
    # ---- detail targets (face + body + stylisation), then bake everything into the basis
    face = base_face(p)
    for k, v in stylized_face(p).items():
        face[k] = face.get(k, 0) + v
    for k, v in p['face'].items():
        face[k] = face.get(k, 0) + v
    for path, w in resolve_targets(face) + resolve_targets(p['shape']):
        TS.load_target(bm, path, weight=w)
    TS.bake_targets(bm)
    if bm.data.shape_keys:
        bm.shape_key_clear()
    log('basemesh', len(bm.data.vertices), 'verts; targets baked')
    # ---- skin (GAMEENGINE = one Principled BSDF, what glTF wants)
    skin = ME.asset('skins', p['skin']['texture'] + '.mhmat') or ME.asset('skins', 'young_caucasian_female.mhmat')
    HS.set_character_skin(skin, bm, skin_type='GAMEENGINE')
    H.skin_path = skin
    # ---- rig
    H.rig = HS.add_builtin_rig(bm, 'game_engine')

    def add(sub, name, atype, role=None):
        if not name or name == 'none':
            return None
        path = ME.asset(sub, name + '.mhclo')
        if not path:
            print('[human_creator] WARN missing asset', sub, name)
            return None
        o = HS.add_mhclo_asset(path, bm, asset_type=atype, material_type='GAMEENGINE', subdiv_levels=0)
        H.mhclo[o.name] = path
        o['vtp_mhclo'] = path
        if role:
            H.parts[role] = o
        return o
    add('eyes', 'high-poly', 'Eyes', 'eyes')
    add('eyebrows', p['eyebrows'], 'Eyebrows', 'eyebrows')
    add('eyelashes', p['eyelashes'], 'Eyelashes', 'eyelashes')
    add('teeth', p['teeth'], 'Teeth', 'teeth')
    add('tongue', p['tongue'], 'Tongue', 'tongue')
    add('hair', p['hair']['style'], 'Hair', 'hair')
    # eye colour: MPFB loaded the default eye material; swap its texture
    eyes = H.parts.get('eyes')
    if eyes:
        mat = ME.asset('eyes', os.path.join('materials', p['eyes']['color'] + '.mhmat'))
        tex = os.path.join(ME.DATA_DIR, 'eyes', 'materials', p['eyes']['color'] + '_eye.png')
        if os.path.isfile(tex):
            for m in eyes.data.materials:
                for n in m.node_tree.nodes:
                    if n.type == 'TEX_IMAGE' and 'iffuse' in n.name:
                        n.image = bpy.data.images.load(tex, check_existing=True)
    o = p['outfit']
    for c in o['clothes']:
        ob = add('clothes', c, 'Clothes')
        if ob:
            H.clothes.append(ob)
    ob = add('clothes', o['shoes'], 'Clothes')
    if ob:
        H.clothes.append(ob)
    for cos in o['costumes']:
        objs = []
        for c in list(cos.get('clothes', [])) + ([cos['shoes']] if cos.get('shoes') else []):
            ob = add('clothes', c, 'Clothes')
            if ob:
                objs.append(ob)
        H.costumes[cos['id']] = objs
    log('assets', {k: v.name for k, v in H.parts.items()}, 'clothes', [c.name for c in H.clothes],
        'costumes', {k: [x.name for x in v] for k, v in H.costumes.items()})
    return H
