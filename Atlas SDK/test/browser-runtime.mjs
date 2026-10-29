import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { firefox } from 'playwright';
import { createCore } from '../../Atlas Core/dist/server.js';
import { defaults } from '../../Atlas Core/dist/settings.js';

const directory = process.env.ATLAS_BROWSER_DIRECTORY;
assert.ok(directory, 'Run npm run test:browser to install an isolated package consumer');
const certutil = process.env.ATLAS_BROWSER_CERTUTIL ?? 'certutil';
const profile = join(directory, 'firefox-profile');
const certificate = join(directory, 'server.pem');
const key = join(directory, 'server.key');
const ca = join(directory, 'ca.pem');
const caKey = join(directory, 'ca.key');
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

function openssl(args) {
  execFileSync('openssl', args, { stdio: 'pipe' });
}

async function pageServer(bundle) {
  const server = createServer((request, response) => {
    response.setHeader('Cache-Control', 'no-store');
    if (request.url === '/browser.mjs') {
      response.writeHead(200, { 'Content-Type': 'text/javascript' });
      response.end(bundle);
    } else if (request.url === '/') {
      response.writeHead(200, { 'Content-Type': 'text/html' });
      response.end('<!doctype html><title>Atlas installed browser qualification</title>');
    } else {
      response.writeHead(404).end();
    }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { server, origin: `http://127.0.0.1:${address.port}` };
}

async function closeServer(server) {
  await new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
  assert.equal(server.listening, false);
}

test('installed SDK runs public HTTPS workflows in Firefox with profile-scoped TLS trust', async (t) => {
  const failures = [];
  const browsers = new Set();
  const pages = [];
  let core;
  const report = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
  const traffic = [];
  const responses = [];
  const responseJobs = [];
  let upgrades = 0;
  const sockets = [];
  const activeSockets = new Set();
  const frames = [];
  const multipart = [];
  const pageErrors = [];
  const contexts = [];
  let completed = false;
  t.after(async () => {
    for (const context of browsers) {
      try {
        const browser = context.browser();
        await context.close();
        assert.equal(browser.isConnected(), false);
      } catch (error) {
        failures.push(error);
      }
    }
    if (core) {
      try {
        await core.close();
        assert.equal(core.app.server.listening, false);
        assert.equal(core.rpc.worker.threadId, -1);
      } catch (error) {
        failures.push(error);
      }
    }
    for (const page of pages) {
      try {
        await closeServer(page.server);
      } catch (error) {
        failures.push(error);
      }
    }
    await Promise.all(responseJobs);
    await writeFile(
      join(directory, 'traffic.json'),
      JSON.stringify({ requests: traffic, responses }, null, 2),
    );
    if (failures.length) throw new AggregateError(failures, 'Browser qualification cleanup failed');
    if (completed) {
      report.shutdown = {
        sdkClosed: true,
        browsersClosed: true,
        coreWorkerExited: true,
        serversClosed: true,
      };
      await writeFile(
        join(directory, 'qualification.json'),
        JSON.stringify(report, null, 2) + '\n',
      );
    }
  });
  await mkdir(profile);
  openssl([
    'req',
    '-x509',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-days',
    '2',
    '-subj',
    '/CN=Atlas browser test CA',
    '-addext',
    'basicConstraints=critical,CA:TRUE',
    '-addext',
    'keyUsage=critical,keyCertSign,cRLSign',
    '-keyout',
    caKey,
    '-out',
    ca,
  ]);
  openssl([
    'req',
    '-new',
    '-newkey',
    'rsa:2048',
    '-nodes',
    '-subj',
    '/CN=localhost',
    '-keyout',
    key,
    '-out',
    join(directory, 'server.csr'),
  ]);
  await writeFile(
    join(directory, 'server.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:localhost,IP:127.0.0.1\n',
  );
  openssl([
    'x509',
    '-req',
    '-in',
    join(directory, 'server.csr'),
    '-CA',
    ca,
    '-CAkey',
    caKey,
    '-CAcreateserial',
    '-days',
    '2',
    '-extfile',
    join(directory, 'server.ext'),
    '-out',
    certificate,
  ]);
  const bundle = await readFile(join(directory, 'consumer/browser.mjs'));
  const trustedPage = await pageServer(bundle);
  pages.push(trustedPage);
  const deniedPage = await pageServer(bundle);
  pages.push(deniedPage);
  const credential = randomBytes(32).toString('base64url');
  const settings = {
    ...defaults,
    host: '127.0.0.1',
    port: 0,
    freeDiskBytes: 0,
    trustedOrigins: [trustedPage.origin],
  };
  const installation = join(directory, 'core');
  await mkdir(installation);
  core = await createCore({ directory: installation, certificate, key, settings });
  await core.rpc.call(
    'provision',
    { api_key_id: randomUUID(), request_id: randomUUID(), secret: credential },
    1024,
    true,
  );
  function observe(server) {
    server.on('upgrade', () => {
      upgrades++;
    });
    server.on('request', (request, response) => {
      response.once('finish', () =>
        traffic.push({
          path: request.url,
          method: request.method,
          origin: request.headers.origin,
          authenticated: request.headers.authorization === `Bearer ${credential}`,
          attemptId: request.headers['atlas-attempt-id'],
          datasetId: request.headers['atlas-dataset-id'],
          protocol: request.headers['atlas-protocol-version'],
          requestedHeaders: request.headers['access-control-request-headers'],
          status: response.statusCode,
        }),
      );
    });
  }
  observe(core.app.server);
  let baseUrl = await core.listen();
  const datasetId = core.dataset;
  const launch = async () => {
    const context = await firefox.launchPersistentContext(profile, {
      headless: true,
      timeout: 30_000,
      firefoxUserPrefs: { 'security.enterprise_roots.enabled': false },
    });
    browsers.add(context);
    context.setDefaultTimeout(15_000);
    context.on('request', (request) => {
      if (request.method() !== 'POST' || new URL(request.url()).pathname !== '/objects') return;
      const byteLength = Number(request.headers()['content-length']);
      assert.ok(Number.isSafeInteger(byteLength) && byteLength > 0);
      assert.ok(byteLength < 4 * 1024 * 1024 + 8192, 'Bounded native multipart fixture');
      if (byteLength < 8192) {
        const body = request.postDataBuffer();
        assert.equal(body?.length, byteLength);
        multipart.push({ byteLength, body: body.toString('latin1') });
      } else multipart.push({ byteLength });
    });
    context.on('response', (response) => {
      if (!response.url().startsWith('https:')) return;
      responseJobs.push(
        (async () => {
          const headers = await response.allHeaders();
          responses.push({
            path: new URL(response.url()).pathname,
            attemptId: response.request().headers()['atlas-attempt-id'],
            requestId: headers['atlas-request-id'],
            datasetId: headers['atlas-dataset-id'],
            protocol: headers['atlas-protocol-version'],
            allowedOrigin: headers['access-control-allow-origin'],
            allowedHeaders: headers['access-control-allow-headers'],
            exposedHeaders: headers['access-control-expose-headers'],
            contentLength: headers['content-length'],
            contentSha256: headers['atlas-content-sha256'],
          });
        })().catch((error) => {
          failures.push(error);
        }),
      );
    });
    context.on('page', (page) => {
      page.on('websocket', (socket) => {
        sockets.push(socket.url());
        activeSockets.add(socket);
        socket.on('close', () => activeSockets.delete(socket));
        socket.on('framereceived', ({ payload }) => {
          if (typeof payload === 'string') frames.push(JSON.parse(payload).type);
        });
      });
      page.on('pageerror', (error) => pageErrors.push(error.message));
    });
    return context;
  };
  const untrusted = await launch();
  const probe = await untrusted.newPage();
  await assert.rejects(
    probe.goto(`${baseUrl}/health`),
    /SEC_ERROR_UNKNOWN_ISSUER|SEC_ERROR_UNTRUSTED_ISSUER/,
  );
  await untrusted.close();
  browsers.delete(untrusted);
  execFileSync(certutil, [
    '-A',
    '-d',
    `sql:${profile}`,
    '-n',
    'Atlas isolated browser CA',
    '-t',
    'C,,',
    '-i',
    ca,
  ]);
  const trust = execFileSync(certutil, ['-L', '-d', `sql:${profile}`], { encoding: 'utf8' });
  assert.match(trust, /Atlas isolated browser CA\s+C,,/);
  await writeFile(join(directory, 'profile-trust.txt'), trust);
  const browser = await launch();
  report.browser = {
    name: 'firefox',
    version: browser.browser().version(),
    executable: firefox.executablePath(),
  };
  report.playwright = JSON.parse(
    await readFile(new URL('../node_modules/playwright/package.json', import.meta.url), 'utf8'),
  ).version;
  const page = await browser.newPage();
  const unauthenticated = await page.goto(`${baseUrl}/health`);
  assert.equal(
    unauthenticated.status(),
    401,
    'TLS accepts the CA but authentication is still required',
  );
  await page.goto(trustedPage.origin);
  const initial = await page.evaluate(
    async (config) => (await import('/browser.mjs')).runHttp(config),
    { baseUrl, credential, datasetId },
  );
  contexts.push(...initial.contexts);
  const refused = await page.evaluate(
    async (config) => (await import('/browser.mjs')).refusals(config),
    { baseUrl, credential, datasetId },
  );
  contexts.push(...refused.contexts);
  const wrongVersion = await page.evaluate(
    async ({ baseUrl, credential, datasetId }) => {
      const response = await fetch(`${baseUrl}/readiness`, {
        headers: {
          Authorization: `Bearer ${credential}`,
          'Atlas-Dataset-ID': datasetId,
          'Atlas-Protocol-Version': '0.2.0',
          'Atlas-Attempt-ID': crypto.randomUUID(),
        },
      });
      return {
        status: response.status,
        dataset: response.headers.get('Atlas-Dataset-ID'),
        protocol: response.headers.get('Atlas-Protocol-Version'),
        request: response.headers.get('Atlas-Request-ID'),
        body: await response.json(),
      };
    },
    { baseUrl, credential, datasetId },
  );
  assert.equal(wrongVersion.status, 409);
  assert.equal(wrongVersion.body.error.code, 'protocol_mismatch');
  assert.equal(wrongVersion.dataset, datasetId);
  assert.equal(wrongVersion.protocol, '0.3.0');
  assert.equal(wrongVersion.request, wrongVersion.body.error.request_id);
  const denied = await browser.newPage();
  await denied.goto(deniedPage.origin);
  const corsDenied = await denied.evaluate(
    async ({ baseUrl, credential }) => {
      try {
        await fetch(`${baseUrl}/health`, { headers: { Authorization: `Bearer ${credential}` } });
        return false;
      } catch (error) {
        return error instanceof TypeError;
      }
    },
    { baseUrl, credential },
  );
  assert.equal(corsDenied, true, 'Browser refuses an untrusted origin');
  await denied.close();
  await core.close();
  assert.equal(core.rpc.worker.threadId, -1, 'Database worker exits before restart');
  core = await createCore({ directory: installation, certificate, key, settings });
  assert.equal(core.dataset, datasetId);
  observe(core.app.server);
  baseUrl = await core.listen();
  await page.reload();
  const retained = await page.evaluate(
    async (config) => (await import('/browser.mjs')).readRetained(config),
    { baseUrl, credential, datasetId, operatorId: initial.operatorId },
  );
  contexts.push(...retained.contexts);
  await Promise.all(responseJobs);
  for (const context of contexts) {
    assert.match(context.attemptId, uuid);
    assert.match(context.requestId, uuid);
    const requests = traffic.filter((request) => request.attemptId === context.attemptId);
    assert.equal(requests.length, 1);
    const response = responses.find((response) => response.attemptId === context.attemptId);
    assert.ok(response);
    assert.equal(response.requestId, context.requestId);
    assert.equal(requests[0].origin, trustedPage.origin);
    assert.equal(response.datasetId, datasetId);
    assert.equal(response.protocol, '0.3.0');
    assert.equal(response.allowedOrigin, trustedPage.origin);
    if (requests[0].path !== '/health') assert.equal(requests[0].datasetId, datasetId);
    assert.equal(requests[0].protocol, '0.3.0');
    assert.equal(requests[0].authenticated, requests[0].status !== 401);
  }
  assert.equal(new Set(contexts.map((context) => context.attemptId)).size, contexts.length);
  assert.equal(
    traffic.filter((request) => request.attemptId !== undefined).length,
    contexts.length + 1,
    'Only expected SDK attempts and the explicit version probe reached Core',
  );
  const preflight = traffic.filter(
    (request) => request.method === 'OPTIONS' && request.origin === trustedPage.origin,
  );
  assert.ok(preflight.length > 0, 'Real browser CORS preflights reached Core');
  for (const header of [
    'authorization',
    'atlas-attempt-id',
    'atlas-dataset-id',
    'atlas-protocol-version',
    'content-type',
  ]) {
    assert.ok(
      preflight.some((request) => request.requestedHeaders?.toLowerCase().includes(header)),
      `Browser requested ${header}`,
    );
    assert.ok(
      responses.some((response) => response.allowedHeaders?.toLowerCase().includes(header)),
      `Core permits ${header}`,
    );
  }
  assert.ok(preflight.every((request) => request.status === 204));
  assert.ok(
    traffic.some((request) => request.origin === deniedPage.origin && request.status === 400),
  );
  assert.deepEqual(pageErrors, []);
  assert.deepEqual(sockets, [], 'Default HTTP mode opens zero browser WebSockets');
  assert.equal(upgrades, 0, 'Core receives zero WebSocket upgrades');
  const transfers = await page.evaluate(
    async (config) => (await import('/browser.mjs')).runTransfers(config),
    { baseUrl, credential, datasetId },
  );
  await Promise.all(responseJobs);
  assert.equal(
    traffic.filter((request) => request.attemptId === transfers.refusedAttemptId).length,
    0,
  );
  assert.equal(multipart.length, 3, 'Two small native retries and one large Blob upload');
  const captured = multipart.filter((upload) => upload.body !== undefined);
  assert.equal(captured.length, 2, 'Only the two small multipart bodies are captured');
  for (const { body } of captured) {
    assert.ok(body.indexOf('name="descriptor"') < body.indexOf('name="file"'));
    assert.match(body, /name="descriptor"[^\r]*\r\nContent-Type: application\/json/i);
    assert.match(body, /name="file"[^\r]*\r\nContent-Type: application\/octet-stream/i);
    assert.ok(!body.includes('private-name.bin'), 'Transport does not expose caller filename');
  }
  const large = multipart.filter((upload) => upload.body === undefined);
  assert.equal(large.length, 1);
  assert.ok(large[0].byteLength > 4 * 1024 * 1024);
  assert.equal(transfers.delayedDownload.byteLength, 4 * 1024 * 1024);
  assert.match(transfers.delayedDownload.objectId, uuid);
  assert.notEqual(transfers.delayedDownload.objectId, transfers.objectId);
  assert.match(transfers.delayedDownload.digest, /^[0-9a-f]{64}$/);
  const delayedContent = responses.find(
    (response) => response.path === `/objects/${transfers.delayedDownload.objectId}/content`,
  );
  assert.ok(delayedContent, 'Actual Core response for the delayed large download');
  assert.equal(delayedContent.contentLength, String(transfers.delayedDownload.byteLength));
  assert.equal(delayedContent.contentSha256, transfers.delayedDownload.digest);
  for (const attempt of transfers.contexts) {
    const request = traffic.filter((request) => request.attemptId === attempt.attemptId);
    const response = responses.find((response) => response.attemptId === attempt.attemptId);
    assert.equal(request.length, 1);
    assert.equal(response?.requestId, attempt.requestId);
  }
  const content = responses.find(
    (response) => response.path === `/objects/${transfers.objectId}/content`,
  );
  assert.ok(content, 'Actual Core binary response');
  for (const header of [
    'content-length',
    'content-disposition',
    'atlas-content-sha256',
    'atlas-request-id',
  ]) {
    assert.ok(content.exposedHeaders?.toLowerCase().includes(header), `CORS exposes ${header}`);
  }
  const full = await page.evaluate(
    async (config) => (await import('/browser.mjs')).startFull(config),
    { baseUrl, credential, datasetId },
  );
  const localBefore = traffic.length;
  await page.evaluate(async () => (await import('/browser.mjs')).readFull());
  assert.equal(
    traffic.length,
    localBefore,
    'Ready Full reads, query, changedSince and subscription send zero HTTP',
  );
  const updated = await page.evaluate(async () => (await import('/browser.mjs')).updateFull());
  assert.ok(traffic.some((request) => request.path === '/messages/get_track_movement_history'));
  assert.ok(traffic.some((request) => request.path === '/messages/get_observation'));
  assert.ok(
    frames.includes('authenticated') && frames.includes('change_batch'),
    'Real authenticated WSS delivered complete updates',
  );
  const paused = await page.evaluate(async () => (await import('/browser.mjs')).pauseFull());
  const pausedBefore = traffic.length;
  await page.evaluate(async () => (await import('/browser.mjs')).pausedFull());
  assert.equal(traffic.length, pausedBefore, 'Authorization pause sends zero HTTP');
  const recovered = await page.evaluate(async () => (await import('/browser.mjs')).recoverFull());
  const closed = await page.evaluate(async () => (await import('/browser.mjs')).closeFull());
  const fullContexts = [
    ...full.contexts,
    ...updated.contexts,
    ...paused.contexts,
    ...recovered.contexts,
  ];
  await Promise.all(responseJobs);
  for (const context of fullContexts) {
    assert.match(context.requestId, uuid);
    assert.equal(traffic.filter((request) => request.attemptId === context.attemptId).length, 1);
    assert.equal(
      responses.find((response) => response.attemptId === context.attemptId)?.requestId,
      context.requestId,
    );
  }
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(activeSockets.size, 0, 'Awaited client close shuts down native sockets');
  const afterClose = traffic.length;
  await page.waitForTimeout(200);
  assert.equal(traffic.length, afterClose, 'No recovery or traffic after close');
  assert.ok(upgrades >= 2, 'Initial authenticated feed and changed-key recovery');
  assert.deepEqual(pageErrors, []);
  report.trust = {
    profile,
    database: 'cert9.db',
    unknownIssuerRejected: true,
    caTrustedOnlyInProfile: true,
    authenticatedTlsSucceeded: true,
  };
  report.assertions = [
    ...initial.assertions,
    'retained effect after Core restart',
    'wrong Dataset refusal',
    'wrong credential refusal',
    'exact version refusal',
    'request and error correlation',
    'CORS preflight and exposed context',
    'untrusted origin blocked',
    'zero HTTP-mode WebSocket connections',
    ...transfers.assertions,
    ...closed.assertions,
    'changed-key recovery over real WSS',
    'native multipart part order and media',
    'binary CORS headers and correlation',
  ];
  report.notExercised = ['Chromium', 'WebKit', 'sustained workload', 'power-loss durability'];
  report.full = {
    socketCount: sockets.length,
    upgradeCount: upgrades,
    receivedFrameTypes: [...new Set(frames)],
    correlatedAttempts: fullContexts.length,
  };
  report.transfers = {
    objectId: transfers.objectId,
    sha256: transfers.digest,
    byteLength: transfers.byteLength,
    nativeMultipartRequests: multipart.length,
    capturedMultipartRequests: captured.length,
    largeMultipartBytes: large[0].byteLength,
    delayedDownload: transfers.delayedDownload,
    correlatedAttempts: transfers.contexts.length,
  };
  report.correlatedAttemptContexts =
    contexts.length + transfers.contexts.length + fullContexts.length;
  report.sdkHttpRequests = traffic.filter(
    (request) => request.attemptId !== undefined && request.protocol === '0.3.0',
  ).length;

  completed = true;
});
