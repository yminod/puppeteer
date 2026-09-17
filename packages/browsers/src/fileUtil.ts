/**
 * @license
 * Copyright 2023 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import {spawnSync, spawn, execFile} from 'node:child_process';
import {constants, createReadStream, createWriteStream} from 'node:fs';
import {mkdir, readdir, symlink} from 'node:fs/promises';
import * as path from 'node:path';
import {Writable} from 'node:stream';
import {pipeline} from 'node:stream/promises';
import {promisify} from 'node:util';

import type {Entry, Options, ZipFile} from 'yauzl';

import {DEBUG_PREFIXES, type Logger} from './debug.js';

const execFileAsync = promisify(execFile);

/**
 * @internal
 */
export async function unpackArchive(
  archivePath: string,
  folderPath: string,
  logger?: Logger,
): Promise<void> {
  if (!path.isAbsolute(folderPath)) {
    folderPath = path.resolve(process.cwd(), folderPath);
  }
  if (archivePath.endsWith('.zip')) {
    await mkdir(folderPath, {recursive: true});
    await extractZip(archivePath, folderPath, logger);
  } else if (archivePath.endsWith('.tar.bz2')) {
    await extractTar(archivePath, folderPath, 'bzip2', logger);
  } else if (archivePath.endsWith('.dmg')) {
    await mkdir(folderPath);
    await installDMG(archivePath, folderPath);
  } else if (archivePath.endsWith('.exe')) {
    // Firefox on Windows.
    const result = spawnSync(archivePath, [`/ExtractDir=${folderPath}`], {
      env: {
        __compat_layer: 'RunAsInvoker',
      },
    });
    if (result.status !== 0) {
      throw new Error(
        `Failed to extract ${archivePath} to ${folderPath}: ${result.output}`,
      );
    }
  } else if (archivePath.endsWith('.tar.xz')) {
    await extractTar(archivePath, folderPath, 'xz');
  } else {
    throw new Error(`Unsupported archive format: ${archivePath}`);
  }
}

/**
 * @internal
 */
export const internalConstantsForTesting = {
  xz: 'xz',
  bzip2: 'bzip2',
};

/**
 * @internal
 */
async function extractTar(
  tarPath: string,
  folderPath: string,
  decompressUtilityName: keyof typeof internalConstantsForTesting,
  logger?: Logger,
): Promise<void> {
  const {unpackTar} = await import('modern-tar/fs');
  const unpack = spawn(
    internalConstantsForTesting[decompressUtilityName],
    ['-d'],
    {
      stdio: ['pipe', 'pipe', 'inherit'],
    },
  );
  const source = createReadStream(tarPath);
  const tar = unpackTar(folderPath);
  let firstError: Error | undefined;
  let spawnError: Error | undefined;

  const stopProducer = (error: Error): void => {
    firstError ??= error;
    source.destroy();
    unpack.stdin.destroy();
    unpack.stdout.destroy();
    tar.destroy();
    if (
      unpack.pid !== undefined &&
      unpack.exitCode === null &&
      unpack.signalCode === null
    ) {
      try {
        unpack.kill();
      } catch {
        // The close event remains the process-quiescence boundary.
      }
    }
  };

  const childClosed = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>(resolve => {
    unpack.once('error', error => {
      spawnError = normalizeUtilityError(error, decompressUtilityName);
      stopProducer(spawnError);
    });
    unpack.once('close', (code, signal) => {
      logger?.(DEBUG_PREFIXES.fileUtil)?.(
        `${decompressUtilityName} exited, code=${code}, signal=${signal}`,
      );
      resolve({code, signal});
    });
  });

  const input = pipeline(source, unpack.stdin).catch(error => {
    stopProducer(error as Error);
    throw error;
  });
  const output = pipeline(unpack.stdout, tar).catch(error => {
    stopProducer(error as Error);
    throw error;
  });
  const [inputResult, outputResult, childResult] = await Promise.allSettled([
    input,
    output,
    childClosed,
  ]);

  if (spawnError) {
    throw spawnError;
  }
  if (childResult.status === 'rejected') {
    throw childResult.reason;
  }
  if (childResult.value.code !== null && childResult.value.code !== 0) {
    throw new Error(
      `\`${decompressUtilityName}\` exited with ` +
        `code ${childResult.value.code}`,
    );
  }
  if (firstError) {
    throw firstError;
  }
  if (inputResult.status === 'rejected') {
    throw inputResult.reason;
  }
  if (outputResult.status === 'rejected') {
    throw outputResult.reason;
  }
  if (childResult.value.signal) {
    throw new Error(
      `\`${decompressUtilityName}\` exited with signal ${childResult.value.signal}`,
    );
  }
}

