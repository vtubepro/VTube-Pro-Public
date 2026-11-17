"""Costume GLBs for the app's wardrobe, built against the finished avatar skeleton."""
from __future__ import annotations


def build_all(m, specs, ctx):
    if not specs:
        return []
    from . import costume_build
    return [costume_build.build(m, s, ctx) for s in specs]
