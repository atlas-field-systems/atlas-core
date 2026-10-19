package atlas

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestReleaseSnapshotUUIDIdentity(t *testing.T) {
	for _, run := range []string{fixtureDataset, strings.ToLower(fixtureDataset), fixtureRun} {
		t.Run(run, func(t *testing.T) {
			frame := ReleaseSnapshotFrame{
				Type: "release_snapshot", DatasetId: fixtureDataset, ProtocolVersion: ProtocolVersion(Version()), CoreRunId: fixtureDataset,
				Request: ReleaseSnapshotRequest{RequestId: fixtureRun, SnapshotId: fixtureDataset, LoadId: fixtureRun, CoreRunId: run},
			}
			wire, err := Encode("ReleaseSnapshotFrame", frame, DefaultLimits())
			if err != nil {
				t.Fatal(err)
			}
			err = ValidateFrame("client", wire, FrameContext{fixtureDataset, strings.ToLower(fixtureDataset), true, false}, DefaultLimits())
			if (err == nil) != (run != fixtureRun) {
				t.Fatalf("release UUID identity: %v", err)
			}
			decoded, err := Decode[ReleaseSnapshotFrame]("ReleaseSnapshotFrame", wire, DefaultLimits())
			if err != nil || decoded.CoreRunId != fixtureDataset || decoded.Request.CoreRunId != run {
				t.Fatalf("source spelling changed: %+v, %v", decoded, err)
			}
		})
	}
}

func TestReserveUUIDIdentity(t *testing.T) {
	for _, id := range []string{fixtureDataset, strings.ToLower(fixtureDataset), strings.ToLower(fixtureDataset[:len(fixtureDataset)-1] + "7")} {
		wire := []byte(`{"external_power":null,"observed_at":null,"reserves":[{"id":"` + fixtureDataset + `","kind":"fuel","remaining_percent":null,"observed_at":null},{"id":"` + id + `","kind":"fuel","remaining_percent":null,"observed_at":null}]}`)
		value, err := Decode[Power]("Power", wire, DefaultLimits())
		if (err == nil) != !strings.EqualFold(id, fixtureDataset) {
			t.Errorf("reserve %s: %v", id, err)
		}
		if err == nil {
			out, err := Encode("Power", value, DefaultLimits())
			if err != nil || !bytes.Contains(out, []byte(fixtureDataset)) || !bytes.Contains(out, []byte(id)) {
				t.Fatalf("reserve spellings changed: %s, %v", out, err)
			}
		}
	}
}

