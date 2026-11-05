// Real LayerFS SDK versus native git worktrees, against one pinned checkout.
// Exploratory evidence only: this does not replace layerfs-benchmark's release gates.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, statSync } from "node:fs";
import { open, readFile, writeFile, mkdir, lstat } from "node:fs/promises";
import { platform, release } from "node:os";
import { extname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import { setTimeout as pause } from "node:timers/promises";
import { LayerFS } from "../src/index.js";
import { LayerFSRuntime } from "../../runtime/src/index.js";
import { Recorder } from "./stats.mjs";

const exec = promisify(execFile);
const TYPES = new Set([".rs", ".js", ".mjs", ".ts", ".tsx", ".py", ".md", ".toml", ".json", ".txt", ".yml", ".yaml"]);
const TREE_PATTERNS = [...TYPES].map((extension) => "**/*" + extension);
const USAGE = "node api/agent/bench/agent-workload.mjs --repo DIR --ref COMMIT --out NEW_DIR --image sha256:DIGEST --bundle SEALED_LINUX_BUNDLE [--daemon BIN] [--agents 1,4,16] [--edits 128] [--reads 128] [--cache cold,warm] [--cold-hook ABSOLUTE_EXECUTABLE]";

function options(argv) {
  const result = { agents: "1,4,16", edits: "128", reads: "128", cache: "cold,warm", ref: "HEAD" };
  if (argv.includes("--help")) {
    console.log(USAGE);
    process.exit(0);
  }
  if (argv.length % 2) throw new Error(USAGE);
  const supplied = new Set();
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    if (!key.startsWith("--") || !["repo", "ref", "out", "image", "bundle", "daemon", "docker", "agents", "edits", "reads", "cache", "cold-hook"].includes(key.slice(2))) {
      throw new Error("unknown option " + key + "\n" + USAGE);
    }
    if (supplied.has(key)) throw new Error("duplicate option " + key);
    supplied.add(key);
    result[key.slice(2)] = argv[i + 1];
  }
  if (!result.repo || !result.out || !/^sha256:[0-9a-f]{64}$/.test(result.image ?? "")) throw new Error(USAGE);
  result.repo = resolve(result.repo);
  result.out = resolve(result.out);
  if (!isAbsolute(result.repo) || !statSync(result.repo).isDirectory() || existsSync(result.out)) {
    throw new Error("source must exist and output must be a new directory");
  }
  if (result.out === result.repo || result.out.startsWith(result.repo + "/")) {
    throw new Error("output must be outside the measured repository");
  }
  if (!result.bundle && !result.daemon) throw new Error("--bundle or --daemon is required");
  if (platform() === "darwin" && !result.bundle) throw new Error("macOS requires a sealed Linux --bundle");
  result.agents = result.agents.split(",").map(Number);
  if (!result.agents.length || result.agents.some((n) => ![1, 4, 16].includes(n)) || new Set(result.agents).size !== result.agents.length) {
    throw new Error("--agents is an ordered subset of 1,4,16");
  }
  result.cache = result.cache.split(",");
  if (!result.cache.length || result.cache.some((m) => !["cold", "warm"].includes(m)) || new Set(result.cache).size !== result.cache.length) {
    throw new Error("--cache is cold,warm or a subset");
  }
  for (const key of ["edits", "reads"]) {
    result[key] = Number(result[key]);
    if (!Number.isSafeInteger(result[key]) || result[key] < 1 || result[key] > 1_000_000) throw new Error("--" + key + " must be 1..1000000");
  }
  if (result["cold-hook"] && !isAbsolute(result["cold-hook"])) throw new Error("--cold-hook must be absolute");
  return result;
}

