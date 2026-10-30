import { createClient } from '@atlas/sdk';
import { NewId, Uuid } from '@atlas/protocol';

/** @typedef {{ baseUrl: string, credential: string, datasetId: string }} Configuration */
/** @typedef {import('@atlas/sdk').AttemptContext} AttemptContext */

/** @param {unknown} value @param {string} message @returns {asserts value} */
function check(value, message) {
  if (!value) throw new Error(message);
}

/** @param {Configuration} config */
export async function runHttp(config) {
  const client = createClient({
    baseUrl: config.baseUrl,
    credentials: () => config.credential,
    limits: { preparedOperations: 1 },
  });
  /** @type {AttemptContext[]} */
  const contexts = [];
  const operatorId = NewId.parse(crypto.randomUUID());
  try {
    check(client.mode === 'http', 'HTTP must be the default mode');
    const discovery = await client.connect();
    check(
      discovery.kind === 'response' && discovery.response.kind === 'success',
      'Authenticated discovery',
    );
    check(client.state.kind === 'ready', 'Discovery must make the client ready');
    check(client.state.datasetId === config.datasetId, 'Exact discovered Dataset');
    check(discovery.response.body.data.protocol_version === '0.3.0', 'Exact Protocol version');
    check(discovery.response.body.dataset_id === config.datasetId, 'Discovery body context');
    contexts.push(discovery.context);
    const prepared = client.operators.create({
      operator_id: operatorId,
      request_id: NewId.parse(crypto.randomUUID()),
      name: 'Browser pilot Δ',
      description: 'Retained HTTPS browser write',
    });
    const write = await prepared.send();
    check(
      write.attempt.kind === 'response' && write.attempt.response.kind === 'success',
      'Typed browser mutation',
    );
    check(write.outcome.kind === 'accepted', 'Prepared operation has accepted evidence');
    check(write.attempt.response.body.data.name === 'Browser pilot Δ', 'Mutation value');
    check(write.attempt.response.body.data.edit_revision === '0', 'Exact initial revision');
    check(typeof write.attempt.response.body.commit_cursor === 'string', 'Mutation commit cursor');
    contexts.push(write.attempt.context);
    const retry = await prepared.send();
    check(
      retry.attempt.kind === 'response' && retry.attempt.response.kind === 'success',
      'Deliberate exact retry',
    );
    check(
      retry.attempt.response.body.commit_cursor === write.attempt.response.body.commit_cursor,
      'Retry retains original effect',
    );
    contexts.push(retry.attempt.context);
    prepared.close();
    prepared.close();
    const afterOperationClose = await prepared.send();
    check(
      afterOperationClose.attempt.kind === 'not_sent' &&
        afterOperationClose.attempt.code === 'closed',
      'Closed operation cannot retry',
    );
    check(
      afterOperationClose.outcome.kind === 'accepted',
      'Closed operation preserves accepted evidence',
    );
    const unused = client.operators.create({
      operator_id: NewId.parse(crypto.randomUUID()),
      request_id: NewId.parse(crypto.randomUUID()),
      name: 'Released slot',
    });
    unused.close();
    const read = await client.operators.get({ operator_id: operatorId });
    check(read.kind === 'response' && read.response.kind === 'success', 'Typed browser read');
    check(read.response.body.data.operator_id === operatorId, 'Read identity');
    check(
      read.response.body.data.name === 'Browser pilot Δ',
      'Read retains independent expected name',
    );
    check(
      read.response.body.data.description === 'Retained HTTPS browser write',
      'Read retains description',
    );
    contexts.push(read.context);
    const list = client.operators.list({});
    try {
      const page = await list.next();
      check(page.kind === 'response' && page.response.kind === 'success', 'Browser list');
      check(page.response.body.data.items.length === 1, 'Exactly one retained operator');
      check(page.response.body.data.items[0]?.operator_id === operatorId, 'List identity');
      check(page.response.body.data.next_page_token === null, 'List is complete');
      contexts.push(page.context);
    } finally {
      list.close();
    }
    return {
      operatorId,
      contexts,
      assertions: [
        'authenticated discovery',
        'exact Dataset and Protocol',
        'default HTTP mode',
        'typed mutation and read',
        'deliberate retry with one effect',
        'explicit operation close preserves evidence and frees capacity',
        'complete list',
        'SDK close',
      ],
    };
  } finally {
    await client.close();
    const afterClose = await client.operators.get({ operator_id: operatorId });
    check(
      afterClose.kind === 'not_sent' && afterClose.code === 'closed',
      'Close blocks new traffic',
    );
  }
}

