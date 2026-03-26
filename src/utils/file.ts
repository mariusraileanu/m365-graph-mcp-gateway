/**
 * Safe filesystem helpers for the token cache and other persistent data.
 *
 * - atomicWriteFile: write-to-temp → fsync → rename — prevents partial/corrupt
 *   writes on crash or power loss.
 * - safeReadFile: returns null for missing or empty files instead of throwing.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

/**
 * Write `content` to `filePath` atomically.
 *
 * 1. Write to a temp file in the same directory (same filesystem → rename is atomic).
 * 2. fsync the file descriptor to ensure data hits storage.
 * 3. Rename the temp file over the target (atomic on POSIX).
 * 4. Clean up the temp file on any error.
 */
export async function atomicWriteFile(filePath: string, content: string, mode: number = 0o600): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true });

  const tmpPath = path.join(dir, `.${path.basename(filePath)}.tmp.${crypto.randomBytes(4).toString('hex')}`);

  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(tmpPath, 'w', mode);
    await fd.writeFile(content, 'utf-8');
    await fd.sync();
    await fd.close();
    fd = null;

    await fs.promises.rename(tmpPath, filePath);
  } catch (err) {
    // Close fd if still open
    if (fd) {
      await fd.close().catch(() => {});
    }
    // Best-effort cleanup of the temp file
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/**
 * Read a file, returning `null` if the file does not exist or is empty.
 * Any other read error is re-thrown.
 */
export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return data.length === 0 ? null : data;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
