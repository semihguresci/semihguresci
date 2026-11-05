"""Render the light-volume fallback with the model used by assets/js/light-volume.js.

The density is the same baked value-noise volume the WebGPU path samples, looked up
trilinearly with repeat addressing. Samples are midpoint rather than jittered, so the
output approximates the converged live image. Bloom, tone mapping, vignette, and
dither follow the present pass.

Run from the repository root:
    python -B tools/render_dust_reference.py
    python -B tools/render_dust_reference.py --width 480 --height 300 --output output/preview.webp
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import time
from pathlib import Path

import numpy as np
from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/js/light-volume.js"
DEFAULT_OUTPUT = ROOT / "assets/images/dust-volume-fallback.webp"


def load_model(source: Path) -> tuple[dict, str]:
    text = source.read_text(encoding="utf-8")
    match = re.search(r"const MODEL\s*=\s*(\{[\s\S]*?\})\s*;", text)
    if not match:
        raise ValueError(f"No MODEL literal found in {source}")
    digest = hashlib.sha256(text.replace("\r\n", "\n").encode("utf-8")).hexdigest()
    return json.loads(match.group(1)), digest


def lerp(a, b, t):
    return a + (b - a) * t


def smoothstep(low, high, value):
    t = np.clip((value - low) / (high - low), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def normalize(vector):
    return vector / np.maximum(np.linalg.norm(vector, axis=-1, keepdims=True), 1e-12)


def hash3(x, y, z):
    h = (
        x.astype(np.uint32) * np.uint32(1664525)
        + y.astype(np.uint32) * np.uint32(1013904223)
        + z.astype(np.uint32) * np.uint32(2246822519)
    ).astype(np.uint32)
    h = h ^ (h >> np.uint32(16))
    h = (h * np.uint32(2654435761)).astype(np.uint32)
    h = h ^ (h >> np.uint32(15))
    h = (h * np.uint32(2246822519)).astype(np.uint32)
    h = h ^ (h >> np.uint32(13))
    return (h & np.uint32(0xFFFFFF)).astype(np.float64) / 16777215.0


def value_noise(x, y, z, period):
    cx, cy, cz = np.floor(x), np.floor(y), np.floor(z)
    fx, fy, fz = x - cx, y - cy, z - cz
    wx = fx * fx * fx * (fx * (fx * 6.0 - 15.0) + 10.0)
    wy = fy * fy * fy * (fy * (fy * 6.0 - 15.0) + 10.0)
    wz = fz * fz * fz * (fz * (fz * 6.0 - 15.0) + 10.0)
    x0 = cx.astype(np.int64) % period
    y0 = cy.astype(np.int64) % period
    z0 = cz.astype(np.int64) % period
    x1 = (x0 + 1) % period
    y1 = (y0 + 1) % period
    z1 = (z0 + 1) % period
    x00 = lerp(hash3(x0, y0, z0), hash3(x1, y0, z0), wx)
    x10 = lerp(hash3(x0, y1, z0), hash3(x1, y1, z0), wx)
    x01 = lerp(hash3(x0, y0, z1), hash3(x1, y0, z1), wx)
    x11 = lerp(hash3(x0, y1, z1), hash3(x1, y1, z1), wx)
    return lerp(lerp(x00, x10, wy), lerp(x01, x11, wy), wz)


def build_volume(model):
    size = model["noiseSize"]
    coords = (np.arange(size) + 0.5) / size
    X, Y, Z = np.meshgrid(coords, coords, coords, indexing="ij")
    total = np.zeros_like(X)
    norm = 0.0
    amp = 1.0
    period = model["noiseBase"]
    for _ in range(model["noiseOctaves"]):
        total += amp * value_noise(X * period, Y * period, Z * period, period)
        norm += amp
        amp *= 0.5
        period *= 2
    return total / norm


def sample_volume(grid, uvw):
    size = grid.shape[0]
    t = uvw * size - 0.5
    base = np.floor(t)
    f = t - base
    i0 = base.astype(np.int64) % size
    i1 = (i0 + 1) % size
    x0, y0, z0 = i0[..., 0], i0[..., 1], i0[..., 2]
    x1, y1, z1 = i1[..., 0], i1[..., 1], i1[..., 2]
    fx, fy, fz = f[..., 0], f[..., 1], f[..., 2]
    c00 = lerp(grid[x0, y0, z0], grid[x1, y0, z0], fx)
    c10 = lerp(grid[x0, y1, z0], grid[x1, y1, z0], fx)
    c01 = lerp(grid[x0, y0, z1], grid[x1, y0, z1], fx)
    c11 = lerp(grid[x0, y1, z1], grid[x1, y1, z1], fx)
    return lerp(lerp(c00, c10, fy), lerp(c01, c11, fy), fz)


def density(model, grid, p, time_seconds):
    ellipsoid = np.asarray(model["ellipsoid"], dtype=np.float64)
    q = p / ellipsoid
    r2 = np.sum(q * q, axis=-1)
    envelope = np.where(r2 < 1.0, (1.0 - r2) ** 2, 0.0)
    extent = model["domainExtent"]
    drift = np.asarray(model["drift"], dtype=np.float64)
    uvw = p / extent + 0.5 + drift * time_seconds / extent
    phase = model["warpSpeed"] * time_seconds
    warp = np.stack(
        [
            np.sin(phase + 6.0 * uvw[..., 1] + 1.7),
            np.cos(0.8 * phase + 5.0 * uvw[..., 2]),
            np.sin(0.6 * phase + 4.0 * uvw[..., 0]),
        ],
        axis=-1,
    )
    uvw = uvw + model["warpAmount"] * warp
    noise = sample_volume(grid, uvw)
    wisps = smoothstep(model["wispLow"], model["wispHigh"], noise)
    return envelope * (model["densityFloor"] + model["densityGain"] * wisps)


def box_span(origin, direction, half):
    safe = np.where(direction >= 0.0, 1.0, -1.0) * np.maximum(np.abs(direction), 1e-6)
    inverse = 1.0 / safe
    a = (-half - origin) * inverse
    b = (half - origin) * inverse
    lo = np.minimum(a, b)
    hi = np.maximum(a, b)
    return np.stack([np.max(lo, axis=-1), np.min(hi, axis=-1)], axis=-1)


def phase_hg(mu, g):
    mu = np.clip(mu, -1.0, 1.0)
    return (1.0 - g * g) / (4.0 * np.pi * np.power(1.0 + g * g - 2.0 * g * mu, 1.5))


def light_transmittance(model, grid, p, to_light, distance, time_seconds, sigma_t, steps):
    exit_distance = box_span(p, to_light, np.asarray(model["ellipsoid"], dtype=np.float64))[..., 1]
    length = np.maximum(0.0, np.minimum(distance, exit_distance))
    ds = length / steps
    tau = np.zeros(len(p))
    for j in range(steps):
        sample = p + to_light * ((j + 0.5) * ds)[:, None]
        tau += density(model, grid, sample, time_seconds) * ds
    return np.exp(-sigma_t * tau)


def render_hdr(model, grid, width, height, view_steps, light_steps, time_seconds=0.0, rows_per_chunk=24):
    camera = np.asarray(model["camera"], dtype=np.float64)
    light_pos = np.asarray(model["lightPosition"], dtype=np.float64)
    light_dir = normalize(np.asarray(model["lightTarget"], dtype=np.float64) - light_pos)
    light_color = np.asarray(model["lightColor"], dtype=np.float64)
    ambient = np.asarray(model["ambient"], dtype=np.float64)
    background = np.asarray(model["background"], dtype=np.float64)
    ellipsoid = np.asarray(model["ellipsoid"], dtype=np.float64)
    sigma_a, sigma_s, g = model["sigmaA"], model["sigmaS"], model["g"]
    sigma_t = sigma_a + sigma_s
    albedo = sigma_s / sigma_t
    hdr = np.zeros((height, width, 3))

    for first in range(0, height, rows_per_chunk):
        last = min(height, first + rows_per_chunk)
        ys, xs = np.meshgrid(np.arange(first, last) + 0.5, np.arange(width) + 0.5, indexing="ij")
        uv_x = (2.0 * xs - width) / height
        uv_y = (height - 2.0 * ys) / height
        rd = normalize(np.stack([uv_x * model["fovTan"], uv_y * model["fovTan"], -np.ones_like(uv_x)], axis=-1))
        span = box_span(camera, rd, ellipsoid)
        t0 = np.maximum(span[..., 0], 0.0)
        t1 = span[..., 1]
        valid = t1 > t0
        ds = np.where(valid, (t1 - t0) / view_steps, 0.0)
        view_t = np.ones(uv_x.shape)
        radiance = np.zeros(uv_x.shape + (3,))

        for i in range(view_steps):
            t = t0 + (i + 0.5) * ds
            p = camera + rd * t[..., None]
            rho = density(model, grid, p, time_seconds)
            seg_t = np.exp(-sigma_t * rho * ds)
            scatter = albedo * (1.0 - seg_t)
            radiance += (view_t * scatter)[..., None] * ambient

            delta = light_pos - p
            d2 = np.maximum(np.sum(delta * delta, axis=-1), 1e-4)
            d = np.sqrt(d2)
            to_light = delta / d[..., None]
            cone = smoothstep(model["cosOuter"], model["cosInner"], -np.sum(to_light * light_dir, axis=-1))
            lit = (cone > 0.0) & (rho > 0.0)
            if np.any(lit):
                light_t = light_transmittance(model, grid, p[lit], to_light[lit], d[lit], time_seconds, sigma_t, light_steps)
                phase = phase_hg(np.sum(rd[lit] * to_light[lit], axis=-1), g)
                key = light_color * (model["lightIntensity"] * cone[lit] * light_t / d2[lit] * phase)[:, None]
                radiance[lit] += (view_t[lit] * scatter[lit])[:, None] * key
            view_t *= seg_t

        to_lamp = light_pos - camera
        along = np.sum(rd * to_lamp, axis=-1)
        across = to_lamp - rd * along[..., None]
        across2 = np.sum(across * across, axis=-1)
        halo = 1.0 / (1.0 + 400.0 * across2) + 0.15 / (1.0 + 12.0 * across2)
        glare = view_t * model["glare"] * (along > 0.0) * halo
        radiance += glare[..., None] * light_color

        glow = np.exp(-0.7 * (uv_x * uv_x + uv_y * uv_y))
        radiance += (background * (0.85 + 0.15 * glow)[..., None]) * view_t[..., None]
        hdr[first:last] = radiance
    return hdr


def aces(x):
    return np.clip((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0)


def to_srgb(c):
    low = c * 12.92
    high = 1.055 * np.power(np.maximum(c, 0.0), 1.0 / 2.4) - 0.055
    return np.where(c <= 0.0031308, low, high)


def interleaved_noise(x, y):
    return np.mod(52.9829189 * np.mod(0.06711056 * x + 0.00583715 * y, 1.0), 1.0)


def bilinear(image, sx, sy):
    height, width, _ = image.shape
    cx = np.clip(sx, 0.0, width)
    cy = np.clip(sy, 0.0, height)
    px = cx - 0.5
    py = cy - 0.5
    x0 = np.floor(px).astype(np.int64)
    y0 = np.floor(py).astype(np.int64)
    fx = (px - x0)[..., None]
    fy = (py - y0)[..., None]
    xa = np.clip(x0, 0, width - 1)
    xb = np.clip(x0 + 1, 0, width - 1)
    ya = np.clip(y0, 0, height - 1)
    yb = np.clip(y0 + 1, 0, height - 1)
    top = lerp(image[ya, xa], image[ya, xb], fx)
    bottom = lerp(image[yb, xa], image[yb, xb], fx)
    return lerp(top, bottom, fy)


def present(model, hdr):
    height, width, _ = hdr.shape
    ys, xs = np.meshgrid(np.arange(height), np.arange(width), indexing="ij")
    glow = np.zeros_like(hdr)
    for k in range(8):
        angle = k * 0.7853982
        glow += np.maximum(bilinear(hdr, xs + 0.5 + np.cos(angle) * 7.0, ys + 0.5 + np.sin(angle) * 7.0) - 0.6, 0.0)
    scene = hdr + glow * (0.5 / 8.0)
    mapped = aces(scene * model["exposure"])
    uv_x = (xs + 0.5) / width - 0.5
    uv_y = (ys + 0.5) / height - 0.5
    mapped *= (1.0 - 0.6 * (uv_x * uv_x + uv_y * uv_y))[..., None]
    dither = (
        interleaved_noise(xs + 0.5 + 17.0, ys + 0.5 + 9.0)
        + interleaved_noise((xs + 0.5) * 1.37 + 3.0, (ys + 0.5) * 1.37 + 31.0)
        - 1.0
    ) / 255.0
    srgb = np.clip(to_srgb(np.clip(mapped, 0.0, 1.0)) + dither[..., None], 0.0, 1.0)
    return np.rint(srgb * 255.0).astype(np.uint8)


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--width", type=int, default=960)
    parser.add_argument("--height", type=int, default=600)
    parser.add_argument("--view-steps", type=int, default=96)
    parser.add_argument("--light-steps", type=int, default=12)
    parser.add_argument("--time", type=float, default=0.0)
    args = parser.parse_args()
    if min(args.width, args.height, args.view_steps, args.light_steps) <= 0:
        parser.error("Image dimensions and sample counts must be positive")

    model, source_hash = load_model(args.source)
    started = time.perf_counter()
    grid = build_volume(model)
    hdr = render_hdr(model, grid, args.width, args.height, args.view_steps, args.light_steps, args.time)
    pixels = present(model, hdr)

    exif = Image.Exif()
    exif[0x010E] = (
        f"CPU reference of assets/js/light-volume.js (sha256 {source_hash[:16]}); "
        f"{args.view_steps} view / {args.light_steps} light midpoint samples; time {args.time}"
    )
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(pixels, "RGB").save(args.output, "WEBP", quality=90, method=6, exif=exif.tobytes())
    print(f"Saved {args.output} ({args.width}x{args.height}, {args.view_steps}/{args.light_steps} samples, {time.perf_counter() - started:.1f}s)")


if __name__ == "__main__":
    main()
