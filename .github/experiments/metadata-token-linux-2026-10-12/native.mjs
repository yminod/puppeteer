// Research transport only: runs the exact production candidate, without a lock shim.
import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';

const self = fileURLToPath(import.meta.url);
const sha = file =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const errorRecord = error => ({
  message: error.message,
  code: error.code,
  stack: error.stack,
});

async function worker(config) {
  const {Cache} = await import(
    pathToFileURL(path.join(config.repo, 'packages/browsers/lib/Cache.js'))
  );
  const {Browser, BrowserPlatform} = await import(
    pathToFileURL(
      path.join(
        config.repo,
        'packages/browsers/lib/browser-data/browser-data.js',
      ),
    )
  );
  const cache = new Cache(config.cache);
  const events = [];
  const record = event => {
    const value = {event, pid: process.pid, utc: new Date().toISOString()};
    events.push(value);
    fs.writeFileSync(
      path.join(config.output, 'events.json'),
      JSON.stringify(events, null, 2),
    );
    process.send?.(value);
  };
  if (config.mode === 'hold') {
    const original = cache.readMetadata.bind(cache);
    cache.readMetadata = browser => {
      const metadata = original(browser);
      record('holding');
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
      return metadata;
    };
  }
  process.once('message', async () => {
    try {
      record('started');
      for (let index = 0; index < (config.mode === 'hold' ? 1 : 50); index++) {
        const key = `${config.label}-${index}`;
        cache.writeAlias(Browser.CHROME, key, String(index));
        cache.writeExecutablePath(
          Browser.CHROME,
          BrowserPlatform.LINUX,
          key,
          `custom/${config.label}/${index}/chrome`,
        );
        await new Promise(resolve => setImmediate(resolve));
      }
      save(path.join(config.output, 'result.json'), {success: true, events});
      process.disconnect();
    } catch (error) {
      save(path.join(config.output, 'result.json'), {
        success: false,
        error: errorRecord(error),
        events,
      });
      process.exitCode = 1;
      process.disconnect();
    }
  });
  record('ready');
}

