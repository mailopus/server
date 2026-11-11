package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"maps"
	"net"
	"strings"
	"sync"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
	"github.com/emersion/go-message/textproto"
)

const maxMessage = 25 << 20 // Mailopus's upload and Email Routing limit

var imapCaps = imap.CapSet{
	imap.CapIMAP4rev1: {}, imap.CapIMAP4rev2: {},
	imap.CapIdle: {}, imap.CapUIDPlus: {}, imap.CapMove: {}, imap.CapNamespace: {}, imap.CapUnselect: {},
	imap.CapEnable: {}, imap.CapESearch: {}, imap.CapSearchRes: {}, imap.CapListExtended: {}, imap.CapListStatus: {},
	imap.CapChildren: {}, imap.CapSpecialUse: {}, imap.CapLiteralPlus: {}, imap.CapSASLIR: {}, imap.CapAppendLimit: {},
}

var (
	errNoMailbox = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeNonExistent, Text: "No such mailbox"}
	errCannot    = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeCannot, Text: "Mailopus doesn't support this yet"}
	errRevoked   = &imap.Error{Type: imap.StatusResponseTypeBye, Text: "App password revoked"}
	errBackend   = &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeUnavailable, Text: "Mailopus is unavailable, try again"}
)

// Server holds what every connection shares.
type Server struct {
	base    string
	limiter *Limiter
	log     *slog.Logger
}

// Session is one IMAP connection. It implements imapserver.SessionIMAP4rev2.
type Session struct {
	srv  *Server
	conn *imapserver.Conn
	ip   string
	user string
	acct *Account

	box       *Mailbox
	st        *imapserver.SessionTracker
	readOnly  bool
	searchRes imap.UIDSet
}

var _ imapserver.SessionIMAP4rev2 = (*Session)(nil)
var _ imapserver.SessionAppendLimit = (*Session)(nil)

func (srv *Server) newSession(conn *imapserver.Conn) (imapserver.Session, *imapserver.GreetingData, error) {
	ip, _, _ := net.SplitHostPort(conn.NetConn().RemoteAddr().String())
	srv.log.Info("imap: connect", "ip", ip)
	return &Session{srv: srv, conn: conn, ip: ip}, nil, nil
}

func ctx() (context.Context, context.CancelFunc) {
	return context.WithTimeout(context.Background(), 2*time.Minute)
}

// backend turns a JMAP failure into an IMAP status, logging the cause (never content).
func (s *Session) backend(op string, err error) error {
	if err == nil {
		return nil
	}
	var ie *imap.Error
	if errors.As(err, &ie) {
		return err
	}
	if errors.Is(err, errAuth) {
		return errRevoked
	}
	s.srv.log.Warn("imap: backend error", "op", op, "user", s.user, "err", err)
	return errBackend
}

func (s *Session) Close() error {
	if s.st != nil {
		s.st.Close()
	}
	if s.acct != nil {
		s.acct.mu.Lock()
		delete(s.acct.conns, s.conn)
		s.acct.mu.Unlock()
		accounts.release(s.acct)
	}
	s.srv.log.Info("imap: disconnect", "ip", s.ip, "user", s.user)
	return nil
}

func (s *Session) Login(username, password string) error {
	a, err := s.srv.login(s.ip, username, password, "imap")
	if err != nil {
		if errors.Is(err, errAuth) || errors.Is(err, errLimited) || errors.Is(err, errLocked) {
			return imapserver.ErrAuthFailed
		}
		return s.backend("login", err)
	}
	a.mu.Lock()
	a.conns[s.conn] = struct{}{}
	a.mu.Unlock()
	s.user = strings.ToLower(username)
	s.acct = a
	return nil
}

