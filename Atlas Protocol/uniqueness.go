package atlas

import (
	"encoding/json"
	"fmt"
	"math/big"
	"sort"
	"strconv"
	"strings"

	"github.com/getkin/kin-openapi/openapi3"
)

func checkUniqueItems(schema *openapi3.Schema, values []interface{}) error {
	uuid := schema.Items != nil && uuidSchema(schema.Items.Value)
	seen := make(map[string]bool, len(values))
	for _, value := range values {
		if text, ok := value.(string); ok && uuid {
			value = strings.ToLower(text)
		}
		key, err := jsonIdentity(value)
		if err != nil {
			return err
		}
		if seen[key] {
			if _, ok := value.(string); ok && uuid {
				return fmt.Errorf("duplicate UUID")
			}
			return fmt.Errorf("duplicate items")
		}
		seen[key] = true
	}
	return nil
}

func jsonIdentity(value interface{}) (string, error) {
	var out strings.Builder
	var appendValue func(interface{}) error
	text := func(s string) {
		out.WriteString(strconv.Itoa(len(s)))
		out.WriteByte(':')
		out.WriteString(s)
	}
	appendValue = func(value interface{}) error {
		switch value := value.(type) {
		case nil:
			out.WriteByte('n')
		case bool:
			out.WriteString(strconv.FormatBool(value))
		case string:
			out.WriteByte('s')
			text(value)
		case json.Number:
			key, err := numberIdentity(value)
			if err != nil {
				return err
			}
			out.WriteByte('d')
			text(key)
		case []interface{}:
			out.WriteByte('a')
			out.WriteString(strconv.Itoa(len(value)))
			out.WriteByte(':')
			for _, child := range value {
				if err := appendValue(child); err != nil {
					return err
				}
			}
		case map[string]interface{}:
			out.WriteByte('o')
			out.WriteString(strconv.Itoa(len(value)))
			out.WriteByte(':')
			keys := make([]string, 0, len(value))
			for key := range value {
				keys = append(keys, key)
			}
			sort.Strings(keys)
			for _, key := range keys {
				text(key)
				if err := appendValue(value[key]); err != nil {
					return err
				}
			}
		default:
			return fmt.Errorf("unexpected JSON identity type %T", value)
		}
		return nil
	}
	if err := appendValue(value); err != nil {
		return "", err
	}
	return out.String(), nil
}

func numberIdentity(value json.Number) (string, error) {
	source := string(value)
	negative := strings.HasPrefix(source, "-")
	source = strings.TrimPrefix(source, "-")
	var exponent big.Int
	if i := strings.IndexAny(source, "eE"); i >= 0 {
		if _, ok := exponent.SetString(source[i+1:], 10); !ok {
			return "", fmt.Errorf("invalid JSON exponent")
		}
		source = source[:i]
	}
	fractional := 0
	if dot := strings.IndexByte(source, '.'); dot >= 0 {
		fractional = len(source) - dot - 1
		source = source[:dot] + source[dot+1:]
	}
	coefficient := strings.TrimLeft(source, "0")
	if coefficient == "" {
		return "0", nil
	}
	digits := strings.TrimRight(coefficient, "0")
	exponent.Add(&exponent, big.NewInt(int64(len(coefficient)-len(digits)-fractional)))
	if negative {
		digits = "-" + digits
	}
	return digits + "e" + exponent.String(), nil
}
