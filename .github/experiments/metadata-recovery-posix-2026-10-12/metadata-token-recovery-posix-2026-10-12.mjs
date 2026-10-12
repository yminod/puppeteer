// POSIX adapter of MT1 final Windows P0-P10. Shared model bytes stay unchanged.
// Native SIGINT and platform fixtures replace the Windows console controller.
import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  observe,
  reclaim,
  release,
  tryAcquire,
  withCacheLock,
} from "./metadata-token-recovery-model-2026-10-09.mjs";

const [outputArgument, repoArgument] = process.argv.slice(2);
assert(outputArgument && repoArgument);
assert(["darwin", "linux"].includes(process.platform));
assert.equal(process.version, "v24.15.0");
const output = path.resolve(outputArgument);
const repo = path.resolve(repoArgument);
assert(!fs.existsSync(output));
fs.mkdirSync(output, { recursive: true });
const self = fileURLToPath(import.meta.url);
const worker = path.join(
  path.dirname(self),
  "metadata-token-recovery-worker-2026-10-09.mjs",
);
const { detectBrowserPlatform } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/detectPlatform.js"))
);
const platform = detectBrowserPlatform();
assert(platform);
const executable = "custom-executable";
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const sourceFiles = [
  "packages/browsers/src/Cache.ts",
  "packages/browsers/test/src/Cache.test.ts",
  "packages/browsers/lib/Cache.js",
];
const expected = [
  "7122c6b244aaea7b4a9c616c462ea86685447d4a86c17a4443a74dfe5511736e",
  "adba2e60e5893d4de654bba9b581d23da0194f8560415a11210810a5f1bbe304",
  "fdaaf960a7a73ea3fabd1c86e7253557ef6b2dbef53a1794e75596fd66e103ea",
];
const git = (...args) =>
  execFileSync(
    "git",
    ["-c", `safe.directory=${repo.replaceAll("\\", "/")}`, "-C", repo, ...args],
    { encoding: "utf8" },
  ).trim();
