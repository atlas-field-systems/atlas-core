import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const sdk = fileURLToPath(new URL('../', import.meta.url));
const scenarios = [
  ['direct-workspace', false],
  ['workspace-link', false],
  ['nested-link', false],
  ['external-parent', true],
  ['external-link', true],
  ['sibling-prefix', true],
  ['workspace-alias', false],
];
for (const runner of ['test.mjs', 'package.mjs', 'browser.mjs']) {
  for (const [scenario, allowed] of scenarios) {
    test(`${runner} root: ${scenario}`, async () => {
      const sandbox = await mkdtemp(join(process.env.ATLAS_TEST_ROOT ?? tmpdir(), 'root-probe-'));
      try {
        const workspace = join(sandbox, 'workspace');
        const copy = join(workspace, 'Atlas SDK');
        await mkdir(copy, { recursive: true });
        await cp(join(sdk, 'scripts'), join(copy, 'scripts'), { recursive: true });
        await cp(join(sdk, 'package.json'), join(copy, 'package.json'));
        await mkdir(join(copy, 'test'));
        await symlink(join(sdk, 'node_modules'), join(copy, 'node_modules'));
        const targets = {
          'direct-workspace': workspace,
          'workspace-link': workspace,
          'nested-link': copy,
          'external-parent': sandbox,
          'external-link': join(sandbox, 'external'),
          'sibling-prefix': `${workspace}-external`,
          'workspace-alias': workspace,
        };
        const target = targets[scenario];
        await mkdir(target, { recursive: true });
        const alias = join(sandbox, 'alias');
        await symlink(target, alias);
        const direct = ['direct-workspace', 'external-parent', 'sibling-prefix'].includes(scenario);
        const executable = join(
          scenario === 'workspace-alias' ? join(alias, 'Atlas SDK') : copy,
          'scripts',
          runner,
        );
        const env = { ...process.env, ATLAS_TEST_ROOT: direct ? target : alias };
        delete env.npm_execpath;
        delete env.ATLAS_SDK_ENTRY;
        const result = spawnSync(process.execPath, [executable], {
          cwd: copy,
          env,
          encoding: 'utf8',
          timeout: 15_000,
        });
        assert.equal(result.error, undefined);
        assert.equal(result.signal, null);
        assert.equal(result.status, 1, result.stderr);
        assert.match(
          result.stderr,
          allowed
            ? runner === 'test.mjs'
              ? /No SDK test suites found/
              : /Run through npm/
            : /Use an external ATLAS_TEST_ROOT/,
        );
        const fixtures = (await readdir(target)).filter((name) => name.startsWith('sdk-'));
        assert.equal(fixtures.length, allowed ? 1 : 0, result.stderr);
        if (allowed) {
          const prefix = {
            'test.mjs': 'sdk-',
            'package.mjs': 'sdk-consumer-',
            'browser.mjs': 'sdk-browser-',
          };
          assert.ok(fixtures[0].startsWith(prefix[runner]));
        }
      } finally {
        await rm(sandbox, { recursive: true, force: true });
      }
    });
  }
}
