---
status: accepted
---

# Release Core, SDK and Protocol together

Atlas Core is a system, not a single software module. Core, its SDK and its Protocol are developed as closely linked parts and released through one coordinated workflow with the same version number. A Core release of `0.1.6` also publishes SDK `0.1.6` and Protocol `0.1.6`, even when a component's implementation or contract has not changed. The user selected this on 20 September 2026 to make the corresponding released components unambiguous instead of maintaining independent version sequences.

The shared number identifies the release those artifacts belong to. Runtime version equality is not required: [compatible client versions are allowed](0005-allow-compatible-client-versions.md). The supported upgrade overlap remains to be designed. Plugins retain independent release versions. This decision does not yet assign the Command Interface or field software to the shared version sequence, and it does not settle module or subsystem boundaries.
