# Tags

Tags are classifications an Asset reports about itself. The optional `tags` section
tells consumers, for example, that an Asset is simulated rather than physical.

## Fields

| Field | Type | Presence | Meaning and bounds |
| --- | --- | --- | --- |
| `tags` | Array of strings | Required, non-null | Unique supported tags; empty means the Asset reports none |

| Tag | Meaning |
| --- | --- |
| `simulated` | The Asset is a simulation, not physical hardware |

The list is closed. Core refuses any other value, and integrations cannot register
new tags. Adding a tag changes the Protocol version. Order carries no meaning and
accepted order is retained. The array cannot exceed the number of supported tags.

## Reporting

Tags use the [report envelope](../report-format.md), not `UpdateAsset` authored fields.
They have no edit revision, and registration cannot supply them. An Asset is
untagged until its first report carries the section, and each later result
replaces the whole list. The only `source_times` key is `tags`.

A tag is the Asset's own claim, which Core retains without verifying. An absent
section means nothing was reported, not that the Asset is physical. Tags grant no
Command support or execution authority, and no message selects Assets by tag.

## Examples

Valid value for a simulated Asset:

```json
{"tags": ["simulated"]}
```

Invalid because the list is closed:

```json
{"tags": ["training"]}
```

Invalid because entries are unique:

```json
{"tags": ["simulated", "simulated"]}
```

[Component index](README.md)
