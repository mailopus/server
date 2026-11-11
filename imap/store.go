package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"log/slog"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/coder/websocket"
	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
)

// Message is one email as one mailbox sees it.
type Message struct {
	UID   imap.UID
	ID    string
	Flags []imap.Flag
	Size  int64
	Date  time.Time
}

// Mailbox is one Mailopus mailbox. Its message list loads on first SELECT or STATUS and then
// follows the account's changes; every IMAP connection on the account shares it.
type Mailbox struct {
	ID, Name, Role string
	UIDValidity    uint32
	UIDNext        imap.UID
	Total, Unread  uint32

	loaded  bool
	msgs    []*Message
	byID    map[string]*Message
	tracker *imapserver.MailboxTracker
}

func (m *Mailbox) imapName() string {
	if m.Role == "inbox" {
		return "INBOX"
	}
	return m.Name
}

func (m *Mailbox) index(id string) int {
	return slices.IndexFunc(m.msgs, func(x *Message) bool { return x.ID == id })
}

func (m *Mailbox) expunge(id string) {
	i := m.index(id)
	if i < 0 {
		return
	}
	m.tracker.QueueExpunge(uint32(i) + 1)
	m.msgs = slices.Delete(m.msgs, i, i+1)
	delete(m.byID, id)
}

// Account is the shared state for one app password: the mailbox list, loaded mailboxes, the JMAP
// state they're synced to, and the push socket. Keyed by credential, so revoking a password ends
// exactly the connections that used it.
type Account struct {
	c   *Client
	key string

	// ponytail: one lock per account for every mailbox; per-mailbox locks if one account's
	// connections ever contend.
	mu       sync.Mutex
	boxes    []*Mailbox
	state    string
	revoked  bool
	conns    map[*imapserver.Conn]struct{}
	refs     int
	stop     context.CancelFunc
	lastSync time.Time
	// lastBoxes is when refreshBoxes last asked Mailopus, under mu.
	lastBoxes time.Time

	syncMu sync.Mutex

	ready   chan struct{} // closed once the mailbox list has loaded
	loadErr error
}

type registry struct {
	mu       sync.Mutex
	accounts map[string]*Account
}

var accounts = &registry{accounts: map[string]*Account{}}

func credKey(user, pass string) string {
	h := sha256.Sum256([]byte(strings.ToLower(user) + "\x00" + normalizePassword(pass)))
	return string(h[:])
}

// normalizePassword drops the dashes and spaces a paste may add. Case matters (Mailopus decides
// whether an old case-insensitive password matches; the proxy only uses this to share Accounts).
func normalizePassword(p string) string {
	return strings.NewReplacer("-", "", " ", "").Replace(p)
}

// open returns the shared Account for these credentials, loading the mailbox list the first time.
func (r *registry) open(ctx context.Context, c *Client) (*Account, error) {
	key := credKey(c.user, c.pass)
	r.mu.Lock()
	a := r.accounts[key]
	if a == nil {
		a = &Account{c: c, key: key, conns: map[*imapserver.Conn]struct{}{}}
		r.accounts[key] = a
	}
	a.refs++
	first := a.refs == 1
	if first {
		a.ready = make(chan struct{})
	}
	ready := a.ready
	r.mu.Unlock()
	if first {
		pctx, cancel := context.WithCancel(context.Background())
		a.mu.Lock()
		a.stop = cancel
		a.mu.Unlock()
		a.loadErr = a.refreshBoxes(ctx)
		if a.loadErr == nil {
			go a.push(pctx)
		}
		close(ready)
	}
	// Clients open several connections at once; the others wait for the first to load the list.
	select {
	case <-ready:
	case <-ctx.Done():
		r.release(a)
		return nil, ctx.Err()
	}
	if a.loadErr != nil {
		r.release(a)
		return nil, a.loadErr
	}
	return a, nil
}

func (r *registry) release(a *Account) {
	r.mu.Lock()
	defer r.mu.Unlock()
	a.refs--
	if a.refs > 0 {
		return
	}
	delete(r.accounts, a.key)
	a.mu.Lock()
	if a.stop != nil {
		a.stop()
	}
	a.mu.Unlock()
}

