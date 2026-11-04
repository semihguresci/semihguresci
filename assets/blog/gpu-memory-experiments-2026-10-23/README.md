# Evidence for the GPU memory experiment series

These files accompany the October 23, 2026 articles in `_posts/`. The series
overview is `/blog/gpu-memory-experiments-series/`.

`data/manifest.json` lists the copied files and their SHA-256 hashes. The 45
experiment JSON files are byte-for-byte copies of the local benchmark's
current exports for measurement revision `2026-10-23-integrity-fixes`.
They contain 5,205 timed rows from an RTX 2080 SUPER, driver 610.88, device API
Vulkan 1.4.341, with five timed samples and two warmups per case. Requested
total scratch is 32 MiB, except experiment 34 at 128 MiB. The performance
collection has validation layers disabled; separate development runs used
validation.

`data/summary.csv` recomputes medians directly from the raw rows, grouped by
experiment ID, variant, problem size, and dispatch count. It contains 1,041
cases. Median throughput and GB/s are medians of their exported per-iteration
values. GPU times are milliseconds. Throughput is logical elements per second
under each experiment's definition; GB/s uses that experiment's exported byte
formula, not an observed hardware-traffic counter. Raw row notes retain the
definitions and parameters needed to interpret each result.

The source checkout was dirty. A base Git commit does not identify the full
measured program; each raw export records binary, source-tree and shader
bundle hashes. The public repository's current branch may differ from this
snapshot. Copied charts were verified against the experiment's analysis
provenance, including the raw source and analyzer/plotter hashes, before
copying. Only figures referenced by the new articles are included.

## Known issue in the frozen evidence

Experiment 10's `fp16_storage` host converter compares a signed exponent with
an unsigned overflow threshold. Zero and sufficiently small finite values
can be encoded as infinity. Input packing and the format-specific oracle
share that converter, so an oracle pass does not validate binary16 conversion.
The series excludes this path from precision and performance recommendations;
the large common-fp32 error is preserved as a diagnosed implementation defect.
The CSV marks these cases as `known_fp16_conversion_defect`.

Run `python data/reproduce_fp16_packing.py` to compare selected boundary values
with Python's independent binary16 encoder. The script prints the comparison
and writes its adjacent `.txt` file. It models the frozen host code; it does
not modify or rerun the benchmark.

These files preserve an exploratory single-device collection. Hardware
mechanisms and small timing differences require additional measurements.
