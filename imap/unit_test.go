package main

import (
	"fmt"
	"testing"
	"time"

	"github.com/emersion/go-imap/v2"
	"github.com/emersion/go-imap/v2/imapserver"
)

func loadedBox(uids ...imap.UID) *Mailbox {
	b := &Mailbox{ID: "box", loaded: true, byID: map[string]*Message{}}
	for _, u := range uids {
		m := &Message{UID: u, ID: idFor(u)}
		b.msgs = append(b.msgs, m)
		b.byID[m.ID] = m
	}
	b.tracker = imapserver.NewMailboxTracker(uint32(len(uids)))
	return b
}

func idFor(u imap.UID) string { return string(rune('a' + u)) }

func uidsOf(b *Mailbox) []imap.UID {
	var out []imap.UID
	for _, m := range b.msgs {
		out = append(out, m.UID)
	}
	return out
}

func TestApplyChanges(t *testing.T) {
	b := loadedBox(1, 2, 3)
	st := b.tracker.NewSession()
	defer st.Close()
	in := func(id string, uid int64, kw ...string) changedEmail {
		k := map[string]bool{}
		for _, x := range kw {
			k[x] = true
		}
		return changedEmail{ID: id, Keywords: k, ImapUids: map[string]int64{"box": uid}, ReceivedAt: time.Now()}
	}
	out := func(id string) changedEmail { return changedEmail{ID: id, ImapUids: map[string]int64{"other": 9}} }

	applyChanges(b, []changedEmail{
		in(idFor(1), 1, "$seen"), // flags change
		out(idFor(2)),            // moved out
		in("new", 4),             // arrived
	}, []string{idFor(3)}, nil) // destroyed
	if got := uidsOf(b); len(got) != 2 || got[0] != 1 || got[1] != 4 {
		t.Fatalf("uids %v, want [1 4]", got)
	}
	if !hasFlag(b.msgs[0].Flags, imap.FlagSeen) {
		t.Fatal("flags not applied")
	}
	if b.UIDNext != 5 {
		t.Fatalf("uidnext %d", b.UIDNext)
	}

	// Replaying the same changes is a no-op.
	applyChanges(b, []changedEmail{in(idFor(1), 1, "$seen"), in("new", 4)}, nil, nil)
	if got := uidsOf(b); len(got) != 2 {
		t.Fatalf("replay changed the list: %v", got)
	}

	// Moved out and back: same email, new uid, so an EXPUNGE then a new message at the end.
	applyChanges(b, []changedEmail{in(idFor(1), 5)}, nil, nil)
	if got := uidsOf(b); len(got) != 2 || got[0] != 4 || got[1] != 5 {
		t.Fatalf("uids %v, want [4 5]", got)
	}
	// The session tracker must agree with the list: 2 messages left.
	if st.DecodeSeqNum(2) != 0 && st.DecodeSeqNum(3) != 0 {
		t.Fatal("tracker out of step")
	}
}

func TestFlagMapping(t *testing.T) {
	cases := map[imap.Flag]string{imap.FlagSeen: "$seen", imap.FlagDeleted: "$deleted", `\FLAGGED`: "$flagged", "$Forwarded": "$forwarded", "Work": "work", `\Recent`: "", `\Unknown`: "", "bad(flag": ""}
	for f, want := range cases {
		if got := flagToKeyword(f); got != want {
			t.Errorf("flagToKeyword(%q) = %q, want %q", f, got, want)
		}
	}
	if keywordToFlag("$seen") != imap.FlagSeen || keywordToFlag("$junk") != "$junk" {
		t.Error("keywordToFlag")
	}
}

