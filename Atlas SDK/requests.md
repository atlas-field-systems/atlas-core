# Requests and unknown outcomes

**A successful write means Core committed it, not that the local picture has
already caught up.** Return that result immediately. Write responses never update
the picture, its cursor, journal, or subscriptions.

## Prepare before sending

Retain the original Dataset, operation kind, retry identity, submitted facts, and
required edit precondition. Preparation happens before network transmission. Changes
to Entity descriptions use their descriptive revision. Measurement-only Asset
updates do not depend on it. Follow [UpdateAsset](../Atlas%20Protocol/messaging/assets.md#updating-sections)
for section replacement and evidence requirements.
Observation creation and reports retain the identities required by
[Observation messages](../Atlas%20Protocol/messaging/observations.md). Reconcile
through the Observation and its recorded Track association after a lost reply.

| Outcome | Meaning |
| --- | --- |
| `not_submitted` | Local failure before transmission |
| `accepted` | Validated response confirms Core's committed result |
| `rejected` | Validated definitive refusal |
| `unknown_outcome` | Timeout, abort, disconnect, or invalid response after possible transmission |
| `dataset_invalidated` | Dataset changed; an old submission must not be repurposed |

An invalid response can follow a real effect. A 404 during later lookup does not
prove that a request never committed. Cancellation of a wait is not cancellation
of processing. A valid late reply can resolve the prepared identity, but must not
settle a call twice or contaminate a new Dataset's state.

## Retry deliberately

Retry the same identity, original facts, Dataset, and precondition under current
authorization. Do not silently create another Observation or Task, allocate another Object, rebase
an edit, or rerun an Operation. Preserve conflict and ended-identity errors.

Same-release Restart retains valid Dataset retries. Reset requires deliberate
reconciliation, not attaching an old request to the new Dataset. Installation-lived
API-key creation is a specific exception in identity lifetime, not automatic retry
permission across Dataset changes.

## Files and processing

A replayable upload source provides stable descriptor fields plus an `open` function
that returns a fresh stream for each attempt. Retries begin at byte zero. A consumed
one-shot source fails explicitly as non-replayable; do not buffer an arbitrary file
or promise resume to hide that limitation.

Keep progress, upload publication, Asset completion, and Plugin outcome distinct.
Expose [Protocol's Operation states and recovery rules](../Atlas%20Protocol/operations.md)
without treating an aborted SDK wait as an Operation outcome.

[Next: the local picture](picture.md)
