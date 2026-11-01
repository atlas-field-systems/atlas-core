import { wait } from './common.js';
import { AssetReport, Sequence } from '@atlas/protocol';
import { createClient } from '@atlas/sdk';
import { randomBytes } from 'node:crypto';
import type { AssetRuntime } from '../asset.js';
import { id, success } from '../sdk.js';
import type { FaultInput, FaultReceipt } from './common.js';
import { asset, observed, receipt } from './common.js';
export async function exerciseCredentials(input: FaultInput): Promise<FaultReceipt> {
  const runtime = asset(input),
    client = runtime.client,
    asset_id = runtime.identity.asset_id;
  const before = async () => success(await input.operator.input.reader.assets.get({ asset_id }));
  switch (input.action.id) {
    case 'key-revoked': {
      const snapshot = await before();
      const op = input.operator.client.apiKeys.revoke({
        request_id: id(),
        api_key_id: runtime.identity.api_key_id,
      });
      try {
        const result = await op.send();
        const read = await client.assets.get({ asset_id });
        return receipt(
          input.action.id,
          'http',
          op.submission.identity,
          '/messages/revoke_api_key',
          [result, read, snapshot, await before()],
        );
      } finally {
        op.close();
      }
    }
    case 'contact-expiry': {
      runtime.hooks.networkHoldUntil = performance.now() + 71000;
      await runtime.writes.drain();
      const start = performance.now(),
        initial = await before();
      await wait(input, 16000);
      const degraded = await before();
      await wait(input, Math.max(0, start + 70000 - performance.now()));
      const offline = await before();
      runtime.hooks.networkHoldUntil = 0;
      await runtime.checkContact();
      return receipt(
        input.action.id,
        'runtime',
        runtime.identity.process_generation,
        'all-traffic',
        [initial, degraded, offline, await before()],
      );
    }
    case 'challenge-expired': {
      const contact = client.assets.contact({
        mode: 'current',
        asset_id,
        process_generation: runtime.identity.process_generation,
        request_id: id(),
      });
      let report: ReturnType<AssetRuntime['preparePosition']> | undefined;
      try {
        const challenge = success(await contact.read());
        report = runtime.preparePosition();
        const facts = {
          ...report.submission.facts,
          request_id: id(),
          report: AssetReport.parse({
            ...report.submission.facts.report,
            report_id: id(),
            generated_at: challenge.issued_at,
            contact_proof: { challenge_id: challenge.challenge_id },
          }),
        };
        await wait(input, 10500);
        const operation = client.assets.update(facts);
        try {
          return receipt(
            input.action.id,
            'http',
            challenge.challenge_id,
            '/messages/update_asset',
            [await observed(operation, runtime), await before()],
          );
        } finally {
          operation.close();
        }
      } finally {
        report?.close();
        await contact.close();
      }
    }
    case 'process-obsolete': {
      const generation = id();
      const contact = client.assets.contact({
        mode: 'replace',
        asset_id,
        process_generation: generation,
        expected_process_generation: runtime.identity.process_generation,
        request_id: id(),
      });
      try {
        const challenge = success(await contact.read());
        const operation = contact.replace({
          asset_id,
          request_id: id(),
          expected_process_generation: runtime.identity.process_generation,
          process_generation: generation,
          challenge_id: challenge.challenge_id,
          first_report: {
            dataset_id: input.operator.input.datasetId,
            entity_id: asset_id,
            origin: { kind: 'asset_process', process_generation: generation },
            report_id: id(),
            sequence: Sequence.parse('1'),
            generated_at: challenge.issued_at,
            mode: 'current',
            sections: {},
            contact_proof: { challenge_id: challenge.challenge_id },
          },
        });
        try {
          const replaced = await observed(operation, runtime);
          const old = runtime.preparePosition();
          try {
            return receipt(
              input.action.id,
              'http',
              operation.submission.identity,
              '/messages/replace_asset_process',
              [replaced, await observed(old, runtime), await before()],
            );
          } finally {
            old.close();
          }
        } finally {
          operation.close();
        }
      } finally {
        await contact.close();
      }
    }
    case 'key-rotated': {
      const key = {
        api_key_id: id(),
        request_id: id(),
        secret: randomBytes(32).toString('base64url'),
      };
      const create = input.operator.client.apiKeys.create(key);
      let current = input.core.credential.secret;
      const probe = createClient({ baseUrl: input.proxy.baseUrl, credentials: () => current });
      try {
        success((await create.send()).attempt);
        success(await probe.connect());
        const unsent = probe.assets.update({
          asset_id,
          request_id: id(),
          alias: 'rotated',
          expected_edit_revision: (await before()).edit_revision,
        });
        current = key.secret;
        const recovered = await probe.recover();
        try {
          return receipt(input.action.id, 'http', key.api_key_id, 'recover', [
            recovered,
            { outcome: unsent.outcome },
            await probe.assets.get({ asset_id }),
          ]);
        } finally {
          unsent.close();
        }
      } finally {
        create.close();
        await probe.close();
        const revoke = input.operator.client.apiKeys.revoke({
          api_key_id: key.api_key_id,
          request_id: id(),
        });
        try {
          success((await revoke.send()).attempt);
        } finally {
          revoke.close();
        }
      }
    }

    default:
      throw new Error('Fault dispatched to wrong owner');
  }
}
