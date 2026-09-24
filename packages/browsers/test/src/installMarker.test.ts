/**
 * @license
 * Copyright 2026 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  INSTALL_MARKER_FILE,
  InvalidInstallMarkerError,
  readInstallMarker,
  writeInstallMarker,
} from '../../lib/installMarker.js';

describe('install marker', () => {
  let tmpDir: string;
  let installationDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-installation-'));
    installationDir = path.join(tmpDir, 'installation');
    fs.mkdirSync(installationDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  });

  it('returns undefined for a legacy installation', () => {
    assert.strictEqual(readInstallMarker(installationDir), undefined);
  });

  it('writes and reads a valid marker', () => {
    const relativeExecutablePath = path.join('browser', 'executable');
    const executablePath = path.join(installationDir, relativeExecutablePath);
    fs.mkdirSync(path.dirname(executablePath), {recursive: true});
    fs.writeFileSync(executablePath, 'browser');

    writeInstallMarker(installationDir, relativeExecutablePath);

    assert.deepStrictEqual(readInstallMarker(installationDir), {
      version: 1,
      relativeExecutablePath,
      executablePath,
    });
  });

  it('allows unknown fields in version 1', () => {
    const relativeExecutablePath = 'executable';
    fs.writeFileSync(path.join(installationDir, relativeExecutablePath), '');
    writeMarker({
      version: 1,
      relativeExecutablePath,
      futureField: true,
    });

    assert.strictEqual(
      readInstallMarker(installationDir)?.relativeExecutablePath,
      relativeExecutablePath,
    );
  });

  for (const [name, marker] of [
    ['non-object JSON', []],
    ['unknown version', {version: 2, relativeExecutablePath: 'executable'}],
    ['missing executable path', {version: 1}],
    ['empty executable path', {version: 1, relativeExecutablePath: ''}],
    [
      'absolute executable path',
      {version: 1, relativeExecutablePath: path.resolve('executable')},
    ],
    [
      'escaping executable path',
      {version: 1, relativeExecutablePath: path.join('..', 'executable')},
    ],
  ] as const) {
    it(`rejects ${name}`, () => {
      writeMarker(marker);
      assert.throws(() => {
        readInstallMarker(installationDir);
      }, InvalidInstallMarkerError);
    });
  }

  it('rejects malformed JSON', () => {
    fs.writeFileSync(markerPath(), '{');
    assert.throws(() => {
      readInstallMarker(installationDir);
    }, InvalidInstallMarkerError);
  });

  it('rejects a marker symlink', () => {
    const markerTarget = path.join(tmpDir, 'marker-target');
    fs.mkdirSync(markerTarget);
    fs.symlinkSync(markerTarget, markerPath(), 'junction');

    assert.throws(() => {
      readInstallMarker(installationDir);
    }, InvalidInstallMarkerError);
  });

  it('does not replace an archive-provided marker', () => {
    const relativeExecutablePath = 'executable';
    fs.writeFileSync(path.join(installationDir, relativeExecutablePath), '');
    writeMarker({version: 1, relativeExecutablePath});

    assert.throws(
      () => {
        writeInstallMarker(installationDir, relativeExecutablePath);
      },
      {code: 'EEXIST'},
    );
  });

  it('rejects an executable outside the installation through a junction', () => {
    const externalDir = path.join(tmpDir, 'external');
    fs.mkdirSync(externalDir);
    fs.writeFileSync(path.join(externalDir, 'executable'), '');
    fs.symlinkSync(
      externalDir,
      path.join(installationDir, 'external'),
      'junction',
    );
    writeMarker({
      version: 1,
      relativeExecutablePath: path.join('external', 'executable'),
    });

    assert.throws(() => {
      readInstallMarker(installationDir);
    }, InvalidInstallMarkerError);
  });

  it('allows a relocatable relative symlink inside the tree', function () {
    const realDir = path.join(installationDir, 'real');
    fs.mkdirSync(realDir);
    fs.writeFileSync(path.join(realDir, 'executable'), '');
    try {
      fs.symlinkSync('real', path.join(installationDir, 'linked'), 'dir');
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'EPERM'
      ) {
        this.skip();
      }
      throw error;
    }
    const relativeExecutablePath = path.join('linked', 'executable');
    writeInstallMarker(installationDir, relativeExecutablePath);

    assert.strictEqual(
      readInstallMarker(installationDir)?.executablePath,
      path.join(installationDir, relativeExecutablePath),
    );

    const publishedDir = path.join(tmpDir, 'published');
    fs.renameSync(installationDir, publishedDir);
    installationDir = publishedDir;
    assert.strictEqual(
      readInstallMarker(installationDir)?.executablePath,
      path.join(installationDir, relativeExecutablePath),
    );
  });

  function markerPath(): string {
    return path.join(installationDir, INSTALL_MARKER_FILE);
  }

  function writeMarker(marker: unknown): void {
    fs.writeFileSync(markerPath(), JSON.stringify(marker));
  }
});
