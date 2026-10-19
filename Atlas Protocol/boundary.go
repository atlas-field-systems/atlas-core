package atlas

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/getkin/kin-openapi/openapi3"
)

//go:embed openapi.json
var document []byte

var loadContract = sync.OnceValues(func() (*openapi3.T, error) {
	doc, err := openapi3.NewLoader().LoadFromData(document)
	if err != nil {
		return nil, err
	}
	timestampGrammar, err := regexp.Compile(doc.Components.Schemas["Timestamp"].Value.Pattern)
	if err != nil {
		return nil, err
	}
	openapi3.DefineStringFormatValidator("date-time", openapi3.NewCallbackValidator(func(s string) error {
		if !timestampGrammar.MatchString(s) {
			return fmt.Errorf("invalid timestamp grammar")
		}
		_, err := time.Parse(time.RFC3339Nano, s)
		return err
	}))
	openapi3.DefineStringFormatValidator("uri", openapi3.NewCallbackValidator(func(s string) error {
		u, err := url.Parse(s)
		if err != nil {
			return err
		}
		if !u.IsAbs() || strings.ContainsAny(s, " \t\r\n") {
			return fmt.Errorf("invalid absolute URI")
		}
		return nil
	}))
	openapi3.DefineStringFormatValidator("uint64-decimal", openapi3.NewCallbackValidator(func(s string) error { _, err := strconv.ParseUint(s, 10, 64); return err }))
	return doc, doc.Validate(context.Background())
})

func Version() string {
	doc, err := loadContract()
	if err != nil {
		panic(err)
	}
	return doc.Info.Version
}
func Catalog() []CatalogEntry {
	var data struct {
		Catalog []CatalogEntry `json:"x-atlas-catalog"`
	}
	if err := json.Unmarshal(document, &data); err != nil {
		panic(err)
	}
	return data.Catalog
}

func ValidateJSON(name string, data []byte, limits Limits) error {
	if err := scan(data, limits); err != nil {
		return err
	}
	doc, err := loadContract()
	if err != nil {
		return err
	}
	schema, ok := doc.Components.Schemas[name]
	if !ok {
		return fmt.Errorf("unknown schema %s", name)
	}
	var value interface{}
	if err := json.Unmarshal(data, &value); err != nil {
		return err
	}
	if err := semantics(schema.Value, value); err != nil {
		return err
	}
	return schema.Value.VisitJSON(value)
}