type jmapMailbox struct {
	ID              string  `json:"id"`
	Name            string  `json:"name"`
	Role            *string `json:"role"`
	TotalEmails     uint32  `json:"totalEmails"`
	UnreadEmails    uint32  `json:"unreadEmails"`
	ImapUIDValidity uint32  `json:"imapUidValidity"`
	ImapUIDNext     uint32  `json:"imapUidNext"`
}

var mailboxProps = []string{"name", "role", "totalEmails", "unreadEmails", "imapUidValidity", "imapUidNext"}

// boxesTTL is how long a folder list is reused. Mail sends LIST often and from every connection, and
// for a limited app password Mailopus counts each folder's mail on every Mailbox/get. A var for tests.
var boxesTTL = 30 * time.Second

// refreshBoxes reloads the mailbox list and counts, keeping loaded message lists. It reuses a list
// fetched in the last boxesTTL.
func (a *Account) refreshBoxes(ctx context.Context) error {
	a.mu.Lock()
	fresh := !a.lastBoxes.IsZero() && time.Since(a.lastBoxes) < boxesTTL
	a.mu.Unlock()
	if fresh {
		return nil
	}
	var r struct {
		State string        `json:"state"`
		List  []jmapMailbox `json:"list"`
	}
	if err := a.c.Call1(ctx, "Mailbox/get", map[string]any{"properties": mailboxProps}, &r); err != nil {
		return err
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	a.applyBoxes(r.List)
	a.lastBoxes = time.Now()
	if a.state == "" {
		a.state = r.State
	}
	return nil
}

func (a *Account) applyBoxes(list []jmapMailbox) {
	old := map[string]*Mailbox{}
	for _, b := range a.boxes {
		old[b.ID] = b
	}
	boxes := make([]*Mailbox, 0, len(list))
	for _, j := range list {
		b := old[j.ID]
		if b == nil {
			b = &Mailbox{ID: j.ID}
		}
		b.Name = j.Name
		if j.Role != nil {
			b.Role = *j.Role
		}
		b.UIDValidity = j.ImapUIDValidity
		b.Total, b.Unread = j.TotalEmails, j.UnreadEmails
		if next := imap.UID(j.ImapUIDNext); next > b.UIDNext {
			b.UIDNext = next
		}
		boxes = append(boxes, b)
	}
	slices.SortStableFunc(boxes, func(x, y *Mailbox) int { return roleOrder(x.Role) - roleOrder(y.Role) })
	a.boxes = boxes
}

func roleOrder(role string) int {
	if i := slices.Index([]string{"inbox", "drafts", "sent", "archive", "junk", "trash"}, role); i >= 0 {
		return i
	}
	return 100
}

// box finds a mailbox by IMAP name. INBOX is case-insensitive (RFC 3501 §5.1).
func (a *Account) box(name string) *Mailbox {
	for _, b := range a.boxes {
		n := b.imapName()
		if n == name || (n == "INBOX" && strings.EqualFold(name, "INBOX")) {
			return b
		}
	}
	return nil
}

type uidsPage struct {
	State       string            `json:"state"`
	UIDValidity uint32            `json:"uidValidity"`
	UIDNext     uint32            `json:"uidNext"`
	List        []json.RawMessage `json:"list"`
	HasMore     bool              `json:"hasMore"`
}

// load fetches a mailbox's whole uid list (Email/imapUids), then catches up on changes made
// while it loaded. Holds syncMu so a push sync can't run half-way through.
func (a *Account) load(ctx context.Context, b *Mailbox) error {
	a.syncMu.Lock()
	defer a.syncMu.Unlock()
	a.mu.Lock()
	done := b.loaded
	a.mu.Unlock()
	if done {
		return nil
	}
	var msgs []*Message
	var after imap.UID
	var uidNext imap.UID
	for {
		var p uidsPage
		if err := a.c.Call1(ctx, "Email/imapUids", map[string]any{"mailboxId": b.ID, "afterUid": after}, &p); err != nil {
			return err
		}
		for _, raw := range p.List {
			m, err := decodeUIDRow(raw)
			if err != nil {
				return err
			}
			msgs = append(msgs, m)
			after = m.UID
		}
		uidNext = imap.UID(p.UIDNext)
		if !p.HasMore {
			break
		}
	}
	a.mu.Lock()
	b.msgs = msgs
	b.byID = make(map[string]*Message, len(msgs))
	for _, m := range msgs {
		b.byID[m.ID] = m
	}
	if uidNext > b.UIDNext {
		b.UIDNext = uidNext
	}
	b.tracker = imapserver.NewMailboxTracker(uint32(len(msgs)))
	b.loaded = true
	a.mu.Unlock()
	// Changes since a.state replay onto this mailbox too; applying one already in the list is a no-op.
	return a.syncLocked(ctx, nil)
}

// decodeUIDRow reads one Email/imapUids row: [uid, emailId, keywords, size, receivedAt ms].
func decodeUIDRow(raw json.RawMessage) (*Message, error) {
	var row []json.RawMessage
	if err := json.Unmarshal(raw, &row); err != nil || len(row) < 5 {
		return nil, errors.New("jmap: bad Email/imapUids row")
	}
	var uid uint32
	var id string
	var kw []string
	var size, at int64
	for i, dst := range []any{&uid, &id, &kw, &size, &at} {
		if err := json.Unmarshal(row[i], dst); err != nil {
			return nil, errors.New("jmap: bad Email/imapUids row")
		}
	}
	return &Message{UID: imap.UID(uid), ID: id, Flags: keywordsToFlags(kw), Size: size, Date: time.UnixMilli(at)}, nil
}

// sync brings every loaded mailbox up to date with the account. source, if set, is the
// connection that made the change, and doesn't get FETCH FLAGS echoes it already wrote itself.
func (a *Account) sync(ctx context.Context, source *imapserver.SessionTracker) error {
	a.syncMu.Lock()
	defer a.syncMu.Unlock()
	return a.syncLocked(ctx, source)
}

type changedEmail struct {
	ID         string           `json:"id"`
	Keywords   map[string]bool  `json:"keywords"`
	Size       int64            `json:"size"`
	ReceivedAt time.Time        `json:"receivedAt"`
	ImapUids   map[string]int64 `json:"imapUids"`
}

func (a *Account) syncLocked(ctx context.Context, source *imapserver.SessionTracker) error {
	a.mu.Lock()
	since := a.state
	a.mu.Unlock()

	var changed, destroyed []string
	for {
		var r struct {
			NewState       string   `json:"newState"`
			HasMoreChanges bool     `json:"hasMoreChanges"`
			Created        []string `json:"created"`
			Updated        []string `json:"updated"`
			Destroyed      []string `json:"destroyed"`
		}
		err := a.c.Call1(ctx, "Email/changes", map[string]any{"sinceState": since, "maxChanges": 500}, &r)
		var me *MethodError
		if errors.As(err, &me) && me.Type == "cannotCalculateChanges" {
			return a.reloadAll(ctx)
		}
		if err != nil {
			return a.authFailed(err)
		}
		changed = append(changed, r.Created...)
		changed = append(changed, r.Updated...)
		destroyed = append(destroyed, r.Destroyed...)
		since = r.NewState
		if !r.HasMoreChanges {
			break
		}
	}

	var emails []changedEmail
	for i := 0; i < len(changed); i += 500 {
		var r struct {
			List []changedEmail `json:"list"`
		}
		ids := changed[i:min(i+500, len(changed))]
		if err := a.c.Call1(ctx, "Email/get", map[string]any{"ids": ids, "properties": []string{"keywords", "size", "receivedAt", "imapUids"}}, &r); err != nil {
			return a.authFailed(err)
		}
		emails = append(emails, r.List...)
		// Asked for but not returned: destroyed since Email/changes ran.
		got := map[string]bool{}
		for _, e := range r.List {
			got[e.ID] = true
		}
		for _, id := range ids {
			if !got[id] {
				destroyed = append(destroyed, id)
			}
		}
	}

	var boxes struct {
		List []jmapMailbox `json:"list"`
	}
	if len(changed)+len(destroyed) > 0 || since != a.state {
		if err := a.c.Call1(ctx, "Mailbox/get", map[string]any{"properties": mailboxProps}, &boxes); err != nil {
			return a.authFailed(err)
		}
	}

	a.mu.Lock()
	defer a.mu.Unlock()
	if boxes.List != nil {
		a.applyBoxes(boxes.List)
	}
	for _, b := range a.boxes {
		if b.loaded {
			applyChanges(b, emails, destroyed, source)
		}
	}
	a.state = since
	a.lastSync = time.Now()
	return nil
}

// applyChanges updates one loaded mailbox from fresh email state. Idempotent: an email already
// listed with the same uid and flags changes nothing, so replaying changes is safe.
func applyChanges(b *Mailbox, emails []changedEmail, destroyed []string, source *imapserver.SessionTracker) {
	for _, id := range destroyed {
		b.expunge(id)
	}
	added := false
	for _, e := range emails {
		uid, in := e.ImapUids[b.ID]
		cur := b.byID[e.ID]
		if cur != nil && (!in || cur.UID != imap.UID(uid)) {
			// Removed from this mailbox, or removed and added back (a new uid).
			b.expunge(e.ID)
			cur = nil
		}
		if !in {
			continue
		}
		flags := keywordsToFlags(keys(e.Keywords))
		if cur != nil {
			if !sameFlags(cur.Flags, flags) {
				cur.Flags = flags
				b.tracker.QueueMessageFlags(uint32(b.index(e.ID))+1, cur.UID, flags, source)
			}
			continue
		}
		m := &Message{UID: imap.UID(uid), ID: e.ID, Flags: flags, Size: e.Size, Date: e.ReceivedAt}
		// Uids only grow within a mailbox, so new mail always goes on the end.
		if n := len(b.msgs); n > 0 && b.msgs[n-1].UID >= m.UID {
			slog.Warn("sync: uid out of order, skipped", "mailbox", b.ID, "uid", m.UID)
			continue
		}
		b.msgs = append(b.msgs, m)
		b.byID[m.ID] = m
		if m.UID >= b.UIDNext {
			b.UIDNext = m.UID + 1
		}
		added = true
	}
	if added {
		b.tracker.QueueNumMessages(uint32(len(b.msgs)))
	}
}

// reloadAll handles a state Mailopus can't compute changes from: reload each loaded mailbox and
// diff against what connections have seen, so they still get the right EXPUNGE and EXISTS.
func (a *Account) reloadAll(ctx context.Context) error {
	if err := a.refreshBoxesState(ctx); err != nil {
		return err
	}
	a.mu.Lock()
	var loaded []*Mailbox
	for _, b := range a.boxes {
		if b.loaded {
			loaded = append(loaded, b)
		}
	}
	a.mu.Unlock()
	for _, b := range loaded {
		var emails []changedEmail
		var after imap.UID
		for {
			var p uidsPage
			if err := a.c.Call1(ctx, "Email/imapUids", map[string]any{"mailboxId": b.ID, "afterUid": after}, &p); err != nil {
				return a.authFailed(err)
			}
			for _, raw := range p.List {
				m, err := decodeUIDRow(raw)
				if err != nil {
					return err
				}
				emails = append(emails, changedEmail{ID: m.ID, Keywords: flagsToKeywords(m.Flags), Size: m.Size, ReceivedAt: m.Date, ImapUids: map[string]int64{b.ID: int64(m.UID)}})
				after = m.UID
			}
			if !p.HasMore {
				break
			}
		}
		a.mu.Lock()
		present := map[string]bool{}
		for _, e := range emails {
			present[e.ID] = true
		}
		var gone []string
		for _, m := range b.msgs {
			if !present[m.ID] {
				gone = append(gone, m.ID)
			}
		}
		applyChanges(b, emails, gone, nil)
		a.mu.Unlock()
	}
	return nil
}

func (a *Account) refreshBoxesState(ctx context.Context) error {
	var r struct {
		State string        `json:"state"`
		List  []jmapMailbox `json:"list"`
	}
	if err := a.c.Call1(ctx, "Mailbox/get", map[string]any{"properties": mailboxProps}, &r); err != nil {
		return a.authFailed(err)
	}
	a.mu.Lock()
	a.applyBoxes(r.List)
	a.state = r.State
	a.mu.Unlock()
	return nil
}

// authFailed ends every connection on a revoked app password.
func (a *Account) authFailed(err error) error {
	if !errors.Is(err, errAuth) {
		return err
	}
	a.mu.Lock()
	a.revoked = true
	conns := make([]*imapserver.Conn, 0, len(a.conns))
	for c := range a.conns {
		conns = append(conns, c)
	}
	a.mu.Unlock()
	for _, c := range conns {
		go c.Bye("App password revoked")
	}
	return err
}

// push holds the account's WebSocket and syncs on every StateChange. A sync also runs after each
// (re)connect, so changes made while the socket was down aren't missed. Every 5 minutes it checks
// the password is still valid, which ends idle connections on a revoked one.
func (a *Account) push(ctx context.Context) {
	backoff := time.Second
	for ctx.Err() == nil {
		err := a.pushOnce(ctx)
		if ctx.Err() != nil {
			return
		}
		if errors.Is(err, errAuth) {
			a.authFailed(err)
			return
		}
		slog.Warn("push: socket closed", "err", err, "retry", backoff)
		select {
		case <-time.After(backoff):
		case <-ctx.Done():
			return
		}
		backoff = min(backoff*2, time.Minute)
	}
}

func (a *Account) pushOnce(ctx context.Context) error {
	conn, res, err := websocket.Dial(ctx, a.c.socketURL(), &websocket.DialOptions{HTTPHeader: a.c.authHeader(), Subprotocols: []string{"jmap"}, HTTPClient: a.c.http})
	if err != nil {
		if res != nil && res.StatusCode == 401 {
			return errAuth
		}
		return err
	}
	defer conn.CloseNow()
	conn.SetReadLimit(1 << 20)
	if err := conn.Write(ctx, websocket.MessageText, []byte(`{"@type":"WebSocketPushEnable","dataTypes":null}`)); err != nil {
		return err
	}
	if err := a.sync(ctx, nil); err != nil {
		slog.Warn("push: sync", "err", err)
	}

	msgs := make(chan []byte)
	errc := make(chan error, 1)
	go func() {
		for {
			_, data, err := conn.Read(ctx)
			if err != nil {
				errc <- err
				return
			}
			msgs <- data
		}
	}()
	ping := time.NewTicker(50 * time.Second)
	defer ping.Stop()
	check := time.NewTicker(5 * time.Minute)
	defer check.Stop()
	for {
		select {
		case data := <-msgs:
			if strings.Contains(string(data), `"StateChange"`) {
				if err := a.sync(ctx, nil); err != nil {
					slog.Warn("push: sync", "err", err)
				}
			}
		case <-ping.C:
			// The Durable Object answers "ping" without waking up (setWebSocketAutoResponse).
			if err := conn.Write(ctx, websocket.MessageText, []byte("ping")); err != nil {
				return err
			}
		case <-check.C:
			if _, err := Login(ctx, a.c.base, a.c.user, a.c.pass, a.c.ip); errors.Is(err, errAuth) {
				return errAuth
			}
		case err := <-errc:
			return err
		case <-ctx.Done():
			conn.Close(websocket.StatusNormalClosure, "")
			return ctx.Err()
		}
	}
}

// maybeSync is the fallback when the push socket is down: sync at most every 30 seconds.
func (a *Account) maybeSync(ctx context.Context) error {
	a.mu.Lock()
	stale := time.Since(a.lastSync) > 30*time.Second
	a.mu.Unlock()
	if !stale {
		return nil
	}
	return a.sync(ctx, nil)
}

func keys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k, v := range m {
		if v {
			out = append(out, k)
		}
	}
	return out
}
