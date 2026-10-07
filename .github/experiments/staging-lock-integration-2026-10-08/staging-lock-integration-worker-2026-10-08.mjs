/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import syncFs from 'node:fs';
import {spawn} from 'node:child_process';
import path from 'node:path';
import {syncBuiltinESMExports} from 'node:module';
import {pathToFileURL} from 'node:url';

const pending = new Map();
const released = new Set();
let configuration;

function send(event, data = {}) {
  process.send?.({event, ...data});
}

async function gate(name) {
  send(name);
  if (released.has(name)) {
    return;
  }
  const deferred = Promise.withResolvers();
  pending.set(name, deferred);
  await deferred.promise;
}

process.on('message', message => {
  if (message.command === 'release') {
    released.add(message.name);
    pending.get(message.name)?.resolve();
  } else if (message.command === 'start') {
    configuration = message.configuration;
    void run().catch(error => {
      send('fatal', {error: describeError(error)});
      process.exitCode = 1;
      process.disconnect();
    });
  }
});

function describeError(error) {
  return {
    name: error?.name,
    message: error?.message ?? String(error),
    code: error?.code,
    reason: error?.reason,
    waitedMs: error?.waitedMs,
    cause: error?.cause ? describeError(error.cause) : undefined,
  };
}

async function run() {
  const config = configuration;
  const lib = path.join(config.repo, 'packages/browsers/lib');
  const load = async name => {
    return await import(pathToFileURL(path.join(lib, name)).href);
  };
  const {install, installLockForTesting} = await load('install.js');
  const {Cache} = await load('Cache.js');
  const {internalConstantsForTesting: stagingDependencies} =
    await load('installStaging.js');
  const originalLink = stagingDependencies.link;
  stagingDependencies.link = async (...args) => {
    if (config.beforeArchivePublish) await gate('archivePublishHeld');
    return await originalLink(...args);
  };
  let lock = await load('installLock.js');
  if (config.mode === 'baseline') {
    try {
      lock = await load('installLockBaseline.js');
    } catch (error) {
      if (error.code !== 'ERR_MODULE_NOT_FOUND') {
        throw error;
      }
    }
  }
  const originalRename = fs.rename;
  const originalRenameSync = syncFs.renameSync;
  syncFs.renameSync = (source, target) => {
    if (config.failMetadata && path.basename(String(target)) === '.metadata') {
      throw new Error('RESEARCH_METADATA_FAILURE');
    }
    return originalRenameSync(source, target);
  };
  fs.rename = async (source, target) => {
    if (
      config.beforeClaimRename &&
      ['first', 'next'].includes(path.basename(String(target)))
    ) {
      await gate('claimRenameHeld');
    }
    if (config.failOwner && path.basename(String(target)) === 'heartbeat') {
      throw new Error('RESEARCH_OWNER_PUBLICATION_FAILURE');
    }
    if (config.failRelease && path.basename(String(target)) === 'released') {
      throw new Error('RESEARCH_RELEASE_FAILURE');
    }
    if (String(source).endsWith(`${path.sep}output`)) {
      send('beforePublish', {source, target});
      if (config.helper) {
        const control = path.join(config.cache, 'helper-resume');
        const done = path.join(config.cache, 'helper-done.json');
        const helper = spawn(
          process.execPath,
          [
            '-e',
            `
          const fs = require('node:fs');
          const [control, target, done] = process.argv.slice(1);
          const interval = setInterval(() => {
            if (!fs.existsSync(control)) return;
            fs.writeFileSync(target, 'old-helper-resumed\\n');
            fs.writeFileSync(done, JSON.stringify({pid: process.pid, target}));
            clearInterval(interval);
          }, 10);
          setTimeout(() => process.exit(2), 15000).unref();
        `,
            control,
            path.join(source, 'identity.txt'),
            done,
          ],
          {stdio: 'ignore', windowsHide: true},
        );
        send('helperStarted', {
          helperPid: helper.pid,
          control,
          done,
          target: path.join(source, 'identity.txt'),
        });
      }
      if (config.beforePublish) {
        await gate('publishHeld');
      }
    }
    return await originalRename(source, target);
  };
  const originalWriteFile = fs.writeFile;
  const originalUtimes = fs.utimes;
  let heartbeatWrites = 0;
  const holdHeartbeat = async target => {
    if (path.basename(String(target)) !== 'heartbeat') {
      return;
    }
    heartbeatWrites++;
    // Baseline initially writeFiles its heartbeat; the generation candidate
    // only calls utimes after atomic publication of the owner record.
    const refresh = config.mode === 'baseline' ? heartbeatWrites > 1 : true;
    if (config.delayHeartbeat && refresh) {
      await gate('heartbeatHeld');
    }
  };
  fs.writeFile = async (...args) => {
    await holdHeartbeat(args[0]);
    return await originalWriteFile(...args);
  };
  fs.utimes = async (...args) => {
    await holdHeartbeat(args[0]);
    if (config.failRefresh) {
      throw new Error('RESEARCH_REFRESH_FAILURE');
    }
    return await originalUtimes(...args);
  };
  syncBuiltinESMExports();

  installLockForTesting.withInstallLock = async (lockPath, task, options) => {
    const execute = async () => {
      send('entered', {lockPath});
      const value = await task();
      const cache = new Cache(config.cache);
      send('taskComplete', {
        value:
          typeof value === 'string'
            ? value
            : {
                path: value.path,
                executablePath: value.executablePath,
              },
        installations: (typeof value === 'string'
          ? []
          : cache.getInstalledBrowsers()
        ).map(browser => {
          return {platform: browser.platform, buildId: browser.buildId};
        }),
      });
      if (config.afterTask) {
        await gate('releaseHeld');
      }
      return value;
    };
    if (config.mode === 'none') {
      return await execute();
    }
    return await lock.withInstallLock(lockPath, execute, {
      ...options,
      ...config.lockOptions,
      beforeStaleLockClaim: async () => {
        send('beforeClaim');
        if (config.beforeClaim) {
          await gate('claimHeld');
        }
      },
      beforeOwnerPublication: async () => {
        if (config.beforeOwnerPublication) await gate('ownerPublicationHeld');
      },
    });
  };

  const provider = (route, executable) => {
    return {
      supports: () => {
        return true;
      },
      getDownloadUrl: () => {
        return new URL(route, config.server);
      },
      getExecutablePath: () => {
        return executable;
      },
      getName: () => {
        return `Research-${route}`;
      },
    };
  };
  const providers = config.defaultProvider
    ? []
    : [
        ...(config.fallback ? [provider('/invalid/test.zip', 'missing')] : []),
        provider(config.route, config.executable),
      ];
  send('ready');
  try {
    const result = await install({
      browser: 'chrome',
      platform: 'linux',
      buildId: config.buildId ?? '123',
      cacheDir: config.cache,
      unpack: config.unpack ?? true,
      buildIdAlias: config.alias,
      providers,
      baseUrl: config.server,
      logger: () => {
        return message => {
          send('log', {message});
          if (message.startsWith('Installing ')) {
            send('extract', {message});
          }
          if (message.startsWith('Waiting for browser install lock')) {
            send('contended');
          }
          if (message.includes('RESEARCH_REFRESH_FAILURE'))
            send('refreshFailed');
        };
      },
    });
    send('done', {
      status: 'success',
      value:
        typeof result === 'string'
          ? result
          : {
              path: result.path,
              executablePath: result.executablePath,
            },
    });
  } catch (error) {
    send('done', {status: 'error', error: describeError(error)});
  } finally {
    fs.rename = originalRename;
    stagingDependencies.link = originalLink;
    syncFs.renameSync = originalRenameSync;
    fs.writeFile = originalWriteFile;
    fs.utimes = originalUtimes;
    syncBuiltinESMExports();
    process.disconnect();
  }
}
