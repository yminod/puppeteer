/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {fork, execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const repo =
  process.env.PUPPETEER_RESEARCH_REPO ??
  process.argv.find(arg => arg.startsWith('--repo='))?.slice(7);
assert(
  repo && path.isAbsolute(repo),
  'Set an absolute PUPPETEER_RESEARCH_REPO',
);
const mode =
  process.argv.find(arg => arg.startsWith('--mode='))?.slice(7) ?? 'generation';
const selected = process.argv
  .find(arg => arg.startsWith('--cases='))
  ?.slice(8)
  .split(',') ?? ['C0'];
const root = path.resolve(import.meta.dirname, '../../..');
const outputRoot =
  process.env.PUPPETEER_RESEARCH_OUTPUT ??
  path.join(root, '.local/staging-lock-integration-2026-10-08');
fs.mkdirSync(outputRoot, {recursive: true});
const output = fs.mkdtempSync(path.join(outputRoot, `${mode}-`));
const events = [];
const results = [];
const children = [];
const requests = [];
const routes = new Map();
const helpers = [];
const crcTable = Array.from({length: 256}, (_, value) => {
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, content] of Object.entries(files)) {
    const filename = Buffer.from(name);
    const bytes = Buffer.from(content);
    let crc = 0xffffffff;
    for (const byte of bytes) {
      crc = crcTable[(crc ^ byte) & 255] ^ (crc >>> 8);
    }
    crc = (crc ^ 0xffffffff) >>> 0;
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50, 0);
    header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14);
    header.writeUInt32LE(bytes.length, 18);
    header.writeUInt32LE(bytes.length, 22);
    header.writeUInt16LE(filename.length, 26);
    local.push(header, filename, bytes);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50, 0);
    directory.writeUInt16LE(0x0314, 4);
    directory.writeUInt16LE(20, 6);
    directory.writeUInt32LE(crc, 16);
    directory.writeUInt32LE(bytes.length, 20);
    directory.writeUInt32LE(bytes.length, 24);
    directory.writeUInt16LE(filename.length, 28);
    directory.writeUInt32LE((0o100755 << 16) >>> 0, 38);
    directory.writeUInt32LE(offset, 42);
    central.push(directory, filename);
    offset += header.length + filename.length + bytes.length;
  }
  const index = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(Object.keys(files).length, 8);
  end.writeUInt16LE(Object.keys(files).length, 10);
  end.writeUInt32LE(index.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, index, end]);
}

for (const role of ['old', 'new', 'third']) {
  routes.set(
    `/${role}/test.zip`,
    zip({
      [`browser/${role}-chrome`]: `executable-${role}\n`,
      'identity.txt': `payload-${role}\n`,
    }),
  );
}
routes.set('/invalid/test.zip', Buffer.from('invalid zip'));
routes.set('/stream/test.zip', routes.get('/old/test.zip'));
routes.set(
  '/123/linux64/chrome-linux64.zip',
  zip({
    'chrome-linux64/chrome': 'default-executable\n',
    'identity.txt': 'default-provider\n',
  }),
);
let serverUrl;
const server = http.createServer((request, response) => {
  requests.push({at: performance.now(), url: request.url});
  events.push({event: 'request', at: performance.now(), url: request.url});
  const archive = routes.get(request.url);
  if (!archive) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {'content-length': archive.length});
  if (request.url === '/stream/test.zip') {
    response.write(archive.subarray(0, Math.floor(archive.length / 2)));
    events.push({event: 'streamHeld', at: performance.now()});
    return;
  }
  response.end(archive);
});

function worker(role, cache, overrides = {}) {
  const child = fork(
    path.join(
      import.meta.dirname,
      'staging-lock-integration-worker-2026-10-08.mjs',
    ),
    [],
    {
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    },
  );
  const messages = [];
  const waiters = [];
  let stdout = '';
  let stderr = '';
  let exited = false;
  const exit = Promise.withResolvers();
  child.stdout.on('data', bytes => {
    stdout += bytes;
  });
  child.stderr.on('data', bytes => {
    stderr += bytes;
  });
  child.on('message', message => {
    if (message.event === 'helperStarted') helpers.push(message);
    const event = {...message, role, pid: child.pid, at: performance.now()};
    messages.push(event);
    events.push(event);
    for (const waiter of [...waiters]) {
      if (waiter.event === message.event || message.event === 'fatal') {
        clearTimeout(waiter.timer);
        waiters.splice(waiters.indexOf(waiter), 1);
        message.event === 'fatal'
          ? waiter.reject(new Error(JSON.stringify(message)))
          : waiter.resolve(event);
      }
    }
  });
  child.on('error', error => {
    exit.reject(error);
  });
  child.on('exit', (code, signal) => {
    exited = true;
    fs.writeFileSync(
      path.join(output, `${children.indexOf(controller)}-${role}.stdout.log`),
      stdout,
    );
    fs.writeFileSync(
      path.join(output, `${children.indexOf(controller)}-${role}.stderr.log`),
      stderr,
    );
    for (const waiter of waiters) {
      clearTimeout(waiter.timer);
      waiter.reject(
        new Error(`${role} exited before ${waiter.event}: ${code}/${signal}`),
      );
    }
    exit.resolve({code, signal});
  });
  const controller = {
    child,
    messages,
    exit: exit.promise,
    wait(event, timeout = 10000) {
      const existing = messages.find(message => message.event === event);
      if (existing) return Promise.resolve(existing);
      if (exited)
        return Promise.reject(
          new Error(`${role} already exited before ${event}`),
        );
      return new Promise((resolve, reject) => {
        const waiter = {event, resolve, reject};
        waiter.timer = setTimeout(() => {
          waiters.splice(waiters.indexOf(waiter), 1);
          reject(new Error(`Timed out waiting for ${role}/${event}`));
        }, timeout);
        waiters.push(waiter);
      });
    },
    release(name) {
      if (child.connected) child.send({command: 'release', name});
    },
    async stop() {
      if (!exited) child.kill();
      return await exit.promise;
    },
  };
  children.push(controller);
  child.send({
    command: 'start',
    configuration: {
      repo,
      cache,
      mode,
      server: serverUrl,
      route: `/${role}/test.zip`,
      executable: `browser/${role}-chrome`,
      lockOptions: {
        retryDelay: 10,
        heartbeatInterval: 50,
        staleThreshold: 1000,
        acquisitionTimeout: 5000,
      },
      ...overrides,
    },
  });
  return controller;
}

