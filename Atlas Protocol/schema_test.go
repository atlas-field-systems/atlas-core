package atlas

import (
	"context"
	"github.com/getkin/kin-openapi/openapi3"
	"testing"
)

func TestAuthoredContract(t *testing.T) {
	if err := scan(document, DefaultLimits()); err != nil {
		t.Fatal(err)
	}
	doc, err := openapi3.NewLoader().LoadFromFile("openapi.json")
	if err != nil {
		t.Fatal(err)
	}
	if err := doc.Validate(context.Background()); err != nil {
		t.Fatal(err)
	}
}
