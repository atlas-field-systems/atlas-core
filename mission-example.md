# Mission example

**An operator uses Atlas Mission and two drones to inspect a road.** This example
uses the initial Move To, Pause, and Resume Commands. It adds no area-search Command.

Atlas Mission is the separate operator UI described in the
[operating environment](operating-environment.md). It uses SDK Full mode for its
map and Task list. Here, a mission is the operator's field activity. Core retains
its Entities, Tasks, and Objects; each drone's runtime owns physical execution.

## Prepare the installation

Before the mission, the team updates Core if needed and performs the required
Reset through local administration. Core stays on that release for the mission.
[Updates happen between missions](Atlas%20Core/lifecycle.md).

The operator opens Mission and connects through SDK with an API key. An external
gateway registers Drone 1 and Drone 2 as Assets and submits their reports. Mission
displays accepted positions, capabilities, and contact state. The gateway handles radio.

## Queue movement

The operator saves two point Geofeatures, Road Entrance and Road Bend. Mission
queues Move To Road Entrance followed by Move To Road Bend for Drone 1. It queues
Move To Road Bend for Drone 2. Core validates and retains the Tasks and requested order.

Each drone retrieves its assigned work through the gateway. Drone 1 executes its
first movement and then the second. Its runtime plans the route, schedules work,
and decides arrival. Two accepted destinations do not cause Core to reject a
movement conflict or divert the drone. Mission displays accepted execution reports.

## Pause and resume

The operator requests Pause for Drone 1. Core records the control; Mission shows
it as requested until the drone reports actual suspension. Later queued work stays
blocked, including work submitted after Pause. Resume continues suspended work
first, or starts the next eligible Task if that work has ended. The Asset checks
current instructions before unpausing. [Task rules](Atlas%20Protocol/tasks.md) own the details.

## Share observations and files

Drone 1 detects a vehicle and creates Observation 1 through the gateway. Drone 1
remains its publisher. Core's built-in policy creates Track 1 in the same commit.
Mission shows that Track with its source Observation and original measurement time.

As the vehicle moves, Drone 1 reports new evidence under Observation 1. Core updates
Track 1 without changing either ID. Replaying a report creates no new movement.
An independent detection by Drone 2 creates a separate Observation and Track.
The initial policy does not match targets across publishers.

Drone 1 uploads a photograph as an Object associated with Observation 1. Mission
follows Track 1's source association to retrieve it. A delayed upload does not
prevent the Observation and Track from appearing.

## Edit a waypoint

The operator moves Road Bend's point. Core stores a new geometry revision under
the same Geofeature ID. Both Tasks referencing Road Bend keep that reference.

Drone 1 adopts the new revision. Drone 2 keeps its original revision. These are
Asset choices. Saving the edit does not prove adoption; a report identifying the
revision actually used supplies that evidence. Core does not infer a flight change.

## Cancel while a drone is unreachable

Drone 2 disappears behind terrain for about five minutes. Mission retains its
last-known position with contact state supplied by Core. The operator requests
cancellation of its Move To Task. Core commits `cancellation_requested`.

Mission immediately shows **Cancellation requested** after Core confirms the save,
even if its local picture has not received the change. An older picture cannot
revert that confirmed display. SDK's picture still updates only through synchronization.

The Task remains cancellation-requested while Drone 2 is unreachable. On reconnect,
the drone handles the request and reports `cancelled` after cancellation takes effect.
Mission shows **Cancelled** when its picture receives that committed outcome.

If the drone completed first, Core accepts its completion instead. Explicit refusal
restores the reported execution state; ordinary progress cannot erase the request.
If the save reply is lost, Mission shows an unconfirmed save and reconciles using
the original cancellation request identity. [Task cancellation](Atlas%20Protocol/tasks.md#creation-and-state)
defines the confirmation loop.

## Finish the mission

Drone 1 reports completion. Core records `completed`, and Mission shows the result
when its picture receives the change. Result files can arrive afterward without
changing that Task outcome.

Closing Mission leaves Core running. External field procedures end the operation.
Observations and Tracks retain their identities, history, and associations until
Reset. They have no individual delete. A Core update requires Reset and clears
this mission's operational data.
