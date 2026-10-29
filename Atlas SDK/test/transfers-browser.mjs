import { NewId, Counter } from '@atlas/protocol';

/** @param {import('@atlas/sdk').HttpClient | import('@atlas/sdk').FullClient} client */
export async function runTransferAssertions(client) {
  /** @param {unknown} condition @param {string} message @returns {asserts condition} */
  function check(condition, message) {
    if (!condition) throw new Error(message);
  }
  const bytes = new TextEncoder().encode('Atlas browser multipart\0exact bytes');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  // The owning browser runner supplies a freshly discovered client and records HTTP traffic.
  const facts = {
    object_id: NewId.parse(crypto.randomUUID()),
    request_id: NewId.parse(crypto.randomUUID()),
    byte_length: Counter.parse(String(bytes.length)),
    sha256: digest,
    content_type: 'application/octet-stream',
    metadata: { associations: [] },
  };
  let opens = 0;
  const unsupported = client.objects.upload(facts, {
    open() {
      opens++;
      return new ReadableStream();
    },
  });
  const refusal = await unsupported.send();
  check(
    refusal.attempt.kind === 'not_sent' && refusal.attempt.code === 'unsupported_source',
    'browser request stream refused before transmission',
  );
  check(
    opens === 0 && refusal.outcome.kind === 'not_submitted',
    'unsupported source stays unopened',
  );
  /** @type {import('@atlas/sdk').AttemptContext[]} */
  const contexts = [];
  for (const file of [
    new Blob([bytes]),
    new File([bytes], 'private-name.bin', { type: 'text/plain' }),
  ]) {
    const uploaded = await client.objects.upload(facts, file).send();
    check(
      uploaded.attempt.kind === 'response' && uploaded.attempt.response.kind === 'success',
      'native multipart accepted',
    );
    check(uploaded.outcome.kind === 'accepted', 'publication established');
    if (uploaded.attempt.kind !== 'response') throw new Error('missing upload context');
    check(
      uploaded.attempt.context.suppliedBytes === bytes.length &&
        uploaded.attempt.context.observedTransportBytes === null,
      'honest native Blob byte counts',
    );
    contexts.push(uploaded.attempt.context);
  }
  const download = client.objects.content({
    object_id: facts.object_id,
    disposition: 'attachment',
  });
  const opened = await download.open();
  if (opened.kind !== 'response' || opened.response.kind !== 'content')
    throw new Error('content headers failed');
  check(
    opened.response.descriptor.byte_length === facts.byte_length &&
      opened.response.descriptor.sha256 === digest,
    'content descriptor matches original facts',
  );
  const reader = opened.response.stream.getReader();
  let offset = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const byte of value) check(byte === bytes[offset++], 'exact downloaded byte');
    }
  } finally {
    reader.releaseLock();
  }
  check(offset === bytes.length, 'complete file');
  const verified = await download.settled;
  check(
    verified.kind === 'response' && verified.response.kind === 'content',
    'EOF and SHA-256 verified',
  );
  if (verified.kind !== 'response') throw new Error('missing download context');
  contexts.push(verified.context);
  const listed = await client.http.objects.list({}).next();
  check(listed.kind === 'response' && listed.response.kind === 'success', 'Object list');
  check(
    listed.response.body.data.items.filter((item) => item.object_id === facts.object_id).length ===
      1,
    'one Object after retry',
  );
  contexts.push(listed.context);
  const reference = await client.reference('text/html');
  check(
    reference.kind === 'response' &&
      reference.response.kind === 'reference' &&
      reference.response.media === 'text/html',
    'typed bounded HTML reference',
  );
  if (reference.kind !== 'response') throw new Error('missing reference context');
  contexts.push(reference.context);
  return {
    objectId: facts.object_id,
    digest,
    byteLength: bytes.length,
    contexts,
    refusedAttemptId: refusal.attempt.kind === 'not_sent' ? refusal.attempt.attemptId : null,
    assertions: [
      'generic source unsupported before open or HTTP',
      'native Blob and File multipart',
      'exact same-identity retry',
      'content descriptor and full digest verification',
      'bounded typed reference',
      'supplied bytes distinct from unknown transport bytes',
    ],
  };
}
