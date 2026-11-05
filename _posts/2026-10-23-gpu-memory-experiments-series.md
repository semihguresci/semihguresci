---
title: "GPU memory experiments: a guide to the 45-study series"
date: 2026-10-23
tags: [gpu, memory, vulkan, experiments]
excerpt: "A nine-part tour of 45 Vulkan compute experiments, from dispatch timing and data layout to subgroup algorithms and rendering workloads."
featured: true
category: "GPU performance"
---

I built the GPU memory access benchmark to make memory decisions easier to
test. A particle layout, a shared-memory tile, or a compacted work list can
look convincing in source code. The useful question is what changes when it
runs: the addresses requested, the amount of useful work, the synchronization,
the output contract, and the time required to produce that output.

The project now contains 45 Vulkan compute experiments. This series walks
through their implementations and the October 23 collection, connecting the
small kernels to decisions in a rendering engine. Each article explains the
experiment, shows selected measurements, and identifies the next control that
would make the result more informative.

The [project repository](https://github.com/semihguresci/gpu-memory-access-benchmark)
contains the implementation. The measurements used here are also available as
[raw JSON snapshots and a hash manifest](/assets/blog/gpu-memory-experiments-2026-10-23/data/manifest.json)
and an [all-case median table](/assets/blog/gpu-memory-experiments-2026-10-23/data/summary.csv).
The snapshots preserve the evidence behind these articles even as the project
changes.

The earlier articles on this site describe older collections. Several
workloads, output checks, and byte formulas changed before the October run,
so those historical ratios should be read with their own methods and sizes.
This series uses the downloadable October snapshots throughout.

## Reading the series

The order moves from establishing a measurement to assembling larger pieces
of GPU work. Each article can also be read on its own.

| Part | Experiments | Main question |
| --- | --- | --- |
| [1. Dispatch and measurement](/blog/gpu-memory-experiments-01-05-dispatch-and-measurement/) | 01–05 | What does a timing interval include, and how does indexing affect it? |
| [2. Layout, padding, and precision](/blog/gpu-memory-experiments-06-10-layout-padding-and-precision/) | 06–10 | How do field organization, record stride, and representation change access? |
| [3. Access patterns and reuse](/blog/gpu-memory-experiments-11-15-access-patterns-and-reuse/) | 11–15 | What changes when accesses become strided, indirect, scattered, or repetitive? |
| [4. Tiling, registers, and barriers](/blog/gpu-memory-experiments-16-20-tiling-registers-and-barriers/) | 16–20 | When does local cooperation repay its work and synchronization costs? |
| [5. Reduction, scan, and compaction](/blog/gpu-memory-experiments-21-25-reduction-scan-and-compaction/) | 21–25 | How do communication patterns and ordering requirements shape a GPU primitive? |
| [6. Alignment, heaps, and shared memory](/blog/gpu-memory-experiments-26-29-alignment-heaps-and-shared-memory/) | 26–29 | How much does the placement and spacing of the same useful data matter? |
| [7. Subgroups, transpose, and radix sort](/blog/gpu-memory-experiments-30-34-subgroups-transpose-and-radix-sort/) | 30–34 | How do local primitives become portable building blocks for larger algorithms? |
| [8. Occupancy and rendering data](/blog/gpu-memory-experiments-35-39-occupancy-and-rendering-data/) | 35–39 | What do resource and rendering proxies actually establish? |
| [9. Queues, fusion, and reproducibility](/blog/gpu-memory-experiments-40-45-queues-fusion-and-reproducibility/) | 40–45 | Where do scheduling, stage boundaries, and repeated measurements enter the result? |

## The collection behind the numbers

All nine parts use measurement revision
`2026-10-23-integrity-fixes`. The collection contains 5,205 timed rows; every
row passed its configured output checks. Separate development runs exercised
all 45 experiments with Vulkan validation enabled. Those runs serve a
different purpose from the uninstrumented timings used in the articles.

| Setting | Collection value |
| --- | --- |
| GPU | NVIDIA GeForce RTX 2080 SUPER |
| Driver | NVIDIA 610.88 |
| Device API | Vulkan 1.4.341 |
| Timed samples | Five per variant, size, and dispatch-count case |
| Warmups | Two per case |
| Requested total scratch | 32 MiB per experiment; 128 MiB for radix sort, experiment 34 |
| Primary comparison | Median GPU time at an explicitly stated problem size and dispatch count |
| Export schema | 1.2.0 |

The scratch setting is a total buffer-payload budget. It does not mean every
variant processes 32 MiB of useful input, and it excludes allocation padding.
Different representations and auxiliary buffers leave different amounts for
logical elements. A result therefore needs its element count as well as the
command-line setting.

These exports came from a working tree with uncommitted changes. Their base
Git revision alone does not identify the measured program. Each raw file
also records its binary, source-tree, and shader-bundle hashes. The download
manifest binds the copied data and figures by SHA-256; it does not imply that
the current public branch already contains that exact build.

## Three quantities to keep separate

GPU time measures an interval chosen by the implementation. Most studies
time a dispatch or a sequence of dispatches and their required dependencies.
Experiment 28 sums upload, kernel, and readback intervals. A fused pipeline
and a staged pipeline can therefore have different timing scopes from a
single arithmetic kernel.

Throughput expresses useful logical work per second. A complete radix sort
still sorts one input stream, even when its implementation launches 12 or 24
dispatches. Counting the same keys once per pass would make extra work look
like extra useful output.

Bandwidth also needs a numerator. Some studies count useful field bytes;
others estimate source-level reads, writes, or atomic operations. Repeated
requests may be served by caches, and the estimates do not report hardware
DRAM transactions. I compare GB/s only with its experiment's byte definition
in view. The articles identify the important formulas where they affect the
comparison.

## Correctness checks have boundaries too

Several repairs made the experiment contracts clearer before this
collection. Layout variants now match their active field operations. The
register study keeps 32 chains and 256 state updates constant. The barrier
study publishes one immutable shared seed. All eight measured frames in the
coherence study retain separate validated outputs. Subgroup scans and
compaction use explicit logical indexing instead of assuming that lane IDs
match workgroup-local IDs.

There is also a useful unresolved warning in the frozen evidence. Experiment
10's host float-to-half converter compares a signed exponent with an
unsigned overflow threshold. Zero and sufficiently small finite values can
be encoded as infinity. Its format-specific CPU oracle uses the same
converter, so passing that oracle can coexist with a large error against
the common fp32 reference. Part 2 explains the finding and excludes this
fp16 path from precision recommendations. The dataset preserves the observed
result rather than silently replacing it with an expected one.

This is why the articles describe the oracle, as well as the pass count.
A passing row establishes agreement with the implemented check. Independent
reference values and boundary cases are needed to test the check itself.

## What I would measure next

The current collection is one GPU, one driver, and five samples within each
run. It is useful for inspecting implementations and finding large effects.
It cannot establish statistical significance for small differences or
predict a ranking on another device. A measured curve also leaves several
possible explanations open: instruction selection, scheduling, placement,
coalescing, cache reuse, and synchronization can interact.

The next controls follow directly from those gaps: repeat independently
collected runs with varied ordering; separate permutations within a block
from permutations between blocks; add dependent-load latency and independent
load-chain studies; compare actual memory types at several reuse counts;
and inspect compiler output or supported counters before naming occupancy,
bank conflicts, or cache-hit rates as the cause.

For rendering, the larger step is to connect the proxy's output to the
consumer that makes it useful. That means dependent BVH traversal, downstream
visibility work, actual indirect execution, or genuinely concurrent queues,
with the complete path measured. Each part ends near that boundary so the
next experiment has a concrete purpose.

Start with [dispatch and measurement](/blog/gpu-memory-experiments-01-05-dispatch-and-measurement/),
or use the table above to jump to the memory decision you are working on.
