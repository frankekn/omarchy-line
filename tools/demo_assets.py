#!/usr/bin/env python3
"""Draws the pictures the stub's demo fixtures serve (docs/images/demo/).

Everything is generated here from shapes and gradients with ImageMagick, so
there is nothing to license: initial avatars for every person and chat in
daemon/stub.py's DEMO_PEOPLE, three photo-like scenes, a two-card FLEX
carousel and one sticker. Deterministic; rerun after changing DEMO_PEOPLE.

    tools/demo_assets.py            # writes docs/images/demo/
"""

import importlib.util
import os
import random
import shutil
import subprocess
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "docs", "images", "demo")
FONT = "Noto-Sans-CJK-TC-Medium"

# Mid-tone, slightly muted: white initials stay readable, and none of them
# shouts against the dark panel.
PALETTE = ("#D9735B", "#D69A3C", "#5E9E6E", "#3E9294", "#4A84C1",
           "#6A71C2", "#9268BA", "#C0648F")


def load_stub():
    spec = importlib.util.spec_from_file_location(
        "stub", os.path.join(ROOT, "daemon", "stub.py"))
    stub = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(stub)
    return stub


def magick(*args):
    subprocess.run(["magick", *args], check=True)


def png(path, size=None):
    resize = ["-resize", size] if size else []
    return [*resize, "-depth", "8", "-strip", "-define", "png:compression-level=9", path]


def jpg(path):
    return ["-strip", "-quality", "84", "-sampling-factor", "4:2:0",
            "-interlace", "JPEG", path]


def lighter(hex_color, amount):
    r, g, b = (int(hex_color[i:i + 2], 16) for i in (1, 3, 5))
    mix = lambda c: round(c + (255 - c) * amount)
    return "#%02X%02X%02X" % (mix(r), mix(g), mix(b))


def avatar(path, initials, color):
    size = 256
    point = 112 if len(initials) == 1 else 92
    magick("-size", "%dx%d" % (size, size),
           "-define", "gradient:direction=SouthEast",
           "gradient:%s-%s" % (lighter(color, 0.28), color),
           "-font", FONT, "-pointsize", str(point), "-fill", "#FFFFFF",
           "-gravity", "center", "-annotate", "+0+4", initials,
           *png(path))


def photo_coast(path):
    """Sunset over the sea, a headland on the left."""
    w, h, horizon = 960, 720, 430
    shimmer = []
    rnd = random.Random(7)
    for _ in range(90):
        y = rnd.randint(horizon + 6, h - 10)
        spread = (y - horizon) * 1.1 + 20
        x = 600 + rnd.uniform(-spread, spread)
        length = rnd.uniform(10, 40) * (1 + (y - horizon) / 200)
        shimmer += ["-draw", "line %d,%d %d,%d" % (x, y, x + length, y)]
    magick(
        "-size", "%dx%d" % (w, horizon),
        "gradient:#2E3A6B-#F4A06A",
        "(", "-size", "%dx%d" % (w, h - horizon), "gradient:#E8956C-#1E2B4A", ")",
        "-append",
        # glow, then the sun itself
        "(", "-size", "%dx%d" % (w, h), "xc:none", "-fill", "#FFD9A0C0",
        "-draw", "circle 600,%d 600,%d" % (horizon - 30, horizon - 160),
        "-blur", "0x60", ")", "-composite",
        "-fill", "#FFF0C8", "-draw", "circle 600,%d 600,%d" % (horizon - 30, horizon - 78),
        # the sea covers the lower part of the sun
        "(", "-size", "%dx%d" % (w, h - horizon), "gradient:#E08F6A-#1E2B4A", ")",
        "-geometry", "+0+%d" % horizon, "-composite",
        "-stroke", "#FFE2B088", "-strokewidth", "3", *shimmer, "-stroke", "none",
        # far headland, then the near cliff
        "-fill", "#5B4A6E",
        "-draw", "polygon 0,%d 120,%d 260,%d 380,%d 420,%d 0,%d" % (
            horizon - 70, horizon - 110, horizon - 60, horizon - 18, horizon, horizon),
        "-fill", "#2A2238",
        "-draw", "polygon 0,%d 90,%d 180,%d 240,%d 300,%d 340,%d 300,%d 0,%d" % (
            horizon - 160, horizon - 190, horizon - 120, horizon - 30, horizon + 60,
            h - 140, h, h),
        "-blur", "0x1.2",
        "-attenuate", "0.25", "+noise", "Gaussian",
        *jpg(path))


