import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { readFile, statfs, readdir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorObject, NewId, PROTOCOL_VERSION, Secret, Uuid, contract, correlation, exchanges, writeJson } from '@atlas/protocol';
import type { ExchangeName } from '@atlas/protocol';
import { DatabaseWorker } from './rpc.js';
import { bindings } from './bindings.js';
import { Settings, defaults } from './settings.js';
import { digest, id } from './exact.js';
import { publicError, refuse, Refusal } from './fault.js';
import { Transfers } from './transfers.js';
import { ChangesConnection } from './sockets.js';
import { Diagnostics, faultFrames } from './diagnostics.js';
import type { Context } from './engine.js';

const ErrorBody = contract(z.strictObject({ dataset_id: Uuid, error: ErrorObject }), 'http_response');
export type ServerOptions = { directory: string; certificate: string; key: string; settings?: Settings };
function headers(request: FastifyRequest): Headers {
  const result = new Headers();
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    const key = request.raw.rawHeaders[i], value = request.raw.rawHeaders[i + 1];
    if (key !== undefined && value !== undefined) result.append(key, value);
  }
  return result;
}
export async function storageUsage(directory: string): Promise<{ bytes: number; free: number }> {
  let bytes = 0, count = 0;
  async function walk(path: string): Promise<void> {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      if (++count > 100_000) throw new Refusal('resource_limit');
      const name = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Refusal('integrity_fault');
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) bytes += (await lstat(name)).size;
    }
  }
  await walk(directory);
  const disk = await statfs(directory, { bigint: true });
  return { bytes, free: Number(disk.bavail * disk.bsize) };
}
export async function createCore(options: ServerOptions) {
  const settings = Settings.parse(options.settings ?? defaults);
  const rpc = new DatabaseWorker(options.directory, settings);
  const ready = await rpc.ready;
  const diagnostics = new Diagnostics(join(options.directory, 'logs'), settings.diagnosticBytes, settings.diagnosticLevel);
  const transfers = new Transfers(rpc, join(options.directory, 'objects'), settings);
  await transfers.initialize();
  const [cert, key] = await Promise.all([readFile(options.certificate), readFile(options.key)]);
  const app = Fastify({ https: { cert, key, minVersion: 'TLSv1.2' }, logger: false,
    requestIdHeader: false, genReqId: () => id(), bodyLimit: settings.limits.max_request_bytes,
    requestTimeout: 60_000, connectionTimeout: 15_000, maxRequestsPerSocket: 1000,
    ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } } });
  app.server.maxConnections = 256;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: settings.limits.max_request_bytes }, (_request, body, done) => done(null, body));
  await app.register(multipart, { attachFieldsToBody: false, isPartAFile: () => true,
    limits: { files: 2, fields: 0, parts: 2, fileSize: settings.limits.max_object_bytes, fieldNameSize: 64, headerPairs: 32 } });
  await app.register(websocket, { options: { maxPayload: settings.limits.max_control_bytes, perMessageDeflate: false, clientTracking: true } });
  const contexts = new WeakMap<FastifyRequest, Context>();
  const starts = new WeakMap<FastifyRequest, number>();
  const connections = new Set<ChangesConnection>();
  let inFlight = 0, stopped = false, closing: Promise<void> | undefined;
  app.addHook('onRequest', async (request, reply) => {
    starts.set(request, performance.now());
    reply.header('Atlas-Dataset-ID', ready.dataset).header('Atlas-Protocol-Version', PROTOCOL_VERSION).header('Atlas-Request-ID', request.id);
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!settings.trustedOrigins.includes(origin)) refuse('invalid_request');
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,Atlas-Dataset-ID,Atlas-Protocol-Version,Atlas-Attempt-ID')
        .header('Access-Control-Expose-Headers', 'Atlas-Dataset-ID,Atlas-Protocol-Version,Atlas-Request-ID,Atlas-Content-SHA256,Content-Length,Content-Disposition');
      if (request.method === 'OPTIONS') { reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); await reply.code(204).send(); return; }
    }
    if (stopped) { await reply.code(503).send(); return; }
    if (++inFlight > 64) { inFlight--; refuse('resource_limit'); }
    const incoming = headers(request);
    if (request.routeOptions.url === '/changes') return;
    const auth = incoming.get('Authorization');
    if (auth === null || !auth.startsWith('Bearer ')) refuse('unauthorized');
    const secret = Secret.safeParse(auth.slice(7));
    if (!secret.success) refuse('unauthorized');
    const context: Context = { verifier: digest(secret.data),
      ...(incoming.has('Atlas-Dataset-ID') ? { dataset: incoming.get('Atlas-Dataset-ID') ?? '' } : {}),
      ...(incoming.has('Atlas-Protocol-Version') ? { protocol: incoming.get('Atlas-Protocol-Version') ?? '' } : {}) };
    await rpc.call('authorize', { context, discovery: request.routeOptions.url === '/health' }, 512, true);
    contexts.set(request, context);
  });
  app.addHook('onResponse', async (request, reply) => {
    inFlight = Math.max(0, inFlight - 1);
    const route = request.routeOptions.url;
    const definition = Object.values(exchanges).find(binding => binding.path.replace('{object_id}', ':object_id') === route);
    if (!definition) return;
    const report = definition.operationId === 'ReportObservation' || definition.operationId === 'UpdateAsset';
    const requestId = NewId.safeParse(request.id);
    const attempt = correlation(headers(request)).attemptId;
    diagnostics.emit({ severity: report ? 'DEBUG' : 'INFO', component: 'http', event: 'request_completed', route: definition.path,
      dataset: ready.dataset, run: ready.run, ...(requestId.success ? { request_id: requestId.data } : {}), ...(attempt === undefined ? {} : { attempt_id: attempt }),
      duration_ms: Math.max(0, performance.now() - (starts.get(request) ?? performance.now())), count: reply.statusCode });
  });
  app.setErrorHandler(async (error, request, reply) => {
    if (!rpc.available) { await reply.code(503).send(); return; }
    let fault: unknown = error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.code.includes('FILE_TOO_LARGE')) fault = new Refusal('payload_too_large');
      else if (error.code.startsWith('FST_')) fault = new Refusal('invalid_request');
    }
    const response = publicError(fault, ready.dataset, NewId.parse(request.id));
    if (response.status === 401) reply.header('WWW-Authenticate', 'Bearer');
    diagnostics.emit({ severity: response.status >= 500 ? 'ERROR' : 'DEBUG', component: 'http', event: 'request_refused', code: response.body.error.code, request_id: response.body.error.request_id,
      ...(response.status >= 500 ? faultFrames(error) : {}) });
    await reply.code(response.status).type('application/json').send(Buffer.from(writeJson(ErrorBody, response.body)));
  });
  function contextFor(request: FastifyRequest): Context { const context = contexts.get(request); if (!context) refuse('unauthorized'); return context; }
  for (const name of Object.keys(exchanges)) {
    if (!isExchange(name)) throw new Error('unknown_exchange');
    const definition = exchanges[name];
    app.route({ method: definition.method, url: definition.path.replace('{object_id}', ':object_id'),
      handler: async (request, reply) => {
        const context = contextFor(request);
        const incoming = { method: request.method, path: request.raw.url ?? '', headers: headers(request) };
        if (definition.transport === 'upload') {
          const result = await transfers.upload(request, context, bytes => bindings.UploadObject.request({ ...incoming, uploadDescriptor: bytes }));
          if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
          const bytes = writeJson(contract(exchanges.UploadObject.success, 'http_response'), result.body);
          const responseHeaders = new Headers({ 'Atlas-Dataset-ID': ready.dataset, 'Atlas-Protocol-Version': PROTOCOL_VERSION, 'Content-Type': 'application/json' });
          bindings.UploadObject.response({ status: 200, headers: responseHeaders, body: bytes }, { datasetId: ready.dataset });
          return reply.type('application/json').send(Buffer.from(bytes));
        }
        const input = bindings[name].request({ ...incoming, ...(Buffer.isBuffer(request.body) ? { body: request.body } : {}) }, {
          maxBytes: settings.limits.max_request_bytes, maxValues: settings.limits.max_request_json_values, maxDepth: settings.limits.max_json_depth });
        const result = await rpc.exchange(name, input, context, (Buffer.isBuffer(request.body) ? request.body.byteLength * 8 : 1024) + settings.limits.max_message_bytes);
        if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
        const responseHeaders = new Headers({ 'Atlas-Dataset-ID': ready.dataset, 'Atlas-Protocol-Version': PROTOCOL_VERSION });
        if (result.kind === 'reference') {
          const media = incoming.headers.get('Accept');
          const document = media === 'text/html' ? '<!doctype html><html lang="en"><meta charset="utf-8"><title>Atlas Protocol</title><h1>Atlas Protocol 0.1.0</h1><p>The OpenAPI reference is available at this URL with Accept: application/vnd.oai.openapi+json.</p></html>' : result.document;
          const body = Buffer.from(document); responseHeaders.set('Content-Type', media ?? result.media);
          bindings[name].response({ status: 200, headers: responseHeaders, body }, { request: input, datasetId: ready.dataset });
          return reply.type(media ?? result.media).send(body);
        }
        if (result.kind === 'content') {
          const download = await transfers.download(result.descriptor.object_id, context);
          for (const [key, value] of Object.entries({ 'Content-Type': download.image.content_type, 'Content-Length': download.image.byte_length,
            'Atlas-Content-SHA256': download.image.sha256, 'Content-Disposition': result.descriptor.disposition })) { responseHeaders.set(key, value); reply.header(key, value); }
          bindings[name].response({ status: 200, headers: responseHeaders }, { request: input, datasetId: ready.dataset });
          return reply.send(download.stream);
        }
        if (definition.transport !== 'json') throw new Error('unexpected_exchange_result');
        const body = writeJson(contract(definition.success, 'http_response'), result.body);
        responseHeaders.set('Content-Type', 'application/json');
        bindings[name].response({ status: result.status, headers: responseHeaders, body }, { request: input, datasetId: ready.dataset });
        return reply.code(result.status).type('application/json').send(Buffer.from(body));
      } });
  }
  app.options('/*', async (_request, reply) => reply.code(204).send());
  app.get('/changes', { websocket: true }, socket => {
    if (connections.size >= settings.maxConnections) { socket.close(1013); return; }
    const connection = new ChangesConnection(socket, rpc, ready.dataset, ready.run, settings, () => connections.delete(connection));
    connections.add(connection);
  });
  let tickBusy = false;
  const timer = setInterval(() => {
    if (tickBusy || stopped || !rpc.available) return;
    tickBusy = true;
    void (async () => {
      const usage = await storageUsage(options.directory);
      await rpc.call('pressure', usage.bytes + settings.reserveBytes >= settings.storageBytes || usage.free < settings.freeDiskBytes, 128, true);
      await rpc.call('tick', {}, 0, true);
    })().catch(error => diagnostics.emit({ severity: 'ERROR', event: 'background_failure', component: 'runtime', ...faultFrames(error) })).finally(() => { tickBusy = false; });
  }, 250);
  async function close(): Promise<void> {
    if (closing) return closing;
    stopped = true; clearInterval(timer);
    closing = (async () => {
      if (rpc.available) await rpc.call('drain', {}, 0, true);
      for (const connection of connections) connection.close();
      await transfers.close();
      await app.close();
      await rpc.close();
      diagnostics.emit({ severity: 'INFO', component: 'lifecycle', event: 'core_stopped', dataset: ready.dataset, run: ready.run });
      await diagnostics.close();
    })();
    return closing;
  }
  return { app, rpc, close, dataset: ready.dataset, run: ready.run, diagnostics,
    async listen() { return app.listen({ host: settings.host, port: settings.port }); } };
}
function isExchange(value: string): value is ExchangeName { return Object.hasOwn(exchanges, value); }
