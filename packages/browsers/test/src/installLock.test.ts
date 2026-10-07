/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import promises from 'node:fs/promises';
import {syncBuiltinESMExports} from 'node:module';
import os from 'node:os';
import path from 'node:path';

import {
  InstallLockError,
  installLockDependenciesForTesting,
  withInstallLock,
  type InstallLockOptions,
} from '../../lib/installLock.js';

describe('installLock generation experiment', () => {
  let directory: string;
  let lockPath: string;
  const originalRename = promises.rename;
  const originalUtimes = promises.utimes;
  const originalDependencies = {...installLockDependenciesForTesting};
  const held: Array<{release: () => void; promise: Promise<unknown>}> = [];
  const options: InstallLockOptions = {
    heartbeatInterval: 60_000,
    staleThreshold: 10_000,
    acquisitionTimeout: 1000,
    retryDelay: 1,
    logger: () => {},
  };

  beforeEach(() => {
    directory = fs.mkdtempSync(
      path.join(os.tmpdir(), 'puppeteer-lock-generation-'),
    );
    lockPath = path.join(directory, 'lock');
  });

  afterEach(async () => {
    promises.rename = originalRename;
    promises.utimes = originalUtimes;
    syncBuiltinESMExports();
    Object.assign(installLockDependenciesForTesting, originalDependencies);
    for (const lock of held) {
      lock.release();
    }
    await Promise.allSettled(
      held.map(lock => {
        return lock.promise;
      }),
    );
    held.length = 0;
    fs.rmSync(directory, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  });

  function current() {
    let generation = JSON.parse(
      fs.readFileSync(path.join(lockPath, 'first/identity'), 'utf8'),
    ).generation as string;
    while (
      fs.existsSync(
        path.join(lockPath, 'generations', generation, 'next/identity'),
      )
    ) {
      generation = JSON.parse(
        fs.readFileSync(
          path.join(lockPath, 'generations', generation, 'next/identity'),
          'utf8',
        ),
      ).generation;
    }
    const location = path.join(lockPath, 'generations', generation);
    return {
      generation,
      directory: location,
      heartbeat: path.join(location, 'heartbeat'),
    };
  }

  async function hold(overrides: InstallLockOptions = {}) {
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const promise = withInstallLock(
      lockPath,
      async () => {
        entered.resolve();
        await release.promise;
      },
      {...options, ...overrides},
    );
    held.push({release: release.resolve, promise});
    await Promise.race([entered.promise, promise]);
    return {release: release.resolve, promise, snapshot: current()};
  }

  function age(target: string) {
    const old = new Date(Date.now() - 20_000);
    fs.utimesSync(target, old, old);
  }

  it('publishes a complete owner record before its first task starts', async () => {
    let called = false;
    await withInstallLock(
      lockPath,
      async () => {
        called = true;
        const snapshot = current();
        const owner = JSON.parse(fs.readFileSync(snapshot.heartbeat, 'utf8'));
        assert.strictEqual(owner.generation, snapshot.generation);
        assert.strictEqual(owner.pid, process.pid);
      },
      {
        ...options,
        beforeOwnerPublication: async () => {
          assert.strictEqual(called, false);
          assert.strictEqual(
            fs.existsSync(path.join(lockPath, 'first')),
            false,
          );
          const generations = fs.readdirSync(
            path.join(lockPath, 'generations'),
          );
          assert.strictEqual(generations.length, 1);
          const owner = JSON.parse(
            fs.readFileSync(
              path.join(lockPath, 'generations', generations[0]!, 'heartbeat'),
              'utf8',
            ),
          );
          assert.strictEqual(owner.version, 1);
          assert.strictEqual(owner.generation, generations[0]);
        },
      },
    );
    assert.strictEqual(called, true);
    assert.strictEqual(
      fs.existsSync(path.join(current().directory, 'released')),
      true,
    );
  });

  it('reclaims a fresh local dead owner without waiting for the stale threshold', async () => {
    const first = await hold();
    const process = spawn(globalThis.process.execPath, ['-e', ''], {
      stdio: 'ignore',
    });
    await once(process, 'exit');
    const owner = JSON.parse(fs.readFileSync(first.snapshot.heartbeat, 'utf8'));
    fs.writeFileSync(
      first.snapshot.heartbeat,
      JSON.stringify({...owner, pid: process.pid}),
    );
    let entered = false;
    await withInstallLock(
      lockPath,
      async () => {
        entered = true;
      },
      {...options, acquisitionTimeout: 0},
    );
    assert.strictEqual(entered, true);
    assert.notStrictEqual(current().generation, first.snapshot.generation);
    first.release();
    await first.promise;
  });

  it('keeps fresh foreign owners and does not infer local death from EPERM', async () => {
    const first = await hold();
    const owner = JSON.parse(fs.readFileSync(first.snapshot.heartbeat, 'utf8'));
    fs.writeFileSync(
      first.snapshot.heartbeat,
      JSON.stringify({...owner, hostname: `${os.hostname()}-remote`}),
    );
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('foreign owner was claimed');
        },
        {...options, acquisitionTimeout: 0},
      ),
      error => {
        return (
          error instanceof InstallLockError &&
          error.reason === 'owner-unverifiable'
        );
      },
    );
    fs.writeFileSync(first.snapshot.heartbeat, JSON.stringify(owner));
    installLockDependenciesForTesting.kill = () => {
      throw Object.assign(new Error('denied'), {code: 'EPERM'});
    };
    age(first.snapshot.heartbeat);
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('EPERM was interpreted as dead');
        },
        {...options, acquisitionTimeout: 0},
      ),
      error => {
        return (
          error instanceof InstallLockError &&
          error.reason === 'owner-unverifiable'
        );
      },
    );
  });

  it('permits a stalled foreign owner only after the configured hard maximum', async () => {
    const first = await hold();
    const owner = JSON.parse(fs.readFileSync(first.snapshot.heartbeat, 'utf8'));
    fs.writeFileSync(
      first.snapshot.heartbeat,
      JSON.stringify({...owner, hostname: `${os.hostname()}-remote`}),
    );
    age(first.snapshot.heartbeat);
    await withInstallLock(lockPath, async () => {}, {
      ...options,
      hardMaximum: 1000,
      acquisitionTimeout: 0,
    });
    const replacement = current();
    first.release();
    await first.promise;
    assert.strictEqual(current().generation, replacement.generation);
  });

  for (const state of ['empty', 'malformed', 'missing']) {
    it(`waits for fresh ${state} metadata and recovers it only when stale`, async () => {
      const first = await hold();
      if (state === 'missing') {
        fs.unlinkSync(first.snapshot.heartbeat);
      } else {
        fs.writeFileSync(
          first.snapshot.heartbeat,
          state === 'empty' ? '' : '{',
        );
      }
      await assert.rejects(
        withInstallLock(
          lockPath,
          async () => {
            assert.fail('fresh invalid metadata was claimed');
          },
          {...options, acquisitionTimeout: 0},
        ),
        error => {
          return (
            error instanceof InstallLockError &&
            error.reason === 'invalid-owner-metadata'
          );
        },
      );
      age(
        state === 'missing'
          ? first.snapshot.directory
          : first.snapshot.heartbeat,
      );
      await withInstallLock(lockPath, async () => {}, {
        ...options,
        acquisitionTimeout: 0,
      });
      assert.notStrictEqual(current().generation, first.snapshot.generation);
    });
  }

  it('revalidates a stale heartbeat that became fresh before the claim', async () => {
    const first = await hold();
    fs.writeFileSync(first.snapshot.heartbeat, '{');
    age(first.snapshot.heartbeat);
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('freshened state was claimed');
        },
        {
          ...options,
          acquisitionTimeout: 0,
          beforeStaleLockClaim: async () => {
            const now = new Date();
            fs.utimesSync(first.snapshot.heartbeat, now, now);
          },
        },
      ),
      InstallLockError,
    );
    assert.strictEqual(current().generation, first.snapshot.generation);
    assert.strictEqual(
      fs.readdirSync(path.join(lockPath, 'generations')).length,
      1,
    );
  });

  it('refreshes with utimes while keeping the owner bytes and inode unchanged', async () => {
    const refreshed = Promise.withResolvers<void>();
    const first = await hold({heartbeatInterval: 5});
    const bytes = fs.readFileSync(first.snapshot.heartbeat);
    const inode = fs.statSync(first.snapshot.heartbeat, {bigint: true}).ino;
    promises.utimes = async (...args) => {
      await originalUtimes(...args);
      refreshed.resolve();
    };
    syncBuiltinESMExports();
    await refreshed.promise;
    assert.deepStrictEqual(fs.readFileSync(first.snapshot.heartbeat), bytes);
    assert.strictEqual(
      fs.statSync(first.snapshot.heartbeat, {bigint: true}).ino,
      inode,
    );
  });

  it('does not reclaim a long task while its heartbeat keeps advancing', async () => {
    const first = await hold({heartbeatInterval: 5});
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('total task duration was used as hard ceiling');
        },
        {...options, hardMaximum: 100, acquisitionTimeout: 250},
      ),
      InstallLockError,
    );
    assert.strictEqual(current().generation, first.snapshot.generation);
  });

  it('keeps the task result when heartbeat refresh fails', async () => {
    const failed = Promise.withResolvers<void>();
    const logs: string[] = [];
    promises.utimes = async () => {
      failed.resolve();
      throw new Error('refresh failed');
    };
    syncBuiltinESMExports();
    const value = {};
    assert.strictEqual(
      await withInstallLock(
        lockPath,
        async () => {
          await failed.promise;
          return value;
        },
        {
          ...options,
          heartbeatInterval: 5,
          logger: message => {
            logs.push(String(message));
          },
        },
      ),
      value,
    );
    assert(
      logs.some(message => {
        return message.includes('refresh failed');
      }),
    );
  });

  for (const taskFails of [false, true]) {
    it(`preserves task ${taskFails ? 'error identity' : 'success identity'} when release fails`, async () => {
      promises.rename = async (source, target) => {
        if (path.basename(String(target)) === 'released') {
          throw new Error('release failed');
        }
        return await originalRename(source, target);
      };
      syncBuiltinESMExports();
      const logs: string[] = [];
      const primary = new Error('primary task failure');
      const value = {};
      const result = withInstallLock(
        lockPath,
        async () => {
          if (taskFails) {
            throw primary;
          }
          return value;
        },
        {
          ...options,
          logger: message => {
            logs.push(String(message));
          },
        },
      );
      if (taskFails) {
        await assert.rejects(result, error => {
          return error === primary;
        });
      } else {
        assert.strictEqual(await result, value);
      }
      assert(
        logs.some(message => {
          return message.includes('release failed');
        }),
      );
      assert.strictEqual(
        fs.readdirSync(current().directory).some(name => {
          return name.endsWith('.tmp');
        }),
        false,
      );
    });
  }

  it('preserves an acquisition error even when private claim cleanup fails', async () => {
    const primary = new Error('publication failed');
    const logs: string[] = [];
    let entered = false;
    installLockDependenciesForTesting.remove = async () => {
      throw new Error('cleanup failed');
    };
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          entered = true;
        },
        {
          ...options,
          logger: message => {
            logs.push(String(message));
          },
          beforeOwnerPublication: async () => {
            throw primary;
          },
        },
      ),
      error => {
        return error === primary;
      },
    );
    assert.strictEqual(entered, false);
    assert.strictEqual(fs.existsSync(path.join(lockPath, 'first')), false);
    assert.strictEqual(
      logs.filter(message => {
        return message.includes('cleanup failed');
      }).length,
      2,
    );
  });

  it('never starts the task after initial owner publication fails', async () => {
    const primary = new Error('owner rename failed');
    promises.rename = async (source, target) => {
      if (path.basename(String(target)) === 'heartbeat') {
        throw primary;
      }
      return await originalRename(source, target);
    };
    syncBuiltinESMExports();
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('task ran before owner publication');
        },
        options,
      ),
      error => {
        return error === primary;
      },
    );
    assert.deepStrictEqual(
      fs.readdirSync(path.join(lockPath, 'generations')),
      [],
    );
    assert.strictEqual(fs.existsSync(path.join(lockPath, 'first')), false);
  });
});
