package hostmanagement

import (
	"crypto/ed25519"
	"crypto/rand"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"time"
)

// SetupInput carries only a verifier for the administrator credential. The
// caller prepares and keeps the actual key before requesting setup.
type SetupInput struct {
	AdminVerifier     string   `json:"admin_verifier"`
	ServerNames       []string `json:"server_names"`
	CACertificate     []byte   `json:"ca_certificate,omitempty"`
	ServerCertificate []byte   `json:"server_certificate,omitempty"`
	ServerKey         []byte   `json:"server_key,omitempty"`
	OpenEnrollment    bool     `json:"open_enrollment"`
}

type TrustMaterial struct {
	CACertificate     []byte
	CAKey             []byte
	ServerCertificate []byte
	ServerKey         []byte
	Fingerprint       string
}

// PrepareSetup writes the prepared key once to an owner-only caller directory.
// It never returns the secret and refuses to overwrite an existing key.
func PrepareSetup(dir string, names []string) (SetupInput, error) {
	if err := os.MkdirAll(dir, 0700); err != nil {
		return SetupInput{}, fmt.Errorf("prepare credential directory: %w", err)
	}
	secret := make([]byte, 32)
	if _, err := rand.Read(secret); err != nil {
		return SetupInput{}, fmt.Errorf("prepare credential: %w", err)
	}
	key := base64.RawURLEncoding.EncodeToString(secret)
	file, err := os.OpenFile(filepath.Join(dir, "admin.key"), os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return SetupInput{}, fmt.Errorf("retain prepared credential: %w", err)
	}
	_, writeErr := file.WriteString(key)
	if writeErr == nil {
		writeErr = file.Sync()
	}
	closeErr := file.Close()
	if err := errors.Join(writeErr, closeErr); err != nil {
		return SetupInput{}, fmt.Errorf("retain prepared credential: %w", err)
	}
	digest := sha256.Sum256([]byte(key))
	input := SetupInput{AdminVerifier: hex.EncodeToString(digest[:]), ServerNames: names}
	if err := writeJSON(filepath.Join(dir, "setup.json"), input); err != nil {
		return SetupInput{}, err
	}
	return input, nil
}

func ProvisionTrust(input SetupInput, now time.Time) (TrustMaterial, error) {
	if _, err := hex.DecodeString(input.AdminVerifier); err != nil || len(input.AdminVerifier) != sha256.Size*2 {
		return TrustMaterial{}, errors.New("invalid prepared administrator verifier")
	}
	if len(input.ServerNames) == 0 {
		return TrustMaterial{}, errors.New("at least one server address is required")
	}
	var trust TrustMaterial
	if len(input.ServerCertificate) != 0 || len(input.ServerKey) != 0 || len(input.CACertificate) != 0 {
		trust = TrustMaterial{CACertificate: input.CACertificate, ServerCertificate: input.ServerCertificate, ServerKey: input.ServerKey}
	} else {
		caPublic, caPrivate, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return trust, err
		}
		caSerial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if err != nil {
			return trust, err
		}
		ca := &x509.Certificate{SerialNumber: caSerial, Subject: pkix.Name{CommonName: "Atlas installation CA"}, NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(10, 0, 0), IsCA: true, BasicConstraintsValid: true, KeyUsage: x509.KeyUsageCertSign | x509.KeyUsageCRLSign}
		caDER, err := x509.CreateCertificate(rand.Reader, ca, ca, caPublic, caPrivate)
		if err != nil {
			return trust, err
		}
		trust.CACertificate = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: caDER})
		caKey, err := x509.MarshalPKCS8PrivateKey(caPrivate)
		if err != nil {
			return trust, err
		}
		trust.CAKey = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: caKey})
		serverPublic, serverPrivate, err := ed25519.GenerateKey(rand.Reader)
		if err != nil {
			return trust, err
		}
		serial, err := rand.Int(rand.Reader, new(big.Int).Lsh(big.NewInt(1), 128))
		if err != nil {
			return trust, err
		}
		server := &x509.Certificate{SerialNumber: serial, Subject: pkix.Name{CommonName: "Atlas Core"}, NotBefore: now.Add(-time.Minute), NotAfter: now.AddDate(1, 0, 0), KeyUsage: x509.KeyUsageDigitalSignature, ExtKeyUsage: []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth}}
		for _, name := range input.ServerNames {
			if ip := net.ParseIP(name); ip != nil {
				server.IPAddresses = append(server.IPAddresses, ip)
			} else {
				server.DNSNames = append(server.DNSNames, name)
			}
		}
		serverDER, err := x509.CreateCertificate(rand.Reader, server, ca, serverPublic, caPrivate)
		if err != nil {
			return trust, err
		}
		trust.ServerCertificate = pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: serverDER})
		serverKey, err := x509.MarshalPKCS8PrivateKey(serverPrivate)
		if err != nil {
			return trust, err
		}
		trust.ServerKey = pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: serverKey})
	}
	pair, err := tls.X509KeyPair(trust.ServerCertificate, trust.ServerKey)
	if err != nil {
		return TrustMaterial{}, errors.New("server certificate/key are invalid")
	}
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(trust.CACertificate) {
		return TrustMaterial{}, errors.New("CA certificate is invalid")
	}
	leaf, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		return TrustMaterial{}, errors.New("server certificate is invalid")
	}
	intermediates := x509.NewCertPool()
	for _, encoded := range pair.Certificate[1:] {
		certificate, err := x509.ParseCertificate(encoded)
		if err != nil {
			return TrustMaterial{}, errors.New("server certificate chain is invalid")
		}
		intermediates.AddCert(certificate)
	}
	for _, name := range input.ServerNames {
		if name == "" {
			return TrustMaterial{}, errors.New("configured server addresses must be nonempty")
		}
		if _, err := leaf.Verify(x509.VerifyOptions{Roots: roots, Intermediates: intermediates, DNSName: name, CurrentTime: now}); err != nil {
			return TrustMaterial{}, errors.New("server certificate does not validate for every configured address")
		}
	}
	block, _ := pem.Decode(trust.CACertificate)
	if block == nil || block.Type != "CERTIFICATE" {
		return TrustMaterial{}, errors.New("CA certificate is invalid")
	}
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return TrustMaterial{}, errors.New("CA certificate is invalid")
	}
	digest := sha256.Sum256(ca.Raw)
	trust.Fingerprint = hex.EncodeToString(digest[:])
	return trust, nil
}

// writeJSON makes the containing directory durable before callers perform the
// effect authorized by the record. Temporary files always stay beside it.
func writeJSON(path string, value any) error {
	data, err := json.Marshal(value)
	if err != nil {
		return fmt.Errorf("encode local record: %w", err)
	}
	return writeDurable(path, data, 0600)
}

func writeDurable(path string, data []byte, mode os.FileMode) error {
	dir := filepath.Dir(path)
	file, err := os.CreateTemp(dir, ".atlas-record-*")
	if err != nil {
		return fmt.Errorf("prepare local record: %w", err)
	}
	temp := file.Name()
	defer os.Remove(temp)
	if err := file.Chmod(mode); err != nil {
		file.Close()
		return err
	}
	_, err = file.Write(data)
	if err == nil {
		err = file.Sync()
	}
	err = errors.Join(err, file.Close())
	if err != nil {
		return fmt.Errorf("sync local record: %w", err)
	}
	if err := os.Rename(temp, path); err != nil {
		return fmt.Errorf("replace local record: %w", err)
	}
	directory, err := os.Open(dir)
	if err != nil {
		return err
	}
	return errors.Join(directory.Sync(), directory.Close())
}
