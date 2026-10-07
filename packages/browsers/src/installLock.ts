/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Research prototype: immutable succession records deliberately remain in the
// cache. This isolates generations without conditional shared-path deletion,
// but is not a bounded-storage production lock or a legacy-lock migration.

import {randomUUID} from 'node:crypto';
import {
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  utimes,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

import type {Browser, BrowserPlatform} from './browser-data/browser-data.js';
import type {Cache} from './Cache.js';
import {debug, type LoggerFunction} from './debug.js';
import {InstallLockError} from './installLockBaseline.js';

export {InstallLockError} from './installLockBaseline.js';

/**
 * @internal
 */
export interface InstallLockOptions {
  retryDelay?: number;
  staleThreshold?: number;
  acquisitionTimeout?: number;
  heartbeatInterval?: number;
  /**
   * Maximum heartbeat age, not total task duration. Disabled unless specified
   * by an experiment; no production hard-ceiling value is adopted here.
   */
  hardMaximum?: number;
  cleanupMaxRetries?: number;
  cleanupRetryDelay?: number;
  logger?: LoggerFunction;
  warningLogger?: LoggerFunction;
  beforeStaleLockClaim?: () => Promise<void>;
  beforeOwnerPublication?: () => Promise<void>;
}

interface Owner {
  version: 1;
  generation: string;
  hostname: string;
  pid: number;
}

interface Snapshot {
  generation: string;
  directory: string;
  owner: Owner | undefined;
  mtimeMs: number;
  released: boolean;
}

interface Candidate {
  owner: Owner;
  directory: string;
  pointer: string;
}

type Decision =
  | {claimable: true}
  | {
      claimable: false;
      reason: 'owner-alive' | 'owner-unverifiable' | 'invalid-owner-metadata';
    };

/**
 * Only unique, unpublished paths are recursively removed. Fault injection must
 * be restored by its owning test.
 *
 * @internal
 */
export const installLockDependenciesForTesting = {
  kill: process.kill.bind(process),
  remove: rm,
};

export function installLockPath(
  cache: Cache,
  browser: Browser,
  platform: BrowserPlatform,
  buildId: string,
): string {
  // Keep the experiment's on-disk protocol separate from existing PR locks.
  return path.join(
    cache.browserRoot(browser),
    `.installLockGeneration-${platform}-${encodeURIComponent(buildId)}`,
  );
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}

async function exists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch (error) {
    if (hasCode(error, 'ENOENT')) {
      return false;
    }
    throw error;
  }
}

function isGeneration(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
  );
}

function parseOwner(text: string, generation: string): Owner | undefined {
  try {
    const value: unknown = JSON.parse(text);
    if (typeof value !== 'object' || value === null) {
      return;
    }
    const record = value as Record<string, unknown>;
    if (
      record['version'] !== 1 ||
      record['generation'] !== generation ||
      typeof record['hostname'] !== 'string' ||
      !record['hostname'] ||
      record['hostname'].trim() !== record['hostname'] ||
      typeof record['pid'] !== 'number' ||
      !Number.isSafeInteger(record['pid']) ||
      record['pid'] <= 0
    ) {
      return;
    }
    return record as unknown as Owner;
  } catch {
    return;
  }
}

async function readPointer(pointer: string): Promise<string | undefined> {
  let contents: string;
  try {
    contents = await readFile(path.join(pointer, 'identity'), 'utf8');
  } catch (error) {
    if (hasCode(error, 'ENOENT') && !(await exists(pointer))) {
      return;
    }
    throw error;
  }
  const value = JSON.parse(contents) as Record<string, unknown>;
  if (value['version'] !== 1 || !isGeneration(value['generation'])) {
    throw new Error(`Invalid immutable install lock pointer: ${pointer}`);
  }
  return value['generation'];
}

async function inspect(lockPath: string): Promise<Snapshot | undefined> {
  let generation = await readPointer(path.join(lockPath, 'first'));
  if (generation === undefined) {
    return;
  }
  const visited = new Set<string>();
  while (true) {
    if (visited.has(generation)) {
      throw new Error(`Cyclic install lock succession at ${lockPath}`);
    }
    visited.add(generation);
    const directory = path.join(lockPath, 'generations', generation);
    const next = await readPointer(path.join(directory, 'next'));
    if (next !== undefined) {
      generation = next;
      continue;
    }
    const heartbeat = path.join(directory, 'heartbeat');
    let owner: Owner | undefined;
    let mtimeMs: number;
    try {
      owner = parseOwner(await readFile(heartbeat, 'utf8'), generation);
      mtimeMs = (await stat(heartbeat)).mtimeMs;
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) {
        throw error;
      }
      mtimeMs = (await stat(directory)).mtimeMs;
    }
    return {
      generation,
      directory,
      owner,
      mtimeMs,
      released: await exists(path.join(directory, 'released')),
    };
  }
}

function decision(
  snapshot: Snapshot,
  staleThreshold: number,
  hardMaximum: number,
): Decision {
  if (snapshot.released) {
    return {claimable: true};
  }
  const age = Math.max(0, Date.now() - snapshot.mtimeMs);
  if (snapshot.owner !== undefined) {
    if (snapshot.owner.hostname === os.hostname()) {
      try {
        installLockDependenciesForTesting.kill(snapshot.owner.pid, 0);
      } catch (error) {
        if (hasCode(error, 'ESRCH')) {
          return {claimable: true};
        }
        if (age > hardMaximum) {
          return {claimable: true};
        }
        return {claimable: false, reason: 'owner-unverifiable'};
      }
    }
    if (age > hardMaximum) {
      return {claimable: true};
    }
    return {
      claimable: false,
      reason:
        snapshot.owner.hostname === os.hostname()
          ? 'owner-alive'
          : 'owner-unverifiable',
    };
  }
  return age > staleThreshold
    ? {claimable: true}
    : {claimable: false, reason: 'invalid-owner-metadata'};
}

