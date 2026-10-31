import { parseArgs } from 'node:util';
import { readdir } from 'node:fs/promises';
import { loadScenario, faultIds } from './scenario.js';
import { evaluate } from './run.js';
import { simulate } from './interactive.js';
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
  if (command === 'simulate') {
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
    if (values.group) throw new Error('Eval groups are not yet implemented');
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
    for (const input of inputs) {
      if (stop.signal.aborted) throw new Error('Run interrupted');
      const record = await evaluate(input);
      process.stdout.write(JSON.stringify(record) + '\n');
      if (record.verdict !== 'passed') process.exitCode = 1;
    }
  } else throw new Error(`Unknown command ${command}`);
} catch (e) {
  process.stderr.write((e instanceof Error ? e.message : String(e)) + '\n');
  process.exitCode ||= 1;
}
