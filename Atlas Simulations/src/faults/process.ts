import { activation } from './common.js';
import { wait } from './common.js';
import type { ProxyEvent } from '../proxy.js';
import type { HttpClient } from '@atlas/sdk';
import { createClient } from '@atlas/sdk';
import { request } from 'node:https';
import { id, success } from '../sdk.js';
import type { FaultInput, FaultReceipt } from './common.js';
import { asset, json, observed, receipt } from './common.js';
export async function exerciseProcess(input: FaultInput): Promise<FaultReceipt> {
  const runtime = asset(input),
    client = runtime.client,
    asset_id = runtime.identity.asset_id;
  const before = async () => success(await input.operator.input.reader.assets.get({ asset_id }));
  switch (input.action.id) {
    case 'core-restart':
    case 'core-kill': {
      const snapshot = await before();
      const initialState = client.state;
      if (initialState.kind !== 'ready') throw new Error('Lifecycle Asset client is not ready');
      const operation = runtime.preparePosition();
      let witness: ProxyEvent | undefined;
      let admitted: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      input.proxy.arm({
        path: '/messages/update_asset',
        requestId: operation.submission.facts.request_id,
        kind: 'delay',
        delayMs: 15000,
        fired: (event) => {
          witness = event;
          admitted?.();
        },
      });
      const writeStartedAt = performance.now();
      const pending = observed(operation, runtime, 10000).then((result) => ({
        result,
        settledAt: performance.now(),
      }));
      let verifier: HttpClient | undefined;
      let primary: unknown;
      try {
        await activation(barrier, input);
        let identity: string;
        const requestedAt = performance.now();
        let killedAt: number | undefined;
        if (input.action.id === 'core-kill') {
          identity = await input.core.kill();
          killedAt = performance.now();
          await input.core.cli(['start']);
        } else {
          identity = await input.core.findContainer();
          await input.core.cli(['restart']);
        }
        await input.core.findContainer();
        if (!witness) throw new Error('Lifecycle request witness absent');
        const closed = input.proxy.closeConnection(witness.connection);
        verifier = createClient({
          baseUrl: input.proxy.baseUrl,
          datasetId: input.operator.input.datasetId,
          credentials: () => input.core.credential.secret,
        });
        const currentHealth = success(await verifier.connect());
        const settled = await pending;
        const first = settled.result;
        const interruption = closed
          ? { kind: 'proxy', event: closed }
          : { kind: 'sdk', attempt: first.attempt };
        let retry = await observed(operation, runtime);
        for (let attempt = 0; retry.outcome.kind === 'unknown_outcome' && attempt < 10; attempt++) {
          await wait(input, 100);
          retry = await observed(operation, runtime);
        }
        await runtime.checkContact();
        const retained = [];
        const history = verifier.assets.history({
          entity_id: asset_id,
          query_id: id(),
          page_size: 1000,
        });
        const original =
          snapshot.telemetry?.state === 'value'
            ? snapshot.telemetry.constituents.position
            : undefined;
        try {
          for (let page = 0; page < 101; page++) {
            const next = await history.next();
            if (next.kind === 'end') break;
            for (const row of success(next).readings)
              if (row.source_evidence.reading_id === original?.reading_id) {
                if (retained.length >= 16) throw new Error('Retained reading witness budget');
                retained.push(row);
              }
            if (page === 100) throw new Error('Retained reading history page budget');
          }
        } finally {
          const closed = await history.close();
          if (closed.kind === 'abandoned') {
            if (!['unallocated', 'acknowledged'].includes(closed.evidence))
              throw new Error('Retained history release unverified');
          } else success(closed);
        }
        return receipt(input.action.id, 'container', identity, input.action.id, [
          snapshot,
          success(await verifier.assets.get({ asset_id })),
          {
            witness,
            interruption,
            timing: {
              writeStartedAt,
              requestedAt,
              writeSettledAt: settled.settledAt,
              ...(killedAt === undefined ? {} : { killedAt }),
            },
            beforeRun: initialState.health.core_run_id,
            afterRun: currentHealth.core_run_id,
            first,
            retry,
            identity: operation.submission.identity,
            requestId: operation.submission.facts.request_id,
          },
          retained,
        ]);
      } catch (error) {
        primary = error;
        throw error;
      } finally {
        operation.close();
        try {
          await verifier?.close();
        } catch (error) {
          if (primary)
            throw new AggregateError(
              [primary, error],
              'Lifecycle fault and verifier cleanup failed',
            );
          throw error;
        }
      }
    }
    case 'core-drain': {
      const operation = runtime.preparePosition();
      const bytes = Buffer.from(JSON.stringify(operation.submission.facts));
      const held = request(new URL('/messages/update_asset', input.core.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'content-length': bytes.length,
          authorization: `Bearer ${runtime.identity.secret}`,
          'atlas-protocol-version': '0.5.0',
          'atlas-dataset-id': input.operator.input.datasetId,
        },
      });
      const response = new Promise<unknown>((resolve, reject) => {
        held.once('response', (reply) => {
          const parts: Buffer[] = [];
          reply.on('data', (part: Buffer) => parts.push(part));
          reply.once('end', () =>
            resolve({
              status: reply.statusCode,
              body: JSON.parse(Buffer.concat(parts).toString()),
            }),
          );
          reply.once('error', reject);
        });
        held.once('error', reject);
      });
      void response.catch(() => {});
      held.write(bytes.subarray(0, -1));
      await wait(input, 100);
      const samples: unknown[] = [];
      let stopped = false;
      const stop = input.core.cli(['stop']).finally(() => {
        stopped = true;
      });
      try {
        while (!stopped && samples.length < 1000) {
          try {
            const response = await input.operator.client.readiness({});
            samples.push(json(response));
          } catch (e) {
            samples.push({ failure: e instanceof Error ? e.message : 'readiness' });
          }
          if (JSON.stringify(samples.at(-1)).includes('"ready":false')) break;
          if (samples.length % 5 === 0) {
            try {
              samples.push(json(await input.core.cli(['inspect'])));
            } catch (error) {
              samples.push({ inspectionFailure: String(error).slice(0, 256) });
            }
            if (JSON.stringify(samples.at(-1)).includes('"ready":false')) break;
          }
          await wait(input, 10);
        }
        held.end(bytes.subarray(-1));
        const rawResult = await response;
        await stop;
        await input.core.cli(['start']);
        await input.core.findContainer();
        const result = (await observed(operation, runtime)).attempt;
        return receipt(input.action.id, 'container', input.core.containerId ?? 'missing', 'stop', [
          samples,
          result,
          { outcome: operation.outcome, rawResult },
        ]);
      } finally {
        held.destroy();
        operation.close();
      }
    }
    case 'core-reset': {
      const snapshot = await before(),
        identity = await input.core.findContainer();
      await runtime.position();
      let stopTraffic = false;
      const traffic = (async () => {
        while (!stopTraffic) {
          try {
            await runtime.position();
          } catch (error) {
            if ('reason' in client.state && client.state.reason === 'dataset_invalidated') return;
            throw error;
          }
          await wait(input, 50);
        }
      })();
      void traffic.catch(() => {});
      try {
        await input.core.cli(['reset']);
        await input.core.cli(['start']);
        await input.core.findContainer();
      } finally {
        stopTraffic = true;
        await traffic;
      }
      const old = await client.assets.get({ asset_id });
      const requestsBefore = input.proxy.requestCounts.get('/messages/get_asset') ?? 0;
      const stoppedRead = await client.assets.get({ asset_id });
      const requestsAfter = input.proxy.requestCounts.get('/messages/get_asset') ?? 0;
      const fresh = createClient({
        baseUrl: input.proxy.baseUrl,
        credentials: () => input.core.credential.secret,
      });
      try {
        success(await fresh.connect());
        return receipt(input.action.id, 'container', identity, 'reset', [
          snapshot,
          old,
          await fresh.assets.get({ asset_id }),
          { oldDataset: input.operator.input.datasetId, newDataset: fresh.state.datasetId },
          client.state,
          { stoppedRead, requestsBefore, requestsAfter },
        ]);
      } finally {
        await fresh.close();
      }
    }

    default:
      throw new Error('Fault dispatched to wrong owner');
  }
}
