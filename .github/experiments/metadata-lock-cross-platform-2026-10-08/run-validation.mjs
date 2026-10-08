/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// Transport and audit the unchanged WI3/MM1 inputs in fresh canonical worktrees.
import assert from 'node:assert/strict';
import {execFileSync, spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const transport = path.resolve(import.meta.dirname, '../../..');
const fixture = readJson(path.join(import.meta.dirname, 'fixture.json'));
const manifest = readJson(
  path.join(
    import.meta.dirname,
    'metadata-lock-cross-platform-inputs-2026-10-08.json',
  ),
);
const command = process.argv[2];
const allowDirty = process.argv.includes('--allow-dirty');
const requireLinux = process.argv.includes('--require-linux-ext4');
const baseline = option('baseline');
const candidate = option('candidate');
const output = option('output');
const built = (option('built') ?? '').split(',').filter(Boolean);

function option(name) {
  return process.argv
    .find(arg => {
      return arg.startsWith(`--${name}=`);
    })
    ?.slice(name.length + 3);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, {flag: 'wx'});
}

function hash(file, normalized = false) {
  const data = normalized
    ? fs.readFileSync(file, 'utf8').replaceAll('\r\n', '\n')
    : fs.readFileSync(file);
  return createHash('sha256').update(data).digest('hex');
}

function git(repo, ...args) {
  return execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
}

