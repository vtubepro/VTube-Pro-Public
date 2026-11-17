"""anime_hair.build — turn a StyleResult into finished hair objects: clump mesh + scalp shell + hair ties, clean toon
normals from the smooth proxy, the painted atlas + material, optional spring-chain weights."""
from __future__ import annotations

import math
import os

import bmesh
import bpy
import numpy as np

from . import hairkit as hk


def make_tie(center, axis, radius, name='HairTie'):
    bm = bmesh.new()
    bmesh.ops.create_circle(bm, cap_ends=False, segments=16, radius=radius)
    geom = bmesh.ops.extrude_edge_only(bm, edges=bm.edges[:])
    for v in [e for e in geom['geom'] if isinstance(e, bmesh.types.BMVert)]:
        v.co.z += radius * 0.9
    bmesh.ops.solidify(bm, geom=bm.faces[:], thickness=radius * 0.35)
    me = bpy.data.meshes.new(name); bm.to_mesh(me); bm.free()
    o = bpy.data.objects.new(name, me); bpy.context.scene.collection.objects.link(o)
    z = hk.unit(axis); x = hk.unit(np.cross([0, 0, 1.0], z)) if abs(z[2]) < 0.95 else np.array([1.0, 0, 0])
    y = np.cross(z, x)
    from mathutils import Matrix
    M = Matrix(((x[0], y[0], z[0], center[0]), (x[1], y[1], z[1], center[1]), (x[2], y[2], z[2], center[2]), (0, 0, 0, 1)))
    me.transform(M)
    for p in me.polygons:
        p.use_smooth = True
    uv = me.uv_layers.new(name='UVMap')
    m = bpy.data.materials.get('HairTie_mat') or bpy.data.materials.new('HairTie_mat')
    m.use_nodes = True
    b = next(n for n in m.node_tree.nodes if n.type == 'BSDF_PRINCIPLED')
    b.inputs['Base Color'].default_value = (0.85, 0.15, 0.3, 1)
    me.materials.append(m)
    return o


def coverage_gaps(F, hair, hairline, step=9.0, reach=0.06):
    """Scalp directions (theta, phi) inside the hairline whose outward ray from the scalp hits no hair."""
    from mathutils import Vector
    from mathutils.bvhtree import BVHTree
    dg = bpy.context.evaluated_depsgraph_get()
    bvh = BVHTree.FromObject(hair, dg)
    hl = {'front': 32.0, 'side': 5.0, 'back': -38.0}
    hl.update(hairline or {})
    gaps = []
    for ph in np.arange(-30, 89, step * 0.8):
        n_th = max(4, int(360 / step * math.cos(math.radians(ph))))
        for th in np.linspace(-180, 180, n_th, endpoint=False):
            a = abs(th)
            lim = hl['front'] + (hl['side'] - hl['front']) * (a / 90) ** 1.5 if a < 90 else hl['side'] + (hl['back'] - hl['side']) * ((a - 90) / 90) ** 0.8
            if ph < lim + 6:
                continue
            p, n = F.root(th, ph, 0.001)
            hit = bvh.ray_cast(Vector(p), Vector(n), reach)
            if hit[0] is None:
                gaps.append((float(th), float(ph)))
    return gaps


def fill_gaps(F, res, gaps, rng, width=0.05):
    """Filler clumps for uncovered scalp spots: rooted a little above the gap, flowing down over it."""
    from .styles import hang
    added = 0
    taken = []
    for th, ph in sorted(gaps, key=lambda g: -g[1]):
        if any(abs(((th - t2 + 180) % 360) - 180) < 14 and abs(ph - p2) < 12 for t2, p2 in taken):
            continue
        taken.append((th, ph))
        res.clumps.append(hang(F, th, min(ph + 10, 86), 0.05, width, gravity=4.0, out=0.3, margin=0.005, tips=2,
                               tip_spread=0.4, split=0.6, taper=2.2, variant=int(rng.integers(0, 4)), layer='filler',
                               thick=0.34))
        added += 1
    return added


