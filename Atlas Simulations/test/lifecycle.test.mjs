import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '@atlas/sdk';
import { Core } from '../dist/core.js';
import { success } from '../dist/sdk.js';
test(
  'packed SDK authenticates to fresh pinned Core container and verifies stop',
  { timeout: 180000 },
  async () => {
    const core = await Core.allocate();
    let client;
    try {
      await core.setup();
      assert.match(core.containerId, /^[a-f0-9]{64}$/);
      client = createClient({ baseUrl: core.baseUrl, credentials: () => core.credential.secret });
      success(await client.connect());
      assert.equal(client.state.kind, 'ready');
    } finally {
      if (client) await client.close();
      await core.stop();
    }
  },
);
