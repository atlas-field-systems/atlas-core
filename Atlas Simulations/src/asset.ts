import type {
  Altitude,
  ExecutionEvidence,
  ExecutionPayload,
  Position,
  Task,
} from '@atlas/protocol';
import { Counter, NewId, Sequence, Timestamp, Uuid } from '@atlas/protocol';
import type {
  AssetReporter,
  AssignedInstructions,
  HttpClient,
  ObservationReporter,
} from '@atlas/sdk';
import { createClient } from '@atlas/sdk';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import type { Scenario } from './scenario.js';
import { id, isAuthorizationFailure, success } from './sdk.js';
import { Truth } from './truth.js';
import { World } from './world.js';
import { Writes } from './writes.js';

type Context = NonNullable<AssignedInstructions['context']>;
type Instructions = { context: Context; tasks: Map<Uuid, Task>; started: number };
type Move = { taskId: Uuid; target: Position; altitude?: Altitude; geometryRevision?: Counter };
export type Gate = { kind: 'running' } | { kind: 'paused'; byTask: Uuid; revision: Counter };
export type QueuedExecution =
  | { kind: 'idle' }
  | { kind: 'moving' | 'paused'; move: Move }
  | { kind: 'reporting-terminal'; move: Move; outcome: 'completed' | 'cancelled' | 'failed' };
