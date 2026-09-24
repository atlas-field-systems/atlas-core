// Package pagination encodes list positions as opaque cursors bound to one
// Dataset, and applies the Protocol page-size default.
package pagination

import (
	"encoding/base64"
	"encoding/json"
	"fmt"

	"github.com/google/uuid"

	"github.com/atlas-field-systems/atlas-core/core/internal/problem"
)

// DefaultLimit is the documented default of the Protocol Limit parameter.
const DefaultLimit = 50

var (
	errInvalidCursor = problem.Invalid("invalid_cursor", "The cursor is not valid for this list.")
	errOtherDataset  = problem.Conflict("dataset_changed", "The cursor belongs to another Dataset.")
)

// Limit returns the requested page size, or the default when absent. The
// Protocol schema has already bounded it.
func Limit(requested *int) int {
	if requested == nil {
		return DefaultLimit
	}
	return *requested
}

// Codec encodes and decodes the cursors of one Dataset.
type Codec struct {
	dataset string
}

func NewCodec(datasetID uuid.UUID) Codec {
	return Codec{dataset: datasetID.String()}
}

type envelope struct {
	Dataset  string          `json:"d"`
	List     string          `json:"l"`
	Position json.RawMessage `json:"p"`
}

// Encode returns an opaque cursor for a position in the named list. The
// position must be a plain JSON-encodable struct.
func (c Codec) Encode(list string, position any) (string, error) {
	encodedPosition, err := json.Marshal(position)
	if err != nil {
		return "", fmt.Errorf("encode %s cursor: %w", list, err)
	}
	encoded, err := json.Marshal(envelope{Dataset: c.dataset, List: list, Position: encodedPosition})
	if err != nil {
		return "", fmt.Errorf("encode %s cursor: %w", list, err)
	}
	return base64.RawURLEncoding.EncodeToString(encoded), nil
}

// Decode reads a cursor issued by Encode for the same list into position. A
// cursor from another Dataset, such as one issued before a Reset, conflicts.
func (c Codec) Decode(cursor, list string, position any) error {
	decoded, err := base64.RawURLEncoding.DecodeString(cursor)
	if err != nil {
		return errInvalidCursor
	}
	var wrapper envelope
	if json.Unmarshal(decoded, &wrapper) != nil || wrapper.List != list {
		return errInvalidCursor
	}
	if wrapper.Dataset != c.dataset {
		return errOtherDataset
	}
	if json.Unmarshal(wrapper.Position, position) != nil {
		return errInvalidCursor
	}
	return nil
}
