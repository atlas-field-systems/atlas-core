package entities

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/coreerr"
	"github.com/atlas-field-systems/atlas-core/entities/generated/storage"
	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/oapi-codegen/nullable"
)

// Unbounded range ends use the representable Core time extremes.
var (
	earliestTime = time.Date(1, 1, 1, 0, 0, 0, 0, time.UTC)
	latestTime   = time.Date(9999, 12, 31, 23, 59, 59, 0, time.UTC)
)

// MovementHistory returns retained raw samples for one Entity, including a
// deleted one, without reconstructing Entity state. Ranges include from and
// exclude to. The page token pins the Dataset, Entity, time basis, range and
// the accepted-sample boundary of the first page.
func (m *Module) MovementHistory(ctx context.Context, datasetID, id string, params protocol.GetMovementHistoryParams) (protocol.MovementHistoryPage, error) {
	limit := PageSize(params.Limit)
	basis := protocol.ReceivedAt
	if params.TimeBasis != nil {
		basis = *params.TimeBasis
	}
	from, to := earliestTime, latestTime
	if params.From != nil {
		from = params.From.UTC()
	}
	if params.To != nil {
		to = params.To.UTC()
	}
	if !from.Before(to) && params.From != nil && params.To != nil {
		return protocol.MovementHistoryPage{}, coreerr.Invalid("invalid_request", "The range starts before it ends").Paths("/from")
	}
	entityID := system.CanonicalIdentifier(id)
	scope, err := Scope([]string{entityID, string(basis), system.FormatTime(from), system.FormatTime(to)})
	if err != nil {
		return protocol.MovementHistoryPage{}, err
	}
	page := protocol.MovementHistoryPage{EntityId: mustIdentifier(entityID), TimeBasis: basis, Items: []protocol.MovementSample{}, NextPageToken: nullable.NewNullNullable[string]()}
	err = m.store.Read(ctx, datasetID, func(tx *sql.Tx) error {
		rec, exists, err := load(ctx, tx, entityID)
		if err != nil {
			return err
		}
		if !exists {
			return coreerr.NotFound("The Entity was never present in this Dataset")
		}
		page.EntityDeleted = rec.row.DeletedAt.Valid
		queries := storage.New(tx)
		var boundary int64
		afterTime, afterID := "", ""
		if params.PageToken != nil {
			token, err := m.store.OpenToken(*params.PageToken, "movement", scope, limit)
			if err != nil {
				return err
			}
			boundary, err = strconv.ParseInt(token.Pinned["boundary"], 10, 64)
			if err != nil {
				return fmt.Errorf("decode movement boundary: %w", err)
			}
			afterTime, afterID, _ = strings.Cut(token.After, "|")
		} else if boundary, err = queries.MaxReceivedOrder(ctx); err != nil {
			return fmt.Errorf("read movement boundary: %w", err)
		}
		var samples []protocol.MovementSample
		var keys []string
		if basis == protocol.ReceivedAt {
			lower := system.FormatTime(from)
			if afterTime == "" {
				afterTime, afterID = "", ""
			}
			rows, err := queries.MovementByReceipt(ctx, storage.MovementByReceiptParams{
				EntityID: entityID, ReceivedOrder: boundary, ReceivedAt: lower, ReceivedAt_2: system.FormatTime(to),
				ReceivedAt_3: afterTime, ReceivedAt_4: afterTime, SampleID: afterID, Limit: int64(limit + 1),
			})
			if err != nil {
				return fmt.Errorf("read movement samples: %w", err)
			}
			for _, row := range rows {
				sample, err := movementSample(row, nil)
				if err != nil {
					return err
				}
				samples = append(samples, sample)
				keys = append(keys, row.ReceivedAt+"|"+row.SampleID)
			}
		} else {
			rows, err := queries.MovementObserved(ctx, storage.MovementObservedParams{EntityID: entityID, ReceivedOrder: boundary})
			if err != nil {
				return fmt.Errorf("read movement samples: %w", err)
			}
			type candidate struct {
				key    string
				sample protocol.MovementSample
			}
			var matches []candidate
			for _, row := range rows {
				window := func(observed time.Time) bool { return !observed.Before(from) && observed.Before(to) }
				sample, err := movementSample(row, window)
				if err != nil {
					return err
				}
				if len(sample.MatchedQuantities) == 0 {
					continue
				}
				earliest := latestTime
				for _, observed := range observedTimes(sample) {
					if window(observed) && observed.Before(earliest) {
						earliest = observed
					}
				}
				matches = append(matches, candidate{system.FormatTime(earliest) + "|" + row.SampleID, sample})
			}
			slices.SortFunc(matches, func(a, b candidate) int { return strings.Compare(a.key, b.key) })
			after := ""
			if afterTime != "" {
				after = afterTime + "|" + afterID
			}
			for _, match := range matches {
				if after != "" && match.key <= after {
					continue
				}
				samples = append(samples, match.sample)
				keys = append(keys, match.key)
				if len(samples) > limit {
					break
				}
			}
		}
		if len(samples) > limit {
			token, err := m.store.SealToken(system.PageToken{Kind: "movement", Scope: scope, Limit: limit, After: keys[limit-1], Pinned: map[string]string{"boundary": strconv.FormatInt(boundary, 10)}})
			if err != nil {
				return err
			}
			page.NextPageToken = nullable.NewNullableWithValue(token)
			samples = samples[:limit]
		}
		page.Items = append(page.Items, samples...)
		return nil
	})
	return page, err
}

