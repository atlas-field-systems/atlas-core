import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { SubscribeChanges, Uuid, UploadDescriptor, exchanges } from '@atlas/protocol';
import { Context, Engine, isPublicOperation } from './engine.js';
import { Settings } from './settings.js';
import { WriterIdentity } from './objects.js';
import { workerFailure, refuse } from './fault.js';

const port = parentPort;
if (port === null) throw new Error('worker_requires_parent');
const setup = z.object({ directory: z.string(), accountingRoot: z.string(), settings: Settings, establish: z.object({ dataset: Uuid, actionId: Uuid }).optional() }).parse(workerData);
const engine = new Engine(setup.directory, setup.settings, setup.establish, setup.accountingRoot);
port.postMessage({ type: 'ready', dataset: engine.store.dataset, run: engine.store.run, engine: engine.store.engine() });
const Message = z.strictObject({ id: z.number().int().positive(), kind: z.string(), data: z.unknown(), reserved: z.boolean(), enqueuedAtNs: z.bigint().nonnegative() });
const Received = z.strictObject({ type: z.literal('received'), id: z.number().int().positive() });
const active = new Map<number, Promise<void>>();
const replies = new Map<number, number>();
const waitingResponses: { id: number; reserved: boolean; bytes: number; resolve: () => void }[] = [];
const charge = (bytes: number): number => bytes * 8 + 1024;
const pageBytes = charge(setup.settings.limits.max_message_bytes);
const responseBytes = Math.max(setup.settings.workerQueueBytes, pageBytes * 4);
const reservedCount = Math.min(4, Math.max(1, Math.floor(setup.settings.workerQueueCount / 4)));
let usedResponseBytes = 0;
function admitResponses(): void {
  for (let i = 0; i < waitingResponses.length;) {
    const next = waitingResponses[i];
    if (next === undefined) break;
    const count = setup.settings.workerQueueCount - (next.reserved ? 0 : reservedCount);
    const bytes = responseBytes - (next.reserved ? 0 : pageBytes);
    if (replies.size >= count || usedResponseBytes + next.bytes > bytes) { i++; continue; }
    waitingResponses.splice(i, 1);
    replies.set(next.id, next.bytes); usedResponseBytes += next.bytes;
    next.resolve();
  }
}
async function responsePermit(id: number, reserved: boolean, bytes: number): Promise<void> {
  if (replies.has(id)) return;
  await new Promise<void>(resolve => { waitingResponses.push({ id, reserved, bytes: charge(bytes), resolve }); admitResponses(); });
}
function releaseResponse(id: number): void {
  const bytes = replies.get(id);
  if (bytes === undefined) return;
  replies.delete(id); usedResponseBytes -= bytes;
  admitResponses();
}
function finishResponse(id: number, bytes: number): void {
  const permit = replies.get(id);
  if (permit === undefined || charge(bytes) > permit) throw new Error('worker_response_exceeds_permit');
  replies.set(id, charge(bytes)); usedResponseBytes -= permit - charge(bytes); admitResponses();
}
const smallReplies = new Set(['authorize', 'provision', 'open-enroll', 'enrollment-revoke', 'tick', 'describe-upload', 'reserve-upload', 'upload-written',
  'file-reclaimed', 'installed', 'abandon', 'reclaim', 'capture-removed', 'integrity', 'subscribe', 'drain', 'pressure', 'applied-settings', 'close']);
