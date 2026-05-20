---
title: "What Experiment 06 Teaches About GPU Memory: AoS vs SoA"
date: 2026-05-20
tags: [gpu, memory, benchmark, vulkan]
---

Experiment 06 is where the GPU memory access benchmark stops asking "can we
measure GPU memory correctly?" and starts asking a more practical question:

How much performance can we lose just by arranging the same data in the wrong
shape?

Repository: [semihguresci/gpu-memory-access-benchmark](https://github.com/semihguresci/gpu-memory-access-benchmark)

The experiment compares two layouts for the same logical particle-style update:
AoS, or Array of Structs, and SoA, or Struct of Arrays. The plan is
intentionally simple: run the same kernel over identical particle data, touch
the same fields, keep the arithmetic fixed, and only change the memory layout.
That makes Experiment 06 a clean test of layout efficiency, not a test of
different algorithms.

## The Basic Idea

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

That feels natural from a CPU programming point of view. Each particle is one
object, and all of its fields live together.

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

The logical data is the same. The GPU kernel is still updating particles. But
the byte stream seen by the GPU is completely different.

## Why This Matters On A GPU

A GPU does not process one particle at a time in isolation. It runs many
neighboring threads together. When neighboring threads read neighboring memory
addresses, the hardware can combine those requests efficiently. This is the
good path: adjacent lanes, adjacent addresses, fewer wasted memory
transactions.

AoS fights that pattern when the kernel is field-oriented.

Suppose each GPU thread needs to read the `x` position of one particle. In AoS,
thread 0 reads `particles[0].x`, thread 1 reads `particles[1].x`, thread 2
reads `particles[2].x`, and so on. Those `x` values are not packed next to each
other. They are separated by the size of the whole `Particle` record.

In SoA, the same access becomes `x[0]`, `x[1]`, `x[2]`, `x[3]`. Now the values
are contiguous. That is exactly what the GPU memory system wants.

This is the core lesson of Experiment 06:

For field-wise GPU work, SoA usually gives the GPU a cleaner memory stream than
AoS.

The experiment plan says the same thing directly: field-wise access usually
favors SoA because threads read contiguous values from the same field.

## What The Experiment Measured

Experiment 06 tested two variants:

```text
aos
soa
```

Both variants used the same logical particle data and the same logical update.
The outputs were median GPU time, useful-payload GB/s, and SoA speedup relative
to AoS.

The refreshed run completed successfully: 10/10 correctness rows passed, GPU
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

The report also notes that the fastest and slowest median GPU-time cases in
this focus set were separated by about `2751.14%`, so this was not a tiny
layout difference. It was a major performance gap.

The repository README summarizes the same finding more bluntly: for Experiment
06, SoA shows a `28.42x` GPU-time speedup and a `+2032%` effective-bandwidth
gain over AoS for the measured 64 MiB, 1,000,000 element case.

## Layout Is Part Of The Algorithm

It is tempting to think of data layout as a low-level detail. Experiment 06
shows that this is wrong.

The arithmetic did not become smarter. The particle update did not change
meaning. The benchmark did not switch to a different algorithm. The major
change was how the data was placed in memory.

That means the layout itself became a performance feature.

For CPU-style code, AoS often feels cleaner:

```cpp
particles[i].x += particles[i].vx * dt;
particles[i].y += particles[i].vy * dt;
particles[i].z += particles[i].vz * dt;
```

But on the GPU, the important question is not only "what fields does one
particle need?" It is also:

What addresses do neighboring GPU threads touch at the same time?

If neighboring threads all need the same field from neighboring elements, SoA
gives the GPU a dense stream of useful values. AoS gives it a wider stride
through records, pulling the useful field along with nearby fields that may not
be needed at that moment.

That is why AoS can waste bandwidth even when the code looks perfectly
reasonable.

## When AoS Can Still Make Sense

Experiment 06 should not be read as "AoS is always bad." It should be read more
carefully:

AoS is bad for this kind of field-wise GPU access.

AoS can still be reasonable when a kernel truly consumes most or all of each
record per element. If every thread reads the full particle record and uses all
fields together, AoS may waste less than it does in a field-wise workload. AoS
can also be convenient for CPU-side ownership, debugging, serialization, or code
organization.

But Experiment 06 gives a strong default rule:

When many GPU threads read the same field across many records, start with SoA.

Use AoS only when the access pattern justifies it.

## A Practical Design Rule

For GPU memory layout, the question should not be:

What is the most natural object model?

It should be:

What layout makes neighboring GPU threads read neighboring useful values?

For particle systems, vertex attributes, transforms, instance data, simulation
state, animation channels, or large arrays of records, this rule matters a lot.
A layout that looks elegant in C++ can become expensive once thousands of GPU
threads march through it.

Experiment 06 makes that cost visible.

The benchmark result is especially valuable because it isolates the issue. Same
data. Same logical work. Same output contract. Different layout. The SoA version
wins because it better matches the way the GPU wants to fetch memory.

## Conclusion

Experiment 06 teaches one of the most important GPU memory lessons:

The GPU does not care how elegant your struct is. It cares whether neighboring
lanes touch neighboring addresses.

AoS organizes memory around objects. SoA organizes memory around fields. For
field-wise GPU kernels, fields are usually the better unit of memory
organization.

The measured result is dramatic on the tested GPU: SoA is the clear winner for
this workload, with the fastest median time at `2.465888 ms` for 1,000,000
elements and a very large gap between the fastest and slowest layout cases.

The caveat is also important: these numbers come from one GPU and driver stack,
and the repo warns that different kernels, sizes, drivers, or GPUs may shift
rankings. GB/s values should be compared within the experiment before being
compared across experiments.

But the engineering lesson is stable:

On GPUs, memory layout is not a storage detail. It is a performance decision.
