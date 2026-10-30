import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, request } from 'node:https';
import { randomUUID, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';
import { createCore } from '../../Atlas Core/dist/server.js';
import { defaults } from '../../Atlas Core/dist/settings.js';
import { mutableRoot } from '../../Atlas Core/test/paths.mjs';
const { createClient } = await import(process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js');
const { WebSocket, WebSocketServer } = createRequire(
  new URL('../../Atlas Core/package.json', import.meta.url),
)('ws');

export const uuid = () => randomUUID();
export const secret = () => randomBytes(32).toString('base64url');
export const registration = (alias) => ({
  asset_id: uuid(),
  registration_id: uuid(),
  request_id: uuid(),
  process_generation: uuid(),
  api_key_id: uuid(),
  secret: secret(),
  ...(alias === undefined ? {} : { alias }),
  capabilities: { commands: [{ command: 'move_to', scheduling: ['queued'] }] },
});
export const task = (asset) => ({
  request_id: uuid(),
  task_id: uuid(),
  asset_id: asset,
  command: 'move_to',
  scheduling: 'queued',
  inputs: {
    target: { kind: 'position', position: { latitude: 0, longitude: 0 } },
  },
});
export const barrier = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

export async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(mutableRoot, 'sdk-core-'));
  const certificate = process.env.SDK_TEST_CERTIFICATE;
  const key = process.env.SDK_TEST_KEY;
  if (!certificate || !key)
    throw new Error('Run npm test to establish trusted TLS before Node starts');
  const ca = await readFile(certificate);
  const apiKey = secret(),
    apiKeyId = uuid();
  const settings = {
    ...defaults,
    host: '127.0.0.1',
    port: 0,
    freeDiskBytes: 0,
    ...options,
  };
  let core = await createCore({ directory, certificate, key, settings });
  await core.rpc.call(
    'provision',
    { api_key_id: apiKeyId, request_id: uuid(), secret: apiKey },
    1024,
    true,
  );
  let address = await core.listen();
  const clients = new Set(),
    sockets = new Set(),
    jobs = new Set();
  const failures = [];
  let restarting = false,
    lifecycle = 0;
  const rules = [];
  const traffic = [];
  const wssTraffic = [],
    wssRules = [],
    feeds = new Set();
  const server = createServer({ cert: ca, key: await readFile(key) }, (incoming, outgoing) => {
    const startedDuringRestart = restarting,
      startedInLifecycle = lifecycle;
    const run = async () => {
      const index = rules.findIndex((rule) => rule.path === incoming.url);
      const rule = index < 0 ? undefined : rules.splice(index, 1)[0];
      const chunks = [];
      for await (const chunk of incoming) chunks.push(chunk);
      const body = Buffer.concat(chunks);
      traffic.push({
        path: incoming.url,
        attemptId: incoming.headers['atlas-attempt-id'],
      });
      const response = await new Promise((resolve, reject) => {
        const upstream = request(
          new URL(incoming.url, address),
          {
            method: incoming.method,
            headers: { ...incoming.headers, host: new URL(address).host },
            ca,
          },
          (response) => {
            const bytes = [];
            response.on('data', (chunk) => bytes.push(chunk));
            response.once('end', () =>
              resolve({
                status: response.statusCode,
                headers: response.headers,
                body: Buffer.concat(bytes),
              }),
            );
            response.once('error', reject);
          },
        );
        upstream.once('error', reject);
        upstream.end(body);
      });
      const forward = (
        bytes = response.body,
        status = response.status,
        headers = response.headers,
      ) => {
        outgoing.writeHead(status, {
          ...headers,
          'content-length': bytes.byteLength,
        });
        outgoing.end(bytes);
      };
      if (rule) await rule.action({ ...response, request: body, outgoing, forward });
      else forward();
    };
    const job = run().catch((error) => {
      outgoing.destroy(error);
      if (
        (startedDuringRestart || startedInLifecycle !== lifecycle) &&
        ['ECONNREFUSED', 'ECONNRESET'].includes(error.code)
      )
        return;
      throw error;
    });
    jobs.add(job);
    job.then(
      () => jobs.delete(job),
      (error) => {
        jobs.delete(job);
        failures.push(error);
      },
    );
  });
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  const websocketServer = new WebSocketServer({ noServer: true });
  server.on('upgrade', (incoming, socket, head) => {
    websocketServer.handleUpgrade(incoming, socket, head, (downstream) => {
      const upstream = new WebSocket(address.replace('https:', 'wss:') + '/changes', { ca });
      const pair = { downstream, upstream };
      feeds.add(pair);
      const opened = new Promise((resolve, reject) => {
        upstream.once('open', resolve);
        upstream.once('error', reject);
      });
      let clientFrames = Promise.resolve(),
        serverFrames = Promise.resolve();
      function forward(from, to, direction, raw, binary) {
        const run = async () => {
          if (direction === 'client') await opened;
          const frame = binary ? undefined : JSON.parse(raw.toString());
          wssTraffic.push({ direction, type: frame?.type, requestId: frame?.request_id });
          const send = (value = frame, asBinary = binary) => {
            if (to.readyState === WebSocket.OPEN)
              to.send(asBinary ? raw : JSON.stringify(value), { binary: asBinary });
          };
          const index = wssRules.findIndex(
            (rule) => rule.direction === direction && rule.type === frame?.type,
          );
          const rule = index < 0 ? undefined : wssRules.splice(index, 1)[0];
          if (rule) await rule.action({ frame, send, from, to });
          else send();
        };
        const job = (direction === 'client' ? clientFrames : serverFrames).then(run);
        if (direction === 'client') clientFrames = job;
        else serverFrames = job;
        jobs.add(job);
        void job.then(
          () => jobs.delete(job),
          (error) => {
            jobs.delete(job);
            failures.push(error);
            downstream.terminate();
            upstream.terminate();
          },
        );
      }
      downstream.on('message', (raw, binary) =>
        forward(downstream, upstream, 'client', raw, binary),
      );
      upstream.on('message', (raw, binary) => forward(upstream, downstream, 'server', raw, binary));
      downstream.on('error', () => upstream.terminate());
      upstream.on('error', () => downstream.terminate());
      downstream.once('close', () => {
        feeds.delete(pair);
        upstream.close();
      });
      upstream.once('close', (code) =>
        downstream.close(code >= 1000 && ![1005, 1006, 1015].includes(code) ? code : 1001),
      );
      void opened.catch(() => undefined);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `https://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    const closed = await Promise.allSettled([...clients].map((client) => client.close()));
    for (const result of closed) {
      if (result.status === 'rejected') failures.push(result.reason);
    }
    for (const { upstream, downstream } of feeds) {
      upstream.terminate();
      downstream.terminate();
    }
    await new Promise((resolve, reject) =>
      websocketServer.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => failures.push(error));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    ).catch((error) => failures.push(error));
    await Promise.allSettled(jobs);
    await core.close().catch((error) => failures.push(error));
    if (t.passed && failures.length === 0) await rm(directory, { recursive: true, force: true });
    else t.diagnostic(`Retained Core fixture: ${directory}`);
    if (failures.length) throw new AggregateError(failures, 'SDK fixture cleanup failed');
  });
  return {
    directory,
    apiKey,
    apiKeyId,
    traffic,
    wssTraffic,
    proxyUrl,
    get address() {
      return address;
    },
    get datasetId() {
      return core.dataset;
    },
    client(overrides = {}) {
      const client = createClient({
        baseUrl: proxyUrl,
        credentials: () => apiKey,
        ...overrides,
      });
      clients.add(client);
      return client;
    },
    once(path, action) {
      rules.push({ path, action });
    },
    wssOnce(type, action, direction = 'server') {
      wssRules.push({ type, action, direction });
    },
    closeFeeds(code = 1008) {
      for (const { downstream } of feeds) downstream.close(code);
    },
    async restart() {
      restarting = true;
      lifecycle++;
      await core.close();
      core = await createCore({ directory, certificate, key, settings });
      address = await core.listen();
      restarting = false;
    },
    async reset() {
      restarting = true;
      lifecycle++;
      await core.close();
      await new Promise((resolve, reject) => {
        const worker = new Worker(new URL('../../Atlas Core/dist/offline.js', import.meta.url), {
          workerData: {
            mode: 'establish',
            directory,
            settings,
            dataset: uuid(),
            action: uuid(),
            hard: false,
          },
        });
        worker.once('error', reject);
        worker.once('exit', (code) => (code === 0 ? resolve() : reject(new Error('reset_failed'))));
      });
      core = await createCore({ directory, certificate, key, settings });
      address = await core.listen();
      restarting = false;
    },
  };
}
