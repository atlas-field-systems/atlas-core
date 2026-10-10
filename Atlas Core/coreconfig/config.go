// Package coreconfig defines Core's locally administered settings. Host
// management writes the initial values; Core validates the complete candidate
// before serving. There is no public configuration contract.
package coreconfig

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/url"
	"path/filepath"
	"slices"
	"strings"
)

// Format identifies the retained settings representation.
const Format = 1

// LinkExpectation replaces adequate-IP timing for one declared capacity class.
type LinkExpectation struct {
	FreshnessMS     int64 `json:"freshness_ms"`
	DegradedAfterMS int64 `json:"degraded_after_ms"`
	OfflineAfterMS  int64 `json:"offline_after_ms"`
}

// Settings are the saved Core settings. Every member is mandatory.
type Settings struct {
	RequestBodyLimitBytes          int64                      `json:"request_body_limit_bytes"`
	MaxConcurrentUploads           int64                      `json:"max_concurrent_uploads"`
	MaxInflightOperationsPerPlugin int64                      `json:"max_inflight_operations_per_plugin"`
	ObjectQuotaBytes               int64                      `json:"object_quota_bytes"`
	ObjectFreeSpaceReserveBytes    int64                      `json:"object_free_space_reserve_bytes"`
	ContactDegradedAfterMS         int64                      `json:"contact_degraded_after_ms"`
	ContactOfflineAfterMS          int64                      `json:"contact_offline_after_ms"`
	ContactLinkExpectations        map[string]LinkExpectation `json:"contact_link_expectations"`
	ReplayMaxBytes                 int64                      `json:"replay_max_bytes"`
	ReplayMaxAgeMS                 int64                      `json:"replay_max_age_ms"`
	ListenAddress                  string                     `json:"listen_address"`
	ListenPort                     int64                      `json:"listen_port"`
	AllowedOrigins                 []string                   `json:"allowed_origins"`
	ObjectStoragePath              string                     `json:"object_storage_path"`
	DiagnosticLogPath              string                     `json:"diagnostic_log_path"`
}

// Document is the retained settings file with its reviewed revision.
type Document struct {
	Format   int      `json:"format"`
	Revision int64    `json:"revision"`
	Settings Settings `json:"settings"`
}

// Core-container paths for owned storage. Host deployment paths may differ.
const (
	ObjectStoragePath = "/atlas/objects"
	DiagnosticLogPath = "/atlas/logs"
)

// Bounds and the explicit initial values selected by the accepted
// configuration contract. Values are engineering starting bounds.
const (
	MinRequestBodyLimitBytes = 64 << 10
	MaxRequestBodyLimitBytes = 4 << 20
	// DefaultIPChallengeWindowMS is the adequate-IP contact challenge window,
	// separate from degradation and offline thresholds.
	DefaultIPChallengeWindowMS = 10_000
)

// Initial returns the setup values for a local listen address and port.
func Initial(listenAddress string, listenPort int64, allowedOrigins []string) Settings {
	if allowedOrigins == nil {
		allowedOrigins = []string{}
	}
	return Settings{
		RequestBodyLimitBytes:          1_048_576,
		MaxConcurrentUploads:           4,
		MaxInflightOperationsPerPlugin: 16,
		ObjectQuotaBytes:               16_000_000_000,
		ObjectFreeSpaceReserveBytes:    8_000_000_000,
		ContactDegradedAfterMS:         3_000,
		ContactOfflineAfterMS:          10_000,
		ContactLinkExpectations:        map[string]LinkExpectation{},
		ReplayMaxBytes:                 64 << 20,
		ReplayMaxAgeMS:                 15 * 60 * 1000,
		ListenAddress:                  listenAddress,
		ListenPort:                     listenPort,
		AllowedOrigins:                 allowedOrigins,
		ObjectStoragePath:              ObjectStoragePath,
		DiagnosticLogPath:              DiagnosticLogPath,
	}
}

// FieldError names the offending setting without echoing its value.
type FieldError struct {
	Field  string
	Reason string
}

func (e *FieldError) Error() string { return fmt.Sprintf("setting %s: %s", e.Field, e.Reason) }

