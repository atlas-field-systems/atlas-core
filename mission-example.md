# Mission example

**Draft scenario. An operator uses Atlas Mission and two drones to search a valley
for a missing vehicle.** This example makes the intended responsibilities concrete
so they can be discussed before implementation.

Atlas Mission is assumed to be the separate operator UI described in the
[operating environment](operating-environment.md). For this draft it uses SDK Full
mode for its map and Task list. The drones have an illustrative area-search
capability; its exact Command and inputs still need a Protocol definition.
Here, a mission is the operator's field activity. Core stores its Entities, Tasks,
and Objects.

## Prepare the installation

Before the mission, the team updates Core if needed and performs the required
Reset through local administration. Core stays on that release for the mission.
[Updates happen between missions](Atlas%20Core/lifecycle.md).

The operator opens Atlas Mission and connects to Core through SDK with an API key.
An external gateway registers Drone 1 and Drone 2 as Assets and submits their
reports. Mission displays the accepted positions, capabilities, and contact state.
The gateway handles radio; each drone's runtime owns flight and execution.

## Define the search and assign work

The operator draws a polygon called Valley Search in Mission. SDK sends the edit
to Core, which stores it as Geofeature 1. Mission displays the saved shape.

The operator assigns each drone a search Task referencing Geofeature 1 and the
description of the missing vehicle. Core validates and stores the two Tasks.
Each drone retrieves its assigned work through the gateway and interprets the
search instruction. Route planning and detection happen in the drone's runtime.
Mission displays Task progress from accepted reports.

## Share observations and files

Drone 1 detects a possible match and publishes Track 1 through the gateway.
The publisher remains Drone 1. Mission shows its reported location and observation
time. Core retains the reported observation.

Drone 1 also uploads a photograph as an Object associated with Track 1. Once the
complete file is published, Mission can retrieve and display it. The operator
reviews it to assess whether it matches the missing vehicle. A delayed upload
does not prevent the Track from appearing.

## Edit the search area

The operator extends Valley Search to include a nearby road. Core stores a new
geometry revision under the same Geofeature ID. Both Tasks still reference it.

For this scenario, Drone 1's runtime adopts the changed shape. Drone 2's runtime
keeps the geometry it selected when it began. These are illustrative Asset choices,
not Core policies. A saved shape alone does not tell Mission which shape a drone
is using; a report identifying that revision supplies the evidence.

## Cancel while a drone is unreachable

Drone 2 disappears behind terrain for about five minutes. Mission retains its
last-known position with the contact state supplied by Core.

The operator requests cancellation of Drone 2's search Task. Core commits
`cancellation_requested`. Mission immediately shows **Cancellation requested** once
Core confirms the save, even if its local picture has not received the change yet.
The Task stays in that state while the drone is unreachable.

On reconnect, Drone 2's external runtime retrieves the request and handles
cancellation. It then reports `cancelled` to Core. Core accepts the report and
records `cancelled`; Mission shows **Cancelled** when its picture receives that
change. [Task rules](Atlas%20Protocol/tasks.md) define this confirmation loop.

If Drone 2 instead finished before receiving the request, it reports `completed`.
Core records **Completed**, superseding the cancellation request. Mission shows
the actual outcome. An explicit refusal instead restores the reported execution
state, so Mission can show that the Task is still active.

If the request's save reply is lost, Mission shows that the save is unconfirmed.
Reconciliation uses the original cancellation request identity.

## Finish the mission

Drone 1 reports its search complete. Core records `completed`, and Mission shows
the result when its picture receives the change. Any remaining result files can
arrive later without changing that Task outcome.

Closing Mission leaves Core running. The team ends the field operation through
its external operating procedures. A later Core update may clear this mission's
data; preserving it across updates is not part of this workflow.

## Show confirmed status immediately

Mission displays **Cancellation requested** immediately after Core confirms the
request. Its older local picture must not revert that display. Once the picture
includes the committed change, Mission uses its normal live view. **Cancelled**
requires the later Asset confirmation recorded by Core. The SDK picture itself
continues to update only through synchronization.