function verifyInputs() {
  assert.equal(fixture.version, 1);
  assert.equal(process.version, fixture.node);
  assert.equal(
    execFileSync('npm', ['--version'], {encoding: 'utf8'}).trim(),
    fixture.npm,
  );
  const head = git(transport, 'rev-parse', 'HEAD');
  const status = git(transport, 'status', '--porcelain=v1');
  if (process.env.GITHUB_ACTIONS === 'true') {
    assert.equal(allowDirty, false, 'CI must use a clean committed transport');
    assert.equal(head, process.env.GITHUB_SHA);
    assert.equal(
      process.env.GITHUB_REF,
      `refs/heads/${fixture.experimentBranch}`,
    );
  }
  if (!allowDirty) {
    assert.equal(status, '', 'Transport has unexpected changes');
  }
  git(transport, 'merge-base', '--is-ancestor', fixture.transportBase, 'HEAD');
  const changes = new Set([
    ...git(transport, 'diff', '--name-only', fixture.transportBase)
      .split('\n')
      .filter(Boolean),
    ...git(transport, 'ls-files', '--others', '--exclude-standard')
      .split('\n')
      .filter(Boolean),
  ]);
  assert.deepEqual(
    [...changes].sort(),
    fixture.transportFiles,
    'Only the eight new CI transport files may change',
  );
  for (const file of fixture.frozenFiles) {
    assert.equal(
      hash(path.join(transport, file.path)),
      file.sha256,
      `Frozen harness changed: ${file.path}`,
    );
  }
  const inputs = {};
  for (const [role, repo] of Object.entries({baseline, candidate})) {
    assert.equal(
      git(repo, 'rev-parse', 'HEAD'),
      manifest[role].commit,
      `${role} must use the exact canonical commit`,
    );
    assert.equal(
      git(repo, 'status', '--porcelain=v1'),
      '',
      `${role} must stay clean`,
    );
    assert.equal(
      git(repo, 'branch', '--show-current'),
      '',
      `${role} must be detached`,
    );
    assert.deepEqual(
      git(repo, 'diff', '--name-only', manifest.base).split('\n'),
      manifest[role].files.slice(0, 2).map(file => {
        return file.file;
      }),
    );
    git(
      repo,
      'cat-file',
      '-e',
      `${fixture.upstreamDiscoveryCommit}:packages/browsers/src/Cache.ts`,
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
    const files = manifest[role].files
      .filter(file => {
        return built.includes(role) || !file.file.includes('/lib/');
      })
      .map(file => {
        const full = path.join(repo, file.file);
        const normalizedSha256 = hash(full, true);
        assert.equal(
          normalizedSha256,
          file.normalizedSha256,
          `${role}: ${file.file}`,
        );
        return {file: file.file, sha256: hash(full), normalizedSha256};
      });
    inputs[role] = {repo, head: manifest[role].commit, status: '', files};
  }
  let filesystems;
  if (requireLinux) {
    assert.equal(process.platform, 'linux');
    assert.equal(process.arch, 'x64');
    assert.notEqual(os.userInfo().uid, 0, 'Run as a non-root user');
    filesystems = [transport, baseline, candidate, output].map(target => {
      const type = execFileSync(
        'findmnt',
        ['-n', '-o', 'FSTYPE', '-T', target],
        {encoding: 'utf8'},
      ).trim();
      assert.equal(type, 'ext4', `Unexpected filesystem: ${target}`);
      return {path: target, type};
    });
  }
  return {
    transport: {repo: transport, head, status},
    inputs,
    filesystems,
    transportFiles: fixture.transportFiles.map(file => {
      return {
        file,
        sha256: hash(path.join(transport, file)),
      };
    }),
  };
}

function validateC5(data, negative) {
  const observations = data.events.filter(event => {
    return event.event === 'c5Observations';
  });
  assert.equal(observations.length, 1);
  const value = observations[0];
  assert(value.before?.owner?.pid, 'Replacement owner was not observed');
  assert.deepEqual(value.oldResult.value, value.replacementResult);
  assert.equal(value.oldAttemptCleaned, true);
  if (negative) {
    assert.match(
      data.results[0].error.message,
      /Old generation changed or removed the held new lock/,
    );
    assert.equal(value.after, undefined, 'Expected held-new-lock removal');
    assert.equal(value.thirdResult.status, 'success');
  } else {
    assert.deepEqual(value.before, value.after);
    assert.equal(value.thirdResult.status, 'error');
    assert.equal(value.thirdResult.error.reason, 'owner-alive');
    assert.equal(
      data.events.some(event => {
        return event.event === 'entered' && event.pid === value.thirdResult.pid;
      }),
      false,
    );
  }
  for (const file of value.finalContents) {
    if (file.sha256) {
      assert.equal(
        hash(path.join(value.replacementResult.path, file.path)),
        file.sha256,
      );
    }
  }
  return value;
}

function auditMetadata(data) {
  const paths = data.results.find(result => {
    return result.id === 'C0.separate';
  }).observation.paths;
  assert.equal(paths.length, 2);
  assert.notEqual(paths[0], paths[1]);
  const metadataPath = path.join(path.dirname(paths[0]), '.metadata');
  const metadata = readJson(metadataPath);
  const installations = paths.map((directory, index) => {
    const key = `linux-${index === 0 ? '123' : '456'}`;
    assert.equal(path.basename(directory), key);
    assert(fs.statSync(directory).isDirectory());
    const markerPath = path.join(directory, '.puppeteer-install');
    assert(fs.lstatSync(markerPath).isFile());
    const marker = readJson(markerPath);
    assert.equal(marker.version, 1);
    assert(
      typeof marker.relativeExecutablePath === 'string' &&
        marker.relativeExecutablePath.length,
    );
    assert.equal(path.isAbsolute(marker.relativeExecutablePath), false);
    const executable = path.join(directory, marker.relativeExecutablePath);
    const relative = path.relative(
      fs.realpathSync(directory),
      fs.realpathSync(executable),
    );
    assert(
      !relative.startsWith(`..${path.sep}`) &&
        relative !== '..' &&
        !path.isAbsolute(relative),
    );
    assert(fs.statSync(executable).isFile());
    assert.equal(metadata.executablePaths[key], marker.relativeExecutablePath);
    const identityPath = path.join(directory, 'identity.txt');
    assert.equal(
      fs.readFileSync(identityPath, 'utf8'),
      index === 0 ? 'payload-old\n' : 'payload-new\n',
    );
    assert.equal(
      fs.existsSync(path.join(path.dirname(directory), '.metadata.lock')),
      false,
    );
    return {
      directory,
      key,
      marker,
      markerSha256: hash(markerPath),
      executableSha256: hash(executable),
      identitySha256: hash(identityPath),
    };
  });
  return {
    metadataPath,
    metadataSha256: hash(metadataPath),
    entries: metadata.executablePaths,
    installations,
  };
}

function validateIntegration(kind, child, data, mode, selection) {
  assert.equal(data.sourceState.head, manifest.candidate.commit);
  assert.equal(data.sourceState.status, '');
  assert.deepEqual(data.sourceState.untracked, []);
  assert.equal(
    data.sourceState.trackedPatchSha256,
    createHash('sha256').update('').digest('hex'),
  );
  assert.equal(data.repo, candidate);
  assert.equal(data.platform, process.platform);
  assert.equal(data.arch, process.arch);
  assert.equal(data.node, fixture.node);
  assert.equal(data.mode, mode);
  assert.deepEqual(data.selected, selection.split(','));
  assert.deepEqual(
    data.results.map(result => {
      return result.id;
    }),
    fixture.expectedCases[kind],
  );
  const negative = kind === 'negative-control';
  assert.equal(child.status, negative ? 1 : 0);
  assert(
    data.results.every(result => {
      return result.status === (negative ? 'fail' : 'pass');
    }),
  );
  if (negative) {
    return {expectedFailure: true, c5: validateC5(data, true)};
  }
  const perf = data.results.find(result => {
    return result.id === 'PERF';
  }).observation;
  assert.equal(perf.iterations, 128);
  return {
    passed: data.results.length,
    metadataCompleteness: auditMetadata(data),
    c5: kind === 'generation' ? validateC5(data, false) : undefined,
    performance: {
      cacheHit: perf.cacheHit,
      acquisition: perf.acquisition,
      first16: perf.first16,
      last16: perf.last16,
      storage: perf.storage,
    },
  };
}

function execute(script, args, label, session, extraEnv = {}) {
  const child = spawnSync(
    process.execPath,
    [path.join(import.meta.dirname, script), ...args],
    {
      cwd: transport,
      encoding: 'utf8',
      timeout: 180_000,
      maxBuffer: 32 * 1024 * 1024,
      env: {...process.env, ...extraEnv},
    },
  );
  fs.writeFileSync(
    path.join(session, `${label}.stdout.log`),
    child.stdout ?? '',
    {flag: 'wx'},
  );
  fs.writeFileSync(
    path.join(session, `${label}.stderr.log`),
    child.stderr ?? '',
    {flag: 'wx'},
  );
  writeJson(path.join(session, `${label}-command.json`), {
    node: process.execPath,
    script,
    args,
    cwd: transport,
    extraEnv,
    exitCode: child.status,
    signal: child.signal,
    error: child.error?.message,
  });
  process.stdout.write(child.stdout ?? '');
  process.stderr.write(child.stderr ?? '');
  assert.equal(child.error, undefined);
  return child;
}

function validateFocused(child, directory) {
  assert.equal(child.status, 0);
  const summary = readJson(path.join(directory, 'summary.json'));
  assert.deepEqual(summary, {
    cases: 28,
    failed: 0,
    baselineLostUpdates: 10,
    candidateDifferentBuilds: 10,
  });
  const results = readJson(path.join(directory, 'results.json'));
  assert.deepEqual(
    results.map(result => {
      return result.name;
    }),
    fixture.expectedFocusedCases,
  );
  assert(
    results.every(result => {
      return result.success;
    }),
  );
  const environment = readJson(path.join(directory, 'environment.json'));
  assert.equal(environment.platform, process.platform);
  assert.equal(environment.architecture, process.arch);
  assert.equal(environment.node, fixture.node);
  if (requireLinux) {
    assert.equal(environment.browserPlatform, 'linux');
  }
  const timeouts = [];
  for (const result of results) {
    for (const operation of ['value', 'failure', 'hitFailure']) {
      const value = result[operation];
      if (
        value?.error?.message.startsWith('Timed out waiting for metadata lock ')
      ) {
        timeouts.push({
          case: result.name,
          operation,
          durationMs: value.duration,
          timerAtMs: value.timerAt,
        });
      }
    }
  }
  assert.equal(timeouts.length, 7);
  return {...summary, browserPlatform: environment.browserPlatform, timeouts};
}

function auditOwnedProcesses(session) {
  const pids = new Set();
  const visit = directory => {
    for (const entry of fs.readdirSync(directory, {withFileTypes: true})) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        visit(file);
      } else if (
        entry.name === 'results.json' ||
        /^worker-.*-trace\.json$/.test(entry.name)
      ) {
        const data = readJson(file);
        for (const event of data.events ?? []) {
          if (event.event === 'ready' || event.role) {
            pids.add(event.pid);
          }
          if (event.event === 'helperStarted') {
            pids.add(event.helperPid);
          }
        }
      }
    }
  };
  visit(session);
  const observations = [...pids]
    .filter(Number.isInteger)
    .sort((a, b) => {
      return a - b;
    })
    .map(pid => {
      try {
        process.kill(pid, 0);
        return {pid, status: 'exists'};
      } catch (error) {
        return {pid, status: error.code === 'ESRCH' ? 'exited' : error.code};
      }
    });
  writeJson(path.join(session, 'process-audit.json'), {observations});
  assert(
    observations.every(value => {
      return value.status === 'exited';
    }),
    'Recorded owned processes remain alive',
  );
}

