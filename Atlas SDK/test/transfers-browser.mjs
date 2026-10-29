/** @param {import('../dist/transfers.js').Transfers} transfers */
export async function runTransferAssertions(transfers) {
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
  };
  const bytes = new TextEncoder().encode('Atlas browser multipart\0exact bytes');
  const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
  // The owning browser runner supplies a freshly discovered client and records HTTP traffic.
  const facts = {
    object_id: crypto.randomUUID(),
    request_id: crypto.randomUUID(),
    byte_length: String(bytes.length),
    sha256: digest,
    content_type: 'application/octet-stream',
    metadata: { associations: [] },
  };
  let opens = 0;
  const unsupported = transfers.prepareUpload(facts, {
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
  const contexts = [];
  for (const file of [
    new Blob([bytes]),
    new File([bytes], 'private-name.bin', { type: 'text/plain' }),
  ]) {
    const uploaded = await transfers.prepareUpload(facts, file).send();
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
  const download = transfers.getContent({ object_id: facts.object_id, disposition: 'attachment' });
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
  const reference = await transfers.getReference('text/html');
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
