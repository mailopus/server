package main

import (
	"bufio"
	"bytes"
	"crypto/tls"
	"fmt"
	"log/slog"
	"net"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapclient"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-sasl"
	"github.com/emersion/go-smtp"
)

type lockedBuf struct {
	mu sync.Mutex
	b  bytes.Buffer
}

func (l *lockedBuf) Write(p []byte) (int, error) {
	l.mu.Lock()
	defer l.mu.Unlock()
	return l.b.Write(p)
}
func (l *lockedBuf) String() string { l.mu.Lock(); defer l.mu.Unlock(); return l.b.String() }

type harness struct {
	fake *fakeMailopus
	imap string
	smtp string
	logs *lockedBuf
}

func start(t *testing.T) *harness {
	failDelay = 0
	fake, api := newFake(t)
	logs := &lockedBuf{}
	srv := &Server{base: api.URL, limiter: NewLimiter(), log: slog.New(slog.NewJSONHandler(logs, nil))}
	is := imapserver.New(&imapserver.Options{NewSession: srv.newSession, Caps: imapCaps, InsecureAuth: true, Logger: slogPrintf{srv.log}})
	iln, _ := net.Listen("tcp", "127.0.0.1:0")
	go is.Serve(srv.limiter.Listener(iln))
	ss := smtp.NewServer(srv)
	ss.AllowInsecureAuth = true
	ss.Domain = "localhost"
	sln, _ := net.Listen("tcp", "127.0.0.1:0")
	go ss.Serve(sln)
	t.Cleanup(func() { is.Close(); ss.Close() })
	return &harness{fake: fake, imap: iln.Addr().String(), smtp: sln.Addr().String(), logs: logs}
}

func (h *harness) client(t *testing.T, opts *imapclient.Options) *imapclient.Client {
	c, err := imapclient.DialInsecure(h.imap, opts)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { c.Close() })
	return c
}

