package atlas

import (
	"bytes"
	"crypto/sha1"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/getkin/kin-openapi/openapi3"
)

var bearerGrammar = regexp.MustCompile(`^Bearer [A-Za-z0-9_-]{43,128}$`)

type RequestData struct {
	JSON   []byte
	Upload *UploadObjectDescriptor
}
type binding struct {
	QuerySchema    string `json:"query_schema"`
	BodySchema     string `json:"body_schema"`
	ResponseSchema string `json:"response_schema"`
}

func operation(name string) (string, string, *openapi3.Operation, error) {
	doc, err := loadContract()
	if err != nil {
		return "", "", nil, err
	}
	for path, item := range doc.Paths.Map() {
		for method, op := range item.Operations() {
			if op.OperationID == name {
				return path, method, op, nil
			}
		}
	}
	return "", "", nil, fmt.Errorf("unknown operation %s", name)
}
func bindingFor(op *openapi3.Operation) (binding, error) {
	b, err := json.Marshal(op.Extensions["x-atlas-binding"])
	if err != nil {
		return binding{}, err
	}
	var v binding
	err = json.Unmarshal(b, &v)
	return v, err
}
func oneHeader(headers http.Header, key string) (string, error) {
	var values []string
	for name, v := range headers {
		if strings.EqualFold(name, key) {
			values = append(values, v...)
		}
	}
	if len(values) != 1 || values[0] == "" {
		return "", fmt.Errorf("expected one %s header", key)
	}
	return values[0], nil
}
func contextHeaders(headers http.Header, expected string, checkVersion bool) (string, string, error) {
	dataset, err := oneHeader(headers, "Atlas-Dataset-ID")
	if err != nil {
		return "", "", err
	}
	if err := ValidateJSON("Identifier", []byte(strconv.Quote(dataset)), DefaultLimits()); err != nil {
		return "", "", err
	}
	version, err := oneHeader(headers, "Atlas-Protocol-Version")
	if err != nil {
		return "", "", err
	}
	if len(version) > 128 || !utf8.ValidString(version) || strings.ContainsAny(version, ",\r\n") {
		return "", "", fmt.Errorf("invalid Protocol version header")
	}
	if expected != "" && !strings.EqualFold(dataset, expected) {
		return "", "", fmt.Errorf("dataset_mismatch")
	}
	if checkVersion && version != Version() {
		return "", "", fmt.Errorf("protocol_mismatch")
	}
	return dataset, version, nil
}
func media(headers http.Header) (string, error) {
	raw, err := oneHeader(headers, "Content-Type")
	if err != nil {
		return "", err
	}
	kind, params, err := mime.ParseMediaType(raw)
	if err != nil {
		return "", err
	}
	if charset, ok := params["charset"]; ok && !strings.EqualFold(charset, "utf-8") {
		return "", fmt.Errorf("unsupported_media_type")
	}
	return kind, nil
}
func readBounded(reader io.Reader, limits Limits) ([]byte, error) {
	if err := limits.check(); err != nil {
		return nil, err
	}
	if reader == nil {
		return nil, nil
	}
	data, err := io.ReadAll(io.LimitReader(reader, int64(limits.MaxJSONBytes)+1))
	if err != nil {
		return nil, err
	}
	if len(data) > limits.MaxJSONBytes {
		return nil, fmt.Errorf("payload_too_large")
	}
	return data, nil
}
func pathFacts(pattern, path string) (map[string]string, error) {
	expected, actual := strings.Split(pattern, "/"), strings.Split(path, "/")
	if len(expected) != len(actual) {
		return nil, fmt.Errorf("wrong path")
	}
	facts := map[string]string{}
	for i, part := range expected {
		if strings.HasPrefix(part, "{") {
			v, err := url.PathUnescape(actual[i])
			if err != nil || !utf8.ValidString(v) {
				return nil, fmt.Errorf("invalid path encoding")
			}
			facts[strings.Trim(part, "{}")] = v
		} else if part != actual[i] {
			return nil, fmt.Errorf("wrong path")
		}
	}
	return facts, nil
}
func queryJSON(raw string, op *openapi3.Operation, limits Limits) ([]byte, error) {
	if len(raw) > limits.MaxJSONBytes {
		return nil, fmt.Errorf("payload_too_large")
	}
	values, err := url.ParseQuery(raw)
	if err != nil {
		return nil, err
	}
	if len(values) > limits.MaxValues {
		return nil, fmt.Errorf("query work limit")
	}
	result := map[string]json.RawMessage{}
	for key, values := range values {
		if len(values) != 1 || !utf8.ValidString(key) || !utf8.ValidString(values[0]) {
			return nil, fmt.Errorf("duplicate or malformed query")
		}
		var parameter *openapi3.Parameter
		for _, p := range op.Parameters {
			if p.Value.In == "query" && p.Value.Name == key {
				parameter = p.Value
				break
			}
		}
		if parameter == nil {
			return nil, fmt.Errorf("unsupported_filter")
		}
		schema := parameter.Schema
		if schema == nil {
			schema = parameter.Content["application/json"].Schema
		}
		if schema.Value.Type.Is("string") {
			b, err := json.Marshal(values[0])
			if err != nil {
				return nil, err
			}
			result[key] = b
		} else {
			if err := scan([]byte(values[0]), limits); err != nil {
				return nil, err
			}
			result[key] = json.RawMessage(values[0])
		}
	}
	return json.Marshal(result)
}

