# VTube Pro on Linux

How to run VTube Pro on a Linux PC (best effort), what the browser needs, and where Linux differs from Windows: Flatpak
and Snap browsers, software 3D, and Blender.

## 1. Run it

VTube Pro runs from the folder you downloaded, as on Windows: a small local server plus the studio in your browser.

1. Get **Node.js 22.12 or newer** (the LTS from <https://nodejs.org>, or your distribution's package if it is new
   enough).
2. Unzip VTube Pro (or `git clone https://github.com/vtubepro/VTube-Pro-Public.git`) anywhere in your home folder.
3. In a terminal in that folder: `./setup.sh` the first time (it gets everything ready, builds, starts the server and
   opens the studio), and `./setup.sh --quick` on later days.
4. The studio is at **http://127.0.0.1:5191/**. That address only works on your own PC.

Useful options: `--port N` (another port), `--no-browser` (do not open a tab), `--detach` (keep it running after the
terminal closes), `--stop` (stop the copy it started). `./setup.sh --help` lists them all. Nothing is installed
system-wide, and nothing needs Flatpak.

## 2. Browsers on Linux

- **Reaching VTube Pro:** Flatpak browsers share the host network and Snap browsers use it directly, so
  `http://127.0.0.1:5191` works from Chrome / Chromium / Brave / Edge / Firefox in any packaging.
- **Camera:** Ubuntu's Snap Firefox / Chromium connect their `camera` interface by default; if a camera is not offered:
  `sudo snap connect firefox:camera`. Flathub browsers normally come with camera access (Flatseal shows it under "Devices").
- **No graphics card in the browser ("software 3D"):** see the next section.

## 3. Software 3D

A browser without its graphics card still offers WebGL 2, drawn by the processor (Chrome's SwiftShader, Mesa's llvmpipe /
softpipe / lavapipe). Typical on Linux: a Flatpak browser after an NVIDIA driver update, until `flatpak update`
installs the matching `org.freedesktop.Platform.GL.nvidia-<version>` extension; hardware acceleration switched off; a
blocklisted driver; a virtual machine.

`src/stage/gfx/softwareGl.ts` detects it from the renderer string and the studio switches by itself to a light preset:
graphics preset Low, the studio loop at 30 Hz, its own preview every other loop (15 fps, 0.3 MP), every tracking model
on the processor (MediaPipe's CPU path; a stored "Graphics card" choice still wins), the hidden-window ticker after
250 ms. A notice says so in one sentence and gives the one most likely fix in one sentence with a Copy button
(Linux Chrome: "run flatpak update if your browser is a Flatpak, then switch on Use graphics acceleration when
available in chrome://settings/system and press Relaunch"), with more ways folded below (`flatpak override --user
--device=dri <app id>`, the distro-package browser, drivers, the blocklist flag last). "Full quality anyway" stores
`vtp.softGl = off`.

The loading screen opens the studio anyway when the avatar fails to load (the studio's message says why) and after 40 s
without progress (`src/ui/splash.ts`), so it never waits forever at 96 %.

## 4. Blender on Linux

VTube Pro finds Blender 4.2+ (`shared/blenderSetup.ts` `BLENDER_MIN`). Distro packages: Debian 12 ships 3.4 (too old),
Ubuntu 24.04 (and Mint 22 / Pop 24.04 / Zorin 17 on it) 4.0 (too old), Debian 13 4.3 (works). So:
- **Ubuntu family:** the Snap (`sudo snap install blender --classic`, current, classic confinement = no sandbox
  limits), or the official tarball. **Mint:** Flathub via the Software Manager (Mint ships Flathub) or the tarball.
- **Debian:** the official tarball unpacked into the home folder (no root, any version); `apt install blender` only on
  Debian 13+.
- **Immutable (Bazzite, SteamOS, Silverblue):** the official tarball in the home folder first (no sandbox: Blender can
  read every model path VTube Pro gives it), Flathub `org.blender.Blender` second (works with files under home, which
  the Flatpak can read).
- Never a PPA or a third-party repository.

## 5. If something is wrong

- The server log is `.setup-state/server.err.log` in the VTube Pro folder.
- Stop it with `./setup.sh --stop`.
- Bugs and questions: <https://github.com/vtubepro/VTube-Pro-Public/issues> (never paste keys or passwords).
