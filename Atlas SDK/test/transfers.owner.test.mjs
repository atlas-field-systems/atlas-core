import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

test(
  'transfers: large real HTTPS streams stay within a bounded live buffer allowance',
  { timeout: 150_000 },
  async () => {
    const environment = { ...process.env };
    delete environment.NODE_TEST_CONTEXT;
    const result = await promisify(execFile)(
      process.execPath,
      [
        '--expose-gc',
        '--max-old-space-size=128',
        '--test',
        fileURLToPath(new URL('./transfers-memory.mjs', import.meta.url)),
      ],
      { env: environment, maxBuffer: 1024 * 1024 },
    );
    assert.match(result.stdout, /pass 1/);
    console.log(result.stdout);
  },
);
