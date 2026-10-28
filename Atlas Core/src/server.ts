import Fastify from 'fastify';
import type { FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import { readFile, statfs, opendir, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { ErrorObject, NewId, PROTOCOL_VERSION, ProtocolError, Secret, Uuid, commandCatalog, contract, correlation, exchanges, writeJson } from '@atlas/protocol';
import type { ExchangeName, RequestOf, ResponseOf } from '@atlas/protocol';
import { DatabaseWorker } from './rpc.js';
import { bindings } from './bindings.js';
import { Settings, defaults } from './settings.js';
import { digest, id } from './exact.js';
import { publicError, refuse, Refusal } from './fault.js';
import { Transfers } from './transfers.js';
import { ChangesConnection } from './sockets.js';
import { Diagnostics, faultFrames } from './diagnostics.js';
import type { Context } from './engine.js';
import { CaptureFile } from './temporary.js';
import { WriterIdentity } from './objects.js';
import { exited, ownedDirectory, removeCapture } from './ownership.js';

const ErrorBody = contract(z.strictObject({ dataset_id: Uuid, error: ErrorObject }), 'http_response');
export type ServerOptions = { directory: string; certificate: string; key: string; settings?: Settings; accountingRoot?: string; exitedLaunches?: readonly Uuid[] };
function headers(request: FastifyRequest): Headers {
  const result = new Headers();
  for (let i = 0; i < request.raw.rawHeaders.length; i += 2) {
    const key = request.raw.rawHeaders[i], value = request.raw.rawHeaders[i + 1];
    if (key !== undefined && value !== undefined) result.append(key, value);
  }
  return result;
}
function outgoing<T>(validate: () => T): T {
  try { return validate(); }
  catch (error) { throw new Error('outgoing_contract_fault', { cause: error }); }
}
export async function storageUsage(directory: string): Promise<{ bytes: number; free: number }> {
  let bytes = 0, count = 0;
  async function walk(path: string, depth: number): Promise<void> {
    if (depth > 8) throw new Refusal('resource_limit');
    const entries = await opendir(path);
    for await (const entry of entries) {
      if (++count > 100_000) throw new Refusal('resource_limit');
      const name = join(path, entry.name);
      if (entry.isSymbolicLink()) throw new Refusal('integrity_fault');
      if (entry.isDirectory()) await walk(name, depth + 1);
      else if (entry.isFile()) bytes += (await lstat(name)).size;
    }
  }
  await walk(directory, 0);
  const disk = await statfs(directory, { bigint: true });
  return { bytes, free: Number(disk.bavail * disk.bsize) };
}
export async function createCore(options: ServerOptions) {
  const cleanup: (() => Promise<void>)[] = [];
  try { return await initializeCore(options, cleanup); }
  catch (error) {
    const failures: unknown[] = [error];
    for (const close of cleanup.reverse()) { try { await close(); } catch (failure) { failures.push(failure); } }
    if (failures.length > 1) throw new AggregateError(failures, 'core_initialization_failed');
    throw error;
  }
}
async function initializeCore(options: ServerOptions, cleanup: (() => Promise<void>)[]) {
  const settings = Settings.parse(options.settings ?? defaults);
  const diagnostics = new Diagnostics(join(options.directory, 'logs'), settings.diagnosticBytes, settings.diagnosticLevel, async bytes => {
    const reservation = id();
    await rpc.call('reserve-diagnostics', { reservation, bytes }, 256);
    return async () => { await rpc.call('release-diagnostics', reservation, 128, true); };
  });
  const rpc = new DatabaseWorker(options.directory, settings, undefined, options.accountingRoot, () => diagnostics.emit({ severity: 'ERROR', component: 'database', event: 'worker_failed', evidence: 'unavailable' }));
  cleanup.push(() => rpc.close());
  cleanup.push(() => diagnostics.close());
  const ready = await rpc.ready;
  async function enrollmentWarning(): Promise<void> {
    const enrollment = z.object({ enabled: z.boolean(), bindings: z.array(z.unknown()).max(128) }).parse(await rpc.call('enrollment-inspect', {}, 65536, true));
    if (enrollment.enabled || enrollment.bindings.length > 0) diagnostics.emit({ severity: 'WARN', component: 'lifecycle', event: 'open_enrollment_warning', count: enrollment.bindings.length });
  }
  await enrollmentWarning();
  const exitedLaunches = new Set(options.exitedLaunches ?? []);
  const transfers = new Transfers(rpc, join(options.directory, 'objects'), settings, diagnostics, exitedLaunches);
  cleanup.push(() => transfers.close());
  await transfers.initialize();
  const captures = z.array(CaptureFile).max(4096).parse(await rpc.call('capture-files', {}, 1024, true));
  const captureDirectory = await ownedDirectory(join(options.directory, 'captures'));
  for (const capture of captures) {
    const owner = WriterIdentity.parse(JSON.parse(capture.owner));
    if (owner.launch !== undefined && exitedLaunches.has(owner.launch) || await exited(owner)) {
      await removeCapture(captureDirectory, capture.id);
      await rpc.call('capture-removed', capture.id, 128, true);
    }
  }
  const [cert, key] = await Promise.all([readFile(options.certificate), readFile(options.key)]);
  const app = Fastify({ https: { cert, key, minVersion: 'TLSv1.2' }, logger: false,
    exposeHeadRoutes: false,
    requestIdHeader: false, genReqId: () => id(), bodyLimit: settings.limits.max_request_bytes,
    requestTimeout: 0, connectionTimeout: 60_000, maxRequestsPerSocket: 1000,
    ajv: { customOptions: { coerceTypes: false, useDefaults: false, removeAdditional: false } } });
  cleanup.push(() => app.close());
  app.server.maxConnections = 256;
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer', bodyLimit: settings.limits.max_request_bytes }, (_request, body, done) => done(null, body));
  await app.register(multipart, { attachFieldsToBody: false, isPartAFile: () => true,
    limits: { files: 2, fields: 0, parts: 2, fileSize: Math.max(settings.limits.max_object_bytes, settings.limits.max_request_bytes), fieldNameSize: 64, headerPairs: 32 } });
  await app.register(websocket, { options: { maxPayload: settings.limits.max_control_bytes, perMessageDeflate: false, clientTracking: true } });
  const contexts = new WeakMap<FastifyRequest, Context>();
  const counted = new WeakSet<FastifyRequest>();
  const starts = new WeakMap<FastifyRequest, number>();
  const connections = new Set<ChangesConnection>();
  const reports = { accepted: 0, duplicate: 0, rejected: 0 };
  let inFlight = 0, stopped = false, closing: Promise<void> | undefined;
  function releaseRequest(request: FastifyRequest): void { if (counted.has(request)) { counted.delete(request); inFlight--; } }
  app.addHook('onRequest', async (request, reply) => {
    starts.set(request, performance.now());
    reply.raw.once('close', () => {
      releaseRequest(request);
      if (!reply.raw.writableFinished) diagnostics.emit({ severity: 'WARN', component: 'http', event: 'response_write_failed', request_id: NewId.parse(request.id), outcome: 'failed' });
    });
    reply.header('Atlas-Dataset-ID', ready.dataset).header('Atlas-Protocol-Version', PROTOCOL_VERSION).header('Atlas-Request-ID', request.id);
    const origin = request.headers.origin;
    if (origin !== undefined) {
      if (!settings.trustedOrigins.includes(origin)) refuse('invalid_request');
      reply.header('Access-Control-Allow-Origin', origin).header('Vary', 'Origin')
        .header('Access-Control-Allow-Headers', 'Authorization,Content-Type,Accept,Atlas-Dataset-ID,Atlas-Protocol-Version,Atlas-Attempt-ID')
        .header('Access-Control-Expose-Headers', 'Atlas-Dataset-ID,Atlas-Protocol-Version,Atlas-Request-ID,Atlas-Content-SHA256,Content-Length,Content-Disposition');
      if (request.method === 'OPTIONS') { reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS'); await reply.code(204).send(); return; }
    }
    if (stopped && request.routeOptions.url !== exchanges.GetHealth.path && request.routeOptions.url !== exchanges.GetReadiness.path) { await reply.code(503).send(); return; }
    if (request.routeOptions.url === '/changes') return;
    if (inFlight >= 64) refuse('resource_limit');
    inFlight++; counted.add(request);
    const incoming = headers(request);
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
    releaseRequest(request);
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
    if (!request.raw.readableEnded) reply.header('Connection', 'close');
    if (!rpc.available) { await reply.code(503).send(); return; }
    let fault: unknown = error;
    if (error instanceof Error && 'code' in error && typeof error.code === 'string') {
      if (error.code === 'FST_ERR_CTP_BODY_TOO_LARGE' || error.code.includes('FILE_TOO_LARGE')) fault = new Refusal('payload_too_large');
      else if (error.code.startsWith('FST_')) fault = new Refusal('invalid_request');
    }
    const response = publicError(fault, ready.dataset, NewId.parse(request.id));
    if (request.routeOptions.url === '/messages/update_asset' || request.routeOptions.url === '/messages/report_observation') reports.rejected++;
    if (response.status === 401) reply.header('WWW-Authenticate', 'Bearer');
    diagnostics.emit({ severity: response.status >= 500 ? 'ERROR' : 'DEBUG', component: 'http', event: 'request_refused', code: response.body.error.code, request_id: response.body.error.request_id,
      ...(response.status >= 500 ? faultFrames(error) : {}) });
    if (error instanceof AggregateError) for (const [index, cause] of error.errors.slice(0, 2).entries()) diagnostics.emit({ severity: 'ERROR', component: 'runtime', event: index === 0 ? 'primary_failure' : 'cleanup_failure', code: publicError(cause, ready.dataset).body.error.code, ...faultFrames(cause) });
    await reply.code(response.status).type('application/json').send(Buffer.from(writeJson(ErrorBody, response.body)));
  });
  app.setNotFoundHandler(() => { refuse('invalid_request'); });
  function contextFor(request: FastifyRequest): Context { const context = contexts.get(request); if (!context) refuse('unauthorized'); return context; }
  function record(request: FastifyRequest, name: ExchangeName, response: ResponseOf<ExchangeName>, execution: 'first' | 'replay' | 'read'): void {
    const report = name === 'ReportObservation' || name === 'UpdateAsset';
    if (response.kind !== 'success') return;
    if (report) { if ('evidence_disposition' in response.body.data && response.body.data.evidence_disposition === 'duplicate') reports.duplicate++; else reports.accepted++; }
    if (!report && execution === 'read') return;
    diagnostics.emit({ severity: report ? 'DEBUG' : 'INFO', component: 'http', event: 'operation_recorded', route: exchanges[name].path,
      request_id: NewId.parse(request.id), outcome: execution, ...(response.body.commit_cursor === undefined ? {} : { cursor: response.body.commit_cursor }) });
  }
  for (const name of Object.keys(exchanges)) {
    if (!isExchange(name)) throw new Error('unknown_exchange');
    const definition = exchanges[name];
    app.route({ method: definition.method, url: definition.path.replace('{object_id}', ':object_id'),
      handler: async (request, reply) => {
        const context = contextFor(request);
        const incoming = { method: request.method, path: request.raw.url ?? '', headers: headers(request) };
        if (definition.transport === 'upload') {
          const upload = await transfers.upload(request, context, bytes => bindings.UploadObject.request({ ...incoming, uploadDescriptor: bytes }));
          const result = upload.response;
          record(request, name, result, upload.execution);
          if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
          const bytes = outgoing(() => writeJson(contract(exchanges.UploadObject.success, 'http_response'), result.body));
          const responseHeaders = new Headers({ 'Atlas-Dataset-ID': ready.dataset, 'Atlas-Protocol-Version': PROTOCOL_VERSION, 'Content-Type': 'application/json' });
          outgoing(() => bindings.UploadObject.response({ status: 200, headers: responseHeaders, body: bytes }, { datasetId: ready.dataset, request: upload.request }));
          return reply.type('application/json').send(Buffer.from(bytes));
        }
        let input: RequestOf<ExchangeName>;
        try { input = bindings[name].request({ ...incoming, ...(Buffer.isBuffer(request.body) ? { body: request.body } : {}) }, {
          maxBytes: settings.limits.max_request_bytes, maxValues: settings.limits.max_request_json_values, maxDepth: settings.limits.max_json_depth }); }
        catch (error) {
          if (error instanceof ProtocolError && error.code === 'invalid_value' && Buffer.isBuffer(request.body)) {
            const fields = z.record(z.string(), z.unknown()).safeParse(JSON.parse(request.body.toString('utf8')));
            if (fields.success && name === 'CreateTask') {
              const command = fields.data.command;
              if (typeof command === 'string' && (!isCommand(command) || fields.data.scheduling !== commandCatalog[command].shape.scheduling.value)) refuse('unsupported_command');
            }
            if (fields.success && ('filters' in fields.data || name.endsWith('MovementHistory')) && error.issues.some(issue => issue.message === 'unrecognized_keys')) refuse('unsupported_filter');
          }
          throw error;
        }
        const exchange = await rpc.exchangeDetailed(name, input, context, Buffer.isBuffer(request.body) ? request.body.byteLength * 8 + 1024 : 1024);
        const result = exchange.response;
        record(request, name, result, exchange.execution);
        if (result.kind === 'error') throw new Refusal(result.body.error.code, result.body.error.details);
        const responseHeaders = new Headers({ 'Atlas-Dataset-ID': ready.dataset, 'Atlas-Protocol-Version': PROTOCOL_VERSION });
        if (result.kind === 'reference') {
          const media = incoming.headers.get('Accept');
          const document = media === 'text/html' ? '<!doctype html><html lang="en"><meta charset="utf-8"><title>Atlas Protocol</title><h1>Atlas Protocol 0.3.0</h1><p>The OpenAPI reference is available at this URL with Accept: application/vnd.oai.openapi+json.</p></html>' : result.document;
          const body = Buffer.from(document); responseHeaders.set('Content-Type', media ?? result.media);
          outgoing(() => bindings[name].response({ status: 200, headers: responseHeaders, body }, { request: input, datasetId: ready.dataset }));
          return reply.type(media ?? result.media).send(body);
        }
        if (result.kind === 'content') {
          const download = await transfers.download(result.descriptor.object_id, context);
          for (const [key, value] of Object.entries({ 'Content-Type': download.image.content_type, 'Content-Length': download.image.byte_length,
            'Atlas-Content-SHA256': download.image.sha256, 'Content-Disposition': result.descriptor.disposition })) { responseHeaders.set(key, value); reply.header(key, value); }
          outgoing(() => bindings[name].response({ status: 200, headers: responseHeaders }, { request: input, datasetId: ready.dataset }));
          return reply.send(download.stream);
        }
        if (definition.transport !== 'json') throw new Error('unexpected_exchange_result');
        const body = outgoing(() => writeJson(contract(definition.success, 'http_response'), result.body));
        responseHeaders.set('Content-Type', 'application/json');
        outgoing(() => bindings[name].response({ status: result.status, headers: responseHeaders, body }, { request: input, datasetId: ready.dataset }));
        return reply.code(result.status).type('application/json').send(Buffer.from(body));
      } });
  }
  app.options('/*', async (_request, reply) => reply.code(204).send());
  app.get('/changes', { websocket: true }, socket => {
    if (connections.size >= settings.maxConnections) { socket.close(1013); return; }
    const connection = new ChangesConnection(socket, rpc, ready.dataset, ready.run, settings, diagnostics, () => connections.delete(connection));
    connections.add(connection);
  });
  let tick: Promise<void> | undefined, summaryWork: Promise<void> | undefined;
  function backgroundFailed(error: unknown): void {
    diagnostics.emit({ severity: 'ERROR', event: 'background_failure', component: 'runtime', code: publicError(error, ready.dataset).body.error.code, ...faultFrames(error) });
    if (error instanceof AggregateError) for (const cause of error.errors.slice(1, 3)) {
      diagnostics.emit({ severity: 'ERROR', event: 'background_cleanup_failure', component: 'runtime', code: publicError(cause, ready.dataset).body.error.code, ...faultFrames(cause) });
    }
  }
  const summary = setInterval(() => {
    if (summaryWork !== undefined || stopped) return;
    for (const outcome of ['accepted', 'duplicate', 'rejected'] as const) {
      if (reports[outcome] > 0) diagnostics.emit({ severity: 'INFO', component: 'http', event: 'report_summary', outcome, count: reports[outcome] });
      reports[outcome] = 0;
    }
    summaryWork = (async () => {
      await enrollmentWarning();
      if (stopped) return;
      const value = await rpc.call('inspect', {}, 4096, true);
      const { metrics } = z.object({ metrics: z.object({ transactions: z.number(), commit_ms: z.number(), transaction_ms: z.number(), ipc_wait_ms: z.number(),
        wal_bytes: z.number(), checkpoint_ms: z.number(), contact_refreshes: z.number(), capture_builds: z.number(), capture_failures: z.number(), capture_releases: z.number(), capture_expiries: z.number(), captured_bytes: z.number() }) }).parse(value);
      diagnostics.emit({ severity: 'INFO', component: 'database', event: 'database_summary', count: metrics.transactions, duration_ms: metrics.commit_ms, transaction_ms: metrics.transaction_ms, writer_wait_ms: metrics.ipc_wait_ms });
      diagnostics.emit({ severity: 'INFO', component: 'database', event: 'checkpoint_summary', bytes: metrics.wal_bytes, duration_ms: metrics.checkpoint_ms });
      if (metrics.contact_refreshes > 0) diagnostics.emit({ severity: 'INFO', component: 'http', event: 'fresh_contact_summary', count: metrics.contact_refreshes });
      if (metrics.capture_builds > 0 || metrics.capture_failures > 0) {
        diagnostics.emit({ severity: 'INFO', component: 'synchronization', event: 'capture_summary', count: metrics.capture_builds, bytes: metrics.captured_bytes });
        diagnostics.emit({ severity: 'INFO', component: 'synchronization', event: 'capture_failure_summary', count: metrics.capture_failures });
        diagnostics.emit({ severity: 'INFO', component: 'synchronization', event: 'capture_release_summary', count: metrics.capture_releases });
        diagnostics.emit({ severity: 'INFO', component: 'synchronization', event: 'capture_expiry_summary', count: metrics.capture_expiries });
      }
    })();
    void summaryWork.then(() => { summaryWork = undefined; }, error => { summaryWork = undefined; backgroundFailed(error); });
  }, 30_000);
  const timer = setInterval(() => {
    if (tick !== undefined || stopped) return;
    tick = (async () => {
      await transfers.recheck();
      if (stopped || !rpc.available) return;
      const usage = await storageUsage(options.accountingRoot ?? options.directory);
      if (stopped) return;
      await rpc.call('pressure', usage.bytes + settings.reserveBytes >= settings.storageBytes || usage.free < settings.freeDiskBytes, 128, true);
      if (stopped) return;
      const failures: unknown[] = [];
      try { await rpc.call('tick', {}, 0, true); } catch (error) { failures.push(error); }
      if (!stopped && rpc.available) {
        try { await transfers.reclaimDeleted(); } catch (error) { failures.push(error); }
      }
      if (failures.length === 1) throw failures[0];
      if (failures.length > 1) throw new AggregateError(failures, 'maintenance_failed');
    })();
    void tick.then(() => { tick = undefined; }, error => { tick = undefined; backgroundFailed(error); });
  }, 250);
  async function close(): Promise<void> {
    if (closing) return closing;
    stopped = true; clearInterval(timer); clearInterval(summary);
    const maintenance = [tick, summaryWork];
    closing = (async () => {
      const failures: unknown[] = [];
      async function finish(action: () => Promise<unknown>): Promise<void> { try { await action(); } catch (error) { failures.push(error); } }
      if (rpc.available) await finish(() => rpc.call('drain', {}, 0, true));
      for (const connection of connections) connection.close();
      for (const work of maintenance) if (work !== undefined) await finish(() => work);
      await finish(() => transfers.close());
      await finish(() => app.close());
      diagnostics.emit({ severity: failures.length === 0 ? 'INFO' : 'ERROR', component: 'lifecycle', event: failures.length === 0 ? 'core_stopping' : 'core_stop_failed', dataset: ready.dataset, run: ready.run });
      await finish(() => diagnostics.close());
      await finish(() => rpc.close());
      if (failures.length > 0) throw new AggregateError(failures, 'core_shutdown_failed');
    })();
    return closing;
  }
  return { app, rpc, close, dataset: ready.dataset, run: ready.run, diagnostics,
    async listen() { return app.listen({ host: settings.host, port: settings.port }); } };
}
function isExchange(value: string): value is ExchangeName { return Object.hasOwn(exchanges, value); }
function isCommand(value: string): value is keyof typeof commandCatalog { return Object.hasOwn(commandCatalog, value); }
