package operationaltests_test

import (
	"encoding/json"
	"net/url"
	"sort"
	"sync/atomic"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
	"github.com/google/uuid"
)

func filterPath(t *testing.T, path string, filters map[string]interface{}) string {
	t.Helper()
	query := url.Values{}
	for name, value := range filters {
		encoded, err := json.Marshal(value)
		if err != nil {
			t.Fatal(err)
		}
		query.Set(name, string(encoded))
	}
	return path + "?" + query.Encode()
}

func TestOrdinaryTaskTraversalOrdersPermanentIDsAcrossAssets(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	b, _ := f.register()
	expected := make([]string, 0, 8)
	for i := 0; i < 8; i++ {
		owner := a
		if i%2 == 1 {
			owner = b
		}
		expected = append(expected, f.create(owner).Id.String())
	}
	sort.Strings(expected)
	actual := make([]string, 0, len(expected))
	path := "/tasks?limit=2"
	for {
		page := decode[protocol.TaskPageResponse](t, f.request("GET", path, f.admin, nil, 200))
		for _, task := range page.Data.Items {
			actual = append(actual, task.Id.String())
		}
		if page.Data.NextCursor.IsNull() {
			break
		}
		path = "/tasks?limit=2&cursor=" + url.QueryEscape(page.Data.NextCursor.GetOrEmpty())
	}
	if len(actual) != len(expected) {
		t.Fatalf("Task traversal length=%d, want %d", len(actual), len(expected))
	}
	for i := range expected {
		if actual[i] != expected[i] {
			t.Fatalf("Task traversal=%v, want permanent-ID order %v", actual, expected)
		}
	}
}

func TestOrdinaryPageTokensExpireAtSixtyElapsedSeconds(t *testing.T) {
	var elapsed atomic.Int64
	start := time.Now().UTC()
	f := newFixture(t, systemoperations.Options{PageTime: func() time.Time { return start.Add(time.Duration(elapsed.Load())) }})
	a, _ := f.register()
	f.register()
	f.create(a)
	f.create(a)
	for _, route := range []string{"/entities", "/tasks", "/entities/" + a.id + "/tasks"} {
		t.Run(route, func(t *testing.T) {
			elapsed.Store(0)
			var first struct {
				Data struct {
					NextCursor string `json:"next_cursor"`
				}
			}
			first = decode[struct {
				Data struct {
					NextCursor string `json:"next_cursor"`
				}
			}](t, f.request("GET", route+"?limit=1", f.admin, nil, 200))
			if first.Data.NextCursor == "" {
				t.Fatal("first page has no continuation")
			}
			path := route + "?limit=1&cursor=" + url.QueryEscape(first.Data.NextCursor)
			elapsed.Store(int64(60*time.Second - time.Nanosecond))
			f.request("GET", path, f.admin, nil, 200)
			elapsed.Store(int64(60 * time.Second))
			rejected := decode[protocol.Error](t, f.request("GET", path, f.admin, nil, 409))
			if rejected.Error.Code != "cursor_expired" {
				t.Fatalf("expiry code=%s", rejected.Error.Code)
			}
		})
	}
}