// login is shared by IMAP and SMTP: lockout, JMAP session check, shared account.
func (srv *Server) login(ip, username, password, proto string) (*Account, error) {
	if !srv.limiter.Allowed(ip) {
		srv.log.Warn(proto+": login refused, locked out", "ip", ip)
		return nil, errLocked
	}
	c, cancel := ctx()
	defer cancel()
	client, err := Login(c, srv.base, username, password, ip)
	if err != nil {
		if errors.Is(err, errAuth) || errors.Is(err, errLimited) {
			srv.limiter.Fail(ip)
			srv.log.Warn(proto+": login failed", "ip", ip, "user", strings.ToLower(username), "pw", fingerprint(password))
			time.Sleep(failDelay)
		}
		return nil, err
	}
	a, err := accounts.open(c, client)
	if err != nil {
		return nil, err
	}
	srv.limiter.Succeeded(ip)
	srv.log.Info(proto+": login", "ip", ip, "user", strings.ToLower(username), "pw", fingerprint(password))
	return a, nil
}

func (s *Session) AppendLimit() uint32 { return maxMessage }

// ---------- mailboxes ----------

func specialUse(role string) []imap.MailboxAttr {
	switch role {
	case "sent":
		return []imap.MailboxAttr{imap.MailboxAttrSent}
	case "drafts":
		return []imap.MailboxAttr{imap.MailboxAttrDrafts}
	case "trash":
		return []imap.MailboxAttr{imap.MailboxAttrTrash}
	case "junk":
		return []imap.MailboxAttr{imap.MailboxAttrJunk}
	case "archive":
		return []imap.MailboxAttr{imap.MailboxAttrArchive}
	}
	return nil
}

const delim = '/'

func (s *Session) List(w *imapserver.ListWriter, ref string, patterns []string, options *imap.ListOptions) error {
	if len(patterns) == 0 {
		return w.WriteList(&imap.ListData{Attrs: []imap.MailboxAttr{imap.MailboxAttrNoSelect}, Delim: delim})
	}
	// Folders can be renamed or deleted in the web app, and clients look for that with LIST.
	c, cancel := ctx()
	defer cancel()
	if err := s.acct.refreshBoxes(c); err != nil {
		return s.backend("list", err)
	}
	s.acct.mu.Lock()
	boxes := append([]*Mailbox(nil), s.acct.boxes...)
	s.acct.mu.Unlock()
	for _, e := range folderTree(boxes) {
		match := false
		for _, p := range patterns {
			if imapserver.MatchList(e.name, delim, ref, p) {
				match = true
			}
		}
		if !match {
			continue
		}
		var su []imap.MailboxAttr
		if e.box != nil {
			su = specialUse(e.box.Role)
		}
		if options.SelectSpecialUse && su == nil {
			continue
		}
		attrs := []imap.MailboxAttr{imap.MailboxAttrHasNoChildren}
		if e.children {
			attrs[0] = imap.MailboxAttrHasChildren
		}
		if e.box == nil {
			attrs = append(attrs, imap.MailboxAttrNoSelect)
		} else {
			attrs = append(attrs, imap.MailboxAttrSubscribed)
		}
		data := &imap.ListData{Mailbox: e.name, Delim: delim, Attrs: append(attrs, su...)}
		if options.ReturnStatus != nil && e.box != nil {
			st, err := s.Status(e.name, options.ReturnStatus)
			if err != nil {
				return err
			}
			data.Status = st
		}
		if err := w.WriteList(data); err != nil {
			return err
		}
	}
	return nil
}

type folder struct {
	name     string
	box      *Mailbox // nil for a parent that exists only as a prefix
	children bool
}

// folderTree lists the mailboxes plus any parent a "/" in a name implies but Mailopus doesn't have
// (imported Gmail labels like "CLIENTS/WAYNE"). Those parents can't be selected; without them clients
// show a child with no parent. Each parent comes just before its first child.
func folderTree(boxes []*Mailbox) []folder {
	real := map[string]bool{}
	for _, b := range boxes {
		real[b.imapName()] = true
	}
	parents := map[string]bool{}
	for name := range real {
		for i, r := range name {
			if r == delim && i > 0 {
				parents[name[:i]] = true
			}
		}
	}
	var out []folder
	seen := map[string]bool{}
	for _, b := range boxes {
		name := b.imapName()
		for i, r := range name {
			if r == delim && i > 0 && !real[name[:i]] && !seen[name[:i]] {
				seen[name[:i]] = true
				out = append(out, folder{name: name[:i], children: true})
			}
		}
		out = append(out, folder{name: name, box: b, children: parents[name]})
	}
	return out
}

