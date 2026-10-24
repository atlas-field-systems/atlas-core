import { z } from 'zod';
import {
  NewId,
  Opaque,
  PageSize,
  Position,
  Time,
  Timestamp,
  timestampNanoseconds,
  Uuid,
  uniqueArray,
} from './scalars.js';
import { AssetOrigin, Constituent, PublisherOrigin } from './reports.js';

export function orderedTimes(from: string, before: string, inclusive = false): boolean {
  try {
    const delta = timestampNanoseconds(before) - timestampNanoseconds(from);
    return inclusive ? delta >= 0n : delta > 0n;
  } catch {
    return false;
  }
}
export const TimeStatus = z.enum(['known', 'unknown', 'uncertain']);
const reading = {
  source_entity_id: Uuid,
  quantity: z.literal('position'),
  value: Position.nullable(),
  observed_at: Time,
  time_status: TimeStatus,
  track_ids: uniqueArray(Uuid),
};
export const HistoryReading = z
  .discriminatedUnion('source_entity_kind', [
    z.strictObject({
      ...reading,
      source_entity_kind: z.literal('asset'),
      source_evidence: Constituent.extend({ origin: AssetOrigin }),
      track_ids: z.array(Uuid).length(0),
    }),
    z.strictObject({
      ...reading,
      source_entity_kind: z.literal('observation'),
      source_evidence: Constituent.extend({ origin: PublisherOrigin }),
    }),
  ])
  .refine(
    (value) => (value.time_status === 'unknown') === (value.observed_at === null),
    'Time status differs',
  )
  .meta({ id: 'HistoryReading' });
export const HistoryFirst = z
  .strictObject({
    entity_id: Uuid,
    query_id: NewId,
    allocation_context: Opaque,
    time_groups: uniqueArray(TimeStatus, 3).exactOptional(),
    source_time_from: Timestamp.exactOptional(),
    source_time_before: Timestamp.exactOptional(),
    page_size: PageSize.exactOptional(),
  })
  .refine(
    (value) =>
      !value.source_time_from ||
      !value.source_time_before ||
      orderedTimes(value.source_time_from, value.source_time_before),
    'Reversed history bounds',
  )
  .meta({ id: 'HistoryFirst' });
export const Continuation = z.strictObject({ page_token: Opaque }).meta({ id: 'Continuation' });
export const HistoryQuery = z.union([HistoryFirst, Continuation]).meta({ id: 'HistoryQuery' });
function readingKey(reading: z.output<typeof HistoryReading>): string {
  const origin = reading.source_evidence.origin;
  return [
    reading.source_entity_kind,
    reading.source_entity_id,
    origin.kind,
    origin.kind === 'publisher' ? origin.publisher_id : origin.process_generation,
    reading.quantity,
    reading.source_evidence.reading_id,
  ].join('/');
}
export const HistoryPage = z
  .strictObject({
    query_id: Uuid,
    view_id: Uuid,
    source: z.literal('core'),
    baseline_cursor: Opaque,
    expires_at: Timestamp,
    release_token: Opaque,
    readings: z.array(HistoryReading).max(1000),
    next_page_token: Opaque.nullable(),
  })
  .refine((value) => {
    const seen = new Set<string>();
    for (let index = 0; index < value.readings.length; index++) {
      const reading = value.readings[index];
      if (!reading) continue;
      const key = readingKey(reading);
      if (seen.has(key)) return false;
      seen.add(key);
      const prior = value.readings[index - 1];
      if (!prior) continue;
      if (prior.time_status !== 'known' && reading.time_status === 'known') return false;
      if (prior.time_status === 'known' && reading.time_status !== 'known') continue;
      if (prior.time_status === 'known' && prior.observed_at && reading.observed_at) {
        if (orderedTimes(prior.observed_at, reading.observed_at)) continue;
        if (!orderedTimes(prior.observed_at, reading.observed_at, true)) return false;
      }
      if (readingKey(prior) >= key) return false;
    }
    return true;
  }, 'History identity or order differs')
  .meta({ id: 'HistoryPage' });
export const Release = z.strictObject({ release_token: Opaque }).meta({ id: 'Release' });
export const Released = z.strictObject({ released: z.literal(true) }).meta({ id: 'Released' });
export type HistoryReading = z.output<typeof HistoryReading>;
export type HistoryPage = z.output<typeof HistoryPage>;
export type TimeStatus = z.output<typeof TimeStatus>;
export type HistoryFirst = z.output<typeof HistoryFirst>;
export type Continuation = z.output<typeof Continuation>;
export type HistoryQuery = z.output<typeof HistoryQuery>;
export type Release = z.output<typeof Release>;
export type Released = z.output<typeof Released>;
