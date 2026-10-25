import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as protocol from '../dist/index.js';
import { runFixtures } from '../test/fixture-adapter.mjs';
const path =
  process.argv[2] ?? fileURLToPath(new URL('../test/fixtures/acceptance.json', import.meta.url));
const results = runFixtures(JSON.parse(await readFile(path, 'utf8')), protocol);
const failures = results.filter((result) => !result.pass);
console.log(
  JSON.stringify(
    { total: results.length, passed: results.length - failures.length, failures },
    null,
    2,
  ),
);
if (failures.length) process.exitCode = 1;
