import { Asset, AssetReport, Geofeature, HistoryReading, Task } from '@atlas/protocol';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { FaultReceipt } from './faults.js';
import { FaultId } from './scenario.js';
const attempt = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('response'),
    response: z.discriminatedUnion('kind', [
      z.object({ kind: z.literal('success') }),
      z.object({
        kind: z.literal('error'),
        body: z.object({ error: z.object({ code: z.string() }) }),
      }),
    ]),
  }),
  z.object({ kind: z.enum(['failed', 'not_sent']), code: z.string() }),
  z.object({ kind: z.literal('cancelled') }),
]);
const submission = z.object({ attempt, outcome: z.object({ kind: z.string() }) });
function error(value: unknown): string | undefined {
  const result = attempt.parse(value);
  return result.kind === 'response'
    ? result.response.kind === 'error'
      ? result.response.body.error.code
      : undefined
    : 'code' in result
      ? result.code
      : result.kind;
}
function ok(value: unknown): boolean {
  const result = attempt.parse(value);
  return result.kind === 'response' && result.response.kind === 'success';
}
function samePosition(a: Asset, b: Asset): boolean {
  return isDeepStrictEqual(
    a.telemetry?.state === 'value' ? a.telemetry.value.position : undefined,
    b.telemetry?.state === 'value' ? b.telemetry.value.position : undefined,
  );
}
export function verifyFault(receipt: FaultReceipt): string[] {
  const id = FaultId.parse(receipt.id),
    o = receipt.observations,
    failures: string[] = [];
  const require = (condition: boolean, message: string) => {
    if (!condition) failures.push(message);
  };
  switch (id) {
    case 'reply-lost':
    case 'reply-delayed':
    case 'reply-altered': {
      const event = z
        .object({
          status: z.number(),
          bytes: z.number(),
          connection: z.string(),
          upstreamDigest: z.string().regex(/^[a-f0-9]{64}$/),
          commitCursor: z.string(),
        })
        .parse(o[0]);
      const result = z
        .object({
          identity: z.string(),
          first: submission,
          second: submission,
          outcome: z.object({ kind: z.string() }),
        })
        .parse(o[1]);
      require(event.status === 200 &&
        event.bytes > 0, 'Interception did not witness a successful upstream response');
      require(result.first.outcome.kind ===
        'unknown_outcome', 'First attempt lost durable knowledge');
      require(ok(result.second.attempt) &&
        result.outcome.kind === 'accepted', 'Retry did not accept original prepared identity');
      const committed = z
        .object({
          second: z.object({
            attempt: z.object({
              kind: z.literal('response'),
              response: z.object({
                kind: z.literal('success'),
                body: z.object({ commit_cursor: z.string().optional() }),
              }),
            }),
          }),
        })
        .safeParse(o[1]);
      require(committed.success &&
        (committed.data.second.attempt.response.body.commit_cursor === undefined ||
          committed.data.second.attempt.response.body.commit_cursor ===
            event.commitCursor), 'Retry produced a second public commit');
      if (id === 'reply-delayed') {
        const late = z
          .object({
            wait: z.object({ kind: z.string() }),
            whileCancelled: z.object({ kind: z.string() }),
            settled: attempt,
            outcome: z.object({ kind: z.string() }),
          })
          .parse(o[3]);
        require(late.wait.kind === 'cancelled' &&
          late.whileCancelled.kind === 'unknown_outcome' &&
          ok(late.settled) &&
          late.outcome.kind === 'accepted', 'Cancelled wait failed to retain late success');
      }
      if (id === 'reply-altered')
        require(['invalid_value', 'invalid_http'].includes(
          error(result.first.attempt) ?? '',
        ), 'SDK exposed altered value');
      else
        require(['network', 'deadline'].includes(
          error(result.first.attempt) ?? '',
        ), 'First attempt did not lose its response');
      break;
    }
    case 'connections-closed': {
      const events = z.array(z.object({ action: z.literal('closed') })).parse(o[0]);
      require(events.length > 0, 'No active connection was closed');
      require(ok(submission.parse(o[1]).attempt), 'Traffic did not recover');
      const recovery = z
        .object({
          first: submission,
          beforeRetry: z.object({ kind: z.string() }),
          requestsBefore: z.number(),
          requestsAfter: z.number(),
          picture: z.object({
            kind: z.literal('available'),
            value: Asset,
            stale: z.literal(false),
          }),
        })
        .parse(o[3]);
      require(recovery.first.outcome.kind === 'unknown_outcome' &&
        recovery.beforeRetry.kind === 'unknown_outcome' &&
        recovery.requestsBefore === recovery.requestsAfter, 'SDK automatically replayed the write');
      require(isDeepStrictEqual(
        Asset.parse(o[2]),
        recovery.picture.value,
      ), 'Closed Full picture missed committed state');
      break;
    }
    case 'malformed-request':
    case 'request-too-large': {
      const response = z
        .object({ status: z.number(), body: z.object({ error: z.object({ code: z.string() }) }) })
        .parse(o[0]);
      require(response.status ===
        (id === 'malformed-request' ? 400 : 413), 'Wrong direct HTTP refusal');
      require(response.body.error.code ===
        (id === 'malformed-request'
          ? 'invalid_request'
          : 'payload_too_large'), 'Wrong refusal code');
      require(isDeepStrictEqual(o[1], o[2]), 'Refused request changed Asset');
      break;
    }
    case 'core-restart':
    case 'core-kill': {
      const before = Asset.parse(o[0]),
        after = Asset.parse(o[1]);
      require(before.id === after.id, 'Restart lost Asset identity');
      const previous = before.telemetry?.state === 'value' ? before.telemetry : undefined;
      const current = after.telemetry?.state === 'value' ? after.telemetry : undefined;
      require(Boolean(
        previous?.evidence &&
        current?.evidence &&
        BigInt(current.evidence.sequence) >= BigInt(previous.evidence.sequence),
      ), 'Restart rolled back accepted current sequence');
      const retained = z.array(HistoryReading).max(16).parse(o[3]);
      require(retained.length === 1 &&
        retained.every(
          (row) =>
            row.source_entity_id === before.id &&
            row.source_evidence.reading_id === previous?.constituents.position?.reading_id &&
            isDeepStrictEqual(
              row.source_evidence.origin,
              previous?.constituents.position?.origin,
            ) &&
            isDeepStrictEqual(row.value, previous?.value.position) &&
            row.observed_at === previous?.observed_at,
        ), 'Restart lost accepted immutable position history');
      require(after.communications.health === 'healthy', 'Contact did not recover');
      const inflight = z
        .object({
          witness: z.object({
            status: z.literal(200),
            connection: z.string(),
            requestId: z.string(),
          }),
          requestId: z.string(),
          interruption: z.discriminatedUnion('kind', [
            z.object({
              kind: z.literal('proxy'),
              event: z.object({ connection: z.string(), action: z.literal('closed') }),
            }),
            z.object({ kind: z.literal('sdk'), attempt }),
          ]),
          timing: z.object({
            writeStartedAt: z.number(),
            requestedAt: z.number(),
            writeSettledAt: z.number(),
            killedAt: z.number().optional(),
          }),
          beforeRun: z.string(),
          afterRun: z.string(),
          first: submission,
          retry: submission,
        })
        .parse(o[2]);
      require(inflight.requestId ===
        inflight.witness.requestId, 'Lifecycle receipt belongs to a different write');
      require(inflight.beforeRun !== inflight.afterRun &&
        inflight.timing.writeStartedAt < inflight.timing.requestedAt &&
        inflight.timing.writeSettledAt >=
          inflight.timing
            .requestedAt, 'Lifecycle did not interrupt an active write in a new Core run');
      if (inflight.timing.killedAt !== undefined)
        require(inflight.timing.writeSettledAt >=
          inflight.timing.killedAt, 'Write settled before container kill');
      if (inflight.interruption.kind === 'proxy')
        require(inflight.interruption.event.connection ===
          inflight.witness.connection, 'Wrong write connection closed');
      else
        require(['superseded', 'network', 'invalid_http', 'invalid_json'].includes(
          error(inflight.interruption.attempt) ?? '',
        ), 'Write ended without an observed lifecycle interruption');
      require(inflight.first.outcome.kind === 'unknown_outcome' &&
        ok(inflight.retry.attempt), 'Lifecycle did not preserve the in-flight prepared write');
      require(/^[a-f0-9]{64}$/.test(receipt.activation.identity), 'Container identity missing');
      break;
    }
    case 'picture-capacity':
      require(z.object({ kind: z.string() }).parse(o[0]).kind ===
        'resource-limited', 'Picture did not report explicit capacity');
      break;
    case 'key-revoked':
      require(!ok(o[1]), 'Revoked key admitted traffic');
      require(Asset.parse(o[2]).id === Asset.parse(o[3]).id, 'Earlier evidence disappeared');
      break;
    case 'reorder-stale':
      require(error(o[0]) === 'queue_changed', 'Stale order was not refused');
      require(isDeepStrictEqual(
        Asset.parse(o[1]).task_queue,
        Asset.parse(o[2]).task_queue,
      ), 'Stale reorder changed queue');
      break;
    case 'asset-deleted': {
      require(ok(submission.parse(o[0]).attempt), 'Asset deletion failed');
      require(['unauthorized', 'authorization_required'].includes(
        error(submission.parse(o[1]).attempt) ?? '',
      ), 'Deleted Asset admitted evidence');
      const before = Task.parse(o[3]),
        after = Task.parse(o[4]);
      require(before.command === 'move_to' &&
        before.execution_state === 'in_progress' &&
        before.asset_id === Asset.parse(o[2]).id, 'Deletion did not interrupt an active Move To');
      require(isDeepStrictEqual(before, after), 'Deletion changed the retained Task');
      require(z.object({ code: z.enum(['unauthorized', 'authorization_required']) }).safeParse(o[5])
        .success, 'Deleted runtime did not stop on its authorization refusal');
      break;
    }
    case 'future-time': {
      require(ok(submission.parse(o[0]).attempt), 'Future measurement was refused');
      const after = Asset.parse(o[2]);
      require(after.telemetry?.state === 'value' &&
        after.telemetry.time_status.position === 'uncertain', 'Future source time became known');
      require(after.telemetry?.state === 'value' &&
        isDeepStrictEqual(after.telemetry.value.position, {
          latitude: 0,
          longitude: 0,
        }), 'Higher-sequence current section missing');
      const continuation = z
        .object({
          report: AssetReport,
          repeated: submission,
          afterReplay: Asset,
          afterRestart: Asset,
        })
        .parse(o[3]);
      require(ok(continuation.repeated.attempt), 'Future report replay failed');
      for (const asset of [after, continuation.afterReplay, continuation.afterRestart]) {
        const telemetry = asset.telemetry,
          submitted = continuation.report.sections.telemetry;
        require(telemetry?.state === 'value' &&
          submitted?.state === 'value' &&
          telemetry.observed_at === submitted.observed_at &&
          telemetry.evidence?.report_id === continuation.report.report_id &&
          isDeepStrictEqual(telemetry.constituents, submitted.constituents) &&
          telemetry.time_status.position ===
            'uncertain', 'Future source identity or uncertainty changed after elapsed time, replay or Restart');
      }
      break;
    }
    case 'late-position':
      require(ok(submission.parse(o[0]).attempt), 'Measurement was refused');
      require(samePosition(
        Asset.parse(o[1]),
        Asset.parse(o[2]),
      ), 'Noncurrent measurement replaced current telemetry');
      break;
    case 'tags-cleared': {
      const tags = Asset.parse(o[2]).tags;
      require(ok(submission.parse(o[0]).attempt), 'Tag clear was refused');
      require(isDeepStrictEqual(tags?.state === 'value' ? tags.value : undefined, {
        presets: [],
      }), 'Tags did not clear');
      break;
    }
    case 'tags-history-only':
      require(ok(submission.parse(o[0]).attempt), 'History-only Tag report refused');
      require(isDeepStrictEqual(
        Asset.parse(o[1]).tags,
        Asset.parse(o[2]).tags,
      ), 'Historical Tags changed current Tags');
      break;
    case 'sequence-conflict':
      require(error(submission.parse(o[0]).attempt) ===
        'section_sequence_conflict', 'Occupied section sequence was accepted');
      require(z
        .object({
          status: z.literal(409),
          body: z.object({ error: z.object({ code: z.literal('report_identity_conflict') }) }),
        })
        .safeParse(o[3]).success, 'Changed report identity was not refused');
      break;
    case 'report-replayed': {
      if (!ok(submission.parse(o[0]).attempt) || !ok(submission.parse(o[1]).attempt)) {
        failures.push('Report replay did not settle');
        break;
      }
      const committed = z.object({
        attempt: z.object({
          response: z.object({ body: z.object({ commit_cursor: z.string().optional() }) }),
        }),
      });
      require(committed.parse(o[0]).attempt.response.body.commit_cursor ===
        committed.parse(o[1]).attempt.response.body.commit_cursor, 'Replay emitted another commit');
      require(ok(submission.parse(o[0]).attempt) &&
        ok(submission.parse(o[1]).attempt), 'Report replay did not settle');
      break;
    }
    case 'pause-empty':
      require(z
        .array(Task)
        .length(2)
        .parse(o[1])
        .every((task) => task.execution_state === 'pending'), 'Tasks started through idle pause');
      require(z
        .array(Task)
        .length(2)
        .parse(o[2])
        .every(
          (task) => task.execution_state === 'completed',
        ), 'Two Tasks did not continue after Resume');
      require(Asset.parse(o[0]).task_control.confirmed?.queue_state ===
        'paused', 'Empty queue did not retain pause');
      break;
    case 'contact-expiry':
      require(Asset.parse(o[1]).communications.health ===
        'degraded', 'Missing degraded transition');
      require(Asset.parse(o[2]).communications.health === 'offline', 'Missing offline transition');
      require(Asset.parse(o[3]).communications.health === 'healthy', 'Contact did not renew');
      break;
    case 'challenge-expired':
      require(error(submission.parse(o[0]).attempt) ===
        'challenge_expired', 'Expired challenge advanced contact');
      break;
    case 'process-obsolete':
      require(ok(submission.parse(o[0]).attempt), 'Replacement failed');
      require(error(submission.parse(o[1]).attempt) ===
        'generation_mismatch', 'Obsolete generation committed');
      break;
    case 'key-rotated':
      require(ok(o[0]), 'Recovery with new key failed');
      require(z.object({ outcome: z.object({ kind: z.string() }) }).parse(o[1]).outcome.kind ===
        'not_submitted', 'Recovery replayed a prepared write');
      require(ok(o[2]), 'New key could not read');
      break;
    case 'tags-refused': {
      const responses = z
        .array(z.object({ status: z.number() }))
        .length(4)
        .parse(o[0]);
      require(responses.every((r) => r.status === 400), 'A forbidden Tag input was accepted');
      require(isDeepStrictEqual(
        Asset.parse(o[1]).tags,
        Asset.parse(o[2]).tags,
      ), 'Refused Tags changed Asset');
      break;
    }
    case 'queue-changed':
      require(error(o[1]) === 'queue_changed', 'Paged read survived changed queue');
      require(ok(o[2]), 'Fresh assigned read did not recover');
      break;
    case 'resume-expired':
    case 'resume-superseded': {
      const task = Task.parse(o[1]);
      require(task.execution_state === 'failed' &&
        (task.execution_summary && 'reason' in task.execution_summary
          ? task.execution_summary.reason
          : undefined) ===
          (id === 'resume-expired'
            ? 'expired'
            : 'superseded'), 'Resume did not fail with its cause');
      require(Asset.parse(o[2]).task_control.confirmed?.queue_state ===
        'paused', 'Resume opened gate');
      break;
    }
    case 'cancel-race':
      require(Task.parse(o[1]).execution_state ===
        'completed', 'Arrival before cancellation did not remain completed');
      break;
    case 'cancel-held':
      require(Task.parse(o[0]).execution_state ===
        'pending', 'Later work crossed cancelled held slot');
      require(Task.parse(o[1]).execution_state ===
        'cancelled', 'Held cancellation was not confirmed');
      require(Task.parse(o[3]).execution_state ===
        'completed', 'Later work did not resume after held slot cleared');
      break;
    case 'cancel-refused': {
      const task = Task.parse(o[1]);
      require(Task.parse(o[0]).cancellation_request_id !== null, 'No cancellation was requested');
      require(task.cancellation_request_id === null &&
        task.execution_state === 'in_progress', 'Refusal did not restore execution');
      break;
    }
    case 'terminal-conflict':
      require(error(submission.parse(o[1]).attempt) ===
        'terminal_state_conflict', 'Terminal conflict accepted');
      require(isDeepStrictEqual(o[0], o[2]), 'Terminal conflict changed Task');
      break;
    case 'execution-conflict':
      require(error(submission.parse(o[1]).attempt) ===
        'evidence_conflict', 'Occupied execution sequence accepted');
      require(isDeepStrictEqual(o[2], o[3]), 'Execution conflict changed Task');
      break;
    case 'task-limit':
      require(z.object({ admitted: z.number() }).parse(o[0]).admitted ===
        1000, 'Task limit was not reached');
      require(error(submission.parse(o[1]).attempt) ===
        'resource_limit', 'Extra Task was admitted');
      require(ok(submission.parse(o[2]).attempt), 'Terminal evidence was refused at capacity');
      break;
    case 'storage-pressure':
      require(error(submission.parse(o[0]).attempt) ===
        'storage_limit', 'Ordinary storage write was admitted');
      require(ok(submission.parse(o[1]).attempt), 'Reserved terminal write failed');
      Asset.parse(o[2]);
      break;
    case 'core-drain': {
      const samples = z.array(z.unknown()).parse(o[0]);
      require(samples.some((sample) => {
        const parsed = z
          .object({
            kind: z.literal('response'),
            response: z.object({ body: z.object({ data: z.object({ ready: z.literal(false) }) }) }),
          })
          .safeParse(sample);
        return (
          parsed.success ||
          z
            .object({ running: z.literal(true), service: z.object({ ready: z.literal(false) }) })
            .safeParse(sample).success
        );
      }), 'No readiness=false observation during drain');
      const result = attempt.parse(o[1]);
      require(ok(result), 'Same identity retry did not settle');
      const raw = z.object({ rawResult: z.object({ status: z.number() }) }).parse(o[2]).rawResult;
      require(raw.status === 200 ||
        (raw.status === 429 &&
          z
            .object({
              rawResult: z.object({
                body: z.object({ error: z.object({ code: z.literal('resource_limit') }) }),
              }),
            })
            .safeParse(o[2]).success), 'Unclassified in-flight write reply');
      break;
    }
    case 'version-mismatch':
      require(['protocol_mismatch', 'invalid_http'].includes(
        error(o[1]) ?? '',
      ), 'Discovery mismatch was accepted');
      require(['protocol_mismatch', 'invalid_http'].includes(
        error(o[2]) ?? '',
      ), 'Ordinary work after mismatch was admitted');
      break;
    case 'sync-connection-limit':
      require(z.array(z.object({ type: z.literal('authenticated') })).parse(o[0]).length ===
        31, 'Did not authenticate 32 peers including operator');
      require(z.object({ type: z.literal('closed'), code: z.literal(1013) }).safeParse(o[1])
        .success, 'Thirty-third peer was not refused');
      require(z.object({ type: z.literal('read_changes_result') }).safeParse(o[2])
        .success, 'Existing peer was disrupted');
      break;
    case 'geofeature-edited': {
      const original = Geofeature.parse(o[0]),
        edited = Geofeature.parse(o[1]),
        task = Task.parse(o[2]),
        asset = Asset.parse(o[3]);
      require(original.geometry_revision !==
        edited.geometry_revision, 'Point revision did not change');
      require(task.execution_summary?.geometry_revision ===
        original.geometry_revision, 'Move did not retain captured geometry revision');
      require(asset.telemetry?.state === 'value' &&
        isDeepStrictEqual(
          asset.telemetry.value.position,
          z.object({ target: z.unknown() }).parse(o[4]).target,
        ), 'Point edit diverted movement');
      break;
    }
    case 'core-reset': {
      require(['dataset_mismatch', 'dataset_invalidated'].includes(error(o[1]) ?? '') &&
        z
          .object({ kind: z.literal('blocked'), reason: z.literal('dataset_invalidated') })
          .safeParse(o[4]).success, 'Old Dataset client continued after Reset');
      const stopped = z
        .object({
          stoppedRead: z.object({
            kind: z.literal('not_sent'),
            code: z.literal('dataset_invalidated'),
          }),
          requestsBefore: z.number().int().nonnegative(),
          requestsAfter: z.number().int().nonnegative(),
        })
        .parse(o[5]);
      require(stopped.requestsBefore ===
        stopped.requestsAfter, 'Invalidated client sent another HTTP request');
      require(['entity_not_found', 'asset_not_found'].includes(
        error(o[2]) ?? '',
      ), 'Old ID survived Reset');
      const datasets = z.object({ oldDataset: z.string(), newDataset: z.string() }).parse(o[3]);
      require(datasets.oldDataset !== datasets.newDataset, 'Reset retained Dataset identity');
      break;
    }
    case 'replay-expired': {
      const response = z
        .object({ status: z.number(), body: z.object({ error: z.object({ code: z.string() }) }) })
        .parse(o[1]);
      require(response.status === 410 &&
        response.body.error.code === 'cursor_expired', 'Old replay cursor was admitted');
      const picture = z
        .object({ kind: z.literal('available'), value: Asset, stale: z.literal(false) })
        .parse(o[3]);
      require(isDeepStrictEqual(
        Asset.parse(o[2]),
        picture.value,
      ), 'Rebuilt picture missed current state');
      break;
    }
    case 'slow-consumer': {
      const counts = z
        .object({
          pausesBefore: z.number(),
          pausesAfter: z.number(),
          committed: z.number(),
          closuresBefore: z.number(),
          closuresAfter: z.number(),
        })
        .parse(o[0]);
      require(counts.pausesAfter > counts.pausesBefore &&
        counts.committed === 4000, 'Upstream consumption never paused under load');
      const ended = z.object({ type: z.string(), code: z.number().optional() }).parse(o[1]);
      require(ended.type === 'gap' ||
        (ended.type === 'closed' &&
          (ended.code === 1013 ||
            (ended.code === 1006 &&
              counts.closuresAfter >
                counts.closuresBefore))), 'No explicit Core backpressure gap or closure');
      const picture = z
        .object({ kind: z.literal('available'), value: Asset, stale: z.literal(false) })
        .parse(o[3]);
      require(isDeepStrictEqual(
        Asset.parse(o[2]),
        picture.value,
      ), 'Recovered picture missed state');
      break;
    }

    default: {
      const exhaustive: never = id;
      throw new Error(String(exhaustive));
    }
  }
  return failures;
}
