# Response validation and artificial compatibility

This is [ticket #97](https://github.com/atlas-field-systems/atlas-core/issues/97), within [Slice 0 #94](https://github.com/atlas-field-systems/atlas-core/issues/94). Run the shared command from [the fixture guide](README.md):

```sh
python3 scripts/verify.py --bootstrap
```

The check uses generated TypeScript transport and generated Go strict handlers over real loopback HTTP, with the shared real SQLite/file fixture. Each direct Protocol workflow starts in a separate equivalent fixture. `response-fixtures.json` contains independently authored wire replies and expected failure classifications. The direct path checks the actual injected status, headers and body; the generated path checks that the SDK refuses those replies before returning interpreted data.

| Requirement | Implementation | Executed evidence |
| --- | --- | --- |
| Declared status, media and header schemas | Shared SDK `responseValidation` reads the operation's response declarations and local header references | Valid custom required/optional headers, missing/invalid declared headers, undeclared status/media, and absent content type in `responses.test.ts` |
| Success shape and context agreement | Canonical schema references validate cloned JSON before transport interpretation; declared Dataset/edition headers and supplied envelope Dataset agree with the selected context | Missing/wrong required fields, invalid enum/tagged/nested shape, extra closed-shape field, malformed JSON, missing/malformed/wrong header context and header/envelope disagreement |
| Read versus mutation cursor | Fixture read envelope reuses `ResponseContext`; a GET-only mutation-envelope example reuses `MutationResponseContext` | Cursor-free read succeeds; mutation-envelope fixture with missing or wrongly typed cursor raises a typed schema failure |
| Ordinary errors are untrusted | Declared error schemas reuse canonical `Error`; this fixture additionally requires envelope Dataset | Valid stable code/message/diagnostic UUID/details preserved; missing/invalid code, message, request ID, details and required body/header context rejected |
| Safe typed validation failure | `ResponseValidationError` exposes reason, status and method plus contract path | Every corrupt reply asserts the concrete error class and literal safe message, with no body, actual query values or header contents in diagnostics |
| Raw OpenAPI exception | Raw JSON document has its own response schema with declared context headers | Raw document succeeds without a data envelope; missing required `paths` and context faults fail |
| No-body exception | Declared 204 reply has required header schemas and no media/body declaration | Empty success returns no interpreted data; unexpected media and context faults fail |
| Binary metadata exception | Declared octet-stream reply retains header validation and bypasses JSON parsing | Generated `parseAs: "arrayBuffer"` and direct body consumption succeed; missing length/digest, malformed digest, wrong media and context faults fail |
| Independent older contract | Handwritten `older-client.json` omits `label`, tolerates response additions and is generated in its own invocation | Older artificial 0.1.0 client reads the new optional field; current artificial 0.2.0 client reads its omission over HTTP in `compatibility.test.ts` |
| Unsupported artificial edition | Test-only generated GET handlers refuse 9.0.0 with the common typed envelope | Generated/direct 426 refusal and unchanged supported read-back |
| Disposable representations and one check | Older binding stays in the existing disposable test output directory; ordinary fragment/scenario discovery includes these files | Two absent-output generations include the independent older binding; shared Go format/build/test/vet, strict TypeScript, SDK build/package isolation, scenarios and lifetime checks |

All corruption routes are fixture-only GETs. Their final supported read-back preserves the initial fixture value. A bad response is not proof that an operational mutation was rejected. Post-commit `unknown_outcome`, retained submission descriptors and safe retry remain required in the first owning operational workflow. The error's `request_id` is diagnostic correlation, separate from submission identity and the fixture cursor.

The binary example qualifies metadata representation and body parsing only. Its artificial digest is a schema-format fixture, not a claimed content digest. Ticket #100 owns independent exact-byte, length and digest evidence. These routes implement no Object endpoint or publication. Neither artificial edition establishes a published Atlas compatibility range, discovery or real negotiation. No optional request addition or general backward-compatibility guarantee is claimed.

The first declared-header test failed with `Missing expected rejection` before the SDK header integration and passed after it. Nonsecret traces are retained by the coordinator as `/tmp/atlas-spec94/ticket-97-red-headers.log`, `ticket-97-green-responses.log` and `ticket-97-green-compatibility.log`. The shared verifier's `.artifacts/verification.json` records the final checked `source_revision`, clean/dirty status, exact locked tool pins and fresh generated digests. The required final result is a passing report at the committed clean revision, not an earlier development run. Tool and dependency pins remain the foundation's [Protocol toolchain lock](../../Atlas%20Protocol/toolchain.json), Go module graphs and SDK npm lock; this ticket changes none.
