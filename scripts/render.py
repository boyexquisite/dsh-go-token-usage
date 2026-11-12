#!/usr/bin/env python3
"""Render the dsh-go token usage card to a PNG.

Usage: python3 render.py <input.json> <output.png>

The JSON is built by lib/render.js. Kept dependency-light: Pillow only, and it
falls back to whatever CJK font the host has; when no CJK font is available the
card is drawn with the English label set the host sends (`fallback`) instead of
silently filling every label with tofu boxes.
"""
import json
import os
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
# 17-19px regular text needs 4.5:1 against every painted background; #6B7385 was
# only 4.17-4.40:1, so the PNG was visibly lower contrast than the native panel
# (which the app auto-corrects). #5C6473 gives >= 5.2:1 on all card colours.
MUTED = "#5C6473"
MODELS_BG = "#F4F6FB"
DIVIDER = "#E4E9F2"

# Android/Termux hosts only ship fonts under these paths, so probe them first.
FONT_REGULAR = [
    "/system/fonts/NotoSansCJK-Regular.ttc",
    "/system/fonts/NotoSansCJKsc-Regular.otf",
    "/system/fonts/DroidSansFallback.ttf",
    "/data/data/com.termux/files/usr/share/fonts/TTF/NotoSansCJK-Regular.ttc",
    "/data/data/com.termux/files/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/data/data/com.termux/files/usr/share/fonts/NotoSansCJK-Regular.ttc",
    "/data/data/com.termux/files/usr/share/fonts/TTF/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Regular.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-zenhei.ttc",
    "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyh.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
]
FONT_BOLD = [
    "/system/fonts/NotoSansCJK-Bold.ttc",
    "/system/fonts/NotoSansCJKsc-Bold.otf",
    "/data/data/com.termux/files/usr/share/fonts/TTF/NotoSansCJK-Bold.ttc",
    "/data/data/com.termux/files/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/data/data/com.termux/files/usr/share/fonts/TTF/wqy-zenhei.ttc",
    "/usr/share/fonts/opentype/noto/NotoSansCJK-Bold.ttc",
    "/usr/share/fonts/truetype/noto/NotoSansCJK-Bold.ttc",
    "/System/Library/Fonts/PingFang.ttc",
    "C:/Windows/Fonts/msyhbd.ttc",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
]
# Test hook: pretend the host has no CJK font (exercises the English fallback).
FORCE_ASCII = os.environ.get("DSH_TOKEN_USAGE_FORCE_ASCII", "").strip().lower() not in ("", "0", "false")


def first_existing(paths):
    for path in paths:
        if Path(path).exists():
            return path
    return None


if FORCE_ASCII:
    REGULAR_PATH = first_existing(["/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"])
    BOLD_PATH = first_existing(["/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"]) or REGULAR_PATH
else:
    REGULAR_PATH = first_existing(FONT_REGULAR)
    BOLD_PATH = first_existing(FONT_BOLD) or REGULAR_PATH


def glyph_pixels(font, char):
    """Rasterise one glyph so two different hanzi can be compared reliably."""
    glyph = Image.new("L", (32, 32), 0)
    ImageDraw.Draw(glyph).text((0, 0), char, font=font, fill=255)
    return glyph.tobytes()


def supports_cjk(path):
    """Whether the chosen font really has CJK glyphs (two different hanzi differ)."""
    if path is None:
        return False
    try:
        probe = ImageFont.truetype(path, 24)
        return glyph_pixels(probe, "累") != glyph_pixels(probe, "今")
    except Exception:
        return False


CJK_OK = supports_cjk(REGULAR_PATH)


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


def safe_text_length(draw, text, fnt):
    """Pillow raises on multiline text; never let a label abort the whole card."""
    try:
        return draw.textlength(text, font=fnt)
    except Exception:
        size = getattr(fnt, "size", 16) or 16
        return len(text) * size * 0.6


def fit(draw, text, fnt, max_width):
    # Control characters/newlines from a model id or provider name must never
    # reach textlength (it raises "can't measure length of multiline text") or
    # draw multiple overlapping lines.
    text = " ".join(str(text).split())
    if not text:
        return text
    if safe_text_length(draw, text, fnt) <= max_width:
        return text
    ellipsis = "…"
    while text and safe_text_length(draw, text + ellipsis, fnt) > max_width:
        text = text[:-1]
    return f"{text}{ellipsis}" if text else ellipsis


def fallback_labels(data):
    fallback = data.get("fallback")
    return fallback if isinstance(fallback, dict) else None


def apply_fallback(data, fallback):
    """Swap the drawn labels to the host-provided English set (no CJK font)."""
    if fallback is None:
        return data
    out = dict(data)
    for key in ("title", "modelsTitle", "modelCol", "sourceCol", "tokensCol", "footer"):
        value = fallback.get(key)
        if isinstance(value, str) and value:
            out[key] = value
    rows = data.get("rows", [])
    fallback_rows = fallback.get("rows") if isinstance(fallback.get("rows"), list) else []
    merged_rows = []
    for index, row in enumerate(rows):
        merged = dict(row)
        if index < len(fallback_rows) and isinstance(fallback_rows[index], dict):
            for key in ("label", "meta", "extra"):
                value = fallback_rows[index].get(key)
                if isinstance(value, str) and value:
                    merged[key] = value
        merged_rows.append(merged)
    out["rows"] = merged_rows
    models = [dict(model) for model in data.get("models", [])]
    fallback_models = fallback.get("models") if isinstance(fallback.get("models"), list) else []
    for index, model in enumerate(models):
        if index < len(fallback_models) and isinstance(fallback_models[index], dict):
            value = fallback_models[index].get("source")
            if isinstance(value, str) and value:
                model["source"] = value
    out["models"] = models
    return out


def render(data, output):
    if not CJK_OK:
        data = apply_fallback(data, fallback_labels(data))
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
            draw.text((x + pad + safe_text_length(draw, value, value_font) + 8, y + 62), unit, font=unit_font, fill=MUTED)
        meta = row.get("meta", "")
        if meta:
            draw.text((right - pad - safe_text_length(draw, meta, meta_font), y + 20), meta, font=meta_font, fill=MUTED)
        extra = row.get("extra", "")
        if extra:
            draw.text((right - pad - safe_text_length(draw, extra, extra_font), y + 62), extra, font=extra_font, fill=MUTED)
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
        draw.text((right - pad - safe_text_length(draw, tokens_head, head_font), header_y), tokens_head, font=head_font, fill=MUTED)
        row_y = header_y + 24
        for index, model in enumerate(models):
            if index > 0:
                draw.line((x + pad, row_y - 2, right - pad, row_y - 2), fill=DIVIDER, width=1)
            name = fit(draw, model.get("name", ""), model_font, col_source - (x + pad) - 16)
            draw.text((x + pad, row_y + 10), name, font=model_font, fill=INK)
            value = model.get("value", "")
            value_x = right - pad - safe_text_length(draw, value, model_font)
            source = model.get("source", "")
            if source:
                source_width = value_x - col_source - 12
                draw.text((col_source, row_y + 13), fit(draw, source, model_meta_font, source_width), font=model_meta_font, fill=MUTED)
            draw.text((value_x, row_y + 10), value, font=model_font, fill=INK)
            row_y += 46

    footer = data.get("footer", "")
    if footer:
        footer_width = safe_text_length(draw, footer, footer_font)
        draw.text(((WIDTH - footer_width) / 2, height - 34), footer, font=footer_font, fill=MUTED)

    image.save(output, "PNG", optimize=True)
    return {"width": image.width, "height": image.height, "cjk": CJK_OK, "title": data.get("title", "")}


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
