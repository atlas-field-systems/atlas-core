package atlas

import (
	_ "embed"
	"encoding/json"
	"fmt"
	"reflect"
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
	formats       []openapi3.SchemaValidationOption
	branchSchemas map[*openapi3.Schema]*openapi3.Schema
}

var loadContract = sync.OnceValues(func() (*contract, error) {
	doc, err := openapi3.NewLoader().LoadFromData(document)
	if err != nil {
		return nil, err
	}
	formats, err := contractFormats(doc)
	if err != nil {
		return nil, err
	}
	c := &contract{T: doc, formats: formats, branchSchemas: make(map[*openapi3.Schema]*openapi3.Schema)}
	for _, schema := range doc.Components.Schemas {
		c.branchCandidateSchema(schema.Value)
	}
	return c, nil
})

func (c *contract) branchCandidateSchema(schema *openapi3.Schema) *openapi3.Schema {
	if shape, ok := c.branchSchemas[schema]; ok {
		return shape
	}
	shape := *schema
	c.branchSchemas[schema] = &shape
	if schema.Extensions["x-atlas-geometry"] == true {
		shape = openapi3.Schema{Type: &openapi3.Types{"null", "boolean", "number", "string", "array", "object"}}
		return &shape
	}
	ref := func(s *openapi3.SchemaRef) *openapi3.SchemaRef {
		if s == nil {
			return nil
		}
		return &openapi3.SchemaRef{Ref: s.Ref, Value: c.branchCandidateSchema(s.Value)}
	}
	shape.Properties = make(openapi3.Schemas, len(schema.Properties))
	for key, child := range schema.Properties {
		shape.Properties[key] = ref(child)
	}
	shape.Items = ref(schema.Items)
	for _, group := range []struct{ from, to *openapi3.SchemaRefs }{
		{&schema.OneOf, &shape.OneOf}, {&schema.AnyOf, &shape.AnyOf}, {&schema.AllOf, &shape.AllOf},
	} {
		*group.to = make(openapi3.SchemaRefs, len(*group.from))
		for i, child := range *group.from {
			(*group.to)[i] = ref(child)
		}
	}
	shape.AnyOf = append(shape.AnyOf, shape.OneOf...)
	shape.OneOf = nil
	if schema.Not != nil {
		c.branchCandidateSchema(schema.Not.Value)
	}
	shape.Not = nil
	shape.AdditionalProperties.Schema = ref(schema.AdditionalProperties.Schema)
	return &shape
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
	if schema.Extensions["x-atlas-geometry"] == true {
		if err := geometry(value); err != nil {
			return err
		}
		if err := schema.VisitJSON(value, c.formats...); err != nil {
			return fmt.Errorf("invalid_geometry")
		}
		return nil
	}
	if schema.Extensions["x-go-type"] == "json.RawMessage" {
		return nil
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
			if c.branchSchemas[branch.Value].VisitJSON(value, c.formats...) != nil {
				continue
			}
			candidate := make(integerPlan)
			if err := c.semantics(branch.Value, value, place, candidate); err != nil {
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
		if c.branchSchemas[branch.Value].VisitJSON(value, c.formats...) != nil {
			return fmt.Errorf("invalid_payload: allOf")
		}
		if err := c.semantics(branch.Value, value, place, plan); err != nil {
			return err
		}
	}
	if schema.Not != nil && c.branchSchemas[schema.Not.Value].VisitJSON(value, c.formats...) == nil {
		if c.semantics(schema.Not.Value, value, place, make(integerPlan)) == nil {
			return fmt.Errorf("invalid_payload: not")
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
	if values, ok := value.([]interface{}); ok && schema.Items != nil {
		var seen map[string]bool
		if schema.UniqueItems && uuidSchema(schema.Items.Value) {
			seen = make(map[string]bool, len(values))
		}
		for i, v := range values {
			if id, ok := v.(string); ok && seen != nil {
				key := strings.ToLower(id)
				if seen[key] {
					return fmt.Errorf("duplicate UUID")
				}
				seen[key] = true
			}
			if err := c.semantics(schema.Items.Value, v, place.children[strconv.Itoa(i)], plan); err != nil {
				return err
			}
		}
	}
	return nil
}