func TestListFiltersSelectValuesAndRejectUnsupportedStructure(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, registration := f.prepareRegistration()
	registration["alias"] = "Exact Alias"
	f.request("POST", "/entities", a.secret, registration, 201)
	b, _ := f.register()
	first := f.create(a)
	second := f.create(b)
	third := f.create(a)
	f.request("PATCH", "/tasks/"+first.Id.String()+"/status", f.admin, map[string]string{"kind": "cancellation_request", "request_id": uuid.NewString()}, 200)
	for _, test := range []struct {
		name    string
		filters map[string]interface{}
		want    []string
	}{
		{"IDs OR", map[string]interface{}{"ids": []string{a.id, b.id}}, []string{a.id, b.id}},
		{"empty IDs", map[string]interface{}{"ids": []string{}}, nil},
		{"type OR", map[string]interface{}{"type": []string{"asset", "track"}}, []string{a.id, b.id}},
		{"other type", map[string]interface{}{"type": []string{"track"}}, nil},
		{"empty type", map[string]interface{}{"type": []string{}}, nil},
		{"case insensitive exact Alias", map[string]interface{}{"alias": "eXACT aLIAS"}, []string{a.id}},
		{"Alias has no substring match", map[string]interface{}{"alias": "Exact"}, nil},
		{"unset Alias", map[string]interface{}{"alias_is_set": false}, []string{b.id}},
		{"filters AND", map[string]interface{}{"ids": []string{b.id}, "alias_is_set": true}, nil},
	} {
		t.Run("Entity/"+test.name, func(t *testing.T) {
			page := decode[protocol.AssetPageResponse](t, f.request("GET", filterPath(t, "/entities", test.filters), f.admin, nil, 200))
			got := make([]string, 0, len(page.Data.Items))
			for _, item := range page.Data.Items {
				got = append(got, item.Id.String())
			}
			sort.Strings(test.want)
			if len(got) != len(test.want) {
				t.Fatalf("IDs=%v, want %v", got, test.want)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("IDs=%v, want %v", got, test.want)
				}
			}
		})
	}
	for _, test := range []struct {
		name    string
		filters map[string]interface{}
		want    []string
	}{
		{"IDs OR", map[string]interface{}{"ids": []string{first.Id.String(), second.Id.String()}}, []string{first.Id.String(), second.Id.String()}},
		{"empty IDs", map[string]interface{}{"ids": []string{}}, nil},
		{"Asset IDs OR", map[string]interface{}{"asset_id": []string{a.id, b.id}}, []string{first.Id.String(), second.Id.String(), third.Id.String()}},
		{"empty Asset IDs", map[string]interface{}{"asset_id": []string{}}, nil},
		{"status OR", map[string]interface{}{"status": []string{"pending", "cancellation_requested"}}, []string{first.Id.String(), second.Id.String(), third.Id.String()}},
		{"empty status", map[string]interface{}{"status": []string{}}, nil},
		{"unsupported scheduling has no matches", map[string]interface{}{"scheduling": []string{"immediate"}}, nil},
		{"supported scheduling", map[string]interface{}{"scheduling": []string{"queued"}}, []string{first.Id.String(), second.Id.String(), third.Id.String()}},
		{"empty scheduling", map[string]interface{}{"scheduling": []string{}}, nil},
		{"filters AND", map[string]interface{}{"asset_id": []string{a.id}, "status": []string{"pending"}, "scheduling": []string{"queued"}}, []string{third.Id.String()}},
	} {
		t.Run("Task/"+test.name, func(t *testing.T) {
			page := decode[protocol.TaskPageResponse](t, f.request("GET", filterPath(t, "/tasks", test.filters), f.admin, nil, 200))
			got := make([]string, 0, len(page.Data.Items))
			for _, item := range page.Data.Items {
				got = append(got, item.Id.String())
			}
			sort.Strings(test.want)
			if len(got) != len(test.want) {
				t.Fatalf("IDs=%v, want %v", got, test.want)
			}
			for i := range got {
				if got[i] != test.want[i] {
					t.Fatalf("IDs=%v, want %v", got, test.want)
				}
			}
		})
	}
	assigned := decode[protocol.AssignedTaskPageResponse](t, f.request("GET", filterPath(t, "/entities/"+a.id+"/tasks", map[string]interface{}{"ids": []string{third.Id.String()}, "status": []string{"pending"}, "scheduling": []string{"queued"}}), a.secret, nil, 200))
	if len(assigned.Data.Items) != 1 || assigned.Data.Items[0].Id != third.Id {
		t.Fatal("assigned-work filters did not select the matching Task")
	}
	legacy := decode[protocol.TaskPageResponse](t, f.request("GET", "/tasks?asset_id="+a.id+"&status=cancellation_requested", f.admin, nil, 200))
	if len(legacy.Data.Items) != 1 || legacy.Data.Items[0].Id != first.Id {
		t.Fatal("legacy scalar convenience changed selection")
	}
	for _, path := range []string{"/entities?ids=null", "/entities?type=null", "/entities?alias=null", "/entities?alias_is_set=null", "/entities?unknown=1", "/tasks?ids=null", "/tasks?asset_id=null", "/tasks?status=null", "/tasks?scheduling=null", "/tasks?unknown=1", "/tasks?unknown%ZZ=1", "/tasks?ids=[];unknown=1", "/tasks?status=%5B%22unrecognized%22%5D", "/tasks?ids=%5B%22invalid%22%5D", "/tasks?status=pending&status=completed"} {
		f.request("GET", path, f.admin, nil, 400)
	}
	firstPage := decode[protocol.TaskPageResponse](t, f.request("GET", filterPath(t, "/tasks", map[string]interface{}{"ids": []string{first.Id.String(), second.Id.String()}, "limit": 1}), f.admin, nil, 200))
	changedFilter := filterPath(t, "/tasks", map[string]interface{}{"ids": []string{first.Id.String(), third.Id.String()}, "limit": 1}) + "&cursor=" + url.QueryEscape(firstPage.Data.NextCursor.GetOrEmpty())
	f.request("GET", changedFilter, f.admin, nil, 400)
}