// ValidateRequest consumes the body. The caller owns authentication, staging and commit authority.
func ValidateRequest(name string, req *http.Request, expectedDataset string, limits Limits) (RequestData, error) {
	var result RequestData
	if err := limits.check(); err != nil {
		return result, err
	}
	pattern, method, op, err := operation(name)
	if err != nil {
		return result, err
	}
	if req.Method != method {
		return result, fmt.Errorf("wrong method")
	}
	facts, err := pathFacts(pattern, req.URL.EscapedPath())
	if err != nil {
		return result, err
	}
	if name != "SubscribeChanges" {
		key, err := oneHeader(req.Header, "Authorization")
		if err != nil || !strings.HasPrefix(key, "Bearer ") || !bearerGrammar.MatchString(key) {
			return result, fmt.Errorf("unauthenticated")
		}
		if name != "GetHealth" {
			if _, _, err := contextHeaders(req.Header, expectedDataset, true); err != nil {
				return result, err
			}
		}
	}
	for _, p := range op.Parameters {
		if p.Value.In == "path" {
			if err := p.Value.Schema.Value.VisitJSON(facts[p.Value.Name]); err != nil {
				return result, err
			}
		}
	}
	bind, err := bindingFor(op)
	if err != nil {
		return result, err
	}
	query, err := queryJSON(req.URL.RawQuery, op, limits)
	if err != nil {
		return result, err
	}
	if err := ValidateJSON(bind.QuerySchema, query, limits); err != nil {
		return result, err
	}
	if name == "SubscribeChanges" {
		data, err := readBounded(req.Body, limits)
		if err != nil {
			return result, err
		}
		if len(data) != 0 {
			return result, fmt.Errorf("unexpected body")
		}
		return result, checkUpgrade(req.Header)
	}
	if name == "UploadObject" {
		kind, err := media(req.Header)
		if err != nil || kind != "application/octet-stream" {
			return result, fmt.Errorf("unsupported_media_type")
		}
		raw, err := oneHeader(req.Header, "Atlas-Object-Descriptor")
		if err != nil {
			return result, err
		}
		if len(raw) > base64.RawURLEncoding.EncodedLen(limits.MaxJSONBytes) {
			return result, fmt.Errorf("payload_too_large")
		}
		data, err := base64.RawURLEncoding.Strict().DecodeString(raw)
		if err != nil {
			return result, err
		}
		descriptor, err := Decode[UploadObjectDescriptor]("UploadObjectDescriptor", data, limits)
		if err != nil {
			return result, err
		}
		if err := CheckContent(descriptor, req.Body, limits); err != nil {
			return result, err
		}
		result.Upload = &descriptor
		return result, nil
	}
	if bind.BodySchema != "" {
		kind, err := media(req.Header)
		if err != nil || kind != "application/json" {
			return result, fmt.Errorf("unsupported_media_type")
		}
		data, err := readBounded(req.Body, limits)
		if err != nil {
			return result, err
		}
		if err := ValidateJSON(bind.BodySchema, data, limits); err != nil {
			return result, err
		}
		var fields map[string]json.RawMessage
		if err := json.Unmarshal(data, &fields); err != nil {
			return result, err
		}
		for key, value := range facts {
			if raw, ok := fields[key]; ok {
				var id string
				if err := json.Unmarshal(raw, &id); err != nil {
					return result, err
				}
				if !strings.EqualFold(id, value) {
					return result, fmt.Errorf("path/body identity conflict")
				}
			}
		}
		if asset, ok := facts["asset_id"]; ok {
			var source AssetSource
			sourceRaw, hasSource := fields["source"]
			if raw, ok := fields["report"]; ok {
				var report map[string]json.RawMessage
				if err := json.Unmarshal(raw, &report); err != nil {
					return result, err
				}
				if raw, ok := report["source"]; ok {
					sourceRaw = raw
					hasSource = true
				}
			}
			if hasSource {
				raw := sourceRaw
				if err := json.Unmarshal(raw, &source); err != nil {
					return result, err
				}
				if !strings.EqualFold(source.AssetId, asset) {
					return result, fmt.Errorf("source/path identity conflict")
				}
			}
		}
		result.JSON = data
		return result, nil
	}
	data, err := readBounded(req.Body, limits)
	if err != nil {
		return result, err
	}
	if len(data) != 0 {
		return result, fmt.Errorf("unexpected body")
	}
	return result, nil
}
func checkUpgrade(headers http.Header) error {
	for key, want := range map[string]string{"Upgrade": "websocket", "Sec-WebSocket-Version": "13"} {
		got, err := oneHeader(headers, key)
		if err != nil || !strings.EqualFold(got, want) {
			return fmt.Errorf("invalid WebSocket upgrade")
		}
	}
	connection, err := oneHeader(headers, "Connection")
	if err != nil {
		return err
	}
	found := false
	for _, token := range strings.Split(connection, ",") {
		if strings.EqualFold(strings.TrimSpace(token), "upgrade") {
			found = true
		}
	}
	if !found {
		return fmt.Errorf("invalid WebSocket Connection")
	}
	key, err := oneHeader(headers, "Sec-WebSocket-Key")
	if err != nil {
		return err
	}
	data, err := base64.StdEncoding.Strict().DecodeString(key)
	if err != nil || len(data) != 16 {
		return fmt.Errorf("invalid WebSocket key")
	}
	return nil
}

