import assert from "node:assert/strict";
import { fork, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const arg = (name) =>
  process.argv
    .find((value) => value.startsWith(`${name}=`))
    ?.slice(name.length + 1);
const repo = arg("--repo");
const baseline = arg("--baseline");
const output = arg("--output");
assert(["win32", "darwin", "linux"].includes(process.platform));
for (const value of [repo, baseline, output])
  assert(value && path.isAbsolute(value));
assert(!fs.existsSync(output));
fs.mkdirSync(output);
const { detectBrowserPlatform } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/detectPlatform.js"))
);
const platform = detectBrowserPlatform();
assert(platform, "Unsupported native browser platform");
const { Cache } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/Cache.js"))
);
const { writeInstallMarker } = await import(
  pathToFileURL(path.join(repo, "packages/browsers/lib/installMarker.js"))
);
const workerFile = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "metadata-lock-cross-platform-worker-2026-10-08.mjs",
);
const json = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const files = [
  "packages/browsers/src/Cache.ts",
  "packages/browsers/test/src/Cache.test.ts",
  "packages/browsers/lib/Cache.js",
];
const inputs = (checkout) => ({
  repo: checkout,
  head: execFileSync("git", ["rev-parse", "HEAD"], { cwd: checkout })
    .toString()
    .trim(),
  patch: sha(execFileSync("git", ["diff", "--binary"], { cwd: checkout })),
  files: files.map((file) => ({
    file,
    sha256: sha(fs.readFileSync(path.join(checkout, file))),
  })),
});
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "metadata-lock-cross-platform-inputs-2026-10-08.json",
    ),
    "utf8",
  ),
);
function verifyInput(checkout, expected) {
  const command = (...args) =>
    execFileSync("git", args, { cwd: checkout }).toString();
  assert.equal(
    command("diff", "--cached", "--name-only"),
    "",
    "Input has staged changes",
  );
  assert.equal(
    command("ls-files", "--others", "--exclude-standard"),
    "",
    "Input has untracked files",
  );
  assert.deepEqual(
    command("diff", "--name-only", manifest.base).trim().split("\n"),
    files.slice(0, 2),
  );
  const head = command("rev-parse", "HEAD").trim();
  if (head === expected.commit)
    assert.equal(
      command("status", "--porcelain"),
      "",
      "Committed input is dirty",
    );
  else {
    assert.equal(
      head,
      manifest.base,
      "Input must use the recorded commit or exact historical dirty baseline",
    );
    assert.notEqual(command("status", "--porcelain"), "");
  }
  for (const entry of expected.files)
    assert.equal(
      sha(
        fs
          .readFileSync(path.join(checkout, entry.file), "utf8")
          .replaceAll("\r\n", "\n"),
      ),
      entry.normalizedSha256,
      entry.file,
    );
}
verifyInput(repo, manifest.candidate);
verifyInput(baseline, manifest.baseline);
const before = [inputs(repo), inputs(baseline)];
const harness = Object.fromEntries(
  [fileURLToPath(import.meta.url), workerFile].map((file) => [
    path.basename(file),
    sha(fs.readFileSync(file)),
  ]),
);
json(path.join(output, "environment.json"), {
  platform: process.platform,
  release: os.release(),
  architecture: process.arch,
  node: process.version,
  browserPlatform: platform,
  manifest,
  harness,
  note: "Metadata concurrency/fault cases use native platform keys and dummy completed files; they do not launch a browser or validate native setup/deps.",
});
json(path.join(output, "inputs.json"), before);
const cases = [];
const allChildren = [];
let sequence = 0;
function child(config) {
  const id = ++sequence;
  const configFile = path.join(output, `worker-${id}.json`);
  config.platform = platform;
  config.release = path.join(output, `release-${id}`);
  json(configFile, config);
  const process = fork(workerFile, [configFile], {
    stdio: ["ignore", "pipe", "pipe", "ipc"],
    windowsHide: true,
  });
  const events = [];
  let stdout = "",
    stderr = "";
  process.stdout.on("data", (value) => {
    stdout += value;
  });
  process.stderr.on("data", (value) => {
    stderr += value;
  });
  process.on("message", (value) => events.push(value));
  const exit = new Promise((resolve) =>
    process.once("exit", (code, signal) => {
      json(path.join(output, `worker-${id}-trace.json`), {
        events,
        stdout,
        stderr,
        code,
        signal,
      });
      resolve({ code, signal });
    }),
  );
  const wait = async (event) => {
    const deadline = performance.now() + 20000;
    for (;;) {
      const found = events.find((value) => value.event === event);
      if (found) return found;
      if (process.exitCode !== null || process.signalCode !== null)
        throw new Error(`Worker exited before ${event}: ${stderr}`);
      if (performance.now() > deadline)
        throw new Error(`Worker timeout for ${event}`);
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  };
  const item = {
    process,
    config,
    events,
    exit,
    wait,
    start: async () => {
      await wait("ready");
      process.send({ start: true });
    },
    release: () => fs.writeFileSync(config.release, "release"),
    finish: async () => {
      const value = await wait("done");
      assert.equal((await exit).code, 0);
      return value;
    },
  };
  allChildren.push(item);
  return item;
}
const metadataFile = (cache) => path.join(cache, "chrome/.metadata");
const lockFile = (cache) => path.join(cache, "chrome/.metadata.lock");
function fixture(name, metadata = { aliases: {} }) {
  const directory = path.join(output, name);
  fs.mkdirSync(path.join(directory, "chrome"), { recursive: true });
  json(metadataFile(directory), metadata);
  return directory;
}
function completed(cache, buildId = "123") {
  const directory = path.join(cache, "chrome", `${platform}-${buildId}`);
  const executable = path.join("custom", "chrome.exe");
  fs.mkdirSync(path.dirname(path.join(directory, executable)), {
    recursive: true,
  });
  fs.writeFileSync(path.join(directory, executable), `completed ${buildId}`);
  writeInstallMarker(directory, executable);
  return directory;
}
function tree(directory) {
  return fs
    .readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) =>
      entry.isDirectory()
        ? tree(path.join(directory, entry.name)).map((item) => ({
            ...item,
            file: `${entry.name}/${item.file}`,
          }))
        : [
            {
              file: entry.name,
              sha256: sha(fs.readFileSync(path.join(directory, entry.name))),
            },
          ],
    );
}
async function test(name, task) {
  try {
    const value = await task();
    cases.push({ name, success: true, ...value });
  } catch (error) {
    cases.push({ name, success: false, error: error.stack });
  }
  console.log(JSON.stringify(cases.at(-1)));
  json(path.join(output, "results.json"), cases);
  for (const item of allChildren) {
    if (item.process.exitCode === null && item.process.signalCode === null) {
      item.release();
      item.process.kill("SIGKILL");
      await item.exit;
    }
  }
}
async function pair(
  name,
  checkout,
  locked,
  firstOperation,
  secondOperation,
  seed = { aliases: {} },
) {
  const cache = fixture(name, seed);
  const first = child({
    repo: checkout,
    cache,
    hold: "read",
    operation: firstOperation,
  });
  await first.start();
  await first.wait("held");
  const second = child({ repo: checkout, cache, operation: secondOperation });
  await second.start();
  if (locked) {
    await second.wait("contended");
    assert(!second.events.some((value) => value.event === "read"));
    first.release();
  } else {
    assert.equal((await second.finish()).success, true);
    first.release();
  }
  const a = await first.finish();
  const b = await second.finish();
  assert.equal(a.success, true);
  assert.equal(b.success, true);
  assert(!fs.existsSync(lockFile(cache)));
  return { metadata: JSON.parse(fs.readFileSync(metadataFile(cache))), a, b };
}
for (const [checkout, locked, label] of [
  [baseline, false, "retry-only"],
  [repo, true, "dir-lock"],
]) {
  for (let i = 0; i < 10; i++)
    await test(`${label}-different-builds-${i}`, async () => {
      const value = await pair(
        `${label}-exe-${i}`,
        checkout,
        locked,
        { kind: "exe", buildId: "123", executable: "a.exe" },
        { kind: "exe", buildId: "456", executable: "b.exe" },
      );
      assert.equal(value.metadata.executablePaths[`${platform}-123`], "a.exe");
      assert.equal(
        value.metadata.executablePaths[`${platform}-456`],
        locked ? "b.exe" : undefined,
      );
      return { ...value, lostUpdateObserved: !locked };
    });
}
await test("different-aliases", async () => {
  const value = await pair(
    "aliases",
    repo,
    true,
    { kind: "alias", alias: "stable", buildId: "123" },
    { kind: "alias", alias: "canary", buildId: "456" },
  );
  assert.deepEqual(value.metadata.aliases, { stable: "123", canary: "456" });
  return value;
});
await test("uninstall-versus-alias", async () => {
  const value = await pair(
    "uninstall",
    repo,
    true,
    { kind: "uninstall", buildId: "123" },
    { kind: "alias", alias: "nightly", buildId: "789" },
    {
      aliases: { stable: "123", canary: "456" },
      executablePaths: {
        [`${platform}-123`]: "a.exe",
        [`${platform}-456`]: "b.exe",
      },
    },
  );
  assert.deepEqual(value.metadata.aliases, { canary: "456", nightly: "789" });
  assert.deepEqual(value.metadata.executablePaths, {
    [`${platform}-456`]: "b.exe",
  });
  return value;
});
await test("public-snapshot-write-participates-but-replaces", async () => {
  const value = await pair(
    "snapshot",
    repo,
    true,
    { kind: "alias", alias: "stable", buildId: "123" },
    { kind: "replace", metadata: { aliases: { canary: "456" } } },
  );
  assert.deepEqual(value.metadata, { aliases: { canary: "456" } });
  return { ...value, snapshotReplacementContract: true };
});
await test("live-owner-timeout-without-takeover", async () => {
  const cache = fixture("live-timeout");
  const owner = child({
    repo,
    cache,
    hold: "read",
    operation: { kind: "alias", alias: "stable", buildId: "123" },
  });
  await owner.start();
  await owner.wait("held");
  const caller = child({
    repo,
    cache,
    operation: { kind: "alias", alias: "canary", buildId: "456" },
  });
  await caller.start();
  const value = await caller.finish();
  assert.equal(value.success, false);
  assert.match(value.error.message, /Timed out waiting for metadata lock/);
  assert(value.duration >= 990 && value.duration < 3000);
  assert(fs.existsSync(lockFile(cache)));
  assert.equal(owner.process.exitCode, null);
  owner.release();
  assert.equal((await owner.finish()).success, true);
  new Cache(cache).writeAlias("chrome", "canary", "456");
  assert.deepEqual(new Cache(cache).readMetadata("chrome").aliases, {
    stable: "123",
    canary: "456",
  });
  return { value };
});
for (const stage of ["read", "beforeRename", "beforeRelease"])
  await test(`kill-${stage}`, async () => {
    const cache = fixture(`kill-${stage}`, {
      aliases: { existing: "123" },
      executablePaths: { [`${platform}-123`]: "custom/chrome.exe" },
    });
    const directory = completed(cache);
    const beforeTree = tree(directory);
    const oldBytes = fs.readFileSync(metadataFile(cache));
    const owner = child({
      repo,
      cache,
      hold: stage,
      operation: { kind: "alias", alias: "new", buildId: "456" },
    });
    await owner.start();
    await owner.wait("held");
    assert(fs.existsSync(lockFile(cache)));
    owner.process.kill("SIGKILL");
    await owner.exit;
    const metadataBytes = fs.readFileSync(metadataFile(cache));
    if (stage === "beforeRelease")
      assert.equal(JSON.parse(metadataBytes).aliases.new, "456");
    else assert.deepEqual(metadataBytes, oldBytes);
    const caller = child({
      repo,
      cache,
      operation: { kind: "alias", alias: "later", buildId: "789" },
    });
    await caller.start();
    const failure = await caller.finish();
    assert.equal(failure.success, false);
    assert.match(failure.error.message, /not automatically reclaimed/);
    assert(failure.duration >= 990 && failure.duration < 3000);
    assert.deepEqual(fs.readFileSync(metadataFile(cache)), metadataBytes);
    assert.deepEqual(tree(directory), beforeTree);
    assert.equal(
      new Cache(cache).computeExecutablePath({
        browser: "chrome",
        platform,
        buildId: "123",
      }),
      path.join(directory, "custom/chrome.exe"),
    );
    new Cache(cache).writeAlias("firefox", "stable", "other-browser");
    const hit = child({
      repo,
      cache,
      operation: { kind: "hit", buildId: "123" },
    });
    await hit.start();
    const hitFailure = await hit.finish();
    assert.equal(hitFailure.success, false);
    assert.match(hitFailure.error.message, /metadata lock/);
    assert.deepEqual(tree(directory), beforeTree);
    const retainedTemps = fs
      .readdirSync(path.join(cache, "chrome"))
      .filter((file) => file.startsWith(".metadata-"));
    fs.rmdirSync(lockFile(cache)); // All owned writers have exited; explicit manual recovery.
    new Cache(cache).writeAlias("chrome", "later", "789");
    assert.equal(new Cache(cache).resolveAlias("chrome", "later"), "789");
    assert.deepEqual(tree(directory), beforeTree);
    return {
      failure,
      hitFailure,
      retainedTemps,
      manualRecovery: true,
      readonlyPathPreserved: true,
    };
  });
