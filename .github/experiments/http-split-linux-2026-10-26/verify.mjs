/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {stripVTControlCharacters} from 'node:util';

const harness = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(harness, 'manifest.json'), 'utf8'),
);
const [mode, source, evidence] = process.argv.slice(2);
assert.ok(['transport', 'source', 'before', 'after', 'audit'].includes(mode));

function git(...args) {
  const result = spawnSync('git', args, {cwd: source, encoding: 'utf8'});
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function digest(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function verifyFiles(records) {
  return records.map(record => {
    const file = path.join(source, record.path);
    assert.equal(fs.statSync(file).size, record.size, record.path);
    assert.equal(digest(file), record.sha256, record.path);
    return record;
  });
}

function readLog(name) {
  return stripVTControlCharacters(
    fs.readFileSync(path.join(evidence, name), 'utf8'),
  );
}

if (mode === 'transport') {
  const head = git('rev-parse', 'HEAD');
  const prepared = head === manifest.sourceBase;
  if (!prepared) {
    assert.equal(head, process.env.GITHUB_SHA);
    assert.equal(git('status', '--porcelain'), '');
  }
  assert.deepEqual(
    git(
      'diff',
      ...(prepared ? ['--cached'] : []),
      '--name-only',
      manifest.sourceBase,
      ...(prepared ? [] : ['HEAD']),
    )
      .split('\n')
      .sort(),
    manifest.transportPaths,
  );
  assert.equal(git('diff', '--name-only'), '');
  assert.equal(git('ls-files', '--others', '--exclude-standard'), '');
  assert.equal(
    digest(path.join(harness, 'candidate.patch')),
    manifest.patchSha256,
  );
  console.log(`Transport verified (${prepared ? 'prepared' : head}).`);
} else if (mode === 'audit') {
  const http = JSON.parse(readLog('http.json'));
  assert.equal(http.stats.tests, manifest.httpTests);
  assert.equal(http.stats.passes, manifest.httpTests);
  assert.equal(http.stats.failures, 0);
  assert.equal(http.stats.pending, 0);
  assert.equal(http.passes.length, manifest.httpTests);
  for (const title of [
    'preserves a progress callback error and tears down the transfer',
    'rejects an interrupted response after closing the destination',
    'rejects getText when a relatively redirected request fails',
    'resolves HEAD as false when a relatively redirected request fails',
  ]) {
    assert.ok(
      http.passes.some(test => test.title === title),
      title,
    );
  }
  const unit = readLog('unit.log');
  const counts = [...unit.matchAll(/^[ℹ#] tests (\d+)\s*$/gm)].map(match =>
    Number(match[1]),
  );
  const passes = [...unit.matchAll(/^[ℹ#] pass (\d+)\s*$/gm)].map(match =>
    Number(match[1]),
  );
  const failures = [...unit.matchAll(/^[ℹ#] fail (\d+)\s*$/gm)].map(match =>
    Number(match[1]),
  );
  // A repeated root build may remove Angular test output without re-emitting it.
  // Always require a separate regenerated Angular run, even if root found 30.
  assert.ok([0, manifest.unitTests.ngSchematics].includes(counts[0]));
  assert.deepEqual(counts.slice(1), [
    manifest.unitTests.puppeteer,
    manifest.unitTests.puppeteerCore,
  ]);
  assert.deepEqual(passes, counts);
  assert.deepEqual(failures, [0, 0, 0]);
  const angular = readLog('angular-unit.log');
  assert.match(angular, /^ℹ tests 30\s*$/m);
  assert.match(angular, /^ℹ pass 30\s*$/m);
  assert.match(angular, /^ℹ fail 0\s*$/m);
  const summary = {
    http: http.stats,
    rootUnitCounts: counts,
    separatelyRegeneratedAngular: manifest.unitTests.ngSchematics,
  };
  fs.writeFileSync(
    path.join(evidence, 'test-counts.json'),
    JSON.stringify(summary, null, 2) + '\n',
  );
  console.log(JSON.stringify(summary, null, 2));
} else {
  assert.equal(git('rev-parse', 'HEAD'), manifest.sourceBase);
  assert.equal(git('write-tree'), manifest.sourceTree);
  assert.equal(git('diff', '--name-only'), '');
  assert.equal(git('ls-files', '--others', '--exclude-standard'), '');
  const snapshot = {
    tree: manifest.sourceTree,
    files: verifyFiles(manifest.files),
    ...(mode === 'source' ? {} : {compiled: verifyFiles(manifest.compiled)}),
  };
  if (mode !== 'source') {
    fs.writeFileSync(
      path.join(evidence, `inputs-${mode}.json`),
      JSON.stringify(snapshot, null, 2) + '\n',
    );
    if (mode === 'after') {
      assert.deepEqual(
        snapshot,
        JSON.parse(fs.readFileSync(path.join(evidence, 'inputs-before.json'))),
      );
    }
  }
  console.log(`${mode}: exact HTTP candidate tree and bytes verified.`);
}