def photo_skyline(path):
    """A city at dusk from a rooftop."""
    w, h = 960, 720
    rnd = random.Random(11)
    far, near, windows = [], [], []
    x = -20
    while x < w:
        bw = rnd.randint(40, 90)
        top = rnd.randint(260, 430)
        far += ["-draw", "rectangle %d,%d %d,%d" % (x, top, x + bw, h)]
        x += bw + rnd.randint(-10, 6)
    x = -10
    while x < w:
        bw = rnd.randint(60, 130)
        top = rnd.randint(330, 560)
        near += ["-draw", "rectangle %d,%d %d,%d" % (x, top, x + bw, h)]
        for wy in range(top + 18, h - 120, 22):
            for wx in range(x + 10, x + bw - 12, 16):
                if rnd.random() < 0.38:
                    windows += ["-draw", "rectangle %d,%d %d,%d" % (wx, wy, wx + 7, wy + 10)]
        x += bw + rnd.randint(4, 14)
    magick(
        "-size", "%dx%d" % (w, h), "gradient:#1C2547-#E98E72",
        "(", "-size", "%dx%d" % (w, h), "xc:none", "-fill", "#FFB38A90",
        "-draw", "ellipse 300,520 420,120 0,360", "-blur", "0x70", ")", "-composite",
        "(", "-size", "%dx%d" % (w, h), "xc:none", "-fill", "#4A4566", *far,
        "-blur", "0x2", ")", "-composite",
        "-fill", "#1A1C2E", *near,
        "-fill", "#FFD27A", *windows,
        # the rooftop rail in the foreground
        "-fill", "#0E0F18", "-draw", "rectangle 0,%d %d,%d" % (h - 70, w, h),
        "-draw", "rectangle 0,%d %d,%d" % (h - 150, w, h - 140),
        *sum((["-draw", "rectangle %d,%d %d,%d" % (px, h - 150, px + 8, h - 70)]
              for px in range(20, w, 120)), []),
        "-blur", "0x0.8",
        "-attenuate", "0.3", "+noise", "Gaussian",
        *jpg(path))


