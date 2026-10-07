/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// CI transport and evidence checks for the frozen MI1 experiment. The original
// research harnesses are copied unchanged; this runner is not a browser API.

import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const fixture = JSON.parse(
  fs.readFileSync(path.join(import.meta.dirname, 'fixture.json'), 'utf8'),
);
const repo = path.resolve(import.meta.dirname, '../../..');
const command = process.argv[2];
const allowDirty = process.argv.includes('--allow-dirty');
const requireLinux = process.argv.includes('--require-linux-ext4');
const output = process.argv
  .find(arg => {
    return arg.startsWith('--output=');
  })
  ?.slice('--output='.length);

function git(...args) {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
}

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
}

function verifyInputs() {
  assert.equal(fixture.version, 1);
  assert.equal(process.version, fixture.node, 'Use the MI1 Node version');
  const status = git('status', '--porcelain=v1');
  const head = git('rev-parse', 'HEAD');
  if (process.env.GITHUB_ACTIONS === 'true') {
    assert.equal(allowDirty, false, 'CI must use a clean committed tree');
    assert.equal(head, process.env.GITHUB_SHA);
    assert.equal(
      process.env.GITHUB_REF,
      `refs/heads/${fixture.experimentBranch}`,
    );
  }
  if (!allowDirty) {
    assert.equal(status, '', 'Unexpected worktree changes');
  }
  git('merge-base', '--is-ancestor', fixture.sourceBase, 'HEAD');
  git(
    'cat-file',
    '-e',
    `${fixture.upstreamDiscoveryCommit}:packages/browsers/src/Cache.ts`,
  );

  const files = [...fixture.sourceFiles, ...fixture.harnessFiles].map(file => {
    const actual = hash(path.join(repo, file.path));
    assert.equal(actual, file.sha256, `MI1 input changed: ${file.path}`);
    return {...file, actualSha256: actual};
  });
  const allowedChanges = [
    ...files.map(file => {
      return file.path;
    }),
    '.github/workflows/browser-install-staging-lock-linux.yml',
    '.github/experiments/staging-lock-integration-2026-10-08/fixture.json',
    '.github/experiments/staging-lock-integration-2026-10-08/run-validation.mjs',
  ].sort();
  const changes = new Set([
    ...git('diff', '--name-only', fixture.sourceBase)
      .split('\n')
      .filter(Boolean),
    ...git('ls-files', '--others', '--exclude-standard')
      .split('\n')
      .filter(Boolean),
  ]);
  assert.deepEqual(
    [...changes].sort(),
    allowedChanges,
    'Unexpected source or CI changes',
  );
  const focused = spawnSync(
    'git',
    [
      'grep',
      '-n',
      '-E',
      '(describe|it)\\.only[[:space:]]*\\(',
      '--',
      'packages/browsers/test/src',
    ],
    {cwd: repo, encoding: 'utf8'},
  );
  assert.equal(
    focused.status,
    1,
    `Focused tests left enabled: ${focused.stdout}`,
  );

  let filesystems;
  if (requireLinux) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.notEqual(
      os.userInfo().uid,
      0,
      'Run the recovery comparison as a non-root user',
    );
    filesystems = [repo, output].map(target => {
      const type = execFileSync(
        'findmnt',
        ['-n', '-o', 'FSTYPE', '-T', target],
        {encoding: 'utf8'},
      ).trim();
      assert.equal(type, 'ext4', `Unexpected filesystem at ${target}`);
      return {path: target, type};
    });
  }
  return {
    at: new Date().toISOString(),
    platform: process.platform,
    release: os.release(),
    architecture: process.arch,
    node: process.version,
    uid: os.userInfo().uid,
    head,
    branch: git('branch', '--show-current'),
    status,
    sourceBase: fixture.sourceBase,
    macCombinedSourcePatchSha256: fixture.macCombinedSourcePatchSha256,
    files,
    filesystems,
    ciFiles: allowedChanges
      .filter(file => {
        return file.startsWith('.github/');
      })
      .map(file => {
        return {path: file, sha256: hash(path.join(repo, file))};
      }),
  };
}

