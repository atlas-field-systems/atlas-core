# Runtime schemas and portable reference

One browser-safe TypeScript Protocol package owns runtime schemas and inferred
public types. It exports the portable OpenAPI 3.1.0 reference with stock tooling.
The [package](package-usage.md) implements this profile with locked stock tooling.
[Qualification](qualification.md) distinguishes local checks from integration coverage.

## Supported schema vocabulary

Use closed objects, explicit required fields, scalar types, enums, arrays,
local references, explicit null alternatives, and tagged disjoint alternatives.
The OpenAPI export uses JSON Schema 2020-12 semantics. Null uses
`type: [T, "null"]` for scalars or a null alternative beside a referenced value.
Do not use the 3.0 `nullable` keyword. Declare lengths, cardinalities, and bounds.
Use complete concrete resource schemas with named component properties. Do not
compose closed objects with `allOf`, allow arbitrary fields, or add dynamic registries.

No remote references, custom keywords, conditional schemas, implicit defaults, or
coercion participate in acceptance. An annotation is not a validator.
UUID spelling, timestamp calendars, exact numeric ranges, duplicate decoded members,
cross-field conditions, geometry work, authority, and transitions require boundary
checks. These checks supplement the shared schemas without another field definition.

Omission and explicit null remain distinct in construction and serialization.
A missing measurement cannot become zero. An omitted edit cannot become a clear.
Validate original numeric tokens before conversion loses precision. The shared
[numeric and message bounds](limits.md) apply in Node.js and supported browsers.
Private SQL, filesystem access, and Node-specific storage do not belong in Protocol.

## One source, qualified exports

Author the runtime schemas and local Command Catalog from these contracts once.
Infer TypeScript types and export OpenAPI from that source, rather than maintaining
an independent OpenAPI definition. HTTP and WSS reuse the same resource definitions.
The exported reference remains usable by clients written in other languages.

Choose a supported schema library and exporter only after qualifying their stock
tooling against this profile. Record exact dependencies, locks, and integrity hashes.
A clean export must reproduce its output byte for byte. Never patch generated output
or build a custom schema compiler. Core mechanisms and SDK workflows remain ordinary
handwritten modules. Blanket client, server, or database generation is not required.

Independent fixtures must compare runtime acceptance and the OpenAPI export for
missing/null/zero, closed alternatives, exact integer bounds, duplicate decoded keys,
timestamp endpoints, and bounded geometry. Exercise consuming Core and SDK boundaries
in Node.js and actual supported browsers. Compare against independent expected facts,
not only two tools agreeing. Unsupported export behavior blocks that tool selection;
it does not authorize weakening the contract. Library versions and passing fixtures
are implementation deliverables, not runtime claims made by these pages.

[Contract ownership](README.md#contract-ownership)

## Constrained Power dictionary

Power source_times.reserves is the one declared UUID-keyed dictionary. Export it
with canonical UUID propertyNames, maxProperties 16 and typed additionalProperties
whose value is the closed per-quantity time object. This permits no extension
fields. Runtime checks membership and fuel restrictions against the actual reserves.