async function finished(controller) {
  const done = await controller.wait('done');
  const exit = await controller.exit;
  assert.equal(exit.code, 0);
  assert.equal(done.status, 'success', JSON.stringify(done.error));
  return done;
}

function cache(name) {
  const directory = path.join(output, `cache-${name}`);
  fs.mkdirSync(directory);
  return directory;
}

function tree(directory) {
  const entries = [];
  const visit = (relative = '') => {
    const absolute = path.join(directory, relative);
    const stat = fs.lstatSync(absolute);
    if (stat.isDirectory()) {
      for (const child of fs.readdirSync(absolute).sort()) {
        visit(path.join(relative, child));
      }
    } else if (stat.isSymbolicLink()) {
      entries.push({path: relative, symlink: fs.readlinkSync(absolute)});
    } else {
      entries.push({
        path: relative,
        size: stat.size,
        sha256: createHash('sha256')
          .update(fs.readFileSync(absolute))
          .digest('hex'),
      });
    }
  };
  visit();
  return entries;
}

async function runCase(id, title, task) {
  const start = performance.now();
  try {
    const observation = await task();
    results.push({
      id,
      title,
      status: 'pass',
      durationMs: performance.now() - start,
      observation,
    });
    console.log(`${id}: PASS ${title}`);
  } catch (error) {
    results.push({
      id,
      title,
      status: 'fail',
      durationMs: performance.now() - start,
      error: {message: error.message, stack: error.stack},
    });
    console.log(`${id}: FAIL ${error.message}`);
    throw error;
  }
}

async function c0() {
  await runCase(
    'C0.same',
    'same target serializes; the loser uses the winner marker',
    async () => {
      const directory = cache('same');
      const initialRequests = requests.length;
      const first = worker('old', directory, {beforePublish: true});
      await first.wait('publishHeld');
      const second = worker('new', directory, {beforePublish: mode === 'none'});
      if (mode !== 'none') {
        await second.wait('contended');
        assert.equal(requests.length - initialRequests, 1);
        assert.equal(
          second.messages.some(message => message.event === 'entered'),
          false,
        );
      } else {
        await second.wait('publishHeld');
      }
      first.release('publishHeld');
      if (mode === 'none') {
        await finished(first);
        second.release('publishHeld');
      }
      const [winner, loser] = await Promise.all([
        finished(first),
        finished(second),
      ]);
      assert.deepEqual(loser.value, winner.value);
      assert.equal(requests.length - initialRequests, mode === 'none' ? 2 : 1);
      assert.equal(
        [...first.messages, ...second.messages].filter(
          message => message.event === 'extract',
        ).length,
        mode === 'none' ? 2 : 1,
      );
      const contents = tree(winner.value.path);
      const marker = JSON.parse(
        fs.readFileSync(
          path.join(winner.value.path, '.puppeteer-install'),
          'utf8',
        ),
      );
      assert.equal(marker.relativeExecutablePath, 'browser/old-chrome');
      assert.deepEqual(
        fs.readdirSync(path.join(directory, 'chrome/.staging')),
        [],
      );
      const hitStart = performance.now();
      const hit = await finished(worker('third', directory));
      const hitMs = performance.now() - hitStart;
      assert.deepEqual(hit.value, winner.value);
      assert.equal(requests.length - initialRequests, mode === 'none' ? 2 : 1);
      assert.deepEqual(tree(hit.value.path), contents);
      const metadata = JSON.parse(
        fs.readFileSync(path.join(directory, 'chrome/.metadata'), 'utf8'),
      );
      assert.equal(metadata.executablePaths['linux-123'], 'browser/old-chrome');
      return {
        requests: requests.length - initialRequests,
        cacheHitWorkerMs: hitMs,
        marker,
        contents,
      };
    },
  );
  await runCase(
    'C0.separate',
    'different builds can both extract while the other task holds its lock',
    async () => {
      const directory = cache('separate');
      const first = worker('old', directory, {beforePublish: true});
      await first.wait('publishHeld');
      const second = worker('new', directory, {
        beforePublish: true,
        buildId: '456',
      });
      await second.wait('publishHeld');
      first.release('publishHeld');
      second.release('publishHeld');
      const completed = await Promise.all([finished(first), finished(second)]);
      assert.notEqual(completed[0].value.path, completed[1].value.path);
      assert.equal(
        fs.readFileSync(
          path.join(completed[0].value.path, 'identity.txt'),
          'utf8',
        ),
        'payload-old\n',
      );
      assert.equal(
        fs.readFileSync(
          path.join(completed[1].value.path, 'identity.txt'),
          'utf8',
        ),
        'payload-new\n',
      );
      return {
        paths: completed.map(result => result.value.path),
        globalMetadataLostUpdateNotExcluded: true,
      };
    },
  );
  await runCase(
    'C0.archive',
    'archive-only installs serialize and preserve complete bytes',
    async () => {
      const directory = cache('archive');
      const initialRequests = requests.length;
      const first = worker('old', directory, {
        unpack: false,
        afterTask: true,
      });
      await first.wait('releaseHeld');
      const second = worker('new', directory, {unpack: false});
      if (mode !== 'none') await second.wait('contended');
      assert.equal(requests.length - initialRequests, 1);
      first.release('releaseHeld');
      const completed = await Promise.all([finished(first), finished(second)]);
      assert.equal(completed[0].value, completed[1].value);
      assert.deepEqual(
        fs.readFileSync(completed[0].value),
        routes.get('/old/test.zip'),
      );
      assert.equal(requests.length - initialRequests, 1);
      return {
        requests: 1,
        archiveSha256: createHash('sha256')
          .update(fs.readFileSync(completed[0].value))
          .digest('hex'),
      };
    },
  );
  await runCase(
    'C0.default',
    'default provider and alias follow the completed installation',
    async () => {
      const directory = cache('default');
      const completed = await finished(
        worker('old', directory, {defaultProvider: true, alias: 'latest'}),
      );
      assert.equal(
        fs.readFileSync(completed.value.executablePath, 'utf8'),
        'default-executable\n',
      );
      const metadata = JSON.parse(
        fs.readFileSync(path.join(directory, 'chrome/.metadata'), 'utf8'),
      );
      assert.equal(metadata.aliases.latest, '123');
      assert.equal(metadata.executablePaths?.['linux-123'], undefined);
      return {metadata, contents: tree(completed.value.path)};
    },
  );
  await runCase(
    'C0.fallback',
    'invalid ZIP falls back within the same install lock',
    async () => {
      const directory = cache('fallback');
      const completed = await finished(
        worker('old', directory, {fallback: true}),
      );
      assert.equal(
        fs.readFileSync(completed.value.executablePath, 'utf8'),
        'executable-old\n',
      );
      assert.deepEqual(
        fs.readdirSync(path.join(directory, 'chrome/.staging')),
        [],
      );
      return {contents: tree(completed.value.path)};
    },
  );
}

