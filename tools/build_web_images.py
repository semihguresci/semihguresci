"""Create web-sized images for the portfolio.

Run from the repository root:
    python -B tools/build_web_images.py

Source images stay in place. The home page loads the WebP variants through
<picture>, and the social card supplies the og:image preview for shared links.
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw, ImageFont, ImageOps

ROOT = Path(__file__).resolve().parents[1]
CARD_SIZE = (1200, 630)
CARD_PATH = "assets/images/og-card.jpg"
BACKGROUND = "assets/images/dust-volume-fallback.webp"

VARIANTS = (
    (
        "assets/blog/vulkan-scene-renderer/current/sponza-daylight.jpg",
        "assets/blog/vulkan-scene-renderer/current/sponza-daylight.webp",
        1920,
        90,
    ),
    (
        "assets/blog/gpu-memory-experiments-2026-10-23/charts/aos_vs_soa_gpu_ms_vs_size.png",
        "assets/blog/gpu-memory-experiments-2026-10-23/charts/aos_vs_soa_gpu_ms_vs_size.webp",
        1200,
        90,
    ),
    (
        "assets/images/semih-linkedin-profile.jpg",
        "assets/images/semih-linkedin-profile.webp",
        640,
        84,
    ),
)

FONTS = {
    "name": ("C:/Windows/Fonts/seguisb.ttf", "C:/Windows/Fonts/segoeuib.ttf"),
    "body": ("C:/Windows/Fonts/segoeui.ttf", "C:/Windows/Fonts/arial.ttf"),
    "label": ("C:/Windows/Fonts/consola.ttf", "C:/Windows/Fonts/cour.ttf"),
}


def flatten(image: Image.Image) -> Image.Image:
    if image.mode in ("RGBA", "LA") or (image.mode == "P" and "transparency" in image.info):
        rgba = image.convert("RGBA")
        return Image.alpha_composite(Image.new("RGBA", rgba.size, (255, 255, 255, 255)), rgba).convert("RGB")
    return image.convert("RGB")


def write_variant(source: Path, target: Path, max_width: int, quality: int) -> tuple[int, int]:
    with Image.open(source) as opened:
        image = flatten(ImageOps.exif_transpose(opened))
    if image.width > max_width:
        height = round(image.height * max_width / image.width)
        image = image.resize((max_width, height), Image.Resampling.LANCZOS)
    image.save(target, "WEBP", quality=quality, method=6)
    return source.stat().st_size, target.stat().st_size


def load_font(role: str, size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    for candidate in FONTS[role]:
        if Path(candidate).exists():
            return ImageFont.truetype(candidate, size)
    return ImageFont.load_default(size=size)


def write_social_card(background: Path, target: Path) -> None:
    width, height = CARD_SIZE
    card = ImageOps.fit(Image.open(background).convert("RGB"), CARD_SIZE, Image.Resampling.LANCZOS)
    shade = []
    for y in range(height):
        bottom = min(1.0, max(0.0, (y - 0.30 * height) / (0.45 * height))) * 232
        for x in range(width):
            left = max(0.0, 1.0 - x / (0.62 * width)) * 210
            shade.append(round(max(bottom, left)))
    mask = Image.new("L", CARD_SIZE)
    mask.putdata(shade)
    card = Image.composite(Image.new("RGB", CARD_SIZE, (6, 8, 11)), card, mask)
    draw = ImageDraw.Draw(card)
    draw.rectangle([(86, 352), (146, 356)], fill=(255, 199, 122))
    draw.text((84, 372), "Semih Güreşçi", font=load_font("name", 76), fill=(232, 237, 242))
    draw.text((86, 468), "GPU rendering & performance engineer", font=load_font("body", 34), fill=(161, 173, 185))
    draw.text((88, 548), "VULKAN · WEBGPU · GPU PERFORMANCE", font=load_font("label", 22), fill=(255, 199, 122))
    card.save(target, "JPEG", quality=90, optimize=True, progressive=True)


def main() -> None:
    for source, target, max_width, quality in VARIANTS:
        before, after = write_variant(ROOT / source, ROOT / target, max_width, quality)
        print(f"{target}: {before / 1024:.0f} KiB -> {after / 1024:.0f} KiB")
    write_social_card(ROOT / BACKGROUND, ROOT / CARD_PATH)
    print(f"{CARD_PATH}: {(ROOT / CARD_PATH).stat().st_size / 1024:.0f} KiB")


if __name__ == "__main__":
    main()
