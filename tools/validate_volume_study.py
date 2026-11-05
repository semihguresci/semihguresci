"""Check the light-volume model used by the WebGPU demo and its CPU reference.

These are equation and layout checks on the Python reference, which mirrors
assets/js/light-volume.js. They do not compare pixels against a GPU frame.
Run from the repository root:
    python -B tools/validate_volume_study.py
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))

from render_dust_reference import SOURCE, box_span, build_volume, load_model, phase_hg, value_noise  # noqa: E402


def check(condition: bool, message: str, failures: list[str]) -> None:
    status = "pass" if condition else "FAIL"
    print(f"[{status}] {message}")
    if not condition:
        failures.append(message)


def main() -> int:
    model, _ = load_model(SOURCE)
    failures: list[str] = []
    rng = np.random.default_rng(7)

    # Henyey-Greenstein phase must integrate to one over the sphere: integral of 2*pi*p(mu) dmu.
    mu = np.linspace(-1.0, 1.0, 200001)
    for g in (0.0, model["g"], 0.8):
        integral = np.trapezoid(2.0 * np.pi * phase_hg(mu, g), mu)
        check(abs(integral - 1.0) < 1e-4, f"HG phase normalizes for g={g:.2f} (integral {integral:.6f})", failures)

    # Noise is periodic with its lattice period in every octave and stays in [0, 1].
    x = rng.uniform(0.0, 3.0, size=(4096, 3))
    for period in (3, 6, 12, 24):
        base = value_noise(x[:, 0], x[:, 1], x[:, 2], period)
        shifted = value_noise(x[:, 0] + period, x[:, 1], x[:, 2], period)
        check(np.allclose(base, shifted, atol=1e-9), f"value noise is periodic with period {period} cells", failures)
    values = value_noise(x[:, 0], x[:, 1], x[:, 2], 3)
    check(values.min() >= 0.0 and values.max() <= 1.0, "value noise stays within [0, 1]", failures)

    # The baked volume is normalized and well distributed for the wisp thresholds.
    grid = build_volume(model)
    check(grid.min() >= 0.0 and grid.max() <= 1.0, "baked volume stays within [0, 1]", failures)
    low, high = model["wispLow"], model["wispHigh"]
    share = float(np.mean((grid > low) & (grid < high)))
    check(0.05 < share < 0.95, f"wisp thresholds cover a useful share of the volume ({share:.2f} in transition band)", failures)

    # The lamp and camera stay outside the dust envelope, so the spotlight never sits inside the medium.
    ellipsoid = np.asarray(model["ellipsoid"])
    for name in ("lightPosition", "camera"):
        point = np.asarray(model[name])
        radius = float(np.sum((point / ellipsoid) ** 2))
        check(radius > 1.0, f"{name} lies outside the dust envelope (r^2 = {radius:.2f})", failures)

    # Ray-box span: a ray through the centre crosses the envelope symmetrically.
    origin = np.array([0.0, 0.0, 6.0])
    direction = np.array([0.0, 0.0, -1.0])
    span = box_span(origin, direction, ellipsoid)
    expected = (6.0 - ellipsoid[2], 6.0 + ellipsoid[2])
    check(np.allclose(span, expected, atol=1e-6), "axis-aligned ray spans the ellipsoid exactly", failures)

    if failures:
        print(f"{len(failures)} check(s) failed.")
        return 1
    print("Light-volume model checks pass.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
