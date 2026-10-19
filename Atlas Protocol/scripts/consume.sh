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
TS
./node_modules/.bin/tsc --strict --target ES2023 --module NodeNext --moduleResolution NodeNext --outDir "$scratch/npm/out" "$scratch/npm/consume.ts"
node "$scratch/npm/out/consume.js"
mkdir "$scratch/go"
printf 'module consumer\n\ngo 1.27.2\nrequire atlas/protocol v0.0.0\nreplace atlas/protocol => "%s"\n' "$root" > "$scratch/go/go.mod"
cat > "$scratch/go/main.go" <<'GO'
package main
import ("atlas/protocol";"fmt")
func main(){value,err:=atlas.Decode[atlas.Position]("Position",[]byte(`{"latitude":0,"longitude":90}`),atlas.DefaultLimits());if err!=nil{panic(err)};wire,err:=atlas.Encode("Position",value,atlas.DefaultLimits());if err!=nil||atlas.Version()!="0.1.0"||len(atlas.Catalog())!=3{panic("package consumption failed")};fmt.Println(string(wire))}
GO
go -C "$scratch/go" run -mod=mod .
printf 'Built npm artifact and standalone Go module consumer passed.\n'
