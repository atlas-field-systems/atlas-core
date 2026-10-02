# Atlas domain

Atlas is a control plane for observing Entities, preserving operational data, and tasking Assets. These terms carry forward the source system's vocabulary for the reassessment; they do not select a technology stack or commit this repository to every capability.

## System and shared contracts

**Atlas Core**:
The system providing Atlas's Entities, Tasks and Objects APIs and their supporting capabilities. Its modules are distinct from the related SDK, Protocol and external Command Interface.
_Avoid_: the entire repository, one software module

**Command Interface**:
The operator-facing application that uses Atlas Core and presents supported capabilities, including any Plugin UI contributions.
_Avoid_: Core module, Core server

**Atlas Protocol**:
The shared specification of Atlas resources, operations, messages and externally observable guarantees.
_Avoid_: database schema, SDK implementation

**Atlas SDK**:
The supported general client library that participants on IP links without bandwidth limits, including applications, Plugins, IP-connected Assets and radio gateways, use to interact with Atlas Core.
_Avoid_: Protocol definition, Core implementation, Asset OS, radio protocol

**Asset client**:
The part of the Atlas SDK that owns all traffic originating from an Asset: registration, reports, assigned work and reconnect reconciliation.
_Avoid_: Asset OS, integration, gateway

**HTTP mode**:
The Atlas SDK mode that reads directly from Core on each request, without maintaining a Local operational picture.
_Avoid_: HTTP pass-through, API mode

**Full synchronization mode**:
The Atlas SDK mode that maintains a Local operational picture of the whole Dataset and answers reads from it.
_Avoid_: full sync, hybrid mode, replica mode

**Radio gateway**:
Software connecting Atlas Core with bandwidth-limited Assets over a radio transport while preserving Asset identity and the meaning of their Tasks and reports. It has its own identity and relays only for its bound Assets.
_Avoid_: Asset OS, Source Gateway, Core module

**Core release**:
A published edition of Core with its corresponding SDK and Protocol editions.
_Avoid_: Plugin release, deployment instance

**Installation**:
One Atlas deployment, the scope that Hard Reset clears. The installation of a single Plugin is a Plugin installation.
_Avoid_: Plugin installation, Core release

**Installation setup**:
The installation-scoped state that ordinary Reset retains: Operator profiles, credentials, Asset identity bindings, configuration, installed Plugins with their settings, and reference data.
_Avoid_: installation state, retained setup, startup setup

**Dataset**:
The operational state retained between Resets, independently of individual Core process runs.
_Avoid_: Asset runtime, Session API resource, SDK cache

**Dataset identity**:
The identifier that distinguishes one Dataset from its predecessors. It changes on Reset, so clients can recognise and discard state from an old Dataset.
_Avoid_: Core run, picture rebuild

**Mission**:
A field period, usually a few hours, during which Core stays continuously available. Restart, Reset and release updates happen outside Missions.
_Avoid_: Core run, Dataset

**Core run**:
One Core process lifetime, from Start until Stop or process exit. A Dataset may span several Core runs.
_Avoid_: mission, Dataset lifetime

**Restart**:
Stopping and starting Core while retaining its Dataset, installation setup and Atlas-managed diagnostic logs.
_Avoid_: Reset

**Reset**:
Stopping Core, clearing its operational Dataset and Atlas-managed diagnostic logs, and starting Core with a new Dataset while retaining installation setup.
_Avoid_: Restart, Hard Reset, backup restore

**Hard Reset**:
A local CLI/TUI action that stops Core and its managed Plugins, removes all Atlas-managed operational state and installation setup, and returns Atlas to first-time setup. The Core software and unrelated host resources remain.
_Avoid_: ordinary Reset, software uninstall

**Core time**:
The installation's reference clock. Observation age, freshness and execution deadlines are judged in Core time; other participants estimate their offset from it.
_Avoid_: Asset clock, wall-clock time

**Activity history**:
The record of which authenticated caller (an operator client, local administrator, Asset, Plugin or gateway) issued or cancelled Atlas Tasks, retired Assets or changed Plugins, credentials or configuration, retained until Reset.
_Avoid_: diagnostic logs, movement history, complete telemetry history

## Resources and tasking

**Entity**:
A represented participant, observed subject, or spatial designation in Atlas. Every Entity is an Asset, Track, or Geofeature; its identity and type never change.
_Avoid_: database row

