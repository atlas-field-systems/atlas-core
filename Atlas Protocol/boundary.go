package atlas

import (
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"unicode/utf8"

	"github.com/getkin/kin-openapi/openapi3"
)

//go:embed openapi.json
var document []byte

type contract struct {
	*openapi3.T
	formats  []openapi3.SchemaValidationOption
	patterns map[string]*regexp.Regexp
	schemas  map[*openapi3.Schema]schemaShapes
}

var loadContract = sync.OnceValues(func() (*contract, error) {
	doc, err := openapi3.NewLoader().LoadFromData(document)
	if err != nil {
		return nil, err
	}
	patterns, err := compilePatterns(doc)
	if err != nil {
		return nil, err
	}
	formats, err := contractFormats(doc)
	if err != nil {
		return nil, err
	}
	c := &contract{T: doc, formats: formats, patterns: patterns, schemas: make(map[*openapi3.Schema]schemaShapes)}
	if err := doc.WalkSchemas(func(_ string, schema *openapi3.SchemaRef) error {
		c.prepareSchema(schema.Value)
		return nil
	}); err != nil {
		return nil, err
	}
	return c, nil
})

func (c *contract) checkString(schema *openapi3.Schema, value string) error {
	if err := c.semantics(schema, value, nil, make(integerPlan)); err != nil {
		return err
	}
	return c.schemas[schema].visit(value, c.formats, false)
}

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
	doc, err := loadContract()
	if err != nil {
		return err
	}
	_, err = doc.checkJSON(name, data, limits)
	return err
}

