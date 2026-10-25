import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { runFixture } from '../../../Atlas Protocol/test/fixture-adapter.mjs';
import { runPortable } from '../../../Atlas Protocol/test/portable.mjs';
import { protocol } from './adapter.mjs';

const reports = [];
for (const name of ['acceptance', 'independent-cases']) {
  const corpus = JSON.parse(
    await readFile(
      new URL(`../../../Atlas Protocol/test/fixtures/${name}.json`, import.meta.url),
      'utf8',
    ),
  );
  const results = corpus.cases.map((fixture) => {
    let unexpected;
    const guarded = { ...protocol };
    for (const method of ['readJson', 'writeJson', 'checkJsonBytes'])
      guarded[method] = (...args) => {
        try {
          return protocol[method](...args);
        } catch (error) {
          if (!(error instanceof protocol.ProtocolError)) unexpected = error;
          throw error;
        }
      };
    const result = runFixture(fixture, guarded);
    return unexpected ? { ...result, pass: false, code: `unexpected ${unexpected.name}` } : result;
  });
  reports.push({
    name,
    checks: results.length,
    passed: results.filter((result) => result.pass).length,
    failures: results.filter((result) => !result.pass),
  });
  console.log(`${name}: ${results.filter((result) => result.pass).length}/${results.length}`);
}

const routes = JSON.parse(
  await readFile(new URL('../../../Atlas Protocol/test/routes.json', import.meta.url), 'utf8'),
);
const actual = Object.values(protocol.exchanges).map(
  ({ operationId, method, path }) => `${operationId} ${method} ${path}`,
);
let routeFailures = [];
try {
  assert.deepEqual([...actual].sort(), [...routes].sort());
} catch (error) {
  routeFailures = [{ name: 'route inventory', code: error.message }];
}
reports.push({
  name: 'routes',
  checks: actual.length,
  passed: routeFailures.length ? 0 : actual.length,
  failures: routeFailures,
});
reports.push({ name: 'portable', ...runPortable(protocol) });

const report = {
  toolchain: 'Bend 2.0.39',
  target: 'compiled ES module',
  checks: reports.reduce((count, result) => count + result.checks, 0),
  passed: reports.reduce((count, result) => count + result.passed, 0),
  reports,
};
await mkdir(new URL('../artifacts/', import.meta.url), { recursive: true });
await writeFile(
  new URL('../artifacts/verification.json', import.meta.url),
  JSON.stringify(report, null, 2) + '\n',
);
for (const result of reports) {
  console.log(`${result.name}: ${result.passed}/${result.checks}`);
  for (const failure of result.failures) console.error(JSON.stringify(failure));
}
if (reports.some((result) => result.failures.length)) process.exitCode = 1;
