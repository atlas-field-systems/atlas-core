// This executable belongs to test tooling. Its routes and storage are never
// shipped as operational Core behavior.
package main

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"
	"time"

	"github.com/atlas-field-systems/atlas-core/httpcontract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/contract"
	"github.com/atlas-field-systems/atlas-core/tests/contractfixture/generated/storage"
	"github.com/getkin/kin-openapi/openapi3"
	_ "modernc.org/sqlite"
)

const datasetID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
const protocolVersion = "0.2.0"

type fixtureServer struct {
	queries     *storage.Queries
	dataset     contract.Identifier
	patchSchema *openapi3.SchemaRef
	contentDir  string
}

func (s *fixtureServer) save(ctx context.Context, value contract.FixtureValue) error {
	encoded, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode fixture value: %w", err)
	}
	if err := s.queries.PutValue(ctx, storage.PutValueParams{Key: "value", Value: string(encoded)}); err != nil {
		return fmt.Errorf("store fixture value: %w", err)
	}
	return nil
}

func (s *fixtureServer) read(ctx context.Context) (contract.FixtureValue, error) {
	encoded, err := s.queries.ReadValue(ctx, "value")
	if err != nil {
		return contract.FixtureValue{}, fmt.Errorf("read fixture value: %w", err)
	}
	var value contract.FixtureValue
	if err := json.Unmarshal([]byte(encoded), &value); err != nil {
		return value, fmt.Errorf("decode fixture value: %w", err)
	}
	return value, nil
}

