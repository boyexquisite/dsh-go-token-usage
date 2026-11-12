#!/usr/bin/env python3
"""Render the dsh-go token usage card to a PNG.

Usage: python3 render.py <input.json> <output.png>

The JSON is built by lib/render.js. Kept dependency-light: Pillow only, and it
falls back to whatever CJK font the host has; without one, labels may show
tofu, but the call still succeeds.
"""
import json
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

WIDTH = 1080
MARGIN = 72
ROW_HEIGHT = 168
ROW_GAP = 20
RADIUS = 28
BG = "#F5F7FB"
INK = "#1B2130"
MUTED = "#6B7385"

FONT_REGULAR = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
FONT_BOLD = [
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]


def first_existing(paths):
    for path in paths:
        if Path(path).exists():
            return path
    return None


REGULAR_PATH = first_existing(FONT_REGULAR)
BOLD_PATH = first_existing(FONT_BOLD) or REGULAR_PATH


def font(size, bold=False):
    path = BOLD_PATH if bold else REGULAR_PATH
    if path is None:
        return ImageFont.load_default()
    try:
        return ImageFont.truetype(path, size)
    except OSError:
        return ImageFont.load_default()


def tint(hex_color, amount=0.10):
    """Blend a colour into the card background, like the app's tinted cards."""
    value = hex_color.lstrip("#")
    rgb = tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))
    bg = tuple(int(BG[i : i + 2], 16) for i in (1, 3, 5))
    return tuple(round(bg[i] * (1 - amount) + rgb[i] * amount) for i in range(3))


def fit(draw, text, fnt, max_width):
    if draw.textlength(text, font=fnt) <= max_width:
        return text
    ellipsis = "…"
    while text and draw.textlength(text + ellipsis, font=fnt) > max_width:
        text = text[:-1]
    return text + ellipsis


def render(data, output):
    rows = data.get("rows", [])
    models = data.get("models", [])
    models_title = data.get("modelsTitle", "")

    models_height = 0
    if models:
        models_height = 92 + 68 * len(models) + 24

    height = MARGIN + 96 + 40 + len(rows) * (ROW_HEIGHT + ROW_GAP) + models_height + 96 + MARGIN
    image = Image.new("RGB", (WIDTH, height), BG)
    draw = ImageDraw.Draw(image)

    title_font = font(58, bold=True)
    subtitle_font = font(26)
    label_font = font(30, bold=True)
    value_font = font(62, bold=True)
    unit_font = font(24)
    meta_font = font(26)
    small_font = font(22)
    model_font = font(28)
    model_meta_font = font(23)

    x = MARGIN
    right = WIDTH - MARGIN

    draw.text((x, MARGIN), data.get("title", ""), font=title_font, fill=INK)
    subtitle = data.get("subtitle", "")
    draw.text((x, MARGIN + 78), subtitle, font=subtitle_font, fill=MUTED)

    y = MARGIN + 96 + 40
    for row in rows:
        color = row.get("color", "#3D6FD6")
        draw.rounded_rectangle((x, y, right, y + ROW_HEIGHT), radius=RADIUS, fill=tint(color))
        draw.text((x + 32, y + 26), row.get("label", ""), font=label_font, fill=color)
        value = row.get("value", "—")
        draw.text((x + 32, y + 74), value, font=value_font, fill=color)
        value_width = draw.textlength(value, font=value_font)
        unit = row.get("unit", "")
        if unit:
            draw.text((x + 40 + value_width, y + 104), unit, font=unit_font, fill=MUTED)
        meta = row.get("meta", "")
        if meta:
            meta_width = draw.textlength(meta, font=meta_font)
            draw.text((right - 32 - meta_width, y + 36), meta, font=meta_font, fill=MUTED)
        extra = row.get("extra", "")
        if extra:
            extra_width = draw.textlength(extra, font=small_font)
            draw.text((right - 32 - extra_width, y + 96), extra, font=small_font, fill=MUTED)
        y += ROW_HEIGHT + ROW_GAP

    if models:
        draw.text((x, y + 18), models_title, font=label_font, fill=INK)
        y += 72
        for model in models:
            name = fit(draw, model.get("name", ""), model_font, 520)
            draw.text((x, y + 6), name, font=model_font, fill=INK)
            source = model.get("source", "")
            if source:
                draw.text((x, y + 42), source, font=model_meta_font, fill=MUTED)
            value = model.get("value", "")
            value_width = draw.textlength(value, font=model_font)
            draw.text((right - value_width, y + 6), value, font=model_font, fill=INK)
            y += 68

    footer = data.get("footer", "")
    if footer:
        footer_font = font(21)
        footer_width = draw.textlength(footer, font=footer_font)
        draw.text(((WIDTH - footer_width) / 2, height - MARGIN + 18), footer, font=footer_font, fill=MUTED)

    image.save(output, "PNG", optimize=True)
    return {"width": image.width, "height": image.height}


def main():
    if len(sys.argv) != 3:
        print("usage: render.py <input.json> <output.png>", file=sys.stderr)
        return 2
    with open(sys.argv[1], "r", encoding="utf-8") as handle:
        data = json.load(handle)
    info = render(data, sys.argv[2])
    print(json.dumps(info))
    return 0


if __name__ == "__main__":
    sys.exit(main())
