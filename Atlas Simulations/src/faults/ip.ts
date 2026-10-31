import { activation } from './common.js';
import { wait } from './common.js';
import type { Prepared } from '@atlas/sdk';
import { createClient } from '@atlas/sdk';
import type { ProxyEvent } from '../proxy.js';
import { id, success } from '../sdk.js';
import type { FaultInput, FaultReceipt } from './common.js';
import { asset, json, observed, raw, receipt } from './common.js';
export async function exerciseIp(input: FaultInput): Promise<FaultReceipt> {
  const runtime = asset(input),
    asset_id = runtime.identity.asset_id;
  const before = async () => success(await input.operator.input.reader.assets.get({ asset_id }));
  switch (input.action.id) {
    case 'reply-lost':
    case 'reply-delayed':
    case 'reply-altered': {
      await runtime.writes.drain();
      async function probe<R, T>(operation: Prepared<R, T>, path: string): Promise<FaultReceipt> {
        let intercepted: ProxyEvent | undefined;
        const kind =
          input.action.id === 'reply-lost'
            ? 'drop'
            : input.action.id === 'reply-delayed'
              ? 'delay'
              : 'alter';
        input.proxy.arm({
          path,
          kind,
          delayMs: 1000,
          fired: (event) => {
            intercepted = event;
          },
        });
        try {
          const first = await observed(operation, runtime, 300);
          const second = await observed(operation, runtime);
          if (!intercepted) throw new Error('Proxy fault never intercepted a reply');
          let late: unknown = null;
          if (input.action.id === 'reply-delayed') {
            const delayed = runtime.preparePosition();
            const cancelled = new AbortController();
            input.proxy.arm({
              path: '/messages/update_asset',
              kind: 'delay',
              delayMs: 1000,
              fired: () => cancelled.abort(),
            });
            try {
              const attempt = delayed.start({ timeoutMs: 3000 });
              const wait = await attempt.wait(cancelled.signal);
              const whileCancelled = delayed.outcome;
              const settled = await attempt.settled;
              late = { wait, whileCancelled, settled, outcome: delayed.outcome };
              const identity = `${delayed.submission.operation}/${delayed.submission.identity}`;
              runtime.writes.truth.append({
                kind: 'submitted',
                source: 'fault',
                identity,
                operation: delayed.submission.operation,
                facts: json(delayed.submission.facts),
              });
              runtime.writes.truth.append({ kind: 'attempt', identity, result: json(settled) });
              runtime.writes.truth.append({
                kind: 'outcome',
                identity,
                outcome: json(delayed.outcome),
              });
            } finally {
              delayed.close();
            }
          }
          return receipt(input.action.id, 'proxy', intercepted.connection, path, [
            intercepted,
            { identity: operation.submission.identity, first, second, outcome: operation.outcome },
            await before(),
            late,
          ]);
        } finally {
          operation.close();
        }
      }
      const writeKind = input.action.write_kind ?? 'telemetry';
      if (writeKind === 'tags') return probe(runtime.prepareTags(), '/messages/update_asset');
      if (writeKind === 'observation')
        return probe(await runtime.prepareObservation(), '/messages/report_observation');
      if (writeKind === 'execution') {
        const task_id = id();
        const task = input.operator.client.tasks.create({
          request_id: id(),
          task_id,
          asset_id,
          command: 'move_to',
          scheduling: 'queued',
          inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } },
        });
        try {
          success((await task.send()).attempt);
        } finally {
          task.close();
        }
        return probe(
          runtime.prepareExecution({
            task_id,
            event: 'state',
            state: 'failed',
            reason: 'qualification',
          }),
          '/messages/report_task_execution',
        );
      }
      return probe(runtime.preparePosition(), '/messages/update_asset');
    }
    case 'connections-closed': {
      const operation = runtime.preparePosition();
      let admitted: (() => void) | undefined;
      const barrier = new Promise<void>((resolve) => {
        admitted = resolve;
      });
      input.proxy.arm({
        path: '/messages/update_asset',
        kind: 'delay',
        delayMs: 2000,
        fired: () => admitted?.(),
      });
      const pending = observed(operation, runtime, 3000);
      try {
        await activation(barrier, input);
        const events = input.proxy.closeConnections();
        const first = await pending;
        const requestsBefore = input.proxy.requestCounts.get('/messages/update_asset') ?? 0;
        await wait(input, 500);
        const requestsAfter = input.proxy.requestCounts.get('/messages/update_asset') ?? 0;
        const beforeRetry = operation.outcome;
        const result = await observed(operation, runtime);
        const snapshot = await before();
        const deadline = performance.now() + 10000;
        while (true) {
          const picture = input.operator.client.assets.get({ asset_id });
          if (
            picture.kind === 'available' &&
            !picture.stale &&
            picture.value?.version === snapshot.version
          )
            break;
          if (performance.now() > deadline)
            throw new Error('Closed Full connection did not recover to commit boundary');
          await wait(input, 20);
        }
        return receipt(
          input.action.id,
          'proxy',
          events[0]?.connection ?? 'no-active-connection',
          '*',
          [
            events,
            result,
            snapshot,
            {
              first,
              beforeRetry,
              requestsBefore,
              requestsAfter,
              picture: input.operator.client.assets.get({ asset_id }),
            },
          ],
        );
      } finally {
        operation.close();
      }
    }
    case 'malformed-request':
    case 'request-too-large': {
      const snapshot = await before();
      const result = await raw(
        input,
        '/messages/update_asset',
        input.action.id === 'malformed-request' ? '{' : ' '.repeat(1048577),
      );
      return receipt(input.action.id, 'http', id(), '/messages/update_asset', [
        result,
        snapshot,
        await before(),
      ]);
    }
    case 'version-mismatch': {
      let intercepted: ProxyEvent | undefined;
      input.proxy.arm({
        path: '/health',
        kind: 'version',
        fired: (event) => {
          intercepted = event;
        },
      });
      const probe = createClient({
        baseUrl: input.proxy.baseUrl,
        credentials: () => input.core.credential.secret,
      });
      try {
        const connected = await probe.connect();
        const read = await probe.assets.get({ asset_id });
        if (!intercepted) throw new Error('Discovery was not intercepted');
        return receipt(input.action.id, 'proxy', intercepted.connection, '/health', [
          intercepted,
          connected,
          read,
        ]);
      } finally {
        await probe.close();
      }
    }

    default:
      throw new Error('Fault dispatched to wrong owner');
  }
}
