import { readFile, open, rename, mkdir, lstat, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { id } from './exact.js';
import { WriterIdentity } from './objects.js';

export async function processIdentity(pid = process.pid): Promise<WriterIdentity> {
  const [boot, raw] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readFile(`/proc/${pid}/stat`, 'utf8')]);
  const start = raw.slice(raw.lastIndexOf(')') + 2).split(' ')[19];
  return WriterIdentity.parse({ pid, boot: boot.trim(), start });
}
export async function exited(identity: WriterIdentity): Promise<boolean> {
  try {
    const actual = await processIdentity(identity.pid);
    return actual.boot !== identity.boot || actual.start !== identity.start;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return true;
    throw new Error('writer_exit_unverified');
  }
}
export async function flushDirectory(directory: string): Promise<void> { const handle = await open(directory, 'r'); try { await handle.sync(); } finally { await handle.close(); } }
export async function atomicJson(path: string, value: unknown): Promise<void> {
  const data = JSON.stringify(value) + '\n';
  if (Buffer.byteLength(data) > 65_536) throw new Error('record_limit');
  const temporary = `${path}.${id()}.tmp`;
  const file = await open(temporary, 'wx', 0o600);
  try { await file.writeFile(data); await file.sync(); } finally { await file.close(); }
  try { await rename(temporary, path); await flushDirectory(dirname(path)); }
  catch (error) { await rm(temporary, { force: true }); throw error; }
}
export async function ownedDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  const parts = absolute.split('/').filter(Boolean);
  let prefix = '/';
  for (const part of parts) {
    prefix = join(prefix, part);
    const info = await lstat(prefix);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('unowned_path');
  }
  return absolute;
}