func observedTimes(sample protocol.MovementSample) []time.Time {
	var times []time.Time
	for _, observed := range []nullable.Nullable[time.Time]{
		quantityTime(sample.Position != nil, func() nullable.Nullable[time.Time] { return sample.Position.ObservedAt }),
		quantityTime(sample.SpeedMps != nil, func() nullable.Nullable[time.Time] { return sample.SpeedMps.ObservedAt }),
		quantityTime(sample.Altitude != nil, func() nullable.Nullable[time.Time] { return sample.Altitude.ObservedAt }),
	} {
		if observed.IsSpecified() && !observed.IsNull() {
			times = append(times, observed.MustGet())
		}
	}
	return times
}

func quantityTime(present bool, get func() nullable.Nullable[time.Time]) nullable.Nullable[time.Time] {
	if !present {
		return nullable.Nullable[time.Time]{}
	}
	return get()
}

// movementSample decodes a stored sample. With an observation window, it
// reports which explicitly timed quantities fall inside it; otherwise every
// supplied quantity matches the receipt window.
func movementSample(row storage.MovementSample, window func(time.Time) bool) (protocol.MovementSample, error) {
	sample := protocol.MovementSample{
		SampleId: mustIdentifier(row.SampleID), EntityId: mustIdentifier(row.EntityID), ReceivedAt: system.ParseTime(row.ReceivedAt),
		EvidenceOrigin: nullable.NewNullNullable[protocol.EvidenceOrigin](), RetainedEvidenceId: nullable.NewNullNullable[protocol.NullableIdentifier](),
		MatchedQuantities: []protocol.MovementQuantityName{},
	}
	if row.OriginGeneration.Valid {
		sample.EvidenceOrigin = nullable.NewNullableWithValue(protocol.EvidenceOrigin{
			ProcessGeneration: strconv.FormatInt(row.OriginGeneration.Int64, 10), Sequence: strconv.FormatInt(row.OriginSequence.Int64, 10),
		})
	}
	if row.RetainedEvidenceID.Valid {
		sample.RetainedEvidenceId = nullable.NewNullableWithValue(mustIdentifier(row.RetainedEvidenceID.String))
	}
	var quantities map[string]json.RawMessage
	if err := json.Unmarshal([]byte(row.Quantities), &quantities); err != nil {
		return sample, fmt.Errorf("decode movement sample: %w", err)
	}
	decodeQuantity := func(name string, target any) error {
		raw, ok := quantities[name]
		if !ok {
			return nil
		}
		if err := json.Unmarshal(raw, target); err != nil {
			return fmt.Errorf("decode movement %s: %w", name, err)
		}
		return nil
	}
	var position protocol.MovementPosition
	var speed protocol.MovementSpeed
	var altitude protocol.MovementAltitude
	for name, target := range map[string]any{unitPosition: &position, unitSpeed: &speed, unitAltitude: &altitude} {
		if err := decodeQuantity(name, target); err != nil {
			return sample, err
		}
	}
	matches := func(name protocol.MovementQuantityName, observed nullable.Nullable[time.Time]) {
		if window == nil || (observed.IsSpecified() && !observed.IsNull() && window(observed.MustGet())) {
			sample.MatchedQuantities = append(sample.MatchedQuantities, name)
		}
	}
	if _, ok := quantities[unitPosition]; ok {
		sample.Position = &position
		matches(protocol.MovementQuantityNamePosition, position.ObservedAt)
	}
	if _, ok := quantities[unitSpeed]; ok {
		sample.SpeedMps = &speed
		matches(protocol.MovementQuantityNameSpeedMps, speed.ObservedAt)
	}
	if _, ok := quantities[unitAltitude]; ok {
		sample.Altitude = &altitude
		matches(protocol.MovementQuantityNameAltitude, altitude.ObservedAt)
	}
	return sample, nil
}