def ink_hull(out, pal, width=0.0022, tip=0.3, name=None):
    """Exportable inverted-hull ink outline for the clumps (the MToon outline can't be used: it extrudes along the
    SHADING normals, which the proxy transfer made smooth over the whole mass, so clump edges would get no line).
    A copy of the clump mesh pushed out along its GEOMETRIC vertex normals by width * (1 - (1 - tip) * t) (thin,
    sharp toward the tips), winding flipped: with ordinary back-face culling only its inside shows = an ink rim
    around every clump, where it overlaps other hair / skin too. Vertex groups (head + spring joints) are copied, so
    it sways with the hair. Material: flat ink (unlit in the app: black lit/shade + ink emission)."""
    hair = out['hair']
    me = hair.data.copy()
    me.name = name or hair.name + '_Ink'
    ob = bpy.data.objects.new(me.name, me)
    bpy.context.scene.collection.objects.link(ob)
    ob.matrix_world = hair.matrix_world.copy()
    for g in hair.vertex_groups:
        ob.vertex_groups.new(name=g.name)
    for v in hair.data.vertices:
        for g in v.groups:
            ob.vertex_groups[hair.vertex_groups[g.group].name].add([v.index], g.weight, 'REPLACE')
    n = len(me.vertices)
    VN = np.zeros(n * 3); me.vertices.foreach_get('normal', VN); VN = VN.reshape(-1, 3)
    P = np.zeros(n * 3); me.vertices.foreach_get('co', P); P = P.reshape(-1, 3)
    # t per vertex from the HairTone corner colour (R = t)
    tcol = np.zeros(n)
    at = me.color_attributes.get('HairTone')
    if at is not None:
        C = np.zeros(len(me.loops) * 4); at.data.foreach_get('color', C); C = C.reshape(-1, 4)
        vi = np.zeros(len(me.loops), int); me.loops.foreach_get('vertex_index', vi)
        tcol[vi] = C[:, 0]
    w = width * (1 - (1 - tip) * np.clip(tcol, 0, 1))
    me.vertices.foreach_set('co', (P + VN * w[:, None]).reshape(-1))
    me.flip_normals()
    if hasattr(me, 'normals_split_custom_set'):
        try:
            me.free_normals_split()
        except Exception:
            pass
    m = bpy.data.materials.get(me.name + '_mat') or bpy.data.materials.new(me.name + '_mat')
    m.use_nodes = True; m.use_backface_culling = True
    nt = m.node_tree; nt.nodes.clear()
    e = nt.nodes.new('ShaderNodeEmission'); e.inputs[0].default_value = (*pal.ink, 1)
    o = nt.nodes.new('ShaderNodeOutputMaterial'); nt.links.new(e.outputs[0], o.inputs[0])
    m['toon'] = 1; m['ink'] = list(pal.ink)
    me.materials.clear(); me.materials.append(m)
    for p in me.polygons:
        p.use_smooth = True; p.material_index = 0
    ob['no_outline'] = 1
    out['ink'] = ob
    return ob


def dump_npz(o, path, mat_names=None):
    """Stage-2 part dump: triangulated, per-corner split mesh in glTF space (x, z, -y), shading normals from the
    corner (custom) normals, weights by bone name (top 4). Same format as the anime builds' stage-2 dump()."""
    dg = bpy.context.evaluated_depsgraph_get()
    ev = o.evaluated_get(dg)
    me = ev.to_mesh()
    me.calc_loop_triangles()
    uvl = me.uv_layers.active
    M = np.array(o.matrix_world)
    groups = {g.index: g.name for g in o.vertex_groups}
    vw = []
    for v in me.vertices:
        ws = sorted(((g.weight, groups[g.group]) for g in v.groups if g.weight > 1e-4 and g.group in groups), reverse=True)[:4]
        tot = sum(w for w, _ in ws) or 1.0
        vw.append([(nm, w / tot) for w, nm in ws])
    CN = np.zeros(len(me.loops) * 3); me.corner_normals.foreach_get('vector', CN); CN = CN.reshape(-1, 3)
    VC = np.array([v.co for v in me.vertices]) if len(me.vertices) else np.zeros((0, 3))
    keys, P, Nn, UV, W, Jn, tris, mats, bone_names, bidx = {}, [], [], [], [], [], [], [], [], {}
    for lt in me.loop_triangles:
        tri = []
        for li in lt.loops:
            vi = me.loops[li].vertex_index
            uv = tuple(uvl.data[li].uv) if uvl else (0.0, 0.0)
            n = CN[li]
            key = (vi, round(uv[0], 5), round(uv[1], 5), round(n[0], 2), round(n[1], 2), round(n[2], 2))
            k = keys.get(key)
            if k is None:
                k = len(P); keys[key] = k
                co = M[:3, :3] @ VC[vi] + M[:3, 3]
                nn = M[:3, :3] @ n; nn /= np.linalg.norm(nn) + 1e-12
                P.append((co[0], co[2], -co[1])); Nn.append((nn[0], nn[2], -nn[1])); UV.append((uv[0], 1 - uv[1]))
                jj, ww = [0, 0, 0, 0], [0.0] * 4
                for s_, (bn, w) in enumerate(vw[vi]):
                    if bn not in bidx:
                        bidx[bn] = len(bone_names); bone_names.append(bn)
                    jj[s_] = bidx[bn]; ww[s_] = w
                Jn.append(jj); W.append(ww)
            tri.append(k)
        tris.append(tri)
        mn = o.material_slots[lt.material_index].material.name if o.material_slots else 'none'
        mats.append((mat_names or {}).get(mn, mn))
    names = sorted(set(mats))
    mi = np.array([names.index(m_) for m_ in mats], np.int32)
    np.savez_compressed(path, P=np.array(P, np.float32), N=np.array(Nn, np.float32), UV=np.array(UV, np.float32),
                        J=np.array(Jn, np.int32), W=np.array(W, np.float32), T=np.array(tris, np.int32), M=mi,
                        mat_names=np.array(names), bones=np.array(bone_names or ['J_Bip_C_Head']))
    ev.to_mesh_clear()
    print(f'DUMP {os.path.basename(path)}: {len(P)} verts, {len(tris)} tris, mats {names}, bones {len(bone_names)}')


