---
status: accepted
---

# Protect active Plugin work during lifecycle changes

Plugins can be stopped, updated or reconfigured while Core stays running ([ADR-0002](0002-core-manages-installed-plugins.md)), and they may have finite Operations or continuous ingestion in progress when that happens. Plugins can also crash, and a new configuration can prevent a Plugin from starting.

Current rules: [Plugins](../topics/plugins.md).

## Decision

A planned Plugin stop or update stops admitting new Operations, asks continuous ingestion to stop, and waits for finite active Operations to finish or be explicitly cancelled. If the Plugin cannot stop cooperatively, the operator may force stop it; a force stop is never reported as successful Operation completion.

After a Plugin crash while Core remains in the same run, reconcile recorded work and outcomes. Core reports a fault and offers a manual restart. A known failed Operation keeps its failure and needs an explicit operator rerun; restarting the Plugin never retries it automatically. Plugin restart and force stop are local CLI/TUI actions; public consumers can cancel individual Operations but cannot manage Plugin processes.

Plugin settings declare a schema. Saving and applying are separate local actions, and applying to a running Plugin follows the stopping procedure. If applying settings prevents startup, the Plugin stays faulted until the local operator explicitly restores the last working settings or corrects and reapplies them.

Execution continuity after a whole-Core restart is outside this decision; see [ADR-0015](0015-separate-start-stop-restart-and-reset.md).

Decision history:

- 20 September 2026: the user accepted active-work protection.
- 21 September 2026: the user accepted the stopping procedure for independent Plugin lifecycle actions while Core stays running.
- 22 September 2026: the user accepted the manual configuration-recovery policy.

## Rationale and alternatives

- Manual reruns keep recovery simple and avoid unintended repeated processing.
- Fault reporting with manual restart was selected instead of automatic restart or an elaborate recovery system.
- Continuous ingestion is not finite work that must finish naturally, so shutdown stops it rather than waiting for it.

## Consequences

- Plugin work stays separate from the Asset Tasks that produced its input Objects; stopping a Plugin does not alter those Tasks.
- A stop request alone is not proof that all effects have stopped, so confirmed outcomes and uncertainty are reported honestly.
- The external Command Interface can display faults but does not restart Plugins.
- Core does not automatically restore settings or restart after a failed apply, and configuration recovery never reruns failed Operations.
- Saved settings, running configuration and the last startup-validated revision are tracked separately.
- Shutdown deadlines and outcome fields remain implementation choices; configuration schema format, startup success criteria and detailed result fields remain open.
