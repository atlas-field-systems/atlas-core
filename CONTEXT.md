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
The supported client library that external applications, Assets and Plugins are expected to use to interact with Atlas Core.
_Avoid_: Protocol definition, Core implementation

**Core release**:
A published edition of Core with its corresponding SDK and Protocol editions.
_Avoid_: Plugin release, deployment instance

**Dataset**:
The operational state retained between Resets, independently of individual Core process runs.
_Avoid_: Asset runtime, Session API resource, SDK cache

**Core run**:
One Core process lifetime, from Start until Stop or process exit. A Dataset may span several Core runs.
_Avoid_: mission, Dataset lifetime

**Restart**:
Stopping and starting Core while retaining its Dataset, installation setup and Atlas-managed diagnostic logs.
_Avoid_: Reset

**Reset**:
Stopping Core, clearing its operational Dataset and Atlas-managed diagnostic logs, and starting Core with a new Dataset while retaining installation setup.
_Avoid_: Restart, backup restore

**Activity history**:
The record of who issued or cancelled Atlas Tasks and who changed Plugins, credentials or configuration, retained until Reset.
_Avoid_: diagnostic logs, movement history, complete telemetry history

## Resources and tasking

**Entity**:
A represented participant, observed subject, or spatial designation in Atlas. Every Entity is an Asset, Track, or Geofeature; its identity and type never change.
_Avoid_: database row

**Alias**:
An optional, editable Entity name, unique across Entity types ignoring case. Relationships use permanent Entity identities.

**Asset status**:
An Asset's reported operational condition. It does not establish a Task outcome or prove current contact.

**Asset**:
An Entity representing a taskable or reporting system participating in Atlas.
_Avoid_: Plugin, device record

**Asset Host**:
The computer hosting the Asset-side software for one Asset; it does not mean the Atlas Core server. Attached controllers, sensors, and radios are its peripherals.
_Avoid_: Asset cluster

**Asset OS**:
The Asset-side software that owns scheduling, execution, interruption and connected/offline behavior. Also written "Asset operating system"; its implementation is outside Atlas Core.
_Avoid_: Atlas Core, server scheduler

**Track**:
An Entity representing an observed subject, whether stationary or moving. A detected house is a Track.
_Avoid_: Asset, stream item

**Geofeature**:
An Entity representing a defined spatial designation, such as a zone or rally point, with point, line, or polygon geometry.
_Avoid_: Asset, Track

**Command**:
A Core-defined intent that a supporting Asset can execute, with defined inputs and observable behavior.
_Avoid_: arbitrary function, Task

**Command Catalog**:
The Protocol-owned collection of Command definitions and schemas. Assets declare which Commands they support; they do not invent additional catalog entries.

**Task**:
One request to execute a Command on one assigned Asset, with a recorded lifecycle and outcome.
_Avoid_: Command definition, mutable assignment

**Task scheduling**:
The selection of queued execution or immediate handling for a Task, within the Command and Asset's supported behavior.

**Pause Command**:
An immediate Command that interrupts the Asset's current queued Task and leaves the Asset waiting in its own idle or holding behavior, preserving the remaining queue.
_Avoid_: cancellation, emergency stop, merely waiting for current work to finish

**Resume Command**:
An immediate Command that releases an Asset's paused condition and continues its suspended Task before the remaining queue. A Task that cannot safely resume reports failure.
_Avoid_: recreating or automatically rerunning interrupted work

**Paused Task**:
A Task whose execution the Asset has confirmed is suspended; it remains nonterminal and retains its progress.
_Avoid_: an unstarted Task, a cancelled Task

**Task cancellation request**:
A request to withdraw a Task, represented by its nonterminal Cancellation requested status. The request does not establish that execution stopped; Canceled requires Asset confirmation.
_Avoid_: Canceled, proof that execution stopped

**Object**:
Stored file content and associated descriptive metadata, published when ready for use. Content is immutable; metadata can change. An Object can reference related Entities and Tasks.
_Avoid_: Entity, arbitrary JSON value

**Movement sample**:
A report of one or more of an Entity's position, speed, or altitude, with observation time when known and the time Atlas received it.
_Avoid_: complete Entity snapshot

**Local operational picture**:
The SDK's latest-known view of Entities, Tasks and Object metadata maintained from Core changes. It may lag while changes are in transit or synchronization is interrupted.

**Operator**:
A person using Atlas, represented by identity information such as a name and personal settings.
_Avoid_: permission role

## Extensions and external data

**Plugin**:
An Atlas-managed extension that exposes Operations, processes Atlas data, or gathers External source data. It is not itself taskable.
_Avoid_: Asset, External source

**Operation**:
An invocation of a Plugin capability through Atlas that produces a result. Its processing can continue independently of the invoking operator’s connection.
_Avoid_: Atlas Task, Asset Command, Datastream, arbitrary endpoint

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