function lockSnapshot(lockPath) {
  if (!fs.existsSync(lockPath)) return;
  const directHeartbeat = path.join(lockPath, 'heartbeat');
  if (fs.existsSync(directHeartbeat)) {
    const stat = fs.statSync(directHeartbeat, {bigint: true});
    return {
      owner: JSON.parse(fs.readFileSync(directHeartbeat, 'utf8')),
      inode: String(stat.ino),
      heartbeatPath: directHeartbeat,
    };
  }
  const pointer = JSON.parse(
    fs.readFileSync(path.join(lockPath, 'first/identity'), 'utf8'),
  );
  let generation = pointer.generation;
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
  const heartbeatPath = path.join(
    lockPath,
    'generations',
    generation,
    'heartbeat',
  );
  const stat = fs.statSync(heartbeatPath, {bigint: true});
  return {
    generation,
    owner: JSON.parse(fs.readFileSync(heartbeatPath, 'utf8')),
    inode: String(stat.ino),
    heartbeatPath,
  };
}

async function waitFor(predicate, description) {
  const started = performance.now();
  while (!predicate()) {
    assert(
      performance.now() - started < 10000,
      `Timed out waiting for ${description}`,
    );
    await new Promise(resolve => {
      setTimeout(resolve, 10);
    });
  }
}

async function c1() {
  for (const helper of [false, true]) {
    await runCase(
      helper ? 'C1.helper' : 'C1',
      'fresh dead owner; private helper work cannot affect the replacement',
      async () => {
        const directory = cache(helper ? 'dead-helper' : 'dead');
        const first = worker('old', directory, {
          beforePublish: true,
          helper,
          lockOptions: {
            retryDelay: 10,
            heartbeatInterval: 20,
            staleThreshold: 60000,
            acquisitionTimeout: 1000,
          },
        });
        await first.wait('publishHeld');
        const helperRecord = helper
          ? await first.wait('helperStarted')
          : undefined;
        const oldSnapshot = lockSnapshot(
          (await first.wait('entered')).lockPath,
        );
        await first.stop();
        const diedAt = performance.now();
        if (helperRecord)
          assert.doesNotThrow(() => {
            process.kill(helperRecord.helperPid, 0);
          });
        const next = worker('new', directory, {
          lockOptions: {
            retryDelay: 10,
            heartbeatInterval: 20,
            staleThreshold: 60000,
            acquisitionTimeout: 250,
          },
        });
        const done = await next.wait('done');
        await next.exit;
        if (mode === 'baseline') {
          assert.equal(done.status, 'error');
          assert.equal(
            next.messages.some(message => message.event === 'entered'),
            false,
          );
        } else {
          assert.equal(done.status, 'success', JSON.stringify(done.error));
          const entered = await next.wait('entered');
          assert(entered.at - diedAt < 60000);
          const before = tree(done.value.path);
          if (helperRecord) {
            fs.writeFileSync(helperRecord.control, 'resume');
            await waitFor(() => {
              return fs.existsSync(helperRecord.done);
            }, 'orphan helper completion');
            assert.equal(
              fs.readFileSync(helperRecord.target, 'utf8'),
              'old-helper-resumed\n',
            );
            assert.deepEqual(tree(done.value.path), before);
            assert.equal(
              JSON.parse(fs.readFileSync(helperRecord.done, 'utf8')).pid,
              helperRecord.helperPid,
            );
          }
        }
        return {
          oldSnapshot,
          nextResult: done,
          deathToEnteredMs:
            next.messages.find(message => message.event === 'entered')?.at -
            diedAt,
          helper: helperRecord,
          leftoverPrivateAttempts: fs.readdirSync(
            path.join(directory, 'chrome/.staging'),
          ),
        };
      },
    );
  }
}

