"""Render the dust study's static fallback using its single-scattering model.

Model parameters are read from the JSON MODEL literal in assets/js/render-study.js.
The analytic density, camera, spotlight, and display transform mirror that
renderer at the neutral pointer position. Distances use normalized scene units.
The reference uses float64 and higher midpoint sample counts by default; it is
a quadrature reference, rather than a pixel-equivalence claim for f32 GPU output.

Run from the repository root:
    python -B tools/render_dust_reference.py
    python -B tools/render_dust_reference.py --match-gpu --output output/dust-gpu-steps.png
"""

from __future__ import annotations

import argparse
import hashlib
import json
from pathlib import Path
import re
import time

import numpy as np
from PIL import Image, PngImagePlugin


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets/js/render-study.js"


def load_model(source: Path) -> tuple[dict, str]:
    text = source.read_text(encoding="utf-8")
    match = re.search(r"const MODEL\s*=\s*(?:Object\.freeze\()?\s*(\{[\s\S]*?\})\s*\)?\s*;", text)
    if not match:
        raise ValueError(f"No JSON MODEL literal found in {source}")
    model = json.loads(match.group(1))
    return model, hashlib.sha256(text.encode("utf-8")).hexdigest()


def smoothstep(low, high, value):
    t = np.clip((value - low) / (high - low), 0.0, 1.0)
    return t * t * (3.0 - 2.0 * t)


def normalize(value):
    return value / np.maximum(np.linalg.norm(value, axis=-1, keepdims=True), 1e-12)


def ray_box(origin, direction, model):
    safe = np.where(np.abs(direction) > 1e-6, direction, np.where(direction < 0, -1e-6, 1e-6))
    a = (np.asarray(model["boundsMin"]) - origin) / safe
    b = (np.asarray(model["boundsMax"]) - origin) / safe
    return np.max(np.minimum(a, b), axis=-1), np.min(np.maximum(a, b), axis=-1)


def density(position, elapsed, model):
    scaled = position / np.asarray(model["densityRadius"])
    support = np.maximum(0.0, 1.0 - np.sum(scaled * scaled, axis=-1))
    w = position + np.array([elapsed * 0.025, elapsed * 0.008, 0.0])
    layer = 0.5 + 0.5 * np.sin(3.2 * w[..., 0] + 4.2 * w[..., 1] + 0.65 * w[..., 2] + 0.35 * np.sin(2.1 * w[..., 1]))
    layer2 = 0.5 + 0.5 * np.sin(1.3 * w[..., 0] - 3.1 * w[..., 1] + 0.9 * w[..., 2] + 0.7)
    return support * support * (0.08 + 0.60 * layer * layer + 0.16 * layer2)


def phase_hg(mu, g):
    return (1.0 - g * g) / (4.0 * np.pi * np.power(1.0 + g * g - 2.0 * g * mu, 1.5))


def shadow_transmittance(position, to_light, light_distance, elapsed, model, steps):
    _, exit_distance = ray_box(position, to_light, model)
    length = np.maximum(0.0, np.minimum(exit_distance, light_distance))
    ds = length / steps
    optical_depth = np.zeros(position.shape[0], dtype=np.float64)
    for index in range(steps):
        sample = position + to_light * ((index + 0.5) * ds)[:, None]
        optical_depth += density(sample, elapsed, model) * ds
    return np.exp(-(model["sigmaA"] + model["sigmaS"]) * optical_depth)


def display_transform(radiance, exposure):
    mapped = 1.0 - np.exp(-np.maximum(radiance, 0.0) * exposure)
    srgb = np.where(mapped <= 0.0031308, mapped * 12.92, 1.055 * np.power(mapped, 1.0 / 2.4) - 0.055)
    return np.uint8(np.rint(np.clip(srgb, 0.0, 1.0) * 255.0))


