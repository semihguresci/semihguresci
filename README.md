# Semih Güreşçi

I'm a GPU rendering and performance engineer in Luxembourg. I build real-time rendering systems for mobile XR and desktop graphics, and I measure every optimization before and after the change.

## What I work on

- **Vulkan:** a low-level API for graphics and compute on the GPU. I build renderers and benchmarks with it.
- **GPU performance:** finding where a frame spends its time, then testing changes with measurements.
- **WebGPU:** the browser API for GPU work. The live background on my website is a WebGPU rendering.

## Links

- Website: [semihguresci.com](https://semihguresci.com/), with results, selected work, and contact details
- CV: [download the CV as a PDF](https://semihguresci.com/assets/cv/SemihGuresciCV.pdf)
- Articles: [read the writing on GPU performance and rendering](https://semihguresci.com/blog/), or follow the [RSS feed](https://semihguresci.com/feed.xml)
- LinkedIn: [my LinkedIn profile](https://www.linkedin.com/in/semihguresci/)
- Email: [semih.guresci@gmail.com](mailto:semih.guresci@gmail.com)

## Selected projects

- [Vulkan Scene Renderer](https://github.com/semihguresci/VulkanSceneRenderer): a C++23 and Vulkan 1.4 scene engine with forward and deferred pipelines, GPU-driven visibility, and glTF, BIM, and USD inspection.
- [GPU Memory Benchmarks](https://github.com/semihguresci/gpu-memory-access-benchmark): 45 Vulkan compute experiments on data layout, cache behavior, coalescing, and bandwidth.
- [Vulkan Profiling Benchmark](https://github.com/semihguresci/vk-profiling-benchmark): a small benchmark with controlled raster and compute workloads, CPU and GPU timings, and Nsight capture scripts.

## Accessibility

The website has a skip link, visible keyboard focus, text alternatives for images, and reduced-motion support. Text colors are checked against WCAG contrast guidance. Browsers without WebGPU see a static image instead of the live background, and the animation starts paused when reduced motion is requested.

If any part of the website or this page is hard to use, please tell me by email.

## About this repository

This repository contains the source for [semihguresci.com](https://semihguresci.com/). The site uses plain HTML, CSS, and JavaScript, with a Python build step. For build instructions and technical notes, see [docs/site.md](docs/site.md).
