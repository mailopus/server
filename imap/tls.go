package main

import (
	"context"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/pem"
	"errors"
	"fmt"
	"log/slog"
	"math/big"
	"net"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/caddyserver/certmagic"
	"github.com/libdns/cloudflare"
)

func sprintf(format string, v ...any) string { return fmt.Sprintf(format, v...) }
func sprint(v ...any) string                 { return fmt.Sprint(v...) }

// loadTLS picks the certificate source from TLS_MODE:
//   - acme: Let's Encrypt by DNS-01 through Cloudflare (CF_API_TOKEN, DNS edit on the zone), so
//     no port 80 and it works on a host the internet can't reach. ACME_CHALLENGE_DOMAIN writes the
//     challenge somewhere else: CNAME _acme-challenge.<host> to it, and the token needs only that zone.
//   - files: TLS_CERT and TLS_KEY.
//   - self-signed: for docker compose up on a laptop.
func loadTLS(log *slog.Logger) (*tls.Config, error) {
	hosts := strings.Split(env("TLS_HOSTNAMES", "localhost"), ",")
	switch mode := env("TLS_MODE", "self-signed"); mode {
	case "acme":
		token := os.Getenv("CF_API_TOKEN")
		if token == "" {
			return nil, errors.New("TLS_MODE=acme needs CF_API_TOKEN")
		}
		certmagic.Default.Storage = &certmagic.FileStorage{Path: env("CERT_DIR", "/data/certs")}
		certmagic.DefaultACME.Agreed = true
		certmagic.DefaultACME.Email = os.Getenv("ACME_EMAIL")
		// Let's Encrypt staging (https://acme-staging-v02.api.letsencrypt.org/directory) for trying a setup
		// without spending the real rate limits.
		certmagic.DefaultACME.CA = env("ACME_CA", certmagic.LetsEncryptProductionCA)
		certmagic.DefaultACME.DisableHTTPChallenge = true
		certmagic.DefaultACME.DisableTLSALPNChallenge = true
		certmagic.DefaultACME.DNS01Solver = &certmagic.DNS01Solver{DNSManager: certmagic.DNSManager{
			DNSProvider:    &cloudflare.Provider{APIToken: token},
			OverrideDomain: os.Getenv("ACME_CHALLENGE_DOMAIN"),
		}}
		cfg := certmagic.NewDefault()
		if err := cfg.ManageSync(context.Background(), hosts); err != nil {
			return nil, err
		}
		t := cfg.TLSConfig()
		t.NextProtos = nil
		t.MinVersion = tls.VersionTLS12
		log.Info("tls: acme", "hosts", hosts)
		return t, nil
	case "files":
		cert, err := tls.LoadX509KeyPair(os.Getenv("TLS_CERT"), os.Getenv("TLS_KEY"))
		if err != nil {
			return nil, err
		}
		return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
	case "self-signed":
		cert, err := selfSigned(hosts, env("CERT_DIR", "/data/certs"))
		if err != nil {
			return nil, err
		}
		log.Warn("tls: self-signed certificate, for local testing only", "hosts", hosts)
		return &tls.Config{Certificates: []tls.Certificate{cert}, MinVersion: tls.VersionTLS12}, nil
	default:
		return nil, fmt.Errorf("unknown TLS_MODE %q", mode)
	}
}

// selfSigned makes a certificate for local testing, valid for the hostnames, localhost and the
// loopback addresses. It's kept in dir, so trusting it once in Keychain survives restarts.
func selfSigned(hosts []string, dir string) (tls.Certificate, error) {
	certFile, keyFile := filepath.Join(dir, "selfsigned.crt"), filepath.Join(dir, "selfsigned.key")
	if cert, err := tls.LoadX509KeyPair(certFile, keyFile); err == nil {
		return cert, nil
	}
	key, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		return tls.Certificate{}, err
	}
	tmpl := &x509.Certificate{
		SerialNumber: big.NewInt(time.Now().UnixNano()),
		Subject:      pkix.Name{CommonName: "Mailopus IMAP proxy (local test)"},
		DNSNames:     append(hosts, "localhost"),
		IPAddresses:  []net.IP{net.IPv4(127, 0, 0, 1), net.IPv6loopback},
		NotBefore:    time.Now().Add(-time.Hour),
		NotAfter:     time.Now().AddDate(1, 0, 0),
		KeyUsage:     x509.KeyUsageDigitalSignature,
		ExtKeyUsage:  []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
	}
	der, err := x509.CreateCertificate(rand.Reader, tmpl, tmpl, &key.PublicKey, key)
	if err != nil {
		return tls.Certificate{}, err
	}
	keyDER, err := x509.MarshalECPrivateKey(key)
	if err != nil {
		return tls.Certificate{}, err
	}
	if err := os.MkdirAll(dir, 0o700); err == nil {
		os.WriteFile(certFile, pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: der}), 0o644)
		os.WriteFile(keyFile, pem.EncodeToMemory(&pem.Block{Type: "EC PRIVATE KEY", Bytes: keyDER}), 0o600)
	}
	return tls.Certificate{Certificate: [][]byte{der}, PrivateKey: key}, nil
}
