import { z } from 'zod';
import { ProtocolError, contract, writeJson } from '@atlas/protocol';
import type { NegotiatedLimits, Uuid } from '@atlas/protocol';

export function boundedPage<T, R>(items: T[], make: (shortened: boolean) => R, limits: NegotiatedLimits, dataset: Uuid): R {
  let shortened = false;
  while (true) {
    const page = make(shortened);
    try {
      writeJson(contract(z.unknown(), 'http_response'), { dataset_id: dataset, data: page },
        { maxBytes: limits.max_message_bytes - 512, maxValues: limits.max_json_values - 128, maxChanges: limits.max_changes });
      return page;
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.code !== 'resource_limit' && error.code !== 'payload_too_large' || items.length <= 1) throw error;
      items.length = Math.max(1, Math.floor(items.length / 2)); shortened = true;
    }
  }
}