func TestHTTPReadContextObservesTheTransactionRatherThanResourceVersion(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, registered := f.register()
	task := f.create(a)
	edit := decode[protocol.AssetMutationResponse](t, f.request("PATCH", "/entities/"+a.id, f.admin, map[string]interface{}{"alias": "later state", "expected_edit_revision": registered.Data.Entity.EditRevision}, 200))
	read := decode[protocol.TaskResponse](t, f.request("GET", "/tasks/"+task.Id.String(), f.admin, nil, 200))
	if read.ReadContext.Source != "http" || read.ReadContext.CommitCursor != edit.CommitCursor || read.ReadContext.CommitCursor == read.Data.Version {
		t.Fatalf("HTTP boundary=%+v, resource version=%s, expected Core boundary=%s", read.ReadContext, read.Data.Version, edit.CommitCursor)
	}
	page := decode[protocol.TaskPageResponse](t, f.request("GET", "/tasks", f.admin, nil, 200))
	if page.ReadContext != read.ReadContext {
		t.Fatalf("unchanged Core returned inconsistent boundaries: read=%+v page=%+v", read.ReadContext, page.ReadContext)
	}
}

func TestFilteredContinuationRemainsUsableAtTheAcceptedIDCountBound(t *testing.T) {
	f := newFixture(t, systemoperations.Options{})
	a, _ := f.register()
	first, second := f.create(a), f.create(a)
	ids := []string{first.Id.String(), second.Id.String()}
	for len(ids) < 1000 {
		ids = append(ids, uuid.NewString())
	}
	path := filterPath(t, "/tasks", map[string]interface{}{"ids": ids, "limit": 1})
	page := decode[protocol.TaskPageResponse](t, f.request("GET", path, f.admin, nil, 200))
	if len(page.Data.Items) != 1 || page.Data.NextCursor.IsNull() {
		t.Fatal("filtered first page has no continuation")
	}
	next := decode[protocol.TaskPageResponse](t, f.request("GET", path+"&cursor="+url.QueryEscape(page.Data.NextCursor.GetOrEmpty()), f.admin, nil, 200))
	if len(next.Data.Items) != 1 || next.Data.Items[0].Id == page.Data.Items[0].Id || !next.Data.NextCursor.IsNull() {
		t.Fatal("accepted filter could not traverse both matching resources")
	}
	ids[0] = uuid.NewString()
	changed := filterPath(t, "/tasks", map[string]interface{}{"ids": ids, "limit": 1}) + "&cursor=" + url.QueryEscape(page.Data.NextCursor.GetOrEmpty())
	f.request("GET", changed, f.admin, nil, 400)
}