**Component**:
A named part of an Entity's data, such as its position, Operational status or Command support.
_Avoid_: database column, arbitrary JSON value

**Observed data**:
Entity data describing an observed subject, authored only by its Track publisher.
_Avoid_: Reported data, Descriptive data

**Reported data**:
Entity data an Asset authors about itself, including its Operational status and Command support.
_Avoid_: Observed data, Descriptive data

**Descriptive data**:
Entity data that operators edit, such as an Alias, protected against conflicting concurrent edits.
_Avoid_: Reported data, Observed data

**Derived data**:
Entity data Core computes, such as Contact and Communication state. No participant writes it directly.
_Avoid_: Reported data

**Alias**:
An optional, editable Entity name, unique across Entity types. Relationships use permanent Entity identities.

**Operational status**:
An Asset's reported operational condition, from `unknown` through `stopped`. It does not establish a Task outcome or prove current Contact.
_Avoid_: Asset status

**Communication state**:
Core's assessment of the quality of its link with an Asset, from `high_bandwidth` to `offline`. It is derived by Core, never reported by the Asset.
_Avoid_: connectivity, connection state, communications, Asset status

**Contact**:
Core's record of the latest fresh accepted report from an Asset, shown as its last-seen time. Duplicates, historical backlog and Core's own changes never refresh it.
_Avoid_: heartbeat packet, Communication state

**Asset report acceptance**:
Core's decision to record an authenticated Asset report and its valid effects, distinguishing report identity, ordering of reported facts and evidence of fresh contact. Accepting a historical outcome does not establish current contact.
_Avoid_: Task acceptance, proof of execution, heartbeat alone

**Asset**:
An Entity representing a taskable or reporting system participating in Atlas.
_Avoid_: Plugin, device record

**Asset retirement**:
The administrative withdrawal of an Asset from participation while retaining its Entity and execution evidence. A retired Asset receives no new Tasks; retirement does not establish that physical execution stopped.
_Avoid_: Entity deletion, Operational status, Task cancellation, physical stop

**Enrollment**:
Giving an Asset an authenticated identity bound to its Asset ID. The binding belongs to the Installation and survives Reset.
_Avoid_: Asset registration

**Open enrollment**:
A local testing setting in which any connecting Asset is enrolled without deployment authorization. Each Asset still receives its own identity, and revoked identities stay revoked.
_Avoid_: disabled authentication, anonymous Assets

**Asset registration**:
Creating an Asset's Entity in the current Dataset under its enrolled identity. Registration is not a report; Reset clears it.
_Avoid_: Enrollment, Check-in

**Asset Host**:
The computer hosting the Asset-side software for one Asset; it does not mean the Atlas Core server. Attached controllers, sensors, and radios are its peripherals.
_Avoid_: Asset cluster

**Asset OS**:
The Asset-side software that owns scheduling, execution, interruption and connected/offline behavior. Also written "Asset operating system"; its implementation is outside Atlas Core.
_Avoid_: Atlas Core, server scheduler

**Check-in**:
An Asset's report of its current Entity data, establishing Contact when fresh. It does not deliver or reconcile Tasks.
_Avoid_: reconnect reconciliation, heartbeat packet, registration

**Reconnect reconciliation**:
The workflow in which a reconnecting Asset checks in, catches up on its current Tasks, cancellations and queue revisions, and reports outcomes of work performed while away.
_Avoid_: check-in, replaying every historical instruction

**Track**:
An Entity representing an observed subject, whether stationary or moving. A detected house is a Track.
_Avoid_: Asset, stream item

**Track publisher**:
The single source responsible for a Track's Observed data, whose identity is distinct from an individual Plugin installation. It is distinct from an operator editing Descriptive data and from any External sources it consults.
_Avoid_: descriptive editor, Task assignee

**Geofeature**:
An Entity representing a defined spatial designation, such as a zone or rally point, with point, line, or polygon geometry.
_Avoid_: Asset, Track

**Command**:
A Protocol-defined intent that a supporting Asset can execute, with defined inputs and observable behavior.
_Avoid_: arbitrary function, Task

**Command Catalog**:
The Protocol-owned collection of Command definitions and schemas. Assets declare which Commands they support; they do not invent additional catalog entries.

**Task**:
One request to execute a Command on one assigned Asset, with a recorded lifecycle and outcome.
_Avoid_: Command definition, mutable assignment

**Required result**:
An Object the assigned Asset declares its Task needs before the Task can be Completed.
_Avoid_: attachment, optional result