async function c2() {
  await runCase(
    'C2.foreign',
    'foreign stalled owner is recovered through the configured hard ceiling',
    async () => {
      const directory = cache('foreign');
      const old = worker('old', directory, {
        beforePublish: true,
        lockOptions: {
          heartbeatInterval: 60000,
          retryDelay: 10,
          hardMaximum: 300,
          staleThreshold: 100,
          acquisitionTimeout: 5000,
        },
      });
      await old.wait('publishHeld');
      const oldSnapshot = lockSnapshot((await old.wait('entered')).lockPath);
      fs.writeFileSync(
        oldSnapshot.heartbeatPath,
        JSON.stringify({
          ...oldSnapshot.owner,
          hostname: `${os.hostname()}-foreign`,
        }),
      );
      const next = worker('new', directory, {
        afterTask: true,
        lockOptions: {
          heartbeatInterval: 20,
          retryDelay: 10,
          hardMaximum: 300,
          staleThreshold: 100,
          acquisitionTimeout: 5000,
        },
      });
      await next.wait('releaseHeld');
      const before = lockSnapshot((await next.wait('entered')).lockPath);
      const value = (await next.wait('taskComplete')).value;
      const contents = tree(value.path);
      old.release('publishHeld');
      const resumed = await finished(old);
      assert.deepEqual(resumed.value, value);
      assert.deepEqual(
        lockSnapshot((await next.wait('entered')).lockPath),
        before,
      );
      assert.deepEqual(tree(value.path), contents);
      next.release('releaseHeld');
      await finished(next);
      return {oldSnapshot, replacement: before, contents};
    },
  );
}

async function c3() {
  for (const state of ['empty', 'malformed', 'missing']) {
    await runCase(
      `C3.${state}`,
      'fresh invalid owner is kept, stale invalid owner is recovered',
      async () => {
        const directory = cache(`invalid-${state}`);
        const first = worker('old', directory, {
          beforePublish: true,
          lockOptions: {heartbeatInterval: 60000},
        });
        await first.wait('publishHeld');
        const before = lockSnapshot((await first.wait('entered')).lockPath);
        const generationPath = path.dirname(before.heartbeatPath);
        if (state === 'missing') fs.unlinkSync(before.heartbeatPath);
        else
          fs.writeFileSync(before.heartbeatPath, state === 'empty' ? '' : '{');
        const probe = worker('third', directory, {
          lockOptions: {acquisitionTimeout: 0, staleThreshold: 10000},
        });
        const freshResult = await probe.wait('done');
        await probe.exit;
        assert.equal(freshResult.status, 'error');
        assert.equal(
          probe.messages.some(message => message.event === 'entered'),
          false,
        );
        const aged = new Date(Date.now() - 20000);
        fs.utimesSync(
          state === 'missing' ? generationPath : before.heartbeatPath,
          aged,
          aged,
        );
        const next = worker('new', directory, {
          afterTask: true,
          lockOptions: {
            heartbeatInterval: 20,
            staleThreshold: 10000,
            acquisitionTimeout: 5000,
            retryDelay: 10,
          },
        });
        await next.wait('releaseHeld');
        const replacement = lockSnapshot((await next.wait('entered')).lockPath);
        first.release('publishHeld');
        await finished(first);
        assert.deepEqual(
          lockSnapshot((await next.wait('entered')).lockPath),
          replacement,
        );
        next.release('releaseHeld');
        await finished(next);
        return {freshResult, replacement};
      },
    );
  }
  await runCase(
    'C3.freshened',
    'claim-time reinspection rejects a now-fresh owner',
    async () => {
      const directory = cache('freshened');
      const first = worker('old', directory, {
        beforePublish: true,
        lockOptions: {heartbeatInterval: 60000},
      });
      await first.wait('publishHeld');
      const before = lockSnapshot((await first.wait('entered')).lockPath);
      fs.writeFileSync(before.heartbeatPath, '{');
      const aged = new Date(Date.now() - 20000);
      fs.utimesSync(before.heartbeatPath, aged, aged);
      const claimant = worker('new', directory, {
        beforeClaim: true,
        lockOptions: {acquisitionTimeout: 0, staleThreshold: 10000},
      });
      await claimant.wait('claimHeld');
      const now = new Date();
      fs.writeFileSync(before.heartbeatPath, JSON.stringify(before.owner));
      fs.utimesSync(before.heartbeatPath, now, now);
      claimant.release('claimHeld');
      const result = await claimant.wait('done');
      await claimant.exit;
      assert.equal(result.status, 'error');
      assert.equal(
        claimant.messages.some(message => message.event === 'entered'),
        false,
      );
      assert.deepEqual(
        lockSnapshot((await first.wait('entered')).lockPath),
        before,
      );
      first.release('publishHeld');
      await finished(first);
      return {result, before};
    },
  );
  await runCase(
    'C3.initial',
    'a paused draft never exposes partial owner metadata or an acquired lock',
    async () => {
      const directory = cache('initial');
      const first = worker('old', directory, {beforeOwnerPublication: true});
      await first.wait('ownerPublicationHeld');
      assert.equal(
        first.messages.some(message => message.event === 'entered'),
        false,
      );
      const next = worker('new', directory, {afterTask: true});
      await next.wait('releaseHeld');
      const replacement = lockSnapshot((await next.wait('entered')).lockPath);
      first.release('ownerPublicationHeld');
      await first.wait('contended');
      assert.deepEqual(
        lockSnapshot((await next.wait('entered')).lockPath),
        replacement,
      );
      next.release('releaseHeld');
      const completed = await Promise.all([finished(first), finished(next)]);
      assert.deepEqual(completed[0].value, completed[1].value);
      return {replacement, completed};
    },
  );
}