func Decode[T interface{}](name string, data []byte, limits Limits) (T, error) {
	var value T
	if err := typeMatches[T](name); err != nil {
		return value, err
	}
	if err := ValidateJSON(name, data, limits); err != nil {
		return value, err
	}
	err := json.Unmarshal(data, &value)
	return value, err
}
func Encode[T interface{}](name string, value T, limits Limits) ([]byte, error) {
	if err := typeMatches[T](name); err != nil {
		return nil, err
	}
	if err := limits.check(); err != nil {
		return nil, err
	}
	count, size := 0, 0
	if err := outbound(reflect.ValueOf(value), false, 0, &count, &size, limits); err != nil {
		return nil, err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	if err := ValidateJSON(name, data, limits); err != nil {
		return nil, err
	}
	return data, nil
}
func typeMatches[T interface{}](name string) error {
	if schemaTypes[name] != reflect.TypeFor[T]() {
		return fmt.Errorf("schema %s does not describe %s", name, reflect.TypeFor[T]())
	}
	return nil
}

type presence interface {
	IsSpecified() bool
	IsNull() bool
}

func outbound(v reflect.Value, optional bool, depth int, count, size *int, limits Limits) error {
	*count++
	if depth > limits.MaxDepth || *count > limits.MaxValues || *size > limits.MaxJSONBytes {
		return fmt.Errorf("outbound work limit")
	}
	if !v.IsValid() {
		return nil
	}
	if v.CanInterface() {
		if n, ok := v.Interface().(presence); ok {
			if !n.IsSpecified() {
				if optional {
					return nil
				}
				return fmt.Errorf("required nullable is unset")
			}
			if v.Len() != 1 {
				return fmt.Errorf("invalid nullable state")
			}
			if n.IsNull() {
				return nil
			}
		}
	}
	switch v.Kind() {
	case reflect.Pointer, reflect.Interface:
		if !v.IsNil() {
			return outbound(v.Elem(), false, depth, count, size, limits)
		}
	case reflect.Struct:
		for i := 0; i < v.NumField(); i++ {
			field := v.Type().Field(i)
			if field.PkgPath != "" {
				if v.Field(i).Kind() == reflect.Slice {
					*size += v.Field(i).Len()
				}
				continue
			}
			if err := outbound(v.Field(i), strings.Contains(field.Tag.Get("json"), ",omitempty"), depth+1, count, size, limits); err != nil {
				return err
			}
		}
	case reflect.Slice, reflect.Array:
		*size += v.Len()
		if v.Len() > limits.MaxValues || *size > limits.MaxJSONBytes {
			return fmt.Errorf("outbound size limit")
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			if v.Type() == reflect.TypeFor[json.RawMessage]() {
				return scan(v.Bytes(), limits)
			}
			return nil
		}
		for i := 0; i < v.Len(); i++ {
			if err := outbound(v.Index(i), false, depth+1, count, size, limits); err != nil {
				return err
			}
		}
	case reflect.Map:
		if v.Len() > limits.MaxValues {
			return fmt.Errorf("outbound work limit")
		}
		iter := v.MapRange()
		for iter.Next() {
			if err := outbound(iter.Value(), false, depth, count, size, limits); err != nil {
				return err
			}
		}
	case reflect.String:
		if !utf8.ValidString(v.String()) {
			return fmt.Errorf("invalid UTF-8")
		}
		*size += v.Len()
	default:
		*size++
	}
	if *size > limits.MaxJSONBytes {
		return fmt.Errorf("outbound size limit")
	}
	return nil
}

func semantics(schema *openapi3.Schema, value interface{}) error {
	if value == nil {
		return nil
	}
	if schema.Extensions["x-atlas-geometry"] == true {
		if err := geometry(value); err != nil {
			return err
		}
		if err := schema.VisitJSON(value); err != nil {
			return fmt.Errorf("invalid_geometry")
		}
		return nil
	}
	for _, group := range []openapi3.SchemaRefs{schema.OneOf, schema.AnyOf, schema.AllOf} {
		for _, branch := range group {
			if err := semantics(branch.Value, value); err != nil {
				return err
			}
		}
	}
	if object, ok := value.(map[string]interface{}); ok {
		for key, child := range schema.Properties {
			if v, ok := object[key]; ok {
				if err := semantics(child.Value, v); err != nil {
					return err
				}
			}
		}
		if raw, ok := schema.Extensions["x-atlas-dependent-required"]; ok {
			b, _ := json.Marshal(raw)
			var dependencies map[string][]string
			if err := json.Unmarshal(b, &dependencies); err != nil {
				return err
			}
			for key, required := range dependencies {
				if _, ok := object[key]; ok {
					for _, other := range required {
						if _, ok := object[other]; !ok {
							return fmt.Errorf("%s requires %s", key, other)
						}
					}
				}
			}
		}
		if raw, ok := schema.Extensions["x-atlas-unique-by"]; ok {
			b, _ := json.Marshal(raw)
			var fields map[string]string
			if err := json.Unmarshal(b, &fields); err != nil {
				return err
			}
			for key, identity := range fields {
				values, _ := object[key].([]interface{})
				seen := map[string]bool{}
				for _, item := range values {
					if item, ok := item.(map[string]interface{}); ok {
						key, ok := item[identity].(string)
						if !ok {
							continue
						}
						if seen[key] {
							return fmt.Errorf("duplicate %s", identity)
						}
						seen[key] = true
					}
				}
			}
		}
	}
	if values, ok := value.([]interface{}); ok && schema.Items != nil {
		for _, v := range values {
			if err := semantics(schema.Items.Value, v); err != nil {
				return err
			}
		}
	}
	return nil
}
