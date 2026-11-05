# Agent-worktree workload and tail latency (exploratory)

Implements [factory O11](https://github.com/kvnloo/oss-factory/issues/325): measure a realistic agent worktree's small-file edits, Git inspection, build-style reads and teardown, with raw observations rather than medians alone.

This fork-local harness uses the existing [LayerFS agent SDK](../../docs/agent.md) and runtime. It is **not** an admitted LayerFS performance result. The root [benchmark policy](../../../docs/general/benchmark_rules.md) and [measurement workflow](../../../docs/general/agent-measurement-policy.md) require stronger matched-operation, cache residency, deployment and memory proofs before any speedup claim. The separate `layerfs-benchmark` repository owns released benchmark suites; fs-bench-pro remains frozen.

## Workload and comparison

Both backends use the same immutable Git commit checked out in a once-prepared `git clone --no-hardlinks` snapshot. For each cold/warm selection and cohort (1, 4 or 16 parallel agents):

1. LayerFS initializes the real repository into a Store and forks branches sharing the initial Layer; Git uses `git worktree add --detach` from the same snapshot.
2. Every agent writes/overwrites small scratch files, reads back each write, and edits one tracked text file.
3. A tree walk visits extension-matched files, followed by many bounded small reads.
4. LayerFS mounts Workspaces and runs real `git status`/`git diff` in its Sandbox, while the native worktrees run the same Git commands on the host.
5. Every workspace, Sandbox, project and native worktree is explicitly cleaned up. Errors and uncertain cleanup are preserved.

This is an agent-interface comparison, **not a claim of syscall equivalence**: LayerFS makes SDK calls and Git commands inside a Sandbox; the native arm makes filesystem calls and Git commands on the host. LayerFS commits on each `fs.write`; plain Git does not. Tree-walk interfaces also differ. Treat these as distinct operational experiences, not an interchangeable speed-ratio benchmark.

## Factory Mac/Linux command

Prerequisites: Node 20+, Git, pinned Rust 1.85.1, working Docker Engine/Desktop, sufficient disk headroom, a **real immutable LayerFS Sandbox image digest** and a sealed Linux daemon bundle for the exact source build. The source must be a local, non-bare Git checkout. Run this in the LayerFS fork checkout; the source checkout is not modified.

```bash
set -euo pipefail
# Factory must set each to the actual pinned, existing source/asset; no guessed digest.
: "$SOURCE_REPO"
: "$LAYERFS_BUNDLE"
: "$LAYERFS_IMAGE"
export LAYERFS_CONSTRUCTION_WORKERS=1 UV_THREADPOOL_SIZE=32
SOURCE_SHA="$(git -C "$SOURCE_REPO" rev-parse --verify HEAD)"
RUN_ROOT="$(mktemp -d /tmp/layerfs-agent-workload.XXXXXX)"
npm --prefix api install
npm --prefix api run build:native
node api/agent/bench/agent-workload.mjs \
  --repo "$SOURCE_REPO" --ref "$SOURCE_SHA" \
  --out "$RUN_ROOT/evidence" --image "$LAYERFS_IMAGE" \
  --bundle "$LAYERFS_BUNDLE" \
  --agents 1,4,16 --edits 128 --reads 128 --cache cold,warm
```

`LAYERFS_IMAGE` must match `sha256:` followed by 64 hexadecimal digits. On Linux a real daemon can be supplied with `--daemon /absolute/path/to/layerfs-daemon`; macOS requires `--bundle`. The runtime initializes a private home and its own uniquely prefixed Sandbox containers and Store volumes. Provide the sandbox image/bundle through the factory's existing sealed-build provisioning, not made-up paths. The native addon build needs an existing offline Cargo dependency cache.

**Expected schedule: approximately 10–60 minutes** for 1/4/16 agents at 128 writes and 128 build reads per agent on a moderately sized repository, *estimate only, not a measured duration*. Large repositories and Docker initialization can take longer. For a functional short invocation, select `--agents 1 --edits 8 --reads 8 --cache warm`.

Unit tests (without a Store): `node --test api/agent/bench/stats.test.mjs`. Real-run verification and timing must be performed by the factory; no execution is claimed by this PR.

## Cache honesty

`cold` without `--cold-hook` is recorded **cold-first-touch-unverified**, not verified cold. Cloning, starting a new Store, or resetting a file does not prove OS page-cache, daemon or worker residency. `warm` is recorded **warm-preconditioned**: the runner pre-reads selected files before timed phases. Neither state may be silently substituted for a certified release-benchmark cache condition.

For a certified cold experiment, the operator can pass `--cold-hook /absolute/executable`; the hook receives `BENCH_BACKEND`, `BENCH_PHASE`, `BENCH_AGENTS` and the LayerFS volume environment. It must implement both cache invalidation and **independent residency checks**, printing a JSON evidence record with `verified: true`, `cache: "cold"`, `residency_checked: true` and a nonempty `method`. Returning these fields without doing the checks does not constitute proof. A failing hook aborts the run and preserves evidence.

## Raw evidence, tails and limits

Fresh `samples.csv` and `samples.jsonl` record **every attempted operation** (including failures) with backend, cache, cohort, agent, phase/operation, sequence, start/end/elapsed monotonic nanoseconds, and error. `summary.json` groups by backend/cache/cohort/operation with total/success/failure counts, arithmetic mean, maximum, operation-window throughput (ops/s), and nearest-rank admitted percentiles. No durations are synthesized.

| Tail | Minimum successful samples in same group |
| --- | ---: |
| p50 | 20 |
| p90 | 100 |
| p99 | 1,000 |
| p99.9 | 10,000 |
| p99.99 | **100,000** |

These thresholds give approximately ten observations in the upper tail; they **do not guarantee statistical confidence**. A percentile is omitted when too few samples exist or any observation in its group failed; `unavailable_percentiles` records why. The default workload is intentionally bounded and generally **cannot support p99.99**. To measure that tail for a specific operation, plan at least 100,000 valid independent observations of that operation per backend/cache/cohort, and separately evaluate warm/cold and concurrency effects.

Throughput uses successful call count divided by elapsed wall interval from earliest call start to latest completion *within the same operation group*. Because other operations interleave, this is not isolated saturation throughput. Failure returns nonzero and leaves `summary.json` marked FAILED, with all raw samples and potential cleanup blockers retained. Outputs are local; the factory must upload raw data before issuing any performance statement.
