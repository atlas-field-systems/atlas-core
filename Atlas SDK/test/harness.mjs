import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { createServer, request } from 'node:https';
import { randomUUID, randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { createCore } from '../../Atlas Core/dist/server.js';
import { defaults } from '../../Atlas Core/dist/settings.js';
import { mutableRoot } from '../../Atlas Core/test/paths.mjs';
const { createClient } = await import(process.env.ATLAS_SDK_ENTRY ?? '../dist/index.js');

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
  const rules = [];
  const traffic = [];
  const server = createServer({ cert: ca, key: await readFile(key) }, (incoming, outgoing) => {
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
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const proxyUrl = `https://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    await Promise.all([...clients].map((client) => client.close()));
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await Promise.allSettled(jobs);
    await core.close();
    if (failures.length) throw new AggregateError(failures, 'HTTPS proxy failed');
    await rm(directory, { recursive: true, force: true });
  });
  return {
    directory,
    apiKey,
    apiKeyId,
    traffic,
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
    async restart() {
      await core.close();
      core = await createCore({ directory, certificate, key, settings });
      address = await core.listen();
    },
    async reset() {
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
    },
  };
}
