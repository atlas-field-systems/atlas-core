import { Session } from '../dist/connection.js';
import { Operations } from '../dist/prepared.js';
import { createRemoteReads } from '../dist/remote-reads.js';
import { httpResources } from '../dist/client.js';
import { createTransfers } from '../dist/transfers.js';

export { success, sent } from './public-helpers.mjs';
import { success } from './public-helpers.mjs';
export async function owners(t, f, options = {}, remoteLimits) {
  const session = new Session({ baseUrl: f.proxyUrl, credentials: () => f.apiKey, ...options });
  const operations = new Operations(session);
  success(await session.discover());
  const remote = createRemoteReads(session, operations, remoteLimits);
  const http = httpResources(session, operations, remote, createTransfers(session, operations));
  t.after(async () => {
    await session.close();
    operations.close();
  });
  return { session, operations, remote, http };
}