func (s *Session) Status(name string, options *imap.StatusOptions) (*imap.StatusData, error) {
	s.acct.mu.Lock()
	b := s.acct.box(name)
	if b == nil {
		s.acct.mu.Unlock()
		return nil, errNoMailbox
	}
	data := &imap.StatusData{Mailbox: b.imapName(), UIDNext: b.UIDNext, UIDValidity: b.UIDValidity}
	total, unread := b.Total, b.Unread
	if b.loaded {
		total, unread = uint32(len(b.msgs)), 0
		var size int64
		for _, m := range b.msgs {
			if !hasFlag(m.Flags, imap.FlagSeen) {
				unread++
			}
			size += m.Size
		}
		if options.Size {
			data.Size = &size
		}
	}
	needLoad := !b.loaded && (options.Size || options.NumDeleted)
	s.acct.mu.Unlock()
	if needLoad {
		c, cancel := ctx()
		defer cancel()
		if err := s.acct.load(c, b); err != nil {
			return nil, s.backend("status", err)
		}
		return s.Status(name, options)
	}
	if options.NumMessages {
		data.NumMessages = &total
	}
	if options.NumUnseen {
		data.NumUnseen = &unread
	}
	if options.NumRecent {
		zero := uint32(0)
		data.NumRecent = &zero
	}
	if options.NumDeleted {
		var n uint32
		s.acct.mu.Lock()
		for _, m := range b.msgs {
			if hasFlag(m.Flags, imap.FlagDeleted) {
				n++
			}
		}
		s.acct.mu.Unlock()
		data.NumDeleted = &n
	}
	return data, nil
}

func (s *Session) Select(name string, options *imap.SelectOptions) (*imap.SelectData, error) {
	if s.st != nil {
		s.Unselect()
	}
	s.acct.mu.Lock()
	b := s.acct.box(name)
	s.acct.mu.Unlock()
	if b == nil {
		return nil, errNoMailbox
	}
	c, cancel := ctx()
	defer cancel()
	t := time.Now()
	if err := s.acct.load(c, b); err != nil {
		return nil, s.backend("select", err)
	}
	if err := s.acct.maybeSync(c); err != nil {
		return nil, s.backend("select", err)
	}
	s.acct.mu.Lock()
	defer s.acct.mu.Unlock()
	s.box, s.st, s.readOnly = b, b.tracker.NewSession(), options.ReadOnly
	var firstUnseen uint32
	for i, m := range b.msgs {
		if !hasFlag(m.Flags, imap.FlagSeen) {
			firstUnseen = uint32(i) + 1
			break
		}
	}
	s.srv.log.Info("imap: select", "user", s.user, "mailbox", b.ID, "messages", len(b.msgs), "ms", time.Since(t).Milliseconds())
	return &imap.SelectData{
		Flags:             []imap.Flag{imap.FlagSeen, imap.FlagAnswered, imap.FlagFlagged, imap.FlagDeleted, imap.FlagDraft},
		PermanentFlags:    []imap.Flag{imap.FlagSeen, imap.FlagAnswered, imap.FlagFlagged, imap.FlagDeleted, imap.FlagDraft, imap.FlagWildcard},
		NumMessages:       uint32(len(b.msgs)),
		FirstUnseenSeqNum: firstUnseen,
		UIDNext:           b.UIDNext,
		UIDValidity:       b.UIDValidity,
	}, nil
}

func (s *Session) Unselect() error {
	if s.st != nil {
		s.st.Close()
	}
	s.box, s.st, s.readOnly = nil, nil, false
	return nil
}

// Folder management needs Mailbox/set, which Mailopus doesn't have yet.
func (s *Session) Create(string, *imap.CreateOptions) error         { return errCannot }
func (s *Session) Delete(string) error                              { return errCannot }
func (s *Session) Rename(string, string, *imap.RenameOptions) error { return errCannot }
func (s *Session) Subscribe(string) error                           { return nil }
func (s *Session) Unsubscribe(string) error                         { return nil }

