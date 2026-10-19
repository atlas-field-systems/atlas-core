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
import {Decode, Encode, Version, Catalog, PluginNumberText, ValidateRequest} from '@atlas/protocol';
import type {components} from '@atlas/protocol';
const value: components['schemas']['Telemetry'] = {position: null, altitude: null, ground_speed: 0, observed_at: null};
const decoded = Decode('Telemetry', Encode('Telemetry', value));
if (Version !== '0.1.0' || Catalog().length !== 3 || decoded.ground_speed !== 0) throw new Error('package consumption failed');
const exact = Decode('PluginPayload', new TextEncoder().encode('{"2":1.0,"10":[9007199254740993,1e-400,42]}'));
const exactWire = new TextDecoder().decode(Encode('PluginPayload', exact));
if (!exactWire.includes('"2":1.0') || !exactWire.includes('[9007199254740993,1e-400,42]')) throw new Error('packed Plugin numeric source changed');
if (PluginNumberText(Decode('PluginPayload', new TextEncoder().encode('42'))) !== '42') throw new Error('small Plugin number lost its atom');
const id = '00000000-0000-0000-0000-000000000001';
const invocation: components['schemas']['CreateOperationRequest'] = {request_id: id, operation_id: id, plugin_id: id, release: 'independent-v1', capability: 'null-result', input: null};
if (Decode('CreateOperationRequest', Encode('CreateOperationRequest', invocation)).input !== null) throw new Error('null Plugin input changed');
const operation: components['schemas']['Operation'] = {id, version: '1', plugin_id: id, release: 'independent-v1', capability: 'null-result', input: null, state: 'completed', object_ids: [], known_effects: null};
const result = Decode('Operation', Encode('Operation', operation));
const checked = await ValidateRequest('ListAssets', new Request('https://atlas.invalid/assets?page_size=1e2', {headers: {'Authorization': 'Bearer ' + 'A'.repeat(43), 'Atlas-Dataset-ID': id, 'Atlas-Protocol-Version': Version}}), id);
if (Decode('EntityListQuery', checked.query).page_size !== 100) throw new Error('packed checked query changed');
if (result.known_effects !== null || !Object.hasOwn(result, 'known_effects') || Object.hasOwn(result, 'output')) throw new Error('Plugin payload presence changed');
TS
./node_modules/.bin/tsc --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --outDir "$scratch/npm/out" "$scratch/npm/consume.ts"
node "$scratch/npm/out/consume.js"
mkdir "$scratch/go"
printf 'module consumer\n\ngo 1.27.2\nrequire atlas/protocol v0.0.0\nreplace atlas/protocol => "%s"\n' "$root" > "$scratch/go/go.mod"
cat > "$scratch/go/main.go" <<'GO'
package main
import ("atlas/protocol";"fmt";"net/http";"strings";"bytes")
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
	evidence := atlas.SourceEvidence{EvidenceId:id, Sequence:"1", CorrectionRevision:"0", EvidenceKind:"current"}
	evidence.GeneratedAt.SetNull()
	reading := atlas.TelemetryValue{Classification:"dated_measurement",State:"value",Evidence:evidence}
	reading.Value.ObservedAt.SetNull(); reading.Value.Altitude.SetNull()
	if _, err := atlas.Variant[atlas.TelemetrySection]("TelemetryValue", "TelemetrySection", reading, limits); err == nil {panic("incomplete variant accepted")}
	reading.Value.Position.SetNull(); reading.Value.GroundSpeed.Set(0)
	section, err := atlas.Variant[atlas.TelemetrySection]("TelemetryValue", "TelemetrySection", reading, limits)
	if err != nil {panic(err)}
	report := atlas.AssetReport{Source:atlas.AssetSource{Kind:"asset",AssetId:id,ProcessGeneration:id},Sections:&atlas.AssetSections{Telemetry:&section}}
	wire, err = atlas.Encode("AssetReport", report, limits)
	if err != nil || !bytes.Contains(wire, []byte(`"ground_speed":0`)) || !bytes.Contains(wire, []byte(`"position":null`)) {panic("validated nested variant changed")}
	request, err := http.NewRequest("GET", "https://atlas.invalid/assets?page_size=1e2", nil)
	if err != nil {panic(err)}
	request.Header.Set("Authorization","Bearer "+strings.Repeat("A",43)); request.Header.Set("Atlas-Dataset-ID",id); request.Header.Set("Atlas-Protocol-Version",atlas.Version())
	checked, err := atlas.ValidateRequest("ListAssets",request,id,limits)
	if err != nil {panic(err)}
	query, err := atlas.Decode[atlas.EntityListQuery]("EntityListQuery",checked.Query,limits)
	if err != nil || query.PageSize == nil || *query.PageSize != 100 {panic("standalone checked query changed")}
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
