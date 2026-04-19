/** Atomic writes and explicit ENOENT-only reads for persistent state. */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';

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
    if (fd) {
      await fd.close().catch(() => {});
    }
    await fs.promises.unlink(tmpPath).catch(() => {});
    throw err;
  }
}

/** Read a file, returning `null` only when it does not exist. */
export async function safeReadFile(filePath: string): Promise<string | null> {
  try {
    return await fs.promises.readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    throw err;
  }
}
