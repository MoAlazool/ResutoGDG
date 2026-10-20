"""Converts the self-hosted web fonts to WOFF2 with content-hashed names (PCL-22).

Lossless: every glyph, table and OpenType feature of the source TTF is kept (the legacy design's fonts, unchanged),
only the container is WOFF2 (Brotli). The hash in the file name lets apps/web serve /fonts/* as immutable for a
year (next.config.ts); a changed font gets a new name, so no cache ever serves a stale file.

Sources: legacy/public/fonts/*.ttf (read only; identical to the TTFs apps/web shipped before).
Usage (fontTools 4.55 + brotli 1.1 in any venv):
  python scripts/perf/fonts/convert-woff2.py            # writes apps/web/public/fonts/<name>.<hash8>.woff2
Then update the @font-face src URLs in apps/web/app/globals.css to the printed names.
"""
import hashlib
import io
import pathlib
import sys

from fontTools.ttLib import TTFont

ROOT = pathlib.Path(__file__).resolve().parents[3]
SRC = ROOT / "legacy" / "public" / "fonts"
OUT = ROOT / "apps" / "web" / "public" / "fonts"
NAMES = ["manrope", "plex-arabic", "plex-arabic-medium", "plex-arabic-semibold", "plex-arabic-bold"]


def main() -> int:
    for old in OUT.glob("*.woff2"):
        old.unlink()
    for name in NAMES:
        font = TTFont(SRC / f"{name}.ttf")
        font.flavor = "woff2"
        buf = io.BytesIO()
        font.save(buf)
        data = buf.getvalue()
        digest = hashlib.sha256(data).hexdigest()[:8]
        target = OUT / f"{name}.{digest}.woff2"
        target.write_bytes(data)
        ttf = (SRC / f"{name}.ttf").stat().st_size
        print(f"{target.name}\t{ttf} -> {len(data)} bytes ({100 - round(100 * len(data) / ttf)}% smaller)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
