# Semih Güreşçi — personal portfolio

A static portfolio with an original, interactive GPU study, engineering projects, writing, and a dedicated CV page. The frontend uses HTML, CSS, and JavaScript without a framework or runtime dependencies.

## Local review

From the project directory in PowerShell:

```powershell
./serve-local.ps1
```

Open **http://127.0.0.1:4000**. This builds the source into `.preview/` and serves it locally. After editing, rebuild with `./serve-local.ps1 -BuildOnly`, then refresh the page. The server can continue running while the files are rebuilt.

## Static build

The existing Python template and Markdown renderer is also the static build tool. It uses the Python standard library; Jekyll, Ruby, npm packages, and a backend are not required.

```powershell
python -B tools/preview_site.py --source . --output dist
```

`dist/` contains the complete site, including `.nojekyll`, assets, articles, the CV, and the existing custom domain file. It can be served on GitHub Pages or another static host. Building locally does not publish anything. The templates remain compatible with the existing Jekyll authoring structure.

## Content and design

- `index.html`: homepage content and project diagrams.
- `_posts/`: existing Markdown articles; their URLs are preserved.
- `_includes/` and `_layouts/`: shared page structure, navigation, metadata, and article layout.
- `cv/index.html` and `assets/css/cv.css`: the CV page with technical experience, skills, and projects. **Download PDF** provides the original supplied CV.
- `assets/cv/SemihGuresciCV.pdf`: original supplied one-page CV, available through the download links. Web copy selectively summarizes the rendering and performance work.
- `assets/css/style.css`: typography, colors, light/dark themes, responsive layouts, reduced-motion support.
- `assets/js/site.js`: navigation and theme controls.
- `assets/js/render-study.js`: volume integration, WGSL/WebGPU and GLSL/WebGL2 renderers, and animation lifecycle.

The hero is a light-through-dust volume study. A warm spotlight illuminates a slowly drifting, bounded analytic density field. The camera ray marches through the volume and integrates single-scattered light, including attenuation toward the camera and the light. Pointer movement steers the spotlight; Pause/Play is the only control. WebGPU is preferred, with the same model in WebGL2 and a precomputed CPU render when neither backend is available.

### Volume-study model

Distances are normalized scene units and radiance is relative. Density is a prescribed smooth field, not a fluid or particle simulation. The model uses absorption `sigmaA = 0.12`, scattering `sigmaS = 0.78`, and Henyey–Greenstein asymmetry `g = 0.35`. Extinction is `sigmaT = sigmaA + sigmaS`. Each midpoint sample treats density and incident illumination as constant over its segment:

```text
Tsegment = exp(-sigmaT * density * stepLength)
L += Tview * incomingLight * phaseHG(mu) * (sigmaS / sigmaT) * (1 - Tsegment)
Tview *= Tsegment
```

The spotlight has inverse-square falloff and a soft angular profile. A second march estimates attenuation between each scattering sample and the light. The phase-function cosine compares the incoming and outgoing photon propagation directions. The implementation follows [Beer–Lambert transmittance](https://www.pbr-book.org/4ed/Volume_Scattering/Transmittance) and [Henyey–Greenstein scattering](https://www.pbr-book.org/4ed/Volume_Scattering/Phase_Functions).

The live render uses 64 camera steps and 6 light steps. Finite midpoint quadrature and the single-scattering approximation are intentional; multiple scattering is omitted. The density support bounds the integration domain. No hierarchy, hardware benchmark, or empty-space-skipping speedup is claimed. The display targets 30 fps, with DPR at most 1.25, a 760-pixel long-edge limit, and a 300,000-pixel budget. Automatic motion pauses offscreen, in hidden tabs, and initially when reduced motion is requested.

`python -B tools/validate_volume_study.py` checks the actual WGSL and GLSL scalar helper arithmetic against homogeneous analytical slabs, vacuum and pure-absorption limits, phase-function normalization and direction, and known heterogeneous quadrature convergence. These are CPU equation checks, not a claim of full GPU image equivalence.

`python -B tools/render_dust_reference.py` generates `assets/images/dust-volume-fallback.png` from the renderer's `MODEL` parameters at the neutral light position and time zero. It uses higher sample counts for a deterministic CPU reference; `--match-gpu` uses the live sample counts instead. The PNG records the LF-normalized renderer source hash. NumPy and Pillow are needed only to regenerate this development asset.

Fonts are self-hosted. Their open font licenses are included in `assets/fonts/`.

### Color and information hierarchy

Color has a small, consistent vocabulary across the homepage, articles, and CV:

| Role | Treatment | Use |
| --- | --- | --- |
| Content and structure | Graphite, ivory, and muted neutrals | Headings, body copy, metadata, and section boundaries |
| Actions and selection | Lime, with a darker green equivalent on light surfaces | Primary links, buttons, focus, and selected viewer controls |
| Technical evidence | Blue, adjusted for each theme | Performance figures, memory cells, pipeline diagrams, and benchmark bars |

The palette keeps navigation and primary actions easy to find while giving technical diagrams a distinct visual role. Typography and contrast establish the reading order; labels and shapes keep the diagrams understandable without color. Technical panels use a dark local palette in both themes. The volume study uses a fixed warm light and neutral dust against charcoal, with a quiet scientific caption.

Text and essential control color pairs are checked against the [WCAG contrast guidance](https://www.w3.org/WAI/WCAG22/Understanding/contrast-minimum.html); color is reinforced by [text and other visual cues](https://www.w3.org/WAI/WCAG22/Understanding/use-of-color.html).
