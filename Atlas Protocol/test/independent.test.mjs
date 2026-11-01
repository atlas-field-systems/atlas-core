import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import * as protocol from '../dist/index.js';
import { runFixtures } from './fixture-adapter.mjs';

for (const name of ['acceptance', 'independent-cases'])
  test(`${name} corpus through the built public package`, async () => {
    const corpus = JSON.parse(
      await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'),
    );
    const results = runFixtures(corpus, protocol);
    assert.deepEqual(
      results.filter((result) => !result.pass),
      [],
    );
    assert.equal(results.length, name === 'acceptance' ? 130 : 47);
  });