func (s *Session) Namespace() (*imap.NamespaceData, error) {
	return &imap.NamespaceData{Personal: []imap.NamespaceDescriptor{{Delim: delim}}}, nil
}

// ---------- updates ----------

func (s *Session) Poll(w *imapserver.UpdateWriter, allowExpunge bool) error {
	if s.acct == nil {
		return nil
	}
	s.acct.mu.Lock()
	revoked := s.acct.revoked
	s.acct.mu.Unlock()
	if revoked {
		return errRevoked
	}
	c, cancel := ctx()
	defer cancel()
	if err := s.acct.maybeSync(c); err != nil {
		s.srv.log.Warn("imap: sync", "user", s.user, "err", err)
	}
	if s.st == nil {
		return nil
	}
	return s.st.Poll(w, allowExpunge)
}

// Idle waits on the tracker; the account's push socket syncs and queues the updates.
func (s *Session) Idle(w *imapserver.UpdateWriter, stop <-chan struct{}) error {
	if s.st == nil {
		<-stop
		return nil
	}
	return s.st.Idle(w, stop)
}

// ---------- selected state ----------

type seqMsg struct {
	seq uint32 // as the client sees it
	m   *Message
}

// pick resolves a sequence or UID set against the selected mailbox. Caller holds acct.mu.
func (s *Session) pick(numSet imap.NumSet) []seqMsg {
	b := s.box
	if imap.IsSearchRes(numSet) {
		numSet = s.searchRes
	}
	var out []seqMsg
	switch set := numSet.(type) {
	case imap.SeqSet:
		set = staticSeq(set, uint32(len(b.msgs)))
		for i, m := range b.msgs {
			seq := s.st.EncodeSeqNum(uint32(i) + 1)
			if seq != 0 && set.Contains(seq) {
				out = append(out, seqMsg{seq, m})
			}
		}
	case imap.UIDSet:
		var max imap.UID
		if n := len(b.msgs); n > 0 {
			max = b.msgs[n-1].UID
		}
		set = staticUID(set, max)
		for i, m := range b.msgs {
			if set.Contains(m.UID) {
				out = append(out, seqMsg{s.st.EncodeSeqNum(uint32(i) + 1), m})
			}
		}
	}
	return out
}

// staticSeq and staticUID replace "*" (stored as 0) with the largest number in the mailbox.
func staticSeq(set imap.SeqSet, max uint32) imap.SeqSet {
	out := make(imap.SeqSet, len(set))
	for i, r := range set {
		out[i] = r
		fixRange(&out[i].Start, &out[i].Stop, max)
	}
	return out
}

func staticUID(set imap.UIDSet, max imap.UID) imap.UIDSet {
	out := make(imap.UIDSet, len(set))
	for i, r := range set {
		out[i] = r
		fixRange((*uint32)(&out[i].Start), (*uint32)(&out[i].Stop), uint32(max))
	}
	return out
}

func fixRange(start, stop *uint32, max uint32) {
	dyn := *start == 0 || *stop == 0
	if *start == 0 {
		*start = max
	}
	if *stop == 0 {
		*stop = max
	}
	if dyn && *start > *stop {
		*start, *stop = *stop, *start
	}
}

func (s *Session) picked(numSet imap.NumSet) []seqMsg {
	s.acct.mu.Lock()
	defer s.acct.mu.Unlock()
	return s.pick(numSet)
}

// setEmails runs one Email/set update and syncs, so every connection sees the change.
func (s *Session) setEmails(op string, update map[string]any, destroy []string) error {
	if len(update) == 0 && len(destroy) == 0 {
		return nil
	}
	c, cancel := ctx()
	defer cancel()
	args := map[string]any{}
	if len(update) > 0 {
		args["update"] = update
	}
	if len(destroy) > 0 {
		args["destroy"] = destroy
	}
	var r struct {
		NotUpdated   map[string]json.RawMessage `json:"notUpdated"`
		NotDestroyed map[string]json.RawMessage `json:"notDestroyed"`
	}
	if err := s.acct.c.Call1(c, "Email/set", args, &r); err != nil {
		return s.backend(op, err)
	}
	var source *imapserver.SessionTracker
	if op == "store" {
		source = s.st
	}
	if err := s.acct.sync(c, source); err != nil {
		return s.backend(op, err)
	}
	if n := len(r.NotUpdated) + len(r.NotDestroyed); n > 0 {
		s.srv.log.Warn("imap: some changes refused", "op", op, "user", s.user, "count", n)
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "Some messages couldn't be changed"}
	}
	return nil
}

