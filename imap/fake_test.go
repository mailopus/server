package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sort"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"
)

// fakeMailopus is just enough of Mailopus's JMAP API (with the IMAP capability) for the proxy.
type fakeMailopus struct {
	t    *testing.T
	mu   sync.Mutex
	user string
	pass string

	modseq  int
	boxes   []*fakeBox
	emails  map[string]*fakeEmail
	blobs   map[string][]byte
	sockets []*websocket.Conn
	sent    []string // recipients of submissions
	nextID  int
	counts  map[string]int // method calls by name
	ip      string         // X-Mailopus-Client-Ip of the last authenticated request
}

type fakeBox struct {
	id, name, role string
	uidnext        int
}

type fakeEmail struct {
	id        string
	raw       []byte
	keywords  map[string]bool
	uids      map[string]int
	received  time.Time
	updated   int
	created   int
	destroyed bool
}

func newFake(t *testing.T) (*fakeMailopus, *httptest.Server) {
	f := &fakeMailopus{t: t, user: "me@mailopus.net", pass: "ABCD-EFGH-IJKL-MNOP-QRST", emails: map[string]*fakeEmail{}, blobs: map[string][]byte{}}
	for _, b := range [][2]string{{"inbox", "Inbox"}, {"sent", "Sent"}, {"drafts", "Drafts"}, {"trash", "Trash"}, {"archive", "Archive"}} {
		f.boxes = append(f.boxes, &fakeBox{id: "box-" + b[0], name: b[1], role: b[0], uidnext: 1})
	}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeMailopus) box(id string) *fakeBox {
	for _, b := range f.boxes {
		if b.id == id {
			return b
		}
	}
	return nil
}

// deliver adds a message to the inbox the way ingest would, and pushes a StateChange.
func (f *fakeMailopus) deliver(subject, body string) string {
	f.mu.Lock()
	raw := []byte(fmt.Sprintf("From: Ann <ann@example.com>\r\nTo: %s\r\nSubject: %s\r\nMessage-ID: <%s@x>\r\nDate: Sat, 07 Nov 2026 10:00:00 +0000\r\n\r\n%s\r\n", f.user, subject, subject, body))
	id := f.add(raw, map[string]bool{}, []string{"box-inbox"})
	socks := append([]*websocket.Conn(nil), f.sockets...)
	f.mu.Unlock()
	for _, ws := range socks {
		ws.Write(f.t.Context(), websocket.MessageText, []byte(`{"@type":"StateChange","changed":{}}`))
	}
	return id
}

func (f *fakeMailopus) add(raw []byte, kw map[string]bool, boxes []string) string {
	f.nextID++
	f.modseq++
	e := &fakeEmail{id: fmt.Sprintf("e%d", f.nextID), raw: raw, keywords: kw, uids: map[string]int{}, received: time.Now(), updated: f.modseq, created: f.modseq}
	for _, b := range boxes {
		bx := f.box(b)
		e.uids[b] = bx.uidnext
		bx.uidnext++
	}
	f.emails[e.id] = e
	return e.id
}

func (f *fakeMailopus) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	u, p, ok := r.BasicAuth()
	if !ok || u != f.user || normalizePassword(p) != normalizePassword(f.pass) {
		w.WriteHeader(401)
		return
	}
	f.mu.Lock()
	f.ip = r.Header.Get("X-Mailopus-Client-Ip")
	f.mu.Unlock()
	switch {
	case r.URL.Path == "/jmap/session":
		json.NewEncoder(w).Encode(map[string]any{
			"capabilities":    map[string]any{capCore: map[string]any{}, capMail: map[string]any{}, capIMAP: map[string]any{}},
			"primaryAccounts": map[string]string{capMail: "acct"},
		})
	case r.URL.Path == "/jmap/ws":
		ws, err := websocket.Accept(w, r, &websocket.AcceptOptions{Subprotocols: []string{"jmap"}})
		if err != nil {
			return
		}
		f.mu.Lock()
		f.sockets = append(f.sockets, ws)
		f.mu.Unlock()
		for {
			if _, _, err := ws.Read(r.Context()); err != nil {
				return
			}
		}
	case strings.HasPrefix(r.URL.Path, "/jmap/upload/"):
		b, _ := io.ReadAll(r.Body)
		f.mu.Lock()
		f.nextID++
		id := fmt.Sprintf("u%d", f.nextID)
		f.blobs[id] = b
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]string{"blobId": id})
	case strings.HasPrefix(r.URL.Path, "/jmap/download/"):
		id := strings.Split(r.URL.Path, "/")[4]
		f.mu.Lock()
		e := f.emails[id]
		f.mu.Unlock()
		if e == nil {
			w.WriteHeader(404)
			return
		}
		w.Write(e.raw)
	case r.URL.Path == "/jmap/api":
		var req struct {
			MethodCalls [][3]json.RawMessage `json:"methodCalls"`
		}
		json.NewDecoder(r.Body).Decode(&req)
		f.mu.Lock()
		created := map[string]string{}
		var out [][3]any
		for _, c := range req.MethodCalls {
			var name, id string
			var args map[string]any
			json.Unmarshal(c[0], &name)
			json.Unmarshal(c[1], &args)
			json.Unmarshal(c[2], &id)
			out = append(out, [3]any{name, f.method(name, args, created), id})
		}
		f.mu.Unlock()
		json.NewEncoder(w).Encode(map[string]any{"methodResponses": out})
	default:
		w.WriteHeader(404)
	}
}

