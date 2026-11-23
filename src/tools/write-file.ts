import { constants, promises as fs } from 'node:fs';

/** Inspect the opened inode before truncation, not just its pathname. */
export async function writeUnlinkedFile(file: string, content: string | Buffer): Promise<void> {
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1) throw new Error('Refusing to write a non-regular or hard-linked file');
    await handle.truncate(0);
    await handle.writeFile(content);
  } finally {
    await handle.close();
  }
}