func (s *Session) Store(w *imapserver.FetchWriter, numSet imap.NumSet, flags *imap.StoreFlags, options *imap.StoreOptions) error {
	if s.readOnly {
		return &imap.Error{Type: imap.StatusResponseTypeNo, Text: "Mailbox is read-only"}
	}
	msgs := s.picked(numSet)
	update := map[string]any{}
	for _, sm := range msgs {
		switch flags.Op {
		case imap.StoreFlagsSet:
			kw := flagsToKeywords(flags.Flags)
			update[sm.m.ID] = map[string]any{"keywords": kw}
		default:
			patch := map[string]any{}
			for _, f := range flags.Flags {
				if k := flagToKeyword(f); k != "" {
					if flags.Op == imap.StoreFlagsAdd {
						patch["keywords/"+k] = true
					} else {
						patch["keywords/"+k] = nil
					}
				}
			}
			if len(patch) > 0 {
				update[sm.m.ID] = patch
			}
		}
	}
	if err := s.setEmails("store", update, nil); err != nil {
		return err
	}
	s.srv.log.Info("imap: store", "user", s.user, "mailbox", s.box.ID, "count", len(msgs))
	if flags.Silent {
		return nil
	}
	s.acct.mu.Lock()
	defer s.acct.mu.Unlock()
	for _, sm := range msgs {
		if s.box.byID[sm.m.ID] == nil || sm.seq == 0 {
			continue
		}
		rw := w.CreateMessage(sm.seq)
		rw.WriteUID(sm.m.UID)
		rw.WriteFlags(sm.m.Flags)
		if err := rw.Close(); err != nil {
			return err
		}
	}
	return nil
}

func (s *Session) destination(name string) (*Mailbox, error) {
	s.acct.mu.Lock()
	defer s.acct.mu.Unlock()
	dest := s.acct.box(name)
	if dest == nil {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTryCreate, Text: "No such mailbox"}
	}
	if dest == s.box {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Text: "Source and destination are the same"}
	}
	return dest, nil
}

// copyData looks up the new uids in dest (Email/get imapUids) for COPYUID.
func (s *Session) copyData(msgs []seqMsg, dest *Mailbox) (*imap.CopyData, error) {
	ids := make([]string, len(msgs))
	for i, sm := range msgs {
		ids[i] = sm.m.ID
	}
	c, cancel := ctx()
	defer cancel()
	var r struct {
		List []changedEmail `json:"list"`
	}
	if err := s.acct.c.Call1(c, "Email/get", map[string]any{"ids": ids, "properties": []string{"imapUids"}}, &r); err != nil {
		return nil, err
	}
	uids := map[string]int64{}
	for _, e := range r.List {
		uids[e.ID] = e.ImapUids[dest.ID]
	}
	data := &imap.CopyData{UIDValidity: dest.UIDValidity}
	for _, sm := range msgs {
		if u := uids[sm.m.ID]; u > 0 {
			data.SourceUIDs.AddNum(sm.m.UID)
			data.DestUIDs.AddNum(imap.UID(u))
		}
	}
	return data, nil
}

func (s *Session) Copy(numSet imap.NumSet, destName string) (*imap.CopyData, error) {
	dest, err := s.destination(destName)
	if err != nil {
		return nil, err
	}
	msgs := s.picked(numSet)
	update := map[string]any{}
	for _, sm := range msgs {
		update[sm.m.ID] = map[string]any{"mailboxIds/" + dest.ID: true}
	}
	if err := s.setEmails("copy", update, nil); err != nil {
		return nil, err
	}
	s.srv.log.Info("imap: copy", "user", s.user, "from", s.box.ID, "to", dest.ID, "count", len(msgs))
	data, err := s.copyData(msgs, dest)
	return data, s.backend("copy", err)
}