const preparesAfterWait = new Set(['exchange', 'close', 'tick', 'open-enroll', 'prepare-upload', 'describe-upload', 'reserve-upload']);
async function execute(raw: unknown): Promise<void> {
  const message = Message.parse(raw);
  const maximum = smallReplies.has(message.kind) ? 4096 : setup.settings.limits.max_message_bytes;
  const produce = (bytes = maximum) => responsePermit(message.id, message.reserved, bytes);
  const release = () => releaseResponse(message.id);
  engine.store.metrics.ipc_wait_ms += Math.max(0, Number(process.hrtime.bigint() - message.enqueuedAtNs) / 1_000_000);
  try {
    if (!preparesAfterWait.has(message.kind)) await produce();
    let result: unknown;
    switch (message.kind) {
      case 'exchange': {
        const data = z.strictObject({ operation: z.unknown(), context: Context }).parse(message.data);
        if (!isPublicOperation(data.operation)) refuse('invalid_request');
        let execution: 'first' | 'replay' | 'read' = 'read';
        const response = await engine.execute(data.operation, data.context, outcome => { execution = outcome; }, produce, release);
        result = { response, execution }; break;
      }
      case 'authorize': {
        const data = z.object({ context: Context, discovery: z.boolean() }).parse(message.data);
        result = engine.authorize(data.context, data.discovery); break;
      }
      case 'provision': engine.provision(exchanges.CreateApiKey.request.schema.parse(message.data)); result = {}; break;
      case 'enrollment-inspect': result = { enabled: engine.settings.openEnrollment, bindings: engine.identity.openBindings() }; break;
      case 'open-enroll': {
        const data = z.object({ dataset: Uuid, request: exchanges.RegisterAsset.request.schema }).parse(message.data);
        if (!engine.settings.openEnrollment) refuse('unauthorized');
        if (data.dataset !== engine.store.dataset) refuse('dataset_mismatch');
        if (engine.identity.openBinding(data.request.api_key_id) === null) refuse('identity_conflict');
        result = await engine.reserveStorage(admit => {
          if (!engine.settings.openEnrollment) refuse('unauthorized');
          if (data.dataset !== engine.store.dataset) refuse('dataset_mismatch');
          if (engine.identity.openBinding(data.request.api_key_id) === null) refuse('identity_conflict');
          admit(1_048_576);
          const outcome = engine.store.transact(null, tx => {
            const registration = engine.entities.register(tx, data.request);
            return { asset_id: registration.asset.id, api_key_id: registration.api_key.api_key_id, binding_id: engine.identity.markOpen(registration.api_key.api_key_id) };
          });
          return { ...outcome.data, commit_cursor: outcome.cursor };
        }, produce, release); break;
      }
      case 'enrollment-revoke': {
        const data = z.object({ binding: Uuid, key: Uuid, confirm: z.literal(true) }).parse(message.data);
        engine.store.transact(null, tx => engine.identity.revokeOpen(tx, data.binding, data.key)); result = { revoked: true }; break;
      }
      case 'tick': await engine.tick(); result = {}; break;
      case 'prepare-upload': {
        const data = z.object({ context: Context, descriptor: UploadDescriptor.optional(), attempt: Uuid, owner: WriterIdentity }).parse(message.data);
        engine.authorize(data.context);
        result = await engine.reserveStorage(admit => {
          const authority = engine.authorize(data.context);
          return engine.store.db.transaction(() => engine.objects.prepare(data.descriptor, data.attempt, data.owner, authority.keyId, admit))();
        }, produce, release); break;
      }
      case 'describe-upload': {
        const data = z.object({ context: Context, attempt: Uuid, descriptor: UploadDescriptor }).parse(message.data);
        engine.authorize(data.context);
        await engine.reserveStorage(admit => {
          engine.authorize(data.context);
          engine.objects.describe(data.attempt, data.descriptor, admit);
        }, produce, release); result = {}; break;
      }
      case 'reserve-upload': {
        const data = z.object({ context: Context, attempt: Uuid, bytes: z.number().int().nonnegative(), written: z.number().int().nonnegative() }).parse(message.data);
        engine.authorize(data.context); engine.objects.progress(data.attempt, data.written);
        await engine.reserveStorage(admit => {
          engine.authorize(data.context);
          engine.objects.reserve(data.attempt, data.bytes, admit);
        }, produce, release); result = {}; break;
      }
      case 'upload-written': { const data = z.object({ attempt: Uuid, written: z.number().int().nonnegative() }).parse(message.data); engine.objects.progress(data.attempt, data.written); result = {}; break; }
      case 'attempt': result = engine.objects.attempt(Uuid.parse(message.data)); break;
      case 'retired-files': result = engine.objects.retired(); break;
      case 'file-reclaimed': engine.objects.reclaimed(Uuid.parse(message.data)); result = {}; break;
      case 'installed': engine.objects.installed(Uuid.parse(message.data)); result = {}; break;
      case 'abandon': engine.objects.abandon(Uuid.parse(message.data)); result = {}; break;
      case 'reclaim': engine.objects.reclaim(Uuid.parse(message.data)); result = {}; break;
      case 'attempts': { const data = z.object({ after: Uuid.optional() }).parse(message.data); result = engine.objects.attempts(data.after); break; }
      case 'capture-files': result = engine.temporary.captureFiles(); break;
      case 'file-owners': {
        const captures = engine.temporary.captureFiles().flatMap(record => { const owner = WriterIdentity.parse(JSON.parse(record.owner)); return owner.launch === undefined ? [] : [owner.launch]; });
        result = [...new Set([...engine.objects.writerLaunches(), ...captures])]; break;
      }
      case 'capture-removed': engine.temporary.fileRemoved(Uuid.parse(message.data)); result = {}; break;
      case 'file': {
        const data = z.object({ context: Context, object: Uuid }).parse(message.data); engine.authorize(data.context);
        result = engine.objects.file(data.object); break;
      }
      case 'integrity': { const data = z.object({ object: Uuid, fault: z.boolean() }).parse(message.data); engine.objects.integrity(data.object, data.fault); result = {}; break; }
      case 'inspect': result = { ...engine.store.engine(), state: engine.state, pressure: engine.pressure, metrics: engine.store.metrics }; break;
      case 'subscribe': {
        const data = z.object({ context: Context, request: SubscribeChanges }).parse(message.data); engine.authorize(data.context);
        engine.store.parseCursor(data.request.from_cursor);
        result = { subscription_id: data.request.subscription_id, handoff_cursor: engine.store.cursor(), limits: engine.reads.negotiate(data.request) }; break;
      }
      case 'feed': {
        const data = z.object({ context: Context, from: z.string(), boundary: z.string().nullable() }).parse(message.data); engine.authorize(data.context);
        const boundary = data.boundary ?? engine.store.cursor();
        result = engine.reads.feed(data.from, boundary); break;
      }
      case 'drain': engine.state = 'draining'; result = {}; break;
      case 'pressure': engine.pressure = z.boolean().parse(message.data); result = {}; break;
      case 'applied-settings': {
        const revision = z.object({ revision: z.string() }).parse(message.data).revision;
        if (engine.store.meta('settings_revision') !== revision) engine.store.transact(null, tx => { engine.identity.activity(tx, 'configuration', 'Local administrator applied settings'); engine.store.setMeta('settings_revision', revision); });
        result = {}; break;
      }
      case 'close':
        await Promise.allSettled([...active].filter(([id]) => id !== message.id).map(([, work]) => work));
        await engine.close(); result = {};
        await produce();
        port?.postMessage({ type: 'reply', id: message.id, value: result }); port?.close(); return;
      default: throw new Error('unknown_worker_operation');
    }
    await produce();
    const bytes = Buffer.byteLength(JSON.stringify(result));
    if (bytes > maximum) refuse('resource_limit');
    finishResponse(message.id, bytes);
    port?.postMessage({ type: 'reply', id: message.id, value: result });
  } catch (error) {
    await produce(4096);
    const failure = workerFailure(error, engine.store.dataset);
    finishResponse(message.id, Buffer.byteLength(JSON.stringify(failure)));
    port?.postMessage({ type: 'refusal', id: message.id, ...failure });
  }
}
port.on('message', (raw: unknown) => {
  const acknowledgement = Received.safeParse(raw);
  if (acknowledgement.success) { if (!replies.has(acknowledgement.data.id)) throw new Error('unknown_worker_reply'); releaseResponse(acknowledgement.data.id); return; }
  const message = Message.parse(raw);
  const work = execute(raw);
  active.set(message.id, work); void work.finally(() => active.delete(message.id));
});