function git(args, cwd) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error("git " + args.join(" ") + ": " + (result.stderr || result.error?.message || result.status));
  return result.stdout;
}
async function gitAsync(args, cwd) {
  const { stdout } = await exec("git", args, { cwd, maxBuffer: 64 * 1024 * 1024 });
  return stdout;
}
function selectedFiles(snapshot) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = git(["ls-files", "-z"], snapshot).split("\0").filter(Boolean);
  return names.filter((name) => {
    if (!TYPES.has(extname(name)) || name.includes("\n") || name.includes("\r")) return false;
    try {
      const path = join(snapshot, name);
      if (!lstatSync(path).isFile() || statSync(path).size === 0 || statSync(path).size > 16_384) return false;
      decoder.decode(readFileSync(path));
      return true;
    } catch {
      return false;
    }
  }).sort();
}
function trackedEdit(file, original, agent) {
  const ext = extname(file);
  const marker = ext === ".md" ? "<!-- agent-workload-" + agent + " -->" :
    [".py", ".toml", ".yml", ".yaml"].includes(ext) ? "# agent-workload-" + agent :
    "// agent-workload-" + agent;
  return original + (original.endsWith("\n") ? "" : "\n") + marker + "\n";
}
async function nativeSmallRead(path) {
  const handle = await open(path, "r");
  try {
    const bytes = Buffer.alloc(4096);
    const read = await handle.read(bytes, 0, bytes.length, 0);
    assert.ok(read.bytesRead > 0);
  } finally {
    await handle.close();
  }
}
async function layerfsTreeWalk(client, branch) {
  let count = 0;
  for (const pattern of TREE_PATTERNS) {
    let offset = 0;
    for (;;) {
      const page = await client.fs.glob(branch, pattern, "/", 1000, offset);
      count += page.items.length;
      offset += page.items.length;
      if (!page.hasMore) break;
      if (!page.items.length) throw new Error("fs.glob returned an empty nonterminal page");
    }
  }
  assert.ok(count > 0, "tree walk selected no tracked-like source files");
}
async function nativeTreeWalk(worktree) {
  const paths = (await gitAsync(["ls-files", "-z"], worktree)).split("\0").filter(Boolean);
  let found = 0;
  for (const path of paths) {
    if (!TYPES.has(extname(path))) continue;
    const meta = await lstat(join(worktree, path));
    if (meta.isFile()) found++;
  }
  assert.ok(found > 0, "tree walk selected no source files");
}
function cacheLabel(mode, opts) {
  return mode === "warm" ? "warm-preconditioned" : opts["cold-hook"] ? "cold-verified-by-hook" : "cold-first-touch-unverified";
}
function cacheEvidence(opts, meta, proofs) {
  if (meta.cache === "warm") return;
  if (!opts["cold-hook"]) {
    proofs.push({ ...meta, verified: false, reason: "first touch does not prove OS, Store or worker cache residency" });
    return;
  }
  const response = spawnSync(opts["cold-hook"], [], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, LAYERFS_VOLUME: meta.backend === "layerfs" ? (process.env.LAYERFS_VOLUME ?? "") : "",
      BENCH_BACKEND: meta.backend, BENCH_PHASE: meta.phase, BENCH_AGENTS: String(meta.agents) },
  });
  if (response.error || response.status !== 0) throw new Error("cold hook failed: " + (response.stderr || response.error?.message || response.status));
  const proof = JSON.parse(response.stdout);
  if (proof.verified !== true || proof.cache !== "cold" || proof.residency_checked !== true || typeof proof.method !== "string" || !proof.method) {
    throw new Error("cold hook must return verified cold residency evidence, not a cache-flush command alone");
  }
  proofs.push({ ...meta, ...proof });
}
async function precondition(mode, backend, handles, selected, client) {
  if (mode !== "warm") return;
  for (const handle of handles) {
    const name = selected[(handle.id * 7) % selected.length];
    if (backend === "layerfs") await client.fs.read(handle.branch, "/" + name, 1, 8);
    else await nativeSmallRead(join(handle.path, name));
  }
}
async function initialized(runtime, name, source) {
  const job = await runtime.project.start_init(name, source, { timeout: 300_000 });
  const deadline = Date.now() + 360_000;
  for (;;) {
    const state = await runtime.project.get_init(job.id);
    if (!state) throw new Error("LayerFS Init receipt disappeared: " + job.id);
    if (state.step === "done") return state.project;
    if (state.step === "failed") throw new Error("LayerFS Init failed: " + JSON.stringify(state.error));
    if (Date.now() >= deadline) throw new Error("LayerFS Init still running after driver deadline; preserve project custody");
    await pause(250);
  }
}
function sdkEnvironment(runtime, project) {
  const s = runtime.settings;
  Object.assign(process.env, {
    LAYERFS_HOME: s.home,
    LAYERFS_IMAGE: s.image,
    LAYERFS_VOLUME: project.volume,
    LAYERFS_STORE_PATH: s.volumes + "/" + project.volume + "/_data/global/store.sqlite",
    LAYERFS_DAEMON: s.daemon,
    LAYERFS_DOCKER: s.docker,
    LAYERFS_CONTAINER_PREFIX: s.containerPrefix,
  });
}
function checkExec(result, operation) {
  if (result.exitCode !== 0) throw new Error(operation + " exit " + result.exitCode + ": " + String(result.stderr).slice(0, 500));
  return result.stdout;
}
function quoteShell(value) {
  return "'" + value.replaceAll("'", "'\\''") + "'";
}

