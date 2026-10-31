import { z } from 'zod';
import type { Scenario } from './scenario.js';
export const Group = z.enum([
  'missions',
  'ip',
  'core-process',
  'capacity',
  'credentials',
  'tasks',
  'evidence',
]);
export type Group = z.infer<typeof Group>;
const members: Record<Exclude<Group, 'missions'>, readonly string[]> = {
  ip: [
    'reply-lost',
    'reply-delayed',
    'reply-altered',
    'connections-closed',
    'version-mismatch',
    'malformed-request',
  ],
  'core-process': ['core-restart', 'core-kill', 'core-drain', 'core-reset'],
  capacity: [
    'storage-pressure',
    'task-limit',
    'request-too-large',
    'sync-connection-limit',
    'slow-consumer',
    'replay-expired',
    'picture-capacity',
  ],
  credentials: [
    'key-revoked',
    'key-rotated',
    'process-obsolete',
    'challenge-expired',
    'contact-expiry',
  ],
  tasks: [
    'cancel-race',
    'cancel-held',
    'cancel-refused',
    'pause-empty',
    'resume-expired',
    'resume-superseded',
    'queue-changed',
    'reorder-stale',
    'terminal-conflict',
    'asset-deleted',
    'geofeature-edited',
  ],
  evidence: [
    'report-replayed',
    'sequence-conflict',
    'execution-conflict',
    'late-position',
    'future-time',
    'tags-refused',
    'tags-cleared',
    'tags-history-only',
  ],
};
export function inGroup(scenario: Scenario, group: Group): boolean {
  const faults = (scenario.timeline ?? []).filter((a) => a.action === 'fault');
  return group === 'missions'
    ? faults.length === 0
    : faults.some((a) => members[group].includes(a.id));
}