func TestLimiter(t *testing.T) {
	l := NewLimiter()
	now := time.Unix(0, 0)
	l.now = func() time.Time { return now }
	for i := 0; i < maxFails-1; i++ {
		l.Fail("1.2.3.4")
	}
	if !l.Allowed("1.2.3.4") {
		t.Fatal("locked before the limit")
	}
	l.Fail("1.2.3.4")
	if l.Allowed("1.2.3.4") || !l.Allowed("5.6.7.8") {
		t.Fatal("lockout should hit only that IP")
	}
	now = now.Add(lockFor + time.Second)
	if !l.Allowed("1.2.3.4") {
		t.Fatal("lockout didn't expire")
	}
	// Old failures age out of the window.
	for i := 0; i < maxFails-1; i++ {
		l.Fail("9.9.9.9")
	}
	now = now.Add(failWindow + time.Second)
	l.Fail("9.9.9.9")
	if !l.Allowed("9.9.9.9") {
		t.Fatal("failures outside the window counted")
	}
	// An address that signed in recently keeps working through a stale password's failures, then loses that after trustFor.
	l.Succeeded("8.8.8.8")
	for i := 0; i < maxFails*2; i++ {
		l.Fail("8.8.8.8")
	}
	if !l.Allowed("8.8.8.8") {
		t.Fatal("a recently good address was locked out")
	}
	now = now.Add(trustFor + time.Second)
	for i := 0; i < maxFails; i++ {
		l.Fail("8.8.8.8")
	}
	if l.Allowed("8.8.8.8") {
		t.Fatal("trust didn't expire")
	}
	for i := 0; i < maxConnsPerIP; i++ {
		if !l.acquire("1.1.1.1") {
			t.Fatal("refused under the cap")
		}
	}
	if l.acquire("1.1.1.1") {
		t.Fatal("accepted over the cap")
	}
}

func TestFolderTree(t *testing.T) {
	var boxes []*Mailbox
	for _, n := range []string{"Sent", "CLIENTS/WAYNE", "CLIENTS/ACME", "a/b/c", "a"} {
		boxes = append(boxes, &Mailbox{ID: n, Name: n})
	}
	got := map[string]folder{}
	var order []string
	for _, f := range folderTree(boxes) {
		got[f.name] = f
		order = append(order, f.name)
	}
	want := []string{"Sent", "CLIENTS", "CLIENTS/WAYNE", "CLIENTS/ACME", "a/b", "a/b/c", "a"}
	if fmt.Sprint(order) != fmt.Sprint(want) {
		t.Fatalf("order %v, want %v", order, want)
	}
	if got["CLIENTS"].box != nil || !got["CLIENTS"].children {
		t.Error("CLIENTS should be a parent-only folder with children")
	}
	if got["a"].box == nil || !got["a"].children {
		t.Error("a is a real mailbox with children")
	}
	if got["Sent"].children || got["a/b/c"].children {
		t.Error("leaves have no children")
	}
}

func TestFixBodyStructure(t *testing.T) {
	inner := &imap.BodyStructureMultiPart{Subtype: "mixed"}
	bs := &imap.BodyStructureMultiPart{Subtype: "mixed", Children: []imap.BodyStructure{
		&imap.BodyStructureSinglePart{Type: "message", Subtype: "rfc822", MessageRFC822: &imap.BodyStructureMessageRFC822{BodyStructure: inner}},
	}}
	got := fixBodyStructure(bs).(*imap.BodyStructureMultiPart)
	sp := got.Children[0].(*imap.BodyStructureSinglePart).MessageRFC822.BodyStructure
	if p, ok := sp.(*imap.BodyStructureSinglePart); !ok || p.Extended == nil {
		t.Fatalf("empty multipart not replaced with a writable part: %T", sp)
	}
}

func TestLimiterCountsAnIPv6Slash64AsOneClient(t *testing.T) {
	l := NewLimiter()
	for i := 0; i < maxFails; i++ {
		l.Fail("2001:db8:1:2::" + string(rune('1'+i)))
	}
	if l.Allowed("2001:db8:1:2:ffff::9") {
		t.Fatal("another address in the same /64 should be locked out too")
	}
	if !l.Allowed("2001:db8:1:3::1") || !l.Allowed("203.0.113.9") {
		t.Fatal("other networks stay allowed")
	}
}
