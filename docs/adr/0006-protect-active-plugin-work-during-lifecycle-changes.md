---
status: accepted
---

# Protect active Plugin work during lifecycle changes

A planned Plugin stop or update is blocked while its work is active, until that work finishes or the operator explicitly cancels it. The user accepted this on 20 September 2026. After a Plugin crash while Core remains in the same run, reconcile recorded work and outcomes. This clause does not specify recovery of execution after a whole-Core restart; see [the lifecycle decision](0015-separate-start-stop-restart-and-reset.md). Once a Plugin Operation is known to have failed, retain its failure and require an explicit operator rerun; restarting the Plugin must not automatically retry that Operation. The user selected manual reruns to keep recovery simple and avoid unintended repeated processing.

Plugin work is separate from the Asset Tasks that produced its input Objects. Stopping a Plugin does not alter those Tasks or their execution outcomes; Core and the assigned Asset retain their tasking responsibilities. The lifecycle design must define how dependent results are handed off or kept pending, what counts as active work for ongoing ingestion, and when cancellation is complete. Recovery must not blindly reissue Asset Commands.

For both processing Plugins and continuous-source Plugins, Core reports a fault and offers a manual restart. The user selected this simple policy instead of automatic restart or an elaborate recovery system. Restarting a Plugin and rerunning a failed Operation remain separate actions; the external Command Interface exposes fault information and a restart action through its Plugins menu.
