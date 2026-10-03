# Isolated Protocol fidelity proof

This is an executable research fixture for [issue #69](https://github.com/atlas-field-systems/atlas-core/issues/69). It does not implement Atlas Core or its public SDK. The [research report](../13-protocol-toolchain-proof.md) records the results and limits.

Run with Python 3.12+, Node 24.21.0 and npm 11.19.0:

```sh
cd docs/research/atlas-reassessment/protocol-proof
python3 verify.py --bootstrap
```

Bootstrap downloads the checksum-pinned Go and sqlc archives into `/tmp/atlas-protocol-tools` when absent. Set `ATLAS_PROOF_TOOLS` to another task-owned directory if needed. The pinned generator's dependency graph is in `tools/go.mod` and `tools/go.sum`; runtime dependencies are in `go.mod`, `go.sum` and `package-lock.json`. No global package installation is needed.

The verifier installs locked npm dependencies, removes and regenerates its entire `generated/` directory twice, compares all six generated files byte for byte, checks TypeScript and Go formatting, runs Go tests/vet, builds the fixture server and runs the client proof. Generated files, dependencies and the compiled fixture server are ignored. Editing generated output is unnecessary.

| File | Ownership |
| --- | --- |
| `protocol.json` | Current representative Protocol schemas, route bindings and Command metadata |
| `older-client.json` | Independent historical-client fixture containing fewer known response fields |
| `fixtures.json` | Independently authored valid/invalid inputs and expected outcomes |
| `server.go` | Ordinary handwritten fixture behavior behind generated Go strict bindings, real SQLite queries and file transfers |
| `server_test.go` | Go validation of non-HTTP messages, where no HTTP binding exists |
| `proof.ts` | Generated TypeScript client, schema-driven validation adapters and workflow checks |
| `schema.sql`, `queries.sql` | Private proof storage facts, separately authored from Protocol |
| `oapi-codegen.yaml`, `sqlc.yaml` | Small supported generator configuration |
| `verify.py`, `toolchain.json` | Exact tool pins, checksum bootstrap and clean-regeneration gate |

The server uses loopback and a private temporary SQLite database/content directory. Client shutdown sends SIGTERM; the server stops and removes its task-owned data. Fixture endpoints and response-corruption switches exist only to supply controlled test inputs.
