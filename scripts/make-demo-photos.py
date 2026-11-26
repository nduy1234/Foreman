"""Generate illustrative demo "field photos" for the Foreman demo seed.

These are drawn diagrams, clearly labelled as illustrative, not real photos. Each JPEG carries
EXIF (camera model, GPS near a fictional site, DateTimeOriginal). DateTimeOriginal is a fixed
placeholder ("2000:01:0N 08:00:00") that the seeder overwrites in-place with a real date at
seed time, so photo timestamps always line up with the seeded inspection dates.

Run:  python scripts/make-demo-photos.py
Writes: src/seed/photos.generated.ts
"""
import base64
import io
import random
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / "src" / "seed" / "photos.generated.ts"
W, H = 800, 560
random.seed(7)


def font(size):
    for name in ("arialbd.ttf", "arial.ttf", "DejaVuSans-Bold.ttf", "DejaVuSans.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


F_BIG, F_SMALL = font(26), font(17)


def ground(d, top, color):
    d.rectangle([0, top, W, H], fill=color)
    for _ in range(900):
        x, y = random.randint(0, W), random.randint(top, H)
        c = tuple(max(0, min(255, v + random.randint(-18, 18))) for v in color)
        d.point((x, y), fill=c)


def caption(d, title, sub):
    d.rectangle([0, 0, W, 64], fill=(23, 43, 77))
    d.text((16, 8), title, font=F_BIG, fill=(255, 255, 255))
    d.text((16, 38), sub, font=F_SMALL, fill=(184, 199, 224))
    d.rectangle([0, H - 30, W, H], fill=(0, 0, 0))
    d.text((12, H - 26), "Illustrative demo image - Foreman sample data - not a real site photo",
           font=F_SMALL, fill=(255, 214, 102))


def footing():
    im = Image.new("RGB", (W, H), (150, 190, 230)); d = ImageDraw.Draw(im)
    ground(d, 200, (122, 94, 64))
    d.polygon([(120, 300), (680, 300), (640, 440), (160, 440)], fill=(92, 70, 48))
    for x in range(180, 640, 40):
        d.line([(x, 330), (x, 420)], fill=(120, 60, 30), width=4)
    d.line([(160, 360), (640, 360)], fill=(120, 60, 30), width=4)
    d.line([(160, 400), (640, 400)], fill=(120, 60, 30), width=4)
    d.rectangle([680, 250, 700, 440], fill=(240, 200, 40))
    caption(d, "Footing excavation - Grid A-D / 1-2", "Bottom of footing on native soil; tape shows 24 in width")
    return im


def rebar():
    im = Image.new("RGB", (W, H), (150, 150, 150)); d = ImageDraw.Draw(im)
    ground(d, 64, (170, 166, 158))
    for x in range(40, W, 54):   # wide spacing (~18 in), thin bars (#4)
        d.line([(x, 90), (x - 20, 520)], fill=(110, 60, 35), width=5)
    for y in range(100, 520, 54):
        d.line([(20, y), (W, y + 10)], fill=(110, 60, 35), width=5)
    for x in range(70, W, 108):
        for y in range(130, 520, 108):
            d.rectangle([x, y, x + 10, y + 10], fill=(60, 60, 60))
    d.rectangle([560, 380, 760, 420], fill=(255, 255, 255))
    d.text((570, 388), "#4 @ 18 in o.c.?", font=F_SMALL, fill=(174, 46, 36))
    caption(d, "Foundation bottom mat - Grid B-C / 2-3", "Bar size and spacing visible against tape")
    return im


def slab():
    im = Image.new("RGB", (W, H), (150, 190, 230)); d = ImageDraw.Draw(im)
    ground(d, 64, (40, 40, 44))
    for y in range(90, 520, 70):
        d.line([(0, y), (W, y + 6)], fill=(200, 200, 205), width=2)  # taped seams
    for (x, y) in [(200, 220), (430, 330), (610, 180)]:
        d.ellipse([x, y, x + 30, y + 30], fill=(220, 220, 220))
        d.rectangle([x + 10, y - 30, x + 20, y], fill=(230, 230, 230))
    d.rectangle([700, 64, W, 530], fill=(160, 140, 110))
    d.text((706, 300), "no\ninsul.", font=F_SMALL, fill=(255, 255, 255))
    caption(d, "Slab on grade - vapor barrier, Level 1", "Seams taped; plumbing stubs sleeved; east edge insulation pending")
    return im


def framing():
    im = Image.new("RGB", (W, H), (210, 205, 195)); d = ImageDraw.Draw(im)
    ground(d, 470, (150, 140, 120))
    d.rectangle([40, 110, 760, 122], fill=(196, 160, 110))
    d.rectangle([40, 460, 760, 472], fill=(196, 160, 110))
    for x in range(40, 770, 40):
        d.rectangle([x, 110, x + 8, 470], fill=(206, 170, 120))
    d.rectangle([40, 110, 360, 470], outline=(120, 120, 120), width=3, fill=(232, 232, 228))
    d.text((120, 270), "gypsum hung", font=F_SMALL, fill=(80, 80, 80))
    d.text((470, 270), "corridor side OPEN", font=F_SMALL, fill=(174, 46, 36))
    d.rectangle([600, 420, 640, 470], outline=(174, 46, 36), width=3)
    d.text((560, 480), "hold-down missing", font=F_SMALL, fill=(174, 46, 36))
    caption(d, "Level 2 corridor wall - Grid C-D / 4", "Rated corridor wall: one side boarded, corridor side open")
    return im


def mep():
    im = Image.new("RGB", (W, H), (205, 200, 190)); d = ImageDraw.Draw(im)
    ground(d, 470, (150, 140, 120))
    for x in range(40, 770, 40):
        d.rectangle([x, 100, x + 8, 470], fill=(206, 170, 120))
    for i, x in enumerate(range(90, 700, 120)):
        d.rectangle([x, 300, x + 26, 336], fill=(40, 90, 200))
        d.line([(x + 13, 300), (x + 13, 100)], fill=(250, 250, 250), width=4)
    d.line([(40, 180), (760, 180)], fill=(190, 190, 190), width=14)  # conduit/pipe
    d.ellipse([380, 165, 412, 197], outline=(174, 46, 36), width=4)
    d.text((420, 200), "penetration not firestopped", font=F_SMALL, fill=(174, 46, 36))
    caption(d, "MEP rough-in - Level 2 east wing", "Boxes set, home runs pulled; rated-wall penetration open")
    return im


PHOTOS = [
    ("footing", "footing-excavation-gridA.jpg", footing, (34, 1, 22.0), (117, 23, 45.0)),
    ("rebar", "foundation-bottom-mat-gridB.jpg", rebar, (34, 1, 22.4), (117, 23, 44.1)),
    ("slab", "slab-vapor-barrier-L1.jpg", slab, (34, 1, 23.1), (117, 23, 43.7)),
    ("framing", "L2-corridor-wall-gridC.jpg", framing, (34, 1, 21.8), (117, 23, 45.6)),
    ("mep", "L2-mep-roughin-east.jpg", mep, (34, 1, 22.9), (117, 23, 44.8)),
]


def exif_bytes(n, lat, lon):
    ex = Image.Exif()
    ex[0x010F] = "Foreman Demo"          # Make
    ex[0x0110] = "SiteCam 2"             # Model
    ex[0x0131] = "Foreman sample data"   # Software
    sub = ex.get_ifd(0x8769)
    sub[0x9003] = f"2000:01:0{n} 08:00:00"  # DateTimeOriginal placeholder
    gps = ex.get_ifd(0x8825)
    gps[1], gps[2] = "N", lat
    gps[3], gps[4] = "W", lon
    return ex.tobytes()


def main():
    lines = [
        "// GENERATED by scripts/make-demo-photos.py - do not edit by hand.",
        "// Illustrative demo images (drawn, not real photos). DateTimeOriginal is a placeholder",
        "// that src/seed/photos.ts rewrites at seed time.",
        "export interface DemoPhoto { id: string; filename: string; placeholder: string; base64: string }",
        "export const DEMO_PHOTOS: DemoPhoto[] = [",
    ]
    for n, (pid, fname, draw, lat, lon) in enumerate(PHOTOS, start=1):
        buf = io.BytesIO()
        draw().save(buf, "JPEG", quality=62, optimize=True, exif=exif_bytes(n, lat, lon))
        data = buf.getvalue()
        placeholder = f"2000:01:0{n} 08:00:00"
        assert data.count(placeholder.encode()) == 1, pid
        b64 = base64.b64encode(data).decode()
        lines.append(f"  {{ id: '{pid}', filename: '{fname}', placeholder: '{placeholder}', base64: '{b64}' }},")
        print(f"{fname}: {len(data) // 1024} KB")
    lines.append("];")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote", OUT)


if __name__ == "__main__":
    main()
