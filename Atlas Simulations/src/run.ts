import { z } from 'zod';
import { Uuid } from '@atlas/protocol';
import type { HttpClient } from '@atlas/sdk';
import { createClient } from '@atlas/sdk';
import { createHash, randomBytes } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { cpus, release, totalmem } from 'node:os';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { AssetRuntime } from './asset.js';
import { checkEvidence, collectEvidence } from './checks.js';
import { storageBytes } from './measurements.js';
import { Core } from './core.js';
import { verifyFault } from './fault-checks.js';
import type { FaultReceipt } from './faults.js';
import { exerciseFault } from './faults.js';
import { Operator } from './operator.js';
import { command } from './process.js';
import { Proxy } from './proxy.js';
import type { CleanupEvidence, RunRecord } from './records.js';
import { passed, saveRecord, unrun } from './records.js';
import type { Scenario } from './scenario.js';
import { id, success } from './sdk.js';
import { Truth } from './truth.js';
import { Shutdown } from './shutdown.js';
import { World } from './world.js';
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 1024);
async function source(): Promise<RunRecord['source']> {
  const commit = await command('git', ['rev-parse', 'HEAD']);
  const branch = await command('git', ['branch', '--show-current']);
  const dirty = (await command('git', ['status', '--porcelain'])).length > 0;
  return { commit, branch: process.env.ATLAS_SOURCE_BRANCH ?? branch, dirty };
}
export async function evaluate(input: {
  scenario: Scenario;
  sha256: string;
  signal?: AbortSignal;
}): Promise<RunRecord> {
  const started = performance.now(),
    cpu = process.cpuUsage();
  const core = await Core.allocate();
  const failures: string[] = [],
    runtimes: AssetRuntime[] = [];
  let registrar: HttpClient | undefined, operator: Operator | undefined, truth: Truth | undefined;
  let stopSampling: (() => Promise<void>) | undefined;
  let storage: Record<string, number | null> = {
    databaseBytes: null,
    walBytes: null,
    installationBytes: null,
  };
  let stopWorld: (() => void) | undefined;
  let fatal: unknown;
  let proxy: Proxy | undefined;
  const receipts: FaultReceipt[] = [];
  let receiptBytes = 0;
  const retainReceipt = async (receipt: FaultReceipt): Promise<void> => {
    const bytes = Buffer.byteLength(JSON.stringify(receipt));
    if (bytes > 4194304 || receiptBytes + bytes > 8388608)
      throw new Error('Fault evidence byte budget');
    receiptBytes += bytes;
    receipts.push(receipt);
    await writeFile(join(core.directory, 'faults.json'), JSON.stringify(receipts), { mode: 0o600 });
  };
  let finalReset: Extract<import('./scenario.js').TimelineAction, { action: 'fault' }> | undefined;
  let checks = unrun('Run did not reach verification');
  const cleanup: CleanupEvidence = {
    writersDrained: false,
    createdKeysRevoked: false,
    clientsClosed: false,
    coreExit: 'unverified',
    failures: [],
  };
  let shutdown: Shutdown | undefined;
  const clean = async (label: string, action: () => Promise<void>): Promise<boolean> => {
    try {
      if (shutdown) {
        const ok = await shutdown.finish(label, action);
        if (!ok) cleanup.failures.push(shutdown.failures.at(-1) ?? label);
        return ok;
      }
      await action();
      return true;
    } catch (e) {
      cleanup.failures.push(`${label} ${errorText(e)}`);
      return false;
    }
  };
  try {
    await core.setup();
    proxy = new Proxy(core.baseUrl);
    await proxy.start();
    const baseUrl = proxy.baseUrl;
    truth = await Truth.create(core.directory);
    stopSampling = truth.measurements.start(core);
    registrar = createClient({ baseUrl, credentials: () => core.credential.secret });
    success(await registrar.connect());
    const datasetId = Uuid.parse(registrar.state.datasetId);
    const world = new World(input.scenario, truth),
      runId = randomBytes(2).toString('hex');
    stopWorld = world.start();
    for (const config of input.scenario.assets) {
      const runtime = new AssetRuntime({
        config,
        baseUrl,
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
      baseUrl,
      secret: core.credential.secret,
      datasetId,
      assets: new Map(runtimes.map((a) => [a.alias, a.identity.asset_id])),
      truth,
      reader: registrar,
    });
    await operator.start(input.scenario);
    const timeline = input.scenario.timeline;
    if (!timeline || !input.scenario.expect || !input.scenario.deadline_seconds)
      throw new Error('Eval fields required');
    const origin = performance.now(),
      deadline = origin + input.scenario.deadline_seconds * 1000;

    const scenarioSignal = input.signal
      ? AbortSignal.any([
          input.signal,
          AbortSignal.timeout(Math.ceil(input.scenario.deadline_seconds * 1000)),
        ])
      : AbortSignal.timeout(Math.ceil(input.scenario.deadline_seconds * 1000));
    for (const action of timeline) {
      while (performance.now() - origin < action.at_seconds * 1000) {
        if (input.signal?.aborted) throw new Error('Run interrupted');
        if (fatal) throw fatal;
        if (performance.now() > deadline) throw new Error('Scenario deadline');
        await delay(50);
      }
      if (action.action === 'fault' && action.id === 'core-reset') {
        finalReset = action;
        continue;
      }
      if (action.action === 'fault') {
        const underLoad = ['core-restart', 'core-kill'].includes(action.id);
        if (!underLoad) for (const runtime of runtimes) runtime.hooks.networkHoldUntil = Infinity;
        if (!underLoad) for (const runtime of runtimes) await runtime.writes.drain();
        try {
          await retainReceipt(
            await exerciseFault({
              action,
              core,
              operator,
              assets: runtimes,
              proxy,
              signal: scenarioSignal,
            }),
          );
        } finally {
          for (const runtime of runtimes) runtime.hooks.networkHoldUntil = 0;
        }
      } else await operator.apply(action);
    }
    let heldSince: number | undefined;
    for (;;) {
      if (input.signal?.aborted) throw new Error('Run interrupted');
      if (fatal) throw fatal;
      if (performance.now() > deadline) throw new Error('Scenario deadline');
      let matches = true,
        nonterminal = false;
      for (const expected of input.scenario.expect.tasks) {
        const task = success(
          await registrar.tasks.get({
            task_id: operator.move(expected.asset, expected.index).id,
          }),
        );
        matches &&= task.execution_state === expected.state;
        nonterminal ||= !['completed', 'failed', 'cancelled'].includes(expected.state);
      }
      for (const task_id of operator.controls) {
        const task = success(await registrar.tasks.get({ task_id }));
        matches &&= ['completed', 'failed', 'cancelled'].includes(task.execution_state);
      }
      if (matches) {
        heldSince ??= performance.now();
        if (!nonterminal || performance.now() - heldSince >= 15000) break;
      } else heldSince = undefined;
      await delay(100);
    }
    for (const runtime of runtimes) await runtime.park();
    if (fatal) throw fatal;
    await operator.writes.drain();
    await truth.boundary();
    const verification = {
      scenario: finalReset
        ? {
            ...input.scenario,
            timeline: (input.scenario.timeline ?? []).filter((a) => a !== finalReset),
          }
        : input.scenario,
      baseUrl,
      secret: core.credential.secret,
      datasetId,
      truth: truth.path,
      assets: new Map(runtimes.map((a) => [a.alias, a.identity.asset_id])),
      moves: operator.moves,
    };
    const evidence = await collectEvidence(verification);
    evidence.faults = receipts.map((r) => r.id);
    checks = checkEvidence(verification, evidence);
    const faultFailures = receipts.flatMap((r) =>
      verifyFault(r).map((reason) => `${r.id} ${reason}`),
    );
    if (faultFailures.length)
      checks.faults = {
        kind: 'failed',
        reasons: [
          ...(checks.faults.kind === 'failed' ? checks.faults.reasons : []),
          ...faultFailures,
        ].slice(0, 100),
      };
    if (finalReset) {
      const reset = await exerciseFault({
        action: finalReset,
        core,
        operator,
        assets: runtimes,
        proxy,
      });
      await retainReceipt(reset);
      const reasons = verifyFault(reset);
      if (reasons.length) checks.faults = { kind: 'failed', reasons };
      await registrar.close();
      registrar = createClient({ baseUrl, credentials: () => core.credential.secret });
      success(await registrar.connect());
    }
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
    stopWorld?.();
    shutdown = new Shutdown();
    const shutdownDeadline = shutdown.deadline - 3000;
    let drained = (
      await Promise.all(
        runtimes.map((runtime) =>
          clean(`park ${runtime.alias}`, () => runtime.park(shutdownDeadline)),
        ),
      )
    ).every(Boolean);
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
    if (proxy) {
      const owner = proxy;
      await clean('proxy close', () => owner.close());
    }
    await clean('resource sampler', async () => {
      await stopSampling?.();
    });
    cleanup.coreExit = !core.setupAttempted
      ? 'not-owned'
      : (await clean('Core stop', () => core.stop()))
        ? 'verified'
        : 'unverified';
    if (cleanup.coreExit === 'verified')
      await clean('final storage', async () => {
        storage = await storageBytes(core.installation);
      });
  }
  if (fatal && !failures.includes(errorText(fatal))) failures.push(errorText(fatal));
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
      actualSettings:
        core.activeSettingsHash ?? createHash('sha256').update(settings).digest('hex'),
      appliedSettings: core.appliedSettingsHashes,
    },
    versions: {
      protocol: z
        .object({ version: z.string() })
        .parse(
          JSON.parse(
            await readFile(
              new URL('../node_modules/@atlas/protocol/package.json', import.meta.url),
              'utf8',
            ),
          ),
        ).version,
      sdk: z
        .object({ version: z.string() })
        .parse(
          JSON.parse(
            await readFile(
              new URL('../node_modules/@atlas/sdk/package.json', import.meta.url),
              'utf8',
            ),
          ),
        ).version,
      core: z
        .object({ version: z.string() })
        .parse(
          JSON.parse(
            await readFile(new URL('../../Atlas Core/package.json', import.meta.url), 'utf8'),
          ),
        ).version,
    },
    checks,
    cleanup,
    verdict: !failures.length && passed(checks, cleanup) ? 'passed' : 'failed',
    failures,
    measurements: {
      ...truth?.measurements.values(),
      ...storage,
      requests: proxy?.requests ?? 0,
      latencyUnobservedRequests: Math.max(
        0,
        (proxy?.requests ?? 0) - (truth?.measurements.attempts ?? 0),
      ),
      pictureLagOmissions: truth?.commits.size ?? 0,
      durationMs: performance.now() - started,
      simulatorCpuMs: (elapsedCpu.user + elapsedCpu.system) / 1000,
      simulatorPeakMemory: truth?.measurements.simulatorPeakMemory ?? process.memoryUsage().rss,
    },
    environment: {
      node: process.version,
      npm: await command('npm', ['--version']).catch(() => 'unavailable'),
      docker: await command('docker', ['version', '--format', '{{.Server.Version}}']).catch(
        () => 'unavailable',
      ),
      cpu: cpus()[0]?.model ?? 'unknown',
      cpus: cpus().length,
      memory: totalmem(),
      kernel: release(),
      image: image.trim(),
    },
  };
  if (process.env.ATLAS_EVAL_HISTORY) {
    try {
      await saveRecord(process.env.ATLAS_EVAL_HISTORY, record);
    } catch (error) {
      record.verdict = 'failed';
      record.failures.push(`History publication ${errorText(error)}`);
    }
  }
  await saveRecord(join(core.directory, 'records'), record);
  return record;
}
