import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const root = resolve(directory, '../../..');
const output = mkdtempSync(join(directory, '.geometry-'));
after(() => rmSync(output, { recursive: true, force: true }));
const native = join(output, 'geometry');
const build = spawnSync(process.env.BEND ?? '/tmp/atlas-bend2-toolchain/bin/bend',
  [join(directory, 'geometry-driver.bend'), '-o', native],
  { cwd: root, encoding: 'utf8', timeout: 60_000, env: { ...process.env, BEND_NO_TELEMETRY: '1' } });
assert.ifError(build.error);
assert.equal(build.status, 0, build.stdout + build.stderr);

function check(raw, expected = 'ok', mode = 'check', changes = 1000, work = 4194304) {
  const result = spawnSync(native, [mode, raw, String(changes), String(work)],
    { cwd: root, encoding: 'utf8', timeout: 30_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout.trim(), expected, raw.slice(0, 160));
}

const polygon = (ring) => JSON.stringify({ type: 'Polygon', coordinates: [ring] });
const triangle = polygon([[0, 0], [1, 0], [1, 1], [0, 0]]);

test('native topology reuses the independent geometry expectations', () => {
  for (const filename of ['acceptance.json', 'independent-cases.json']) {
    const corpus = JSON.parse(readFileSync(join(root, 'Atlas Protocol/test/fixtures', filename), 'utf8'));
    for (const item of corpus.cases.filter((entry) => entry.schema_name === 'Geometry' && entry.id !== 'independent-39')) {
      let code = item.error_code;
      if (!code && item.expected === 'reject') code = /dateline|endpoints|pole-edge|holes|independent-38/.test(item.id)
        ? 'unsupported_geometry' : /vertex-cap/.test(item.id) ? 'geometry_limit_exceeded' : 'invalid_geometry';
      check(item.raw_json, item.expected === 'accept' ? 'ok' : code);
    }
  }
});

test('native longitude comparison uses the exact converted endpoints', () => {
  check('{"type":"LineString","coordinates":[[-1e-15,0],[180,0]]}', 'unsupported_geometry');
  check('{"type":"LineString","coordinates":[[1e-15,0],[180,0]]}');
  check('{"type":"LineString","coordinates":[[0,0],[0,0]]}');
  check(polygon([[0, 0], [0, 1], [1, 1], [1, 0], [0, 0]]));
  check(polygon([[0, 0], [1, 0], [1, 0], [0, 1], [0, 0]]), 'invalid_geometry');
  check(polygon([[0, 0], [2, 0], [2, 2], [0, 2], [0, 1], [0, 0]]));
  check(polygon([[0, 0], [2, 0], [2, 2], [0, 2], [1, 0], [0, 0]]), 'invalid_geometry');
});

test('native reserve bounds work before coordinates are parsed', () => {
  check(triangle, 'ok', 'reserve', 0, 48);
  check(triangle, 'resource_limit', 'reserve', 0, 47);
  check(`[${triangle},${triangle}]`, 'ok', 'reserve', 0, 96);
  check(`[${triangle},${triangle}]`, 'resource_limit', 'reserve', 0, 95);
  check(JSON.stringify({ type: 'Polygon', coordinates: [[], []] }), 'unsupported_geometry', 'reserve', 0, 0);
  for (const type of ['Polygon', 'LineString']) {
    const coordinates = Array(1025).fill('not a point');
    check(JSON.stringify({ type, coordinates: type === 'Polygon' ? [coordinates] : coordinates }),
      'geometry_limit_exceeded', 'reserve');
  }
  check('{"changes":[null,null],"nested":{"changes":[null]}}', 'resource_limit', 'reserve', 2);
  check('{"changes":[null,null],"nested":{"changes":[null]}}', 'ok', 'reserve', 3);
  check('{"items":[null,{"kind":"put","resource_kind":null}]}', 'resource_limit', 'reserve', 1);
  check('{"items":[null,{"kind":"delete","resource_kind":null}]}', 'ok', 'reserve', 0);
  check('{"items":[{"kind":"put"}]}', 'ok', 'reserve', 0);
});

test('native reserve refuses the independent complete qualification workloads with exhausted work', () => {
  const corpus = JSON.parse(readFileSync(join(root, 'Atlas Protocol/test/fixtures/acceptance.json'), 'utf8'));
  const cases = corpus.cases.filter((item) => item.qualification?.includes('bounded_geometry_work'));
  assert.equal(cases.length, 4);
  for (const item of cases) check(item.raw_json, 'resource_limit', 'reserve', 1000, 0);
  check('{"items":[{"kind":"put","resource_kind":"asset"}],"changes":[null]}', 'resource_limit', 'reserve', 1);
  check('{"items":[{"kind":"put","resource_kind":"asset"}],"changes":[null]}', 'ok', 'reserve', 2);
});
