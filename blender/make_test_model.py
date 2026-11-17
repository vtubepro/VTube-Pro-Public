"""Dev helper: build a simple test character (body sphere + head + arms + legs) and export GLB.

params: {"output": "<path.glb>", "shape_keys": true}
Used by the server's self-tests; not part of the runtime pipeline.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import bpy  # noqa: E402
import common  # noqa: E402


def mat(name, rgba):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    m.node_tree.nodes["Principled BSDF"].inputs["Base Color"].default_value = rgba
    return m


def main(p):
    common.reset_scene()
    green = mat("Skin", (0.3, 0.7, 0.3, 1))
    blue = mat("Cloth", (0.2, 0.3, 0.8, 1))
    parts = []
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.25, location=(0, 0, 1.05), segments=24, ring_count=12)
    body = bpy.context.object; body.scale = (1, 0.8, 1.4); body.name = "Body"; body.data.materials.append(blue); parts.append(body)
    bpy.ops.mesh.primitive_uv_sphere_add(radius=0.16, location=(0, 0, 1.55), segments=24, ring_count=12)
    head = bpy.context.object; head.name = "Head"; head.data.materials.append(green); parts.append(head)
    for side in (1, -1):
        bpy.ops.mesh.primitive_cube_add(size=1, location=(side * 0.45, 0, 1.3))
        arm = bpy.context.object; arm.scale = (0.55, 0.08, 0.08); arm.name = f"Arm{side}"; arm.data.materials.append(green); parts.append(arm)
        bpy.ops.mesh.primitive_cube_add(size=1, location=(side * 0.12, 0, 0.45))
        leg = bpy.context.object; leg.scale = (0.1, 0.1, 0.9); leg.name = f"Leg{side}"; leg.data.materials.append(blue); parts.append(leg)
    for o in parts:
        o.select_set(True)
    bpy.context.view_layer.objects.active = body
    bpy.ops.object.transform_apply(location=False, rotation=True, scale=True)
    if p.get("subdivide", True):
        # plain (non-smoothing) cuts so bone heat has vertices along the limbs
        for o in parts:
            if o.name.startswith(("Arm", "Leg")):
                bpy.ops.object.select_all(action="DESELECT")
                bpy.context.view_layer.objects.active = o
                o.select_set(True)
                bpy.ops.object.mode_set(mode="EDIT")
                bpy.ops.mesh.select_all(action="SELECT")
                bpy.ops.mesh.subdivide(number_cuts=6)
                bpy.ops.object.mode_set(mode="OBJECT")
    if p.get("shape_keys", True):
        head.shape_key_add(name="Basis")
        k = head.shape_key_add(name="puff")
        for v in k.data:
            v.co = v.co * 1.2
    common.export_glb(p["output"])
    return {"output": p["output"]}


common.run_main(main)