function runTrials(session) {
  assert.deepEqual([...built].sort(), ['baseline', 'candidate']);
  const results = [];
  const runs = [
    {kind: 'focused'},
    {
      kind: 'generation',
      mode: 'generation',
      selection: 'C0,C1,C2,C3,C4,C5,C6,C7,15318,PERF,DISCOVERY',
    },
    {kind: 'none', mode: 'none', selection: 'C0,PERF,DISCOVERY'},
    {kind: 'baseline', mode: 'baseline', selection: 'C0,C1,PERF,DISCOVERY'},
    {kind: 'negative-control', mode: 'baseline', selection: 'C5'},
  ];
  for (const run of runs) {
    const directory = path.join(session, run.kind);
    const result = {kind: run.kind};
    try {
      let child, observation;
      if (run.kind === 'focused') {
        child = execute(
          'metadata-lock-cross-platform-2026-10-08.mjs',
          [
            `--repo=${candidate}`,
            `--baseline=${baseline}`,
            `--output=${directory}`,
          ],
          run.kind,
          session,
        );
        observation = validateFocused(child, directory);
      } else {
        fs.mkdirSync(directory);
        child = execute(
          'staging-lock-integration-2026-10-08.mjs',
          [`--mode=${run.mode}`, `--cases=${run.selection}`],
          run.kind,
          session,
          {
            PUPPETEER_RESEARCH_REPO: candidate,
            PUPPETEER_RESEARCH_OUTPUT: directory,
          },
        );
        const directories = fs
          .readdirSync(directory, {withFileTypes: true})
          .filter(entry => {
            return entry.isDirectory();
          });
        assert.equal(directories.length, 1);
        const file = path.join(directory, directories[0].name, 'results.json');
        observation = {
          ...validateIntegration(
            run.kind,
            child,
            readJson(file),
            run.mode,
            run.selection,
          ),
          evidence: file,
          evidenceSha256: hash(file),
        };
      }
      Object.assign(result, {
        status: 'pass',
        exitCode: child.status,
        observation,
      });
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
    results,
  });
  auditOwnedProcesses(session);
  assert(
    results.every(result => {
      return result.status === 'pass';
    }),
    'Validation failed; inspect all raw outputs and summary.json',
  );
}