// calls is how many times a method was called.
func (f *fakeMailopus) calls(name string) int {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.counts[name]
}

func (f *fakeMailopus) method(name string, args map[string]any, created map[string]string) map[string]any {
	if f.counts == nil {
		f.counts = map[string]int{}
	}
	f.counts[name]++
	state := fmt.Sprint(f.modseq)
	switch name {
	case "Mailbox/get":
		var list []map[string]any
		for _, b := range f.boxes {
			total, unread := 0, 0
			for _, e := range f.emails {
				if _, in := e.uids[b.id]; in && !e.destroyed {
					total++
					if !e.keywords["$seen"] {
						unread++
					}
				}
			}
			list = append(list, map[string]any{"id": b.id, "name": b.name, "role": b.role, "totalEmails": total, "unreadEmails": unread, "imapUidValidity": 1700000000, "imapUidNext": b.uidnext})
		}
		return map[string]any{"state": state, "list": list}
	case "Email/imapUids":
		b := f.box(args["mailboxId"].(string))
		after := int(args["afterUid"].(float64))
		var rows [][]any
		for _, e := range f.sorted(b.id) {
			if e.uids[b.id] > after {
				rows = append(rows, []any{e.uids[b.id], e.id, keys(e.keywords), len(e.raw), e.received.UnixMilli()})
			}
		}
		return map[string]any{"state": state, "uidValidity": 1700000000, "uidNext": b.uidnext, "list": rows, "hasMore": false}
	case "Email/changes":
		var since int
		fmt.Sscan(args["sinceState"].(string), &since)
		var c, u, d []string
		for _, e := range f.emails {
			if e.updated <= since {
				continue
			}
			switch {
			case e.destroyed && e.created <= since:
				d = append(d, e.id)
			case e.destroyed:
			case e.created > since:
				c = append(c, e.id)
			default:
				u = append(u, e.id)
			}
		}
		return map[string]any{"newState": state, "hasMoreChanges": false, "created": c, "updated": u, "destroyed": d}
	case "Email/get":
		var list []map[string]any
		for _, id := range args["ids"].([]any) {
			e := f.emails[id.(string)]
			if e == nil || e.destroyed {
				continue
			}
			hdr := string(e.raw[:strings.Index(string(e.raw), "\r\n\r\n")+4])
			list = append(list, map[string]any{"id": e.id, "keywords": e.keywords, "size": len(e.raw), "receivedAt": e.received.Format(time.RFC3339), "imapUids": e.uids, "imapHeader": hdr})
		}
		return map[string]any{"state": state, "list": list}
	case "Email/set":
		upd, _ := args["update"].(map[string]any)
		for id, p := range upd {
			if strings.HasPrefix(id, "#") {
				id = created[id[1:]]
			}
			e := f.emails[id]
			for path, v := range p.(map[string]any) {
				switch {
				case path == "keywords":
					e.keywords = map[string]bool{}
					for k := range v.(map[string]any) {
						e.keywords[k] = true
					}
				case strings.HasPrefix(path, "keywords/"):
					if v == nil {
						delete(e.keywords, path[9:])
					} else {
						e.keywords[path[9:]] = true
					}
				case strings.HasPrefix(path, "mailboxIds/"):
					b := path[11:]
					if v == nil {
						delete(e.uids, b)
					} else if _, in := e.uids[b]; !in {
						e.uids[b] = f.box(b).uidnext
						f.box(b).uidnext++
					}
				}
			}
			f.modseq++
			e.updated = f.modseq
		}
		des, _ := args["destroy"].([]any)
		for _, id := range des {
			e := f.emails[id.(string)]
			f.modseq++
			e.destroyed, e.updated, e.uids = true, f.modseq, map[string]int{}
		}
		return map[string]any{"newState": fmt.Sprint(f.modseq)}
	case "Email/import":
		res := map[string]any{}
		for cid, v := range args["emails"].(map[string]any) {
			o := v.(map[string]any)
			kw := map[string]bool{}
			for k := range o["keywords"].(map[string]any) {
				kw[k] = true
			}
			var boxes []string
			for b := range o["mailboxIds"].(map[string]any) {
				boxes = append(boxes, b)
			}
			id := f.add(f.blobs[o["blobId"].(string)], kw, boxes)
			created[cid] = id
			res[cid] = map[string]any{"id": id}
		}
		return map[string]any{"created": res}
	case "Identity/get":
		return map[string]any{"list": []map[string]any{{"id": "ident", "email": f.user}}}
	case "EmailSubmission/set":
		for _, v := range args["create"].(map[string]any) {
			for _, r := range v.(map[string]any)["envelope"].(map[string]any)["rcptTo"].([]any) {
				f.sent = append(f.sent, r.(map[string]any)["email"].(string))
			}
		}
		f.method("Email/set", map[string]any{"update": map[string]any{"#m": args["onSuccessUpdateEmail"].(map[string]any)["#s"]}}, created)
		return map[string]any{"created": map[string]any{"s": map[string]any{"id": "sub1"}}}
	}
	f.t.Errorf("fake: unexpected method %s", name)
	return map[string]any{}
}

func (f *fakeMailopus) sorted(box string) []*fakeEmail {
	var out []*fakeEmail
	for _, e := range f.emails {
		if _, in := e.uids[box]; in && !e.destroyed {
			out = append(out, e)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].uids[box] < out[j].uids[box] })
	return out
}

func basic(user, pass string) string {
	return "Basic " + base64.StdEncoding.EncodeToString([]byte(user+":"+pass))
}