func Decode[T interface{}](name string, data []byte, limits Limits) (T, error) {
	var value T
	if err := typeMatches[T](name); err != nil {
		return value, err
	}
	doc, err := loadContract()
	if err != nil {
		return value, err
	}
	checked, err := doc.checkJSON(name, data, limits)
	if err != nil {
		return value, err
	}
	err = json.Unmarshal(checked, &value)
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

// Variant validates the source before generated union marshaling can erase omissions.
func Variant[U, V interface{}](variantSchema, unionSchema string, value V, limits Limits) (U, error) {
	var zero U
	wire, err := Encode(variantSchema, value, limits)
	if err != nil {
		return zero, err
	}
	return Decode[U](unionSchema, wire, limits)
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
		if *size > limits.MaxJSONBytes {
			return fmt.Errorf("outbound size limit")
		}
		if v.Type().Elem().Kind() == reflect.Uint8 {
			if v.Type() == reflect.TypeFor[json.RawMessage]() {
				return scan(v.Bytes(), limits)
			}
			return nil
		}
		if v.Len() > limits.MaxValues {
			return fmt.Errorf("outbound size limit")
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

func uuidProperty(schema *openapi3.Schema, field string) bool {
	if property := schema.Properties[field]; property != nil {
		return property.Value.Format == "uuid"
	}
	for _, group := range []openapi3.SchemaRefs{schema.OneOf, schema.AnyOf, schema.AllOf} {
		for _, branch := range group {
			if uuidProperty(branch.Value, field) {
				return true
			}
		}
	}
	return false
}

func uuidSchema(schema *openapi3.Schema) bool {
	if schema.Format == "uuid" {
		return true
	}
	for _, branch := range schema.AllOf {
		if uuidSchema(branch.Value) {
			return true
		}
	}
	for _, group := range []openapi3.SchemaRefs{schema.OneOf, schema.AnyOf} {
		if len(group) == 0 {
			continue
		}
		allUUID := true
		for _, branch := range group {
			allUUID = allUUID && uuidSchema(branch.Value)
		}
		if allUUID {
			return true
		}
	}
	return false
}

func (c *contract) semantics(schema *openapi3.Schema, value interface{}, place *numberPlace, plan integerPlan) error {
	return c.semanticsWithGeometry(schema, value, place, plan, false)
}

// Composition branches share a value. Property and item traversal starts a fresh topology check.
func (c *contract) semanticsWithGeometry(schema *openapi3.Schema, value interface{}, place *numberPlace, plan integerPlan, topologyChecked bool) error {
	if schema.Extensions["x-atlas-geometry"] == true {
		if !topologyChecked {
			if err := geometry(value); err != nil {
				return err
			}
		}
		if err := c.schemas[schema].visit(value, c.formats, true); err != nil {
			if errors.Is(err, errUnpreparedRule) {
				return err
			}
			return fmt.Errorf("invalid_geometry")
		}
		if err := c.semanticRules(schema, value, place, plan, true); err != nil {
			if errors.Is(err, errUnpreparedRule) {
				return err
			}
			return fmt.Errorf("invalid_geometry")
		}
		return nil
	}
	if schema.Extensions["x-go-type"] == "json.RawMessage" {
		return nil
	}
	return c.semanticRules(schema, value, place, plan, topologyChecked)
}

func (c *contract) semanticRules(schema *openapi3.Schema, value interface{}, place *numberPlace, plan integerPlan, topologyChecked bool) error {
	if text, ok := value.(string); ok && schema.Pattern != "" {
		pattern := c.patterns[schema.Pattern]
		if pattern == nil {
			return fmt.Errorf("%w: pattern %s", errUnpreparedRule, schema.Pattern)
		}
		if !pattern.MatchString(text) {
			return fmt.Errorf("invalid_payload: pattern %s", schema.Pattern)
		}
	}
	if schema.Type.Includes("integer") {
		if number, ok := value.(json.Number); ok {
			d, err := exactInteger(schema, number)
			if err != nil {
				return err
			}
			plan[place] = d
		}
	}
	for _, group := range []struct {
		branches openapi3.SchemaRefs
		one      bool
	}{{schema.OneOf, true}, {schema.AnyOf, false}} {
		if len(group.branches) == 0 {
			continue
		}
		var failure error
		accepted := 0
		marks := make(integerPlan)
		for _, branch := range group.branches {
			if err := c.schemas[branch.Value].visit(value, c.formats, false); err != nil {
				if errors.Is(err, errUnpreparedRule) {
					return err
				}
				continue
			}
			candidate := make(integerPlan)
			if err := c.semanticsWithGeometry(branch.Value, value, place, candidate, topologyChecked); err != nil {
				if errors.Is(err, errUnpreparedRule) {
					return err
				}
				if failure == nil {
					failure = err
				}
				continue
			}
			accepted++
			marks.merge(candidate)
		}
		if accepted == 0 {
			if failure != nil {
				return failure
			}
			return fmt.Errorf("invalid_payload: no matching branch")
		}
		if group.one && accepted != 1 {
			return fmt.Errorf("invalid_payload: multiple oneOf branches")
		}
		plan.merge(marks)
	}
	for _, branch := range schema.AllOf {
		if err := c.schemas[branch.Value].visit(value, c.formats, false); err != nil {
			if errors.Is(err, errUnpreparedRule) {
				return err
			}
			return fmt.Errorf("invalid_payload: allOf")
		}
		if err := c.semanticsWithGeometry(branch.Value, value, place, plan, topologyChecked); err != nil {
			return err
		}
	}
	if schema.Not != nil {
		err := c.schemas[schema.Not.Value].visit(value, c.formats, false)
		if errors.Is(err, errUnpreparedRule) {
			return err
		}
		if err == nil {
			err = c.semanticsWithGeometry(schema.Not.Value, value, place, make(integerPlan), topologyChecked)
			if errors.Is(err, errUnpreparedRule) {
				return err
			}
			if err == nil {
				return fmt.Errorf("invalid_payload: not")
			}
		}
	}

	if object, ok := value.(map[string]interface{}); ok {
		for key, child := range schema.Properties {
			if v, ok := object[key]; ok {
				if err := c.semantics(child.Value, v, place.children[key], plan); err != nil {
					return err
				}
			}
		}
		if extra := schema.AdditionalProperties.Schema; extra != nil {
			for key, v := range object {
				if _, known := schema.Properties[key]; !known {
					if err := c.semantics(extra.Value, v, place.children[key], plan); err != nil {
						return err
					}
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
				uuidIdentity := uuidProperty(schema.Properties[key].Value.Items.Value, identity)
				seen := map[string]bool{}
				for _, item := range values {
					if item, ok := item.(map[string]interface{}); ok {
						key, ok := item[identity].(string)
						if !ok {
							continue
						}
						if uuidIdentity {
							key = strings.ToLower(key)
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
	if values, ok := value.([]interface{}); ok {
		if schema.UniqueItems {
			if err := checkUniqueItems(schema, values); err != nil {
				return err
			}
		}
		if schema.Items != nil {
			for i, v := range values {
				if err := c.semantics(schema.Items.Value, v, place.children[strconv.Itoa(i)], plan); err != nil {
					return err
				}
			}
		}
	}
	return nil
}