func must[T any](v T, err error) func(*testing.T) T {
	return func(t *testing.T) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func TestLoginFailureAndLockout(t *testing.T) {
	h := start(t)
	for i := 0; i < maxFails; i++ {
		c := h.client(t, nil)
		if err := c.Login(h.fake.user, "WRONG-PASSWORD").Wait(); err == nil {
			t.Fatal("wrong password accepted")
		}
	}
	// Locked out now, even with the right password.
	c := h.client(t, nil)
	if err := c.Login(h.fake.user, h.fake.pass).Wait(); err == nil {
		t.Fatal("locked-out IP signed in")
	}
}

func TestReadFlagMoveDeleteAndIdle(t *testing.T) {
	h := start(t)
	h.fake.deliver("first", "secret body one")
	h.fake.deliver("second", "secret body two")

	updates := make(chan uint32, 10)
	c := h.client(t, &imapclient.Options{UnilateralDataHandler: &imapclient.UnilateralDataHandler{
		Mailbox: func(d *imapclient.UnilateralDataMailbox) {
			if d.NumMessages != nil {
				updates <- *d.NumMessages
			}
		},
	}})
	// Without the dashes, as a paste might drop them.
	if err := c.Login(h.fake.user, strings.ReplaceAll(h.fake.pass, "-", "")).Wait(); err != nil {
		t.Fatal(err)
	}
	// Mailopus sees the proxy's address on every request, so the proxy names the mail app's.
	h.fake.mu.Lock()
	seen := h.fake.ip
	h.fake.mu.Unlock()
	if seen != "127.0.0.1" && seen != "::1" {
		t.Fatalf("client address sent to Mailopus: %q", seen)
	}

	boxes := must(c.List("", "*", nil).Collect())(t)
	names := map[string]bool{}
	for _, b := range boxes {
		names[b.Mailbox] = true
	}
	for _, n := range []string{"INBOX", "Sent", "Drafts", "Trash", "Archive"} {
		if !names[n] {
			t.Errorf("LIST missing %s: %v", n, names)
		}
	}

	sel := must(c.Select("INBOX", nil).Wait())(t)
	if sel.NumMessages != 2 || sel.UIDValidity != 1700000000 || sel.UIDNext != 3 {
		t.Fatalf("SELECT: %+v", sel)
	}

	// Headers only (what a client does to list a folder), then the full message.
	msgs := must(c.Fetch(imap.SeqSetNum(1, 2), &imap.FetchOptions{UID: true, Flags: true, Envelope: true, RFC822Size: true}).Collect())(t)
	if len(msgs) != 2 || msgs[0].Envelope.Subject != "first" || msgs[1].UID != 2 {
		t.Fatalf("FETCH envelope: %+v", msgs)
	}
	body := &imap.FetchItemBodySection{}
	full := must(c.Fetch(imap.UIDSetNum(1), &imap.FetchOptions{BodySection: []*imap.FetchItemBodySection{body}}).Collect())(t)
	if !strings.Contains(string(full[0].FindBodySection(body)), "secret body one") {
		t.Fatal("BODY[] missing the body")
	}
	// A non-peek BODY[] marks it read.
	if !h.fake.emails["e1"].keywords["$seen"] {
		t.Fatal("BODY[] didn't set $seen")
	}

	// Flag.
	if err := c.Store(imap.UIDSetNum(2), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagFlagged}, Silent: true}, nil).Close(); err != nil {
		t.Fatal(err)
	}
	if !h.fake.emails["e2"].keywords["$flagged"] {
		t.Fatal("STORE +FLAGS \\Flagged didn't reach Mailopus")
	}

	// Move uid 1 to Archive: COPYUID back, gone from INBOX.
	mv := must(c.Move(imap.UIDSetNum(1), "Archive").Wait())(t)
	if mv.UIDValidity != 1700000000 || mv.DestUIDs == nil {
		t.Fatalf("MOVE copy data: %+v", mv)
	}
	if _, in := h.fake.emails["e1"].uids["box-inbox"]; in {
		t.Fatal("MOVE left it in Inbox")
	}

	// Delete: \Deleted then EXPUNGE. In no other mailbox, so Mailopus destroys it.
	if err := c.Store(imap.UIDSetNum(2), &imap.StoreFlags{Op: imap.StoreFlagsAdd, Flags: []imap.Flag{imap.FlagDeleted}, Silent: true}, nil).Close(); err != nil {
		t.Fatal(err)
	}
	if err := c.Expunge().Close(); err != nil {
		t.Fatal(err)
	}
	if !h.fake.emails["e2"].destroyed {
		t.Fatal("EXPUNGE didn't destroy the email")
	}

	// IDLE: new mail arrives, the push socket fires, the client hears EXISTS.
	idle, err := c.Idle()
	if err != nil {
		t.Fatal(err)
	}
	for len(updates) > 0 {
		<-updates
	}
	time.Sleep(200 * time.Millisecond) // let the push socket connect
	h.fake.deliver("third", "secret body three")
	select {
	case n := <-updates:
		if n != 1 {
			t.Fatalf("EXISTS %d, want 1", n)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("no EXISTS during IDLE")
	}
	idle.Close()
	idle.Wait()

	// Logs: no password, no message content.
	logs := h.logs.String()
	for _, secret := range []string{h.fake.pass, strings.ReplaceAll(h.fake.pass, "-", ""), strings.ToLower(strings.ReplaceAll(h.fake.pass, "-", "")), "secret body", "first", "second", "third"} {
		if strings.Contains(logs, secret) {
			t.Errorf("logs contain %q", secret)
		}
	}
	if !strings.Contains(logs, `"imap: login"`) {
		t.Error("expected a login line in the logs")
	}
}

func (f *fakeMailopus) only(t *testing.T) *fakeEmail {
	t.Helper()
	if len(f.emails) != 1 {
		t.Fatalf("%d emails, want 1", len(f.emails))
	}
	for _, e := range f.emails {
		return e
	}
	return nil
}

func TestAppendReturnsUID(t *testing.T) {
	h := start(t)
	c := h.client(t, nil)
	if err := c.Login(h.fake.user, h.fake.pass).Wait(); err != nil {
		t.Fatal(err)
	}
	msg := "From: me@mailopus.net\r\nSubject: draft\r\n\r\nhi\r\n"
	cmd := c.Append("Drafts", int64(len(msg)), &imap.AppendOptions{Flags: []imap.Flag{imap.FlagDraft}})
	cmd.Write([]byte(msg))
	cmd.Close()
	data, err := cmd.Wait()
	if err != nil {
		t.Fatal(err)
	}
	if data.UID != 1 || data.UIDValidity != 1700000000 {
		t.Fatalf("APPENDUID %+v", data)
	}
	if !h.fake.only(t).keywords["$draft"] {
		t.Fatal("APPEND flags not stored")
	}
}

