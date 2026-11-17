"""Rigid accessories baked into the avatar (see props_lib for the meshes)."""
from __future__ import annotations


def apply(m, props, ctx):
    if props:
        from . import props_lib
        for p in props:
            props_lib.attach(m, p, ctx)
