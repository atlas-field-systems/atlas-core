import * as protocol from '../dist/index.js';
import { runFixtures } from '../test/fixture-adapter.mjs';
import { runPortable } from '../test/portable.mjs';
const corpora = await Promise.all(
  ['/fixtures.json', '/independent-cases.json'].map(async (path) => (await fetch(path)).json()),
);
const fixtures = corpora.flatMap((corpus) => runFixtures(corpus, protocol));
const portable = runPortable(protocol);
window.qualification = {
  userAgent: navigator.userAgent,
  portable,
  fixtures: {
    total: fixtures.length,
    passed: fixtures.filter((result) => result.pass).length,
    failures: fixtures.filter((result) => !result.pass),
  },
};
document.querySelector('pre').textContent = JSON.stringify(window.qualification, null, 2);
document.title =
  window.qualification.fixtures.failures.length || portable.failures.length
    ? 'Atlas qualification failures'
    : 'Atlas qualification passed';
