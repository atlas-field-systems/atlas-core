# Atlas Core

> Planning-session record, pending reconciliation with the architecture merged in PR #1. "Approved" and "agreed" below describe this session; they do not supersede existing ADRs. See [conflicts and document authority](planning-reconciliation.md).

Atlas Core manages shared operational information and the instructions used to task things in that environment.

## Language

**Entity**:
A represented participant, observed subject, or spatial feature in Atlas. Every Entity is one of three types: Asset, Track, or Geofeature. Its identity and type never change.

**Alias**:
An optional, editable name that identifies one Entity across Atlas, ignoring case. Relationships refer to the Entity's permanent identity rather than its alias.

**Asset**:
An Entity representing a taskable or reporting system participating in Atlas. Every Asset has an Asset status and authors its own reported state; Operators direct it through Tasks.

**Asset status**:
The condition reported for an Asset, used to describe its availability and ability to perform work. It does not by itself establish the outcome of a Task.

**Track**:
An Entity representing an observed subject, whether stationary or moving. A detected house is a Track.

**Geofeature**:
An Entity representing a defined spatial designation, such as a zone or rally point. Every Geofeature has point, line, or polygon geometry.
_Avoid_: Geological area, detected house

**Command**:
A Protocol-defined type of operational instruction expressing operator intent, such as scan area, move to, takeoff, land, or return to launch.

**Command Catalog**:
The Protocol-owned collection of Commands and their schemas. Assets declare which Commands they support; they do not add Commands to the catalog.

**Task**:
One execution of one Command assigned to one Asset. Its assigned Asset never changes; the Asset queues its Tasks and executes them one at a time, by default in submission order. Acknowledged means the Asset accepted the Task into its queue; in progress means execution has begun.
_Avoid_: Background job, generic software operation

**Cancellation request**:
A request to withdraw a Task. For work already accepted by an Asset, the request does not establish that execution stopped; cancellation requires confirmation from the Asset.

**Object**:
Stored file content and its associated metadata, flexible enough to hold any file type the operational environment needs. Once supplied, the file content is immutable; descriptive metadata can change. An Object can reference zero or more related Entities and Tasks.
_Avoid_: Entity, generic structured record

**Local operational picture**:
The SDK's latest-known view of Entities, Tasks, and Object metadata, maintained from Atlas Core changes for local reads. It can lag behind Core while changes are in transit or synchronization is interrupted.

**Operator**:
A person using Atlas, represented by identity information such as a name and personal settings.
_Avoid_: Permission role

**Plugin**:
An extension to Atlas that Core installs, runs, and configures, and that follows a defined structure and lifecycle contract.