async function cleanup(
  target: string,
  options: InstallLockOptions,
  logger: LoggerFunction | undefined,
): Promise<void> {
  try {
    await installLockDependenciesForTesting.remove(target, {
      recursive: true,
      force: true,
      maxRetries: options.cleanupMaxRetries ?? 5,
      retryDelay: options.cleanupRetryDelay ?? 100,
    });
  } catch (error) {
    logger?.(
      `Failed to clean up private install lock path ${target}: ${error}`,
    );
  }
}

async function atomicRecord(target: string, record: unknown): Promise<void> {
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, {flag: 'wx'});
    await rename(temporary, target);
  } finally {
    await rm(temporary, {force: true}).catch(() => {});
  }
}

async function candidate(
  lockPath: string,
  options: InstallLockOptions,
  logger: LoggerFunction | undefined,
): Promise<Candidate> {
  const owner: Owner = {
    version: 1,
    generation: randomUUID(),
    hostname: os.hostname(),
    pid: process.pid,
  };
  const directory = path.join(lockPath, 'generations', owner.generation);
  const pointer = path.join(lockPath, `.claim-${owner.generation}`);
  try {
    await mkdir(directory);
    await atomicRecord(path.join(directory, 'heartbeat'), owner);
    await mkdir(pointer);
    await writeFile(
      path.join(pointer, 'identity'),
      `${JSON.stringify({version: 1, generation: owner.generation})}\n`,
      {flag: 'wx'},
    );
    await options.beforeOwnerPublication?.();
    return {owner, directory, pointer};
  } catch (error) {
    await cleanup(pointer, options, logger);
    await cleanup(directory, options, logger);
    throw error;
  }
}

export async function withInstallLock<T>(
  lockPath: string,
  task: () => Promise<T>,
  options: InstallLockOptions = {},
): Promise<T> {
  const logger = options.logger ?? debug('puppeteer:browsers:install');
  const staleThreshold = options.staleThreshold ?? 60_000;
  const hardMaximum = options.hardMaximum ?? Infinity;
  const acquisitionTimeout = options.acquisitionTimeout ?? 15 * 60_000;
  const started = performance.now();
  let loggedContention = false;
  let acquired: Candidate;
  await mkdir(path.join(lockPath, 'generations'), {recursive: true});
  while (true) {
    const snapshot = await inspect(lockPath);
    const claim = snapshot
      ? decision(snapshot, staleThreshold, hardMaximum)
      : {claimable: true as const};
    if (claim.claimable) {
      const attempt = await candidate(lockPath, options, logger);
      let published = false;
      try {
        if (snapshot) {
          await options.beforeStaleLockClaim?.();
        }
        const current = await inspect(lockPath);
        if (
          current?.generation === snapshot?.generation &&
          (!current || decision(current, staleThreshold, hardMaximum).claimable)
        ) {
          const pointer = current
            ? path.join(current.directory, 'next')
            : path.join(lockPath, 'first');
          try {
            // Complete nonempty directories cannot replace a nonempty winner
            // on the local filesystems being tested by this prototype.
            await rename(attempt.pointer, pointer);
            published = true;
            acquired = attempt;
            break;
          } catch (error) {
            if (!hasCode(error, 'EEXIST') && !hasCode(error, 'ENOTEMPTY')) {
              // Windows can report EPERM for a nonempty destination. Only
              // accept it when a complete competing record is present.
              if (!(await readPointer(pointer))) {
                throw error;
              }
            }
          }
        }
      } finally {
        if (!published) {
          await cleanup(attempt.pointer, options, logger);
          await cleanup(attempt.directory, options, logger);
        }
      }
    }
    if (!loggedContention) {
      logger?.(`Waiting for browser install lock at ${lockPath}`);
      loggedContention = true;
    }
    const waitedMs = performance.now() - started;
    if (waitedMs >= acquisitionTimeout) {
      throw new InstallLockError(
        lockPath,
        waitedMs,
        claim.claimable ? undefined : claim.reason,
        snapshot?.owner,
        snapshot ? Math.max(0, Date.now() - snapshot.mtimeMs) : undefined,
      );
    }
    await sleep(options.retryDelay ?? 100);
  }
  let refresh: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (refresh) {
      return;
    }
    const now = new Date();
    // This path names only this generation, even after a successor publishes.
    refresh = utimes(path.join(acquired.directory, 'heartbeat'), now, now)
      .catch(error => {
        logger?.(`Failed to refresh browser install lock: ${error}`);
      })
      .finally(() => {
        refresh = undefined;
      });
  }, options.heartbeatInterval ?? 10_000);
  timer.unref();
  try {
    return await task();
  } finally {
    clearInterval(timer);
    await refresh;
    try {
      // Never delete a shared lock pathname or a published succession record.
      await atomicRecord(
        path.join(acquired.directory, 'released'),
        acquired.owner,
      );
    } catch (error) {
      logger?.(`Failed to release browser install lock generation: ${error}`);
    }
  }
}
