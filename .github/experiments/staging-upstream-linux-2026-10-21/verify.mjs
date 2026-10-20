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

const harness = path.dirname(fileURLToPath(import.meta.url));
const manifest = JSON.parse(
  fs.readFileSync(path.join(harness, 'manifest.json')),
);
const [mode, source, evidence, suite] = process.argv.slice(2);
assert.ok(['transport', 'verify', 'final'].includes(mode));

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

if (mode === 'transport') {
  assert.equal(git('rev-parse', 'HEAD'), process.env.GITHUB_SHA);
  assert.equal(git('status', '--porcelain'), '');
  assert.deepEqual(
    git('diff', '--name-only', manifest.sourceBase, 'HEAD').split('\n').sort(),
    manifest.transportPaths,
  );
  assert.equal(
    digest(path.join(harness, 'candidate.patch')),
    manifest.patchSha256,
  );
  console.log('Transport paths and patch digest match.');
} else {
  assert.equal(git('rev-parse', 'HEAD'), manifest.sourceBase);
  assert.equal(git('write-tree'), manifest.sourceTree);
  assert.equal(git('diff', '--name-only'), '');
  assert.equal(git('ls-files', '--others', '--exclude-standard'), '');
  const snapshot = {
    tree: manifest.sourceTree,
    files: verifyFiles(manifest.files),
    compiled: verifyFiles(manifest.compiled),
  };
  fs.writeFileSync(
    path.join(
      evidence,
      mode === 'verify' ? 'inputs-before.json' : 'inputs-after.json',
    ),
    JSON.stringify(snapshot, null, 2) + '\n',
  );
  if (mode === 'final') {
    assert.deepEqual(
      snapshot,
      JSON.parse(fs.readFileSync(path.join(evidence, 'inputs-before.json'))),
    );
    if (suite === 'package') {
      const log = fs.readFileSync(
        path.join(evidence, 'package-test.log'),
        'utf8',
      );
      assert.match(
        log,
        new RegExp(`\\b${manifest.linuxPackage.passing} passing\\b`),
      );
      assert.match(
        log,
        new RegExp(`\\b${manifest.linuxPackage.pending} pending\\b`),
      );
      assert.doesNotMatch(log, /\b\d+ failing\b/);
      for (const name of [
        'unpacks tar.xz',
        'unpacks tar.bz2',
        'should download a buildId that is a bzip2 archive',
        'converges concurrent installs on a completed tree',
        'prevents path traversal in installationDir and uninstall',
        'rejects an invalid build ID before creating an archive download attempt',
        'extracts symlink chains inside the target directory',
        'rejects symlink chains routed through an earlier symlink',
        'resolves after closing the archive',
        'closes the archive after an entry write fails',
        'rejects getText when a relatively redirected request fails',
        'resolves HEAD as false when a relatively redirected request fails',
        'should remove the alias of an uninstalled browser',
      ]) {
        assert.ok(log.includes(`✔ ${name}`), name);
      }
    }
  }
  console.log(
    `${mode}: exact candidate tree, source and compiled bytes match.`,
  );
}
