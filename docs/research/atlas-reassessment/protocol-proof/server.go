package main

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"mime"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"slices"
	"strconv"
	"syscall"
	"time"

	"atlas.example/protocol-proof/generated/contract"
	"atlas.example/protocol-proof/generated/storage"
	"github.com/getkin/kin-openapi/openapi3filter"
	middleware "github.com/oapi-codegen/nethttp-middleware"
	"github.com/oapi-codegen/nullable"
	_ "modernc.org/sqlite"
)

// These are proof fixtures, not Atlas resource implementations.
//
//go:embed schema.sql
var ddl string

//go:embed fixtures.json
var fixtures []byte

//go:embed protocol.json
var protocol []byte

const datasetID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"

type proofServer struct {
	cursor  string
	dataset contract.ResponseContext

	queries     *storage.Queries
	initial     contract.Asset
	object      contract.ObjectMetadata
	contentPath string
}

func (s *proofServer) reset(ctx context.Context) error { return s.save(ctx, s.initial) }
func (s *proofServer) save(ctx context.Context, asset contract.Asset) error {
	value, err := json.Marshal(asset)
	if err != nil {
		return fmt.Errorf("encode Asset: %w", err)
	}
	if err := s.queries.PutEntity(ctx, storage.PutEntityParams{ID: asset.Id.String(), Value: string(value)}); err != nil {
		return fmt.Errorf("store Asset: %w", err)
	}
	return nil
}
func (s *proofServer) entity(ctx context.Context) (contract.Entity, error) {
	value, err := s.queries.ReadEntity(ctx, s.initial.Id.String())
	if err != nil {
		return contract.Entity{}, fmt.Errorf("read Asset: %w", err)
	}
	var entity contract.Entity
	if err := json.Unmarshal([]byte(value), &entity); err != nil {
		return entity, fmt.Errorf("decode stored Entity: %w", err)
	}
	return entity, nil
}
func (s *proofServer) GetEntity(ctx context.Context, r contract.GetEntityRequestObject) (contract.GetEntityResponseObject, error) {
	entity, err := s.entity(ctx)
	if err != nil {
		return nil, err
	}
	return contract.GetEntity200JSONResponse{Body: contract.EntityResponse{DatasetId: s.dataset.DatasetId, Data: entity}}, nil
}
func (s *proofServer) PatchEntity(ctx context.Context, r contract.PatchEntityRequestObject) (contract.PatchEntityResponseObject, error) {
	entity, err := s.entity(ctx)
	if err != nil {
		return nil, err
	}
	asset, err := entity.AsAsset()
	if err != nil {
		return nil, fmt.Errorf("decode Asset variant: %w", err)
	}
	patch := r.Body
	if patch == nil {
		return nil, errors.New("validated patch body missing")
	}
	if patch.Alias.IsSpecified() {
		asset.Alias = patch.Alias
	}
	if patch.Labels.IsSpecified() {
		asset.Labels = patch.Labels
	}
	if patch.FixtureComponent.IsSpecified() {
		if patch.FixtureComponent.IsNull() {
			asset.FixtureComponent = nullable.NewNullNullable[contract.FixtureComponent]()
		} else {
			update, err := patch.FixtureComponent.Get()
			if err != nil {
				return nil, fmt.Errorf("read fixture component patch: %w", err)
			}
			current, err := asset.FixtureComponent.Get()
			if err != nil {
				return nil, fmt.Errorf("patch cleared fixture component: %w", err)
			}
			if update.Left != nil {
				current.Left = *update.Left
			}
			if update.Right != nil {
				current.Right = *update.Right
			}
			asset.FixtureComponent = nullable.NewNullableWithValue(current)
		}
	}
	if err := s.save(ctx, asset); err != nil {
		return nil, err
	}
	entity, err = s.entity(ctx)
	if err != nil {
		return nil, err
	}
	return contract.PatchEntity200JSONResponse{Body: contract.EntityResponse{DatasetId: s.dataset.DatasetId, Data: entity, CommitCursor: &s.cursor}}, nil
}
func (s *proofServer) ExecuteCommand(ctx context.Context, r contract.ExecuteCommandRequestObject) (contract.ExecuteCommandResponseObject, error) {
	if r.Body == nil {
		return nil, errors.New("validated Command body missing")
	}
	return contract.ExecuteCommand200JSONResponse{Body: contract.CommandResponse{DatasetId: s.dataset.DatasetId, Data: *r.Body, CommitCursor: &s.cursor}}, nil
}
func (s *proofServer) AcceptReport(ctx context.Context, r contract.AcceptReportRequestObject) (contract.AcceptReportResponseObject, error) {
	if r.Body == nil {
		return nil, errors.New("validated report body missing")
	}
	return contract.AcceptReport200JSONResponse{Body: contract.TaskReportResponse{DatasetId: s.dataset.DatasetId, Data: *r.Body, CommitCursor: &s.cursor}}, nil
}
func (s *proofServer) GetObject(ctx context.Context, r contract.GetObjectRequestObject) (contract.GetObjectResponseObject, error) {
	return contract.GetObject200JSONResponse{Body: contract.ObjectMetadataResponse{DatasetId: s.dataset.DatasetId, Data: s.object}}, nil
}
func (s *proofServer) PutObject(ctx context.Context, r contract.PutObjectRequestObject) (contract.PutObjectResponseObject, error) {
	file, err := os.Create(s.contentPath)
	if err != nil {
		return nil, fmt.Errorf("open proof content: %w", err)
	}
	n, writeErr := io.Copy(file, r.Body)
	closeErr := file.Close()
	if writeErr != nil {
		return nil, fmt.Errorf("write proof content: %w", writeErr)
	}
	if closeErr != nil {
		return nil, fmt.Errorf("close proof content: %w", closeErr)
	}
	s.object.SizeBytes = strconv.FormatInt(n, 10)
	return contract.PutObject200JSONResponse{Body: contract.ObjectMetadataResponse{DatasetId: s.dataset.DatasetId, Data: s.object, CommitCursor: &s.cursor}}, nil
}
func (s *proofServer) GetContent(ctx context.Context, r contract.GetContentRequestObject) (contract.GetContentResponseObject, error) {
	file, err := os.Open(s.contentPath)
	if err != nil {
		return nil, fmt.Errorf("open proof download: %w", err)
	}
	stat, err := file.Stat()
	if err != nil {
		closeErr := file.Close()
		return nil, errors.Join(fmt.Errorf("size proof download: %w", err), closeErr)
	}
	return contract.GetContent200ApplicationoctetStreamResponse{Body: file, ContentLength: stat.Size()}, nil
}
func writeError(w http.ResponseWriter, status int, code contract.ErrorInfoCode) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(contract.Error{Error: contract.ErrorInfo{Code: code, Message: "Request rejected", RequestId: [16]byte{}}}); err != nil {
		log.Printf("write proof error: %v", err)
	}
}
func run() (result error) {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	dir, err := os.MkdirTemp("", "atlas-protocol-proof-")
	if err != nil {
		return err
	}
	defer func() {
		if err := os.RemoveAll(dir); err != nil {
			result = errors.Join(result, fmt.Errorf("remove proof data: %w", err))
		}
	}()
	db, err := sql.Open("sqlite", filepath.Join(dir, "proof.sqlite"))
	if err != nil {
		return err
	}
	defer func() {
		if err := db.Close(); err != nil {
			result = errors.Join(result, fmt.Errorf("close proof database: %w", err))
		}
	}()
	db.SetMaxOpenConns(1)
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL;"+ddl); err != nil {
		return fmt.Errorf("initialize SQLite: %w", err)
	}
	var sqliteVersion string
	if err := db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&sqliteVersion); err != nil {
		return err
	}
	var seed struct {
		Asset  contract.Asset          `json:"asset"`
		Object contract.ObjectMetadata `json:"object"`
	}
	if err := json.Unmarshal(fixtures, &seed); err != nil {
		return err
	}
	var responseContext contract.ResponseContext
	if err := json.Unmarshal([]byte(`{"dataset_id":"`+datasetID+`"}`), &responseContext); err != nil {
		return err
	}
	s := &proofServer{cursor: "fixture:commit:1", dataset: responseContext, queries: storage.New(db), initial: seed.Asset, object: seed.Object, contentPath: filepath.Join(dir, "object.bin")}
	if err := s.reset(ctx); err != nil {
		return err
	}
	var compatibility struct {
		Versions []string `json:"x-atlas-supported-protocol-versions"`
	}
	if err := json.Unmarshal(protocol, &compatibility); err != nil {
		return err
	}
	spec, err := contract.GetSwagger()
	if err != nil {
		return err
	}
	if err := spec.Validate(ctx); err != nil {
		return fmt.Errorf("validate Protocol: %w", err)
	}
	requestError := func(w http.ResponseWriter, r *http.Request, err error) {
		writeError(w, http.StatusBadRequest, contract.InvalidRequest)
	}
	invalidRequest := func(ctx context.Context, err error, w http.ResponseWriter, r *http.Request, opts middleware.ErrorHandlerOpts) {
		requestError(w, r, err)
	}
	binding := contract.HandlerWithOptions(contract.NewStrictHandlerWithOptions(s, nil, contract.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: requestError,
	}), contract.StdHTTPServerOptions{ErrorHandlerFunc: requestError})
	api := middleware.OapiRequestValidatorWithOptions(spec, &middleware.Options{ErrorHandlerWithOpts: invalidRequest})(binding)
	// The default binary decoder reads the entire body. Keep bulk transfer as an
	// io.Reader and validate its content type from the same authored operation.
	streamingAPI := middleware.OapiRequestValidatorWithOptions(spec, &middleware.Options{
		ErrorHandlerWithOpts: invalidRequest,
		Options:              openapi3filter.Options{ExcludeRequestBody: true},
	})(binding)
	handler := http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		version := r.Header.Get("Atlas-Protocol-Version")
		w.Header().Set("Atlas-Protocol-Version", version)
		w.Header().Set("Atlas-Dataset-ID", datasetID)
		if !slices.Contains(compatibility.Versions, version) {
			writeError(w, http.StatusUpgradeRequired, contract.UnsupportedProtocol)
			return
		}
		if r.Header.Get("Atlas-Dataset-ID") != datasetID {
			writeError(w, http.StatusConflict, contract.DatasetMismatch)
			return
		}
		if r.URL.Path == "/__fixture/reset" {
			if err := s.reset(r.Context()); err != nil {
				http.Error(w, "fixture reset failed", 500)
				return
			}
			w.WriteHeader(204)
			return
		}
		// Inject real malformed successful responses at the HTTP boundary.
		if r.URL.Path == "/entity" && r.URL.Query().Get("fault") != "" {
			w.Header().Set("Content-Type", "application/json")
			switch r.URL.Query().Get("fault") {
			case "shape":
				if _, err := io.WriteString(w, `{"dataset_id":"aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa","data":{"type":"asset","id":7}}`); err != nil {
					log.Printf("write fixture response: %v", err)
				}
			case "json":
				if _, err := io.WriteString(w, `{`); err != nil {
					log.Printf("write fixture response: %v", err)
				}
			case "enum", "media":
				entity, err := s.entity(r.Context())
				if err != nil {
					http.Error(w, "read fixture failed", 500)
					return
				}
				asset, err := entity.AsAsset()
				if err != nil {
					http.Error(w, "read Asset fixture failed", 500)
					return
				}
				if r.URL.Query().Get("fault") == "enum" {
					asset.OperationalStatus = "flying"
				} else {
					w.Header().Set("Content-Type", "text/plain")
				}

				if err := entity.FromAsset(asset); err != nil {
					http.Error(w, "encode fixture failed", 500)
					return
				}
				if err := json.NewEncoder(w).Encode(contract.EntityResponse{DatasetId: s.dataset.DatasetId, Data: entity}); err != nil {
					log.Printf("write fixture response: %v", err)
				}
			case "dataset":
				w.Header().Set("Atlas-Dataset-ID", "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb")
				value, err := s.entity(r.Context())
				if err != nil {
					http.Error(w, "read fixture failed", 500)
					return
				}
				if err := json.NewEncoder(w).Encode(contract.EntityResponse{DatasetId: s.dataset.DatasetId, Data: value}); err != nil {
					log.Printf("write fixture response: %v", err)
				}

			case "dataset_body":
				value, err := s.entity(r.Context())
				if err != nil {
					http.Error(w, "read fixture failed", 500)
					return
				}
				var context contract.ResponseContext
				if err := json.Unmarshal([]byte(`{"dataset_id":"bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"}`), &context); err != nil {
					http.Error(w, "read Dataset fixture failed", 500)
					return
				}
				if err := json.NewEncoder(w).Encode(contract.EntityResponse{DatasetId: context.DatasetId, Data: value}); err != nil {
					log.Printf("write fixture response: %v", err)
				}
			case "version":
				w.Header().Set("Atlas-Protocol-Version", "9.0.0")
				value, err := s.entity(r.Context())
				if err != nil {
					http.Error(w, "read fixture failed", 500)
					return
				}
				if err := json.NewEncoder(w).Encode(contract.EntityResponse{DatasetId: s.dataset.DatasetId, Data: value}); err != nil {
					log.Printf("write fixture response: %v", err)
				}
			default:
				http.Error(w, "unknown fixture fault", 400)
			}
			return
		}
		r.Body = http.MaxBytesReader(w, r.Body, 4096)
		if r.Method == http.MethodPut && r.URL.Path == "/object" {
			mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
			content := spec.Paths.Find("/object").Put.RequestBody.Value.Content
			if err != nil || content[mediaType] == nil {
				writeError(w, http.StatusBadRequest, contract.InvalidRequest)
				return
			}
			streamingAPI.ServeHTTP(w, r)
			return
		}
		api.ServeHTTP(w, r)
	})
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second}
	results := make(chan error, 1)
	go func() { results <- server.Serve(listener) }()
	fmt.Printf("ready http://%s sqlite=%s\n", listener.Addr(), sqliteVersion)
	select {
	case err := <-results:
		if !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	case <-ctx.Done():
		shutdown, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if err := server.Shutdown(shutdown); err != nil {
			return err
		}
		if err := <-results; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	return nil
}
func main() {
	if err := run(); err != nil {
		log.Fatal(err)
	}
}