async function runArm(opts, context, recorder, backend, mode, agents, runtime) {
  const cache = cacheLabel(mode, opts);
  const m = (operation, agent = -1, sequence = 0) => ({ backend, cache, agents, agent, operation, sequence });
  const handles = [];
  const cleanupFailures = [];
  let project = null;
  let client = null;
  let sandbox = null;
  let error = null;
  const initializedName = "aw" + context.runId + mode[0] + agents;
  try {
    if (backend === "layerfs") {
      project = await recorder.measure(m("project_init"), () => initialized(runtime, initializedName, context.snapshot));
      sdkEnvironment(runtime, project);
      client = await recorder.measure(m("sdk_open"), () => LayerFS.open(initializedName));
    }
    cacheEvidence(opts, { backend, cache: mode, phase: "fork", agents }, context.cacheProofs);
    for (let id = 0; id < agents; id++) {
      const handle = { id, branch: "agent-" + id, path: join(opts.out, "worktrees", mode + "-" + agents + "-" + id) };
      if (backend === "layerfs") {
        await recorder.measure(m("worktree_fork", id), () => client.branch.fork(handle.branch, "main"));
        handles.push(handle);
        await recorder.measure(m("scratch_mkdir", id), () => client.fs.mkdir(handle.branch, "/.agent-workload"));
      } else {
        await recorder.measure(m("worktree_fork", id), () => gitAsync(["worktree", "add", "--detach", "--", handle.path, context.sha], context.snapshot));
        handles.push(handle);
        await recorder.measure(m("scratch_mkdir", id), () => mkdir(join(handle.path, ".agent-workload")));
      }
    }
    await precondition(mode, backend, handles, context.files, client);
    cacheEvidence(opts, { backend, cache: mode, phase: "edit", agents }, context.cacheProofs);
    await Promise.all(handles.map(async (handle) => {
      for (let sequence = 0; sequence < opts.edits; sequence++) {
        const file = "part-" + (sequence % 32) + ".txt";
        const value = "agent=" + handle.id + " edit=" + sequence + "\n";
        const path = "/.agent-workload/" + file;
        if (backend === "layerfs") {
          await recorder.measure(m("small_write", handle.id, sequence), () => client.fs.write(handle.branch, path, value));
          await recorder.measure(m("small_read_after_write", handle.id, sequence), async () => {
            const read = await client.fs.read(handle.branch, path);
            assert.equal(read.text, value);
          });
        } else {
          const absolute = join(handle.path, ".agent-workload", file);
          await recorder.measure(m("small_write", handle.id, sequence), () => writeFile(absolute, value));
          await recorder.measure(m("small_read_after_write", handle.id, sequence), async () => {
            const read = await readFile(absolute, "utf8");
            assert.equal(read, value);
          });
        }
      }
      const changed = trackedEdit(context.tracked, context.trackedContent, handle.id);
      if (backend === "layerfs") {
        await recorder.measure(m("tracked_edit", handle.id), async () => {
          const result = await client.fs.write(handle.branch, "/" + context.tracked, changed);
          assert.equal(result.kind, "Committed");
        });
      } else {
        await recorder.measure(m("tracked_edit", handle.id), () => writeFile(join(handle.path, context.tracked), changed));
      }
    }));
    await precondition(mode, backend, handles, context.files, client);
    cacheEvidence(opts, { backend, cache: mode, phase: "tree", agents }, context.cacheProofs);
    await Promise.all(handles.map(async (handle) => {
      if (backend === "layerfs") {
        await recorder.measure(m("tree_walk", handle.id), () => layerfsTreeWalk(client, handle.branch));
      } else {
        await recorder.measure(m("tree_walk", handle.id), () => nativeTreeWalk(handle.path));
      }
      for (let sequence = 0; sequence < opts.reads; sequence++) {
        const file = context.files[(sequence + handle.id * 7) % context.files.length];
        if (backend === "layerfs") {
          await recorder.measure(m("build_small_read", handle.id, sequence), async () => {
            const value = await client.fs.read(handle.branch, "/" + file, 1, 8);
            assert.equal(typeof value.text, "string");
          });
        } else {
          await recorder.measure(m("build_small_read", handle.id, sequence), () => nativeSmallRead(join(handle.path, file)));
        }
      }
    }));
    cacheEvidence(opts, { backend, cache: mode, phase: "git", agents }, context.cacheProofs);
    if (backend === "layerfs") {
      const made = await recorder.measure(m("sandbox_create"), () => client.sandbox.create());
      sandbox = made.sandbox;
    }
    await Promise.all(handles.map(async (handle) => {
      if (backend === "layerfs") {
        const mounted = await recorder.measure(m("workspace_mount", handle.id), () => client.workspace.mount(sandbox, handle.branch));
        handle.ws = { sandbox: mounted.sandbox, path: mounted.path };
        await recorder.measure(m("git_status", handle.id), async () => {
          const status = await client.workspace.exec(handle.ws, "git status --porcelain=v1 --untracked-files=no");
          assert.ok(checkExec(status, "git status").trim(), "edited tracked file absent from git status");
        });
        await recorder.measure(m("git_diff", handle.id), async () => {
          const diff = await client.workspace.exec(handle.ws, "git diff --no-ext-diff -- " + quoteShell(context.tracked));
          assert.ok(checkExec(diff, "git diff").includes("agent-workload-"), "tracked edit absent from git diff");
        });
      } else {
        await recorder.measure(m("git_status", handle.id), async () => {
          const status = await gitAsync(["status", "--porcelain=v1", "--untracked-files=no"], handle.path);
          assert.ok(status.trim(), "edited tracked file absent from git status");
        });
        await recorder.measure(m("git_diff", handle.id), async () => {
          const diff = await gitAsync(["diff", "--no-ext-diff", "--", context.tracked], handle.path);
          assert.ok(diff.includes("agent-workload-"), "tracked edit absent from git diff");
        });
      }
    }));
  } catch (caught) {
    error = caught;
  } finally {
    for (const handle of handles) {
      try {
        if (backend === "layerfs" && handle.ws) {
          await recorder.measure(m("workspace_unmount", handle.id), () => client.workspace.unmount(handle.ws, true));
          handle.ws = null;
        } else if (backend === "git") {
          await recorder.measure(m("worktree_remove", handle.id), () => gitAsync(["worktree", "remove", "--force", "--", handle.path], context.snapshot));
        }
      } catch (failure) {
        cleanupFailures.push("worker " + handle.id + ": " + failure.message);
      }
    }
    if (sandbox) {
      try {
        await recorder.measure(m("sandbox_close"), () => client.sandbox.close(sandbox));
      } catch (failure) {
        cleanupFailures.push("sandbox: " + failure.message);
      }
    }
    if (client) {
      try {
        await recorder.measure(m("sdk_close"), () => client.close());
      } catch (failure) {
        cleanupFailures.push("SDK: " + failure.message);
      }
    }
    if (project && !cleanupFailures.length) {
      try {
        await recorder.measure(m("project_remove"), () => runtime.project.remove(initializedName, { confirm: initializedName }));
      } catch (failure) {
        cleanupFailures.push("project: " + failure.message);
      }
    }
  }
  if (error || cleanupFailures.length) {
    throw new Error([error?.message, ...cleanupFailures].filter(Boolean).join("; "));
  }
}

