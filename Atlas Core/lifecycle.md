# Lifecycle and local administration

**Restart retains data. Reset clears it. Neither means rerun uncertain work.**

| Action | Operational data and logs | Installation setup |
| --- | --- | --- |
| Start | Open retained data, or initialize first use | Reapply retained setup |
| Stop | Retain; stop Core | Retain |
| Restart | Retain | Retain |
| Reset | Clear; establish a new Dataset | Retain, including operator profiles |
| Hard Reset | Clear all Atlas-owned state | Clear setup, keys, and trust |

Hard Reset needs explicit destructive confirmation, keeps Core software and unrelated
host resources, and returns to first-use setup. A new Core release requires an
explicit update with Reset. Updates happen between missions; updating during a
mission or retaining mission data across an update is outside scope. There is no
operational-data migration or backup/restore feature. Installation-format conversion
must be deliberate and preserve identity, revocation, and credentials; incompatible
retained formats cannot be silently wiped.

## One command owns each action

An explicit local command owns each lifecycle or settings action until it finishes
or exits. It holds one installation-scoped lock and awaits owned subprocesses and
storage writers before normal exit. Commands start no detached cleanup workers.
Concurrent mutations return `management_busy`; inspection remains available.
There is no persistent Atlas management service, takeover control, or automatic recovery.

Commands own Docker access; Core does not. Core owns policy and its private
maintenance endpoint. Commands never edit live SQL. Disable automatic Core restarts.
Independent integrations own their processes and shutdown; local commands do not supervise them.

After an interrupted Start, Stop, or settings command, inspect actual state before
retrying. Interrupted destructive work requires an explicit recovery command using
the retained action record. Recovery acquires the same lock and rechecks process
identity and completed steps. A container name or reused PID is insufficient.
Explicit host force-stop remains possible, but cleanup requires verified writer exit.
Lost control-channel replies never prove that a process stopped.

## Reset recovery

Before Reset, Hard Reset, or update clears storage, flush a bounded action record
outside that storage. It identifies the action, kind, old and intended Dataset,
immutable process identities, verified steps, and safe primary and cleanup failures.
Use owned, validated paths and atomic record replacement with file and directory
flushes. Stop and verify every writer before deleting its data. Unverified exit blocks cleanup.

Clear old operational data, logs, and activity, then let Core atomically establish
the intended Dataset and an action-bound marker. Flush independent matching proof
outside cleared storage before Core serves. Before any further deletion, recovery
validates intent and reads the retained marker and proof without an ordinary writer.
Recorded progress alone cannot determine whether establishment happened.

- Marker matching the action and intended Dataset, with matching or absent proof: preserve the new
  Dataset, regenerate missing proof from that marker, and finish only recorded old cleanup.
- Verified absence of this action's marker and proof, with intact pre-establishment
  intent and only the recorded old Dataset or cleared storage: resume remaining old
  cleanup and establish the intended Dataset once.
- Missing or corrupt intent, unreadable facts, disagreement between marker and proof,
  absence after recorded establishment, or any other state: stop for explicit repair. Never wipe.

Ordinary Start refuses incomplete destructive work. Nothing resumes or relaunches
automatically. Hard Reset retains its minimal recovery record until verified completion.

Reset never deletes independently operated integrations' storage. Their old Dataset
requests remain fenced by Protocol even if they keep running.

[Diagnostics](diagnostics.md#collection-and-lifetime) defines log and export ownership.
Verify those writers stopped before cleanup. Diagnostic copies must not escape Reset
through an unmanaged container log or host journal. No stopped-state activity journal
is imported into Core; command output and recovery records have separate purposes.

Ordinary retained startup preserves Task evidence and unresolved execution, plus
Observation and Track identities, associations, immutable readings, and report retry
facts. Reset clears those records with the old Dataset, including inactive records.
Restart expires HTTP history views, snapshot captures, and contact challenges.
Partial uploads restart from zero. Mission continuity across whole-Core restart
is not promised.

## Configuration and access

Core configuration and runtime settings use explicit local commands, never
public SDK routes. Validate the entire reviewed candidate with a revision
precondition. Saved, effective, and last-working settings differ. Apply
restart-required settings explicitly; do not hide failures with fallback.

Use authenticated HTTPS/WSS with normal certificate verification and explicit
trusted origins. Offline setup supplies local trust, preloaded images/reference data,
and the first credential. No cloud login or TLS bypass; credentials stay out of URLs
and diagnostic records. [Safe fault context](diagnostics.md#safe-fault-context)
defines useful error evidence without retaining raw output.
Operator profiles and key bindings follow [Protocol identity](../Atlas%20Protocol/identity.md).
Deletion and new bindings serialize in Core's transaction; a deleted profile cannot
gain an active binding. Past attribution remains, with no permission tiers.

[Next: fusion](fusion.md)
