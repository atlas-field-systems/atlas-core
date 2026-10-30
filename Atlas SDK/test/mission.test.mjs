import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, uuid, secret, registration, task, barrier } from './harness.mjs';
import { success, sent, reading, telemetry } from './public-helpers.mjs';

async function until(predicate, label) {
  const deadline = performance.now() + 10_000;
  while (!predicate()) {
    assert.ok(performance.now() < deadline, label);
    await delay(10);
  }
}

function evidence(source, sequence, payload, report_id = uuid()) {
  return {
    dataset_id: source.datasetId,
    asset_id: source.facts.asset_id,
    origin: { kind: 'asset_process', process_generation: source.facts.process_generation },
    report_id,
    sequence: String(sequence),
    generated_at: '2026-10-21T12:00:00.0000001Z',
    payload,
  };
}

async function instructions(client, source) {
  const started = performance.now();
  const handle = client.tasks.assigned({
    asset_id: source.facts.asset_id,
    process_generation: source.facts.process_generation,
    read_id: uuid(),
    page_size: 1,
  });
  let context;
  const tasks = [];
  try {
    for (let page = 0; page < 5; page++) {
      const result = await handle.next();
      if (result.kind === 'end') {
        assert.ok(context);
        assert.ok(performance.now() - started < 10_000, 'Instructions arrived within validity');
        assert.equal(new Set(tasks.map((item) => item.task_id)).size, tasks.length);
        assert.ok(tasks.every((item) => item.asset_id === source.facts.asset_id));
        return { context, tasks };
      }
      const { tasks: items, next_page_token: _token, ...current } = success(result);
      if (context) assert.deepEqual(current, context);
      else context = current;
      assert.equal(current.process_generation, source.facts.process_generation);
      tasks.push(...items);
    }
    assert.fail('Assigned work exceeded the mission page bound');
  } finally {
    handle.close();
  }
}

async function history(client, kind, entity_id) {
  const handle = client[kind].history({ entity_id, query_id: uuid(), page_size: 1 });
  const rows = [];
  try {
    for (let page = 0; page < 6; page++) {
      const result = await handle.next();
      if (result.kind === 'end') return rows;
      rows.push(...success(result).readings);
    }
    assert.fail('History exceeded the mission page bound');
  } finally {
    success(await handle.close());
  }
}

const schedules = [
  { name: 'direct-first', modes: ['http', 'full'], order: [0, 1, 2], lost: 'observation' },
  { name: 'gateway-first', modes: ['full', 'http'], order: [2, 1, 0], lost: 'execution' },
];

