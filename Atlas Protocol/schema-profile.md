# Schema and generation profile

The initial machine contract uses OpenAPI 3.1.0 with reusable named components.
This selects an implementation input. No OpenAPI artifact, generated binding,
codec, or cross-language conformance result exists in this documentation baseline.

## Supported schema vocabulary

Use closed objects, explicit `required`, scalar types, enums, arrays,
local `$ref`, explicit null alternatives, and tagged `oneOf` with disjoint required discriminants.
Use JSON Schema 2020-12 semantics. Null uses `type: [T, "null"]` for scalar values
or a null alternative beside a referenced value. Do not use the 3.0 `nullable` keyword.
Declare lengths, cardinalities, and numeric bounds. Use complete concrete resource
schemas with named component properties. Do not compose closed objects with `allOf`,
use arbitrary additional fields, or create a dynamic component registry.
Plugin-owned JSON is the explicit exception, under its bounded lossless contract.

No remote schema references, custom keywords, conditional schemas, implicit defaults,
or coercion participate in acceptance. An annotation is not a validator.
Enforce UUID spelling, timestamp calendars, exact numeric ranges, duplicate member
rejection, cross-field conditions, authority, and transitions at consuming boundaries.
Those checks supplement the same shared definitions rather than inventing another schema.

Omission and explicit null remain distinct in generated construction and serialization.
A missing measurement cannot become zero. An omitted edit cannot become a clear.
Validation sees original numeric tokens before a generated type loses precision.
The [numeric and message bounds](limits.md) apply in Go, TypeScript, and browsers.

## Lossless Plugin values

The handwritten boundary represents Plugin JSON as null, boolean, string, exact
numeric token, ordered array, or object with unique decoded member names.
It preserves number spelling through decode, storage, retries, and encode.
The public typed representation cannot expose an unsafe untyped escape hatch or
convert an arbitrary numeric token through JavaScript `number` first.
Ordinary native JSON parsing is not a fallback for this domain.

## Reproducible generation

The implementation authors one OpenAPI source and the local Command Catalog from
these contracts. Core and SDK releases share that exact Protocol version.
Generation uses stock tool configuration and committed exact dependency locks,
including generator, formatter, validator, and lossless codec versions with
integrity hashes. A clean regeneration must reproduce checked-in output byte for byte.
Never patch generated output. Handwritten runtime validation and workflow code
remain ordinary modules, as selected by their owning layers.

The implementation qualifies the selected tool versions against this profile before
release. Independent fixtures must cover missing/null/zero, exact integer checks,
closed alternatives, duplicate decoded keys, timestamp endpoints, geometry work
bounds, and lossless Plugin numbers in Go, Node, and supported browsers.
Tool version pins and executed fixtures are implementation deliverables, not
unresolved behavioral choices or claims made by these Markdown pages.

[Go generation](https://github.com/oapi-codegen/oapi-codegen#does-oapi-codegen-support-openapi-31)
and [TypeScript generation](https://openapi-ts.dev/introduction) document support
for this edition. Support for Atlas's full profile still requires the fixtures above.

[Contract ownership](README.md#contract-ownership)
