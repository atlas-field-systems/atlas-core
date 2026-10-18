package atlas

import (
 "context"
 "testing"
 "github.com/getkin/kin-openapi/openapi3"
)

func TestAuthoredContract(t *testing.T) {
 doc, err := openapi3.NewLoader().LoadFromFile("openapi.json")
 if err != nil {t.Fatal(err)}
 if err := doc.Validate(context.Background()); err != nil {t.Fatal(err)}
}
