import { z } from 'zod';
import { MessageLimits, TemporaryLimits } from '@atlas/protocol';

const count = z.number().int().min(0).max(2_147_483_647);
const bytes = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const Settings = z.strictObject({
  host: z.string().min(1).max(255), port: z.number().int().min(0).max(65535),
  trustedOrigins: z.array(z.url().refine(value => new URL(value).origin === value)).max(64),
  openEnrollment: z.boolean(),
  limits: MessageLimits, temporary: TemporaryLimits,
  workerQueueCount: count.max(4096), workerQueueBytes: bytes,
  maxConnections: count.max(1024), maxUploads: count.max(64), maxDownloads: count.max(64),
  resourceImageBytes: bytes.max(1_048_576), outstandingTasks: count.max(1000),
  replayBytes: bytes, replayMilliseconds: count,
  storageBytes: bytes, freeDiskBytes: bytes, objectBytes: bytes, reserveBytes: bytes,
  diagnosticBytes: bytes.max(268_435_456), diagnosticLevel: z.enum(['INFO', 'DEBUG', 'WARN', 'ERROR']),
}).refine(s => s.workerQueueCount >= 4 && s.workerQueueBytes >= 1_048_576 && s.reserveBytes < s.storageBytes &&
  s.objectBytes <= s.storageBytes && s.resourceImageBytes >= 65_536 && s.limits.max_message_bytes >= s.resourceImageBytes * 3 + 16_384 &&
  s.limits.max_request_bytes >= 65_536 && s.limits.max_request_json_values >= 8192 && s.limits.max_json_depth >= 16 &&
  s.limits.max_changes >= 3 && s.limits.max_json_values >= 65_536 && s.limits.max_control_bytes >= 4096 && s.limits.max_control_json_values >= 1024,
  'Settings cannot represent required control effects');
export type Settings = z.infer<typeof Settings>;
export const defaults: Settings = Settings.parse({
  host: '0.0.0.0', port: 7443, trustedOrigins: [], openEnrollment: false,
  limits: { max_request_bytes: 1_048_576, max_request_json_values: 65_536, max_message_bytes: 4_194_304,
    max_json_values: 262_144, max_changes: 1000, max_control_bytes: 16_384,
    max_control_json_values: 4096, max_json_depth: 32, max_object_bytes: 2_000_000_000 },
  temporary: { max_snapshot_captures: 8, max_snapshot_captures_per_key: 2,
    max_snapshot_bytes: '536870912', max_total_snapshot_bytes: '2147483648',
    max_history_views: 16, max_history_views_per_key: 4, max_history_references_per_view: 100_000,
    max_total_history_references: 1_000_000, max_history_bytes: '134217728', max_contact_challenges: 1024, max_allocation_receipts: 4096 },
  workerQueueCount: 256, workerQueueBytes: 16_777_216, maxConnections: 32, maxUploads: 4, maxDownloads: 4,
  resourceImageBytes: 1_048_576, outstandingTasks: 1000, replayBytes: 67_108_864, replayMilliseconds: 900_000,
  storageBytes: 64_000_000_000, freeDiskBytes: 8_000_000_000, objectBytes: 16_000_000_000,
  reserveBytes: 67_108_864, diagnosticBytes: 268_435_456, diagnosticLevel: 'INFO',
});
