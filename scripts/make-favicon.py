#!/usr/bin/env python3
"""Render favicon assets with rounded-square corners.

Source of truth: public/icons/icon-512.png (purple tile with white "C").
Rounded corners are applied with a high-res alpha mask so edges stay smooth.

Usage: python3 scripts/make-favicon.py [radius_ratio]
Outputs: public/icons/icon-192.png, public/icons/icon-512.png,
         public/icons/icon-180.png (apple-touch), public/icons/icon-32.png,
         public/icons/icon.svg (rounded svg wrapper for browsers)
"""
import base64
import io
import sys
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent
ICONS = ROOT / "public" / "icons"
SRC = ICONS / "icon-512.png"
RATIO = float(sys.argv[1]) if len(sys.argv) > 1 else 0.22  # 22% ≈ squircle-ish
SS = 8  # supersampling factor for the mask


def rounded(img: Image.Image, ratio: float) -> Image.Image:
    size = img.size[0]
    r = round(size * ratio)
    big = Image.new("L", (size * SS, size * SS), 0)
    ImageDraw.Draw(big).rounded_rectangle(
        (0, 0, size * SS - 1, size * SS - 1), radius=r * SS, fill=255
    )
    mask = big.resize((size, size), Image.LANCZOS)
    out = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    out.paste(img.convert("RGBA"), (0, 0), mask)
    return out


def main() -> None:
    base = Image.open(SRC).convert("RGBA")
    if base.size != (512, 512):
        base = base.resize((512, 512), Image.LANCZOS)

    out512 = rounded(base, RATIO)
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
    print(f"rounded radius ratio={RATIO} -> 512/192/180/32 png + favicon.svg")


if __name__ == "__main__":
    main()