// Move writes COPYUID; the EXPUNGEs reach this connection from the tracker in the poll that
// runs before the tagged OK.
func (s *Session) Move(w *imapserver.MoveWriter, numSet imap.NumSet, destName string) error {
	dest, err := s.destination(destName)
	if err != nil {
		return err
	}
	msgs := s.picked(numSet)
	src := s.box.ID
	update := map[string]any{}
	for _, sm := range msgs {
		update[sm.m.ID] = map[string]any{"mailboxIds/" + src: nil, "mailboxIds/" + dest.ID: true}
	}
	if err := s.setEmails("move", update, nil); err != nil {
		return err
	}
	s.srv.log.Info("imap: move", "user", s.user, "from", src, "to", dest.ID, "count", len(msgs))
	data, err := s.copyData(msgs, dest)
	if err != nil {
		return s.backend("move", err)
	}
	return w.WriteCopyData(data)
}

// Expunge removes \Deleted messages from this mailbox. An email in no other mailbox is destroyed,
// since a JMAP email needs at least one.
func (s *Session) Expunge(w *imapserver.ExpungeWriter, uids *imap.UIDSet) error {
	if s.readOnly {
		return nil
	}
	s.acct.mu.Lock()
	var ids []string
	for _, m := range s.box.msgs {
		if hasFlag(m.Flags, imap.FlagDeleted) && (uids == nil || uids.Contains(m.UID)) {
			ids = append(ids, m.ID)
		}
	}
	src := s.box.ID
	s.acct.mu.Unlock()
	if len(ids) == 0 {
		return nil
	}
	c, cancel := ctx()
	defer cancel()
	var r struct {
		List []changedEmail `json:"list"`
	}
	if err := s.acct.c.Call1(c, "Email/get", map[string]any{"ids": ids, "properties": []string{"imapUids"}}, &r); err != nil {
		return s.backend("expunge", err)
	}
	update := map[string]any{}
	var destroy []string
	for _, e := range r.List {
		if len(e.ImapUids) <= 1 {
			destroy = append(destroy, e.ID)
		} else {
			update[e.ID] = map[string]any{"mailboxIds/" + src: nil, "keywords/$deleted": nil}
		}
	}
	s.srv.log.Info("imap: expunge", "user", s.user, "mailbox", src, "removed", len(update), "destroyed", len(destroy))
	return s.setEmails("expunge", update, destroy)
}

func (s *Session) Append(name string, r imap.LiteralReader, options *imap.AppendOptions) (*imap.AppendData, error) {
	s.acct.mu.Lock()
	b := s.acct.box(name)
	s.acct.mu.Unlock()
	if b == nil {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTryCreate, Text: "No such mailbox"}
	}
	if r.Size() > maxMessage {
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Code: imap.ResponseCodeTooBig, Text: "Message over 25 MB"}
	}
	raw, err := io.ReadAll(r)
	if err != nil {
		return nil, err
	}
	c, cancel := ctx()
	defer cancel()
	blob, err := s.acct.c.Upload(c, raw)
	if err != nil {
		return nil, s.backend("append", err)
	}
	email := map[string]any{"blobId": blob, "mailboxIds": map[string]bool{b.ID: true}, "keywords": flagsToKeywords(options.Flags)}
	if !options.Time.IsZero() {
		email["receivedAt"] = options.Time.UTC().Format(time.RFC3339)
	}
	var res struct {
		Created    map[string]struct{ ID string } `json:"created"`
		NotCreated map[string]MethodError         `json:"notCreated"`
	}
	if err := s.acct.c.Call1(c, "Email/import", map[string]any{"emails": map[string]any{"a": email}}, &res); err != nil {
		return nil, s.backend("append", err)
	}
	created, ok := res.Created["a"]
	if !ok {
		s.srv.log.Warn("imap: append refused", "user", s.user, "type", res.NotCreated["a"].Type)
		return nil, &imap.Error{Type: imap.StatusResponseTypeNo, Text: "Mailopus refused the message"}
	}
	if err := s.acct.sync(c, nil); err != nil {
		return nil, s.backend("append", err)
	}
	var got struct {
		List []changedEmail `json:"list"`
	}
	if err := s.acct.c.Call1(c, "Email/get", map[string]any{"ids": []string{created.ID}, "properties": []string{"imapUids"}}, &got); err != nil || len(got.List) == 0 {
		return nil, s.backend("append", err)
	}
	s.srv.log.Info("imap: append", "user", s.user, "mailbox", b.ID, "bytes", len(raw))
	return &imap.AppendData{UIDValidity: b.UIDValidity, UID: imap.UID(got.List[0].ImapUids[b.ID])}, nil
}

