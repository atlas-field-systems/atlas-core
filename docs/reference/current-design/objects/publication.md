# Publishing files

> Retained current design for review. [Planning status](../../../README.md#planning-status).

Core's Object owner gives each upload attempt distinct private staging and installed
paths. A retry never overwrites an earlier attempt's file.
Stream into an attempt-owned private staging file without holding a SQL transaction.
Verify length and digest; flush bytes, install without overwrite, and flush the
parent directory. Then take a short transaction, recheck current authority and
Dataset, and commit ready metadata, retry result, and public change together.
Only then acknowledge publication.

Once a descriptor matches a committed upload receipt, retry verifies the entire
incoming stream by bounded count and SHA-256 without another content reservation.
It rechecks authority, Dataset, original facts, and deletion in the final transaction.
When the file precedes its descriptor, normal staging can stop at a capacity refusal;
Core finishes hashing and succeeds only if the later descriptor proves a committed
exact retry. Otherwise it returns the refusal and reclaims the attempt. Concurrent
first uploads still need separate staging and admission until one commits.

Staging and installed paths share a local filesystem with supported flush semantics.
Database durability and actual power-loss qualification follow the [worker contract](../implementation/database.md#driver-and-durability).

After interruption, Core's Object owner cleans only proven-owned abandoned attempts
after verifying their writers have exited. Missing SQL references alone do not prove
abandonment. Never delete a committed, active, or ambiguously owned file. File presence
alone is not publication. Allow a fresh attempt without restarting Core. Metadata/file
disagreement is an explicit per-Object fault, not permission to fabricate bytes or
erase evidence.
