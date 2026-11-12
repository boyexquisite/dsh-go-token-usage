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

WIDTH = 810
MARGIN = 40
ROW_HEIGHT = 112
ROW_GAP = 12
RADIUS = 22
BG = "#FFFFFF"
INK = "#1B2130"
MUTED = "#6B7385"
MODELS_BG = "#F4F6FB"
DIVIDER = "#E4E9F2"

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
    """Blend a colour into white, like the app's tinted cards."""
    value = hex_color.lstrip("#")
    rgb = tuple(int(value[i : i + 2], 16) for i in (0, 2, 4))
    bg = (255, 255, 255)
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

    models_height = 0
    if models:
        models_height = 86 + 46 * len(models) + 20

    height = 150 + len(rows) * (ROW_HEIGHT + ROW_GAP) + 16 + models_height + 64
    image = Image.new("RGB", (WIDTH, height), BG)
    draw = ImageDraw.Draw(image)

    title_font = font(40, bold=True)
    subtitle_font = font(19)
    label_font = font(22, bold=True)
    value_font = font(42, bold=True)
    unit_font = font(18)
    meta_font = font(19)
    extra_font = font(17)
    section_font = font(23, bold=True)
    head_font = font(17)
    model_font = font(23)
    model_meta_font = font(19)
    footer_font = font(16)

    x = MARGIN
    right = WIDTH - MARGIN

    draw.text((x, 42), data.get("title", ""), font=title_font, fill=INK)
    draw.text((x, 94), data.get("subtitle", ""), font=subtitle_font, fill=MUTED)

    y = 150
    for row in rows:
        color = row.get("color", "#3D6FD6")
        draw.rounded_rectangle((x, y, right, y + ROW_HEIGHT), radius=RADIUS, fill=tint(color))
        pad = 24
        draw.text((x + pad, y + 16), row.get("label", ""), font=label_font, fill=color)
        value = row.get("value", "—")
        draw.text((x + pad, y + 42), value, font=value_font, fill=color)
        unit = row.get("unit", "")
        if unit:
            draw.text((x + pad + draw.textlength(value, font=value_font) + 8, y + 62), unit, font=unit_font, fill=MUTED)
        meta = row.get("meta", "")
        if meta:
            draw.text((right - pad - draw.textlength(meta, font=meta_font), y + 20), meta, font=meta_font, fill=MUTED)
        extra = row.get("extra", "")
        if extra:
            draw.text((right - pad - draw.textlength(extra, font=extra_font), y + 62), extra, font=extra_font, fill=MUTED)
        y += ROW_HEIGHT + ROW_GAP

    if models:
        y += 4
        card_top = y
        card_bottom = y + models_height
        draw.rounded_rectangle((x, card_top, right, card_bottom), radius=RADIUS, fill=MODELS_BG)
        pad = 24
        draw.text((x + pad, y + 18), data.get("modelsTitle", ""), font=section_font, fill=INK)
        header_y = y + 54
        col_source = x + pad + 300
        draw.text((x + pad, header_y), data.get("modelCol", ""), font=head_font, fill=MUTED)
        draw.text((col_source, header_y), data.get("sourceCol", ""), font=head_font, fill=MUTED)
        tokens_head = data.get("tokensCol", "")
        draw.text((right - pad - draw.textlength(tokens_head, font=head_font), header_y), tokens_head, font=head_font, fill=MUTED)
        row_y = header_y + 24
        for index, model in enumerate(models):
            if index > 0:
                draw.line((x + pad, row_y - 2, right - pad, row_y - 2), fill=DIVIDER, width=1)
            name = fit(draw, model.get("name", ""), model_font, col_source - (x + pad) - 16)
            draw.text((x + pad, row_y + 10), name, font=model_font, fill=INK)
            source = model.get("source", "")
            if source:
                draw.text((col_source, row_y + 13), source, font=model_meta_font, fill=MUTED)
            value = model.get("value", "")
            draw.text((right - pad - draw.textlength(value, font=model_font), row_y + 10), value, font=model_font, fill=INK)
            row_y += 46

    footer = data.get("footer", "")
    if footer:
        footer_width = draw.textlength(footer, font=footer_font)
        draw.text(((WIDTH - footer_width) / 2, height - 34), footer, font=footer_font, fill=MUTED)

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
