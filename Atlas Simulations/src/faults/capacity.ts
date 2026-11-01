import { wait } from './common.js';
import { Opaque } from '@atlas/protocol';
import { createClient } from '@atlas/sdk';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { Peer } from '../peer.js';
import { id, success } from '../sdk.js';
import type { FaultInput, FaultReceipt } from './common.js';
import { asset, committedCursor, observed, raw, receipt } from './common.js';
export async function exerciseCapacity(input: FaultInput): Promise<FaultReceipt> {
  const runtime = asset(input),
    asset_id = runtime.identity.asset_id;
  const before = async () => success(await input.operator.input.reader.assets.get({ asset_id }));
  switch (input.action.id) {
    case 'picture-capacity': {
      const extra = input.operator.client.geofeatures.create({
        request_id: id(),
        geofeature_id: id(),
        geometry: { type: 'Point', coordinates: [0, 0] },
      });
      try {
        success((await extra.send()).attempt);
      } finally {
        extra.close();
      }
      const probe = createClient({
        baseUrl: input.proxy.baseUrl,
        credentials: () => input.core.credential.secret,
        mode: 'full',
        picture: { images: 1, bytes: 65536 },
      });
      try {
        success(await probe.connect());
        await wait(input, 1000);
        return receipt(input.action.id, 'http', id(), '/sync', [probe.picture.status]);
      } finally {
        await probe.close();
      }
    }
    case 'task-limit': {
      const tasks: ReturnType<typeof id>[] = [];
      for (let slot = 0; slot < 1000; slot++) {
        input.signal?.throwIfAborted();
        const task_id = id();
        const operation = input.operator.client.tasks.create({
          request_id: id(),
          task_id,
          asset_id,
          command: 'move_to',
          scheduling: 'queued',
          inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } },
        });
        try {
          success((await operation.send()).attempt);
          tasks.push(task_id);
        } finally {
          operation.close();
        }
      }
      const task_id = id();
      const extra = input.operator.client.tasks.create({
        request_id: id(),
        task_id,
        asset_id,
        command: 'move_to',
        scheduling: 'queued',
        inputs: { target: { kind: 'position', position: { latitude: 0, longitude: 0 } } },
      });
      const first = tasks[0];
      if (!first) throw new Error('Task admission empty');
      const terminal = runtime.prepareExecution({
        task_id: first,
        event: 'state',
        state: 'failed',
        reason: 'qualification',
      });
      try {
        return receipt(
          input.action.id,
          'http',
          extra.submission.identity,
          '/messages/create_task',
          [
            { admitted: tasks.length },
            await extra.send(),
            await observed(terminal, runtime),
            await before(),
          ],
        );
      } finally {
        extra.close();
        terminal.close();
      }
    }
    case 'storage-pressure': {
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
      const settings = z
        .record(z.string(), z.json())
        .parse(JSON.parse(await readFile(join(input.core.directory, 'settings.json'), 'utf8')));
      const candidate = {
        ...settings,
        storageBytes: 67108865,
        objectBytes: 0,
        freeDiskBytes: 0,
        reserveBytes: 67108864,
      };
      const path = join(input.core.directory, 'pressure-settings.json');
      await writeFile(path, JSON.stringify(candidate), { mode: 0o600 });
      const show = z
        .object({ revision: z.string() })
        .parse(await input.core.cli(['settings', 'show']));
      await input.core.cli([
        'settings',
        'save',
        '--expected-revision',
        show.revision,
        '--file',
        path,
      ]);
      await input.core.cli(['settings', 'apply', '--restart']);
      await input.core.findContainer();
      const ordinary = runtime.preparePosition(),
        terminal = runtime.prepareExecution({
          task_id,
          event: 'state',
          state: 'failed',
          reason: 'qualification',
        });
      try {
        const refusal = await observed(ordinary, runtime),
          completion = await observed(terminal, runtime),
          read = await before();
        const current = z
          .object({ revision: z.string() })
          .parse(await input.core.cli(['settings', 'show']));
        await input.core.cli([
          'settings',
          'save',
          '--expected-revision',
          current.revision,
          '--file',
          join(input.core.directory, 'settings.json'),
        ]);
        await input.core.cli(['settings', 'apply', '--restart']);
        await input.core.findContainer();
        return receipt(
          input.action.id,
          'http',
          ordinary.submission.identity,
          '/messages/update_asset',
          [refusal, completion, read],
        );
      } finally {
        ordinary.close();
        terminal.close();
      }
    }
    case 'sync-connection-limit': {
      const peers: Peer[] = [];
      const authenticated: unknown[] = [];
      try {
        for (let slot = 0; slot < 31; slot++) {
          const peer = new Peer(
            input.proxy.baseUrl,
            input.operator.input.datasetId,
            input.core.credential.secret,
          );
          peers.push(peer);
          const frame = await peer.next();
          if (frame.type !== 'authenticated') throw new Error(`Peer ${slot} ${frame.type}`);
          authenticated.push({ type: frame.type });
        }
        const extra = new Peer(
          input.proxy.baseUrl,
          input.operator.input.datasetId,
          input.core.credential.secret,
        );
        peers.push(extra);
        const refused = await extra.next();
        const first = peers[0],
          cursor = await committedCursor(runtime);
        if (!first || !cursor) throw new Error('Existing peer cursor missing');
        first.send({
          type: 'read_changes',
          request_id: id(),
          dataset_id: input.operator.input.datasetId,
          protocol_version: '0.5.0',
          data: {
            from_cursor: Opaque.parse(cursor),
            max_message_bytes: 4194304,
            max_json_values: 262144,
            max_changes: 1000,
          },
        });
        return receipt(input.action.id, 'http', id(), '/changes', [
          authenticated,
          refused,
          await first.next(),
        ]);
      } finally {
        for (const peer of peers) await peer.close();
      }
    }
    case 'replay-expired': {
      const settings = z
        .record(z.string(), z.json())
        .parse(JSON.parse(await readFile(join(input.core.directory, 'settings.json'), 'utf8')));
      const path = join(input.core.directory, 'replay-settings.json');
      await writeFile(path, JSON.stringify({ ...settings, replayMilliseconds: 1 }), {
        mode: 0o600,
      });
      const show = z
        .object({ revision: z.string() })
        .parse(await input.core.cli(['settings', 'show']));
      await input.core.cli([
        'settings',
        'save',
        '--expected-revision',
        show.revision,
        '--file',
        path,
      ]);
      await input.core.cli(['settings', 'apply', '--restart']);
      await input.core.findContainer();
      const deadline = performance.now() + 10000;
      while (input.operator.client.picture.status.kind !== 'synchronized') {
        if (performance.now() > deadline) throw new Error('Operator rebuild deadline');
        await wait(input, 50);
      }
      const cursor = await committedCursor(runtime);
      if (!cursor) throw new Error('Replay cursor absent');
      await runtime.position();
      await wait(input, 1600);
      await runtime.position();
      input.proxy.closeConnections();
      await wait(input, 100);
      const result = await raw(input, '/messages/read_changes', {
        from_cursor: cursor,
        max_message_bytes: 4194304,
        max_json_values: 262144,
        max_changes: 1000,
      });
      const snapshot = await before();
      const boundary = performance.now() + 10000;
      while (true) {
        const picture = input.operator.client.assets.get({ asset_id });
        if (
          picture.kind === 'available' &&
          !picture.stale &&
          picture.value?.version === snapshot.version
        )
          break;
        if (performance.now() > boundary) throw new Error('Replay picture commit boundary');
        await wait(input, 20);
      }
      return receipt(input.action.id, 'http', id(), '/messages/read_changes', [
        { cursor },
        result,
        snapshot,
        input.operator.client.assets.get({ asset_id }),
      ]);
    }
    case 'slow-consumer': {
      const peer = new Peer(
        input.proxy.baseUrl,
        input.operator.input.datasetId,
        input.core.credential.secret,
      );
      try {
        const auth = await peer.next();
        if (auth.type !== 'authenticated') throw new Error('Slow peer authentication failed');
        const cursor = await committedCursor(runtime);
        if (!cursor) throw new Error('Slow consumer cursor missing');
        peer.send({
          type: 'subscribe_changes',
          request_id: id(),
          dataset_id: input.operator.input.datasetId,
          protocol_version: '0.5.0',
          data: {
            subscription_id: id(),
            from_cursor: Opaque.parse(cursor),
            max_message_bytes: 4194304,
            max_json_values: 262144,
            max_changes: 1000,
          },
        });
        let subscribed = false;
        for (let frame = 0; frame < 8; frame++) {
          const response = await peer.next();
          if (response.type === 'handoff_complete') {
            subscribed = true;
            break;
          }
        }
        if (!subscribed) throw new Error('Slow consumer subscription did not hand off');
        const pauses = input.proxy.upstreamPauses,
          closures = input.proxy.upstreamClosures;
        const resumeAffected = input.proxy.pauseChanges();
        peer.drainBatches = true;
        peer.pause();
        let snapshot = await before();
        for (let report = 0; report < 4000; report++) {
          input.signal?.throwIfAborted();
          const operation = input.operator.client.assets.update({
            request_id: id(),
            asset_id,
            expected_edit_revision: snapshot.edit_revision,
            description: { name: `pressure ${report}`, description: 'x'.repeat(4096) },
          });
          try {
            snapshot = success((await operation.send()).attempt).asset;
          } finally {
            operation.close();
          }
        }
        resumeAffected();
        peer.resume();
        input.operator.client.picture.retry();
        const ended = await peer.next(10000);
        const deadline = performance.now() + 60000;
        while (true) {
          const picture = input.operator.client.assets.get({ asset_id });
          if (
            picture.kind === 'available' &&
            !picture.stale &&
            picture.value?.version === snapshot.version
          )
            break;
          if (performance.now() > deadline)
            throw new Error(
              'Full recovery deadline ' +
                JSON.stringify({
                  status: input.operator.client.picture.status,
                  receivedVersion: input.operator.client.assets.get({ asset_id }).kind,
                  expectedVersion: snapshot.version,
                }),
            );
          await wait(input, 50);
        }
        return receipt(input.action.id, 'proxy', id(), '/changes', [
          {
            pausesBefore: pauses,
            pausesAfter: input.proxy.upstreamPauses,
            committed: 4000,
            closuresBefore: closures,
            closuresAfter: input.proxy.upstreamClosures,
          },
          ended,
          await before(),
          input.operator.client.assets.get({ asset_id }),
        ]);
      } finally {
        await peer.close();
      }
    }

    default:
      throw new Error('Fault dispatched to wrong owner');
  }
}
