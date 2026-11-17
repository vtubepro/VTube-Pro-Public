"""Builds tools/launcher/vtubepro.ico (the desktop-shortcut icon): the studio's logo mark (the frog on the green-to-blue
rounded tile, same colours as the top bar / loading screen). Needs Pillow. Run: python tools/launcher/make_icon.py"""
import os
from PIL import Image, ImageDraw, ImageFont

HERE = os.path.dirname(os.path.abspath(__file__))
S = 1024  # draw big, downsample for crisp small sizes


def tile():
    grad = Image.new('RGBA', (S, S))
    a, b = (0x7b, 0xd8, 0x8f), (0x6c, 0xc7, 0xf5)
    px = grad.load()
    for y in range(S):
        for x in range(S):
            t = (x + y) / (2 * S - 2)
            px[x, y] = tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3)) + (255,)
    mask = Image.new('L', (S, S), 0)
    ImageDraw.Draw(mask).rounded_rectangle((0, 0, S - 1, S - 1), radius=int(S * 0.28), fill=255)
    out = Image.new('RGBA', (S, S), (0, 0, 0, 0))
    out.paste(grad, (0, 0), mask)
    return out


def frog(img):
    try:  # Windows' colour emoji font gives the exact mark the app shows
        f = ImageFont.truetype(os.path.join(os.environ.get('WINDIR', r'C:\Windows'), 'Fonts', 'seguiemj.ttf'), 109)
        g = Image.new('RGBA', (160, 160), (0, 0, 0, 0))
        ImageDraw.Draw(g).text((80, 84), '\U0001F438', font=f, embedded_color=True, anchor='mm')
        if g.getbbox() and len(g.convert('RGB').getcolors(1 << 16) or []) > 8:
            g = g.resize((int(S * 0.8), int(S * 0.8)), Image.LANCZOS)
            img.alpha_composite(g, (int(S * 0.1), int(S * 0.11)))
            return
    except Exception:
        pass
    d = ImageDraw.Draw(img)  # fallback: a simple drawn frog face
    d.ellipse((190, 330, 834, 860), fill=(52, 168, 83))
    for cx in (345, 679):
        d.ellipse((cx - 130, 200, cx + 130, 460), fill=(52, 168, 83))
        d.ellipse((cx - 85, 245, cx + 85, 415), fill=(255, 255, 255))
        d.ellipse((cx - 40, 290, cx + 40, 370), fill=(20, 24, 32))
    d.arc((330, 520, 694, 760), 20, 160, fill=(20, 60, 30), width=28)


img = tile()
frog(img)
img.save(os.path.join(HERE, 'vtubepro.ico'), sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
img.resize((256, 256), Image.LANCZOS).save(os.path.join(HERE, 'vtubepro_preview.png'))
print('wrote vtubepro.ico')
