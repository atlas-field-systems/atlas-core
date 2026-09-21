---
status: accepted
---

# Operate without internet access

An installed Atlas system must support local authentication, tasking, Objects and synchronization without internet access, provided its operators and Assets can reach Core. The user selected this for local coordination sessions typically lasting a few hours, so a required cloud service must not prevent ordinary Core operation. Plugins that use internet services retain their own external dependencies without imposing them on Core.

This decision concerns operation of an installed system, not air-gapped package acquisition or updates. Protocol and SDK consumers must be able to use the locally reachable Core under this deployment model.
