#!/usr/bin/env python3
"""
Generates the raster brand assets committed under app/.

Run by hand when the mark or the strapline changes; the outputs are committed
so neither CI nor a contributor needs Python to build the site:

    python3 scripts/brand-assets.py

Colours are read straight from the design tokens in app/globals.css so the
social card cannot drift away from the interface it advertises.
"""
from PIL import Image, ImageDraw, ImageFont

ROBOTO = "/usr/share/fonts/truetype/roboto/unhinted/RobotoTTF/Roboto-{}.ttf"
MONO = "/usr/share/fonts/truetype/liberation/LiberationMono-{}.ttf"

# app/globals.css
BG = "#0a0a0b"
SURFACE = "#141416"
BORDER = "#232327"
BORDER_STRONG = "#313137"
TEXT = "#ececee"
TEXT_2 = "#9d9da6"
TEXT_3 = "#6a6a73"
ELEVATED = "#c2804f"

def font(weight, size, mono=False):
    return ImageFont.truetype((MONO if mono else ROBOTO).format(weight), size)

def mark(draw, x, y, size, stroke, line_w):
    """The Sentra mark: a rounded square with a rising trace through it."""
    r = size * 0.28
    draw.rounded_rectangle([x, y, x + size, y + size], radius=r,
                           outline=stroke, width=max(2, int(size * 0.06)))
    s = size / 20.0
    pts = [(x + 5.5 * s, y + 12.5 * s), (x + 8 * s, y + 8.5 * s),
           (x + 10.5 * s, y + 11 * s), (x + 14.5 * s, y + 5.5 * s)]
    draw.line(pts, fill=stroke, width=line_w, joint="curve")

def dial(draw, cx, cy, r, score, colour, width=14):
    """240-degree arc, matching components/RiskDial.tsx."""
    sweep, start = 240, 150
    box = [cx - r, cy - r, cx + r, cy + r]
    draw.arc(box, start, start + sweep, fill=BORDER_STRONG, width=width)
    draw.arc(box, start, start + sweep * (score / 100.0), fill=colour, width=width)

def opengraph(path):
    W, H = 1200, 630
    img = Image.new("RGB", (W, H), BG)
    d = ImageDraw.Draw(img)

    # Hairline frame, echoing the panel borders in the app.
    d.rectangle([40, 40, W - 40, H - 40], outline=BORDER, width=1)

    mark(d, 76, 74, 46, TEXT_2, 4)
    d.text((136, 78), "Sentra", font=font("Medium", 38), fill=TEXT)

    d.text((76, 208), "Your balance says what you have.",
           font=font("Regular", 44), fill=TEXT_2)
    d.text((76, 268), "Sentra says what you stand to lose.",
           font=font("Medium", 44), fill=TEXT)

    d.text((76, 366), "Continuous Value-at-Risk and Expected Shortfall",
           font=font("Regular", 25), fill=TEXT_3)
    d.text((76, 400), "for Solana wallets, scored every 30 seconds.",
           font=font("Regular", 25), fill=TEXT_3)

    d.line([76, 484, 560, 484], fill=BORDER, width=1)
    d.text((76, 508), "VALUE AT RISK   ·   EXPECTED SHORTFALL   ·   RISK ATTRIBUTION",
           font=font("Medium", 17), fill=TEXT_3)

    # The instrument, reading the same as the dashboard's demo book.
    cx, cy, r = 940, 300, 122
    dial(d, cx, cy, r, 47.2, ELEVATED)
    score = font("Medium", 66)
    text = "47.2"
    tw = d.textbbox((0, 0), text, font=score)
    d.text((cx - (tw[2] - tw[0]) / 2, cy - 44), text, font=score, fill=TEXT)
    band = font("Medium", 18)
    bw = d.textbbox((0, 0), "ELEVATED", font=band)
    d.text((cx - (bw[2] - bw[0]) / 2, cy + 34), "ELEVATED", font=band, fill=ELEVATED)

    # Label sits above the arc, as it does over the dial in the dashboard.
    cap = font("Medium", 17)
    cw = d.textbbox((0, 0), "BLENDED RISK", font=cap)
    d.text((cx - (cw[2] - cw[0]) / 2, cy - r - 46), "BLENDED RISK",
           font=cap, fill=TEXT_3)

    img.save(path, "PNG", optimize=True)
    print("wrote", path, img.size)

def apple_icon(path):
    S = 180
    scale = 4  # supersample, then downscale for clean edges
    img = Image.new("RGB", (S * scale, S * scale), BG)
    d = ImageDraw.Draw(img)
    pad = 26 * scale
    mark(d, pad, pad, S * scale - pad * 2, TEXT, 11 * scale)
    img = img.resize((S, S), Image.LANCZOS)
    img.save(path, "PNG", optimize=True)
    print("wrote", path, img.size)

if __name__ == "__main__":
    opengraph("app/opengraph-image.png")
    apple_icon("app/apple-icon.png")
