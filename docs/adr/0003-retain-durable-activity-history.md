---
status: superseded by ADR-0015
---

# Retain durable activity history

Historical decision. [ADR-0013](0013-start-each-core-run-with-empty-data.md) first replaced this policy with wipe-on-start behavior; [ADR-0015](0015-separate-start-stop-restart-and-reset.md) now retains activity history across ordinary stops and restarts and clears it on Reset. The original text below is not the current retention specification.

Core retains a durable history of who issued or cancelled Tasks and who changed Plugins, credentials or configuration. The user selected this on 20 September 2026 so these actions can be reconstructed after they occur. Diagnostic logs do not satisfy this requirement.

The owning modules supply the action and affected resource; Identity and access supplies the caller identity. Activity history records must not include secret values. Retain activity history by default across operating sessions, with no automatic age-based deletion. Query interfaces, explicit deletion, consistency with the recorded action and behavior when history cannot be stored remain to be designed. The requirement does not imply recording every telemetry sample.