function auditPackage(session) {
  assert(requireLinux, 'Package acceptance requires real Linux/ext4');
  assert(built.includes('candidate'));
  const file = option('log');
  assert(file && path.isAbsolute(file));
  const log = fs.readFileSync(file, 'utf8').replaceAll(/\x1B\[[0-9;]*m/g, '');
  const counts = {};
  for (const kind of ['passing', 'pending', 'failing']) {
    const matches = [
      ...log.matchAll(new RegExp(`(?:^|\\n)\\s+(\\d+) ${kind}\\b`, 'g')),
    ];
    assert(matches.length <= 1);
    counts[kind] = matches.length ? Number(matches[0][1]) : 0;
  }
  writeJson(path.join(session, 'package-counts.json'), {
    file,
    sha256: hash(file),
    counts,
  });
  assert.deepEqual(counts, fixture.expectedLinuxPackage);
  for (const text of fixture.packageLogChecks) {
    assert(log.includes(text), `Missing package evidence: ${text}`);
  }
}

assert(['verify', 'validate', 'package-audit'].includes(command));
for (const directory of [baseline, candidate, output]) {
  assert(directory && path.isAbsolute(directory));
}
assert(
  new Set([
    transport,
    path.resolve(baseline),
    path.resolve(candidate),
    path.resolve(output),
  ]).size === 4,
);
for (const role of built) {
  assert(['baseline', 'candidate'].includes(role));
}
fs.mkdirSync(output, {recursive: true});
const session = fs.mkdtempSync(path.join(output, `${command}-`));
writeJson(path.join(session, 'environment.json'), {
  at: new Date().toISOString(),
  platform: process.platform,
  release: os.release(),
  arch: process.arch,
  node: process.version,
  uid: os.userInfo().uid,
  command,
  built,
});
try {
  const before = verifyInputs();
  writeJson(path.join(session, 'inputs-before.json'), before);
  if (command === 'validate') {
    runTrials(session);
  }
  if (command === 'package-audit') {
    auditPackage(session);
  }
  const after = verifyInputs();
  writeJson(path.join(session, 'inputs-after.json'), after);
  assert.deepEqual(after, before, 'Validation changed a frozen input');
} catch (error) {
  writeJson(path.join(session, 'failure.json'), {
    message: error.message,
    stack: error.stack,
  });
  throw error;
} finally {
  console.log(`Validation evidence: ${session}`);
}
