import { describe, it, afterEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

import { atomicWriteFile, safeReadFile } from './file.js';

function tmpDir(): string {
  return path.join('/tmp', `file-test-${crypto.randomBytes(4).toString('hex')}`);
}

const dirs: string[] = [];

afterEach(async () => {
  mock.restoreAll();
  for (const d of dirs) {
    await fs.promises.rm(d, { recursive: true, force: true }).catch(() => {});
  }
  dirs.length = 0;
});

describe('atomicWriteFile', () => {
  it('writes content that can be read back', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'test.txt');

    await atomicWriteFile(fp, 'hello world');
    const content = await fs.promises.readFile(fp, 'utf-8');
    assert.equal(content, 'hello world');
  });

  it('creates parent directories if missing', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'deep', 'nested', 'file.txt');

    await atomicWriteFile(fp, 'nested content');
    const content = await fs.promises.readFile(fp, 'utf-8');
    assert.equal(content, 'nested content');
  });

  it('sets file permissions to 0o600 by default', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'secret.txt');

    await atomicWriteFile(fp, 'secret');
    const stat = await fs.promises.stat(fp);
    // Check owner-only read/write (0o600). Mask with 0o777 to ignore sticky bits.
    assert.equal(stat.mode & 0o777, 0o600);
  });

  it('overwrites existing file atomically', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'overwrite.txt');

    await atomicWriteFile(fp, 'first');
    await atomicWriteFile(fp, 'second');
    const content = await fs.promises.readFile(fp, 'utf-8');
    assert.equal(content, 'second');
  });

  it('does not leave temp files on success', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'clean.txt');

    await atomicWriteFile(fp, 'clean');
    const files = await fs.promises.readdir(dir);
    assert.equal(files.length, 1);
    assert.equal(files[0], 'clean.txt');
  });
});

describe('safeReadFile', () => {
  it('returns null for nonexistent file', async () => {
    const result = await safeReadFile('/tmp/nonexistent-file-' + crypto.randomBytes(8).toString('hex'));
    assert.equal(result, null);
  });

  it('returns empty string for empty file', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'empty.txt');

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(fp, '');
    const result = await safeReadFile(fp);
    assert.equal(result, '');
  });

  it('returns content for non-empty file', async () => {
    const dir = tmpDir();
    dirs.push(dir);
    const fp = path.join(dir, 'data.txt');

    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(fp, 'some data');
    const result = await safeReadFile(fp);
    assert.equal(result, 'some data');
  });

  it('throws on permission error (not ENOENT)', async () => {
    const denied = Object.assign(new Error('permission denied'), { code: 'EACCES' });
    mock.method(fs.promises, 'readFile', async () => {
      throw denied;
    });

    await assert.rejects(() => safeReadFile('/tmp/permission-denied.txt'), (err: NodeJS.ErrnoException) => err.code === 'EACCES');
  });
});
