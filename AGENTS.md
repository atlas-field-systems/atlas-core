# Working on Atlas

Read the [Atlas product charter](https://github.com/atlas-field-systems/atlas/blob/main/CHARTER.md)
and [operating environment](https://github.com/atlas-field-systems/atlas/blob/main/environment.md)
for context before changing behavior, then the [overview](README.md) and owning layer here.

The charter owns purpose and operating context. Subsystem docs own their behavior.
Protocol defines exact shared contracts; Core owns server mechanisms; SDK owns
client behavior. For planned subsystem changes, read [subsystem planning](docs/README.md)
and the affected story, then update the owning definition before implementing it.
Identify conflicts with the central context or current contracts and reconcile them
explicitly. Do not silently restore historical restrictions or claim intended
capabilities exist.

Use the central repository's merged main branch unless a review explicitly names a
proposed revision. An unmerged proposal is not approved behavior. Merging a document
does not approve behavior it labels as proposed. If the central source cannot be
read, report the gap rather than inventing its rules.

## Documentation first

State the observable outcome and failure behavior before implementing it. Keep
one authoritative definition: Protocol for shared contracts, Core for server
mechanisms, SDK for client behavior. Update that definition rather than adding
another summary that can disagree with it.

Keep pages short, with a clear opening and small sections. Explain a rule once.
Prefer a concrete example to a taxonomy. Put investigation transcripts, temporary
plans, and review chatter in the PR or local scratch space, not permanent docs.
Aim for fewer than 100 lines per page without hiding a long essay on one line.

The user owns product behavior and scope. Agents can choose engineering details
within those boundaries. Separate defects from suggestions; do not let a review
bot create new requirements. Do not merge without the user's approval.

## Implementation discipline

Use ordinary modules, small interfaces, and supported libraries. Generate only
mechanical representations; never patch generated output. Keep private SQL and
storage types out of Protocol. Do not build a framework for a hypothetical caller.

Validate untrusted input and responses at the actual consuming boundary. Preserve
omitted versus null values, exact identifiers, and numeric precision. A generated
type is not runtime validation. Do not silence type errors with unsafe casts,
blanket suppressions, or an untyped escape hatch.

Name the owner of each transaction, process, stream, timer, and cleanup. Recheck
authority after waits. Record committed effects before honoring later cancellation.
A lost response is not proof that nothing happened.

Bound work before proportional allocation, including copies, decoded data,
concurrent consumers, and accumulated state. Await writers before deleting their
storage. Keep primary and cleanup failures visible; never report an unverified
cleanup as success.

## Verification and completion

Extend the smallest real workflow that proves the change. Independent expected
results must catch a plausible broken implementation; generated snapshots alone
are not an oracle. Do not add a helper test merely to satisfy a test-count habit.

Report the exact changed scope, checks actually run, failures, and unrun coverage.
Do not weaken a check to get green. Use the owning layer's pinned build and
qualification commands. Keep mutable test installations, database sidecars, captures,
logs, and failure evidence outside the managed workspace. Core's test harness accepts
`ATLAS_TEST_ROOT`; see [qualification](Atlas%20Core/qualification.md) before running it.
