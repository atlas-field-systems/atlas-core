import { parentPort, workerData } from 'node:worker_threads';
import { z } from 'zod';
import { SubscribeChanges, Uuid, UploadDescriptor, exchanges } from '@atlas/protocol';
import { Context, Engine, isPublicOperation } from './engine.js';
import { Settings } from './settings.js';
import { WriterIdentity } from './objects.js';
import { publicError, refuse } from './fault.js';

const port = parentPort;
if (port === null) throw new Error('worker_requires_parent');
const setup = z.object({ directory: z.string(), settings: Settings, establish: z.object({ dataset: Uuid, actionId: Uuid }).optional() }).parse(workerData);
const engine = new Engine(setup.directory, setup.settings, setup.establish);
port.postMessage({ type: 'ready', dataset: engine.store.dataset, run: engine.store.run, engine: engine.store.engine() });
const Message = z.strictObject({ id: z.number().int().positive(), kind: z.string(), data: z.unknown() });
const active = new Set<Promise<void>>();
async function execute(raw: unknown): Promise<void> {
  const message = Message.parse(raw);
  try {
    let result: unknown;
    switch (message.kind) {
      case 'exchange': {
        const data = z.strictObject({ operation: z.unknown(), context: Context }).parse(message.data);
        if (!isPublicOperation(data.operation)) refuse('invalid_request');
        result = await engine.execute(data.operation, data.context); break;
      }
      case 'authorize': {
        const data = z.object({ context: Context, discovery: z.boolean() }).parse(message.data);
        result = engine.authorize(data.context, data.discovery); break;
      }
      case 'provision': engine.provision(exchanges.CreateApiKey.request.schema.parse(message.data)); result = {}; break;
      case 'tick': await engine.tick(); result = {}; break;
      case 'prepare-upload': {
        const data = z.object({ context: Context, descriptor: UploadDescriptor.optional(), attempt: Uuid, owner: WriterIdentity }).parse(message.data);
        const authority = engine.authorize(data.context);
        result = engine.store.db.transaction(() => engine.objects.prepare(data.descriptor, data.attempt, data.owner, authority.keyId))(); break;
      }
      case 'describe-upload': { const data = z.object({ context: Context, attempt: Uuid, descriptor: UploadDescriptor }).parse(message.data); engine.authorize(data.context); engine.objects.describe(data.attempt, data.descriptor); result = {}; break; }
      case 'reserve-upload': { const data = z.object({ context: Context, attempt: Uuid, bytes: z.number().int().nonnegative() }).parse(message.data); engine.authorize(data.context); engine.objects.reserve(data.attempt, data.bytes); result = {}; break; }
      case 'attempt': result = engine.objects.attempt(Uuid.parse(message.data)); break;
      case 'installed': engine.objects.installed(Uuid.parse(message.data)); result = {}; break;
      case 'abandon': engine.objects.abandon(Uuid.parse(message.data)); result = {}; break;
      case 'reclaim': engine.objects.reclaim(Uuid.parse(message.data)); result = {}; break;
      case 'attempts': result = engine.objects.attempts(); break;
      case 'file': {
        const data = z.object({ context: Context, object: Uuid }).parse(message.data); engine.authorize(data.context);
        result = engine.objects.file(data.object); break;
      }
      case 'integrity': { const data = z.object({ object: Uuid, fault: z.boolean() }).parse(message.data); engine.objects.integrity(data.object, data.fault); result = {}; break; }
      case 'inspect': result = { ...engine.store.engine(), state: engine.state, pressure: engine.pressure }; break;
      case 'subscribe': {
        const data = z.object({ context: Context, request: SubscribeChanges }).parse(message.data); engine.authorize(data.context);
        engine.store.parseCursor(data.request.from_cursor);
        result = { subscription_id: data.request.subscription_id, handoff_cursor: engine.store.cursor(), limits: engine.reads.negotiate(data.request) }; break;
      }
      case 'feed': {
        const data = z.object({ context: Context, from: z.string(), boundary: z.string().nullable() }).parse(message.data); engine.authorize(data.context);
        const boundary = data.boundary ?? engine.store.cursor();
        const messages = engine.store.messages(data.from, boundary, 1);
        result = { through: boundary, messages, earliest: engine.store.earliest() }; break;
      }
      case 'drain': engine.state = 'draining'; result = {}; break;
      case 'pressure': engine.pressure = z.boolean().parse(message.data); result = {}; break;
      case 'close':
        await Promise.allSettled([...active]); await engine.close(); result = {};
        port?.postMessage({ type: 'reply', id: message.id, value: result }); port?.close(); return;
      default: throw new Error('unknown_worker_operation');
    }
    port?.postMessage({ type: 'reply', id: message.id, value: result });
  } catch (error) { port?.postMessage({ type: 'refusal', id: message.id, error: publicError(error, engine.store.dataset) }); }
}
port.on('message', (raw: unknown) => {
  const work = execute(raw);
  active.add(work); void work.finally(() => active.delete(work));
});
