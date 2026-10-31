# Independent acceptance fixtures

`acceptance.json` records 130 contract-derived cases, with 53 expected accepts
and 77 expected rejects. Expectations come from the cited baseline documents,
not a schema library or an implementation run. `independent-cases.json` preserves
44 additional independently supplied expectations for exact scalars and geometry.
Both corpora run through the built public package in Node and the browser page.

## Case format

Each case has `id`, `schema_name`, `contract`, `expected`, and `rationale`.
`contract` points to the owning document from the repository root.
`schema_name` names a contract-level entry point. `test/fixture-adapter.mjs` maps
these names to public schemas and consuming boundaries. Input text and expected
results remain independent of those definitions.

Exactly one input field is present.

- `raw_json` is the original JSON document as text. Encode it as UTF-8 unchanged.
- `raw_bytes` is the original byte list for malformed UTF-8.

Do not parse and reserialize inputs before testing. That loses duplicate names,
numeric spelling, and invalid Unicode. The corpus file's own JSON escaping is
one storage layer. Decode that layer once to obtain each original input.

Optional `canonical_json`, `retained_json`, `retained_fields`, and `absent_fields`
record independent serialization facts. Field paths use JSON Pointer syntax.
`error_code` identifies a documented geometry refusal, not a library diagnostic.
`context` supplies case-specific facts such as the admission clock.

## Validation scope

An accept means valid under the named contract and the initial message limits.
It does not prove authority, durable effects, replay handling, or state transitions.
For full envelopes, assume matching current Dataset, live IDs and processes,
valid authority, advertised Command support, and no conflicting prior evidence.
The synchronization case supplies its matching exact Protocol version in `context`.
The Move To tests exercise creation input, never an invented Task read image.
No Object read shape is assumed.

`OrdinaryInteger`, `TypedFloat`, `Counter`, and `NewUuid` select shared scalar
contracts. `AssetReport` and `ObservationReport` select the complete `report`
envelope. Execution message inputs include their complete `evidence` wrapper.
`StatusReadResult` selects a complete section result in a read image.

Cases with `scope: "parsing_budget_only"` select raw JSON parsing and independent
byte, value, or depth accounting. Their generic documents are not resource schemas.
`boundary` selects HTTP request, WSS control, or synchronization limits.
Root containers count as values. Encoded byte counts include JSON punctuation.

## Geometry qualification

`qualification` marks adversarial workloads for the implementation's bounded-work
checks. The full report has a 1024-pair collinear-edge rectangle. The complete
synchronization batch has three 1024-pair polygons, including thin and subnormal
shapes. All are geometrically valid and fit the initial message limits.

The documents require finite work accounting but define no portable numeric work
cap. A runner must exercise these workloads with sufficient work budget, then
verify `resource_limit` refusal with an exhausted configured budget before
proportional work or allocation. The acceptance facts do not claim a latency,
memory measurement, or deployment capacity. Tiny nonzero polygons must survive
robust topology checks even when ordinary area multiplication loses their area.

The [qualification guide](../../qualification.md) defines package and browser checks.
These corpora alone do not qualify Core or SDK workflows, durability, or capacity.
Agreement between two tools does not replace the independent expectations stored here.

The valid multi-resource frame uses a thin polygon scaled by an exact power of two
to keep latitude in range. A separate rejected frame retains the original
out-of-range coordinates, so both the adversarial valid workload and whole-frame
coordinate rejection remain covered.

The accepted contact-only report supplies a generation timestamp as required by
contact.md. A separate rejected report preserves the original null timestamp.