async function c4() {
  await runCase(
    'C4.renameRace',
    'two prepared reclaimers race the same immutable successor publication',
    async () => {
      const directory = cache('reclaimer-rename-race');
      const old = worker('old', directory, {beforePublish: true});
      await old.wait('publishHeld');
      await old.stop();
      const initialRequests = requests.length;
      const first = worker('new', directory, {
        beforeClaimRename: true,
        afterTask: true,
        lockOptions: {
          heartbeatInterval: 20,
          retryDelay: 5,
          acquisitionTimeout: 5000,
        },
      });
      const second = worker('third', directory, {
        beforeClaimRename: true,
        afterTask: true,
        lockOptions: {
          heartbeatInterval: 20,
          retryDelay: 5,
          acquisitionTimeout: 5000,
        },
      });
      await Promise.all([
        first.wait('claimRenameHeld'),
        second.wait('claimRenameHeld'),
      ]);
      first.release('claimRenameHeld');
      second.release('claimRenameHeld');
      const winner = await Promise.race([
        first.wait('releaseHeld').then(() => {
          return first;
        }),
        second.wait('releaseHeld').then(() => {
          return second;
        }),
      ]);
      const loser = winner === first ? second : first;
      await loser.wait('contended');
      assert.equal(
        loser.messages.some(message => message.event === 'entered'),
        false,
      );
      assert.equal(requests.length - initialRequests, 1);
      const winnerValue = (await winner.wait('taskComplete')).value;
      const contents = tree(winnerValue.path);
      winner.release('releaseHeld');
      await finished(winner);
      await loser.wait('releaseHeld');
      loser.release('releaseHeld');
      const loserResult = await finished(loser);
      assert.deepEqual(loserResult.value, winnerValue);
      assert.deepEqual(tree(winnerValue.path), contents);
      assert.equal(requests.length - initialRequests, 1);
      return {
        winnerPid: winner.child.pid,
        loserPid: loser.child.pid,
        contents,
        requests: 1,
      };
    },
  );
  await runCase(
    'C4',
    'a delayed second reclaimer cannot replace a newer held generation',
    async () => {
      const directory = cache('reclaimers');
      const old = worker('old', directory, {beforePublish: true});
      await old.wait('publishHeld');
      await old.stop();
      const first = worker('new', directory, {
        beforeClaim: true,
        afterTask: true,
        lockOptions: {heartbeatInterval: 20, acquisitionTimeout: 5000},
      });
      const delayed = worker('third', directory, {
        beforeClaim: true,
        lockOptions: {acquisitionTimeout: 0},
      });
      await Promise.all([first.wait('claimHeld'), delayed.wait('claimHeld')]);
      first.release('claimHeld');
      await first.wait('releaseHeld');
      const before = lockSnapshot((await first.wait('entered')).lockPath);
      delayed.release('claimHeld');
      const delayedResult = await delayed.wait('done');
      await delayed.exit;
      assert.equal(delayedResult.status, 'error');
      assert.equal(
        delayed.messages.some(message => message.event === 'entered'),
        false,
      );
      assert.deepEqual(
        lockSnapshot((await first.wait('entered')).lockPath),
        before,
      );
      assert.deepEqual(
        fs
          .readdirSync((await first.wait('entered')).lockPath)
          .filter(name => name.startsWith('.claim-')),
        [],
      );
      first.release('releaseHeld');
      const result = await finished(first);
      return {before, delayedResult, result};
    },
  );
}

