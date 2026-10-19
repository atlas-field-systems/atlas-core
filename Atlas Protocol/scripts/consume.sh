#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
root="$PWD"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
npm pack --json --pack-destination "$scratch" > "$scratch/pack.json"
archive="$(node -p 'JSON.parse(require("node:fs").readFileSync(process.argv[1]))[0].filename' "$scratch/pack.json")"
mkdir "$scratch/npm"
printf '{"private":true,"type":"module"}\n' > "$scratch/npm/package.json"
npm --prefix "$scratch/npm" install --ignore-scripts --no-audit --no-fund "$scratch/$archive" > "$scratch/install.log"
cat > "$scratch/npm/consume.ts" <<'TS'
import {Decode, Encode, Version, Catalog} from '@atlas/protocol';
import type {components} from '@atlas/protocol';
const value: components['schemas']['Telemetry'] = {position: null, altitude: null, ground_speed: 0, observed_at: null};
const decoded = Decode('Telemetry', Encode('Telemetry', value));
if (Version !== '0.1.0' || Catalog().length !== 3 || decoded.ground_speed !== 0) throw new Error('package consumption failed');
const id = '00000000-0000-0000-0000-000000000001';
const invocation: components['schemas']['CreateOperationRequest'] = {request_id: id, operation_id: id, plugin_id: id, release: 'independent-v1', capability: 'null-result', input: null};
if (Decode('CreateOperationRequest', Encode('CreateOperationRequest', invocation)).input !== null) throw new Error('null Plugin input changed');
const operation: components['schemas']['Operation'] = {id, version: '1', plugin_id: id, release: 'independent-v1', capability: 'null-result', input: null, state: 'completed', object_ids: [], known_effects: null};
const result = Decode('Operation', Encode('Operation', operation));
if (result.known_effects !== null || !Object.hasOwn(result, 'known_effects') || Object.hasOwn(result, 'output')) throw new Error('Plugin payload presence changed');
TS
./node_modules/.bin/tsc --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --outDir "$scratch/npm/out" "$scratch/npm/consume.ts"
node "$scratch/npm/out/consume.js"
mkdir "$scratch/go"
printf 'module consumer\n\ngo 1.27.2\nrequire atlas/protocol v0.0.0\nreplace atlas/protocol => "%s"\n' "$root" > "$scratch/go/go.mod"
cat > "$scratch/go/main.go" <<'GO'
package main
import ("atlas/protocol";"fmt")
func main() {
	limits := atlas.DefaultLimits()
	value, err := atlas.Decode[atlas.Position]("Position", []byte(`{"latitude":0,"longitude":90}`), limits)
	if err != nil { panic(err) }
	wire, err := atlas.Encode("Position", value, limits)
	if err != nil || atlas.Version() != "0.1.0" || len(atlas.Catalog()) != 3 { panic("package consumption failed") }
	fmt.Println(string(wire))
	const id = "00000000-0000-0000-0000-000000000001"
	invocation := atlas.CreateOperationRequest{RequestId: id, OperationId: id, PluginId: id, Release: "independent-v1", Capability: "null-result"}
	invocation.Input.SetNull()
	wire, err = atlas.Encode("CreateOperationRequest", invocation, limits)
	if err != nil { panic(err) }
	input, err := atlas.Decode[atlas.CreateOperationRequest]("CreateOperationRequest", wire, limits)
	if err != nil || !input.Input.IsNull() { panic("null Plugin input changed") }
	operation := atlas.Operation{Id: id, Version: "1", PluginId: id, Release: "independent-v1", Capability: "null-result", Input: invocation.Input, State: "completed", ObjectIds: []atlas.Identifier{}}
	operation.KnownEffects.SetNull()
	wire, err = atlas.Encode("Operation", operation, limits)
	if err != nil { panic(err) }
	result, err := atlas.Decode[atlas.Operation]("Operation", wire, limits)
	if err != nil || !result.KnownEffects.IsNull() || result.Output.IsSpecified() { panic("Plugin payload presence changed") }
}
GO
go -C "$scratch/go" run -mod=mod .
printf 'Built npm artifact and standalone Go module consumer passed.\n'
