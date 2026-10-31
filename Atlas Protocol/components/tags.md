# Tags

Tags are an Asset-reported preset set. Core retains the complete result and SDK
exposes it on Asset reads. Tags do not change capabilities or command admission.

## Fields and meaning

`Tags` is exactly `{presets: TagPreset[]}`. `presets` is required, unique, and
bounded by the preset vocabulary. The only initial `TagPreset` is `simulated`,
meaning the Asset reports that it represents a simulated system.

A value of `{presets: []}` explicitly clears the set. Omission of the `tags`
section preserves the prior result. Registration leaves Tags absent until an eligible current report.
Tags are available only on Assets, inside the normal
[section result](../report-format.md#complete-section-results) envelope.
Both classifications are allowed. `state_until_changed` is recommended for a
preset set that remains true until changed. Error and withdrawn results retain
their normal meaning and evidence.

`source_times` permits only the optional `presets` key. The read value requires
`time_status.presets`, describing the effective source time of the whole set.
There are no per-preset times or constituent identities. Tags have no source-free
initial value. [Evidence admission](../report-evidence.md) owns retries, ordering,
history-only reports, and replacement-process behavior.

```json
{
  "state": "value",
  "classification": "state_until_changed",
  "observed_at": null,
  "value": {"presets": ["simulated"]}
}
```

## Refused values and placement

Unknown presets, duplicates, null values, missing `presets`, and extra properties
are refused. Authored Tags, Tags in registration, and Tags on Observations, Tracks,
or Geofeatures are refused. User editing, free-form tags, and tag filters are
outside this contract.
