package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/atlas-field-systems/atlas-core/corefacts"
)

func TestPublishedCanonicalFacts(t *testing.T) {
	body, err := os.ReadFile(filepath.Join("..", "..", "..", "tests", "s1", "canonical-vectors.json"))
	if err != nil {
		t.Fatal(err)
	}
	var vectors []struct {
		Name      string `json:"name"`
		Input     string `json:"input"`
		Canonical string `json:"canonical"`
	}
	if err = json.Unmarshal(body, &vectors); err != nil {
		t.Fatal(err)
	}
	for _, vector := range vectors {
		t.Run(vector.Name, func(t *testing.T) {
			canonical, err := corefacts.Canonical([]byte(vector.Input))
			if err != nil {
				t.Fatal(err)
			}
			if string(canonical) != vector.Canonical {
				t.Fatalf("canonical facts differ: %s", canonical)
			}
		})
	}
}
