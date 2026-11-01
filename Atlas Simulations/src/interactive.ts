import { Uuid, exchanges } from '@atlas/protocol';
import { createClient } from '@atlas/sdk';
import { randomBytes } from 'node:crypto';
import { mkdtemp, open } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetRuntime } from './asset.js';
import { externalRoot } from './core.js';
import type { Scenario } from './scenario.js';
import { id, success } from './sdk.js';
import { Truth } from './truth.js';
import { Shutdown } from './shutdown.js';
import { World } from './world.js';
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
  let stopWorld: (() => void) | undefined;
  let fatal: unknown;
  const world = new World(input.scenario, truth),
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
      const startup = runtime.start(registrar);
      let interrupted: (() => void) | undefined;
      const interruption = new Promise<void>((resolve) => {
        interrupted = resolve;
      });
      const abort = () => interrupted?.();
      input.signal.addEventListener('abort', abort, { once: true });
      if (input.signal.aborted) abort();
      try {
        await Promise.race([startup, interruption]);
      } finally {
        input.signal.removeEventListener('abort', abort);
      }
      if (input.signal.aborted) break;
    }
    stopWorld = world.start();
    while (!input.signal.aborted) {
      if (fatal) throw fatal;
      await delay(100);
    }
  } catch (e) {
    failures.push(e);
  } finally {
    stopWorld?.();
    const shutdown = new Shutdown();
    const drained = (
      await Promise.all(
        runtimes.map((runtime) =>
          shutdown.finish(`writers ${runtime.alias}`, () => runtime.park(shutdown.deadline - 3000)),
        ),
      )
    ).every(Boolean);
    for (const runtime of runtimes) {
      await shutdown.finish(`revoke ${runtime.alias}`, async () => {
        const op = registrar.apiKeys.revoke({
          request_id: id(),
          api_key_id: runtime.identity.api_key_id,
        });
        try {
          success(
            (
              await op.send({
                timeoutMs: Math.max(1, Math.ceil(shutdown.deadline - performance.now())),
              })
            ).attempt,
          );
        } finally {
          op.close();
        }
      });
      await shutdown.finish(`client ${runtime.alias}`, () => runtime.close());
    }
    await shutdown.finish('registrar', async () => {
      await registrar.close();
    });
    if (drained) await shutdown.finish('truth', () => truth.close());
    failures.push(...shutdown.failures);
  }
  if (fatal) failures.push(fatal);
  if (failures.length)
    throw new AggregateError(
      failures,
      `Simulation or cleanup failed ${failures.map((e) => (e instanceof Error ? e.message : String(e))).join('; ')}`,
    );
}
