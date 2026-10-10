package manager

import (
	"context"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/sha256"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/atlas-field-systems/atlas-core/canonical"
	"github.com/atlas-field-systems/atlas-core/coreconfig"
	"github.com/atlas-field-systems/atlas-core/corerun"
	"github.com/atlas-field-systems/atlas-core/system"
	"github.com/google/uuid"
)

// SetupOptions are first-time setup inputs. Secrets are read from and written
// to owner-only files, never taken from command arguments.
type SetupOptions struct {
	InstallationID string
	Image          string
	ListenAddress  string
	ListenPort     int64
	Hostnames      []string
	AllowedOrigins []string
	// AdminKeyFile holds the prepared first administrator key. Setup
	// generates and retains it there first when the file does not exist.
	AdminKeyFile string
	// EnrollmentAuthorityFile holds the deployment enrollment authority's
	// private key for deployment tooling. Core stores only its public key.
	EnrollmentAuthorityFile string
	// ServerCertificate and ServerKey optionally supply administrator trusted
	// certificate material instead of a generated installation CA.
	ServerCertificate, ServerKey string
	TestFaults                   bool
}

// SetupResult reports nonsecret setup facts for verification.
type SetupResult struct {
	InstallationID string
	CACertificate  string
	CAFingerprint  string
	Created        bool
}

// AdminKeyName names the first administrator credential.
const AdminKeyName = "first-administrator"

// Setup provisions an installation while operational serving is disabled:
// owned directories, trust material, initial Core settings, the first
// administrator credential verifier and the enrollment authority public key.
func Setup(ctx context.Context, installation Installation, options SetupOptions) (SetupResult, error) {
	if options.InstallationID == "" {
		options.InstallationID = uuid.NewString()
	}
	if _, err := uuid.Parse(options.InstallationID); err != nil {
		return SetupResult{}, fmt.Errorf("installation identity must be a UUID: %w", err)
	}
	if options.AdminKeyFile == "" || options.EnrollmentAuthorityFile == "" {
		return SetupResult{}, errors.New("setup requires an administrator key file and an enrollment authority file")
	}
	settings := coreconfig.Initial(options.ListenAddress, options.ListenPort, options.AllowedOrigins)
	if err := settings.Validate(); err != nil {
		return SetupResult{}, fmt.Errorf("initial settings: %w", err)
	}
	for _, directory := range []string{installation.Root, installation.Recovery} {
		if !filepath.IsAbs(directory) {
			return SetupResult{}, fmt.Errorf("owned path %s must be absolute", directory)
		}
	}
	if existing, err := installation.record(); err == nil && existing.InstallationID != options.InstallationID {
		return SetupResult{}, fmt.Errorf("the root already holds installation %s", existing.InstallationID)
	}
	for _, directory := range []string{
		installation.Root, installation.coreDir(), installation.setupDir(), installation.coreSetupDir(), filepath.Join(installation.coreSetupDir(), "tls"),
		installation.caDir(), installation.journalDir(), installation.logsDir(), installation.runDir(), installation.Recovery, installation.actionsDir(),
	} {
		if err := os.MkdirAll(directory, 0o700); err != nil {
			return SetupResult{}, fmt.Errorf("create owned directory: %w", err)
		}
	}
	image, err := resolveImage(ctx, options.Image)
	if err != nil {
		return SetupResult{}, err
	}
	lock, err := installation.acquire("")
	if err != nil {
		return SetupResult{}, err
	}
	defer func() { _ = lock.release() }()
	record := Record{
		Format: 1, InstallationID: options.InstallationID, Image: image, ListenAddress: options.ListenAddress, ListenPort: options.ListenPort,
		Hostnames: options.Hostnames, TestFaults: options.TestFaults, OwnerUID: os.Getuid(), OwnerGID: os.Getgid(),
	}
	identity, err := json.Marshal(corerun.InstallationRecord{Format: 1, InstallationID: options.InstallationID})
	if err != nil {
		return SetupResult{}, err
	}
	if err := writeDurable(installation.identityFile(), identity, 0o644); err != nil {
		return SetupResult{}, err
	}
	if _, err := os.Stat(installation.settingsFile()); errors.Is(err, os.ErrNotExist) {
		encoded, err := json.MarshalIndent(coreconfig.Document{Format: coreconfig.Format, Revision: 1, Settings: settings}, "", "  ")
		if err != nil {
			return SetupResult{}, err
		}
		if err := writeDurable(installation.settingsFile(), append(encoded, '\n'), 0o644); err != nil {
			return SetupResult{}, err
		}
	}
	if err := installation.provisionTLS(options); err != nil {
		return SetupResult{}, err
	}
	adminSecret, err := preparedSecret(options.AdminKeyFile)
	if err != nil {
		return SetupResult{}, err
	}
	enrollmentPublic, err := enrollmentAuthority(options.EnrollmentAuthorityFile)
	if err != nil {
		return SetupResult{}, err
	}
	if err := installation.writeCompose(record); err != nil {
		return SetupResult{}, err
	}
	encodedRecord, err := json.MarshalIndent(record, "", "  ")
	if err != nil {
		return SetupResult{}, err
	}
	if err := writeDurable(installation.recordFile(), append(encodedRecord, '\n'), 0o600); err != nil {
		return SetupResult{}, err
	}
	// Core performs setup in maintenance and is the sole SQLite accessor.
	if err := installation.startContainer(ctx); err != nil {
		return SetupResult{}, err
	}
	created, setupErr := func() (bool, error) {
		if err := installation.waitForPrivate(ctx, 30*time.Second); err != nil {
			return false, err
		}
		hello, err := installation.hello(ctx)
		if err != nil {
			return false, err
		}
		reply, err := corerun.Call(ctx, installation.socket(), corerun.Request{
			Action: corerun.ActionSetup, RunID: hello.RunID, InstallationID: options.InstallationID,
			AdminKeyName: AdminKeyName, AdminSecret: adminSecret, EnrollmentPublicKey: enrollmentPublic,
		})
		return reply.Created, err
	}()
	stopErr := installation.stopCore(ctx)
	if err := errors.Join(setupErr, stopErr); err != nil {
		return SetupResult{}, err
	}
	if created {
		if err := installation.appendJournal(newActivity("installation.setup", "installation", options.InstallationID, "completed", map[string]any{
			"listen_address": options.ListenAddress, "listen_port": options.ListenPort, "hostnames": options.Hostnames,
		})); err != nil {
			return SetupResult{}, err
		}
	}
	fingerprint, err := certificateFingerprint(installation.CACertificate())
	if err != nil {
		return SetupResult{}, err
	}
	return SetupResult{InstallationID: options.InstallationID, CACertificate: installation.CACertificate(), CAFingerprint: fingerprint, Created: created}, nil
}

