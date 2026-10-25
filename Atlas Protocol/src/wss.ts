import { readJson, writeJson, effectiveBudget } from './json.js';
import type { Budget } from './json.js';
import { PROTOCOL_VERSION } from './scalars.js';
import { ProtocolError } from './failure.js';
import { wss } from './synchronization.js';
import type { ClientFrame, ServerFrame } from './synchronization.js';

export type WssContext = Readonly<{
  datasetId?: string;
  requestId?: string;
  subscriptionId?: string;
  budget?: Partial<Budget>;
}>;
function check(frame: ClientFrame | ServerFrame, context: WssContext, readingServer = false): void {
  const mismatch = frame.type === 'error' && frame.error.code === 'protocol_mismatch';
  if (frame.type === 'error') {
    const error = frame.error;
    if (
      (error.code === 'dataset_mismatch' &&
        error.details !== undefined &&
        error.details.dataset_id !== frame.dataset_id) ||
      (error.code === 'protocol_mismatch' &&
        error.details !== undefined &&
        error.details.protocol_version !== frame.protocol_version)
    )
      throw new ProtocolError('invalid_value');
  }
  if (
    (frame.protocol_version !== PROTOCOL_VERSION && !(readingServer && mismatch)) ||
    (context.datasetId !== undefined && frame.dataset_id !== context.datasetId) ||
    (context.requestId !== undefined &&
      (!('request_id' in frame) || frame.request_id !== context.requestId))
  )
    throw new ProtocolError('invalid_value');
  if ('data' in frame && 'limits' in frame.data) {
    const limits = frame.data.limits;
    const budget = effectiveBudget('wss_data', context.budget);
    if (
      limits.max_message_bytes > budget.maxBytes ||
      limits.max_json_values > budget.maxValues ||
      limits.max_changes > budget.maxChanges
    )
      throw new ProtocolError('invalid_value');
  }
  if (
    context.subscriptionId !== undefined &&
    'data' in frame &&
    'subscription_id' in frame.data &&
    frame.data.subscription_id !== context.subscriptionId
  )
    throw new ProtocolError('invalid_value');
}
export function readWssClient(bytes: Uint8Array, context: WssContext = {}): ClientFrame {
  const frame = readJson(wss.clientFrame, bytes, context.budget);
  check(frame, context);
  return frame;
}
export function readWssServer(bytes: Uint8Array, context: WssContext = {}): ServerFrame {
  const frame = readJson(wss.serverFrame, bytes, context.budget);
  check(frame, context, true);
  return frame;
}
export function writeWssClient(frame: ClientFrame, context: WssContext = {}): Uint8Array {
  const bytes = writeJson(wss.clientFrame, frame, context.budget);
  check(frame, context);
  return bytes;
}
export function writeWssServer(frame: ServerFrame, context: WssContext = {}): Uint8Array {
  const bytes = writeJson(wss.serverFrame, frame, context.budget);
  check(frame, context);
  return bytes;
}
