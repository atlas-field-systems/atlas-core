import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { createClient } from '@atlas/sdk';
import { Asset, Task, Track, Observation, Uuid, exchanges } from '@atlas/protocol';
import type { HistoryReading, Position } from '@atlas/protocol';
import type { Scenario } from './scenario.js';
import { TruthEntry } from './truth.js';
import { id, success } from './sdk.js';
import type { CheckResults, CheckName } from './records.js';
import { z } from 'zod';

export type VerificationInput = {
  scenario: Scenario;
  baseUrl: string;
  secret: string;
  datasetId: Uuid;
  truth: string;
  assets: ReadonlyMap<string, Uuid>;
  moves: readonly { asset: string; index: number; id: Uuid }[];
};
type Submitted = {
  identity: string;
  operation: string;
  facts: z.infer<ReturnType<typeof z.json>>;
  outcome: string;
};
export type Evidence = {
  assets: Map<string, Asset>;
  tasks: Map<Uuid, Task>;
  tracks: Track[];
  observations: Map<Uuid, Observation>;
  history: Map<string, HistoryReading[]>;
  physical: Extract<TruthEntry, { kind: 'physical' }>[];
  submissions: Submitted[];
  faults: string[];
};
export async function readTruth(path: string): Promise<Pick<Evidence, 'physical' | 'submissions'>> {
  const physical: Evidence['physical'] = [],
    submissions: Submitted[] = [];
  const byIdentity = new Map<string, Submitted>();
  const stream = createReadStream(path, { highWaterMark: 65536 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 134217728 || line.length > 1048576) throw new Error('Truth input budget');
      const entry = TruthEntry.parse(JSON.parse(line));
      switch (entry.kind) {
        case 'physical':
          if (physical.length >= 100000) throw new Error('Physical index capacity');
          physical.push(entry);
          break;
        case 'submitted': {
          if (byIdentity.size >= 100000) throw new Error('Submission index capacity');
          if (!byIdentity.has(entry.identity)) {
            const item = { ...entry, outcome: 'not_submitted' };
            submissions.push(item);
            byIdentity.set(entry.identity, item);
          }
          break;
        }
        case 'outcome': {
          const item = byIdentity.get(entry.identity);
          if (!item) throw new Error('Outcome lacks submission');
          item.outcome = z.object({ kind: z.string() }).parse(entry.outcome).kind;
          break;
        }
        case 'attempt':
          break;
        default: {
          const exhaustive: never = entry;
          throw new Error(String(exhaustive));
        }
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
  return { physical, submissions };
}
function key(
  entity: string,
  origin: { kind: string; process_generation?: string; publisher_id?: string },
  reading: string,
): string {
  return `${entity}/${origin.kind}/${origin.process_generation ?? origin.publisher_id}/position/${reading}`;
}
export function checkEvidence(
  input: Pick<VerificationInput, 'scenario' | 'assets' | 'moves'>,
  e: Evidence,
): CheckResults {
  const failures: Record<CheckName, string[]> = {
    tasks: [],
    order: [],
    assets: [],
    positions: [],
    final_position: [],
    tracks: [],
    tags: [],
    faults: [],
  };
  const expect = input.scenario.expect;
  if (!expect) throw new Error('Missing eval expectations');
  for (const expected of expect.tasks) {
    const binding = input.moves.find(
      (m) => m.asset === expected.asset && m.index === expected.index,
    );
    const task = binding && e.tasks.get(binding.id);
    if (!task || task.execution_state !== expected.state)
      failures.tasks.push(`Task ${expected.asset}/${expected.index} expected ${expected.state}`);
    if (task && ['completed', 'cancelled'].includes(task.execution_state)) {
      const effects = e.physical.filter((p) => p.task === task.task_id);
      if (task.execution_state === 'completed' && !effects.some((p) => p.event === 'arrive'))
        failures.tasks.push(`Completed without arrival ${task.task_id}`);
      if (task.execution_state === 'cancelled' && effects.some((p) => p.event === 'arrive'))
        failures.tasks.push(`Cancelled after physical arrival ${task.task_id}`);
    }
  }
  const removed = new Set(expect.removed_assets ?? []);
  for (const [alias] of input.assets) {
    const asset = e.assets.get(alias);
    if (removed.has(alias) === Boolean(asset)) failures.assets.push(`Asset presence ${alias}`);
    if (removed.has(alias)) continue;
    const moves = input.moves.filter((m) => m.asset === alias);
    let expectedOrder = moves.map((m) => m.index);
    for (const action of input.scenario.timeline ?? [])
      if (action.action === 'reorder' && action.asset === alias) expectedOrder = action.indexes;
    const starts = e.physical.filter((p) => p.asset === alias && p.event === 'start');
    const actualOrder = starts.map((p) => moves.find((m) => m.id === p.task)?.index);
    const completedOrder = expectedOrder.filter((i) => actualOrder.includes(i));
    if (!isDeepStrictEqual(actualOrder, completedOrder))
      failures.order.push(`Start order ${alias}`);
    let paused = false;
    for (const p of e.physical.filter((p) => p.asset === alias)) {
      if (p.event === 'pause') paused = true;
      if (p.event === 'resume') paused = false;
      if (paused && (p.event === 'start' || p.event === 'arrive'))
        failures.order.push(`Work crossed pause ${alias}`);
    }
    const reports = e.submissions
      .filter((s) => s.operation === 'UpdateAsset')
      .map((s) => ({ ...s, facts: exchanges.UpdateAsset.request.schema.parse(s.facts) }))
      .filter((s) => s.facts.asset_id === input.assets.get(alias) && s.facts.report);
    const first = reports[0]?.facts.report;
    if (
      !first ||
      first.mode !== 'current' ||
      first.sections.tags?.state !== 'value' ||
      !first.sections.tags.value.presets.includes('simulated')
    )
      failures.tags.push(`First report lacks simulated ${alias}`);
    let lastPosition: Position | null | undefined,
      lastTags: unknown,
      highestPosition = -1n,
      highestTags = -1n;
    const expectedReadings = new Map<string, { outcome: string; value: Position | null }>();
    for (const s of reports) {
      const report = s.facts.report;
      if (!report) continue;
      const telemetry = report.sections.telemetry;
      if (telemetry?.state === 'value' && telemetry.constituents.position) {
        const constituent = telemetry.constituents.position;
        expectedReadings.set(key(s.facts.asset_id, constituent.origin, constituent.reading_id), {
          outcome: s.outcome,
          value: telemetry.value.position,
        });
        if (
          s.outcome === 'accepted' &&
          report.mode === 'current' &&
          BigInt(report.sequence) > highestPosition
        ) {
          lastPosition = telemetry.value.position;
          highestPosition = BigInt(report.sequence);
        }
      }
      const tags = report.sections.tags;
      if (
        s.outcome === 'accepted' &&
        report.mode === 'current' &&
        tags?.state === 'value' &&
        BigInt(report.sequence) > highestTags
      ) {
        lastTags = tags.value;
        highestTags = BigInt(report.sequence);
      }
    }
    const counts = new Map<string, number>();
    for (const row of e.history.get(alias) ?? []) {
      const identity = key(
        row.source_entity_id,
        row.source_evidence.origin,
        row.source_evidence.reading_id,
      );
      counts.set(identity, (counts.get(identity) ?? 0) + 1);
      const expected = expectedReadings.get(identity);
      if (!expected || !isDeepStrictEqual(expected.value, row.value))
        failures.positions.push(`Unexpected reading ${identity}`);
    }
    for (const [identity, reading] of expectedReadings) {
      const count = counts.get(identity) ?? 0;
      if (
        (reading.outcome === 'accepted' && count !== 1) ||
        (['rejected', 'not_submitted'].includes(reading.outcome) && count !== 0) ||
        count > 1
      )
        failures.positions.push(`Reading count ${identity} ${count} ${reading.outcome}`);
    }
    if (
      !asset ||
      !isDeepStrictEqual(
        asset.telemetry?.state === 'value' ? asset.telemetry.value.position : undefined,
        lastPosition,
      )
    )
      failures.final_position.push(`Latest position ${alias}`);
    const lastArrival = e.physical.filter((p) => p.asset === alias && p.event === 'arrive').at(-1);
    if (lastArrival) {
      const binding = moves.find((m) => m.id === lastArrival.task);
      const action = input.scenario.timeline?.filter(
        (a) => a.action === 'move_to' && a.asset === alias,
      )[binding?.index ?? -1];
      const target =
        action && action.action === 'move_to'
          ? 'position' in action
            ? action.position
            : input.scenario.geofeatures?.find((g) => g.alias === action.geofeature)?.position
          : undefined;
      if (!target || !isDeepStrictEqual(lastPosition, target))
        failures.final_position.push(`Target position ${alias}`);
    }
    if (
      !asset ||
      !isDeepStrictEqual(asset.tags?.state === 'value' ? asset.tags.value : undefined, lastTags)
    )
      failures.tags.push(`Current Tags ${alias}`);
  }
  if (e.tracks.length !== expect.tracks)
    failures.tracks.push(`Track count ${e.tracks.length} expected ${expect.tracks}`);
  for (const track of e.tracks)
    for (const source of track.sources) {
      const observation = e.observations.get(source.observation_id);
      if (
        !observation ||
        observation.track_id !== track.id ||
        observation.publisher_id !== source.publisher_id ||
        observation.source_asset_id !== source.source_asset_id
      )
        failures.tracks.push(`Track provenance ${track.id}`);
    }
  for (const action of input.scenario.timeline ?? [])
    if (action.action === 'fault' && !e.faults.includes(action.id))
      failures.faults.push(`Fault did not fire ${action.id}`);
  const result = (name: CheckName): CheckResults[CheckName] =>
    failures[name].length
      ? { kind: 'failed', reasons: failures[name].slice(0, 100) }
      : { kind: 'passed' };
  return {
    tasks: result('tasks'),
    order: result('order'),
    assets: result('assets'),
    positions: result('positions'),
    final_position: result('final_position'),
    tracks: result('tracks'),
    tags: result('tags'),
    faults: result('faults'),
  };
}
export async function collectEvidence(input: VerificationInput): Promise<Evidence> {
  const client = createClient({
    baseUrl: input.baseUrl,
    credentials: () => input.secret,
    datasetId: input.datasetId,
  });
  const truth = await readTruth(input.truth);
  const evidence: Evidence = {
    ...truth,
    assets: new Map(),
    tasks: new Map(),
    tracks: [],
    observations: new Map(),
    history: new Map(),
    faults: [],
  };
  try {
    success(await client.connect());
    for (const [alias, asset_id] of input.assets) {
      const found = await client.assets.get({ asset_id });
      if (
        found.kind === 'response' &&
        found.response.kind === 'error' &&
        found.response.body.error.code === 'entity_not_found'
      )
        continue;
      evidence.assets.set(alias, success(found));
      const view = client.assets.history({ entity_id: asset_id, query_id: id(), page_size: 1000 });
      const rows: HistoryReading[] = [];
      try {
        for (let page = 0; page < 101; page++) {
          const result = await view.next();
          if (result.kind === 'end') break;
          const data = success(result);
          if (rows.length + data.readings.length > 100000) throw new Error('History capacity');
          rows.push(...data.readings);
          if (page === 100) throw new Error('History page capacity');
        }
      } finally {
        const closed = await view.close();
        if (closed.kind === 'abandoned') {
          if (!['unallocated', 'acknowledged'].includes(closed.evidence))
            throw new Error(`History release ${closed.evidence}`);
        } else success(closed);
      }
      evidence.history.set(alias, rows);
    }
    for (const binding of input.moves)
      evidence.tasks.set(binding.id, success(await client.tasks.get({ task_id: binding.id })));
    const cursor = client.tracks.list({ page_size: 1000 });
    try {
      for (let page = 0; page < 101; page++) {
        const result = await cursor.next();
        if (result.kind === 'end') break;
        const data = success(result);
        if (evidence.tracks.length + data.items.length > 100000) throw new Error('Track capacity');
        evidence.tracks.push(...data.items);
        if (page === 100) throw new Error('Track page capacity');
      }
    } finally {
      cursor.close();
    }
    for (const track of evidence.tracks)
      for (const source of track.sources)
        if (!evidence.observations.has(source.observation_id))
          evidence.observations.set(
            source.observation_id,
            success(await client.observations.get({ observation_id: source.observation_id })),
          );
    return evidence;
  } finally {
    await client.close();
  }
}
export async function verifyRun(input: VerificationInput): Promise<CheckResults> {
  return checkEvidence(input, await collectEvidence(input));
}
