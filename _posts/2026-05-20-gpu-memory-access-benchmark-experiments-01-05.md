---
title: "What Experiments 01-05 Teach About GPU Memory"
date: 2026-05-20
tags: [gpu, memory, benchmark, vulkan]
---

The first five experiments in the GPU memory access benchmark are best
understood as the foundation layer of the suite. They are not yet the dramatic
layout and coalescing experiments like AoS vs SoA or strided access. Instead,
they answer a more basic question: can we trust the benchmark harness, and what
does the GPU's good path look like before we intentionally make memory access
worse?

Repository: [semihguresci/gpu-memory-access-benchmark](https://github.com/semihguresci/gpu-memory-access-benchmark)

The project frames Experiments 01-05 as the starting point for benchmark
methodology and execution-model intuition before moving into layout,
access-pattern, cache, and saturation studies.

## Core Lesson

GPU memory performance is not only about how many bytes are moved. It depends on
the whole execution path: dispatch overhead, workgroup size, baseline read/write
bandwidth, sequential mapping, and the cost of more flexible indexing. Only
after those are understood can later experiments fairly explain why layout,
stride, gather/scatter, cache reuse, and shared memory matter.

## Experiment 01: Dispatch Basics

Experiment 01 establishes that the Vulkan compute pipeline can upload data,
dispatch work, read results back, and produce stable GPU timing. Its plan treats
this as a harness-validation experiment first and a performance result second.

The measured run completed with 720/720 correctness-pass rows on an RTX 2080
SUPER, with GPU timestamps supported. At the largest tested problem size, the
fastest path was the `noop` variant at `0.009104 ms`.

The memory lesson is simple but important: before measuring memory bandwidth,
prove that the measurement path itself is sane. A no-op path gives a floor for
dispatch and timing overhead. A deterministic write path proves that actual
memory-touching kernels are being launched and validated correctly. Without
this, later GB/s numbers could be artifacts of the harness rather than the
memory system.

## Experiment 02: Local Size Sweep

Experiment 02 varies `local_size_x` across `32`, `64`, `128`, `256`, `512`,
and `1024`, while keeping the kernel, arithmetic, memory layout, timing path,
and correctness checks fixed. Its purpose is to determine which workgroup size
is fastest and most stable on the tested GPU, not to declare a universal best
size.

The refreshed result covered 12 cases. At the largest tested
`problem_size=2097152`, `local_size_x=512` was fastest with a median GPU time
of `0.013728 ms`. The report also notes about `414.69%` spread between the
fastest and slowest median GPU-time cases in the focus set.

The memory lesson: the same contiguous memory access pattern can perform
differently depending on how work is grouped. Workgroup size influences
scheduling, occupancy, latency hiding, and how efficiently memory traffic is fed
into the GPU. This means memory experiments need a stable launch configuration
before comparing layouts or access patterns.

## Experiment 03: Memory Copy Baseline

Experiment 03 defines the project's practical memory-throughput denominator. It
compares the simplest contiguous modes: `read_only`, `write_only`, and
`read_write_copy`, across a size sweep. The plan describes it as the closest
thing to a roofline-style denominator for later bandwidth claims.

The refreshed result covered 3 benchmark cases. At the largest tested
`problem_size=4194304`, the fastest variant was `write_only`, with median GPU
time `0.047264 ms` and median bandwidth `354.968 GB/s`.

The memory lesson: you need a raw contiguous bandwidth baseline before judging
any optimized or unoptimized kernel. A later kernel that reaches only a fraction
of this baseline may be limited by layout, indexing, cache behavior, extra
arithmetic, synchronization, or memory transaction inefficiency. Without this
denominator, fast and slow are just labels.

## Experiment 04: Sequential Indexing

Experiment 04 establishes the good-path baseline for contiguous thread-to-data
mapping. Its plan maps one invocation to one contiguous element in both source
and destination buffers while keeping arithmetic and memory footprint fixed.

The refreshed result covered the single sequential variant. At
`problem_size=4194304`, `sequential_read_write` reached `0.084256 ms` median GPU
time and `398.244 GB/s` median bandwidth.

The memory lesson: contiguous indexing is the reference case for later
penalties. This is the healthy memory pattern: adjacent invocations touch
adjacent elements, which is exactly the access shape GPU memory systems are
designed to handle well. Later gather, scatter, stride, and reuse experiments
should be interpreted relative to this baseline rather than in isolation.

## Experiment 05: Global ID Mapping Variants

Experiment 05 asks what overhead is introduced by different ways of mapping
global IDs to logical elements. It compares `direct`, `fixed_offset`, and
`grid_stride` mapping while keeping arithmetic, memory traffic, and output
semantics constant.

The refreshed result covered 3 variants. At `problem_size=4194304`, the fastest
variant was `offset`, with median GPU time `0.079968 ms` and `419.598 GB/s`
median bandwidth.

The memory lesson: indexing flexibility has a cost, but the cost has to be
measured rather than assumed. Direct mapping is the cleanest reference path when
exact dispatch coverage is possible. Grid-stride loops add scalability and
launch flexibility, but they also add loop and control-flow behavior that can
matter in a tight memory benchmark.

## The Combined Takeaway

Experiments 01-05 build a disciplined baseline:

| Stage | What it teaches |
| --- | --- |
| Dispatch basics | Trust the harness before trusting performance numbers. |
| Local size sweep | Memory performance depends on execution configuration, not just bytes moved. |
| Memory copy baseline | Establish a raw contiguous bandwidth denominator. |
| Sequential indexing | Define the good path for contiguous memory access. |
| ID mapping variants | Separate memory-access cost from indexing/control-flow overhead. |

Together, these experiments say: GPU memory optimization starts before layout
optimization. You first need a validated benchmark, a stable workgroup size, a
raw throughput baseline, a contiguous indexing reference, and a measured
understanding of indexing overhead. Only then can later experiments credibly
explain why SoA beats AoS, why stride destroys bandwidth, why cache locality
matters, and why shared memory is not automatically faster.
