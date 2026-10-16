# Entities and observations

**An Entity has one immutable ID and type: Asset, Track, or Geofeature.**
Deleted IDs remain reserved for the Dataset. Optional aliases are unique across
Entity types, ignoring case.

## Component composition

Protocol owns the JSON structure, types, and meaning of each reusable component.
Define Position once and reference it wherever a named position appears, including
Telemetry and Command inputs. Define Telemetry, Communications, Heartbeat, and
Geometry as named schemas with documented fields, units, required values,
omission/null rules, bounds, and independent valid and invalid examples.

Concrete Asset, Track, and Geofeature schemas select their allowed and required
components through named properties. Assets require status, communications, and
heartbeat information; Geofeatures require geometry. Assets and Tracks reuse the
same applicable Telemetry definitions. The Entity type determines which components
are legal; composition does not permit arbitrary fields or a dynamic component registry.

Use ordinary schema references rather than copying field definitions. Generated
Go and TypeScript declarations come from these schemas. SDK helpers construct and
read the defined JSON; they do not own a second definition of its structure.

## Data ownership

Descriptions use explicit edits. Asset execution and telemetry use reports,
directly or through a gateway. Any valid API key can submit either kind of change.
Track observations retain their publisher identity. Core derives contact and ordering.
Registration may supply an initial description and capability manifest; later
reports cannot quietly edit descriptions.

Keep these mutation classes separate. Descriptive Entity edits carry
`expected_edit_revision`; telemetry does not invalidate that revision. A competing
description edit does. Validate the complete candidate and commit all or nothing.

Optional Track geometry, media references, military display data, and sensor
references use defined components, not arbitrary Plugin fields. Task state is not
an Entity component.

## Tracks

Each Track has one stable publisher identity, separate from an API credential or
Plugin installation. A drone owns its detections even when a gateway delivers them.
Changing gateways or API keys does not change the publisher. Reinstallation names
an existing publisher explicitly; matching a display name does not establish identity.

There is no automatic publisher transfer, Track fusion, or expiry. Silent Tracks
remain last-known observations until deletion or Reset. A fusion process publishes
a new Track. Command-specific age requirements still apply to using a Track.

Order observations per quantity, not by whole-resource arrival time. Preserve
observation identity, sequence, source time, and correction revision. A correction
changes the currently accepted observation, not its original age. Reject conflicting
identity reuse; an older observation cannot overwrite newer state.

## Geometry and references

A geometry edit increments its own revision. A Task can reference a Geofeature
by ID; editing its geometry leaves that reference intact. Core stores the edit.
The external Asset runtime decides whether and how to apply changed geometry.
Saving geometry is not proof that an Asset applied it. If execution evidence
identifies the revision used, retain that evidence.

Retain reported geometry-revision evidence until Reset, not necessarily every old
polygon. Historical geometry reconstruction is not promised.

Required Track/Geofeature references prevent deletion while a relevant Task is
nonterminal, including paused, cancellation-requested, or retired-Asset work.
Terminal Tasks release these guards. File protection follows different rules.

## Spatial conventions

Named positions use WGS84 `latitude` and `longitude` in degrees. GeoJSON uses
longitude first. Position is a complete pair; zero is valid. Use double precision,
metres, metres per second, and true-north headings in `[0,360)`.
Altitude explicitly names `wgs84_ellipsoid`; do not silently substitute AGL or MSL.
Uncertainty is nonnegative and separate from clock handling.

[Next: identity](identity.md)