await test("ordinary-mutator-error-releases", async () => {
  const cache = fixture("ordinary-error");
  const caller = child({ repo, cache, operation: { kind: "throw" } });
  await caller.start();
  const value = await caller.finish();
  assert.equal(value.error.message, "RESEARCH_MUTATOR_FAILURE");
  assert(!fs.existsSync(lockFile(cache)));
  new Cache(cache).writeAlias("chrome", "stable", "123");
  return { value };
});
assert.deepEqual([inputs(repo), inputs(baseline)], before);
verifyInput(repo, manifest.candidate);
verifyInput(baseline, manifest.baseline);
assert.deepEqual(
  Object.fromEntries(
    [fileURLToPath(import.meta.url), workerFile].map((file) => [
      path.basename(file),
      sha(fs.readFileSync(file)),
    ]),
  ),
  harness,
);
const summary = {
  cases: cases.length,
  failed: cases.filter((value) => !value.success).length,
  baselineLostUpdates: cases.filter((value) => value.lostUpdateObserved).length,
  candidateDifferentBuilds: cases.filter(
    (value) =>
      value.name.startsWith("dir-lock-different-builds") && value.success,
  ).length,
};
json(path.join(output, "summary.json"), summary);
console.log(JSON.stringify(summary));
process.exitCode = summary.failed ? 1 : 0;