// ---------- FETCH ----------

// headerOnly says whether a section can be answered from the header block alone.
func headerOnly(bs *imap.FetchItemBodySection) bool {
	return len(bs.Part) == 0 && bs.Specifier == imap.PartSpecifierHeader
}

func (s *Session) Fetch(w *imapserver.FetchWriter, numSet imap.NumSet, options *imap.FetchOptions) error {
	msgs := s.picked(numSet)
	needHeader, needRaw, markSeen := options.Envelope, options.BodyStructure != nil || len(options.BinarySection) > 0 || len(options.BinarySectionSize) > 0, false
	for _, bs := range options.BodySection {
		if headerOnly(bs) {
			needHeader = true
		} else {
			needRaw = true
		}
		if !bs.Peek {
			markSeen = true
		}
	}
	if markSeen && !s.readOnly {
		update := map[string]any{}
		for _, sm := range msgs {
			if !hasFlag(sm.m.Flags, imap.FlagSeen) {
				update[sm.m.ID] = map[string]any{"keywords/$seen": true}
			}
		}
		if err := s.setEmails("fetch", update, nil); err != nil {
			return err
		}
	}
	t := time.Now()
	// A Worker request reads at most 6 R2 objects at once, so header chunks go out in parallel
	// requests. A batch is chunk*par messages, a few MB of headers.
	const chunk, par = 50, 8
	for i := 0; i < len(msgs); i += chunk * par {
		part := msgs[i:min(i+chunk*par, len(msgs))]
		headers := map[string][]byte{}
		if needHeader && !needRaw {
			var err error
			if headers, err = s.headersPar(part, chunk); err != nil {
				return s.backend("fetch", err)
			}
		}
		for _, sm := range part {
			if sm.seq == 0 {
				continue
			}
			var raw []byte
			if needRaw {
				var err error
				if raw, err = s.raw(sm.m.ID); err != nil {
					return s.backend("fetch", err)
				}
				headers[sm.m.ID] = raw
			}
			if err := s.writeMessage(w, sm, options, headers[sm.m.ID], raw); err != nil {
				return err
			}
		}
	}
	s.srv.log.Info("imap: fetch", "user", s.user, "mailbox", s.box.ID, "count", len(msgs), "raw", needRaw, "ms", time.Since(t).Milliseconds())
	return nil
}

func (s *Session) writeMessage(w *imapserver.FetchWriter, sm seqMsg, options *imap.FetchOptions, header, raw []byte) error {
	s.acct.mu.Lock()
	flags := sm.m.Flags
	s.acct.mu.Unlock()
	rw := w.CreateMessage(sm.seq)
	rw.WriteUID(sm.m.UID)
	if options.Flags {
		rw.WriteFlags(flags)
	}
	if options.InternalDate {
		rw.WriteInternalDate(sm.m.Date)
	}
	if options.RFC822Size {
		rw.WriteRFC822Size(sm.m.Size)
	}
	if options.Envelope {
		if h, err := textproto.ReadHeader(bufio.NewReader(bytes.NewReader(header))); err == nil {
			rw.WriteEnvelope(imapserver.ExtractEnvelope(h))
		}
	}
	if options.BodyStructure != nil {
		rw.WriteBodyStructure(fixBodyStructure(imapserver.ExtractBodyStructure(bytes.NewReader(raw))))
	}
	for _, bs := range options.BodySection {
		src := raw
		if src == nil {
			src = header
		}
		buf := imapserver.ExtractBodySection(bytes.NewReader(src), bs)
		wc := rw.WriteBodySection(bs, int64(len(buf)))
		if _, err := wc.Write(buf); err != nil {
			return err
		}
		if err := wc.Close(); err != nil {
			return err
		}
	}
	for _, bs := range options.BinarySection {
		buf := imapserver.ExtractBinarySection(bytes.NewReader(raw), bs)
		wc := rw.WriteBinarySection(bs, int64(len(buf)))
		if _, err := wc.Write(buf); err != nil {
			return err
		}
		if err := wc.Close(); err != nil {
			return err
		}
	}
	for _, bss := range options.BinarySectionSize {
		rw.WriteBinarySectionSize(bss, imapserver.ExtractBinarySectionSize(bytes.NewReader(raw), bss))
	}
	return rw.Close()
}

