# Requests and unknown outcomes

A successful write confirms Core's commit. Return it immediately, even while the
local picture is behind. Write responses never update the picture or its journal.

## Prepare before sending

A prepared operation owns the original Dataset, operation kind, retry identity,
submitted facts, edit precondition, and durable-effect knowledge. Copy or freeze
these facts before transmission. Each network attempt owns its own deadline,
abort signal, and attempt result. Retrying never creates another logical operation.

Description edits retain their descriptive revision. Measurement-only updates
follow [UpdateAsset](../Atlas%20Protocol/messaging/assets.md#updating-sections).
Observation operations retain [source and report identities](../Atlas%20Protocol/messaging/observations.md).
After a lost reply, reconcile through the Observation and its recorded Track.

| Prepared-operation outcome | Meaning |
| --- | --- |
| `not_submitted` | No attempt could have transmitted the operation |
| `accepted` | A validated matching success confirms Core's committed result |
| `rejected` | Evidence establishes no effect for every possible attempt |
| `unknown_outcome` | Transmission may have occurred without definitive effect evidence |
| `dataset_invalidated` | The Dataset changed; retain prior effect knowledge and never repurpose the submission |

An attempt can return a validated HTTP error while the operation remains accepted
or unknown. A denied retry never erases an earlier success or unresolved attempt.
Timeout, abort, disconnect, invalid responses, and post-commit authorization loss
can all leave `unknown_outcome`. A later lookup that returns 404 does not prove that
an earlier commit is absent.

## When refusal is definitive

Use `rejected` only when the operation-specific refusal guarantees this attempt
made no effect and no earlier or concurrent submission remains accepted or unknown.
Do not infer this from HTTP status alone. For example, a first `CreateTask` refused
as `unsupported_command` before admission can be rejected when no previous
submission of those facts is possible. Local validation before any transmission
instead leaves the operation `not_submitted`.

A self-revoking `RevokeApiKey` can commit and then return `401 unauthorized`.
Its first attempt is denied while its operation is unknown. A deliberate exact
retry using another valid key can recover the retained success and commit cursor.
Likewise, a lost success followed by a revoked-key retry remains unknown. An
already validated success followed by that denial remains accepted.

An edit conflict, capacity refusal, expired identity, or other error on a retry
cannot by itself disprove an earlier effect. Preserve the error as that attempt's
result and retain the operation's knowledge. If the contract does not establish
no effect, keep uncertainty until matching success or authoritative reconciliation.

## Retry deliberately

Retry only on caller request, with the same identity, original facts, Dataset, and
precondition under current authorization. Never rebase an edit, allocate replacement
resources, or repeat physical work automatically. Preserve conflict and ended-identity errors.
Same-release Restart retains valid Dataset retries. Reset requires reconciliation.
Installation-lived API-key creation has its own identity lifetime; it is not
permission for automatic retry across Dataset changes.

Call `operation.close()` when that handle no longer needs to retry. Close is
idempotent, disables that handle's `start()` and `send()`, and preserves its effect
knowledge. Other handles for the same identity remain usable and share evidence.
After all such handles close and their bounded attempts settle, SDK frees the
record's count and byte capacity. Nothing is evicted automatically at a limit.
Close does not abort an attempt or undo a commit; late matching replies still
update the original evidence, and unresolved outcomes remain unknown. Preparing
a retired identity starts fresh local tracking without its earlier evidence.
Use the original facts for a deliberate Core retry, never new work under that ID.

Known key rejection pauses network work under [authorization recovery](authorization.md).
Only authenticated discovery with changed credentials can reopen it. Immediate
revocation remains in force. Recovery never resubmits prepared writes.

Aborting a wait does not cancel Core processing or physical execution. A valid late
response still updates knowledge for its matching prepared identity. Record that
knowledge before honoring later cancellation; never settle a call twice or copy an
old Dataset's result into the new Dataset. A later error cannot undo this evidence.

## Files and execution

A replayable upload source supplies stable descriptor fields and an `open` function
returning a fresh stream per attempt, starting at byte zero. A consumed one-shot
source fails as non-replayable. Do not buffer an arbitrary file or promise resume.
Keep transfer progress, Object publication, and Asset completion distinct.

[Next: the local picture](picture.md)