def photo_dinner(path):
    """Braised pork on rice, from above, on a wooden table."""
    w, h = 960, 720
    cx, cy = 470, 370
    rnd = random.Random(5)
    pork, highlights = [], []
    for _ in range(55):
        # a heap: denser in the middle
        px = cx - 40 + rnd.gauss(0, 46)
        py = cy - 30 + rnd.gauss(0, 38)
        s = rnd.randint(26, 44)
        shade = rnd.choice(("#6A2C12", "#7A3818", "#8B4520", "#5C2510"))
        pork += ["-fill", shade, "-draw", "roundrectangle %d,%d %d,%d 7,7" % (
            px, py, px + s, py + s * rnd.uniform(0.7, 1.1))]
        if rnd.random() < 0.5:
            highlights += ["-draw", "roundrectangle %d,%d %d,%d 3,3" % (
                px + 4, py + 3, px + s // 2, py + 7)]
    magick(
        # table: streaked noise turned into grain, then tinted; drawn wider so
        # the blur's edges fall outside the frame
        "-size", "%dx%d" % (w + 400, h), "xc:", "+noise", "Random",
        "-colorspace", "Gray", "-motion-blur", "0x80+0",
        "-level", "35%,65%", "+level-colors", "#5A3720,#9C6A43",
        "-gravity", "center", "-extent", "%dx%d" % (w, h), "+gravity",
        # plate shadow, plate, rim
        "(", "-size", "%dx%d" % (w, h), "xc:none", "-fill", "#00000070",
        "-draw", "circle %d,%d %d,%d" % (cx + 14, cy + 18, cx + 14, cy - 262),
        "-blur", "0x18", ")", "-composite",
        "-fill", "#F4F1EA", "-draw", "circle %d,%d %d,%d" % (cx, cy, cx, cy - 280),
        "-fill", "#E4DFD3", "-draw", "circle %d,%d %d,%d" % (cx, cy, cx, cy - 226),
        # rice with a little grain, a sauce stain, the pork heap
        "(", "-size", "%dx%d" % (w, h), "xc:#FFFCF2", "-attenuate", "0.6",
        "+noise", "Gaussian", "-blur", "0x1.5",
        "(", "-size", "%dx%d" % (w, h), "xc:black", "-fill", "white",
        "-draw", "circle %d,%d %d,%d" % (cx, cy, cx, cy - 205), ")",
        "-alpha", "off", "-compose", "CopyOpacity", "-composite", ")",
        "-compose", "Over", "-composite",
        "(", "-size", "%dx%d" % (w, h), "xc:none", "-fill", "#8A4A2299",
        "-draw", "circle %d,%d %d,%d" % (cx - 15, cy - 5, cx - 15, cy - 120),
        "-blur", "0x22", ")", "-composite",
        *pork,
        "-fill", "#B87445", *highlights,
        "-fill", "#4E8A3A",
        "-draw", "ellipse %d,%d 62,26 20,340" % (cx + 120, cy + 90),
        "-draw", "ellipse %d,%d 58,24 -30,300" % (cx + 85, cy + 135),
        "-fill", "#8CC46A",
        "-draw", "ellipse %d,%d 36,10 20,340" % (cx + 110, cy + 86),
        "-draw", "ellipse %d,%d 32,9 -30,300" % (cx + 80, cy + 130),
        # a braised egg, halved
        "-fill", "#C98A4E", "-draw", "ellipse %d,%d 50,40 0,360" % (cx - 125, cy + 105),
        "-fill", "#E9A825", "-draw", "circle %d,%d %d,%d" % (cx - 122, cy + 105, cx - 122, cy + 82),
        # chopsticks
        "-fill", "#2B1D16",
        "-draw", "polygon 780,90 794,96 640,640 630,636",
        "-draw", "polygon 830,110 843,118 700,660 690,655",
        "-blur", "0x1",
        "-attenuate", "0.2", "+noise", "Gaussian",
        *jpg(path))


def flex_status(path):
    """Card one of the deploy carousel: a big success check."""
    w, h = 480, 560
    magick(
        "-size", "%dx%d" % (w, h), "gradient:#1F2A44-#16203A",
        "-fill", "#2E3D5F", "-draw", "roundrectangle 40,360 440,384 12,12",
        "-draw", "roundrectangle 40,410 360,434 12,12",
        "-draw", "roundrectangle 40,460 400,484 12,12",
        "-fill", "#3FB37F", "-draw", "roundrectangle 40,360 300,384 12,12",
        "(", "-size", "%dx%d" % (w, h), "xc:none", "-fill", "#3FB37F80",
        "-draw", "circle 240,190 240,70", "-blur", "0x30", ")", "-composite",
        "-fill", "#3FB37F", "-draw", "circle 240,190 240,90",
        "-fill", "none", "-stroke", "#FFFFFF", "-strokewidth", "22",
        "-draw", "polyline 192,192 228,228 292,154",
        *png(path, "360x420"))


def flex_latency(path):
    """Card two: p95 latency dropping and settling."""
    w, h = 480, 560
    pts = [(40, 150), (90, 170), (140, 140), (190, 230), (240, 330),
           (290, 380), (340, 372), (390, 385), (440, 378)]
    line = " ".join("%d,%d" % p for p in pts)
    area = line + " 440,470 40,470"
    grid = sum((["-draw", "line 40,%d 440,%d" % (y, y)] for y in (150, 250, 350, 450)), [])
    magick(
        "-size", "%dx%d" % (w, h), "gradient:#1F2A44-#16203A",
        "-stroke", "#2E3D5F", "-strokewidth", "2", *grid, "-stroke", "none",
        "(", "-size", "%dx%d" % (w, h), "gradient:#4FB3D9-#1F2A44",
        "(", "-size", "%dx%d" % (w, h), "xc:black", "-fill", "#808080",
        "-draw", "polygon " + area, ")",
        "-alpha", "off", "-compose", "CopyOpacity", "-composite", ")",
        "-compose", "Over", "-composite",
        "-fill", "none", "-stroke", "#4FB3D9", "-strokewidth", "8",
        "-draw", "polyline " + line,
        "-stroke", "none", "-fill", "#FFFFFF", "-draw", "circle 440,378 440,366",
        "-fill", "#2E3D5F", "-draw", "roundrectangle 40,500 260,524 12,12",
        "-draw", "roundrectangle 40,60 200,84 12,12",
        *png(path, "360x420"))


def sticker(path):
    """A round, happy mochi cat holding a heart."""
    s = 360
    outline, body = "#4A3B35", "#FFF1DC"
    shapes = [
        ("polygon", "92,110 112,30 168,82"),
        ("polygon", "268,110 248,30 192,82"),
        ("ellipse", "180,190 130,118 0,360"),
    ]

    def draw(fill, stroke, width):
        args = ["-fill", fill, "-stroke", stroke, "-strokewidth", str(width)]
        for kind, spec in shapes:
            args += ["-draw", "%s %s" % (kind, spec)]
        return args

    magick(
        "-size", "%dx%d" % (s, s), "xc:none",
        # the white die-cut border, then the outlined body over it
        *draw("#FFFFFF", "#FFFFFF", 34),
        *draw(body, outline, 8),
        "-stroke", "none", "-fill", "#F7B6A8",
        "-draw", "polygon 104,100 116,52 150,84",
        "-draw", "polygon 256,100 244,52 210,84",
        "-fill", "#F6A5A0",
        "-draw", "ellipse 108,200 22,13 0,360",
        "-draw", "ellipse 252,200 22,13 0,360",
        "-fill", "none", "-stroke", outline, "-strokewidth", "8",
        "-draw", "arc 112,150 152,190 200,340",
        "-draw", "arc 208,150 248,190 200,340",
        "-strokewidth", "6",
        "-draw", "arc 160,196 182,220 0,180",
        "-draw", "arc 178,196 200,220 0,180",
        # the heart and the paws holding it
        "-stroke", "#FFFFFF", "-strokewidth", "14", "-fill", "#FFFFFF",
        "-draw", "path 'M 180,322 C 120,282 128,236 160,240 C 172,242 178,252 180,260 "
                 "C 182,252 188,242 200,240 C 232,236 240,282 180,322 Z'",
        "-stroke", outline, "-strokewidth", "6", "-fill", "#F0647A",
        "-draw", "path 'M 180,322 C 120,282 128,236 160,240 C 172,242 178,252 180,260 "
                 "C 182,252 188,242 200,240 C 232,236 240,282 180,322 Z'",
        "-fill", body,
        "-draw", "ellipse 132,282 24,18 0,360",
        "-draw", "ellipse 228,282 24,18 0,360",
        *png(path))


def main():
    if not shutil.which("magick"):
        sys.exit("demo_assets.py: needs ImageMagick 7 (`magick`)")
    stub = load_stub()
    os.makedirs(OUT, exist_ok=True)
    colors = {k: PALETTE[i % len(PALETTE)]
              for i, k in enumerate(stub.DEMO_AVATAR_KEYS)}
    for locale, people in stub.DEMO_PEOPLE.items():
        for key, (_, initials) in people.items():
            avatar(os.path.join(OUT, "avatar-%s-%s.png" % (locale, key)),
                   initials, colors[key])
    photo_coast(os.path.join(OUT, "photo-coast.jpg"))
    photo_skyline(os.path.join(OUT, "photo-skyline.jpg"))
    photo_dinner(os.path.join(OUT, "photo-dinner.jpg"))
    flex_status(os.path.join(OUT, "flex-status.png"))
    flex_latency(os.path.join(OUT, "flex-latency.png"))
    sticker(os.path.join(OUT, "sticker.png"))
    print("wrote %s" % OUT)


if __name__ == "__main__":
    main()
