// Exploratory agent-workload timings. This is not a LayerFS release benchmark.
import { closeSync, openSync, writeFileSync, writeSync } from "node:fs";
import { join } from "node:path";

export const TAILS = Object.freeze([
  { label: "p50", quantile: 0.5, minimum: 20 },
  { label: "p90", quantile: 0.9, minimum: 100 },
  { label: "p99", quantile: 0.99, minimum: 1_000 },
  { label: "p99.9", quantile: 0.999, minimum: 10_000 },
  { label: "p99.99", quantile: 0.9999, minimum: 100_000 },
]);

export function nearestRank(sorted, quantile) {
  if (!sorted.length || !(quantile > 0 && quantile <= 1)) {
    throw new RangeError("nearestRank requires data and a quantile in (0, 1]");
  }
  return sorted[Math.max(0, Math.ceil(quantile * sorted.length) - 1)];
}

export function summarize(samples) {
  const successful = samples.filter((sample) => sample.ok);
  const durations = successful.map((sample) => sample.elapsed_ns).sort((a, b) => a - b);
  const failed = samples.length - successful.length;
  const result = {
    count: samples.length,
    success_count: successful.length,
    failure_count: failed,
    mean_ns: null,
    max_ns: null,
    window_ns: null,
    throughput_ops_per_second: null,
    percentiles_ns: {},
    unavailable_percentiles: {},
  };
  if (durations.length) {
    let first = Infinity;
    let last = -Infinity;
    for (const sample of successful) {
      if (sample.start_ns < first) first = sample.start_ns;
      if (sample.end_ns > last) last = sample.end_ns;
    }
    const window = last - first;
    result.mean_ns = durations.reduce((sum, value) => sum + value, 0) / durations.length;
    result.max_ns = durations[durations.length - 1];
    result.window_ns = window;
    result.throughput_ops_per_second = window > 0 ? durations.length * 1e9 / window : null;
  }
  for (const tail of TAILS) {
    if (!failed && durations.length >= tail.minimum) {
      result.percentiles_ns[tail.label] = nearestRank(durations, tail.quantile);
    } else {
      result.unavailable_percentiles[tail.label] = {
        minimum_samples: tail.minimum,
        observed_successes: durations.length,
        reason: failed ? "failure_in_group" : "insufficient_samples",
      };
    }
  }
  return result;
}

const CSV_COLUMNS = [
  "backend", "cache", "agents", "agent", "operation", "sequence",
  "start_ns", "end_ns", "elapsed_ns", "ok", "error",
];
function csvCell(value) {
  const text = value == null ? "" : String(value);
  return '"' + text.replaceAll('"', '""') + '"';
}

export class Recorder {
  constructor(directory) {
    this.started = process.hrtime.bigint();
    this.samples = [];
    this.csv = openSync(join(directory, "samples.csv"), "wx", 0o600);
    this.jsonl = openSync(join(directory, "samples.jsonl"), "wx", 0o600);
    writeSync(this.csv, CSV_COLUMNS.join(",") + "\n");
    this.closed = false;
  }

  async measure(meta, callback) {
    const start = process.hrtime.bigint();
    let ok = true;
    let error = null;
    try {
      return await callback();
    } catch (caught) {
      ok = false;
      error = String(caught?.message ?? caught);
      throw caught;
    } finally {
      const end = process.hrtime.bigint();
      const sample = {
        backend: meta.backend,
        cache: meta.cache,
        agents: meta.agents,
        agent: meta.agent ?? -1,
        operation: meta.operation,
        sequence: meta.sequence ?? 0,
        start_ns: Number(start - this.started),
        end_ns: Number(end - this.started),
        elapsed_ns: Number(end - start),
        ok,
        error,
      };
      this.samples.push(sample);
      writeSync(this.csv, CSV_COLUMNS.map((key) => csvCell(sample[key])).join(",") + "\n");
      writeSync(this.jsonl, JSON.stringify(sample) + "\n");
    }
  }

  summary(meta, outcome) {
    const groups = new Map();
    for (const sample of this.samples) {
      const key = JSON.stringify([sample.backend, sample.cache, sample.agents, sample.operation]);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(sample);
    }
    const metrics = [...groups.entries()].map(([key, samples]) => {
      const [backend, cache, agents, operation] = JSON.parse(key);
      return { backend, cache, agents, operation, ...summarize(samples) };
    });
    const document = {
      schema_version: 1,
      metadata: meta,
      outcome,
      percentile_definition: "nearest-rank on successful sample latencies; 10 expected observations beyond a tail; no percentile if a group has any failure",
      throughput_definition: "successful operations / (last completion minus first start) within an operation group; includes interleaved work",
      metrics,
    };
    writeFileSync(join(meta.output, "summary.json"), JSON.stringify(document, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    return document;
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    closeSync(this.csv);
    closeSync(this.jsonl);
  }
}