func (s *fixtureServer) GetValue(ctx context.Context, request contract.GetValueRequestObject) (contract.GetValueResponseObject, error) {
	value, err := s.read(ctx)
	if err != nil {
		return nil, err
	}
	return contract.GetValue200JSONResponse{
		Body:    contract.FixtureValueResponse{DatasetId: s.dataset, Data: value},
		Headers: contract.GetValue200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}

func (s *fixtureServer) PutValue(ctx context.Context, request contract.PutValueRequestObject) (contract.PutValueResponseObject, error) {
	if request.Body == nil {
		return nil, errors.New("validated fixture body missing")
	}
	if err := s.save(ctx, *request.Body); err != nil {
		return nil, err
	}
	return contract.PutValue200JSONResponse{
		Body:    contract.FixtureValueMutationResponse{DatasetId: s.dataset, Data: *request.Body, CommitCursor: "fixture:commit:1"},
		Headers: contract.PutValue200ResponseHeaders{AtlasDatasetID: s.dataset, AtlasProtocolVersion: request.Params.AtlasProtocolVersion},
	}, nil
}

func run() (result error) {
	dataDir := flag.String("data-dir", "", "runner-owned private fixture directory")
	mode := flag.String("mode", "normal", "test-only startup control")
	flag.Parse()
	if *dataDir == "" {
		return errors.New("data-dir is required")
	}
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := os.Mkdir(filepath.Join(*dataDir, "content"), 0o700); err != nil {
		return fmt.Errorf("create private fixture files: %w", err)
	}
	db, err := sql.Open("sqlite", filepath.Join(*dataDir, "fixture.sqlite"))
	if err != nil {
		return fmt.Errorf("open fixture SQLite: %w", err)
	}
	defer func() { result = errors.Join(result, db.Close()) }()
	db.SetMaxOpenConns(1)
	schema, err := os.ReadFile(filepath.Join("tests", "contract", "sql", "schema.sql"))
	if err != nil {
		return fmt.Errorf("read authored fixture SQL: %w", err)
	}
	if _, err := db.ExecContext(ctx, "PRAGMA journal_mode=WAL;"+string(schema)); err != nil {
		return fmt.Errorf("initialize fixture SQLite: %w", err)
	}
	var sqliteVersion, journalMode string
	if err := db.QueryRowContext(ctx, "SELECT sqlite_version()").Scan(&sqliteVersion); err != nil {
		return fmt.Errorf("read SQLite version: %w", err)
	}
	if err := db.QueryRowContext(ctx, "PRAGMA journal_mode").Scan(&journalMode); err != nil {
		return fmt.Errorf("read SQLite journal mode: %w", err)
	}
	var seed struct {
		Initial contract.FixtureValue `json:"initial"`
	}
	initial, err := os.ReadFile(filepath.Join("tests", "contract", "fixtures.json"))
	if err != nil {
		return fmt.Errorf("read fixture seed: %w", err)
	}
	if err := json.Unmarshal(initial, &seed); err != nil {
		return fmt.Errorf("decode fixture seed: %w", err)
	}
	var dataset contract.Identifier
	if err := dataset.UnmarshalText([]byte(datasetID)); err != nil {
		return fmt.Errorf("decode fixture Dataset: %w", err)
	}
	fixture := &fixtureServer{queries: storage.New(db), dataset: dataset, contentDir: filepath.Join(*dataDir, "content")}
	if err := fixture.save(ctx, seed.Initial); err != nil {
		return err
	}
	if err := fixture.initializePatch(ctx); err != nil {
		return err
	}
	if *mode == "startup_failure" {
		return errors.New("controlled fixture startup failure after private SQLite initialization")
	}
	spec, err := contract.GetSwagger()
	if err != nil {
		return fmt.Errorf("load generated fixture contract: %w", err)
	}
	if err := spec.Validate(ctx); err != nil {
		return fmt.Errorf("validate fixture contract: %w", err)
	}
	fixture.patchSchema = spec.Components.Schemas["FixturePatchResource"]
	binding := contract.HandlerWithOptions(contract.NewStrictHandlerWithOptions(fixture, nil, contract.StrictHTTPServerOptions{
		RequestErrorHandlerFunc: httpcontract.RequestError,
		ResponseErrorHandlerFunc: func(w http.ResponseWriter, r *http.Request, err error) {
			log.Printf("fixture handler: %v", err)
			httpcontract.WriteError(w, http.StatusInternalServerError, "internal_error", "Fixture request failed")
		},
	}), contract.StdHTTPServerOptions{ErrorHandlerFunc: httpcontract.RequestError})
	validated, err := httpcontract.ValidateBinaryRequests(spec, binding, "PutFixtureContent", fixtureContentLimit, 4096)
	if err != nil {
		return fmt.Errorf("configure fixture binary validation: %w", err)
	}
	if *mode == "request_hooks" {
		// This diagnostic mode deliberately bypasses schema/document checks to
		// reach generated error hooks, while retaining its finite body bound.
		validated = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.Body != nil && r.Body != http.NoBody {
				r.Body = http.MaxBytesReader(w, r.Body, 4096)
			}
			binding.ServeHTTP(w, r)
		})
	}
	handler := fixtureContext(validated)
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return fmt.Errorf("listen for fixture HTTP: %w", err)
	}
	server := &http.Server{Handler: handler, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 5 * time.Second, WriteTimeout: 5 * time.Second, IdleTimeout: 5 * time.Second}
	served := make(chan error, 1)
	go func() { served <- server.Serve(listener) }()
	if *mode != "missing_readiness" {
		if err := json.NewEncoder(os.Stdout).Encode(struct {
			Event         string `json:"event"`
			BaseURL       string `json:"baseUrl"`
			SQLiteVersion string `json:"sqliteVersion"`
			JournalMode   string `json:"journalMode"`
		}{Event: "ready", BaseURL: "http://" + listener.Addr().String(), SQLiteVersion: sqliteVersion, JournalMode: journalMode}); err != nil {
			return errors.Join(fmt.Errorf("publish fixture readiness: %w", err), server.Close())
		}
	}
	select {
	case err := <-served:
		return fmt.Errorf("serve fixture HTTP: %w", err)
	case <-ctx.Done():
	}
	shutdown, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := server.Shutdown(shutdown); err != nil {
		return errors.Join(fmt.Errorf("shutdown fixture HTTP: %w", err), server.Close())
	}
	if err := <-served; !errors.Is(err, http.ErrServerClosed) {
		return fmt.Errorf("finish fixture HTTP: %w", err)
	}
	return nil
}

func main() {
	if err := run(); err != nil {
		log.Print(err)
		os.Exit(1)
	}
}
