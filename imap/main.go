// Command imap is the IMAP and SMTP submission proxy for Mailopus: ordinary mail clients on one
// side, Mailopus's JMAP API over HTTPS on the other. See README.md.
package main

import (
	"crypto/tls"
	"encoding/json"
	"log/slog"
	"net"
	"net/url"
	"os"
	"time"

	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-smtp"
)

func env(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func jsonUnmarshal(b []byte, v any) { _ = json.Unmarshal(b, v) }

// slogPrintf adapts slog for the IMAP library's error log. It only logs command errors, never
// arguments or literals, and its DebugWriter (raw wire, credentials included) stays unset.
type slogPrintf struct{ l *slog.Logger }

func (p slogPrintf) Printf(format string, v ...any) {
	p.l.Warn("imap: library", "msg", sprintf(format, v...))
}
func (p slogPrintf) Println(v ...any) { p.l.Warn("imap: library", "msg", sprint(v...)) }

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil))
	slog.SetDefault(log)

	tlsConfig, err := loadTLS(log)
	if err != nil {
		log.Error("tls", "err", err)
		os.Exit(1)
	}
	base := env("MAILOPUS_URL", "https://app.mailopus.net")
	// Every request carries the app password as Basic auth, so plain http is only for a server on this machine.
	if u, err := url.Parse(base); err != nil || (u.Scheme != "https" && !(u.Scheme == "http" && (u.Hostname() == "localhost" || u.Hostname() == "host.docker.internal" || net.ParseIP(u.Hostname()).IsLoopback()))) {
		log.Error("MAILOPUS_URL must be https (http only for localhost)", "url", base)
		os.Exit(1)
	}
	srv := &Server{base: base, limiter: NewLimiter(), log: log}

	imapSrv := imapserver.New(&imapserver.Options{
		NewSession: srv.newSession,
		Caps:       imapCaps,
		Logger:     slogPrintf{log},
		// STARTTLS on the plain port (143). LOGIN stays disabled until TLS is up (InsecureAuth is off).
		TLSConfig: tlsConfig,
	})
	smtpSrv := func(implicit bool) *smtp.Server {
		s := smtp.NewServer(srv)
		s.Domain = env("SMTP_HOSTNAME", "localhost")
		s.MaxMessageBytes = maxMessage
		s.MaxRecipients = maxRecipients
		s.ReadTimeout, s.WriteTimeout = 10*time.Minute, time.Minute
		s.ErrorLog = slogPrintf{log}
		if !implicit {
			s.TLSConfig = tlsConfig // STARTTLS, required before AUTH (AllowInsecureAuth stays false)
		}
		return s
	}

	listen := func(addr string, wrapTLS bool) net.Listener {
		ln, err := net.Listen("tcp", addr)
		if err != nil {
			log.Error("listen", "addr", addr, "err", err)
			os.Exit(1)
		}
		ln = srv.limiter.Listener(ln)
		if wrapTLS {
			ln = tls.NewListener(ln, tlsConfig)
		}
		log.Info("listening", "addr", addr, "tls", wrapTLS)
		return ln
	}

	errc := make(chan error, 4)
	go func() { errc <- imapSrv.Serve(listen(env("IMAP_ADDR", ":993"), true)) }()
	go func() { errc <- imapSrv.Serve(listen(env("IMAP_STARTTLS_ADDR", ":143"), false)) }()
	go func() { errc <- smtpSrv(true).Serve(listen(env("SMTPS_ADDR", ":465"), true)) }()
	go func() { errc <- smtpSrv(false).Serve(listen(env("SUBMISSION_ADDR", ":587"), false)) }()
	log.Error("server stopped", "err", <-errc)
	os.Exit(1)
}
