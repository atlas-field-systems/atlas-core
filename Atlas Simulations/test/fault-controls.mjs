const accept = (result) => {
  result.attempt.kind = 'response';
  result.attempt.response = { kind: 'success' };
};
const wrongPosition = (asset) => {
  asset.telemetry.value.position.latitude = asset.telemetry.value.position.latitude === 0 ? 1 : 0;
};
const pending = (task) => {
  task.execution_state = 'pending';
  task.execution_summary = null;
};
export const faultControls = {
  'reply-lost': (o) => {
    o[1].second.attempt.response.body.commit_cursor = 'different-commit';
  },
  'reply-delayed': (o) => {
    o[1].first.outcome.kind = 'accepted';
  },
  'reply-altered': (o) => {
    o[1].first.outcome.kind = 'accepted';
  },
  'connections-closed': (o) => {
    o[0] = [];
  },
  'version-mismatch': (o) => {
    o[1] = { kind: 'response', response: { kind: 'success' } };
  },
  'malformed-request': (o) => {
    o[0].status = 200;
  },
  'core-restart': (o) => {
    o[3] = [];
  },
  'core-kill': (o) => {
    o[3] = [];
  },
  'core-drain': (o) => {
    o[0] = [];
  },
  'core-reset': (o) => {
    o[5].requestsAfter++;
  },
  'storage-pressure': (o) => accept(o[0]),
  'task-limit': (o) => accept(o[1]),
  'request-too-large': (o) => {
    o[0].status = 200;
  },
  'sync-connection-limit': (o) => {
    o[1] = { type: 'authenticated' };
  },
  'slow-consumer': (o) => {
    o[1] = { type: 'closed', code: 1000 };
  },
  'replay-expired': (o) => {
    o[1].status = 200;
  },
  'picture-capacity': (o) => {
    o[0].kind = 'synchronized';
  },
  'key-revoked': (o) => {
    o[1] = { kind: 'response', response: { kind: 'success' } };
  },
  'key-rotated': (o) => {
    o[1].outcome.kind = 'accepted';
  },
  'process-obsolete': (o) => accept(o[1]),
  'challenge-expired': (o) => accept(o[0]),
  'contact-expiry': (o) => {
    o[1].communications.health = 'healthy';
  },
  'cancel-race': (o) => pending(o[1]),
  'cancel-held': (o) => pending(o[1]),
  'cancel-refused': (o) => {
    o[1].cancellation_request_id = o[0].cancellation_request_id;
  },
  'pause-empty': (o) => {
    o[0].task_control.confirmed = null;
  },
  'resume-expired': (o) => pending(o[1]),
  'resume-superseded': (o) => pending(o[1]),
  'queue-changed': (o) => {
    o[1] = { kind: 'response', response: { kind: 'success' } };
  },
  'reorder-stale': (o) => {
    o[0] = { kind: 'response', response: { kind: 'success' } };
  },
  'terminal-conflict': (o) => accept(o[1]),
  'asset-deleted': (o) => accept(o[1]),
  'geofeature-edited': (o) => wrongPosition(o[3]),
  'report-replayed': (o) => {
    o[1].attempt = { kind: 'failed', code: 'network' };
  },
  'sequence-conflict': (o) => accept(o[0]),
  'execution-conflict': (o) => accept(o[1]),
  'late-position': (o) => wrongPosition(o[2]),
  'future-time': (o) => wrongPosition(o[2]),
  'tags-refused': (o) => {
    o[0][0].status = 200;
  },
  'tags-cleared': (o) => {
    o[2].tags.value.presets = ['simulated'];
  },
  'tags-history-only': (o) => {
    o[2].tags.value.presets = [];
  },
};
