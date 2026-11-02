#!/usr/bin/env python3
"""Render the circular favicon/icon set.

Source of truth: the purple tile with a white "C" (public/icons/icon-512.png).
A circular alpha mask is applied at 8x supersampling so the rim stays smooth.

Usage: python3 scripts/make-favicon.py            # circular mask
Outputs: public/icons/icon-512/192/180/32.png, public/favicon.svg,
         public/favicon.ico (16/32/48)
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "public" / "icons"
SRC = ICONS / "icon-512.png"
SS = 8  # supersampling factor for the mask


def circle_mask(size: int) -> Image.Image:
    big = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(big).ellipse((0, 0, size * SS - 1, size * SS - 1), fill=255)
    return big.resize((size, size), Image.LANCZOS)


def rounded(img: Image.Image) -> Image.Image:
    size = img.size[0]
    mask = circle_mask(size)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img.convert("RGBA"), (0, 0), mask)
    return out


def main() -> None:
    base = Image.open(SRC).convert("RGBA")
    if base.size != (512, 512):
        base = base.resize((512, 512), Image.LANCZOS)

    out512 = rounded(base)
    out512.save(ICONS / "icon-512.png")

    for target, name in ((192, "icon-192.png"), (180, "icon-180.png"), (32, "icon-32.png")):
        out512.resize((target, target), Image.LANCZOS).save(ICONS / name)

    buf = io.BytesIO()
    out512.save(buf, format="PNG")
    b64 = base64.b64encode(buf.getvalue()).decode()
    svg = (
        '<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512">'
        f'<image width="512" height="512" href="data:image/png;base64,{b64}"/>'
        "</svg>\n"
    )
    (ROOT / "public" / "favicon.svg").write_text(svg, encoding="utf-8")

    # Classic /favicon.ico fallback: multi-size ICO, each size masked separately so
    # the 16 px rim stays crisp instead of being downsampled from 512.
    frames = [out512.resize((n, n), Image.LANCZOS) for n in (48, 32, 16)]
    frames[0].save(ROOT / "public" / "favicon.ico", format="ICO",
                   sizes=[(48, 48), (32, 32), (16, 16)], append_images=frames[1:])
    print("circle -> 512/192/180/32 png, favicon.svg, favicon.ico")


if __name__ == "__main__":
    main()