async function c6() {
  await runCase(
    'C6.initial',
    'failed initial metadata publication never starts install',
    async () => {
      const directory = cache('owner-failure');
      const initialRequests = requests.length;
      const first = worker('old', directory, {failOwner: true});
      const failure = await first.wait('done');
      await first.exit;
      assert.equal(failure.status, 'error');
      assert.match(failure.error.message, /RESEARCH_OWNER_PUBLICATION_FAILURE/);
      assert.equal(
        first.messages.some(message => message.event === 'entered'),
        false,
      );
      assert.equal(requests.length, initialRequests);
      await finished(worker('new', directory));
      return {failure};
    },
  );
  await runCase(
    'C6.refresh',
    'refresh failure is diagnosed without replacing a completed install',
    async () => {
      const directory = cache('refresh-failure');
      const first = worker('old', directory, {
        failRefresh: true,
        afterTask: true,
        lockOptions: {heartbeatInterval: 5},
      });
      await first.wait('releaseHeld');
      await first.wait('refreshFailed');
      first.release('releaseHeld');
      const result = await finished(first);
      return {
        result,
        diagnostics: first.messages.filter(
          message =>
            message.event === 'log' &&
            message.message.includes('RESEARCH_REFRESH_FAILURE'),
        ),
      };
    },
  );
  for (const failMetadata of [false, true]) {
    await runCase(
      failMetadata ? 'C6.primary' : 'C6.release',
      'release failure keeps the original task outcome',
      async () => {
        const directory = cache(
          failMetadata ? 'primary-failure' : 'release-failure',
        );
        const first = worker('old', directory, {
          failRelease: true,
          failMetadata,
        });
        const result = await first.wait('done');
        await first.exit;
        assert.equal(result.status, failMetadata ? 'error' : 'success');
        if (failMetadata)
          assert.match(result.error.message, /RESEARCH_METADATA_FAILURE/);
        assert(
          first.messages.some(
            message =>
              message.event === 'log' &&
              message.message.includes('RESEARCH_RELEASE_FAILURE'),
          ),
        );
        const final = path.join(directory, 'chrome/linux-123');
        assert.equal(
          fs.readFileSync(path.join(final, 'browser/old-chrome'), 'utf8'),
          'executable-old\n',
        );
        const contents = tree(final);
        const retry = await finished(worker('new', directory));
        assert.deepEqual(tree(retry.value.path), contents);
        return {result, retry, contents};
      },
    );
  }
}

async function c7() {
  await runCase(
    'C7.archive',
    'after takeover the late archive publisher preserves the winner and held generation',
    async () => {
      const directory = cache('archive-takeover');
      const policy = {
        retryDelay: 10,
        heartbeatInterval: 20,
        staleThreshold: 100,
        hardMaximum: 300,
        acquisitionTimeout: 5000,
      };
      const old = worker('old', directory, {
        unpack: false,
        beforeArchivePublish: true,
        delayHeartbeat: true,
        lockOptions: policy,
      });
      await old.wait('archivePublishHeld');
      await old.wait('heartbeatHeld');
      const next = worker('new', directory, {
        unpack: false,
        afterTask: true,
        lockOptions: policy,
      });
      await next.wait('releaseHeld');
      const lockBefore = lockSnapshot((await next.wait('entered')).lockPath);
      const archivePath = (await next.wait('taskComplete')).value;
      const bytesBefore = fs.readFileSync(archivePath);
      assert.deepEqual(bytesBefore, routes.get('/new/test.zip'));
      old.release('heartbeatHeld');
      old.release('archivePublishHeld');
      const failure = await old.wait('done');
      await old.exit;
      assert.equal(failure.status, 'error');
      assert.match(
        failure.error.message,
        /appeared while the installation was in progress/,
      );
      assert.deepEqual(fs.readFileSync(archivePath), bytesBefore);
      assert.deepEqual(
        lockSnapshot((await next.wait('entered')).lockPath),
        lockBefore,
      );
      next.release('releaseHeld');
      await finished(next);
      const retry = await finished(worker('third', directory, {unpack: false}));
      assert.equal(retry.value, archivePath);
      assert.deepEqual(fs.readFileSync(retry.value), bytesBefore);
      return {
        failure,
        retry,
        lockBefore,
        archiveSha256: createHash('sha256').update(bytesBefore).digest('hex'),
      };
    },
  );
  await runCase(
    'C7.download',
    'process interruption leaves no partial canonical tree and retry completes',
    async () => {
      const directory = cache('download-interruption');
      const first = worker('old', directory, {route: '/stream/test.zip'});
      await first.wait('entered');
      const streamIndex = events.length;
      await waitFor(() => {
        return events
          .slice(streamIndex - 5)
          .some(event => event.event === 'streamHeld');
      }, 'first response chunk');
      assert.equal(
        fs.existsSync(path.join(directory, 'chrome/linux-123')),
        false,
      );
      await first.stop();
      const result = await finished(worker('new', directory));
      assert.equal(
        fs.readFileSync(path.join(result.value.path, 'identity.txt'), 'utf8'),
        'payload-new\n',
      );
      return {
        result,
        privateAttempts: fs.readdirSync(
          path.join(directory, 'chrome/.staging'),
        ),
      };
    },
  );
  await runCase(
    'C7.postPublication',
    'metadata failure keeps the published tree and retry performs no download',
    async () => {
      const directory = cache('post-publication');
      const first = worker('old', directory, {failMetadata: true});
      const failure = await first.wait('done');
      await first.exit;
      assert.equal(failure.status, 'error');
      assert.match(failure.error.message, /RESEARCH_METADATA_FAILURE/);
      const contents = tree(path.join(directory, 'chrome/linux-123'));
      const beforeRequests = requests.length;
      const result = await finished(worker('new', directory));
      assert.equal(requests.length, beforeRequests);
      assert.deepEqual(tree(result.value.path), contents);
      return {failure, contents, result};
    },
  );
}

async function partialCache() {
  for (const state of ['empty', 'missing-executable', 'invalid-marker']) {
    await runCase(
      `15318.${state}`,
      'existing broken final is preserved and reported without automatic repair',
      async () => {
        const directory = cache(`partial-${state}`);
        const final = path.join(directory, 'chrome/linux-123');
        fs.mkdirSync(final, {recursive: true});
        if (state === 'missing-executable')
          fs.writeFileSync(path.join(final, 'unrelated.txt'), 'preserve');
        if (state === 'invalid-marker')
          fs.writeFileSync(
            path.join(final, '.puppeteer-install'),
            JSON.stringify({version: 2, relativeExecutablePath: 'missing'}),
          );
        const before = tree(final);
        const beforeRequests = requests.length;
        const first = worker('old', directory);
        const result = await first.wait('done');
        await first.exit;
        assert.equal(result.status, 'error');
        assert.equal(requests.length, beforeRequests);
        assert.deepEqual(tree(final), before);
        return {result, contents: before, automaticRepair: false};
      },
    );
  }
}