export type RuntimeStop = {
  error: unknown;
  world: { position: Position; altitude: Altitude | null };
};
export class AssetRuntime {
  readonly identity = {
    asset_id: id(),
    process_generation: id(),
    api_key_id: id(),
    secret: randomBytes(32).toString('base64url'),
  };
  readonly client: HttpClient;
  gate: Gate = { kind: 'running' };
  execution: QueuedExecution = { kind: 'idle' };
  private reporter: AssetReporter | undefined;
  private assetSequence = 0n;
  private queueSequence = 0n;
  private readonly executionSequences = new Map<Uuid, bigint>();
  private highestControlRevision = Counter.parse('0');
  private adoptedQueueRevision = Counter.parse('0');
  private readonly terminal = new Set<Uuid>();
  private readonly observations = new Map<
    string,
    { reporter: ObservationReporter; sequence: bigint }
  >();
  private readonly loops = new Set<Promise<void>>();
  private readonly stopSignal = new AbortController();
  private parked = false;
  readonly hooks: {
    instructionHoldUntil: number;
    networkHoldUntil: number;
    refuseCancellation: boolean;
    cancellationHoldUntil: number;
    failResume: boolean;
    beforeResume?: () => Promise<void>;
    contactDelayMs: number;
  } = {
    instructionHoldUntil: 0,
    networkHoldUntil: 0,
    refuseCancellation: false,
    cancellationHoldUntil: 0,
    failResume: false,
    contactDelayMs: 0,
  };
  private lastMovement = performance.now();
  private timer: NodeJS.Timeout | undefined;
  private failure: RuntimeStop | undefined;
  stopState(): RuntimeStop | undefined {
    return this.failure;
  }
  readonly writes: Writes;
  constructor(
    readonly input: {
      config: Scenario['assets'][number];
      baseUrl: string;
      datasetId: Uuid;
      runId: string;
      world: World;
      truth: Truth;
      fatal: (error: unknown) => void;
    },
  ) {
    this.writes = new Writes(input.truth);
    this.client = createClient({
      baseUrl: input.baseUrl,
      credentials: () => this.identity.secret,
      datasetId: input.datasetId,
      timeoutMs: 3000,
    });
  }
  get alias(): string {
    return this.input.config.alias;
  }
  private physical(event: 'start' | 'arrive' | 'pause' | 'resume' | 'cancel', task: Uuid): void {
    this.input.truth.append({
      kind: 'physical',
      at: performance.now(),
      asset: this.alias,
      event,
      task,
      position: { ...this.input.world.get(this.alias).position },
    });
  }
  private startup: Promise<void> | undefined;
  start(registrar: HttpClient): Promise<void> {
    this.startup = this.initialize(registrar);
    return this.startup;
  }
  private async initialize(registrar: HttpClient): Promise<void> {
    const registration = registrar.reporting.register({
      ...this.identity,
      registration_id: id(),
      request_id: id(),
      alias: `${this.alias} ${this.input.runId}`,
      capabilities: {
        commands: [
          { command: 'move_to', scheduling: ['queued'] },
          { command: 'pause', scheduling: ['immediate'] },
          { command: 'resume', scheduling: ['immediate'] },
        ],
      },
    });
    try {
      let accepted = false;
      for (let attempt = 0; attempt < 10; attempt++) {
        const result = await registration.registration.send({ timeoutMs: 3000 });
        if (result.outcome.kind === 'accepted') {
          accepted = true;
          break;
        }
        if (result.outcome.kind !== 'unknown_outcome') {
          success(result.attempt);
          break;
        }
        await delay(Math.min(2000, 100 * 2 ** attempt));
      }
      if (!accepted) throw new Error('Registration unresolved');
    } finally {
      registration.registration.close();
    }
    if (this.parked) return;
    success(await this.client.connect());
    if (this.parked) return;
    this.reporter = this.client.reporting.asset({
      id: this.identity.asset_id,
      process_generation: this.identity.process_generation,
    });
    await this.contact(true);
    if (this.parked) return;
    this.timer = setInterval(() => {
      try {
        const now = performance.now(),
          elapsed = (now - this.lastMovement) / 1000;
        this.lastMovement = now;
        if (this.parked || this.execution.kind !== 'moving' || this.gate.kind !== 'running') return;
        const move = this.execution.move;
        if (
          this.input.world.move(
            this.alias,
            move.target,
            this.input.config.cruise_speed,
            elapsed,
            move.altitude,
          )
        ) {
          this.physical('arrive', move.taskId);
          this.execution = { kind: 'reporting-terminal', move, outcome: 'completed' };
        }
      } catch (e) {
        this.fail(e);
      }
    }, 100);
    this.loop(1000, () => this.instructions());
    this.loop(500, () => this.position());
    this.loop(5000, () => this.contact(false));
    this.loop(1000, () => this.detect());
  }
  private fail(error: unknown): void {
    if (this.failure) {
      if (isAuthorizationFailure(this.failure.error) && !isAuthorizationFailure(error))
        this.input.fatal(error);
      return;
    }
    const world = this.input.world.get(this.alias);
    this.failure = {
      error,
      world: {
        position: { ...world.position },
        altitude: world.altitude === null ? null : { ...world.altitude },
      },
    };
    this.parked = true;
    this.input.fatal(error);
  }
  private loop(interval: number, callback: () => Promise<void>): void {
    const promise = (async () => {
      try {
        while (!this.stopSignal.signal.aborted) {
          await delay(interval, undefined, { signal: this.stopSignal.signal });
          if (!this.parked && performance.now() >= this.hooks.networkHoldUntil) await callback();
        }
      } catch (error) {
        if (!(error instanceof Error && error.name === 'AbortError')) this.fail(error);
      }
    })();
    this.loops.add(promise);
    void promise.finally(() => this.loops.delete(promise));
  }
  private reading(first = false) {
    const source = this.input.world.get(this.alias),
      sample = this.input.world.reading(this.alias),
      origin = {
        kind: 'asset_process',
        process_generation: this.identity.process_generation,
      } as const;
    const now = sample.observed_at;
    return {
      report_id: id(),
      sequence: Sequence.parse(String(++this.assetSequence)),
      generated_at: now,
      mode: 'current' as const,
      sections: {
        telemetry: {
          state: 'value' as const,
          classification: 'dated_measurement' as const,
          observed_at: now,
          value: {
            position: sample.position,
            altitude: source.altitude,
            ground_speed: this.execution.kind === 'moving' ? this.input.config.cruise_speed : 0,
          },
          constituents: {
            position: { origin, reading_id: sample.reading_id },
            altitude: { origin, reading_id: id() },
            ground_speed: { origin, reading_id: id() },
          },
        },
        ...(first
          ? {
              tags: {
                state: 'value' as const,
                classification: 'state_until_changed' as const,
                observed_at: null,
                value: { presets: ['simulated' as const] },
              },
            }
          : {}),
      },
    };
  }
  prepareTags() {
    if (!this.reporter) throw new Error('Reporter missing');
    return this.reporter.update({ request_id: id() }, this.reading(true));
  }
  async prepareObservation() {
    const creation = this.client.reporting.createObservation({
      observation_id: id(),
      publisher_id: id(),
      source_asset_id: this.identity.asset_id,
      request_id: id(),
    });
    await this.writes.send(creation.creation);
    const origin = {
      kind: 'publisher',
      publisher_id: creation.reporter.identity.publisher_id,
    } as const;
    const now = Timestamp.parse(new Date().toISOString());
    return creation.reporter.report({
      mode: 'current',
      report_id: id(),
      sequence: Sequence.parse('1'),
      generated_at: now,
      sections: {
        telemetry: {
          state: 'value',
          classification: 'dated_measurement',
          observed_at: now,
          value: {
            position: { ...this.input.world.get(this.alias).position },
            altitude: null,
            ground_speed: 0,
          },
          constituents: {
            position: { origin, reading_id: id() },
            altitude: { origin, reading_id: id() },
            ground_speed: { origin, reading_id: id() },
          },
        },
      },
    });
  }
  preparePosition() {
    if (!this.reporter) throw new Error('Reporter missing');
    return this.reporter.update({ request_id: id() }, this.reading());
  }
  async checkContact(): Promise<void> {
    await this.contact(false);
  }
  async position(): Promise<void> {
    if (!this.reporter) throw new Error('Reporter missing');
    await this.writes.send(this.reporter.update({ request_id: id() }, this.reading()), 'sample');
  }
  private contactWork: Promise<void> | undefined;
  private contact(first: boolean): Promise<void> {
    if (this.contactWork) return this.contactWork;
    const work = this.refreshContact(first);
    this.contactWork = work;
    const release = () => {
      if (this.contactWork === work) this.contactWork = undefined;
    };
    void work.then(release, release);
    return work;
  }
  private async refreshContact(first: boolean): Promise<void> {
    for (let refresh = 0; refresh < 3; refresh++) {
      try {
        await this.contactOnce(first);
        return;
      } catch (error) {
        if (
          !(error instanceof Error && /challenge_expired|contact_expired/.test(error.message)) ||
          refresh === 2
        )
          throw error;
      }
    }
  }
  private async contactOnce(first: boolean): Promise<void> {
    if (!this.reporter) throw new Error('Reporter missing');
    const contact = this.client.assets.contact({
      mode: 'current',
      asset_id: this.identity.asset_id,
      process_generation: this.identity.process_generation,
      request_id: id(),
    });
    let report: ReturnType<AssetReporter['update']> | undefined;
    try {
      let challenge;
      for (let retry = 0; retry < 10; retry++) {
        const result = await contact.read({ timeoutMs: 3000 });
        if (result.kind === 'response' && result.response.kind === 'success') {
          challenge = result.response.body.data;
          break;
        }
        if (contact.releaseEvidence === 'expired' || contact.releaseEvidence === 'owner-ended')
          throw new Error('contact_expired');
        await delay(Math.min(2000, 100 * 2 ** retry));
      }
      if (!challenge) throw new Error('Contact allocation unresolved');
      const contactDelay = this.hooks.contactDelayMs;
      this.hooks.contactDelayMs = 0;
      if (contactDelay) await delay(contactDelay);
      report = this.reporter.update(
        { request_id: id() },
        {
          ...this.reading(first),
          generated_at: challenge.issued_at,
          contact_proof: { challenge_id: challenge.challenge_id },
        },
      );
      await this.writes.send(contact.checkIn(report.submission.facts), 'contact');
    } finally {
      report?.close();
      await contact.close();
    }
  }
  private evidence(payload: ExecutionPayload): ExecutionEvidence {
    const sequence = (this.executionSequences.get(payload.task_id) ?? 0n) + 1n;
    this.executionSequences.set(payload.task_id, sequence);
    return {
      dataset_id: this.input.datasetId,
      asset_id: this.identity.asset_id,
      origin: { kind: 'asset_process', process_generation: this.identity.process_generation },
      report_id: id(),
      sequence: Sequence.parse(String(sequence)),
      generated_at: Timestamp.parse(new Date().toISOString()),
      payload,
    };
  }
  prepareExecution(payload: ExecutionPayload) {
    return this.client.tasks.reportExecution({ evidence: this.evidence(payload) });
  }
  async pollInstructions(): Promise<void> {
    await this.instructions();
  }
  async report(payload: ExecutionPayload): Promise<void> {
    await this.writes.send(this.prepareExecution(payload));
    if (payload.event === 'state' && ['completed', 'failed', 'cancelled'].includes(payload.state))
      this.terminal.add(payload.task_id);
  }
  private async readInstructions(): Promise<Instructions> {
    const started = performance.now();
    const handle = this.client.tasks.assigned({
      asset_id: this.identity.asset_id,
      process_generation: this.identity.process_generation,
      read_id: id(),
      page_size: 100,
    });
    const tasks = new Map<Uuid, Task>();
    try {
      for (let page = 0; page < 12; page++) {
        const result = await handle.next();
        if (result.kind === 'end') {
          if (!handle.context) throw new Error('Missing instruction context');
          return { context: handle.context, tasks, started };
        }
        const data = success(result);
        if (tasks.size + data.tasks.length > 1003) throw new Error('Assigned work capacity');
        for (const task of data.tasks) tasks.set(task.task_id, task);
      }
      throw new Error('Assigned page capacity');
    } finally {
      handle.close();
    }
  }
  private async resolveMove(task: Extract<Task, { command: 'move_to' }>): Promise<Move> {
    const target = task.inputs.target;
    const extra = task.inputs.altitude === undefined ? {} : { altitude: task.inputs.altitude };
    if (target.kind === 'position')
      return { taskId: task.task_id, target: { ...target.position }, ...extra };
    const feature = success(
      await this.client.geofeatures.get({ geofeature_id: target.geofeature_id }),
    );
    if (feature.geometry.type !== 'Point') throw new Error('Move target must be Point');
    const [longitude, latitude] = feature.geometry.coordinates;
    if (latitude === undefined || longitude === undefined)
      throw new Error('Point coordinates missing');
    return {
      taskId: task.task_id,
      target: { latitude, longitude },
      geometryRevision: feature.geometry_revision,
      ...extra,
    };
  }
  private async instructions(): Promise<void> {
    if (performance.now() < this.hooks.instructionHoldUntil) return;
    let read: Instructions;
    try {
      read = await this.readInstructions();
    } catch (error) {
      if (
        error instanceof Error &&
        /queue_changed|network|deadline|resource_limit|not_connected|invalid_http|superseded/.test(
          error.message,
        )
      )
        return;
      throw error;
    }
    const { context, tasks } = read;
    if (BigInt(context.task_control.revision) >= BigInt(this.highestControlRevision))
      this.highestControlRevision = context.task_control.revision;
    if (this.execution.kind === 'reporting-terminal') {
      const execution = this.execution;
      await this.position();
      await this.report({
        task_id: execution.move.taskId,
        event: 'state',
        state: 'completed',
        ...(execution.move.geometryRevision
          ? { geometry_revision: execution.move.geometryRevision }
          : {}),
      });
      if (this.execution === execution) this.execution = { kind: 'idle' };
      return;
    }
    for (const task of tasks.values()) {
      const taskId = task.task_id;
      if (!task.cancellation_request_id || this.terminal.has(taskId)) continue;
      if (performance.now() < this.hooks.cancellationHoldUntil) return;
      if (this.hooks.refuseCancellation) {
        await this.report({
          task_id: taskId,
          event: 'cancellation_refused',
          state: task.execution_state,
          reason: 'unable',
          cancellation_request_id: task.cancellation_request_id,
        });
        return;
      }
      if (this.execution.kind !== 'idle' && this.execution.move.taskId === taskId) {
        this.physical('cancel', taskId);
        this.execution = { kind: 'idle' };
      }
      await this.report({
        task_id: taskId,
        event: 'state',
        state: 'cancelled',
        cancellation_request_id: task.cancellation_request_id,
      });
      return;
    }
    const requested = context.task_control.requested;
    for (const task of tasks.values()) {
      if (
        task.command !== 'move_to' &&
        task.task_id !== requested?.task_id &&
        !this.terminal.has(task.task_id) &&
        !['completed', 'failed', 'cancelled'].includes(task.execution_state)
      ) {
        await this.report({
          task_id: task.task_id,
          event: 'state',
          state: 'failed',
          reason: 'superseded',
        });
      }
    }
    if (requested && !this.terminal.has(requested.task_id)) {
      const control = tasks.get(requested.task_id);
      if (control && !['completed', 'failed', 'cancelled'].includes(control.execution_state)) {
        if (context.task_control.revision !== this.highestControlRevision) return;
        if (requested.command === 'pause') {
          this.gate = {
            kind: 'paused',
            byTask: requested.task_id,
            revision: context.task_control.revision,
          };
          this.physical('pause', requested.task_id);
          if (this.execution.kind === 'moving') {
            const move = this.execution.move;
            this.execution = { kind: 'paused', move };
            this.physical('pause', move.taskId);
            await this.report({ task_id: move.taskId, event: 'state', state: 'paused' });
          }
          await this.report({
            task_id: requested.task_id,
            event: 'state',
            state: 'completed',
            control_revision: context.task_control.revision,
            queue_state: 'paused',
            applied_at: Timestamp.parse(new Date().toISOString()),
          });
          return;
        }
        if (Date.now() >= Date.parse(control.command === 'resume' ? control.expires_at : '')) {
          await this.report({
            task_id: control.task_id,
            event: 'state',
            state: 'failed',
            reason: 'expired',
          });
          return;
        }
        const fresh = await this.readInstructions();
        const latest = fresh.context.task_control;
        if (BigInt(latest.revision) > BigInt(this.highestControlRevision))
          this.highestControlRevision = latest.revision;
        if (
          latest.requested?.task_id !== requested.task_id ||
          latest.revision !== this.highestControlRevision
        ) {
          await this.report({
            task_id: control.task_id,
            event: 'state',
            state: 'failed',
            reason: 'superseded',
          });
          return;
        }
        const latestTask = fresh.tasks.get(control.task_id);
        if (
          !latestTask ||
          latestTask.command !== 'resume' ||
          latestTask.cancellation_request_id ||
          Date.now() >= Date.parse(latestTask.expires_at) ||
          performance.now() - fresh.started >= 10000 ||
          Date.now() >= Date.parse(fresh.context.instructions_valid_until) ||
          fresh.context.core_run_id !== context.core_run_id
        )
          return;
        if (this.execution.kind === 'paused') {
          const remaining = fresh.tasks.get(this.execution.move.taskId);
          if (
            !remaining ||
            remaining.cancellation_request_id ||
            !['paused', 'in_progress'].includes(remaining.execution_state)
          )
            return;
        }
        if (this.hooks.failResume) {
          if (this.execution.kind === 'paused') {
            await this.report({
              task_id: this.execution.move.taskId,
              event: 'state',
              state: 'failed',
              reason: 'resume_failed',
            });
            this.execution = { kind: 'idle' };
          }
          await this.report({
            task_id: control.task_id,
            event: 'state',
            state: 'failed',
            reason: 'resume_failed',
          });
          return;
        }
        await this.hooks.beforeResume?.();
        if (
          this.parked ||
          performance.now() - fresh.started >= 10000 ||
          Date.now() >= Date.parse(fresh.context.instructions_valid_until) ||
          Date.now() >= Date.parse(latestTask.expires_at) ||
          latest.revision !== this.highestControlRevision
        )
          return;
        this.gate = { kind: 'running' };
        this.physical('resume', control.task_id);
        if (this.execution.kind === 'paused') {
          const move = this.execution.move;
          this.execution = { kind: 'moving', move };
          this.lastMovement = performance.now();
          this.physical('resume', move.taskId);
        }
        const { read_id, core_run_id, captured_at, instructions_valid_until, task_queue } =
          fresh.context;
        const applied_at = Timestamp.parse(new Date().toISOString());
        await this.report({
          task_id: control.task_id,
          event: 'state',
          state: 'completed',
          control_revision: latest.revision,
          queue_state: 'running',
          applied_at,
          read_id: NewId.parse(read_id),
          core_run_id,
          captured_at,
          instructions_valid_until,
          queue_revision: task_queue.revision,
        });
        if (this.execution.kind === 'moving')
          await this.report({
            task_id: this.execution.move.taskId,
            event: 'state',
            state: 'in_progress',
          });
        return;
      }
    }
    if (context.task_queue.revision !== this.adoptedQueueRevision) {
      await this.writes.send(
        this.client.tasks.confirmOrder({
          evidence: {
            dataset_id: this.input.datasetId,
            asset_id: this.identity.asset_id,
            origin: { kind: 'asset_process', process_generation: this.identity.process_generation },
            report_id: id(),
            sequence: Sequence.parse(String(++this.queueSequence)),
            generated_at: Timestamp.parse(new Date().toISOString()),
            payload: { queue_revision: context.task_queue.revision },
          },
        }),
      );
      this.adoptedQueueRevision = context.task_queue.revision;
    }
    if (this.gate.kind === 'paused' || this.execution.kind !== 'idle') return;
    const taskId = context.task_queue.requested_task_ids.find(
      (taskId) => !this.terminal.has(taskId),
    );
    if (!taskId) return;
    const task = tasks.get(taskId);
    if (!task || task.command !== 'move_to' || task.cancellation_request_id) return;
    const move = await this.resolveMove(task);
    if (
      this.parked ||
      this.gate.kind !== 'running' ||
      this.execution.kind !== 'idle' ||
      this.terminal.has(taskId) ||
      context.task_control.revision !== this.highestControlRevision
    )
      return;
    this.execution = { kind: 'moving', move };
    this.lastMovement = performance.now();
    this.physical('start', taskId);
    await this.report({
      task_id: taskId,
      event: 'state',
      state: 'in_progress',
      ...(move.geometryRevision ? { geometry_revision: move.geometryRevision } : {}),
    });
  }
  private async detect(): Promise<void> {
    for (const subject of this.input.world.detected(
      this.alias,
      this.input.config.detection_radius,
    )) {
      let state = this.observations.get(subject.alias);
      if (!state) {
        const creation = this.client.reporting.createObservation({
          observation_id: id(),
          publisher_id: id(),
          source_asset_id: this.identity.asset_id,
          request_id: id(),
        });
        await this.writes.send(creation.creation);
        state = { reporter: creation.reporter, sequence: 0n };
        this.observations.set(subject.alias, state);
      }
      const origin = {
        kind: 'publisher',
        publisher_id: state.reporter.identity.publisher_id,
      } as const;
      const sample = this.input.world.reading(subject.alias, 'subject');
      const now = sample.observed_at;
      await this.writes.send(
        state.reporter.report({
          mode: 'current',
          report_id: id(),
          sequence: Sequence.parse(String(++state.sequence)),
          generated_at: now,
          sections: {
            telemetry: {
              state: 'value',
              classification: 'dated_measurement',
              observed_at: now,
              value: { position: sample.position, altitude: null, ground_speed: 0 },
              constituents: {
                position: { origin, reading_id: sample.reading_id },
                altitude: { origin, reading_id: id() },
                ground_speed: { origin, reading_id: id() },
              },
            },
          },
        }),
        'sample',
      );
    }
  }
  async park(deadline = performance.now() + 30000): Promise<void> {
    this.parked = true;
    this.stopSignal.abort();
    if (this.timer) clearInterval(this.timer);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        Promise.all([
          this.writes.drain(deadline),
          Promise.allSettled([this.startup, this.contactWork, ...this.loops]),
        ]),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Unresolved Asset owners ${this.alias}`)),
            Math.max(0, deadline - performance.now()),
          );
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  async close(): Promise<void> {
    await this.client.close();
  }
}
