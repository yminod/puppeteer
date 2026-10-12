// Research-only observation of unchanged Cache. Gates widen specific windows;
// the continuous-update case does not patch Cache or fs.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const config = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
const original = Object.fromEntries(['mkdirSync', 'writeFileSync', 'renameSync', 'rmdirSync'].map(name => [name, fs[name]]));
const wait = new Int32Array(new SharedArrayBuffer(4));
const guard = config.cache && path.join(config.cache, 'chrome/.metadata.lock');
const record = (event, fields = {}) => fs.appendFileSync(path.join(config.output, 'events.jsonl'), JSON.stringify({event, at: performance.now(), pid: process.pid, ...fields}) + '\n');
const save = (name, data) => original.writeFileSync(path.join(config.output, name), JSON.stringify(data), {flag: 'wx'});
const trigger = () => original.writeFileSync(path.join(config.output, 'trigger'), 'ready', {flag: 'wx'});
let held = false;
function hold(stage) {
  if (held || config.hold !== stage) return;
  held = true;
  record('held', {stage, guardExists: !!guard && fs.existsSync(guard)});
  trigger();
  const deadline = performance.now() + 20000;
  while (!fs.existsSync(path.join(config.output, 'release'))) {
    if (performance.now() > deadline) throw new Error('Research gate timeout');
    Atomics.wait(wait, 0, 0, 5);
  }
  record('resumed', {stage});
}
process.on('exit', code => record('exit-event', {code}));
if (config.handler) {
  process.once('SIGINT', signal => {
    const observation = {signal, guardExists: !!guard && fs.existsSync(guard)};
    save('sigint.json', observation);
    record('sigint-handler', observation);
    process.exit(130);
  });
}
record('started', {handler: !!config.handler, mode: config.mode, hold: config.hold});
if (config.nativeSignal) setInterval(() => {}, 1000);

try {
  if (config.mode === 'idle') {
    trigger();
  } else {
    const {Cache} = await import(pathToFileURL(path.join(config.repo, 'packages/browsers/lib/Cache.js')));
    const cache = new Cache(config.cache);
    if (config.hold) {
      const originalRead = Cache.prototype.readMetadata;
      Cache.prototype.readMetadata = function (...args) {
        const result = originalRead.apply(this, args);
        hold('after-read');
        return result;
      };
      let contended = false;
      fs.mkdirSync = (target, options) => {
        try {
          const result = original.mkdirSync(target, options);
          if (path.resolve(String(target)) === guard) hold('after-acquire');
          return result;
        } catch (error) {
          if (path.resolve(String(target)) === guard && error.code === 'EEXIST' && !contended) {
            contended = true;
            record('contended');
            if (config.triggerOnContention) trigger();
            hold('waiting');
          }
          throw error;
        }
      };
      fs.writeFileSync = (target, ...args) => {
        const temporary = path.dirname(String(target)) === path.dirname(guard) && /^\.metadata-\d+-/.test(path.basename(String(target)));
        if (temporary) hold('before-temp');
        const result = original.writeFileSync(target, ...args);
        if (temporary) hold('after-temp');
        return result;
      };
      fs.renameSync = (from, to) => {
        const metadata = path.resolve(String(to)) === path.join(config.cache, 'chrome/.metadata');
        if (metadata) hold('before-rename');
        const result = original.renameSync(from, to);
        if (metadata) hold('after-rename');
        return result;
      };
      fs.rmdirSync = (target, ...args) => {
        if (path.resolve(String(target)) === guard) hold('before-release');
        const result = original.rmdirSync(target, ...args);
        if (path.resolve(String(target)) === guard) hold('after-release');
        return result;
      };
    }
    if (config.mode === 'loop') {
      trigger();
      for (let index = 0; index < 100000; index++) cache.writeAlias('chrome', 'counter', String(index));
      save('result.json', {success: true, completedUpdates: 100000});
    } else {
      if (config.triggerBeforeAlias) trigger();
      const started = performance.now();
      cache.writeAlias('chrome', config.alias ?? 'old', '1');
      save('result.json', {success: true, durationMs: performance.now() - started});
      record('update-returned', {guardExists: fs.existsSync(guard)});
    }
  }
} catch (error) {
  save('result.json', {success: false, error: {name: error.name, code: error.code, message: error.message}});
  record('caught-error', {message: error.message});
  process.exitCode = 1;
}
