import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {observe, reclaim, release, withCacheLock} from './metadata-token-recovery-model-2026-10-09.mjs';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const record = (event, fields = {}) => {
  const value = {event, at: performance.now(), pid: process.pid, ...fields};
  fs.appendFileSync(path.join(config.output, 'events.jsonl'), JSON.stringify(value) + '\n');
  process.send?.(value);
};
const save = (name, value) => fs.writeFileSync(path.join(config.output, name), JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const sleeper = new Int32Array(new SharedArrayBuffer(4));
function gate(stage) {
  if (config.hold !== stage) return;
  record('held', {stage});
  fs.writeFileSync(path.join(config.output, 'trigger'), 'ready', {flag: 'wx'});
  const deadline = performance.now() + 15000;
  while (!fs.existsSync(path.join(config.output, 'release'))) {
    if (performance.now() >= deadline) throw new Error('Research gate timeout');
    Atomics.wait(sleeper, 0, 0, 5);
  }
}
if (config.nativeSignal) setInterval(() => {}, 1000);
try {
  if (config.mode === 'reclaim') {
    const identity = observe(config.root);
    record('observed-for-reclaim', {identity});
    const outcome = reclaim(config.root, identity, {hook: stage => gate(stage)});
    save('result.json', {identity, outcome});
  } else if (config.mode === 'release') {
    save('result.json', release(config.root, config.owner));
  } else {
    const {Cache} = await import(pathToFileURL(path.join(config.repo, 'packages/browsers/lib/Cache.js')));
    const cache = new Cache(config.cache);
    let lease;
    gate('before-acquire');
    withCacheLock(config.root, () => cache.writeAlias('chrome', config.alias ?? 'old', config.value ?? '1'), {
      graceMs: config.graceMs ?? 2000,
      maximumMs: 8000,
      onAcquire: acquired => {lease = acquired; record('acquired', {lease}); gate('after-acquire');},
      hook: (stage, identity) => record(stage, {identity}),
    });
    save('result.json', {success: true, lease});
  }
} catch (error) {
  save('error.json', {name: error.name, code: error.code, message: error.message});
  record('error', {message: error.message});
  process.exitCode = 1;
} finally {process.disconnect?.();}
