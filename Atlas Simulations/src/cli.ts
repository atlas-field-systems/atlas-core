import { compareHistory, comparisonMarkdown } from './history.js';
import { Group, inGroup } from './groups.js';
import { readdir } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { simulate } from './interactive.js';
import { evaluate } from './run.js';
import { faultIds, loadScenario } from './scenario.js';
const command = process.argv[2];
const stop = new AbortController();
for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => stop.abort());
try {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(3),
    options: {
      scenario: { type: 'string' },
      core: { type: 'string' },
      'credential-file': { type: 'string' },
      group: { type: 'string' },
      all: { type: 'boolean' },
    },
    allowPositionals: true,
  });
  if (command === 'compare') {
    const [left, right] = positionals;
    if (!left || !right || positionals.length !== 2 || !process.env.ATLAS_EVAL_HISTORY)
      throw new Error('compare requires two refs and ATLAS_EVAL_HISTORY');
    const result = await compareHistory(process.env.ATLAS_EVAL_HISTORY, left, right);
    process.stdout.write(comparisonMarkdown(result));
    if (result.some((r) => r.before === 'passed' && r.after === 'failed')) process.exitCode = 1;
  } else if (command === 'simulate') {
    if (!values.scenario || !values.core || !values['credential-file'])
      throw new Error('simulate requires --scenario --core --credential-file');
    const { scenario } = await loadScenario(values.scenario).catch((e: unknown) => {
      process.exitCode = 2;
      throw e;
    });
    await simulate({
      scenario,
      baseUrl: values.core,
      credentialFile: values['credential-file'],
      signal: stop.signal,
    });
  } else if (command === 'eval') {
    const paths = values.scenario
      ? [values.scenario]
      : (await readdir('scenarios'))
          .filter((name) => name.endsWith('.json'))
          .map((name) => `scenarios/${name}`);
    const group = values.group === undefined ? undefined : Group.parse(values.group);
    const inputs = await Promise.all(paths.map((path) => loadScenario(path))).catch(
      (e: unknown) => {
        process.exitCode = 2;
        throw e;
      },
    );
    if (values.all) {
      const covered = new Set(
        inputs.flatMap((i) =>
          (i.scenario.timeline ?? []).flatMap((a) => (a.action === 'fault' ? [a.id] : [])),
        ),
      );
      const missing = faultIds.filter((id) => !covered.has(id));
      if (missing.length) throw new Error(`Missing fault scenarios ${missing.join(', ')}`);
    }
    for (const input of inputs.filter((i) => group === undefined || inGroup(i.scenario, group))) {
      if (stop.signal.aborted) throw new Error('Run interrupted');
      const record = await evaluate({ ...input, signal: stop.signal });
      process.stdout.write(JSON.stringify(record) + '\n');
      if (record.verdict !== 'passed') process.exitCode = 1;
    }
  } else throw new Error(`Unknown command ${command}`);
} catch (e) {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
  process.exitCode ||= command === 'compare' ? 2 : 1;
}