for (const schedule of schedules)
  test(
    `mission ${schedule.name} combines direct IP, gateway Assets and two operators`,
    { timeout: 120_000 },
    async (t) => {
      const f = await fixture(t);
      const bootstrap = f.client();
      success(await bootstrap.connect());
      const operators = [];
      for (let index = 0; index < 2; index++) {
        const operator_id = uuid();
        sent(
          await bootstrap.operators
            .create({ operator_id, request_id: uuid(), name: `Pilot ${index}` })
            .send(),
        );
        const key = { api_key_id: uuid(), request_id: uuid(), operator_id, secret: secret() };
        sent(await bootstrap.apiKeys.create(key).send());
        const operator = { key, candidate: key.secret };
        operator.client = f.client({
          mode: schedule.modes[index],
          credentials: () => operator.candidate,
        });
        success(await operator.client.connect());
        operators.push(operator);
      }
      const [lead, watch] = operators.map((operator) => operator.client);
      const fullOperator = operators.find((operator) => operator.client.mode === 'full');
      const full = fullOperator.client;
      const gatewayKey = { api_key_id: uuid(), request_id: uuid(), secret: secret() };
      sent(await lead.apiKeys.create(gatewayKey).send());
      let gateway = f.client({ credentials: () => gatewayKey.secret });
      success(await gateway.connect());
      const waypoint = sent(
        await watch.geofeatures
          .create({
            geofeature_id: uuid(),
            request_id: uuid(),
            geometry: { type: 'Point', coordinates: [1, 1] },
          })
          .send(),
      );
      const sharedReport = uuid(),
        sharedReading = uuid();
      const sources = [];
      for (const [index, name] of ['direct', 'gateway-north', 'gateway-south'].entries()) {
        const facts = registration(name);
        facts.capabilities.commands.push(
          { command: 'pause', scheduling: ['immediate'] },
          { command: 'resume', scheduling: ['immediate'] },
        );
        sent(await (index === 0 ? lead : gateway).assets.register(facts).send());
        const client = index === 0 ? f.client({ credentials: () => facts.secret }) : gateway;
        if (index === 0) success(await client.connect());
        const source = {
          facts,
          client,
          datasetId: f.datasetId,
          publisherId: uuid(),
          observationId: uuid(),
          gate: 'running',
          active: null,
          actions: [],
          terminals: new Map(),
          assetSequence: 1,
          position: { latitude: 10 + index, longitude: -1 },
        };
        source.reporter = client.reporting.asset({
          id: facts.asset_id,
          process_generation: facts.process_generation,
        });
        const created = client.reporting.createObservation({
          observation_id: source.observationId,
          publisher_id: source.publisherId,
          source_asset_id: facts.asset_id,
          request_id: uuid(),
        });
        source.trackId = sent(await created.creation.send()).track.id;
        source.observation = created.reporter;
        source.moves = [0, 1].map((slot) => ({
          ...task(facts.asset_id),
          task_id: `10000000-0000-4000-8000-${String(index * 2 + slot + 1).padStart(12, '0')}`,
          inputs: {
            target:
              slot === 0
                ? { kind: 'geofeature', geofeature_id: waypoint.id }
                : { kind: 'position', position: { latitude: 20 + index, longitude: -1 } },
          },
        }));
        sources.push(source);
      }
      assert.equal(new Set(sources.map((source) => source.trackId)).size, 3);
      const [direct, north, south] = sources;
      for (const source of sources) {
        const contact = source.client.assets.contact({
          asset_id: source.facts.asset_id,
          process_generation: source.facts.process_generation,
          request_id: uuid(),
          mode: 'current',
        });
        try {
          const challenge = success(await contact.read());
          const report = source.reporter.update(
            { request_id: uuid() },
            reading(
              1,
              {},
              {
                generated_at: challenge.issued_at,
                contact_proof: { challenge_id: challenge.challenge_id },
              },
            ),
          );
          const checkedIn = sent(await contact.checkIn(report.submission.facts).send());
          assert.equal(checkedIn.asset.communications.health, 'healthy');
          assert.equal(report.outcome.kind, 'accepted');
        } finally {
          await contact.close();
        }
      }
      for (const index of schedule.order) {
        const source = sources[index];
        const origin = {
          kind: 'asset_process',
          process_generation: source.facts.process_generation,
        };
        sent(
          await source.reporter
            .update(
              { request_id: uuid() },
              {
                ...reading(1, {
                  telemetry: telemetry(origin, 10 + index, '2026-10-21T12:00:01Z', sharedReading),
                }),
                report_id: sharedReport,
              },
            )
            .send(),
        );
        const observationOrigin = { kind: 'publisher', publisher_id: source.publisherId };
        source.observationReport = source.observation.report({
          ...reading(1, {
            telemetry: telemetry(observationOrigin, 51, '2026-10-21T12:00:01Z', sharedReading),
          }),
          report_id: sharedReport,
        });
        if (schedule.lost === 'observation' && index === schedule.order[0]) {
          f.once('/messages/report_observation', ({ outgoing }) => outgoing.destroy());
          assert.equal((await source.observationReport.send()).outcome.kind, 'unknown_outcome');
          const retained = success(
            await watch.observations.get({ observation_id: source.observationId }),
          );
          assert.equal(retained.telemetry.value.position.latitude, 51);
          assert.equal(source.observationReport.outcome.kind, 'unknown_outcome');
          assert.equal(
            sent(await source.observationReport.send()).evidence_disposition,
            'duplicate',
          );
        } else sent(await source.observationReport.send());
        const track = success(await watch.http.tracks.get({ track_id: source.trackId }));
        assert.deepEqual(track.sources, [
          {
            observation_id: source.observationId,
            publisher_id: source.publisherId,
            source_asset_id: source.facts.asset_id,
          },
        ]);
        assert.equal(track.telemetry.value.position.latitude, 51);
        assert.equal(track.telemetry.evidence.entity_id, source.observationId);
        assert.equal(track.telemetry.evidence.report_id, sharedReport);
      }
      for (const source of sources) {
        await Promise.all([
          lead.tasks.create(source.moves[0]).send().then(sent),
          watch.tasks.create(source.moves[1]).send().then(sent),
        ]);
        const ordered = sent(
          await watch.tasks
            .setOrder({
              asset_id: source.facts.asset_id,
              request_id: uuid(),
              expected_queue_revision: '2',
              task_ids: [source.moves[1].task_id, source.moves[0].task_id],
            })
            .send(),
        );
        assert.deepEqual(ordered.task_queue.requested_task_ids, [
          source.moves[1].task_id,
          source.moves[0].task_id,
        ]);
        const assigned = await instructions(source.client, source);
        assert.deepEqual(
          assigned.tasks.map((item) => item.task_id),
          source.moves.map((item) => item.task_id),
        );
        assert.deepEqual(assigned.context.task_queue.requested_task_ids, [
          source.moves[1].task_id,
          source.moves[0].task_id,
        ]);
        assert.ok(
          assigned.tasks.every(
            (item) => item.execution_state === 'pending' && item.execution_summary === null,
          ),
        );
        for (const move of source.moves)
          assert.deepEqual(
            assigned.tasks.find((item) => item.task_id === move.task_id).inputs,
            move.inputs,
          );
        const adopted = sent(
          await source.client.tasks
            .confirmOrder({
              evidence: evidence(
                source,
                1,
                { queue_revision: assigned.context.task_queue.revision },
                sharedReport,
              ),
            })
            .send(),
        );
        assert.deepEqual(adopted.asset.task_queue.confirmed, {
          revision: assigned.context.task_queue.revision,
          process_generation: source.facts.process_generation,
        });
      }

      async function completeMove(source, slot, sequence = 2) {
        const move = source.moves[slot];
        assert.equal(source.gate, 'running');
        const assigned = await instructions(source.client, source);
        if (source.active === null) {
          assert.equal(assigned.context.task_queue.requested_task_ids[0], move.task_id);
          source.active = move.task_id;
          source.actions.push(['start', move.task_id]);
          sent(
            await source.client.tasks
              .reportExecution({
                evidence: evidence(
                  source,
                  sequence - 1,
                  { task_id: move.task_id, event: 'state', state: 'in_progress' },
                  sharedReport,
                ),
              })
              .send(),
          );
        } else assert.equal(source.active, move.task_id);
        source.position = slot === 0 ? { latitude: 1, longitude: 2 } : move.inputs.target.position;
        source.assetSequence++;
        sent(
          await source.reporter
            .update(
              { request_id: uuid() },
              reading(source.assetSequence, {
                telemetry: {
                  ...telemetry(
                    { kind: 'asset_process', process_generation: source.facts.process_generation },
                    source.position.latitude,
                    `2026-10-21T12:00:0${source.assetSequence}Z`,
                  ),
                  value: { position: source.position, altitude: null, ground_speed: 0 },
                },
              }),
            )
            .send(),
        );
        const report = evidence(source, sequence, {
          task_id: move.task_id,
          event: 'state',
          state: 'completed',
          ...(slot === 0 ? { geometry_revision: '1' } : {}),
        });
        source.terminals.set(move.task_id, report);
        sent(await source.client.tasks.reportExecution({ evidence: report }).send());
        source.actions.push(['complete', move.task_id]);
        source.active = null;
      }

      const bytes = Buffer.from('Atlas simulated mission result\0\xff');
      const object = {
        object_id: uuid(),
        request_id: uuid(),
        byte_length: String(bytes.length),
        sha256: createHash('sha256').update(bytes).digest('hex'),
        content_type: 'application/octet-stream',
        metadata: { associations: [] },
      };
      const active = north.moves[1].task_id;
      north.active = active;
      north.actions.push(['start', active]);
      const started = north.client.tasks.reportExecution({
        evidence: evidence(
          north,
          1,
          { task_id: active, event: 'state', state: 'in_progress' },
          sharedReport,
        ),
      });
      if (schedule.lost === 'execution') {
        f.once('/messages/report_task_execution', ({ outgoing }) => outgoing.destroy());
        assert.equal((await started.send()).outcome.kind, 'unknown_outcome');
        assert.equal(
          success(await lead.http.tasks.get({ task_id: active })).execution_state,
          'in_progress',
        );
        assert.equal(started.outcome.kind, 'unknown_outcome');
        assert.equal(sent(await started.send()).evidence_disposition, 'duplicate');
      } else sent(await started.send());
      sent(
        await north.client.tasks
          .reportResults({
            evidence: evidence(
              north,
              1,
              {
                task_id: active,
                declarations: [{ object_id: object.object_id, required: true }],
              },
              sharedReport,
            ),
          })
          .send(),
      );
      assert.deepEqual(
        success(await lead.http.tasks.get({ task_id: active })).result_declarations,
        [{ object_id: object.object_id, required: true }],
      );
      const unavailable = await watch.http.objects.get({ object_id: object.object_id });
      assert.equal(unavailable.response.kind, 'error');
      assert.equal(unavailable.response.body.error.code, 'entity_not_found');
      const absent = watch.http.tasks.objects({ task_id: active });
      assert.deepEqual(success(await absent.next()).items, []);
      absent.close();

      const pause = sent(
        await lead.tasks
          .create({
            task_id: uuid(),
            request_id: uuid(),
            asset_id: north.facts.asset_id,
            command: 'pause',
            scheduling: 'immediate',
            inputs: {},
          })
          .send(),
      );
      assert.equal(north.gate, 'running');
      assert.equal(
        success(await watch.http.tasks.get({ task_id: pause.task_id })).execution_state,
        'pending',
      );
      north.gate = 'paused';
      north.actions.push(['pause', active]);
      sent(
        await north.client.tasks
          .reportExecution({
            evidence: evidence(north, 2, {
              task_id: active,
              event: 'state',
              state: 'paused',
            }),
          })
          .send(),
      );
      sent(
        await north.client.tasks
          .reportExecution({
            evidence: evidence(north, 1, {
              task_id: pause.task_id,
              event: 'state',
              state: 'completed',
              control_revision: '1',
              queue_state: 'paused',
              applied_at: new Date().toISOString(),
            }),
          })
          .send(),
      );
      const resume = sent(
        await watch.tasks
          .create({
            task_id: uuid(),
            request_id: uuid(),
            asset_id: north.facts.asset_id,
            command: 'resume',
            scheduling: 'immediate',
            inputs: {},
            expires_at: new Date(Date.now() + 59_000).toISOString(),
          })
          .send(),
      );
      const oldInstructions = await instructions(north.client, north);
      assert.equal(oldInstructions.context.task_control.requested.task_id, resume.task_id);
      const oldResume = evidence(north, 1, {
        task_id: resume.task_id,
        event: 'state',
        state: 'completed',
        control_revision: '2',
        queue_state: 'running',
        applied_at: new Date().toISOString(),
        read_id: oldInstructions.context.read_id,
        core_run_id: oldInstructions.context.core_run_id,
        captured_at: oldInstructions.context.captured_at,
        instructions_valid_until: oldInstructions.context.instructions_valid_until,
        queue_revision: oldInstructions.context.task_queue.revision,
      });
      const cancel = lead.tasks.cancel({ task_id: south.moves[1].task_id, request_id: uuid() });
      const committed = barrier(),
        deliver = barrier();
      t.after(() => deliver.resolve());
      f.once('/messages/request_task_cancellation', async ({ forward }) => {
        committed.resolve();
        await deliver.promise;
        forward();
      });
      const cancelAttempt = cancel.start();
      try {
        await committed.promise;
        const pending = success(await watch.http.tasks.get({ task_id: south.moves[1].task_id }));
        assert.equal(pending.cancellation_request_id, cancel.submission.facts.request_id);
        assert.equal(pending.execution_state, 'pending');
        assert.deepEqual(south.actions, []);
        assert.equal(cancel.outcome.kind, 'unknown_outcome');
      } finally {
        deliver.resolve();
      }
      success(await cancelAttempt.settled);
      await f.restart();
      const originalDataset = north.datasetId;
      for (const client of new Set([lead, watch, direct.client, gateway]))
        success(await client.connect());
      assert.equal(f.datasetId, originalDataset);
      assert.equal(north.gate, 'paused');
      for (const source of sources)
        assert.equal(
          success(await watch.http.assets.get({ asset_id: source.facts.asset_id })).communications
            .health,
          'offline',
        );
      assert.equal(
        success(await watch.http.tasks.get({ task_id: resume.task_id })).execution_state,
        'pending',
      );
      const fresh = await instructions(north.client, north);
      assert.notEqual(fresh.context.core_run_id, oldInstructions.context.core_run_id);
      assert.equal(fresh.context.task_control.requested.task_id, resume.task_id);
      assert.ok(Date.now() < Date.parse(fresh.context.instructions_valid_until));
      assert.equal(fresh.tasks.find((item) => item.task_id === active).execution_state, 'paused');
      north.gate = 'running';
      north.actions.push(['resume', active]);
      sent(
        await north.client.tasks
          .reportExecution({
            evidence: evidence(north, 1, {
              ...oldResume.payload,
              applied_at: new Date().toISOString(),
              read_id: fresh.context.read_id,
              core_run_id: fresh.context.core_run_id,
              captured_at: fresh.context.captured_at,
              instructions_valid_until: fresh.context.instructions_valid_until,
              queue_revision: fresh.context.task_queue.revision,
            }),
          })
          .send(),
      );
      sent(
        await north.client.tasks
          .reportExecution({
            evidence: evidence(north, 3, {
              task_id: active,
              event: 'state',
              state: 'in_progress',
            }),
          })
          .send(),
      );
      const geometry = sent(
        await lead.geofeatures
          .edit({
            geofeature_id: waypoint.id,
            request_id: uuid(),
            expected_edit_revision: '0',
            edits: { geometry: { type: 'Point', coordinates: [2, 1] } },
          })
          .send(),
      );
      assert.equal(geometry.geometry_revision, '1');
      for (const source of sources) {
        assert.deepEqual(
          success(await source.client.http.geofeatures.get({ geofeature_id: waypoint.id }))
            .geometry,
          { type: 'Point', coordinates: [2, 1] },
        );
        assert.deepEqual(
          success(await source.client.http.tasks.get({ task_id: source.moves[0].task_id })).inputs,
          { target: { kind: 'geofeature', geofeature_id: waypoint.id } },
        );
      }
      await completeMove(direct, 1);
      await completeMove(direct, 0);
      await completeMove(north, 1, 4);
      await completeMove(north, 0);
      const cancelled = await instructions(south.client, south);
      assert.equal(
        cancelled.tasks.find((item) => item.task_id === south.moves[1].task_id)
          .cancellation_request_id,
        cancel.submission.facts.request_id,
      );
      const cancellationEvidence = evidence(south, 1, {
        task_id: south.moves[1].task_id,
        event: 'state',
        state: 'cancelled',
        cancellation_request_id: cancel.submission.facts.request_id,
      });
      south.terminals.set(south.moves[1].task_id, cancellationEvidence);
      sent(await south.client.tasks.reportExecution({ evidence: cancellationEvidence }).send());
      south.actions.push(['cancel', south.moves[1].task_id]);
      const refusedCancellation = { task_id: south.moves[0].task_id, request_id: uuid() };
      sent(await watch.tasks.cancel(refusedCancellation).send());
      const refusal = sent(
        await south.client.tasks
          .reportExecution({
            evidence: evidence(south, 1, {
              task_id: south.moves[0].task_id,
              event: 'cancellation_refused',
              state: 'pending',
              cancellation_request_id: refusedCancellation.request_id,
              reason: 'continue_inspection',
            }),
          })
          .send(),
      );
      assert.equal(refusal.task.cancellation_request_id, null);
      await completeMove(south, 0, 3);

      await gateway.close();
      sent(
        await lead.apiKeys.revoke({ request_id: uuid(), api_key_id: gatewayKey.api_key_id }).send(),
      );
      const obsoleteGateway = f.client({ credentials: () => gatewayKey.secret });
      assert.equal((await obsoleteGateway.connect()).response.body.error.code, 'unauthorized');
      const nextGatewayKey = { api_key_id: uuid(), request_id: uuid(), secret: secret() };
      sent(await watch.apiKeys.create(nextGatewayKey).send());
      gateway = f.client({ credentials: () => nextGatewayKey.secret });
      success(await gateway.connect());
      for (const source of [north, south]) {
        source.client = gateway;
        source.reporter = gateway.reporting.asset({
          id: source.facts.asset_id,
          process_generation: source.facts.process_generation,
        });
        assert.equal(
          sent(await gateway.observations.report(source.observationReport.submission.facts).send())
            .evidence_disposition,
          'duplicate',
        );
        const terminal = source.terminals.get(source.moves[0].task_id);
        assert.equal(
          sent(await gateway.tasks.reportExecution({ evidence: terminal }).send())
            .evidence_disposition,
          'duplicate',
        );
        assert.equal(
          success(await lead.http.assets.get({ asset_id: source.facts.asset_id }))
            .process_generation,
          source.facts.process_generation,
        );
      }
      assert.equal(
        f.traffic.filter((entry) => entry.path === '/messages/replace_asset_process').length,
        0,
      );
      for (const [index, source] of sources.entries()) {
        const reporter = source.client.reporting.observation({
          id: source.observationId,
          publisher_id: source.publisherId,
        });
        sent(
          await reporter
            .report(
              reading(2, {
                telemetry: telemetry(
                  { kind: 'publisher', publisher_id: source.publisherId },
                  52 + index,
                  '2026-10-21T12:00:02Z',
                ),
              }),
            )
            .send(),
        );
        const updated = success(await lead.http.tracks.get({ track_id: source.trackId }));
        assert.equal(updated.id, source.trackId);
        assert.equal(updated.telemetry.value.position.latitude, 52 + index);
        assert.equal(updated.telemetry.evidence.entity_id, source.observationId);
      }
      const stillMissing = await lead.http.objects.get({ object_id: object.object_id });
      assert.equal(stillMissing.response.body.error.code, 'entity_not_found');
      sent(await gateway.objects.upload(object, new Blob([bytes])).send());
      const results = watch.http.tasks.objects({ task_id: active });
      assert.deepEqual(
        success(await results.next()).items.map((item) => item.object_id),
        [object.object_id],
      );
      results.close();
      const download = lead.objects.content(
        {
          object_id: object.object_id,
          disposition: 'attachment',
        },
        { maxBytes: bytes.length },
      );
      const opened = await download.open();
      assert.equal(opened.response.kind, 'content');
      const chunks = [];
      for await (const chunk of opened.response.stream) chunks.push(chunk);
      assert.equal((await download.settled).response.kind, 'content');
      assert.deepEqual(Buffer.concat(chunks), bytes);
      const held = await watch.objects
        .delete({ object_id: object.object_id, request_id: uuid() })
        .send();
      assert.equal(held.attempt.response.body.error.code, 'object_held');

      await until(
        () =>
          full.picture.status.kind === 'synchronized' &&
          full.objects.get({ object_id: object.object_id }).value !== null,
        'Full operator did not receive the completed mission',
      );
      const subscription = full.picture.subscribe();
      t.after(() => subscription.close());
      await subscription.next();
      const coordinator = full === lead ? watch : lead;
      sent(
        await coordinator.apiKeys
          .revoke({ api_key_id: fullOperator.key.api_key_id, request_id: uuid() })
          .send(),
      );
      const denied = await full.readiness({});
      if (denied.kind === 'response') assert.equal(denied.response.body.error.code, 'unauthorized');
      else assert.equal(denied.code, 'authorization_required');
      assert.equal(full.state.kind, 'authorization-required');
      const unsent = full.tasks.create({ ...task(direct.facts.asset_id), task_id: uuid() });
      const beforePause = f.traffic.length;
      assert.equal((await unsent.send()).attempt.code, 'authorization_required');
      assert.equal(f.traffic.length, beforePause);
      sent(
        await north.reporter
          .update(
            { request_id: uuid() },
            reading(4, {
              telemetry: telemetry(
                { kind: 'asset_process', process_generation: north.facts.process_generation },
                41,
                '2026-10-21T12:00:04Z',
              ),
            }),
          )
          .send(),
      );
      assert.equal(
        full.assets.get({ asset_id: north.facts.asset_id }).value.telemetry.value.position.latitude,
        1,
      );
      const replacementKey = {
        api_key_id: uuid(),
        request_id: uuid(),
        secret: secret(),
        operator_id: fullOperator.key.operator_id,
      };
      sent(await coordinator.apiKeys.create(replacementKey).send());
      fullOperator.candidate = replacementKey.secret;
      const mutationPaths = new Set([
        '/messages/create_task',
        '/messages/report_task_execution',
        '/messages/update_asset',
      ]);
      const recoveryStart = f.traffic.length;
      success(await full.recover());
      await until(
        () =>
          full.picture.status.kind === 'synchronized' &&
          full.assets.get({ asset_id: north.facts.asset_id }).value?.telemetry.value.position
            .latitude === 41,
        'Existing Full operator did not recover the missed position',
      );
      assert.deepEqual(
        f.traffic.slice(recoveryStart).filter((entry) => mutationPaths.has(entry.path)),
        [],
      );
      const boundary = full.picture.cursor;
      sent(
        await north.reporter
          .update(
            { request_id: uuid() },
            reading(5, {
              telemetry: telemetry(
                { kind: 'asset_process', process_generation: north.facts.process_generation },
                42,
                '2026-10-21T12:00:05Z',
              ),
            }),
          )
          .send(),
      );
      await until(
        () =>
          full.assets.get({ asset_id: north.facts.asset_id }).value?.telemetry.value.position
            .latitude === 42,
        'Live telemetry did not resume after recovery',
      );
      const changes = full.picture.changedSince(boundary);
      assert.equal(changes.kind, 'available');
      assert.ok(
        changes.value.commits.some((commit) =>
          commit.changes.some((change) => change.resource_id === north.facts.asset_id),
        ),
      );
      let receivedLive = false;
      for (let event = 0; event < 16 && !receivedLive; event++) {
        const next = await subscription.next();
        assert.equal(next.done, false);
        receivedLive =
          next.value.kind === 'commit' &&
          next.value.commit.changes.some(
            (change) =>
              change.kind === 'put' &&
              change.resource_id === north.facts.asset_id &&
              change.image.telemetry.value.position.latitude === 42,
          );
      }
      assert.ok(receivedLive, 'The original subscription received a post-recovery live update');
      subscription.close();

      for (const [index, source] of sources.entries()) {
        const asset = success(
          await coordinator.http.assets.get({ asset_id: source.facts.asset_id }),
        );
        assert.deepEqual(asset.task_queue.requested_task_ids, []);
        if (index === 1)
          assert.deepEqual(asset.task_control.confirmed, {
            revision: '2',
            task_id: resume.task_id,
            process_generation: north.facts.process_generation,
            queue_state: 'running',
          });
        const rows = await history(coordinator, 'assets', source.facts.asset_id);
        assert.deepEqual(
          rows.map((row) => row.value.latitude),
          index === 1 ? [11, 21, 1, 41, 42] : index === 0 ? [10, 20, 1] : [12, 1],
        );
        for (const kind of ['observations', 'tracks']) {
          const rows = await history(
            coordinator,
            kind,
            kind === 'observations' ? source.observationId : source.trackId,
          );
          assert.deepEqual(
            rows.map((row) => [
              row.value.latitude,
              row.observed_at,
              row.source_entity_id,
              row.track_ids,
            ]),
            [
              [51, '2026-10-21T12:00:01Z', source.observationId, [source.trackId]],
              [52 + index, '2026-10-21T12:00:02Z', source.observationId, [source.trackId]],
            ],
          );
        }
        for (const move of source.moves) {
          const retained = success(await coordinator.http.tasks.get({ task_id: move.task_id }));
          const original = source.terminals.get(move.task_id);
          assert.equal(retained.execution_state, original.payload.state);
          assert.equal(retained.execution_summary.report_id, original.report_id);
          assert.equal(retained.execution_summary.sequence, original.sequence);
          assert.deepEqual(retained.execution_summary.origin, original.origin);
          assert.deepEqual(retained.inputs, move.inputs);
        }
      }
      for (const control of [pause, resume]) {
        const retained = success(await coordinator.http.tasks.get({ task_id: control.task_id }));
        assert.equal(retained.execution_state, 'completed');
        assert.deepEqual(retained.execution_summary.origin, {
          kind: 'asset_process',
          process_generation: north.facts.process_generation,
        });
      }
      assert.deepEqual(direct.actions, [
        ['start', direct.moves[1].task_id],
        ['complete', direct.moves[1].task_id],
        ['start', direct.moves[0].task_id],
        ['complete', direct.moves[0].task_id],
      ]);
      assert.deepEqual(north.actions, [
        ['start', active],
        ['pause', active],
        ['resume', active],
        ['complete', active],
        ['start', north.moves[0].task_id],
        ['complete', north.moves[0].task_id],
      ]);
      assert.deepEqual(south.actions, [
        ['cancel', south.moves[1].task_id],
        ['start', south.moves[0].task_id],
        ['complete', south.moves[0].task_id],
      ]);
      const beforeLocal = f.traffic.length;
      for (const [index, source] of sources.entries()) {
        const asset = full.assets.get({ asset_id: source.facts.asset_id });
        const track = full.tracks.get({ track_id: source.trackId });
        assert.equal(asset.kind, 'available');
        assert.equal(track.kind, 'available');
        assert.deepEqual(
          asset.value.telemetry.value.position,
          index === 1 ? { latitude: 42, longitude: -1 } : { latitude: 1, longitude: 2 },
        );
        assert.equal(track.value.telemetry.value.position.latitude, 52 + index);
        assert.deepEqual(track.value.sources, [
          {
            observation_id: source.observationId,
            publisher_id: source.publisherId,
            source_asset_id: source.facts.asset_id,
          },
        ]);
        for (const move of source.moves) {
          const retained = full.tasks.get({ task_id: move.task_id });
          assert.equal(retained.kind, 'available');
          assert.equal(
            retained.value.execution_state,
            source === south && move === source.moves[1] ? 'cancelled' : 'completed',
          );
          assert.equal(
            retained.value.execution_summary.report_id,
            source.terminals.get(move.task_id).report_id,
          );
        }
      }
      assert.equal(full.objects.get({ object_id: object.object_id }).value.sha256, object.sha256);
      assert.deepEqual(full.geofeatures.get({ geofeature_id: waypoint.id }).value.geometry, {
        type: 'Point',
        coordinates: [2, 1],
      });
      for (const [kind, expectedIds] of [
        ['assets', sources.map((source) => source.facts.asset_id)],
        ['tracks', sources.map((source) => source.trackId)],
        [
          'tasks',
          [
            ...sources.flatMap((source) => source.moves.map((move) => move.task_id)),
            pause.task_id,
            resume.task_id,
          ],
        ],
        ['objects', [object.object_id]],
        ['geofeatures', [waypoint.id]],
      ]) {
        const query = full[kind].list({});
        assert.equal(query.kind, 'available');
        const page = query.value.page();
        assert.equal(page.kind, 'available');
        const id = kind === 'tasks' ? 'task_id' : kind === 'objects' ? 'object_id' : 'id';
        assert.deepEqual(page.value.items.map((item) => item[id]).sort(), expectedIds.sort());
        query.value.close();
      }
      assert.equal(f.traffic.length, beforeLocal);
      t.diagnostic(
        JSON.stringify({
          scenario: schedule.name,
          operators: schedule.modes,
          assets: 3,
          tracks: 3,
          tasks: { completed: 7, cancelled: 1 },
          result: { bytes: bytes.length, sha256: object.sha256 },
          fault: schedule.lost,
          restart: 'same Dataset; fresh Resume proof',
          gatewayRotation: 'same sources',
          recovery: 'missed position and subsequent live commit; zero automatic writes',
          physical: 'simulated only',
        }),
      );
    },
  );
