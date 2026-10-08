import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const config = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const send = (event, fields = {}) =>
  process.send?.({ event, at: performance.now(), ...fields });
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));
let held = false;
function hold(stage) {
  if (held || config.hold !== stage) return;
  held = true;
  send("held", { stage });
  const deadline = performance.now() + 20000;
  while (!fs.existsSync(config.release)) {
    if (performance.now() > deadline)
      throw new Error("Research gate timed out");
    Atomics.wait(waitBuffer, 0, 0, 5);
  }
  send("resumed", { stage });
}
const { Cache } = await import(
  pathToFileURL(path.join(config.repo, "packages/browsers/lib/Cache.js"))
);
const originalRead = Cache.prototype.readMetadata;
Cache.prototype.readMetadata = function (...args) {
  const result = originalRead.apply(this, args);
  send("read", { metadata: result });
  hold("read");
  return result;
};
const mkdir = fs.mkdirSync;
let contention = false;
fs.mkdirSync = (target, options) => {
  try {
    const value = mkdir(target, options);
    if (path.basename(String(target)) === ".metadata.lock") send("acquired");
    return value;
  } catch (error) {
    if (
      path.basename(String(target)) === ".metadata.lock" &&
      error.code === "EEXIST" &&
      !contention
    ) {
      contention = true;
      send("contended");
    }
    throw error;
  }
};
const rename = fs.renameSync;
fs.renameSync = (from, to) => {
  if (path.basename(String(to)) === ".metadata") hold("beforeRename");
  const value = rename(from, to);
  if (path.basename(String(to)) === ".metadata") send("committed");
  return value;
};
const rmdir = fs.rmdirSync;
fs.rmdirSync = (target) => {
  if (path.basename(String(target)) === ".metadata.lock") hold("beforeRelease");
  const value = rmdir(target);
  send("released");
  return value;
};
send("ready", { pid: process.pid });
process.once("message", async () => {
  const start = performance.now();
  let timerAt;
  setTimeout(() => {
    timerAt = performance.now() - start;
  }, 10);
  let outcome;
  try {
    const cache = new Cache(config.cache);
    const browser = config.browser ?? "chrome";
    const op = config.operation;
    if (op.kind === "exe")
      cache.writeExecutablePath(
        browser,
        config.platform,
        op.buildId,
        op.executable,
      );
    else if (op.kind === "alias")
      cache.writeAlias(browser, op.alias, op.buildId);
    else if (op.kind === "uninstall")
      cache.uninstall(browser, config.platform, op.buildId);
    else if (op.kind === "replace") cache.writeMetadata(browser, op.metadata);
    else if (op.kind === "throw")
      cache.updateMetadata(browser, () => {
        throw new Error("RESEARCH_MUTATOR_FAILURE");
      });
    else if (op.kind === "hit") {
      const { install } = await import(
        pathToFileURL(
          path.join(config.repo, "packages/browsers/lib/install.js"),
        )
      );
      await install({
        cacheDir: config.cache,
        browser,
        platform: config.platform,
        buildId: op.buildId,
      });
    } else throw new Error(`Unknown operation ${op.kind}`);
    outcome = { success: true };
  } catch (error) {
    outcome = {
      success: false,
      error: { name: error.name, message: error.message, code: error.code },
    };
  }
  const duration = performance.now() - start;
  await new Promise((resolve) => setTimeout(resolve, 20));
  send("done", { ...outcome, duration, timerAt });
  process.disconnect();
});
