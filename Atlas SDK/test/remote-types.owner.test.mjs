import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { build } from 'esbuild';

const path = (relative) => fileURLToPath(new URL(relative, import.meta.url));

test('remote and reporting declarations preserve Protocol types and the complete modules bundle for browsers', async (t) => {
  const root = await mkdtemp(join(process.env.ATLAS_TEST_ROOT, 'remote-types-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const source = `
import { NewId, Uuid, Sequence, Position, Timestamp } from ${JSON.stringify(path('../node_modules/@atlas/protocol/dist/index.js'))};
import { component, commandCatalog } from ${JSON.stringify(path('../dist/components.js'))};
import { createRemoteReads } from ${JSON.stringify(path('../dist/remote-reads.js'))};
import { createReporting } from ${JSON.stringify(path('../dist/reporting.js'))};
import type { Session } from ${JSON.stringify(path('../dist/connection.js'))};
import type { Operations } from ${JSON.stringify(path('../dist/prepared.js'))};
declare const session: Session;
declare const operations: Operations;
const remote = createRemoteReads(session, operations);
const reporting = createReporting(session, operations);
const id = Uuid.parse('10000000-0000-4000-8000-000000000001');
const newId = NewId.parse('10000000-0000-4000-8000-000000000002');
const at = Timestamp.parse('2026-10-21T12:00:00Z');
const view = remote.history.observation({ entity_id: id, query_id: newId, time_groups: ['known'], source_time_from: at });
const rows = view.context?.baseline_cursor;
const reporter = reporting.observation({ id, publisher_id: id });
const prepared = reporter.report({ report_id: newId, sequence: Sequence.parse('9007199254740993'), generated_at: null, mode: 'current', sections: { type: { state: 'value', classification: 'state_until_changed', observed_at: null, value: { kind: 'person' } } } });
const reportId: string = prepared.submission.facts.report.report_id;
const asset = reporting.asset({ id, process_generation: id });
asset.update({ request_id: newId }, { report_id: newId, sequence: Sequence.parse('1'), generated_at: at, mode: 'current', sections: {}, contact_proof: { challenge_id: id } });
component(Position, { latitude: 51.5, longitude: -0.1 });
component(commandCatalog.pause, { command: 'pause', scheduling: 'immediate', inputs: {} });
`;
  const options = {
    target: 'ES2022',
    module: 'NodeNext',
    moduleResolution: 'NodeNext',
    strict: true,
    exactOptionalPropertyTypes: true,
    noEmit: true,
    types: [],
  };
  const input = join(root, 'consumer.mts');
  const config = join(root, 'tsconfig.json');
  await writeFile(config, JSON.stringify({ compilerOptions: options, files: [input] }));
  const compile = () =>
    spawnSync(process.execPath, [path('../node_modules/typescript/bin/tsc'), '-p', config], {
      encoding: 'utf8',
    });
  await writeFile(input, source);
  let result = compile();
  assert.equal(result.status, 0, result.stdout + result.stderr);
  const invalid = [
    "remote.history.asset({ entity_id: id, query_id: newId, allocation_context: 'foreign' });",
    "remote.history.asset({ entity_id: id, query_id: newId, time_groups: ['local'] });",
    "remote.contact({ asset_id: id, process_generation: id, request_id: newId, mode: 'current', expected_process_generation: id });",
    'remote.assigned({ asset_id: id, read_id: newId });',
    "component(Position, { latitude: '51.5', longitude: 0 });",
    "component(commandCatalog.move_to, { command: 'move_to', scheduling: 'immediate', inputs: {} });",
    'asset.update({ request_id: newId, alias: undefined });',
    "reporter.report({ report_id: newId, sequence: Sequence.parse('1'), generated_at: null, mode: 'current', sections: {}, publisher_id: id });",
  ];
  for (const line of invalid) {
    await writeFile(input, source + '\n' + line);
    result = compile();
    assert.notEqual(result.status, 0, line);
    assert.match(result.stdout, /error TS/);
    assert.doesNotMatch(result.stdout, /TS2307|TS2883/);
  }
  const bundled = await build({
    entryPoints: [
      path('../dist/remote-reads.js'),
      path('../dist/reporting.js'),
      path('../dist/components.js'),
    ],
    bundle: true,
    splitting: true,
    format: 'esm',
    platform: 'browser',
    outdir: join(root, 'browser'),
    metafile: true,
  });
  assert.ok(
    Object.keys(bundled.metafile.inputs).every(
      (file) =>
        !file.includes('Atlas Core') && !file.includes('zod-openapi') && !file.startsWith('node:'),
    ),
  );
  assert.ok(
    Object.values(bundled.metafile.outputs).every((output) =>
      output.imports.every((item) => item.external !== true),
    ),
  );
});
