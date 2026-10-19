package atlas

import (
	"encoding/json"
	"net/http"
	"net/url"
	"reflect"
	"testing"
)

func TestCheckedQueryWorkflow(t *testing.T) {
	for _, sample := range []struct {
		operation, path, key, value, checked string
		maxBytes                             int
	}{
		{"ListAssets", "/assets", "names", `["<<<<<<<<<<"]`, `{"names":["<<<<<<<<<<"]}`, 64},
		{"ListAssets", "/assets", "names", `["<>&"]`, `{"names":["<>&"]}`, 64},
		{"ListAssets", "/assets", "names", `  [ "Camera", "camera" ]  `, `{"names":  [ "Camera", "camera" ]  }`, 64},
		{"ListAssets", "/assets", "names", `["café雪😀","quote\"\\","\u0001\u0007\b\f\n\r\t"]`, `{"names":["café雪😀","quote\"\\","\u0001\u0007\b\f\n\r\t"]}`, 512},
		{"GetAssetByAlias", "/assets/by-alias", "alias", "<>&", `{"alias":"<>&"}`, 64},
		{"GetAssetByAlias", "/assets/by-alias", "alias", "a\x00\x07\x0b\x1f\"\\雪😀b", `{"alias":"a\u0000\u0007\u000b\u001f\"\\雪😀b"}`, 512},
		{"GetAssetByAlias", "/assets/by-alias", "alias", "a\u0085\u2028\u2029b", "{\"alias\":\"a\u0085\\u2028\\u2029b\"}", 512},
		{"ListAssets", "/assets", "page_size", "100.0", `{"page_size":100.0}`, 64},
		{"ListAssets", "/assets", "page_size", "1e2", `{"page_size":1e2}`, 64},
	} {
		t.Run(sample.value, func(t *testing.T) {
			limits := DefaultLimits()
			limits.MaxJSONBytes = sample.maxBytes
			req, err := http.NewRequest("GET", "https://atlas.invalid"+sample.path+"?"+sample.key+"="+url.QueryEscape(sample.value), nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = headers()
			data, err := ValidateRequest(sample.operation, req, fixtureDataset, limits)
			if err != nil {
				t.Fatal(err)
			}
			if string(data.Query) != sample.checked {
				t.Fatalf("checked query changed source\n%s\nwant %s", data.Query, sample.checked)
			}
			if sample.key == "alias" {
				query, err := Decode[AliasQuery]("AliasQuery", data.Query, limits)
				if err != nil || query.Alias != sample.value {
					t.Fatal("alias changed", query, err)
				}
			} else {
				query, err := Decode[EntityListQuery]("EntityListQuery", data.Query, limits)
				if err != nil {
					t.Fatal(err)
				}
				if sample.key == "page_size" {
					if query.PageSize == nil || *query.PageSize != 100 {
						t.Fatal("integer changed", query)
					}
				} else {
					var want []string
					if err := json.Unmarshal([]byte(sample.value), &want); err != nil {
						t.Fatal(err)
					}
					if query.Names == nil || !reflect.DeepEqual(*query.Names, want) {
						t.Fatal("names changed", query)
					}
				}
			}
		})
	}
	for _, sample := range []struct {
		raw, checked string
		alias        bool
	}{
		{"alias=a%01b", `{"alias":"a\u0001b"}`, true},
		{"alias=a%E2%80%A8b", `{"alias":"a\u2028b"}`, true},
		{"page_size=1e2", `{"page_size":1e2}`, false},
		{"names=[]&aliases=[]&page_size=100", `{"names":[],"aliases":[],"page_size":100}`, false},
	} {
		for _, delta := range []int{0, -1} {
			limits := DefaultLimits()
			limits.MaxJSONBytes = len(sample.checked) + delta
			path, operation := "/assets", "ListAssets"
			if sample.alias {
				path, operation = "/assets/by-alias", "GetAssetByAlias"
			}
			req, err := http.NewRequest("GET", "https://atlas.invalid"+path+"?"+sample.raw, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = headers()
			data, err := ValidateRequest(operation, req, fixtureDataset, limits)
			if (err == nil) != (delta == 0) {
				t.Fatalf("query %s at limit %d: %v", sample.raw, limits.MaxJSONBytes, err)
			}
			if err == nil && len(data.Query) != len(sample.checked) {
				t.Fatalf("query size changed: %s", data.Query)
			}
		}
	}
	for _, raw := range []string{"names=%5B%5D&n%61mes=%5B%5D", "names=%FF", "names=%5B%22%5Cud800%22%5D", "names=%5B", "page_size=100%200"} {
		req, err := http.NewRequest("GET", "https://atlas.invalid/assets?"+raw, nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header = headers()
		if _, err := ValidateRequest("ListAssets", req, fixtureDataset, DefaultLimits()); err == nil {
			t.Fatalf("malformed query accepted: %s", raw)
		}
	}
	for _, values := range []bool{false, true} {
		limits := DefaultLimits()
		if values {
			limits.MaxValues = 4
		} else {
			limits.MaxDepth = 1
		}
		req, err := http.NewRequest("GET", "https://atlas.invalid/assets?names=%5B%22A%22%2C%22a%22%5D&page_size=100", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header = headers()
		if _, err := ValidateRequest("ListAssets", req, fixtureDataset, limits); err == nil {
			t.Fatal("whole-query work limit ignored")
		}
	}
}