/** @param {Configuration & { operatorId: string }} config */
export async function readRetained(config) {
  const client = createClient({
    baseUrl: config.baseUrl,
    credentials: () => config.credential,
    datasetId: Uuid.parse(config.datasetId),
  });
  try {
    const discovery = await client.connect();
    check(
      discovery.kind === 'response' && discovery.response.kind === 'success',
      'Discovery after Core restart',
    );
    const read = await client.operators.get({ operator_id: NewId.parse(config.operatorId) });
    check(
      read.kind === 'response' && read.response.kind === 'success',
      'Retained read after Core restart',
    );
    check(
      read.response.body.data.name === 'Browser pilot Δ',
      'Retained expected name after restart',
    );
    check(
      read.response.body.data.description === 'Retained HTTPS browser write',
      'Retained expected description after restart',
    );
    check(read.response.body.data.edit_revision === '0', 'Retry did not mutate revision');
    return { contexts: [discovery.context, read.context] };
  } finally {
    await client.close();
  }
}

/** @param {Configuration} config */
export async function refusals(config) {
  const wrongDataset = createClient({
    baseUrl: config.baseUrl,
    credentials: () => config.credential,
    datasetId: NewId.parse(crypto.randomUUID()),
  });
  const denied = createClient({ baseUrl: config.baseUrl, credentials: () => 'A'.repeat(43) });
  try {
    const mismatch = await wrongDataset.connect();
    check(
      mismatch.kind === 'failed' && mismatch.code === 'dataset_invalidated',
      'Wrong Dataset refusal',
    );
    const blocked = await wrongDataset.readiness({});
    check(blocked.kind === 'not_sent', 'No ordinary work after mismatch');
    const unauthorized = await denied.connect();
    check(
      unauthorized.kind === 'response' && unauthorized.response.kind === 'error',
      'Authenticated discovery refuses a wrong key',
    );
    check(unauthorized.response.body.error.code === 'unauthorized', 'Unauthorized error');
    check(
      unauthorized.context.requestId === unauthorized.response.body.error.request_id,
      'Error request correlation exposed through CORS',
    );
    return { contexts: [mismatch.context, unauthorized.context] };
  } finally {
    await Promise.all([wrongDataset.close(), denied.close()]);
  }
}

export * from '@atlas/sdk';
import { Counter, Sequence, Secret } from '@atlas/protocol';
import { runTransferAssertions } from './transfers-browser.mjs';

/** @param {Configuration} config */
export async function runTransfers(config) {
  const client = createClient({ baseUrl: config.baseUrl, credentials: () => config.credential });
  try {
    const connected = await client.connect();
    check(
      connected.kind === 'response' && connected.response.kind === 'success',
      'Transfer discovery',
    );
    const result = await runTransferAssertions(client);
    return { ...result, contexts: [connected.context, ...result.contexts] };
  } finally {
    await client.close();
  }
}

/** @typedef {import('@atlas/sdk').FullClient} FullClient */
/** @typedef {import('@atlas/sdk').HttpClient} HttpClient */
/** @type {{ full: FullClient, admin: HttpClient, assetId: import('@atlas/protocol').NewId, observationId: import('@atlas/protocol').NewId, trackId: import('@atlas/protocol').Uuid, credential: string, nextCredential: string, apiKeyId: import('@atlas/protocol').NewId, recover: () => ReturnType<FullClient['recover']> } | undefined} */
let fullRun;

