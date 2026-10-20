# Lifecycle and local administration

**Restart retains data. Reset clears it. Neither means rerun uncertain work.**

| Action | Operational data and logs | Installation setup |
| --- | --- | --- |
| Start | Open retained data, or initialize first use | Reapply retained setup |
| Stop | Retain; stop managed execution | Retain |
| Restart | Retain | Retain |
| Reset | Clear; establish a new Dataset | Retain |
| Hard Reset | Clear all Atlas-owned state | Clear setup, keys, trust, and Plugin artifacts |

Hard Reset needs explicit destructive confirmation, keeps Core software and unrelated
host resources, and returns to first-use setup. A new Core release requires an
explicit update with Reset. Updates happen between missions; updating during a
mission or retaining mission data across an update is outside scope. There is no
operational-data migration or backup/restore feature. Installation-format conversion
must be deliberate and preserve identity, revocation, and credentials; incompatible
retained formats cannot be silently wiped.

## One surviving owner

Use one per-installation systemd host manager and private local Unix control sockets.
The CLI/TUI is a client, not the lifetime owner. The manager owns Docker access;
Core and Plugins do not. Core owns policy and its private maintenance endpoint.
Disable automatic Core/Plugin restarts. Unexpected Core loss stops managed Plugins;
a transport interruption alone is not proof that a Plugin process died.

Serialize management through one durable action owner. Inspection, confirmed force
stop, and whole-installation takeover remain reachable while a Plugin drains.
Other conflicting actions may return `management_busy`. Never create a second
cleanup owner to bypass the lock, or automatically escalate a protected drain.

Confirmed force stop continues the original update, uninstall, or settings action
only after verified process exit. Unconfirmed exit leaves it incomplete. A confirmed
whole-installation action supersedes the earlier action through the same owner.
Record handoffs before effects so manager interruption cannot create two continuations.

## Reset recovery

Keep durable action records outside the storage they authorize clearing. Use owned,
validated paths, atomic record replacement, and flushed intent before destructive
work. Stop and verify every writer before deleting its data.

Clear Plugin operational work, old logs, and local activity before Core establishes
the fresh Dataset atomically. Core records independent proof of that establishment.
If interrupted before establishment, resume the recorded cleanup. After establishment,
preserve the new Dataset and finish only remaining old cleanup; do not Reset again.
Missing, damaged, or unavailable proof is not permission to wipe. Refuse unsafe Start
and expose repair. Record a Plugin's explicit startup fault rather than leaving
Reset permanently pending because that Plugin cannot become ready.

[Diagnostics](diagnostics.md#collection-and-lifetime) defines collection ownership,
retained copies, and optional export for this cleanup boundary. Diagnostic copies
must not escape Reset through an unmanaged container log or host journal.

Ordinary retained startup preserves Task evidence and unresolved execution.
Apply [Operation recovery rules](../Atlas%20Protocol/operations.md#runtime-loss-and-recovery)
before new Plugin execution.
Partial uploads restart from zero. Mission continuity across whole-Core restart
is not promised.

## Configuration and access

All Core configuration and Plugin installation/runtime settings are local CLI/TUI
administration, never public SDK routes. Validate the entire reviewed candidate
with a revision precondition. Saved, effective, and last-working settings differ.
Apply restart-required settings explicitly; do not hide failures with fallback.

Use authenticated HTTPS/WSS with normal certificate verification and explicit
trusted origins. Offline setup supplies local trust, preloaded images/reference data,
and the first credential. No cloud login, TLS bypass, or credentials in URLs/logs.
Plugin faults do not make unrelated Core services unready.

[Next: plugins](plugins.md)
