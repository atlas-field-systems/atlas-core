// Package systemoperations assembles module ownership and private lifecycle operations.
package systemoperations

import (
	"context"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/atlas-field-systems/atlas-core/coremaintenance"
	"github.com/atlas-field-systems/atlas-core/entities"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/retryidentity"
	"github.com/atlas-field-systems/atlas-core/tasks"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"net"
	"net/url"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"time"
)

const WritingRelease = "s1-local-0.1.0"

type Dispatch struct{ Method, Path, DatasetID, PrincipalID string }
type Options struct {
	DatabasePath, RunID string
	BeforeCommit        func(context.Context) error
	BeforeDispatch      func(context.Context, Dispatch) error
	CommunicationTime   func() time.Time
	PageTime            func() time.Time
}
type Core struct {
	boundary          *writecommit.Boundary
	identity          *identity.Module
	entities          *entities.Module
	tasks             *tasks.Module
	runID             string
	beforeDispatch    func(context.Context, Dispatch) error
	serving           atomic.Bool
	communicationTime func() time.Time
	pageTime          func() time.Time
}

func fingerprint(parts ...string) string {
	sum := sha256.Sum256([]byte(strings.Join(parts, "\n")))
	return hex.EncodeToString(sum[:])
}
func Open(ctx context.Context, options Options) (*Core, error) {
	if _, err := uuid.Parse(options.RunID); err != nil {
		return nil, fmt.Errorf("Core run identity: %w", err)
	}
	schemas := []string{identity.Schema(), retryidentity.Schema(), entities.Schema(), tasks.Schema()}
	b, err := writecommit.Open(ctx, writecommit.Config{Path: options.DatabasePath, WritingRelease: WritingRelease, DatasetFingerprint: fingerprint(writecommit.Schema(), retryidentity.Schema(), entities.Schema(), tasks.Schema()), InstallationFingerprint: fingerprint(identity.Schema()), Schemas: schemas, BeforeCommit: options.BeforeCommit})
	if err != nil {
		return nil, err
	}
	core := &Core{boundary: b, identity: identity.New(), runID: options.RunID, beforeDispatch: options.BeforeDispatch, communicationTime: options.CommunicationTime, pageTime: options.PageTime}
	core.entities = entities.New(b, core.identity, entities.Options{})
	core.tasks = tasks.New(b, core.entities, core.identity, tasks.Options{MaximumOutstanding: int64(coremaintenance.DefaultConfig().MaxOutstandingTasksPerAsset)})
	core.entities.AttachQueues(core.tasks)
	return core, nil
}
func (c *Core) Close() error { return c.boundary.Close() }
func validateSetup(value coremaintenance.Installation) error {
	if _, err := uuid.Parse(value.InstallationID); err != nil {
		return errors.New("invalid installation identity")
	}
	admin, err := hex.DecodeString(value.AdminVerifier)
	if err != nil || len(admin) != 32 {
		return errors.New("invalid administrative verifier")
	}
	if value.EnrollmentPublicKey != "" {
		key, err := base64.RawURLEncoding.Strict().DecodeString(value.EnrollmentPublicKey)
		if err != nil || len(key) != ed25519.PublicKeySize {
			return errors.New("invalid enrollment verification key")
		}
	} else if value.EnrollmentVerifier == "" {
		return errors.New("missing enrollment authority")
	}
	cfg := value.InitialConfig
	if cfg.MaxJSONBytes < 64*1024 || cfg.MaxJSONBytes > 4*1024*1024 || cfg.ContactFreshnessMS <= 0 || cfg.ContactFreshnessMS > 60000 || cfg.DegradedAfterMS <= 0 || cfg.OfflineAfterMS <= cfg.DegradedAfterMS || cfg.ListenAddress == "" {
		return errors.New("invalid initial configuration")
	}
	if cfg.MaxOutstandingTasksPerAsset < 1 || cfg.MaxConcurrentUploads < 1 || cfg.MaxConcurrentUploads > 32 || cfg.MaxInflightOperationsPerPlugin < 1 || cfg.MaxInflightOperationsPerPlugin > 1024 || cfg.ObjectQuotaBytes <= 0 || cfg.ObjectFreeSpaceReserveBytes <= 0 || cfg.ReplayMaxBytes < cfg.MaxJSONBytes || cfg.ReplayMaxAgeMS <= 0 || cfg.ContactLinkExpectations == nil || cfg.AllowedOrigins == nil {
		return errors.New("invalid retained resource limits")
	}
	for _, link := range cfg.ContactLinkExpectations {
		if link.FreshnessMS <= 0 || link.DegradedAfterMS <= 0 || link.OfflineAfterMS <= link.DegradedAfterMS {
			return errors.New("invalid link contact expectation")
		}
	}
	host, port, err := net.SplitHostPort(cfg.ListenAddress)
	if err != nil || net.ParseIP(host) == nil {
		return errors.New("invalid local bind address")
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 || number != cfg.ListenPort {
		return errors.New("invalid local bind port")
	}
	if !filepath.IsAbs(cfg.ObjectStoragePath) || !filepath.IsAbs(cfg.DiagnosticLogPath) || cfg.ObjectStoragePath == cfg.DiagnosticLogPath || strings.HasPrefix(cfg.ObjectStoragePath, cfg.DiagnosticLogPath+string(filepath.Separator)) || strings.HasPrefix(cfg.DiagnosticLogPath, cfg.ObjectStoragePath+string(filepath.Separator)) {
		return errors.New("invalid owned storage paths")
	}
	public, err := url.Parse(cfg.PublicAddress)
	if err != nil || public.Scheme != "https" || public.Host == "" || public.User != nil {
		return errors.New("public address requires HTTPS")
	}
	seen := map[string]bool{}
	for _, origin := range cfg.AllowedOrigins {
		if seen[origin] {
			return errors.New("duplicate browser origin")
		}
		seen[origin] = true
		parsed, err := url.Parse(origin)
		if err != nil || parsed.Scheme != "https" || parsed.Host == "" || parsed.Path != "" || parsed.RawQuery != "" || parsed.Fragment != "" || parsed.User != nil {
			return errors.New("invalid browser origin")
		}
	}
	return nil
}
func (c *Core) Maintain(ctx context.Context, request coremaintenance.Request) (result coremaintenance.Result, err error) {
	if request.RunID != c.runID {
		return result, &coremaintenance.Error{Code: "stale_run", Message: "Private request targets another Core run"}
	}
	if _, err = uuid.Parse(request.ActionID); err != nil {
		return result, &coremaintenance.Error{Code: "invalid_action", Message: "Private action requires UUID identity"}
	}
	replay := false
	_, err = c.boundary.Apply(ctx, "", func(commit *writecommit.Commit) error {
		switch request.Kind {
		case "inspect", "preflight":
			return nil
		case "open":
			return c.recordLocal(ctx, commit, request)
		case "setup":
			if request.Installation == nil {
				return errors.New("setup requires installation material")
			}
			if err := validateSetup(*request.Installation); err != nil {
				return err
			}
			if commit.Metadata.InstallationID != "" {
				if commit.Metadata.InstallationID != request.Installation.InstallationID {
					return errors.New("installation_conflict")
				}
				if err := c.identity.CheckSetup(ctx, commit, *request.Installation); err != nil {
					return errors.New("installation_conflict")
				}
				candidate, err := json.Marshal(request.Installation.InitialConfig)
				if err != nil {
					return err
				}
				if string(candidate) != commit.Metadata.Configuration {
					return errors.New("installation_conflict")
				}
				replay = true
				return nil
			}
			cfg, err := json.Marshal(request.Installation.InitialConfig)
			if err != nil {
				return err
			}
			if err = c.identity.Setup(ctx, commit, *request.Installation); err != nil {
				return err
			}
			if err = c.boundary.Setup(ctx, commit, request.Installation.InstallationID, uuid.NewString(), string(cfg)); err != nil {
				return err
			}
			return c.recordLocal(ctx, commit, request)
		case "reset":
			if request.ResetID == "" {
				return errors.New("reset identity required")
			}
			if _, err := uuid.Parse(request.ResetID); err != nil {
				return errors.New("invalid reset identity")
			}
			if commit.Metadata.LastResetID == request.ResetID {
				replay = true
				return nil
			}
			if request.ExpectedDatasetID == "" || request.ExpectedDatasetID != commit.Metadata.DatasetID {
				return writecommit.ErrDataset
			}
			if err := retryidentity.Clear(ctx, commit); err != nil {
				return err
			}
			if err := c.tasks.Clear(ctx, commit); err != nil {
				return err
			}
			if err := c.entities.Clear(ctx, commit); err != nil {
				return err
			}
			if err := c.boundary.Reset(ctx, commit, uuid.NewString(), request.ResetID); err != nil {
				return err
			}
			return c.recordLocal(ctx, commit, request)
		case "stop":
			return c.recordLocal(ctx, commit, request)
		default:
			return errors.New("unknown private operation")
		}
	})
	if err != nil {
		return result, err
	}
	if request.Kind == "reset" && !replay {
		c.entities.InvalidateChallenges()
	}
	metadata, err := c.boundary.Inspect(ctx)
	if err != nil {
		return result, err
	}
	var config coremaintenance.Config
	if metadata.InstallationID != "" {
		if err = json.Unmarshal([]byte(metadata.Configuration), &config); err != nil {
			return result, fmt.Errorf("retained configuration: %w", err)
		}
		if err = validateSetup(coremaintenance.Installation{InstallationID: metadata.InstallationID, AdminVerifier: strings.Repeat("0", 64), EnrollmentVerifier: "retained", InitialConfig: config}); err != nil {
			return result, err
		}
	}
	return coremaintenance.Result{RunID: c.runID, InstallationID: metadata.InstallationID, DatasetID: metadata.DatasetID, LastEstablishedResetID: metadata.LastResetID, WritingRelease: metadata.WritingRelease, InstallationFormat: metadata.InstallationFormat, DatasetFormat: metadata.DatasetFormat, DatasetFingerprint: metadata.DatasetFingerprint, InstallationFingerprint: metadata.InstallationFingerprint, Ready: c.serving.Load(), AlreadyApplied: replay, Config: config}, nil
}
