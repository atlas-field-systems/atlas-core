---
status: accepted
---

# Core owns Commands and Assets execute Tasks

Core owns the Command catalog and its semantics; Assets execute supported Commands through Tasks. Plugins cannot introduce Asset Commands or receive Tasks as Tool Assets. The user selected this boundary on 20 September 2026 to keep Asset tasking separate from extension invocation and processing.

Plugins may process Objects produced by Asset Tasks, expose Operations whose accepted work continues independently of the caller connection, or gather external data and publish Entities or Objects. Their own processing and ingestion are Plugin work, not Atlas Tasks. The Protocol represents the shared tasking contracts and the SDK exposes them; exact schema and code placement remain implementation choices.

An area-search Operation or an ongoing aircraft-data source does not require a taskable Plugin Entity. Plugin-specific inputs and result formats belong to the extension contract. This replaces the source system's Tool Asset model for the successor.

The scan example is an operator-issued Asset Task producing an Object, followed by a separately invoked Plugin Operation that processes that Object. Plugins may also initiate Tasks for Assets using existing Core-defined Commands through the SDK, without requiring an operator to issue each Task. The user explicitly selected this permission even though an autonomous-tasking Plugin is not planned immediately. Core must not prohibit tasking because the caller is a Plugin. This does not permit Plugins to introduce new Asset Commands or become Task targets.
