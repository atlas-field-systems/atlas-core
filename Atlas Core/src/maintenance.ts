import { createServer, request } from 'node:http';
import { chmod, rm, open } from 'node:fs/promises';
import { z } from 'zod';
import { Counter, Uuid, exchanges } from '@atlas/protocol';
import { join } from 'node:path';
import { atomicJson } from './ownership.js';
import { readJsonFile, SavedSettings } from './installation.js';
import { Settings } from './settings.js';
import { next } from './exact.js';
import { readLocalJson } from './local-json.js';

export const MaintenanceRequest = z.discriminatedUnion('operation', [
  z.strictObject({ operation: z.literal('inspect') }), z.strictObject({ operation: z.literal('stop') }),
  z.strictObject({ operation: z.literal('settings-save'), expected_revision: Counter, candidate: Settings }),
  z.strictObject({ operation: z.literal('provision'), request: z.unknown() }),
  z.strictObject({ operation: z.literal('export') }),
  z.strictObject({ operation: z.literal('enrollment-inspect') }),
  z.strictObject({ operation: z.literal('open-enroll'), dataset: Uuid, request: exchanges.RegisterAsset.request.schema }),
  z.strictObject({ operation: z.literal('enrollment-revoke'), binding: Uuid, key: Uuid, confirm: z.literal(true) }),
]);
export type MaintenanceRequest = z.infer<typeof MaintenanceRequest>;
export async function maintenanceServer(root: string, handle: (request: MaintenanceRequest) => Promise<unknown>, stop: () => Promise<void>) {
  const socket = join(root, 'control', 'maintenance.sock');
  const server = createServer((request, response) => {
    void (async () => {
      if (request.method !== 'POST' || request.url !== '/control') throw new Error('invalid_control');
      const chunks: Buffer[] = []; let bytes = 0;
      for await (const chunk of request) { if (!Buffer.isBuffer(chunk) || (bytes += chunk.byteLength) > 65_536) throw new Error('control_limit'); chunks.push(chunk); }
      const operation = readLocalJson(Buffer.concat(chunks, bytes), MaintenanceRequest);
      const data = await handle(operation);
      const body = JSON.stringify({ ok: true, data });
      if (Buffer.byteLength(body) > 65_536) throw new Error('control_limit');
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(body, () => { if (operation.operation === 'stop') void stop().catch(() => { process.exitCode = 1; }); });
    })().catch(() => { if (!response.headersSent) response.writeHead(409, { 'Content-Type': 'application/json' }); response.end('{"ok":false,"code":"maintenance_failed"}'); });
  });
  server.requestTimeout = 30_000; server.maxConnections = 8;
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(socket, resolve); });
  await chmod(socket, 0o600);
  return { async close() { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); await rm(socket, { force: true }); } };
}
export async function maintenance(root: string, operation: MaintenanceRequest): Promise<unknown> {
  const directory = await open(join(root, 'control'), 'r');
  try { return await new Promise((resolve, reject) => {
    const body = JSON.stringify(operation);
    const req = request({ socketPath: `/proc/self/fd/${directory.fd}/maintenance.sock`, method: 'POST', path: '/control', timeout: 30_000,
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), Connection: 'close' } }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { if ((bytes += chunk.byteLength) > 65_536) { response.destroy(); reject(new Error('control_limit')); } else chunks.push(chunk); });
      response.on('end', () => {
        try { const parsed = z.object({ ok: z.boolean(), data: z.unknown().optional() }).parse(JSON.parse(Buffer.concat(chunks).toString('utf8'))); if (response.statusCode !== 200 || !parsed.ok) throw new Error('maintenance_failed'); resolve(parsed.data); }
        catch { reject(new Error('maintenance_failed')); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('maintenance_timeout'))); req.on('error', () => reject(new Error('maintenance_unavailable'))); req.end(body);
  }); } finally { await directory.close(); }
}
export async function saveSettings(root: string, expected: string, candidate: Settings): Promise<SavedSettings> {
  const path = join(root, 'setup', 'settings.json');
  const settings = await readJsonFile(path, SavedSettings);
  if (settings.revision !== expected) throw new Error('settings_revision_changed');
  const updated: SavedSettings = { ...settings, revision: next(settings.revision), saved: Settings.parse(candidate), apply_failure: 'apply_required' };
  await atomicJson(path, updated);
  return updated;
}
