/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {setTimeout as sleep} from 'node:timers/promises';

import {
  hasUsableBirthtime,
  compareInstallLockIdentities,
  InstallLockError,
  withInstallLock,
} from '../../lib/installLock.js';

describe('installLock', function () {
  let tmpDir = '/tmp/puppeteer-browsers-test';
  let lockPath = '';
  let lockParent = '';

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-browsers-test'));
    lockParent = path.join(tmpDir, 'chrome');
    lockPath = path.join(lockParent, '.installLock-linux-test');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {
      force: true,
      recursive: true,
      maxRetries: 10,
      retryDelay: 500,
    });
  });

  const defaultTestLockOptions = {
    acquisitionTimeout: 1000,
    heartbeatInterval: 1000,
    retryDelay: 1,
    staleThreshold: 10000,
  };
  const testLockOptions = {
    ...defaultTestLockOptions,
    warningLogger: () => {},
  };

  for (const taskFails of [false, true]) {
    it(`preserves task ${taskFails ? 'error' : 'result'} when cleanup and logging fail`, async () => {
      const primary = new Error('task failed');
      const result = {};
      let warning = '';
      const operation = withInstallLock(
        lockPath,
        async () => {
          if (taskFails) {
            throw primary;
          }
          return result;
        },
        {
          ...testLockOptions,
          filesystem: {
            rm: async (target, options) => {
              if (target === lockPath) {
                throw new Error('injected cleanup failure');
              }
              await fs.promises.rm(target, options);
            },
          },
          warningLogger: message => {
            warning = String(message);
            throw new Error('logger failed');
          },
        },
      );
      if (taskFails) {
        await assert.rejects(operation, error => {
          return error === primary;
        });
      } else {
        assert.strictEqual(await operation, result);
      }
      assert.ok(warning.includes(lockPath));
      assert.ok(warning.includes('injected cleanup failure'));
      assert.ok(fs.existsSync(lockPath));
    });
  }

  it('preserves initial heartbeat failure when cleanup fails', async () => {
    const primary = new Error('write failed');
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('must not start task');
        },
        {
          ...testLockOptions,
          filesystem: {
            writeFile: async () => {
              throw primary;
            },
            rm: async () => {
              throw new Error('cleanup failed');
            },
          },
        },
      ),
      error => {
        return error === primary;
      },
    );
  });

  it('publishes complete heartbeat JSON and retains it on refresh rename failure', async () => {
    const refreshFailed = Promise.withResolvers<void>();
    let publications = 0;
    let previous = '';
    await withInstallLock(
      lockPath,
      async () => {
        await refreshFailed.promise;
        assert.strictEqual(
          fs.readFileSync(path.join(lockPath, 'heartbeat'), 'utf8'),
          previous,
        );
      },
      {
        ...testLockOptions,
        heartbeatInterval: 5,
        filesystem: {
          rename: async (source, destination) => {
            const contents = await fs.promises.readFile(source, 'utf8');
            assert.deepStrictEqual(JSON.parse(contents), {
              hostname: os.hostname(),
              pid: process.pid,
            });
            publications++;
            if (publications > 1) {
              assert.strictEqual(
                await fs.promises.readFile(destination, 'utf8'),
                previous,
              );
              throw new Error('rename failed');
            }
            assert.strictEqual(fs.existsSync(destination), false);
            await fs.promises.rename(source, destination);
            previous = contents;
          },
        },
        warningLogger: () => {
          refreshFailed.resolve();
        },
      },
    );
    assert.ok(publications >= 2);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  function writeStaleHeartbeat(contents: string): string {
    fs.mkdirSync(lockPath, {recursive: true});
    const heartbeatPath = path.join(lockPath, 'heartbeat');
    fs.writeFileSync(heartbeatPath, contents);
    const staleTime = new Date(Date.now() - 20000);
    fs.utimesSync(heartbeatPath, staleTime, staleTime);
    return heartbeatPath;
  }

  function writeStaleOwnerHeartbeat(
    pid: number,
    hostname = os.hostname(),
  ): string {
    return writeStaleHeartbeat(`${JSON.stringify({hostname, pid})}\n`);
  }

  it('keeps a claimed lock usable when reaper cleanup and logging fail', async () => {
    writeStaleOwnerHeartbeat(await exitedProcessPid());
    let warned = false;
    const result = await withInstallLock(
      lockPath,
      async () => {
        assert.ok(warned);
        return 42;
      },
      {
        ...testLockOptions,
        filesystem: {
          rm: async (target, options) => {
            if (target === path.join(lockPath, 'reaper')) {
              throw new Error('reaper cleanup failed');
            }
            await fs.promises.rm(target, options);
          },
        },
        warningLogger: () => {
          warned = true;
          throw new Error('logger failed');
        },
      },
    );
    assert.strictEqual(result, 42);
    assert.strictEqual(fs.existsSync(lockPath), false);
  });

  it('retains the primary claim error when reaper cleanup fails', async () => {
    writeStaleOwnerHeartbeat(await exitedProcessPid());
    const previous = fs.readFileSync(path.join(lockPath, 'heartbeat'), 'utf8');
    const primary = new Error('heartbeat publish failed');
    await assert.rejects(
      withInstallLock(
        lockPath,
        async () => {
          assert.fail('must not enter task');
        },
        {
          ...testLockOptions,
          filesystem: {
            rename: async () => {
              throw primary;
            },
            rm: async (target, options) => {
              if (target === path.join(lockPath, 'reaper')) {
                throw new Error('reaper cleanup failed');
              }
              await fs.promises.rm(target, options);
            },
          },
        },
      ),
      error => {
        return error === primary;
      },
    );
    assert.strictEqual(
      fs.readFileSync(path.join(lockPath, 'heartbeat'), 'utf8'),
      previous,
    );
  });

  function requireStableDirectoryBirthtime(context: Mocha.Context): void {
    const before = fs.statSync(lockPath, {bigint: true});
    const probePath = path.join(lockPath, 'birthtime-probe');
    fs.mkdirSync(probePath);
    fs.rmSync(probePath, {recursive: true});
    const after = fs.statSync(lockPath, {bigint: true});
    if (
      !hasUsableBirthtime(before) ||
      compareInstallLockIdentities(before, after) !== 'same'
    ) {
      context.skip();
    }
  }

  async function exitedProcessPid(): Promise<number> {
    const child = spawn(process.execPath, ['-e', ''], {
      stdio: 'ignore',
      windowsHide: true,
    });
    const exited = once(child, 'exit');
    const pid = child.pid;
    assert.ok(pid);
    await exited;
    return pid;
  }

  it('waits without claiming while a stale lock owner is still alive', async () => {
    writeStaleOwnerHeartbeat(process.pid);
    let lockEntered = false;
    let warningCount = 0;
    const warningObserved = Promise.withResolvers<void>();

    const lock = withInstallLock(
      lockPath,
      async () => {
        lockEntered = true;
      },
      {
        ...testLockOptions,
        warningLogger: () => {
          warningCount++;
          warningObserved.resolve();
        },
      },
    );

    try {
      await warningObserved.promise;
      await sleep(20);
      assert.strictEqual(lockEntered, false);
      assert.strictEqual(fs.existsSync(lockPath), true);
      assert.strictEqual(warningCount, 1);
    } finally {
      fs.rmSync(lockPath, {recursive: true, force: true});
      await lock;
    }

    assert.strictEqual(lockEntered, true);
    assert.strictEqual(warningCount, 1);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('times out without claiming a stale lock owned by a live process', async () => {
    writeStaleOwnerHeartbeat(process.pid);
    let lockEntered = false;
    let warningCount = 0;

    const lock = withInstallLock(
      lockPath,
      async () => {
        lockEntered = true;
      },
      {
        ...testLockOptions,
        acquisitionTimeout: 10,
        warningLogger: () => {
          warningCount++;
        },
      },
    );

    await assert.rejects(lock, error => {
      assert(error instanceof InstallLockError);
      assert.strictEqual(error.lockPath, lockPath);
      assert.strictEqual(error.reason, 'owner-alive');
      assert.deepStrictEqual(error.owner, {
        hostname: os.hostname(),
        pid: process.pid,
      });
      assert.ok(error.observedAgeMs! >= 10000);
      assert.ok(error.waitedMs >= 10);
      return true;
    });

    assert.strictEqual(lockEntered, false);
    assert.strictEqual(warningCount, 1);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('times out on fresh contention without inspecting malformed metadata', async () => {
    fs.mkdirSync(lockPath, {recursive: true});
    fs.writeFileSync(path.join(lockPath, 'heartbeat'), '{');
    let lockEntered = false;
    let debugCount = 0;
    let warningCount = 0;

    const lock = withInstallLock(
      lockPath,
      async () => {
        lockEntered = true;
      },
      {
        ...testLockOptions,
        acquisitionTimeout: 0,
        logger: () => {
          debugCount++;
        },
        warningLogger: () => {
          warningCount++;
        },
      },
    );

    await assert.rejects(lock, error => {
      assert(error instanceof InstallLockError);
      assert.strictEqual(error.reason, undefined);
      assert.strictEqual(error.owner, undefined);
      assert.strictEqual(error.observedAgeMs, undefined);
      return true;
    });

    assert.strictEqual(lockEntered, false);
    assert.strictEqual(warningCount, 0);
    assert.strictEqual(debugCount, 1);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('times out instead of claiming stale locks owned on another host', async () => {
    const remoteHostname = `${os.hostname()}-remote`;
    writeStaleOwnerHeartbeat(process.pid, remoteHostname);
    let lockEntered = false;
    let warningCount = 0;

    const lock = withInstallLock(
      lockPath,
      async () => {
        lockEntered = true;
      },
      {
        ...testLockOptions,
        acquisitionTimeout: 0,
        warningLogger: () => {
          warningCount++;
        },
      },
    );

    await assert.rejects(lock, error => {
      assert(error instanceof InstallLockError);
      assert.strictEqual(error.reason, 'owner-unverifiable');
      assert.deepStrictEqual(error.owner, {
        hostname: remoteHostname,
        pid: process.pid,
      });
      return true;
    });

    assert.strictEqual(lockEntered, false);
    assert.strictEqual(warningCount, 1);
    assert.strictEqual(fs.existsSync(lockPath), true);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('fails with console warning fallback for invalid owner metadata', async () => {
    const originalWarn = console.warn;
    try {
      for (const contents of [
        '{',
        JSON.stringify({hostname: os.hostname(), pid: 0}),
      ]) {
        writeStaleHeartbeat(contents);
        let lockEntered = false;
        let warningCount = 0;
        console.warn = () => {
          warningCount++;
        };
        const lock = withInstallLock(
          lockPath,
          async () => {
            lockEntered = true;
          },
          {
            ...defaultTestLockOptions,
            acquisitionTimeout: 0,
          },
        );

        await assert.rejects(lock, error => {
          assert(error instanceof InstallLockError);
          assert.strictEqual(error.reason, 'invalid-owner-metadata');
          assert.strictEqual(error.owner, undefined);
          return true;
        });
        assert.strictEqual(lockEntered, false);
        assert.strictEqual(warningCount, 1);
        fs.rmSync(lockPath, {recursive: true, force: true});
      }
    } finally {
      console.warn = originalWarn;
    }
  });

  it('claims a safely recoverable lock before checking the timeout', async () => {
    const heartbeatPath = writeStaleOwnerHeartbeat(await exitedProcessPid());

    await withInstallLock(
      lockPath,
      async () => {
        assert.deepStrictEqual(
          JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')),
          {
            hostname: os.hostname(),
            pid: process.pid,
          },
        );
      },
      {...testLockOptions, acquisitionTimeout: 0},
    );

    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('classifies heartbeat-less lock identities conservatively', () => {
    const identity = {
      dev: 1n,
      ino: 2n,
      birthtimeNs: 3n,
    };

    assert.strictEqual(hasUsableBirthtime(identity), true);
    assert.strictEqual(
      hasUsableBirthtime({...identity, birthtimeNs: 0n}),
      false,
    );
    assert.strictEqual(
      compareInstallLockIdentities(identity, identity),
      'same',
    );
    assert.strictEqual(
      compareInstallLockIdentities(identity, {...identity, ino: 4n}),
      'recreated',
    );
    assert.strictEqual(
      compareInstallLockIdentities(identity, {...identity, birthtimeNs: 4n}),
      'unstable',
    );
  });

  it('uses the stale threshold for lock directories without heartbeat files', async function () {
    fs.mkdirSync(lockPath, {recursive: true});
    requireStableDirectoryBirthtime(this);
    const heartbeatPath = path.join(lockPath, 'heartbeat');
    const staleTime = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    await withInstallLock(
      lockPath,
      async () => {
        assert.ok(fs.existsSync(heartbeatPath));
        assert.ok(fs.statSync(heartbeatPath).mtimeMs > staleTime.getTime());
      },
      testLockOptions,
    );

    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('uses the stale threshold for reaper directories left behind', async () => {
    const heartbeatPath = writeStaleOwnerHeartbeat(await exitedProcessPid());
    const reaperPath = path.join(lockPath, 'reaper');
    fs.mkdirSync(reaperPath);
    const staleTime = new Date(Date.now() - 20000);
    fs.utimesSync(reaperPath, staleTime, staleTime);

    await withInstallLock(
      lockPath,
      async () => {
        assert.strictEqual(fs.existsSync(reaperPath), false);
        assert.ok(fs.statSync(heartbeatPath).mtimeMs > staleTime.getTime());
      },
      testLockOptions,
    );

    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('serializes concurrent stale lock recovery', async () => {
    writeStaleOwnerHeartbeat(await exitedProcessPid());
    let activeTasks = 0;
    let maxActiveTasks = 0;

    await Promise.all(
      Array.from({length: 2}, () => {
        return withInstallLock(
          lockPath,
          async () => {
            activeTasks++;
            maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
            await sleep(10);
            activeTasks--;
          },
          testLockOptions,
        );
      }),
    );

    assert.strictEqual(maxActiveTasks, 1);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('revalidates heartbeat-less stale locks after acquiring the reaper', async function () {
    fs.mkdirSync(lockPath, {recursive: true});
    requireStableDirectoryBirthtime(this);
    const staleTime = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, staleTime, staleTime);

    const bothObservedStaleLock = Promise.withResolvers<void>();
    const firstTaskEntered = Promise.withResolvers<void>();
    const releaseFirstTask = Promise.withResolvers<void>();
    const firstLockFinished = Promise.withResolvers<void>();
    const secondTaskEntered = Promise.withResolvers<void>();
    let staleLockObservations = 0;
    let activeTasks = 0;
    let maxActiveTasks = 0;

    const waitUntilBothObservedStaleLock = async () => {
      staleLockObservations++;
      if (staleLockObservations === 2) {
        bothObservedStaleLock.resolve();
      }
      await bothObservedStaleLock.promise;
    };

    const firstLock = withInstallLock(
      lockPath,
      async () => {
        activeTasks++;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        firstTaskEntered.resolve();
        await releaseFirstTask.promise;
        activeTasks--;
      },
      {
        ...testLockOptions,
        beforeStaleLockClaim: waitUntilBothObservedStaleLock,
      },
    );
    void firstLock.then(firstLockFinished.resolve, firstLockFinished.resolve);
    const secondLock = withInstallLock(
      lockPath,
      async () => {
        activeTasks++;
        maxActiveTasks = Math.max(maxActiveTasks, activeTasks);
        secondTaskEntered.resolve();
        await firstLockFinished.promise;
        activeTasks--;
      },
      {
        ...testLockOptions,
        beforeStaleLockClaim: async () => {
          await waitUntilBothObservedStaleLock();
          await firstTaskEntered.promise;
        },
      },
    );

    await firstTaskEntered.promise;
    const secondEnteredWhileFirstWasActive = await Promise.race([
      secondTaskEntered.promise.then(() => {
        return true;
      }),
      sleep(100).then(() => {
        return false;
      }),
    ]);
    releaseFirstTask.resolve();
    await Promise.all([firstLock, secondLock]);

    assert.strictEqual(secondEnteredWhileFirstWasActive, false);
    assert.strictEqual(maxActiveTasks, 1);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });

  it('does not claim a recreated heartbeat-less lock using stale stats', async function () {
    fs.mkdirSync(lockPath, {recursive: true});
    requireStableDirectoryBirthtime(this);
    const staleTime = new Date(Date.now() - 20000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    const lockRecreated = Promise.withResolvers<void>();
    let taskEntered = false;
    let recreatedLock = false;

    const lock = withInstallLock(
      lockPath,
      async () => {
        taskEntered = true;
      },
      {
        ...testLockOptions,
        beforeStaleLockClaim: async () => {
          if (recreatedLock) {
            return;
          }
          recreatedLock = true;
          fs.rmSync(lockPath, {recursive: true});
          fs.mkdirSync(lockPath);
          lockRecreated.resolve();
        },
      },
    );

    await lockRecreated.promise;
    await sleep(100);
    assert.strictEqual(taskEntered, false);

    fs.rmSync(lockPath, {recursive: true});
    await lock;

    assert.strictEqual(taskEntered, true);
    assert.strictEqual(fs.existsSync(lockPath), false);
    assert.strictEqual(fs.existsSync(lockParent), true);
  });
});
