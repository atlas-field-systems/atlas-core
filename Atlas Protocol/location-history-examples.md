# Asset location acceptance examples

These are expected outcomes for [location history](location-history.md), not
runtime test results. P42, A40, and similar labels below stand for exact UUIDs.
Source sequence and correction revision are independent of section delivery order.

## New position with older altitude

Asset A currently selects P41 revision 1 and A40 revision 1. A complete current
report supplies new position evidence P42 at 10:05, speed 3, and repeats the
original A40 context at 10:00. The result selects P42 and A40. Only P42 is added.
The altitude retains its identity, time, and revision. A new stationary P43 at the
same coordinates is separate evidence if its original identity is new.

Abbreviated sync commit for that report. Other final Asset fields and reading
source metadata are elided. The altitude target already exists in the picture.

```json
{
	"readings": [{
		"id": "00000000-0000-4000-8000-000000000042",
		"asset_id": "00000000-0000-4000-8000-000000000001",
		"kind": "position", "revision": "1",
		"observed_at": "2026-10-18T10:05:00Z", "time_usability": "known",
		"value": {"latitude": 51.5, "longitude": -0.1}
	}],
	"assets": [{
		"id": "00000000-0000-4000-8000-000000000001", "version": "42",
		"telemetry": {
			"position_ref": {"id": "00000000-0000-4000-8000-000000000042", "revision": "1"},
			"altitude_ref": {"id": "00000000-0000-4000-8000-000000000040", "revision": "1"},
			"ground_speed": 3
		}
	}]
}
```

A later description, status, or speed-only change reuses those references and
sends no reading images. HTTP and public SDK reads expand both referenced values.

## Backfill, correction, and replay

A historical P39 observed at 09:59 arrives after P42. It adds one reading and one
ordinary journal commit. Current remains P42 and A40, with no Asset change.
Correct P42 to revision 2 with longitude -0.2. The same commit replaces P42's
accepted revision, advances Asset version 42 to 43, and selects P42 revision 2.
P42 retains its original process, evidence identity, and 10:05 source time.
An exact replay adds no reading or journal event. Reusing revision 2 with longitude
-0.3 conflicts. Relaying revision 2 through another key or gateway changes nothing.

## Unknown, errors, and invalid references

A new current P44 with null value and null source time is a retained `unknown`
reading. Telemetry selects P44 revision 1 through a non-null reference and keeps
the A40 altitude reference. Expanded position is null. A telemetry error exposes only
the error, with no usable location references or fallback to P42. Readings remain.

An image referencing A40 as position, another Asset's reading, a missing reading,
or an absent revision fails the entire commit. The prior picture, applied Core
cursor, and journal stay unchanged. Staging permits referring Assets to arrive
before their targets, but a complete snapshot cannot publish unresolved references.

## Deleted known-empty and stable pages

Delete Asset D before it has location readings. An initial capture and a rebuilt
picture contain D's tombstone. D's history is a known empty result. An unregistered
ID U is unknown. Deleting A preserves P39, P41, P42, A40, and other readings
accepted before deletion.

For paging, start independently with live A and only P39, P41, P42 revision 2
matching a known-time position query at cursor C, in that order.
A page of size 1 returns P39 and freezes those three references. Before page 2,
insert P40 between P39 and P41 and correct P42 to revision 3. Continuation still
returns P41, then P42 revision 2. A fresh query sees P40 and revision 3.
Expiry, explicit release, Reset, or picture rebuild makes continuation return
restart. Under memory pressure, expiring that view releases its revision 2 reference before
retrying whole-commit capacity. A commit that then fits proceeds without a gap.

For exact-time ordering, a reading with ID suffix 09 at `.0000001Z` precedes one
with suffix 01 at `.0000002Z`. Equal instants `.1Z` and `.100Z` order by exact ID.
Unknown and uncertain readings occupy the separate group in ID order, regardless
of timestamp spelling. Preserve all original spellings in results.
