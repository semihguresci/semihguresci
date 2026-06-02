---
title: "What Experiment 07 Teaches About GPU Memory: AoSoA and Blocked Layouts"
date: 2026-05-21
tags: [gpu, memory, benchmark, vulkan]
---

Experiment 06 gave us the clean result: for field-wise GPU work, SoA beats AoS
because neighboring threads read neighboring values from the same field.

Experiment 07 asks the more practical follow-up question:

What if full SoA is too intrusive?

Repository: [semihguresci/gpu-memory-access-benchmark](https://github.com/semihguresci/gpu-memory-access-benchmark)

That is where AoSoA, or Array of Structures of Arrays, comes in. It is a hybrid
layout. It tries to keep some of the object-like grouping of AoS while
recovering some of the field-contiguous access pattern of SoA. The experiment
plan describes this directly: Experiment 07 evaluates blocked record layouts
that sit between pure AoS and pure SoA. Its main question is whether AoSoA can
recover some of SoA's access efficiency without fully splitting every field into
its own array.

## The Problem With The Two Extremes

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

That is convenient for CPU-style object thinking. Each particle is one thing.

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

That is better for many GPU kernels because neighboring GPU lanes often read
the same field from neighboring elements. The project README explains the
underlying memory idea: neighboring lanes reading neighboring addresses allow
requests to be merged more efficiently, while strided or misaligned access
causes the hardware to move more bytes for the same useful work.

But SoA can be painful in real code. It may require changing data ownership,
CPU-side APIs, serialization, update systems, debugging tools, and shader
interfaces.

Experiment 07 is interesting because it studies the compromise.

## What AoSoA Is Trying To Do

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

The exact block size depends on the implementation, but the purpose is the
same: keep field values close together for a group of elements, without forcing
the entire application into a fully separate-array representation.

That makes AoSoA an engineering compromise. It is not as simple as AoS, and it
is not as pure as SoA. It exists for cases where full SoA is too disruptive but
plain AoS leaves too much GPU memory performance on the table.

## What Experiment 07 Measured

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

The outputs are:

- median GPU time by layout
- relative speedup vs AoS
- practical guidance on whether blocked layouts justify their complexity

That last output is important. Experiment 07 is not only asking which variant
is fastest. It is asking whether the hybrid layout is worth the extra design
complexity.

## The Result

The refreshed run completed successfully. The report says the latest
`full_refresh_20260405` collection passed 60/60 correctness rows, the test
suite passed 37/37, GPU timestamps were supported, and the measured GPU was an
NVIDIA GeForce RTX 2080 SUPER running Vulkan 1.4.325.

At the largest tested size, `problem_size=2000000`, the fastest layout was
still:

| Metric | Value |
| --- | ---: |
| Variant | `soa` |
| Median GPU time | `7.540736 ms` |
| Median GB/s | `21.218` |
| Median throughput | `265,226,099.946` |

The report also says the fastest and slowest median GPU-time cases in the focus
set were separated by about `1414.79%`, so layout choice produced a large
spread on this GPU.

The important point is not just that SoA won. The important point is that AoSoA
did not automatically erase the gap.

## Compromise Layouts Must Earn Their Complexity

AoSoA sounds attractive because it promises a middle path. It can preserve some
locality and grouping while improving field-wise access. But Experiment 07
reminds us that a compromise layout is still a compromise.

If the kernel is strongly field-oriented, full SoA may still be the cleanest
match for the GPU memory system. Neighboring threads want neighboring values
from the same field. SoA gives them exactly that.

AoSoA can help when the rest of the program cannot tolerate full SoA. For
example, it may be useful when:

- CPU-side systems still want grouped records
- data is processed in fixed-size chunks
- a renderer or simulation uses block-local batches
- only part of the codebase is GPU-facing
- full SoA would make APIs or tooling too awkward

But AoSoA is not free. It introduces block math, indexing complexity, and layout
decisions. You now have to choose block size, handle tails, map logical indices
to block-local indices, and keep CPU and GPU code in agreement.

That complexity is worth it only if the measured result justifies it.

Experiment 07's own interpretation says AoSoA should be read as a tradeoff
study rather than a binary winner-take-all test. If the blocked layout wins, it
may be the best engineering choice when full SoA is intrusive.

In this run, however, the fastest result at the largest tested size came from
SoA.

## How To Think About AoSoA In Real Projects

The practical design question is not:

Is AoSoA faster than AoS?

The better question is:

Is AoSoA close enough to SoA to justify avoiding a full SoA rewrite?

That is a very different question.

A full SoA layout is often the best answer for a pure GPU data path. But many
real systems are not pure GPU data paths. They have CPU simulation, asset
loading, editor tooling, debug views, serialization formats, and mixed
read/write ownership. In those systems, AoSoA may be valuable even if it does
not beat SoA.

The tradeoff looks like this:

| Layout | Strength | Weakness |
| --- | --- | --- |
| AoS | Simple object model | Poor fit for field-wise GPU access |
| SoA | Best match for contiguous field access | Can be intrusive to integrate |
| AoSoA | Middle ground between grouping and field locality | More complex indexing and tuning |

Experiment 07 teaches that AoSoA should be treated as a design tool, not a
magic optimization.

## Conclusion

Experiment 07 teaches a more nuanced version of the AoS vs SoA lesson.

Experiment 06 showed that SoA is the right default for field-wise GPU kernels.
Experiment 07 asks whether a blocked hybrid layout can offer a practical
compromise. The answer is: maybe, but measure it.

On the tested RTX 2080 SUPER run, full SoA was still the fastest layout at the
largest tested problem size, reaching `7.540736 ms` median GPU time for
2,000,000 elements. The result also showed a large performance spread across
the focus set, which means layout remained a major performance factor.

The engineering rule is:

Use SoA when the GPU data path can support it. Use AoSoA when full SoA is too
disruptive, but only after benchmarking the blocked layout against both AoS and
SoA.

AoSoA is not the winner by default. Its value is that it gives you another point
in the design space: less rigid than full SoA, more GPU-friendly than plain AoS,
and useful when architecture constraints matter as much as raw speed.
