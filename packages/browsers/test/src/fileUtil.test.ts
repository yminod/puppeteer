/**
 * @license
 * Copyright 2025 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  extractZipWithYauzl,
  internalConstantsForTesting,
  unpackArchive,
  unpackArchiveWithCleanupState,
} from '../../lib/fileUtil.js';

describe('fileUtil', function () {
  let tmpDir = '/tmp/puppeteer-browsers-test';

  const fixturesPath = path.join(import.meta.dirname, '..', 'fixtures');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-browsers-test'));
  });

  afterEach(async () => {
    try {
      fs.rmSync(tmpDir, {
        force: true,
        recursive: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    } catch {}
  });

  function assertTestArchiveUnpacked(): void {
    const dir = fs
      .readdirSync(tmpDir, {
        recursive: true,
      })
      .filter(item => {
        return !(item as string).startsWith('._');
      });
    assert.deepStrictEqual(dir, [
      'test',
      path.join('test', 'folder'),
      path.join('test', 'main.txt'),
      path.join('test', 'run.sh'),
      path.join('test', 'folder', 'folder.txt'),
    ]);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, 'test/main.txt'), 'utf8'),
      'main',
    );
    const modes = dir.map(item => {
      return (
        fs.statSync(path.join(tmpDir, item)).mode &
        (fs.constants.S_IRWXU | fs.constants.S_IRWXG | fs.constants.S_IRWXO)
      ).toString(8);
    });
    assert.deepStrictEqual(
      modes,
      os.platform() === 'win32'
        ? ['0', '0', '0', '0', '0']
        : ['750', '750', '750', '751', '750'],
    );
  }

  function assertTestArchiveEmpty(): void {
    const dir = fs.readdirSync(tmpDir, {
      recursive: true,
    });
    assert.deepStrictEqual(dir, []);
  }

  function assertTestZipUnpacked(): void {
    const entries = fs
      .readdirSync(tmpDir, {recursive: true})
      .filter(item => {
        return !(item as string).startsWith('._');
      })
      .sort();
    assert.deepStrictEqual(entries, [
      'browser',
      path.join('browser', 'chrome'),
      path.join('browser', 'locales'),
      path.join('browser', 'locales', 'en-US.pak'),
      path.join('browser', 'product_logo.png'),
    ]);
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, 'browser/locales/en-US.pak'), 'utf8'),
      'resource',
    );
    assert.strictEqual(
      fs.readFileSync(path.join(tmpDir, 'browser/product_logo.png'), 'utf8'),
      'logo',
    );
  }

  function assertOwnerPermissions(): void {
    const executable = fs.statSync(path.join(tmpDir, 'browser/chrome')).mode;
    assert.strictEqual(executable & 0o700, 0o700);
    const regular = fs.statSync(
      path.join(tmpDir, 'browser/product_logo.png'),
    ).mode;
    assert.strictEqual(regular & 0o700, 0o600);
  }

  function assertSymlink(): void {
    const link = path.join(tmpDir, 'browser/Current');
    assert.ok(fs.lstatSync(link).isSymbolicLink());
    assert.strictEqual(fs.readlinkSync(link), 'chrome');
  }

  it('unpacks tar.xz', async () => {
    await unpackArchive(path.join(fixturesPath, 'test.tar.xz'), tmpDir);
    assertTestArchiveUnpacked();
  });

  it('unpacks tar.bz2', async () => {
    await unpackArchive(path.join(fixturesPath, 'test.tar.bz2'), tmpDir);
    assertTestArchiveUnpacked();
  });

  it('unpacks zip extracting every entry with its structure and contents', async () => {
    await unpackArchive(path.join(fixturesPath, 'test.zip'), tmpDir);
    assertTestZipUnpacked();
  });

  describe('extractZipWithYauzl', () => {
    it('extracts every entry with its structure and contents', async () => {
      await extractZipWithYauzl(path.join(fixturesPath, 'test.zip'), tmpDir);
      assertTestZipUnpacked();
    });

    it('resolves after closing the archive', async () => {
      const archivePath = path.join(tmpDir, 'archive.zip');
      const renamedPath = path.join(tmpDir, 'closed.zip');
      const outputPath = path.join(tmpDir, 'output');
      fs.copyFileSync(path.join(fixturesPath, 'test.zip'), archivePath);

      await extractZipWithYauzl(archivePath, outputPath);
      fs.renameSync(archivePath, renamedPath);
    });

    // Node.js does not honor POSIX permission bits on Windows.
    (os.platform() === 'win32' ? it.skip : it)(
      'preserves owner permissions',
      async () => {
        await extractZipWithYauzl(path.join(fixturesPath, 'test.zip'), tmpDir);
        assertOwnerPermissions();
      },
    );

    // Creating symlinks on Windows requires elevated privileges.
    (os.platform() === 'win32' ? it.skip : it)(
      'preserves symlinks',
      async () => {
        await extractZipWithYauzl(
          path.join(fixturesPath, 'test-symlink.zip'),
          tmpDir,
        );
        assertSymlink();
      },
    );

    // The target is validated before any symlink is created, so unlike the
    // preceding symlink test the rejection can be checked on Windows too.
    it('rejects symlinks that point outside the target directory', async () => {
      const archivePath = path.join(tmpDir, 'escape.zip');
      const renamedPath = path.join(tmpDir, 'closed-escape.zip');
      fs.copyFileSync(
        path.join(fixturesPath, 'test-symlink-escape.zip'),
        archivePath,
      );
      await assert.rejects(
        () => {
          return extractZipWithYauzl(archivePath, tmpDir);
        },
        (error: unknown) => {
          const {cause} = error as {cause?: Error};
          assert.match(cause?.message ?? '', /point outside/);
          return true;
        },
      );
      assert.ok(
        !fs.existsSync(path.join(tmpDir, 'browser', 'evil-link')),
        'symlink pointing outside the target directory was created',
      );
      fs.renameSync(archivePath, renamedPath);
    });
  });

  describe('DMG cleanup', () => {
    const originalDmgExecFile = internalConstantsForTesting.dmgExecFile;
    const originalDmgReaddir = internalConstantsForTesting.dmgReaddir;
    const originalDelay = internalConstantsForTesting.delay;
    const originalDetachAttempts =
      internalConstantsForTesting.dmgDetachAttempts;
    const originalDetachRetryDelay =
      internalConstantsForTesting.dmgDetachRetryDelay;

    afterEach(() => {
      internalConstantsForTesting.dmgExecFile = originalDmgExecFile;
      internalConstantsForTesting.dmgReaddir = originalDmgReaddir;
      internalConstantsForTesting.delay = originalDelay;
      internalConstantsForTesting.dmgDetachAttempts = originalDetachAttempts;
      internalConstantsForTesting.dmgDetachRetryDelay =
        originalDetachRetryDelay;
    });

    it('retries detach and reports a released mount after a transient failure', async () => {
      let detachCalls = 0;
      const delays: number[] = [];
      internalConstantsForTesting.dmgReaddir = async () => {
        return ['Firefox.app'];
      };
      internalConstantsForTesting.delay = async milliseconds => {
        delays.push(milliseconds);
      };
      internalConstantsForTesting.dmgExecFile = async (file, args) => {
        if (file === 'cp') {
          return {stdout: '', stderr: ''};
        }
        if (args[0] === 'attach') {
          return {stdout: '/dev/disk1\t/Volumes/Firefox\n', stderr: ''};
        }
        if (args[0] === 'detach') {
          if (++detachCalls < 3) {
            throw new Error('resource busy');
          }
          return {stdout: '', stderr: ''};
        }
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
      };

      const outcome = await unpackArchiveWithCleanupState(
        path.join(tmpDir, 'firefox.dmg'),
        path.join(tmpDir, 'output'),
      );

      assert.deepStrictEqual(outcome, {
        status: 'success',
        isSafeToCleanup: true,
      });
      assert.strictEqual(detachCalls, 3);
      assert.deepStrictEqual(delays, [1000, 1000]);
    });

    it('preserves copy success when detach retries are exhausted', async () => {
      let detachCalls = 0;
      const messages: string[] = [];
      internalConstantsForTesting.dmgReaddir = async () => {
        return ['Firefox.app'];
      };
      internalConstantsForTesting.delay = async () => {};
      internalConstantsForTesting.dmgExecFile = async (file, args) => {
        if (file === 'cp') {
          return {stdout: '', stderr: ''};
        }
        if (args[0] === 'attach') {
          return {stdout: '/dev/disk1\t/Volumes/Firefox\n', stderr: ''};
        }
        if (args[0] === 'detach') {
          ++detachCalls;
          throw new Error('resource busy');
        }
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
      };

      const outcome = await unpackArchiveWithCleanupState(
        path.join(tmpDir, 'firefox.dmg'),
        path.join(tmpDir, 'output'),
        () => {
          return (...args: unknown[]) => {
            messages.push(args.join(' '));
          };
        },
      );

      assert.deepStrictEqual(outcome, {
        status: 'success',
        isSafeToCleanup: false,
      });
      assert.strictEqual(detachCalls, 3);
      assert.ok(
        messages.some(message => {
          return message.includes('Retaining DMG mount');
        }),
      );
    });

    it('preserves the copy error when detach retries are exhausted', async () => {
      const copyError = new Error('copy failed');
      let detachCalls = 0;
      internalConstantsForTesting.dmgReaddir = async () => {
        return ['Firefox.app'];
      };
      internalConstantsForTesting.delay = async () => {};
      internalConstantsForTesting.dmgExecFile = async (file, args) => {
        if (file === 'cp') {
          throw copyError;
        }
        if (args[0] === 'attach') {
          return {stdout: '/dev/disk1\t/Volumes/Firefox\n', stderr: ''};
        }
        if (args[0] === 'detach') {
          ++detachCalls;
          throw new Error('resource busy');
        }
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
      };

      const outcome = await unpackArchiveWithCleanupState(
        path.join(tmpDir, 'firefox.dmg'),
        path.join(tmpDir, 'output'),
      );

      assert.strictEqual(outcome.status, 'error');
      if (outcome.status === 'error') {
        assert.strictEqual(outcome.error, copyError);
      }
      assert.strictEqual(outcome.isSafeToCleanup, false);
      assert.strictEqual(detachCalls, 3);
    });

    it('reports a failed copy as cleanup-safe after detach succeeds', async () => {
      const copyError = new Error('copy failed');
      internalConstantsForTesting.dmgReaddir = async () => {
        return ['Firefox.app'];
      };
      internalConstantsForTesting.dmgExecFile = async (file, args) => {
        if (file === 'cp') {
          throw copyError;
        }
        if (args[0] === 'attach') {
          return {stdout: '/dev/disk1\t/Volumes/Firefox\n', stderr: ''};
        }
        if (args[0] === 'detach') {
          return {stdout: '', stderr: ''};
        }
        throw new Error(`Unexpected command: ${file} ${args.join(' ')}`);
      };

      const outcome = await unpackArchiveWithCleanupState(
        path.join(tmpDir, 'firefox.dmg'),
        path.join(tmpDir, 'output'),
      );

      assert.strictEqual(outcome.status, 'error');
      if (outcome.status === 'error') {
        assert.strictEqual(outcome.error, copyError);
      }
      assert.strictEqual(outcome.isSafeToCleanup, true);
    });
  });

  it('rejects a non-zero decompressor after closing the archive', async () => {
    const archivePath = path.join(tmpDir, 'input.tar.xz');
    const renamedPath = path.join(tmpDir, 'closed.tar.xz');
    const outputPath = path.join(tmpDir, 'output');
    fs.copyFileSync(path.join(fixturesPath, 'test.tar.xz'), archivePath);
    internalConstantsForTesting.xz = process.execPath;
    try {
      await assert.rejects(
        unpackArchive(archivePath, outputPath),
        /`xz` exited with code/,
      );
      fs.renameSync(archivePath, renamedPath);
    } finally {
      internalConstantsForTesting.xz = 'xz';
    }
  });

  it('throws an error if xz is not found', async () => {
    internalConstantsForTesting.xz = 'xz-not-existent';
    try {
      try {
        await unpackArchive(path.join(fixturesPath, 'test.tar.xz'), tmpDir);
        assert.fail('unpacking did not fail');
      } catch (error) {
        assert.equal(
          (error as Error).message,
          '`xz` utility is required to unpack this archive',
        );
      }
      assertTestArchiveEmpty();
    } finally {
      internalConstantsForTesting.xz = 'xz';
    }
  });

  it('throws an error if bzip2 is not found', async () => {
    internalConstantsForTesting.bzip2 = 'bzip2-not-existent';
    try {
      try {
        await unpackArchive(path.join(fixturesPath, 'test.tar.bz2'), tmpDir);
        assert.fail('unpacking did not fail');
      } catch (error) {
        assert.equal(
          (error as Error).message,
          '`bzip2` utility is required to unpack this archive',
        );
      }
      assertTestArchiveEmpty();
    } finally {
      internalConstantsForTesting.bzip2 = 'bzip2';
    }
  });
});
