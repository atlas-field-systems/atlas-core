import type { HistoryReading, Position } from '@atlas/protocol';
import { Asset, Observation, Task, Track, Uuid, exchanges } from '@atlas/protocol';
import { createClient } from '@atlas/sdk';
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { CheckName, CheckResults } from './records.js';
import type { Scenario } from './scenario.js';
import { id, success } from './sdk.js';
import { TruthEntry } from './truth.js';

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
  ordinal: number;
  identity: string;
  source: 'runtime' | 'fault';
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
  physical: (Extract<TruthEntry, { kind: 'physical' }> & { ordinal: number })[];
  world: Extract<TruthEntry, { kind: 'world' }>[];
  submissions: Submitted[];
  faults: string[];
};
export async function readTruth(
  path: string,
): Promise<Pick<Evidence, 'physical' | 'submissions' | 'world'>> {
  const world: Evidence['world'] = [];
  const physical: Evidence['physical'] = [],
    submissions: Submitted[] = [];
  const byIdentity = new Map<string, Submitted>();
  const stream = createReadStream(path, { highWaterMark: 65536 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  let bytes = 0,
    ordinal = 0;
  try {
    for await (const line of lines) {
      bytes += Buffer.byteLength(line) + 1;
      if (bytes > 134217728 || line.length > 1048576) throw new Error('Truth input budget');
      const entry = TruthEntry.parse(JSON.parse(line));
      ordinal++;
      switch (entry.kind) {
        case 'world':
          if (world.length >= 100000) throw new Error('World reading capacity');
          world.push(entry);
          break;
        case 'physical':
          if (physical.length >= 100000) throw new Error('Physical index capacity');
          physical.push({ ...entry, ordinal });
          break;
        case 'submitted': {
          if (byIdentity.size >= 100000) throw new Error('Submission index capacity');
          if (!byIdentity.has(entry.identity)) {
            const item = { ...entry, ordinal, outcome: 'not_submitted' };
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
  return { physical, submissions, world };
}
function key(
  entity: string,
  origin: { kind: string; process_generation?: string; publisher_id?: string },
  reading: string,
): string {
  return `${entity}/${origin.kind}/${origin.process_generation ?? origin.publisher_id}/position/${reading}`;
}
function target(
  input: Pick<VerificationInput, 'scenario'>,
  asset: string,
  index: number,
): Position | undefined {
  const action = input.scenario.timeline?.filter(
    (a) => a.action === 'move_to' && a.asset === asset,
  )[index];
  return action?.action === 'move_to'
    ? 'position' in action
      ? action.position
      : input.scenario.geofeatures?.find((g) => g.alias === action.geofeature)?.position
    : undefined;
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
  for (const binding of input.moves)
    if (
      expect.tasks.filter((e) => e.asset === binding.asset && e.index === binding.index).length !==
      1
    )
      failures.tasks.push(`Task requires one expectation ${binding.asset}/${binding.index}`);
  for (const expected of expect.tasks) {
    const binding = input.moves.find(
      (m) => m.asset === expected.asset && m.index === expected.index,
    );
    const task = binding && e.tasks.get(binding.id);
    if (!task || task.execution_state !== expected.state)
      failures.tasks.push(`Task ${expected.asset}/${expected.index} expected ${expected.state}`);
    if (task) {
      const effects = e.physical.filter((p) => p.task === task.task_id);
      if (
        ['in_progress', 'paused', 'completed'].includes(task.execution_state) &&
        effects.filter((p) => p.event === 'start').length !== 1
      )
        failures.tasks.push(`Task lacks exactly one physical start ${task.task_id}`);
      if (
        !['completed', 'cancelled', 'failed'].includes(task.execution_state) &&
        effects.some((p) => p.event === 'arrive')
      )
        failures.tasks.push(`Nonterminal Task arrived ${task.task_id}`);
      if (
        task.execution_state === 'completed' &&
        effects.filter((p) => p.event === 'arrive').length !== 1
      )
        failures.tasks.push(`Completed without exactly one arrival ${task.task_id}`);
      if (
        task.execution_state === 'completed' &&
        effects.some(
          (p) =>
            p.event === 'arrive' &&
            !isDeepStrictEqual(p.position, target(input, expected.asset, expected.index)),
        )
      )
        failures.tasks.push(`Arrival missed target ${task.task_id}`);
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
    const reorders = (input.scenario.timeline ?? []).filter(
      (a) => a.action === 'reorder' && a.asset === alias,
    );
    let reorderIndex = 0;
    const events: (
      | { ordinal: number; kind: 'enqueue' | 'start' | 'retire'; index: number }
      | { ordinal: number; kind: 'reorder'; indexes: number[] }
    )[] = [];
    for (const submission of e.submissions) {
      if (submission.outcome !== 'accepted') continue;
      if (submission.operation === 'CreateTask') {
        const facts = exchanges.CreateTask.request.schema.parse(submission.facts);
        const binding = moves.find((m) => m.id === facts.task_id);
        if (binding)
          events.push({ ordinal: submission.ordinal, kind: 'enqueue', index: binding.index });
      } else if (submission.operation === 'ReportTaskExecution') {
        const facts = exchanges.ReportTaskExecution.request.schema.parse(submission.facts);
        const binding = moves.find((m) => m.id === facts.evidence.payload.task_id);
        const payload = facts.evidence.payload;
        if (binding && payload.event === 'state' && ['cancelled', 'failed'].includes(payload.state))
          events.push({ ordinal: submission.ordinal, kind: 'retire', index: binding.index });
      } else if (submission.operation === 'SetTaskOrder') {
        const facts = exchanges.SetTaskOrder.request.schema.parse(submission.facts);
        if (facts.asset_id !== input.assets.get(alias)) continue;
        const action = reorders[reorderIndex++];
        if (
          !action ||
          action.action !== 'reorder' ||
          !isDeepStrictEqual(
            facts.task_ids,
            action.indexes.map((index) => moves.find((m) => m.index === index)?.id),
          )
        ) {
          failures.order.push(`Unexpected reorder ${alias}`);
          continue;
        }
        events.push({ ordinal: submission.ordinal, kind: 'reorder', indexes: action.indexes });
      }
    }
    for (const p of e.physical) {
      const binding = moves.find((m) => m.id === p.task);
      if (p.asset === alias && binding && (p.event === 'start' || p.event === 'cancel'))
        events.push({
          ordinal: p.ordinal,
          kind: p.event === 'cancel' ? 'retire' : 'start',
          index: binding.index,
        });
    }
    if (reorderIndex !== reorders.length) failures.order.push(`Missing reorder ${alias}`);
    let pending: number[] = [];
    const started = new Set<number>();
    const retired = new Set<number>();
    for (const event of events.sort((a, b) => a.ordinal - b.ordinal)) {
      if (event.kind === 'enqueue') pending.push(event.index);
      else if (event.kind === 'reorder')
        pending = event.indexes.filter((index) => !started.has(index) && !retired.has(index));
      else if (event.kind === 'retire') {
        pending = pending.filter((index) => index !== event.index);
        retired.add(event.index);
      } else {
        if (pending[0] !== event.index || started.has(event.index))
          failures.order.push(`Start order ${alias}`);
        pending = pending.filter((index) => index !== event.index);
        started.add(event.index);
      }
    }
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
    let highestTelemetry = -1n;
    let lastPosition: Position | null | undefined,
      lastTags: unknown,
      highestTags = -1n;
    const expectedReadings = new Map<
      string,
      { outcome: string; value: Position | null; observed_at: string | null }
    >();
    for (const s of reports) {
      const report = s.facts.report;
      if (!report) continue;
      const telemetry = report.sections.telemetry;
      if (telemetry?.state === 'value' && telemetry.constituents.position) {
        const constituent = telemetry.constituents.position;
        expectedReadings.set(key(s.facts.asset_id, constituent.origin, constituent.reading_id), {
          outcome: s.outcome,
          value: telemetry.value.position,
          observed_at: telemetry.observed_at,
        });
        if (
          s.outcome === 'accepted' &&
          report.mode === 'current' &&
          BigInt(report.sequence) > highestTelemetry
        ) {
          lastPosition = telemetry.value.position;
          highestTelemetry = BigInt(report.sequence);
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
    const generated = new Map(e.world.map((w) => [w.reading_id, w]));
    for (const submission of reports) {
      const telemetry = submission.facts.report?.sections.telemetry;
      if (telemetry?.state !== 'value' || !telemetry.constituents.position) continue;
      const source = generated.get(telemetry.constituents.position.reading_id);
      if (!source && submission.source === 'runtime')
        failures.positions.push('Runtime reading lacks World generation');
      if (
        source &&
        (!isDeepStrictEqual(source.position, telemetry.value.position) ||
          source.observed_at !== telemetry.observed_at)
      )
        failures.positions.push(`World reading changed ${source.reading_id}`);
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
      if (
        !expected ||
        !isDeepStrictEqual(expected.value, row.value) ||
        expected.observed_at !== row.observed_at
      )
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
    const lastTerminal = e.submissions
      .filter((s) => s.operation === 'ReportTaskExecution' && s.outcome === 'accepted')
      .map((s) => exchanges.ReportTaskExecution.request.schema.parse(s.facts).evidence.payload)
      .filter(
        (p) =>
          p.event === 'state' &&
          ['completed', 'cancelled', 'failed'].includes(p.state) &&
          moves.some((m) => m.id === p.task_id),
      )
      .at(-1);
    if (lastTerminal?.event === 'state' && lastTerminal.state === 'completed') {
      const binding = moves.find((m) => m.id === lastTerminal.task_id);
      const expectedTarget = binding && target(input, alias, binding.index);
      if (!expectedTarget || !isDeepStrictEqual(lastPosition, expectedTarget))
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
  const observationReports = e.submissions
    .filter((s) => s.operation === 'ReportObservation')
    .map((s) => ({ ...s, facts: exchanges.ReportObservation.request.schema.parse(s.facts) }));
  const generated = new Map(e.world.map((w) => [w.reading_id, w]));
  for (const [observation_id] of e.observations) {
    const reports = observationReports.filter((s) => s.facts.observation_id === observation_id);
    const expected = new Map<
      string,
      { outcome: string; value: Position | null; observed_at: string | null }
    >();
    for (const s of reports) {
      const telemetry = s.facts.report.sections.telemetry;
      if (telemetry?.state !== 'value' || !telemetry.constituents.position) continue;
      const source = telemetry.constituents.position;
      expected.set(key(observation_id, source.origin, source.reading_id), {
        outcome: s.outcome,
        value: telemetry.value.position,
        observed_at: telemetry.observed_at,
      });
      const world = generated.get(source.reading_id);
      if (!world && s.source === 'runtime')
        failures.positions.push('Observation lacks World generation');
      if (
        world &&
        (!isDeepStrictEqual(world.position, telemetry.value.position) ||
          world.observed_at !== telemetry.observed_at)
      )
        failures.positions.push(`World Observation changed ${source.reading_id}`);
    }
    for (const entity of [
      observation_id,
      ...e.tracks
        .filter((t) => t.sources.some((s) => s.observation_id === observation_id))
        .map((t) => t.id),
    ]) {
      const counts = new Map<string, number>();
      for (const row of e.history.get(entity) ?? []) {
        const identity = key(
          row.source_entity_id,
          row.source_evidence.origin,
          row.source_evidence.reading_id,
        );
        const reading = expected.get(identity);
        if (
          !reading ||
          !isDeepStrictEqual(reading.value, row.value) ||
          reading.observed_at !== row.observed_at
        )
          failures.positions.push(`Unexpected Observation/Track reading ${identity}`);
        counts.set(identity, (counts.get(identity) ?? 0) + 1);
      }
      for (const [identity, reading] of expected) {
        const count = counts.get(identity) ?? 0;
        if (
          (reading.outcome === 'accepted' && count !== 1) ||
          (['rejected', 'not_submitted'].includes(reading.outcome) && count !== 0) ||
          count > 1
        )
          failures.positions.push(`Observation/Track reading count ${entity} ${identity} ${count}`);
      }
    }
  }
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
  let historyRows = 0,
    historyBytes = 0;
  async function readHistory(
    key: string,
    view: ReturnType<typeof client.assets.history>,
  ): Promise<void> {
    const rows: HistoryReading[] = [];
    try {
      for (let page = 0; page < 101; page++) {
        const result = await view.next();
        if (result.kind === 'end') break;
        const data = success(result);
        if (historyRows + data.readings.length > 100000) throw new Error('History capacity');
        const incomingBytes = Buffer.byteLength(JSON.stringify(data.readings));
        if (historyBytes + incomingBytes > 12582912)
          throw new Error('Aggregate history byte budget');
        historyBytes += incomingBytes;
        historyRows += data.readings.length;
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
    evidence.history.set(key, rows);
  }
  try {
    success(await client.connect());
    for (const [alias, asset_id] of input.assets) {
      const found = await client.assets.get({ asset_id });
      if (
        found.kind === 'response' &&
        found.response.kind === 'error' &&
        ['entity_not_found', 'asset_not_found'].includes(found.response.body.error.code)
      )
        continue;
      evidence.assets.set(alias, success(found));
      await readHistory(
        alias,
        client.assets.history({ entity_id: asset_id, query_id: id(), page_size: 1000 }),
      );
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
    for (const [observation_id] of evidence.observations)
      await readHistory(
        observation_id,
        client.observations.history({ entity_id: observation_id, query_id: id(), page_size: 1000 }),
      );
    for (const track of evidence.tracks)
      await readHistory(
        track.id,
        client.tracks.history({ entity_id: track.id, query_id: id(), page_size: 1000 }),
      );
    return evidence;
  } finally {
    await client.close();
  }
}
export async function verifyRun(input: VerificationInput): Promise<CheckResults> {
  return checkEvidence(input, await collectEvidence(input));
}
