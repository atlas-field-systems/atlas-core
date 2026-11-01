import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { Core } from '../dist/core.js';
import { Proxy } from '../dist/proxy.js';
import { Truth } from '../dist/truth.js';
import { Shutdown } from '../dist/shutdown.js';
for (const stalled of [false, true])
  test(
    `SIGINT drains a ${stalled ? 'stalled' : 'late successful'} writer`,
    { timeout: 50000 },
    async (t) => {
      const core = await Core.allocate();
      await core.setup();
      const proxy = new Proxy(core.baseUrl);
      await proxy.start();
      let child;
      t.after(async () => {
        if (child?.exitCode === null) {
          child.kill('SIGKILL');
          await once(child, 'close');
        }
        await proxy.close();
        await core.stop();
      });
      let fired;
      const intercepted = new Promise((resolve) => {
        fired = resolve;
      });
      const arm = () =>
        proxy.arm({
          path: '/messages/update_asset',
          kind: 'delay',
          delayMs: stalled ? 60000 : 1000,
          fired: (event) => {
            fired(event);
            if (stalled) arm();
          },
        });
      arm();
      child = spawn(
        process.execPath,
        [
          'dist/cli.js',
          'simulate',
          '--scenario',
          'scenarios/road-inspection.json',
          '--core',
          proxy.baseUrl,
          '--credential-file',
          join(core.directory, 'credential.json'),
        ],
        { env: process.env, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      for (const stream of [child.stdout, child.stderr])
        stream.on('data', (data) => {
          output = (output + data.toString()).slice(-16384);
        });
      const exit = once(child, 'close');
      await intercepted;
      const started = performance.now();
      child.kill('SIGINT');
      const [code] = await exit;
      assert.equal(code, stalled ? 1 : 0, output);
      assert.ok(performance.now() - started < 32000, output);
      if (stalled) assert.match(output, /Unresolved.*(writers|Asset|writer)/);
    },
  );
test('failed truth close stays visible with cleanup failure', async () => {
  const core = await Core.allocate();
  const truth = await Truth.create(core.directory);
  await truth.close();
  const cleanup = new Shutdown();
  assert.equal(await cleanup.finish('truth close', () => truth.close()), false);
  assert.match(cleanup.failures.join(' '), /truth close/);
});
