import { parentPort, workerData } from 'node:worker_threads';
import Database from 'better-sqlite3';
import { existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { Uuid, exchanges } from '@atlas/protocol';
import { Engine } from './engine.js';
import { Marker } from './installation.js';
import { Settings } from './settings.js';

const request = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('inspect-marker'), directory: z.string() }),
  z.object({ mode: z.literal('establish'), directory: z.string(), settings: Settings, dataset: Uuid, action: Uuid, hard: z.boolean() }),
  z.object({ mode: z.literal('provision'), directory: z.string(), settings: Settings, request: exchanges.CreateApiKey.request.schema }),
]).parse(workerData);
try {
  if (request.mode === 'inspect-marker') {
    const path = join(request.directory, 'core.sqlite');
    if (!existsSync(path)) parentPort?.postMessage({ exists: false, dataset: null, marker: null });
    else {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try {
        const value = (key: string) => {
          const row = db.prepare('SELECT value FROM core_meta WHERE key=?').get(key);
          return row === undefined ? undefined : z.object({ value: z.string() }).parse(row).value;
        };
        const marker = value('establishment');
        parentPort?.postMessage(Marker.parse({ exists: true, dataset: value('dataset'), marker: marker === undefined ? null : JSON.parse(marker) }));
      } finally { db.close(); }
    }
  } else {
    const path = join(request.directory, 'core.sqlite');
    const fresh = !existsSync(path) || statSync(path).size === 0;
    const establishment = request.mode === 'establish' && fresh ? { dataset: request.dataset, actionId: request.action } : undefined;
    const engine = new Engine(request.directory, request.settings, establishment, request.directory, true);
    try {
      if (request.mode === 'provision') { engine.provision(request.request, false); parentPort?.postMessage({ provisioned: true }); }
      else { engine.establish(request.dataset, request.action, request.hard); parentPort?.postMessage({ established: true, dataset: request.dataset, action: request.action }); }
    } finally { await engine.close(); }
  }
} catch { parentPort?.postMessage({ failed: true, code: 'offline_operation_failed' }); }
