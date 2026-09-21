---
status: accepted
---

# Protect active Plugin work during lifecycle changes

A planned Plugin stop or update stops admitting new Operations, asks continuous ingestion to stop, and waits for finite active Operations to finish or be explicitly canceled. The user accepted active-work protection on 20 September 2026 and this stopping procedure on 21 September 2026. After a Plugin crash while Core remains in the same run, reconcile recorded work and outcomes. Execution continuity after a whole-Core restart is outside scope; see [the lifecycle decision](0015-separate-start-stop-restart-and-reset.md). Once a Plugin Operation is known to have failed, retain its failure and require an explicit operator rerun; restarting the Plugin must not automatically retry that Operation. The user selected manual reruns to keep recovery simple and avoid unintended repeated processing.

Plugin work is separate from the Asset Tasks that produced its input Objects. Stopping a Plugin does not alter those Tasks or their execution outcomes; Core and the assigned Asset retain their tasking responsibilities. The continuous ingestion loop stops as part of Plugin shutdown; it is not finite work that must finish naturally. Cancellation remains a request until its outcome is confirmed. Known outputs and effects remain available even when an Operation fails or is interrupted. Recovery must not blindly reissue Asset Commands.

For both processing Plugins and continuous-source Plugins, Core reports a fault and offers a manual restart. The user selected this simple policy instead of automatic restart or an elaborate recovery system. Restarting a Plugin and rerunning a failed Operation remain separate actions; the external Command Interface can display faults, while Plugin restart and force stop are local CLI/TUI actions. Public API and SDK consumers can cancel individual Operations but cannot manage Plugin processes.

If the Plugin cannot stop cooperatively, Core reports the problem and permits an explicit operator force stop. A force stop must not be reported as successful Operation completion. Report confirmed outcomes and any uncertainty about interrupted work honestly; a stop request alone is not proof that all effects have stopped. Shutdown deadlines and outcome fields remain implementation choices. This stopping procedure was accepted on 21 September 2026 and applies to independent Plugin lifecycle actions while Core stays running.