def export_npz(out, res, out_dir, head_bone='J_Bip_C_Head', material='Anime_Hair', ink_material='Anime_HairInk',
               joints=2, rigid_until=0.3, prefix='HairLock'):
    """Stage-2 export: spring-chain weights on the clumps (one chain per chained clump group), the scalp rigid on
    the head and JOINED into the hair (one mesh, one material = one draw call), the ink hull with the same weights,
    hair_bones.json (glTF space) for the VRM assembly."""
    import json
    os.makedirs(out_dir, exist_ok=True)
    hair, scalp = out['hair'], out['scalp']
    specs = hk.chain_weights(out['builder'], hair, head_bone, res.chains, joints=joints, rigid_until=rigid_until,
                            prefix=prefix)
    ink = out.get('ink')
    if ink is not None:           # re-copy weights onto the hull (it was made before the chains existed)
        for g in list(ink.vertex_groups):
            ink.vertex_groups.remove(g)
        for g in hair.vertex_groups:
            ink.vertex_groups.new(name=g.name)
        for v in hair.data.vertices:
            for g in v.groups:
                ink.vertex_groups[hair.vertex_groups[g.group].name].add([v.index], g.weight, 'REPLACE')
    g = scalp.vertex_groups.get(head_bone) or scalp.vertex_groups.new(name=head_bone)
    g.add(list(range(len(scalp.data.vertices))), 1.0, 'REPLACE')
    rename = {out['material'].name: material} if out.get('material') else {}
    # hair + scalp -> one object
    hc = hair.copy(); hc.data = hair.data.copy(); bpy.context.scene.collection.objects.link(hc)
    sc = scalp.copy(); sc.data = scalp.data.copy(); bpy.context.scene.collection.objects.link(sc)
    with bpy.context.temp_override(active_object=hc, selected_editable_objects=[hc, sc], selected_objects=[hc, sc]):
        bpy.ops.object.join()
    dump_npz(hc, os.path.join(out_dir, 'Hair.npz'), rename)
    bpy.data.objects.remove(hc, do_unlink=True)
    if ink is not None:
        dump_npz(ink, os.path.join(out_dir, 'Hair_Ink.npz'), {ink.data.materials[0].name: ink_material})
    json.dump([{'name': b['name'], 'parent': b['parent'], 'head': [b['head'][0], b['head'][2], -b['head'][1]], 'end': b['end']}
               for b in specs], open(os.path.join(out_dir, 'hair_bones.json'), 'w'), indent=1)
    print(f'EXPORT hair: {len(specs)} joints, {len(res.chains)} chains -> {out_dir}')
    return specs


def build(F, res, name='Hair', tex_path=None, normals=True, proxy_kw=None, rng_seed=5, fill=True, style=None):
    """Returns dict(hair=obj, scalp=obj, ties=[...], builder=HairBuilder, material=mat, filled=n).
    style=None: the original behaviour (unchanged). style='drawn' (Live2D / drawn-art pipeline): per-clump shell
    winding by signed volume and hk.drawn_normals (every lock ring shades with the smooth mass normal at its guide)."""
    rng = np.random.default_rng(rng_seed)
    filled = 0
    for it in range(2 if fill else 1):
        hb = hk.HairBuilder(F)
        if style == 'drawn':
            hb.orient = 'volume'
        for c in res.clumps:
            hb.add(c, rng=np.random.default_rng(rng_seed))
        hair = hb.to_object(name)
        if not fill or it == 1:
            break
        gaps = coverage_gaps(F, hair, res.hairline)
        if not gaps:
            break
        filled = fill_gaps(F, res, gaps, rng)
        print(f'coverage: {len(gaps)} bare scalp samples -> {filled} filler clumps')
        me = hair.data
        bpy.data.objects.remove(hair, do_unlink=True); bpy.data.meshes.remove(me)
    scalp = hk.make_scalp(F, name + 'Scalp', offset=res.scalp_offset, hairline=res.hairline)
    ties = [make_tie(c, a, r, f'{name}Tie{i}') for i, (c, a, r) in enumerate(res.ties)]
    if normals and style == 'drawn':
        proxy = hk.clean_normals([hair, scalp], keep_proxy=True, **(proxy_kw or {}))
        n = hk.drawn_normals(hair, hb, proxy)
        hk.shell_normals(scalp, proxy)
        print(f'drawn normals: {n} lock rings shaded from the smooth mass')
        bpy.data.objects.remove(proxy, do_unlink=True)
    elif normals:
        hk.clean_normals([hair, scalp], **(proxy_kw or {}))
    mat = None
    if tex_path:
        hk.hair_texture(res.palette, tex_path)
        mat = hk.hair_material(name + '_mat', tex_path, res.palette)
        for o in (hair, scalp):
            o.data.materials.clear(); o.data.materials.append(mat)
    return {'hair': hair, 'scalp': scalp, 'ties': ties, 'builder': hb, 'material': mat, 'filled': filled}
