---
title: "GPU memory benchmarks: the first five experiments"
date: 2026-05-20
last_modified_at: 2026-10-23
tags: [gpu, memory, benchmark, vulkan]
excerpt: "Five experiments establish a baseline for dispatch overhead, workgroup size, contiguous bandwidth, and indexing costs."
---

The first five experiments establish the measurement baseline for the GPU
memory access benchmark. They check dispatch correctness, compare workgroup
sizes, measure contiguous memory throughput, and isolate indexing overhead.
These results provide a reference for later experiments on data layout,
strides, cache reuse, and shared memory.

Repository: [semihguresci/gpu-memory-access-benchmark](https://github.com/semihguresci/gpu-memory-access-benchmark)

## What the baseline measures

Memory performance depends on dispatch overhead, workgroup size, read/write
bandwidth, and indexing as well as the number of bytes moved. Measuring these
separately helps explain later changes in layout, stride, gather/scatter,
cache reuse, and saturation.

## Experiment 01: Dispatch basics

Experiment 01 establishes that the Vulkan compute pipeline can upload data,
dispatch work, read results back, and produce stable GPU timing. Its plan treats
this as a harness-validation experiment first and a performance result second.

The measured run completed with 720/720 correctness-pass rows on an RTX 2080
SUPER, with GPU timestamps supported. At the largest tested problem size, the
fastest path was the `noop` variant at `0.009104 ms`.

The no-op variant provides a floor for dispatch and timing overhead.
Deterministic writes check that the benchmark launches and validates kernels
that touch memory. These checks help distinguish memory-system behavior from
measurement errors in later bandwidth results.

## Experiment 02: Local size sweep

Experiment 02 varies `local_size_x` across `32`, `64`, `128`, `256`, `512`,
and `1024`, while keeping the kernel, arithmetic, memory layout, timing path,
and correctness checks fixed. Its purpose is to determine which workgroup size
is fastest and most stable on the tested GPU, not to declare a universal best
size.

The refreshed result covered 12 cases. At the largest tested
`problem_size=2097152`, `local_size_x=512` was fastest with a median GPU time
of `0.013728 ms`. The report also notes about `414.69%` spread between the
fastest and slowest median GPU-time cases in the focus set.

Workgroup size changes scheduling, occupancy, and latency hiding even when
memory access stays contiguous. Layout and access-pattern comparisons therefore
need a consistent launch configuration.

## Experiment 03: Memory copy baseline

Experiment 03 compares `read_only`, `write_only`, and `read_write_copy` across a
size sweep. The plan uses these contiguous modes as a roofline-style reference
for later bandwidth measurements.

The refreshed result covered 3 benchmark cases. At the largest tested
`problem_size=4194304`, the fastest variant was `write_only`, with median GPU
time `0.047264 ms` and median bandwidth `354.968 GB/s`.

A later kernel that reaches only a fraction of this baseline may be limited by
layout, indexing, cache behavior, arithmetic, synchronization, or inefficient
memory transactions. The baseline provides a starting point for investigating
those costs.

## Experiment 04: Sequential indexing

Experiment 04 establishes the baseline for contiguous thread-to-data
mapping. Its plan maps one invocation to one contiguous element in both source
and destination buffers while keeping arithmetic and memory footprint fixed.

The refreshed result covered the single sequential variant. At
`problem_size=4194304`, `sequential_read_write` reached `0.084256 ms` median GPU
time and `398.244 GB/s` median bandwidth.

Adjacent invocations access adjacent elements, allowing the hardware to combine
memory requests efficiently. This provides a reference for later gather,
scatter, stride, and reuse experiments.

## Experiment 05: Global ID mapping variants

Experiment 05 asks what overhead is introduced by different ways of mapping
global IDs to logical elements. It compares `direct`, `fixed_offset`, and
`grid_stride` mapping while keeping arithmetic, memory traffic, and output
semantics constant.

The refreshed result covered 3 variants. At `problem_size=4194304`, the fastest
variant was `offset`, with median GPU time `0.079968 ms` and `419.598 GB/s`
median bandwidth.

Direct mapping provides a simple reference when exact dispatch coverage is
possible. Grid-stride loops offer more flexible launch sizing but add loop and
control-flow work. Measuring that cost separately makes later comparisons
easier to interpret.

## Using these baselines

Each experiment isolates a different part of the execution path:

| Stage | What it teaches |
| --- | --- |
| Dispatch basics | Trust the harness before trusting performance numbers. |
| Local size sweep | Memory performance depends on execution configuration, not just bytes moved. |
| Memory copy baseline | Establish a raw contiguous bandwidth denominator. |
| Sequential indexing | Define the good path for contiguous memory access. |
| ID mapping variants | Separate memory-access cost from indexing/control-flow overhead. |

Use the same validated harness and launch configuration when comparing later
experiments. Read each result against its relevant baseline before attributing
a change to layout, access pattern, cache behavior, or shared memory.
