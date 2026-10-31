import { open, mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@atlas/sdk';
import { Uuid, exchanges } from '@atlas/protocol';
import { externalRoot } from './core.js';
import type { Scenario } from './scenario.js';
import { success, id } from './sdk.js';
import { World } from './world.js';
import { Truth } from './truth.js';
import { AssetRuntime } from './asset.js';
export async function credential(path: string): Promise<string> {
  const file = await open(path, 'r');
  try {
    const stat = await file.stat();
    if ((stat.mode & 0o777) !== 0o600 || stat.size > 16384)
      throw new Error('Credential requires mode 0600 and at most 16 KiB');
    const bytes = Buffer.alloc(16385);
    const n = await file.read(bytes);
    return exchanges.CreateApiKey.request.schema.parse(
      JSON.parse(bytes.subarray(0, n.bytesRead).toString('utf8')),
    ).secret;
  } finally {
    await file.close();
  }
}
export async function simulate(input: {
  scenario: Scenario;
  baseUrl: string;
  credentialFile: string;
  signal: AbortSignal;
}): Promise<void> {
  const secret = await credential(input.credentialFile);
  const registrar = createClient({ baseUrl: input.baseUrl, credentials: () => secret });
  const runtimes: AssetRuntime[] = [];
  const failures: unknown[] = [];
  const truth = await Truth.create(await mkdtemp(join(await externalRoot(), 'interactive-')));
  let fatal: unknown;
  const world = new World(input.scenario),
    runId = randomBytes(2).toString('hex');
  try {
    success(await registrar.connect());
    const datasetId = Uuid.parse(registrar.state.datasetId);
    for (const config of input.scenario.assets) {
      const runtime = new AssetRuntime({
        config,
        baseUrl: input.baseUrl,
        datasetId,
        runId,
        world,
        truth,
        fatal: (e) => {
          fatal ??= e;
        },
      });
      runtimes.push(runtime);
      await runtime.start(registrar);
    }
    let previous = performance.now();
    while (!input.signal.aborted) {
      if (fatal) throw fatal;
      const now = performance.now();
      world.tick((now - previous) / 1000);
      previous = now;
      await delay(100);
    }
  } catch (e) {
    failures.push(e);
  } finally {
    let drained = true;
    for (const runtime of runtimes)
      try {
        await runtime.park();
      } catch (e) {
        drained = false;
        failures.push(e);
      }
    for (const runtime of runtimes) {
      try {
        const op = registrar.apiKeys.revoke({
          request_id: id(),
          api_key_id: runtime.identity.api_key_id,
        });
        try {
          success((await op.send()).attempt);
        } finally {
          op.close();
        }
      } catch (e) {
        failures.push(e);
      }
      try {
        await runtime.close();
      } catch (e) {
        failures.push(e);
      }
    }
    try {
      await registrar.close();
    } catch (e) {
      failures.push(e);
    }
    if (drained)
      try {
        await truth.close();
      } catch (e) {
        failures.push(e);
      }
  }
  if (failures.length) throw new AggregateError(failures, 'Simulation or cleanup failed');
}
