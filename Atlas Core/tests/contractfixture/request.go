package main

import (
	"fmt"
	"net/http"

	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
)

// These fixed test values qualify context representation only. They provide no
// discovery, negotiated edition range, commit-time admission or Reset fencing.
func fixtureContext(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Atlas-Dataset-ID", datasetID)
		w.Header().Set("Atlas-Protocol-Version", protocolVersion)
		edition := r.Header.Get("Atlas-Protocol-Version")
		if edition == "0.1.0" || edition == protocolVersion {
			w.Header().Set("Atlas-Protocol-Version", edition)
		}
		if r.Header.Get("Atlas-Dataset-ID") == "" {
			httpcontract.WriteError(w, http.StatusBadRequest, "dataset_required", "Fixture Dataset is required for "+r.Method)
			return
		}
		var submitted contract.Identifier
		if err := submitted.UnmarshalText([]byte(r.Header.Get("Atlas-Dataset-ID"))); err != nil {
			httpcontract.RequestError(w, r, fmt.Errorf("decode fixture Dataset header: %w", err))
			return
		}
		if submitted.String() != datasetID {
			httpcontract.WriteError(w, http.StatusConflict, "dataset_mismatch", "Fixture Dataset does not match for "+r.Method)
			return
		}
		if edition == "" {
			httpcontract.WriteError(w, http.StatusBadRequest, "invalid_request", "Fixture Protocol edition is required for "+r.Method)
			return
		}
		if edition != "0.1.0" && edition != protocolVersion {
			httpcontract.WriteError(w, http.StatusUpgradeRequired, "unsupported_protocol", "Artificial fixture Protocol edition is unsupported for "+r.Method)
			return
		}
		next.ServeHTTP(w, r)
	})
}
