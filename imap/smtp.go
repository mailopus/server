package main

import (
	"errors"
	"io"
	"net"
	"strings"

	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

const maxRecipients = 50 // Mailopus's own limit per submission

func (srv *Server) NewSession(c *smtp.Conn) (smtp.Session, error) {
	ip, _, _ := net.SplitHostPort(c.Conn().RemoteAddr().String())
	srv.log.Info("smtp: connect", "ip", ip)
	return &smtpSession{srv: srv, ip: ip, conn: c}, nil
}

// smtpSession is one submission connection: AUTH, then mail that goes out through Mailopus
// (Email/import into Drafts, EmailSubmission/set, filed in Sent on success).
type smtpSession struct {
	srv  *Server
	ip   string
	conn *smtp.Conn
	user string
	acct *Account
	from string
	to   []string
}

var (
	errSMTPAuth   = &smtp.SMTPError{Code: 535, EnhancedCode: smtp.EnhancedCode{5, 7, 8}, Message: "Authentication failed"}
	errSMTPNoAuth = &smtp.SMTPError{Code: 530, EnhancedCode: smtp.EnhancedCode{5, 7, 0}, Message: "Authentication required"}
	errSMTPTemp   = &smtp.SMTPError{Code: 451, EnhancedCode: smtp.EnhancedCode{4, 3, 0}, Message: "Mailopus is unavailable, try again"}
)

func (s *smtpSession) AuthMechanisms() []string { return []string{sasl.Plain, sasl.Login} }

func (s *smtpSession) Auth(mech string) (sasl.Server, error) {
	check := func(username, password string) error {
		a, err := s.srv.login(s.ip, username, password, "smtp")
		if err != nil {
			// The EHLO name and mechanism tell apart two mail apps behind one address, when one has a stale password.
			s.srv.log.Warn("smtp: auth refused", "ip", s.ip, "user", strings.ToLower(username), "ehlo", s.conn.Hostname(), "mech", mech, "err", err.Error())
			if errors.Is(err, errAuth) || errors.Is(err, errLimited) || errors.Is(err, errLocked) {
				return errSMTPAuth
			}
			return errSMTPTemp
		}
		s.user, s.acct = strings.ToLower(username), a
		return nil
	}
	switch mech {
	case sasl.Plain:
		return sasl.NewPlainServer(func(identity, username, password string) error {
			if identity != "" && identity != username {
				return errSMTPAuth
			}
			return check(username, password)
		}), nil
	case sasl.Login:
		return &loginServer{check: check}, nil
	}
	return nil, smtp.ErrAuthUnknownMechanism
}

func (s *smtpSession) Mail(from string, _ *smtp.MailOptions) error {
	if s.acct == nil {
		return errSMTPNoAuth
	}
	s.from = strings.ToLower(from)
	return nil
}

func (s *smtpSession) Rcpt(to string, _ *smtp.RcptOptions) error {
	if s.acct == nil {
		return errSMTPNoAuth
	}
	if len(s.to) >= maxRecipients {
		return &smtp.SMTPError{Code: 452, EnhancedCode: smtp.EnhancedCode{4, 5, 3}, Message: "Too many recipients"}
	}
	s.to = append(s.to, to)
	return nil
}

func (s *smtpSession) Data(r io.Reader) error {
	if s.acct == nil {
		return errSMTPNoAuth
	}
	raw, err := io.ReadAll(io.LimitReader(r, maxMessage+1))
	if err != nil {
		return err
	}
	if len(raw) > maxMessage {
		return &smtp.SMTPError{Code: 552, EnhancedCode: smtp.EnhancedCode{5, 3, 4}, Message: "Message over 25 MB"}
	}
	c, cancel := ctx()
	defer cancel()
	a := s.acct

	var ids struct {
		List []struct {
			ID    string `json:"id"`
			Email string `json:"email"`
		} `json:"list"`
	}
	if err := a.c.Call1(c, "Identity/get", nil, &ids); err != nil {
		return s.temp(err)
	}
	identity := ""
	for _, id := range ids.List {
		if strings.EqualFold(id.Email, s.from) {
			identity = id.ID
		}
	}
	if identity == "" {
		s.srv.log.Warn("smtp: sender isn't an identity", "user", s.user)
		return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "You can't send as that address"}
	}

	a.mu.Lock()
	var drafts, sent string
	for _, b := range a.boxes {
		switch b.Role {
		case "drafts":
			drafts = b.ID
		case "sent":
			sent = b.ID
		}
	}
	a.mu.Unlock()
	if drafts == "" || sent == "" {
		return errSMTPTemp
	}

	blob, err := a.c.Upload(c, raw)
	if err != nil {
		return s.temp(err)
	}
	rcpts := make([]map[string]string, len(s.to))
	for i, t := range s.to {
		rcpts[i] = map[string]string{"email": t}
	}
	res, err := a.c.Calls(c,
		Call{Name: "Email/import", Args: map[string]any{"emails": map[string]any{"m": map[string]any{
			"blobId": blob, "mailboxIds": map[string]bool{drafts: true}, "keywords": map[string]bool{"$seen": true},
		}}}},
		Call{Name: "EmailSubmission/set", Args: map[string]any{
			"create": map[string]any{"s": map[string]any{
				"identityId": identity, "emailId": "#m",
				"envelope": map[string]any{"mailFrom": map[string]string{"email": s.from}, "rcptTo": rcpts},
			}},
			"onSuccessUpdateEmail": map[string]any{"#s": map[string]any{"mailboxIds/" + drafts: nil, "mailboxIds/" + sent: true}},
		}},
	)
	if err != nil {
		return s.temp(err)
	}
	var sub struct {
		NotCreated map[string]MethodError `json:"notCreated"`
	}
	if len(res) < 2 {
		return errSMTPTemp
	}
	jsonUnmarshal(res[1], &sub)
	if e, bad := sub.NotCreated["s"]; bad {
		s.srv.log.Warn("smtp: submission refused", "user", s.user, "type", e.Type)
		if e.Type == "forbiddenFrom" {
			return &smtp.SMTPError{Code: 550, EnhancedCode: smtp.EnhancedCode{5, 7, 1}, Message: "From must be the address you're sending as"}
		}
		return &smtp.SMTPError{Code: 554, EnhancedCode: smtp.EnhancedCode{5, 0, 0}, Message: "Mailopus refused the message: " + e.Type}
	}
	s.srv.log.Info("smtp: sent", "user", s.user, "recipients", len(s.to), "bytes", len(raw))
	return nil
}

func (s *smtpSession) temp(err error) error {
	if errors.Is(err, errAuth) {
		return errSMTPAuth
	}
	s.srv.log.Warn("smtp: backend error", "user", s.user, "err", err)
	return errSMTPTemp
}

func (s *smtpSession) Reset() { s.from, s.to = "", nil }

func (s *smtpSession) Logout() error {
	if s.acct != nil {
		accounts.release(s.acct)
	}
	s.srv.log.Info("smtp: disconnect", "ip", s.ip, "user", s.user)
	return nil
}

// loginServer is SASL LOGIN (draft-murchison-sasl-login), which Outlook still prefers.
type loginServer struct {
	check func(user, pass string) error
	user  string
	step  int
}

func (l *loginServer) Next(resp []byte) ([]byte, bool, error) {
	switch l.step {
	case 0:
		l.step++
		if len(resp) > 0 {
			l.user = string(resp)
			l.step++
			return []byte("Password:"), false, nil
		}
		return []byte("Username:"), false, nil
	case 1:
		l.user = string(resp)
		l.step++
		return []byte("Password:"), false, nil
	default:
		return nil, true, l.check(l.user, string(resp))
	}
}
