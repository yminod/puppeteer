// Research model only. No PID/hostname test, heartbeat or production policy.
// Grace measures one continuously observed identity; it is not proof of death.
import {randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const native = Object.fromEntries(['mkdirSync', 'renameSync', 'unlinkSync', 'rmdirSync', 'writeFileSync'].map(name => [name, fs[name]]));
const sleeper = new Int32Array(new SharedArrayBuffer(4));
const lockPath = root => path.join(root, '.metadata.lock');
const ownerPattern = /^owner-([0-9a-f-]{36})$/;

export function observe(root) {
  const lock = lockPath(root);
  try {
    if (!fs.lstatSync(lock).isDirectory() || fs.lstatSync(lock).isSymbolicLink()) throw new Error('Unknown guard type');
    const entries = fs.readdirSync(lock);
    if (!entries.length) return {kind: 'empty', key: 'empty'};
    if (entries.length !== 1 || !ownerPattern.test(entries[0])) throw new Error('Unknown guard contents');
    const marker = entries[0];
    const ownerPath = path.join(lock, marker);
    if (!fs.lstatSync(ownerPath).isFile() || fs.lstatSync(ownerPath).isSymbolicLink()) throw new Error('Unknown owner marker type');
    const owner = JSON.parse(fs.readFileSync(ownerPath, 'utf8'));
    if (owner.version !== 1 || marker !== `owner-${owner.token}`) throw new Error('Unknown owner marker record');
    return {kind: 'owner', key: marker, marker, token: owner.token};
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function removeEmpty(root, options) {
  try {
    (options.rmdir ?? native.rmdirSync)(lockPath(root));
    return {removed: true};
  } catch (error) {
    if (error.code === 'ENOENT') return {removed: false, code: error.code};
    // The pathname may now name a fully published nonempty successor.
    // Confirm a successor instead of suppressing arbitrary permission errors.
    const successor = observe(root);
    if (successor?.kind === 'owner' && ['ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code)) return {removed: false, code: error.code, successor: successor.key};
    throw error;
  }
}

export function reclaim(root, identity, options = {}) {
  options.hook?.('before-remove-marker', identity);
  if (identity.kind === 'owner') {
    try {
      (options.unlink ?? native.unlinkSync)(path.join(lockPath(root), identity.marker));
    } catch (error) {
      // A loser has no authority to remove the current pathname.
      if (error.code === 'ENOENT') return {removed: false, code: error.code, missingOldMarker: true};
      throw error;
    }
    options.hook?.('after-remove-marker', identity);
  }
  const outcome = removeEmpty(root, options);
  options.hook?.('after-remove-directory', outcome);
  return outcome;
}

export function tryAcquire(root, options = {}) {
  const existing = observe(root);
  if (existing) return {acquired: false, code: 'guard-observed', observed: existing};
  const token = randomUUID();
  const marker = `owner-${token}`;
  const prepared = path.join(root, `.metadata.lock-prepared-${token}`);
  native.mkdirSync(root, {recursive: true});
  native.mkdirSync(prepared);
  let published = false;
  try {
    native.writeFileSync(path.join(prepared, marker), JSON.stringify({version: 1, token}), {flag: 'wx'});
    options.beforePublish?.();
    try {
      native.renameSync(prepared, lockPath(root));
      published = true;
      return {acquired: true, owner: {kind: 'owner', key: marker, marker, token}};
    } catch (error) {
      // Native Windows rename reports EPERM for an occupied directory.
      // Only treat it as contention when the destination is a recognized guard.
      if (!['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code)) throw error;
      const observed = observe(root);
      if (!observed) throw error;
      return {acquired: false, code: error.code, observed};
    }
  } finally {
    if (!published) {
      native.unlinkSync(path.join(prepared, marker));
      native.rmdirSync(prepared);
    }
  }
}

export function acquire(root, options = {}) {
  const graceMs = options.graceMs ?? 2000;
  const maximumMs = options.maximumMs ?? 8000;
  const started = performance.now();
  let observedKey;
  let observedAt;
  const trace = [];
  while (true) {
    const attempt = tryAcquire(root);
    if (attempt.acquired) return {...attempt, elapsedMs: performance.now() - started, trace};
    const now = performance.now();
    if (attempt.observed.key !== observedKey) {
      observedKey = attempt.observed.key;
      observedAt = now;
      trace.push({event: 'observed', key: observedKey, atMs: now - started, code: attempt.code});
      options.hook?.('observed', attempt.observed);
    }
    if (now - started >= maximumMs) throw new Error('Research acquisition budget exhausted');
    if (now - observedAt >= graceMs) {
      const outcome = reclaim(root, attempt.observed, options);
      trace.push({event: 'reclaimed', key: attempt.observed.key, atMs: performance.now() - started, outcome});
      observedKey = undefined;
    } else Atomics.wait(sleeper, 0, 0, Math.min(25, graceMs - (now - observedAt)));
  }
}

export function release(root, owner, options = {}) {
  return reclaim(root, owner, options);
}

// Use unchanged Cache RMW/temp/rename behavior under the model's lock.
// Replace only its empty-guard mkdir/rmdir for this synchronous callback.
// This shim is an experiment, not a source patch or public Cache API.
export function withCacheLock(root, task, options = {}) {
  const lease = acquire(root, options);
  const mkdir = fs.mkdirSync;
  const rmdir = fs.rmdirSync;
  const sameGuard = target => path.resolve(String(target)) === lockPath(root);
  fs.mkdirSync = (target, ...args) => sameGuard(target) ? undefined : mkdir(target, ...args);
  fs.rmdirSync = (target, ...args) => sameGuard(target) ? undefined : rmdir(target, ...args);
  try {
    options.onAcquire?.(lease);
    return task(lease);
  } finally {
    fs.mkdirSync = mkdir;
    fs.rmdirSync = rmdir;
    try { const outcome = release(root, lease.owner, options); options.onRelease?.(outcome); }
    catch (error) { options.onCleanupError?.(error); }
  }
}