// Decode parses a retained document strictly: unknown keys and absent or null
// mandatory values are errors, never defaults.
func Decode(encoded []byte) (Document, error) {
	var raw map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &raw); err != nil {
		return Document{}, fmt.Errorf("decode settings document: %w", err)
	}
	for _, name := range []string{"format", "revision", "settings"} {
		if value, ok := raw[name]; !ok || string(value) == "null" {
			return Document{}, &FieldError{name, "is required"}
		}
	}
	var settings map[string]json.RawMessage
	if err := json.Unmarshal(raw["settings"], &settings); err != nil {
		return Document{}, &FieldError{"settings", "must be an object"}
	}
	for _, name := range settingNames() {
		if value, ok := settings[name]; !ok || string(value) == "null" {
			return Document{}, &FieldError{name, "is required"}
		}
	}
	decoder := json.NewDecoder(bytes.NewReader(encoded))
	decoder.DisallowUnknownFields()
	var document Document
	if err := decoder.Decode(&document); err != nil {
		return Document{}, fmt.Errorf("decode settings document: %w", err)
	}
	if document.Format != Format {
		return Document{}, &FieldError{"format", fmt.Sprintf("unsupported settings format %d", document.Format)}
	}
	if document.Revision < 1 {
		return Document{}, &FieldError{"revision", "must be positive"}
	}
	return document, document.Settings.Validate()
}

func settingNames() []string {
	var names []string
	encoded, err := json.Marshal(Settings{})
	if err != nil {
		panic(err)
	}
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(encoded, &fields); err != nil {
		panic(err)
	}
	for name := range fields {
		names = append(names, name)
	}
	slices.Sort(names)
	return names
}

// Validate checks the complete candidate, including cross-field rules.
func (s Settings) Validate() error {
	var errs []error
	positive := func(field string, value int64) {
		if value <= 0 {
			errs = append(errs, &FieldError{field, "must be positive"})
		}
	}
	within := func(field string, value, low, high int64) {
		if value < low || value > high {
			errs = append(errs, &FieldError{field, fmt.Sprintf("must be within %d..%d", low, high)})
		}
	}
	within("request_body_limit_bytes", s.RequestBodyLimitBytes, MinRequestBodyLimitBytes, MaxRequestBodyLimitBytes)
	within("max_concurrent_uploads", s.MaxConcurrentUploads, 1, 32)
	within("max_inflight_operations_per_plugin", s.MaxInflightOperationsPerPlugin, 1, 1024)
	positive("object_quota_bytes", s.ObjectQuotaBytes)
	positive("object_free_space_reserve_bytes", s.ObjectFreeSpaceReserveBytes)
	positive("contact_degraded_after_ms", s.ContactDegradedAfterMS)
	positive("contact_offline_after_ms", s.ContactOfflineAfterMS)
	if s.ContactDegradedAfterMS >= s.ContactOfflineAfterMS {
		errs = append(errs, &FieldError{"contact_degraded_after_ms", "must be less than contact_offline_after_ms"})
	}
	for class, expectation := range s.ContactLinkExpectations {
		field := "contact_link_expectations." + class
		if class == "" {
			errs = append(errs, &FieldError{"contact_link_expectations", "capacity class must be named"})
		}
		positive(field+".freshness_ms", expectation.FreshnessMS)
		positive(field+".degraded_after_ms", expectation.DegradedAfterMS)
		positive(field+".offline_after_ms", expectation.OfflineAfterMS)
		if expectation.DegradedAfterMS >= expectation.OfflineAfterMS {
			errs = append(errs, &FieldError{field + ".degraded_after_ms", "must be less than offline_after_ms"})
		}
	}
	positive("replay_max_bytes", s.ReplayMaxBytes)
	positive("replay_max_age_ms", s.ReplayMaxAgeMS)
	if s.ReplayMaxBytes < s.RequestBodyLimitBytes {
		errs = append(errs, &FieldError{"replay_max_bytes", "must hold at least one maximum-size commit"})
	}
	if ip := net.ParseIP(s.ListenAddress); ip == nil {
		errs = append(errs, &FieldError{"listen_address", "must be a local IP address"})
	}
	within("listen_port", s.ListenPort, 1, 65_535)
	seen := map[string]bool{}
	for _, origin := range s.AllowedOrigins {
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" ||
			strings.Contains(origin, "*") || seen[origin] {
			errs = append(errs, &FieldError{"allowed_origins", "entries must be unique exact HTTPS origins"})
			break
		}
		seen[origin] = true
	}
	for field, path := range map[string]string{"object_storage_path": s.ObjectStoragePath, "diagnostic_log_path": s.DiagnosticLogPath} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			errs = append(errs, &FieldError{field, "must be a clean absolute path"})
		}
	}
	if s.ObjectStoragePath == s.DiagnosticLogPath ||
		strings.HasPrefix(s.ObjectStoragePath+"/", s.DiagnosticLogPath+"/") ||
		strings.HasPrefix(s.DiagnosticLogPath+"/", s.ObjectStoragePath+"/") {
		errs = append(errs, &FieldError{"object_storage_path", "must be disjoint from diagnostic_log_path"})
	}
	return errors.Join(errs...)
}
