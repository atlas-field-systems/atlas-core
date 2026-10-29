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
  const client = createClient({ baseUrl: config.baseUrl, credentials: () => config.credential });
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
