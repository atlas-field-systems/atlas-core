// Package entities owns Assets, shared report acceptance and movement evidence.
package entities

import (
	"context"
	"database/sql"
	"embed"
	"encoding/json"
	"errors"
	"fmt"
	storage "github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/retryidentity"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/google/uuid"
	"github.com/oapi-codegen/nullable"
	"strconv"
	"strings"
	"sync"
	"time"
)

//go:embed sql/schema.sql
var files embed.FS

func Schema() string { body, _ := files.ReadFile("sql/schema.sql"); return string(body) }

var ErrNotFound = errors.New("not_found")
var ErrEdit = errors.New("edit_conflict")
var ErrAlias = errors.New("alias_conflict")
var ErrGeneration = errors.New("generation_conflict")
var ErrObsolete = errors.New("obsolete_process")
var ErrReportConflict = errors.New("report_identity_conflict")
var ErrEvidence = errors.New("evidence_identity_conflict")
var ErrInvalid = errors.New("invalid_component")
var ErrProtected = errors.New("nonterminal_tasks")

type QueueOwner interface {
	InitialQueue(context.Context, *writecommit.Commit, string) (protocol.TaskQueue, error)
	HasNonterminal(context.Context, *writecommit.Commit, string) (bool, error)
}
type Module struct {
	boundary          *writecommit.Boundary
	identity          *identity.Module
	queues            QueueOwner
	validate          func(protocol.Asset) error
	challengeMu       sync.Mutex
	challenges        map[string]challenge
	freshness         time.Duration
	degraded, offline time.Duration
	communicationTime func() time.Time
}
type challenge struct {
	value           protocol.ContactChallenge
	issued, expires time.Time
	dataset         string
}
type Options struct {
	Validate                     func(protocol.Asset) error
	Freshness, Degraded, Offline time.Duration
	CommunicationTime            func() time.Time
}

func New(b *writecommit.Boundary, id *identity.Module, options Options) *Module {
	clock := options.CommunicationTime
	if clock == nil {
		clock = time.Now
	}
	return &Module{communicationTime: clock, boundary: b, identity: id, validate: options.Validate, challenges: make(map[string]challenge), freshness: options.Freshness, degraded: options.Degraded, offline: options.Offline}
}
func (m *Module) AttachQueues(owner QueueOwner) { m.queues = owner }
func (m *Module) read(ctx context.Context, c *writecommit.Commit, id string) (protocol.Asset, error) {
	body, err := storage.New(c.SQL).ReadEntity(ctx, id)
	if errors.Is(err, sql.ErrNoRows) {
		return protocol.Asset{}, ErrNotFound
	}
	if err != nil {
		return protocol.Asset{}, err
	}
	var value protocol.Asset
	if err = json.Unmarshal([]byte(body), &value); err != nil {
		return value, fmt.Errorf("retained Asset: %w", err)
	}
	return value, nil
}
func (m *Module) ReadInside(ctx context.Context, c *writecommit.Commit, id string) (protocol.Asset, error) {
	value, err := m.read(ctx, c, id)
	if err != nil {
		return value, err
	}
	if err = m.refreshCommunication(ctx, c, &value); err != nil {
		return value, err
	}
	return value, nil
}
func (m *Module) Read(ctx context.Context, dataset string, principal identity.Principal, id string) (value protocol.Asset, readContext protocol.HTTPReadContext, err error) {
	readContext, err = m.identity.Read(ctx, m.boundary, dataset, principal, func(c *writecommit.Commit) error { var e error; value, e = m.ReadInside(ctx, c, id); return e })
	return
}
func (m *Module) ByAlias(ctx context.Context, dataset string, principal identity.Principal, alias string) (value protocol.Asset, readContext protocol.HTTPReadContext, err error) {
	readContext, err = m.identity.Read(ctx, m.boundary, dataset, principal, func(c *writecommit.Commit) error {
		body, e := storage.New(c.SQL).ReadAlias(ctx, sql.NullString{String: aliasKey(alias), Valid: true})
		if errors.Is(e, sql.ErrNoRows) {
			return ErrNotFound
		}
		if e != nil {
			return e
		}
		if e = json.Unmarshal([]byte(body), &value); e != nil {
			return e
		}
		return m.refreshCommunication(ctx, c, &value)
	})
	return
}
func (m *Module) List(ctx context.Context, dataset string) (values []protocol.Asset, err error) {
	values = []protocol.Asset{}
	err = m.boundary.Read(ctx, dataset, func(c *writecommit.Commit) error {
		bodies, e := storage.New(c.SQL).ListEntities(ctx)
		if e != nil {
			return e
		}
		for _, body := range bodies {
			var value protocol.Asset
			if e = json.Unmarshal([]byte(body), &value); e != nil {
				return e
			}
			if e = m.refreshCommunication(ctx, c, &value); e != nil {
				return e
			}
			values = append(values, value)
		}
		return nil
	})
	return
}
func (m *Module) derive(value *protocol.Asset) {
	if value.Components.Heartbeat.LastSeen.IsNull() {
		value.Components.Communications.State = "offline"
		return
	}
	last, err := value.Components.Heartbeat.LastSeen.Get()
	if err != nil {
		return
	}
	age := m.communicationTime().Sub(last)
	switch {
	case age >= m.offline:
		value.Components.Communications.State = "offline"
	case age >= m.degraded:
		value.Components.Communications.State = "degraded"
	default:
		value.Components.Communications.State = "high_bandwidth"
	}
}

