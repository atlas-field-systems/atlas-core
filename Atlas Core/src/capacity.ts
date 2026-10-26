import { opendirSync, statSync, statfsSync } from 'node:fs';
import { join } from 'node:path';
import { Refusal } from './fault.js';
import type { Settings } from './settings.js';

export function diskUsage(root: string): { bytes: number; free: number } {
  let bytes = 0, files = 0;
  const walk = (path: string, depth: number): void => {
    if (depth > 8) throw new Refusal('resource_limit');
    const directory = opendirSync(path);
    try {
      while (true) {
        const entry = directory.readSync(); if (!entry) break;
        if (++files > 100_000 || entry.isSymbolicLink()) throw new Refusal('resource_limit');
        if (entry.isDirectory()) walk(join(path, entry.name), depth + 1);
        else if (entry.isFile()) { try { bytes += statSync(join(path, entry.name)).size; } catch (error) { if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error; } }
      }
    } finally { directory.closeSync(); }
  };
  walk(root, 0);
  const disk = statfsSync(root, { bigint: true });
  return { bytes, free: Number(disk.bavail * disk.bsize) };
}
export function hasCapacity(usage: { bytes: number; free: number }, settings: Settings, bytes: number, required = false): boolean {
  return usage.bytes + bytes + (required ? 0 : settings.reserveBytes) <= settings.storageBytes && usage.free >= bytes + (required ? 0 : settings.freeDiskBytes);
}
