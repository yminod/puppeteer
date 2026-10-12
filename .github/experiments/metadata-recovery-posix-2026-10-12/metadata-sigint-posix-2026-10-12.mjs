// Research-only POSIX observations of unchanged Cache; no product signal handler.
import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

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
  "metadata-sigint-worker-2026-10-09.mjs",
);
const hash = (file) =>
  createHash("sha256").update(fs.readFileSync(file)).digest("hex");
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + "\n", { flag: "wx" });
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const git = (...args) =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
const files = [
  "packages/browsers/src/Cache.ts",
  "packages/browsers/test/src/Cache.test.ts",
  "packages/browsers/lib/Cache.js",
];
const expected = [
  "7122c6b244aaea7b4a9c616c462ea86685447d4a86c17a4443a74dfe5511736e",
  "adba2e60e5893d4de654bba9b581d23da0194f8560415a11210810a5f1bbe304",
  "fdaaf960a7a73ea3fabd1c86e7253557ef6b2dbef53a1794e75596fd66e103ea",
];
const freeze = () => {
  assert.equal(
    git("rev-parse", "HEAD"),
    "944cdef2d6a3bf7b40a55e2ea4a18c5d76beb069",
  );
  assert.equal(git("status", "--porcelain"), "");
  return {
    sourceHead: git("rev-parse", "HEAD"),
    inputs: files.map((file, i) => {
      const sha256 = hash(path.join(repo, file));
      assert.equal(sha256, expected[i]);
      return { file, sha256 };
    }),
    asRun: [self, worker].map((file) => ({ file, sha256: hash(file) })),
  };
};
const inputs = freeze();
save(path.join(output, "inputs-before.json"), inputs);
const { Cache } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/Cache.js"))
);
const { install } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/install.js"))
);
const { detectBrowserPlatform } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/detectPlatform.js"))
);
const platform = detectBrowserPlatform();
assert(platform);
const processes = [],
  results = [],
  fixtures = [];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function setup(label) {
  const directory = path.join(output, label);
  fs.mkdirSync(directory);
  const cacheRoot = path.join(directory, "cache");
  const cache = new Cache(cacheRoot);
  const tree = cache.installationDir("chrome", platform, "1234567");
  fs.mkdirSync(tree, { recursive: true });
  fs.writeFileSync(
    path.join(tree, "custom-executable"),
    "Research regular-file fixture; no launch",
  );
  fs.writeFileSync(
    path.join(tree, ".puppeteer-install"),
    JSON.stringify({ version: 1, relativeExecutablePath: "custom-executable" }),
  );
  cache.writeMetadata("chrome", {
    aliases: { base: "0" },
    executablePaths: { [`${platform}-1234567`]: "custom-executable" },
  });
  const ctx = {
    directory,
    cacheRoot,
    cache,
    tree,
    guard: path.join(cache.browserRoot("chrome"), ".metadata.lock"),
  };
  ctx.treeHashes = treeHashes(ctx);
  fixtures.push(ctx);
  return ctx;
}
function treeHashes(ctx) {
  return ["custom-executable", ".puppeteer-install"].map((name) => ({
    name,
    sha256: hash(path.join(ctx.tree, name)),
  }));
}
function events(entry) {
  const file = path.join(entry.directory, "events.jsonl");
  return fs.existsSync(file)
    ? fs
        .readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function child(ctx, label, config) {
  const directory = path.join(ctx.directory, label);
  fs.mkdirSync(directory);
  const file = path.join(directory, "config.json");
  save(file, { repo, cache: ctx.cacheRoot, output: directory, ...config });
  const log = fs.openSync(path.join(directory, "worker.log"), "wx");
  const childProcess = spawn(process.execPath, [worker, file], {
    stdio: ["ignore", log, log],
  });
  fs.closeSync(log);
  const entry = {
    process: childProcess,
    role: label,
    pid: childProcess.pid,
    directory,
    closed: false,
  };
  entry.close = new Promise((resolve) =>
    childProcess.once("close", (code, signal) => {
      Object.assign(entry, { closed: true, code, signal });
      resolve();
    }),
  );
  childProcess.on("error", (error) => {
    entry.error = String(error);
  });
  processes.push(entry);
  return entry;
}
async function until(entry, predicate) {
  const deadline = performance.now() + 15000;
  while (!predicate()) {
    assert(!entry.closed, `${entry.role} closed before readiness`);
    assert(performance.now() < deadline, `${entry.role} readiness timeout`);
    await delay(5);
  }
}
const held = (entry) =>
  until(entry, () => fs.existsSync(path.join(entry.directory, "trigger")));
const resume = (entry) =>
  fs.writeFileSync(path.join(entry.directory, "release"), "resume", {
    flag: "wx",
  });
async function signal(entry) {
  assert(entry.process.kill("SIGINT"));
  entry.sentAt = performance.now();
}
async function closed(entry) {
  let timer;
  try {
    await Promise.race([
      entry.close,
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`${entry.role} close timeout`)),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
function snapshot(ctx) {
  assert.deepEqual(treeHashes(ctx), ctx.treeHashes);
  const readOnlyPath = ctx.cache.computeExecutablePath({
    browser: "chrome",
    platform,
    buildId: "1234567",
  });
  assert.equal(readOnlyPath, path.join(ctx.tree, "custom-executable"));
  return {
    metadata: ctx.cache.readMetadata("chrome"),
    metadataSha256: hash(ctx.cache.metadataFile("chrome")),
    guard: fs.existsSync(ctx.guard),
    treeHashes: treeHashes(ctx),
    readOnlyPath,
  };
}
async function retry(ctx, blocked) {
  const started = performance.now();
  if (blocked) {
    assert.throws(
      () => ctx.cache.writeAlias("chrome", "retry", "2"),
      /Timed out waiting for metadata lock/,
    );
    await assert.rejects(
      install({
        cacheDir: ctx.cacheRoot,
        browser: "chrome",
        platform,
        buildId: "1234567",
      }),
      /Timed out waiting for metadata lock/,
    );
  } else {
    ctx.cache.writeAlias("chrome", "retry", "2");
    const hit = await install({
      cacheDir: ctx.cacheRoot,
      browser: "chrome",
      platform,
      buildId: "1234567",
    });
    assert.equal(hit.path, ctx.tree);
  }
  return performance.now() - started;
}
async function run(name, task) {
  try {
    results.push({ name, pass: true, observation: await task() });
    console.log(JSON.stringify({ name, pass: true }));
  } catch (error) {
    results.push({ name, pass: false, error: error.stack });
    console.log(JSON.stringify({ name, pass: false, error: error.message }));
  }
}
try {
  for (const stage of [
    "after-acquire",
    "after-read",
    "before-temp",
    "after-temp",
    "before-rename",
    "after-rename",
    "before-release",
    "after-release",
  ]) {
    await run(`D.${stage}`, async () => {
      const ctx = setup(`default-${stage}`);
      const target = child(ctx, "owner", {
        mode: "write",
        hold: stage,
        nativeSignal: true,
      });
      await held(target);
      const before = snapshot(ctx);
      await signal(target);
      await closed(target);
      assert.equal(target.code, null);
      assert.equal(target.signal, "SIGINT");
      const after = snapshot(ctx);
      assert.deepEqual(after, before);
      const blocked = stage !== "after-release";
      assert.equal(after.guard, blocked);
      assert.equal(
        after.metadata.aliases.old,
        ["after-rename", "before-release", "after-release"].includes(stage)
          ? "1"
          : undefined,
      );
      const temps = fs
        .readdirSync(ctx.cache.browserRoot("chrome"))
        .filter((name) => /^\.metadata-\d+-/.test(name));
      assert.equal(
        temps.length,
        ["after-temp", "before-rename"].includes(stage) ? 1 : 0,
      );
      const retryMs = await retry(ctx, blocked);
      if (blocked) {
        fs.rmdirSync(ctx.guard);
        await retry(ctx, false);
      }
      return {
        before,
        after,
        retryMs,
        temps,
        manualRecoveryOnly: blocked,
        events: events(target),
      };
    });
  }
  for (const stage of ["after-read", "after-temp", "before-release"]) {
    await run(`H.${stage}`, async () => {
      const ctx = setup(`handled-${stage}`);
      const target = child(ctx, "owner", {
        mode: "write",
        hold: stage,
        handler: true,
        nativeSignal: true,
      });
      await held(target);
      await signal(target);
      await delay(100);
      assert(!target.closed);
      assert(!events(target).some((value) => value.event === "sigint-handler"));
      assert(fs.existsSync(ctx.guard));
      resume(target);
      await closed(target);
      assert.equal(target.code, 130);
      assert.equal(target.signal, null);
      const recorded = events(target);
      const returned = recorded.findIndex(
        (value) => value.event === "update-returned",
      );
      const listener = recorded.findIndex(
        (value) => value.event === "sigint-handler",
      );
      assert(returned >= 0 && listener > returned);
      assert.equal(recorded[listener].guardExists, false);
      assert(!fs.existsSync(ctx.guard));
      await retry(ctx, false);
      return { events: recorded, after: snapshot(ctx) };
    });
  }
  for (const handler of [false, true]) {
    await run(`W.${handler ? "handled" : "default"}`, async () => {
      const ctx = setup(`waiter-${handler}`);
      const holder = child(ctx, "holder", {
        mode: "write",
        hold: "after-acquire",
      });
      await held(holder);
      const before = snapshot(ctx);
      const waiting = child(ctx, "waiter", {
        mode: "write",
        hold: handler ? "observe-only" : "waiting",
        triggerOnContention: true,
        nativeSignal: true,
        handler,
      });
      await held(waiting);
      await signal(waiting);
      await closed(waiting);
      assert.deepEqual(snapshot(ctx), before);
      const recorded = events(waiting);
      if (handler) {
        assert.equal(waiting.code, 130);
        assert.equal(waiting.signal, null);
        const contended = recorded.find((value) => value.event === "contended");
        const caught = recorded.find((value) => value.event === "caught-error");
        const listener = recorded.find(
          (value) => value.event === "sigint-handler",
        );
        assert(caught.at - contended.at >= 900);
        assert(listener.at >= caught.at);
        assert.equal(listener.guardExists, true);
      } else {
        assert.equal(waiting.code, null);
        assert.equal(waiting.signal, "SIGINT");
      }
      resume(holder);
      await closed(holder);
      assert.equal(holder.code, 0);
      await retry(ctx, false);
      return { before, events: recorded, after: snapshot(ctx) };
    });
  }
} finally {
  for (const entry of processes)
    if (!entry.closed) {
      entry.process.kill("SIGKILL");
      await entry.close;
    }
  for (const ctx of fixtures) assert.deepEqual(treeHashes(ctx), ctx.treeHashes);
  const after = freeze();
  assert.deepEqual(after, inputs);
  save(path.join(output, "inputs-after.json"), after);
  const processAudit = processes.map(({ process, close, ...entry }) => ({
    ...entry,
    events: events(entry),
  }));
  save(path.join(output, "results.json"), {
    researchOnly: true,
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
    processAudit,
  });
  const summary = {
    cases: results.length,
    passing: results.filter((value) => value.pass).length,
    failing: results.filter((value) => !value.pass).length,
    ownedProcesses: processAudit.length,
    allClosed: processAudit.every((value) => value.closed),
  };
  save(path.join(output, "summary.json"), summary);
  console.log(JSON.stringify(summary));
  if (summary.failing || !summary.allClosed) process.exitCode = 1;
}
