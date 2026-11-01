import type { Uuid } from '@atlas/protocol';
import { Timestamp } from '@atlas/protocol';
import type { FullClient, HttpClient } from '@atlas/sdk';
import { createClient } from '@atlas/sdk';
import type { Scenario, TimelineAction } from './scenario.js';
import { id, success } from './sdk.js';
import { Truth } from './truth.js';
import { Writes } from './writes.js';
type OperatorReads = {
  assets: Pick<HttpClient['assets'], 'get'>;
  tasks: Pick<HttpClient['tasks'], 'get'>;
};
export type TaskBinding = {
  asset: string;
  index: number;
  id: Uuid;
  action: Extract<TimelineAction, { action: 'move_to' }>;
};
export class Operator {
  readonly client: FullClient;
  readonly moves: TaskBinding[] = [];
  readonly controls: Uuid[] = [];
  readonly features = new Map<string, Uuid>();
  readonly writes: Writes;
  private subscription: ReturnType<FullClient['picture']['subscribe']> | undefined;
  private pictureReader: Promise<void> | undefined;
  constructor(
    readonly input: {
      baseUrl: string;
      secret: string;
      datasetId: Uuid;
      assets: ReadonlyMap<string, Uuid>;
      truth: Truth;
      reader: OperatorReads;
    },
  ) {
    this.client = createClient({
      baseUrl: input.baseUrl,
      credentials: () => input.secret,
      datasetId: input.datasetId,
      mode: 'full',
    });
    this.writes = new Writes(input.truth);
  }
  async start(scenario: Scenario): Promise<void> {
    const started = performance.now();
    success(await this.client.connect());
    const deadline = performance.now() + 10000;
    while (this.client.picture.status.kind !== 'synchronized') {
      if (performance.now() > deadline) throw new Error('Initial picture deadline');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    this.input.truth.measurements.initialLoadMs = performance.now() - started;
    const subscription = this.client.picture.subscribe();
    this.subscription = subscription;
    this.pictureReader = (async () => {
      for await (const event of subscription) {
        if (event.kind !== 'commit') continue;
        this.input.truth.pictureCommit(event.commit.coreCursor);
      }
    })();
    void this.pictureReader.catch(() => {});
    for (const feature of scenario.geofeatures ?? []) {
      const identifier = id();
      await this.writes.send(
        this.client.geofeatures.create({
          request_id: id(),
          geofeature_id: identifier,
          alias: feature.alias,
          geometry: {
            type: 'Point',
            coordinates: [feature.position.longitude, feature.position.latitude],
          },
        }),
      );
      this.features.set(feature.alias, identifier);
    }
  }
  move(asset: string, index: number): TaskBinding {
    const binding = this.moves.find((m) => m.asset === asset && m.index === index);
    if (!binding) throw new Error('Missing Task binding');
    return binding;
  }
  async apply(action: Exclude<TimelineAction, { action: 'fault' }>): Promise<void> {
    const asset_id = this.input.assets.get(action.asset);
    if (!asset_id) throw new Error('Unknown Asset binding');
    switch (action.action) {
      case 'move_to': {
        const task_id = id();
        const target =
          'position' in action
            ? { kind: 'position' as const, position: action.position }
            : { kind: 'geofeature' as const, geofeature_id: this.feature(action.geofeature) };
        await this.writes.send(
          this.client.tasks.create({
            request_id: id(),
            task_id,
            asset_id,
            command: 'move_to',
            scheduling: 'queued',
            inputs: {
              target,
              ...(action.altitude === undefined ? {} : { altitude: action.altitude }),
            },
          }),
        );
        this.moves.push({
          asset: action.asset,
          index: this.moves.filter((m) => m.asset === action.asset).length,
          id: task_id,
          action,
        });
        return;
      }
      case 'pause':
      case 'resume': {
        const task_id = id();
        await this.writes.send(
          this.client.tasks.create(
            action.action === 'pause'
              ? {
                  request_id: id(),
                  task_id,
                  asset_id,
                  command: 'pause',
                  scheduling: 'immediate',
                  inputs: {},
                }
              : {
                  request_id: id(),
                  task_id,
                  asset_id,
                  command: 'resume',
                  scheduling: 'immediate',
                  inputs: {},
                  expires_at: Timestamp.parse(new Date(Date.now() + 30000).toISOString()),
                },
          ),
        );
        this.controls.push(task_id);
        return;
      }
      case 'cancel':
        await this.writes.send(
          this.client.tasks.cancel({
            request_id: id(),
            task_id: this.move(action.asset, action.index).id,
          }),
        );
        return;
      case 'reorder': {
        const asset = success(await this.input.reader.assets.get({ asset_id }));
        await this.writes.send(
          this.client.tasks.setOrder({
            request_id: id(),
            asset_id,
            expected_queue_revision: asset.task_queue.revision,
            task_ids: action.indexes.map((i) => this.move(action.asset, i).id),
          }),
        );
        return;
      }
      default: {
        const exhaustive: never = action;
        throw new Error(String(exhaustive));
      }
    }
  }
  private feature(alias: string): Uuid {
    const value = this.features.get(alias);
    if (!value) throw new Error('Missing Geofeature binding');
    return value;
  }
  async close(): Promise<void> {
    await this.writes.drain();
    this.subscription?.close();
    await this.pictureReader;
    await this.client.close();
  }
}