func TestAPIKeyBoundaryAgreement(t *testing.T) {
	for _, sample := range []struct {
		name, secret string
		valid        bool
	}{
		{"minimum", strings.Repeat("A", 43), true},
		{"alphabet", strings.Repeat("aZ09_-", 21) + "-_", true},
		{"too short", strings.Repeat("A", 42), false},
		{"too long", strings.Repeat("A", 129), false},
		{"plus", strings.Repeat("+", 43), false},
		{"slash", strings.Repeat("/", 43), false},
		{"padding", strings.Repeat("A", 42) + "=", false},
		{"space", strings.Repeat("A", 42) + " A", false},
	} {
		t.Run(sample.name, func(t *testing.T) {
			secret, err := json.Marshal(sample.secret)
			if err != nil {
				t.Fatal(err)
			}
			credential := []byte(`{"key_id":"` + fixtureRun + `","secret":` + string(secret) + `}`)
			frame := []byte(`{"type":"authenticate","dataset_id":"` + fixtureDataset + `","protocol_version":"0.1.0","api_key":` + string(secret) + `}`)
			req, err := http.NewRequest("GET", "https://atlas.invalid/assets/"+fixtureDataset, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Header = headers()
			req.Header.Set("Authorization", "bEaReR "+sample.secret)
			_, httpErr := ValidateRequest("GetAsset", req, fixtureDataset, DefaultLimits())
			for boundary, err := range map[string]error{
				"frame schema": ValidateJSON("AuthenticateFrame", frame, DefaultLimits()),
				"frame":        ValidateFrame("client", frame, FrameContext{DatasetID: fixtureDataset}, DefaultLimits()),
				"credential":   ValidateJSON("CredentialFacts", credential, DefaultLimits()),
				"HTTP":         httpErr,
			} {
				if (err == nil) != sample.valid {
					t.Errorf("%s valid=%v: %v", boundary, sample.valid, err)
				}
			}
		})
	}
}

func TestMIMEHeaderBoundaries(t *testing.T) {
	for _, sample := range readFixture[[]struct {
		Name        string `json:"name"`
		Operation   string `json:"operation"`
		Media       string `json:"media"`
		Disposition string `json:"disposition"`
		Mode        string `json:"mode"`
		Valid       bool   `json:"valid"`
	}](t, "http-headers.json") {
		t.Run(sample.Name, func(t *testing.T) {
			for _, exchange := range readFixture[[]exchange](t, "exchanges.json") {
				if exchange.Name != sample.Operation {
					continue
				}
				response := exchangeResponse(t, exchange)
				response.Header.Set("Content-Type", sample.Media)
				ctx := ResponseContext{DatasetID: fixtureDataset, Disposition: sample.Mode}
				if sample.Operation == "ReadObjectContent" {
					response.Header.Set("Content-Disposition", sample.Disposition)
				}
				_, err := ValidateResponse(sample.Operation, response, ctx, DefaultLimits())
				if (err == nil) != sample.Valid {
					t.Fatalf("valid=%v: %v", sample.Valid, err)
				}
				return
			}
			t.Fatal("missing exchange")
		})
	}
}

func TestCallerOwnedFileStaging(t *testing.T) {
	const digest = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
	contentFixture := readFixture[struct {
		Descriptor UploadObjectDescriptor `json:"descriptor"`
		Object     Object                 `json:"object"`
		Hex        string                 `json:"hex"`
	}](t, "content.json")
	if contentFixture.Object.Sha256 != digest {
		t.Fatal("unexpected source digest")
	}
	for _, direction := range []string{"upload", "download"} {
		for _, content := range []string{"abc", "ab", "abd"} {
			t.Run(direction+"/"+content, func(t *testing.T) {
				root := t.TempDir()
				sourcePath, stagePath, finalPath := filepath.Join(root, "source"), filepath.Join(root, "staging"), filepath.Join(root, "verified")
				if err := os.WriteFile(sourcePath, []byte(content), 0600); err != nil {
					t.Fatal(err)
				}
				source, err := os.Open(sourcePath)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := source.Close(); err != nil {
						t.Error(err)
					}
				})
				stage, err := os.Create(stagePath)
				if err != nil {
					t.Fatal(err)
				}
				t.Cleanup(func() {
					if err := stage.Close(); err != nil && !errors.Is(err, os.ErrClosed) {
						t.Error(err)
					}
				})
				stream := io.TeeReader(source, stage)
				descriptor := UploadObjectDescriptor{ObjectId: fixtureDataset, RequestId: fixtureRun, ByteLength: "3", Sha256: digest, ContentType: "text/plain", Metadata: ObjectMetadata{Name: "source.txt", EntityIds: []Identifier{}, TaskIds: []Identifier{}}}
				if direction == "upload" {
					wire, encodeErr := Encode("UploadObjectDescriptor", descriptor, DefaultLimits())
					if encodeErr != nil {
						t.Fatal(encodeErr)
					}
					req, requestErr := http.NewRequest("POST", "https://atlas.invalid/objects", stream)
					if requestErr != nil {
						t.Fatal(requestErr)
					}
					req.Header = headers()
					req.Header.Set("Content-Type", "application/octet-stream")
					req.Header.Set("Atlas-Object-Descriptor", base64.RawURLEncoding.EncodeToString(wire))
					var result RequestData
					result, err = ValidateRequest("UploadObject", req, fixtureDataset, DefaultLimits())
					if err == nil && (result.Upload == nil || result.Upload.Sha256 != digest || result.Upload.ByteLength != "3") {
						t.Fatal("upload lost verified descriptor")
					}
				} else {
					h := headers()
					h.Set("Content-Type", "text/plain")
					h.Set("Content-Length", "3")
					h.Set("Content-Digest", "sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:")
					h.Set("Content-Disposition", "attachment")
					_, err = ValidateResponse("ReadObjectContent", &http.Response{StatusCode: 200, Header: h, Body: io.NopCloser(stream)}, ResponseContext{DatasetID: fixtureDataset, Object: &contentFixture.Object, Disposition: "attachment"}, DefaultLimits())
				}
				if closeErr := stage.Close(); closeErr != nil {
					t.Fatal(closeErr)
				}
				if content != "abc" {
					if err == nil {
						t.Fatal("invalid transfer verified")
					}
					if _, statErr := os.Stat(finalPath); !errors.Is(statErr, os.ErrNotExist) {
						t.Fatalf("invalid transfer committed: %v", statErr)
					}
					return
				}
				if err != nil {
					t.Fatal(err)
				}
				if err := os.Rename(stagePath, finalPath); err != nil {
					t.Fatal(err)
				}
				stored, err := os.ReadFile(finalPath)
				if err != nil || string(stored) != "abc" {
					t.Fatalf("verified bytes changed: %q, %v", stored, err)
				}
			})
		}
	}
}