// fixBodyStructure replaces multiparts with no parts (a broken boundary, say), which go-imap
// panics on, with an empty text/plain part.
func fixBodyStructure(bs imap.BodyStructure) imap.BodyStructure {
	switch b := bs.(type) {
	case *imap.BodyStructureMultiPart:
		if len(b.Children) == 0 {
			return &imap.BodyStructureSinglePart{Type: "text", Subtype: "plain", Encoding: "7bit", Text: &imap.BodyStructureText{}, Extended: &imap.BodyStructureSinglePartExt{}}
		}
		for i, c := range b.Children {
			b.Children[i] = fixBodyStructure(c)
		}
	case *imap.BodyStructureSinglePart:
		if b.MessageRFC822 != nil && b.MessageRFC822.BodyStructure != nil {
			b.MessageRFC822.BodyStructure = fixBodyStructure(b.MessageRFC822.BodyStructure)
		}
	}
	return bs
}

// headersPar runs headers on chunks of msgs concurrently.
func (s *Session) headersPar(msgs []seqMsg, chunk int) (map[string][]byte, error) {
	var mu sync.Mutex
	var wg sync.WaitGroup
	var first error
	out := map[string][]byte{}
	for i := 0; i < len(msgs); i += chunk {
		part := msgs[i:min(i+chunk, len(msgs))]
		wg.Go(func() {
			h, err := s.headers(part)
			mu.Lock()
			defer mu.Unlock()
			if err != nil && first == nil {
				first = err
			}
			maps.Copy(out, h)
		})
	}
	wg.Wait()
	return out, first
}

// headers fetches header blocks (Email/get imapHeader) for those not cached.
func (s *Session) headers(msgs []seqMsg) (map[string][]byte, error) {
	out := map[string][]byte{}
	var missing []string
	for _, sm := range msgs {
		if h, ok := headerCache.Get(s.acct.c.AccountID + sm.m.ID); ok {
			out[sm.m.ID] = h
		} else {
			missing = append(missing, sm.m.ID)
		}
	}
	if len(missing) == 0 {
		return out, nil
	}
	c, cancel := ctx()
	defer cancel()
	var r struct {
		List []struct {
			ID         string `json:"id"`
			ImapHeader string `json:"imapHeader"`
		} `json:"list"`
	}
	if err := s.acct.c.Call1(c, "Email/get", map[string]any{"ids": missing, "properties": []string{"imapHeader"}}, &r); err != nil {
		return nil, err
	}
	for _, e := range r.List {
		// One char per byte on the wire, so non-UTF-8 headers survive JSON.
		h := make([]byte, 0, len(e.ImapHeader))
		for _, ch := range e.ImapHeader {
			h = append(h, byte(ch))
		}
		headerCache.Add(s.acct.c.AccountID+e.ID, h)
		out[e.ID] = h
	}
	return out, nil
}

func (s *Session) raw(id string) ([]byte, error) {
	if b, ok := rawCache.Get(s.acct.c.AccountID + id); ok {
		return b, nil
	}
	c, cancel := ctx()
	defer cancel()
	b, err := s.acct.c.Download(c, id)
	if err != nil {
		return nil, err
	}
	rawCache.Add(s.acct.c.AccountID+id, b)
	return b, nil
}