function validateResult(kind, status, data, head) {
  assert.equal(data.sourceState.head, head);
  assert.equal(data.node, fixture.node);
  assert.equal(data.platform, process.platform);
  assert.equal(data.arch, process.arch);
  assert.deepEqual(
    data.results.map(result => {
      return result.id;
    }),
    fixture.expectedCases[kind],
    `Missing, extra, or reordered cases: ${kind}`,
  );
  if (kind === 'negative-control') {
    assert.equal(status, 1, 'The shared-path negative control must fail');
    assert.equal(data.results[0].status, 'fail');
    assert.match(
      data.results[0].error.message,
      /Old generation changed or removed the held new lock/,
      'An unrelated failure does not validate the negative control',
    );
    const observation = data.events.find(event => {
      return event.event === 'c5Observations';
    });
    assert(
      observation?.before?.owner?.pid,
      'The replacement owner was not observed',
    );
    assert.equal(
      observation.after,
      undefined,
      'The expected new-lock removal was not observed',
    );
    assert.equal(observation.thirdResult.status, 'success');
    return {expectedFailure: true};
  }
  assert.equal(status, 0, `Harness failed: ${kind}`);
  for (const result of data.results) {
    assert.equal(result.status, 'pass', `${kind}: ${result.id}`);
  }
  const perf = data.results.find(result => {
    return result.id === 'PERF';
  }).observation;
  assert.equal(perf.iterations, 128);
  return {
    passed: data.results.length,
    performance: {
      cacheHit: perf.cacheHit,
      acquisition: perf.acquisition,
      first16: perf.first16,
      last16: perf.last16,
      storage: perf.storage,
    },
  };
}

function runIntegration(inputs) {
  const session = fs.mkdtempSync(path.join(output, 'integration-'));
  writeJson(path.join(session, 'inputs.json'), inputs);
  const cases = [
    {
      kind: 'generation',
      mode: 'generation',
      selection: 'C0,C1,C2,C3,C4,C5,C6,C7,15318,PERF,DISCOVERY',
    },
    {kind: 'none', mode: 'none', selection: 'C0,PERF,DISCOVERY'},
    {kind: 'baseline', mode: 'baseline', selection: 'C0,C1,PERF,DISCOVERY'},
    {kind: 'negative-control', mode: 'baseline', selection: 'C5'},
  ];
  const results = [];
  for (const run of cases) {
    const root = path.join(session, run.kind);
    fs.mkdirSync(root);
    const child = spawnSync(
      process.execPath,
      [
        path.join(
          import.meta.dirname,
          'staging-lock-integration-2026-10-08.mjs',
        ),
        `--repo=${repo}`,
        `--mode=${run.mode}`,
        `--cases=${run.selection}`,
      ],
      {
        cwd: repo,
        encoding: 'utf8',
        timeout: 120_000,
        maxBuffer: 32 * 1024 * 1024,
        env: {
          ...process.env,
          PUPPETEER_RESEARCH_REPO: repo,
          PUPPETEER_RESEARCH_OUTPUT: root,
        },
      },
    );
    fs.writeFileSync(path.join(root, 'harness.stdout.log'), child.stdout ?? '');
    fs.writeFileSync(path.join(root, 'harness.stderr.log'), child.stderr ?? '');
    process.stdout.write(child.stdout ?? '');
    process.stderr.write(child.stderr ?? '');
    const result = {
      kind: run.kind,
      exitCode: child.status,
      signal: child.signal,
    };
    try {
      assert.equal(child.error, undefined);
      const directories = fs
        .readdirSync(root, {withFileTypes: true})
        .filter(entry => {
          return entry.isDirectory();
        });
      assert.equal(directories.length, 1, 'Expected one fresh harness output');
      const file = path.join(root, directories[0].name, 'results.json');
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(data.mode, run.mode);
      Object.assign(
        result,
        validateResult(run.kind, child.status, data, inputs.head),
        {
          status: 'pass',
          evidence: path.relative(session, file),
          evidenceSha256: hash(file),
        },
      );
    } catch (error) {
      Object.assign(result, {
        status: 'fail',
        error: error.message,
        stack: error.stack,
      });
    }
    results.push(result);
  }
  writeJson(path.join(session, 'summary.json'), {
    at: new Date().toISOString(),
    head: inputs.head,
    platform: process.platform,
    architecture: process.arch,
    results,
  });
  console.log(`Validation evidence: ${session}`);
  assert(
    results.every(result => {
      return result.status === 'pass';
    }),
    'Integration validation failed; inspect summary.json and raw evidence',
  );
}

assert(
  ['verify', 'integration'].includes(command),
  'Use verify or integration',
);
assert(output && path.isAbsolute(output), 'Set an absolute --output directory');
fs.mkdirSync(output, {recursive: true});
const inputs = verifyInputs();
if (command === 'verify') {
  writeJson(path.join(output, 'verified-inputs.json'), inputs);
  console.log(`Verified MI1 input hashes at ${inputs.head}`);
} else {
  runIntegration(inputs);
}
