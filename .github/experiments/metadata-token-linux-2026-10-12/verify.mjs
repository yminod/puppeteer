// Verify exact source/build inputs and all completed Linux evidence.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(here, 'manifest.json'), 'utf8'),
);
const [mode, repoArgument, outputArgument, allowLocal] = process.argv.slice(2);
assert(['verify', 'audit'].includes(mode));
const repo = path.resolve(repoArgument),
  output = path.resolve(outputArgument);
const read = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const hash = file =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const save = (file, value) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', {flag: 'wx'});
const git = (...args) =>
  execFileSync('git', ['-C', repo, ...args], {encoding: 'utf8'}).trim();
const requireLinux = allowLocal !== '--allow-local';
assert.equal(process.version, 'v24.15.0');
if (requireLinux) {
  assert.equal(process.platform, 'linux');
  assert.equal(process.arch, 'x64');
  assert(process.getuid() !== 0);
  assert.equal(
    execFileSync('findmnt', ['-n', '-o', 'FSTYPE', '-T', output], {
      encoding: 'utf8',
    }).trim(),
    'ext4',
  );
}
for (const item of manifest.harnesses)
  assert.equal(hash(path.join(here, item.file)), item.sha256, item.file);
assert.equal(hash(path.join(here, 'candidate.patch')), manifest.patchSha256);
function source() {
  assert.equal(git('rev-parse', 'HEAD'), manifest.baseCommit);
  const tracked = git('diff', '--name-only', 'HEAD')
    .split('\n')
    .filter(Boolean);
  const untracked = git('ls-files', '--others', '--exclude-standard')
    .split('\n')
    .filter(Boolean);
  const changed = [...tracked, ...untracked].sort();
  assert.deepEqual(changed, manifest.sourceFiles.map(item => item.file).sort());
  return {
    head: git('rev-parse', 'HEAD'),
    changed,
    files: [...manifest.sourceFiles, ...manifest.compiledFiles].map(item => {
      const file = path.join(repo, item.file),
        sha256 = hash(file);
      assert.equal(sha256, item.sha256, item.file);
      return {file: item.file, bytes: fs.statSync(file).size, sha256};
    }),
  };
}
const current = source();
if (mode === 'verify') {
  save(path.join(output, 'inputs-before.json'), {
    source: current,
    environment: {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      kernel: os.release(),
    },
    timestamp: new Date().toISOString(),
  });
  console.log(
    JSON.stringify({
      sourceFiles: 5,
      compiledFiles: 2,
      inputsMatched: true,
      behaviorCases: 0,
    }),
  );
} else {
  assert.deepEqual(
    current,
    read(path.join(output, 'inputs-before.json')).source,
  );
  const focused = read(path.join(output, 'focused.json'));
  assert.equal(focused.stats.passes, 41);
  assert.equal(focused.stats.failures, 0);
  assert.equal(focused.stats.pending, 0);
  assert.deepEqual(
    focused.tests.map(item => item.fullTitle).sort(),
    [...manifest.focusedCaseNames].sort(),
  );
  const native = read(path.join(output, 'native/results.json'));
  assert.deepEqual(
    native.cases.map(item => item.name).sort(),
    [...manifest.nativeCaseNames].sort(),
  );
  assert(native.cases.every(item => item.pass));
  assert.equal(native.summary.ownedProcesses, 4);
  assert(native.processAudit.every(item => item.closed));
  assert.equal(
    native.processAudit.filter(item => item.signal === 'SIGINT').length,
    2,
  );
  assert.equal(
    native.processAudit.filter(item => item.code === 0 && item.signal === null)
      .length,
    2,
  );
  assert.equal(
    native.processAudit.filter(item => item.signal === 'SIGKILL').length,
    0,
  );
  for (const item of native.cases) {
    const directory = path.join(output, 'native', item.name);
    const metadataFile = path.join(directory, 'cache/chrome/.metadata');
    const metadata = read(metadataFile);
    assert.deepEqual(metadata, item.observation.final.metadata);
    assert.equal(hash(metadataFile), item.observation.final.sha256);
    assert.equal(metadata.aliases.base, '0');
    assert.equal(metadata.executablePaths['linux-base'], 'custom/base/chrome');
    assert(!fs.existsSync(path.join(directory, 'cache/chrome/.metadata.lock')));
    if (item.name === 'N0.native-directory-collision') {
      assert.equal(item.observation.renameCode, 'ENOTEMPTY');
      assert.equal(item.observation.rmdirCode, 'ENOTEMPTY');
    } else if (item.name.startsWith('N1.')) {
      assert(item.observation.recoveryMs >= 2000);
      assert.deepEqual(metadata.aliases, {base: '0', recovered: '1'});
    } else if (item.name.startsWith('N2.')) {
      assert(item.observation.recoveryMs >= 2000);
      const executable = path.join(
        directory,
        'cache/chrome/linux-123/custom/chrome',
      );
      assert.equal(hash(executable), item.observation.executableSha256);
      assert.equal(
        metadata.executablePaths['linux-123'],
        path.join('custom', 'chrome'),
      );
      assert.deepEqual(metadata.aliases, {base: '0'});
    } else {
      assert.equal(Object.keys(metadata.aliases).length, 101);
      assert.equal(Object.keys(metadata.executablePaths).length, 101);
      for (const label of ['a', 'b'])
        for (let index = 0; index < 50; index++) {
          assert.equal(metadata.aliases[`${label}-${index}`], String(index));
          assert.equal(
            metadata.executablePaths[`linux-${label}-${index}`],
            `custom/${label}/${index}/chrome`,
          );
        }
    }
  }
  let packageResult;
  if (requireLinux) {
    const log = fs
      .readFileSync(path.join(output, 'package.log'), 'utf8')
      .replace(/\u001b\[[0-9;]*[A-Za-z]/g, '');
    const count = word =>
      Number(log.match(new RegExp(`^\\s+(\\d+) ${word}\\b`, 'm'))?.[1] ?? 0);
    packageResult = {
      passing: count('passing'),
      failing: count('failing'),
      pending: count('pending'),
    };
    assert.deepEqual(packageResult, {passing: 208, failing: 0, pending: 1});
    assert(log.includes('should download a buildId that is a dmg archive'));
    for (const test of focused.tests)
      assert(log.includes(test.title), `Package missing ${test.title}`);
  }
  save(path.join(output, 'inputs-after.json'), {
    source: current,
    timestamp: new Date().toISOString(),
  });
  const report = {
    sourceAndCompiledUnchanged: true,
    focused: {passing: 41, failing: 0, pending: 0},
    native: native.summary,
    package: packageResult,
    recoveryMs: native.cases
      .filter(item => item.observation.recoveryMs)
      .map(item => ({name: item.name, ms: item.observation.recoveryMs})),
    auditedNativeMetadata: native.cases.length,
  };
  save(path.join(output, 'audit.json'), report);
  console.log(JSON.stringify(report));
}
