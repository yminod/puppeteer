/**
 * @license
 * Copyright 2025 Google Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert';
import {createHash} from 'node:crypto';
import {once} from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import {downloadFile, getText, headHttpRequest} from '../../lib/httpUtil.js';

describe('downloadFile', function () {
  let tmpDir: string;
  let server: http.Server;
  let serverUrl: URL;
  let streamingResponse: http.ServerResponse;

  const testContent = Buffer.from('test browser binary content');
  const correctHash = createHash('sha256').update(testContent).digest('hex');

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'puppeteer-httputil-test'));
    server = http.createServer((req, res) => {
      if (req.url === '/streaming') {
        streamingResponse = res;
        res.writeHead(200, {'Content-Length': String(testContent.length * 2)});
        res.write(testContent.subarray(0, 4));
        return;
      }
      if (req.url === '/aborted') {
        res.writeHead(200, {'Content-Length': String(testContent.length * 2)});
        res.write(testContent.subarray(0, 4));
        setImmediate(() => {
          res.destroy();
        });
        return;
      }
      res.writeHead(200, {'Content-Length': String(testContent.length)});
      res.end(testContent);
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as {port: number};
    serverUrl = new URL(`http://127.0.0.1:${address.port}/test`);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => {
      server.close(() => {
        return resolve();
      });
    });
    try {
      fs.rmSync(tmpDir, {
        force: true,
        recursive: true,
        maxRetries: 10,
        retryDelay: 500,
      });
    } catch {}
  });

  it('downloads a file without hash verification', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    await downloadFile(serverUrl, destPath);
    assert.ok(fs.existsSync(destPath));
    assert.deepStrictEqual(fs.readFileSync(destPath), testContent);
  });

  it('rejects when the response ends before the content length is reached', async () => {
    await new Promise<void>(resolve => {
      server.close(() => {
        return resolve();
      });
    });
    server = http.createServer((_req, res) => {
      res.writeHead(200, {'Content-Length': String(testContent.length + 1)});
      res.write(testContent, () => {
        res.destroy();
      });
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as {port: number};
    serverUrl = new URL(`http://127.0.0.1:${address.port}/test`);

    const destPath = path.join(tmpDir, 'download.bin');
    await assert.rejects(
      () => {
        return downloadFile(serverUrl, destPath);
      },
      (error: Error & {cause?: unknown}) => {
        assert.match(
          error.message,
          /Download failed: expected \d+ bytes, received \d+ bytes/,
        );
        assert.ok(error.cause instanceof Error);
        return true;
      },
    );
    assert.ok(!fs.existsSync(destPath));
  });

  it('closes the response when writing the file fails', async () => {
    await new Promise<void>(resolve => {
      server.close(() => {
        return resolve();
      });
    });
    let resolveResponseClosed!: () => void;
    const responseClosed = new Promise<void>(resolve => {
      resolveResponseClosed = resolve;
    });
    server = http.createServer((_req, res) => {
      res.on('close', resolveResponseClosed);
      res.writeHead(200, {'Content-Length': String(testContent.length + 1)});
      res.write(testContent);
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as {port: number};
    serverUrl = new URL(`http://127.0.0.1:${address.port}/test`);

    await assert.rejects(() => {
      return downloadFile(serverUrl, tmpDir);
    });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(
            new Error('Response was not closed after the file write failed'),
          );
        }, 1000);
        void responseClosed.then(() => {
          clearTimeout(timeout);
          resolve();
        });
      });
    } finally {
      server.closeAllConnections();
    }
  });

  it('downloads a file and resolves when the hash matches', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    await downloadFile(serverUrl, destPath, undefined, correctHash);
    assert.ok(fs.existsSync(destPath));
    assert.deepStrictEqual(fs.readFileSync(destPath), testContent);
  });

  it('rejects with an integrity error when the hash mismatches', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    const wrongHash = 'a'.repeat(64);
    await assert.rejects(
      () => {
        return downloadFile(serverUrl, destPath, undefined, wrongHash);
      },
      (err: Error) => {
        assert.ok(
          err.message.includes('Integrity check failed'),
          `Expected "Integrity check failed" in: ${err.message}`,
        );
        assert.ok(
          err.message.includes(wrongHash),
          `Expected wrong hash in error message`,
        );
        assert.ok(
          err.message.includes(correctHash),
          `Expected actual hash in error message`,
        );
        return true;
      },
    );
  });

  it('deletes the downloaded file when the hash mismatches', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    const wrongHash = 'b'.repeat(64);
    await assert.rejects(() => {
      return downloadFile(serverUrl, destPath, undefined, wrongHash);
    });
    assert.ok(
      !fs.existsSync(destPath),
      'File should be deleted after hash mismatch',
    );
  });

  it('accepts an uppercase expected hash', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    await downloadFile(
      serverUrl,
      destPath,
      undefined,
      correctHash.toUpperCase(),
    );
    assert.ok(fs.existsSync(destPath));
  });

  it('preserves a progress callback error and tears down the transfer', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    const progressError = new Error('progress callback failed');
    let progressCalls = 0;

    await assert.rejects(
      downloadFile(
        new URL('/streaming', serverUrl),
        destPath,
        () => {
          ++progressCalls;
          throw progressError;
        },
        correctHash,
      ),
      (error: unknown) => {
        assert.strictEqual(error, progressError);
        return true;
      },
    );

    assert.strictEqual(progressCalls, 1);
    assert.strictEqual(fs.existsSync(destPath), false);
    if (!streamingResponse.destroyed) {
      await once(streamingResponse, 'close', {
        signal: AbortSignal.timeout(1000),
      });
    }
    assert.strictEqual(streamingResponse.destroyed, true);
  });

  it('rejects an interrupted response after closing the destination', async () => {
    const destPath = path.join(tmpDir, 'download.bin');
    const interruptedUrl = new URL('/aborted', serverUrl);

    await assert.rejects(() => {
      return downloadFile(interruptedUrl, destPath);
    });

    assert.strictEqual(fs.existsSync(destPath), false);
  });
});

describe('HTTP request errors', () => {
  let server: http.Server;
  let redirectUrl: URL;

  beforeEach(async () => {
    server = http.createServer((req, res) => {
      if (req.url === '/redirect') {
        res.writeHead(302, {
          Location: new URL('/reset', redirectUrl).toString(),
        });
        res.end();
        return;
      }
      // Fail the redirected request before sending any response headers.
      req.socket.destroy();
    });
    await new Promise<void>(resolve => {
      server.listen(0, '127.0.0.1', resolve);
    });
    const address = server.address() as {port: number};
    redirectUrl = new URL(`http://127.0.0.1:${address.port}/redirect`);
  });

  afterEach(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => {
      server.close(() => {
        resolve();
      });
    });
  });

  it('rejects getText when a redirected request fails', async () => {
    await assert.rejects(getText(redirectUrl), {code: 'ECONNRESET'});
  });

  it('resolves HEAD as false when a redirected request fails', async () => {
    assert.strictEqual(await headHttpRequest(redirectUrl), false);
  });
});
