package entities

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	storage "github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/identity"
	"github.com/atlas-field-systems/atlas-core/writecommit"
	"github.com/oapi-codegen/nullable"
)

type HistoryPosition struct {
	Time time.Time
	ID   string
}
type HistoryOptions struct {
	From, To      time.Time
	TimeBasis     string
	UpperSequence *int64
	After         *HistoryPosition
	Limit         int
}
type HistoryPage struct {
	Items         []protocol.MovementSample
	Deleted       bool
	UpperSequence int64
	Next          *HistoryPosition
}

// HistoryPage reads only a bounded keyset page under the first page's immutable
// accepted-sample boundary. Source timing stays in the sample; numeric SQL keys
// provide exact second/nanosecond chronology across original UTC spellings.
func (m *Module) HistoryPage(ctx context.Context, dataset string, principal identity.Principal, id string, options HistoryOptions) (page HistoryPage, readContext protocol.HTTPReadContext, err error) {
	page.Items = []protocol.MovementSample{}
	readContext, err = m.identity.Read(ctx, m.boundary, dataset, principal, func(c *writecommit.Commit) error {
		if !options.From.Before(options.To) || options.Limit < 1 || options.Limit > 1000 {
			return ErrInvalid
		}
		q := storage.New(c.SQL)
		if _, e := m.read(ctx, c, id); e != nil {
			if !errors.Is(e, ErrNotFound) {
				return e
			}
			if _, e = q.ReadTombstone(ctx, id); e != nil {
				return ErrNotFound
			}
			page.Deleted = true
		}
		if options.UpperSequence == nil {
			upper, e := q.MovementUpper(ctx)
			if e != nil {
				return e
			}
			page.UpperSequence = upper
		} else {
			page.UpperSequence = *options.UpperSequence
		}
		after := HistoryPosition{}
		hasAfter := int64(0)
		if options.After != nil {
			after = *options.After
			hasAfter = 1
		}
		type item struct {
			value    string
			position HistoryPosition
		}
		values := []item{}
		if options.TimeBasis == "observed_at" {
			rows, e := q.ObservedMovementPage(ctx, storage.ObservedMovementPageParams{AssetID: id, UpperSequence: page.UpperSequence, FromSeconds: options.From.Unix(), FromNanos: int64(options.From.Nanosecond()), ToSeconds: options.To.Unix(), ToNanos: int64(options.To.Nanosecond()), HasAfter: hasAfter, AfterSeconds: after.Time.Unix(), AfterNanos: int64(after.Time.Nanosecond()), AfterID: after.ID, PageLimit: int64(options.Limit + 1)})
			if e != nil {
				return e
			}
			for _, row := range rows {
				values = append(values, item{row.Value, HistoryPosition{time.Unix(row.Seconds, row.Nanos).UTC(), row.ID}})
			}
		} else if options.TimeBasis == "received_at" {
			rows, e := q.ReceiptMovementPage(ctx, storage.ReceiptMovementPageParams{AssetID: id, UpperSequence: page.UpperSequence, FromSeconds: options.From.Unix(), FromNanos: int64(options.From.Nanosecond()), ToSeconds: options.To.Unix(), ToNanos: int64(options.To.Nanosecond()), HasAfter: hasAfter, AfterSeconds: after.Time.Unix(), AfterNanos: int64(after.Time.Nanosecond()), AfterID: after.ID, PageLimit: int64(options.Limit + 1)})
			if e != nil {
				return e
			}
			for _, row := range rows {
				values = append(values, item{row.Value, HistoryPosition{time.Unix(row.Seconds, row.Nanos).UTC(), row.ID}})
			}
		} else {
			return ErrInvalid
		}
		if len(values) > options.Limit {
			values = values[:options.Limit]
			last := values[len(values)-1].position
			page.Next = &last
		}
		for _, row := range values {
			var sample protocol.MovementSample
			if e := json.Unmarshal([]byte(row.value), &sample); e != nil {
				return e
			}
			sample.MatchedQuantities = []protocol.MovementSampleMatchedQuantities{}
			matches := func(observed nullable.Nullable[string]) bool {
				if options.TimeBasis == "received_at" {
					return true
				}
				if observed.IsNull() {
					return false
				}
				when, e := time.Parse(time.RFC3339Nano, observed.GetOrEmpty())
				return e == nil && !when.Before(options.From) && when.Before(options.To)
			}
			if sample.Quantities.Position != nil && matches(sample.Quantities.Position.ObservedAt) {
				sample.MatchedQuantities = append(sample.MatchedQuantities, "position")
			}
			if sample.Quantities.SpeedMps != nil && matches(sample.Quantities.SpeedMps.ObservedAt) {
				sample.MatchedQuantities = append(sample.MatchedQuantities, "speed_mps")
			}
			if sample.Quantities.Altitude != nil && matches(sample.Quantities.Altitude.ObservedAt) {
				sample.MatchedQuantities = append(sample.MatchedQuantities, "altitude")
			}
			page.Items = append(page.Items, sample)
		}
		return nil
	})
	return
}
