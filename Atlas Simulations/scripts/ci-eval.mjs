import { spawnSync } from 'node:child_process';
import { mkdir, readdir, copyFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Group } from '../dist/groups.js';
const group = Group.parse(process.argv[2]);
const root = process.env.ATLAS_TEST_ROOT;
const output = join(process.env.RUNNER_TEMP, 'sim-output', group);
await mkdir(join(output, 'records'), { recursive: true });
const result = spawnSync(process.execPath, ['scripts/cli.mjs', 'eval', '--all', '--group', group], {
  stdio: 'inherit',
  env: process.env,
});
let records = 0;
for (const dir of await readdir(root)) {
  if (!dir.startsWith('run-')) continue;
  for (const name of await readdir(join(root, dir, 'records')).catch((e) => {
    if (e.code === 'ENOENT') return [];
    throw e;
  })) {
    if (!name.endsWith('.json')) continue;
    await copyFile(join(root, dir, 'records', name), join(output, 'records', name));
    records++;
  }
}
await writeFile(
  join(output, 'group.json'),
  JSON.stringify({ group, result: result.status === 0 ? 'success' : 'failure', records }),
);
process.exitCode = result.status ?? 1;