async function main() {
  const opts = options(process.argv.slice(2));
  mkdirSync(opts.out, { mode: 0o700 });
  mkdirSync(join(opts.out, "worktrees"), { mode: 0o700 });
  const recorder = new Recorder(opts.out);
  const runId = randomUUID().replaceAll("-", "").slice(0, 12);
  const metadata = {
    output: opts.out, generated_at: new Date().toISOString(), run_id: runId,
    platform: platform(), os_release: release(), node: process.version,
    source: opts.repo, requested_ref: opts.ref, source_sha: null,
    image: opts.image, bundle: opts.bundle ?? null, daemon: opts.daemon ?? null,
    edits_per_agent: opts.edits, reads_per_agent: opts.reads, agents: opts.agents,
    requested_cache_modes: opts.cache, cache_proofs: [],
    cold_definition: "Only an external residency-checking hook can certify cold; without it first-touch rows are unverified diagnostics.",
    warm_definition: "Pre-read selected files before edit and tree phases; edits/metadata may independently warm caches.",
    snapshot_setup: "One no-hardlinks local clone, exact detached SHA, shared immutable source for both arms.",
  };
  const snapshot = join(opts.out, "source-snapshot");
  let runtime = null;
  let outcome = { status: "FAILED", reason: "incomplete" };
  let succeeded = false;
  try {
    const sha = git(["rev-parse", "--verify", opts.ref + "^{commit}"], opts.repo).trim();
    metadata.source_sha = sha;
    await recorder.measure({ backend: "setup", cache: "none", agents: 0, operation: "snapshot_clone" }, async () => {
      git(["clone", "--quiet", "--no-hardlinks", "--no-checkout", "--", opts.repo, snapshot]);
      git(["checkout", "--detach", "--quiet", sha], snapshot);
    });
    const files = selectedFiles(snapshot);
    if (!files.length) throw new Error("source has no nonempty tracked UTF-8 text files <=16 KiB");
    const editableTypes = new Set([".md", ".rs", ".js", ".mjs", ".ts", ".tsx", ".py", ".toml", ".txt", ".yml", ".yaml"]);
    const tracked = files.includes("README.md") ? "README.md" : files.find((name) => extname(name) === ".md") ?? files.find((name) => editableTypes.has(extname(name)));
    if (!tracked) throw new Error("source has no text file with a safe comment syntax for a tracked diff");
    const context = {
      snapshot, sha, files, tracked, trackedContent: readFileSync(join(snapshot, tracked), "utf8"),
      runId, cacheProofs: metadata.cache_proofs,
    };
    metadata.tracked_edit_path = tracked;
    metadata.read_file_count = files.length;
    runtime = await LayerFSRuntime.open({
      home: join(opts.out, "runtime-home"),
      image: opts.image,
      bundle: opts.bundle,
      daemon: opts.daemon,
      docker: opts.docker,
      containerPrefix: "lfs-aw-" + runId + "-",
      sweep: false,
    });
    const state = await runtime.status();
    if (state.missing.length) throw new Error("LayerFS runtime is missing: " + state.missing.join(", "));
    if (platform() === "darwin") await runtime.worker.start();
    for (const mode of opts.cache) {
      for (const agents of opts.agents) {
        const order = agents === 4 ? ["layerfs", "git"] : ["git", "layerfs"];
        for (const backend of order) {
          await runArm(opts, context, recorder, backend, mode, agents, runtime);
        }
      }
    }
    succeeded = true;
    outcome = { status: "COMPLETE", reason: null };
  } catch (error) {
    outcome = { status: "FAILED", reason: error?.stack ?? String(error) };
  } finally {
    if (runtime) {
      try { await runtime.close(); } catch (error) {
        outcome = { status: "FAILED", reason: (outcome.reason ?? "") + "; runtime.close: " + error.message };
        succeeded = false;
      }
    }
    if (succeeded) {
      try { rmSync(snapshot, { recursive: true, force: true }); } catch (error) {
        outcome = { status: "FAILED", reason: "snapshot cleanup: " + error.message };
        succeeded = false;
      }
    }
    recorder.close();
    recorder.summary(metadata, outcome);
  }
  if (!succeeded) {
    console.error("FAILED; retained evidence and uncertain resources in " + opts.out + ": " + outcome.reason);
    process.exitCode = 1;
  } else {
    console.log("Complete: " + join(opts.out, "summary.json") + ", samples.csv, samples.jsonl");
  }
}

await main();
