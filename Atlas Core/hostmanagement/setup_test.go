package hostmanagement_test

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/atlas-field-systems/atlas-core/hostmanagement"
)

func TestPreparedSetupRetainsCredentialAndCreatesVerifiableTrust(t *testing.T) {
	dir := t.TempDir()
	prepared, err := hostmanagement.PrepareSetup(dir, []string{"127.0.0.1", "atlas.local"})
	if err != nil {
		t.Fatal(err)
	}
	key, err := os.ReadFile(filepath.Join(dir, "admin.key"))
	if err != nil {
		t.Fatal(err)
	}
	if len(key) < 32 || prepared.AdminVerifier == string(key) {
		t.Fatal("prepared secret must be retained separately from verifier")
	}
	trust, err := hostmanagement.ProvisionTrust(prepared, time.Now())
	if err != nil {
		t.Fatal(err)
	}
	block, _ := pem.Decode(trust.CACertificate)
	ca, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(ca)
	pair, err := tls.X509KeyPair(trust.ServerCertificate, trust.ServerKey)
	if err != nil {
		t.Fatal(err)
	}
	server, err := x509.ParseCertificate(pair.Certificate[0])
	if err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"127.0.0.1", "atlas.local"} {
		if _, err := server.Verify(x509.VerifyOptions{Roots: roots, DNSName: name}); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := server.Verify(x509.VerifyOptions{Roots: roots, DNSName: "wrong.local"}); err == nil {
		t.Fatal("wrong hostname accepted")
	}
	if _, err := server.Verify(x509.VerifyOptions{Roots: x509.NewCertPool(), DNSName: "atlas.local"}); err == nil {
		t.Fatal("wrong CA accepted")
	}
	if _, err := server.Verify(x509.VerifyOptions{Roots: roots, DNSName: "atlas.local", CurrentTime: server.NotAfter.Add(time.Second)}); err == nil {
		t.Fatal("expired certificate accepted")
	}
	info, err := os.Stat(filepath.Join(dir, "admin.key"))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0600 {
		t.Fatal("credential is not owner-only")
	}
}