/** @param {FullClient} client @param {() => boolean} predicate */
async function pictureUntil(client, predicate) {
  const subscription = client.picture.subscribe();
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  try {
    await Promise.race([
      (async () => {
        if (predicate()) return;
        for await (const event of subscription) {
          check(event.kind !== 'gap', 'No picture gap');
          if (predicate()) return;
        }
        throw new Error('Picture stopped before expected boundary');
      })(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('Picture deadline')), 15000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    subscription.close();
  }
}

/** @param {Configuration} config */
export async function startFull(config) {
  const admin = createClient({ baseUrl: config.baseUrl, credentials: () => config.credential });
  const apiKeyId = NewId.parse(crypto.randomUUID());
  const credential = Secret.parse(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
  );
  const nextCredential = Secret.parse(
    btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replaceAll('=', ''),
  );
  let accepted = credential;
  const full = createClient({
    baseUrl: config.baseUrl,
    credentials: () => accepted,
    mode: 'full',
    picture: { pageSize: 1 },
  });
  /** @type {AttemptContext[]} */
  const contexts = [];
  try {
    const discovery = await admin.connect();
    check(
      discovery.kind === 'response' && discovery.response.kind === 'success',
      'Full admin discovery',
    );
    contexts.push(discovery.context);
    for (const [id, secret] of [
      [apiKeyId, credential],
      [NewId.parse(crypto.randomUUID()), nextCredential],
    ]) {
      const created = await admin.apiKeys
        .create({
          api_key_id: NewId.parse(id),
          request_id: NewId.parse(crypto.randomUUID()),
          secret: Secret.parse(secret),
        })
        .send();
      check(
        created.attempt.kind === 'response' && created.attempt.response.kind === 'success',
        'Full test key',
      );
      contexts.push(created.attempt.context);
    }
    const assetId = NewId.parse(crypto.randomUUID());
    const registration = admin.reporting.register({
      asset_id: assetId,
      registration_id: NewId.parse(crypto.randomUUID()),
      request_id: NewId.parse(crypto.randomUUID()),
      process_generation: NewId.parse(crypto.randomUUID()),
      api_key_id: NewId.parse(crypto.randomUUID()),
      secret: Secret.parse('C'.repeat(42) + 'A'),
      alias: 'Firefox Asset',
      capabilities: { commands: [{ command: 'move_to', scheduling: ['queued'] }] },
    });
    const registered = await registration.registration.send();
    check(
      registered.attempt.kind === 'response' && registered.attempt.response.kind === 'success',
      'Browser Asset registration',
    );
    contexts.push(registered.attempt.context);
    const observationId = NewId.parse(crypto.randomUUID());
    const publisherId = NewId.parse(crypto.randomUUID());
    const creation = admin.reporting.createObservation({
      request_id: NewId.parse(crypto.randomUUID()),
      observation_id: observationId,
      publisher_id: publisherId,
    });
    const created = await creation.creation.send();
    check(
      created.attempt.kind === 'response' && created.attempt.response.kind === 'success',
      'Browser Observation creation',
    );
    contexts.push(created.attempt.context);
    const report = await creation.reporter
      .report({
        report_id: NewId.parse(crypto.randomUUID()),
        sequence: Sequence.parse('1'),
        generated_at: null,
        mode: 'current',
        sections: {
          telemetry: {
            state: 'value',
            classification: 'dated_measurement',
            observed_at: null,
            value: { position: { latitude: 51, longitude: -1 }, altitude: null, ground_speed: 0 },
            constituents: {
              position: {
                origin: { kind: 'publisher', publisher_id: publisherId },
                reading_id: NewId.parse(crypto.randomUUID()),
              },
              altitude: {
                origin: { kind: 'publisher', publisher_id: publisherId },
                reading_id: NewId.parse(crypto.randomUUID()),
              },
              ground_speed: {
                origin: { kind: 'publisher', publisher_id: publisherId },
                reading_id: NewId.parse(crypto.randomUUID()),
              },
            },
          },
        },
      })
      .send();
    check(
      report.attempt.kind === 'response' && report.attempt.response.kind === 'success',
      'Browser position report',
    );
    contexts.push(report.attempt.context);
    const connected = await full.connect();
    check(connected.kind === 'response' && connected.response.kind === 'success', 'Full discovery');
    contexts.push(connected.context);
    await pictureUntil(full, () => full.picture.status.kind === 'synchronized');
    fullRun = {
      full,
      admin,
      assetId,
      observationId,
      trackId: created.attempt.response.body.data.track.id,
      credential,
      nextCredential,
      apiKeyId,
      recover: () => {
        accepted = nextCredential;
        return full.recover();
      },
    };
    return { contexts, assetId, observationId, generation: full.picture.status.generation };
  } catch (error) {
    await Promise.all([admin.close(), full.close()]);
    throw error;
  }
}

export function readFull() {
  check(fullRun, 'Full workflow is running');
  const { full, assetId, trackId } = fullRun;
  const asset = full.assets.get({ asset_id: assetId });
  check(
    asset.kind === 'available' && asset.value?.alias === 'Firefox Asset',
    'Initial snapshot publication',
  );
  const track = full.tracks.get({ track_id: trackId });
  check(track.kind === 'available' && track.value?.id === trackId, 'Track in complete picture');
  const query = full.assets.query({ filters: { aliases: ['Firefox Asset'] }, page_size: 1 });
  check(query.kind === 'available', 'Local query');
  try {
    const page = query.value.page();
    check(page.kind === 'available' && page.value.items.length === 1, 'Local frozen page');
  } finally {
    query.value.close();
  }
  const changes = full.picture.changedSince(full.picture.cursor);
  check(changes.kind === 'available' && changes.value.commits.length === 0, 'Local changed-since');
  const subscription = full.picture.subscribe();
  subscription.close();
  return { stale: asset.stale, status: asset.status.kind };
}

export async function updateFull() {
  check(fullRun, 'Full workflow is running');
  const { full, assetId, observationId, trackId } = fullRun;
  const updated = await full.assets
    .update({
      asset_id: assetId,
      request_id: NewId.parse(crypto.randomUUID()),
      expected_edit_revision: Counter.parse('0'),
      alias: 'Firefox WSS update',
    })
    .send();
  check(
    updated.attempt.kind === 'response' && updated.attempt.response.kind === 'success',
    'HTTP write in Full',
  );
  const cursor = updated.attempt.response.body.commit_cursor;
  await pictureUntil(full, () => full.picture.status.cursor === cursor);
  const read = full.assets.get({ asset_id: assetId });
  check(
    read.kind === 'available' && read.value?.alias === 'Firefox WSS update',
    'Authenticated WSS update',
  );
  const observation = await full.observations.get({ observation_id: observationId });
  check(
    observation.kind === 'response' && observation.response.kind === 'success',
    'Explicit HTTP Observation',
  );
  const history = full.tracks.history({
    entity_id: trackId,
    query_id: NewId.parse(crypto.randomUUID()),
  });
  try {
    const page = await history.next();
    check(page.kind === 'response' && page.response.kind === 'success', 'Explicit HTTP history');
    check(page.response.body.data.readings[0]?.value?.latitude === 51, 'Real retained history');
    const released = await history.close();
    check(
      released.kind === 'response' && released.response.kind === 'success',
      'Acknowledged history release',
    );
    return {
      contexts: [updated.attempt.context, observation.context, page.context, released.context],
    };
  } finally {
    await history.close();
  }
}

export async function pauseFull() {
  check(fullRun, 'Full workflow is running');
  const { admin, full, assetId, apiKeyId } = fullRun;
  const revoked = await admin.apiKeys
    .revoke({ api_key_id: apiKeyId, request_id: NewId.parse(crypto.randomUUID()) })
    .send();
  check(
    revoked.attempt.kind === 'response' && revoked.attempt.response.kind === 'success',
    'Revoke Full key',
  );
  await full.readiness({});
  await pictureUntil(full, () => full.picture.status.kind === 'authorization-required');
  const asset = full.assets.get({ asset_id: assetId });
  check(
    asset.kind === 'available' && asset.stale && asset.status.kind === 'authorization-required',
    'Retained stale complete picture',
  );
  return { contexts: [revoked.attempt.context] };
}

export async function pausedFull() {
  check(fullRun, 'Full workflow is running');
  const { full, assetId, observationId } = fullRun;
  const local = full.assets.get({ asset_id: assetId });
  check(local.kind === 'available' && local.stale, 'Paused picture is local');
  const blocked = await full.observations.get({ observation_id: observationId });
  check(
    blocked.kind === 'not_sent' && blocked.code === 'authorization_required',
    'Paused HTTP sends nothing',
  );
}

export async function recoverFull() {
  check(fullRun, 'Full workflow is running');
  const { full, recover, assetId } = fullRun;
  const before = full.picture.status.generation;
  const accepted = await recover();
  check(
    accepted.kind === 'response' && accepted.response.kind === 'success',
    'Changed-key recovery',
  );
  await pictureUntil(full, () => full.picture.status.kind === 'synchronized');
  check(full.picture.status.generation === before, 'Same-Dataset replay retains local generation');
  const read = full.assets.get({ asset_id: assetId });
  check(read.kind === 'available' && !read.stale, 'Recovered local picture');
  return { contexts: [accepted.context] };
}

export async function closeFull() {
  check(fullRun, 'Full workflow is running');
  const { full, admin } = fullRun;
  try {
    const closed = full.close();
    check(full.close() === closed, 'Concurrent close shares one owner');
    await closed;
    check(full.picture.status.kind === 'stopped', 'Picture stopped');
    const refused = await full.connect();
    check(refused.kind === 'not_sent' && refused.code === 'closed', 'Close cannot restart');
    return {
      assertions: [
        'Full initial publication',
        'authenticated WSS updates',
        'local reads without HTTP',
        'explicit HTTP Observation and history',
        'stale authorization and paused traffic',
        'awaited socket and client shutdown',
      ],
    };
  } finally {
    await admin.close();
    fullRun = undefined;
  }
}
