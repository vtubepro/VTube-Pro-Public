"""Pro2D -> 3D design overrides (to3d_rebuild): checked again here against the spec the TypeScript table writes
(shared/to3d/overrides.ts -> overrides_spec.json), then applied to the design (pre) and to the pipeline knobs.

    flat = load(path)                 # {'creator.face.eyeSize': 1.1, 'hair.mode': 'ponytail', ...}
    apply_design(pre, flat)           # after design(): creator / face params, hair colour into the hair stage too
    k = knobs(flat)                   # lid bake, drawn lid, rest smile, teeth, hair opts, springs, exposure
"""
import json
import os
import re

HERE = os.path.dirname(os.path.abspath(__file__))
SPEC = os.path.join(HERE, 'overrides_spec.json')
HEX = re.compile(r'^#[0-9a-fA-F]{6}$')


def spec():
    with open(SPEC, encoding='utf-8') as f:
        return {k['path']: k for k in json.load(f)['keys']}


def check(flat):
    S, bad = spec(), []
    for k, v in flat.items():
        o = S.get(k)
        if o is None:
            bad.append(f'unknown setting {k}')
            continue
        t = o['type']
        if t in ('number', 'int'):
            if isinstance(v, bool) or not isinstance(v, (int, float)) or (t == 'int' and int(v) != v) or not (o['min'] <= v <= o['max']):
                bad.append(f'{k} out of range')
        elif t == 'hex' and not (isinstance(v, str) and HEX.match(v)):
            bad.append(f'{k} is not a colour')
        elif t == 'enum' and v not in o['values']:
            bad.append(f'{k} must be one of {o["values"]}')
        elif t == 'bool' and not isinstance(v, bool):
            bad.append(f'{k} must be true or false')
    if bad:
        raise ValueError('overrides: ' + '; '.join(bad))
    return flat


def load(path):
    if not path:
        return {}
    with open(path, encoding='utf-8') as f:
        flat = json.load(f)
    return check(flat)


def _set(d, path, v):
    ks = path.split('.')
    for k in ks[:-1]:
        if not isinstance(d.get(k), dict):
            d[k] = {}
        d = d[k]
    d[ks[-1]] = v


def apply_design(pre, flat):
    """creator.* / face.* into the design; colours that the design copies elsewhere follow"""
    for k, v in flat.items():
        if k.startswith(('creator.', 'face.')) and k != 'creator.base':
            _set(pre, k, v)
    C = pre.setdefault('l2d', {}).setdefault('colors', {})
    if 'creator.colors.hair' in flat:
        C['hair'] = flat['creator.colors.hair']            # the hair stage reads the drawn colours (hair.hair_params)
    if 'creator.colors.eyes' in flat and 'face.iris.color' not in flat:
        _set(pre, 'face.iris.color', flat['creator.colors.eyes'])
    if 'creator.colors.brows' in flat and 'face.brow.color' not in flat:
        _set(pre, 'face.brow.color', flat['creator.colors.brows'])
    return pre


def knobs(flat):
    springs = {}
    for k, v in flat.items():
        if k.startswith('springs.'):
            _, g, p = k.split('.')
            springs.setdefault(g, {})[p] = v
    opts = []
    if 'hair.ink' in flat:
        opts.append(f"ink={flat['hair.ink']}")
    if flat.get('hair.silfit') is False:
        opts.append('silfit=0')
    if 'hair.seed' in flat:
        opts.append(f"seed={int(flat['hair.seed'])}")
    return {
        'sex': flat.get('sex'), 'base': flat.get('creator.base'),
        'lid_bake': flat.get('eyes.lidBake'), 'drawn_lid': flat.get('eyes.drawnLid', True),
        'rest_smile': flat.get('mouth.restSmile'), 'teeth': flat.get('mouth.teeth'),
        'hair_mode': flat.get('hair.mode'), 'back_scale': flat.get('hair.backLengthScale'), 'hair_opts': opts,
        'springs': springs, 'exposure': flat.get('look.vrmExposure'),
    }


def tune_springs(tune, springs):
    """assemble.TUNE (stiffness, gravity, drag, hit radius) per chain family, overridden"""
    out = dict(tune)
    for g, p in springs.items():
        if g in out:
            st, gp, dr, hr = out[g]
            out[g] = (p.get('stiffness', st), p.get('gravity', gp), p.get('drag', dr), hr)
    return out