def render(model, width, height, view_steps, light_steps, elapsed=0.0, rows_per_chunk=32):
    sigma_t = model["sigmaA"] + model["sigmaS"]
    if sigma_t <= 0.0:
        albedo = 0.0
    else:
        albedo = model["sigmaS"] / sigma_t
    camera = np.asarray(model["camera"], dtype=np.float64)
    light_position = np.asarray(model["lightPosition"], dtype=np.float64)
    light_direction = normalize(np.asarray(model["lightTarget"]) - light_position)
    light_color = np.asarray(model["lightColor"])
    background = np.asarray(model["background"])
    pixels = np.empty((height, width, 3), dtype=np.uint8)

    for first_row in range(0, height, rows_per_chunk):
        last_row = min(height, first_row + rows_per_chunk)
        xx, yy = np.meshgrid(np.arange(width) + 0.5, np.arange(first_row, last_row) + 0.5)
        # Image rows grow downward; the shader's camera-space Y grows upward.
        uv = np.stack(((2.0 * xx - width) / height, (height - 2.0 * yy) / height), axis=-1).reshape(-1, 2)
        ray = normalize(np.column_stack((uv * model["fovTan"], -np.ones(len(uv)))))
        near, far = ray_box(camera, ray, model)
        near = np.maximum(near, 0.0)
        hit = far > near
        ds = np.where(hit, (far - near) / view_steps, 0.0)
        near = np.where(hit, near, 0.0)
        transmittance = np.ones(len(uv), dtype=np.float64)
        radiance = np.zeros((len(uv), 3), dtype=np.float64)

        for step in range(view_steps):
            position = camera + ray * (near + (step + 0.5) * ds)[:, None]
            rho = density(position, elapsed, model)
            segment_t = np.exp(-sigma_t * rho * ds)
            light_delta = light_position - position
            distance_squared = np.maximum(np.sum(light_delta * light_delta, axis=-1), 0.0001)
            distance = np.sqrt(distance_squared)
            to_light = light_delta / np.maximum(distance[:, None], 1e-12)
            cos_theta = np.sum(-to_light * light_direction, axis=-1)
            spot = smoothstep(model["cosOuter"], model["cosInner"], cos_theta)
            lit = hit & (rho > 0.0) & (spot > 0.0)
            if np.any(lit):
                light_t = shadow_transmittance(position[lit], to_light[lit], distance[lit], elapsed, model, light_steps)
                # Both propagation directions are reversed together: mu = rd · toLight.
                mu = np.clip(np.sum(ray[lit] * to_light[lit], axis=-1), -1.0, 1.0)
                incident = model["lightIntensity"] * spot[lit] * light_t / np.maximum(distance_squared[lit], 1e-12)
                weight = transmittance[lit] * albedo * (1.0 - segment_t[lit]) * phase_hg(mu, model["g"]) * incident
                radiance[lit] += light_color * weight[:, None]
            transmittance *= segment_t

        glow = np.exp(-np.sum(uv * uv, axis=-1) * 0.7)
        bg = background * (0.85 + 0.15 * glow)[:, None]
        radiance += bg * transmittance[:, None]
        pixels[first_row:last_row] = display_transform(radiance, model["exposure"]).reshape(last_row - first_row, width, 3)
    return pixels


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=SOURCE)
    parser.add_argument("--output", type=Path, default=ROOT / "assets/images/dust-volume-fallback.png")
    parser.add_argument("--width", type=int, default=640)
    parser.add_argument("--height", type=int, default=560)
    parser.add_argument("--view-steps", type=int, default=96)
    parser.add_argument("--light-steps", type=int, default=12)
    parser.add_argument("--time", type=float, default=0.0)
    parser.add_argument("--match-gpu", action="store_true", help="Use the live renderer's sample counts instead of reference defaults")
    args = parser.parse_args()
    if min(args.width, args.height, args.view_steps, args.light_steps) <= 0:
        parser.error("Image dimensions and integration sample counts must be positive")
    model, source_hash = load_model(args.source)
    view_steps = model["viewSteps"] if args.match_gpu else args.view_steps
    light_steps = model["lightSteps"] if args.match_gpu else args.light_steps
    start = time.perf_counter()
    result = render(model, args.width, args.height, view_steps, light_steps, args.time)
    metadata = PngImagePlugin.PngInfo()
    metadata.add_text("Description", "CPU reference: Beer-Lambert extinction and Henyey-Greenstein single scattering in analytic dust")
    metadata.add_text("SourceSHA256", source_hash)
    metadata.add_text("Samples", f"{view_steps} view / {light_steps} light; midpoint quadrature")
    metadata.add_text("ElapsedSceneTime", str(args.time))
    metadata.add_text("Model", json.dumps(model, sort_keys=True))
    args.output.parent.mkdir(parents=True, exist_ok=True)
    Image.fromarray(result).save(args.output, pnginfo=metadata, optimize=True)
    print(f"Saved {args.output} ({args.width}x{args.height}, {view_steps}/{light_steps} samples, CPU {time.perf_counter() - start:.2f}s)")


if __name__ == "__main__":
    main()
