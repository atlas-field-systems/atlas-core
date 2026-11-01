# Objects and result files

> Retained current design for review. [Planning status](../../../README.md#planning-status).

**An Object exists publicly only when its complete content is ready.**
There are no public upload placeholders, reservations, partial Objects, or
metadata-only creates. Content is immutable after publication.

## Upload and retry

Prepare a stable Object ID, upload request ID, byte length, SHA-256 digest,
content type, initial metadata, and associations before sending. A Task may declare
that Object as a future result. Declaration does not prove the file is available.

Upload one complete binary stream with its descriptor. Failed transfers restart
from zero; there is no resume protocol. The caller retains or can reproduce the
source bytes. Exact retry validates the same original descriptor and bytes and
recovers the original successful Object. Changed facts conflict.

A successful upload means complete verified bytes and committed metadata are
available. A lost response means unknown outcome, not failed publication. Retry
identity cannot resurrect a deleted Object. Cancelling an HTTP wait does not undo
a committed upload or cancel an Asset Task.

## Metadata, references, and deletion

Metadata may be edited; content type, size, and digest remain storage facts.
Associations are references, not cascade ownership. Deleting an Entity or removing
a metadata association does not delete its Objects.
Source evidence files can reference an Observation. A Track exposes its source
associations without changing the Object's original metadata or copying its bytes.

A required Task result creates a deletion hold until Reset, even after the Task
terminates. Any remaining hold blocks deletion. Holds and deletes serialize: a
hold committed first protects the Object; a deletion committed first cannot be
undone by a later declaration or upload retry. Neither result changes Task outcome.
Ready-file discovery also follows [Task declarations](../tasks/tasks.md#references-and-results),
so a declared file is discoverable without a duplicate upload association.

Deleting an unprotected Object cuts off new public reads when the tombstone
commits. An already-open download may finish. Physical cleanup can follow, but
its storage remains charged until reclaimed. No force-delete bypasses a hold.

## Integrity

Missing or damaged committed content is an explicit integrity fault, not an empty
successful download. Preserve metadata and unrelated operations; do not fabricate
results or rewrite a completed Task. Late file availability never reopens a Task.

[Next: messaging](../shared/messages.md)

## Descriptor and read image

Upload descriptor requires `request_id`, `object_id`, `byte_length`, `sha256`,
`content_type`, and `metadata`. New IDs are UUIDv4. Byte length is a canonical
counter string no greater than 2,000,000,000. SHA-256 is exactly 64 lowercase hex
characters. Content type is a nonblank ASCII media type without parameters,
with one slash and token characters on both sides, at most 255 characters.

Metadata requires `associations`, a unique array of at most 128 closed
`{kind, id}` references. Kind is asset, observation, track, geofeature, or task;
id is a UUID. Optional non-null `name` is nonblank, at most 128 scalars; optional
non-null `description` is at most 4,096. There is no public hold list.

A read image requires `dataset_id`, `object_id`, `version`, `edit_revision`,
`created_at`, and the descriptor's byte_length, sha256, content_type, metadata.
It omits request_id. Revisions are counters; created_at is a timestamp.
EditObject requires object_id, request_id, expected_edit_revision and `edits`.
Edits permits name and description with null clearing, and associations replacing
the complete array. Omission preserves metadata. At least one edit is required.
ReadObjectContent requires object_id and `disposition`, exactly inline or attachment.
The transport streams bytes; Protocol validates only the response descriptor.
