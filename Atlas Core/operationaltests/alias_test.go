package operationaltests_test

import (
	"net/url"
	"testing"

	"github.com/atlas-field-systems/atlas-core/generated/protocol"
	"github.com/atlas-field-systems/atlas-core/systemoperations"
)

func TestUnicodeAliasesShareOneIdentityForRegistrationLookupFilterAndEdit(t *testing.T) {
	for _, pair := range [][2]string{{"Ångström", "ångström"}, {"Σήμα", "ςήμα"}, {"Kelvin", "kelvin"}} {
		t.Run(pair[0], func(t *testing.T) {
			f := newFixture(t, systemoperations.Options{})
			a, request := f.prepareRegistration()
			request["alias"] = pair[0]
			registered := decode[protocol.RegistrationResponse](t, f.request("POST", "/entities", a.secret, request, 201))
			assertAlias := func() {
				read := decode[protocol.AssetResponse](t, f.request("GET", "/entities/alias/"+url.PathEscape(pair[1]), f.admin, nil, 200))
				if read.Data.Id.String() != a.id || read.Data.Alias.GetOrEmpty() != pair[0] {
					t.Fatal("Alias lookup changed identity or display spelling")
				}
				page := decode[protocol.AssetPageResponse](t, f.request("GET", filterPath(t, "/entities", map[string]interface{}{"alias": pair[1]}), f.admin, nil, 200))
				if len(page.Data.Items) != 1 || page.Data.Items[0].Id.String() != a.id || page.Data.Items[0].Alias.GetOrEmpty() != pair[0] {
					t.Fatal("Alias filter differs from lookup or changes display spelling")
				}
			}
			assertAlias()
			b, collision := f.prepareRegistration()
			collision["alias"] = pair[1]
			refused := decode[protocol.Error](t, f.request("POST", "/entities", b.secret, collision, 409))
			if refused.Error.Code != "alias_conflict" {
				t.Fatalf("registration collision code=%s", refused.Error.Code)
			}
			delete(collision, "alias")
			other := decode[protocol.RegistrationResponse](t, f.request("POST", "/entities", b.secret, collision, 201))
			refused = decode[protocol.Error](t, f.request("PATCH", "/entities/"+b.id, f.admin, map[string]interface{}{"alias": pair[1], "expected_edit_revision": other.Data.Entity.EditRevision}, 409))
			if refused.Error.Code != "alias_conflict" {
				t.Fatalf("edit collision code=%s", refused.Error.Code)
			}
			unchanged := decode[protocol.AssetResponse](t, f.request("GET", "/entities/"+b.id, f.admin, nil, 200))
			if !unchanged.Data.Alias.IsNull() || unchanged.Data.Version != other.Data.Entity.Version {
				t.Fatal("refused Alias edit changed stored facts")
			}
			f.restart(systemoperations.Options{})
			assertAlias()
			f.request("PATCH", "/entities/"+a.id, f.admin, map[string]interface{}{"alias": nil, "expected_edit_revision": registered.Data.Entity.EditRevision}, 200)
			f.request("GET", "/entities/alias/"+url.PathEscape(pair[1]), f.admin, nil, 404)
			f.request("PATCH", "/entities/"+b.id, f.admin, map[string]interface{}{"alias": pair[1], "expected_edit_revision": other.Data.Entity.EditRevision}, 200)
			read := decode[protocol.AssetResponse](t, f.request("GET", "/entities/alias/"+url.PathEscape(pair[0]), f.admin, nil, 200))
			if read.Data.Id.String() != b.id || read.Data.Alias.GetOrEmpty() != pair[1] {
				t.Fatal("cleared Alias did not become reusable under the same identity")
			}
		})
	}
}

func TestConcurrentUnicodeAliasClaimsCommitOnlyOneOwner(t *testing.T) {
	for _, editing := range []bool{false, true} {
		t.Run(map[bool]string{false: "registration", true: "edit"}[editing], func(t *testing.T) {
			f := newFixture(t, systemoperations.Options{})
			results := make(chan outcome, 2)
			start := make(chan struct{})
			for _, alias := range []string{"Ångström", "ångström"} {
				a, request := f.prepareRegistration()
				method, path, secret := "POST", "/entities", a.secret
				if editing {
					registered := decode[protocol.RegistrationResponse](t, f.request(method, path, secret, request, 201))
					method, path, secret = "PATCH", "/entities/"+a.id, f.admin
					request = map[string]interface{}{"alias": alias, "expected_edit_revision": registered.Data.Entity.EditRevision}
				} else {
					request["alias"] = alias
				}
				go func() { <-start; results <- f.exchange(method, path, secret, request) }()
			}
			close(start)
			accepted, refused := 0, 0
			for i := 0; i < 2; i++ {
				result := <-results
				if result.err != nil {
					t.Fatal(result.err)
				}
				switch result.status {
				case 200, 201:
					accepted++
				case 409:
					refused++
					if decode[protocol.Error](t, result.body).Error.Code != "alias_conflict" {
						t.Fatal("collision did not report Alias identity")
					}
				default:
					t.Fatalf("unexpected status=%d", result.status)
				}
			}
			if accepted != 1 || refused != 1 {
				t.Fatalf("Alias claim outcomes: accepted=%d refused=%d", accepted, refused)
			}
			page := decode[protocol.AssetPageResponse](t, f.request("GET", filterPath(t, "/entities", map[string]interface{}{"alias": "ÅNGSTRÖM"}), f.admin, nil, 200))
			if len(page.Data.Items) != 1 {
				t.Fatalf("committed Alias owners=%d", len(page.Data.Items))
			}
		})
	}
}
