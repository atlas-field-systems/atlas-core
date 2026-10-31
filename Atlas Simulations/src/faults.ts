import { exerciseCapacity } from './faults/capacity.js';
import type { FaultInput, FaultReceipt } from './faults/common.js';
import { exerciseCredentials } from './faults/credentials.js';
import { exerciseEvidence } from './faults/evidence.js';
import { exerciseIp } from './faults/ip.js';
import { exerciseProcess } from './faults/process.js';
import { exerciseTasks } from './faults/tasks.js';
import type { FaultId } from './scenario.js';
export { FaultReceipt } from './faults/common.js';
export type { FaultInput } from './faults/common.js';
const handlers = {
  'reply-lost': exerciseIp,
  'reply-delayed': exerciseIp,
  'reply-altered': exerciseIp,
  'connections-closed': exerciseIp,
  'malformed-request': exerciseIp,
  'request-too-large': exerciseIp,
  'core-restart': exerciseProcess,
  'core-kill': exerciseProcess,
  'picture-capacity': exerciseCapacity,
  'key-revoked': exerciseCredentials,
  'reorder-stale': exerciseTasks,
  'asset-deleted': exerciseTasks,
  'late-position': exerciseEvidence,
  'future-time': exerciseEvidence,
  'tags-cleared': exerciseEvidence,
  'tags-history-only': exerciseEvidence,
  'sequence-conflict': exerciseEvidence,
  'report-replayed': exerciseEvidence,
  'pause-empty': exerciseTasks,
  'contact-expiry': exerciseCredentials,
  'challenge-expired': exerciseCredentials,
  'process-obsolete': exerciseCredentials,
  'key-rotated': exerciseCredentials,
  'tags-refused': exerciseEvidence,
  'resume-expired': exerciseTasks,
  'resume-superseded': exerciseTasks,
  'cancel-race': exerciseTasks,
  'cancel-held': exerciseTasks,
  'cancel-refused': exerciseTasks,
  'terminal-conflict': exerciseTasks,
  'execution-conflict': exerciseTasks,
  'queue-changed': exerciseTasks,
  'task-limit': exerciseCapacity,
  'storage-pressure': exerciseCapacity,
  'core-drain': exerciseProcess,
  'version-mismatch': exerciseIp,
  'sync-connection-limit': exerciseCapacity,
  'geofeature-edited': exerciseTasks,
  'core-reset': exerciseProcess,
  'replay-expired': exerciseCapacity,
  'slow-consumer': exerciseCapacity,
} satisfies Record<FaultId, (input: FaultInput) => Promise<FaultReceipt>>;
export function exerciseFault(input: FaultInput): Promise<FaultReceipt> {
  return handlers[input.action.id](input);
}
