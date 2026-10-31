import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { cpus, totalmem, release } from 'node:os';
import { createHash, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from '@atlas/sdk';
import type { HttpClient } from '@atlas/sdk';
import { Uuid } from '@atlas/protocol';
import { collectEvidence, checkEvidence } from './checks.js';
import { Core, externalRoot } from './core.js';
import { command } from './process.js';
import { Truth } from './truth.js';
import { World } from './world.js';
import { AssetRuntime } from './asset.js';
import { Operator } from './operator.js';
import { success, id } from './sdk.js';
import type { Scenario } from './scenario.js';
import { passed, unrun, saveRecord } from './records.js';
import type { RunRecord, CleanupEvidence } from './records.js';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1024);
async function source(): Promise<RunRecord['source']> {
  const commit = await command('git', ['rev-parse', 'HEAD']);
  const branch = await command('git', ['branch', '--show-current']);
  const dirty = (await command('git', ['status', '--porcelain'])).length > 0;
  return { commit, branch, dirty };
}
export async function evaluate(input: { scenario: Scenario; sha256: string }): Promise<RunRecord> {
  const started = performance.now(),
    cpu = process.cpuUsage();
  const core = await Core.allocate();
  const failures: string[] = [],
    runtimes: AssetRuntime[] = [];
  let registrar: HttpClient | undefined, operator: Operator | undefined, truth: Truth | undefined;
  let fatal: unknown;
  let checks = unrun('Run did not reach verification');
  const cleanup: CleanupEvidence = {
    writersDrained: false,
    createdKeysRevoked: false,
    clientsClosed: false,
    coreExit: 'unverified',
    failures: [],
  };
  const clean = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    try {
      await action();
      return true;
    } catch (e) {
      cleanup.failures.push(`${label} ${errorText(e)}`);
      return false;
    }
  };
  try {
    await core.setup();
    truth = await Truth.create(core.directory);
    registrar = createClient({ baseUrl: core.baseUrl, credentials: () => core.credential.secret });
    success(await registrar.connect());
    const datasetId = Uuid.parse(registrar.state.datasetId);
    const world = new World(input.scenario),
      runId = randomBytes(2).toString('hex');
    for (const config of input.scenario.assets) {
      const runtime = new AssetRuntime({
        config,
        baseUrl: core.baseUrl,
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
    operator = new Operator({
      baseUrl: core.baseUrl,
      secret: core.credential.secret,
      datasetId,
      assets: new Map(runtimes.map((a) => [a.alias, a.identity.asset_id])),
      truth,
    });
    await operator.start(input.scenario);
    const timeline = input.scenario.timeline;
    if (!timeline || !input.scenario.expect || !input.scenario.deadline_seconds)
      throw new Error('Eval fields required');
    const origin = performance.now(),
      deadline = origin + input.scenario.deadline_seconds * 1000;
    let previousWorld = origin;
    for (const action of timeline) {
      while (performance.now() - origin < action.at_seconds * 1000) {
        if (fatal) throw fatal;
        if (performance.now() > deadline) throw new Error('Scenario deadline');
        const now = performance.now();
        world.tick((now - previousWorld) / 1000);
        previousWorld = now;
        await delay(50);
      }
      if (action.action === 'fault') throw new Error(`Fault not implemented ${action.id}`);
      await operator.apply(action);
    }
    let heldSince: number | undefined;
    for (;;) {
      if (fatal) throw fatal;
      if (performance.now() > deadline) throw new Error('Scenario deadline');
      let matches = true,
        nonterminal = false;
      for (const expected of input.scenario.expect.tasks) {
        const task = success(
          await operator.client.http.tasks.get({
            task_id: operator.move(expected.asset, expected.index).id,
          }),
        );
        matches &&= task.execution_state === expected.state;
        nonterminal ||= !['completed', 'failed', 'cancelled'].includes(expected.state);
      }
      for (const task_id of operator.controls) {
        const task = success(await operator.client.http.tasks.get({ task_id }));
        matches &&= ['completed', 'failed', 'cancelled'].includes(task.execution_state);
      }
      if (matches) {
        heldSince ??= performance.now();
        if (!nonterminal || performance.now() - heldSince >= 15000) break;
      } else heldSince = undefined;
      const now = performance.now();
      world.tick((now - previousWorld) / 1000);
      previousWorld = now;
      await delay(100);
    }
    for (const runtime of runtimes) await runtime.park();
    await operator.writes.drain();
    await truth.boundary();
    const verification = {
      scenario: input.scenario,
      baseUrl: core.baseUrl,
      secret: core.credential.secret,
      datasetId,
      truth: truth.path,
      assets: new Map(runtimes.map((a) => [a.alias, a.identity.asset_id])),
      moves: operator.moves,
    };
    const evidence = await collectEvidence(verification);
    checks = checkEvidence(verification, evidence);
    const capture = JSON.stringify({
      scenario: input.scenario,
      assets: [...verification.assets],
      moves: operator.moves,
      evidence: {
        ...evidence,
        assets: [...evidence.assets],
        tasks: [...evidence.tasks],
        observations: [...evidence.observations],
        history: [...evidence.history],
      },
    });
    if (Buffer.byteLength(capture) > 16777216)
      throw new Error('Verification capture budget exceeded');
    await writeFile(join(core.directory, 'evidence.json'), capture, { mode: 0o600 });
  } catch (e) {
    failures.push(errorText(e));
  } finally {
    let drained = true;
    for (const runtime of runtimes)
      drained = (await clean(`park ${runtime.alias}`, () => runtime.park())) && drained;
    if (operator) {
      const owner = operator;
      drained = (await clean('operator writes', () => owner.writes.drain())) && drained;
    }
    cleanup.writersDrained = drained;
    let revoked = true;
    if (registrar) {
      const owner = registrar;
      for (const runtime of runtimes)
        revoked =
          (await clean(`revoke ${runtime.alias}`, async () => {
            const op = owner.apiKeys.revoke({
              request_id: id(),
              api_key_id: runtime.identity.api_key_id,
            });
            try {
              success((await op.send()).attempt);
            } finally {
              op.close();
            }
          })) && revoked;
    }
    cleanup.createdKeysRevoked = revoked;
    let closed = true;
    for (const runtime of runtimes)
      closed = (await clean(`close ${runtime.alias}`, () => runtime.close())) && closed;
    if (operator) {
      const owner = operator;
      closed = (await clean('operator close', () => owner.close())) && closed;
    }
    if (registrar) {
      const owner = registrar;
      closed =
        (await clean('registrar close', async () => {
          await owner.close();
        })) && closed;
    }
    cleanup.clientsClosed = closed;
    if (truth && drained) {
      const owner = truth;
      await clean('truth close', () => owner.close());
    }
    cleanup.coreExit = (await clean('Core stop', () => core.stop())) ? 'verified' : 'unverified';
  }
  const elapsedCpu = process.cpuUsage(cpu);
  const settings = await readFile(new URL('../settings/eval.json', import.meta.url));
  const image = await readFile(
    new URL('../../Atlas Core/artifacts/image-id', import.meta.url),
    'utf8',
  ).catch(() => 'unavailable');
  const record: RunRecord = {
    scenario: input.scenario.name,
    at: new Date().toISOString(),
    source: await source(),
    inputs: {
      scenario: input.sha256,
      settings: createHash('sha256').update(settings).digest('hex'),
    },
    checks,
    cleanup,
    verdict: !failures.length && passed(checks, cleanup) ? 'passed' : 'failed',
    failures,
    measurements: {
      durationMs: performance.now() - started,
      simulatorCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
      simulatorPeakMemory: process.resourceUsage().maxRSS * 1024,
    },
    environment: {
      node: process.version,
      cpu: cpus()[0]?.model ?? 'unknown',
      cpus: cpus().length,
      memory: totalmem(),
      kernel: release(),
      image: image.trim(),
    },
  };
  await saveRecord(join(core.directory, 'records'), record);
  return record;
}
