import type Database from 'better-sqlite3';
import { z } from 'zod';
import { AssignedTasks, Counter, Task, Uuid } from '@atlas/protocol';
import type { Asset, ExecutionEvidence, ExecutionPayload, RequestOf } from '@atlas/protocol';
import { canonical, instant, next, now, zero } from './exact.js';
import { refuse } from './fault.js';
import type { Store, Transaction } from './database.js';
import type { Entities } from './entities.js';
import type { Identity } from './identity.js';
import type { Temporary } from './temporary.js';
import { boundedPage } from './pages.js';

const Image = z.object({ image: z.string() });
const Internal = z.object({ started: z.number(), generation: Uuid.nullable(), sequence: Counter,
  control_revision: Counter.nullable() });
const { tasks: _tasks, next_page_token: _next, ...assignedFields } = AssignedTasks.shape;
const AssignedContext = z.strictObject(assignedFields);
const Instructions = z.object({ facts: z.string(), image: z.string() });
const AssignedToken = z.object({ context: AssignedContext, after: z.string(), size: z.number().int(), deadline: z.number() });
const terminal = (task: Task): boolean => ['completed', 'failed', 'cancelled'].includes(task.execution_state);
type StreamEvidence = ExecutionEvidence | RequestOf<'ReportTaskResults'>['evidence'] | RequestOf<'ConfirmTaskOrder'>['evidence'];
export class Tasks {
  constructor(private readonly store: Store, private readonly entities: Entities, private readonly identity: Identity, private readonly temporary: Temporary,
    private readonly declare: (task: Uuid, object: Uuid, required: boolean) => void) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS task_images(id TEXT PRIMARY KEY,asset TEXT NOT NULL,image TEXT NOT NULL,geofeature TEXT) STRICT;
      CREATE INDEX IF NOT EXISTS tasks_asset ON task_images(asset,id);
      CREATE TABLE IF NOT EXISTS task_internal(id TEXT PRIMARY KEY,started INTEGER NOT NULL,generation TEXT,sequence TEXT NOT NULL,control_revision TEXT) STRICT;
      CREATE TABLE IF NOT EXISTS task_submission(asset TEXT PRIMARY KEY,sequence TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_evidence(scope TEXT NOT NULL,report TEXT NOT NULL,sequence TEXT NOT NULL,facts TEXT NOT NULL,PRIMARY KEY(scope,report),UNIQUE(scope,sequence)) STRICT;
      CREATE TABLE IF NOT EXISTS task_adoption(asset TEXT PRIMARY KEY,generation TEXT NOT NULL,sequence TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_instructions(read_id TEXT PRIMARY KEY,facts TEXT NOT NULL,image TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_terminal(id TEXT PRIMARY KEY,payload TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_cancellation_retries(request TEXT PRIMARY KEY,image TEXT NOT NULL) STRICT;
      CREATE TABLE IF NOT EXISTS task_instruction_lifetime(read_id TEXT PRIMARY KEY,run TEXT NOT NULL,deadline REAL NOT NULL) STRICT;`);
  }
  get(taskId: Uuid): Task {
    const row = this.store.db.prepare('SELECT image FROM task_images WHERE id=?').get(taskId);
    if (!row) refuse('entity_not_found');
    return Task.parse(JSON.parse(Image.parse(row).image));
  }
  private internal(taskId: Uuid): z.infer<typeof Internal> {
    return Internal.parse(this.store.db.prepare('SELECT started,generation,sequence,control_revision FROM task_internal WHERE id=?').get(taskId));
  }
  private save(tx: Transaction, task: Task, required = false): Task {
    const image = Task.parse(task);
    const bytes = Buffer.byteLength(JSON.stringify(image));
    if (bytes > this.store.settings.resourceImageBytes - (required ? 0 : 16_384)) refuse('resource_limit');
    this.store.db.prepare('UPDATE task_images SET image=? WHERE id=?').run(JSON.stringify(image), image.task_id);
    tx.change({ kind: 'put', resource_kind: 'task', resource_id: image.task_id, version: image.version, image });
    return image;
  }
  create(tx: Transaction, request: RequestOf<'CreateTask'>): Task {
    if (tx.retry('CreateTask', request.request_id, request)) return this.get(request.task_id);
    const asset = this.entities.asset(request.asset_id);
    if (this.store.db.prepare('SELECT id FROM task_images WHERE id=?').get(request.task_id)) refuse('identity_conflict');
    if (!asset.capabilities.commands.some(c => c.command === request.command && c.scheduling.some(s => s === request.scheduling))) refuse('unsupported_command');
    const count = z.object({ count: z.number() }).parse(this.store.db.prepare(`SELECT count(*) AS count FROM task_images WHERE asset=? AND json_extract(image,'$.execution_state') NOT IN ('completed','failed','cancelled')`).get(asset.id)).count;
    if (count >= this.store.settings.outstandingTasks) refuse('resource_limit');
    let feature: Uuid | null = null;
    if (request.command === 'move_to' && request.inputs.target.kind === 'geofeature') {
      const target = this.entities.geofeature(request.inputs.target.geofeature_id);
      if (target.geometry.type !== 'Point') refuse('unsupported_geometry');
      feature = target.id;
    }
    const accepted = now();
    if (request.command === 'resume' && (instant(request.expires_at) <= instant(accepted) || instant(request.expires_at) - instant(accepted) > 60_000_000_000n)) refuse('invalid_request');
    const old = this.store.db.prepare('SELECT sequence FROM task_submission WHERE asset=?').get(asset.id);
    const sequence = next(old === undefined ? zero : z.object({ sequence: Counter }).parse(old).sequence);
    this.store.db.prepare('INSERT INTO task_submission VALUES(?,?) ON CONFLICT(asset) DO UPDATE SET sequence=excluded.sequence').run(asset.id, sequence);
    const task = Task.parse({ ...request, dataset_id: this.store.dataset, version: zero, accepted_at: accepted,
      submission_sequence: sequence, execution_state: 'pending', cancellation_request_id: null, result_declarations: [] });
    this.store.db.prepare('INSERT INTO task_images VALUES(?,?,?,?)').run(task.task_id, task.asset_id, JSON.stringify(task), feature);
    let control = null;
    if (task.command === 'move_to') {
      asset.task_queue.requested_task_ids.push(task.task_id);
      asset.task_queue.revision = next(asset.task_queue.revision);
    } else {
      control = next(asset.task_control.revision);
      asset.task_control.revision = control;
      asset.task_control.requested = task.command === 'pause'
        ? { command: 'pause', task_id: task.task_id, expires_at: null }
        : { command: 'resume', task_id: task.task_id, expires_at: task.expires_at };
    }
    this.store.db.prepare('INSERT INTO task_internal VALUES(?,0,NULL,?,?)').run(task.task_id, zero, control);
    asset.version = next(asset.version);
    this.entities.saveAsset(tx, asset);
    this.save(tx, task);
    tx.remember('CreateTask', request.request_id, request);
    this.identity.activity(tx, 'task', 'Task accepted');
    return task;
  }
  cancel(tx: Transaction, request: RequestOf<'RequestTaskCancellation'>): Task {
    const task = this.get(request.task_id);
    if (tx.retry('RequestTaskCancellation', request.request_id, request)) {
      const row = Image.parse(this.store.db.prepare('SELECT image FROM task_cancellation_retries WHERE request=?').get(request.request_id));
      return Task.parse(JSON.parse(row.image));
    }
    if (!terminal(task)) {
      if (task.cancellation_request_id !== null) refuse('cancellation_pending');
      task.cancellation_request_id = request.request_id;
      task.version = next(task.version);
      this.save(tx, task, true);
      const slot = this.internal(task.task_id);
      if (task.command === 'move_to' && slot.started === 0 && this.entities.isLive(task.asset_id, 'asset')) {
        const asset = this.entities.asset(task.asset_id);
        asset.task_queue.revision = next(asset.task_queue.revision);
        asset.version = next(asset.version); this.entities.saveAsset(tx, asset, true);
      }
      this.identity.activity(tx, 'task', 'Cancellation requested');
    }
    const image = JSON.stringify(task);
    tx.retainedBytes += Buffer.byteLength(image);
    this.store.db.prepare('INSERT INTO task_cancellation_retries VALUES(?,?)').run(request.request_id, image);
    tx.remember('RequestTaskCancellation', request.request_id, request);
    return task;
  }
  private admit(tx: Transaction, kind: string, evidence: StreamEvidence, taskId = ''): { duplicate: boolean; newer: boolean } {
    if (evidence.dataset_id !== this.store.dataset) refuse('dataset_mismatch');
    const asset = this.entities.asset(evidence.asset_id);
    const scope = `${asset.id}/${evidence.origin.process_generation}/${kind}/${taskId}`;
    const row = this.store.db.prepare('SELECT facts FROM task_evidence WHERE scope=? AND report=?').get(scope, evidence.report_id);
    if (row) {
      if (z.object({ facts: z.string() }).parse(row).facts !== canonical(evidence)) refuse('evidence_conflict');
      return { duplicate: true, newer: false };
    }
    if (asset.process_generation !== evidence.origin.process_generation) refuse('generation_mismatch');
    if (this.store.db.prepare('SELECT report FROM task_evidence WHERE scope=? AND sequence=?').get(scope, evidence.sequence)) refuse('evidence_conflict');
    const high = this.store.db.prepare('SELECT sequence FROM task_evidence WHERE scope=? ORDER BY length(sequence) DESC,sequence DESC LIMIT 1').get(scope);
    const newer = !high || BigInt(evidence.sequence) > BigInt(z.object({ sequence: Counter }).parse(high).sequence);
    this.store.db.prepare('INSERT INTO task_evidence VALUES(?,?,?,?)').run(scope, evidence.report_id, evidence.sequence, canonical(evidence));
    tx.dirty = true;
    return { duplicate: false, newer };
  }
  execution(tx: Transaction, request: RequestOf<'ReportTaskExecution'>) {
    const evidence = request.evidence;
    const task = this.get(evidence.payload.task_id);
    if (task.asset_id !== evidence.asset_id) refuse('identity_conflict');
    const admitted = this.admit(tx, 'execution', evidence, task.task_id);
    if (admitted.duplicate) return { task, evidence_disposition: 'duplicate' as const };
    const payload = evidence.payload;
    const before = this.internal(task.task_id);
    const asset = this.entities.asset(task.asset_id);
    this.validateExecution(task, payload, before.control_revision, evidence.origin.process_generation);
    if (terminal(task)) {
      if (task.execution_state !== payload.state || payload.event === 'cancellation_refused') refuse('terminal_state_conflict');
      const terminal = z.object({ payload: z.string() }).parse(this.store.db.prepare('SELECT payload FROM task_terminal WHERE id=?').get(task.task_id));
      if (terminal.payload !== canonical(payload)) refuse('terminal_state_conflict');
      return { task, evidence_disposition: 'accepted' as const };
    }
    const wasHeld = task.command === 'move_to' && before.started === 0 && task.cancellation_request_id !== null;
    const oldState = task.execution_state;
    const oldCancel = task.cancellation_request_id;
    if (payload.event === 'cancellation_refused' || payload.state === 'cancelled') {
      if (task.cancellation_request_id !== payload.cancellation_request_id) refuse('cancellation_changed');
    }
    const isTerminal = payload.state === 'completed' || payload.state === 'failed' || payload.state === 'cancelled';
    const newer = before.generation !== evidence.origin.process_generation || BigInt(evidence.sequence) > BigInt(before.sequence);
    if (isTerminal || newer) {
      if (task.command === 'move_to' && before.started !== 0 && payload.event === 'cancellation_refused' && payload.state === 'pending') refuse('invalid_request');
      task.execution_state = payload.state;
      this.store.db.prepare('UPDATE task_internal SET generation=?,sequence=? WHERE id=?').run(evidence.origin.process_generation, evidence.sequence, task.task_id);
    }
    if (isTerminal) this.store.db.prepare('INSERT INTO task_terminal VALUES(?,?)').run(task.task_id, canonical(payload));
    if (payload.event === 'cancellation_refused' || isTerminal) task.cancellation_request_id = null;
    const starts = task.execution_state === 'in_progress' || task.execution_state === 'paused' || terminal(task);
    let queueChanged = false;
    if (task.command === 'move_to' && starts && before.started === 0) {
      this.store.db.prepare('UPDATE task_internal SET started=1 WHERE id=?').run(task.task_id);
      asset.task_queue.requested_task_ids = asset.task_queue.requested_task_ids.filter(taskId => taskId !== task.task_id);
      queueChanged = true;
    } else if (wasHeld && payload.event === 'cancellation_refused') queueChanged = true;
    let controlChanged = false;
    if (payload.event === 'state' && payload.state === 'completed' && 'control_revision' in payload &&
      (asset.task_control.confirmed === null || asset.task_control.confirmed.process_generation !== evidence.origin.process_generation || BigInt(payload.control_revision) > BigInt(asset.task_control.confirmed.revision))) {
      asset.task_control.confirmed = { revision: payload.control_revision, task_id: task.task_id,
        process_generation: evidence.origin.process_generation, queue_state: payload.queue_state };
      controlChanged = true;
    }
    if (queueChanged) asset.task_queue.revision = next(asset.task_queue.revision);
    if (queueChanged || controlChanged) { asset.version = next(asset.version); this.entities.saveAsset(tx, asset, true); }
    if (oldState !== task.execution_state || oldCancel !== task.cancellation_request_id) {
      task.version = next(task.version); this.save(tx, task, true);
      this.identity.activity(tx, 'task', terminal(task) ? 'Task terminated' : 'Task execution updated');
    }
    return { task, evidence_disposition: 'accepted' as const };
  }
  private validateExecution(task: Task, payload: ExecutionPayload, control: Counter | null, generation: Uuid): void {
    if ('geometry_revision' in payload && (task.command !== 'move_to' || task.inputs.target.kind !== 'geofeature')) refuse('invalid_request');
    if (payload.event !== 'state' || payload.state !== 'completed') {
      if ('control_revision' in payload) refuse('invalid_request');
      return;
    }
    if (task.command === 'move_to') { if ('control_revision' in payload) refuse('invalid_request'); return; }
    if (!('control_revision' in payload) || payload.control_revision !== control || payload.queue_state !== (task.command === 'pause' ? 'paused' : 'running')) refuse('control_not_confirmed');
    if (task.command === 'resume') {
      if (!('read_id' in payload) || instant(payload.applied_at) >= instant(task.expires_at)) refuse('control_not_confirmed');
      const row = this.store.db.prepare('SELECT facts,image FROM task_instructions WHERE read_id=?').get(payload.read_id);
      if (!row) refuse('control_not_confirmed');
      const observed = AssignedContext.parse(JSON.parse(Instructions.parse(row).image));
      if (observed.asset_id !== task.asset_id || observed.process_generation !== generation || observed.read_id !== payload.read_id || observed.core_run_id !== payload.core_run_id ||
        observed.captured_at !== payload.captured_at || observed.instructions_valid_until !== payload.instructions_valid_until ||
        observed.task_queue.revision !== payload.queue_revision || observed.task_control.revision !== control || observed.task_control.requested?.task_id !== task.task_id) refuse('control_not_confirmed');
    }
  }
  results(tx: Transaction, request: RequestOf<'ReportTaskResults'>) {
    const evidence = request.evidence;
    const task = this.get(evidence.payload.task_id);
    if (task.asset_id !== evidence.asset_id) refuse('identity_conflict');
    if (this.admit(tx, 'results', evidence, task.task_id).duplicate) return { task, evidence_disposition: 'duplicate' as const };
    let changed = false;
    for (const declaration of evidence.payload.declarations) {
      const found = task.result_declarations.find(item => item.object_id === declaration.object_id);
      if (found && found.required !== declaration.required) refuse('evidence_conflict');
      if (found) continue;
      if (task.result_declarations.length >= 128) refuse('resource_limit');
      this.declare(task.task_id, declaration.object_id, declaration.required);
      task.result_declarations.push(declaration);
      changed = true;
    }
    if (changed) { task.version = next(task.version); this.save(tx, task); }
    return { task, evidence_disposition: 'accepted' as const };
  }
  order(tx: Transaction, request: RequestOf<'SetTaskOrder'>): Asset {
    const asset = this.entities.asset(request.asset_id);
    if (tx.retry('SetTaskOrder', request.request_id, request)) return asset;
    if (asset.task_queue.revision !== request.expected_queue_revision) refuse('queue_changed');
    const eligible = asset.task_queue.requested_task_ids.filter(taskId => this.get(taskId).cancellation_request_id === null);
    if (eligible.length !== request.task_ids.length || request.task_ids.some(taskId => !eligible.includes(taskId))) refuse('invalid_request');
    let position = 0;
    const order = asset.task_queue.requested_task_ids.map(taskId => {
      if (this.get(taskId).cancellation_request_id !== null) return taskId;
      const next = request.task_ids[position++];
      if (next === undefined) throw new Error('incomplete_order');
      return next;
    });
    if (canonical(order) !== canonical(asset.task_queue.requested_task_ids)) {
      asset.task_queue.requested_task_ids = order; asset.task_queue.revision = next(asset.task_queue.revision);
      asset.version = next(asset.version); this.entities.saveAsset(tx, asset, true);
      this.identity.activity(tx, 'task', 'Task order edited');
    }
    tx.remember('SetTaskOrder', request.request_id, request);
    return asset;
  }
  confirm(tx: Transaction, request: RequestOf<'ConfirmTaskOrder'>) {
    const evidence = request.evidence;
    const asset = this.entities.asset(evidence.asset_id);
    const admitted = this.admit(tx, 'adoption', evidence);
    if (admitted.duplicate) return { asset, evidence_disposition: 'duplicate' as const };
    if (BigInt(evidence.payload.queue_revision) > BigInt(asset.task_queue.revision)) refuse('queue_changed');
    let changed = false;
    const prior = asset.task_queue.confirmed;
    if (admitted.newer && (!prior || prior.process_generation !== asset.process_generation || BigInt(evidence.payload.queue_revision) >= BigInt(prior.revision))) {
      asset.task_queue.confirmed = { revision: evidence.payload.queue_revision, process_generation: asset.process_generation };
      changed = canonical(prior) !== canonical(asset.task_queue.confirmed);
    }
    if ('control_revision' in evidence.payload) {
      const control = evidence.payload.control_revision;
      const row = this.store.db.prepare('SELECT t.image FROM task_images t JOIN task_internal i ON t.id=i.id WHERE t.asset=? AND i.control_revision=?').get(asset.id, control);
      if (!row) refuse('control_not_confirmed');
      const task = Task.parse(JSON.parse(Image.parse(row).image));
      if (task.command === 'move_to' || task.execution_state !== 'completed' || evidence.payload.queue_state !== (task.command === 'pause' ? 'paused' : 'running')) refuse('control_not_confirmed');
      const old = asset.task_control.confirmed;
      if (admitted.newer && (!old || old.process_generation !== asset.process_generation || BigInt(control) >= BigInt(old.revision))) {
        asset.task_control.confirmed = { revision: control, task_id: task.task_id, process_generation: asset.process_generation, queue_state: evidence.payload.queue_state };
        changed ||= canonical(old) !== canonical(asset.task_control.confirmed);
      }
    }
    if (changed) { asset.version = next(asset.version); this.entities.saveAsset(tx, asset, true); }
    return { asset, evidence_disposition: 'accepted' as const };
  }
  assigned(tx: Transaction, request: RequestOf<'GetAssignedTasks'>): AssignedTasks {
    let context: z.infer<typeof AssignedContext>;
    let after = '', size: number, deadline: number;
    if ('page_token' in request) {
      const token = this.temporary.open(request.page_token, 'assigned', AssignedToken);
      context = token.context; after = token.after; size = token.size; deadline = token.deadline;
      if (performance.now() >= deadline) refuse('allocation_expired');
    } else {
      const asset = this.entities.asset(request.asset_id);
      if (asset.process_generation !== request.process_generation) refuse('generation_mismatch');
      size = request.page_size ?? 100; deadline = performance.now() + 60_000;
      const old = this.store.db.prepare('SELECT facts,image FROM task_instructions WHERE read_id=?').get(request.read_id);
      if (old) {
        const found = Instructions.parse(old);
        if (found.facts !== canonical(request)) refuse('identity_conflict');
        context = AssignedContext.parse(JSON.parse(found.image));
        const lifetime = z.object({ run: Uuid, deadline: z.number() }).parse(this.store.db.prepare('SELECT run,deadline FROM task_instruction_lifetime WHERE read_id=?').get(request.read_id));
        if (lifetime.run !== this.store.run || lifetime.deadline <= performance.now()) refuse('allocation_expired');
        deadline = lifetime.deadline;
      } else {
        const captured = now();
        context = { asset_id: asset.id, process_generation: asset.process_generation, read_id: request.read_id,
          core_run_id: this.store.run, captured_at: captured, instructions_valid_until: AssignedTasks.shape.instructions_valid_until.parse(new Date(Date.parse(captured) + 10_000).toISOString()),
          task_queue: asset.task_queue, task_control: asset.task_control };
        tx.retainedBytes = Buffer.byteLength(JSON.stringify(context));
        this.store.db.prepare('INSERT INTO task_instructions VALUES(?,?,?)').run(request.read_id, canonical(request), JSON.stringify(context));
        this.store.db.prepare('INSERT INTO task_instruction_lifetime VALUES(?,?,?)').run(request.read_id, this.store.run, deadline);
      }
    }
    const asset = this.entities.asset(context.asset_id);
    if (asset.process_generation !== context.process_generation) refuse('generation_mismatch');
    if (asset.task_queue.revision !== context.task_queue.revision || asset.task_control.revision !== context.task_control.revision) refuse('queue_changed');
    const tasks: Task[] = [];
    let bytes = Buffer.byteLength(JSON.stringify(context)) + 16384, more = false;
    for (const raw of this.store.db.prepare(`SELECT image FROM task_images WHERE id>? AND asset=? AND json_extract(image,'$.execution_state') NOT IN ('completed','failed','cancelled') ORDER BY id LIMIT ?`).iterate(after, asset.id, size + 1)) {
      const row = Image.parse(raw), length = Buffer.byteLength(row.image);
      if (tasks.length >= size || bytes + length > this.store.settings.limits.max_message_bytes - 16384) { more = true; break; }
      tasks.push(Task.parse(JSON.parse(row.image))); bytes += length;
    }
    if (tasks.length === 0 && more) refuse('resource_limit');
    return boundedPage(tasks, shortened => ({ ...context, tasks, next_page_token: more || shortened
      ? this.temporary.seal('assigned', { context, after: tasks.at(-1)?.task_id ?? after, size, deadline }) : null }), this.store.settings.limits, this.store.dataset);
  }
  guarded(feature: Uuid): boolean {
    return this.store.db.prepare(`SELECT id FROM task_images WHERE geofeature=? AND json_extract(image,'$.execution_state') NOT IN ('completed','failed','cancelled') LIMIT 1`).get(feature) !== undefined;
  }
  list(after: string, limit: number, asset?: Uuid): Task[] {
    const rows = asset === undefined
      ? this.store.db.prepare('SELECT image FROM task_images WHERE id>? ORDER BY id LIMIT ?').all(after, limit)
      : this.store.db.prepare(`SELECT image FROM task_images WHERE id>? AND asset=? AND json_extract(image,'$.execution_state') NOT IN ('completed','failed','cancelled') ORDER BY id LIMIT ?`).all(after, asset, limit);
    return rows.map(row => Task.parse(JSON.parse(Image.parse(row).image)));
  }
  *picture(source: Database.Database): Generator<Task> {
    for (const row of source.prepare('SELECT image FROM task_images ORDER BY id').iterate()) yield Task.parse(JSON.parse(Image.parse(row).image));
  }
  clearDataset(): void {
    this.store.db.exec('DELETE FROM task_images; DELETE FROM task_internal; DELETE FROM task_submission; DELETE FROM task_evidence; DELETE FROM task_adoption; DELETE FROM task_instructions; DELETE FROM task_instruction_lifetime; DELETE FROM task_terminal; DELETE FROM task_cancellation_retries');
  }
}