// preparedSecret reads the retained administrator secret, generating it with
// a cryptographically secure source and retaining it before any submission.
func preparedSecret(path string) (string, error) {
	encoded, err := os.ReadFile(path)
	if err == nil {
		secret := strings.TrimSpace(string(encoded))
		if len(secret) < 43 {
			return "", errors.New("the administrator key file does not hold a prepared key")
		}
		return secret, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return "", fmt.Errorf("read administrator key file: %w", err)
	}
	raw := make([]byte, 32)
	if _, err := rand.Read(raw); err != nil {
		return "", fmt.Errorf("generate administrator key: %w", err)
	}
	secret := canonical.Encode(raw)
	if err := writeDurable(path, []byte(secret+"\n"), 0o600); err != nil {
		return "", err
	}
	return secret, nil
}

// enrollmentAuthority reads or creates the deployment enrollment authority's
// Ed25519 key, retaining the private key only in its owner-only file.
func enrollmentAuthority(path string) (string, error) {
	key, err := readEnrollmentKey(path)
	if errors.Is(err, os.ErrNotExist) {
		public, private, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return "", fmt.Errorf("generate enrollment authority: %w", err)
		}
		encoded := pem.EncodeToMemory(&pem.Block{Type: "ATLAS ENROLLMENT AUTHORITY", Bytes: private.Seed()})
		if err := writeDurable(path, encoded, 0o600); err != nil {
			return "", err
		}
		return canonical.Encode(public), nil
	}
	if err != nil {
		return "", err
	}
	return canonical.Encode(key.Public().(ed25519.PublicKey)), nil
}

func readEnrollmentKey(path string) (ed25519.PrivateKey, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	block, _ := pem.Decode(encoded)
	if block == nil || block.Type != "ATLAS ENROLLMENT AUTHORITY" || len(block.Bytes) != ed25519.SeedSize {
		return nil, errors.New("the enrollment authority file is unreadable")
	}
	return ed25519.NewKeyFromSeed(block.Bytes), nil
}