**Required-result protection**:
Keeping a Required result from being deleted from the acceptance of its declaration until Reset, even after the Task ends.
_Avoid_: Object lock

**Collection finished**:
The end of a scan's data gathering, reported by its Asset. Its Required results may still be uploading.
_Avoid_: Completed Task, Task lifecycle status

**Task scheduling**:
The selection of queued execution or immediate handling for a Task, within the Command and Asset's supported behavior.

**Queued Task**:
A Task the Asset executes in order with its other queued Tasks.
_Avoid_: pending Task

**Immediate Task**:
A Task the Asset handles promptly on receipt, outside its queue order. Pause and Resume are Immediate Tasks.
_Avoid_: priority Task, guaranteed instant execution

**Queue revision**:
A requested change to the order of an Asset's unstarted Queued Tasks. Core records it separately from the order the Asset confirms adopting.
_Avoid_: confirmed order, execution order

**Pause Command**:
An immediate Command that suspends the Asset's current Queued Task and leaves the Asset waiting in its own idle behavior, preserving the remaining queue.
_Avoid_: cancellation, emergency stop, merely waiting for current work to finish

**Resume Command**:
An immediate Command that releases an Asset's paused condition and continues its suspended Task before the remaining queue. A Task that cannot safely resume reports failure, and the Asset stays paused.
_Avoid_: recreating or automatically rerunning suspended work

**Paused Task**:
A Task whose execution the Asset has confirmed is suspended, also called a suspended Task; it remains nonterminal and retains its progress.
_Avoid_: an unstarted Task, a cancelled Task, an interrupted Task

**Task cancellation request**:
A request to withdraw a Task, represented by its nonterminal Cancellation requested status. The request does not establish that execution stopped; Cancelled requires Asset confirmation.
_Avoid_: Cancelled, proof that execution stopped

**Cancellation declined**:
An Asset's report that it cannot withdraw a Task, returning the Task to the execution status its reports establish. The refusal remains part of the Task's record.
_Avoid_: Failed, Cancelled

**Object**:
Stored file content and associated descriptive metadata, published when ready for use. Content is immutable; metadata can change. An Object can reference related Entities and Tasks.
_Avoid_: Entity, arbitrary JSON value

**Movement sample**:
A report of one or more of an Entity's position, speed, or altitude, with observation time when known and the time Atlas received it.
_Avoid_: complete Entity snapshot

**Local operational picture**:
The SDK's latest-known view of Entities, Tasks and Object metadata maintained from Core changes. It may lag while changes are in transit or synchronization is interrupted.
_Avoid_: full picture, synchronized picture, shared picture, SDK picture

**Operator**:
A person using Atlas, represented by identity information such as a name and personal settings.
_Avoid_: permission role

## Extensions and external data

**Plugin**:
An Atlas-managed extension that offers Plugin capabilities, processes Atlas data, or gathers External source data. It is not itself taskable.
_Avoid_: Asset, External source

**Plugin capability**:
Something a Plugin offers for invocation through Atlas. Each invocation is a separate Operation.
_Avoid_: Operation, arbitrary endpoint

**Operation**:
One submitted invocation of a Plugin capability, with its own identity, lifecycle and outcome. A deliberate rerun is a new Operation. Its processing can continue independently of the invoking operator’s connection.
_Avoid_: Operation attempt, Plugin capability, Atlas Task, Asset Command, Datastream

**Interrupted Operation**:
An Operation whose outcome Core can no longer establish. It is terminal and records uncertainty, not proof that nothing happened.
_Avoid_: Paused Task, suspended Task, Failed

**External source**:
A system outside Atlas from which a Plugin obtains data.
_Avoid_: Plugin, Datastream

**Plugin release**:
An immutable version of one Plugin that can be published and installed independently of a Core release, subject to its declared contracts.
_Avoid_: Core release, running Plugin

## Historical source vocabulary

These terms describe Modernization research. They do not name required successor components or selected capabilities.

**Source connector**:
In Modernization, Atlas-managed access to one External source. The Plugin owns the source-specific meaning of the data.
_Avoid_: Plugin, data model

**Source Gateway**:
In Modernization, the component through which Plugins use Source connectors without receiving External source credentials.
_Avoid_: Edge Gateway, data normalizer

**Datastream**:
In the Modernization model, a named data product published by a Plugin for clients to consume without exposing an External source directly.
_Avoid_: Core change feed, External API
