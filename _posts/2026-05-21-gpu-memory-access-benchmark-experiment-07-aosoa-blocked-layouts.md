---
title: "AoSoA and blocked layouts: measuring the tradeoffs"
date: 2026-05-21
last_modified_at: 2026-10-23
tags: [gpu, memory, benchmark, vulkan]
excerpt: "A comparison of AoS, SoA, and blocked AoSoA layouts, including the performance and integration tradeoffs."
---

Experiment 06 found that SoA was faster than AoS for its field-wise GPU
workload. Experiment 07 adds a blocked Array of Structures of Arrays (AoSoA)
layout to the comparison. Each block groups a small set of elements while
storing each field contiguously within that group.

Repository: [semihguresci/gpu-memory-access-benchmark](https://github.com/semihguresci/gpu-memory-access-benchmark)

The plan evaluates whether blocked storage can recover some of SoA's access
efficiency while keeping records grouped. The experiment measures whether that
benefit justifies the additional indexing and integration costs.

## The layouts

In an AoS layout, each particle is stored as one full record:

```cpp
struct Particle {
    float x;
    float y;
    float z;
    float vx;
    float vy;
    float vz;
};

Particle particles[N];
```

Memory looks roughly like this:

```text
x0 y0 z0 vx0 vy0 vz0 | x1 y1 z1 vx1 vy1 vz1 | x2 y2 z2 ...
```

Each particle and all of its fields are stored together.

In a SoA layout, every field gets its own array:

```cpp
float x[N];
float y[N];
float z[N];
float vx[N];
float vy[N];
float vz[N];
```

Memory looks like this:

```text
x0 x1 x2 x3 ...
y0 y1 y2 y3 ...
z0 z1 z2 z3 ...
```

For field-wise GPU kernels, neighboring lanes can read consecutive values from
the same array. As the project README explains, these requests can be combined
more efficiently. Strided or misaligned accesses can require more bytes to be
moved for the same useful work.

Adopting SoA can also require changes to data ownership, CPU APIs,
serialization, update systems, debugging tools, and shader interfaces. AoSoA
offers another way to organize data when those changes are costly.

## How blocked storage works

AoSoA groups elements into small blocks. Inside each block, fields are split
like SoA. Across blocks, the data is still grouped into chunks.

Instead of this AoS shape:

```text
particle0 | particle1 | particle2 | particle3 | particle4 | particle5 ...
```

And instead of this full SoA shape:

```text
all x values | all y values | all z values | all vx values | all vy values ...
```

AoSoA looks more like this:

```text
block 0:
  x0 x1 x2 x3
  y0 y1 y2 y3
  z0 z1 z2 z3
  vx0 vx1 vx2 vx3
  vy0 vy1 vy2 vy3
  vz0 vz1 vz2 vz3

block 1:
  x4 x5 x6 x7
  y4 y5 y6 y7
  z4 z5 z6 z7
  ...
```

The block size depends on the implementation. Within each block, values from
the same field stay close together; the application can still work with groups
of elements rather than separate arrays spanning the entire dataset.

## Method

Experiment 07 compares three layouts:

```text
aos
aosoa_blocked
soa
```

The method keeps the logical particle update fixed while changing only the
storage layout: interleaved storage for AoS, blocked storage for AoSoA, and
fully split storage for SoA. The plan also keeps the workload size, timing path,
and correctness rules consistent across layouts, so the comparison is about
layout rather than a different algorithm.

The experiment reports:

- median GPU time by layout
- relative speedup vs AoS
- practical guidance on whether blocked layouts justify their complexity

## Results

The report's `full_refresh_20260405` collection passed 60/60 correctness rows,
and the test suite passed 37/37. GPU timestamps were supported, and the
measured GPU was an
NVIDIA GeForce RTX 2080 SUPER running Vulkan 1.4.325.

At the largest tested size, `problem_size=2000000`, SoA was fastest:

| Metric | Value |
| --- | ---: |
| Variant | `soa` |
| Median GPU time | `7.540736 ms` |
| Median GB/s | `21.218` |
| Median throughput | `265,226,099.946` |

The report also records about `1414.79%` separation between the fastest and
slowest median GPU-time cases in the focus set. On this GPU, blocked storage
did not close the gap to SoA at the largest tested size.

## Integration tradeoffs

SoA directly supports contiguous field access. AoSoA can be useful when the
surrounding system benefits from grouping, for example when:

- CPU-side systems still want grouped records
- data is processed in fixed-size chunks
- a renderer or simulation uses block-local batches
- only part of the codebase is GPU-facing
- full SoA would make APIs or tooling too awkward

Blocked storage introduces a block-size choice, tail handling, and extra index
calculations. Its CPU and shader representations must also agree. The
experiment's interpretation treats this as a tradeoff study: an acceptable
performance gap to SoA may be worthwhile if it avoids a costly conversion of
CPU simulation, asset loading, editor tools, or serialization code.

| Layout | Strength | Weakness |
| --- | --- | --- |
| AoS | Simple object model | Poor fit for field-wise GPU access |
| SoA | Best match for contiguous field access | Can be intrusive to integrate |
| AoSoA | Middle ground between grouping and field locality | More complex indexing and tuning |

Use the measured difference to assess that tradeoff. Compare the chosen AoSoA
block size with both AoS and SoA for the actual workload before adopting it.