// provisionTLS installs supplied server material, or generates an
// installation CA and a server certificate naming every supported address.
func (i Installation) provisionTLS(options SetupOptions) error {
	certificatePath := filepath.Join(i.coreSetupDir(), "tls", "server.crt")
	keyPath := filepath.Join(i.coreSetupDir(), "tls", "server.key")
	if options.ServerCertificate != "" || options.ServerKey != "" {
		certificate, err := os.ReadFile(options.ServerCertificate)
		if err != nil {
			return fmt.Errorf("read supplied server certificate: %w", err)
		}
		key, err := os.ReadFile(options.ServerKey)
		if err != nil {
			return fmt.Errorf("read supplied server key: %w", err)
		}
		if err := writeDurable(certificatePath, certificate, 0o644); err != nil {
			return err
		}
		// The key is read by Core running as the installation owner.
		return writeDurable(keyPath, key, 0o600)
	}
	if _, err := os.Stat(i.CACertificate()); err == nil {
		return nil
	}
	caKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate installation CA key: %w", err)
	}
	now := time.Now().UTC()
	caTemplate := &x509.Certificate{
		SerialNumber: serial(), Subject: pkix.Name{CommonName: "Atlas installation CA", Organization: []string{"Atlas"}},
		NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true,
		KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign, MaxPathLenZero: true,
	}
	caDER, err := x509.CreateCertificate(rand.Reader, caTemplate, caTemplate, &caKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create installation CA: %w", err)
	}
	ca, err := x509.ParseCertificate(caDER)
	if err != nil {
		return err
	}
	serverKey, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return fmt.Errorf("generate server key: %w", err)
	}
	serverTemplate := &x509.Certificate{
		SerialNumber: serial(), Subject: pkix.Name{CommonName: options.ListenAddress},
		NotBefore: now.Add(-time.Hour), NotAfter: now.AddDate(2, 0, 0),
		KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	for _, name := range append([]string{options.ListenAddress}, options.Hostnames...) {
		if ip := net.ParseIP(name); ip != nil {
			serverTemplate.IPAddresses = append(serverTemplate.IPAddresses, ip)
		} else if name != "" {
			serverTemplate.DNSNames = append(serverTemplate.DNSNames, name)
		}
	}
	serverDER, err := x509.CreateCertificate(rand.Reader, serverTemplate, ca, &serverKey.PublicKey, caKey)
	if err != nil {
		return fmt.Errorf("create server certificate: %w", err)
	}
	caKeyDER, err := x509.MarshalECPrivateKey(caKey)
	if err != nil {
		return err
	}
	serverKeyDER, err := x509.MarshalECPrivateKey(serverKey)
	if err != nil {
		return err
	}
	for _, file := range []struct {
		path  string
		block *pem.Block
		perm  os.FileMode
	}{
		{filepath.Join(i.caDir(), "ca.key"), &pem.Block{Type: "EC PRIVATE KEY", Bytes: caKeyDER}, 0o600},
		{keyPath, &pem.Block{Type: "EC PRIVATE KEY", Bytes: serverKeyDER}, 0o600},
		{certificatePath, &pem.Block{Type: "CERTIFICATE", Bytes: serverDER}, 0o644},
		{i.CACertificate(), &pem.Block{Type: "CERTIFICATE", Bytes: caDER}, 0o644},
	} {
		if err := writeDurable(file.path, pem.EncodeToMemory(file.block), file.perm); err != nil {
			return err
		}
	}
	return nil
}

func serial() *big.Int {
	value, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 127))
	if err != nil {
		panic(err)
	}
	return value
}

// certificateFingerprint is the SHA-256 fingerprint of a PEM certificate for
// out-of-band verification through the local management channel.
func certificateFingerprint(path string) (string, error) {
	encoded, err := os.ReadFile(path)
	if err != nil {
		return "", fmt.Errorf("read CA certificate: %w", err)
	}
	block, _ := pem.Decode(encoded)
	if block == nil {
		return "", errors.New("CA certificate is not PEM")
	}
	sum := sha256.Sum256(block.Bytes)
	return hex.EncodeToString(sum[:]), nil
}

// AuthorizeEnrollment issues deployment enrollment authorization for one
// Asset ID and its recovery public key, signed by the enrollment authority.
func AuthorizeEnrollment(installation Installation, authorityFile, assetID, recoveryPublicKey string) (map[string]string, error) {
	record, err := installation.installationRecord()
	if err != nil {
		return nil, err
	}
	key, err := readEnrollmentKey(authorityFile)
	if err != nil {
		return nil, err
	}
	if _, err := uuid.Parse(assetID); err != nil {
		return nil, fmt.Errorf("Asset ID must be a UUID: %w", err)
	}
	if _, err := canonical.PublicKey(recoveryPublicKey); err != nil {
		return nil, err
	}
	facts, err := canonical.Object(map[string]json.RawMessage{
		"atlas_signature": canonical.String(canonical.EnrollmentSignature), "installation_id": canonical.String(record.InstallationID),
		"asset_id": canonical.String(system.CanonicalIdentifier(assetID)), "recovery_public_key": canonical.String(recoveryPublicKey),
	})
	if err != nil {
		return nil, err
	}
	authorization, err := canonical.Object(map[string]json.RawMessage{
		"installation_id": canonical.String(record.InstallationID), "asset_id": canonical.String(system.CanonicalIdentifier(assetID)),
		"recovery_public_key": canonical.String(recoveryPublicKey), "signature": canonical.String(canonical.Encode(ed25519.Sign(key, facts))),
	})
	if err != nil {
		return nil, err
	}
	// The Atlas-Enrollment header carries the canonical authorization.
	return map[string]string{"asset_id": system.CanonicalIdentifier(assetID), "token": canonical.Encode(authorization)}, nil
}

// CAResult identifies the exported nonsecret installation CA.
type CAResult struct {
	Certificate string `json:"certificate"`
	Fingerprint string `json:"sha256_fingerprint"`
}

// CA reports the installation CA certificate for client trust stores.
func CA(installation Installation) (CAResult, error) {
	fingerprint, err := certificateFingerprint(installation.CACertificate())
	return CAResult{Certificate: installation.CACertificate(), Fingerprint: fingerprint}, err
}