assert.equal(
  git("rev-parse", "HEAD"),
  "944cdef2d6a3bf7b40a55e2ea4a18c5d76beb069",
);
assert.equal(git("status", "--porcelain"), "");
const frozen = () => ({
  sourceHead: git("rev-parse", "HEAD"),
  inputs: sourceFiles.map((file, index) => {
    const sha256 = hash(path.join(repo, file));
    assert.equal(sha256, expected[index]);
    return { file, sha256 };
  }),
  asRun: [
    self,
    worker,
    path.join(
      path.dirname(self),
      "metadata-token-recovery-model-2026-10-09.mjs",
    ),
  ].map((file) => ({ file, sha256: hash(file) })),
});
const inputs = frozen();
save(path.join(output, "inputs-before.json"), inputs);
const { Cache } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/Cache.js"))
);
const { install } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/install.js"))
);
const results = [];
const processes = [];
const fixtures = [];
function setup(label) {
  const directory = path.join(output, label);
  fs.mkdirSync(directory);
  const cacheRoot = path.join(directory, "cache");
  const cache = new Cache(cacheRoot);
  const tree = cache.installationDir("chrome", platform, "1234567");
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(
    path.join(tree, executable),
    "Research regular-file executable fixture; no launch",
  );
  fs.writeFileSync(
    path.join(tree, ".puppeteer-install"),
    JSON.stringify({ version: 1, relativeExecutablePath: executable }),
  );
  cache.writeMetadata("chrome", {
    aliases: { base: "0" },
    executablePaths: { [`${platform}-1234567`]: executable },
  });
  const ctx = {
    directory,
    cacheRoot,
    cache,
    tree,
    root: cache.browserRoot("chrome"),
  };
  ctx.treeHashes = treeHashes(ctx);
  fixtures.push(ctx);
  return ctx;
}
function treeHashes(ctx) {
  return [executable, ".puppeteer-install"].map((name) => ({
    name,
    sha256: hash(path.join(ctx.tree, name)),
  }));
}
function identity(ctx) {
  return {
    owner: observe(ctx.root),
    inode: fs.statSync(path.join(ctx.root, ".metadata.lock")).ino,
    metadataSha256: hash(ctx.cache.metadataFile("chrome")),
    markerSha256: hash(
      path.join(ctx.root, ".metadata.lock", observe(ctx.root).marker),
    ),
  };
}
function child(config, label) {
  const directory = path.join(config.root ?? config.directory, label);
  fs.mkdirSync(directory);
  const file = path.join(directory, "config.json");
  save(file, { repo, ...config, output: directory });
  const log = fs.openSync(path.join(directory, "worker.log"), "wx");
  const process = fork(worker, [file], { stdio: ["ignore", log, log, "ipc"] });
  fs.closeSync(log);
  const entry = {
    process,
    role: label,
    pid: process.pid,
    events: [],
    closed: false,
    directory,
  };
  process.on("message", (event) => entry.events.push(event));
  process.on("error", (error) => {
    entry.error = String(error);
  });
  entry.close = new Promise((resolve) =>
    process.once("close", (code, signal) => {
      Object.assign(entry, { closed: true, code, signal });
      resolve(code);
    }),
  );
  processes.push(entry);
  return entry;
}
async function event(entry, name) {
  const deadline = performance.now() + 15000;
  while (!entry.events.some((value) => value.event === name)) {
    if (entry.closed || performance.now() >= deadline)
      throw new Error(`${entry.role} did not reach ${name}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return entry.events.find((value) => value.event === name);
}
function resume(entry) {
  fs.writeFileSync(path.join(entry.directory, "release"), "resume", {
    flag: "wx",
  });
}
async function native(ctx) {
  const entry = child(
    {
      root: ctx.root,
      cache: ctx.cacheRoot,
      mode: "write",
      hold: "after-acquire",
      nativeSignal: true,
    },
    "sigint-owner",
  );
  await event(entry, "held");
  const before = identity(ctx);
  assert.equal(before.owner.kind, "owner");
  const sent = entry.process.kill("SIGINT");
  assert(sent);
  await entry.close;
  assert.equal(entry.code, null);
  assert.equal(entry.signal, "SIGINT");
  assert.deepEqual(identity(ctx), before);
  return {
    targetPid: entry.pid,
    signalSent: sent,
    code: entry.code,
    signal: entry.signal,
    before,
    after: identity(ctx),
  };
}
async function run(name, task) {
  try {
    const observation = await task();
    results.push({ name, pass: true, observation });
    console.log(JSON.stringify({ name, pass: true }));
  } catch (error) {
    results.push({ name, pass: false, error: error.stack });
    console.log(JSON.stringify({ name, pass: false, error: error.message }));
  }
}
try {
  await run("P0.native-nonempty-publication", () => {
    const ctx = setup("p0");
    let winner;
    const loser = tryAcquire(ctx.root, {
      beforePublish: () => {
        winner = tryAcquire(ctx.root);
        assert(winner.acquired);
      },
    });
    assert(!loser.acquired);
    assert(
      ["ENOTEMPTY", "EEXIST"].includes(loser.code),
      `Unexpected POSIX directory collision: ${loser.code}`,
    );
    assert.deepEqual(observe(ctx.root), winner.owner);
    const held = identity(ctx);
    const third = tryAcquire(ctx.root);
    assert(!third.acquired);
    assert.deepEqual(identity(ctx), held);
    release(ctx.root, winner.owner);
    return { nativeErrno: loser.code, winnerHeld: held, third };
  });
  await run("P1.sigint-then-real-alias-and-cache-hit", async () => {
    const ctx = setup("p1");
    const signal = await native(ctx);
    const orphan = identity(ctx);
    assert.equal(orphan.owner.kind, "owner");
    let lease;
    withCacheLock(
      ctx.root,
      () => ctx.cache.writeAlias("chrome", "recovered", "2"),
      {
        graceMs: 2000,
        onAcquire: (value) => {
          lease = value;
        },
      },
    );
    assert(lease.elapsedMs >= 2000);
    assert(lease.trace.some((value) => value.event === "reclaimed"));
    assert.equal(ctx.cache.readMetadata("chrome").aliases.recovered, "2");
    assert.equal(observe(ctx.root), null);
    const hit = await install({
      cacheDir: ctx.cacheRoot,
      browser: "chrome",
      platform,
      buildId: "1234567",
    });
    assert.equal(hit.path, ctx.tree);
    assert.deepEqual(treeHashes(ctx), ctx.treeHashes);
    return {
      signal,
      orphan,
      lease,
      metadata: ctx.cache.readMetadata("chrome"),
      cacheHitPath: hit.path,
    };
  });
  await run("P2.two-simultaneous-retries", async () => {
    const ctx = setup("p2");
    const orphan = tryAcquire(ctx.root);
    assert(orphan.acquired);
    const a = child(
      {
        root: ctx.root,
        cache: ctx.cacheRoot,
        mode: "write",
        alias: "alpha",
        value: "A",
        hold: "before-acquire",
      },
      "a",
    );
    const b = child(
      {
        root: ctx.root,
        cache: ctx.cacheRoot,
        mode: "write",
        alias: "beta",
        value: "B",
        hold: "before-acquire",
      },
      "b",
    );
    await event(a, "held");
    await event(b, "held");
    resume(a);
    resume(b);
    assert.equal(await a.close, 0);
    assert.equal(await b.close, 0);
    const metadata = ctx.cache.readMetadata("chrome");
    assert.deepEqual(metadata.aliases, { base: "0", alpha: "A", beta: "B" });
    assert.equal(observe(ctx.root), null);
    return {
      orphan: orphan.owner,
      metadata,
      a: json(path.join(a.directory, "result.json")),
      b: json(path.join(b.directory, "result.json")),
    };
  });
  await run("P3.naive-empty-reaper-deletes-new-owner", () => {
    const ctx = setup("p3");
    const lock = path.join(ctx.root, ".metadata.lock");
    fs.mkdirSync(lock);
    const aObserved = fs.statSync(lock).ino;
    fs.rmdirSync(lock);
    fs.mkdirSync(lock);
    const newInode = fs.statSync(lock).ino;
    fs.rmdirSync(lock);
    assert(!fs.existsSync(lock));
    return {
      expectedNegativeControl: true,
      aObserved,
      newInode,
      newOwnerGuardDeleted: true,
    };
  });
  await run("P4.losing-token-reaper-preserves-successor", async () => {
    const ctx = setup("p4");
    const old = tryAcquire(ctx.root);
    assert(old.acquired);
    const a = child(
      { root: ctx.root, mode: "reclaim", hold: "before-remove-marker" },
      "a",
    );
    await event(a, "held");
    reclaim(ctx.root, old.owner);
    const next = tryAcquire(ctx.root);
    assert(next.acquired);
    const held = identity(ctx);
    resume(a);
    assert.equal(await a.close, 0);
    const outcome = json(path.join(a.directory, "result.json"));
    assert(outcome.outcome.missingOldMarker);
    assert.deepEqual(identity(ctx), held);
    assert(!tryAcquire(ctx.root).acquired);
    release(ctx.root, next.owner);
    return { old: old.owner, held, outcome };
  });
  await run("P5.delayed-rmdir-preserves-successor", async () => {
    const ctx = setup("p5");
    const old = tryAcquire(ctx.root);
    assert(old.acquired);
    const a = child(
      { root: ctx.root, mode: "reclaim", hold: "after-remove-marker" },
      "a",
    );
    await event(a, "held");
    assert.equal(observe(ctx.root).kind, "empty");
    reclaim(ctx.root, observe(ctx.root));
    const next = tryAcquire(ctx.root);
    assert(next.acquired);
    const held = identity(ctx);
    resume(a);
    assert.equal(await a.close, 0);
    const outcome = json(path.join(a.directory, "result.json"));
    assert.equal(outcome.outcome.removed, false);
    assert.equal(outcome.outcome.successor, next.owner.key);
    assert.deepEqual(identity(ctx), held);
    assert(!tryAcquire(ctx.root).acquired);
    release(ctx.root, next.owner);
    return { held, outcome };
  });
  await run("P6.late-release-preserves-successor", () => {
    const ctx = setup("p6");
    const old = tryAcquire(ctx.root);
    reclaim(ctx.root, old.owner);
    const next = tryAcquire(ctx.root);
    const held = identity(ctx);
    const outcome = release(ctx.root, old.owner);
    assert(outcome.missingOldMarker);
    assert.deepEqual(identity(ctx), held);
    assert(!tryAcquire(ctx.root).acquired);
    release(ctx.root, next.owner);
    return { held, outcome };
  });
  await run("P7.legacy-empty-guard-grace", () => {
    const ctx = setup("p7");
    fs.mkdirSync(path.join(ctx.root, ".metadata.lock"));
    let lease;
    withCacheLock(
      ctx.root,
      () => ctx.cache.writeAlias("chrome", "legacy", "2"),
      {
        graceMs: 2000,
        onAcquire: (value) => {
          lease = value;
        },
      },
    );
    assert(lease.elapsedMs >= 2000);
    assert.equal(lease.trace[0].key, "empty");
    assert.equal(observe(ctx.root), null);
    return { lease, metadata: ctx.cache.readMetadata("chrome") };
  });
  await run("P8.removal-error-and-unknown-guard-preserved", () => {
    const ctx = setup("p8");
    const owner = tryAcquire(ctx.root);
    const before = identity(ctx);
    const failure = Object.assign(new Error("Injected unlink denial"), {
      code: "EACCES",
    });
    assert.throws(
      () =>
        reclaim(ctx.root, owner.owner, {
          unlink: () => {
            throw failure;
          },
        }),
      (error) => error === failure,
    );
    assert.deepEqual(identity(ctx), before);
    assert(!tryAcquire(ctx.root).acquired);
    release(ctx.root, owner.owner);
    fs.mkdirSync(path.join(ctx.root, ".metadata.lock"));
    fs.writeFileSync(path.join(ctx.root, ".metadata.lock/unknown"), "retain");
    assert.throws(() => tryAcquire(ctx.root), /Unknown guard contents/);
    assert.equal(
      fs.readFileSync(path.join(ctx.root, ".metadata.lock/unknown"), "utf8"),
      "retain",
    );
    return {
      injectedError: failure.code,
      ownerPreserved: before,
      unknownContentsRetained: true,
    };
  });
  await run("P9.exception-and-cleanup-primary-result", () => {
    const ctx = setup("p9");
    const primary = new Error("Research mutator failure");
    assert.throws(
      () =>
        withCacheLock(ctx.root, () =>
          ctx.cache.updateMetadata("chrome", () => {
            throw primary;
          }),
        ),
      (error) => error === primary,
    );
    assert.equal(observe(ctx.root), null);
    let cleanup;
    const denial = Object.assign(new Error("Injected rmdir denial"), {
      code: "EACCES",
    });
    assert.throws(
      () =>
        withCacheLock(
          ctx.root,
          () => {
            throw primary;
          },
          {
            rmdir: () => {
              throw denial;
            },
            onCleanupError: (error) => {
              cleanup = error;
            },
          },
        ),
      (error) => error === primary,
    );
    assert.equal(cleanup, denial);
    assert.equal(observe(ctx.root).kind, "empty");
    const retainedEmptyGuard = true;
    reclaim(ctx.root, observe(ctx.root));
    return {
      primaryPreserved: true,
      cleanupCode: cleanup.code,
      retainedEmptyGuard,
    };
  });
  await run("P10.successor-restarts-observation-grace", async () => {
    const ctx = setup("p10");
    const old = tryAcquire(ctx.root);
    assert(old.acquired);
    const waiting = child(
      { root: ctx.root, cache: ctx.cacheRoot, mode: "write", alias: "waited" },
      "waiter",
    );
    await event(waiting, "observed");
    await new Promise((resolve) => setTimeout(resolve, 1500));
    reclaim(ctx.root, old.owner);
    const next = tryAcquire(ctx.root);
    assert(next.acquired);
    const held = identity(ctx);
    const deadline = performance.now() + 3000;
    while (
      !waiting.events.some(
        (value) =>
          value.event === "observed" && value.identity.key === next.owner.key,
      )
    ) {
      assert(performance.now() < deadline);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
    assert.deepEqual(identity(ctx), held);
    assert(!waiting.events.some((value) => value.event === "acquired"));
    release(ctx.root, next.owner);
    assert.equal(await waiting.close, 0);
    const result = json(path.join(waiting.directory, "result.json"));
    assert(!result.lease.trace.some((value) => value.event === "reclaimed"));
    assert.equal(
      result.lease.trace.filter((value) => value.event === "observed").length,
      2,
    );
    assert.equal(observe(ctx.root), null);
    return { held, result };
  });
} finally {
  for (const entry of processes)
    if (entry.process && !entry.closed) {
      entry.process.kill("SIGKILL");
      await entry.close;
    }
  const after = frozen();
  assert.deepEqual(after, inputs);
  assert.equal(git("status", "--porcelain"), "");
  for (const ctx of fixtures) assert.deepEqual(treeHashes(ctx), ctx.treeHashes);
  save(path.join(output, "inputs-after.json"), after);
  const audit = processes.map(({ process, close, ...entry }) => entry);
  save(path.join(output, "results.json"), {
    researchOnly: true,
    policy: {
      graceMs: 2000,
      maximumMs: 8000,
      productionValues: false,
      resumedOldWriterSafety: false,
    },
    environment: {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      node: process.version,
      browserPlatform: platform,
      uid: process.getuid(),
      filesystem: fs.statfsSync(output),
    },
    inputs,
    results,
    processAudit: audit,
  });
  const summary = {
    cases: results.length,
    passing: results.filter((value) => value.pass).length,
    failing: results.filter((value) => !value.pass).length,
    ownedProcesses: audit.length,
    allClosed: audit.every((value) => value.closed),
  };
  save(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary));
  if (summary.failing || !summary.allClosed) process.exitCode = 1;
}
