import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, symlink, writeFile, readFile, rm } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test(
  'public integration types preserve remote, reporting, transfer and cleanup contracts',
  { timeout: 180_000 },
  async () => {
    const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'public-types-'));
    const consumer = process.env.ATLAS_SDK_ENTRY
      ? dirname(fileURLToPath(process.env.ATLAS_SDK_ENTRY))
      : undefined;
    const sdkRoot = consumer
      ? join(consumer, 'node_modules/@atlas/sdk')
      : fileURLToPath(new URL('../', import.meta.url));
    const protocolRoot = join(consumer ?? sdkRoot, 'node_modules/@atlas/protocol');
    await mkdir(join(root, 'node_modules/@atlas'), { recursive: true });
    await symlink(sdkRoot, join(root, 'node_modules/@atlas/sdk'));
    await symlink(protocolRoot, join(root, 'node_modules/@atlas/protocol'));
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    await writeFile(
      join(root, 'tsconfig.json'),
      JSON.stringify({
        compilerOptions: {
          target: 'ES2022',
          module: 'NodeNext',
          moduleResolution: 'NodeNext',
          strict: true,
          exactOptionalPropertyTypes: true,
          noEmit: true,
          types: [],
          lib: ['ES2022', 'DOM'],
        },
        files: ['consumer.ts'],
      }),
    );
    const common = `import { createClient, component, commandCatalog, ClientCloseError,
  type Client, type ClientOptions, type HttpClient, type FullClient,
  type HistoryView, type AssignedInstructions, type ContactRequest, type PreparedUpload,
  type ContentDownload, type ContentHandle, type ReferenceMedia, type ClientCloseResult,
  type RemoteCloseResult, type Reporting, type AssetReporter, type ObservationReporter,
  type AllocationEvidence, type HistorySelection, type HistoryContext, type ReleaseEvidence,
  type RemoteAbandonment, type HistoryCloseResult, type ContactSelection, type RemoteLimits,
  type AssetReading, type ObservationReading, type AssetChanges, type ContentOptions, type UploadSource,
} from '@atlas/sdk';
import { NewId, Uuid, Sequence, Position, Timestamp, Counter } from '@atlas/protocol';
const client: HttpClient = createClient({ baseUrl: 'https://localhost', credentials: () => '', remote: { handles: 4, retainedBytes: 64000 } });
const full: FullClient = createClient({ baseUrl: 'https://localhost', credentials: () => '', mode: 'full' });
declare const options: ClientOptions;
const dynamic: Client = createClient(options);
if (dynamic.mode === 'full') dynamic.picture.subscribe();
const reporting: Reporting = client.reporting;
const id = Uuid.parse('10000000-0000-4000-8000-000000000001');
const newId = NewId.parse('10000000-0000-4000-8000-000000000002');
const at = Timestamp.parse('2026-10-21T12:00:00Z');
const view = client.observations.history({ entity_id: id, query_id: newId, time_groups: ['known'], source_time_from: at });
const rows = view.context?.baseline_cursor;
const reporter = reporting.observation({ id, publisher_id: id });
const prepared = reporter.report({ report_id: newId, sequence: Sequence.parse('9007199254740993'), generated_at: null, mode: 'current', sections: { type: { state: 'value', classification: 'state_until_changed', observed_at: null, value: { kind: 'person' } } } });
const reportId: string = prepared.submission.facts.report.report_id;
const asset = reporting.asset({ id, process_generation: id });
asset.update({ request_id: newId }, { report_id: newId, sequence: Sequence.parse('1'), generated_at: at, mode: 'current', sections: {}, contact_proof: { challenge_id: id } });
component(Position, { latitude: 51.5, longitude: -0.1 });
component(commandCatalog.pause, { command: 'pause', scheduling: 'immediate', inputs: {} });

const assetHistory: HistoryView = full.assets.history({ entity_id: id, query_id: newId });
const trackHistory: HistoryView = full.tracks.history({ entity_id: id, query_id: newId });
const assigned: AssignedInstructions = full.tasks.assigned({ asset_id: id, process_generation: id, read_id: newId });
const contact: ContactRequest = full.assets.contact({ asset_id: id, process_generation: id, request_id: newId, mode: 'current' });
const upload: PreparedUpload = client.objects.upload({ object_id: newId, request_id: newId, byte_length: Counter.parse('0'), sha256: 'a'.repeat(64), content_type: 'text/plain', metadata: { associations: [] } }, new Blob());
const download: ContentDownload = full.objects.content({ object_id: id, disposition: 'attachment' }, { maxBytes: 0 });
const opened = await download.open();
if (opened.kind === 'response' && opened.response.kind === 'content') {
  const handle: ContentHandle = opened.response;
  const stream: ReadableStream<Uint8Array> = handle.stream;
}
const reference = await full.reference('text/html');
if (reference.kind === 'response' && reference.response.kind === 'reference') {
  const document: string = reference.response.document;
}
const closed: ClientCloseResult = await client.close();
const remoteEvidence: RemoteCloseResult = closed.remote;
declare const failure: ClientCloseError;
const failures: unknown[] = failure.errors;
`;
    const compiler = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
    const compile = () =>
      spawnSync(process.execPath, [compiler, '-p', join(root, 'tsconfig.json')], {
        encoding: 'utf8',
      });
    await writeFile(join(root, 'consumer.ts'), common);
    const positive = compile();
    assert.equal(positive.status, 0, positive.stdout + positive.stderr);
    const invalid = [
      "client.assets.history({ entity_id: id, query_id: newId, allocation_context: 'foreign' });",
      "client.tracks.history({ entity_id: id, query_id: newId, time_groups: ['local'] });",
      "client.assets.contact({ asset_id: id, process_generation: id, request_id: newId, mode: 'current', expected_process_generation: id });",
      'client.tasks.assigned({ asset_id: id, read_id: newId });',
      "component(Position, { latitude: '51.5', longitude: 0 });",
      "component(commandCatalog.move_to, { command: 'move_to', scheduling: 'immediate', inputs: {} });",
      'asset.update({ request_id: newId, alias: undefined });',
      "reporter.report({ report_id: newId, sequence: Sequence.parse('1'), generated_at: null, mode: 'current', sections: {}, publisher_id: id });",
      'client.objects.upload(upload.submission.facts, new Uint8Array());',
      "client.objects.content({ object_id: id, disposition: 'download' });",
      "client.reference('application/json');",
      'const wrong: ReadableStream = download.settled;',
      'const released: boolean = closed.remote;',
      "createClient({ baseUrl: 'https://localhost', credentials: () => '', remote: { handles: '4' } });",
      'full.observations.history({ entity_id: id, query_id: newId, page_token: "foreign" });',
    ];
    const files = [];
    for (const [index, line] of invalid.entries()) {
      const name = `negative-${index}.ts`;
      files.push(name);
      await writeFile(join(root, name), common + line);
    }
    const config = JSON.parse(await readFile(join(root, 'tsconfig.json'), 'utf8'));
    await writeFile(join(root, 'tsconfig.json'), JSON.stringify({ ...config, files }));
    const negative = compile();
    assert.notEqual(negative.status, 0);
    for (const name of files) {
      assert.ok(
        negative.stdout.includes(`${name}(`),
        `Missing independent diagnostic for ${name}: ${negative.stdout}`,
      );
    }
    assert.ok(!negative.stdout.includes('TS2307'), negative.stdout);
    console.log(
      JSON.stringify({
        publicIntegrationTypes: true,
        positiveCases: 1,
        negativeCases: invalid.length,
      }),
    );
    await rm(root, { recursive: true, force: true });
  },
);
