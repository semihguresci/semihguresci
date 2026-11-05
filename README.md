# Semih Güreşçi — personal portfolio

A static portfolio for GPU rendering and performance work: a live WebGPU volume-lighting background, measured results, selected projects, writing, and a CV page. The site uses HTML, CSS, and JavaScript without a framework or runtime dependencies.

## Local review

From the project directory in PowerShell:

```powershell
./serve-local.ps1
```

Open **http://127.0.0.1:4000**. The script builds the source into `.preview/` and serves it locally. After editing, rebuild with `./serve-local.ps1 -BuildOnly`, then refresh the page.

## Static build

The Python template and Markdown renderer in `tools/preview_site.py` is also the static build tool. It uses the Python standard library only; Jekyll, Ruby, npm packages, and a backend are not required.

```powershell
python -B tools/preview_site.py --source . --output dist
```

`dist/` contains the complete site, including `.nojekyll`, assets, articles, the CV, the 404 page, and the custom domain file. It can be served on GitHub Pages or another static host. Building locally does not publish anything. The templates stay within the Liquid subset that the builder supports, and they remain compatible with the Jekyll structure.

## Structure

- `index.html`: the home page. The hero background is the live WebGPU study. The page continues with results, selected work, capabilities, the method, experience, writing, about, and contact.
- `cv/index.html`: the CV page. **Download PDF** serves `assets/cv/SemihGuresciCV.pdf`, the original supplied CV.
- `blog/index.html` and `_posts/`: the writing index and the articles. Article URLs are preserved. Posts marked `featured: true` appear on the home page.
- `feed.xml`: the RSS feed of all articles, linked from every page.
- `_layouts/` and `_includes/`: the page shell, navigation, metadata, and article layout.
- `_data/projects.yml`: the repository list on the home page.
- `_config.yml`: site settings. `reading_wpm` sets the reading-time estimate for articles, which excludes code blocks.
- `404.html`: the not-found page (noindex).
- `assets/css/style.css`: the design system, responsive layouts, and reduced-motion support.
- `assets/js/site.js`: navigation, section highlighting, reveal animations, and the article progress bar.
- `assets/js/light-volume.js`: the WebGPU background and its shared `MODEL` parameters.
- `tools/`: the static builder, the reference renderer, the image generator, and the model checks.

## WebGPU background

The hero background is a single-scattering volume lit by a spotlight. It is rendered full-bleed behind the copy and runs on WebGPU only. When WebGPU is unavailable or the device is lost, the page keeps the static render from `assets/images/dust-volume-fallback.webp`.

Each frame does the following:

1. **Density:** a 64³ value-noise volume is baked by a compute pass at startup. Each density sample is one trilinear fetch. The field drifts across the frame, and a time-varying warp makes the dust boil, so the structure keeps changing. An analytic ellipsoid envelope keeps the edges soft.
2. **Trace:** each pixel takes one jittered estimate. Each sample marches toward the spotlight to estimate shadowing. A cool ambient term adds fill, and a stylized lamp glare marks the source.
3. **Accumulation:** the estimate is blended into a running average of eight frames. That smooths the jitter without smearing the moving dust. The average restarts when the light moves.
4. **Present:** an ACES tone map, a small glow around bright regions, a vignette, and triangular dither before the sRGB encode.

The HUD reports GPU time from timestamp queries when the browser exposes them, and it plots the last 120 samples against a 10 ms budget. In Auto quality, the render scale adjusts to hold that budget. Eco, Balanced, and Ultra fix the scale and sample counts.

Controls: pointer movement steers the light, and the pause button stops the motion. Reduced motion starts paused. The animation also pauses when the hero leaves the viewport or when the tab is hidden.

### Volume model

Distances are normalized scene units, and radiance is relative. Density is a prescribed field, not a fluid or particle simulation. Multiple scattering is omitted. The parameters live in the `MODEL` object at the top of `assets/js/light-volume.js`:

```text
density(p, t) = envelope(p) * (floor + gain * smoothstep(low, high, noise(q)))
q = p / extent + 0.5 + drift * t / extent + warpAmount * warp(t)
Tsegment = exp(-sigmaT * density * stepLength)
L += Tview * (sigmaS / sigmaT) * (1 - Tsegment) * (incident * phaseHG(mu) + ambient)
Tview *= Tsegment
```

`warp(t)` is a smooth set of sine offsets in the three axes, so the dust boils as well as drifting. `sigmaT = sigmaA + sigmaS`. The segment transmittance is analytic. The in-scattered light is sampled at the jittered point. The spotlight has inverse-square falloff and a soft cone. The Henyey–Greenstein phase uses `g = 0.30`. The references are [Beer–Lambert transmittance](https://www.pbr-book.org/4ed/Volume_Scattering/Transmittance) and [Henyey–Greenstein scattering](https://www.pbr-book.org/4ed/Volume_Scattering/Phase_Functions).

Because the same `MODEL` object feeds both the WGSL shaders and the Python reference, editing a parameter there and regenerating the fallback keeps the static image in step with the live background.

## Tools

`python -B tools/render_dust_reference.py` regenerates `assets/images/dust-volume-fallback.webp` from `MODEL` at 1600×900, with 96 view and 12 light midpoint samples and the moment `--time` (default 0). It applies the same warp, bloom, tone map, vignette, and dither as the live pass. Options: `--width`, `--height`, `--view-steps`, `--light-steps`, `--time`, and `--output`. NumPy and Pillow are needed only for this development step.

`python -B tools/build_web_images.py` creates WebP variants of the large home-page images and the 1200×630 social card at `assets/images/og-card.jpg`. The source images stay in place, so the articles keep their original files. Run it again after replacing a source image or the fallback.

`python -B tools/validate_volume_study.py` checks the Python reference against the model: the Henyey–Greenstein normalization, the noise periodicity and range, the baked volume distribution, the placement of the lamp and camera outside the dust envelope, and the ray–box span. These are equation and layout checks. They do not compare pixels with a GPU frame.

## Color and typography

The palette is dark and restrained. Graphite and ivory carry the text. Warm amber marks actions, focus, and the spotlight. Cyan marks measured values. Manrope and IBM Plex Mono are self-hosted. Their open font licenses are in `assets/fonts/`.

Text and control color pairs are checked against the [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html). Color is reinforced by text, shape, and position, following the [use of color guidance](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).
