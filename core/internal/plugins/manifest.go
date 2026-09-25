package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"

	"github.com/getkin/kin-openapi/openapi3"
)

// ManifestFile is the manifest's name inside a Plugin's directory.
const ManifestFile = "atlas-plugin.json"

// idPattern matches the Protocol PluginId parameter.
var idPattern = regexp.MustCompile(`^[a-z][a-z0-9-]{0,62}$`)

// Manifest declares a Plugin: what Core records at install and what local
// management needs to run its container.
type Manifest struct {
	ID           string       `json:"id"`
	Release      string       `json:"release"`
	Image        string       `json:"image"`
	Port         int          `json:"port"`
	Capabilities []Capability `json:"capabilities"`
}

// Capability is one Operation the Plugin performs, with the JSON Schema its
// input must match.
type Capability struct {
	Name        string          `json:"name"`
	InputSchema json.RawMessage `json:"input_schema"`
}

// ParseManifest reads and checks a manifest.
func ParseManifest(data []byte) (Manifest, error) {
	var manifest Manifest
	if err := json.Unmarshal(data, &manifest); err != nil {
		return Manifest{}, fmt.Errorf("read Plugin manifest: %w", err)
	}
	if !idPattern.MatchString(manifest.ID) {
		return Manifest{}, fmt.Errorf("Plugin ID %q must match %s", manifest.ID, idPattern)
	}
	if manifest.Release == "" || manifest.Image == "" || manifest.Port < 1 || manifest.Port > 65535 {
		return Manifest{}, errors.New("Plugin manifest needs a release, an image and a port")
	}
	if len(manifest.Capabilities) == 0 {
		return Manifest{}, errors.New("Plugin manifest declares no capabilities")
	}
	for _, capability := range manifest.Capabilities {
		if _, err := parseSchema(capability.InputSchema); err != nil {
			return Manifest{}, fmt.Errorf("capability %q input schema: %w", capability.Name, err)
		}
	}
	return manifest, nil
}

func parseSchema(raw json.RawMessage) (*openapi3.Schema, error) {
	schema := &openapi3.Schema{}
	if err := json.Unmarshal(raw, schema); err != nil {
		return nil, err
	}
	return schema, nil
}