async function parent(outputArgument, repoArgument, allowLocal) {
  assert(
    process.platform === 'linux' ||
      (allowLocal === '--allow-local' && process.platform === 'darwin'),
  );
  assert.equal(process.version, 'v24.15.0');
  const output = path.resolve(outputArgument),
    repo = path.resolve(repoArgument);
  assert(!fs.existsSync(output));
  fs.mkdirSync(output, {recursive: true});
  const {Cache} = await import(
    pathToFileURL(path.join(repo, 'packages/browsers/lib/Cache.js'))
  );
  const {Browser, BrowserPlatform} = await import(
    pathToFileURL(
      path.join(repo, 'packages/browsers/lib/browser-data/browser-data.js'),
    )
  );
  const {install} = await import(
    pathToFileURL(path.join(repo, 'packages/browsers/lib/main.js'))
  );
  const {writeInstallMarker} = await import(
    pathToFileURL(path.join(repo, 'packages/browsers/lib/installMarker.js'))
  );
  const {withMetadataLock} = await import(
    pathToFileURL(path.join(repo, 'packages/browsers/lib/metadataLock.js'))
  );
  const processes = [],
    cases = [];
  const seed = {
    aliases: {base: '0'},
    executablePaths: {'linux-base': 'custom/base/chrome'},
  };
  function fixture(name) {
    const directory = path.join(output, name);
    fs.mkdirSync(directory);
    const cacheRoot = path.join(directory, 'cache'),
      cache = new Cache(cacheRoot);
    cache.writeMetadata(Browser.CHROME, structuredClone(seed));
    return {
      directory,
      cacheRoot,
      cache,
      root: cache.browserRoot(Browser.CHROME),
      metadataFile: cache.metadataFile(Browser.CHROME),
    };
  }
  function child(ctx, label, mode) {
    const directory = path.join(ctx.directory, label);
    fs.mkdirSync(directory);
    const file = path.join(directory, 'config.json');
    save(file, {repo, cache: ctx.cacheRoot, output: directory, label, mode});
    const fd = fs.openSync(path.join(directory, 'worker.log'), 'wx');
    const target = fork(self, ['worker', file], {
      stdio: ['ignore', fd, fd, 'ipc'],
    });
    fs.closeSync(fd);
    const entry = {
      target,
      pid: target.pid,
      directory,
      events: [],
      signals: [],
      closed: false,
    };
    target.on('message', value => entry.events.push(value));
    target.on('error', error => (entry.error = errorRecord(error)));
    entry.close = new Promise(resolve =>
      target.once('close', (code, signal) => {
        Object.assign(entry, {closed: true, code, signal});
        resolve();
      }),
    );
    processes.push(entry);
    return entry;
  }
  async function event(entry, name) {
    const deadline = Date.now() + 10000;
    while (!entry.events.some(value => value.event === name)) {
      assert(!entry.closed && !entry.error, `Worker ended before ${name}`);
      assert(Date.now() < deadline, `Missing worker event ${name}`);
      await delay(5);
    }
  }
  async function close(entry) {
    let timer;
    try {
      await Promise.race([
        entry.close,
        new Promise((_, reject) => {
          timer = setTimeout(
            () => reject(new Error('Worker close timeout')),
            15000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
    assert(!entry.error);
  }
  function signal(entry, name) {
    assert(entry.target.kill(name));
    entry.signals.push({signal: name, utc: new Date().toISOString()});
  }
  function guard(ctx) {
    const lock = path.join(ctx.root, '.metadata.lock');
    const entries = fs.readdirSync(lock);
    assert.equal(entries.length, 1);
    const marker = entries[0],
      record = read(path.join(lock, marker));
    assert.equal(marker, `owner-${record.token}`);
    assert.equal(record.version, 1);
    return {
      marker,
      record,
      inode: fs.statSync(lock).ino,
      sha256: sha(path.join(lock, marker)),
    };
  }
  async function interrupted(ctx) {
    const holder = child(ctx, 'holder', 'hold');
    await event(holder, 'ready');
    holder.target.send('start');
    await event(holder, 'holding');
    const before = guard(ctx),
      metadata = ctx.cache.readMetadata(Browser.CHROME);
    signal(holder, 'SIGINT');
    await close(holder);
    assert.equal(holder.code, null);
    assert.equal(holder.signal, 'SIGINT');
    assert.deepEqual(guard(ctx), before);
    assert.deepEqual(ctx.cache.readMetadata(Browser.CHROME), metadata);
    return {owner: before, metadata, pid: holder.pid};
  }
  function finalMetadata(ctx) {
    const metadata = ctx.cache.readMetadata(Browser.CHROME);
    assert.equal(metadata.aliases.base, '0');
    assert.equal(
      metadata.executablePaths['linux-base'],
      seed.executablePaths['linux-base'],
    );
    assert(!fs.existsSync(path.join(ctx.root, '.metadata.lock')));
    assert(
      !fs
        .readdirSync(ctx.root)
        .some(name => name.startsWith('.metadata.lock-prepared-')),
    );
    save(path.join(ctx.directory, 'final-metadata.json'), metadata);
    return {metadata, sha256: sha(ctx.metadataFile)};
  }
  async function run(name, task) {
    try {
      const observation = await task(fixture(name));
      cases.push({name, pass: true, observation});
    } catch (error) {
      cases.push({name, pass: false, error: errorRecord(error)});
    }
    console.log(JSON.stringify({name, pass: cases.at(-1).pass}));
  }
  try {
    await run('N0.native-directory-collision', async ctx => {
      let observation;
      withMetadataLock(ctx.root, () => {
        const before = guard(ctx),
          lock = path.join(ctx.root, '.metadata.lock');
        const token = randomUUID(),
          contender = path.join(ctx.root, '.native-contender');
        fs.mkdirSync(contender);
        fs.writeFileSync(
          path.join(contender, `owner-${token}`),
          JSON.stringify({version: 1, token}),
        );
        let renameCode, rmdirCode;
        assert.throws(
          () => fs.renameSync(contender, lock),
          error => {
            renameCode = error.code;
            return error.code === 'ENOTEMPTY';
          },
        );
        assert.throws(
          () => fs.rmdirSync(lock),
          error => {
            rmdirCode = error.code;
            return error.code === 'ENOTEMPTY';
          },
        );
        assert.deepEqual(guard(ctx), before);
        fs.rmSync(contender, {recursive: true});
        observation = {renameCode, rmdirCode, ownerPreserved: before};
      });
      return {...observation, final: finalMetadata(ctx)};
    });
    await run('N1.sigint-alias-recovery', async ctx => {
      const orphan = await interrupted(ctx),
        started = performance.now();
      ctx.cache.writeAlias(Browser.CHROME, 'recovered', '1');
      const recoveryMs = performance.now() - started;
      assert(recoveryMs >= 2000);
      const final = finalMetadata(ctx);
      assert.equal(final.metadata.aliases.recovered, '1');
      assert.deepEqual(Object.keys(final.metadata.aliases).sort(), [
        'base',
        'recovered',
      ]);
      return {orphan, recoveryMs, final};
    });
    await run('N2.sigint-direct-cache-hit', async ctx => {
      const buildId = '123',
        relative = path.join('custom', 'chrome');
      const installation = ctx.cache.installationDir(
        Browser.CHROME,
        BrowserPlatform.LINUX,
        buildId,
      );
      const executable = path.join(installation, relative);
      fs.mkdirSync(path.dirname(executable), {recursive: true});
      fs.writeFileSync(executable, 'dummy executable\n');
      writeInstallMarker(installation, relative);
      ctx.cache.writeExecutablePath(
        Browser.CHROME,
        BrowserPlatform.LINUX,
        buildId,
        'stale',
      );
      const executableSha256 = sha(executable),
        orphan = await interrupted(ctx),
        started = performance.now();
      const installed = await install({
        cacheDir: ctx.cacheRoot,
        browser: Browser.CHROME,
        platform: BrowserPlatform.LINUX,
        buildId,
      });
      const recoveryMs = performance.now() - started;
      assert(recoveryMs >= 2000);
      assert.equal(installed.executablePath, executable);
      assert.equal(sha(executable), executableSha256);
      const final = finalMetadata(ctx);
      assert.equal(final.metadata.executablePaths['linux-123'], relative);
      assert.deepEqual(final.metadata.aliases, seed.aliases);
      return {orphan, recoveryMs, executableSha256, final};
    });
    await run('N3.concurrent-rmw', async ctx => {
      const writers = [child(ctx, 'a', 'write'), child(ctx, 'b', 'write')];
      await Promise.all(writers.map(entry => event(entry, 'ready')));
      for (const entry of writers) entry.target.send('start');
      await Promise.all(writers.map(close));
      for (const entry of writers) {
        assert.equal(entry.code, 0);
        assert.equal(entry.signal, null);
        assert.equal(
          read(path.join(entry.directory, 'result.json')).success,
          true,
        );
      }
      const final = finalMetadata(ctx);
      for (const label of ['a', 'b']) {
        for (let index = 0; index < 50; index++) {
          assert.equal(
            final.metadata.aliases[`${label}-${index}`],
            String(index),
          );
          assert.equal(
            final.metadata.executablePaths[`linux-${label}-${index}`],
            `custom/${label}/${index}/chrome`,
          );
        }
      }
      assert.equal(Object.keys(final.metadata.aliases).length, 101);
      assert.equal(Object.keys(final.metadata.executablePaths).length, 101);
      return {aliasUpdates: 100, executableUpdates: 100, final};
    });
  } finally {
    for (const entry of processes) {
      if (!entry.closed) {
        signal(entry, 'SIGKILL');
        await entry.close;
      }
    }
    const processAudit = processes.map(({target, close, ...entry}) => entry);
    const summary = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      cases: cases.length,
      passing: cases.filter(value => value.pass).length,
      failing: cases.filter(value => !value.pass).length,
      ownedProcesses: processAudit.length,
      allClosed: processAudit.every(value => value.closed),
    };
    save(path.join(output, 'results.json'), {summary, cases, processAudit});
    console.log(JSON.stringify(summary));
    if (summary.failing || !summary.allClosed) process.exitCode = 1;
  }
}

if (process.argv[2] === 'worker') await worker(read(process.argv[3]));
else await parent(...process.argv.slice(2));
