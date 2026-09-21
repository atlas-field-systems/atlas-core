---
status: superseded by ADR-0013
---

# Retain durable activity history

Superseded: [ADR-0013](0013-start-each-core-run-with-empty-data.md) requires every Core restart to wipe data. Activity history remains useful only within the current run. The original cross-run durability decision below is historical.

Core retains a durable history of who issued or cancelled Tasks and who changed Plugins, credentials or configuration. The user selected this on 20 September 2026 so these actions can be reconstructed after they occur. Diagnostic logs do not satisfy this requirement.

The owning modules supply the action and affected resource; Identity and access supplies the caller identity. Activity history records must not include secret values. Retain activity history by default across operating sessions, with no automatic age-based deletion. Query interfaces, explicit deletion, consistency with the recorded action and behavior when history cannot be stored remain to be designed. The requirement does not imply recording every telemetry sample.
