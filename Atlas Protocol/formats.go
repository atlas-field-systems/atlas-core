package atlas

import (
	"encoding/json"
	"fmt"
	"math"
	"net/url"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/getkin/kin-openapi/openapi3"
)

func contractFormats(doc *openapi3.T) ([]openapi3.SchemaValidationOption, error) {
	timestampGrammar, err := regexp.Compile(doc.Components.Schemas["Timestamp"].Value.Pattern)
	if err != nil {
		return nil, err
	}
	stringFormats := map[string]openapi3.StringFormatValidator{
		"date-time": openapi3.NewCallbackValidator(func(s string) error {
			if !timestampGrammar.MatchString(s) {
				return fmt.Errorf("invalid timestamp grammar")
			}
			_, err := time.Parse(time.RFC3339Nano, s)
			return err
		}),
		"uri": openapi3.NewCallbackValidator(func(s string) error {
			u, err := url.Parse(s)
			if err != nil {
				return err
			}
			if !u.IsAbs() || strings.ContainsAny(s, " \t\r\n") {
				return fmt.Errorf("invalid absolute URI")
			}
			return nil
		}),
		"uint64-decimal": openapi3.NewCallbackValidator(func(s string) error { _, err := strconv.ParseUint(s, 10, 64); return err }),
		"uuid":           openapi3.NewRegexpFormatValidator(doc.Components.Schemas["Identifier"].Value.Pattern),
		"base64url-json": openapi3.NewRegexpFormatValidator(`^[A-Za-z0-9_-]+$`),
		"binary": openapi3.NewCallbackValidator(func(s string) error {
			if !utf8.ValidString(s) {
				return fmt.Errorf("invalid UTF-8")
			}
			return nil
		}),
	}
	integerFormats := map[string]openapi3.IntegerFormatValidator{
		"int64": openapi3.NewRangeFormatValidator(int64(math.MinInt64), int64(math.MaxInt64)),
	}
	numberFormats := map[string]openapi3.NumberFormatValidator{
		"double": openapi3.NewRangeFormatValidator(-math.MaxFloat64, math.MaxFloat64),
	}
	var authored interface{}
	if err := json.Unmarshal(document, &authored); err != nil {
		return nil, err
	}
	var check func(interface{}) error
	check = func(value interface{}) error {
		switch value := value.(type) {
		case map[string]interface{}:
			if format, ok := value["format"].(string); ok && format != "" {
				kinds, ok := value["type"].([]interface{})
				if !ok {
					kinds = []interface{}{value["type"]}
				}
				for _, kind := range kinds {
					covered := false
					switch kind {
					case "string":
						covered = stringFormats[format] != nil
					case "integer":
						covered = integerFormats[format] != nil
					case "number":
						covered = numberFormats[format] != nil
					case "null":
						continue
					}
					if !covered {
						return fmt.Errorf("contract format %s for %v has no local validator", format, kind)
					}
				}
			}
			for _, child := range value {
				if err := check(child); err != nil {
					return err
				}
			}
		case []interface{}:
			for _, child := range value {
				if err := check(child); err != nil {
					return err
				}
			}
		}
		return nil
	}
	if err := check(authored); err != nil {
		return nil, err
	}
	return []openapi3.SchemaValidationOption{
		openapi3.WithStringFormatValidators(stringFormats),
		openapi3.WithIntegerFormatValidators(integerFormats),
		openapi3.WithNumberFormatValidators(numberFormats),
	}, nil
}
