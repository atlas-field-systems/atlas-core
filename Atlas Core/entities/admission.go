package entities

import (
	"encoding/json"
	"github.com/atlas-field-systems/atlas-core/identity"
)

// MutationError identifies submitted fields without loading a foreign resource.
type MutationError struct {
	Code  string
	Paths []string
}

func (e *MutationError) Error() string { return e.Code }

// AdmitPatch checks module-owned mutation classes and field authority. Protocol
// remains responsible for structural validation and report acceptance for proofs.
func AdmitPatch(raw []byte, principal identity.Principal) error {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil // Protocol reports structural shape failures.
	}
	descriptive, reported, observed := []string{}, []string{}, []string{}
	forbidden := []string{}
	for field := range fields {
		switch field {
		case "alias", "subtype", "expected_edit_revision":
			descriptive = append(descriptive, "/"+field)
		case "report_context", "authority_claim", "components", "command_manifest":
			reported = append(reported, "/"+field)
		case "observation_context":
			observed = append(observed, "/"+field)
		default:
			forbidden = append(forbidden, "/"+field)
		}
	}
	classes := 0
	for _, group := range [][]string{descriptive, reported, observed} {
		if len(group) > 0 {
			classes++
		}
	}
	if classes > 1 {
		return &MutationError{"mixed_mutation_classes", append(append(descriptive, reported...), observed...)}
	}
	if len(forbidden) > 0 {
		return &MutationError{"forbidden_field", forbidden}
	}
	if len(observed) > 0 {
		return &MutationError{"forbidden_field", observed}
	}
	if len(descriptive) > 0 && principal.Kind != "operator" && principal.Kind != "plugin" {
		return &MutationError{"forbidden_field", descriptive}
	}
	if len(reported) > 0 && principal.Kind != "asset" {
		return &MutationError{"forbidden_field", reported}
	}
	if rawComponents, ok := fields["components"]; ok {
		var components map[string]json.RawMessage
		if err := json.Unmarshal(rawComponents, &components); err != nil {
			return nil
		}
		for component := range components {
			if component != "status" && component != "telemetry" {
				return &MutationError{"forbidden_field", []string{"/components/" + component}}
			}
		}
		if rawStatus, ok := components["status"]; ok {
			var status map[string]json.RawMessage
			if json.Unmarshal(rawStatus, &status) == nil {
				for field := range status {
					if field != "value" && field != "reason" && field != "details" {
						return &MutationError{"forbidden_field", []string{"/components/status/" + field}}
					}
				}
			}
		}
	}
	return nil
}