function normalizeUtilityError(error: Error, utilityName: string): Error {
  if ('code' in error && error.code === 'ENOENT') {
    return new Error(
      `\`${utilityName}\` utility is required to unpack this archive`,
      {
        cause: error,
      },
    );
  }
  return error;
}

/**
 * @internal
 */
async function installDMG(dmgPath: string, folderPath: string): Promise<void> {
  const {stdout} = await execFileAsync('hdiutil', [
    'attach',
    '-nobrowse',
    '-noautoopen',
    dmgPath,
  ]);

  const volumes = stdout.match(/\/Volumes\/(.*)/m);
  if (!volumes) {
    throw new Error(`Could not find volume path in ${stdout}`);
  }
  const mountPath = volumes[0]!;

  try {
    const fileNames = await readdir(mountPath);
    const appName = fileNames.find(item => {
      return typeof item === 'string' && item.endsWith('.app');
    });
    if (!appName) {
      throw new Error(`Cannot find app in ${mountPath}`);
    }
    const mountedPath = path.join(mountPath!, appName);

    await execFileAsync('cp', ['-R', mountedPath, folderPath]);
  } finally {
    await execFileAsync('hdiutil', ['detach', mountPath, '-quiet']);
  }
}

/**
 * @internal
 */
class ArchiverUnavailableError extends Error {}

/**
 * @internal
 */
async function extractZip(
  archivePath: string,
  folderPath: string,
  logger?: Logger,
): Promise<void> {
  for (const extract of [extractZipWithCli, extractZipWithYauzl]) {
    try {
      await extract(archivePath, folderPath, logger);
      return;
    } catch (error) {
      if (!(error instanceof ArchiverUnavailableError)) {
        throw error;
      }
    }
  }
  throw new Error(
    `Extraction failed: no zip archiver is available. Install \`unzip\` (or \`tar.exe\`/Powershell on Windows), or add the optional \`yauzl\` dependency.`,
  );
}

/**
 * @internal
 */
export async function extractZipWithYauzl(
  archivePath: string,
  folderPath: string,
  _logger?: Logger,
): Promise<void> {
  const {default: yauzl} = await import(
    /* webpackIgnore: true */ 'yauzl'
  ).catch(() => {
    throw new ArchiverUnavailableError(
      'Extraction failed: The optional `yauzl` dependency is not installed.',
    );
  });
  const open = promisify<string, Options, ZipFile>(yauzl.open);
  try {
    const zipFile = await open(archivePath, {lazyEntries: true});
    await new Promise<void>((resolve, reject) => {
      let activeEntry: Promise<void> | undefined;
      let closed = false;
      let ended = false;
      let failure: unknown;
      let settled = false;

      const settle = (): void => {
        if (settled || !closed || activeEntry) {
          return;
        }
        if (failure) {
          settled = true;
          reject(failure);
        } else if (ended) {
          settled = true;
          resolve();
        }
      };
      const fail = (error: unknown): void => {
        failure ??= error;
        zipFile.close();
        settle();
      };

      zipFile
        .on('error', fail)
        .on('close', () => {
          closed = true;
          settle();
        })
        .on('end', () => {
          ended = true;
          zipFile.close();
          settle();
        })
        .on('entry', entry => {
          activeEntry = extractZipEntry(zipFile, entry, folderPath);
          void activeEntry.then(
            () => {
              activeEntry = undefined;
              if (failure) {
                settle();
              } else {
                zipFile.readEntry();
              }
            },
            error => {
              activeEntry = undefined;
              fail(error);
            },
          );
        })
        .readEntry();
    });
  } catch (error) {
    throw new Error(`Extraction failed: ${archivePath}`, {cause: error});
  }
}

/**
 * @internal
 */
