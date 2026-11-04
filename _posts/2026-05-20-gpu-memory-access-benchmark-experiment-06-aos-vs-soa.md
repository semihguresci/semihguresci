---
title: "AoS vs SoA: measuring GPU memory access"
date: 2026-05-20
last_modified_at: 2026-10-23
tags: [gpu, memory, benchmark, vulkan]
excerpt: "A measured comparison of AoS and SoA particle layouts, with an explanation of how field access affects GPU memory traffic."
---

Experiment 06 compares Array of Structs (AoS) and Struct of Arrays (SoA)
layouts for a particle update. Both variants use the same logical data,
fields, arithmetic, and correctness checks. The variable is how the fields
are arranged in memory.

Repository: [semihguresci/gpu-memory-access-benchmark](https://github.com/semihguresci/gpu-memory-access-benchmark)

## AoS and SoA layouts

Imagine each particle has several fields:

```cpp
struct Particle {
    float x;
    float y;
    float z;
    float vx;
    float vy;
    float vz;
};
```

In an AoS layout, memory looks like this:

```cpp
Particle particles[N];
```

So the data is stored record by record:

```text
x0 y0 z0 vx0 vy0 vz0 | x1 y1 z1 vx1 vy1 vz1 | x2 y2 z2 ...
```

Each particle is one object, with all of its fields stored together.

In a SoA layout, the same data is split by field:

```cpp
float x[N];
float y[N];
float z[N];
float vx[N];
float vy[N];
float vz[N];
```

Now memory looks like this:

```text
x0 x1 x2 x3 ...
y0 y1 y2 y3 ...
z0 z1 z2 z3 ...
```

The logical data and particle update stay the same, but the addresses accessed
by neighboring GPU threads change.

## How field access affects memory traffic

A GPU runs many neighboring threads together. When those threads read
neighboring addresses, the hardware can combine their requests into fewer
memory transactions.

Suppose each GPU thread needs to read the `x` position of one particle. In AoS,
thread 0 reads `particles[0].x`, thread 1 reads `particles[1].x`, thread 2
reads `particles[2].x`, and so on. Those `x` values are not packed next to each
other. They are separated by the size of the whole `Particle` record.

In SoA, the same access becomes `x[0]`, `x[1]`, `x[2]`, `x[3]`: the values are
contiguous. The experiment plan identifies this field-wise access pattern as
one that usually favors SoA.

## Measured results

Experiment 06 tested two variants:

```text
aos
soa
```

Both variants used the same logical particle data and the same logical update.
The outputs were median GPU time, useful-payload GB/s, and SoA speedup relative
to AoS.

The recorded run passed 10/10 correctness rows. GPU
timestamps were supported, and the run was collected on an NVIDIA GeForce RTX
2080 SUPER using Vulkan 1.4.325.

At the largest tested size, `problem_size=1000000`, the fastest result came
from the `soa` variant:

| Metric | Value |
| --- | ---: |
| Variant | `soa` |
| Median GPU time | `2.465888 ms` |
| Median GB/s | `19.466` |
| Median throughput | `405,533,422.443` |

The report also notes about `2751.14%` separation between the fastest and
slowest median GPU-time cases in this focus set.

The repository README reports a `28.42x` GPU-time speedup and a `+2032%`
effective-bandwidth gain for SoA over AoS in the measured 64 MiB,
1,000,000 element case.

## Choosing a layout

AoS keeps each particle update together in the source:

```cpp
particles[i].x += particles[i].vx * dt;
particles[i].y += particles[i].vy * dt;
particles[i].z += particles[i].vz * dt;
```

For a field-wise GPU workload, however, the stride between records can bring
unused neighboring fields into memory transactions. SoA puts the useful values
next to one another. It is a sensible starting point when many threads read
the same field across many records, including particle state, vertex
attributes, transforms, instance data, and animation channels.

AoS can still suit kernels that consume most or all of each record together.
It may also fit CPU ownership, debugging, serialization, or existing interfaces
more easily. The choice depends on the fields each kernel accesses and the
cost of integrating another representation.

These results come from one GPU and driver stack. Different kernels, sizes,
drivers, or GPUs may change the rankings. Compare GB/s within this experiment
before comparing it with other experiments; the reported bandwidth measures
useful payload.
