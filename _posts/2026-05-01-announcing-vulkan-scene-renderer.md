---
title: "Announcing VulkanSceneRenderer"
date: 2026-05-01
tags: [vulkan, graphics, renderer, gltf]
---

VulkanSceneRenderer is a C++23 Vulkan renderer built for real-time glTF scene
rendering, physically based materials, and renderer experimentation. The project
has reached the point where it can load production-style sample assets, render
them through a modern deferred pipeline, and expose enough debug information to
make rendering problems inspectable instead of mysterious.

![Sponza lion relief rendered in VulkanSceneRenderer](/assets/blog/vulkan-scene-renderer/sponza-lion-relief.png)

## What It Renders

The renderer supports a deferred opaque path, a forward transparent path with
order-independent transparency, and a glTF-focused material system. Current PBR
coverage includes metallic-roughness, normal maps, occlusion, emissive textures,
alpha mask and blend modes, specular, clearcoat, sheen, transmission, volume,
iridescence, dispersion, and multiple-scattering compensation for specular IBL.

![Default diagnostic scene](/assets/blog/vulkan-scene-renderer/diagnostic-default-scene.png)

The diagnostic scene is intentionally simple: a triangle, cube, and procedural
sphere under the same camera, environment, and lighting controls used by larger
assets. It gives the renderer a fast sanity check for transforms, winding,
depth, normals, lighting, and post-process output before moving on to heavier
content.

![Texture settings validation scene](/assets/blog/vulkan-scene-renderer/texture-settings-culling.png)

## Under The Hood

The frame is organized as a render graph rather than a single monolithic render
function. `RendererFrontend` owns the frame-level orchestration, while focused
managers own lighting, shadows, frame resources, culling, OIT, bloom,
environment maps, scene data, and GPU allocations. `FrameRecorder` records the
passes in graph order and keeps image layout transitions close to the pass that
needs them.

The current frame flow is:

```text
Depth prepass
  -> Hi-Z / occlusion cull
  -> G-buffer
  -> shadow cascades
  -> tile light cull
  -> GTAO
  -> deferred lighting + transparent OIT
  -> bloom
  -> post-process + debug output
```

For materials, the renderer uses a compact bridge between object data and
material data. Each object carries transform data, a normal matrix, bounds, and
an `objectInfo` vector. `objectInfo.x` stores the material index. Full material
factors, texture indices, texture transforms, and feature flags live in a
`GpuMaterial` storage buffer, with bindless sampled images and sampler metadata
in the scene descriptor set.

That keeps draw submission object-index based while still letting shaders fetch
the complete glTF material when needed:

```text
glTF material
  -> container::material::Material
  -> container::gpu::GpuMaterial
  -> shaders/material_data_common.slang::GpuMaterial

Scene object
  -> ObjectData.objectInfo.x
  -> uMaterials[objectInfo.x]
```

Opaque and alpha-masked geometry write compact G-buffer channels first. Deferred
lighting then combines per-pixel data with material-index lookups for layered
terms that do not fit cleanly in the G-buffer, such as clearcoat, sheen,
iridescence, and colored dielectric specular. Transparent and transmission
materials use the forward path, where the full material record is available
during shading.

![Sponza debug overview with material and normal views](/assets/blog/vulkan-scene-renderer/sponza-debug-overview.png)

The debug overview is part of the workflow. It makes the renderer show final
lighting alongside material, depth, normal, and intermediate views, which is
useful when investigating problems like reversed winding, incorrect sampler
state, culling mistakes, or unexpected PBR channel packing.

The next steps are to keep tightening correctness and visual quality: more
reference scenes, better glass and transmission, stronger visual baselines,
further GPU-driven rendering work, and continued cleanup around renderer
ownership boundaries.

To build it on Windows:

```powershell
cmake --preset windows-release
cmake --build out/build/windows-release --target VulkanSceneRenderer --config Release
```

To run the test suite:

```powershell
ctest --test-dir out/build/windows-release --output-on-failure
```

VulkanSceneRenderer is now a working foundation for renderer experiments:
grounded in glTF assets, explicit about its frame graph, and instrumented enough
to make every rendered image explainable.