func CheckContent(descriptor UploadObjectDescriptor, reader io.Reader, limits Limits) error {
	if _, err := Encode("UploadObjectDescriptor", descriptor, limits); err != nil {
		return err
	}
	size, err := strconv.ParseUint(descriptor.ByteLength, 10, 64)
	if err != nil {
		return err
	}
	if size > uint64(limits.MaxFileBytes) {
		return fmt.Errorf("payload_too_large")
	}
	if reader == nil {
		reader = bytes.NewReader(nil)
	}
	hash := sha256.New()
	n, err := io.Copy(hash, io.LimitReader(reader, int64(size)))
	if err != nil {
		return err
	}
	var extra [1]byte
	more, readErr := io.ReadFull(reader, extra[:])
	if readErr != nil && readErr != io.EOF {
		return readErr
	}
	if uint64(n) != size || more != 0 || hex.EncodeToString(hash.Sum(nil)) != descriptor.Sha256 {
		return fmt.Errorf("integrity_fault")
	}
	return nil
}

// ValidateResponse consumes the body. Failure cannot prove that a mutation did not commit.
type ResponseContext struct {
	DatasetID    string
	Object       *Object
	WebSocketKey string
	Disposition  string
}

func ValidateResponse(name string, response *http.Response, ctx ResponseContext, limits Limits) ([]byte, error) {
	expectedDataset, expectedObject := ctx.DatasetID, ctx.Object
	_, _, op, err := operation(name)
	if err != nil {
		return nil, err
	}
	declared := op.Responses.Value(strconv.Itoa(response.StatusCode))
	if declared == nil {
		return nil, fmt.Errorf("undeclared response status")
	}
	refusal := response.StatusCode >= 400
	dataset, version, err := contextHeaders(response.Header, "", false)
	if err != nil {
		return nil, err
	}
	if !refusal && (version != Version() || expectedDataset != "" && !strings.EqualFold(dataset, expectedDataset)) {
		return nil, fmt.Errorf("response context mismatch")
	}
	if response.StatusCode == 101 {
		if name != "SubscribeChanges" {
			return nil, fmt.Errorf("unexpected upgrade")
		}
		return nil, checkUpgradeResponse(response.Header, ctx.WebSocketKey)
	}
	kind, err := media(response.Header)
	if err != nil {
		return nil, err
	}
	if name == "ReadObjectContent" && !refusal {
		size, err := oneHeader(response.Header, "Content-Length")
		if err != nil {
			return nil, err
		}
		digest, err := oneHeader(response.Header, "Content-Digest")
		if err != nil {
			return nil, err
		}
		if !strings.HasPrefix(digest, "sha-256=:") || !strings.HasSuffix(digest, ":") {
			return nil, fmt.Errorf("invalid digest")
		}
		hash, err := base64.StdEncoding.Strict().DecodeString(strings.TrimSuffix(strings.TrimPrefix(digest, "sha-256=:"), ":"))
		if err != nil || len(hash) != 32 {
			return nil, fmt.Errorf("invalid digest")
		}
		disposition, err := oneHeader(response.Header, "Content-Disposition")
		if err != nil {
			return nil, err
		}
		mode, _, err := mime.ParseMediaType(disposition)
		if err != nil || mode != "inline" && mode != "attachment" || ctx.Disposition != "" && mode != ctx.Disposition {
			return nil, fmt.Errorf("invalid disposition")
		}
		descriptor := UploadObjectDescriptor{ObjectId: dataset, RequestId: dataset, ByteLength: size, Sha256: hex.EncodeToString(hash), ContentType: kind, Metadata: ObjectMetadata{Name: "content", EntityIds: []Identifier{}, TaskIds: []Identifier{}}}
		if expectedObject != nil && (expectedObject.ByteLength != size || expectedObject.Sha256 != descriptor.Sha256 || expectedObject.ContentType != kind) {
			return nil, fmt.Errorf("object response mismatch")
		}
		return nil, CheckContent(descriptor, response.Body, limits)
	}
	content := declared.Value.Content[kind]
	if content == nil {
		return nil, fmt.Errorf("undeclared response media")
	}
	data, err := readBounded(response.Body, limits)
	if err != nil {
		return nil, err
	}
	if kind == "text/html" {
		if !utf8.Valid(data) {
			return nil, fmt.Errorf("invalid UTF-8")
		}
		return data, nil
	}
	if name == "GetReferenceDocument" && !refusal {
		if err := scan(data, limits); err != nil {
			return nil, err
		}
		var got, want interface{}
		if err := json.Unmarshal(data, &got); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(document, &want); err != nil {
			return nil, err
		}
		if !reflect.DeepEqual(got, want) {
			return nil, fmt.Errorf("reference document mismatch")
		}
		return data, nil
	}
	schemaName := strings.TrimPrefix(content.Schema.Ref, "#/components/schemas/")
	if err := ValidateJSON(schemaName, data, limits); err != nil {
		return nil, err
	}
	var envelope struct {
		DatasetID string `json:"dataset_id"`
		Error     struct {
			Code string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		return nil, err
	}
	if envelope.DatasetID != "" && !strings.EqualFold(envelope.DatasetID, dataset) {
		return nil, fmt.Errorf("body/header Dataset mismatch")
	}
	if expectedDataset != "" && !strings.EqualFold(dataset, expectedDataset) && envelope.Error.Code != "dataset_mismatch" {
		return nil, fmt.Errorf("response Dataset mismatch")
	}
	if version != Version() && envelope.Error.Code != "protocol_mismatch" {
		return nil, fmt.Errorf("response Protocol mismatch")
	}
	return data, nil
}
func checkUpgradeResponse(headers http.Header, key string) error {
	decoded, err := base64.StdEncoding.Strict().DecodeString(key)
	if err != nil || len(decoded) != 16 {
		return fmt.Errorf("original WebSocket key required")
	}
	for key, want := range map[string]string{"Upgrade": "websocket", "Connection": "Upgrade"} {
		got, err := oneHeader(headers, key)
		if err != nil || !strings.EqualFold(got, want) {
			return fmt.Errorf("invalid WebSocket response")
		}
	}
	raw, err := oneHeader(headers, "Sec-WebSocket-Accept")
	if err != nil {
		return err
	}
	v, err := base64.StdEncoding.Strict().DecodeString(raw)
	want := sha1.Sum([]byte(key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"))
	if err != nil || len(v) != 20 || !bytes.Equal(v, want[:]) {
		return fmt.Errorf("invalid WebSocket accept")
	}
	return nil
}