async function extractZipWithCli(
  archivePath: string,
  folderPath: string,
  logger?: Logger,
): Promise<void> {
  try {
    if (process.platform === 'win32') {
      const systemRoot =
        process.env['SystemRoot'] ?? process.env['SYSTEMROOT'] ?? 'C:\\Windows';
      try {
        const systemTar = `${systemRoot}\\System32\\tar.exe`;
        // -x: extract files
        // -f: specify the archive file
        // -C: extract to the specified directory
        await execFileAsync(systemTar, ['-xf', archivePath, '-C', folderPath]);
        return;
      } catch (tarError) {
        logger?.(DEBUG_PREFIXES.fileUtil)?.(
          `tar.exe extraction failed: ${tarError}`,
        );
      }
      try {
        await execFileAsync('powershell.exe', [
          '-NoProfile',
          '-NonInteractive',
          '-Command',
          '& { Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force }',
          archivePath,
          folderPath,
        ]);
        return;
      } catch (powershellError) {
        logger?.(DEBUG_PREFIXES.fileUtil)?.(
          `powershell.exe extraction failed: ${powershellError}`,
        );
      }
      await execFileAsync('pwsh.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '& { Expand-Archive -LiteralPath $args[0] -DestinationPath $args[1] -Force }',
        archivePath,
        folderPath,
      ]);
    } else {
      // -o: overwrite existing files without prompting
      // -d: extract files into the specified directory
      await execFileAsync('unzip', ['-o', archivePath, '-d', folderPath]);
    }
  } catch (error: any) {
    if (error?.code === 'ENOENT') {
      throw new ArchiverUnavailableError(
        `Extraction failed: Required native binary ('tar.exe', 'powershell.exe', 'pwsh.exe' or 'unzip') was not found in the system PATH.`,
      );
    }
    throw new Error(
      `Extraction failed: ${error?.stderr?.toString() || error?.message}`,
    );
  }
}

/**
 * @internal
 */
function isInsideDirectory(directory: string, candidate: string): boolean {
  const resolvedDirectory = path.resolve(directory);
  const resolvedCandidate = path.resolve(candidate);
  return (
    resolvedCandidate === resolvedDirectory ||
    resolvedCandidate.startsWith(resolvedDirectory + path.sep)
  );
}

/**
 * @internal
 */
async function extractZipEntry(
  zipFile: ZipFile,
  entry: Entry,
  folderPath: string,
): Promise<void> {
  const {S_IFMT, S_IFDIR, S_IFLNK} = constants;

  // see https://github.com/max-mapper/extract-zip/blob/v2.0.1/index.js#L90-L107
  const unixMode = entry.externalFileAttributes >>> 16;
  const isDirectory =
    (unixMode & S_IFMT) === S_IFDIR ||
    entry.fileName.endsWith('/') ||
    (entry.versionMadeBy >> 8 === 0 && entry.externalFileAttributes === 0x10);
  const isSymlink = (unixMode & S_IFMT) === S_IFLNK;
  // Fall back to sensible defaults for archives without Unix attributes.
  const mode =
    unixMode === 0 ? (isDirectory ? 0o755 : 0o644) : unixMode & 0o777;

  const destination = path.join(folderPath, entry.fileName);
  if (isDirectory) {
    await mkdir(destination, {recursive: true, mode});
    return;
  }
  await mkdir(path.dirname(destination), {recursive: true});

  const readStream = await promisify(zipFile.openReadStream.bind(zipFile))(
    entry,
  );
  if (isSymlink) {
    // Consume the symlink target in pipe semantics rather than via async
    // iteration (e.g. stream/consumers `text()`): yauzl <3.3.1 read streams
    // never emit "close", which hangs consumers (thejoshwolfe/yauzl#169)
    const chunks: Buffer[] = [];
    await pipeline(
      readStream,
      new Writable({
        write(chunk: unknown, _encoding, callback) {
          // yauzl opens entries in binary mode, so chunks are always Buffers.
          if (chunk instanceof Buffer) {
            chunks.push(chunk);
          }
          callback();
        },
      }),
    );
    const linkTarget = Buffer.concat(chunks).toString();
    // Verify that the link does not resolve outside of the target directory.
    const resolvedLinkTarget = path.resolve(
      path.dirname(destination),
      linkTarget,
    );
    if (!isInsideDirectory(folderPath, resolvedLinkTarget)) {
      throw new Error(
        `Zip symlink "${entry.fileName}" would point outside of the target directory.`,
      );
    }
    await symlink(linkTarget, destination);
    return;
  }
  await pipeline(readStream, createWriteStream(destination, {mode}));
}
