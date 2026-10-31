import { wait } from './common.js';
import { Counter, Timestamp } from '@atlas/protocol';
import { id, success } from '../sdk.js';
import type { FaultInput, FaultReceipt } from './common.js';
import { asset, observed, receipt } from './common.js';
export async function exerciseTasks(input: FaultInput): Promise<FaultReceipt> {
  const runtime = asset(input),
    client = runtime.client,
    asset_id = runtime.identity.asset_id;
  const before = async () => success(await input.operator.input.reader.assets.get({ asset_id }));
  switch (input.action.id) {
    case 'resume-expired':
    case 'resume-superseded':
    case 'cancel-race':
    case 'cancel-held':
    case 'cancel-refused':
    case 'terminal-conflict':
    case 'execution-conflict':
    case 'queue-changed': {
      const create = async (command: 'pause' | 'resume' | 'move_to', far = false) => {
        const task_id = id(),
          common = { request_id: id(), task_id, asset_id };
        const operation = input.operator.client.tasks.create(
          command === 'move_to'
            ? {
                ...common,
                command,
                scheduling: 'queued',
                inputs: {
                  target: {
                    kind: 'position',
                    position: far
                      ? { latitude: 0, longitude: 0 }
                      : { ...runtime.input.world.get(runtime.alias).position },
                  },
                },
              }
            : command === 'pause'
              ? { ...common, command, scheduling: 'immediate', inputs: {} }
              : {
                  ...common,
                  command,
                  scheduling: 'immediate',
                  inputs: {},
                  expires_at: Timestamp.parse(new Date(Date.now() + 1000).toISOString()),
                },
        );
        try {
          success((await operation.send()).attempt);
          return task_id;
        } finally {
          operation.close();
        }
      };
      const get = async (task_id: ReturnType<typeof id>) =>
        success(await input.operator.input.reader.tasks.get({ task_id }));
      const poll = () => runtime.pollInstructions();
      if (input.action.id === 'queue-changed') {
        const first = await create('move_to'),
          second = await create('move_to');
        const handle = client.tasks.assigned({
          asset_id,
          process_generation: runtime.identity.process_generation,
          read_id: id(),
          page_size: 1,
        });
        try {
          const firstPage = await handle.next();
          if (firstPage.kind === 'end') throw new Error('Assigned first page missing');
          const page = success(firstPage);
          const order = input.operator.client.tasks.setOrder({
            asset_id,
            request_id: id(),
            expected_queue_revision: page.task_queue.revision,
            task_ids: [second, first],
          });
          try {
            success((await order.send()).attempt);
          } finally {
            order.close();
          }
          const continuation = await handle.next();
          const fresh = client.tasks.assigned({
            asset_id,
            process_generation: runtime.identity.process_generation,
            read_id: id(),
            page_size: 100,
          });
          try {
            return receipt(
              input.action.id,
              'http',
              handle.selection.read_id,
              '/messages/get_assigned_tasks',
              [page, continuation, await fresh.next()],
            );
          } finally {
            fresh.close();
          }
        } finally {
          handle.close();
        }
      }
      if (input.action.id === 'resume-expired' || input.action.id === 'resume-superseded') {
        await create('pause');
        await poll();
        const paused = await before();
        const resume = await create('resume');
        if (input.action.id === 'resume-expired') await wait(input, 1100);
        else await create('pause');
        await poll();
        return receipt(
          input.action.id,
          'runtime',
          runtime.identity.process_generation,
          'instructions',
          [paused, await get(resume), await before()],
        );
      }
      const task = await create(
        'move_to',
        input.action.id === 'cancel-held' || input.action.id === 'cancel-refused',
      );
      await poll();
      if (input.action.id === 'cancel-refused') {
        const cancel = input.operator.client.tasks.cancel({ task_id: task, request_id: id() });
        try {
          success((await cancel.send()).attempt);
        } finally {
          cancel.close();
        }
        runtime.hooks.refuseCancellation = true;
        try {
          const requested = await get(task);
          await poll();
          return receipt(
            input.action.id,
            'runtime',
            runtime.identity.process_generation,
            'cancel',
            [requested, await get(task)],
          );
        } finally {
          runtime.hooks.refuseCancellation = false;
        }
      }
      if (input.action.id === 'cancel-held') {
        const cancelRunning = input.operator.client.tasks.cancel({
          task_id: task,
          request_id: id(),
        });
        try {
          success((await cancelRunning.send()).attempt);
        } finally {
          cancelRunning.close();
        }
        await poll();
        const second = await create('move_to'),
          third = await create('move_to');
        const cancel = input.operator.client.tasks.cancel({ task_id: second, request_id: id() });
        try {
          success((await cancel.send()).attempt);
        } finally {
          cancel.close();
        }
        runtime.hooks.cancellationHoldUntil = performance.now() + 1500;
        await poll();
        const held = await get(third);
        runtime.hooks.cancellationHoldUntil = 0;
        await poll();
        for (let turn = 0; turn < 4; turn++) {
          await poll();
          await wait(input, 150);
        }
        return receipt(
          input.action.id,
          'runtime',
          runtime.identity.process_generation,
          'cancel-held',
          [held, await get(second), await before(), await get(third)],
        );
      }
      const deadline = performance.now() + 3000;
      while (runtime.execution.kind !== 'reporting-terminal') {
        if (performance.now() > deadline) throw new Error('Arrival barrier missed');
        await wait(input, 20);
      }
      if (input.action.id === 'cancel-race') {
        const cancel = input.operator.client.tasks.cancel({ task_id: task, request_id: id() });
        try {
          const request = await cancel.send();
          await poll();
          return receipt(
            input.action.id,
            'runtime',
            runtime.identity.process_generation,
            'arrival',
            [
              request,
              await get(task),
              { position: runtime.input.world.get(runtime.alias).position },
            ],
          );
        } finally {
          cancel.close();
        }
      }
      await poll();
      const completed = await get(task);
      if (input.action.id === 'terminal-conflict') {
        const conflict = runtime.prepareExecution({
          task_id: task,
          event: 'state',
          state: 'failed',
          reason: 'test-conflict',
        });
        try {
          return receipt(
            input.action.id,
            'http',
            conflict.submission.identity,
            '/messages/report_task_execution',
            [completed, await observed(conflict, runtime), await get(task)],
          );
        } finally {
          conflict.close();
        }
      }
      const operation = runtime.prepareExecution({
        task_id: task,
        event: 'state',
        state: 'completed',
      });
      try {
        const original = await observed(operation, runtime);
        const conflict = client.tasks.reportExecution({
          evidence: {
            ...operation.submission.facts.evidence,
            report_id: id(),
            payload: { task_id: task, event: 'state', state: 'failed', reason: 'changed-facts' },
          },
        });
        try {
          return receipt(
            input.action.id,
            'http',
            conflict.submission.identity,
            '/messages/report_task_execution',
            [original, await observed(conflict, runtime), completed, await get(task)],
          );
        } finally {
          conflict.close();
        }
      } finally {
        operation.close();
      }
    }

    case 'reorder-stale': {
      const snapshot = await before();
      const op = input.operator.client.tasks.setOrder({
        request_id: id(),
        asset_id,
        expected_queue_revision: Counter.parse('18446744073709551615'),
        task_ids: snapshot.task_queue.requested_task_ids,
      });
      try {
        return receipt(
          input.action.id,
          'http',
          op.submission.identity,
          '/messages/set_task_order',
          [(await op.send()).attempt, snapshot, await before()],
        );
      } finally {
        op.close();
      }
    }
    case 'asset-deleted': {
      const snapshot = await before();
      const op = input.operator.client.assets.delete({ request_id: id(), asset_id });
      try {
        const result = await op.send();
        const report = runtime.preparePosition();
        try {
          return receipt(
            input.action.id,
            'http',
            op.submission.identity,
            '/messages/delete_asset',
            [result, await observed(report, runtime), snapshot],
          );
        } finally {
          report.close();
        }
      } finally {
        op.close();
      }
    }
    case 'pause-empty': {
      await input.operator.apply({ at_seconds: 0, action: 'pause', asset: runtime.alias });
      await runtime.pollInstructions();
      const snapshot = await before();
      const tasks: ReturnType<typeof id>[] = [];
      for (let slot = 0; slot < 2; slot++) {
        const task_id = id();
        const op = input.operator.client.tasks.create({
          request_id: id(),
          task_id,
          asset_id,
          command: 'move_to',
          scheduling: 'queued',
          inputs: {
            target: {
              kind: 'position',
              position: { ...runtime.input.world.get(runtime.alias).position },
            },
          },
        });
        try {
          success((await op.send()).attempt);
        } finally {
          op.close();
        }
        tasks.push(task_id);
      }
      await runtime.pollInstructions();
      const get = async (task_id: ReturnType<typeof id>) =>
        success(await input.operator.input.reader.tasks.get({ task_id }));
      const held = await Promise.all(tasks.map(get));
      await input.operator.apply({ at_seconds: 0, action: 'resume', asset: runtime.alias });
      await runtime.pollInstructions();
      for (let turn = 0; turn < 5; turn++) {
        await runtime.pollInstructions();
        await wait(input, 150);
      }
      return receipt(
        input.action.id,
        'runtime',
        runtime.identity.process_generation,
        'instructions',
        [snapshot, held, await Promise.all(tasks.map(get))],
      );
    }
    case 'geofeature-edited': {
      const initial = { latitude: 52.5, longitude: -0.1 };
      const create = input.operator.client.geofeatures.create({
        request_id: id(),
        geofeature_id: id(),
        geometry: { type: 'Point', coordinates: [initial.longitude, initial.latitude] },
      });
      let feature;
      try {
        feature = success((await create.send()).attempt);
      } finally {
        create.close();
      }
      const task_id = id(),
        task = input.operator.client.tasks.create({
          request_id: id(),
          task_id,
          asset_id,
          command: 'move_to',
          scheduling: 'queued',
          inputs: { target: { kind: 'geofeature', geofeature_id: feature.id } },
        });
      try {
        success((await task.send()).attempt);
      } finally {
        task.close();
      }
      await runtime.pollInstructions();
      const edit = input.operator.client.geofeatures.edit({
        request_id: id(),
        geofeature_id: feature.id,
        expected_edit_revision: feature.edit_revision,
        edits: { geometry: { type: 'Point', coordinates: [0, 0] } },
      });
      let edited;
      try {
        edited = success((await edit.send()).attempt);
      } finally {
        edit.close();
      }
      const deadline = performance.now() + 20000;
      while (runtime.execution.kind !== 'reporting-terminal') {
        if (performance.now() > deadline) throw new Error('Geofeature arrival deadline');
        await wait(input, 50);
      }
      await runtime.pollInstructions();
      return receipt(input.action.id, 'http', feature.id, '/messages/edit_geofeature', [
        feature,
        edited,
        success(await input.operator.input.reader.tasks.get({ task_id })),
        await before(),
        { target: initial },
      ]);
    }

    default:
      throw new Error('Fault dispatched to wrong owner');
  }
}
