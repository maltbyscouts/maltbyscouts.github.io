"""Shrink and strip metadata from photos before they are committed.

- Resizes JPEG/PNG/WebP images so the longest edge is at most --max (default 1600px).
- Removes EXIF/XMP metadata, including any GPS location (important for photos of young people).
  Orientation is applied to the pixels first, so photos stay the right way up.
- Leaves SVGs and small images alone; only rewrites a file if the result is smaller or had metadata.

CI runs it with --check, which fails if any image still has GPS data or is too large.

Usage (from the repo root):
    .venv/Scripts/pip install pillow
    .venv/Scripts/python tools/optimise_images.py site/static/images site/content
"""

from __future__ import annotations

import argparse
import io
import sys
from pathlib import Path

from PIL import Image, ImageOps

EXTS = {".jpg", ".jpeg", ".png", ".webp"}


def problems(path: Path, max_edge: int) -> list[str]:
    """Reasons this image shouldn't be committed as-is (used by --check in CI)."""
    with Image.open(path) as im:
        out = []
        if 34853 in im.getexif():  # GPSInfo tag
            out.append("contains GPS location")
        if max(im.size) > max_edge:
            out.append(f"{im.size[0]}x{im.size[1]} is larger than {max_edge}px")
        return out


def optimise(path: Path, max_edge: int, quality: int) -> tuple[int, int]:
    before = path.stat().st_size
    with Image.open(path) as im:
        had_meta = bool(im.info.get("exif") or im.info.get("xmp") or im.getexif())
        im = ImageOps.exif_transpose(im)
        resized = max(im.size) > max_edge
        if resized:
            im.thumbnail((max_edge, max_edge), Image.LANCZOS)
        buf = io.BytesIO()
        fmt = {".jpg": "JPEG", ".jpeg": "JPEG", ".png": "PNG", ".webp": "WEBP"}[path.suffix.lower()]
        if fmt == "JPEG":
            im.convert("RGB").save(buf, fmt, quality=quality, optimize=True, progressive=True)
        elif fmt == "PNG":
            im.save(buf, fmt, optimize=True)
        else:
            im.save(buf, fmt, quality=quality)
    data = buf.getvalue()
    if resized or had_meta or len(data) < before:
        path.write_bytes(data)
        return before, len(data)
    return before, before


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("paths", nargs="+", type=Path)
    ap.add_argument("--max", type=int, default=1600)
    ap.add_argument("--quality", type=int, default=82)
    ap.add_argument("--check", action="store_true", help="don't change anything; exit 1 if any image needs fixing")
    a = ap.parse_args()
    bad = 0
    total_before = total_after = 0
    for root in a.paths:
        files = [root] if root.is_file() else [p for p in root.rglob("*") if p.suffix.lower() in EXTS]
        for f in files:
            if "processed_images" in f.parts:
                continue
            if a.check:
                for why in problems(f, a.max):
                    print(f"{f}: {why}")
                    bad += 1
                continue
            try:
                b, af = optimise(f, a.max, a.quality)
            except Exception as e:  # noqa: BLE001 - report and carry on
                print(f"skip {f}: {e}", file=sys.stderr)
                continue
            total_before += b
            total_after += af
            if af != b:
                print(f"{f}: {b // 1024}KB -> {af // 1024}KB")
    if a.check:
        if bad:
            sys.exit("Fix with: python tools/optimise_images.py <paths>")
        print("all images OK")
        return
    print(f"total: {total_before // 1024}KB -> {total_after // 1024}KB")


if __name__ == "__main__":
    main()
