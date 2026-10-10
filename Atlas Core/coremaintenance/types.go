// Package coremaintenance defines the owner-authenticated private host boundary.
package coremaintenance

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
)

type ContactExpectation struct {
	FreshnessMS     int64 `json:"freshness_ms"`
	DegradedAfterMS int64 `json:"degraded_after_ms"`
	OfflineAfterMS  int64 `json:"offline_after_ms"`
}

type Config struct {
	MaxOutstandingTasksPerAsset    int                           `json:"max_outstanding_tasks_per_asset"`
	ListenPort                     int                           `json:"listen_port"`
	MaxConcurrentUploads           int                           `json:"max_concurrent_uploads"`
	MaxInflightOperationsPerPlugin int                           `json:"max_inflight_operations_per_plugin"`
	ObjectQuotaBytes               int64                         `json:"object_quota_bytes"`
	ObjectFreeSpaceReserveBytes    int64                         `json:"object_free_space_reserve_bytes"`
	ContactLinkExpectations        map[string]ContactExpectation `json:"contact_link_expectations"`
	ReplayMaxBytes                 int64                         `json:"replay_max_bytes"`
	ReplayMaxAgeMS                 int64                         `json:"replay_max_age_ms"`
	ObjectStoragePath              string                        `json:"object_storage_path"`
	DiagnosticLogPath              string                        `json:"diagnostic_log_path"`
	ListenAddress                  string                        `json:"listen_address"`
	PublicAddress                  string                        `json:"public_address"`
	AllowedOrigins                 []string                      `json:"allowed_origins"`
	MaxJSONBytes                   int64                         `json:"request_body_limit_bytes"`
	ContactFreshnessMS             int64                         `json:"contact_freshness_ms"`
	DegradedAfterMS                int64                         `json:"contact_degraded_after_ms"`
	OfflineAfterMS                 int64                         `json:"contact_offline_after_ms"`
	OpenEnrollment                 bool                          `json:"open_enrollment"`
}

func DefaultConfig() Config {
	return Config{MaxOutstandingTasksPerAsset: 1000, ListenPort: 8443, MaxConcurrentUploads: 4, MaxInflightOperationsPerPlugin: 16, ObjectQuotaBytes: 16000000000, ObjectFreeSpaceReserveBytes: 8000000000, ContactLinkExpectations: map[string]ContactExpectation{}, ReplayMaxBytes: 64 * 1024 * 1024, ReplayMaxAgeMS: 15 * 60 * 1000, ObjectStoragePath: "/var/lib/atlas/objects", DiagnosticLogPath: "/var/lib/atlas/logs", ListenAddress: "0.0.0.0:8443", PublicAddress: "https://localhost:8443", AllowedOrigins: []string{}, MaxJSONBytes: 1048576, ContactFreshnessMS: 10000, DegradedAfterMS: 3000, OfflineAfterMS: 10000}
}

type Installation struct {
	InstallationID      string `json:"installation_id"`
	AdminVerifier       string `json:"admin_verifier"`
	EnrollmentVerifier  string `json:"enrollment_verifier,omitempty"`
	EnrollmentPublicKey string `json:"enrollment_public_key,omitempty"`
	InitialConfig       Config `json:"initial_config"`
}

type LocalAction struct {
	ActionID   string `json:"action_id"`
	Kind       string `json:"kind"`
	ActorUID   uint32 `json:"actor_uid"`
	ActorGID   uint32 `json:"actor_gid"`
	AcceptedAt string `json:"accepted_at"`
	Outcome    string `json:"outcome,omitempty"`
}

type Request struct {
	Activity          *LocalAction  `json:"activity,omitempty"`
	ActionID          string        `json:"action_id"`
	RunID             string        `json:"run_id"`
	Kind              string        `json:"kind"`
	ResetID           string        `json:"reset_id,omitempty"`
	ExpectedDatasetID string        `json:"expected_dataset_id,omitempty"`
	Installation      *Installation `json:"installation,omitempty"`
}

type Result struct {
	RunID                   string `json:"run_id"`
	InstallationID          string `json:"installation_id"`
	DatasetID               string `json:"dataset_id"`
	LastEstablishedResetID  string `json:"last_established_reset_id"`
	WritingRelease          string `json:"writing_release"`
	InstallationFormat      int64  `json:"installation_format"`
	DatasetFormat           int64  `json:"dataset_format"`
	DatasetFingerprint      string `json:"dataset_fingerprint"`
	InstallationFingerprint string `json:"installation_fingerprint"`
	Ready                   bool   `json:"ready"`
	AlreadyApplied          bool   `json:"already_applied"`
	Config                  Config `json:"config"`
}

type Error struct {
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *Error) Error() string { return e.Code + ": " + e.Message }
func Verifier(secret string) string {
	value := sha256.Sum256([]byte(secret))
	return hex.EncodeToString(value[:])
}

// Call verifies the Unix transport rather than borrowing any public credential.
func Call(ctx context.Context, socket string, request Request) (Result, error) {
	body, err := json.Marshal(request)
	if err != nil {
		return Result{}, err
	}
	transport := &http.Transport{DialContext: func(ctx context.Context, _, _ string) (net.Conn, error) {
		return (&net.Dialer{}).DialContext(ctx, "unix", socket)
	}}
	defer transport.CloseIdleConnections()
	httpRequest, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://core/maintenance", bytes.NewReader(body))
	if err != nil {
		return Result{}, err
	}
	httpRequest.Header.Set("Content-Type", "application/json")
	response, err := (&http.Client{Transport: transport}).Do(httpRequest)
	if err != nil {
		return Result{}, fmt.Errorf("private Core request: %w", err)
	}
	defer response.Body.Close()
	data, err := io.ReadAll(io.LimitReader(response.Body, 1048577))
	if err != nil {
		return Result{}, err
	}
	if len(data) > 1048576 {
		return Result{}, fmt.Errorf("private response exceeds bound")
	}
	if response.StatusCode != http.StatusOK {
		var failure Error
		if err = json.Unmarshal(data, &failure); err != nil {
			return Result{}, fmt.Errorf("decode private failure: %w", err)
		}
		return Result{}, &failure
	}
	var result Result
	if err = json.Unmarshal(data, &result); err != nil {
		return Result{}, fmt.Errorf("decode private result: %w", err)
	}
	if result.RunID != request.RunID {
		return Result{}, fmt.Errorf("private Core run identity mismatch")
	}
	return result, nil
}
