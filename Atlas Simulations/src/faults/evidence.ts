import { wait } from './common.js';
import { AssetReport, Timestamp } from '@atlas/protocol';
import { randomBytes } from 'node:crypto';
import { id, success } from '../sdk.js';
import type { FaultInput, FaultReceipt } from './common.js';
import { asset, observed, raw, receipt } from './common.js';
export async function exerciseEvidence(input: FaultInput): Promise<FaultReceipt> {
  const runtime = asset(input),
    client = runtime.client,
    asset_id = runtime.identity.asset_id;
  const before = async () => success(await input.operator.input.reader.assets.get({ asset_id }));
  switch (input.action.id) {
    case 'late-position':
    case 'future-time':
    case 'tags-cleared':
    case 'tags-history-only':
    case 'sequence-conflict':
    case 'report-replayed': {
      const snapshot = await before();
      const report = runtime.preparePosition();
      try {
        const facts = report.submission.facts;
        if (!facts.report) throw new Error('Report facts absent');
        const observed_at = Timestamp.parse(
          new Date(
            Date.now() + (input.action.id === 'future-time' ? 3000 : -3600000),
          ).toISOString(),
        );
        const telemetry = facts.report.sections.telemetry;
        const origin = {
          kind: 'asset_process',
          process_generation: runtime.identity.process_generation,
        } as const;
        const altered = AssetReport.parse({
          ...facts.report,
          report_id: id(),
          mode: input.action.id === 'tags-history-only' ? 'history_only' : 'current',
          sections: input.action.id.startsWith('tags-')
            ? {
                tags: {
                  state: 'value',
                  classification: 'state_until_changed',
                  observed_at: null,
                  value: { presets: [] },
                },
              }
            : {
                telemetry:
                  telemetry?.state === 'value'
                    ? {
                        ...telemetry,
                        observed_at,
                        value: { ...telemetry.value, position: { latitude: 0, longitude: 0 } },
                        constituents: {
                          position: { origin, reading_id: id() },
                          altitude: { origin, reading_id: id() },
                          ground_speed: { origin, reading_id: id() },
                        },
                      }
                    : telemetry,
              },
        });
        if (input.action.id === 'report-replayed') {
          const first = await observed(report, runtime);
          const duplicate = input.operator.client.assets.update(facts);
          try {
            return receipt(
              input.action.id,
              'http',
              report.submission.identity,
              '/messages/update_asset',
              [first, await observed(duplicate, runtime), await before()],
            );
          } finally {
            duplicate.close();
          }
        }
        if (input.action.id === 'sequence-conflict')
          success((await observed(report, runtime)).attempt);
        if (input.action.id === 'late-position') {
          const newer = runtime.preparePosition();
          try {
            success((await observed(newer, runtime)).attempt);
          } finally {
            newer.close();
          }
        }
        const changed = client.assets.update({ ...facts, request_id: id(), report: altered });
        try {
          const result = await observed(changed, runtime);
          if (input.action.id === 'tags-cleared') await runtime.position();
          const after = await before();
          if (input.action.id === 'future-time') {
            await wait(input, 3500);
            const replay = input.operator.client.assets.update({
              ...facts,
              request_id: id(),
              report: altered,
            });
            try {
              const repeated = await observed(replay, runtime);
              const afterReplay = await before();
              await input.core.cli(['restart']);
              await input.core.findContainer();
              const afterRestart = await before();
              return receipt(
                input.action.id,
                'http',
                changed.submission.identity,
                '/messages/update_asset',
                [result, snapshot, after, { report: altered, repeated, afterReplay, afterRestart }],
              );
            } finally {
              replay.close();
            }
          }
          const identityConflict =
            input.action.id === 'sequence-conflict'
              ? await raw(input, '/messages/update_asset', {
                  ...facts,
                  request_id: id(),
                  report: { ...altered, report_id: facts.report.report_id },
                })
              : null;
          return receipt(
            input.action.id,
            'http',
            changed.submission.identity,
            '/messages/update_asset',
            [result, snapshot, after, identityConflict],
          );
        } finally {
          changed.close();
        }
      } finally {
        report.close();
      }
    }
    case 'tags-refused': {
      const snapshot = await before(),
        report = runtime.preparePosition();
      try {
        const facts = report.submission.facts;
        if (!facts.report) throw new Error('Missing report');
        const tags = {
          state: 'value',
          classification: 'state_until_changed',
          observed_at: null,
          value: { presets: ['simulated'] },
        };
        const registration = {
          asset_id: id(),
          registration_id: id(),
          process_generation: id(),
          api_key_id: id(),
          request_id: id(),
          secret: randomBytes(32).toString('base64url'),
          tags: { presets: ['simulated'] },
        };
        const results = [];
        results.push(await raw(input, '/messages/register_asset', registration));
        results.push(
          await raw(input, '/messages/update_asset', {
            asset_id,
            request_id: id(),
            expected_edit_revision: snapshot.edit_revision,
            tags: { presets: ['simulated'] },
          }),
        );
        for (const presets of [['unknown'], ['simulated', 'simulated']])
          results.push(
            await raw(input, '/messages/update_asset', {
              ...facts,
              report: { ...facts.report, sections: { tags: { ...tags, value: { presets } } } },
            }),
          );
        return receipt(input.action.id, 'http', id(), '/messages/update_asset', [
          results,
          snapshot,
          await before(),
        ]);
      } finally {
        report.close();
      }
    }

    default:
      throw new Error('Fault dispatched to wrong owner');
  }
}