async function performanceProbe() {
  await runCase(
    'PERF',
    'warm cache-hit latency and persistent succession storage',
    async () => {
      const directory = cache('performance');
      const lib = path.join(repo, 'packages/browsers/lib');
      const {install, installLockForTesting} = await import(
        pathToFileURL(path.join(lib, 'install.js')).href
      );
      const implementation = await import(
        pathToFileURL(
          path.join(
            lib,
            mode === 'baseline' ? 'installLockBaseline.js' : 'installLock.js',
          ),
        ).href
      );
      const acquisition = [];
      installLockForTesting.withInstallLock = async (target, task, options) => {
        const started = performance.now();
        const execute = async () => {
          acquisition.push(performance.now() - started);
          return await task();
        };
        if (mode === 'none') return await execute();
        return await implementation.withInstallLock(target, execute, options);
      };
      const settings = {
        browser: 'chrome',
        platform: 'linux',
        buildId: '123',
        cacheDir: directory,
        baseUrl: serverUrl,
        providers: [
          {
            supports: () => {
              return true;
            },
            getDownloadUrl: () => {
              return new URL('/old/test.zip', serverUrl);
            },
            getExecutablePath: () => {
              return 'browser/old-chrome';
            },
            getName: () => {
              return 'Research-Performance';
            },
          },
        ],
        logger: () => {
          return () => {};
        },
      };
      const beforeRequests = requests.length;
      await install(settings);
      acquisition.length = 0;
      const samples = [];
      for (let index = 0; index < 128; index++) {
        const started = performance.now();
        await install(settings);
        samples.push(performance.now() - started);
      }
      assert.equal(requests.length - beforeRequests, 1);
      const summary = values => {
        const sorted = [...values].sort((a, b) => {
          return a - b;
        });
        return {
          p50Ms: sorted[Math.floor(sorted.length * 0.5)],
          p95Ms: sorted[Math.floor(sorted.length * 0.95)],
          maxMs: sorted.at(-1),
        };
      };
      let files = 0;
      let bytes = 0;
      let allocatedBytes = 0;
      const visit = target => {
        const stat = fs.lstatSync(target);
        allocatedBytes += (stat.blocks ?? 0) * 512;
        if (stat.isDirectory()) {
          for (const name of fs.readdirSync(target))
            visit(path.join(target, name));
        } else {
          files++;
          bytes += stat.size;
        }
      };
      const lockDirectory = fs
        .readdirSync(path.join(directory, 'chrome'))
        .find(name => name.startsWith('.installLock'));
      if (lockDirectory) visit(path.join(directory, 'chrome', lockDirectory));
      return {
        iterations: samples.length,
        cacheHit: summary(samples),
        acquisition: summary(acquisition),
        first16: summary(samples.slice(0, 16)),
        last16: summary(samples.slice(-16)),
        storage: {files, bytes, allocatedBytes},
        samples,
        acquisitionSamples: acquisition,
      };
    },
  );
}

async function discoveryProbe() {
  await runCase(
    'DISCOVERY',
    'archive-only cache discovery reproduces the artifact classification failure',
    async () => {
      const directory = cache('discovery');
      const archive = await finished(worker('old', directory, {unpack: false}));
      const {Cache} = await import(
        pathToFileURL(path.join(repo, 'packages/browsers/lib/Cache.js')).href
      );
      let failure;
      try {
        new Cache(directory).getInstalledBrowsers();
      } catch (error) {
        failure = {
          message: error.message,
          code: error.code,
          cause: error.cause?.code,
        };
      }
      assert(
        failure,
        'The previously observed discovery failure was not reproduced',
      );
      const upstreamCommit = 'c91da4f32ceffed3696334376aabcd1a1c19d41e';
      const upstreamSource = execFileSync(
        'git',
        ['show', `${upstreamCommit}:packages/browsers/src/Cache.ts`],
        {cwd: repo, encoding: 'utf8'},
      );
      const typescript = await import(
        pathToFileURL(
          path.join(repo, 'node_modules/typescript/lib/typescript.js'),
        ).href
      );
      const transpiled = typescript.default.transpileModule(upstreamSource, {
        compilerOptions: {
          target: typescript.default.ScriptTarget.ES2022,
          module: typescript.default.ModuleKind.ES2022,
        },
      }).outputText;
      const unchangedDependencies = [
        'packages/browsers/src/browser-data',
        'packages/browsers/src/debug.ts',
        'packages/browsers/src/detectPlatform.ts',
      ];
      assert.equal(
        execFileSync(
          'git',
          [
            'diff',
            '--name-only',
            upstreamCommit,
            'HEAD',
            '--',
            ...unchangedDependencies,
          ],
          {cwd: repo, encoding: 'utf8'},
        ).trim(),
        '',
      );
      const replay = transpiled.replace(
        /from '(\.\/[^']+)'/g,
        (_, relative) => {
          return `from '${pathToFileURL(path.join(repo, 'packages/browsers/lib', relative)).href}'`;
        },
      );
      const replayPath = path.join(output, 'Cache-upstream-replay.mjs');
      fs.writeFileSync(replayPath, replay);
      const {Cache: UpstreamCache} = await import(
        pathToFileURL(replayPath).href
      );
      let upstreamFailure;
      try {
        new UpstreamCache(directory).getInstalledBrowsers();
      } catch (error) {
        upstreamFailure = {message: error.message, code: error.code};
      }
      assert(
        upstreamFailure,
        'Upstream Cache did not reproduce the existing artifact classification gap',
      );
      return {
        archive: archive.value,
        observedDefect: failure,
        lockMode: mode,
        noProductionFixApplied: true,
        upstreamCacheCommit: upstreamCommit,
        upstreamCacheSourceSha256: createHash('sha256')
          .update(upstreamSource)
          .digest('hex'),
        upstreamFailure,
      };
    },
  );
}

