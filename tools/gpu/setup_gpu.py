"""Kept for older notes: the GPU setup is now tools/gpu/gpu_setup.ts (Node only, no Python needed beforehand),
also behind the app's "Set up GPU tracking" button and setup.ps1 -Gpu. This forwards to it.

  python tools/gpu/setup_gpu.py [--check | --dry-run | --uninstall] [--parts runtime,a2f,rtmw,maxine]
"""
import os
import subprocess
import sys

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
args = ['--status' if a == '--check' else a for a in sys.argv[1:] if a != '--rtmw']
sys.exit(subprocess.call('npx tsx tools/gpu/gpu_setup.ts ' + ' '.join(args), cwd=ROOT, shell=True))