func TestSMTPSubmission(t *testing.T) {
	h := start(t)
	c, err := smtp.Dial(h.smtp)
	if err != nil {
		t.Fatal(err)
	}
	defer c.Close()
	if err := c.Auth(sasl.NewPlainClient("", h.fake.user, "nope")); err == nil {
		t.Fatal("bad password accepted")
	}
	if err := c.Auth(sasl.NewPlainClient("", h.fake.user, h.fake.pass)); err != nil {
		t.Fatal(err)
	}
	msg := "From: me@mailopus.net\r\nTo: ann@example.com\r\nSubject: hi\r\n\r\nhello\r\n"
	if err := c.SendMail(h.fake.user, []string{"ann@example.com", "bcc@example.com"}, strings.NewReader(msg)); err != nil {
		t.Fatal(err)
	}
	if strings.Join(h.fake.sent, ",") != "ann@example.com,bcc@example.com" {
		t.Fatalf("envelope recipients %v", h.fake.sent)
	}
	e := h.fake.only(t)
	if _, in := e.uids["box-sent"]; !in {
		t.Fatal("sent message not filed in Sent")
	}
	if _, in := e.uids["box-drafts"]; in {
		t.Fatal("sent message left in Drafts")
	}
	if err := c.SendMail("someone@else.com", []string{"x@example.com"}, strings.NewReader(msg)); err == nil {
		t.Fatal("sent as an address that isn't an identity")
	}
}

var _ = tls.VersionTLS12

// Apple Mail sends UID FETCH 0:N; the patched go-imap in third_party reads 0 as 1.
func TestUIDFetchZero(t *testing.T) {
	h := start(t)
	h.fake.deliver("first", "body")
	conn, err := net.Dial("tcp", h.imap)
	if err != nil {
		t.Fatal(err)
	}
	defer conn.Close()
	r := bufio.NewReader(conn)
	r.ReadString('\n') // greeting
	fmt.Fprintf(conn, "a LOGIN %s %s\r\nb SELECT INBOX\r\nc UID FETCH 0:5 (UID FLAGS)\r\nd UID FETCH 0 (UID)\r\n", h.fake.user, h.fake.pass)
	var got []string
	for len(got) < 4 {
		line, err := r.ReadString('\n')
		if err != nil {
			t.Fatal(err)
		}
		if line[0] != '*' {
			got = append(got, strings.TrimSpace(line))
		}
	}
	for _, l := range got {
		if !strings.Contains(l, " OK ") {
			t.Fatalf("expected OK, got %q", l)
		}
	}
}

// A folder renamed in the web app shows under its new name on the next LIST.
func TestListSeesRename(t *testing.T) {
	boxesTTL = 0
	t.Cleanup(func() { boxesTTL = 30 * time.Second })
	h := start(t)
	h.fake.mu.Lock()
	h.fake.boxes = append(h.fake.boxes, &fakeBox{id: "box-label", name: "Receipts", uidnext: 1})
	h.fake.mu.Unlock()
	c := h.client(t, nil)
	if err := c.Login(h.fake.user, h.fake.pass).Wait(); err != nil {
		t.Fatal(err)
	}
	names := func() map[string]bool {
		out := map[string]bool{}
		for _, b := range must(c.List("", "*", nil).Collect())(t) {
			out[b.Mailbox] = true
		}
		return out
	}
	if !names()["Receipts"] {
		t.Fatal("Receipts missing")
	}
	h.fake.mu.Lock()
	h.fake.boxes[len(h.fake.boxes)-1].name = "Bills"
	h.fake.mu.Unlock()
	if n := names(); !n["Bills"] || n["Receipts"] {
		t.Fatalf("rename not seen: %v", n)
	}
}

// Back-to-back LISTs reuse one Mailbox/get.
func TestListReusesFolderList(t *testing.T) {
	h := start(t)
	c := h.client(t, nil)
	if err := c.Login(h.fake.user, h.fake.pass).Wait(); err != nil {
		t.Fatal(err)
	}
	before := h.fake.calls("Mailbox/get")
	for range 3 {
		must(c.List("", "*", nil).Collect())(t)
	}
	if n := h.fake.calls("Mailbox/get") - before; n != 0 {
		t.Fatalf("%d Mailbox/get calls for 3 LISTs right after login", n)
	}
}
