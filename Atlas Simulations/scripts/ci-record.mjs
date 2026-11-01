import { readdir, readFile, appendFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Group, inGroup } from '../dist/groups.js';
import { loadScenario } from '../dist/scenario.js';
import { passed, readRecord } from '../dist/records.js';
import { compareHistory, comparisonMarkdown } from '../dist/history.js';
export function jobFailures(needs, fork) {
  return ['build', 'eval', 'publish']
    .filter(
      (job) =>
        needs[job]?.result !== 'success' &&
        !(job === 'publish' && fork && needs[job]?.result === 'skipped'),
    )
    .map((job) => `${job} ${needs[job]?.result ?? 'missing'}`);
}
export async function aggregate(directory, needs, fork) {
  const failures = jobFailures(needs, fork);
  const scenarios = await Promise.all(
    (await readdir('scenarios'))
      .filter((n) => n.endsWith('.json'))
      .map((n) => loadScenario(join('scenarios', n))),
  );
  for (const group of Group.options) {
    const expected = scenarios.filter((i) => inGroup(i.scenario, group));
    try {
      const bytes = await readFile(join(directory, group, 'group.json'));
      if (bytes.length > 16384) throw new Error('Manifest limit');
      const manifest = JSON.parse(bytes);
      if (manifest.group !== group || manifest.result !== 'success')
        throw new Error('Group failed');
      const names = await readdir(join(directory, group, 'records'));
      if (
        names.length > 256 ||
        names.length !== expected.length ||
        manifest.records !== names.length
      )
        throw new Error('Missing group records');
      const records = await Promise.all(
        names.map((n) => readRecord(join(directory, group, 'records', n))),
      );
      for (const item of expected) {
        const found = records.filter(
          (r) => r.scenario === item.scenario.name && r.inputs.scenario === item.sha256,
        );
        if (
          found.length !== 1 ||
          found[0].verdict !== 'passed' ||
          !passed(found[0].checks, found[0].cleanup) ||
          found[0].failures.length
        )
          throw new Error(`Failed or missing ${item.scenario.name}`);
      }
    } catch (e) {
      failures.push(`${group} ${e.message}`);
    }
  }
  return failures;
}
if (process.argv[1]?.endsWith('/ci-record.mjs')) {
  const failures = await aggregate(
    process.env.RECORD_DIRECTORY,
    JSON.parse(process.env.JOB_RESULTS),
    process.env.IS_FORK === 'true',
  );
  const comparison = await compareHistory(
    process.env.ATLAS_EVAL_HISTORY,
    'main',
    process.env.GITHUB_SHA ?? process.env.ATLAS_SOURCE_BRANCH,
  );
  const summary =
    comparisonMarkdown(comparison) +
    failures.map((f) => `\nFailed ${f.replaceAll('\n', ' ')}`).join('');
  if (process.env.GITHUB_STEP_SUMMARY) await appendFile(process.env.GITHUB_STEP_SUMMARY, summary);
  process.stdout.write(summary);
  if (failures.length) process.exitCode = 1;
}
