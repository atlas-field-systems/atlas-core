package atlas

import (
	"errors"
	"fmt"
	"regexp"

	"github.com/getkin/kin-openapi/openapi3"
)

type schemaShapes struct {
	candidate, node *openapi3.Schema
}

var errUnpreparedRule = errors.New("unprepared contract rule")

func (s schemaShapes) visit(value interface{}, formats []openapi3.SchemaValidationOption, structural bool) error {
	if s.candidate == nil || s.node == nil {
		return errUnpreparedRule
	}
	shape := s.candidate
	if structural {
		shape = s.node
	}
	return shape.VisitJSON(value, formats...)
}

func (c *contract) prepareSchema(schema *openapi3.Schema) schemaShapes {
	if shapes, ok := c.schemas[schema]; ok {
		return shapes
	}
	node := *schema
	node.Pattern, node.UniqueItems = "", false
	shapes := schemaShapes{candidate: &node, node: &node}
	if schema.Extensions["x-atlas-geometry"] == true {
		shapes.candidate = &openapi3.Schema{Type: &openapi3.Types{"null", "boolean", "number", "string", "array", "object"}}
	}
	c.schemas[schema] = shapes
	ref := func(s *openapi3.SchemaRef) *openapi3.SchemaRef {
		if s == nil {
			return nil
		}
		return &openapi3.SchemaRef{Ref: s.Ref, Value: c.prepareSchema(s.Value).candidate}
	}
	for _, group := range []struct{ from, to *openapi3.Schemas }{
		{&schema.Properties, &node.Properties}, {&schema.PatternProperties, &node.PatternProperties},
		{&schema.DependentSchemas, &node.DependentSchemas}, {&schema.Defs, &node.Defs},
	} {
		*group.to = make(openapi3.Schemas, len(*group.from))
		for key, child := range *group.from {
			(*group.to)[key] = ref(child)
		}
	}
	for _, group := range []struct{ from, to *openapi3.SchemaRefs }{
		{&schema.OneOf, &node.OneOf}, {&schema.AnyOf, &node.AnyOf},
		{&schema.AllOf, &node.AllOf}, {&schema.PrefixItems, &node.PrefixItems},
	} {
		*group.to = make(openapi3.SchemaRefs, len(*group.from))
		for i, child := range *group.from {
			(*group.to)[i] = ref(child)
		}
	}
	for _, edge := range []struct{ from, to **openapi3.SchemaRef }{
		{&schema.Items, &node.Items}, {&schema.Not, &node.Not},
		{&schema.AdditionalProperties.Schema, &node.AdditionalProperties.Schema},
		{&schema.Contains, &node.Contains}, {&schema.PropertyNames, &node.PropertyNames},
		{&schema.UnevaluatedItems.Schema, &node.UnevaluatedItems.Schema},
		{&schema.UnevaluatedProperties.Schema, &node.UnevaluatedProperties.Schema},
		{&schema.If, &node.If}, {&schema.Then, &node.Then}, {&schema.Else, &node.Else},
		{&schema.ContentSchema, &node.ContentSchema},
	} {
		*edge.to = ref(*edge.from)
	}
	node.AnyOf = append(node.AnyOf, node.OneOf...)
	node.OneOf, node.Not = nil, nil
	return shapes
}

func compilePatterns(doc *openapi3.T) (map[string]*regexp.Regexp, error) {
	patterns := make(map[string]*regexp.Regexp)
	err := doc.WalkSchemas(func(path string, schema *openapi3.SchemaRef) error {
		if schema.Value.Extensions["x-go-type"] == "json.RawMessage" {
			if err := schema.WalkSubtree(func(childPath string, child *openapi3.SchemaRef) error {
				if child.Value.Pattern != "" || child.Value.UniqueItems {
					return fmt.Errorf("%s%s: opaque JSON skips pattern or uniqueItems", path, childPath)
				}
				return nil
			}); err != nil {
				return err
			}
		}
		pattern := schema.Value.Pattern
		if pattern != "" && patterns[pattern] == nil {
			re, err := regexp.Compile(pattern)
			if err != nil {
				return fmt.Errorf("%s: pattern: %w", path, err)
			}
			patterns[pattern] = re
		}
		return nil
	})
	return patterns, err
}