// Read-triggered ageing uses the same writer boundary as reports. A changed
// Derived state gets its own version and change image without inventing Contact.
func (m *Module) refreshCommunication(ctx context.Context, c *writecommit.Commit, value *protocol.Asset) error {
	previous := value.Components.Communications.State
	m.derive(value)
	if previous == value.Components.Communications.State {
		return nil
	}
	return m.save(ctx, c, value, true)
}
func (m *Module) save(ctx context.Context, c *writecommit.Commit, value *protocol.Asset, advance bool) error {
	if advance {
		n, err := strconv.ParseUint(value.Version, 10, 64)
		if err != nil {
			return err
		}
		value.Version = strconv.FormatUint(n+1, 10)
		value.UpdatedAt = time.Now().UTC()
	}
	if m.validate != nil {
		if err := m.validate(*value); err != nil {
			return fmt.Errorf("complete Asset validation: %w", err)
		}
	}
	body, err := json.Marshal(value)
	if err != nil {
		return err
	}
	revision, err := strconv.ParseInt(value.Version, 10, 64)
	if err != nil {
		return err
	}
	edit, err := strconv.ParseInt(value.EditRevision, 10, 64)
	if err != nil {
		return err
	}
	alias := sql.NullString{}
	key := sql.NullString{}
	if value.Alias.IsSpecified() && !value.Alias.IsNull() {
		alias.String = value.Alias.GetOrEmpty()
		alias.Valid = true
		key = sql.NullString{String: aliasKey(alias.String), Valid: true}
	}
	if err = storage.New(c.SQL).SaveEntity(ctx, storage.SaveEntityParams{ID: value.Id.String(), Alias: alias, AliasKey: key, Value: string(body), Revision: revision, EditRevision: edit}); err != nil {
		if strings.Contains(err.Error(), "UNIQUE constraint failed: entities.alias_key") {
			return ErrAlias
		}
		return err
	}
	return c.Changed("entity", value.Id.String(), value)
}
func (m *Module) Register(ctx context.Context, dataset string, request protocol.RegisterAssetRequest, secret string, raw []byte, open bool) (value protocol.Asset, association protocol.RegistrationAssociation, cursor string, err error) {
	cursor, err = m.boundary.Apply(ctx, dataset, func(c *writecommit.Commit) error {
		binding, e := m.identity.Enroll(ctx, c, request, secret, raw, open)
		if e != nil {
			return e
		}
		association = protocol.RegistrationAssociation{AssetId: request.Id, PrincipalId: uuid.MustParse(binding.Principal.ID), CredentialId: uuid.MustParse(binding.CredentialID), RegistrationId: request.RegistrationId}
		facts, e := registrationFacts(raw)
		if e != nil {
			return e
		}
		claim, e := retryidentity.Check(ctx, c, "registration", dataset, request.RegistrationId.String(), facts)
		if e != nil {
			return e
		}
		if claim.Replay {
			value, e = m.ReadInside(ctx, c, claim.ResultID)
			return e
		}
		if _, e = storage.New(c.SQL).ReadTombstone(ctx, request.Id.String()); e == nil {
			return retryidentity.ErrEnded
		} else if !errors.Is(e, sql.ErrNoRows) {
			return e
		}
		if _, e = m.read(ctx, c, request.Id.String()); e == nil {
			return ErrReportConflict
		} else if !errors.Is(e, ErrNotFound) {
			return e
		}
		now := time.Now().UTC()
		manifest := protocol.CommandManifest{}
		if request.CommandManifest != nil {
			manifest = *request.CommandManifest
		}
		queue, e := m.queues.InitialQueue(ctx, c, request.Id.String())
		if e != nil {
			return e
		}
		alias := request.Alias
		if !alias.IsSpecified() {
			alias.SetNull()
		}
		subtype := request.Subtype
		if !subtype.IsSpecified() {
			subtype.SetNull()
		}
		value = protocol.Asset{Id: request.Id, Type: "asset", Alias: alias, Subtype: subtype, Version: "1", EditRevision: "1", CreatedAt: now, UpdatedAt: now, CommandManifest: manifest, Reporting: map[string]protocol.ReportingMetadata{}, TaskQueue: queue, ProcessAuthority: nullable.NewNullNullable[protocol.ProcessAuthority](), Components: protocol.AssetComponents{Status: protocol.StatusComponent{Value: "unknown", Reason: nullable.NewNullNullable[string](), ReportedAt: nullable.NewNullNullable[string](), ReceivedAt: nullable.NewNullNullable[time.Time](), ChangedAt: nullable.NewNullNullable[time.Time]()}, Communications: protocol.CommunicationsComponent{State: "offline"}, Heartbeat: protocol.HeartbeatComponent{LastSeen: nullable.NewNullNullable[time.Time]()}}}
		if e = m.save(ctx, c, &value, false); e != nil {
			return e
		}
		if e = retryidentity.Store(ctx, c, claim, request.Id.String()); e != nil {
			return e
		}
		c.RecordAction(request.RegistrationId.String(), binding.Principal.ID, "asset", "asset_registered", request.Id.String())
		return c.CheckResponse(protocol.RegistrationResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: protocol.RegistrationResponseData{Entity: value, Association: association}, CommitCursor: c.Cursor()})
	})
	return
}
func (m *Module) Edit(ctx context.Context, dataset string, principal identity.Principal, id string, edit protocol.DescriptiveEditRequest) (value protocol.Asset, cursor string, err error) {
	cursor, err = m.boundary.Apply(ctx, dataset, func(c *writecommit.Commit) error {
		if principal.Kind != "operator" && principal.Kind != "plugin" {
			return identity.ErrForbidden
		}
		if e := m.identity.Authorize(ctx, c, principal); e != nil {
			return e
		}
		var e error
		value, e = m.read(ctx, c, id)
		if e != nil {
			return e
		}
		if edit.ExpectedEditRevision != value.EditRevision {
			return ErrEdit
		}
		if !edit.Alias.IsSpecified() && !edit.Subtype.IsSpecified() {
			return ErrInvalid
		}
		if edit.Alias.IsSpecified() {
			value.Alias = edit.Alias
		}
		if edit.Subtype.IsSpecified() {
			value.Subtype = edit.Subtype
		}
		n, e := strconv.ParseUint(value.EditRevision, 10, 64)
		if e != nil {
			return e
		}
		value.EditRevision = strconv.FormatUint(n+1, 10)
		if err := m.save(ctx, c, &value, true); err != nil {
			return err
		}
		return c.CheckResponse(protocol.AssetMutationResponse{DatasetId: uuid.MustParse(c.Metadata.DatasetID), Data: value, CommitCursor: c.Cursor()})
	})
	return
}
func (m *Module) Delete(ctx context.Context, dataset string, principal identity.Principal, id string) (cursor string, err error) {
	return m.boundary.Apply(ctx, dataset, func(c *writecommit.Commit) error {
		if principal.Kind != "operator" && principal.Kind != "plugin" {
			return identity.ErrForbidden
		}
		if e := m.identity.Authorize(ctx, c, principal); e != nil {
			return e
		}
		if _, e := m.read(ctx, c, id); e != nil {
			return e
		}
		protected, e := m.queues.HasNonterminal(ctx, c, id)
		if e != nil {
			return e
		}
		if protected {
			return ErrProtected
		}
		q := storage.New(c.SQL)
		if e = m.identity.Revoke(ctx, c, id); e != nil {
			return e
		}
		if e = q.DeleteEntity(ctx, id); e != nil {
			return e
		}
		if e = q.PutTombstone(ctx, id); e != nil {
			return e
		}
		if e = retryidentity.End(ctx, c, id); e != nil {
			return e
		}
		c.RecordAction(uuid.NewString(), principal.ID, principal.Kind, "credential_revoked", id)
		return c.Changed("entity", id, nil)
	})
}
func (m *Module) UpdateQueue(ctx context.Context, c *writecommit.Commit, id string, queue protocol.TaskQueue) error {
	value, err := m.read(ctx, c, id)
	if err != nil {
		return err
	}
	value.TaskQueue = queue
	return m.save(ctx, c, &value, true)
}
func (m *Module) Clear(ctx context.Context, c *writecommit.Commit) error {
	q := storage.New(c.SQL)
	for _, clear := range []func(context.Context) error{q.ClearEntities, q.ClearGenerations, q.ClearTransfers, q.ClearReports, q.ClearEvidence, q.ClearMovement, q.ClearMovementObservations, q.ClearOrdering, q.ClearTombstones} {
		if err := clear(ctx); err != nil {
			return err
		}
	}
	return nil
}

func (m *Module) InvalidateChallenges() {
	m.challengeMu.Lock()
	clear(m.challenges)
	m.challengeMu.Unlock()
}

type EvidenceCounts struct{ Reports, Movement int64 }

func (m *Module) Evidence(ctx context.Context, c *writecommit.Commit) (EvidenceCounts, error) {
	q := storage.New(c.SQL)
	reports, err := q.CountReports(ctx)
	if err != nil {
		return EvidenceCounts{}, err
	}
	movement, err := q.CountMovement(ctx)
	return EvidenceCounts{reports, movement}, err
}

// Registration compares only its explicitly declared defaults; signed enrollment
// facts and every other omission/null distinction retain their original form.
func registrationFacts(raw []byte) ([]byte, error) {
	var fields map[string]json.RawMessage
	if err := json.Unmarshal(raw, &fields); err != nil {
		return nil, err
	}
	if _, ok := fields["alias"]; !ok {
		fields["alias"] = json.RawMessage("null")
	}
	if _, ok := fields["command_manifest"]; !ok {
		fields["command_manifest"] = json.RawMessage("[]")
	}
	return json.Marshal(fields)
}
