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

**Activity history**:
The record of who issued or cancelled Atlas Tasks and who changed Plugins, credentials or configuration, retained until Reset.
_Avoid_: diagnostic logs, movement history, complete telemetry history

## Resources and tasking

**Entity**:
An identified subject in Atlas's operational picture, such as an Asset, Track, or Geofeature.
_Avoid_: database row

**Asset**:
An Entity representing a taskable or reporting system participating in Atlas.
_Avoid_: Plugin, device record

**Asset Host**:
The one computer running the Atlas process for one Asset. Attached controllers, sensors, and radios are its peripherals.
_Avoid_: Asset cluster

**Track**:
An Entity representing an observed moving subject.
_Avoid_: Asset, stream item

**Geofeature**:
An Entity representing a spatial feature or area.
_Avoid_: Asset, Track

**Command**:
A Core-defined intent that a supporting Asset can execute, with defined inputs and observable behavior.
_Avoid_: arbitrary function, Task

**Task**:
One request to execute a Command on one assigned Asset, with a recorded lifecycle and outcome.
_Avoid_: Command definition, mutable assignment

**Object**:
A named resource describing operational data, which may have associated content.
_Avoid_: Entity, arbitrary JSON value

**Movement sample**:
A report of one or more of an Entity's position, speed, or altitude, with observation time when known and the time Atlas received it.
_Avoid_: complete Entity snapshot

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

**Source connector**:
Atlas-managed access to one External source. The Plugin owns the source-specific meaning of the data.
_Avoid_: Plugin, data model

**Source Gateway**:
The Atlas component through which Plugins use Source connectors without receiving External source credentials.
_Avoid_: Edge Gateway, data normalizer

**Datastream**:
A named data product published by a Plugin for clients to consume without exposing an External source directly.
_Avoid_: Core change feed, External API

**Plugin release**:
An immutable version of one Plugin that can be published and installed independently of a Core release, subject to its declared contracts.
_Avoid_: Core release, running Plugin