async function c5() {
  await runCase(
    'C5',
    'old heartbeat and finally cannot change the new owner; third caller stays out',
    async () => {
      const directory = cache('old-resume');
      const policy = {
        retryDelay: 10,
        heartbeatInterval: 20,
        staleThreshold: 100,
        hardMaximum: 300,
        unsafeHardMaximumForTesting: 300,
        acquisitionTimeout: 5000,
      };
      const old = worker('old', directory, {
        beforePublish: true,
        delayHeartbeat: true,
        lockOptions: policy,
      });
      await old.wait('publishHeld');
      await old.wait('heartbeatHeld');
      const replacement = worker('new', directory, {
        afterTask: true,
        lockOptions: policy,
      });
      await replacement.wait('releaseHeld');
      const before = lockSnapshot((await replacement.wait('entered')).lockPath);
      const replacementResult = (await replacement.wait('taskComplete')).value;
      const beforeTree = tree(replacementResult.path);
      const metadataBefore = fs.readFileSync(
        path.join(directory, 'chrome/.metadata'),
        'utf8',
      );
      old.release('heartbeatHeld');
      old.release('publishHeld');
      const oldResult = await finished(old);
      assert.deepEqual(oldResult.value, replacementResult);
      assert.deepEqual(tree(replacementResult.path), beforeTree);
      assert.equal(
        fs.readFileSync(path.join(directory, 'chrome/.metadata'), 'utf8'),
        metadataBefore,
      );
      const after = lockSnapshot((await replacement.wait('entered')).lockPath);
      const third = worker('third', directory, {
        lockOptions: {...policy, acquisitionTimeout: 0},
      });
      const thirdResult = await third.wait('done');
      await third.exit;
      const observation = {
        before,
        after,
        oldResult,
        replacementResult,
        thirdResult,
        finalContents: beforeTree,
        oldAttemptCleaned:
          fs.readdirSync(path.join(directory, 'chrome/.staging')).length === 0,
      };
      events.push({event: 'c5Observations', ...observation});
      replacement.release('releaseHeld');
      await finished(replacement);
      assert.deepEqual(
        after,
        before,
        'Old generation changed or removed the held new lock',
      );
      assert.equal(
        thirdResult.status,
        'error',
        'Third caller acquired while replacement was still active',
      );
      assert.equal(
        third.messages.some(message => message.event === 'entered'),
        false,
      );
      return observation;
    },
  );
}

try {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  serverUrl = `http://127.0.0.1:${server.address().port}`;
  if (selected.includes('C0')) await c0();
  if (selected.includes('C1')) await c1();
  if (selected.includes('C2')) await c2();
  if (selected.includes('C3')) await c3();
  if (selected.includes('C4')) await c4();
  if (selected.includes('C5')) await c5();
  if (selected.includes('C6')) await c6();
  if (selected.includes('C7')) await c7();
  if (selected.includes('15318')) await partialCache();
  if (selected.includes('PERF')) await performanceProbe();
  if (selected.includes('DISCOVERY')) await discoveryProbe();
} catch (error) {
  console.error(error.stack);
  process.exitCode = 1;
} finally {
  await Promise.all(
    children.map(child => {
      return child.stop();
    }),
  );
  for (const helper of helpers) {
    if (!fs.existsSync(helper.done)) fs.writeFileSync(helper.control, 'resume');
    await waitFor(() => {
      return fs.existsSync(helper.done);
    }, 'owned helper cleanup').catch(() => {
      try {
        process.kill(helper.helperPid);
      } catch {}
    });
  }
  server.closeAllConnections();
  await new Promise(resolve => {
    server.close(resolve);
  });
  const git = args => {
    return execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
  };
  const untracked = git(['ls-files', '--others', '--exclude-standard'])
    .split('\n')
    .filter(Boolean);
  const sourceState = {
    head: git(['rev-parse', 'HEAD']),
    branch: git(['branch', '--show-current']),
    status: git(['status', '--short']),
    trackedPatchSha256: createHash('sha256')
      .update(execFileSync('git', ['diff', '--binary'], {cwd: repo}))
      .digest('hex'),
    untracked: untracked.map(file => {
      return {
        file,
        sha256: createHash('sha256')
          .update(fs.readFileSync(path.join(repo, file)))
          .digest('hex'),
      };
    }),
  };
  fs.writeFileSync(
    path.join(output, 'results.json'),
    JSON.stringify(
      {
        at: new Date().toISOString(),
        mode,
        selected,
        repo,
        output,
        platform: process.platform,
        release: os.release(),
        arch: process.arch,
        node: process.version,
        sourceState,
        results,
        requests,
        events,
      },
      null,
      2,
    ),
  );
  console.log(`Evidence: ${output}`);
}
