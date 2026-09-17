/**
 * @license
 * Copyright 2024 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {writeInstallMarker} from '../../lib/installMarker.js';
import {Browser, BrowserPlatform, Cache} from '../../lib/main.js';

describe('Cache', () => {
  let tmpDir = '/tmp/puppeteer-browsers-test';
  let cache: Cache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-browsers-test'));
    cache = new Cache(tmpDir);
  });

  afterEach(() => {
    cache.clear();
  });

  it('return empty metadata if .metadata file does not exist', async function () {
    assert.deepStrictEqual(cache.readMetadata(Browser.CHROME), {
      aliases: {},
    });
  });

  it('throw an error if .metadata is malformed', async function () {
    // @ts-expect-error wrong type on purpose;
    cache.writeMetadata(Browser.CHROME, 'metadata');
    assert.throws(() => {
      return cache.readMetadata(Browser.CHROME);
    }, new Error(`.metadata is not an object`));
  });

  it('writes and reads .metadata', async function () {
    cache.writeMetadata(Browser.CHROME, {
      aliases: {
        canary: '123.0.0.0',
      },
    });
    assert.deepStrictEqual(cache.readMetadata(Browser.CHROME), {
      aliases: {
        canary: '123.0.0.0',
      },
    });

    assert.deepStrictEqual(
      cache.resolveAlias(Browser.CHROME, 'canary'),
      '123.0.0.0',
    );
  });

  it('resolves latest', async function () {
    cache.writeMetadata(Browser.CHROME, {
      aliases: {
        canary: '115.0.5789',
        stable: '114.0.5789',
      },
    });

    assert.deepStrictEqual(
      cache.resolveAlias(Browser.CHROME, 'latest'),
      '115.0.5789',
    );
  });

  it('prefers the executable path from the install marker', () => {
    const buildId = '123.0.0.0';
    const installationDir = cache.installationDir(
      Browser.CHROME,
      BrowserPlatform.LINUX,
      buildId,
    );
    const relativeExecutablePath = path.join('custom', 'chrome');
    const executablePath = path.join(installationDir, relativeExecutablePath);
    fs.mkdirSync(path.dirname(executablePath), {recursive: true});
    fs.writeFileSync(executablePath, '');
    cache.writeExecutablePath(
      Browser.CHROME,
      BrowserPlatform.LINUX,
      buildId,
      path.join('stale', 'chrome'),
    );
    writeInstallMarker(installationDir, relativeExecutablePath);

    assert.strictEqual(
      cache.computeExecutablePath({
        browser: Browser.CHROME,
        platform: BrowserPlatform.LINUX,
        buildId,
      }),
      executablePath,
    );
  });

  it('does not fall back when the install marker is invalid', () => {
    const buildId = '123.0.0.0';
    const installationDir = cache.installationDir(
      Browser.CHROME,
      BrowserPlatform.LINUX,
      buildId,
    );
    fs.mkdirSync(installationDir, {recursive: true});
    fs.writeFileSync(
      path.join(installationDir, '.puppeteer-install'),
      JSON.stringify({
        version: 2,
        relativeExecutablePath: path.join('custom', 'chrome'),
      }),
    );
    cache.writeExecutablePath(
      Browser.CHROME,
      BrowserPlatform.LINUX,
      buildId,
      path.join('legacy', 'chrome'),
    );

    assert.throws(() => {
      cache.computeExecutablePath({
        browser: Browser.CHROME,
        platform: BrowserPlatform.LINUX,
        buildId,
      });
    }, /unsupported marker version/);
  });

  it('does not overwrite malformed global metadata during an update', () => {
    const metadataPath = cache.metadataFile(Browser.CHROME);
    fs.mkdirSync(path.dirname(metadataPath), {recursive: true});
    fs.writeFileSync(metadataPath, '{');

    assert.throws(() => {
      cache.writeAlias(Browser.CHROME, 'stable', '123.0.0.0');
    });
    assert.strictEqual(fs.readFileSync(metadataPath, 'utf8'), '{');
  });

  it('leaves no metadata temp file after an atomic update', () => {
    cache.writeAlias(Browser.CHROME, 'stable', '123.0.0.0');

    assert.deepStrictEqual(fs.readdirSync(cache.browserRoot(Browser.CHROME)), [
      '.metadata',
    ]);
  });
});
