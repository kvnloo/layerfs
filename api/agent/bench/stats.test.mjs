import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nearestRank, Recorder, summarize, TAILS } from "./stats.mjs";

function observations(count) {
  return Array.from({ length: count }, (_, i) => ({
    ok: true,
    elapsed_ns: i + 1,
    start_ns: i * 10,
    end_ns: i * 10 + i + 1,
  }));
}

test("nearest-rank percentiles have no interpolation or extrapolation", () => {
  assert.equal(nearestRank([1, 2, 3, 4], 0.5), 2);
  assert.equal(nearestRank([1, 2, 3, 4], 0.9), 4);
  assert.throws(() => nearestRank([], 0.99), RangeError);
  assert.throws(() => nearestRank([1], 0), RangeError);
});

test("each tail is absent below its independent minimum", () => {
  for (const { label, minimum } of TAILS) {
    const below = summarize(observations(minimum - 1));
    assert.equal(Object.hasOwn(below.percentiles_ns, label), false);
    assert.deepEqual(below.unavailable_percentiles[label], {
      minimum_samples: minimum,
      observed_successes: minimum - 1,
      reason: "insufficient_samples",
    });
    const enough = summarize(observations(minimum));
    assert.equal(enough.percentiles_ns[label], Math.ceil(
      { p50: 0.5, p90: 0.9, p99: 0.99, "p99.9": 0.999, "p99.99": 0.9999 }[label] * minimum,
    ));
    assert.equal(Object.hasOwn(enough.unavailable_percentiles, label), false);
  }
});

test("p99.99 at 100,000 observations uses the observed rank", () => {
  const report = summarize(observations(100_000));
  assert.equal(report.count, 100_000);
  assert.equal(report.percentiles_ns["p99.99"], 99_990);
  assert.equal(report.mean_ns, 50_000.5);
  assert.equal(report.max_ns, 100_000);
});

test("any failed observation blocks percentile claims for that group", () => {
  const rows = observations(100_000);
  rows[1].ok = false;
  const result = summarize(rows);
  assert.equal(result.count, 100_000);
  assert.equal(result.success_count, 99_999);
  assert.equal(result.failure_count, 1);
  assert.deepEqual(result.percentiles_ns, {});
  assert.equal(result.unavailable_percentiles["p99.99"].reason, "failure_in_group");
});

test("raw CSV and JSONL retain successful and failed operations", async () => {
  const directory = mkdtempSync(join(tmpdir(), "layerfs-agent-stats-"));
  const recorder = new Recorder(directory);
  try {
    const meta = { backend: "git", cache: "warm", agents: 1, agent: 0, operation: "write" };
    await recorder.measure(meta, async () => {});
    await assert.rejects(() => recorder.measure({ ...meta, sequence: 1 }, async () => {
      throw new Error("write failed");
    }), /write failed/);
    recorder.close();
    const csv = readFileSync(join(directory, "samples.csv"), "utf8").trim().split("\n");
    const jsonl = readFileSync(join(directory, "samples.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
    assert.equal(csv.length, 3);
    assert.equal(jsonl.length, 2);
    assert.deepEqual(jsonl.map((row) => row.ok), [true, false]);
    assert.equal(jsonl[1].error, "write failed");
  } finally {
    recorder.close();
    rmSync(directory, { recursive: true, force: true });
  }
});
