// Verify canonical inputs and independently audit complete native model evidence.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const [mode, ...args] = process.argv.slice(2);
assert(["verify", "audit"].includes(mode));
const argument = (name) =>
  args.find((value) => value.startsWith(`${name}=`))?.slice(name.length + 1);
assert(
  args.every(
    (value) =>
      ["--repo=", "--output="].some((prefix) => value.startsWith(prefix)) ||
      value === "--require-linux",
  ),
);
const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(
    path.join(here, "metadata-recovery-posix-inputs-2026-10-12.json"),
    "utf8",
  ),
);
const repo = path.resolve(argument("--repo"));
const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hash = (file) => sha(fs.readFileSync(file));
const json = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const git = (...parameters) =>
  execFileSync("git", ["-C", repo, ...parameters], { encoding: "utf8" }).trim();
assert.equal(process.version, "v24.15.0");
assert.equal(git("rev-parse", "HEAD"), manifest.source.commit);
assert.equal(git("status", "--porcelain"), "");
for (const input of manifest.source.files)
  assert.equal(hash(path.join(repo, input.file)), input.sha256, input.file);
for (const input of manifest.harnesses)
  assert.equal(hash(path.join(here, input.file)), input.sha256, input.file);
const report = {
  mode,
  sourceCommit: manifest.source.commit,
  harnesses: manifest.harnesses.length,
  node: process.version,
  platform: process.platform,
  uid: process.getuid(),
  behaviorCasesRunByChecker: 0,
};
if (args.includes("--require-linux")) {
  assert.equal(process.platform, "linux");
  assert.equal(process.arch, "x64");
  assert.notEqual(process.getuid(), 0);
  assert.equal(fs.statfsSync(path.resolve(argument("--output"))).type, 0xef53);
}
if (mode === "audit") {
  const output = path.resolve(argument("--output"));
  const verify = (directory, names) => {
    const root = path.join(output, directory);
    const result = json(path.join(root, "results.json"));
    const summary = json(path.join(root, "summary.json"));
    assert.deepEqual(
      result.results.map((value) => value.name),
      names,
    );
    assert(result.results.every((value) => value.pass));
    assert.equal(summary.cases, names.length);
    assert.equal(summary.passing, names.length);
    assert.equal(summary.failing, 0);
    assert(summary.allClosed);
    assert.equal(result.processAudit.length, summary.ownedProcesses);
    assert(result.processAudit.every((value) => value.closed && !value.error));
    assert.deepEqual(
      json(path.join(root, "inputs-before.json")),
      json(path.join(root, "inputs-after.json")),
    );
    for (const input of result.inputs.inputs)
      assert.equal(
        input.sha256,
        manifest.source.files.find((value) => value.file === input.file).sha256,
      );
    for (const input of result.inputs.asRun)
      assert.equal(
        input.sha256,
        manifest.harnesses.find(
          (value) => value.file === path.basename(input.file),
        ).sha256,
      );
    assert.equal(result.environment.platform, process.platform);
    assert.equal(result.environment.node, process.version);
    assert.notEqual(result.environment.uid, 0);
    if (args.includes("--require-linux"))
      assert.equal(result.environment.filesystem.type, 0xef53);
    let trees = 0;
    for (const item of fs
      .readdirSync(root, { withFileTypes: true })
      .filter((item) => item.isDirectory())) {
      const browser = path.join(root, item.name, "cache", "chrome");
      const tree = path.join(
        browser,
        `${result.environment.browserPlatform}-1234567`,
      );
      const marker = json(path.join(tree, ".puppeteer-install"));
      assert.deepEqual(marker, {
        version: 1,
        relativeExecutablePath: "custom-executable",
      });
      const metadata = json(path.join(browser, ".metadata"));
      assert.equal(metadata.aliases.base, "0");
      assert.equal(
        metadata.executablePaths[
          `${result.environment.browserPlatform}-1234567`
        ],
        "custom-executable",
      );
      const expected =
        directory === "token"
          ? "Research regular-file executable fixture; no launch"
          : "Research regular-file fixture; no launch";
      assert.equal(hash(path.join(tree, "custom-executable")), sha(expected));
      trees++;
    }
    assert.equal(trees, names.length);
    return { result, summary, trees };
  };
  const tokenNames = [
    "P0.native-nonempty-publication",
    "P1.sigint-then-real-alias-and-cache-hit",
    "P2.two-simultaneous-retries",
    "P3.naive-empty-reaper-deletes-new-owner",
    "P4.losing-token-reaper-preserves-successor",
    "P5.delayed-rmdir-preserves-successor",
    "P6.late-release-preserves-successor",
    "P7.legacy-empty-guard-grace",
    "P8.removal-error-and-unknown-guard-preserved",
    "P9.exception-and-cleanup-primary-result",
    "P10.successor-restarts-observation-grace",
  ];
  const sigintNames = [
    "D.after-acquire",
    "D.after-read",
    "D.before-temp",
    "D.after-temp",
    "D.before-rename",
    "D.after-rename",
    "D.before-release",
    "D.after-release",
    "H.after-read",
    "H.after-temp",
    "H.before-release",
    "W.default",
    "W.handled",
  ];
  const token = verify("token", tokenNames);
  const sigint = verify("sigint", sigintNames);
  const observation = (name) =>
    token.result.results.find((value) => value.name === name).observation;
  assert.equal(observation(tokenNames[1]).signal.signal, "SIGINT");
  assert.equal(observation(tokenNames[1]).signal.code, null);
  assert(observation(tokenNames[1]).lease.elapsedMs >= 2000);
  const metadata = json(path.join(output, "token/p2/cache/chrome/.metadata"));
  assert.deepEqual(metadata.aliases, { base: "0", alpha: "A", beta: "B" });
  assert(
    observation(tokenNames[3]).expectedNegativeControl &&
      observation(tokenNames[3]).newOwnerGuardDeleted,
  );
  assert(observation(tokenNames[4]).outcome.outcome.missingOldMarker);
  assert.equal(observation(tokenNames[5]).outcome.outcome.removed, false);
  assert.equal(observation(tokenNames[5]).outcome.outcome.code, "ENOTEMPTY");
  assert(observation(tokenNames[6]).outcome.missingOldMarker);
  assert(
    !observation(tokenNames[10]).result.lease.trace.some(
      (value) => value.event === "reclaimed",
    ),
  );
  Object.assign(report, {
    token: token.summary,
    sigint: sigint.summary,
    trees: token.trees + sigint.trees,
    nativeErrno: observation(tokenNames[0]).nativeErrno,
    reclaimMs: observation(tokenNames[1]).lease.elapsedMs,
  });
  fs.writeFileSync(
    path.join(output, "independent-audit.json"),
    JSON.stringify(report, null, 2) + "\n",
    { flag: "wx" },
  );
}
console.log(JSON.stringify(report));
