# Semih Güreşçi

**GPU rendering and performance engineer · Luxembourg**

I build real-time rendering systems in C++ and Vulkan for mobile XR and desktop graphics. I use GPU profiling and controlled benchmarks to measure how changes affect frame time and memory bandwidth.

[Portfolio](https://semihguresci.com/) · [Writing](https://semihguresci.com/blog/) · [CV (PDF)](https://semihguresci.com/assets/cv/SemihGuresciCV.pdf) · [LinkedIn](https://www.linkedin.com/in/semihguresci/) · [Email](mailto:semih.guresci@gmail.com)

## Selected projects

### [Vulkan Scene Renderer](https://github.com/semihguresci/VulkanSceneRenderer)

A C++23 and Vulkan 1.4 renderer with forward and deferred raster pipelines, progressive path tracing, GPU culling, and glTF, BIM, and USD scene inspection.

[Renderer write-up](https://semihguresci.com/blog/announcing-vulkan-scene-renderer/)

![The Sponza courtyard rendered with progressive path tracing in Vulkan Scene Renderer](https://semihguresci.com/assets/blog/vulkan-scene-renderer/current/sponza-daylight.webp)

### [GPU memory experiments](https://github.com/semihguresci/gpu-memory-access-benchmark)

45 Vulkan compute experiments on memory layout, coalescing, cache locality, bandwidth, and synchronization.

[Nine-part experiment series](https://semihguresci.com/blog/gpu-memory-experiments-series/)

### [Vulkan Profiling Benchmark](https://github.com/semihguresci/vk-profiling-benchmark)

Controlled raster and compute workloads with separate CPU and GPU timings, JSON output, and Nsight capture scripts.

[Benchmark walkthrough](https://semihguresci.com/blog/vk-bench-first-look/)

## About this repository

This repository contains the source for [semihguresci.com](https://semihguresci.com/), including the interactive WebGPU volume-lighting study. See the [build and technical notes](docs/site.md) or subscribe to the [RSS feed](https://semihguresci.com/feed.xml).

## Accessibility

The website has a skip link, visible keyboard focus, text alternatives for images, and reduced-motion support. Text colors are checked against WCAG contrast guidance. Browsers without WebGPU see a static image instead of the live background, and the animation starts paused when reduced motion is requested.

If any part of the website or this page is hard to use, please tell me by email.
